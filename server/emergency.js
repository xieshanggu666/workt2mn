import db, { getSetting, setSetting, tx } from './db.js'

// 园区应急指挥模块：安全事件 发现 → 分级 → 封控 → 疏散 → 复园 → 复盘 全状态流转
// 联动：设施停运与预约退款、游客投诉与理赔、岗位调度（安保）、财务补偿与抢险结算
// 所有写操作走幂等键 + 事务：多步联动（停运/退款/投诉/封控）任一步失败整体回滚，不留半完成状态
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 由 index.js 注入共享上下文（时钟、现金、财务流水、停运时段联动、投诉、排班调度）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  // (ride)=>sync 结果：设施停运/恢复联动关时段、在途预约全额退款、团行程重排、投诉
  syncRideSlots: null,
  // ()=>入园时段关停（特别重大事件全园封控），返回退款人数
  closeEntrySlots: null,
  reopenEntrySlots: null,
  // 投诉建单 / 关闭关联投诉
  createComplaint: null,
  closeComplaintLinked: null,
  // 排班在岗校验 + 应急岗位需求触发动态调度
  staffDutyState: null,
  dispatchAfter: null
}
export function initEmergencyContext(deps) {
  Object.assign(ctx, deps)
}

// ---------------- 常量：事件类型 / 等级 / 状态机 / 时限 ----------------
export const INCIDENT_TYPES = {
  fire:     { name: '火情火灾', icon: '🔥', defSev: 3 },
  facility: { name: '设备事故', icon: '🎢', defSev: 2 },
  crowd:    { name: '人群拥挤踩踏', icon: '👥', defSev: 2 },
  food:     { name: '食物中毒', icon: '🤢', defSev: 3 },
  medical:  { name: '游客急病受伤', icon: '🚑', defSev: 1 },
  weather:  { name: '极端天气', icon: '⛈️', defSev: 2 },
  security: { name: '治安事件', icon: '🚨', defSev: 2 },
  power:    { name: '停电停水', icon: '⚡', defSev: 2 },
  missing:  { name: '人员走失', icon: '🔎', defSev: 1 },
  other:    { name: '其他安全事件', icon: '⚠️', defSev: 1 }
}

export const SEVERITY_NAMES = { 0: '待分级', 1: '一般', 2: '较大', 3: '重大', 4: '特别重大' }
// 分级后完成封控的处置时限（tick=游戏小时）
export const CONTROL_SLA = { 1: 6, 2: 4, 3: 2, 4: 1 }
// 上报后未分级的时限：超时系统自动按建议级别分级
const GRADE_SLA = 4
// 各等级封控时的抢险费用基数（按等级核定）
export const RESCUE_COST = { 1: 800, 2: 2500, 3: 6000, 4: 15000 }
// 应急岗位补贴（元/人，复园结算）
export const STAFF_SUBSIDY = { control: 120, evacuate: 150, rescue: 200, medical: 180 }
// 在途（已分级未复园）事件对散客客流的折减系数
export const CROWD_FACTOR = { 1: 0.92, 2: 0.78, 3: 0.5, 4: 0.15 }

export const STATUS_FLOW = {
  reported:      { name: '待分级', icon: '📥', next: ['graded', 'closed_false'] },
  graded:        { name: '已分级', icon: '🚩', next: ['contained', 'evacuating', 'closed_false'] },
  contained:     { name: '已封控', icon: '🚧', next: ['evacuating', 'controlled', 'reopened'] },
  evacuating:    { name: '疏散中', icon: '🏃', next: ['controlled'] },
  controlled:    { name: '已控场', icon: '✅', next: ['reopened'] },
  reopened:      { name: '已复园', icon: '🌤️', next: ['closed_review'] },
  closed_review: { name: '复盘结案', icon: '📋', next: [] },
  closed_false:  { name: '误报关闭', icon: '❔', next: [] }
}
// 事件在途（未复园/未结案）状态
export const ACTIVE_INCIDENT_STATUSES = ['reported', 'graded', 'contained', 'evacuating', 'controlled']

const ROLE_NAMES = { operations: '运营', security: '安保', visitor: '游客', system: '系统' }
export function roleName(r) { return ROLE_NAMES[r] || r || '' }

function fail(code, msg, extra = {}) { return { ok: false, code, msg, ...extra } }

// ---------------- 幂等（与预约/组团同口径：业务结果缓存，系统异常回滚不缓存） ----------------
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  let result
  try {
    result = fn()
  } catch (e) {
    console.error('[emergency] 事务执行失败，已整体回滚:', e)
    return fail('TX_FAILED', '系统繁忙，本次操作未生效，请稍后重试')
  }
  if (result?.ok || (result?.code && result.code !== 'TX_FAILED')) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

function logIncident(iid, action, note = '', staffId = null, actorRole = 'operations') {
  db.prepare('INSERT INTO incident_logs(incident_id,tick,day,hour,action,note,staff_id,actor_role) VALUES(?,?,?,?,?,?,?,?)')
    .run(iid, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId, actorRole)
}

function getIncident(id) {
  return db.prepare('SELECT * FROM incidents WHERE id=?').get(num(id))
}

function ensureTransition(inc, to) {
  const allows = STATUS_FLOW[inc.status]?.next || []
  if (!allows.includes(to)) {
    throw new TxBusiness(`当前状态「${STATUS_FLOW[inc.status]?.name || inc.status}」不能流转到「${STATUS_FLOW[to]?.name || to}」`)
  }
}
// 业务校验失败：回滚并返回可读提示（幂等可缓存，允许用户修正后换键重试）
class TxBusiness extends Error {}

function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxBusiness) return fail('INC_STATUS_CONFLICT', e.message)
    console.error('[emergency] 事务失败，已整体回滚:', e)
    return fail('TX_FAILED', '系统繁忙，本次操作未生效，请稍后重试')
  }
}

