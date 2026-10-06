// 园区应急指挥一致性测试：
// 发现→分级→封控（设施停运+预约退款+投诉同事务）→疏散→控场→复园（恢复+费用结算）→复盘
// 覆盖：状态机非法流转拦截、误报关闭恢复、理赔现金赔付与投诉闭环、超时限自动升级、
//       幂等重放不重复副作用、事务中段失败整体回滚（设施/时段/退款/投诉不留半成品）
// 运行：node --test server/emergency.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const MAINT = await import('./maintenance.js')
const EM = await import('./emergency.js')

// ---- 共享测试上下文：记录财务流水、投诉建单/关闭、排班在岗、调度触发 ----
const finLogs = []
const complaints = new Map()   // id -> row
const closedComplaints = []
let failRefundFinance = false  // 注入：退款流水失败 → 封控事务须整体回滚
let dispatchCalls = 0

RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => {
    if (failRefundFinance && amount < 0) throw new Error('模拟退款流水失败')
    finLogs.push({ day, label, amount, detail })
  },
  createComplaint: p => {
    const id = complaints.size + 1
    complaints.set(id, { id, status: 'open', ...p })
    return { id, code: 'TS' + String(id).padStart(4, '0') }
  },
  handleParkOutageGroup: () => {}
})
MAINT.initMaintenanceContext({
  logFinance: (...a) => finLogs.push(a[3] === undefined ? { label: a[1] } : { day: a[0], label: a[1], amount: a[2], detail: a[3] }),
  syncRideSlots: ride => RSV.syncRideSlots(ride),
  linkComplaintsToRide: () => {},
  staffDutyState: () => ({ scheduled: true, onDuty: true }),
  onWorkComplete: () => {}
})
EM.initEmergencyContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  syncRideSlots: ride => RSV.syncRideSlots(ride),
  closeEntrySlots: () => RSV.emergencyCloseEntrySlots('测试全园封控'),
  reopenEntrySlots: () => RSV.emergencyReopenEntrySlots(),
  createComplaint: p => {
    const id = complaints.size + 1
    complaints.set(id, { id, status: 'open', ...p })
    return { id, code: 'TS' + String(id).padStart(4, '0') }
  },
  closeComplaintLinked: (cid, inc, kind, meta = {}) => {
    const c = complaints.get(cid)
    if (!c || !['open', 'processing', 'ready'].includes(c.status)) return
    c.status = kind === 'claim_paid' || kind === 'event_review' ? 'closed_resolved' : 'closed_force'
    c.kind = kind
    c.meta = meta
    closedComplaints.push({ cid, kind })
  },
  staffDutyState: () => ({ scheduled: true, onDuty: true }),
  dispatchAfter: () => { dispatchCalls++ }
})

const cash = () => Number(getSetting('cash'))
const incById = id => db.prepare('SELECT * FROM incidents WHERE id=?').get(id)
const rideById = id => db.prepare('SELECT * FROM rides WHERE id=?').get(id)
const rideSlot = (rideId, day, hour) =>
  db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND day=? AND hour=?").get(rideId, day, hour)
const logCount = iid => db.prepare('SELECT COUNT(*) n FROM incident_logs WHERE incident_id=?').get(iid).n

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 10)
  setSetting('cash', 200000)
  setSetting('ticket', 100)
  RSV.ensureSlots()
})

test('发现上报：游客上报自动联动安全投诉；运营上报不建投诉', () => {
  const v = EM.reportIncident({ type: 'medical', title: '游客晕倒', reporterRole: 'visitor', requestId: 'r-visitor' })
  assert.equal(v.ok, true)
  assert.ok(v.code.startsWith('EM'))
  assert.equal(incById(v.id).status, 'reported')
  assert.ok(incById(v.id).complaint_id, '游客上报应自动生成关联投诉')

  const o = EM.reportIncident({ type: 'fire', title: '设备冒烟', reporterRole: 'operations', requestId: 'r-ops' })
  assert.equal(o.ok, true)
  assert.equal(incById(o.id).complaint_id, null, '运营上报不自动建投诉（分级时再建）')
})

test('非法状态流转被拦截：未分级不能复园/复盘', () => {
  const r = EM.reportIncident({ type: 'other', title: '待分级事件', reporterRole: 'security', requestId: 'r-bad1' })
  assert.equal(EM.reopenIncident(r.id, { requestId: 'x1' }).ok, false)
  assert.equal(EM.reviewIncident(r.id, { cause: '原因', requestId: 'x2' }).ok, false)
  assert.equal(EM.controlIncident(r.id, { requestId: 'x3' }).ok, false)
  assert.equal(incById(r.id).status, 'reported', '状态保持不变')
})

