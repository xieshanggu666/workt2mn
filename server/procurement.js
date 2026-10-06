import db, { getSetting, setSetting, tx } from './db.js'

// 园区物资采购与库存模块：
//   供应商档案 → 采购单（运营/商铺协同/缺货自动草稿）→ 审批 → 收货按批次入库（保质期/批次价）
//   → FEFO 先到期先出扣库存联动商铺销售（缺货记流失）→ 账期付款/退货冲抵 → 盘点调账 → 异常对账
// 所有多步写操作（库存/批次/单据/现金/流水）在同一事务提交，任一步失败整体回滚。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const round1 = v => Math.round(v * 10) / 10

// 由 index.js 注入（时钟/现金直接读 settings；财务流水与销售联动钩子在此接线）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  // 联营联动：联营商户销售/退货的库存批次成本回调（扣库存在采购事务内，回调不得再开写事务）
  partnerStockHook: null
}
export function initProcurementContext(deps) {
  Object.assign(ctx, deps)
}

export class ProcError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra) }
}

const FIN_LABEL = '物料成本'   // 采购付款/报损盘亏的财务科目（现金制：付款时确认成本）
const EXPIRY_WARN_DAYS = 2    // 临期预警提前天数

// ---------------- 编码 / 基础读写 ----------------
function genCode(prefix, table, idCol = 'id') {
  const id = db.prepare(`SELECT MAX(${idCol}) m FROM ${table}`).get().m || 0
  return prefix + String(id + 1).padStart(4, '0')
}
function stampCode(table, idCol, id, prefix) {
  db.prepare(`UPDATE ${table} SET code=? WHERE ${idCol}=?`).run(prefix + String(id).padStart(4, '0'), id)
}
function logOrder(orderId, action, note = '', staffId = null) {
  db.prepare('INSERT INTO purchase_logs(order_id,tick,day,action,note,staff_id) VALUES(?,?,?,?,?,?)')
    .run(orderId, ctx.tick(), ctx.day(), action, note, staffId)
}
function logMovement(materialId, batchId, vendorId, change, qtyAfter, reason, refType, refId) {
  db.prepare(`INSERT INTO stock_movements(material_id,batch_id,vendor_id,change,qty_after,reason,ref_type,ref_id,day,tick)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(materialId, batchId, vendorId, change, qtyAfter, reason, refType, refId || 0, ctx.day(), ctx.tick())
}
function getMaterial(id) {
  return db.prepare('SELECT * FROM materials WHERE id=?').get(id)
}
function onHand(materialId) {
  return num(db.prepare('SELECT qty_on_hand FROM inventory WHERE material_id=?').get(materialId)?.qty_on_hand)
}
function setOnHand(materialId, qty) {
  db.prepare(`INSERT INTO inventory(material_id,qty_on_hand,qty_reserved,updated_tick)
              VALUES(?,?,0,?) ON CONFLICT(material_id) DO UPDATE SET qty_on_hand=excluded.qty_on_hand, updated_tick=excluded.updated_tick`)
    .run(materialId, round1(qty), ctx.tick())
}

// 批次当前可销售量 = 剩余 - 召回隔离量（隔离量不参与销售/FEFO 消耗）
function batchSaleAvail(b) {
  return round1(Math.max(0, num(b.qty_remain) - num(b.quarantined_qty)))
}

// 可销售批次：在库、有未隔离剩余、未过期；先到期先出（FEFO，无保质期排最后）
function saleableBatches(materialId) {
  const day = ctx.day()
  return db.prepare(`SELECT * FROM inbound_batches
                     WHERE material_id=? AND status='in'
                       AND COALESCE(qty_remain-quarantined_qty,0)>0
                       AND (expire_day=0 OR expire_day>? )
                     ORDER BY CASE WHEN expire_day=0 THEN 1 ELSE 0 END, expire_day, id`)
    .all(materialId, day)
}
function availableQty(materialId) {
  return round1(saleableBatches(materialId).reduce((s, b) => s + batchSaleAvail(b), 0))
}

// FEFO 扣减库存：逐批次扣到 0 再切下一批；调用方需先确认可用量充足
// includeExpiring=true 时允许核减已过期批次（盘亏/报损场景），销售扣减只走未过期批次
// partner 标记联营商户销售扣减：流水记 partner_sale 以便结算时按 FEFO 批次成本汇总扣收
function deductStock(materialId, qty, { vendorId = null, reason = 'sale', refType = '', refId = 0, includeExpired = false, partner = false } = {}) {
  let remain = qty
  const cuts = []
  const batches = includeExpired
    ? db.prepare(`SELECT * FROM inbound_batches WHERE material_id=? AND status='in' AND qty_remain>0
                  ORDER BY CASE WHEN expire_day=0 THEN 1 ELSE 0 END, expire_day,id`).all(materialId)
    : saleableBatches(materialId)
  for (const b of batches) {
    const avail = batchSaleAvail(b)
    if (avail <= 0) continue
    if (remain <= 0) break
    const take = Math.min(avail, remain)
    const left = round1(b.qty_remain - take)
    db.prepare('UPDATE inbound_batches SET qty_remain=?, status=? WHERE id=?')
      .run(left, left <= 0 ? 'exhausted' : 'in', b.id)
    remain = round1(remain - take)
    cuts.push({ batchId: b.id, take, unitCost: b.unit_cost })
  }
  if (remain > 0.0001) throw new ProcError('STOCK_INSUFFICIENT', `库存扣减失败：物资#${materialId} 可用量不足`)
  const after = round1(onHand(materialId) - qty)
  setOnHand(materialId, after)
  const useReason = partner && reason === 'sale' ? 'partner_sale' : reason
  for (const c of cuts) {
    logMovement(materialId, c.batchId, vendorId, -c.take, after, useReason, refType, refId)
    if (partner) ctx.partnerStockHook?.(vendorId, { kind: 'sale', materialId, batchId: c.batchId, qty: c.take, unitCost: c.unitCost })
  }
  return cuts
}

// 入库：收货/盘盈/退货回补。expireDay=0 表示无保质期
function receiveIntoStock(materialId, qty, unitCost, { orderId = null, supplierId = null, expireDay = 0, reason = 'in', note = '' } = {}) {
  const r = db.prepare(`INSERT INTO inbound_batches(order_id,material_id,supplier_id,qty_received,qty_remain,unit_cost,receive_day,expire_day,status,note)
                        VALUES(?,?,?,?,?,?,?,?, 'in',?)`)
    .run(orderId, materialId, supplierId, qty, qty, num(unitCost), ctx.day(), expireDay, note)
  const bid = Number(r.lastInsertRowid)
  stampCode('inbound_batches', 'id', bid, 'RK')
  const after = round1(onHand(materialId) + qty)
  setOnHand(materialId, after)
  logMovement(materialId, bid, null, qty, after, reason, 'batch', bid)
  return bid
}

function addFinding({ type, severity = 'warn', materialId = null, supplierId = null, orderId = null, refType = '', refId = 0, title, detail = '', amount = 0 }) {
  // 同类同对象只保留一条未处理：已存在 open 则不重复生成（状态推进时再升级严重度）
  const dup = db.prepare(`SELECT id, severity FROM inventory_findings
                          WHERE status='open' AND type=? AND IFNULL(material_id,-1)=IFNULL(?,-1)
                            AND IFNULL(supplier_id,-1)=IFNULL(?,-1) AND IFNULL(order_id,-1)=IFNULL(?,-1)
                            AND ref_type=? AND ref_id=?`).get(type, materialId, supplierId, orderId, refType, refId)
  if (dup) {
    if (severity === 'critical' && dup.severity !== 'critical') {
      db.prepare("UPDATE inventory_findings SET severity='critical' WHERE id=?").run(dup.id)
    }
    return dup.id
  }
  const r = db.prepare(`INSERT INTO inventory_findings(type,severity,material_id,supplier_id,order_id,ref_type,ref_id,title,detail,amount,status,create_day,create_tick)
                        VALUES(?,?,?,?,?,?,?,?,?,?, 'open',?,?)`)
    .run(type, severity, materialId, supplierId, orderId, refType, refId, title, detail, amount, ctx.day(), ctx.tick())
  return Number(r.lastInsertRowid)
}
function resolveFindingRef(refType, refId, note = '系统自动核销') {
  db.prepare("UPDATE inventory_findings SET status='resolved', resolve_note=?, resolve_day=? WHERE status='open' AND ref_type=? AND ref_id=?")
    .run(note, ctx.day(), refType, refId)
}

// ---------------- 供应商 ----------------
export function listSuppliers({ status = null } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM suppliers WHERE status=? ORDER BY id').all(status)
    : db.prepare('SELECT * FROM suppliers ORDER BY id').all()
  return rows.map(s => {
    const ap = db.prepare(`SELECT COALESCE(SUM(total_amount),0) t, COALESCE(SUM(paid_amount),0) p
                           FROM purchase_orders WHERE supplier_id=? AND status IN ('approved','partial','received')`).get(s.id)
    const credited = db.prepare(`SELECT COALESCE(SUM(r.amount),0) c FROM purchase_returns r
                                 JOIN purchase_orders o ON o.id=r.order_id
                                 WHERE r.kind='purchase' AND o.supplier_id=?`).get(s.id).c
    const orderCnt = db.prepare('SELECT COUNT(*) n FROM purchase_orders WHERE supplier_id=?').get(s.id).n
    return { ...s, order_count: orderCnt, payable: Math.max(0, ap.t - ap.p - credited) }
  })
}
export function supplierDetail(id) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id)
  if (!s) return null
  const orders = db.prepare('SELECT * FROM purchase_orders WHERE supplier_id=? ORDER BY id DESC LIMIT 50').all(id)
  return { supplier: listSuppliers().find(x => x.id === id), orders }
}
export function saveSupplier(payload = {}, id = null) {
  const name = String(payload.name || '').trim()
  if (!name) return { ok: false, code: 'BAD_ARG', msg: '供应商名称必填' }
  if (id) {
    const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id)
    if (!s) return { ok: false, code: 'NOT_FOUND', msg: '供应商不存在' }
    db.prepare(`UPDATE suppliers SET name=?,contact=?,phone=?,category=?,pay_term_days=?,rating=?,status=?,note=? WHERE id=?`)
      .run(name, String(payload.contact ?? s.contact), String(payload.phone ?? s.phone),
           String(payload.category ?? s.category), Math.max(0, num(payload.pay_term_days ?? s.pay_term_days)),
           Math.min(5, Math.max(1, num(payload.rating ?? s.rating))),
           payload.status === 'suspended' ? 'suspended' : 'active',
           String(payload.note ?? s.note), id)
    return { ok: true, id }
  }
  const r = db.prepare(`INSERT INTO suppliers(name,contact,phone,category,pay_term_days,rating,status,note,created_day)
                        VALUES(?,?,?,?,?,?, 'active',?,?)`)
    .run(name, String(payload.contact || ''), String(payload.phone || ''),
         String(payload.category || '综合'), Math.max(0, num(payload.pay_term_days)),
         Math.min(5, Math.max(1, num(payload.rating, 3))), String(payload.note || ''), ctx.day())
  const nid = Number(r.lastInsertRowid)
  stampCode('suppliers', 'id', nid, 'S')
  return { ok: true, id: nid }
}