// ---------------- 封控对象联动（设施停运 / 区域封锁） ----------------
// 封控单个设施：状态改 closed（应急停运，区别于检修 maintenance），记录原状态，
// 调用预约模块关停时段 + 在途预约园方全额退款 + 团行程重排 + 自动投诉（同一事务）
function lockdownRide(inc, rideId, note) {
  const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(rideId)
  if (!ride) throw new TxBusiness(`设施 #${rideId} 不存在`)
  // 在途检修工单的设施不重复停运（其已停运且退款联动已完成），只登记封控对象用于复园判断
  const openOrder = db.prepare("SELECT id FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing')").get(rideId)
  const prev = ride.status
  const ins = db.prepare(`INSERT OR IGNORE INTO incident_targets(incident_id,target_type,target_id,prev_status,locked_tick,note)
                          VALUES(?, 'ride', ?, ?, ?, ?)`)
    .run(inc.id, rideId, prev, ctx.tick(), note || '')
  if (ins.changes === 0) return { ride: ride.name, refundQty: 0, duplicated: true }
  let refundQty = 0
  if (!openOrder && prev !== 'closed') {
    db.prepare("UPDATE rides SET status='closed' WHERE id=?").run(rideId)
    // 停运联动：关时段 + 登记补偿任务（散客退款/团队重排退款）；事务提交后逐任务独立事务补偿
    const sync = ctx.syncRideSlots?.({ ...ride, status: 'closed' })
    if (sync && !sync.ok) throw new Error(`设施停运联动失败：${sync.msg || sync.code || '未知错误'}`)
    // 受影响人数由预约模块按入队预约统计（退款在提交后独立事务完成，可能在重试队列中恢复）
    refundQty = Math.max(0, sync?.affectedQty ?? (pendingRideRiders(rideId) - 0))
  }
  return { ride: ride.name, refundQty }
}

function pendingRideRiders(rideId) {
  const r = db.prepare(`SELECT COALESCE(SUM(qty),0) n FROM reservations
                        WHERE scope='ride' AND ride_id=? AND status='booked'`).get(rideId)
  return r.n
}

// 封控区域：区域置 open=0，区域内在营设施一并应急停运（逐一同事务联动退款）
function lockdownZone(inc, zoneId, note) {
  const zone = db.prepare('SELECT * FROM zones WHERE id=?').get(zoneId)
  if (!zone) throw new TxBusiness(`区域 #${zoneId} 不存在`)
  db.prepare(`INSERT OR IGNORE INTO incident_targets(incident_id,target_type,target_id,prev_status,locked_tick,note)
              VALUES(?, 'zone', ?, 'open', ?, ?)`).run(inc.id, zoneId, ctx.tick(), note || `区域「${zone.name}」封锁`)
  db.prepare('UPDATE zones SET open=0 WHERE id=?').run(zoneId)
  let refundQty = 0
  const rides = db.prepare("SELECT * FROM rides WHERE zone_id=? AND status='operating'").all(zoneId)
  const names = []
  for (const r of rides) {
    const res = lockdownRide(inc, r.id, `随区域「${zone.name}」封控停运`)
    refundQty += res.refundQty
    names.push(r.name)
  }
  return { zone: zone.name, rides: names, refundQty }
}

// 复园 / 误报关闭：恢复封控对象（设施改回原状态并重开时段，区域重新开放）
// 注意：封控期间若设施另有在途检修工单，则维持检修停运，由检修完工流程恢复（不强行复运）
function restoreTargets(incId) {
  const rows = db.prepare('SELECT * FROM incident_targets WHERE incident_id=? AND restored_tick=0').all(incId)
  const restoredRides = []
  let reopenedZones = 0
  for (const t of rows) {
    if (t.target_type === 'zone') {
      db.prepare('UPDATE zones SET open=1 WHERE id=?').run(t.target_id)
      reopenedZones++
    } else if (t.target_type === 'ride') {
      const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(t.target_id)
      const openOrder = ride && db.prepare("SELECT id FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing')").get(t.target_id)
      // 仅恢复仍处于「应急停运（closed）」的设施；若封控期间已转检修/被另行处置则尊重其当前流程
      if (ride && !openOrder && ride.status === 'closed') {
        const toStatus = t.prev_status === 'maintenance' ? 'closed' : 'operating'
        db.prepare('UPDATE rides SET status=? WHERE id=?').run(toStatus, t.target_id)
        if (toStatus === 'operating') {
          const sync = ctx.syncRideSlots?.({ ...ride, status: 'operating' })
          if (sync && !sync.ok) throw new Error(`复园重开时段失败：${sync.msg || sync.code || '未知错误'}`)
        }
        restoredRides.push(ride.name)
      }
    }
    db.prepare('UPDATE incident_targets SET restored_tick=? WHERE id=?').run(ctx.tick(), t.id)
  }
  return { restoredRides, reopenedZones }
}

// ---------------- 状态流转：发现 / 分级 / 封控 / 疏散 / 控场 ----------------
// 发现上报：运营/安保/游客均可上报；游客上报（理赔/求助）角色记 visitor
export function reportIncident(payload = {}) {
  return idempotent('inc_report', payload.requestId, () => runAtomic(() => {
    const type = INCIDENT_TYPES[payload.type] ? payload.type : 'other'
    const title = String(payload.title || '').trim() || `${INCIDENT_TYPES[type].name} · 安全事件`
    const actorRole = ['operations', 'security', 'visitor'].includes(payload.reporterRole) ? payload.reporterRole : 'security'
    const sourceMap = { operations: 'ops', security: 'patrol', visitor: 'visitor' }
    const inc = {
      type, title,
      desc: String(payload.desc || '').slice(0, 500),
      location: String(payload.location || '').slice(0, 100),
      zoneId: payload.zoneId ? num(payload.zoneId) : null,
      source: payload.source === 'auto' ? 'auto' : (sourceMap[actorRole] || 'patrol'),
      reporterRole: actorRole,
      complaintId: payload.complaintId ? num(payload.complaintId) : null
    }
    const r = db.prepare(`INSERT INTO incidents(code,type,title,desc,location,zone_id,severity,status,source,reporter_role,complaint_id,create_tick,create_day)
                          VALUES(?,?,?,?,?,?,0,'reported',?,?,?,?,?)`)
      .run('', inc.type, inc.title, inc.desc, inc.location, inc.zoneId, inc.source, inc.reporterRole, inc.complaintId, ctx.tick(), ctx.day())
    const id = Number(r.lastInsertRowid)
    const code = 'EM' + String(id).padStart(4, '0')
    db.prepare('UPDATE incidents SET code=? WHERE id=?').run(code, id)
    logIncident(id, 'report',
      `${roleName(actorRole)}发现上报：${inc.title}${inc.location ? `（地点：${inc.location}）` : ''}`,
      payload.staffId ? num(payload.staffId) : null, actorRole)
    // 游客上报安全事件：自动生成一张安全类投诉工单，便于投诉侧协同处置
    if (actorRole === 'visitor' && !inc.complaintId) {
      const c = ctx.createComplaint?.({
        category: 'safety', severity: 2,
        title: `安全事件游客求助 · ${inc.title}`,
        content: inc.desc || '游客在园区内遭遇/目击安全事件，请求紧急处置。',
        target: inc.zoneId ? { type: 'zone', id: inc.zoneId, name: zoneName(inc.zoneId) } : { type: '', id: null },
        source: 'guest'
      })
      if (c?.id) {
        db.prepare('UPDATE incidents SET complaint_id=? WHERE id=?').run(c.id, id)
        logIncident(id, 'link_complaint', `已联动生成安全投诉工单 ${c.code}`, null, 'system')
      }
    }
    return { ok: true, id, code, status: 'reported' }
  }))
}