test('分级即封控：1级仅分级；2级封锁事发区域并停运设施、在途预约全额退款、生成投诉（同事务）', () => {
  // 给设施1（区域2）与设施3（区域1）各下一单未来预约
  const s1 = rideSlot(1, 2, 10)
  const s3 = rideSlot(3, 2, 11)
  const b1 = RSV.createReservation({ scope: 'ride', rideId: 1, slotId: s1.id, qty: 3, requestId: 'em-b1' })
  const b3 = RSV.createReservation({ scope: 'ride', rideId: 3, slotId: s3.id, qty: 2, requestId: 'em-b3' })
  assert.equal(b1.ok, true); assert.equal(b3.ok, true)
  const cash0 = cash()

  const r = EM.reportIncident({
    type: 'facility', title: '设施异响晃动', reporterRole: 'security',
    zoneId: 2, requestId: 'r-fac-report'
  })
  // 仅显式封控设施1（不全区域封锁），保持后续测试可用设施
  const g = EM.gradeIncident(r.id, {
    severity: 2,
    lockdown: { rides: [1], zones: [], autoZone: false },
    requestId: 'r-fac-grade'
  })
  assert.equal(g.ok, true)
  assert.equal(g.status, 'contained', '2级且有区域 → 分级即封控')
  assert.ok(g.refundRideQty >= 3, '设施1的在途预约应退款')

  const inc = incById(r.id)
  assert.equal(inc.severity, 2)
  assert.equal(inc.status, 'contained')
  assert.ok(inc.control_deadline_tick > 10, '应设置封控时限')
  assert.ok(inc.complaint_id, '2级以上应联动安全投诉')
  // 仅设施1停运
  assert.equal(rideById(1).status, 'closed', '设施应应急停运')
  assert.equal(rideSlot(1, 2, 10).status, 'closed', '设施时段应关停')
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(b1.id).status, 'refunded')
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(b3.id).status, 'booked', '未封控设施不受影响')
  assert.equal(rideById(3).status, 'operating')
  // 现金按退款扣减
  const refund = db.prepare('SELECT refund_amount FROM reservations WHERE id=?').get(b1.id).refund_amount
  assert.equal(cash(), cash0 - refund)
  // 封控对象已登记
  const targets = db.prepare('SELECT * FROM incident_targets WHERE incident_id=?').all(r.id)
  assert.ok(targets.some(t => t.target_type === 'ride' && t.target_id === 1))
})

test('全流程：疏散→控场→复园（恢复设施/区域、重开时段、结算抢险费与补贴）→复盘（声誉回补、投诉闭环）', () => {
  const r = EM.reportIncident({ type: 'crowd', title: '人流对冲拥挤', reporterRole: 'security', zoneId: 5, requestId: 'r-flow' })
  assert.equal(EM.gradeIncident(r.id, {
    severity: 3, lockdown: { rides: [2], zones: [], autoZone: false }, requestId: 'r-flow-grade'
  }).ok, true)
  const guard = db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND active=1 LIMIT 1").get()
  // 调派安保并到场
  const a = EM.assignIncidentStaff(r.id, { staffId: guard.id, taskType: 'evacuate', requestId: 'r-alloc' })
  assert.equal(a.ok, true)
  const link = db.prepare("SELECT * FROM incident_staff WHERE incident_id=? AND staff_id=?").get(r.id, guard.id)
  assert.equal(EM.acknowledgeStaff(link.id, { requestId: 'r-ack' }).ok, true)
  // 疏散两批
  assert.equal(EM.startEvacuation(r.id, { qty: 30, staffId: guard.id, requestId: 'r-ev1' }).ok, true)
  assert.equal(EM.reportEvacuation(r.id, { qty: 25, staffId: guard.id, requestId: 'r-ev2' }).ok, true)
  assert.equal(incById(r.id).evacuated_qty, 55)
  assert.equal(incById(r.id).status, 'evacuating')
  // 控场
  assert.equal(EM.controlIncident(r.id, { casualties: 1, staffId: guard.id, requestId: 'r-ctrl' }).ok, true)
  assert.equal(incById(r.id).status, 'controlled')
  assert.equal(incById(r.id).casualties, 1)

  const cashBeforeReopen = cash()
  const ro = EM.reopenIncident(r.id, { requestId: 'r-reopen' })
  assert.equal(ro.ok, true)
  assert.equal(ro.status, 'reopened')
  // 区域5重新开放、区内设施恢复运营并重开时段
  assert.equal(db.prepare('SELECT open FROM zones WHERE id=5').get().open, 1)
  // 抢险费（3级=6000）+ 疏散补贴（150）
  assert.equal(ro.rescueCost, 6000)
  assert.equal(ro.subsidy, 150)
  assert.equal(cash(), cashBeforeReopen - 6150)
  assert.ok(finLogs.some(f => f.label === '应急' && f.amount === -6000))
  assert.ok(finLogs.some(f => f.label === '应急' && f.amount === -150))
  // 应急补贴已回写到编组
  assert.equal(db.prepare('SELECT subsidy FROM incident_staff WHERE id=?').get(link.id).subsidy, 150)

  // 复盘：评分5、时限内封控 → 声誉回补为正；关联投诉闭环
  const rep0 = Number(getSetting('reputation'))
  const rv = EM.reviewIncident(r.id, { cause: '短时客流对冲，疏导不足', actions: '增设硬隔离', rating: 5, requestId: 'r-review' })
  assert.equal(rv.ok, true)
  assert.equal(incById(r.id).status, 'closed_review')
  assert.ok(rv.repRecover > 0)
  assert.equal(Number(getSetting('reputation')) >= rep0, true)
  const cid = incById(r.id).complaint_id
  assert.ok(cid && complaints.get(cid).status === 'closed_resolved', '关联投诉应随复盘闭环')
})

