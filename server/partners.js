import db, { getSetting, setSetting, tx } from './db.js'
import { registerOutageHandler, enqueueTask, OUTAGE_KINDS } from './outage.js'

// 园区联营商户结算模块：
//   商户申请入驻（新商户/存量商铺转联营）→ 审核签约（扣点率/账期/保证金/会员优惠分摊）
//   → 按销售流水实时分账（散客 tick / 会员消费；消费券营销成本园方承担）
//   → 库存联动（FEFO 批次成本在结算账单中扣收）
//   → 会员优惠（卡折扣按合同在商户/园方间分摊）
//   → 投诉处理（结案现金补偿按严重度罚没商户待结算款）
//   → 退货退款（红冲分账流水、回补库存批次成本在结算时冲回）
//   → 财务结算（周期账单汇总，支付清偿对商户负债；现金不足自动挂账）
// 资金口径：联营商铺销售现金归园方代收（账上记商业收入 + 商户应付款），
//          账单支付时借「商户结算」出账，应付归零；与自营商铺（直接经营利润）相区分。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const pct = v => Math.max(0, Math.min(1, num(v)))

// 由 index.js 注入：时钟/现金直接读 settings；财务流水、库存扣减/退货、投诉升级在此接线
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  // (vendorId, qty, { partner:true }) => { managed, sold, lost } | 抛 ProcError
  applyVendorSales: null,
  // (vendorId, qty, { partner:true }) => { ok, managed, sold } | 抛 ProcError（与会员支付同事务）
  reserveVendorStock: null,
  // (vendorId, qty, { partner:true }) => { ok, refund, restored }
  customerReturn: null,
  // (vendorId, qty, dayFrom, dayTo) => { cogs }
  partnerCogs: null,
  // (vendorId, type) 新商户建铺后按类型自动挂供货物资
  autoLinkVendor: null,
  // 停运补偿退款扣现金（与红冲同一事务）：默认直接改 settings.cash，index.js 可注入统一口径
  deductCash: null
}
export function initPartnerContext(deps) { Object.assign(ctx, deps) }

// 统一停运补偿队列处理器：联营商铺退款（园方当场代付游客 + 负向红冲行结转账单）。
// 红冲行按任务 id 幂等，重试不二次退款；现金、分账流水、账单在同一事务同步。
function executePartnerRefundTask(task) {
  const p = task.payload || {}
  const vendorId = num(p.vendorId ?? task.ref_id)
  const v = getVendor(vendorId)
  if (!v) return { ok: false, obsolete: true, msg: `商铺 ${vendorId} 不存在，补偿作废` }
  const qty = Math.max(1, Math.round(num(p.qty, 1)))
  const refund = Math.max(0, Math.round(num(p.refund)))
  if (refund <= 0) return { ok: false, obsolete: true, msg: '退款额为 0，补偿作废' }
  // 已无有效联营合同（如已终止清算）：无法红冲，置失败等待人工，不擅自按自营口径退款
  if (!activeContract(vendorId)) {
    return { ok: false, code: 'NO_CONTRACT', msg: `商铺「${v.name}」无有效联营合同，无法红冲，请人工处理` }
  }
  const pr = outagePartnerReturn(vendorId, qty, {
    refund, complaintId: num(p.complaintId) || null, reason: p.note || '设施停运/经营异常联营退款',
    outageTaskId: task.id, source: p.source || 'organic'
  })
  if (pr.replay) return { ok: true, summary: `商铺「${v.name}」退款已红冲（重放，不重复退款）` }
  if (!pr.ok) return { ok: false, code: pr.code, msg: pr.msg }
  // 现金扣减（园方代付游客，红冲在结算时向商户收回）——与红冲同事务，回滚则一起回滚
  const deduct = ctx.deductCash || (amt => setSetting('cash', Math.round(ctx.cash() - amt)))
  deduct(refund)
  ctx.logFinance?.(ctx.day(), '商业', -refund,
    `「${v.name}」联营游客退款 ${qty} 份（${p.note || '停运补偿'} · 红冲任务 #${task.id}）`)
  return { ok: true, summary: `商铺「${v.name}」联营退款 ¥${refund} 已红冲` }
}
registerOutageHandler(OUTAGE_KINDS.PARTNER, executePartnerRefundTask)

// 对外登记一笔可恢复的联营退款补偿任务（停运/召回等异常路径调用；在调用方事务内入队）。
// 返回 { id, created }。
export function enqueuePartnerRefundTask({ vendorId, qty, refund, complaintId = null, note = '', source = 'outage', idemKey = '' } = {}) {
  return enqueueTask(OUTAGE_KINDS.PARTNER, {
    refType: 'vendor', refId: num(vendorId),
    idemKey: idemKey || `partner-refund-${num(vendorId)}-${ctx.tick()}-${Math.round(num(refund))}-${Math.round(num(qty))}`,
    source,
    payload: { vendorId: num(vendorId), qty: Math.round(num(qty)), refund: Math.round(num(refund)), complaintId: num(complaintId) || null, note, source: 'organic' },
    note: note || `联营商铺 #${vendorId} 退款 ¥${refund}`
  })
}

export class PartnerError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra) }
}

// 投诉罚没：按投诉严重度对结案现金补偿的倍数（最低保底额），责任在联营商户时从待结算款扣没
export const PARTNER_CONST = {
  FINE_MUL: { 1: 1, 2: 1.5, 3: 2 },     // 一般/严重/紧急
  FINE_MIN: { 1: 50, 2: 150, 3: 400 },
  PERIOD_CHOICES: [3, 7, 15, 30],
  DEPOSIT_MIN: 0,
  DEPOSIT_MAX: 1000000,
  COMMISSION_MIN: 0.05,
  COMMISSION_MAX: 0.8
}
const FIN = { share: '联营分成', settle: '商户结算', deposit: '商户保证金', fine: '商户罚没' }

