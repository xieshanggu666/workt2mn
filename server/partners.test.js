// 园区联营商户结算模块测试：
//  1) 入驻申请：申请→重复申请拦截→审核驳回/通过签约（新商户建店免建设费、保证金收取、存量商铺转联营免租）
//  2) 销售分账：散客/会员销售按合同扣点拆分，会员优惠按约分摊，库存 FEFO 批次成本可汇总
//  3) 退货退款：采购事务回补库存 + 联营红冲负向流水；红冲后账单净额冲减
//  4) 投诉处罚：联营商铺客诉现金补偿结案按严重度罚没，计入账单扣减
//  5) 周期账单：自动/手动出账汇总（分账-优惠承担-批次成本-罚没），支付清偿/现金不足挂账/补付
//  6) 终止清算：保证金退还/扣没；合同终止不再出周期账
// 运行：node --experimental-sqlite --test server/partners.test.js（需 Node >= 22.5）
process.env.PARK_DB_PATH = ':memory:'

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const P = await import('./procurement.js')
const M = await import('./members.js')
const L = await import('./partners.js')

const finLogs = []
P.initProcurementContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail })
})
M.initMemberContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  reserveVendorStock: (vendorId, qty) => P.reserveVendorStock(vendorId, qty, { partner: L.isPartnerVendor(vendorId) }),
  partnerSaleHook: (vendorId, payload) => L.recordSale(vendorId, { ...payload, source: 'member' })
})
L.initPartnerContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  applyVendorSales: (vendorId, qty) => P.applyVendorSales(vendorId, qty, { partner: true }),
  reserveVendorStock: (vendorId, qty) => P.reserveVendorStock(vendorId, qty, { partner: true }),
  customerReturn: (vendorId, qty, opts) => P.customerReturn(vendorId, qty, { ...opts, partner: true }),
  partnerCogs: (vendorId, from, to) => P.partnerCogs(vendorId, from, to)
})

const cash = () => Number(getSetting('cash'))
const finSum = (label, sign = 0) => finLogs
  .filter(f => f.label === label)
  .reduce((s, f) => s + (sign < 0 ? Math.min(0, f.amount) : sign > 0 ? Math.max(0, f.amount) : f.amount), 0)

test.beforeEach(() => {
  setSetting('day', 1)
  setSetting('tick', 100)
  setSetting('cash', 500000)
  finLogs.length = 0
})

// 找到一个已挂物资的存量商铺（爆米花小屋）——仅用于基础查询；写流程统一用独立新铺避免用例间串账
function seedVendor() {
  const pop = P.listMaterials().find(m => m.name.includes('爆米花'))
  const vid = pop.vendors[0].id
  return { vid, mat: pop }
}

let uniqueSeq = 0
// 创建专属新商铺 + 专属物资 + 期初库存（用例间完全隔离，不与存量商铺共享物资）
function freshShop({ stdCost = 6, stock = 500 } = {}) {
  uniqueSeq += 1
  const day = Number(getSetting('day'))
  const vr = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price) VALUES(?,?,?,0,0.6,?)')
    .run(`测试联营铺#${uniqueSeq}`, '餐饮', 1, 20)
  const vid = Number(vr.lastInsertRowid)
  const mr = db.prepare(`INSERT INTO materials(name,category,unit,std_cost,safety_stock,shelf_days,auto_reorder,reorder_qty,preferred_supplier_id,status)
                         VALUES(?,?, '份',?,10,0,1,100,1,'active')`)
    .run(`测试物资#${uniqueSeq}`, '食材', stdCost)
  const mid = Number(mr.lastInsertRowid)
  db.prepare('INSERT INTO vendor_materials(vendor_id,material_id) VALUES(?,?)').run(vid, mid)
  const br = db.prepare(`INSERT INTO inbound_batches(material_id,supplier_id,qty_received,qty_remain,unit_cost,receive_day,expire_day,status,note)
                         VALUES(?,1,?,?,?,? ,0,'in','期初')`).run(mid, stock, stock, stdCost, day)
  const bid = Number(br.lastInsertRowid)
  db.prepare('INSERT INTO inventory(material_id,qty_on_hand,qty_reserved,updated_tick) VALUES(?,? ,0,0)').run(mid, stock)
  db.prepare(`INSERT INTO stock_movements(material_id,batch_id,vendor_id,change,qty_after,reason,ref_type,ref_id,day,tick)
              VALUES(?,?,NULL,?,?, 'in','batch',?,?,0)`).run(mid, bid, stock, stock, bid, day)
  const mat = P.listMaterials().find(m => m.id === mid)
  return { vid, mat }
}

