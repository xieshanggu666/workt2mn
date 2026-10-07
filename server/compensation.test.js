// 统一可恢复补偿队列测试：
// 设施停运后的散客预约退款 / 团队行程 / 联营（召回）退款统一排队，
// 失败时独立事务重试，同步库存·现金·投诉·账单；人工处理后绝不重复扣款/退款。
// 运行：node --test server/compensation.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const G = await import('./groups.js')
const COMP = await import('./compensation.js')

const finLogs = []
const complaints = []
const realLogFinance = (day, label, amount, detail) => finLogs.push({ day, label, amount, detail })

RSV.initReservationContext({
  logFinance: realLogFinance,
  createComplaint: p => { complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') } }
})
G.initGroupContext({
  logFinance: realLogFinance,
  createComplaint: p => { complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') } }
})

const cash = () => Number(getSetting('cash'))
const rsvById = id => db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
const slotById = id => db.prepare('SELECT * FROM reservation_slots WHERE id=?').get(id)
const comps = () => db.prepare('SELECT * FROM compensation_tasks ORDER BY id').all()
const rideSlot = (day, rid, hour) => db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND day=? AND hour=?").get(rid, day, hour)

before(() => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
  setSetting('cash', 100000); setSetting('ticket', 100)
  RSV.ensureSlots()
})

beforeEach(() => {
  finLogs.length = 0
  complaints.length = 0
})

// ---------- 1. 停运主事务成功路径：补偿任务随主事务登记并已 done，预约退款、现金、库存、投诉一致 ----------
test('设施停运联动成功：预约全额退款、名额释放、投诉生成，且不留待补偿任务', () => {
  const s = rideSlot(2, 1, 10)
  const book = RSV.createReservation({ scope: 'ride', rideId: 1, slotId: s.id, qty: 2, requestId: 'c1-book' })
  assert.equal(book.ok, true)
  const cashAfterBook = cash()

  const r = RSV.syncRideSlots({ id: 1, name: '极速飞车', status: 'maintenance' })
  assert.equal(r.ok, true)
  assert.equal(rsvById(book.id).status, 'refunded')
  assert.equal(rsvById(book.id).reason, 'park')
  assert.equal(rsvById(book.id).refund_amount, 2 * 60)
  assert.equal(cash(), cashAfterBook - 120, '现金应退回')
  assert.equal(slotById(s.id).status, 'closed')
  assert.ok(finLogs.some(f => f.amount === -120), '退款流水留痕')
  assert.ok(complaints.some(c => c.category === 'facility'), '应建设施投诉')
  const open = db.prepare("SELECT COUNT(*) n FROM compensation_tasks WHERE status IN ('pending','processing')").get().n
  assert.equal(open, 0, '成功路径不应残留待补偿任务')
})

// ---------- 2. 停运主事务因资金流水故障失败：设施回滚为运营，但补偿任务已独立挂起，引擎重试自动补退 ----------
test('停运联动失败回滚后补偿队列补退：恢复后现金/库存/投诉一次到位，重试不重复退款', () => {
  const s = rideSlot(3, 2, 11)
  const book = RSV.createReservation({ scope: 'ride', rideId: 2, slotId: s.id, qty: 3, requestId: 'c2-book' })
  assert.equal(book.ok, true)
  const ride2 = db.prepare('SELECT * FROM rides WHERE id=2').get()
  const cashAfterBook = cash()

  // 故障：退款流水写入抛错（主事务整体回滚：设施仍运营、预约仍 booked、现金未退）
  RSV.initReservationContext({ logFinance: () => { throw new Error('模拟财务流水故障') } })
  const r = RSV.syncRideSlots({ ...ride2, status: 'maintenance' })
  RSV.initReservationContext({ logFinance: realLogFinance })
  assert.equal(r.ok, false)
  assert.equal(rsvById(book.id).status, 'booked', '主事务回滚，预约仍 booked')
  assert.equal(cash(), cashAfterBook, '现金未退')
  assert.equal(db.prepare("SELECT status FROM rides WHERE id=2").get().status, 'operating', '设施回滚为运营')

  // 补偿任务已独立持久化（不随主事务回滚丢失）
  const pending = comps().filter(t => t.status === 'pending' && t.domain === 'reservation')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].ref_id, book.id)

  // 引擎重试（财务恢复）：补偿在独立事务内完成
  const stats = COMP.runCompensations()
  assert.equal(stats.done, 1)
  assert.equal(rsvById(book.id).status, 'refunded')
  assert.equal(rsvById(book.id).refund_amount, 3 * ride2.price)
  assert.equal(cash(), cashAfterBook - 3 * ride2.price, '补退后现金扣减一次')
  assert.equal(slotById(s.id).refund_count, 3)
  assert.ok(finLogs.some(f => f.amount === -3 * ride2.price), '补退流水留痕')
  assert.ok(complaints.some(c => c.title.includes(ride2.name)), '补退时补建投诉')

  // 再跑引擎：幂等，不二次退款
  const stats2 = COMP.runCompensations()
  assert.equal(stats2.done, 0)
  assert.equal(cash(), cashAfterBook - 3 * ride2.price, '现金不得二次扣减')
  assert.equal(slotById(s.id).refund_count, 3, 'refund_count 不得重复累加')
})