// ---------------- 编码 / 日志 ----------------
function stampCode(table, idCol, id, prefix) {
  db.prepare(`UPDATE ${table} SET code=? WHERE ${idCol}=?`).run(prefix + String(id).padStart(4, '0'), id)
}
function logPartner(refType, refId, action, note = '', vendorId = null, staffId = null) {
  db.prepare('INSERT INTO partner_logs(ref_type,ref_id,vendor_id,tick,day,action,note,staff_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(refType, refId || 0, vendorId, ctx.tick(), ctx.day(), action, note, staffId)
}
const getVendor = id => db.prepare('SELECT * FROM vendors WHERE id=?').get(num(id))
// 入参兼容商铺行对象（tick 循环）或商铺 id
const vendorIdOf = v => (v && typeof v === 'object' ? num(v.id) : num(v))
// 商铺当前有效联营合同（同商铺同时最多一份 active）
export function activeContract(vendor) {
  return db.prepare("SELECT * FROM partner_contracts WHERE vendor_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(vendorIdOf(vendor))
}
export function isPartnerVendor(vendor) {
  return !!activeContract(vendor)
}

// ---------------- 入驻申请 ----------------
export function listApplications({ status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM partner_applications WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM partner_applications ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(enrichApplication)
}
function enrichApplication(a) {
  const v = a.vendor_id ? getVendor(a.vendor_id) : null
  const zone = db.prepare('SELECT name FROM zones WHERE id=?').get(a.zone_id)
  return {
    ...a,
    vendor_name: v?.name || '',
    zone_name: zone?.name || '',
    applicant_name: a.applicant_staff_id ? db.prepare('SELECT name FROM staff WHERE id=?').get(a.applicant_staff_id)?.name || '' : '',
    reviewer_name: a.reviewer_id ? db.prepare('SELECT name FROM staff WHERE id=?').get(a.reviewer_id)?.name || '' : ''
  }
}
export function applicationDetail(id) {
  const a = db.prepare('SELECT * FROM partner_applications WHERE id=?').get(num(id))
  return a ? enrichApplication(a) : null
}

// 提交入驻申请：mode=new 新商户（仅登记意向，签约时建商铺）；mode=existing 存量商铺转联营
export function applyPartner(payload = {}) {
  const name = String(payload.name || '').trim()
  const contact = String(payload.contact || '').trim()
  const phone = String(payload.phone || '').trim()
  if (!name) return { ok: false, code: 'BAD_ARG', msg: '商户/品牌名称必填' }
  if (!contact) return { ok: false, code: 'BAD_ARG', msg: '联系人必填' }
  const type = ['餐饮', '纪念品', '饮品'].includes(payload.type) ? payload.type : '餐饮'
  const zoneId = num(payload.zone_id, 1)
  if (!db.prepare('SELECT id FROM zones WHERE id=?').get(zoneId)) return { ok: false, code: 'BAD_ARG', msg: '所属区域不存在' }
  const commissionRate = pct(payload.commission_rate ?? 0.2)
  if (commissionRate < PARTNER_CONST.COMMISSION_MIN || commissionRate > PARTNER_CONST.COMMISSION_MAX)
    return { ok: false, code: 'BAD_ARG', msg: `分成率需在 ${PARTNER_CONST.COMMISSION_MIN * 100}%~${PARTNER_CONST.COMMISSION_MAX * 100}% 之间` }
  const period = PARTNER_CONST.PERIOD_CHOICES.includes(num(payload.settle_period_days)) ? num(payload.settle_period_days) : 7
  const deposit = Math.max(PARTNER_CONST.DEPOSIT_MIN, Math.min(PARTNER_CONST.DEPOSIT_MAX, Math.round(num(payload.deposit, 5000))))

  let vendorId = null
  if (payload.mode === 'existing') {
    vendorId = num(payload.vendor_id)
    const v = getVendor(vendorId)
    if (!v) return { ok: false, code: 'VENDOR_NOT_FOUND', msg: '商铺不存在' }
    if (activeContract(vendorId)) return { ok: false, code: 'ALREADY_PARTNER', msg: '该商铺已有履约中的联营合同' }
    const dup = db.prepare("SELECT id FROM partner_applications WHERE vendor_id=? AND status='applied'").get(vendorId)
    if (dup) return { ok: false, code: 'PENDING_APPLICATION', msg: '该商铺已有待审核的联营申请' }
  } else {
    const dupName = db.prepare("SELECT id FROM partner_applications WHERE name=? AND status='applied'").get(name)
    if (dupName) return { ok: false, code: 'PENDING_APPLICATION', msg: '已存在同名商户的待审核申请' }
  }

  try {
    return tx(() => {
      const r = db.prepare(`INSERT INTO partner_applications
        (vendor_id,name,contact,phone,type,zone_id,license,proposal,commission_rate,settle_period_days,deposit,
         status,applicant_staff_id,create_day,create_tick)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, 'applied',?,?,?)`)
        .run(vendorId, name, contact, phone, type, zoneId, String(payload.license || ''), String(payload.proposal || ''),
             commissionRate, period, deposit, num(payload.applicant_staff_id) || null, ctx.day(), ctx.tick())
      const id = Number(r.lastInsertRowid)
      stampCode('partner_applications', 'id', id, 'LY')
      logPartner('application', id, 'apply',
        `${payload.mode === 'existing' ? '存量商铺转联营' : '新商户'}入驻申请：扣点 ${(commissionRate * 100).toFixed(0)}%、账期 ${period} 天、保证金 ¥${deposit}`,
        vendorId, num(payload.applicant_staff_id) || null)
      return { ok: true, id }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '申请提交失败' }
  }
}

// 撤回申请（仅待审核）
export function withdrawApplication(id, { staffId = null } = {}) {
  const a = db.prepare('SELECT * FROM partner_applications WHERE id=?').get(num(id))
  if (!a) return { ok: false, code: 'NOT_FOUND', msg: '申请不存在' }
  if (a.status !== 'applied') return { ok: false, code: 'BAD_STATE', msg: '仅待审核申请可撤回' }
  db.prepare("UPDATE partner_applications SET status='withdrawn' WHERE id=?").run(a.id)
  logPartner('application', a.id, 'withdraw', '商户撤回入驻申请', a.vendor_id, staffId)
  return { ok: true }
}

// 审核通过 → 签约：新商户先建商铺（免园区建设费，商户自带装修/设备）；收取保证金；生成 active 合同
export function approveApplication(id, { staffId = null, commissionRate = null, period = null, deposit = null, memberDiscountShare = null, endDay = 0 } = {}) {
  const a = db.prepare('SELECT * FROM partner_applications WHERE id=?').get(num(id))
  if (!a) return { ok: false, code: 'NOT_FOUND', msg: '申请不存在' }
  if (a.status !== 'applied') return { ok: false, code: 'BAD_STATE', msg: '申请已处理，不能重复审核' }

  // 审核时可微调条款（默认采用申请值）
  const rate = commissionRate == null ? a.commission_rate : pct(commissionRate)
  if (rate < PARTNER_CONST.COMMISSION_MIN || rate > PARTNER_CONST.COMMISSION_MAX)
    return { ok: false, code: 'BAD_ARG', msg: '分成率超出允许范围' }
  const settlePeriod = period == null ? a.settle_period_days : num(period)
  if (!PARTNER_CONST.PERIOD_CHOICES.includes(settlePeriod)) return { ok: false, code: 'BAD_ARG', msg: '结算周期不合法' }
  const depositAmt = deposit == null ? a.deposit : Math.max(0, Math.round(num(deposit)))
  const mdShare = memberDiscountShare == null ? 1 : pct(memberDiscountShare)   // 默认会员折扣全部商户承担
  if (ctx.cash() + depositAmt < 0) return { ok: false, code: 'NO_CASH', msg: '系统资金异常' }

  try {
    return tx(() => {
      let vendorId = a.vendor_id
      if (!vendorId) {
        // 新联营商户入驻：园区不承担建设成本（与自营 8000 建店区分）
        const r = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
          .run(a.name, a.type, a.zone_id, 0, 0.6, 25, 0, 0)
        vendorId = Number(r.lastInsertRowid)
        db.prepare('UPDATE partner_applications SET vendor_id=? WHERE id=?').run(vendorId, a.id)
        // 与自营开店一致：按商铺类型自动挂供货物资，销售即接入库存联动（无匹配物资则不受库存管理）
        try { ctx.autoLinkVendor?.(vendorId, a.type) } catch (e) { console.error('[partners] 自动挂物资失败:', e) }
      } else {
        // 存量商铺转联营：固定租金改由联营扣点替代，日结不再收租
        db.prepare('UPDATE vendors SET rent=0 WHERE id=?').run(vendorId)
      }

      // 保证金：签约即收（商户现金缴纳，园方代管），终止清算时按约定退还/扣没
      if (depositAmt > 0) {
        setSetting('cash', Math.round(ctx.cash() + depositAmt))
        ctx.logFinance?.(ctx.day(), FIN.deposit, depositAmt, `「${a.name}」联营保证金（代管，终止清算）`)
      }

      const cr = db.prepare(`INSERT INTO partner_contracts
        (application_id,vendor_id,commission_rate,member_discount_share,settle_period_days,deposit,
         start_day,end_day,status,sign_day,sign_tick,signer_id,note)
        VALUES(?,?,?,?,?,?,?,?,'active',?,?,?,?)`)
        .run(a.id, vendorId, rate, mdShare, settlePeriod, depositAmt, ctx.day(), Math.max(0, Math.round(num(endDay))),
             ctx.day(), ctx.tick(), num(staffId) || null, `审核通过签约：${a.contact} ${a.phone}`)
      const contractId = Number(cr.lastInsertRowid)
      stampCode('partner_contracts', 'id', contractId, 'HT')

      db.prepare("UPDATE partner_applications SET status='approved',reviewer_id=?,contract_id=?,review_day=?,review_tick=? WHERE id=?")
        .run(num(staffId) || null, contractId, ctx.day(), ctx.tick(), a.id)
      logPartner('application', a.id, 'approve', `审核通过并签约 ${'HT' + String(contractId).padStart(4, '0')}，保证金 ¥${depositAmt}`, vendorId, staffId)
      logPartner('contract', contractId, 'sign',
        `联营合同生效：扣点 ${(rate * 100).toFixed(0)}%、账期 ${settlePeriod} 天、会员优惠商户承担 ${(mdShare * 100).toFixed(0)}%`,
        vendorId, staffId)
      return { ok: true, contractId, vendorId }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '签约失败' }
  }
}

// 审核驳回
export function rejectApplication(id, { reason = '', staffId = null } = {}) {
  const a = db.prepare('SELECT * FROM partner_applications WHERE id=?').get(num(id))
  if (!a) return { ok: false, code: 'NOT_FOUND', msg: '申请不存在' }
  if (a.status !== 'applied') return { ok: false, code: 'BAD_STATE', msg: '申请已处理，不能重复审核' }
  db.prepare("UPDATE partner_applications SET status='rejected',reject_reason=?,reviewer_id=?,review_day=?,review_tick=? WHERE id=?")
    .run(String(reason || '资质不符').slice(0, 200), num(staffId) || null, ctx.day(), ctx.tick(), a.id)
  logPartner('application', a.id, 'reject', `驳回：${reason || '资质不符'}`, a.vendor_id, staffId)
  return { ok: true }
}

// ---------------- 销售分账流水 ----------------
// 记录一笔联营销售分账（调用方须已在事务中：散客 tick 外层 tick 事务 / 会员消费在 runAtomic 内）
// 入参：实际成交账单金额 bill、牌价 gross、会员/散客来源；按合同扣点与优惠分摊拆分
export function recordSale(vendorId, { qty = 1, gross, bill, source = 'organic', memberId = null, note = '' } = {}) {
  const contract = activeContract(vendorId)
  if (!contract) throw new PartnerError('NO_CONTRACT', `商铺 #${vendorId} 无有效联营合同`)
  const q = Math.max(0, num(qty))
  const grossAmt = Math.max(0, Math.round(num(gross)))
  const billAmt = Math.max(0, Math.min(grossAmt, Math.round(num(bill))))
  const discount = grossAmt - billAmt                                   // 会员优惠总额
  const parkShare = Math.round(billAmt * contract.commission_rate)     // 园方扣点
  const merchantShare = billAmt - parkShare                            // 商户分账应得
  const merchantDiscountBorne = Math.round(discount * contract.member_discount_share)
  const parkDiscountBorne = discount - merchantDiscountBorne
  const id = db.prepare('SELECT COALESCE(MAX(id),0)+1 i FROM partner_sales').get().i
  const r = db.prepare(`INSERT INTO partner_sales
    (code,vendor_id,contract_id,member_id,source,qty,gross,bill_amount,member_discount,
     merchant_share,park_share,merchant_discount_borne,park_discount_borne,
     commission_rate,member_discount_share,kind,day,tick,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'sale',?,?,?)`)
    .run('LS' + String(id).padStart(4, '0'), vendorId, contract.id, num(memberId) || null, source, q,
         grossAmt, billAmt, discount, merchantShare, parkShare, merchantDiscountBorne, parkDiscountBorne,
         contract.commission_rate, contract.member_discount_share, ctx.day(), ctx.tick(), note)
  const saleId = Number(r.lastInsertRowid)
  return {
    saleId, code: 'LS' + String(saleId).padStart(4, '0'),
    gross: grossAmt, bill: billAmt, discount, merchantShare, parkShare,
    merchantDiscountBorne, parkDiscountBorne
  }
}

// 退货红冲行通用构造：所有金额字段为负，与正向销售同口径（结算时直接 SUM 净额）
function insertReturnRow({ vendorId, contractId, memberId, source, qty, grossNeg, billNeg,
                           commissionRate, memberDiscountShare, originSaleId = null, complaintId = null,
                           outageTaskId = null, note = '' }) {
  const discountNeg = grossNeg - billNeg                                   // 负数（优惠冲回）
  const parkShareN = -Math.round(-billNeg * commissionRate)               // 负数
  const merchantShareN = billNeg - parkShareN                             // 负数
  const mdBorneN = -Math.round(-discountNeg * memberDiscountShare)        // 负数
  const pdBorneN = discountNeg - mdBorneN                                 // 负数
  const id = db.prepare('SELECT COALESCE(MAX(id),0)+1 i FROM partner_sales').get().i
  const r = db.prepare(`INSERT INTO partner_sales
    (code,vendor_id,contract_id,member_id,source,qty,gross,bill_amount,member_discount,
     merchant_share,park_share,merchant_discount_borne,park_discount_borne,
     commission_rate,member_discount_share,kind,origin_sale_id,complaint_id,outage_task_id,day,tick,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'return',?,?,?,?,?,?)`)
    .run('LS' + String(id).padStart(4, '0'), vendorId, contractId, memberId || null, source, -qty,
         grossNeg, billNeg, discountNeg, merchantShareN, parkShareN, mdBorneN, pdBorneN,
         commissionRate, memberDiscountShare, originSaleId || null, num(complaintId) || null,
         num(outageTaskId) || null, ctx.day(), ctx.tick(), note)
  const rid = Number(r.lastInsertRowid)
  return { id: rid, code: 'LS' + String(rid).padStart(4, '0'), merchantShare: merchantShareN, bill: billNeg, gross: grossNeg }
}

// 会员/指定原单退货：按原销售流水的牌价单价与折扣率红冲（结算前可关联；已出账返回提示，改走散客退货在后续账单冲减）
export function recordReturn(vendorId, originSaleId, { qty = 1, refund, complaintId = null, note = '' } = {}) {
  const origin = db.prepare("SELECT * FROM partner_sales WHERE id=? AND kind='sale'").get(num(originSaleId))
  if (!origin) return { ok: false, code: 'SALE_NOT_FOUND', msg: '原销售流水不存在' }
  if (origin.vendor_id !== num(vendorId)) return { ok: false, code: 'BAD_ARG', msg: '退货商户与原销售不一致' }
  const q = Math.max(1, Math.round(num(qty)))
  if (q > origin.qty - Math.abs(num(returnedQty(origin.id)))) return { ok: false, code: 'QTY_EXCEED', msg: '退货数量超过可退数量' }
  const refundAmt = Math.max(0, Math.round(num(refund)))
  if (refundAmt <= 0) return { ok: false, code: 'BAD_ARG', msg: '退款金额必须大于 0' }
  if (origin.settlement_id) return { ok: false, code: 'ALREADY_SETTLED', msg: '该笔销售已出账，退货将在后续账单以净额冲减' }
  try {
    return tx(() => {
      const grossUnit = origin.qty > 0 ? origin.gross / origin.qty : 0
      const grossNeg = -Math.round(grossUnit * q)
      const row = insertReturnRow({
        vendorId: origin.vendor_id, contractId: origin.contract_id, memberId: origin.member_id, source: origin.source,
        qty: q, grossNeg, billNeg: -refundAmt, commissionRate: origin.commission_rate,
        memberDiscountShare: origin.member_discount_share, originSaleId: origin.id, complaintId,
        note: note || `退货红冲原流水 ${origin.code}`
      })
      logPartner('sale', row.id, 'return', `退货 ${q} 份红冲 ${origin.code}，退款 ¥${refundAmt}`, vendorId)
      return { ok: true, ...row, refund: refundAmt }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '退货登记失败' }
  }
}
function returnedQty(originSaleId) {
  return db.prepare("SELECT COALESCE(SUM(qty),0) q FROM partner_sales WHERE origin_sale_id=? AND kind='return'").get(num(originSaleId)).q
}

// 散客退货入口：不要求关联原流水（散客 tick 未留会员单），按当前合同生成红冲行
export function organicReturn(vendorId, qty, { refund = null, complaintId = null, reason = '' } = {}) {
  const contract = activeContract(vendorId)
  if (!contract) return { ok: false, code: 'NO_CONTRACT', msg: '商铺无有效联营合同' }
  const v = getVendor(vendorId)
  const q = Math.max(1, Math.round(num(qty)))
  const refundAmt = Math.max(0, Math.round(refund ?? q * (v?.price || 0)))
  try {
    return tx(() => {
      const grossNeg = -Math.round(q * (v?.price || 0))
      const row = insertReturnRow({
        vendorId, contractId: contract.id, source: 'organic', qty: q, grossNeg, billNeg: -refundAmt,
        commissionRate: contract.commission_rate, memberDiscountShare: contract.member_discount_share,
        complaintId, note: reason || '散客退货红冲'
      })
      logPartner('sale', row.id, 'return', `散客退货 ${q} 份，退款 ¥${refundAmt}`, vendorId)
      return { ok: true, ...row, refund: refundAmt }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '退货登记失败' }
  }
}

// 统一停运补偿队列可恢复版联营退款：写负向红冲行（按 outageTaskId 幂等，重试不重复红冲）。
// 不自行扣现金：由调用方（补偿执行器/召回）在同一事务内按统一口径扣现金并记财务流水，
// 保证现金、分账流水与账单三者同生共死、可重试恢复。
// 返回 { ok, row, refund }；该任务已红冲过（重试）返回 { ok:true, replay:true }。
export function outagePartnerReturn(vendorId, qty, { refund = null, complaintId = null, reason = '', outageTaskId = null, source = 'organic' } = {}) {
  const contract = activeContract(vendorId)
  if (!contract) return { ok: false, code: 'NO_CONTRACT', msg: '商铺无有效联营合同' }
  const v = getVendor(vendorId)
  const q = Math.max(1, Math.round(num(qty)))
  const refundAmt = Math.max(0, Math.round(refund ?? q * (v?.price || 0)))
  if (refundAmt <= 0) return { ok: false, code: 'BAD_ARG', msg: '退款金额必须大于 0' }
  // 补偿重试幂等：同一补偿任务已写过红冲行则直接重放，绝不二次退款
  if (outageTaskId) {
    const dup = db.prepare("SELECT id FROM partner_sales WHERE outage_task_id=? AND kind='return'").get(num(outageTaskId))
    if (dup) return { ok: true, replay: true, id: dup.id, refund: refundAmt }
  }
  try {
    const grossNeg = -Math.round(q * (v?.price || 0))
    const row = insertReturnRow({
      vendorId, contractId: contract.id, source, qty: q, grossNeg, billNeg: -refundAmt,
      commissionRate: contract.commission_rate, memberDiscountShare: contract.member_discount_share,
      complaintId, outageTaskId, note: reason || '停运补偿联营退款红冲'
    })
    logPartner('sale', row.id, 'return', `停运/补偿联营退款 ${q} 份，退款 ¥${refundAmt}（红冲结转账单）`, vendorId)
    return { ok: true, ...row, refund: refundAmt }
  } catch (e) {
    // 并发下唯一索引兜底：已红冲则按重放处理
    if (outageTaskId) {
      const dup = db.prepare("SELECT id FROM partner_sales WHERE outage_task_id=? AND kind='return'").get(num(outageTaskId))
      if (dup) return { ok: true, replay: true, id: dup.id, refund: refundAmt }
    }
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '联营退款红冲失败' }
  }
}

// 投诉处罚：结案现金补偿且投诉对象为联营商户时，按严重度罚没（园方收入，结算扣减，非新增现金）
// 幂等：同一投诉最多一笔罚没（部分唯一索引），重复调用返回既有记录
export function levyComplaintFine(complaint) {
  if (!complaint || complaint.target_type !== 'vendor' || !complaint.target_id) return null
  const contract = activeContract(complaint.target_id)
  if (!contract) return null
  const exist = db.prepare('SELECT * FROM partner_fines WHERE complaint_id=?').get(complaint.id)
  if (exist) return { fineId: exist.id, amount: exist.amount, replay: true }
  const sev = Math.min(3, Math.max(1, num(complaint.severity, 1)))
  const compCost = Math.max(0, Math.round(num(complaint.comp_cost)))
  const amount = Math.max(PARTNER_CONST.FINE_MIN[sev] || 50, Math.round(compCost * (PARTNER_CONST.FINE_MUL[sev] || 1)))
  let fineId
  tx(() => {
    const id = db.prepare('SELECT COALESCE(MAX(id),0)+1 i FROM partner_fines').get().i
    const r = db.prepare(`INSERT INTO partner_fines
      (code,vendor_id,contract_id,complaint_id,severity,amount,comp_cost,reason,day,tick)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run('CF' + String(id).padStart(4, '0'), contract.vendor_id, contract.id, complaint.id, sev, amount, compCost,
           `投诉 ${complaint.code || '#' + complaint.id} 结案罚没（${sev === 3 ? '紧急' : sev === 2 ? '严重' : '一般'}）`,
           ctx.day(), ctx.tick())
    fineId = Number(r.lastInsertRowid)
    logPartner('sale', fineId, 'fine', `投诉责任罚没 ¥${amount}（客诉补偿 ¥${compCost}）`, contract.vendor_id)
  })
  return { fineId, amount }
}

// ---------------- 结算账单 ----------------
function openPeriodFrom(contract) {
  // 该合同下一张周期账的起始日：取最近一张账单结束日次日，否则合同生效日
  const last = db.prepare("SELECT period_to FROM partner_settlements WHERE contract_id=? ORDER BY id DESC LIMIT 1").get(contract.id)
  return last ? last.period_to + 1 : contract.start_day
}

// 汇总区间内未入账的销售/红冲/罚没
function summarizePeriod(contract, dayFrom, dayTo) {
  const sales = db.prepare(`SELECT
      COALESCE(SUM(qty),0) qty, COALESCE(SUM(gross),0) gross, COALESCE(SUM(bill_amount),0) bill,
      COALESCE(SUM(merchant_share),0) mshare, COALESCE(SUM(park_share),0) pshare,
      COALESCE(SUM(member_discount),0) md, COALESCE(SUM(merchant_discount_borne),0) mdb,
      COUNT(*) n
      FROM partner_sales WHERE contract_id=? AND settlement_id=0 AND day>=? AND day<=?`).get(contract.id, dayFrom, dayTo)
  const fines = db.prepare(`SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM partner_fines
                            WHERE contract_id=? AND settlement_id=0 AND day>=? AND day<=?`).get(contract.id, dayFrom, dayTo)
  return {
    saleCount: Math.round(num(sales.qty) * 10) / 10,
    gross: Math.round(num(sales.gross)),
    billAmount: Math.round(num(sales.bill)),
    merchantShare: Math.round(num(sales.mshare)),
    parkShare: Math.round(num(sales.pshare)),
    memberDiscount: Math.round(num(sales.md)),
    merchantDiscountBorne: Math.round(num(sales.mdb)),
    fines: Math.round(num(fines.a)),
    lineCount: num(sales.n),
    fineCount: num(fines.n)
  }
}

// 生成账单（内部）：source=periodic 周期账 / terminate 终止清算（depositOffset 扣没 / depositRefund 退还）
function buildSettlement(contract, { source = 'periodic', dayFrom = null, dayTo = null, depositOffset = 0, depositRefund = 0, note = '' } = {}) {
  const from = dayFrom ?? openPeriodFrom(contract)
  const to = dayTo ?? ctx.day()
  if (to < from) return { ok: false, code: 'EMPTY_PERIOD', msg: '账期区间为空' }
  const sum = summarizePeriod(contract, from, to)
  const cogsInfo = ctx.partnerCogs ? ctx.partnerCogs(contract.vendor_id, from, to) : { cogs: 0 }
  // 商户实得 = 分账应得 - 会员优惠商户承担 - 批次成本 - 投诉罚没 - 保证金扣没 + 保证金退还
  const rawPayable = sum.merchantShare - sum.merchantDiscountBorne - cogsInfo.cogs - sum.fines
    - Math.round(num(depositOffset)) + Math.round(num(depositRefund))
  // 净额为负（退货红冲大于销售等）：不出账，流水保持 settlement_id=0 结转下期冲抵；终止清算时负数由保证金/园区承担，应付置 0
  if (rawPayable < 0 && source === 'periodic') {
    return { ok: false, code: 'NEGATIVE_PERIOD', msg: '本周期净额为负（退货/罚没大于销售），结转下期冲抵', carry: rawPayable }
  }
  const payable = Math.max(0, rawPayable)
  // 无任何流水/罚没/成本且无保证金处理、非终止清算 → 不出空账
  const empty = sum.lineCount === 0 && sum.fineCount === 0 && cogsInfo.cogs === 0
    && Math.round(num(depositOffset)) === 0 && Math.round(num(depositRefund)) === 0
  if (empty && source === 'periodic') return { ok: false, code: 'EMPTY_PERIOD', msg: '本周期无待结算流水' }

  const id0 = db.prepare('SELECT COALESCE(MAX(id),0)+1 i FROM partner_settlements').get().i
  const r = db.prepare(`INSERT INTO partner_settlements
    (code,vendor_id,contract_id,period_from,period_to,sale_count,gross,bill_amount,
     merchant_share,park_share,member_discount,merchant_discount_borne,cogs,fines,deposit_offset,deposit_refund,payable,
     source,status,create_day,create_tick,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`)
    .run('JS' + String(id0).padStart(4, '0'), contract.vendor_id, contract.id, from, to,
         sum.saleCount, sum.gross, sum.billAmount, sum.merchantShare, sum.parkShare,
         sum.memberDiscount, sum.merchantDiscountBorne, cogsInfo.cogs, sum.fines,
         Math.round(num(depositOffset)), Math.round(num(depositRefund)), payable,
         source, ctx.day(), ctx.tick(), note)
  const sid = Number(r.lastInsertRowid)
  // 关联流水/罚没到本账单
  db.prepare('UPDATE partner_sales SET settlement_id=? WHERE contract_id=? AND settlement_id=0 AND day>=? AND day<=?')
    .run(sid, contract.id, from, to)
  db.prepare('UPDATE partner_fines SET settlement_id=? WHERE contract_id=? AND settlement_id=0 AND day>=? AND day<=?')
    .run(sid, contract.id, from, to)
  logPartner('settlement', sid, 'issue',
    `${source === 'terminate' ? '终止清算' : '周期账单'} ${from}~${to}：应付商户 ¥${payable}（分账 ¥${sum.merchantShare} - 优惠承担 ¥${sum.merchantDiscountBorne} - 物料成本 ¥${cogsInfo.cogs} - 罚没 ¥${sum.fines}${Math.round(num(depositOffset)) ? ` - 保证金扣没 ¥${Math.round(num(depositOffset))}` : ''}${Math.round(num(depositRefund)) ? ` + 保证金退还 ¥${Math.round(num(depositRefund))}` : ''}）`,
    contract.vendor_id)
  return { ok: true, id: sid, payable }
}

// 运营手动为某合同出当期账
export function issueSettlement(contractId, { note = '' } = {}) {
  const c = db.prepare('SELECT * FROM partner_contracts WHERE id=?').get(num(contractId))
  if (!c) return { ok: false, code: 'NOT_FOUND', msg: '合同不存在' }
  if (c.status !== 'active') return { ok: false, code: 'BAD_STATE', msg: '合同已终止' }
  try {
    return tx(() => buildSettlement(c, { source: 'periodic', note }))
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '出账失败' }
  }
}

// 支付账单：园方代为清偿对商户负债；现金不足转 overdue 挂账（资金到位后补付）
export function paySettlement(id, { staffId = null } = {}) {
  const s = db.prepare('SELECT * FROM partner_settlements WHERE id=?').get(num(id))
  if (!s) return { ok: false, code: 'NOT_FOUND', msg: '账单不存在' }
  if (s.status === 'paid') return { ok: false, code: 'ALREADY_PAID', msg: '账单已支付' }
  const v = getVendor(s.vendor_id)
  if (ctx.cash() < s.payable) {
    if (s.status !== 'overdue') {
      db.prepare("UPDATE partner_settlements SET status='overdue',note=COALESCE(NULLIF(note,''),'现金不足挂账，待资金到位补付') WHERE id=?").run(s.id)
      logPartner('settlement', s.id, 'overdue', `账期支付时现金不足 ¥${s.payable}，挂账待补付`, s.vendor_id, staffId)
      db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
        .run(ctx.tick(), ctx.day(), 'partner', '联营账单挂账',
          `「${v?.name || '商户'}」结算账单 ${s.code} 应付 ¥${s.payable}，园区现金不足已挂账，资金到位后请在联营结算页补付。`, -1, 'active')
    }
    return { ok: false, code: 'INSUFFICIENT_CASH', msg: `现金不足（需 ¥${s.payable}），账单已挂账` }
  }
  try {
    return tx(() => {
      setSetting('cash', Math.round(ctx.cash() - s.payable))
      if (s.payable > 0) ctx.logFinance?.(ctx.day(), FIN.settle, -s.payable, `「${v?.name}」联营结算 ${s.code}（${s.period_from}~${s.period_to}）`)
      if (s.fines > 0) ctx.logFinance?.(ctx.day(), FIN.fine, s.fines, `「${v?.name}」投诉罚没（账单 ${s.code}）`)
      db.prepare("UPDATE partner_settlements SET status='paid',pay_day=?,pay_tick=? WHERE id=?")
        .run(ctx.day(), ctx.tick(), s.id)
      logPartner('settlement', s.id, 'pay', `支付商户结算款 ¥${s.payable}`, s.vendor_id, staffId)
      return { ok: true, paid: s.payable }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '支付失败' }
  }
}

// 补付挂账账单
export function retryOverdueSettlements() {
  const rows = db.prepare("SELECT * FROM partner_settlements WHERE status='overdue' ORDER BY id").all()
  let paid = 0, count = 0
  for (const s of rows) {
    const r = paySettlement(s.id)
    if (r.ok) { paid += r.paid; count++ }
  }
  return { count, paid, remaining: rows.length - count }
}

// 日结自动出账：合同到期（last_from + period - 1 <= day）即生成 draft 账单（不自动付款）
export function autoIssueSettlements(day = ctx.day()) {
  const contracts = db.prepare("SELECT * FROM partner_contracts WHERE status='active'").all()
  const issued = []
  for (const c of contracts) {
    const from = openPeriodFrom(c)
    if (from + c.settle_period_days - 1 <= day) {
      try {
        tx(() => {
          const r = buildSettlement(c, { source: 'periodic', dayFrom: from, dayTo: day, note: `账期 ${c.settle_period_days} 天到期自动出账` })
          if (r.ok) issued.push(r.id)
        })
      } catch (e) { console.error('[partners] 自动出账失败:', e) }
    }
  }
  return issued
}

// 终止合同：先出终止清算账（含保证金扣没/退还），合同置 terminated；账单仍需支付
// forfeitDeposit=true 扣没全部保证金（转园方收入）；否则保证金在清算账应付中退还商户
export function terminateContract(contractId, { reason = '', forfeitDeposit = false, staffId = null } = {}) {
  const c = db.prepare('SELECT * FROM partner_contracts WHERE id=?').get(num(contractId))
  if (!c) return { ok: false, code: 'NOT_FOUND', msg: '合同不存在' }
  if (c.status !== 'active') return { ok: false, code: 'BAD_STATE', msg: '合同已终止' }
  try {
    return tx(() => {
      const from = openPeriodFrom(c)
      const vName = getVendor(c.vendor_id)?.name || '商户'
      const r = buildSettlement(c, {
        source: 'terminate', dayFrom: from, dayTo: ctx.day(),
        depositOffset: forfeitDeposit ? c.deposit : 0,
        depositRefund: forfeitDeposit ? 0 : c.deposit,
        note: (forfeitDeposit ? '终止合同，扣没保证金；' : '终止合同，保证金随清算账退还；') + (reason || '')
      })
      if (!r.ok && r.code === 'EMPTY_PERIOD') {
        // 区间完全无流水且无保证金：仅终止合同，不出账
        db.prepare("UPDATE partner_contracts SET status='terminated' WHERE id=?").run(c.id)
        logPartner('contract', c.id, 'terminate', `合同终止：${reason || '协议解约'}（无未结款项）`, c.vendor_id, staffId)
        return { ok: true, settlementId: null }
      }
      if (!r.ok) throw new PartnerError(r.code, r.msg)
      const sid = r.id
      if (forfeitDeposit && c.deposit > 0) {
        ctx.logFinance?.(ctx.day(), FIN.fine, c.deposit, `「${vName}」合同终止扣没保证金（清算账 ${'JS' + String(sid).padStart(4, '0')}）`)
      } else if (c.deposit > 0) {
        ctx.logFinance?.(ctx.day(), FIN.deposit, -c.deposit, `「${vName}」合同终止应退保证金（随清算账 ${'JS' + String(sid).padStart(4, '0')} 支付）`)
      }
      db.prepare("UPDATE partner_contracts SET status='terminated',end_settlement_id=? WHERE id=?").run(sid, c.id)
      logPartner('contract', c.id, 'terminate', `合同终止，清算账单 ${'JS' + String(sid).padStart(4, '0')}：${reason || '协议解约'}`, c.vendor_id, staffId)
      return { ok: true, settlementId: sid }
    })
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '终止失败' }
  }
}

// ---------------- 查询 ----------------
export function listContracts({ status = null, vendorId = null, limit = 100 } = {}) {
  let rows
  if (vendorId) rows = db.prepare('SELECT * FROM partner_contracts WHERE vendor_id=? ORDER BY id DESC LIMIT ?').all(num(vendorId), limit)
  else if (status) rows = db.prepare('SELECT * FROM partner_contracts WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
  else rows = db.prepare('SELECT * FROM partner_contracts ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(enrichContract)
}
function enrichContract(c) {
  const v = getVendor(c.vendor_id)
  const pending = db.prepare("SELECT COALESCE(COUNT(*),0) n, COALESCE(SUM(payable),0) p FROM partner_settlements WHERE contract_id=? AND status IN ('draft','overdue')").get(c.id)
  return {
    ...c,
    vendor_name: v?.name || '',
    vendor_type: v?.type || '',
    pending_bills: num(pending.n),
    pending_payable: Math.round(num(pending.p))
  }
}
export function contractDetail(id) {
  const c = db.prepare('SELECT * FROM partner_contracts WHERE id=?').get(num(id))
  if (!c) return null
  const sales = db.prepare('SELECT * FROM partner_sales WHERE contract_id=? ORDER BY id DESC LIMIT 100').all(c.id).map(enrichSale)
  const fines = db.prepare('SELECT * FROM partner_fines WHERE contract_id=? ORDER BY id DESC LIMIT 50').all(c.id)
  const bills = db.prepare('SELECT * FROM partner_settlements WHERE contract_id=? ORDER BY id DESC LIMIT 50').all(c.id).map(enrichSettlement)
  return { contract: enrichContract(c), sales, fines, bills }
}
function enrichSale(s) {
  const v = getVendor(s.vendor_id)
  const m = s.member_id ? db.prepare('SELECT code,name FROM members WHERE id=?').get(s.member_id) : null
  const bill = s.settlement_id ? db.prepare('SELECT code FROM partner_settlements WHERE id=?').get(s.settlement_id) : null
  return {
    ...s,
    vendor_name: v?.name || '',
    member_code: m?.code || '',
    member_name: m?.name || '',
    settlement_code: bill?.code || ''
  }
}
export function listSales({ vendorId = null, kind = null, unsettledOnly = false, limit = 100 } = {}) {
  const where = []
  const args = []
  if (vendorId) { where.push('vendor_id=?'); args.push(num(vendorId)) }
  if (kind) { where.push('kind=?'); args.push(kind) }
  if (unsettledOnly) where.push('settlement_id=0')
  const sql = 'SELECT * FROM partner_sales ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?'
  args.push(limit)
  return db.prepare(sql).all(...args).map(enrichSale)
}
export function listSettlements({ status = null, vendorId = null, limit = 100 } = {}) {
  const where = []
  const args = []
  if (status) { where.push('status=?'); args.push(status) }
  if (vendorId) { where.push('vendor_id=?'); args.push(num(vendorId)) }
  const sql = 'SELECT * FROM partner_settlements ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?'
  args.push(limit)
  return db.prepare(sql).all(...args).map(enrichSettlement)
}
function enrichSettlement(s) {
  const v = getVendor(s.vendor_id)
  return { ...s, vendor_name: v?.name || '', vendor_type: v?.type || '' }
}
export function settlementDetail(id) {
  const s = db.prepare('SELECT * FROM partner_settlements WHERE id=?').get(num(id))
  if (!s) return null
  const lines = db.prepare('SELECT * FROM partner_sales WHERE settlement_id=? ORDER BY id').all(s.id).map(enrichSale)
  const fines = db.prepare('SELECT * FROM partner_fines WHERE settlement_id=? ORDER BY id').all(s.id)
  return { settlement: enrichSettlement(s), lines, fines }
}
export function listFines({ vendorId = null, unsettledOnly = false, limit = 100 } = {}) {
  const where = []
  const args = []
  if (vendorId) { where.push('vendor_id=?'); args.push(num(vendorId)) }
  if (unsettledOnly) where.push('settlement_id=0')
  const sql = 'SELECT * FROM partner_fines ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?'
  args.push(limit)
  return db.prepare(sql).all(...args).map(f => ({ ...f, vendor_name: getVendor(f.vendor_id)?.name || '' }))
}

// ---------------- 统计 ----------------
export function partnerStats() {
  const day = ctx.day()
  const contracts = {
    active: db.prepare("SELECT COUNT(*) n FROM partner_contracts WHERE status='active'").get().n,
    terminated: db.prepare("SELECT COUNT(*) n FROM partner_contracts WHERE status='terminated'").get().n
  }
  const applications = {
    applied: db.prepare("SELECT COUNT(*) n FROM partner_applications WHERE status='applied'").get().n,
    approved: db.prepare("SELECT COUNT(*) n FROM partner_applications WHERE status='approved'").get().n
  }
  const bills = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END),0) draft,
      COALESCE(SUM(CASE WHEN status='overdue' THEN 1 ELSE 0 END),0) overdue,
      COALESCE(SUM(CASE WHEN status IN ('draft','overdue') THEN payable ELSE 0 END),0) payable,
      COALESCE(SUM(CASE WHEN status='paid' AND pay_day=? THEN payable ELSE 0 END),0) paid_today,
      COALESCE(SUM(CASE WHEN status='paid' THEN payable ELSE 0 END),0) paid_total
      FROM partner_settlements`).get(day)
  const today = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='sale' THEN bill_amount ELSE 0 END),0) bill,
      COALESCE(SUM(CASE WHEN kind='sale' THEN park_share ELSE 0 END),0) park,
      COALESCE(SUM(CASE WHEN kind='sale' THEN merchant_share ELSE 0 END),0) merchant,
      COALESCE(SUM(CASE WHEN kind='return' THEN bill_amount ELSE 0 END),0) refund
      FROM partner_sales WHERE day=?`).get(day)
  const finesToday = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM partner_fines WHERE day=?').get(day).a
  return {
    contracts,
    applications,
    bills: {
      draft: num(bills.draft), overdue: num(bills.overdue),
      payable: Math.round(num(bills.payable)),
      paidToday: Math.round(num(bills.paid_today)),
      paidTotal: Math.round(num(bills.paid_total))
    },
    today: {
      bill: Math.round(num(today.bill)),
      refund: Math.round(num(today.refund)),
      parkShare: Math.round(num(today.park)),
      merchantShare: Math.round(num(today.merchant)),
      fines: Math.round(num(finesToday))
    }
  }
}
