<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const tab = ref('stock')

const tabs = [
  { k: 'stock', icon: '📦', label: '库存物资' },
  { k: 'orders', icon: '🛒', label: '采购单' },
  { k: 'suppliers', icon: '🤝', label: '供应商' },
  { k: 'batches', icon: '📥', label: '入库批次' },
  { k: 'returns', icon: '↩️', label: '退货管理' },
  { k: 'stocktake', icon: '📋', label: '盘点调账' },
  { k: 'findings', icon: '🚩', label: '异常对账' }
]

const PO_STATUS = {
  draft: { t: '草稿', c: 'var(--muted)' },
  submitted: { t: '待审批', c: 'var(--accent2)' },
  approved: { t: '已批准·待到货', c: 'var(--blue)' },
  partial: { t: '部分到货', c: 'var(--purple)' },
  received: { t: '已到货·待结算', c: '#58c4dd' },
  settled: { t: '已结算', c: 'var(--green)' },
  cancelled: { t: '已作废', c: 'var(--red)' }
}
const poStatus = s => PO_STATUS[s] || { t: s, c: 'var(--muted)' }

const FIND_META = {
  shortage: { t: '缺货预警', icon: '🔻' },
  expiry: { t: '临期/过期', icon: '⏰' },
  price: { t: '价格差异', icon: '💱' },
  stock_diff: { t: '账实不符', icon: '🧮' },
  payable: { t: '应付异常', icon: '💳' }
}

const stockCls = s => ({ out: 'st-out', low: 'st-low', ok: 'st-ok' }[s] || '')
const stockText = s => ({ out: '断货', low: '偏低', ok: '充足' }[s] || '-')

const stats = computed(() => store.purchaseStats)
const day = computed(() => store.clock.day)

// ---------------- 库存 Tab ----------------
const stockFilter = ref('all')
const stockKeyword = ref('')
const filteredMats = computed(() => store.materials.filter(m => {
  if (stockFilter.value !== 'all' && m.stock_status !== stockFilter.value) return false
  if (stockKeyword.value && !m.name.includes(stockKeyword.value) && !m.code.includes(stockKeyword.value.toUpperCase())) return false
  return true
}))
const stockValue = computed(() => store.materials.reduce((s, m) => s + m.qty_on_hand * m.std_cost, 0))

const matModal = ref(false)
const matForm = ref({})
function openMat(m = null) {
  matForm.value = m ? { ...m } : {
    name: '', category: '食材', unit: '份', std_cost: 0, safety_stock: 30,
    shelf_days: 0, auto_reorder: 1, reorder_qty: 100, preferred_supplier_id: null
  }
  matModal.value = true
}
async function saveMat() {
  const r = await store.saveMaterial(matForm.value, matForm.value.id || null)
  if (r.ok) matModal.value = false
  else alert(r.msg || '保存失败')
}

const linkModal = ref(false)
const linkVendor = ref(null)
const linkIds = ref([])
function openLink(v) {
  linkVendor.value = v
  linkIds.value = matVendorsMap(v.id)
  linkModal.value = true
}
function matVendorsMap(vendorId) {
  const m0 = store.materials.find(m => m.vendors.some(v => v.id === vendorId))
  return store.materials.filter(m => m.vendors.some(v => v.id === vendorId)).map(m => m.id)
}
async function saveLink() {
  const r = await store.setVendorMaterials(linkVendor.value.id, linkIds.value)
  if (r.ok) linkModal.value = false
  else alert(r.msg || '保存失败')
}

const moveModal = ref(false)
const moveData = ref(null)
async function openMovements(m) {
  moveData.value = { name: m.name, list: [] }
  const r = await store.materialMovements(m.id)
  if (r.ok) moveData.value.list = r.list
  moveModal.value = true
}
const MOVE_REASON = { in: '入库', sale: '销售', partner_sale: '联营销售', sale_return: '销售退货', partner_sale_return: '联营退货', purchase_return: '采购退货', recall_refund: '召回游客退款(不回库)', adjust_gain: '盘盈', adjust_loss: '盘亏', spoil: '过期报损/召回销毁' }

// ---------------- 采购单 Tab ----------------
const poFilter = ref('')
const filteredPos = computed(() =>
  store.purchaseOrders.filter(o => !poFilter.value || o.status === poFilter.value))
const poCounts = computed(() => {
  const c = {}
  for (const o of store.purchaseOrders) c[o.status] = (c[o.status] || 0) + 1
  return c
})

const poModal = ref(false)
const poForm = ref({ supplier_id: null, source: 'manual', vendor_id: null, note: '', lines: [] })
function openPo() {
  poForm.value = {
    supplier_id: store.suppliers[0]?.id || null,
    source: 'manual', vendor_id: null, note: '',
    lines: [{ material_id: store.materials[0]?.id || null, qty: 50, unit_cost: store.materials[0]?.std_cost || 0 }]
  }
  poModal.value = true
}
function addLine() {
  poForm.value.lines.push({ material_id: store.materials[0]?.id || null, qty: 50, unit_cost: 0 })
}
function onMatChange(line) {
  const m = store.materials.find(x => x.id === +line.material_id)
  if (m && !line.unit_cost) line.unit_cost = m.std_cost
}
const poTotal = computed(() => poForm.value.lines.reduce((s, l) => s + (+l.qty || 0) * (+l.unit_cost || 0), 0))
async function submitPoForm() {
  const payload = {
    supplier_id: +poForm.value.supplier_id,
    source: poForm.value.source,
    vendor_id: poForm.value.source === 'shop' ? +poForm.value.vendor_id : null,
    note: poForm.value.note,
    items: poForm.value.lines.filter(l => +l.qty > 0).map(l => ({ material_id: +l.material_id, qty: +l.qty, unit_cost: +l.unit_cost }))
  }
  const r = await store.createPurchaseOrder(payload)
  if (r.ok) poModal.value = false
  else alert(r.msg || '创建失败')
}