// ---------- 3. 人工已先退款：补偿任务重试时识别终态自动作废，绝不二次退款 ----------
test('人工先线下退款后补偿任务自动作废，绝不二次退款', () => {
  const s = rideSlot(3, 3, 12)
  const book = RSV.createReservation({ scope: 'ride', rideId: 3, slotId: s.id, qty: 1, requestId: 'c3-book' })
  assert.equal(book.ok, true)
  const cashAfterBook = cash()

  RSV.initReservationContext({ logFinance: () => { throw new Error('模拟财务流水故障') } })
  RSV.syncRideSlots({ id: 3, name: '摩天轮', status: 'maintenance' })
  RSV.initReservationContext({ logFinance: realLogFinance })
  const task = comps().find(t => t.status === 'pending' && t.ref_id === book.id)
  assert.ok(task)

  // 人工在业务侧先完成全额退款
  const manual = RSV.refundReservation(book.id, 'park', '人工先行补退')
  assert.equal(manual.ok, true)
  assert.equal(cash(), cashAfterBook - 45)

  // 引擎重试：处理器发现已退款 → 任务作废（dup），不重复退现金/不重复释放库存
  const stats = COMP.runCompensations()
  assert.equal(stats.done + stats.obsolete, 1)
  const after = db.prepare('SELECT * FROM compensation_tasks WHERE id=?').get(task.id)
  assert.ok(['done', 'obsolete'].includes(after.status))
  assert.equal(cash(), cashAfterBook - 45, '现金只退一次')
  assert.equal(slotById(s.id).refund_count, 1)
})

// ---------- 4. 人工登记“已处理”：自动补偿停止，不再触碰现金 ----------
test('登记人工已处理后任务终结，引擎不再自动执行资金动作', () => {
  const s = rideSlot(3, 4, 13)
  const book = RSV.createReservation({ scope: 'ride', rideId: 4, slotId: s.id, qty: 2, requestId: 'c4-book' })
  assert.equal(book.ok, true)
  const cashAfterBook = cash()

  RSV.initReservationContext({ logFinance: () => { throw new Error('故障') } })
  RSV.syncRideSlots({ id: 4, name: '跳楼机', status: 'closed' })
  RSV.initReservationContext({ logFinance: realLogFinance })
  const task = comps().find(t => t.status === 'pending' && t.ref_id === book.id)

  const mr = COMP.resolveTaskManual(task.id, { staffId: 9, note: '现场现金已退游客，凭回执登记' })
  assert.equal(mr.ok, true)
  const stats = COMP.runCompensations()
  assert.equal(stats.done, 0, '人工终结的任务不再自动执行')
  assert.equal(cash(), cashAfterBook, '队列不替人工再扣一次款')
  // 预约仍 booked（人工只登记了队列动作；真实场景人工应同时在业务侧退款，此处验证队列不擅自动资金）
  assert.equal(rsvById(book.id).status, 'booked')
})

// ---------- 5. 团队行程：停运失败挂起 → 补偿处理器重排/退款团款，现金库存团账一致，重复执行不二次退 ----------
test('团队停运补偿：任务重试完成重排或团款回退，团账/名额/现金一次到位', () => {
  // 准备：明天 9 点入园 + 10 点设施 5（碰碰车，未被其他用例关停）的 6 人团并确认
  const sub = G.submitGroup({
    leader_name: '赵团长', qty: 6,
    itinerary: [
      { kind: 'entry', day: 2, hour: 9 },
      { kind: 'ride', ride_id: 5, day: 2, hour: 10 }
    ],
    requestId: 'c5-submit'
  })
  assert.equal(sub.ok, true, sub.msg)
  const cf = G.confirmGroup(sub.id, { requestId: 'c5-confirm' })
  assert.equal(cf.ok, true, cf.msg)
  const g = db.prepare('SELECT * FROM group_orders WHERE id=?').get(sub.id)
  const rideItem = db.prepare("SELECT * FROM group_items WHERE group_id=? AND kind='ride'").get(sub.id)
  const cashAfterConfirm = cash()

  // 构造停运联动失败：直接以补偿队列挂起一团任务（模拟主事务回滚后的独立挂载）
  const n = G.enqueueGroupOutageCompensations(
    [{ id: 999, group_item_id: rideItem.id, source: 'group' }],
    { type: 'ride', ride: { id: 5, name: '碰碰车' }, reason: 'outage_failed' }
  )
  assert.equal(n, 1)
  const task = comps().find(t => t.domain === 'group' && t.status === 'pending')
  assert.ok(task)

  // 引擎执行补偿
  const stats = COMP.runCompensations()
  assert.equal(stats.failed, 0, '团队补偿不应失败')
  const itemAfter = db.prepare('SELECT * FROM group_items WHERE id=?').get(rideItem.id)
  assert.ok(['rerouted', 'interrupted', 'refund_park'].includes(itemAfter.status),
    `行程应被重排/挂起/退款，实际 ${itemAfter.status}`)
  const gAfter = db.prepare('SELECT * FROM group_orders WHERE id=?').get(sub.id)
  // 若入园/设施被退款，团款回退有流水；重排则不动现金。关键是团账应收与现金口径一致
  if (gAfter.refunded_amount > g.refunded_amount) {
    const back = gAfter.refunded_amount - g.refunded_amount
    assert.ok(finLogs.some(f => f.label === '团退款' && f.amount === -back), '团款回退应有流水')
  }
  assert.ok(complaints.some(c => c.title.includes(g.code)), '一团一投诉')

  // 再跑一次：处理器幂等（行程已非 active/rerouted 待安置态），任务不重复退团款
  const cashBefore2 = cash()
  COMP.runCompensations()
  assert.equal(cash(), cashBefore2, '重复执行不得二次退团款')
})

