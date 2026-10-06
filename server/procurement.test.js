// 园区物资采购与库存模块测试：
//  1) 商铺销售联动：FEFO 批次扣减、缺货限销+流失记录、断货会员消费整单回滚
//  2) 采购单全生命周期：草稿→提交→批准→自动/手动收货（批次/保质期/标准成本）→账期付款→结算
//  3) 退货：采购退货冲应付/现金退回并回减库存；销售退货回补+退款
//  4) 财务一致性：付款现金扣减与流水一致；现金不足货到即付转挂账异常
//  5) 盘点：盘亏扣批次+物料成本流水，盘盈入库
//  6) 临期/过期报损、缺货自动补货草稿幂等、异常对账闭环
// 运行：node --experimental-sqlite --test server/procurement.test.js（需 Node >= 22.5）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const P = await import('./procurement.js')

const finLogs = []
P.initProcurementContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail })
})

const cash = () => Number(getSetting('cash'))
const refreshMat = x => { const id = x && typeof x === 'object' ? x.id : x; return P.listMaterials().find(m => m.id === id) }
const finSum = (label, sign = -1) => finLogs.filter(f => f.label === label).reduce((s, f) => s + (sign < 0 ? Math.min(0, f.amount) : Math.max(0, f.amount)), 0)

before(() => {
  setSetting('day', 1)
  setSetting('tick', 0)
  setSetting('cash', 500000)
  finLogs.length = 0
})

// 用例间共享同一内存库（基础数据只播种一次）：每个用例前重置时钟与现金，断言一律用相对差值
test.beforeEach(() => {
  setSetting('day', 1)
  setSetting('tick', 100)
  setSetting('cash', 500000)
})

test('基础数据：供应商/物资/期初批次自动补齐且有库存', () => {
  assert.ok(P.listSuppliers().length >= 4)
  const mats = P.listMaterials()
  assert.ok(mats.length >= 8)
  for (const m of mats) assert.ok(m.qty_on_hand > 0, `${m.name} 应有期初库存`)
  // 商铺已按类型挂供货物资
  const pop = mats.find(m => m.name.includes('爆米花'))
  assert.ok(pop.vendors.some(v => v.name.includes('爆米花')))
})

test('商铺销售：FEFO 扣减库存，需求超过库存时限销并记录缺货流失', () => {
  const pop = refreshMat(P.listMaterials().find(m => m.name.includes('爆米花')).id)
  const vid = pop.vendors[0].id
  const before = pop.qty_on_hand
  const cap = P.applyVendorSales(vid, 3)
  assert.equal(cap.sold, 3)
  assert.equal(cap.lost, 0)
  assert.equal(refreshMat(pop.id).qty_on_hand, before - 3)

  // 超大需求：只卖掉剩余，其余流失，生成缺货异常
  const big = P.applyVendorSales(vid, 99999)
  assert.ok(big.sold > 0)
  assert.ok(big.lost > 0)
  assert.equal(refreshMat(pop.id).qty_on_hand, 0)
  assert.equal(refreshMat(pop.id).stock_status, 'out')
  const shortage = P.listInventoryFindings({ type: 'shortage' }).find(f => f.material_id === pop.id)
  assert.ok(shortage, '缺货应生成异常对账记录')
  assert.equal(shortage.severity, 'critical')
  const lost = db.prepare('SELECT COALESCE(SUM(qty_lost),0) q FROM stock_lost_sales WHERE vendor_id=?').get(vid).q
  assert.ok(lost >= big.lost - 0.01)
})

