// 动态排班跨日计划预览与审批一致性测试：
// dry-run 预览不落地 / 审批原子落地 / 幂等 / 需求指纹 stale / 条目失效与冗余跳过 /
// 紧急调令计划→审批→考勤 / 预估工资与实际结算一致 / 引擎审批模式只生成待批计划 /
// auto 计划唯一且随需求刷新 / 跨日疲劳规避 / 驳回与过期
// 运行：node --experimental-sqlite --test server/dispatch_plan.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const SCH = await import('./scheduling.js')

const finLogs = []
SCH.initSchedulingContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  complaintRoles: { queue: ['保安', '安保'], hygiene: ['保洁'], facility: ['维修'] }
})

const tick = () => Number(getSetting('tick'))
function setClock(day, hour) {
  setSetting('day', day); setSetting('hour', hour)
  setSetting('tick', (day - 1) * 10 + (hour - 9))
}
const shiftByCode = code => db.prepare('SELECT * FROM shift_templates WHERE code=?').get(code)
const hire = (name, role = '保安') =>
  db.prepare('SELECT * FROM staff WHERE id=?').get(
    Number(db.prepare("INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,1,320,1,80,1)").run(name, role).lastInsertRowid))
const realDispatchCount = (from, to) =>
  db.prepare("SELECT COUNT(*) n FROM staff_schedules WHERE source='dispatch' AND day BETWEEN ? AND ? AND status<>'cancelled'").get(from, to).n
const attOf = schedId => db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(schedId)

before(() => {
  setClock(100, 9)
  setSetting('cash', 100000)
  setSetting('scheduleAutoFill', 0)   // 默认关闭引擎自动调度，用例精确控制
  setSetting('scheduleMode', 'dynamic')
  setSetting('scheduleApproval', 1)
  setSetting('dispatchGuardFlow', 150)
  setSetting('dispatchCleanFlow', 150)
  setSetting('dispatchNightGuardsPerZone', 0)
})

test('dry-run 预览：未审批不产生真实排班/调令；计划含需求快照、条目依据与预估工资', () => {
  setClock(100, 9)
  const r = SCH.createDispatchPlan({ horizon: 3, reason: '测试预览', requestId: 'dp-1' })
  assert.equal(r.ok, true)
  assert.ok(r.itemCount > 0, '未来三天应有补位条目')
  assert.ok(r.estWage > 0, '预估工资应为正')
  assert.equal(realDispatchCount(100, 102), 0, '审批前不得产生真实排班')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE source='dispatch' AND create_day>=100").get().n, 0, '审批前不得生成调令')
  const p = SCH.getDispatchPlan(r.id)
  assert.equal(p.status, 'pending')
  assert.equal(p.stale, false)
  assert.equal(p.days.length, 3)
  assert.ok(p.days[0].bands.some(b => b.need_guard >= 1), '需求快照应含班段岗位需求')
  const schedItem = p.items.find(i => i.kind === 'schedule' && i.check.state === 'applicable')
  assert.ok(schedItem)
  assert.equal(schedItem.reason_obj.need >= 1, true)
  assert.ok(schedItem.est_wage > 0)
  assert.equal(schedItem.est_wage, Math.round(schedItem.hourly_wage * db.prepare('SELECT standard_hours FROM shift_templates WHERE id=?').get(schedItem.shift_id).standard_hours))
})

test('生成幂等：同一 requestId 重放返回同一计划，不重复建单', () => {
  const r1 = SCH.createDispatchPlan({ horizon: 3, requestId: 'dp-idem' })
  const r2 = SCH.createDispatchPlan({ horizon: 3, requestId: 'dp-idem' })
  assert.equal(r2.ok, true); assert.equal(r2.id, r1.id); assert.equal(r2.replay, true)
})