// 分级：运营核定等级（可同时对设施/区域封控，一步进入「已封控」；或仅分级待封控）
// lockdown: { rides:[id], zones:[id], parkWide:bool }
export function gradeIncident(id, payload = {}) {
  return idempotent('inc_grade', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    const severity = Math.round(num(payload.severity, -1))
    if (![1, 2, 3, 4].includes(severity)) throw new TxBusiness('请选择正确的事件等级（1~4 级）')
    const lock = payload.lockdown || {}
    const willLock = severity >= 2 || (Array.isArray(lock.rides) && lock.rides.length) || (Array.isArray(lock.zones) && lock.zones.length) || lock.parkWide
    // 允许从 reported 直接到 graded 或 contained（分级即封控）
    const toStatus = willLock ? 'contained' : 'graded'
    if (inc.status !== 'reported') throw new TxBusiness(`当前状态「${STATUS_FLOW[inc.status]?.name}」不能分级`)

    let rideRefund = 0
    const lockedNames = []
    const applyLock = () => {
      for (const zid of dedupe(lock.zones)) {
        const rz = lockdownZone(inc, num(zid), '分级封控区域')
        rideRefund += rz.refundQty; lockedNames.push(`区域「${rz.zone}」`)
      }
      for (const rid of dedupe(lock.rides)) {
        const rr = lockdownRide(inc, num(rid), '分级封控设施')
        rideRefund += rr.refundQty; lockedNames.push(`设施「${rr.ride}」`)
      }
      // 未显式指定封控对象但有事件区域：等级≥2 默认封锁事发区域
      if (!lockedNames.length && inc.zone_id && severity >= 2 && lock.autoZone !== false) {
        const rz = lockdownZone(inc, inc.zone_id, `${SEVERITY_NAMES[severity]}事件，默认封锁事发区域`)
        rideRefund += rz.refundQty; lockedNames.push(`区域「${rz.zone}」`)
      }
    }
    if (willLock) applyLock()

    let entryRefund = 0
    if (lock.parkWide || severity === 4) {
      // 特别重大：全园封控，关停全部入园时段，在途入园预约园方全额退款
      entryRefund = ctx.closeEntrySlots?.() || 0
    }

    // 等级≥2 生成一张安全投诉工单（事件维度，统一登记游客安全诉求；不与理赔重复）
    let complaintId = inc.complaint_id
    if (severity >= 2 && !complaintId) {
      const c = ctx.createComplaint?.({
        category: 'safety', severity: severity >= 3 ? 3 : 2,
        title: `安全事件处置 · ${inc.title}`,
        content: `发生${SEVERITY_NAMES[severity]}安全事件，已启动应急响应，登记游客安全诉求与现场处置。`,
        target: inc.zone_id ? { type: 'zone', id: inc.zone_id, name: zoneName(inc.zone_id) } : { type: '', id: null },
        source: 'manual'
      })
      if (c?.id) {
        complaintId = c.id
        logIncident(inc.id, 'link_complaint', `已联动生成安全投诉工单 ${c.code}，随事件处置协同推进`, null, 'system')
      }
    }

    const deadline = ctx.tick() + CONTROL_SLA[severity]
    db.prepare(`UPDATE incidents SET severity=?, status=?, control_deadline_tick=?, contained_tick=?,
                refund_ride_qty=refund_ride_qty+?, refund_entry_qty=refund_entry_qty+?, complaint_id=COALESCE(?,complaint_id)
                WHERE id=?`)
      .run(severity, toStatus, deadline, willLock ? ctx.tick() : 0, rideRefund, entryRefund, complaintId, inc.id)
    logIncident(inc.id, 'grade', `运营核定为${SEVERITY_NAMES[severity]}（${severity}级），限 ${CONTROL_SLA[severity]}h 内完成封控`,
      payload.staffId ? num(payload.staffId) : null, 'operations')
    if (lockedNames.length) logIncident(inc.id, 'lockdown', `已封控：${lockedNames.join('、')}；联动设施预约退款 ${rideRefund} 人`, null, 'system')
    if (entryRefund) logIncident(inc.id, 'lockdown', `特别重大事件全园封控，关停入园时段，在途入园预约退款 ${entryRefund} 人`, null, 'system')

    // 应急岗位需求：触发动态调度补齐安保（审批模式下进待批计划）
    try { ctx.dispatchAfter?.(`安全事件${inc.code}分级${severity}级安保需求`) } catch { /* 调度失败不阻塞应急流程 */ }
    return { ok: true, id: inc.id, code: inc.code, status: toStatus, severity, refundRideQty: rideRefund, refundEntryQty: entryRefund }
  }))
}