// ---------------- 物资目录 / 商铺供货映射 ----------------
export function listMaterials() {
  const mats = db.prepare('SELECT * FROM materials ORDER BY id').all()
  return mats.map(m => {
    const qty = availableQty(m.id)
    const quarantined = num(db.prepare('SELECT COALESCE(SUM(quarantined_qty),0) q FROM inbound_batches WHERE material_id=?').get(m.id)?.q)
    const expiring = db.prepare(`SELECT COALESCE(SUM(qty_remain),0) n FROM inbound_batches
                                 WHERE material_id=? AND status='in' AND qty_remain>0 AND expire_day>0
                                   AND expire_day<=?`).get(m.id, ctx.day() + EXPIRY_WARN_DAYS).n
    const vendors = db.prepare(`SELECT v.id,v.name FROM vendor_materials vm JOIN vendors v ON v.id=vm.vendor_id
                                WHERE vm.material_id=? ORDER BY v.id`).all(m.id)
    const stock_status = qty <= 0 ? 'out' : qty < m.safety_stock ? 'low' : 'ok'
    return { ...m, qty_on_hand: qty, quarantined_qty: round1(quarantined), physical_qty: round1(qty + quarantined), expiring_qty: round1(expiring), stock_status, vendors }
  })
}
export function materialMovements(materialId, { limit = 100 } = {}) {
  return db.prepare('SELECT * FROM stock_movements WHERE material_id=? ORDER BY id DESC LIMIT ?').all(materialId, limit)
}
export function saveMaterial(payload = {}, id = null) {
  const name = String(payload.name || '').trim()
  if (!name) return { ok: false, code: 'BAD_ARG', msg: '物资名称必填' }
  const fields = {
    category: String(payload.category || '食材'),
    unit: String(payload.unit || '份'),
    std_cost: Math.max(0, Math.round(num(payload.std_cost))),
    safety_stock: Math.max(0, round1(num(payload.safety_stock))),
    shelf_days: Math.max(0, Math.round(num(payload.shelf_days))),
    auto_reorder: num(payload.auto_reorder) ? 1 : 0,
    reorder_qty: Math.max(0, round1(num(payload.reorder_qty))),
    preferred_supplier_id: payload.preferred_supplier_id ? num(payload.preferred_supplier_id) : null
  }
  if (id) {
    if (!getMaterial(id)) return { ok: false, code: 'NOT_FOUND', msg: '物资不存在' }
    db.prepare(`UPDATE materials SET name=?,category=?,unit=?,std_cost=?,safety_stock=?,shelf_days=?,
                auto_reorder=?,reorder_qty=?,preferred_supplier_id=? WHERE id=?`)
      .run(name, fields.category, fields.unit, fields.std_cost, fields.safety_stock, fields.shelf_days,
           fields.auto_reorder, fields.reorder_qty, fields.preferred_supplier_id, id)
    return { ok: true, id }
  }
  const r = db.prepare(`INSERT INTO materials(name,category,unit,std_cost,safety_stock,shelf_days,auto_reorder,reorder_qty,preferred_supplier_id,status)
                        VALUES(?,?,?,?,?,?,?,?,?, 'active')`)
    .run(name, fields.category, fields.unit, fields.std_cost, fields.safety_stock, fields.shelf_days,
         fields.auto_reorder, fields.reorder_qty, fields.preferred_supplier_id)
  const nid = Number(r.lastInsertRowid)
  stampCode('materials', 'id', nid, 'M')
  return { ok: true, id: nid }
}
export function setVendorMaterials(vendorId, materialIds) {
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId)
  if (!v) return { ok: false, code: 'NOT_FOUND', msg: '商铺不存在' }
  const ids = [...new Set((materialIds || []).map(num).filter(Boolean))]
  return tx(() => {
    db.prepare('DELETE FROM vendor_materials WHERE vendor_id=?').run(vendorId)
    const ins = db.prepare('INSERT OR IGNORE INTO vendor_materials(vendor_id,material_id) VALUES(?,?)')
    for (const mid of ids) {
      if (!getMaterial(mid)) throw new ProcError('BAD_ARG', `物资 #${mid} 不存在`)
      ins.run(vendorId, mid)
    }
    return { ok: true }
  })
}
// 新商铺按类型自动挂供货物资
export function autoLinkVendor(vendorId, type) {
  const mats = db.prepare('SELECT id,category FROM materials').all()
  if (!mats.length) return
  const cat = type === '餐饮' ? '食材' : type === '饮品' ? '饮品原料' : '文创百货'
  const pick = mats.filter(m => m.category === cat).slice(0, 1)
  if (!pick.length) return
  db.prepare('INSERT OR IGNORE INTO vendor_materials(vendor_id,material_id) VALUES(?,?)').run(vendorId, pick[0].id)
}
function vendorMaterialIds(vendorId) {
  return db.prepare('SELECT material_id FROM vendor_materials WHERE vendor_id=? ORDER BY material_id').all(vendorId).map(x => x.material_id)
}

// ---------------- 商铺销售联动：实时扣库存（散客 tick + 会员消费共用） ----------------
// 返回实际可售量与缺货流失；未挂物资的商铺视为不受库存管理，销量不受限
export function vendorSaleable(vendorId, want) {
  const mids = vendorMaterialIds(vendorId)
  if (!mids.length) return { managed: false, sold: want, lost: 0, mids: [] }
  let sold = want
  for (const mid of mids) sold = Math.min(sold, availableQty(mid))
  sold = Math.floor(sold * 10) / 10
  return { managed: true, sold: round1(sold), lost: round1(want - sold), mids }
}

export function applyVendorSales(vendorId, wantQty, { partner = false } = {}) {
  const want = Math.max(0, round1(num(wantQty)))
  const cap = vendorSaleable(vendorId, want)
  return tx(() => {
    if (!cap.managed) return cap
    // 有可售量才扣批次；完全断货时 sold=0 也要继续累计流失（持续断货每时段都在损失营收）
    if (cap.sold > 0) {
      for (const mid of cap.mids) {
        deductStock(mid, cap.sold, { vendorId, reason: 'sale', refType: 'vendor', refId: vendorId, partner })
      }
    }
    if (cap.lost > 0) recordLostSale(vendorId, cap.mids, cap.lost)
    return cap
  })
}

// 会员消费专用：要求整单数量可满足，否则抛 STOCKOUT（与支付同事务，会员页可提示改数量）
export function reserveVendorStock(vendorId, qty, { partner = false } = {}) {
  const want = Math.max(1, Math.round(num(qty)))
  const cap = vendorSaleable(vendorId, want)
  if (!cap.managed) return { ok: true, managed: false, sold: want }
  if (cap.sold + 0.0001 < want) {
    const m = cap.mids.map(mid => getMaterial(mid)).find(m => availableQty(m.id) < want)
    throw new ProcError('STOCKOUT', `「${m?.name || '物资'}」库存仅剩 ${availableQty(m?.id)} ${m?.unit || '份'}，本单需 ${want}，请减少数量或等待补货`)
  }
  for (const mid of cap.mids) {
    deductStock(mid, want, { vendorId, reason: 'sale', refType: 'vendor', refId: vendorId, partner })
  }
  return { ok: true, managed: true, sold: want }
}