test('审批：全部可落地条目原子写入真实排班，来源 dispatch，无同日重复排班；计划标记落地数', () => {
  setClock(101, 9)
  const r = SCH.createDispatchPlan({ horizon: 3, requestId: 'dp-app-1' })
  const before = SCH.getDispatchPlan(r.id)
  const expected = before.applicableCount
  assert.ok(expected > 0)
  const ap = SCH.approveDispatchPlan(r.id, null, '主管同意')
  assert.equal(ap.ok, true)
  assert.equal(ap.appliedSchedules.length + ap.appliedOts.length, expected)
  const appliedRows = db.prepare("SELECT * FROM dispatch_plan_items WHERE plan_id=? AND status='applied'").all(r.id)
  assert.equal(appliedRows.length, expected)
  // 落地排班条目都回写了真实 schedule_id
  assert.ok(appliedRows.filter(x => x.kind === 'schedule').every(x => x.schedule_id))
  const dup = db.prepare("SELECT staff_id,day,COUNT(*) n FROM staff_schedules WHERE day BETWEEN 101 AND 103 AND status<>'cancelled' GROUP BY staff_id,day HAVING n>1").all()
  assert.equal(dup.length, 0, '审批落地不得造成同日重复排班')
  const plan = db.prepare('SELECT * FROM dispatch_plans WHERE id=?').get(r.id)
  assert.equal(plan.status, 'approved')
  assert.equal(plan.applied_schedules + plan.applied_ots, expected)
  // 已审批计划不可重复审批
  assert.equal(SCH.approveDispatchPlan(r.id).ok, false)
})

test('审批部分失效：审批前员工已被占用的条目安全跳过（记原因），其余条目正常落地', () => {
  setClock(112, 9)
  const r = SCH.createDispatchPlan({ horizon: 2, requestId: 'dp-skip-1' })
  const items = SCH.getDispatchPlan(r.id).items
  const target = items.find(i => i.kind === 'schedule' && i.check.state === 'applicable')
  assert.ok(target)
  // 审批前给该员工手排同日另一班次 → 计划条目应在审批时判定冲突并跳过（选一个确定不冲突的目标班次）
  const otherShift = db.prepare('SELECT id FROM shift_templates WHERE id<>? AND cross_day=0 AND code<>? ORDER BY id LIMIT 1')
    .get(target.shift_id, db.prepare('SELECT code FROM shift_templates WHERE id=?').get(target.shift_id).code).id
  const man = SCH.createSchedule({ staffId: target.staff_id, shiftId: otherShift, day: target.day, requestId: 'dp-skip-man' })
  assert.equal(man.ok, true)
  const ap = SCH.approveDispatchPlan(r.id)
  assert.equal(ap.ok, true, '部分条目不影响整单审批')
  assert.ok(ap.skipped.some(s => s.id === target.id), '冲突条目应跳过')
  const skippedRow = db.prepare('SELECT * FROM dispatch_plan_items WHERE id=?').get(target.id)
  assert.equal(skippedRow.status, 'skipped')
  const plan = db.prepare('SELECT * FROM dispatch_plans WHERE id=?').get(r.id)
  assert.ok(plan.skipped_items >= 1)
})

test('需求指纹：计划生成后新增检修工单，计划标记 stale（需求已变化）', () => {
  setClock(103, 9)
  const r = SCH.createDispatchPlan({ horizon: 2, requestId: 'dp-stale' })
  assert.equal(SCH.getDispatchPlan(r.id).stale, false)
  const ride = db.prepare('SELECT * FROM rides ORDER BY id LIMIT 1').get()
  db.prepare("INSERT INTO maintenance_orders(code,ride_id,status,source,progress,cost,create_tick,create_day) VALUES('WXSTALE',?,'queued','manual',0,3000,?,103)")
    .run(ride.id, tick())
  assert.equal(SCH.getDispatchPlan(r.id).stale, true)
})