test('FEFO：先到期先出，销售不扣已过期批次', () => {
  const m = refreshMat(P.listMaterials().find(x => x.name.includes('柠檬糖浆')))
  const vid = m.vendors[0].id
  // 建一个次日到期批次（+10）和一个远期批次（+10），库存总量 +20
  const day = Number(getSetting('day'))
  const ins = db.prepare(`INSERT INTO inbound_batches(material_id,supplier_id,qty_received,qty_remain,unit_cost,receive_day,expire_day,status)
                          VALUES(?,?,10,10,3,?,?, 'in')`)
  ins.run(m.id, m.preferred_supplier_id, day, day + 1)
  const nearId = db.prepare('SELECT MAX(id) i FROM inbound_batches').get().i
  ins.run(m.id, m.preferred_supplier_id, day, day + 60)
  db.prepare(`INSERT INTO inventory(material_id,qty_on_hand,updated_tick) VALUES(?,?,100)
              ON CONFLICT(material_id) DO UPDATE SET qty_on_hand=qty_on_hand+20`).run(m.id, 100)
  const stockBefore = refreshMat(m.id).qty_on_hand
  P.applyVendorSales(vid, 5)
  assert.equal(db.prepare('SELECT qty_remain FROM inbound_batches WHERE id=?').get(nearId).qty_remain, 5, '应先消耗临期批次')
  assert.equal(refreshMat(m.id).qty_on_hand, stockBefore - 5)

  // 临期批过期后：可售量不含它；销售只走其他未过期批次，过期批次保持不变
  setSetting('day', day + 2)
  const matsNow = P.listMaterials()
  const linkedIds = db.prepare('SELECT material_id FROM vendor_materials WHERE vendor_id=?').all(vid).map(x => x.material_id)
  const expected = Math.min(...linkedIds.map(id => matsNow.find(x => x.id === id).qty_on_hand))
  const cap = P.applyVendorSales(vid, 99999)
  assert.equal(cap.sold, expected, '断货销量 = 各挂供物资未过期可用量的最小值')
  assert.ok(cap.sold < stockBefore - 5, '过期临期批次不计入可售')
  assert.equal(db.prepare('SELECT qty_remain FROM inbound_batches WHERE id=?').get(nearId).qty_remain, 5, '过期批次保持不被动')
})

test('采购单全流程：创建校验 → 提交 → 批准 → 收货入账（账期供应商不即付）', () => {
  const sup = P.listSuppliers().find(s => s.category === '文创百货')  // 账期 30 天
  const toy = refreshMat(P.listMaterials().find(x => x.name.includes('公仔')).id)
  const stock0 = toy.qty_on_hand
  // 非法：无供应商/空明细/数量 0
  assert.equal(P.createOrder({ supplier_id: 99999, items: [] }).ok, false)
  assert.equal(P.createOrder({ supplier_id: sup.id, items: [{ material_id: toy.id, qty: 0 }] }).ok, false)

  const o = P.createOrder({ supplier_id: sup.id, source: 'shop', vendor_id: toy.vendors[0]?.id, items: [{ material_id: toy.id, qty: 20, unit_cost: 18 }] })
  assert.equal(o.ok, true)
  let d = P.orderDetail(o.id).order
  assert.equal(d.status, 'draft')
  assert.equal(d.total_amount, 360)
  assert.equal(P.approveOrder(o.id).ok, false, '草稿不能直接批准')
  assert.equal(P.submitOrder(o.id).ok, true)
  assert.equal(P.submitOrder(o.id).ok, false, '不能重复提交')
  assert.equal(P.approveOrder(o.id).ok, true)
  d = P.orderDetail(o.id).order
  assert.equal(d.status, 'approved')
  assert.equal(d.pay_due_day, Number(getSetting('day')) + 30)

  const itemId = d.items[0].id
  // 超收拒绝
  assert.equal(P.receiveOrder(o.id, [{ item_id: itemId, qty: 21 }]).ok, false)
  // 分批收货：先收 8
  const r1 = P.receiveOrder(o.id, [{ item_id: itemId, qty: 8 }])
  assert.equal(r1.ok, true)
  d = P.orderDetail(o.id).order
  assert.equal(d.status, 'partial')
  assert.equal(d.paid_amount, 0, '账期供应商收货不应即付')
  assert.equal(refreshMat(toy.id).qty_on_hand, stock0 + 8)
  // 收齐
  assert.equal(P.receiveOrder(o.id, [{ item_id: itemId, qty: 12 }]).ok, true)
  d = P.orderDetail(o.id).order
  assert.equal(d.status, 'received')
  assert.equal(d.outstanding, 360)
  // 标准成本回写
  assert.equal(refreshMat(toy.id).std_cost, 18)
  // 批次携带保质期（文创无保质期 expire_day=0）
  const batches = P.orderDetail(o.id).batches
  assert.equal(batches.length, 2)
  assert.equal(batches[0].expire_day, 0)
})

