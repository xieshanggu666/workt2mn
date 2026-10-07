// 设施停运统一补偿中心一致性测试：
//   停运后的散客预约退款 / 团队行程重排退款 / 联营退款红冲统一接入可恢复补偿队列：
//   ① 主事务（关时段/停运/登记任务/投诉）提交后逐任务独立事务补偿；
//   ② 补偿失败任务保持 pending，现金/库存/单据不动（不虚报），引擎排空重试原子恢复；
//   ③ 人工或他途先行处置后任务置 obsolete，重试绝不二次扣款/二次退款；
//   ④ 联营红冲按任务幂等，重试不重复退款。
// 运行：node --experimental-sqlite --test server/outage.test.js（需 Node >= 22.5）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const G = await import('./groups.js')
const L = await import('./partners.js')
const OUTAGE = await import('./outage.js')

const finLogs = []
const complaints = []
let failRefundFinance = false

RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => {
    if (failRefundFinance && amount < 0) throw new Error('模拟退款流水失败')
    finLogs.push({ day, label, amount, detail })
  },
  createComplaint: p => { complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') } },
  planGroupOutageTasks: (rows, info) => G.planParkOutageGroupTasks(rows, info, 'outage')
})
G.initGroupContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: p => { complaints.push(p); return { id: complaints.length, code: 'TG' + String(complaints.length).padStart(4, '0') } }
})
L.initPartnerContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  deductCash: amount => setSetting('cash', Math.round(Number(getSetting('cash')) - amount))
})

const cash = () => Number(getSetting('cash'))
const rideSlot = (rid, day, hour) =>
  db.prepare('SELECT * FROM reservation_slots WHERE scope=? AND ride_id=? AND day=? AND hour=?').get('ride', rid, day, hour)
const entrySlot = (day, hour) =>
  db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=? AND hour=?").get(day, hour)
const pendingTasks = () => db.prepare("SELECT * FROM outage_tasks WHERE status='pending' ORDER BY id").all()

before(() => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
  setSetting('cash', 500000); setSetting('ticket', 100); setSetting('groupDepositRate', 0.3)
  RSV.ensureSlots()
})

test('散客停运补偿：停运主事务提交后逐单退款，现金/名额/投诉同步，任务置 done', () => {
  const s = rideSlot(1, 2, 10)
  const book = RSV.createReservation({ scope: 'ride', rideId: 1, slotId: s.id, qty: 3, requestId: 'oc-1' })
  assert.equal(book.ok, true)
  const cash0 = cash()
  const complaints0 = complaints.length

  const sync = RSV.syncRideSlots({ id: 1, name: '设施一', status: 'maintenance' })
  assert.equal(sync.ok, true)

  // 主事务提交后已逐单补偿：预约退款、现金扣减、名额释放、投诉生成
  const rsv = db.prepare('SELECT * FROM reservations WHERE id=?').get(book.id)
  assert.equal(rsv.status, 'refunded')
  assert.equal(rsv.reason, 'park')
  assert.equal(rsv.refund_amount, 3 * s.capacity >= 0 ? rsv.amount : 0)
  assert.ok(rsv.refund_amount > 0)
  assert.equal(cash(), cash0 - rsv.amount, '现金按全额退款扣减')
  assert.equal(rideSlot(1, 2, 10).status, 'closed')
  assert.equal(rideSlot(1, 2, 10).booked_count, 0, '名额释放')
  assert.equal(rideSlot(1, 2, 10).refund_count, 3)
  assert.ok(finLogs.some(f => f.amount === -rsv.amount), '退款财务流水留痕')
  assert.equal(complaints.length, complaints0 + 1, '每批停运生成一张设施故障投诉')
  // 补偿任务已完成，无挂起
  assert.equal(pendingTasks().filter(t => t.kind === 'reservation_refund').length, 0)
  assert.equal(db.prepare("SELECT status FROM outage_tasks WHERE id=1").get().status, 'done')
})