// 对已分级（graded）事件追加封控对象 → contained
export function lockdownIncident(id, payload = {}) {
  return idempotent('inc_lockdown', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (inc.status !== 'graded') throw new TxBusiness(`当前状态「${STATUS_FLOW[inc.status]?.name}」不能追加封控`)
    const lock = payload
    let rideRefund = 0
    const names = []
    for (const zid of dedupe(lock.zones)) {
      const rz = lockdownZone(inc, num(zid), '追加封控区域')
      rideRefund += rz.refundQty; names.push(`区域「${rz.zone}」`)
    }
    for (const rid of dedupe(lock.rides)) {
      const rr = lockdownRide(inc, num(rid), '追加封控设施')
      rideRefund += rr.refundQty; names.push(`设施「${rr.ride}」`)
    }
    if (lock.parkWide || inc.severity === 4) {
      const q = ctx.closeEntrySlots?.() || 0
      if (q) { db.prepare('UPDATE incidents SET refund_entry_qty=refund_entry_qty+? WHERE id=?').run(q, inc.id) }
      logIncident(inc.id, 'lockdown', `全园封控，关停入园时段，在途入园预约退款 ${q} 人`, null, 'system')
    }
    db.prepare("UPDATE incidents SET status='contained', contained_tick=?, control_deadline_tick=?, refund_ride_qty=refund_ride_qty+? WHERE id=?")
      .run(ctx.tick(), ctx.tick() + CONTROL_SLA[inc.severity || 2], rideRefund, inc.id)
    logIncident(inc.id, 'lockdown', `完成现场封控：${names.join('、') || '划定警戒区'}；联动设施预约退款 ${rideRefund} 人`,
      payload.staffId ? num(payload.staffId) : null, 'operations')
    return { ok: true, status: 'contained', refundRideQty: rideRefund }
  }))
}

// 疏散：contained/graded → evacuating，累计疏散人数（可多次上报增量）
export function startEvacuation(id, payload = {}) {
  return idempotent('inc_evac_start', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (!['contained', 'graded'].includes(inc.status)) throw new TxBusiness('需先完成封控才能组织疏散')
    db.prepare("UPDATE incidents SET status='evacuating', evacuated_qty=evacuated_qty+? WHERE id=?")
      .run(Math.max(0, Math.round(num(payload.qty))), inc.id)
    logIncident(inc.id, 'evacuate', `启动游客疏散，本批引导 ${Math.max(0, Math.round(num(payload.qty)))} 人撤离至安全区`,
      payload.staffId ? num(payload.staffId) : null, 'security')
    return { ok: true, status: 'evacuating' }
  }))
}

// 疏散进展上报（安保角色，增量累计）
export function reportEvacuation(id, payload = {}) {
  return idempotent('inc_evac_progress', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (inc.status !== 'evacuating') throw new TxBusiness('事件不在疏散中')
    const qty = Math.max(0, Math.round(num(payload.qty)))
    db.prepare('UPDATE incidents SET evacuated_qty=evacuated_qty+? WHERE id=?').run(qty, inc.id)
    logIncident(inc.id, 'evacuate_progress', `现场上报：新增疏散 ${qty} 人，累计 ${inc.evacuated_qty + qty} 人`,
      payload.staffId ? num(payload.staffId) : null, 'security')
    return { ok: true, evacuatedQty: inc.evacuated_qty + qty }
  }))
}

// 控场：疏散完毕/险情得到控制 → controlled，核定受伤人数
export function controlIncident(id, payload = {}) {
  return idempotent('inc_control', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (!['evacuating', 'contained'].includes(inc.status)) throw new TxBusiness('需先封控（并视情况疏散）才能确认控场')
    const casualties = Math.max(0, Math.round(num(payload.casualties, inc.casualties)))
    db.prepare("UPDATE incidents SET status='controlled', casualties=? WHERE id=?").run(casualties, inc.id)
    logIncident(inc.id, 'control',
      `现场险情已控制，伤员 ${casualties} 人已送医/处置，累计疏散 ${inc.evacuated_qty} 人，等待复园评估`,
      payload.staffId ? num(payload.staffId) : null, 'security')
    return { ok: true, status: 'controlled' }
  }))
}

// 复园：controlled/contained → reopened；恢复封控对象、重开时段/区域，结算抢险费用与应急岗位补贴
export function reopenIncident(id, payload = {}) {
  return idempotent('inc_reopen', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (!['controlled', 'contained'].includes(inc.status)) throw new TxBusiness('需控场后才能复园')
    // 恢复封控对象（设施/区域、时段）
    const restored = restoreTargets(inc.id)
    if (inc.severity === 4) ctx.reopenEntrySlots?.()

    // 结算应急岗位补贴（已到场且未撤防的人员均计；已撤防的也按记录计）
    const staffRows = db.prepare("SELECT * FROM incident_staff WHERE incident_id=? AND status IN ('acknowledged','assigned','stood_down')").all(inc.id)
    let subsidy = 0
    for (const s of staffRows) {
      const sub = s.subsidy || STAFF_SUBSIDY[s.task_type] || STAFF_SUBSIDY.control
      subsidy += sub
      db.prepare("UPDATE incident_staff SET subsidy=?, status=CASE WHEN status='assigned' THEN 'stood_down' ELSE status END, stand_tick=CASE WHEN stand_tick=0 THEN ? ELSE stand_tick END WHERE id=?")
        .run(sub, ctx.tick(), s.id)
    }
    // 抢险费用（按等级核定，可由运营覆盖）
    const rescueCost = payload.cost != null ? Math.max(0, Math.round(num(payload.cost))) : RESCUE_COST[inc.severity] || 1000
    const totalCost = rescueCost + subsidy
    if (totalCost > 0) {
      setSetting('cash', Math.round(ctx.cash() - totalCost))
      if (rescueCost > 0) ctx.logFinance?.(ctx.day(), '应急', -rescueCost, `安全事件 ${inc.code} 应急抢险费用（${SEVERITY_NAMES[inc.severity] || ''}）`)
      if (subsidy > 0) ctx.logFinance?.(ctx.day(), '应急', -subsidy, `安全事件 ${inc.code} 应急岗位补贴 · ${staffRows.length} 人次`)
    }
    db.prepare(`UPDATE incidents SET status='reopened', reopened_tick=?, reopened_day=?, rescue_cost=?, subsidy_total=? WHERE id=?`)
      .run(ctx.tick(), ctx.day(), rescueCost, subsidy, inc.id)
    const parts = []
    if (restored.reopenedZones) parts.push(`${restored.reopenedZones} 个区域重新开放`)
    if (restored.restoredRides.length) parts.push(`设施 ${restored.restoredRides.map(n => `「${n}」`).join('、')} 恢复运营`)
    logIncident(inc.id, 'reopen',
      `经评估现场安全，园区恢复开放：${parts.join('，') || '无封控对象'}；抢险费用 ¥${rescueCost}、应急补贴 ¥${subsidy} 已结算`,
      payload.staffId ? num(payload.staffId) : null, 'operations')
    // 到场安保应急任务完成，满意度小幅提振
    for (const s of staffRows) {
      const st = db.prepare('SELECT morale FROM staff WHERE id=?').get(s.staff_id)
      if (st) db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.min(100, st.morale + 3), s.staff_id)
    }
    return { ok: true, status: 'reopened', rescueCost, subsidy, restoredRides: restored.restoredRides.length, reopenedZones: restored.reopenedZones }
  }))
}