test('误报关闭：恢复封控对象，不计抢险费用', () => {
  const r = EM.reportIncident({ type: 'smoke', title: '疑似烟雾', reporterRole: 'security', zoneId: 6, requestId: 'r-false-rep' })
  assert.equal(EM.gradeIncident(r.id, { severity: 2, requestId: 'r-false-grade' }).ok, true)
  assert.equal(db.prepare('SELECT open FROM zones WHERE id=6').get().open, 0)
  const cash0 = cash()
  const f = EM.closeFalseIncident(r.id, { requestId: 'r-false-close' })
  assert.equal(f.ok, true)
  assert.equal(incById(r.id).status, 'closed_false')
  assert.equal(db.prepare('SELECT open FROM zones WHERE id=6').get().open, 1, '区域应恢复开放')
  assert.equal(cash(), cash0, '误报不计抢险费用')
  assert.equal(incById(r.id).rescue_cost, 0)
})

test('游客理赔：现金赔付出账并闭环关联投诉；驳回不出账；现金不足拒绝赔付', () => {
  const r = EM.reportIncident({ type: 'food', title: '餐后不适', reporterRole: 'operations', requestId: 'r-cl-inc' })
  EM.gradeIncident(r.id, { severity: 1, lockdown: {}, requestId: 'r-cl-grade' }) // 1级仅分级
  const cl = EM.fileClaim(r.id, { guestName: '王女士', item: '医疗费用', amountReq: 800, requestId: 'r-cl-file' })
  assert.equal(cl.ok, true)
  assert.ok(cl.complaintId, '理赔应自动生成关联投诉')
  const claimRow = () => db.prepare('SELECT * FROM incident_claims WHERE id=?').get(cl.id)

  // 超额赔付（现金不足）拒绝
  const huge = EM.payClaim(cl.id, { amount: 999999999, requestId: 'r-cl-huge' })
  assert.equal(huge.ok, false)
  assert.equal(claimRow().status, 'submitted')

  const cash0 = cash()
  const pay = EM.payClaim(cl.id, { amount: 600, requestId: 'r-cl-pay' })
  assert.equal(pay.ok, true)
  assert.equal(pay.amount, 600)
  assert.equal(cash(), cash0 - 600)
  assert.ok(finLogs.some(f => f.label === '应急补偿' && f.amount === -600))
  assert.equal(claimRow().status, 'paid')
  assert.equal(complaints.get(cl.complaintId).status, 'closed_resolved')
  // 重复赔付被状态拦截
  assert.equal(EM.payClaim(cl.id, { amount: 600, requestId: 'r-cl-pay2' }).ok, false)

  // 第二笔理赔驳回：不出账
  const cl2 = EM.fileClaim(r.id, { guestName: '李先生', item: '财物', amountReq: 200, requestId: 'r-cl-file2' })
  const cash1 = cash()
  assert.equal(EM.rejectClaim(cl2.id, { note: '无责', requestId: 'r-cl-rej' }).ok, true)
  assert.equal(cash(), cash1)
  assert.equal(complaints.get(cl2.complaintId).status, 'closed_force')
})