test('账期付款：现金扣减+流水+结清状态；超额付款拒绝', () => {
  const sup = P.listSuppliers().find(s => s.category === '文创百货')
  const mat = refreshMat(P.listMaterials().find(x => x.name.includes('T 恤') || x.name.includes('纪念 T')))
  const o = P.createOrder({ supplier_id: sup.id, items: [{ material_id: mat.id, qty: 7, unit_cost: 20 }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  const itemId = P.orderDetail(o.id).order.items[0].id
  P.receiveOrder(o.id, [{ item_id: itemId, qty: 7 }])
  const po = P.orderDetail(o.id).order
  assert.equal(po.status, 'received')
  const cash0 = cash()
  assert.equal(P.payOrder(po.id, po.outstanding + 1).ok, false, '不允许超额付款')
  const r = P.payOrder(po.id, po.outstanding)
  assert.equal(r.ok, true)
  assert.equal(r.paid, 140)
  assert.equal(cash(), cash0 - 140)
  const d = P.orderDetail(po.id).order
  assert.equal(d.status, 'settled')
  assert.equal(d.outstanding, 0)
  assert.equal(P.payOrder(po.id, 10).code, 'NOTHING_DUE')
  assert.ok(finLogs.some(f => f.detail.includes(po.code) && f.amount === -140), '应有 140 元采购付款流水')
})

test('货到即付供应商：收货即付款，现金不足转应付异常', () => {
  const sup = P.listSuppliers().find(s => s.category === '饮品原料') // 账期 0
  assert.equal(sup.pay_term_days, 0)
  const syr = refreshMat(P.listMaterials().find(x => x.name.includes('柠檬')).id)
  setSetting('cash', 1000)
  const cash0 = cash()
  const o = P.createOrder({ supplier_id: sup.id, items: [{ material_id: syr.id, qty: 50, unit_cost: 3 }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  const itemId = P.orderDetail(o.id).order.items[0].id
  const r = P.receiveOrder(o.id, [{ item_id: itemId, qty: 50 }])
  assert.equal(r.ok, true)
  assert.equal(r.amount, 150)
  assert.equal(cash(), cash0 - 150, '货到即付应立即扣款')
  let d = P.orderDetail(o.id).order
  assert.equal(d.status, 'settled')

  // 现金不足：再下一单，付款挂账并生成 payable 异常，库存仍正常入
  const o2 = P.createOrder({ supplier_id: sup.id, items: [{ material_id: syr.id, qty: 99999, unit_cost: 3 }] })
  P.submitOrder(o2.id); P.approveOrder(o2.id)
  const item2 = P.orderDetail(o2.id).order.items[0].id
  const cashBefore = cash()
  const r2 = P.receiveOrder(o2.id, [{ item_id: item2, qty: 99999 }])
  assert.equal(r2.ok, true, '收货本身成功（付款挂账）')
  assert.equal(cash(), cashBefore, '现金不足时不扣款')
  d = P.orderDetail(o2.id).order
  assert.equal(d.outstanding, 99999 * 3)
  const finding = P.listInventoryFindings({ type: 'payable' }).find(f => f.order_id === o2.id)
  assert.ok(finding, '现金不足应登记应付异常')
})

test('采购退货：未付单冲应付、已付单现金退回，库存回减', () => {
  const sup = P.listSuppliers().find(s => s.category === '食材')
  const bread = refreshMat(P.listMaterials().find(x => x.name.includes('面包胚')).id)
  // 未付账期场景（食材账期 7 天）
  const o = P.createOrder({ supplier_id: sup.id, items: [{ material_id: bread.id, qty: 10, unit_cost: 5 }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  const itemId = P.orderDetail(o.id).order.items[0].id
  P.receiveOrder(o.id, [{ item_id: itemId, qty: 10 }])
  const stock0 = refreshMat(bread.id).qty_on_hand
  const cash0 = cash()
  const r = P.purchaseReturn({ order_id: o.id, material_id: bread.id, qty: 4, reason: '霉变' })
  assert.equal(r.ok, true)
  assert.equal(r.amount, 20)
  assert.equal(r.cashBack, 0, '未付款单只冲应付，不退现金')
  assert.equal(cash(), cash0)
  assert.equal(refreshMat(bread.id).qty_on_hand, stock0 - 4)
  const d = P.orderDetail(o.id).order
  assert.equal(d.outstanding, 30, '50-20=30')

  // 结清后再退 1 件 → 现金退回
  P.payOrder(o.id, 30)
  const r2 = P.purchaseReturn({ order_id: o.id, material_id: bread.id, qty: 1 })
  assert.equal(r2.ok, true)
  assert.equal(r2.cashBack, 5, '已付款部分现金退回')
  // 超退拒绝
  assert.equal(P.purchaseReturn({ order_id: o.id, material_id: bread.id, qty: 999 }).ok, false)
})

test('销售退货：库存回补且按售价退款入商业流水', () => {
  const pop = refreshMat(P.listMaterials().find(x => x.name.includes('爆米花')).id)
  const vid = pop.vendors[0].id
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vid)
  const stock0 = refreshMat(pop.id).qty_on_hand
  const cash0 = cash()
  const r = P.customerReturn(vid, 2, { reason: '口味问题' })
  assert.equal(r.ok, true)
  assert.equal(r.refund, v.price * 2)
  assert.equal(cash(), cash0 - v.price * 2)
  assert.equal(refreshMat(pop.id).qty_on_hand, stock0 + 2)
  assert.ok(finLogs.some(f => f.label === '商业' && f.amount === -(v.price * 2)))
})

test('盘点：盘盈入库、盘亏扣批次并记物料成本；差异自动生成异常，审批后核销', () => {
  const cup = refreshMat(P.listMaterials().find(x => x.name.includes('一次性杯')))
  const stock0 = cup.qty_on_hand
  const lossQty = Math.min(3, stock0)          // 动态盘亏量（不依赖前序用例剩余）
  assert.ok(lossQty >= 1, '杯材需有可盘亏库存')
  const st = P.createStocktake({ scope: 'all' })
  assert.equal(st.ok, true)
  const detail = P.stocktakeDetail(st.id)
  // 杯材盘亏 lossQty，其余账实相符
  const actuals = detail.items.map(it =>
    it.material_id === cup.id ? { item_id: it.id, qty_actual: it.qty_book - lossQty }
                              : { item_id: it.id, qty_actual: it.qty_book })
  const s = P.submitStocktake(st.id, actuals)
  assert.equal(s.ok, true)
  assert.equal(s.diffCount, 1)
  assert.equal(s.diffAmount, -lossQty * cup.std_cost)
  assert.ok(P.listInventoryFindings({ type: 'stock_diff' }).some(f => f.ref_id === st.id))
  const cash0 = cash()
  const a = P.approveStocktake(st.id)
  assert.equal(a.ok, true)
  assert.equal(a.loss, lossQty * cup.std_cost)
  assert.equal(refreshMat(cup.id).qty_on_hand, stock0 - lossQty)
  assert.equal(cash(), cash0 - lossQty * cup.std_cost)
  assert.ok(finLogs.some(f => f.label === '物料成本' && f.detail.includes('PD')))
  assert.equal(P.listInventoryFindings({ status: 'open', type: 'stock_diff' }).filter(f => f.ref_id === st.id).length, 0)
  assert.equal(P.approveStocktake(st.id).ok, false, '已调账不能重复审批')
})

test('临期预警与过期报损：过期批次整批核销并产生物料成本损失', () => {
  const day = Number(getSetting('day'))
  const m = refreshMat(P.listMaterials().find(x => x.name.includes('热狗肠')))
  // 新建一个次日到期的专属批次（不依赖其他用例剩余库存）
  const r = db.prepare(`INSERT INTO inbound_batches(material_id,supplier_id,qty_received,qty_remain,unit_cost,receive_day,expire_day,status)
                        VALUES(?,?,10,10,4,?,?, 'in')`).run(m.id, m.preferred_supplier_id, day, day + 1)
  const bid = Number(r.lastInsertRowid)
  db.prepare(`INSERT INTO inventory(material_id,qty_on_hand,updated_tick) VALUES(?,?,100)
              ON CONFLICT(material_id) DO UPDATE SET qty_on_hand=qty_on_hand+10`).run(m.id, 100)
  P.detectFindings()
  assert.ok(P.listInventoryFindings({ type: 'expiry' }).some(f => f.ref_id === bid), '应有临期预警')
  // 推进到过期日：报损
  const beforeQty = refreshMat(m).qty_on_hand
  setSetting('day', day + 1)
  const res = P.processExpiry()
  assert.ok(res.count >= 1)
  assert.ok(res.cost > 0)
  const b = db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(bid)
  assert.equal(b.status, 'closed')
  assert.equal(refreshMat(m).qty_on_hand, beforeQty - 10)
})

test('缺货自动补货：低于安全库存且无在途单时生成草稿，幂等不重复；后续有在途单不再生成', () => {
  const mat = refreshMat(P.listMaterials().find(x => x.name.includes('T 恤') || x.name.includes('纪念 T')))
  // 清空在途采购
  db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id IN (SELECT order_id FROM purchase_order_items WHERE material_id=?)").run(mat.id)
  // 手工把库存压到安全线以下
  for (const b of db.prepare("SELECT * FROM inbound_batches WHERE material_id=? AND status='in' AND qty_remain>0").all(mat.id)) {
    db.prepare("UPDATE inbound_batches SET status='exhausted', qty_remain=0 WHERE id=?").run(b.id)
  }
  db.prepare('UPDATE inventory SET qty_on_hand=0 WHERE material_id=?').run(mat.id)
  const ids1 = P.autoReorderTick()
  assert.ok(ids1.length >= 1, '应生成补货草稿')
  const ids2 = P.autoReorderTick()
  assert.equal(ids2.length, 0, '已有草稿在途，不重复生成')
  const po = P.listOrders({ status: 'draft' }).find(o => o.items.some(i => i.material_id === mat.id))
  assert.ok(po)
  assert.equal(po.source, 'auto')
  assert.ok(po.items[0].qty_ordered >= mat.reorder_qty)
})

test('自动到货：批准满 3 tick 的采购单整批收货并完成货到即付结算', () => {
  const sup = P.listSuppliers().find(s => s.category === '饮品原料')
  const mat = refreshMat(P.listMaterials().find(x => x.name.includes('一次性杯')))
  const o = P.createOrder({ supplier_id: sup.id, items: [{ material_id: mat.id, qty: 10, unit_cost: 1 }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  assert.deepEqual(P.autoDeliveryTick(), [], '批准未满 3 tick 不到货')
  const t = Number(getSetting('tick')) + 3
  setSetting('tick', t)
  const ids = P.autoDeliveryTick()
  assert.ok(ids.includes(o.id))
  const d = P.orderDetail(o.id).order
  assert.equal(d.status, 'settled', '账期 0 天供应商自动收货后即付清')
  assert.equal(d.received_qty, 10)
})

test('异常对账：人工处理闭环（resolve/ignore），逾期应付自动升级', () => {
  const sup = P.listSuppliers().find(s => s.category === '文创百货')
  const mat = refreshMat(P.listMaterials().find(x => x.name.includes('益智玩具')))
  const o = P.createOrder({ supplier_id: sup.id, items: [{ material_id: mat.id, qty: 5, unit_cost: 15 }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  const itemId = P.orderDetail(o.id).order.items[0].id
  P.receiveOrder(o.id, [{ item_id: itemId, qty: 5 }])
  // 推进日期并把应付日改到过去，模拟逾期（巡检条件 pay_due_day>0 AND pay_due_day<当前日）
  setSetting('day', 3)
  db.prepare('UPDATE purchase_orders SET pay_due_day=? WHERE id=?').run(1, o.id)
  P.detectFindings()
  const f = P.listInventoryFindings({ status: 'open', type: 'payable' }).find(x => x.order_id === o.id)
  assert.ok(f, '逾期未付应生成 open 状态的应付异常')
  assert.equal(P.resolveInventoryFinding(f.id, '已电话催收').ok, true)
  assert.equal(P.listInventoryFindings({ status: 'open' }).filter(x => x.id === f.id).length, 0)
  // 忽略一条缺货异常
  const short = P.listInventoryFindings({ type: 'shortage' })[0]
  if (short) {
    P.ignoreInventoryFinding(short.id, '系统误报')
    assert.equal(db.prepare('SELECT status FROM inventory_findings WHERE id=?').get(short.id).status, 'ignored')
  }
})

test('统计口径：库存价值按标准成本、应付=总额-已付-退货冲抵', () => {
  const s = P.procurementStats()
  const manual = P.listMaterials().reduce((sum, m) => sum + m.qty_on_hand * m.std_cost, 0)
  assert.equal(s.stockValue, Math.round(manual))
  assert.ok(s.payable >= 0)
  assert.ok(s.openFindings >= 0)
})
