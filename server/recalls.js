import db, { tx } from './db.js'
import {
  quarantineBatch, releaseBatchQuarantine, recallQuarantinedBatches,
  returnQuarantinedToSupplier, destroyQuarantinedBatches, vendorMaterialNetSold
} from './procurement.js'
import { registerHandler, enqueueDetached } from './compensation.js'

// 供应商批次召回模块：供应商 / 园方 / 联营商户 三方协同闭环
//   发起召回（隔离在库批次·停售·通知受影响商铺·餐饮质量投诉·事件通知）
//   → 供应商受理 → 联营商户确认 → 逐铺游客退货退款（自营退现金/联营红冲分账）
//   → 隔离批次退供应商（货款冲应付/退现金）或现场销毁（核销）
//   → 供应商赔付（货款损失+严重度罚则）→ 结案（关联投诉闭环）；误报/撤销解除隔离恢复销售
// 全部多步写（批次/库存/现金/流水/单据/投诉/事件）在同一事务提交，任一步失败整体回滚。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const round1 = v => Math.round(v * 10) / 10

// 由 index.js 注入：时钟/现金/财务、投诉建单与闭环、联营红冲、事件通知
const ctx = {
  day: () => 1, hour: () => 9, tick: () => 0,
  createComplaint: null,
  closeComplaint: null,       // (complaintId, kind, note)
  organicPartnerReturn: null, // (vendorId, qty, { refund, complaintId, reason }) => 红冲分账
  isPartnerVendor: null       // (vendorId) => boolean
}
export function initRecallContext(deps) { Object.assign(ctx, deps) }

export class RecallError extends Error {
  constructor(code, msg) { super(msg); this.code = code }
}

const OPEN_STATUS = ['issued', 'processing']
const SEVERITY_NAMES = { 1: '一般', 2: '严重', 3: '紧急' }
// 供应商赔付罚则系数（除货款损失外，按严重度加收罚金，由供应商承担）
const PENALTY_MUL = { 1: 0, 2: 0.2, 3: 0.5 }