// 事故复盘：reopened → closed_review；登记原因/措施/教训与处置评分，声誉按处置质量回补
export function reviewIncident(id, payload = {}) {
  return idempotent('inc_review', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (inc.status !== 'reopened') throw new TxBusiness('需复园后才能提交复盘结案')
    const cause = String(payload.cause || '').trim()
    if (!cause) throw new TxBusiness('请填写事故原因认定')
    const rating = Math.max(1, Math.min(5, Math.round(num(payload.rating, 3))))
    // 声誉回补：处置越及时（封控时限内）、评分越高回补越多；受伤人数扣减
    const onTime = inc.contained_tick > 0 && inc.control_deadline_tick > 0 && inc.contained_tick <= inc.control_deadline_tick ? 1 : 0
    let recover = rating * 0.8 + (onTime ? 1.5 : 0) - inc.casualties * 0.5 - (inc.severity - 1) * 0.4
    recover = Math.max(0, Math.round(recover * 10) / 10)
    if (recover > 0) setSetting('reputation', Math.round(Math.min(100, num(getSetting('reputation'), 70) + recover) * 10) / 10)
    db.prepare(`UPDATE incidents SET status='closed_review', closed_tick=?, closed_day=?, close_reason=?,
                review_cause=?, review_actions=?, review_lessons=?, review_rating=?, review_rep_recover=? WHERE id=?`)
      .run(ctx.tick(), ctx.day(), '事故复盘结案', cause,
        String(payload.actions || '').slice(0, 500), String(payload.lessons || '').slice(0, 500),
        rating, recover, inc.id)
    logIncident(inc.id, 'review',
      `事故复盘结案：${cause}；处置评分 ${rating} 星，声誉回补 +${recover}`,
      payload.staffId ? num(payload.staffId) : null, 'operations')
    // 事件关联投诉随复盘做正向关闭（事件已妥善处置）
    if (inc.complaint_id) ctx.closeComplaintLinked?.(inc.complaint_id, inc, 'event_review')
    return { ok: true, status: 'closed_review', rating, repRecover: recover }
  }))
}

// 误报关闭：reported/graded/contained → closed_false；恢复封控对象，不产生抢险费用
export function closeFalseIncident(id, payload = {}) {
  return idempotent('inc_false', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (!['reported', 'graded', 'contained'].includes(inc.status)) throw new TxBusiness('当前状态不能按误报关闭（请先复园）')
    restoreTargets(inc.id)
    if (inc.severity === 4) ctx.reopenEntrySlots?.()
    db.prepare("UPDATE incidents SET status='closed_false', closed_tick=?, closed_day=?, close_reason=? WHERE id=?")
      .run(ctx.tick(), ctx.day(), String(payload.reason || '经核实为误报/虚惊，未发生真实安全事件'), inc.id)
    logIncident(inc.id, 'false', `经核实为误报，解除响应并恢复封控对象，不计抢险费用`,
      payload.staffId ? num(payload.staffId) : null, 'operations')
    if (inc.complaint_id) ctx.closeComplaintLinked?.(inc.complaint_id, inc, 'event_false')
    return { ok: true, status: 'closed_false' }
  }))
}

// ---------------- 岗位调度联动（安保调派 / 到场 / 撤防） ----------------
export function assignIncidentStaff(id, payload = {}) {
  return idempotent('inc_assign_staff', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (!ACTIVE_INCIDENT_STATUSES.includes(inc.status)) throw new TxBusiness('事件已结案，不能再调派人员')
    const staffId = num(payload.staffId)
    const st = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(staffId)
    if (!st) throw new TxBusiness('员工不存在或已离岗')
    const taskType = ['control', 'evacuate', 'rescue', 'medical'].includes(payload.taskType) ? payload.taskType
      : (inc.status === 'evacuating' ? 'evacuate' : 'control')
    const dup = db.prepare("SELECT id FROM incident_staff WHERE incident_id=? AND staff_id=? AND status IN ('assigned','acknowledged')").get(inc.id, staffId)
    if (dup) throw new TxBusiness(`${st.name} 已在该事件应急编组中`)
    db.prepare(`INSERT INTO incident_staff(incident_id,staff_id,task_type,status,subsidy,assign_tick,note)
                VALUES(?,?,?,?,?,?,?)`)
      .run(inc.id, staffId, taskType, 'assigned', STAFF_SUBSIDY[taskType] || STAFF_SUBSIDY.control, ctx.tick(), String(payload.note || ''))
    logIncident(inc.id, 'dispatch_staff',
      `调派 ${st.name}（${st.role}）参与${taskLabel(taskType)}，应急补贴 ¥${STAFF_SUBSIDY[taskType] || STAFF_SUBSIDY.control}（复园结算）`,
      payload.operatorId ? num(payload.operatorId) : null, 'operations')
    return { ok: true }
  }))
}