// 新铺申请→签约一条龙
function signFreshShop(opts = {}) {
  const shop = freshShop(opts.shop || {})
  const a = L.applyPartner({
    mode: 'existing', vendor_id: shop.vid, name: `联营商户#${uniqueSeq}`, contact: '联系人',
    commission_rate: opts.rate ?? 0.2, settle_period_days: opts.period ?? 7,
    deposit: opts.deposit ?? 0, member_discount_share: opts.mdShare
  })
  const ap = L.approveApplication(a.id)
  assert.equal(ap.ok, true, ap.msg)
  return { ...shop, applicationId: a.id, contractId: ap.contractId }
}

test('入驻申请：新商户申请→审核签约，收取保证金并建商铺（园区不付建设费）', () => {
  const cashBefore = cash()
  const a = L.applyPartner({
    name: '测试联营奶茶', contact: '张三', phone: '139', type: '饮品', zone_id: 1,
    commission_rate: 0.25, settle_period_days: 7, deposit: 8000
  })
  assert.equal(a.ok, true, a.msg)
  const pending = L.listApplications({ status: 'applied' }).find(x => x.id === a.id)
  assert.equal(pending.vendor_id, null)

  const ap = L.approveApplication(a.id, { staffId: 9 })
  assert.equal(ap.ok, true, ap.msg)
  assert.ok(ap.vendorId)
  assert.equal(cash() - cashBefore, 8000, '仅收保证金，无 8000 建设费')
  assert.equal(finSum('商户保证金', 1), 8000)
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(ap.vendorId)
  assert.equal(v.rent, 0, '联营商铺无固定租金')
  assert.equal(L.isPartnerVendor(ap.vendorId), true)
  const c = L.listContracts({ vendorId: ap.vendorId })[0]
  assert.equal(c.commission_rate, 0.25)
  assert.equal(c.status, 'active')
})

test('入驻申请：重复申请拦截；驳回后可重新申请', () => {
  const { vid } = seedVendor()
  const a1 = L.applyPartner({ mode: 'existing', vendor_id: vid, name: '存量转联营', contact: '李四' })
  assert.equal(a1.ok, true, a1.msg)
  const a2 = L.applyPartner({ mode: 'existing', vendor_id: vid, name: '存量转联营2', contact: '王五' })
  assert.equal(a2.ok, false)
  assert.equal(a2.code, 'PENDING_APPLICATION')

  const rj = L.rejectApplication(a1.id, { reason: '资质待补' })
  assert.equal(rj.ok, true)
  const a3 = L.applyPartner({ mode: 'existing', vendor_id: vid, name: '存量转联营', contact: '王五' })
  assert.equal(a3.ok, true, a3.msg)
  const ap = L.approveApplication(a3.id)
  assert.equal(ap.ok, true, ap.msg)
})