// 采购单详情
const detail = ref(null)
const receiveMap = ref({})
const payAmount = ref(null)
async function openDetail(o) {
  const r = await store.purchaseOrderDetail(o.id)
  if (!r.ok) return alert(r.msg || '加载失败')
  detail.value = r
  receiveMap.value = {}
  payAmount.value = r.order.outstanding
  for (const it of r.order.items) {
    const remain = it.qty_ordered - it.qty_received - it.qty_returned
    if (remain > 0) receiveMap.value[it.id] = remain
  }
}
function closeDetail() { detail.value = null }

async function act(fn, ...args) {
  const r = await fn(...args)
  if (!r?.ok) { alert(r?.msg || '操作失败'); return }
  if (detail.value) await openDetail({ id: detail.value.order.id })
}
async function doReceive() {
  const receives = Object.entries(receiveMap.value)
    .map(([item_id, qty]) => ({ item_id: +item_id, qty: +qty }))
    .filter(x => x.qty > 0)
  await act(store.receivePurchaseOrder.bind(store), detail.value.order.id, receives, '')
}
async function doPay() {
  await act(store.payPurchaseOrder.bind(store), detail.value.order.id, +payAmount.value)
}

// 采购退货弹窗（从详情打开）
const retModal = ref(false)
const retForm = ref({})
function openRet() {
  const it = detail.value.order.items.find(x => x.qty_received - x.qty_returned > 0)
  retForm.value = {
    item_id: it?.id, material_id: it?.material_id,
    qty: 1, reason: ''
  }
  retModal.value = true
}
async function doPurchaseReturn() {
  const r = await store.purchaseReturn({
    order_id: detail.value.order.id,
    material_id: +retForm.value.material_id,
    qty: +retForm.value.qty,
    reason: retForm.value.reason
  })
  if (!r.ok) return alert(r.msg || '退货失败')
  retModal.value = false
  await openDetail({ id: detail.value.order.id })
}

// ---------------- 供应商 Tab ----------------
const supModal = ref(false)
const supForm = ref({})
function openSup(s = null) {
  supForm.value = s ? { ...s } : { name: '', contact: '', phone: '', category: '综合', pay_term_days: 0, rating: 3, note: '' }
  supModal.value = true
}
async function saveSup() {
  const r = await store.saveSupplier(supForm.value, supForm.value.id || null)
  if (r.ok) supModal.value = false
  else alert(r.msg || '保存失败')
}
async function toggleSup(s) {
  await store.saveSupplier({ ...s, status: s.status === 'active' ? 'suspended' : 'active' }, s.id)
}

// ---------------- 批次 Tab ----------------
const onlyExpiring = ref(false)
const batches = ref([])
async function loadBatches() {
  const r = await store.stockBatches(onlyExpiring.value ? '?expiring=1' : '')
  batches.value = r.list || []
}
// 首次切到批次 Tab 时拉取（state 里只带了临期批，全量需单独请求）
loadBatches()

// ---------------- 退货 Tab ----------------
const retKind = ref('')
const returns = computed(() => store.purchaseReturns.filter(r => !retKind.value || r.kind === retKind.value))
const saleRetModal = ref(false)
const saleRet = ref({ vendor_id: null, qty: 1, reason: '' })
function openSaleRet() {
  saleRet.value = { vendor_id: store.vendors[0]?.id || null, qty: 1, reason: '' }
  saleRetModal.value = true
}
async function doSaleReturn() {
  const r = await store.salesReturn(saleRet.value)
  if (!r.ok) return alert(r.msg || '退货失败')
  saleRetModal.value = false
}

// ---------------- 盘点 Tab ----------------
async function createStocktake(scope) {
  const r = await store.createStocktake({ scope, note: '' })
  if (!r.ok) alert(r.msg || '创建失败')
}
const stDetail = ref(null)
const stActuals = ref({})
async function openSt(st) {
  const r = await store.stocktakeDetail(st.id)
  if (!r.ok) return
  stDetail.value = r.stocktake
  stActuals.value = {}
  for (const it of stDetail.value.items) stActuals.value[it.id] = it.qty_actual
}
function closeSt() { stDetail.value = null }
async function submitSt() {
  const actuals = Object.entries(stActuals.value).map(([item_id, qty_actual]) => ({ item_id: +item_id, qty_actual: +qty_actual }))
  const r = await store.submitStocktake(stDetail.value.id, actuals)
  if (r.ok) { closeSt(); if (r.diffCount === 0) alert('账实相符，无差异') }
  else alert(r.msg || '提交失败')
}
async function approveSt(st) {
  if (!confirm('确认按实盘数调账？盘亏将按标准成本核销物料成本。')) return
  await store.approveStocktake(st.id, '')
}

// ---------------- 异常对账 Tab ----------------
const fStatus = ref('open')
const findings = ref(null) // null=用 state 快照；切换历史时单独拉取
async function loadFindings() {
  const q = new URLSearchParams()
  if (fStatus.value) q.set('status', fStatus.value)
  const r = await store.inventoryFindings(q.toString() ? `?${q}` : '')
  findings.value = r.list || []
}
const shownFindings = computed(() => findings.value ?? store.inventoryFindings)
async function resolveF(f, ignore = false) {
  const note = prompt(ignore ? '忽略理由（可留空）' : '处理说明（可留空）', '') ?? ''
  const fn = ignore ? store.ignoreInventoryFinding : store.resolveInventoryFinding
  const r = await fn(f.id, note)
  if (r.ok) loadFindings()
}
</script>