// 安保到场确认
export function acknowledgeStaff(linkId, payload = {}) {
  return idempotent('inc_ack_staff', payload.requestId, () => runAtomic(() => {
    const link = db.prepare('SELECT * FROM incident_staff WHERE id=?').get(num(linkId))
    if (!link) throw new TxBusiness('调派记录不存在')
    if (link.status !== 'assigned') throw new TxBusiness('当前状态不能到场确认')
    // 排班在岗门控：当日须有排班（应急调令可在调度侧补班）；不在班仅告警不强制，应急优先
    const duty = ctx.staffDutyState?.(link.staff_id)
    db.prepare("UPDATE incident_staff SET status='acknowledged', ack_tick=? WHERE id=?").run(ctx.tick(), link.id)
    const st = db.prepare('SELECT name,role FROM staff WHERE id=?').get(link.staff_id)
    logIncident(link.incident_id, 'ack_staff', `${st?.name || '员工'}已到达现场投入${taskLabel(link.task_type)}${duty && !duty.onDuty ? '（当前不在排班时段，应急出勤）' : ''}`,
      link.staff_id, 'security')
    return { ok: true, onDuty: duty ? !!duty.onDuty : true }
  }))
}

// 撤防
export function standDownStaff(linkId, payload = {}) {
  return idempotent('inc_stand_staff', payload.requestId, () => runAtomic(() => {
    const link = db.prepare('SELECT * FROM incident_staff WHERE id=?').get(num(linkId))
    if (!link) throw new TxBusiness('调派记录不存在')
    if (!['assigned', 'acknowledged'].includes(link.status)) throw new TxBusiness('该人员已撤防')
    db.prepare("UPDATE incident_staff SET status='stood_down', stand_tick=? WHERE id=?").run(ctx.tick(), link.id)
    const st = db.prepare('SELECT name FROM staff WHERE id=?').get(link.staff_id)
    logIncident(link.incident_id, 'stand_staff', `${st?.name || '员工'}撤防归建`, link.staff_id, 'security')
    return { ok: true }
  }))
}

// ---------------- 游客理赔（财务补偿联动） ----------------
export function fileClaim(id, payload = {}) {
  return idempotent('inc_claim', payload.requestId, () => runAtomic(() => {
    const inc = getIncident(id)
    if (!inc) throw new TxBusiness('事件不存在')
    if (inc.status === 'closed_false') throw new TxBusiness('误报事件不受理理赔')
    const amountReq = Math.max(0, Math.round(num(payload.amountReq)))
    if (amountReq <= 0) throw new TxBusiness('请填写理赔申请金额')
    const r = db.prepare(`INSERT INTO incident_claims(incident_id,code,guest_name,guest_phone,member_id,item,amount_req,status,create_tick,create_day)
                          VALUES(?,?,?,?,?,?,?,'submitted',?,?)`)
      .run(inc.id, '', String(payload.guestName || '游客').slice(0, 30), String(payload.guestPhone || '').slice(0, 30),
        payload.memberId ? num(payload.memberId) : null, String(payload.item || '安全事件损失补偿').slice(0, 100),
        amountReq, ctx.tick(), ctx.day())
    const cid = Number(r.lastInsertRowid)
    const code = 'CL' + String(cid).padStart(4, '0')
    db.prepare('UPDATE incident_claims SET code=? WHERE id=?').run(code, cid)
    // 自动生成安全投诉工单并关联（赔付/驳回时同步闭环），与投诉模块协同
    let complaintId = null
    const c = ctx.createComplaint?.({
      category: 'safety', severity: inc.severity >= 3 ? 3 : 2,
      title: `安全事件理赔 · ${inc.title}`,
      content: `游客就安全事件 ${inc.code} 申请理赔：${String(payload.item || '损失补偿')}，申请金额 ¥${amountReq}。`,
      target: inc.zone_id ? { type: 'zone', id: inc.zone_id, name: zoneName(inc.zone_id) } : { type: '', id: null },
      source: 'manual',
      memberId: payload.memberId ? num(payload.memberId) : null
    })
    if (c?.id) {
      complaintId = c.id
      db.prepare('UPDATE incident_claims SET complaint_id=? WHERE id=?').run(complaintId, cid)
    }
    logIncident(inc.id, 'claim', `游客提交理赔 ${code}：${String(payload.item || '损失补偿')}，申请 ¥${amountReq}${complaintId ? `，联动投诉 ${c.code}` : ''}`,
      null, 'visitor')
    return { ok: true, id: cid, code, complaintId }
  }))
}

// 核定赔付：现金支付入财务流水（应急补偿），关联投诉正向闭环
export function payClaim(claimId, payload = {}) {
  return idempotent('inc_claim_pay', payload.requestId, () => runAtomic(() => {
    const cl = db.prepare('SELECT * FROM incident_claims WHERE id=?').get(num(claimId))
    if (!cl) throw new TxBusiness('理赔单不存在')
    if (cl.status !== 'submitted') throw new TxBusiness('该理赔已处理')
    const amount = Math.max(0, Math.round(num(payload.amount != null ? payload.amount : cl.amount_req)))
    if (amount <= 0) throw new TxBusiness('赔付金额需大于 0（驳回请走驳回）')
    if (ctx.cash() < amount) throw new TxBusiness(`现金不足，赔付需 ¥${amount.toLocaleString()}`)
    setSetting('cash', Math.round(ctx.cash() - amount))
    ctx.logFinance?.(ctx.day(), '应急补偿', -amount,
      `安全事件理赔 ${cl.code} · ${cl.item} · ${cl.guest_name}（事件 ${eventCode(cl.incident_id)}）`)
    db.prepare(`UPDATE incident_claims SET status='paid', amount_pay=?, handler_id=?, note=?, handle_tick=?, handle_day=? WHERE id=?`)
      .run(amount, payload.handlerId ? num(payload.handlerId) : null, String(payload.note || '核定赔付'), ctx.tick(), ctx.day(), cl.id)
    logIncident(cl.incident_id, 'claim_pay', `理赔 ${cl.code} 核定赔付 ¥${amount}（${cl.guest_name}），财务已出账`,
      payload.handlerId ? num(payload.handlerId) : null, 'operations')
    // 关联投诉做补偿结案闭环
    if (cl.complaint_id) {
      ctx.closeComplaintLinked?.(cl.complaint_id, null, 'claim_paid', { claimCode: cl.code, amount })
    }
    return { ok: true, amount }
  }))
}