test('销售分账：散客销售按扣点拆账并消耗库存（批次成本计入结算）', () => {
  const { vid, mat, contractId } = signFreshShop({ rate: 0.2 })
  const stockBefore = P.listMaterials().find(m => m.id === mat.id).qty_on_hand

  const cap = P.applyVendorSales(vid, 10, { partner: true })
  assert.equal(cap.sold, 10)
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  const gross = Math.round(cap.sold * v.price)
  const sale = L.recordSale(vid, { qty: cap.sold, gross, bill: gross, source: 'organic' })
  assert.equal(sale.bill, gross)
  assert.equal(sale.parkShare, Math.round(gross * 0.2))
  assert.equal(sale.merchantShare, gross - sale.parkShare)
  assert.equal(sale.discount, 0, '散客无会员优惠')

  // 库存按 partner_sale 流水扣减，可按 FEFO 批次成本汇总
  const after = P.listMaterials().find(m => m.id === mat.id).qty_on_hand
  assert.equal(after, stockBefore - 10)
  const cogs = P.partnerCogs(vid, 1, 1)
  assert.ok(cogs.cogs > 0, '批次成本应可汇总')
  assert.equal(cogs.cogs, 10 * mat.std_cost)
  const sm = db.prepare("SELECT reason FROM stock_movements WHERE vendor_id=? AND reason='partner_sale' LIMIT 1").get(vid)
  assert.ok(sm)
})

test('会员消费：联营成交按合同拆分扣点与会员优惠（商户全额承担折扣），与扣款同事务', () => {
  const { vid } = signFreshShop({ rate: 0.2, mdShare: 1 })
  // 会员1（金卡 discount_vendor=0.95）现金消费 4 份
  const r = M.vendorSpend(1, vid, { payMethod: 'cash', qty: 4 })
  assert.equal(r.ok, true, r.msg)
  assert.ok(r.partner, '应返回联营分账结果')
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  const gross = v.price * 4
  const bill = Math.round(gross * 0.95)
  assert.equal(r.bill, bill)
  // 商户应得 = 账单×80%；会员优惠由商户全额承担
  const row = db.prepare("SELECT * FROM partner_sales WHERE vendor_id=? AND kind='sale' AND source='member' ORDER BY id DESC LIMIT 1").get(vid)
  assert.equal(row.gross, gross)
  assert.equal(row.bill_amount, bill)
  assert.equal(row.member_discount, gross - bill)
  assert.equal(row.merchant_discount_borne, gross - bill)
  assert.equal(row.park_discount_borne, 0)
  assert.equal(row.merchant_share, Math.round(bill * 0.8))
})

test('会员优惠分摊：member_discount_share=0.5 时优惠商户/园方各承担一半', () => {
  const { vid } = signFreshShop({ rate: 0.3, mdShare: 0.5 })
  const r = M.vendorSpend(2, vid, { payMethod: 'cash', qty: 2 })  // 银卡 0.98
  assert.equal(r.ok, true, r.msg)
  const row = db.prepare("SELECT * FROM partner_sales WHERE vendor_id=? AND kind='sale' ORDER BY id DESC LIMIT 1").get(vid)
  assert.equal(row.merchant_discount_borne, Math.round(row.member_discount * 0.5))
  assert.equal(row.park_discount_borne, row.member_discount - row.merchant_discount_borne)
})

test('退货退款：回补库存（partner_sale_return）并红冲分账，账单按净额结算', () => {
  const { vid, mat } = signFreshShop({ rate: 0.2 })
  const stock0 = P.listMaterials().find(m => m.id === mat.id).qty_on_hand

  P.applyVendorSales(vid, 5, { partner: true })
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  const gross = 5 * v.price
  L.recordSale(vid, { qty: 5, gross, bill: gross, source: 'organic' })

  const ret = P.customerReturn(vid, 2, { partner: true })
  assert.equal(ret.ok, true, ret.msg)
  assert.equal(ret.refund, 2 * v.price)
  const pr = L.organicReturn(vid, 2, { refund: ret.refund })
  assert.equal(pr.ok, true, pr.msg)

  // 库存回补
  const stock1 = P.listMaterials().find(m => m.id === mat.id).qty_on_hand
  assert.equal(stock1, stock0 - 3)
  // 红冲后批次成本净额只算 3 份
  const cogs = P.partnerCogs(vid, 1, 1)
  assert.equal(cogs.cogs, 3 * mat.std_cost)
  // 净账单 = 3 份牌价
  const net = db.prepare("SELECT COALESCE(SUM(bill_amount),0) b, COALESCE(SUM(merchant_share),0) m FROM partner_sales WHERE vendor_id=? AND settlement_id=0").get(vid)
  assert.equal(net.b, 3 * v.price)
})