test('补偿失败可恢复：退款流水失败任务挂起，现金/名额/预约保持一致，恢复后排空原子补退且不重复', () => {
  const s = rideSlot(2, 2, 11)
  const book = RSV.createReservation({ scope: 'ride', rideId: 2, slotId: s.id, qty: 2, requestId: 'oc-2' })
  assert.equal(book.ok, true)
  const cash0 = cash()

  // 停运事务提交 + 补偿执行阶段持续失败
  failRefundFinance = true
  RSV.syncRideSlots({ id: 2, name: '设施二', status: 'maintenance' })
  let drain
  for (let i = 0; i < 3; i++) drain = OUTAGE.drainPendingTasks({ kinds: ['reservation_refund'] })
  failRefundFinance = false

  // 停运已生效，但补偿未完成：时段关闭落库（设施状态由报修/应急模块置停运，此处只验时段与补偿）；
  // 资金/名额/预约不动（不虚报）
  assert.equal(rideSlot(2, 2, 11).status, 'closed')
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(book.id).status, 'booked')
  assert.equal(cash(), cash0, '现金未退')
  assert.equal(rideSlot(2, 2, 11).booked_count, 2, '名额未释放')
  assert.equal(rideSlot(2, 2, 11).refund_count, 0)
  assert.ok(drain.remaining >= 1, '补偿任务保持 pending')
  const task = pendingTasks().find(t => t.kind === 'reservation_refund')
  assert.ok(task.attempts >= 3, '失败应累计尝试次数')
  assert.ok(task.last_error.includes('TX_FAILED') || task.last_error.includes('失败'))

  // 恢复后排空：一次性原子补退
  const rec = OUTAGE.drainPendingTasks({ kinds: ['reservation_refund'] })
  assert.equal(rec.failed, 0)
  const rsv = db.prepare('SELECT * FROM reservations WHERE id=?').get(book.id)
  assert.equal(rsv.status, 'refunded')
  assert.equal(cash(), cash0 - rsv.amount, '现金一次性退回')
  assert.equal(rideSlot(2, 2, 11).booked_count, 0)
  // 再排空幂等：无任务执行、现金不变、无二次退款流水
  const finNegBefore = finLogs.filter(f => f.amount === -rsv.amount).length
  OUTAGE.drainPendingTasks()
  assert.equal(finLogs.filter(f => f.amount === -rsv.amount).length, finNegBefore, '不得产生第二条退款流水')
  assert.equal(cash(), cash0 - rsv.amount, '不得二次退款')
})

test('人工先行处置后补偿任务作废：人工退款 → 排空不二次退款，任务置 obsolete', () => {
  const s = rideSlot(3, 2, 12)
  const book = RSV.createReservation({ scope: 'ride', rideId: 3, slotId: s.id, qty: 1, requestId: 'oc-3' })
  assert.equal(book.ok, true)
  const cash0 = cash()

  // 停运登记补偿任务但令其失败挂起
  failRefundFinance = true
  RSV.syncRideSlots({ id: 3, name: '设施三', status: 'closed' })
  OUTAGE.drainPendingTasks({ kinds: ['reservation_refund'] })
  failRefundFinance = false
  const taskId = pendingTasks().find(t => t.kind === 'reservation_refund').id

  // 人工在控制台完成全额退款（同事务作废旧任务）
  const manual = RSV.refundReservation(book.id, 'park', '人工补退')
  assert.equal(manual.ok, true)
  assert.equal(cash(), cash0 - manual.back)
  assert.equal(db.prepare('SELECT status FROM outage_tasks WHERE id=?').get(taskId).status, 'obsolete')

  // 引擎排空：无补偿执行，现金不二次扣减
  const rec = OUTAGE.drainPendingTasks()
  assert.equal(rec.done, 0)
  assert.equal(cash(), cash0 - manual.back, '人工处理后绝不二次退款')
})

