import db, { getSetting, tx } from './db.js'

// 设施停运统一补偿中心（可恢复的补偿处理 / Saga）
// ------------------------------------------------------------------------
// 停运后三类补偿统一接入本队列，逐任务独立事务执行，任一失败不影响其他任务与停运主流程：
//   ① reservation_refund 散客在途预约园方全额退款（同步现金 + 时段库存 + 投诉/会员权益）
//   ② group_outage       团队行程自动重排或园方退款（同步团账现金 + 名额 + 投诉）
//   ③ partner_refund     联营商铺退款红冲（同步现金 + 负向分账流水 + 批次成本 + 账单）
// 失败时任务保持 pending：引擎每小时（爽约/结案扫描之前）统一重试，成功才一次性同步
// 库存/现金/投诉/账单；任务按 idem_key 幂等去重，对象已被人工或他途先行处置的任务置
// obsolete——人工处理后重试绝不二次扣款或二次退款。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0)
}
export function initOutageContext(deps = {}) { Object.assign(ctx, deps) }

// 补偿处理器注册表：由各业务模块（reservations/groups/partners）经 initOutageContext 注入。
// 处理器契约（在独立事务内被调用）：
//   handler(task) => { ok:true, summary? }                 补偿成功（须自身幂等：重复执行无二次副作用）
//                  => { ok:false, obsolete:true }          对象已被他途/人工处置，任务作废
//                  => { ok:false, code, msg }              系统/业务失败，保留 pending 待重试
const handlers = {}
export function registerOutageHandler(kind, fn) { handlers[kind] = fn }

// ---------------- 任务登记 ----------------
// 登记一个补偿任务。默认在调用方事务内写入（与关时段/投诉同提交，回滚则一起回滚）；
// 同一 idem_key 已有 pending 任务时幂等复用，不重复入队（部分唯一索引兜底并发）。
// 返回 { id, created }。
export function enqueueTask(kind, { refType = '', refId = 0, idemKey, payload = {}, source = 'outage', note = '' } = {}) {
  const key = String(idemKey || '').trim()
  if (!key) throw new Error('outage task idem_key required')
  const exist = db.prepare("SELECT id FROM outage_tasks WHERE idem_key=? AND status='pending'").get(key)
  if (exist) return { id: exist.id, created: false }
  const r = db.prepare(`INSERT INTO outage_tasks(kind,ref_type,ref_id,idem_key,payload,status,source,created_tick,created_day,updated_tick)
                        VALUES(?,?,?,?,?, 'pending', ?,?,?,?)`)
    .run(kind, refType, num(refId), key, JSON.stringify(payload || {}), source, ctx.tick(), ctx.day(), ctx.tick())
  const id = Number(r.lastInsertRowid)
  logTask(id, 'enqueue', note || `${kind} 补偿任务入队（ref ${refType}#${refId}）`)
  return { id, created: true }
}

// 某团是否存在 pending 的停运补偿任务且任务覆盖指定行程（精确解析 payload.itemIds）。
// 供团队爽约结案排除：补偿未完成的行程不得按爽约没收已付部分。
export function hasPendingGroupOutage(groupId, itemId) {
  const rows = db.prepare("SELECT payload FROM outage_tasks WHERE kind='group_outage' AND status='pending' AND ref_id=?").all(num(groupId))
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload || '{}')
      if (Array.isArray(p.itemIds) && p.itemIds.map(num).includes(num(itemId))) return true
    } catch { /* 忽略损坏 payload */ }
  }
  return false
}

// 预约被人工核销/改签/退款/爽约等妥善处置后，作废旧的预约类补偿任务（防二次退款）。
// 与 reservations.resolvePending 同一口径（散客超售旧队列 + 统一停运队列一并作废）。
export function resolveTasksByRef(kind, refId) {
  db.prepare("UPDATE outage_tasks SET status='obsolete', updated_tick=? WHERE kind=? AND ref_id=? AND status='pending'")
    .run(ctx.tick(), kind, num(refId))
}

function logTask(id, action, note = '') {
  db.prepare('INSERT INTO outage_task_logs(task_id,tick,day,action,note) VALUES(?,?,?,?,?)')
    .run(id, ctx.tick(), ctx.day(), action, note)
}