<template>
  <div class="proc">
    <!-- 统计栏 -->
    <div class="kpis">
      <div class="kpi card"><em>库存总值</em><b class="money">¥{{ Math.round(stockValue).toLocaleString() }}</b><span class="muted">按标准成本计价</span></div>
      <div class="kpi card"><em>断货 / 偏低</em><b :class="stats.outStock ? 'neg money' : ''">{{ stats.outStock }} / {{ stats.lowStock }}</b><span class="muted">临期批次 {{ stats.expiringBatches }}</span></div>
      <div class="kpi card"><em>待付货款</em><b class="money neg">¥{{ stats.payable.toLocaleString() }}</b><span class="muted" v-if="stats.overduePayable">其中逾期 ¥{{ stats.overduePayable.toLocaleString() }}</span><span class="muted" v-else>暂无逾期</span></div>
      <div class="kpi card"><em>今日缺货流失</em><b class="money neg">¥{{ stats.lostToday.rev.toLocaleString() }}</b><span class="muted">{{ stats.lostToday.qty }} 份未成交</span></div>
      <div class="kpi card"><em>今日物料支出</em><b class="money neg">¥{{ stats.costToday.toLocaleString() }}</b><span class="muted">采购付款+报损盘亏</span></div>
      <div class="kpi card"><em>待处理异常</em><b :class="stats.criticalFindings ? 'neg money' : ''">{{ stats.openFindings }}</b><span class="muted">紧急 {{ stats.criticalFindings }} 条</span></div>
    </div>

    <div class="tabs">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">
        <span>{{ t.icon }}</span>{{ t.label }}
        <i class="badge" v-if="t.k==='orders' && (poCounts.draft||poCounts.submitted)">{{ (poCounts.draft||0)+(poCounts.submitted||0) }}</i>
        <i class="badge red" v-if="t.k==='findings' && stats.openFindings">{{ stats.openFindings }}</i>
      </button>
    </div>

    <!-- 库存物资 -->
    <div v-if="tab==='stock'" class="panel">
      <div class="bar">
        <div class="filters">
          <button :class="{on:stockFilter==='all'}" @click="stockFilter='all'">全部</button>
          <button :class="{on:stockFilter==='out'}" @click="stockFilter='out'">断货</button>
          <button :class="{on:stockFilter==='low'}" @click="stockFilter='low'">偏低</button>
          <button :class="{on:stockFilter==='ok'}" @click="stockFilter='ok'">充足</button>
          <input v-model="stockKeyword" placeholder="搜索物资名称/编码" style="width:180px" />
        </div>
        <button class="primary" @click="openMat()">＋ 新增物资</button>
      </div>
      <div class="table card">
        <div class="thead stock-head">
          <span>物资</span><span>分类</span><span>现库存</span><span>状态</span><span>安全库存</span>
          <span>标准成本</span><span>库存价值</span><span>保质期</span><span>供货商铺</span><span>操作</span>
        </div>
        <div class="trow stock-head" v-for="m in filteredMats" :key="m.id">
          <span><b>{{ m.name }}</b><em class="muted code">{{ m.code }}</em></span>
          <span>{{ m.category }}</span>
          <span><b :class="stockCls(m.stock_status)">{{ m.qty_on_hand }} {{ m.unit }}</b>
            <em class="muted" v-if="m.expiring_qty>0" style="color:var(--accent2)"> · 临期{{m.expiring_qty}}</em>
            <em v-if="m.quarantined_qty>0" class="tag tag-red" style="margin-left:4px">🚨 召回隔离 {{ m.quarantined_qty }}</em>
          </span>
          <span><i class="st-dot" :class="stockCls(m.stock_status)"></i>{{ stockText(m.stock_status) }}</span>
          <span>{{ m.safety_stock }}<em class="muted"> / 补货 {{ m.reorder_qty }}</em></span>
          <span class="money">¥{{ m.std_cost }}</span>
          <span class="money">¥{{ Math.round(m.qty_on_hand*m.std_cost).toLocaleString() }}</span>
          <span>{{ m.shelf_days > 0 ? m.shelf_days + ' 天' : '—' }}</span>
          <span><span class="tag" v-for="v in m.vendors" :key="v.id" style="margin-right:4px">{{ v.name }}</span><em v-if="!m.vendors.length" class="muted">未挂商铺</em></span>
          <span class="ops">
            <button class="ghost" @click="openMat(m)">编辑</button>
            <button class="ghost" @click="openMovements(m)">流水</button>
          </span>
        </div>
        <div class="muted empty" v-if="!filteredMats.length">暂无物资</div>
      </div>
      <div class="bar" style="margin-top:12px">
        <span class="muted">商铺供货物资配置（决定哪些商铺受库存联动管理，未配置的商铺销售不受库存限制）</span>
      </div>
      <div class="table card">
        <div class="thead link-head"><span>商铺</span><span>类型</span><span>挂供物资</span><span></span></div>
        <div class="trow link-head" v-for="v in store.vendors" :key="v.id">
          <span><b>{{ v.name }}</b></span><span>{{ v.type }}</span>
          <span>{{ matVendorsMap(v.id).length }} 种</span>
          <span class="ops"><button class="ghost" @click="openLink(v)">配置供货物资</button></span>
        </div>
      </div>
    </div>

    <!-- 采购单 -->
    <div v-else-if="tab==='orders'" class="panel">
      <div class="bar">
        <div class="filters">
          <button :class="{on:poFilter===''}" @click="poFilter=''">全部</button>
          <button v-for="(meta,k) in PO_STATUS" :key="k" :class="{on:poFilter===k}" @click="poFilter=k">{{ meta.t }} {{ poCounts[k]||'' }}</button>
        </div>
        <button class="primary" @click="openPo">＋ 新建采购单</button>
      </div>
      <div class="table card">
        <div class="thead po-head">
          <span>采购单</span><span>供应商</span><span>来源</span><span>金额</span><span>已付/待付</span><span>状态</span><span>应付日</span><span>操作</span>
        </div>
        <div class="trow po-head" v-for="o in filteredPos" :key="o.id">
          <span><b>{{ o.code }}</b><em class="muted code">第{{o.create_day}}天</em></span>
          <span>{{ o.supplier?.name }}<em class="muted code">{{ o.supplier?.pay_term_days }}天账期</em></span>
          <span>{{ o.source==='auto' ? '缺货自动' : o.source==='shop' ? '商铺协同' : '运营' }}<em class="muted code" v-if="o.vendor_name">·{{o.vendor_name}}</em></span>
          <span class="money">¥{{ o.total_amount.toLocaleString() }}</span>
          <span><span class="money">¥{{ o.paid_amount }}</span><em class="muted"> / </em><b class="money neg" v-if="o.outstanding">¥{{ o.outstanding }}</b><em v-else class="muted">两清</em></span>
          <span><i class="pstat" :style="{color:poStatus(o.status).c}">●</i> {{ poStatus(o.status).t }}<em v-if="o.overdue" class="tag red-tag">逾期</em></span>
          <span>{{ o.pay_due_day ? '第'+o.pay_due_day+'天' : '—' }}</span>
          <span class="ops"><button class="ghost" @click="openDetail(o)">详情</button></span>
        </div>
        <div class="muted empty" v-if="!filteredPos.length">暂无采购单，缺货时系统会按首选供应商自动生成补货草稿</div>
      </div>
    </div>

    <!-- 供应商 -->
    <div v-else-if="tab==='suppliers'" class="panel">
      <div class="bar"><span></span><button class="primary" @click="openSup()">＋ 新增供应商</button></div>
      <div class="sup-cards">
        <div class="card sup" v-for="s in store.suppliers" :key="s.id">
          <div class="sup-h">
            <b>{{ s.name }}</b><span class="tag">{{ s.category }}</span>
            <span class="tag" :class="s.status==='active' ? 'tag-on' : 'tag-off'">{{ s.status==='active' ? '合作中' : '已暂停' }}</span>
          </div>
          <div class="sup-m">
            <div><em class="muted">联系人</em>{{ s.contact || '—' }} {{ s.phone }}</div>
            <div><em class="muted">账期</em>{{ s.pay_term_days }} 天（{{ s.pay_term_days ? '按账期结算' : '货到即付' }}）</div>
            <div><em class="muted">评级</em>{{ '★'.repeat(s.rating) }}{{ '☆'.repeat(5-s.rating) }}</div>
            <div><em class="muted">采购单数</em>{{ s.order_count }}</div>
            <div><em class="muted">当前应付</em><b class="money neg" v-if="s.payable">¥{{ s.payable.toLocaleString() }}</b><em v-else class="muted">无</em></div>
          </div>
          <div class="sup-a">
            <button class="ghost" @click="openSup(s)">编辑</button>
            <button class="ghost" :class="s.status==='active' ? 'danger' : ''" @click="toggleSup(s)">{{ s.status==='active' ? '暂停合作' : '恢复合作' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 入库批次 -->
    <div v-else-if="tab==='batches'" class="panel">
      <div class="bar">
        <label class="muted"><input type="checkbox" :checked="onlyExpiring" @change="onlyExpiring=$event.target.checked;loadBatches()" /> 仅看 2 天内到期/临期</label>
        <button class="ghost" @click="loadBatches">刷新</button>
      </div>
      <div class="table card">
        <div class="thead batch-head"><span>批次号</span><span>物资</span><span>来源</span><span>剩余/入库</span><span>隔离量</span><span>批次单价</span><span>入库日</span><span>到期日</span><span>状态</span></div>
        <div class="trow batch-head" v-for="b in batches" :key="b.id">
          <span><b>{{ b.code }}</b></span>
          <span>{{ b.material_name }}<em class="muted code">{{ b.unit }}</em></span>
          <span>{{ b.supplier_name || (b.note||'期初') }}</span>
          <span>{{ b.qty_remain }} / {{ b.qty_received }}</span>
          <span><b v-if="b.quarantined_qty" class="neg">🚨 {{ b.quarantined_qty }}</b><em v-else class="muted">0</em></span>
          <span class="money">¥{{ b.unit_cost }}</span>
          <span>第{{b.receive_day}}天</span>
          <span :class="b.expired ? 'neg money' : b.expire_day<=day+2 ? 'warn-text' : ''">
            {{ b.expire_day ? `第${b.expire_day}天` : '无保质期' }}
            <em class="tag red-tag" v-if="b.expired">已过期</em>
          </span>
          <span>{{ b.recall_id ? '召回隔离中 ' + ('ZH' + String(b.recall_id).padStart(4,'0')) : {in:'在库', exhausted:'已耗尽', closed:'已结清/报损'}[b.status] }}</span>
        </div>
        <div class="muted empty" v-if="!batches.length">暂无批次</div>
      </div>
    </div>

    <!-- 退货 -->
    <div v-else-if="tab==='returns'" class="panel">
      <div class="bar">
        <div class="filters">
          <button :class="{on:retKind===''}" @click="retKind=''">全部</button>
          <button :class="{on:retKind==='purchase'}" @click="retKind='purchase'">采购退货</button>
          <button :class="{on:retKind==='sale'}" @click="retKind='sale'">销售退货</button>
        </div>
        <button class="primary" @click="openSaleRet">＋ 游客销售退货</button>
      </div>
      <div class="table card">
        <div class="thead ret-head"><span>退货号</span><span>类型</span><span>物资</span><span>数量</span><span>金额</span><span>关联</span><span>原因</span><span>日期</span></div>
        <div class="trow ret-head" v-for="r in returns" :key="r.id">
          <span><b>{{ r.code }}</b></span>
          <span><i :class="r.kind==='purchase' ? 'tag tag-off' : 'tag tag-on'">{{ r.kind==='purchase' ? '退供应商' : '游客退货' }}</i></span>
          <span>{{ r.material_name }}</span>
          <span>{{ r.qty }}</span>
          <span class="money" :class="r.kind==='sale' ? 'neg' : ''">¥{{ r.amount }}</span>
          <span>{{ r.order_code || r.vendor_name || '—' }}</span>
          <span class="muted">{{ r.reason }}</span>
          <span>第{{r.create_day}}天</span>
        </div>
        <div class="muted empty" v-if="!returns.length">暂无退货记录</div>
      </div>
    </div>

    <!-- 盘点 -->
    <div v-else-if="tab==='stocktake'" class="panel">
      <div class="bar">
        <span class="muted">定期盘点：实盘与系统账有差异时生成异常，审批后盘盈入库、盘亏按标准成本核销</span>
        <div>
          <button class="primary" @click="createStocktake('all')">＋ 全仓盘点</button>
        </div>
      </div>
      <div class="table card">
        <div class="thead st-head"><span>盘点单</span><span>范围</span><span>差异项</span><span>差异净值</span><span>状态</span><span>日期</span><span>操作</span></div>
        <div class="trow st-head" v-for="st in store.stocktakes" :key="st.id">
          <span><b>{{ st.code }}</b></span>
          <span>{{ st.scope==='all' ? '全仓' : '商铺：'+st.vendor_name }}</span>
          <span>{{ st.diff_count }} 项</span>
          <span class="money" :class="st.diff_amount<0?'neg':''">{{ st.diff_amount ? '¥'+st.diff_amount : '—' }}</span>
          <span>{{ {open:'盘点中', submitted:'待审批调账', adjusted:'已调账', cancelled:'已撤销'}[st.status] }}</span>
          <span>第{{st.create_day}}天</span>
          <span class="ops">
            <button class="ghost" v-if="st.status==='open'" @click="openSt(st)">录入实盘</button>
            <button class="ghost" @click="openSt(st)">查看</button>
            <button class="succ" v-if="st.status==='submitted'" @click="approveSt(st)">批准调账</button>
            <button class="danger" v-if="['open','submitted'].includes(st.status)" @click="store.cancelStocktake(st.id)">撤销</button>
          </span>
        </div>
        <div class="muted empty" v-if="!store.stocktakes.length">暂无盘点单</div>
      </div>
    </div>

    <!-- 异常对账 -->
    <div v-else-if="tab==='findings'" class="panel">
      <div class="bar">
        <div class="filters">
          <button :class="{on:fStatus==='open'}" @click="fStatus='open';loadFindings()">待处理</button>
          <button :class="{on:fStatus==='resolved'}" @click="fStatus='resolved';loadFindings()">已处理</button>
          <button :class="{on:fStatus==='ignored'}" @click="fStatus='ignored';loadFindings()">已忽略</button>
          <button :class="{on:fStatus===''}" @click="fStatus='';loadFindings()">全部</button>
        </div>
        <button class="ghost" @click="loadFindings">刷新</button>
      </div>
      <div class="findings">
        <div class="card find" :class="'sev-'+f.severity" v-for="f in shownFindings" :key="f.id">
          <div class="f-ic">{{ FIND_META[f.type]?.icon || '🚩' }}</div>
          <div class="f-body">
            <div class="f-h">
              <b>{{ f.title }}</b>
              <span class="tag">{{ FIND_META[f.type]?.t || f.type }}</span>
              <span class="tag" :class="f.severity==='critical'?'tag-red':f.severity==='warn'?'tag-warn':'tag-on'">{{ f.severity==='critical'?'紧急':f.severity==='warn'?'警告':'提示' }}</span>
              <span class="tag" :class="f.status==='open'?'tag-off':'tag-on'">{{ {open:'待处理',resolved:'已处理',ignored:'已忽略'}[f.status] }}</span>
            </div>
            <p class="muted">{{ f.detail }}</p>
            <div class="muted f-meta">第{{f.create_day}}天
              <template v-if="f.material_name"> · {{ f.material_name }}</template>
              <template v-if="f.supplier_name"> · {{ f.supplier_name }}</template>
              <template v-if="f.order_code"> · {{ f.order_code }}</template>
              <template v-if="f.resolve_note"> · 处理：{{ f.resolve_note }}</template>
            </div>
          </div>
          <div class="f-acts" v-if="f.status==='open'">
            <button class="succ" @click="resolveF(f,false)">核销处理</button>
            <button class="ghost" @click="resolveF(f,true)">忽略</button>
          </div>
        </div>
        <div class="muted empty" v-if="!shownFindings.length">没有异常记录</div>
      </div>
    </div>

    <!-- ============ 弹窗：物资编辑 ============ -->
    <div class="modal" v-if="matModal" @click.self="matModal=false">
      <div class="modal-box card">
        <h3>{{ matForm.id ? '编辑物资' : '新增物资' }}</h3>
        <div class="form">
          <label>名称 <input v-model="matForm.name" placeholder="如：爆米花原料" /></label>
          <div class="form-row">
            <label>分类
              <select v-model="matForm.category"><option>食材</option><option>饮品原料</option><option>包材</option><option>文创百货</option></select>
            </label>
            <label>单位 <input v-model="matForm.unit" /></label>
          </div>
          <div class="form-row">
            <label>标准成本(¥)<input type="number" v-model.number="matForm.std_cost" /></label>
            <label>保质期(天,0=无)<input type="number" v-model.number="matForm.shelf_days" /></label>
          </div>
          <div class="form-row">
            <label>安全库存<input type="number" v-model.number="matForm.safety_stock" /></label>
            <label>建议补货量<input type="number" v-model.number="matForm.reorder_qty" /></label>
          </div>
          <label>首选供应商
            <select v-model.number="matForm.preferred_supplier_id">
              <option :value="null">无</option>
              <option v-for="s in store.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <label class="chk"><input type="checkbox" v-model="matForm.auto_reorder" :true-value="1" :false-value="0" /> 低于安全库存时自动生成补货草稿</label>
        </div>
        <div class="acts"><button class="primary" @click="saveMat">保存</button><button class="ghost" @click="matModal=false">取消</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：商铺供货配置 ============ -->
    <div class="modal" v-if="linkModal" @click.self="linkModal=false">
      <div class="modal-box card">
        <h3>🏪 {{ linkVendor?.name }} · 供货物资</h3>
        <p class="muted" style="font-size:12px;margin-bottom:10px">勾选后，该商铺每销售 1 份将按 FEFO 扣减所选物资库存；任一物资断货即停售并产生缺货预警。</p>
        <div class="checklist">
          <label v-for="m in store.materials" :key="m.id">
            <input type="checkbox" :value="m.id" v-model="linkIds" />
            {{ m.name }} <em class="muted">（库存 {{m.qty_on_hand}} {{m.unit}}）</em>
          </label>
        </div>
        <div class="acts"><button class="primary" @click="saveLink">保存</button><button class="ghost" @click="linkModal=false">取消</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：库存流水 ============ -->
    <div class="modal" v-if="moveModal" @click.self="moveModal=false">
      <div class="modal-box card wide">
        <h3>📜 {{ moveData?.name }} · 库存流水</h3>
        <div class="mini-table">
          <div class="mini-head"><span>日期</span><span>变动</span><span>结存</span><span>类型</span><span>关联</span></div>
          <div class="mini-row" v-for="mv in moveData?.list" :key="mv.id">
            <span>第{{mv.day}}天</span>
            <span :class="mv.change>0?'money':'money neg'">{{ mv.change>0?'+':'' }}{{ mv.change }}</span>
            <span>{{ mv.qty_after }}</span>
            <span>{{ MOVE_REASON[mv.reason] || mv.reason }}</span>
            <span class="muted">{{ mv.ref_type }}#{{ mv.ref_id }}</span>
          </div>
          <div class="muted empty" v-if="!moveData?.list.length">暂无流水</div>
        </div>
        <div class="acts"><button class="ghost" @click="moveModal=false">关闭</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：新建采购单 ============ -->
    <div class="modal" v-if="poModal" @click.self="poModal=false">
      <div class="modal-box card wide">
        <h3>🛒 新建采购单</h3>
        <div class="form">
          <div class="form-row">
            <label>供应商
              <select v-model.number="poForm.supplier_id">
                <option v-for="s in store.suppliers.filter(x=>x.status==='active')" :key="s.id" :value="s.id">{{ s.name }}（{{s.pay_term_days}}天账期）</option>
              </select>
            </label>
            <label>提报来源
              <select v-model="poForm.source">
                <option value="manual">运营采购</option>
                <option value="shop">商铺协同提报</option>
              </select>
            </label>
            <label v-if="poForm.source==='shop'">协同商铺
              <select v-model.number="poForm.vendor_id"><option v-for="v in store.vendors" :key="v.id" :value="v.id">{{ v.name }}</option></select>
            </label>
          </div>
          <div class="po-lines">
            <div class="line-h"><span>物资</span><span style="width:110px">数量</span><span style="width:120px">单价(¥)</span><span style="width:40px"></span></div>
            <div class="line-r" v-for="(l,i) in poForm.lines" :key="i">
              <select v-model.number="l.material_id" @change="onMatChange(l)">
                <option v-for="m in store.materials" :key="m.id" :value="m.id">{{ m.name }}（库存{{m.qty_on_hand}}/安全{{m.safety_stock}}）</option>
              </select>
              <input type="number" style="width:110px" v-model.number="l.qty" min="1" />
              <input type="number" style="width:120px" v-model.number="l.unit_cost" min="0" />
              <button class="ghost danger" @click="poForm.lines.splice(i,1)">✕</button>
            </div>
            <button class="ghost" @click="addLine">＋ 添加明细行</button>
          </div>
          <label>备注 <input v-model="poForm.note" placeholder="可留空" /></label>
          <div class="po-total">合计：<b class="money">¥{{ Math.round(poTotal).toLocaleString() }}</b></div>
        </div>
        <div class="acts"><button class="primary" @click="submitPoForm">存为草稿</button><button class="ghost" @click="poModal=false">取消</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：采购单详情 ============ -->
    <div class="modal" v-if="detail" @click.self="closeDetail">
      <div class="modal-box card wide">
        <h3>🛒 {{ detail.order.code }}
          <span class="pstat" :style="{color:poStatus(detail.order.status).c}">●</span>
          {{ poStatus(detail.order.status).t }}
        </h3>
        <div class="d-meta">
          <span>供应商：<b>{{ detail.order.supplier?.name }}</b>（{{ detail.order.supplier?.pay_term_days }} 天账期）</span>
          <span>来源：{{ detail.order.source==='auto'?'缺货自动':detail.order.source==='shop'?'商铺协同'+(detail.order.vendor_name?'·'+detail.order.vendor_name:''):'运营' }}</span>
          <span>总额：<b class="money">¥{{ detail.order.total_amount }}</b></span>
          <span>已付：<b class="money">¥{{ detail.order.paid_amount }}</b></span>
          <span>退货冲抵：¥{{ detail.order.credited }}</span>
          <span>待付：<b class="money neg">¥{{ detail.order.outstanding }}</b></span>
          <span v-if="detail.order.pay_due_day">应付日：第{{detail.order.pay_due_day}}天 <em class="tag red-tag" v-if="detail.order.overdue">已逾期</em></span>
        </div>

        <div class="mini-table">
          <div class="mini-head det-head"><span>物资</span><span>单价</span><span>订购</span><span>已收</span><span>已退</span><span v-if="['approved','partial'].includes(detail.order.status)">本次收货</span></div>
          <div class="mini-row det-head" v-for="it in detail.order.items" :key="it.id">
            <span>{{ it.material_name }}</span>
            <span>¥{{ it.unit_cost }}</span>
            <span>{{ it.qty_ordered }} {{ it.unit }}</span>
            <span>{{ it.qty_received }}</span>
            <span>{{ it.qty_returned }}</span>
            <span v-if="['approved','partial'].includes(detail.order.status)">
              <input type="number" style="width:90px" v-model.number="receiveMap[it.id]" min="0" :max="it.qty_ordered-it.qty_received-it.qty_returned" :disabled="it.qty_ordered-it.qty_received-it.qty_returned<=0" />
            </span>
          </div>
        </div>

        <div class="d-acts">
          <button class="primary" v-if="detail.order.status==='draft'" @click="act(store.submitPurchaseOrder.bind(store), detail.order.id)">提交审批</button>
          <template v-if="detail.order.status==='submitted'">
            <button class="succ" @click="act(store.approvePurchaseOrder.bind(store), detail.order.id)">批准</button>
            <button class="danger" @click="act(store.rejectPurchaseOrder.bind(store), detail.order.id, '审批不通过')">驳回作废</button>
          </template>
          <button class="succ" v-if="['approved','partial'].includes(detail.order.status)" @click="doReceive">确认收货入库</button>
          <button v-if="['approved','partial','received'].includes(detail.order.status) && detail.order.outstanding>0" @click="doPay">
            支付货款 ¥{{ payAmount }}
          </button>
          <button class="ghost" v-if="detail.order.items.some(x=>x.qty_received-x.qty_returned>0)" @click="openRet">采购退货</button>
        </div>

        <div class="d-sub" v-if="detail.order.payments.length">
          <b>付款记录</b>
          <span v-for="p in detail.order.payments" :key="p.id" class="tag">{{ p.code }} ¥{{p.amount}} · 第{{p.create_day}}天</span>
        </div>
        <div class="d-sub" v-if="detail.batches.length">
          <b>入库批次</b>
          <span v-for="b in detail.batches" :key="b.id" class="tag">{{ b.code }} {{b.material_name}}×{{b.qty_received}}{{ b.expire_day?` ·第${b.expire_day}天到期`:'' }}</span>
        </div>

        <div class="logs">
          <b class="muted">流转日志</b>
          <div v-for="lg in detail.logs" :key="lg.id" class="log-line">
            <span class="muted">第{{lg.day}}天</span> {{ lg.note }}
          </div>
        </div>
        <div class="acts"><button class="ghost" @click="closeDetail">关闭</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：采购退货 ============ -->
    <div class="modal" v-if="retModal" @click.self="retModal=false">
      <div class="modal-box card">
        <h3>↩️ 采购退货（退供应商）</h3>
        <div class="form">
          <label>退货物资
            <select v-model.number="retForm.material_id">
              <option v-for="it in detail.order.items.filter(x=>x.qty_received-x.qty_returned>0)" :key="it.id" :value="it.material_id">{{ it.material_name }}（可退 {{it.qty_received-it.qty_returned}} {{it.unit}}）</option>
            </select>
          </label>
          <label>数量 <input type="number" min="1" v-model.number="retForm.qty" /></label>
          <label>原因 <input v-model="retForm.reason" placeholder="如：到货破损/临期/质量问题" /></label>
          <p class="muted" style="font-size:12px">未付货款优先冲减应付；已付款部分供应商退回现金，库存按批次回减。</p>
        </div>
        <div class="acts"><button class="primary" @click="doPurchaseReturn">确认退货</button><button class="ghost" @click="retModal=false">取消</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：游客销售退货 ============ -->
    <div class="modal" v-if="saleRetModal" @click.self="saleRetModal=false">
      <div class="modal-box card">
        <h3>↩️ 游客销售退货</h3>
        <div class="form">
          <label>退货商铺
            <select v-model.number="saleRet.vendor_id"><option v-for="v in store.vendors" :key="v.id" :value="v.id">{{ v.name }}（售价 ¥{{v.price}}）</option></select>
          </label>
          <label>数量 <input type="number" min="1" v-model.number="saleRet.qty" /></label>
          <label>原因 <input v-model="saleRet.reason" placeholder="如：商品质量/游客退换" /></label>
          <p class="muted" style="font-size:12px">按商铺售价退还现金（商业流水红字），物资按原批次回补库存。</p>
        </div>
        <div class="acts"><button class="primary" @click="doSaleReturn">确认退货退款</button><button class="ghost" @click="saleRetModal=false">取消</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：盘点录入 ============ -->
    <div class="modal" v-if="stDetail" @click.self="closeSt">
      <div class="modal-box card wide">
        <h3>📋 {{ stDetail.code }} · {{ stDetail.scope==='all'?'全仓盘点':'商铺盘点' }}</h3>
        <div class="mini-table">
          <div class="mini-head st2-head"><span>物资</span><span>账面数</span><span>实盘数</span><span>差异</span><span>成本差异</span></div>
          <div class="mini-row st2-head" v-for="it in stDetail.items" :key="it.id">
            <span>{{ it.material_name }}</span>
            <span>{{ it.qty_book }} {{ it.unit }}</span>
            <span><input type="number" min="0" style="width:100px" v-model.number="stActuals[it.id]" :disabled="stDetail.status!=='open'" /></span>
            <span :class="(stActuals[it.id]-it.qty_book)<0?'money neg':(stActuals[it.id]-it.qty_book)>0?'money':'muted'">
              {{ (stActuals[it.id]-it.qty_book > 0 ? '+' : '') + (Math.round((stActuals[it.id]-it.qty_book)*10)/10) }}
            </span>
            <span class="money" :class="((stActuals[it.id]-it.qty_book)*it.unit_cost)<0?'neg':''">
              ¥{{ Math.round((stActuals[it.id]-it.qty_book)*it.unit_cost) }}
            </span>
          </div>
        </div>
        <div class="acts">
          <button class="primary" v-if="stDetail.status==='open'" @click="submitSt">提交盘点（生成待审批差异）</button>
          <button class="ghost" @click="closeSt">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.proc { display: flex; flex-direction: column; gap: 14px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px,1fr)); gap: 12px; }