// 驳回理赔：不出账，关联投诉同步关闭（园方说明）
export function rejectClaim(claimId, payload = {}) {
  return idempotent('inc_claim_reject', payload.requestId, () => runAtomic(() => {
    const cl = db.prepare('SELECT * FROM incident_claims WHERE id=?').get(num(claimId))
    if (!cl) throw new TxBusiness('理赔单不存在')
    if (cl.status !== 'submitted') throw new TxBusiness('该理赔已处理')
    db.prepare(`UPDATE incident_claims SET status='rejected', handler_id=?, note=?, handle_tick=?, handle_day=? WHERE id=?`)
      .run(payload.handlerId ? num(payload.handlerId) : null, String(payload.note || '不符合理赔范围'), ctx.tick(), ctx.day(), cl.id)
    logIncident(cl.incident_id, 'claim_reject', `理赔 ${cl.code} 驳回：${String(payload.note || '不符合理赔范围')}`,
      payload.handlerId ? num(payload.handlerId) : null, 'operations')
    if (cl.complaint_id) ctx.closeComplaintLinked?.(cl.complaint_id, null, 'claim_rejected', { claimCode: cl.code, note: payload.note })
    return { ok: true }
  }))
}

// 投诉转报：把安全类投诉升级为安全事件，投诉与事件双向关联
export function escalateFromComplaint(complaintId, payload = {}) {
  return idempotent('inc_from_complaint', payload.requestId, () => runAtomic(() => {
    const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(num(complaintId))
    if (!c) throw new TxBusiness('投诉不存在')
    const exist = db.prepare('SELECT id FROM incidents WHERE complaint_id=? AND status IN (\'' + ACTIVE_INCIDENT_STATUSES.join("','") + "')").get(c.id)
    if (exist) throw new TxBusiness('该投诉已关联在途安全事件')
    const type = c.category === 'facility' ? 'facility' : c.category === 'missing' ? 'missing' : c.category === 'food' ? 'food' : 'other'
    const r = db.prepare(`INSERT INTO incidents(code,type,title,desc,location,zone_id,severity,status,source,reporter_role,complaint_id,create_tick,create_day)
                          VALUES(?,?,?,?,?,?,0,'reported','complaint','operations',?,?,?)`)
      .run('', type, c.title, c.content, '', c.target_type === 'zone' ? c.target_id : null, c.id, ctx.tick(), ctx.day())
    const id = Number(r.lastInsertRowid)
    const code = 'EM' + String(id).padStart(4, '0')
    db.prepare('UPDATE incidents SET code=? WHERE id=?').run(code, id)
    logIncident(id, 'report', `由安全投诉 ${c.code} 转报为安全事件，进入应急指挥流程`, payload.staffId ? num(payload.staffId) : null, 'operations')
    return { ok: true, id, code }
  }))
}

// ---------------- 引擎：自动分级超时 / 模拟事件 ----------------
// 每游戏小时调用：① 上报后久未分级 → 按建议级别自动分级；② 已分级超封控时限 → 升级并声誉扣分
export function processIncidents() {
  let repPenalty = 0
  const t = ctx.tick()
  for (const inc of db.prepare(`SELECT * FROM incidents WHERE status IN ('reported','graded','contained','evacuating')`).all()) {
    try {
      if (inc.status === 'reported' && t - inc.create_tick >= GRADE_SLA) {
        let autoSev = 0
        tx(() => {
          const sev = INCIDENT_TYPES[inc.type]?.defSev || 2
          autoSev = sev
          const deadline = t + CONTROL_SLA[sev]
          db.prepare("UPDATE incidents SET severity=?, status='graded', control_deadline_tick=? WHERE id=?")
            .run(sev, deadline, inc.id)
          logIncident(inc.id, 'auto_grade', `上报后 ${GRADE_SLA}h 未分级，系统按建议级别核定为${SEVERITY_NAMES[sev]}，请尽快封控`, null, 'system')
        })
        repPenalty += autoSev === 1 ? 0.5 : 1
        continue
      }
      // 超过封控时限仍未控场：升一级（上限4），声誉受损
      if (['graded', 'contained', 'evacuating'].includes(inc.status) && inc.control_deadline_tick && t > inc.control_deadline_tick && inc.severity < 4) {
        tx(() => {
          db.prepare('UPDATE incidents SET severity=severity+1, control_deadline_tick=? WHERE id=?')
            .run(t + CONTROL_SLA[Math.min(4, inc.severity + 1)], inc.id)
          logIncident(inc.id, 'escalate', `超过封控处置时限未控场，事件自动升级为${SEVERITY_NAMES[inc.severity + 1]}，声誉受损`, null, 'system')
        })
        repPenalty += 2
      }
    } catch (e) {
      console.error(`[emergency] 事件 #${inc.id} 引擎推进失败（已回滚跳过）:`, e)
    }
  }
  return repPenalty
}

// 在途事件对散客客流的折减（取最高等级事件的系数）
export function activeCrowdFactor() {
  const row = db.prepare(`SELECT MAX(severity) s FROM incidents
                          WHERE status IN ('graded','contained','evacuating','controlled') AND severity>=1`).get()
  if (!row?.s) return 1
  return CROWD_FACTOR[row.s] || 1
}

// 模拟安全事件（低频；营业时段、有开放设施时才发生）
export function maybeSpawnIncident() {
  const openRides = db.prepare("SELECT COUNT(*) n FROM rides WHERE status='operating'").get().n
  if (!openRides) return null
  const active = db.prepare(`SELECT COUNT(*) n FROM incidents WHERE status IN ('${ACTIVE_INCIDENT_STATUSES.join("','")}')`).get().n
  if (active >= 3) return null
  if (Math.random() > 0.05) return null
  const keys = Object.keys(INCIDENT_TYPES).filter(k => k !== 'other')
  const type = keys[Math.floor(Math.random() * keys.length)]
  const tpl = INCIDENT_TYPES[type]
  const ride = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY RANDOM() LIMIT 1").get()
  const r = reportIncident({
    type,
    title: `${tpl.name} · ${ride?.name ? '设施附近' : '园区'}`,
    desc: `安保巡报：现场疑似发生${tpl.name}，已通知值班主管，请尽快核实现场并分级处置。`,
    location: ride ? `「${ride.name}」周边` : '园区公共区域',
    zoneId: ride?.zone_id || null,
    reporterRole: 'security',
    source: 'auto'
  })
  return r
}

