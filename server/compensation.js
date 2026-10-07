import db, { getSetting, setSetting, tx } from './db.js'

// 统一可恢复补偿队列：
//   设施停运 / 全园封控后，散客预约退款、团队行程（重排/挂起/退团款）、联营退款
//   三类补偿统一在此排队执行。每个任务在独立事务内运行处理器，
//   现金 / 库存 / 投诉 / 账单同事务提交，任一失败整体回滚，任务保持 pending 自动重试。
//
// 幂等原则（处理器必须遵守，队列仅做调度与状态防护）：
//   - 同一业务幂等键（idem_key）同时只允许一条未终结任务（部分唯一索引兜底）；
//   - 处理器重试时先读取业务真实状态，已补偿（已退款/已重排/已挂起/已红冲）则直接返回 success，
//     绝不重复扣款或重复退款；
//   - 业务对象已被人工或其他流程妥善处置（状态不再需要补偿）→ 标记 obsolete 跳过；
//   - 人工在业务侧处理后可在补偿队列“登记人工已处理”，任务终结为 manual，自动重试不再触达资金。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0)
}
// 时钟必须惰性读 settings（测试会在模块导入后重置 day/tick）；init 可覆盖但默认保持惰性
export function initCompensationContext(deps = {}) {
  if (deps.day !== undefined || deps.hour !== undefined || deps.tick !== undefined) {
    // 显式注入时钟函数时才替换（index.js 注入 state.day 等）
    Object.assign(ctx, deps)
  }
}

// 退避：首次立即重试；此后每失败一次 +1 游戏小时，上限 4 小时（与主循环每小时一跳匹配）
const BACKOFF_TICKS = [0, 1, 1, 2, 2, 3, 4]
// 超过尝试上限转人工：资金服务长期不可用等场景，停止自动触达，等待人工核对
const DEFAULT_MAX_ATTEMPTS = 24

// 处理器注册表：{ [domain]: async/sync (task) => result }
// 处理器约定：
//   成功返回对象（可含 { obsolete:true, note, cash, stock, complaint, bill } 等执行结果快照）；
//   业务已无需补偿时返回 { obsolete:true }，队列置 obsolete；
//   失败直接抛错（事务回滚，队列记录错误并安排重试），不得自行吞掉资金类错误。
const handlers = new Map()
export function registerHandler(domain, handler) { handlers.set(domain, handler) }

export class CompError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra) }
}