.kpi { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; }
.kpi em { font-style: normal; font-size: 12px; color: var(--muted); }
.kpi b { font-size: 21px; }
.kpi span { font-size: 11px; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tabs button { position: relative; display: flex; align-items: center; gap: 6px; }
.tabs button.on { border-color: var(--accent); color: var(--accent); background: rgba(255,107,107,.1); }
.badge { font-style: normal; font-size: 10px; background: var(--accent2); color: #4a3200; border-radius: 10px; padding: 0 6px; line-height: 16px; }
.badge.red { background: var(--red); color: #fff; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.filters button.on { border-color: var(--blue); color: var(--blue); }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; gap: 8px; align-items: center; padding: 10px 12px; font-size: 13px; min-width: 900px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.stock-head { grid-template-columns: 1.4fr .7fr .9fr .7fr .9fr .7fr .9fr .7fr 1.2fr .9fr; }
.po-head { grid-template-columns: 1fr 1.2fr 1fr .8fr 1fr 1.2fr .7fr .7fr; }
.link-head { grid-template-columns: 1fr .8fr 1fr 1fr; }
.batch-head { grid-template-columns: .8fr 1.2fr 1.1fr .8fr .7fr .7fr .7fr 1fr 1fr; }
.ret-head { grid-template-columns: .8fr .9fr 1.2fr .6fr .7fr 1fr 1.4fr .6fr; }
.st-head { grid-template-columns: .8fr 1fr .7fr .8fr 1fr .7fr 1.6fr; }
.code { display: block; font-size: 11px; font-style: normal; }
.st-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.st-ok { color: var(--green); } .st-low { color: var(--accent2); } .st-out { color: var(--red); }
.st-dot.st-ok { background: var(--green); } .st-dot.st-low { background: var(--accent2); } .st-dot.st-out { background: var(--red); }
.ops { display: flex; gap: 6px; }
.ops button { padding: 5px 10px; font-size: 12px; }
.empty { padding: 18px; text-align: center; }
.pstat { font-style: normal; font-size: 10px; }
.red-tag { background: rgba(255,107,107,.18); color: var(--red); border-color: rgba(255,107,107,.45); margin-left:4px; }
.warn-text { color: var(--accent2); }
.sup-cards { display: grid; grid-template-columns: repeat(auto-fill,minmax(290px,1fr)); gap: 14px; }
.sup { display: flex; flex-direction: column; gap: 10px; }
.sup-h { display: flex; align-items: center; gap: 8px; }
.sup-h b { margin-right: auto; }
.sup-m { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 13px; }
.sup-m em { font-style: normal; display: block; font-size: 11px; }
.sup-a { display: flex; gap: 8px; border-top: 1px solid var(--border); padding-top: 10px; }
.tag-on { color: var(--green); border-color: rgba(109,213,160,.4); background: rgba(109,213,160,.12); }
.tag-off { color: var(--red); border-color: rgba(255,107,107,.4); background: rgba(255,107,107,.12); }
.tag-red { color: var(--red); border-color: rgba(255,107,107,.45); background: rgba(255,107,107,.15); }
.tag-warn { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.12); }
.findings { display: flex; flex-direction: column; gap: 10px; }
.find { display: flex; gap: 14px; align-items: flex-start; border-left: 3px solid var(--border); }
.find.sev-critical { border-left-color: var(--red); }
.find.sev-warn { border-left-color: var(--accent2); }
.f-ic { font-size: 24px; }
.f-body { flex: 1; }
.f-h { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.f-meta { font-size: 11px; margin-top: 5px; }
.f-acts { display: flex; flex-direction: column; gap: 6px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal-box { width: min(520px,94vw); max-height: 88vh; overflow-y: auto; }
.modal-box.wide { width: min(760px,95vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form-row label { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 5px; }
.form .chk { flex-direction: row; align-items: center; gap: 8px; }
.acts { display: flex; gap: 8px; }
.checklist { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 10px 0; max-height: 300px; overflow-y: auto; }
.checklist label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text); background: var(--panel2); padding: 7px 10px; border-radius: 8px; }
.po-lines { display: flex; flex-direction: column; gap: 6px; }
.line-h, .line-r { display: flex; gap: 8px; align-items: center; }
.line-h { font-size: 11px; color: var(--muted); padding: 0 2px; }
.line-h span:first-child, .line-r select { flex: 1; }
.po-total { text-align: right; font-size: 14px; }
.mini-table { margin: 10px 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.mini-head, .mini-row { display: grid; grid-template-columns: repeat(5,1fr); gap: 8px; padding: 8px 12px; font-size: 12.5px; align-items: center; }
.mini-head { background: var(--panel2); color: var(--muted); font-size: 11.5px; }
.mini-row { border-top: 1px solid var(--border); }
.det-head { grid-template-columns: 1.4fr .7fr .7fr .7fr .7fr 1fr; }
.st2-head { grid-template-columns: 1.4fr .9fr 1.1fr .8fr .9fr; }
.d-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; margin: 10px 0; }
.d-acts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.d-sub { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; font-size: 12px; }
.logs { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; max-height: 150px; overflow-y: auto; }
.log-line { font-size: 12px; padding: 3px 0; }
</style>