// ---------------- 查询 ----------------
function zoneName(zid) {
  if (!zid) return ''
  return db.prepare('SELECT name FROM zones WHERE id=?').get(zid)?.name || ''
}
function eventCode(iid) {
  return db.prepare('SELECT code FROM incidents WHERE id=?').get(iid)?.code || `#${iid}`
}
function taskLabel(k) {
  return { control: '封控警戒', evacuate: '疏散引导', rescue: '抢险救援', medical: '医疗救护' }[k] || k
}
function dedupe(arr) {
  return [...new Set((arr || []).map(x => num(x)).filter(x => x > 0))]
}

function enrich(inc) {
  const typeMeta = INCIDENT_TYPES[inc.type] || INCIDENT_TYPES.other
  const zone = inc.zone_id ? db.prepare('SELECT id,name FROM zones WHERE id=?').get(inc.zone_id) : null
  const targets = db.prepare('SELECT * FROM incident_targets WHERE incident_id=? ORDER BY id').all(inc.id)
  const staff = db.prepare(`SELECT is2.*, s.name staff_name, s.role staff_role, s.active staff_active
                            FROM incident_staff is2 JOIN staff s ON s.id=is2.staff_id
                            WHERE is2.incident_id=? ORDER BY is2.id`).all(inc.id)
  const claims = db.prepare('SELECT * FROM incident_claims WHERE incident_id=? ORDER BY id DESC').all(inc.id)
  const overdue = ['graded', 'contained', 'evacuating'].includes(inc.status) && inc.control_deadline_tick && ctx.tick() > inc.control_deadline_tick
  return {
    ...inc,
    type_name: typeMeta.name,
    type_icon: typeMeta.icon,
    severity_name: SEVERITY_NAMES[inc.severity] || '待分级',
    status_name: STATUS_FLOW[inc.status]?.name || inc.status,
    status_icon: STATUS_FLOW[inc.status]?.icon || '',
    zone_name: zone?.name || '',
    targets: targets.map(t => ({
      ...t,
      target_name: t.target_type === 'ride'
        ? (db.prepare('SELECT name FROM rides WHERE id=?').get(t.target_id)?.name || `设施#${t.target_id}`)
        : (db.prepare('SELECT name FROM zones WHERE id=?').get(t.target_id)?.name || `区域#${t.target_id}`)
    })),
    staff: staff.map(s => ({ ...s, task_name: taskLabel(s.task_type) })),
    claims,
    overdue: overdue ? 1 : 0,
    claim_paid_total: claims.filter(c => c.status === 'paid').reduce((s, c) => s + c.amount_pay, 0),
    next_actions: STATUS_FLOW[inc.status]?.next || []
  }
}

export function listIncidents({ status = null, limit = 80 } = {}) {
  const rows0 = status
    ? db.prepare('SELECT * FROM incidents WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM incidents ORDER BY id DESC LIMIT ?').all(limit)
  return rows0.map(enrich)
}

export function incidentDetail(id) {
  const inc = getIncident(id)
  if (!inc) return null
  const logs = db.prepare('SELECT * FROM incident_logs WHERE incident_id=? ORDER BY id').all(inc.id)
    .map(l => ({ ...l, actor_name: roleName(l.actor_role) }))
  return { incident: enrich(inc), logs }
}

export function incidentStats() {
  const day = ctx.day()
  const open = db.prepare(`SELECT COUNT(*) n FROM incidents WHERE status IN ('${ACTIVE_INCIDENT_STATUSES.join("','")}')`).get().n
  const bySev = {}
  for (const s of [1, 2, 3, 4]) {
    bySev[s] = db.prepare(`SELECT COUNT(*) n FROM incidents WHERE severity=? AND status IN ('${ACTIVE_INCIDENT_STATUSES.join("','")}')`).get(s).n
  }
  const overdue = db.prepare(`SELECT COUNT(*) n FROM incidents
    WHERE status IN ('graded','contained','evacuating') AND control_deadline_tick>0 AND control_deadline_tick<?`).get(ctx.tick()).n
  const pendingClaims = db.prepare("SELECT COUNT(*) n FROM incident_claims WHERE status='submitted'").get().n
  const claimPayToday = db.prepare("SELECT COALESCE(SUM(amount_pay),0) n FROM incident_claims WHERE status='paid' AND handle_day=?").get(day).n
  const costToday = db.prepare('SELECT COALESCE(SUM(rescue_cost+subsidy_total),0) n FROM incidents WHERE reopened_day=?').get(day).n
  const closedToday = db.prepare('SELECT COUNT(*) n FROM incidents WHERE closed_day=?').get(day).n
  const totalCost = db.prepare('SELECT COALESCE(SUM(rescue_cost+subsidy_total),0) n FROM incidents').get().n
  const totalClaimPaid = db.prepare("SELECT COALESCE(SUM(amount_pay),0) n FROM incident_claims WHERE status='paid'").get().n
  const avgRatingRow = db.prepare("SELECT AVG(review_rating) a FROM incidents WHERE status='closed_review'").get()
  return {
    open, bySeverity: bySev, overdue, pendingClaims, claimPayToday, costToday,
    closedToday, totalCost, totalClaimPaid, avgRating: avgRatingRow.a ? Math.round(avgRatingRow.a * 10) / 10 : 0
  }
}

export const EMERGENCY_CONST = {
  TYPES: INCIDENT_TYPES, SEVERITY_NAMES, CONTROL_SLA, RESCUE_COST, STAFF_SUBSIDY,
  STATUS_FLOW, ACTIVE_INCIDENT_STATUSES, GRADE_SLA
}