test('投诉处罚：联营商铺客诉现金补偿结案，按严重度罚没并计入账单', () => {
  const { vid } = signFreshShop({ rate: 0.2 })
  P.applyVendorSales(vid, 4, { partner: true })
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  L.recordSale(vid, { qty: 4, gross: 4 * v.price, bill: 4 * v.price, source: 'organic' })

  // 严重度 2、补偿 200 → 罚没 = max(150, round(200*1.5)=300) = 300
  const fine = L.levyComplaintFine({ id: 999, code: 'TS9999', target_type: 'vendor', target_id: vid, severity: 2, comp_cost: 200 })
  assert.ok(fine)
  assert.equal(fine.amount, 300)
  const fines = L.listFines({ vendorId: vid })
  assert.equal(fines[0].amount, 300)

  // 自营商铺不受罚
  const otherShop = freshShop()
  assert.equal(L.levyComplaintFine({ id: 998, target_type: 'vendor', target_id: otherShop.vid, severity: 2, comp_cost: 200 }), null)
})

test('周期账单：手动出账汇总（分账-批次成本-罚没），支付清偿应付', () => {
  const { vid, mat, contractId: cid } = signFreshShop({ rate: 0.2, period: 3, deposit: 0 })
  P.applyVendorSales(vid, 10, { partner: true })
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  const gross = 10 * v.price
  L.recordSale(vid, { qty: 10, gross, bill: gross, source: 'organic' })
  // 严重度 1 罚没保底 50；预期应付 = 分账 160 - 批次成本 60 - 罚没 50 = 50
  L.levyComplaintFine({ id: 901, code: 'TS9001', target_type: 'vendor', target_id: vid, severity: 1, comp_cost: 0 })

  const is = L.issueSettlement(cid)
  assert.equal(is.ok, true, is.msg)
  const detail = L.settlementDetail(is.id).settlement
  const expectedPayable = Math.round(gross * 0.8) - 10 * mat.std_cost - 50
  assert.equal(detail.merchant_share, Math.round(gross * 0.8))
  assert.equal(detail.cogs, 10 * mat.std_cost)
  assert.equal(detail.fines, 50)
  assert.equal(detail.payable, expectedPayable)
  assert.equal(detail.status, 'draft')

  const cashBefore = cash()
  const pay = L.paySettlement(is.id)
  assert.equal(pay.ok, true)
  assert.equal(cash() - cashBefore, -expectedPayable)
  assert.equal(finSum('商户结算', -1), -expectedPayable)
  // 已支付不能重复支付
  assert.equal(L.paySettlement(is.id).ok, false)
  // 流水已关联，不能重复出账
  const again = L.issueSettlement(cid)
  assert.equal(again.ok, false)
  assert.equal(again.code, 'EMPTY_PERIOD')
})

test('账单支付：现金不足自动挂账，资金到位后补付', () => {
  const { vid, contractId } = signFreshShop({ rate: 0.2, deposit: 0 })
  P.applyVendorSales(vid, 2, { partner: true })
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  L.recordSale(vid, { qty: 2, gross: 2 * v.price, bill: 2 * v.price, source: 'organic' })
  const is = L.issueSettlement(contractId)
  setSetting('cash', 0)
  const fail = L.paySettlement(is.id)
  assert.equal(fail.ok, false)
  assert.equal(fail.code, 'INSUFFICIENT_CASH')
  assert.equal(L.listSettlements({ status: 'overdue' }).some(s => s.id === is.id), true)
  setSetting('cash', 500000)
  const retry = L.retryOverdueSettlements()
  assert.equal(retry.count, 1)
  assert.equal(L.listSettlements({ status: 'paid' }).some(s => s.id === is.id), true)
})