test('紧急调令计划：当天班段已开始缺岗 → dry-run 调令不落地；审批后生成 dispatch 调令，再批准写入考勤加班', () => {
  // 前一日闭园排次日早班保安；次日 13 点其在岗，其余保安全部晚班占住，压低阈值制造中班保安硬缺
  setClock(103, 18)
  const g = hire('计划调令保安甲')
  SCH.createSchedule({ staffId: g.id, shiftId: shiftByCode('morning').id, day: 104, requestId: 'dp-ot-1' })
  setClock(104, 13)
  SCH.processScheduling()   // 自动打卡（自动补位已关，仅考勤推进）
  assert.equal(attOf(db.prepare("SELECT id FROM staff_schedules WHERE staff_id=? AND day=104").get(g.id).id)?.status, 'checked_in')
  const old = Number(getSetting('dispatchGuardFlow'))
  setSetting('dispatchGuardFlow', 100)
  db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND id<>?").all(g.id)
    .forEach((x, i) => SCH.createSchedule({ staffId: x.id, shiftId: shiftByCode('evening').id, day: 104, requestId: `dp-ot-o${i}` }))
  const r = SCH.createDispatchPlan({ horizon: 1, reason: '中班硬缺' })
  const p = SCH.getDispatchPlan(r.id)
  const ot = p.items.find(i => i.kind === 'overtime')
  assert.ok(ot, '应推演出现场紧急加班调令条目')
  assert.equal(ot.check.state, 'applicable')
  assert.ok(ot.ot_ticks >= 1 && ot.ot_ticks <= 4)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE source='dispatch' AND schedule_id=?").get(ot.schedule_id).n, 0, '审批前不得落调令')
  const ap = SCH.approveDispatchPlan(r.id)
  assert.equal(ap.appliedOts.length, 1)
  const reqId = ap.appliedOts[0].request_id
  const rq = db.prepare('SELECT * FROM shift_requests WHERE id=?').get(reqId)
  assert.equal(rq.source, 'dispatch'); assert.equal(rq.status, 'pending')
  // 主管批准调令 → 写入考勤加班，下班点顺延（沿用既有加班审批闭环）
  const ap2 = SCH.approveOvertime(reqId, null)
  assert.equal(ap2.ok, true)
  assert.ok(ap2.overtime_ticks >= 1)
  setSetting('dispatchGuardFlow', old)
})

test('冗余调令：缺口在审批前已被补齐时，调令条目标记 redundant，审批不再生成调令', () => {
  setClock(104, 18)
  const g = hire('冗余测试保安')
  SCH.createSchedule({ staffId: g.id, shiftId: shiftByCode('morning').id, day: 105, requestId: 'dp-rd-1' })
  setClock(105, 13)
  SCH.processScheduling()
  const old = Number(getSetting('dispatchGuardFlow'))
  setSetting('dispatchGuardFlow', 100)
  db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND id<>?").all(g.id)
    .forEach((x, i) => SCH.createSchedule({ staffId: x.id, shiftId: shiftByCode('evening').id, day: 105, requestId: `dp-rd-o${i}` }))
  const r = SCH.createDispatchPlan({ horizon: 1 })
  const otItem = SCH.getDispatchPlan(r.id).items.find(i => i.kind === 'overtime')
  assert.ok(otItem)
  // 审批前新增一名保安排入中班（允许补入进行中班段），缺口消解
  const fresh = hire('补位保安')
  assert.equal(SCH.createSchedule({
    staffId: fresh.id, shiftId: shiftByCode('mid').id, day: 105,
    requestId: 'dp-rd-fill', allowStarted: true
  }).ok, true)
  const replay = SCH.getDispatchPlan(r.id)
  assert.equal(replay.items.find(i => i.id === otItem.id).check.state, 'redundant')
  const ap = SCH.approveDispatchPlan(r.id)
  assert.equal(ap.appliedOts.length, 0, '缺口已补齐，不应再产生调令')
  setSetting('dispatchGuardFlow', old)
})