function recordLostSale(vendorId, mids, qtyLost) {
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId)
  const lostRev = Math.round(qtyLost * (v?.price || 0) * (v?.margin || 0.6))
  // 每个本时段同商铺同物资仅留一条流失记录，连续缺货累加
  for (const mid of mids) {
    const last = db.prepare(`SELECT * FROM stock_lost_sales WHERE vendor_id=? AND IFNULL(material_id,-1)=? AND day=? AND tick=?
                             ORDER BY id DESC LIMIT 1`).get(vendorId, mid, ctx.day(), ctx.tick())
    if (last) {
      db.prepare('UPDATE stock_lost_sales SET qty_lost=?, lost_rev=? WHERE id=?')
        .run(round1(last.qty_lost + qtyLost), last.lost_rev + lostRev, last.id)
    } else {
      db.prepare('INSERT INTO stock_lost_sales(vendor_id,material_id,qty_lost,lost_rev,day,tick) VALUES(?,?,?,?,?,?)')
        .run(vendorId, mid, qtyLost, lostRev, ctx.day(), ctx.tick())
    }
    const m = getMaterial(mid)
    addFinding({
      type: 'shortage', severity: onHand(mid) <= 0 ? 'critical' : 'warn', materialId: mid,
      title: `「${m?.name || '物资'}」缺货影响「${v?.name || '商铺'}」销售`,
      detail: `本时段 ${v?.name || '商铺'} 有 ${qtyLost} 份需求因缺货流失，预估损失营收 ¥${lostRev}；当前库存 ${onHand(mid)} ${m?.unit || ''}，安全库存 ${m?.safety_stock || 0}。`,
      amount: lostRev
    })
  }
}

// 游客销售退货：库存回补（回最近一批在库批次；无批次则新建退货回补批），按售价退款
// partner 标记联营商户退货：流水记 partner_sale_return，返回明细供联营模块红冲分账与批次成本
export function customerReturn(vendorId, qty, { reason = '', memberId = null, partner = false } = {}) {
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId)
  if (!v) return { ok: false, code: 'NOT_FOUND', msg: '商铺不存在' }
  const q = Math.max(1, Math.round(num(qty)))
  const mids = vendorMaterialIds(vendorId)
  try {
    const restored = []
    const r0 = tx(() => {
      for (const mid of mids) {
        const m = getMaterial(mid)
        const batch = db.prepare(`SELECT * FROM inbound_batches WHERE material_id=? AND status='in' ORDER BY id DESC LIMIT 1`).get(mid)
        let bid, unitCost
        if (batch) {
          bid = batch.id
          unitCost = batch.unit_cost
          const left = round1(Math.min(batch.qty_received, batch.qty_remain + q))
          db.prepare("UPDATE inbound_batches SET qty_remain=?, status='in' WHERE id=?").run(left, batch.id)
          const after = round1(onHand(mid) + q)
          setOnHand(mid, after)
          const useReason = partner ? 'partner_sale_return' : 'sale_return'
          logMovement(mid, batch.id, vendorId, q, after, useReason, 'return', 0)
        } else {
          unitCost = m.std_cost
          const newBid = receiveIntoStock(mid, q, m.std_cost, { reason: partner ? 'partner_sale_return' : 'sale_return', note: '销售退货回补（无在库批次）' })
          bid = newBid
        }
        restored.push({ materialId: mid, batchId: bid, unitCost })
        if (partner) ctx.partnerStockHook?.(vendorId, { kind: 'return', materialId: mid, batchId: bid, qty: q, unitCost })
        const rid = db.prepare(`INSERT INTO purchase_returns(kind,vendor_id,material_id,qty,amount,reason,status,create_tick,create_day)
                                VALUES('sale',?,?,?,? ,?, 'done',?,?)`)
          .run(vendorId, mid, q, Math.round(q * v.price), reason || '游客退货', ctx.tick(), ctx.day())
        const retId = Number(rid.lastInsertRowid)
        stampCode('purchase_returns', 'id', retId, 'RT')
      }
      const refund = Math.round(q * v.price)
      setSetting('cash', Math.round(ctx.cash() - refund))
      ctx.logFinance?.(ctx.day(), '商业', -refund, `「${v.name}」销售退货 ${q} 份退款`)
      logOrder(null, 'sale_return', `「${v.name}」销售退货 ${q} 份，退款 ¥${refund}`)
      return { ok: true, refund, restored }
    })
    return r0
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '退货失败' }
  }
}

// ---------------- 采购单 ----------------
const OPEN_PO = "status IN ('draft','submitted','approved','partial')"