// ---------------- 补偿执行（独立事务，逐任务容错） ----------------
// 执行单个任务：处理器在独立事务内跑，成功置 done、对象已处置置 obsolete、失败保留 pending。
// 返回 'done' | 'obsolete' | 'failed'。
function runTask(task) {
  let payload = {}
  try { payload = JSON.parse(task.payload || '{}') } catch { payload = {} }
  const handler = handlers[task.kind]
  if (!handler) {
    markFailed(task, 'NO_HANDLER', `缺少补偿处理器：${task.kind}`)
    return 'failed'
  }
  let result
  try {
    result = tx(() => handler({ ...task, payload }))
  } catch (e) {
    // 处理器未自行捕获的异常：事务已回滚，无任何副作用，记录后等待重试
    result = { ok: false, code: e?.code || 'TX_FAILED', msg: e?.message || '补偿事务异常已回滚' }
  }
  if (result?.ok) {
    db.prepare("UPDATE outage_tasks SET status='done', attempts=attempts+1, last_error='', updated_tick=?, done_tick=?, done_day=? WHERE id=? AND status='pending'")
      .run(ctx.tick(), ctx.tick(), ctx.day(), task.id)
    logTask(task.id, 'done', result.summary || `${task.kind} 补偿成功`)
    return 'done'
  }
  if (result?.obsolete) {
    db.prepare("UPDATE outage_tasks SET status='obsolete', attempts=attempts+1, updated_tick=? WHERE id=? AND status='pending'")
      .run(ctx.tick(), task.id)
    logTask(task.id, 'observe', result.msg || `${task.kind} 对象已被他途处置，补偿任务自动作废`)
    return 'obsolete'
  }
  markFailed(task, result?.code || 'TX_FAILED', result?.msg || '补偿执行失败')
  return 'failed'
}

function markFailed(task, code, msg) {
  const err = `${code} ${msg || ''}`.trim().slice(0, 300)
  db.prepare("UPDATE outage_tasks SET attempts=attempts+1, last_error=?, updated_tick=? WHERE id=? AND status='pending'")
    .run(err, ctx.tick(), task.id)
  logTask(task.id, 'retry', `补偿失败（第 ${task.attempts + 1} 次）：${err}`)
  console.error(`[outage] 补偿任务 #${task.id}(${task.kind}) 执行失败，保持挂起待重试（第 ${task.attempts + 1} 次）:`, code, msg || '')
}

// 排空全部 pending 任务（引擎每小时在爽约扫描之前调用；停运事务提交后也可立即调用一轮）。
// 逐任务独立事务，一单失败不影响其余；返回 { done, obsolete, failed, remaining, byKind }
export function drainPendingTasks({ kinds = null, limit = 500 } = {}) {
  const rows = db.prepare("SELECT * FROM outage_tasks WHERE status='pending' ORDER BY id LIMIT ?").all(limit)
  let done = 0, obsolete = 0, failed = 0
  const byKind = {}
  for (const task of rows) {
    if (Array.isArray(kinds) && !kinds.includes(task.kind)) continue
    const outcome = runTask(task)
    if (outcome === 'done') { done++; byKind[task.kind] = (byKind[task.kind] || 0) + 1 }
    else if (outcome === 'obsolete') obsolete++
    else failed++
  }
  const remaining = db.prepare("SELECT COUNT(*) n FROM outage_tasks WHERE status='pending'").get().n
  return { done, obsolete, failed, remaining, byKind }
}

// 引擎补偿恢复（在爽约/结案扫描之前）：先排空停运统一补偿队列，再兼容旧的散客超售补退队列
export function recoverCompensations() {
  const outage = drainPendingTasks()
  return outage
}

// ---------------- 查询 ----------------
export function listOutageTasks({ status = 'pending', kind = null, limit = 200 } = {}) {
  const conds = []
  const vals = []
  if (status && status !== 'all') { conds.push('status=?'); vals.push(status) }
  if (kind) { conds.push('kind=?'); vals.push(kind) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM outage_tasks ${where} ORDER BY id DESC LIMIT ?`).all(...vals, num(limit, 200))
    .map(t => {
      let payload = {}
      try { payload = JSON.parse(t.payload || '{}') } catch { payload = {} }
      return { ...t, payloadObj: payload }
    })
}

export function outageTaskLogs(id) {
  return db.prepare('SELECT * FROM outage_task_logs WHERE task_id=? ORDER BY id').all(num(id))
}

export function outageStats() {
  const pending = db.prepare(`SELECT COUNT(*) n,
    COALESCE(SUM(CASE WHEN kind='reservation_refund' THEN 1 ELSE 0 END),0) rsv,
    COALESCE(SUM(CASE WHEN kind='group_outage' THEN 1 ELSE 0 END),0) grp,
    COALESCE(SUM(CASE WHEN kind='partner_refund' THEN 1 ELSE 0 END),0) partner
    FROM outage_tasks WHERE status='pending'`).get()
  const doneToday = db.prepare('SELECT COUNT(*) n FROM outage_tasks WHERE status=? AND done_day=?')
    .get('done', ctx.day()).n
  return {
    pending: pending.n,
    pendingByKind: { reservation: pending.rsv, group: pending.grp, partner: pending.partner },
    doneToday
  }
}

export const OUTAGE_KINDS = { RESERVATION: 'reservation_refund', GROUP: 'group_outage', PARTNER: 'partner_refund' }