test('工资一致：审批落地排班的预估工资 = 下班实际结算工资（含 1.5 倍加班调令溢价）', () => {
  setClock(106, 9)
  const r = SCH.createDispatchPlan({ horizon: 1, requestId: 'dp-wage' })
  const p = SCH.getDispatchPlan(r.id)
  const item = p.items.find(i => i.kind === 'schedule' && i.day === 106 && i.check.state === 'applicable')
  assert.ok(item)
  SCH.approveDispatchPlan(r.id)
  const schId = db.prepare('SELECT schedule_id FROM dispatch_plan_items WHERE id=?').get(item.id).schedule_id
  setClock(106, 9)
  SCH.processScheduling()
  const wage = db.prepare('SELECT wage FROM staff WHERE id=?').get(item.staff_id).wage
  const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(item.shift_id)
  setClock(106, sh.end_hour)
  SCH.processScheduling()
  const att = attOf(schId)
  assert.equal(att.status, 'checked_out')
  assert.equal(att.pay, item.est_wage, '实际结算工资应等于计划预估工资')
  assert.equal(att.pay, Math.round(Math.round(wage / 5) * sh.standard_hours))
  assert.ok(finLogs.some(f => f.label === '工资' && f.amount === -att.pay && f.detail.includes(att.code)))
})

test('引擎审批模式：processScheduling 只生成 auto 待批计划，不直接补排班；同需求去重、需求变化后旧单 obsolete', () => {
  setClock(107, 9)
  setSetting('scheduleAutoFill', 1)
  setSetting('scheduleApproval', 1)
  assert.equal(realDispatchCount(107, 109), 0)
  SCH.processScheduling()
  const auto1 = db.prepare("SELECT * FROM dispatch_plans WHERE source='auto' AND status='pending' AND day_from=107").get()
  assert.ok(auto1, '引擎应生成 auto 待批计划')
  assert.equal(realDispatchCount(107, 109), 0, '审批模式引擎不得直接补位')
  // 同需求指纹再次推进：不重复建单
  setClock(107, 10)
  SCH.processScheduling()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dispatch_plans WHERE source='auto' AND status='pending' AND day_from=107").get().n, 1)
  // 需求变化（承载阈值下调，缺口增多）：旧单 obsolete，新待批计划出现
  setSetting('dispatchGuardFlow', 120)
  setClock(107, 11)
  SCH.processScheduling()
  assert.equal(db.prepare("SELECT status FROM dispatch_plans WHERE id=?").get(auto1.id).status, 'obsolete')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dispatch_plans WHERE source='auto' AND status='pending' AND day_from=107").get().n, 1)
  setSetting('scheduleAutoFill', 0)
})

test('驳回：计划不产生任何排班，条目留痕 skipped', () => {
  setClock(108, 9)
  const r = SCH.createDispatchPlan({ horizon: 2, requestId: 'dp-rej' })
  const n = SCH.getDispatchPlan(r.id).applicableCount
  assert.ok(n > 0)
  const rj = SCH.rejectDispatchPlan(r.id, null, '人手充足')
  assert.equal(rj.ok, true)
  assert.equal(realDispatchCount(108, 109), 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dispatch_plan_items WHERE plan_id=? AND status<>'skipped'").get(r.id).n, 0)
  assert.equal(SCH.rejectDispatchPlan(r.id).ok, false)
})

test('跨日疲劳规避：计划内前夜跨日夜班员工，次日不再出现日班条目', () => {
  setClock(109, 9)
  setSetting('dispatchNightGuardsPerZone', 2)   // 强制夜勤保安需求
  const r = SCH.createDispatchPlan({ horizon: 3, requestId: 'dp-night' })
  const items = SCH.getDispatchPlan(r.id).items.filter(i => i.check.state === 'applicable')
  const nights = items.filter(i => i.band === 'night')
  assert.ok(nights.length > 0, '应推演跨日夜班条目')
  for (const n of nights) {
    const nextDayItem = items.find(i => i.staff_id === n.staff_id && i.day === n.day + 1 && i.band !== 'night')
    assert.equal(nextDayItem, undefined, `员工 ${n.staff_name} 前夜夜班次日不应再排日班`)
  }
  setSetting('dispatchNightGuardsPerZone', 0)
})

test('过期清理：day_to 早于今日的待批计划自动 expired', () => {
  setClock(109, 18)
  const r = SCH.createDispatchPlan({ horizon: 1 })
  setClock(111, 9)
  const n = SCH.expireDispatchPlans()
  assert.ok(n >= 1)
  assert.equal(db.prepare('SELECT status FROM dispatch_plans WHERE id=?').get(r.id).status, 'expired')
})