export function createOrder({ supplier_id, items = [], source = 'manual', vendor_id = null, note = '' } = {}) {
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id=? AND status='active'").get(num(supplier_id))
  if (!supplier) return { ok: false, code: 'BAD_ARG', msg: '请选择合作中的供应商' }
  const lines = []
  for (const it of items) {
    const m = getMaterial(num(it.material_id))
    const qty = round1(num(it.qty))
    if (!m) return { ok: false, code: 'BAD_ARG', msg: '采购物资不存在' }
    if (qty <= 0) return { ok: false, code: 'BAD_ARG', msg: `「${m.name}」采购数量须大于 0` }
    const unitCost = Math.max(0, Math.round(num(it.unit_cost, m.std_cost))) || m.std_cost
    lines.push({ material_id: m.id, qty, unit_cost: unitCost })
  }
  if (!lines.length) return { ok: false, code: 'BAD_ARG', msg: '至少添加一行采购物资' }
  try {
    return tx(() => {
      const total = lines.reduce((s, l) => s + l.qty * l.unit_cost, 0)
      const r = db.prepare(`INSERT INTO purchase_orders(code,supplier_id,source,vendor_id,status,total_amount,note,creator_id,create_tick,create_day)
                            VALUES('',?, ?,?, 'draft',?,?,?, ?,?)`)
        .run(supplier.id, source, vendor_id ? num(vendor_id) : null, Math.round(total),
             String(note || ''), null, ctx.tick(), ctx.day())
      const id = Number(r.lastInsertRowid)
      stampCode('purchase_orders', 'id', id, 'PO')
      const ii = db.prepare('INSERT INTO purchase_order_items(order_id,material_id,qty_ordered,unit_cost) VALUES(?,?,?,?)')
      lines.forEach(l => ii.run(id, l.material_id, l.qty, l.unit_cost))
      logOrder(id, 'create', source === 'auto' ? '缺货自动生成补货草稿' : source === 'shop' ? '商铺协同提报采购需求' : '运营创建采购草稿')
      return { ok: true, id }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

export function submitOrder(id) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, code: 'NOT_FOUND', msg: '采购单不存在' }
  if (o.status !== 'draft') return { ok: false, code: 'BAD_STATUS', msg: '仅草稿状态可提交审批' }
  db.prepare("UPDATE purchase_orders SET status='submitted', submit_tick=? WHERE id=?").run(ctx.tick(), id)
  logOrder(id, 'submit', '采购单提交运营审批')
  return { ok: true }
}

export function approveOrder(id, { staffId = null } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, code: 'NOT_FOUND', msg: '采购单不存在' }
  if (o.status !== 'submitted') return { ok: false, code: 'BAD_STATUS', msg: '仅待审批采购单可批准' }
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(o.supplier_id)
  try {
    return tx(() => {
      const dueDay = ctx.day() + Math.max(0, num(supplier?.pay_term_days))
      db.prepare("UPDATE purchase_orders SET status='approved', approve_tick=?, pay_due_day=? WHERE id=?")
        .run(ctx.tick(), dueDay, id)
      logOrder(id, 'approve', `采购单已批准，供应商「${supplier?.name}」备货，账期 ${supplier?.pay_term_days || 0} 天，应付日第 ${dueDay} 天`, staffId)
      resolveFindingRef('order', id, '采购单已批准')
      return { ok: true }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

export function rejectOrder(id, { note = '', staffId = null } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, code: 'NOT_FOUND', msg: '采购单不存在' }
  if (!['submitted', 'draft'].includes(o.status)) return { ok: false, code: 'BAD_STATUS', msg: '当前状态不可驳回' }
  db.prepare("UPDATE purchase_orders SET status='cancelled', close_tick=? WHERE id=?").run(ctx.tick(), id)
  logOrder(id, 'reject', note || '审批驳回，采购单作废', staffId)
  return { ok: true }
}

// 收货：按行实收（允许分批/部分收货）；每物资生成一个入库批次，按物资保质期算到期日
// 货到即付（账期 0）的供应商：收货金额当场付款入账；现金不足则转为挂账应付并登记异常
export function receiveOrder(id, receives = [], { note = '', auto = false } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, code: 'NOT_FOUND', msg: '采购单不存在' }
  if (!['approved', 'partial'].includes(o.status)) return { ok: false, code: 'BAD_STATUS', msg: '仅已批准/部分到货的采购单可收货' }
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
  const plan = new Map()
  for (const r of receives || []) {
    const it = items.find(x => x.id === num(r.item_id))
    if (!it) return { ok: false, code: 'BAD_ARG', msg: '收货明细不属于该采购单' }
    const qty = round1(num(r.qty))
    if (qty <= 0) return { ok: false, code: 'BAD_ARG', msg: '收货数量须大于 0' }
    if (it.qty_received + (plan.get(it.id)?.qty || 0) + qty > it.qty_ordered + 0.0001) {
      return { ok: false, code: 'OVER_RECEIVE', msg: `物资#${it.material_id} 收货数超过采购数（订 ${it.qty_ordered}）` }
    }
    plan.set(it.id, { it, qty: (plan.get(it.id)?.qty || 0) + qty })
  }
  if (!plan.size) return { ok: false, code: 'BAD_ARG', msg: '请填写本次收货数量' }
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(o.supplier_id)
  try {
    return tx(() => {
      let amount = 0
      const batchIds = []
      for (const { it, qty } of plan.values()) {
        const m = getMaterial(it.material_id)
        db.prepare('UPDATE purchase_order_items SET qty_received=? WHERE id=?')
          .run(round1(it.qty_received + qty), it.id)
        const expireDay = m.shelf_days > 0 ? ctx.day() + m.shelf_days : 0
        const bid = receiveIntoStock(m.id, qty, it.unit_cost, {
          orderId: o.id, supplierId: o.supplier_id, expireDay,
          reason: 'in', note: auto ? '供应商自动到货' : '采购收货'
        })
        batchIds.push(bid)
        amount += qty * it.unit_cost
        // 价格异常：本批单价与目录标准成本偏差超 30% 挂价格差异异常（须在回写标准成本前比较）
        const oldCost = m.std_cost
        if (oldCost > 0 && Math.abs(it.unit_cost - oldCost) / Math.max(it.unit_cost, oldCost) > 0.30) {
          addFinding({
            type: 'price', severity: 'warn', materialId: m.id, supplierId: o.supplier_id, orderId: o.id,
            refType: 'batch', refId: bid, title: `「${m.name}」采购单价波动超 30%`,
            detail: `本批单价 ¥${it.unit_cost}/${m.unit}，目录标准成本 ¥${oldCost}/${m.unit}，请核对报价或合同价。`,
            amount: Math.round(Math.abs(it.unit_cost - oldCost) * qty)
          })
        }
        // 标准成本以最近一批实收价回写
        db.prepare('UPDATE materials SET std_cost=? WHERE id=?').run(it.unit_cost, m.id)
      }
      // 状态：全部行收齐 → received，否则 partial
      const afterItems = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
      const allReceived = afterItems.every(x => x.qty_received + x.qty_returned >= x.qty_ordered - 0.0001)
      db.prepare('UPDATE purchase_orders SET status=? WHERE id=?').run(allReceived ? 'received' : 'partial', id)
      logOrder(id, 'receive', `${auto ? '供应商自动到货' : '确认收货'} ${[...plan.values()].map(({ it, qty }) => `${getMaterial(it.material_id)?.name}×${qty}`).join('、')}，本批金额 ¥${Math.round(amount)}${note ? '；' + note : ''}`)

      // 货到即付：自动按本批金额付款；现金不足则挂应付并登记异常
      if (num(supplier?.pay_term_days) === 0 && amount > 0) {
        payOrderInternal(id, Math.round(amount), { auto: true, method: 'cash', silentInsuf: true })
      }
      maybeSettle(id)
      return { ok: true, amount: Math.round(amount), batchIds }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// 订单退货冲抵累计（采购退货）
function creditedOf(orderId) {
  return num(db.prepare("SELECT COALESCE(SUM(amount),0) c FROM purchase_returns WHERE kind='purchase' AND order_id=?").get(orderId).c)
}
function outstandingOf(o) {
  return Math.round(Math.max(0, num(o.total_amount) - num(o.paid_amount) - creditedOf(o.id)))
}
function maybeSettle(id) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
  const allDone = items.length && items.every(x => x.qty_received + x.qty_returned >= x.qty_ordered - 0.0001)
  if (allDone && outstandingOf(o) <= 0 && ['received', 'partial'].includes(o.status)) {
    db.prepare("UPDATE purchase_orders SET status='settled', close_tick=? WHERE id=?").run(ctx.tick(), id)
    logOrder(id, 'settle', '货票两清，采购单结算完成')
    resolveFindingRef('order', id, '采购单已完成结算')
  }
}

// 内部付款（同事务内调用）：现金扣减 + 付款单 + 财务流水
function payOrderInternal(orderId, amount, { auto = false, method = 'cash', note = '', silentInsuf = false } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(orderId)
  const out = outstandingOf(o)
  const pay = Math.min(Math.round(amount), out)
  if (pay <= 0) return { paid: 0 }
  if (ctx.cash() < pay) {
    if (silentInsuf) {
      const supplier = db.prepare('SELECT name FROM suppliers WHERE id=?').get(o.supplier_id)
      addFinding({
        type: 'payable', severity: 'warn', orderId: o.id, supplierId: o.supplier_id,
        refType: 'order', refId: o.id, title: `采购单 ${o.code} 货到即付但现金不足，已转挂账`,
        detail: `应付「${supplier?.name}」¥${pay}，当前园区现金 ¥${Math.round(ctx.cash())}，请尽快筹款后在采购单内付款。`, amount: pay
      })
      return { paid: 0, insuf: true }
    }
    throw new ProcError('NO_CASH', `现金不足：需付款 ¥${pay}，当前现金 ¥${Math.round(ctx.cash())}`)
  }
  setSetting('cash', Math.round(ctx.cash() - pay))
  db.prepare('UPDATE purchase_orders SET paid_amount=paid_amount+? WHERE id=?').run(pay, o.id)
  const r = db.prepare('INSERT INTO purchase_payments(order_id,amount,method,note,create_tick,create_day) VALUES(?,?,?,?,?,?)')
    .run(o.id, pay, method, note || (auto ? '货到即付（自动）' : '账期结算付款'), ctx.tick(), ctx.day())
  const pid = Number(r.lastInsertRowid)
  stampCode('purchase_payments', 'id', pid, 'PAY')
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id=?').get(o.supplier_id)
  ctx.logFinance?.(ctx.day(), FIN_LABEL, -pay, `采购付款 ${o.code} ·「${supplier?.name}」${auto ? '货到即付' : '账期结算'}`)
  logOrder(o.id, 'pay', `支付供应商货款 ¥${pay}（${auto ? '货到即付' : '账期结算'}）`)
  return { paid: pay }
}

export function payOrder(id, amount) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, code: 'NOT_FOUND', msg: '采购单不存在' }
  const out = outstandingOf(o)
  if (out <= 0) return { ok: false, code: 'NOTHING_DUE', msg: '该单无待付金额' }
  if (!['approved', 'partial', 'received'].includes(o.status)) return { ok: false, code: 'BAD_STATUS', msg: '当前状态不可付款' }
  const pay = Math.round(num(amount))
  if (pay <= 0) return { ok: false, code: 'BAD_ARG', msg: '付款金额须大于 0' }
  if (pay > out) return { ok: false, code: 'OVER_PAY', msg: `付款不能超过待付 ¥${out}` }
  try {
    return tx(() => {
      const r = payOrderInternal(id, pay)
      maybeSettle(id)
      resolveFindingRef('order', id, '逾期货款已支付')
      return { ok: true, paid: r.paid }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

// 采购退货：退供应商。优先退该单批次；已付款部分先冲未付应付，超额部分现金退回
export function purchaseReturn({ order_id, material_id, qty, reason = '', batch_id = null } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(num(order_id))
  if (!o) return { ok: false, code: 'NOT_FOUND', msg: '采购单不存在' }
  const m = getMaterial(num(material_id))
  if (!m) return { ok: false, code: 'BAD_ARG', msg: '物资不存在' }
  const q = round1(num(qty))
  if (q <= 0) return { ok: false, code: 'BAD_ARG', msg: '退货数量须大于 0' }
  const it = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=? AND material_id=?').get(o.id, m.id)
  if (!it || it.qty_received - it.qty_returned + 0.0001 < q) {
    return { ok: false, code: 'BAD_ARG', msg: '退货数量不能超过该单实收余量' }
  }
  if (availableQty(m.id) + 0.0001 < q) return { ok: false, code: 'STOCK_INSUFFICIENT', msg: '当前可退库存不足（可能已售出或报损）' }
  const amount = Math.round(q * it.unit_cost)
  try {
    return tx(() => {
      // 选批次：指定批次优先 → 该单物资批次（最新先退）→ 其他在库批次
      let batches = []
      if (batch_id) {
        const b = db.prepare("SELECT * FROM inbound_batches WHERE id=? AND status='in' AND qty_remain>0").get(num(batch_id))
        if (b) batches = [b]
      }
      if (!batches.length) {
        batches = db.prepare(`SELECT * FROM inbound_batches WHERE material_id=? AND order_id=? AND status='in'
                              AND COALESCE(qty_remain-quarantined_qty,0)>0 ORDER BY id DESC`).all(m.id, o.id)
      }
      let need = q
      const picked = []
      for (const b of batches) {
        const take = Math.min(b.qty_remain, need)
        picked.push({ b, take })
        need = round1(need - take)
      }
      for (const b of saleableBatches(m.id).reverse()) {
        if (need <= 0) break
        const take = Math.min(b.qty_remain, need)
        picked.push({ b, take })
        need = round1(need - take)
      }
      if (need > 0.0001) throw new ProcError('STOCK_INSUFFICIENT', '可退库存不足')
      for (const { b, take } of picked) {
        const left = round1(b.qty_remain - take)
        db.prepare('UPDATE inbound_batches SET qty_remain=?, status=? WHERE id=?')
          .run(left, left <= 0 ? 'exhausted' : 'in', b.id)
        const after = round1(onHand(m.id) - take)
        setOnHand(m.id, after)
        logMovement(m.id, b.id, null, -take, after, 'purchase_return', 'return', 0)
      }
      db.prepare('UPDATE purchase_order_items SET qty_returned=? WHERE id=?').run(round1(it.qty_returned + q), it.id)
      const rid = db.prepare(`INSERT INTO purchase_returns(kind,order_id,batch_id,material_id,qty,amount,reason,status,create_tick,create_day)
                              VALUES('purchase',?, ?,?,?,?,? ,'done',?,?)`)
        .run(o.id, picked[0]?.b.id || null, m.id, q, amount, reason || '质量问题退货', ctx.tick(), ctx.day())
      const retId = Number(rid.lastInsertRowid)
      stampCode('purchase_returns', 'id', retId, 'RT')
      // 货款：先冲未付应付（不动现金）；若已全额付款 → 供应商现金退回
      const outBefore = outstandingOf(o)  // 不含本次退货
      const cashBack = Math.max(0, amount - outBefore)
      if (cashBack > 0) {
        setSetting('cash', Math.round(ctx.cash() + cashBack))
        ctx.logFinance?.(ctx.day(), FIN_LABEL, cashBack, `采购退货 ${o.code} 供应商退回货款 ·「${m.name}」×${q}`)
      }
      const supplier = db.prepare('SELECT name FROM suppliers WHERE id=?').get(o.supplier_id)
      logOrder(o.id, 'return', `采购退货「${m.name}」×${q}，冲抵/退回货款 ¥${amount}（${cashBack > 0 ? `现金退回 ¥${cashBack}，余冲应付` : '全部冲减应付'}）${reason ? '；' + reason : ''}`)
      db.prepare("UPDATE purchase_orders SET status=(SELECT CASE WHEN status='received' THEN 'received' ELSE status END) WHERE id=?").run(o.id)
      maybeSettle(o.id)
      return { ok: true, amount, cashBack }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}

export function listOrders({ status = null, supplierId = null, limit = 200 } = {}) {
  let rows
  if (status) rows = db.prepare('SELECT * FROM purchase_orders WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
  else rows = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC LIMIT ?').all(limit)
  if (supplierId) rows = rows.filter(o => o.supplier_id === num(supplierId))
  return rows.map(enrichOrder)
}
function enrichOrder(o) {
  const supplier = db.prepare('SELECT id,name,category,pay_term_days,rating,status FROM suppliers WHERE id=?').get(o.supplier_id)
  const vendor = o.vendor_id ? db.prepare('SELECT id,name FROM vendors WHERE id=?').get(o.vendor_id) : null
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(o.id).map(it => ({
    ...it, material_name: getMaterial(it.material_id)?.name || `物资#${it.material_id}`,
    unit: getMaterial(it.material_id)?.unit || ''
  }))
  const credited = creditedOf(o.id)
  const payments = db.prepare('SELECT * FROM purchase_payments WHERE order_id=? ORDER BY id').all(o.id)
  const returns = db.prepare("SELECT * FROM purchase_returns WHERE kind='purchase' AND order_id=? ORDER BY id").all(o.id)
  const receivedQty = items.reduce((s, it) => s + it.qty_received, 0)
  const overdue = ['approved', 'partial', 'received'].includes(o.status) && (num(o.total_amount) - num(o.paid_amount) - credited) > 0 && o.pay_due_day > 0 && o.pay_due_day < ctx.day()
  return {
    ...o, supplier, vendor_name: vendor?.name || '', items, payments, returns,
    credited, outstanding: Math.max(0, Math.round(num(o.total_amount) - num(o.paid_amount) - credited)),
    received_qty: round1(receivedQty), overdue
  }
}
export function orderDetail(id) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return null
  const batches = db.prepare(`SELECT b.* FROM inbound_batches b WHERE b.order_id=? ORDER BY b.id`).all(id)
    .map(b => ({ ...b, material_name: getMaterial(b.material_id)?.name }))
  const logs = db.prepare('SELECT * FROM purchase_logs WHERE order_id=? ORDER BY id').all(id)
  return { order: enrichOrder(o), batches, logs }
}

// ---------------- 缺货自动补货草稿 ----------------
// 低于安全库存的自动补货物资，且当前无未结采购行 → 按首选供应商分组生成草稿（幂等）
export function autoReorderTick() {
  const created = []
  const groups = new Map()
  for (const m of db.prepare("SELECT * FROM materials WHERE status='active' AND auto_reorder=1 AND reorder_qty>0").all()) {
    if (availableQty(m.id) >= m.safety_stock) continue
    const openLine = db.prepare(`SELECT 1 FROM purchase_order_items poi
                                 JOIN purchase_orders po ON po.id=poi.order_id
                                 WHERE poi.material_id=? AND po.status IN ('draft','submitted','approved','partial')
                                 AND poi.qty_ordered - poi.qty_received - poi.qty_returned > 0 LIMIT 1`).get(m.id)
    if (openLine) continue
    const supId = m.preferred_supplier_id
    if (!supId || !db.prepare("SELECT 1 FROM suppliers WHERE id=? AND status='active'").get(supId)) continue
    if (!groups.has(supId)) groups.set(supId, [])
    groups.get(supId).push(m)
  }
  for (const [supId, mats] of groups) {
    const r = createOrder({
      supplier_id: supId, source: 'auto',
      items: mats.map(m => ({ material_id: m.id, qty: Math.max(m.reorder_qty, m.safety_stock - availableQty(m.id)), unit_cost: m.std_cost })),
      note: '库存低于安全阈值，系统自动生成补货草稿，请运营确认后提交审批'
    })
    if (r.ok) created.push(r.id)
  }
  return created
}

// 已批准采购单模拟供应商次日达：批准满 3 个 tick 自动整批到货
export function autoDeliveryTick() {
  const rows = db.prepare("SELECT * FROM purchase_orders WHERE status IN ('approved','partial') AND approve_tick>0 AND approve_tick+3<=?").all(ctx.tick())
  const ids = []
  for (const o of rows) {
    const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(o.id)
    const receives = items
      .filter(it => it.qty_received + it.qty_returned < it.qty_ordered - 0.0001)
      .map(it => ({ item_id: it.id, qty: round1(it.qty_ordered - it.qty_received - it.qty_returned) }))
    if (!receives.length) continue
    const r = receiveOrder(o.id, receives, { auto: true })
    if (r.ok) ids.push(o.id)
  }
  return ids
}

// ---------------- 临期/过期处理 ----------------
// 过期批次整批报损：库存核销 + 物料成本损失入财务流水
// 召回隔离中的批次不在此处报损（走召回退回/销毁流程，避免在途召回账实被擅改）
export function processExpiry() {
  const rows = db.prepare(`SELECT * FROM inbound_batches WHERE status='in' AND qty_remain>0 AND expire_day>0 AND expire_day<=?
                           AND COALESCE(quarantined_qty,0)=0`).all(ctx.day())
  let cost = 0
  for (const b of rows) {
    tx(() => {
      const qty = b.qty_remain
      const c = Math.round(qty * b.unit_cost)
      db.prepare("UPDATE inbound_batches SET status='closed', qty_remain=0 WHERE id=?").run(b.id)
      const after = round1(onHand(b.material_id) - qty)
      setOnHand(b.material_id, after)
      logMovement(b.material_id, b.id, null, -qty, after, 'spoil', 'batch', b.id)
      setSetting('cash', Math.round(ctx.cash() - c))
      ctx.logFinance?.(ctx.day(), FIN_LABEL, -c, `库存过期报损 ·「${getMaterial(b.material_id)?.name || '物资'}」${qty}（批次 ${'RK' + String(b.id).padStart(4, '0')}）`)
      addFinding({
        type: 'expiry', severity: 'critical', materialId: b.material_id, refType: 'batch', refId: b.id,
        title: `「${getMaterial(b.material_id)?.name}」批次已过期报损`,
        detail: `批次 RK${String(b.id).padStart(4, '0')} 于第 ${b.expire_day} 天到期，剩余 ${qty} ${getMaterial(b.material_id)?.unit || ''}已报损，损失成本 ¥${c}。`,
        amount: c
      })
      cost += c
    })
  }
  return { count: rows.length, cost }
}

// ---------------- 盘点 ----------------
export function listStocktakes({ status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM stocktakes WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM stocktakes ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(st => ({
    ...st,
    vendor_name: st.vendor_id ? db.prepare('SELECT name FROM vendors WHERE id=?').get(st.vendor_id)?.name || '' : '',
    items: db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id=?').all(st.id)
      .map(it => ({ ...it, material_name: getMaterial(it.material_id)?.name || '', unit: getMaterial(it.material_id)?.unit || '' }))
  }))
}
export function stocktakeDetail(id) {
  return listStocktakes().find(x => x.id === id) || null
}
export function createStocktake({ scope = 'all', vendor_id = null, note = '' } = {}) {
  let mids
  if (scope === 'vendor' && vendor_id) {
    if (!db.prepare('SELECT 1 FROM vendors WHERE id=?').get(num(vendor_id))) return { ok: false, code: 'NOT_FOUND', msg: '商铺不存在' }
    mids = vendorMaterialIds(num(vendor_id))
  } else {
    mids = db.prepare('SELECT id FROM materials ORDER BY id').all().map(x => x.id)
  }
  if (!mids.length) return { ok: false, code: 'BAD_ARG', msg: '范围内没有可盘点的物资（请先为商铺挂供货物资）' }
  try {
    return tx(() => {
      const r = db.prepare(`INSERT INTO stocktakes(scope,vendor_id,status,note,creator_id,create_day)
                            VALUES(?,?,'open',?,NULL,?)`).run(scope, scope === 'vendor' ? num(vendor_id) : null, String(note || ''), ctx.day())
      const id = Number(r.lastInsertRowid)
      stampCode('stocktakes', 'id', id, 'PD')
      const ii = db.prepare('INSERT INTO stocktake_items(stocktake_id,material_id,qty_book,qty_actual,unit_cost) VALUES(?,?,?,?,?)')
      mids.forEach(mid => ii.run(id, mid, availableQty(mid), availableQty(mid), getMaterial(mid)?.std_cost || 0))
      return { ok: true, id }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}
// 录入实盘并提交（actuals: {item_id, qty_actual}）
export function submitStocktake(id, actuals = []) {
  const st = db.prepare('SELECT * FROM stocktakes WHERE id=?').get(id)
  if (!st) return { ok: false, code: 'NOT_FOUND', msg: '盘点单不存在' }
  if (st.status !== 'open') return { ok: false, code: 'BAD_STATUS', msg: '盘点已提交，不可重复录入' }
  try {
    return tx(() => {
      const items = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id=?').all(id)
      let diffCount = 0, diffAmount = 0
      const amap = new Map(actuals.map(a => [num(a.item_id), Math.max(0, round1(num(a.qty_actual)))]))
      for (const it of items) {
        const actual = amap.has(it.id) ? amap.get(it.id) : it.qty_actual
        db.prepare('UPDATE stocktake_items SET qty_actual=? WHERE id=?').run(actual, it.id)
        const d = round1(actual - it.qty_book)
        if (Math.abs(d) > 0.0001) {
          diffCount++
          diffAmount += Math.round(d * it.unit_cost)
        }
      }
      db.prepare("UPDATE stocktakes SET status='submitted', diff_count=?, diff_amount=? WHERE id=?").run(diffCount, diffAmount, id)
      if (diffCount > 0) {
        addFinding({
          type: 'stock_diff', severity: Math.abs(diffAmount) >= 1000 ? 'critical' : 'warn',
          refType: 'stocktake', refId: id, title: `盘点单 ${'PD' + String(id).padStart(4, '0')} 出现账实差异`,
          detail: `${diffCount} 项物资账实不符，差异净值 ¥${diffAmount}（正为盘盈、负为盘亏），请审批调账。`, amount: diffAmount
        })
      }
      return { ok: true, diffCount, diffAmount }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}
// 审批调账：盘盈按标准成本入盈收批；盘亏 FEFO 核减并按成本记物料损耗
export function approveStocktake(id, { note = '' } = {}) {
  const st = db.prepare('SELECT * FROM stocktakes WHERE id=?').get(id)
  if (!st) return { ok: false, code: 'NOT_FOUND', msg: '盘点单不存在' }
  if (st.status !== 'submitted') return { ok: false, code: 'BAD_STATUS', msg: '仅待审批盘点单可调账' }
  try {
    return tx(() => {
      const items = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id=? AND adjusted=0').all(id)
      let loss = 0, gain = 0
      for (const it of items) {
        const d = round1(it.qty_actual - it.qty_book)
        if (Math.abs(d) <= 0.0001) { db.prepare('UPDATE stocktake_items SET adjusted=1 WHERE id=?').run(it.id); continue }
        const m = getMaterial(it.material_id)
        if (d > 0) {
          receiveIntoStock(m.id, d, it.unit_cost || m.std_cost, { reason: 'adjust_gain', note: `盘点单 ${'PD' + String(id).padStart(4, '0')} 盘盈调账` })
          gain += Math.round(d * it.unit_cost)
        } else {
          deductStock(m.id, -d, { reason: 'adjust_loss', refType: 'stocktake', refId: id })
          loss += Math.round(-d * it.unit_cost)
        }
        db.prepare('UPDATE stocktake_items SET adjusted=1 WHERE id=?').run(it.id)
      }
      if (loss > 0) {
        setSetting('cash', Math.round(ctx.cash() - loss))
        ctx.logFinance?.(ctx.day(), FIN_LABEL, -loss, `盘点盘亏核销 ${'PD' + String(id).padStart(4, '0')}`)
      }
      if (gain > 0) ctx.logFinance?.(ctx.day(), FIN_LABEL, gain, `盘点盘盈入账 ${'PD' + String(id).padStart(4, '0')}`)
      db.prepare("UPDATE stocktakes SET status='adjusted', adjust_day=?, note=? WHERE id=?")
        .run(ctx.day(), st.note + (note ? `；审批意见：${note}` : ''), id)
      resolveFindingRef('stocktake', id, note || '盘点差异已审批调账')
      return { ok: true, loss, gain }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message }
  }
}
export function cancelStocktake(id) {
  const st = db.prepare('SELECT * FROM stocktakes WHERE id=?').get(id)
  if (!st) return { ok: false, code: 'NOT_FOUND', msg: '盘点单不存在' }
  if (st.status === 'adjusted') return { ok: false, code: 'BAD_STATUS', msg: '已调账单不可撤销' }
  db.prepare("UPDATE stocktakes SET status='cancelled' WHERE id=?").run(id)
  resolveFindingRef('stocktake', id, '盘点单撤销')
  return { ok: true }
}

// ---------------- 异常对账 ----------------
export function listInventoryFindings({ status = null, type = null, limit = 200 } = {}) {
  let sql = 'SELECT * FROM inventory_findings WHERE 1=1'
  const args = []
  if (status) { sql += ' AND status=?'; args.push(status) }
  if (type) { sql += ' AND type=?'; args.push(type) }
  sql += ' ORDER BY (severity=\'critical\') DESC, id DESC LIMIT ?'
  args.push(limit)
  return db.prepare(sql).all(...args).map(f => ({
    ...f,
    material_name: f.material_id ? getMaterial(f.material_id)?.name || '' : '',
    supplier_name: f.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id=?').get(f.supplier_id)?.name || '' : '',
    order_code: f.order_id ? db.prepare('SELECT code FROM purchase_orders WHERE id=?').get(f.order_id)?.code || '' : ''
  }))
}
export function resolveInventoryFinding(id, note = '') {
  const f = db.prepare('SELECT * FROM inventory_findings WHERE id=?').get(id)
  if (!f) return { ok: false, code: 'NOT_FOUND', msg: '异常记录不存在' }
  db.prepare("UPDATE inventory_findings SET status='resolved', resolve_note=?, resolve_day=? WHERE id=?")
    .run(String(note || '人工核对处理'), ctx.day(), id)
  return { ok: true }
}
export function ignoreInventoryFinding(id, note = '') {
  const f = db.prepare('SELECT * FROM inventory_findings WHERE id=?').get(id)
  if (!f) return { ok: false, code: 'NOT_FOUND', msg: '异常记录不存在' }
  db.prepare("UPDATE inventory_findings SET status='ignored', resolve_note=?, resolve_day=? WHERE id=?")
    .run(String(note || '误报忽略'), ctx.day(), id)
  return { ok: true }
}

// 每小时巡检：缺货 / 临期 / 逾期应付（去重靠 addFinding 同对象不重复）
export function detectFindings() {
  // 缺货 / 低于安全库存
  for (const m of db.prepare("SELECT * FROM materials WHERE status='active' AND safety_stock>0").all()) {
    const qty = availableQty(m.id)
    if (qty < m.safety_stock) {
      addFinding({
        type: 'shortage', severity: qty <= 0 ? 'critical' : 'warn', materialId: m.id,
        title: qty <= 0 ? `「${m.name}」已断货` : `「${m.name}」低于安全库存`,
        detail: `当前可用 ${qty} ${m.unit}，安全库存 ${m.safety_stock} ${m.unit}；${m.auto_reorder ? '已开自动补货，系统会生成补货草稿' : '未开自动补货，请手动下单'}。`
      })
    }
  }
  // 临期（未过期但 2 天内到期）
  for (const b of db.prepare(`SELECT * FROM inbound_batches WHERE status='in' AND qty_remain>0 AND expire_day>0
                              AND expire_day>? AND expire_day<=?`).all(ctx.day(), ctx.day() + EXPIRY_WARN_DAYS)) {
    addFinding({
      type: 'expiry', severity: 'warn', materialId: b.material_id, refType: 'batch', refId: b.id,
      title: `「${getMaterial(b.material_id)?.name}」批次临期`,
      detail: `批次 RK${String(b.id).padStart(4, '0')} 将于第 ${b.expire_day} 天到期（剩 ${b.expire_day - ctx.day()} 天），在库 ${b.qty_remain} ${getMaterial(b.material_id)?.unit || ''}，请优先促销或退供应商。`
    })
  }
  // 逾期应付
  for (const o of db.prepare("SELECT * FROM purchase_orders WHERE pay_due_day>0 AND pay_due_day<? AND status IN ('approved','partial','received')").all(ctx.day())) {
    const out = outstandingOf(o)
    if (out <= 0) continue
    const overdueDays = ctx.day() - o.pay_due_day
    addFinding({
      type: 'payable', severity: overdueDays >= 3 ? 'critical' : 'warn', orderId: o.id, supplierId: o.supplier_id,
      refType: 'order', refId: o.id, title: `采购单 ${o.code} 货款已逾期 ${overdueDays} 天未付`,
      detail: `应付供应商 ¥${out}，应付日为第 ${o.pay_due_day} 天；长期拖欠会影响供货评级与后续采购。`, amount: out
    })
  }
}

// 每游戏小时推进：自动补货草稿 → 自动到货 → 临期/过期 → 异常巡检
export function processProcurementTick() {
  try {
    const drafts = autoReorderTick()
    const delivered = autoDeliveryTick()
    const expiry = processExpiry()
    detectFindings()
    return { drafts, delivered, expiry }
  } catch (e) {
    console.error('[procurement] 库存模块小时推进失败（不影响主循环）:', e)
    return { error: String(e?.message || e) }
  }
}

// ---------------- 查询 / 统计 ----------------
export function listBatches({ materialId = null, expiring = false, limit = 200 } = {}) {
  let rows
  if (materialId) rows = db.prepare('SELECT * FROM inbound_batches WHERE material_id=? ORDER BY id DESC LIMIT ?').all(materialId, limit)
  else if (expiring) {
    rows = db.prepare(`SELECT * FROM inbound_batches WHERE status='in' AND qty_remain>0 AND expire_day>0 AND expire_day<=?
                       ORDER BY expire_day LIMIT ?`).all(ctx.day() + EXPIRY_WARN_DAYS, limit)
  } else rows = db.prepare('SELECT * FROM inbound_batches ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(b => ({
    ...b, material_name: getMaterial(b.material_id)?.name || '',
    unit: getMaterial(b.material_id)?.unit || '',
    supplier_name: b.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id=?').get(b.supplier_id)?.name || '' : '',
    expired: b.expire_day > 0 && b.expire_day <= ctx.day()
  }))
}

export function listReturns({ kind = null, limit = 100 } = {}) {
  const rows = kind
    ? db.prepare('SELECT * FROM purchase_returns WHERE kind=? ORDER BY id DESC LIMIT ?').all(kind, limit)
    : db.prepare('SELECT * FROM purchase_returns ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(r => ({
    ...r,
    material_name: getMaterial(r.material_id)?.name || '',
    vendor_name: r.vendor_id ? db.prepare('SELECT name FROM vendors WHERE id=?').get(r.vendor_id)?.name || '' : '',
    order_code: r.order_id ? db.prepare('SELECT code FROM purchase_orders WHERE id=?').get(r.order_id)?.code || '' : ''
  }))
}

// 联营结算用：按库存流水汇总联营商户在区间内消耗的 FEFO 批次成本
// 销售扣减（partner_sale）- 退货回补（partner_sale_return），净额即商户应承担的物料成本
export function partnerCogs(vendorId, dayFrom, dayTo) {
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN reason='partner_sale' THEN ROUND((-change)*b.unit_cost) ELSE 0 END),0) sold_cost,
      COALESCE(SUM(CASE WHEN reason='partner_sale_return' THEN ROUND(change*b.unit_cost) ELSE 0 END),0) return_cost
      FROM stock_movements sm LEFT JOIN inbound_batches b ON b.id=sm.batch_id
      WHERE sm.vendor_id=? AND sm.reason IN ('partner_sale','partner_sale_return')
        AND sm.day>=? AND sm.day<=?`).get(vendorId, dayFrom, dayTo)
  const cogs = Math.max(0, Math.round(num(row.sold_cost) - num(row.return_cost)))
  return { cogs, soldCost: Math.round(num(row.sold_cost)), returnCost: Math.round(num(row.return_cost)) }
}

// ---------------- 供应商批次召回：批次隔离 / 解除 / 退供 / 销毁（供召回模块调用） ----------------
// 隔离：把批次可售余量转入隔离量（在库总量不变，立刻停售）；记 recall_id。需在调用方事务内。
export function quarantineBatch(batchId, qty, recallId) {
  const b = db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(num(batchId))
  if (!b) throw new ProcError('BATCH_NOT_FOUND', `批次 #${batchId} 不存在`)
  if (num(b.recall_id) && num(b.recall_id) !== num(recallId)) {
    throw new ProcError('BATCH_QUARANTINED', `批次 ${'RK' + String(b.id).padStart(4, '0')} 已被召回单 ${'ZH' + String(b.recall_id).padStart(4, '0')} 隔离`)
  }
  const q = round1(Math.min(num(qty), batchSaleAvail(b)))
  if (q <= 0) throw new ProcError('NO_AVAILABLE_QTY', `批次 ${'RK' + String(b.id).padStart(4, '0')} 无可用可隔离量`)
  db.prepare('UPDATE inbound_batches SET quarantined_qty=COALESCE(quarantined_qty,0)+?, recall_id=? WHERE id=?')
    .run(q, num(recallId), b.id)
  return { batchId: b.id, qty: q, materialId: b.material_id, unitCost: b.unit_cost, orderId: b.order_id, supplierId: b.supplier_id }
}

// 解除隔离（撤销/误报）：隔离量回到可售；召回单结清时清空 recall_id。需在调用方事务内。
export function releaseBatchQuarantine(batchId, qty, recallId, { clearRecall = false } = {}) {
  const b = db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(num(batchId))
  if (!b) return { batchId, qty: 0 }
  const q = round1(Math.min(num(qty), num(b.quarantined_qty)))
  if (q <= 0) return { batchId, qty: 0 }
  const leftQ = round1(num(b.quarantined_qty) - q)
  db.prepare('UPDATE inbound_batches SET quarantined_qty=?, recall_id=? WHERE id=?')
    .run(leftQ, clearRecall && leftQ <= 0 ? null : (num(b.recall_id) || num(recallId)), b.id)
  return { batchId: b.id, qty: q, materialId: b.material_id }
}

// 取某召回单当前仍隔离的批次（join 召回物资，隔离量 > 0）
export function recallQuarantinedBatches(recallId) {
  return db.prepare(`SELECT b.*, COALESCE(b.quarantined_qty,0) q_qty
                     FROM inbound_batches b
                     JOIN recall_orders r ON r.id=? AND b.material_id=r.material_id
                     WHERE b.recall_id=? AND COALESCE(b.quarantined_qty,0)>0
                     ORDER BY b.id`).all(num(recallId), num(recallId))
}

// 退回供应商：从隔离量核减批次库存（非销售出库），按批次成本结算货款。需在调用方事务内。
// 有采购单：先冲该单未付应付，超出已付部分退现金（沿用采购退货口径），并写采购退货单；
// 期初批次（无采购单）：按批次成本由供应商现金赔付，直接加现金。
// 返回 { qty, amount, cashBack, creditApplied }
export function returnQuarantinedToSupplier(recallId, qty) {
  const r = db.prepare('SELECT * FROM recall_orders WHERE id=?').get(num(recallId))
  if (!r) throw new ProcError('RECALL_NOT_FOUND', `召回单 #${recallId} 不存在`)
  let need = round1(num(qty))
  if (need <= 0) throw new ProcError('BAD_ARG', '退货数量须大于 0')
  const batches = recallQuarantinedBatches(recallId)
  const totalQ = round1(batches.reduce((s, b) => s + b.q_qty, 0))
  if (totalQ + 0.0001 < need) throw new ProcError('QTY_EXCEED', `隔离在库仅 ${totalQ}，不能退回 ${need}`)

  let amount = 0, cashBack = 0, creditApplied = 0
  for (const b of batches) {
    if (need <= 0) break
    const take = round1(Math.min(b.q_qty, need))
    const cost = Math.round(take * b.unit_cost)
    amount += cost
    // 批次：隔离量与剩余量同步核减（隔离量是剩余量的一部分），在库总量下降
    const leftQ = round1(b.q_qty - take)
    const leftRemain = round1(b.qty_remain - take)
    db.prepare('UPDATE inbound_batches SET quarantined_qty=?, qty_remain=?, status=?, recall_id=? WHERE id=?')
      .run(leftQ, leftRemain, leftRemain <= 0 ? 'closed' : 'in', leftQ > 0 ? r.id : null, b.id)
    const after = round1(num(db.prepare('SELECT qty_on_hand FROM inventory WHERE material_id=?').get(b.material_id)?.qty_on_hand) - take)
    setOnHand(b.material_id, after)
    logMovement(b.material_id, b.id, null, -take, after, 'purchase_return', 'recall', r.id)

    if (b.order_id) {
      // 先冲该采购单未付应付：货款冲减由采购退货单行体现（creditedOf 汇总，不改动 paid_amount）；
      // 超出未付应付的部分（已付款）由供应商现金退回
      const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(b.order_id)
      const outstanding = Math.max(0, Math.round(num(o.total_amount) - num(o.paid_amount) - creditedOf(o.id)))
      const credit = Math.min(cost, outstanding)
      if (credit > 0) creditApplied += credit
      const back = cost - credit
      if (back > 0) {
        setSetting('cash', Math.round(ctx.cash() + back))
        ctx.logFinance?.(ctx.day(), FIN_LABEL, back, `召回退货 ${r.code} 供应商退/赔货款 ·「${getMaterial(b.material_id)?.name || '物资'}」×${take}`)
        cashBack += back
      }
      db.prepare('UPDATE purchase_order_items SET qty_returned=qty_returned+? WHERE order_id=? AND material_id=?')
        .run(take, b.order_id, b.material_id)
      const rid0 = db.prepare(`INSERT INTO purchase_returns(kind,order_id,batch_id,material_id,qty,amount,reason,status,create_tick,create_day)
                               VALUES('purchase',?,?,?,?,?,?,'done',?,?)`)
        .run(b.order_id, b.id, b.material_id, take, cost, `供应商批次召回 ${r.code} 退回`, ctx.tick(), ctx.day())
      const retId = Number(rid0.lastInsertRowid)
      stampCode('purchase_returns', 'id', retId, 'RT')
      maybeSettle(b.order_id)
    } else {
      // 期初批次：供应商直接按成本现金赔付
      setSetting('cash', Math.round(ctx.cash() + cost))
      ctx.logFinance?.(ctx.day(), FIN_LABEL, cost, `召回退货 ${r.code} 期初批次供应商赔付 ·「${getMaterial(b.material_id)?.name || '物资'}」×${take}`)
      cashBack += cost
    }
    need = round1(need - take)
  }
  return { qty: round1(num(qty) - need), amount, cashBack, creditApplied }
}

// 现场销毁隔离批次：不退货，按批次成本核销物料损失。需在调用方事务内。
export function destroyQuarantinedBatches(recallId, qty) {
  const r = db.prepare('SELECT * FROM recall_orders WHERE id=?').get(num(recallId))
  if (!r) throw new ProcError('RECALL_NOT_FOUND', `召回单 #${recallId} 不存在`)
  let need = round1(num(qty))
  if (need <= 0) throw new ProcError('BAD_ARG', '销毁数量须大于 0')
  const batches = recallQuarantinedBatches(recallId)
  const totalQ = round1(batches.reduce((s, b) => s + b.q_qty, 0))
  if (totalQ + 0.0001 < need) throw new ProcError('QTY_EXCEED', `隔离在库仅 ${totalQ}，不能销毁 ${need}`)
  let cost = 0
  for (const b of batches) {
    if (need <= 0) break
    const take = round1(Math.min(b.q_qty, need))
    const c = Math.round(take * b.unit_cost)
    cost += c
    const leftQ = round1(b.q_qty - take)
    const leftRemain = round1(b.qty_remain - take)
    db.prepare('UPDATE inbound_batches SET quarantined_qty=?, qty_remain=?, status=?, recall_id=? WHERE id=?')
      .run(leftQ, leftRemain, leftRemain <= 0 ? 'closed' : 'in', leftQ > 0 ? r.id : null, b.id)
    const after = round1(num(db.prepare('SELECT qty_on_hand FROM inventory WHERE material_id=?').get(b.material_id)?.qty_on_hand) - take)
    setOnHand(b.material_id, after)
    logMovement(b.material_id, b.id, null, -take, after, 'spoil', 'recall', r.id)
    need = round1(need - take)
  }
  if (cost > 0) {
    setSetting('cash', Math.round(ctx.cash() - cost))
    ctx.logFinance?.(ctx.day(), FIN_LABEL, -cost, `召回 ${r.code} 问题批次现场销毁核销`)
  }
  return { qty: round1(num(qty) - need), cost }
}

// 某商铺对某物资的净售出量（销售 - 销售退货/召回退款），用于召回时确定需联系游客退货的规模
export function vendorMaterialNetSold(vendorId, materialId) {
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN reason IN ('sale','partner_sale') THEN -change ELSE 0 END),0) sold,
      COALESCE(SUM(CASE WHEN reason IN ('sale_return','partner_sale_return','recall_refund') THEN change ELSE 0 END),0) returned
      FROM stock_movements WHERE vendor_id=? AND material_id=?`).get(num(vendorId), num(materialId))
  return round1(Math.max(0, num(row.sold) - num(row.returned)))
}

// 可发起召回的批次：在库、有未隔离剩余（含已过期，便于召回历史问题批次）
export function recallCandidates(materialId) {
  return db.prepare(`SELECT *, COALESCE(qty_remain-quarantined_qty,0) avail
                     FROM inbound_batches
                     WHERE material_id=? AND status='in' AND COALESCE(qty_remain-quarantined_qty,0)>0
                     ORDER BY id DESC`).all(num(materialId))
}

export function procurementStats() {
  const one = sql => db.prepare(sql).get()
  const day = ctx.day()
  const materials = listMaterials()
  const low = materials.filter(m => m.stock_status === 'low').length
  const out = materials.filter(m => m.stock_status === 'out').length
  const stockValue = Math.round(materials.reduce((s, m) => s + m.qty_on_hand * m.std_cost, 0))
  const openAp = one(`SELECT COALESCE(SUM(total_amount),0) t, COALESCE(SUM(paid_amount),0) p FROM purchase_orders
                      WHERE status IN ('approved','partial','received')`)
  const credited = one(`SELECT COALESCE(SUM(r.amount),0) c FROM purchase_returns r
                        JOIN purchase_orders o ON o.id=r.order_id WHERE r.kind='purchase'`).c
  const lostToday = db.prepare('SELECT COALESCE(SUM(qty_lost),0) q, COALESCE(SUM(lost_rev),0) r FROM stock_lost_sales WHERE day=?').get(day)
  const spoilToday = db.prepare(`SELECT COALESCE(SUM(change*-1),0) q FROM stock_movements WHERE reason IN ('spoil','adjust_loss') AND day=?`).get(day).q
  const finToday = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END),0) spend
      FROM finance WHERE day=? AND label=?`).get(day, FIN_LABEL)
  const overdueRows = db.prepare(`SELECT total_amount, paid_amount FROM purchase_orders
                                  WHERE status IN ('approved','partial','received') AND pay_due_day>0 AND pay_due_day<?`).all(day)
  const overduePayable = Math.round(overdueRows.reduce((s, o) => s + Math.max(0, o.total_amount - o.paid_amount), 0))
  return {
    draft: one("SELECT COUNT(*) n FROM purchase_orders WHERE status='draft'").n,
    submitted: one("SELECT COUNT(*) n FROM purchase_orders WHERE status='submitted'").n,
    receiving: one("SELECT COUNT(*) n FROM purchase_orders WHERE status IN ('approved','partial')").n,
    openFindings: one("SELECT COUNT(*) n FROM inventory_findings WHERE status='open'").n,
    criticalFindings: one("SELECT COUNT(*) n FROM inventory_findings WHERE status='open' AND severity='critical'").n,
    findingsByType: {
      shortage: one("SELECT COUNT(*) n FROM inventory_findings WHERE status='open' AND type='shortage'").n,
      expiry: one("SELECT COUNT(*) n FROM inventory_findings WHERE status='open' AND type='expiry'").n,
      price: one("SELECT COUNT(*) n FROM inventory_findings WHERE status='open' AND type='price'").n,
      stock_diff: one("SELECT COUNT(*) n FROM inventory_findings WHERE status='open' AND type='stock_diff'").n,
      payable: one("SELECT COUNT(*) n FROM inventory_findings WHERE status='open' AND type='payable'").n
    },
    lowStock: low, outStock: out,
    expiringBatches: db.prepare(`SELECT COUNT(*) n FROM inbound_batches WHERE status='in' AND qty_remain>0 AND expire_day>0 AND expire_day<=?`).get(day + EXPIRY_WARN_DAYS).n,
    stockValue,
    payable: Math.max(0, Math.round(openAp.t - openAp.p - credited)),
    overduePayable,
    lostToday: { qty: round1(lostToday.q), rev: lostToday.r },
    spoilTodayQty: round1(spoilToday),
    costToday: finToday.spend
  }
}