function logTask(taskId, action, note = '', staffId = null) {
  db.prepare('INSERT INTO compensation_logs(task_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(taskId, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}

// 登记一个补偿任务（幂等：同 idem_key 已有未终结任务时直接复用，不重复挂起）。
// 可在调用方事务内调用（并入外层事务，外层回滚则任务一同回滚——这是期望行为：
// 停运批处理中先成功落库的任务随提交保留，整体回滚的批量则不残留任务）；
// 也可在独立事务中调用（异常路径独立持久化，参考 enqueueDetached）。
// 返回 { ok, id, duplicated }
export function enqueue({
  domain, action = '', idemKey, refType = '', refId = null,
  payload = {}, source = 'auto', priority = 5, maxAttempts = DEFAULT_MAX_ATTEMPTS, note = ''
}) {
  const key = String(idemKey || '').trim()
  if (!key) throw new CompError('BAD_ARG', '补偿任务缺少幂等键 idemKey')
  // 注：此处不校验处理器是否已注册——故障注入/模块接线异常期间也必须允许挂起，
  // 处理器缺失在执行期（runTask）才报错并按系统异常退避重试。

  const exist = db.prepare("SELECT id FROM compensation_tasks WHERE idem_key=? AND status IN ('pending','processing')").get(key)
  if (exist) return { ok: true, id: exist.id, duplicated: true }

  const r = db.prepare(`INSERT INTO compensation_tasks
      (code,domain,action,idem_key,ref_type,ref_id,payload,status,source,priority,max_attempts,next_run_tick,note,created_tick,created_day,updated_tick)
      VALUES('',?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)`)
    .run(domain, action, key, refType, refId ?? null,
      JSON.stringify(payload ?? {}),
      source, priority, maxAttempts,
      ctx.tick(), String(note || '').slice(0, 300), ctx.tick(), ctx.day(), ctx.tick())
  const id = Number(r.lastInsertRowid)
  db.prepare('UPDATE compensation_tasks SET code=? WHERE id=?').run('BC' + String(id).padStart(4, '0'), id)
  logTask(id, 'enqueue', note || `${domain}/${action} 补偿任务挂起`)
  return { ok: true, id, duplicated: false }
}

// 异常路径独立持久化：不受调用方失败事务回滚影响（对标超售补退挂起的持久化方式）。
// 用于“主流程已提交、但后置联动失败”或捕获到批处理整体回滚后补挂任务。
export function enqueueDetached(task) {
  try {
    return tx(() => enqueue(task))
  } catch (e) {
    console.error('[compensation] 补偿任务挂起失败:', e)
    return { ok: false, msg: e.message }
  }
}

// 在调用方事务内排队并立即同步执行（停运联动主事务使用）：
// 补偿与停运（改状态/关时段）同事务提交，保持“停运了就一定退完款”的原子语义；
// 处理器抛错会冒到调用方触发整体回滚。syncRun=false 时只排队不执行（后台引擎重试）。
export function enqueueAndRun(task, { run = true } = {}) {
  const q = enqueue(task)
  if (!run || q.duplicated) return q
  return { ...q, ...runTask(loadTaskRow(q.id), { sync: true }) }
}

function loadTaskRow(id) { return db.prepare('SELECT * FROM compensation_tasks WHERE id=?').get(num(id)) }

function loadTask(id) { return db.prepare('SELECT * FROM compensation_tasks WHERE id=?').get(num(id)) }

// 执行单个任务。
// sync=true：调用方已在事务内（停运联动主事务），处理器与任务终结直接并入外层事务：
//   成功则补偿与主流程同提交；失败抛错由外层回滚（调用方捕获后可 detach 重挂，走后台重试）。
// sync=false（引擎/手动重试）：任务独立事务，单任务失败回滚不影响其他任务，失败后落 attempts/退避。
function runTask(task, { sync = false } = {}) {
  const handler = handlers.get(task.domain)
  const payload = safeParse(task.payload)

  if (sync) {
    if (!handler) throw new CompError('NO_HANDLER', `补偿域 ${task.domain} 未注册处理器`)
    const locked = db.prepare("SELECT * FROM compensation_tasks WHERE id=? AND status='pending'").get(task.id)
    if (!locked) return { outcome: 'skipped' }
    db.prepare("UPDATE compensation_tasks SET status='processing', updated_tick=? WHERE id=? AND status='pending'")
      .run(ctx.tick(), task.id)
    const out = handler({ ...locked, payload }) || {}
    finalizeInline(task, out)
    return { outcome: out.obsolete ? 'obsolete' : 'done', result: out }
  }

  let result
  try {
    if (!handler) throw new CompError('NO_HANDLER', `补偿域 ${task.domain} 未注册处理器`)
    result = tx(() => {
      const locked = db.prepare("SELECT * FROM compensation_tasks WHERE id=? AND status='pending'").get(task.id)
      if (!locked) return { skipped: true }
      db.prepare("UPDATE compensation_tasks SET status='processing', updated_tick=? WHERE id=? AND status='pending'")
        .run(ctx.tick(), task.id)
      return handler({ ...locked, payload }) || {}
    })
  } catch (e) {
    // 回滚后状态仍是 pending；记录失败与退避（独立写入）
    recordFailure(task, e)
    return { outcome: 'failed', error: e.code || 'TX_FAILED', msg: e.message }
  }
  if (result?.skipped) return { outcome: 'skipped' }

  // 成功提交后终结任务（独立短事务；若此处异常任务停留 processing，下轮 resetStale 兜底）
  try {
    tx(() => finalizeInline(task, result))
  } catch (e) {
    console.error(`[compensation] 任务 #${task.id} 补偿已执行但终结落库失败（下轮幂等重试）:`, e)
    // 退回 pending 让下轮幂等重放（处理器必须保证重复执行不重复扣款/退款）
    db.prepare("UPDATE compensation_tasks SET status='pending', attempts=attempts+1, last_error=?, next_run_tick=?, updated_tick=? WHERE id=? AND status='processing'")
      .run(`FINALIZE_FAILED ${String(e.message).slice(0, 260)}`, ctx.tick(), ctx.tick(), task.id)
    return { outcome: 'failed', error: 'FINALIZE_FAILED', msg: e.message }
  }
  return { outcome: result?.obsolete ? 'obsolete' : 'done', result }
}

// 任务终结落库（不包事务：sync 模式并入外层，独立模式由 runTask 包 tx）
function finalizeInline(task, result) {
  const cur = loadTask(task.id)
  if (!cur || cur.status === 'manual') return
  if (result?.obsolete) {
    db.prepare("UPDATE compensation_tasks SET status='obsolete', attempts=attempts+1, last_error='', result=?, finished_tick=?, finished_day=?, updated_tick=? WHERE id=?")
      .run(JSON.stringify(snapshot(result)), ctx.tick(), ctx.day(), ctx.tick(), task.id)
    logTask(task.id, 'obsolete', result.note || '业务已被其他流程处置，补偿自动作废')
    return
  }
  db.prepare("UPDATE compensation_tasks SET status='done', attempts=attempts+1, last_error='', result=?, needs_manual=0, finished_tick=?, finished_day=?, updated_tick=? WHERE id=?")
    .run(JSON.stringify(snapshot(result)), ctx.tick(), ctx.day(), ctx.tick(), task.id)
  logTask(task.id, 'success', successNote(task.domain, result))
}

function recordFailure(task, e) {
  const attempts = task.attempts + 1
  const msg = `${e.code || 'TX_FAILED'} ${e.message || ''}`.trim().slice(0, 300)
  const giveUp = attempts >= task.max_attempts
  const backoff = giveUp ? 999999 : BACKOFF_TICKS[Math.min(attempts, BACKOFF_TICKS.length - 1)]
  db.prepare(`UPDATE compensation_tasks
              SET status='pending', attempts=?, last_error=?, needs_manual=?, next_run_tick=?, updated_tick=?
              WHERE id=?`)
    .run(attempts, msg, giveUp ? 1 : 0, ctx.tick() + backoff, ctx.tick(), task.id)
  if (giveUp) {
    logTask(task.id, 'needs_manual', `自动补偿连续 ${attempts} 次失败（${msg}），转人工队列核对`)
  }
}

// processing 兜底回收：进程崩溃可能把任务留在 processing，下一轮重新置 pending（处理器幂等）
function resetStale() {
  db.prepare("UPDATE compensation_tasks SET status='pending', updated_tick=? WHERE status='processing' AND updated_tick<>?")
    .run(ctx.tick(), ctx.tick())
}

const safeParse = s => { try { return JSON.parse(s || '{}') } catch { return {} } }
const snapshot = o => {
  const { obsolete, skipped, ...rest } = o || {}
  return rest
}
function successNote(domain, r) {
  const parts = []
  if (r.cash) parts.push(`现金 ¥${r.cash}`)
  if (r.stock) parts.push(`库存 ${r.stock}`)
  if (r.complaint) parts.push(`投诉 ${r.complaint}`)
  if (r.bill) parts.push(`账单 ${r.bill}`)
  if (r.note) parts.push(r.note)
  return `${domain} 补偿完成${parts.length ? '：' + parts.join('、') : ''}`
}

// 引擎每小时调用（停运补偿必须先于爽约扫描：补退成功释放名额，仍失败保持 booked 不被误没收）。
// 逐任务独立事务，单任务失败不影响其余；needs_manual 的任务不自动执行。
// 返回 { done, obsolete, failed, manual, remaining, cash, qty, retried }
export function runCompensations({ limit = 200, includeManual = false } = {}) {
  resetStale()
  const rows = db.prepare(`SELECT * FROM compensation_tasks
                           WHERE status='pending' AND next_run_tick<=? AND (?=1 OR needs_manual=0)
                           ORDER BY priority, id LIMIT ?`)
    .all(ctx.tick(), includeManual ? 1 : 0, num(limit, 200))
  let done = 0, obsolete = 0, failed = 0, cash = 0, qty = 0
  for (const t of rows) {
    const r = runTask(t)
    if (r.outcome === 'done') {
      done++
      cash += num(r.result?.cash)
      qty += num(r.result?.qty)
    } else if (r.outcome === 'obsolete') obsolete++
    else failed++
  }
  const manual = db.prepare("SELECT COUNT(*) n FROM compensation_tasks WHERE needs_manual=1 AND status='pending'").get().n
  const remaining = db.prepare("SELECT COUNT(*) n FROM compensation_tasks WHERE status IN ('pending','processing') AND needs_manual=0").get().n
  return { retried: rows.length, done, obsolete, failed, manual, remaining, cash, qty }
}

// 手动立即重试一条任务（运营在补偿队列页点击；needs_manual 也可强制重试）
export function retryTask(id, { staffId = null, note = '' } = {}) {
  const task = loadTask(id)
  if (!task) return { ok: false, code: 'NOT_FOUND', msg: '补偿任务不存在' }
  if (['done', 'manual', 'obsolete'].includes(task.status)) {
    return { ok: false, code: 'TERMINAL', msg: '任务已终结，无需重试' }
  }
  db.prepare("UPDATE compensation_tasks SET needs_manual=0, next_run_tick=?, updated_tick=? WHERE id=?")
    .run(ctx.tick(), ctx.tick(), id)
  logTask(id, 'retry', note || '人工触发立即重试', staffId)
  const r = runTask(loadTask(id))
  if (r.outcome === 'done' || r.outcome === 'obsolete' || r.outcome === 'skipped') return { ok: true, outcome: r.outcome, result: r.result }
  return { ok: false, code: r.error || 'STILL_FAILING', msg: r.msg || '补偿仍失败，任务保持挂起' }
}

// 登记“人工已处理”：运营已在线下/业务侧完成补偿（现金已退、名额已释放、账单已红冲等），
// 系统停止自动重试。仅做登记与留痕，不再触碰现金/库存——人工动作的防重由业务侧
// 状态条件更新与幂等键保证，队列侧绝不替人工再扣一次款或再退一次款。
export function resolveTaskManual(id, { staffId = null, note = '' } = {}) {
  const task = loadTask(id)
  if (!task) return { ok: false, code: 'NOT_FOUND', msg: '补偿任务不存在' }
  if (['done', 'manual', 'obsolete'].includes(task.status)) {
    return { ok: true, id, duplicated: true, status: task.status }
  }
  try {
    return tx(() => {
      const u = db.prepare("UPDATE compensation_tasks SET status='manual', needs_manual=0, finished_tick=?, finished_day=?, updated_tick=?, staff_id=?, note=? WHERE id=? AND status IN ('pending','processing')")
        .run(ctx.tick(), ctx.day(), ctx.tick(), staffId ?? null, String(note || '').slice(0, 300), id)
      if (u.changes === 0) return { ok: true, id, duplicated: true }
      logTask(id, 'manual', note || '运营登记人工已处理，自动补偿停止（不重复扣款/退款）', staffId)
      return { ok: true, id, status: 'manual' }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// 人工核对后确认业务已无需补偿（如预约已在他途核销/退款、联营红冲已在后续账单冲减）
export function markObsolete(id, { staffId = null, note = '' } = {}) {
  const task = loadTask(id)
  if (!task) return { ok: false, code: 'NOT_FOUND', msg: '补偿任务不存在' }
  if (['done', 'manual', 'obsolete'].includes(task.status)) return { ok: true, id, duplicated: true }
  try {
    return tx(() => {
      db.prepare("UPDATE compensation_tasks SET status='obsolete', needs_manual=0, finished_tick=?, finished_day=?, updated_tick=?, staff_id=? WHERE id=? AND status IN ('pending','processing')")
        .run(ctx.tick(), ctx.day(), ctx.tick(), staffId ?? null, id)
      logTask(id, 'obsolete', note || '人工核对确认业务已无需补偿', staffId)
      return { ok: true, id, status: 'obsolete' }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// ---------------- 查询 ----------------
const DOMAIN_NAMES = { reservation: '预约退款', group: '团队行程', partner: '联营退款' }
const STATUS_NAMES = { pending: '待补偿', processing: '执行中', done: '已补偿', manual: '人工已处理', obsolete: '已作废' }

function taskLogs(id) {
  return db.prepare('SELECT * FROM compensation_logs WHERE task_id=? ORDER BY id').all(id)
}

export function listCompensations({ status = null, domain = null, needsManual = null, limit = 200 } = {}) {
  const where = [], vals = []
  if (status) { where.push('status=?'); vals.push(status) }
  if (domain) { where.push('domain=?'); vals.push(domain) }
  if (needsManual === 1) { where.push('needs_manual=1') }
  const sql = `SELECT * FROM compensation_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
                        needs_manual DESC, priority, id DESC LIMIT ?`
  const rides = db.prepare('SELECT id,name FROM rides').all()
  const rideName = id => rides.find(r => r.id === id)?.name || ''
  return db.prepare(sql).all(...vals, num(limit, 200)).map(t => ({
    ...t,
    payload_obj: safeParse(t.payload),
    result_obj: safeParse(t.result),
    domain_name: DOMAIN_NAMES[t.domain] || t.domain,
    status_name: STATUS_NAMES[t.status] || t.status,
    ride_name: t.payload ? rideName(safeParse(t.payload).rideId) : '',
    logs: taskLogs(t.id)
  }))
}

export function compensationDetail(id) {
  const t = loadTask(id)
  if (!t) return null
  return {
    task: { ...t, payload_obj: safeParse(t.payload), result_obj: safeParse(t.result), domain_name: DOMAIN_NAMES[t.domain] || t.domain, status_name: STATUS_NAMES[t.status] || t.status },
    logs: taskLogs(id)
  }
}

export function compensationStats() {
  const one = sql => db.prepare(sql).get()
  const pending = one("SELECT COUNT(*) n, COALESCE(SUM(attempts),0) a FROM compensation_tasks WHERE status IN ('pending','processing') AND needs_manual=0")
  const manual = one("SELECT COUNT(*) n FROM compensation_tasks WHERE needs_manual=1 AND status='pending'")
  const today = one("SELECT COUNT(*) n FROM compensation_tasks WHERE finished_day=? AND status='done'")
  const byDomain = db.prepare("SELECT domain, COUNT(*) n FROM compensation_tasks WHERE status IN ('pending','processing') GROUP BY domain").all()
  return {
    pending: pending.n,
    totalAttempts: pending.a,
    needsManual: manual.n,
    doneToday: db.prepare("SELECT COUNT(*) n FROM compensation_tasks WHERE status='done' AND finished_day=?").get(ctx.day()).n,
    pendingByDomain: Object.fromEntries(byDomain.map(x => [x.domain, x.n]))
  }
}

export const COMPENSATION_CONST = { DOMAIN_NAMES, STATUS_NAMES, DEFAULT_MAX_ATTEMPTS }