test('自动出账：账期到期日结自动生成账单（不自动付款）', () => {
  const { vid, contractId } = signFreshShop({ rate: 0.2, period: 3, deposit: 0 })
  P.applyVendorSales(vid, 3, { partner: true })
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  L.recordSale(vid, { qty: 3, gross: 3 * v.price, bill: 3 * v.price, source: 'organic' })

  // 合同生效第 1 天，账期 3 天：第 3 天前不出账
  setSetting('day', 2)
  assert.deepEqual(L.autoIssueSettlements(2), [])
  setSetting('day', 3)
  const issued = L.autoIssueSettlements(3)
  assert.equal(issued.length, 1)
  const bill = L.listSettlements({}).find(s => s.id === issued[0])
  assert.equal(bill.status, 'draft', '自动出账不自动付款')
  assert.equal(bill.period_from, 1)
  assert.equal(bill.period_to, 3)
  // 幂等：已出账区间不会重复
  assert.deepEqual(L.autoIssueSettlements(3), [])
})

test('终止清算：保证金随清算账退还；扣没场景转园方收入', () => {
  // 场景 A：无违约，保证金退还（计入账单应付）
  const s1 = signFreshShop({ rate: 0.2, deposit: 5000 })
  P.applyVendorSales(s1.vid, 2, { partner: true })
  const vp = db.prepare('SELECT price FROM vendors WHERE id=?').get(s1.vid)
  L.recordSale(s1.vid, { qty: 2, gross: 2 * vp.price, bill: 2 * vp.price, source: 'organic' })
  const t1 = L.terminateContract(s1.contractId, { reason: '协议到期', forfeitDeposit: false })
  assert.equal(t1.ok, true, t1.msg)
  const b1 = L.settlementDetail(t1.settlementId).settlement
  assert.equal(b1.deposit_refund, 5000)
  assert.equal(b1.deposit_offset, 0)
  assert.ok(b1.payable >= 5000, '应付含保证金退还')
  assert.equal(b1.source, 'terminate')
  assert.equal(L.isPartnerVendor(s1.vid), false, '合同终止后不再视为联营中')

  // 场景 B：违约扣没保证金（无流水也应出清算账单）
  const s2 = signFreshShop({ rate: 0.25, deposit: 3000 })
  const t2 = L.terminateContract(s2.contractId, { reason: '严重违规', forfeitDeposit: true })
  assert.equal(t2.ok, true, t2.msg)
  const b2 = L.settlementDetail(t2.settlementId).settlement
  assert.equal(b2.deposit_offset, 3000)
  assert.equal(b2.deposit_refund, 0)
  assert.ok(finLogs.some(f => f.label === '商户罚没' && f.amount === 3000), '扣没保证金记罚没收入')
})

test('统计：联营待办/今日流水/累计支付口径正确', () => {
  const { vid, contractId } = signFreshShop({ rate: 0.2, deposit: 0 })
  P.applyVendorSales(vid, 4, { partner: true })
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  L.recordSale(vid, { qty: 4, gross: 4 * v.price, bill: 4 * v.price, source: 'organic' })
  const is = L.issueSettlement(contractId)
  const st0 = L.partnerStats()
  assert.equal(st0.contracts.active >= 1, true)
  // 全局口径含其他用例累计：断言新账单确实计入 draft 待付
  assert.ok(st0.bills.draft >= 1)
  const detail0 = L.settlementDetail(is.id).settlement
  const inDraft = L.listSettlements({ status: 'draft' }).some(s => s.id === is.id)
  assert.equal(inDraft, true)
  // 今日流水为全局累计：本单金额应包含在 today.bill 内
  assert.ok(st0.today.bill >= 4 * v.price)
  assert.equal(st0.bills.payable >= detail0.payable, true)

  const paidBefore = L.partnerStats().bills.paidToday
  L.paySettlement(is.id)
  const st1 = L.partnerStats()
  assert.equal(st1.bills.paidToday - paidBefore, detail0.payable)
  assert.equal(L.listSettlements({ status: 'paid' }).some(s => s.id === is.id), true)
})