// ---------- 6. 团队补偿重试期间不得被爽约没收 ----------
test('团队补偿挂起期间跨天爽约扫描不没收该团团款', () => {
  const sub = G.submitGroup({
    leader_name: '钱团长', qty: 5,
    itinerary: [
      { kind: 'entry', day: 2, hour: 9 },
      { kind: 'ride', ride_id: 2, day: 2, hour: 10 }
    ],
    requestId: 'c6-submit'
  })
  G.confirmGroup(sub.id, { requestId: 'c6-confirm' })
  const rideItem = db.prepare("SELECT * FROM group_items WHERE group_id=? AND kind='ride'").get(sub.id)
  G.enqueueGroupOutageCompensations(
    [{ group_item_id: rideItem.id, source: 'group' }],
    { type: 'ride', ride: { id: 2, name: '旋转木马' } }
  )
  // 跨天执行爽约结案
  setSetting('day', 4)
  G.expireGroupNoShow()
  const item = db.prepare('SELECT * FROM group_items WHERE id=?').get(rideItem.id)
  assert.notEqual(item.status, 'noshow', '挂起补偿的行程不得按爽约没收')
  setSetting('day', 2)
})

// ---------- 7. 多次失败自动转人工，退避期不自动执行，人工可强制重试 ----------
test('超过尝试上限转人工队列；人工立即重试成功且只执行一次资金动作', () => {
  // 注册一个临时故障处理器域：前 3 次抛错，之后成功（通过闭包开关模拟资金服务恢复）
  let flips = 0
  COMP.registerHandler('flaky', (t) => {
    if (flips < 3) throw new Error('下游资金服务不可用')
    return { ok: true, cash: 7, qty: 1, note: '恢复后成功' }
  })
  const q = COMP.enqueueDetached({
    domain: 'flaky', action: 'flaky_test', idemKey: 'flaky:1', refType: 'test', refId: null,
    payload: {}, maxAttempts: 3
  })
  // 失败后退避 1 个 tick；逐拍推进时钟模拟引擎每小时重试
  COMP.runCompensations()
  setSetting('tick', Number(getSetting('tick')) + 1)
  COMP.runCompensations()
  setSetting('tick', Number(getSetting('tick')) + 1)
  COMP.runCompensations()
  let t = db.prepare("SELECT * FROM compensation_tasks WHERE idem_key='flaky:1'").get()
  assert.equal(t.attempts, 3)
  assert.equal(t.needs_manual, 1, '达到上限应转人工')

  // 转人工后普通引擎扫描不再自动执行
  flips = 0
  const skip = COMP.runCompensations()
  assert.equal(skip.done, 0, '人工队列任务不自动执行')
  t = db.prepare("SELECT * FROM compensation_tasks WHERE id=?").get(q.id)
  assert.equal(t.status, 'pending')

  // 下游恢复，人工强制重试成功
  flips = 3
  const mr = COMP.retryTask(q.id, { staffId: 1, note: '资金服务恢复，人工重试' })
  assert.equal(mr.ok, true, mr.msg)
  t = db.prepare("SELECT * FROM compensation_tasks WHERE id=?").get(q.id)
  assert.equal(t.status, 'done')
  assert.equal(t.needs_manual, 0)

  // 再次重试已终结任务被拒绝
  const again = COMP.retryTask(q.id)
  assert.equal(again.ok, false)
  assert.equal(again.code, 'TERMINAL')
})