test('幂等：同 request_id 重放不重复建单/封控/退款/赔付', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM incidents').get().n
  const p1 = EM.reportIncident({ type: 'other', title: '幂等事件', reporterRole: 'security', requestId: 'idem-key-1' })
  const p2 = EM.reportIncident({ type: 'other', title: '幂等事件', reporterRole: 'security', requestId: 'idem-key-1' })
  assert.equal(p2.replay, true)
  assert.equal(p1.id, p2.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM incidents').get().n, before + 1)
  assert.equal(logCount(p1.id), 1, '重放不重复写时间线')

  // 封控退款幂等
  const s = rideSlot(4, 2, 12)
  const b = RSV.createReservation({ scope: 'ride', rideId: 4, slotId: s.id, qty: 2, requestId: 'idem-book' })
  const g1 = EM.gradeIncident(p1.id, { severity: 2, lockdown: { rides: [4], zones: [], autoZone: false }, requestId: 'idem-grade' })
  const g2 = EM.gradeIncident(p1.id, { severity: 2, lockdown: { rides: [4], zones: [], autoZone: false }, requestId: 'idem-grade' })
  assert.equal(g2.replay, true)
  assert.equal(g1.refundRideQty, g2.refundRideQty)
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(b.id).status, 'refunded')
  assert.equal(db.prepare('SELECT refund_amount FROM reservations WHERE id=?').get(b.id).refund_amount > 0, true)
})

test('封控事务原子回滚：退款流水中段失败 → 设施/时段/封控对象/事件状态全部回滚', () => {
  const s = rideSlot(6, 2, 13)
  const b = RSV.createReservation({ scope: 'ride', rideId: 6, slotId: s.id, qty: 2, requestId: 'roll-book' })
  assert.equal(b.ok, true)
  const r = EM.reportIncident({ type: 'facility', title: '回滚用事件', reporterRole: 'operations', requestId: 'roll-rep' })
  const cash0 = cash()

  failRefundFinance = true
  const g = EM.gradeIncident(r.id, {
    severity: 2, lockdown: { rides: [6], zones: [], autoZone: false }, requestId: 'roll-grade'
  })
  failRefundFinance = false

  assert.equal(g.ok, false, '联动失败必须返回失败而非假成功')
  assert.equal(rideById(6).status, 'operating', '设施停运应回滚')
  assert.equal(rideSlot(6, 2, 13).status, 'open', '时段关停应回滚')
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(b.id).status, 'booked', '预约退款应回滚')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM incident_targets WHERE incident_id=?').get(r.id).n, 0, '封控对象应回滚')
  assert.equal(incById(r.id).status, 'reported', '事件分级应回滚为待分级')
  assert.equal(cash(), cash0, '现金不得变化')

  // 恢复后重试成功
  const retry = EM.gradeIncident(r.id, {
    severity: 2, lockdown: { rides: [6], zones: [], autoZone: false }, requestId: 'roll-grade-retry'
  })
  assert.equal(retry.ok, true)
  assert.equal(rideById(6).status, 'closed')
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(b.id).status, 'refunded')
  // 复园恢复
  assert.equal(EM.controlIncident(r.id, { requestId: 'roll-ctrl' }).ok, true)
  const ro = EM.reopenIncident(r.id, { requestId: 'roll-reopen' })
  assert.equal(ro.ok, true)
  assert.equal(rideById(6).status, 'operating', '复园应恢复运营')
})

test('SLA 引擎：上报久未分级自动核定；超封控时限未控场自动升级并可升到4级', () => {
  const r = EM.reportIncident({ type: 'fire', title: '限时事件', reporterRole: 'security', requestId: 'sla-rep' })
  const startTick = incById(r.id).create_tick
  // 推进 4 tick 未分级 → 自动分级（火情默认3级）
  setSetting('tick', startTick + 4)
  EM.processIncidents()
  let inc = incById(r.id)
  assert.equal(inc.status, 'graded')
  assert.equal(inc.severity, 3)

  // 超过封控时限（3级=2tick）仍未控场 → 升4级
  setSetting('tick', inc.control_deadline_tick + 1)
  EM.processIncidents()
  inc = incById(r.id)
  assert.equal(inc.severity, 4)
  assert.equal(inc.status, 'graded', '未封控保持 graded，仅升级')

  // 客流折减：在途4级事件显著压制客流
  assert.ok(EM.activeCrowdFactor() <= 0.2)
})

test('安全投诉转报为事件；重复转报被拦截', () => {
  const cid = 9001
  db.prepare(`INSERT INTO complaints(id,code,tick,day,category,severity,title,status,deadline_tick,source)
              VALUES(?,?,999,1,'safety',3,'测试安全投诉','open',1000,'manual')`)
    .run(cid, 'TS9001')
  complaints.set(cid, { id: cid, status: 'open', category: 'safety' })
  const r = EM.escalateFromComplaint(cid, { requestId: 'r-from-c' })
  assert.equal(r.ok, true)
  assert.equal(incById(r.id).source, 'complaint')
  assert.equal(incById(r.id).complaint_id, cid)
  assert.equal(EM.escalateFromComplaint(cid, { requestId: 'r-from-c2' }).ok, false, '在途事件期间不得重复转报')
})
