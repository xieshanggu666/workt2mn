// 供应商批次召回模块测试：
//  1) 发起召回：批次隔离停售（销售立即被限制）、受影响商铺登记、餐饮投诉与事件联动
//  2) 供应商受理 → 联营商户确认 → 自营/联营业主游客退货退款（联营红冲分账、问题品不回库）
//  3) 隔离批次退供应商（先冲应付、已付退现金）/ 现场销毁（核销物料成本）
//  4) 供应商赔付（货款损失+严重度罚则）→ 结案（关联投诉闭环）；未处置完不可结案
//  5) 撤销（待受理解除隔离恢复销售）；误报结案
// 运行：node --experimental-sqlite --test server/recalls.test.js（需 Node >= 22.5）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const P = await import('./procurement.js')
const R = await import('./recalls.js')

const finLogs = []
P.initProcurementContext({ logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }) })

const cash = () => Number(getSetting('cash'))

// 召回上下文：投诉建单/闭环、现金、财务、联营红冲与联营判定（用最小桩模拟 index.js 接线）
const closedComplaints = []
R.initRecallContext({
  day: () => Number(getSetting('day')),
  hour: () => 9,
  tick: () => Number(getSetting('tick')),
  deductCash: a => setSetting('cash', Number(getSetting('cash')) - a),
  addCash: a => setSetting('cash', Number(getSetting('cash')) + a),
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: ({ category, severity, title, content, target }) => {
    const id0 = db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source)
                            VALUES('',0,1,?,?,?,?,?,?,'open',999,'manual')`)
      .run(category, severity, title, content, target?.type || '', target?.id ?? null)
    const id = Number(id0.lastInsertRowid)
    db.prepare('UPDATE complaints SET code=? WHERE id=?').run('TS' + String(id).padStart(4, '0'), id)
    return { id }
  },
  closeComplaint: (cid, kind) => {
    db.prepare('UPDATE complaints SET status=? WHERE id=?').run(kind === 'recall_closed' ? 'closed_resolved' : 'closed_force', cid)
    closedComplaints.push({ cid, kind })
  },
  organicPartnerReturn: (vendorId, qty, { refund, complaintId, reason }) => {
    const c = db.prepare('SELECT id FROM partner_contracts WHERE vendor_id=? AND status=?').get(vendorId, 'active')
    if (!c) return { ok: false, code: 'NO_CONTRACT', msg: '无联营合同' }
    const id0 = db.prepare(`INSERT INTO partner_sales(code,vendor_id,contract_id,source,qty,gross,bill_amount,
                            merchant_share,park_share,kind,complaint_id,day,tick,note) VALUES('',?,?, 'organic',?,?,?,0,0,'return',?,1,0,?)`)
      .run(vendorId, c.id, -qty, -refund, -refund, complaintId || null, reason || '召回红冲')
    return { ok: true, id: Number(id0.lastInsertRowid), refund }
  },
  isPartnerVendor: vendorId => !!db.prepare("SELECT id FROM partner_contracts WHERE vendor_id=? AND status='active'", ).get(vendorId)
})

before(() => {
  setSetting('day', 1)
  setSetting('tick', 100)
  setSetting('cash', 500000)
  finLogs.length = 0
})

// 把某商铺的供货映射聚焦为单一物资（排除其他物资隔离/断货对本用例的连带影响）
function linkOnly(vid, mid) {
  db.prepare('DELETE FROM vendor_materials WHERE vendor_id=?').run(vid)
  db.prepare('INSERT INTO vendor_materials(vendor_id,material_id) VALUES(?,?)').run(vid, mid)
}

// 把某物资的可用在库批次清空到指定数量之外（便于构造确定的隔离量），返回物资与首个商铺
function setup(matKeyword) {
  const m = P.listMaterials().find(x => x.name.includes(matKeyword))
  const vid = m.vendors[0].id
  return { m, vid }
}

test('基础：采购模块种子数据可用', () => {
  assert.ok(P.listMaterials().length >= 8)
  assert.ok(P.listSuppliers().length >= 4)
})

test('发起召回：批次隔离立即停售、登记受影响商铺、生成投诉与事件', () => {
  const { m, vid } = setup('爆米花')
  const before = P.listMaterials().find(x => x.id === m.id).physical_qty
  const capBefore = P.vendorSaleable(vid, 5)
  assert.equal(capBefore.sold, 5)

  const r = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '检出大肠菌群超标', severity: 3 })
  assert.equal(r.ok, true)
  assert.ok(r.batchQty > 0)
  // 在库总量不变（隔离不核减库存，仅转为隔离量），可售量（qty_on_hand）清零
  const after = P.listMaterials().find(x => x.id === m.id)
  assert.equal(after.physical_qty, before, '隔离不改变库存实物总量')
  assert.equal(after.quarantined_qty, r.batchQty)
  assert.equal(after.qty_on_hand, 0, '隔离后可售量为 0')
  // 但可售量清零（隔离批次被排除出 FEFO）
  const capAfter = P.vendorSaleable(vid, 5)
  assert.equal(capAfter.sold, 0, '隔离后该物资全部不可售')
  assert.ok(capAfter.lost > 0, '需求转为缺货流失')

  const d = R.recallDetail(r.id).recall
  assert.equal(d.status, 'issued')
  assert.equal(d.affected_vendor_count, d.vendors.length)
  assert.ok(d.vendors.some(v => v.vendor_id === vid))
  assert.ok(d.complaint_id, '应联动生成餐饮投诉')
  const comp = db.prepare('SELECT * FROM complaints WHERE id=?').get(d.complaint_id)
  assert.equal(comp.category, 'food')
  assert.equal(comp.severity, 3)
  assert.equal(comp.target_id, vid)
  assert.ok(db.prepare("SELECT * FROM events WHERE type='recall' AND id=?").get(d.event_id), '应生成召回事件通知')
})

test('同一批次不能被重复召回隔离', () => {
  const m = P.listMaterials().find(x => x.name.includes('热狗肠'))
  const r1 = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '首次召回', severity: 1 })
  assert.equal(r1.ok, true)
  const bid = db.prepare('SELECT id FROM inbound_batches WHERE recall_id=? LIMIT 1').get(r1.id).id
  const r2 = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, batches: [{ batch_id: bid }], reason: '重复召回', severity: 1 })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'BATCH_QUARANTINED')
})

test('无在库批次的物资不能发起全量召回', () => {
  const m = P.listMaterials().find(x => x.name.includes('一次性杯'))
  // 清空全部批次余量与隔离
  db.prepare("UPDATE inbound_batches SET status='closed', qty_remain=0, quarantined_qty=0, recall_id=NULL WHERE material_id=?", ).run(m.id)
  db.prepare('UPDATE inventory SET qty_on_hand=0 WHERE material_id=?').run(m.id)
  const r = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '无库存召回', severity: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_STOCK')
})

test('召回协同闭环：受理→自营退货退款（园方退现金、问题品不回库）→ 销毁→赔付→结案', () => {
  const m = P.listMaterials().find(x => x.name.includes('热狗面包胚'))
  const vid = m.vendors[0].id
  linkOnly(vid, m.id)
  // 先产生 3 份自营销售（净售出）
  P.applyVendorSales(vid, 3)
  const stockAfterSale = P.listMaterials().find(x => x.id === m.id).physical_qty

  const r = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '面包胚霉变', severity: 2 })
  const id = r.id
  // 受影响商铺净售出 >= 3（可能含其他用例前的销售，至少包含本次）
  const rv = R.recallDetail(id).recall.vendors.find(v => v.vendor_id === vid)
  assert.ok(rv.sold_qty >= 3)

  // 待受理状态下结案不允许（批次未处置）
  assert.equal(R.closeRecall(id).ok, false)
  // 供应商受理
  assert.equal(R.acceptRecall(id).ok, true)
  assert.equal(R.acceptRecall(id).ok, false, '不能重复受理')

  // 自营商铺为 3 份办理退货退款
  const cash0 = cash()
  const vendor = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  const refundQty = 3
  const rr = R.vendorRefund(id, vid, refundQty)
  assert.equal(rr.ok, true)
  assert.equal(rr.partner, false)
  assert.equal(rr.refund, refundQty * vendor.price)
  assert.equal(cash(), cash0 - refundQty * vendor.price, '自营退款园方退现金')
  // 问题品不回库：在库实物总量不变
  assert.equal(P.listMaterials().find(x => x.id === m.id).physical_qty, stockAfterSale, '召回退货不回补库存')
  // recall_refund 流水冲减净售出，超量退款被拒绝
  assert.equal(R.vendorRefund(id, vid, rv.sold_qty + 999).ok, false)

  // 现场销毁全部隔离批次（采购期初批次，无采购单）
  const detail = R.recallDetail(id).recall
  const remain = detail.remain_quarantine
  const cashD = cash()
  const dr = R.destroyBatches(id, remain)
  assert.equal(dr.ok, true)
  assert.equal(dr.qty, remain)
  assert.ok(dr.cost > 0)
  assert.equal(cash(), cashD - dr.cost, '销毁核销物料成本')

  // 供应商赔付（含严重度罚则）
  const quote = R.compensationQuote(id)
  assert.equal(quote.remainStockCost, 0, '批次已全部处置')
  assert.ok(quote.suggested >= dr.cost + rr.refund)
  const cashP = cash()
  const cp = R.payCompensation(id, quote.suggested)
  assert.equal(cp.ok, true)
  assert.equal(cash(), cashP + quote.suggested)
  assert.ok(cp.penalty > 0, '严重(2)召回应有 20% 罚则')

  // 结案：关联投诉闭环
  const cl = R.closeRecall(id)
  assert.equal(cl.ok, true)
  assert.equal(R.recallDetail(id).recall.status, 'closed')
  const comp = db.prepare('SELECT status FROM complaints WHERE id=?').get(R.recallDetail(id).recall.complaint_id)
  assert.equal(comp.status, 'closed_resolved')
  assert.ok(closedComplaints.some(x => x.kind === 'recall_closed'))
  // 结案后不能再操作
  assert.equal(R.vendorRefund(id, vid, 1).ok, false)
})

test('联营商铺：园方代付游客退款并红冲分账；商户需先确认', () => {
  const m = P.listMaterials().find(x => x.name.includes('柠檬糖浆'))
  const vid = m.vendors[0].id
  linkOnly(vid, m.id)
  // 建立联营合同
  db.prepare(`INSERT INTO partner_contracts(application_id,vendor_id,commission_rate,member_discount_share,settle_period_days,deposit,start_day,status,sign_day,sign_tick)
              VALUES(NULL,?,0.2,1,7,0,1,'active',1,0)`).run(vid)
  // 联营销售 4 份（partner 标记）
  P.applyVendorSales(vid, 4, { partner: true })

  const r = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '糖浆过期重新贴标', severity: 3 })
  const id = r.id
  const rvRow = R.recallDetail(id).recall.vendors.find(v => v.vendor_id === vid)
  assert.equal(rvRow.is_partner, 1)

  // 联营商户确认知悉
  assert.equal(R.acknowledgeVendor(id, vid).ok, true)
  // 自营商户确认被拒
  const selfVid = R.recallDetail(id).recall.vendors.find(v => !v.is_partner)?.vendor_id
  if (selfVid) assert.equal(R.acknowledgeVendor(id, selfVid).ok, false)

  // 园方代付 4 份游客退款，并写负向红冲行
  const redBefore = db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return'").get().n
  const rr = R.vendorRefund(id, vid, 4)
  assert.equal(rr.ok, true)
  assert.equal(rr.partner, true)
  const redAfter = db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return'").get().n
  assert.equal(redAfter, redBefore + 1, '应新增一条联营红冲行')
  const red = db.prepare("SELECT * FROM partner_sales WHERE kind='return' ORDER BY id DESC LIMIT 1").get()
  assert.equal(red.bill_amount, -rr.refund)
  assert.equal(red.complaint_id, R.recallDetail(id).recall.complaint_id)
  // 库存未回补
  const mv = db.prepare("SELECT change,reason FROM stock_movements WHERE ref_type='recall' AND ref_id=? AND vendor_id=? ORDER BY id DESC LIMIT 1").get(id, vid)
  assert.equal(mv.reason, 'recall_refund')
  assert.equal(mv.change, 4)

  // 清理：销毁隔离批次 + 赔付 + 结案，避免影响其他用例的在途统计
  const remain = R.recallDetail(id).recall.remain_quarantine
  if (remain > 0) R.destroyBatches(id, remain)
  const q = R.compensationQuote(id)
  R.payCompensation(id, q.suggested)
  assert.equal(R.closeRecall(id).ok, true)
})

test('隔离批次退供应商：先冲未付应付、已付部分现金退回', () => {
  const sup = P.listSuppliers().find(s => s.category === '文创百货')
  const m = P.listMaterials().find(x => x.name.includes('益智玩具'))
  // 下一单 10 个并收货（账期供应商不即付）
  const o = P.createOrder({ supplier_id: sup.id, items: [{ material_id: m.id, qty: 10, unit_cost: 15 }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  const itemId = P.orderDetail(o.id).order.items[0].id
  P.receiveOrder(o.id, [{ item_id: itemId, qty: 10 }])
  const newBatch = db.prepare('SELECT * FROM inbound_batches WHERE order_id=? ORDER BY id DESC LIMIT 1').get(o.id)

  const r = R.createRecall({ supplier_id: sup.id, material_id: m.id, batches: [{ batch_id: newBatch.id }], reason: '小零件松脱', severity: 2 })
  const id = r.id
  R.acceptRecall(id)
  // 该单未付款：退 6 个应全部冲应付，不退现金
  const cash0 = cash()
  const res1 = R.returnBatches(id, 6)
  assert.equal(res1.ok, true)
  assert.equal(res1.amount, 90)
  assert.equal(res1.creditApplied, 90)
  assert.equal(res1.cashBack, 0)
  assert.equal(cash(), cash0)
  const order = P.orderDetail(o.id).order
  assert.equal(order.outstanding, 150 - 90, '150 应付冲减 90 后余 60')

  // 先付清剩余 60，再退剩余 4 个 → 现金退回
  P.payOrder(o.id, 60)
  const cash1 = cash()
  const res2 = R.returnBatches(id, 4)
  assert.equal(res2.ok, true)
  assert.equal(res2.amount, 60)
  assert.equal(res2.cashBack, 60)
  assert.equal(cash(), cash1 + 60)
  assert.equal(R.recallDetail(id).recall.remain_quarantine, 0)

  // 有受影响商铺净售出但未退款/未确认时，结案被拦截
  // 先将受影响商铺标记为"无在途/线下已退"（本用例聚焦批次货款，不模拟游客退款）
  for (const v of R.recallDetail(id).recall.vendors) {
    if (v.remain_qty > 0 && ['notified', 'acknowledged'].includes(v.status)) {
      assert.equal(R.markVendorNone(id, v.vendor_id).ok, true)
    }
  }

  // 批次已结清、商铺均已处置，可结案
  const q = R.compensationQuote(id)
  if (q.suggested > 0) R.payCompensation(id, q.suggested)
  assert.equal(R.closeRecall(id).ok, true)
})

test('结案护栏：存在未处置隔离批次或未退款商铺时不可结案', () => {
  // 新建独立采购批次并显式重建商铺映射，避免与其他用例相互影响
  const sup = P.listSuppliers().find(s => s.category === '食材')
  const m = P.listMaterials().find(x => x.name.includes('热狗肠'))
  let vid = m.vendors[0]?.id
  if (!vid) {
    vid = db.prepare('SELECT id FROM vendors ORDER BY id LIMIT 1').get().id
    linkOnly(vid, m.id)
  } else {
    linkOnly(vid, m.id)
  }
  const o = P.createOrder({ supplier_id: sup.id, items: [{ material_id: m.id, qty: 12, unit_cost: 4 }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  const itemId = P.orderDetail(o.id).order.items[0].id
  P.receiveOrder(o.id, [{ item_id: itemId, qty: 12 }])
  const newBatch = db.prepare('SELECT id FROM inbound_batches WHERE order_id=? ORDER BY id DESC LIMIT 1').get(o.id)
  P.applyVendorSales(vid, 2)
  const r = R.createRecall({ supplier_id: sup.id, material_id: m.id, batches: [{ batch_id: newBatch.id }], reason: '护栏测试', severity: 2 })
  const id = r.id
  // 批次未处置 → 拦截
  assert.equal(R.closeRecall(id).code, 'STOCK_REMAIN')
  R.acceptRecall(id)
  const remain = R.recallDetail(id).recall.remain_quarantine
  R.destroyBatches(id, remain)
  // 批次处置完但商铺有净售出未退款 → 拦截 REFUND_PENDING
  const rv = R.recallDetail(id).recall.vendors.find(v => v.vendor_id === vid)
  if (rv && rv.remain_qty > 0) {
    assert.equal(R.closeRecall(id).code, 'REFUND_PENDING')
    // 退款后放行
    assert.equal(R.vendorRefund(id, vid, rv.remain_qty).ok, true)
  }
  R.payCompensation(id, R.compensationQuote(id).suggested)
  assert.equal(R.closeRecall(id).ok, true)
})

test('撤销待受理召回：解除隔离恢复销售；误报结案同口径', () => {
  const m = P.listMaterials().find(x => x.name.includes('纪念 T 恤') || x.name.includes('T 恤'))
  const vid = m.vendors[0].id
  const saleable0 = P.vendorSaleable(vid, 1).sold
  const r = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '疑似异味待复检', severity: 1 })
  assert.equal(P.vendorSaleable(vid, 1).sold, 0, '隔离后停售')
  const cancel = R.cancelRecall(r.id, '复检合格，撤销')
  assert.equal(cancel.ok, true)
  assert.equal(cancel.released, r.batchQty)
  assert.equal(R.recallDetail(r.id).recall.status, 'cancelled')
  // 恢复可售
  assert.equal(P.vendorSaleable(vid, 1).sold, Math.min(1, saleable0) === 0 ? 0 : 1, '撤销后恢复销售')
  // recall_id 已清空、隔离量归零
  assert.equal(db.prepare('SELECT COALESCE(SUM(quarantined_qty),0) q FROM inbound_batches WHERE recall_id=?').get(r.id).q, 0)
  // 关联投诉被中性关闭
  const cid = R.recallDetail(r.id).recall.complaint_id
  assert.equal(db.prepare('SELECT status FROM complaints WHERE id=?').get(cid).status, 'closed_force')

  // 另一起：受理后只能误报结案
  const m2 = P.listMaterials().find(x => x.name.includes('主题公仔') || x.name.includes('公仔'))
  const r2 = R.createRecall({ supplier_id: m2.preferred_supplier_id, material_id: m2.id, reason: '误报复检', severity: 1 })
  R.acceptRecall(r2.id)
  assert.equal(R.cancelRecall(r2.id).ok, false, '受理后不可撤销')
  const f = R.closeFalseRecall(r2.id, '第三方复检合格')
  assert.equal(f.ok, true)
  assert.equal(R.recallDetail(r2.id).recall.status, 'closed_false')
  assert.ok(f.released > 0)
})

test('统计口径与详情', () => {
  const s = R.recallStats()
  assert.ok(s.open >= 0)
  assert.ok(s.refundTotal > 0, '有用例产生过游客退款')
  assert.ok(s.compensationTotal > 0, '有用例收到过赔付')
  const list = R.listRecalls({ status: 'closed' })
  assert.ok(list.length >= 3)
  const d = R.recallDetail(list[0].id)
  assert.ok(d.logs.length >= 2)
  assert.ok(d.quote)
})

// ---- 联营退款失败 → 统一补偿队列重试：现金/红冲账单/库存留痕一次到位，人工已退不重复 ----
test('联营召回退款失败补偿：QUEUED 后引擎重试红冲成功，重复执行不重复退款/红冲', async () => {
  const COMP = await import('./compensation.js')
  const m = P.listMaterials().find(x => x.name.includes('一次性杯'))
  const vid = m.vendors[0]?.id || db.prepare('SELECT id FROM vendors ORDER BY id LIMIT 1').get().id
  linkOnly(vid, m.id)
  // 前序用例可能已消耗该物资库存：下一笔 10 个收货，保证有 5 个可售可召回
  const po = P.createOrder({ supplier_id: m.preferred_supplier_id, items: [{ material_id: m.id, qty: 10, unit_cost: m.std_cost || 1 }] })
  P.submitOrder(po.id); P.approveOrder(po.id)
  const itId = P.orderDetail(po.id).order.items[0].id
  P.receiveOrder(po.id, [{ item_id: itId, qty: 10 }])
  db.prepare(`INSERT INTO partner_contracts(application_id,vendor_id,commission_rate,member_discount_share,settle_period_days,deposit,start_day,status,sign_day,sign_tick)
              VALUES(NULL,?,0.2,1,7,0,1,'active',1,0)`).run(vid)
  P.applyVendorSales(vid, 5, { partner: true })

  const r = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '杯材回收料超标', severity: 2 })
  const id = r.id
  R.acknowledgeVendor(id, vid)
  const rvRow = R.recallDetail(id).recall.vendors.find(v => v.vendor_id === vid)
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  const refund5 = 5 * v.price
  const cashBefore = cash()
  const redBefore = db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return'").get().n

  // vendorRefund 在红冲/现金事务失败时会把该退款挂入统一补偿队列（enqueueDetached）；
  // 这里直接挂载同构任务，验证补偿处理器的恢复路径（现金代付 + 红冲 + 库存留痕）：
  const q = COMP.enqueueDetached({
    domain: 'partner', action: 'partner_recall_refund',
    idemKey: `recall:${id}:rv:${rvRow.id}:qty:5`,
    refType: 'recall_vendor', refId: rvRow.id, priority: 2, source: 'retry',
    payload: { recallId: id, recallVendorId: rvRow.id, vendorId: vid, qty: 5, isPartner: true },
    note: '测试挂载联营退款补偿'
  })
  assert.equal(q.ok, true)

  // 引擎执行：现金代付 + 红冲行 + 库存留痕
  const stats = COMP.runCompensations()
  assert.equal(stats.done, 1, stats.failed ? '补偿应成功' : '')
  assert.equal(cash(), cashBefore - refund5, '园方代付游客退款现金扣减一次')
  const redAfter = db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return'").get().n
  assert.equal(redAfter, redBefore + 1, '红冲行写入一条（结转下张联营账单）')
  const red = db.prepare("SELECT * FROM partner_sales WHERE kind='return' ORDER BY id DESC LIMIT 1").get()
  assert.equal(red.settlement_id, 0, '红冲未出账，结转下张结算账单净额冲减')
  assert.equal(red.bill_amount, -refund5)
  const rvAfter = db.prepare('SELECT * FROM recall_vendors WHERE id=?').get(rvRow.id)
  assert.equal(rvAfter.refund_qty, 5)
  assert.equal(rvAfter.refund_amount, refund5)

  // 任务已 done；再次引擎扫描不重复退款/红冲
  COMP.runCompensations()
  assert.equal(cash(), cashBefore - refund5, '现金不得二次扣减')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return'").get().n, redBefore + 1, '不得重复红冲')

  // 清理现场
  const remain = R.recallDetail(id).recall.remain_quarantine
  if (remain > 0) R.destroyBatches(id, remain)
  R.payCompensation(id, R.compensationQuote(id).suggested)
  assert.equal(R.closeRecall(id).ok, true)
})

test('联营退款补偿幂等：人工已先行退款后任务重试自动作废，不重复退款/红冲', async () => {
  const COMP = await import('./compensation.js')
  const m = P.listMaterials().find(x => x.name.includes('爆米花原料'))
  const vid = m.vendors[0]?.id || db.prepare('SELECT id FROM vendors ORDER BY id LIMIT 1').get().id
  linkOnly(vid, m.id)
  const po = P.createOrder({ supplier_id: m.preferred_supplier_id, items: [{ material_id: m.id, qty: 10, unit_cost: m.std_cost || 6 }] })
  P.submitOrder(po.id); P.approveOrder(po.id)
  const itId = P.orderDetail(po.id).order.items[0].id
  P.receiveOrder(po.id, [{ item_id: itId, qty: 10 }])
  db.prepare(`INSERT INTO partner_contracts(application_id,vendor_id,commission_rate,member_discount_share,settle_period_days,deposit,start_day,status,sign_day,sign_tick)
              VALUES(NULL,?,0.2,1,7,0,1,'active',1,0)`).run(vid)
  P.applyVendorSales(vid, 3, { partner: true })
  const r = R.createRecall({ supplier_id: m.preferred_supplier_id, material_id: m.id, reason: '人工先行测试', severity: 1 })
  const id = r.id
  R.acknowledgeVendor(id, vid)
  const rvRow = R.recallDetail(id).recall.vendors.find(x => x.vendor_id === vid)
  const v = db.prepare('SELECT price FROM vendors WHERE id=?').get(vid)
  const cashBefore = cash()

  // 挂载补偿任务后，人工先在业务侧完成退款（含红冲）
  const q = COMP.enqueueDetached({
    domain: 'partner', action: 'partner_recall_refund',
    idemKey: `recall:${id}:rv:${rvRow.id}:qty:3`,
    refType: 'recall_vendor', refId: rvRow.id, priority: 2,
    payload: { recallId: id, recallVendorId: rvRow.id, vendorId: vid, qty: 3, isPartner: true }
  })
  const manual = R.vendorRefund(id, vid, 3)
  assert.equal(manual.ok, true)
  const cashAfterManual = cash()
  assert.equal(cashAfterManual, cashBefore - 3 * v.price)

  // 引擎重试：处理器发现可退数量不足（人工已退）→ obsolete，不重复退款/红冲
  const stats = COMP.runCompensations()
  assert.equal(stats.obsolete, 1)
  assert.equal(cash(), cashAfterManual, '现金不得二次扣减')
  // 仅统计本次召回本铺产生的红冲（全局红冲表含前序用例数据）
  const redCount = db.prepare("SELECT COUNT(*) n FROM partner_sales WHERE kind='return' AND vendor_id=? AND complaint_id=?").get(vid, r.complaintId ?? R.recallDetail(id).recall.complaint_id).n
  assert.equal(redCount, 1, '仅人工那一条红冲')
  const t = db.prepare('SELECT status FROM compensation_tasks WHERE id=?').get(q.id)
  assert.equal(t.status, 'obsolete')

  const remain = R.recallDetail(id).recall.remain_quarantine
  if (remain > 0) R.destroyBatches(id, remain)
  R.payCompensation(id, R.compensationQuote(id).suggested)
  R.closeRecall(id)
})