function stampCode(table, id, prefix) {
  db.prepare(`UPDATE ${table} SET code=? WHERE id=?`).run(prefix + String(id).padStart(4, '0'), id)
}
function logRecall(recallId, action, note = '', { actor = 'park', vendorId = null, staffId = null } = {}) {
  db.prepare('INSERT INTO recall_logs(recall_id,vendor_id,tick,day,hour,action,actor,note,staff_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(recallId, vendorId, ctx.tick(), ctx.day(), ctx.hour(), action, actor, note, staffId)
}
function addEvent(day, type, title, desc, impact, status) {
  const r = db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(ctx.tick(), day, type, title, desc, impact, status)
  return Number(r.lastInsertRowid)
}
function updateEvent(eventId, status, feedback) {
  if (!eventId) return
  db.prepare('UPDATE events SET status=?, feedback=? WHERE id=?').run(status, feedback || '', eventId)
}
function getRecall(id) {
  return db.prepare('SELECT * FROM recall_orders WHERE id=?').get(num(id))
}
function getMaterial(id) { return db.prepare('SELECT * FROM materials WHERE id=?').get(num(id)) }
function getSupplier(id) { return db.prepare('SELECT * FROM suppliers WHERE id=?').get(num(id)) }

// ---------------- 发起召回 ----------------
// batches: [{ batch_id }] 指定批次；为空则隔离该物资全部可用在库批次
export function createRecall({ supplier_id, material_id, batches = [], reason = '', severity = 2, notify_vendors = true, staffId = null } = {}) {
  const supplier = getSupplier(num(supplier_id))
  if (!supplier) return { ok: false, code: 'BAD_ARG', msg: '请选择供应商' }
  const material = getMaterial(num(material_id))
  if (!material) return { ok: false, code: 'BAD_ARG', msg: '召回物资不存在' }
  const sev = Math.max(1, Math.min(3, Math.round(num(severity, 2))))
  const why = String(reason || '').trim()
  if (!why) return { ok: false, code: 'BAD_ARG', msg: '请填写召回原因' }

  let batchRows
  const specified = [...new Set((batches || []).map(b => num(b.batch_id || b.id || b)).filter(Boolean))]
  if (specified.length) {
    batchRows = specified.map(id => db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(id)).filter(Boolean)
    for (const b of batchRows) {
      if (!b || b.material_id !== material.id) return { ok: false, code: 'BAD_ARG', msg: '召回批次与物资不匹配' }
      if (b.status !== 'in') return { ok: false, code: 'BAD_STATUS', msg: `批次 RK${String(b.id).padStart(4, '0')} 非在库状态` }
      if (num(b.recall_id)) return { ok: false, code: 'BATCH_QUARANTINED', msg: `批次 RK${String(b.id).padStart(4, '0')} 已在召回隔离中` }
      if (num(b.qty_remain) - num(b.quarantined_qty) <= 0) return { ok: false, code: 'NO_AVAILABLE_QTY', msg: `批次 RK${String(b.id).padStart(4, '0')} 无可用量` }
    }
    if (!batchRows.length) return { ok: false, code: 'BAD_ARG', msg: '未选择有效批次' }
  } else {
    batchRows = db.prepare(`SELECT * FROM inbound_batches WHERE material_id=? AND status='in'
                            AND COALESCE(qty_remain-quarantined_qty,0)>0 AND recall_id IS NULL ORDER BY id DESC`).all(material.id)
    if (!batchRows.length) return { ok: false, code: 'NO_STOCK', msg: '该物资当前无在库可召回批次' }
  }

  try {
    return tx(() => {
      const r = db.prepare(`INSERT INTO recall_orders
        (code,supplier_id,material_id,reason,severity,status,creator_id,note,create_tick,create_day)
        VALUES('',?,?,?,?, 'issued',?,?,?,?)`)
        .run(supplier.id, material.id, why, sev, num(staffId) || null, '', ctx.tick(), ctx.day())
      const id = Number(r.lastInsertRowid)
      stampCode('recall_orders', id, 'ZH')

      // 1) 批次隔离（立即停售，在库总量不变）
      let batchQty = 0
      const batchDesc = []
      for (const b of batchRows) {
        const qb = quarantineBatch(b.id, b.qty_remain - num(b.quarantined_qty), id)
        batchQty = round1(batchQty + qb.qty)
        batchDesc.push(`RK${String(b.id).padStart(4, '0')}×${qb.qty}`)
      }

      // 2) 受影响商铺：销售过该物资的自营/联营商铺，按净售出量登记需召回游客规模
      let vendorCount = 0
      if (notify_vendors) {
        const vids = db.prepare('SELECT vendor_id FROM vendor_materials WHERE material_id=? ORDER BY vendor_id').all(material.id).map(x => x.vendor_id)
        const iv = db.prepare(`INSERT INTO recall_vendors(recall_id,vendor_id,is_partner,sold_qty,status,notified_tick,notified_day)
                               VALUES(?,?,?,?, 'notified',?,?)`)
        for (const vid of vids) {
          const sold = vendorMaterialNetSold(vid, material.id)
          const isP = !!ctx.isPartnerVendor?.(vid)
          iv.run(id, vid, isP ? 1 : 0, sold, ctx.tick(), ctx.day())
          const v = db.prepare('SELECT name FROM vendors WHERE id=?').get(vid)
          logRecall(id, 'notify', `通知${isP ? '联营' : '自营'}商铺「${v?.name || '#' + vid}」下架停售并联系已购游客退货（净售出 ${sold} ${material.unit}）`, { actor: 'park', vendorId: vid })
          vendorCount++
        }
      }

      db.prepare('UPDATE recall_orders SET batch_qty=?, affected_vendor_count=? WHERE id=?').run(batchQty, vendorCount, id)

      // 3) 餐饮质量投诉联动（游客健康/质量类，按召回严重度建单，主责商铺取销量最大者）
      let complaintId = null
      const mainVendor = db.prepare('SELECT vendor_id FROM recall_vendors WHERE recall_id=? ORDER BY sold_qty DESC,id LIMIT 1').get(id)
      const target = mainVendor ? { type: 'vendor', id: mainVendor.vendor_id, name: db.prepare('SELECT name FROM vendors WHERE id=?').get(mainVendor.vendor_id)?.name || '' } : { type: '', id: null, name: '' }
      const cRes = ctx.createComplaint?.({
        category: 'food', severity: sev,
        title: `餐饮质量投诉 · 供应商批次召回 ${'ZH' + String(id).padStart(4, '0')}`,
        content: `供应商「${supplier.name}」供应的「${material.name}」批次因「${why}」召回，已隔离在库 ${batchQty} ${material.unit} 并通知 ${vendorCount} 家商铺，请跟进游客退换与健康反馈。`,
        target, source: 'manual'
      })
      complaintId = cRes?.id || null
      if (complaintId) db.prepare('UPDATE recall_orders SET complaint_id=? WHERE id=?').run(complaintId, id)

      // 4) 事件通知
      const impact = sev === 3 ? -2 : sev === 2 ? -1 : 0
      const eventId = addEvent(ctx.day(), 'recall', `供应商批次召回 · ${material.name}`,
        `「${supplier.name}」供应的「${material.name}」${SEVERITY_NAMES[sev]}召回（${why}）：已隔离 ${batchQty} ${material.unit}（${batchDesc.join('、')}），通知 ${vendorCount} 家自营/联营商铺下架并办理游客退货退款，待供应商受理与赔付。`,
        impact, 'active')
      db.prepare('UPDATE recall_orders SET event_id=? WHERE id=?').run(eventId, id)

      logRecall(id, 'create', `发起${SEVERITY_NAMES[sev]}召回：隔离 ${batchQty} ${material.unit}，通知 ${vendorCount} 家商铺`, { staffId: num(staffId) || null })
      return { ok: true, id, code: 'ZH' + String(id).padStart(4, '0'), batchQty, affectedVendors: vendorCount, complaintId }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '发起召回失败' }
  }
}

// ---------------- 供应商受理 ----------------
export function acceptRecall(id, { staffId = null, note = '' } = {}) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (r.status !== 'issued') return { ok: false, code: 'BAD_STATUS', msg: '仅待受理召回单可受理' }
  try {
    return tx(() => {
      db.prepare("UPDATE recall_orders SET status='processing', accept_tick=? WHERE id=?").run(ctx.tick(), r.id)
      logRecall(r.id, 'accept', `供应商「${getSupplier(r.supplier_id)?.name}」已受理召回，启动退换与赔付流程${note ? '：' + note : ''}`, { actor: 'supplier', staffId: num(staffId) || null })
      return { ok: true }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// ---------------- 联营商户确认知悉 ----------------
export function acknowledgeVendor(recallId, vendorId, { note = '' } = {}) {
  const rv = db.prepare('SELECT * FROM recall_vendors WHERE recall_id=? AND vendor_id=?').get(num(recallId), num(vendorId))
  if (!rv) return { ok: false, code: 'NOT_FOUND', msg: '该商铺不在本次召回影响范围内' }
  if (!rv.is_partner) return { ok: false, code: 'BAD_STATUS', msg: '仅联营商户需在此确认（自营商铺由园方统一处置）' }
  if (rv.status === 'refunded') return { ok: false, code: 'BAD_STATUS', msg: '该商铺已完成退货退款' }
  try {
    return tx(() => {
      db.prepare("UPDATE recall_vendors SET status='acknowledged', ack_tick=? WHERE id=?").run(ctx.tick(), rv.id)
      const v = db.prepare('SELECT name FROM vendors WHERE id=?').get(rv.vendor_id)
      logRecall(rv.recall_id, 'vendor_ack', `联营商户「${v?.name}」确认知悉召回，已下架并开始联系游客退换${note ? '：' + note : ''}`, { actor: 'partner', vendorId: rv.vendor_id })
      return { ok: true }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// 游客退货退款（按商铺）：召回商品不退库（问题品由游客处置），自营退现金，联营红冲分账。
// 现金/库存留痕/红冲/单据回写同事务；系统异常整体回滚后，统一补偿队列承接重试
//（幂等：以 recall_vendor 已退款数量为准，不重复退现金、不重复红冲账单）。
export function vendorRefund(recallId, vendorId, qty, { note = '', staffId = null } = {}) {
  const r = getRecall(recallId)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (!OPEN_STATUS.includes(r.status)) return { ok: false, code: 'BAD_STATUS', msg: '召回单已结案，不能再登记退款' }
  const rv0 = db.prepare('SELECT * FROM recall_vendors WHERE recall_id=? AND vendor_id=?').get(r.id, num(vendorId))
  if (!rv0) return { ok: false, code: 'NOT_FOUND', msg: '该商铺不在本次召回影响范围内' }
  const q = Math.max(1, Math.round(num(qty)))
  if (q > rv0.sold_qty - rv0.refund_qty + 0.0001) {
    return { ok: false, code: 'QTY_EXCEED', msg: `退款数量不能超过该铺待召回净售出 ${round1(rv0.sold_qty - rv0.refund_qty)}` }
  }
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(rv0.vendor_id)
  const material = getMaterial(r.material_id)
  const refund = Math.round(q * (v?.price || 0))
  if (refund <= 0) return { ok: false, code: 'BAD_ARG', msg: '该商铺售价为 0，无法计算退款金额' }
  const res = applyVendorRefundTx({ recallId: r.id, rv: rv0, q, refund, note, staffId })
  if (res.ok) return res
  // 系统异常（事务已回滚，无资金/库存/红冲副作用）：统一补偿队列挂起重试，不虚报成功
  if (res.code === 'TX_FAILED' || res.code === 'PARTNER_RETURN_FAILED') {
    enqueuePartnerRecallRefund({ recallId: r.id, rvId: rv0.id, vendorId: rv0.vendor_id, qty: q, isPartner: !!rv0.is_partner, reason: res.code })
    return { ok: false, code: 'QUEUED_COMPENSATION', queued: true, msg: '退款处理失败（本次未生效），已进入统一补偿队列自动重试，不会重复扣款/退款' }
  }
  return res
}

// 退款事务本体（可被补偿处理器复用，必须幂等）：
// 以 recall_vendors.refund_qty 的条件增量更新作为“是否已退”的唯一防线——
// 重试/人工已退导致可退数量不足时整体回滚并由处理器判定 obsolete，绝不重复退款/重复红冲。
function applyVendorRefundTx({ recallId, rv, q, refund, note = '', staffId = null }) {
  try {
    return tx(() => {
      const r = getRecall(recallId)
      const rvRow = db.prepare('SELECT * FROM recall_vendors WHERE id=?').get(rv.id)
      if (!r || !rvRow) throw new RecallError('NOT_FOUND', '召回单或商铺记录不存在')
      if (!OPEN_STATUS.includes(r.status)) throw new RecallError('BAD_STATUS', '召回单已结案，不能再退款')
      if (q > rvRow.sold_qty - rvRow.refund_qty + 0.0001) {
        throw new RecallError('QTY_EXCEED', `可退数量不足（待退净售出 ${round1(rvRow.sold_qty - rvRow.refund_qty)}）`)
      }
      const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(rvRow.vendor_id)
      const material = getMaterial(r.material_id)
      if (rvRow.is_partner) {
        // 联营：园方代付游客退款，分账以负向红冲行结转下一账单（不退库、不回补批次成本）
        const pr = ctx.organicPartnerReturn?.(rvRow.vendor_id, q, {
          refund, complaintId: r.complaint_id || null,
          reason: `供应商批次召回 ${r.code} 游客退货（问题品不回库）`
        })
        if (pr && !pr.ok) throw new RecallError(pr.code || 'PARTNER_RETURN_FAILED', pr.msg || '联营红冲失败')
      }
      // 自营由园方承担退款；联营园方当场代付游客（红冲在结算时向商户收回）——统一现金扣减
      ctx.deductCash?.(refund)
      ctx.logFinance?.(ctx.day(), '商业', -refund, `召回 ${r.code}「${v?.name}」游客退货退款 ${q} ${material?.unit || '份'}（${rvRow.is_partner ? '联营红冲' : '自营'}）`)
      // 库存口径留痕：仅记退货数量（正），不回补在库（问题品不回库），供净售出统计冲减
      db.prepare(`INSERT INTO stock_movements(material_id,batch_id,vendor_id,change,qty_after,reason,ref_type,ref_id,day,tick)
                  VALUES(?,NULL,?,?, (SELECT qty_on_hand FROM inventory WHERE material_id=?), 'recall_refund','recall',?,?,?)`)
        .run(r.material_id, rvRow.vendor_id, q, r.material_id, r.id, ctx.day(), ctx.tick())

      db.prepare('UPDATE recall_vendors SET refund_qty=refund_qty+?, refund_amount=refund_amount+?, status=? WHERE id=?')
        .run(q, refund, 'refunded', rvRow.id)
      db.prepare('UPDATE recall_orders SET refund_qty=refund_qty+?, refund_amount=refund_amount+? WHERE id=?').run(q, refund, r.id)
      logRecall(r.id, 'refund', `「${v?.name}」为 ${q} ${material?.unit || '份'}问题商品办理游客退货退款 ¥${refund}`, { actor: rvRow.is_partner ? 'partner' : 'park', vendorId: rvRow.vendor_id, staffId: num(staffId) || null })
      return { ok: true, qty: q, refund, partner: !!rvRow.is_partner }
    })
  } catch (e) {
    if (e instanceof RecallError) return { ok: false, code: e.code, msg: e.message }
    return { ok: false, code: 'TX_FAILED', msg: e.message || '退货退款失败' }
  }
}

// 统一补偿队列挂载：联营/自营召回游客退款失败后独立持久化（含红冲账单同步）
function enqueuePartnerRecallRefund({ recallId, rvId, vendorId, qty, isPartner, reason }) {
  enqueueDetached({
    domain: 'partner',
    action: 'partner_recall_refund',
    idemKey: `recall:${recallId}:rv:${rvId}:qty:${qty}`,
    refType: 'recall_vendor',
    refId: rvId,
    priority: 2,
    source: 'retry',
    payload: { recallId, recallVendorId: rvId, vendorId, qty, isPartner: !!isPartner },
    note: `召回游客退货退款失败（${reason}），统一补偿队列重试（现金+红冲账单同步）`
  })
}

// ---------------- 统一补偿队列：联营退款处理器（召回游客退货；自营/联营共用） ----------------
// 同步四个口径：现金（代付游客退款）、库存（退货留痕，不回库）、投诉（关联召回投诉随退款推进）、
// 账单（联营红冲行 settlement_id=0，自动结转下一张结算账单冲减商户应得）。
registerHandler('partner', (task) => {
  if (task.action !== 'partner_recall_refund') throw new Error(`UNSUPPORTED_PARTNER_ACTION:${task.action}`)
  const { recallId, recallVendorId, qty } = task.payload
  const rv = db.prepare('SELECT * FROM recall_vendors WHERE id=?').get(num(recallVendorId))
  if (!rv) return { obsolete: true, note: '召回商铺记录不存在' }
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(rv.vendor_id)
  const refund = Math.round(num(qty) * (v?.price || 0))
  // 幂等防线：退款事务以“sold_qty-refund_qty 仍够本任务数量”为条件；
  // 若人工/他途已退导致可退数量不足本任务数量，说明本任务对应商品已被处置，任务作废，不补退差额、不重复红冲。
  const remainSold = Math.round(((rv.sold_qty - rv.refund_qty) + Number.EPSILON) * 100) / 100
  if (remainSold + 0.0001 < num(qty)) {
    return { obsolete: true, note: `该铺待退净售出仅 ${remainSold} 份（人工或他途已退款 ${rv.refund_qty} 份），补偿作废，不重复退款/红冲` }
  }
  const res = applyVendorRefundTx({ recallId: num(recallId), rv, q: num(qty), refund })
  if (!res.ok) {
    if (res.code === 'QTY_EXCEED' || res.code === 'BAD_STATUS') {
      return { obsolete: true, note: res.msg }
    }
    throw new Error(`${res.code} ${res.msg}`)   // 触发队列退避重试
  }
  // 账单口径：联营红冲行已写入（settlement_id=0），下张结算单自动净额冲减
  const billNote = res.partner
    ? '联营红冲已入账，结转下张结算账单冲减商户应得与分成'
    : '自营退款现金已扣减（无联营账单）'
  return {
    ok: true,
    qty: res.qty,
    cash: res.refund,
    stock: `召回退货留痕 ${res.qty} 份（问题品不回库）`,
    complaint: '关联召回投诉随退款推进，结案时统一闭环',
    bill: billNote
  }
})

// ---------------- 隔离批次退回供应商 ----------------
export function returnBatches(id, qty, { staffId = null } = {}) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (!OPEN_STATUS.includes(r.status)) return { ok: false, code: 'BAD_STATUS', msg: '召回单已结案，不能再退货' }
  try {
    return tx(() => {
      const res = returnQuarantinedToSupplier(r.id, qty)
      db.prepare('UPDATE recall_orders SET returned_qty=returned_qty+?, return_amount=return_amount+? WHERE id=?')
        .run(res.qty, res.amount, r.id)
      logRecall(r.id, 'return', `隔离批次退供应商 ${res.qty}，货款 ¥${res.amount}（现金退/赔 ¥${res.cashBack}，冲应付 ¥${res.creditApplied}）`, { actor: 'park', staffId: num(staffId) || null })
      return { ok: true, ...res }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// ---------------- 现场销毁 ----------------
export function destroyBatches(id, qty, { staffId = null, note = '' } = {}) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (!OPEN_STATUS.includes(r.status)) return { ok: false, code: 'BAD_STATUS', msg: '召回单已结案，不能再销毁' }
  try {
    return tx(() => {
      const res = destroyQuarantinedBatches(r.id, qty)
      db.prepare('UPDATE recall_orders SET destroyed_qty=destroyed_qty+?, destroy_cost=destroy_cost+? WHERE id=?')
        .run(res.qty, res.cost, r.id)
      logRecall(r.id, 'destroy', `问题批次现场销毁 ${res.qty}，核销物料成本 ¥${res.cost}${note ? '：' + note : ''}`, { actor: 'park', staffId: num(staffId) || null })
      return { ok: true, ...res }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// ---------------- 供应商赔付 ----------------
// 赔付 = 隔离批次货款损失（销毁未退供部分按成本）+ 游客退款 + 严重度罚则（可调整）
export function compensationQuote(id) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  const batches = recallQuarantinedBatches(r.id)
  const remainStockCost = Math.round(batches.reduce((s, b) => s + b.q_qty * b.unit_cost, 0))
  const goodsLoss = r.return_amount + r.destroy_cost + remainStockCost
  const refund = r.refund_amount
  const base = goodsLoss + refund
  const penalty = Math.round((goodsLoss + refund) * (PENALTY_MUL[r.severity] || 0))
  return {
    ok: true,
    goodsLoss,            // 批次货款损失（已退 + 已销毁 + 仍隔离的成本）
    refund,               // 游客退款（供应商承担）
    remainStockCost,      // 仍在隔离的批次成本（结案前应先退供/销毁）
    penalty,              // 严重度罚则
    suggested: base + penalty
  }
}

export function payCompensation(id, amount, { staffId = null, note = '' } = {}) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (!OPEN_STATUS.includes(r.status)) return { ok: false, code: 'BAD_STATUS', msg: '召回单已结案' }
  const pay = Math.round(num(amount))
  if (pay <= 0) return { ok: false, code: 'BAD_ARG', msg: '赔付金额须大于 0' }
  const quote = compensationQuote(id)
  const penalty = Math.min(pay, Math.max(0, quote.suggested - (quote.goodsLoss + quote.refund)))
  try {
    return tx(() => {
      ctx.addCash?.(pay)
      ctx.logFinance?.(ctx.day(), '召回赔付', pay, `供应商「${getSupplier(r.supplier_id)?.name}」召回 ${r.code} 赔付到账（货款/退款损失 + 罚则 ¥${penalty}）`)
      db.prepare('UPDATE recall_orders SET compensation_amount=compensation_amount+?, penalty_amount=penalty_amount+? WHERE id=?')
        .run(pay, penalty, r.id)
      logRecall(r.id, 'compensate', `供应商赔付到账 ¥${pay}（含严重度罚则 ¥${penalty}）${note ? '：' + note : ''}`, { actor: 'supplier', staffId: num(staffId) || null })
      return { ok: true, amount: pay, penalty }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// ---------------- 结案 ----------------
export function closeRecall(id, { note = '', staffId = null } = {}) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (!OPEN_STATUS.includes(r.status)) return { ok: false, code: 'BAD_STATUS', msg: '召回单已结案' }
  const remain = recallQuarantinedBatches(r.id)
  if (remain.length) return { ok: false, code: 'STOCK_REMAIN', msg: `仍有 ${round1(remain.reduce((s, b) => s + b.q_qty, 0))} 隔离批次未处置，请先退回供应商或现场销毁` }
  // 有净售出但未完成退货退款、也未标记"线下已处置"的商铺，必须先逐铺退货退款或确认无在途，避免漏退游客
  const pendingVendors = db.prepare("SELECT COUNT(*) n FROM recall_vendors WHERE recall_id=? AND sold_qty-refund_qty>0.0001 AND status NOT IN ('refunded','none')").get(r.id).n
  if (pendingVendors > 0) return { ok: false, code: 'REFUND_PENDING', msg: `仍有 ${pendingVendors} 家商铺未完成游客退货退款，请先办理或确认"无在途游客/线下已退"` }
  try {
    return tx(() => {
      db.prepare("UPDATE recall_orders SET status='closed', close_tick=?, close_day=?, close_note=? WHERE id=?")
        .run(ctx.tick(), ctx.day(), String(note || ''), r.id)
      // 关联餐饮投诉随召回闭环（赔付/退款已在召回侧完成，按无争议正向闭环）
      if (r.complaint_id) {
        ctx.closeComplaint?.(r.complaint_id, 'recall_closed', {
          recallCode: r.code, refund: r.refund_amount, compensation: r.compensation_amount
        })
      }
      updateEvent(r.event_id, 'resolved', `召回闭环：退供/销毁批次货款 ¥${r.return_amount + r.destroy_cost}，游客退款 ¥${r.refund_amount}，供应商赔付 ¥${r.compensation_amount}。`)
      // 供应商评级：紧急或发生游客健康赔付的召回下调评级（不低于 1）
      const s = getSupplier(r.supplier_id)
      if (s && (r.severity >= 3 || r.refund_amount > 0)) {
        db.prepare('UPDATE suppliers SET rating=MAX(1,rating-1) WHERE id=?').run(s.id)
      }
      logRecall(r.id, 'close', `召回闭环结案${note ? '：' + note : ''}`, { actor: 'park', staffId: num(staffId) || null })
      return { ok: true }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// 商铺确认无在途游客/线下已完成退换（剩余净售出无需系统退款），置 none 以放行结案
export function markVendorNone(recallId, vendorId, { note = '' } = {}) {
  const rv = db.prepare('SELECT * FROM recall_vendors WHERE recall_id=? AND vendor_id=?').get(num(recallId), num(vendorId))
  if (!rv) return { ok: false, code: 'NOT_FOUND', msg: '该商铺不在本次召回影响范围内' }
  if (rv.sold_qty - rv.refund_qty <= 0.0001) return { ok: false, code: 'BAD_STATUS', msg: '该商铺已无待退数量' }
  try {
    return tx(() => {
      db.prepare("UPDATE recall_vendors SET status='none' WHERE id=?").run(rv.id)
      const v = db.prepare('SELECT name FROM vendors WHERE id=?').get(rv.vendor_id)
      logRecall(rv.recall_id, 'vendor_none', `「${v?.name}」确认剩余 ${round1(rv.sold_qty - rv.refund_qty)} 份无在途游客/已线下退换${note ? '：' + note : ''}`, { actor: rv.is_partner ? 'partner' : 'park', vendorId: rv.vendor_id })
      return { ok: true }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// 误报结案：解除全部隔离恢复销售，关联投诉按误报中性关闭
export function closeFalseRecall(id, { reason = '', staffId = null } = {}) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (!OPEN_STATUS.includes(r.status)) return { ok: false, code: 'BAD_STATUS', msg: '召回单已结案' }
  try {
    return tx(() => {
      let released = 0
      for (const b of db.prepare('SELECT * FROM inbound_batches WHERE recall_id=? AND COALESCE(quarantined_qty,0)>0').all(r.id)) {
        const x = releaseBatchQuarantine(b.id, b.quarantined_qty, r.id, { clearRecall: true })
        released = round1(released + x.qty)
      }
      db.prepare("UPDATE recall_orders SET status='closed_false', released_qty=?, close_tick=?, close_day=?, close_note=? WHERE id=?")
        .run(released, ctx.tick(), ctx.day(), String(reason || '经核实为误报'), r.id)
      if (r.complaint_id) ctx.closeComplaint?.(r.complaint_id, 'recall_false', { recallCode: r.code, note: reason })
      updateEvent(r.event_id, 'resolved', `经核实批次合格，召回为误报，已解除 ${released} 隔离恢复销售。`)
      logRecall(r.id, 'false', `误报结案，解除隔离 ${released} 恢复销售：${reason || '批次复检合格'}`, { actor: 'park', staffId: num(staffId) || null })
      return { ok: true, released }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// 撤销（仅发起未受理）：解除隔离恢复销售
export function cancelRecall(id, { reason = '', staffId = null } = {}) {
  const r = getRecall(id)
  if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
  if (r.status !== 'issued') return { ok: false, code: 'BAD_STATUS', msg: '仅待受理召回单可撤销（受理后请走误报结案）' }
  try {
    return tx(() => {
      let released = 0
      for (const b of db.prepare('SELECT * FROM inbound_batches WHERE recall_id=? AND COALESCE(quarantined_qty,0)>0').all(r.id)) {
        const x = releaseBatchQuarantine(b.id, b.quarantined_qty, r.id, { clearRecall: true })
        released = round1(released + x.qty)
      }
      db.prepare("UPDATE recall_orders SET status='cancelled', released_qty=?, close_tick=?, close_day=?, close_note=? WHERE id=?")
        .run(released, ctx.tick(), ctx.day(), String(reason || ''), r.id)
      if (r.complaint_id) ctx.closeComplaint?.(r.complaint_id, 'recall_false', { recallCode: r.code, note: reason || '召回已撤销' })
      updateEvent(r.event_id, 'resolved', `召回已撤销，解除 ${released} 隔离恢复销售。`)
      logRecall(r.id, 'cancel', `撤销召回，解除隔离 ${released} 恢复销售${reason ? '：' + reason : ''}`, { actor: 'park', staffId: num(staffId) || null })
      return { ok: true, released }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// ---------------- 查询 / 统计 ----------------
function enrichVendorRow(rv) {
  const v = db.prepare('SELECT id,name,type,price FROM vendors WHERE id=?').get(rv.vendor_id)
  return {
    ...rv,
    vendor_name: v?.name || '',
    vendor_type: v?.type || '',
    price: v?.price || 0,
    remain_qty: round1(rv.sold_qty - rv.refund_qty)
  }
}
function enrichRecall(r) {
  const material = getMaterial(r.material_id)
  const supplier = getSupplier(r.supplier_id)
  const vendors = db.prepare('SELECT * FROM recall_vendors WHERE recall_id=? ORDER BY id').all(r.id).map(enrichVendorRow)
  const remainQuarantine = round1(recallQuarantinedBatches(r.id).reduce((s, b) => s + b.q_qty, 0))
  const complaint = r.complaint_id ? db.prepare('SELECT code,status FROM complaints WHERE id=?').get(r.complaint_id) : null
  return {
    ...r,
    material_name: material?.name || '',
    unit: material?.unit || '',
    supplier_name: supplier?.name || '',
    severity_name: SEVERITY_NAMES[r.severity] || '',
    vendors,
    remain_quarantine: remainQuarantine,
    complaint_code: complaint?.code || '',
    complaint_status: complaint?.status || ''
  }
}
export function listRecalls({ status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM recall_orders WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM recall_orders ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(enrichRecall)
}
export function recallDetail(id) {
  const r = getRecall(id)
  if (!r) return null
  const batches = db.prepare('SELECT * FROM inbound_batches WHERE material_id=? AND (recall_id=? OR id IN (SELECT batch_id FROM stock_movements WHERE ref_type=? AND ref_id=?)) ORDER BY id DESC LIMIT 100')
    .all(r.material_id, r.id, 'recall', r.id)
    .map(b => ({
      ...b,
      quarantined_here: num(b.recall_id) === r.id ? round1(num(b.quarantined_qty)) : 0,
      material_name: getMaterial(b.material_id)?.name || ''
    }))
  const logs = db.prepare('SELECT * FROM recall_logs WHERE recall_id=? ORDER BY id').all(r.id)
  return { recall: enrichRecall(r), batches, logs, quote: compensationQuote(r.id) }
}
export function recallStats() {
  const one = sql => db.prepare(sql).get()
  const open = one("SELECT COUNT(*) n, COALESCE(SUM(batch_qty),0) q, COALESCE(SUM(refund_amount),0) refund FROM recall_orders WHERE status IN ('issued','processing')")
  return {
    open: num(open.n),
    issued: one("SELECT COUNT(*) n FROM recall_orders WHERE status='issued'").n,
    processing: one("SELECT COUNT(*) n FROM recall_orders WHERE status='processing'").n,
    closed: one("SELECT COUNT(*) n FROM recall_orders WHERE status IN ('closed','closed_false','cancelled')").n,
    openBatchQty: round1(num(open.q)),
    openRefund: num(open.refund),
    pendingVendors: one("SELECT COUNT(*) n FROM recall_vendors WHERE is_partner=1 AND status='notified'").n,
    pendingRefundVendors: one("SELECT COUNT(*) n FROM recall_vendors WHERE sold_qty-refund_qty>0.0001 AND status<>'refunded' AND recall_id IN (SELECT id FROM recall_orders WHERE status IN ('issued','processing'))").n,
    compensationTotal: one("SELECT COALESCE(SUM(compensation_amount),0) a FROM recall_orders WHERE status='closed'").a,
    refundTotal: one("SELECT COALESCE(SUM(refund_amount),0) a FROM recall_orders").a
  }
}