test('团队停运补偿：在途团行程自动重排或回退团款，名额/团账同步，任务 done 不重复退款', () => {
  const r1 = db.prepare('SELECT * FROM rides WHERE id=4').get()
  const sub = G.submitGroup({
    leader_name: '补偿团', qty: 6,
    itinerary: [
      { kind: 'entry', day: 2, hour: 10 },
      { kind: 'ride', ride_id: r1.id, day: 2, hour: 11 }
    ], requestId: 'oc-grp-1'
  })
  assert.equal(sub.ok, true)
  const conf = G.confirmGroup(sub.id, { requestId: 'oc-grp-c1' })
  assert.equal(conf.ok, true)
  const cash0 = cash()

  const item = db.prepare('SELECT * FROM group_items WHERE group_id=? AND kind=?').get(sub.id, 'ride')
  const sync = RSV.syncRideSlots({ id: r1.id, name: r1.name, status: 'maintenance' })
  assert.equal(sync.ok, true)

  const after = db.prepare('SELECT * FROM group_items WHERE id=?').get(item.id)
  assert.ok(['rerouted', 'interrupted', 'refund_park'].includes(after.status))
  // 团补偿任务已终结（done 或被人工处置类路径），无 group 类挂起
  assert.equal(pendingTasks().filter(t => t.kind === 'group_outage').length, 0)

  if (after.status === 'refund_park') {
    // 园方回退团款：现金减少且团账有退款流水；重复排空不二次退
    const paid0 = db.prepare('SELECT COALESCE(SUM(-amount),0) s FROM group_payments WHERE group_id=? AND kind LIKE ?').get(sub.id, 'refund%').s
    assert.ok(paid0 > 0, '应有团退款流水')
    const cashAfter = cash()
    OUTAGE.drainPendingTasks()
    const paid1 = db.prepare('SELECT COALESCE(SUM(-amount),0) s FROM group_payments WHERE group_id=? AND kind LIKE ?').get(sub.id, 'refund%').s
    assert.equal(paid1, paid0, '重复排空不得新增团退款')
    assert.equal(cash(), cashAfter, '现金不二次扣减')
  } else if (after.status === 'rerouted') {
    // 重排：新预约在新设施时段且名额占用，旧名额已释放
    const newRsv = db.prepare('SELECT * FROM reservations WHERE id=?').get(after.reservation_id)
    assert.equal(newRsv.ride_id, after.ride_id)
    assert.notEqual(after.ride_id, item.ride_id)
    assert.equal(newRsv.qty, 6)
  }
  void cash0
})

test('联营退款补偿：任务排空后园方代付现金 + 负向红冲行入账，重复排空按任务幂等不二次退款', () => {
  // 新建商铺并签约联营
  const vr = db.prepare("INSERT INTO vendors(name,type,zone_id,rent,margin,price) VALUES('补偿联营铺','餐饮',1,0,0.6,25)").run()
  const vid = Number(vr.lastInsertRowid)
  const a = L.applyPartner({
    mode: 'existing', vendor_id: vid, name: '补偿联营商户', contact: '联系人',
    commission_rate: 0.2, settle_period_days: 7, deposit: 0
  })
  assert.equal(a.ok, true, a.msg)
  const ap = L.approveApplication(a.id)
  assert.equal(ap.ok, true, ap.msg)

  const cash0 = cash()
  const refund = 50   // 2 份 × 25
  const enq = L.enqueuePartnerRefundTask({ vendorId: vid, qty: 2, refund, note: '设施停运联动联营退款', source: 'outage' })
  assert.ok(enq.created)
  // 入队但未排空：现金未动、无红冲行
  assert.equal(cash(), cash0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return'").get().n, 0)

  const rec = OUTAGE.drainPendingTasks({ kinds: ['partner_refund'] })
  assert.equal(rec.failed, 0)
  assert.equal(cash(), cash0 - refund, '园方代付游客退款扣现金')
  const row = db.prepare("SELECT * FROM partner_sales WHERE kind='return' AND outage_task_id=?").get(enq.id)
  assert.ok(row, '红冲行应溯源补偿任务')
  assert.equal(row.bill_amount, -refund)
  assert.ok(row.merchant_share < 0, '商户分账应为负向红冲')
  assert.ok(finLogs.some(f => f.label === '商业' && f.amount === -refund), '退款财务流水留痕')

  // 重复排空：唯一索引 + replay 双重幂等，不产生第二条红冲、不二次扣现金
  OUTAGE.drainPendingTasks()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return' AND outage_task_id=?").get(enq.id).n, 1)
  assert.equal(cash(), cash0 - refund, '不得二次退款')
})

test('补偿中心统计：pending/done 按类型与日期口径正确', () => {
  const s = OUTAGE.outageStats()
  assert.equal(s.pending, 0, '前面用例补偿应均已终结')
  assert.equal(s.pendingByKind.reservation, 0)
  assert.equal(s.pendingByKind.group, 0)
  assert.equal(s.pendingByKind.partner, 0)
  assert.ok(s.doneToday >= 4, '当日应有多条已完成补偿任务')
})
