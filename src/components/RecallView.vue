<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const STATUS = {
  issued: { t: '待供应商受理', c: 'var(--accent2)' },
  processing: { t: '处置中', c: 'var(--blue)' },
  closed: { t: '已结案', c: 'var(--green)' },
  closed_false: { t: '误报结案', c: 'var(--muted)' },
  cancelled: { t: '已撤销', c: 'var(--red)' }
}
const st = s => STATUS[s] || { t: s, c: 'var(--muted)' }
const VSTATUS = { notified: { t: '已通知待确认', c: 'var(--accent2)' }, acknowledged: { t: '商户已确认', c: 'var(--blue)' }, refunded: { t: '已退货退款', c: 'var(--green)' }, none: { t: '无在途/线下已退', c: 'var(--muted)' } }

const stats = computed(() => store.recallStats)

const filter = ref('')
const filtered = computed(() => store.recalls.filter(r => !filter.value || r.status === filter.value))
const counts = computed(() => {
  const c = {}
  for (const r of store.recalls) c[r.status] = (c[r.status] || 0) + 1
  return c
})

// ---------------- 发起召回 ----------------
const createModal = ref(false)
const form = ref({})
function openCreate() {
  form.value = {
    material_id: store.materials[0]?.id || null,
    supplier_id: null,
    severity: 2,
    reason: '',
    mode: 'all',       // all=该物资全部在库批次；pick=指定批次
    batchIds: [],
    batches: []
  }
  loadCandidates()
  createModal.value = true
}
const candidates = ref([])
function loadCandidates() {
  const m = store.materials.find(x => x.id === +form.value.material_id)
  // 优先用物资首选供应商兜底
  if (m && !form.value.supplier_id) form.value.supplier_id = m.preferred_supplier_id
  // 切换物资时清空已选批次
  form.value.batchIds = []
  // state 中仅有临期批次，候选批次按物资从批次接口拉取（仅在库且有未隔离余量）
  candidates.value = []
  store.stockBatches(`?material_id=${form.value.material_id}`).then(r => {
    candidates.value = (r.list || []).filter(b => b.status === 'in' && (b.qty_remain - (b.quarantined_qty || 0)) > 0)
  })
}
function toggleBatch(id, checked) {
  const set = new Set(form.value.batchIds)
  if (checked) set.add(id); else set.delete(id)
  form.value.batchIds = [...set]
}
const pickedBatches = computed(() => candidates.value.filter(b => form.value.batchIds.includes(b.id)))
const pickQty = computed(() => pickedBatches.value.reduce((s, b) => s + (b.qty_remain - (b.quarantined_qty || 0)), 0))
async function submitCreate() {
  const payload = {
    supplier_id: +form.value.supplier_id,
    material_id: +form.value.material_id,
    severity: +form.value.severity,
    reason: form.value.reason,
    batches: form.value.mode === 'pick' ? form.value.batchIds.map(id => ({ batch_id: id })) : []
  }
  const r = await store.createRecall(payload)
  if (r.ok) createModal.value = false
  else alert(r.msg || '发起召回失败')
}

// ---------------- 详情 ----------------
const detail = ref(null)
const refundMap = ref({})
const returnQty = ref(0)
const destroyQty = ref(0)
const compAmount = ref(0)
async function openDetail(r) {
  const res = await store.recallDetail(r.id)
  if (!res.ok) return alert(res.msg || '加载失败')
  detail.value = res
  refundMap.value = {}
  for (const rv of res.recall.vendors) {
    if (rv.remain_qty > 0) refundMap.value[rv.vendor_id] = rv.remain_qty
  }
  returnQty.value = res.recall.remain_quarantine
  destroyQty.value = res.recall.remain_quarantine
  compAmount.value = res.quote?.suggested || 0
}
function closeDetail() { detail.value = null }

async function act(fn, ...args) {
  const r = await fn(...args)
  if (!r?.ok) {
    // 退款进入统一补偿队列（事务失败自动重试）：告知用户已挂起，可在「停运补偿」页跟踪
    if (r.queued || r.code === 'QUEUED_COMPENSATION') { alert(r.msg || '已进入停运补偿队列，系统将自动重试完成退款/红冲') }
    else alert(r?.msg || '操作失败')
    if (detail.value) await openDetail({ id: detail.value.recall.id })
    return
  }
  if (detail.value) await openDetail({ id: detail.value.recall.id })
}
const doAccept = () => act(store.acceptRecall.bind(store), detail.value.recall.id, null)
const doAck = (vendorId) => act(store.acknowledgeRecallVendor.bind(store), detail.value.recall.id, vendorId, '')
const doRefund = (rv) => act(store.recallVendorRefund.bind(store), detail.value.recall.id, rv.vendor_id, +refundMap.value[rv.vendor_id] || 1, '')
const doNone = async (rv) => {
  const note = prompt('确认该商铺剩余数量无在途游客或已在线下完成退换？（说明，可留空）', '')
  if (note === null) return
  await act(store.recallVendorNone.bind(store), detail.value.recall.id, rv.vendor_id, note)
}
const doReturn = () => act(store.recallReturnBatches.bind(store), detail.value.recall.id, +returnQty.value)
const doDestroy = () => {
  if (!confirm(`确认现场销毁 ${destroyQty.value} 份问题批次？将按批次成本核销物料损失（不退供应商）。`)) return
  act(store.recallDestroyBatches.bind(store), detail.value.recall.id, +destroyQty.value, '')
}
const doComp = () => act(store.recallPayCompensation.bind(store), detail.value.recall.id, +compAmount.value, '')
const doClose = () => act(store.closeRecall.bind(store), detail.value.recall.id, '')
const doFalse = () => {
  const reason = prompt('误报结案说明（批次复检合格，解除隔离恢复销售）', '批次复检合格') ?? null
  if (reason === null) return
  act(store.closeFalseRecall.bind(store), detail.value.recall.id, reason)
}
const doCancel = () => {
  if (!confirm('撤销召回将解除全部批次隔离并恢复销售，确认？')) return
  act(store.cancelRecall.bind(store), detail.value.recall.id, '')
}

const LOG_ACTOR = { park: '园方', supplier: '供应商', partner: '联营商户', system: '系统' }
</script>

<template>
  <div class="recall">
    <div class="kpis">
      <div class="kpi card"><em>在途召回</em><b :class="stats.open ? 'neg money' : ''">{{ stats.open }}</b><span class="muted">待受理 {{ stats.issued }} / 处置中 {{ stats.processing }}</span></div>
      <div class="kpi card"><em>隔离在库批次</em><b class="money">{{ stats.openBatchQty }}</b><span class="muted">待退回供应商 / 销毁</span></div>
      <div class="kpi card"><em>待退款商铺</em><b :class="stats.pendingRefundVendors ? 'neg money' : ''">{{ stats.pendingRefundVendors }}</b><span class="muted">联营待确认 {{ stats.pendingVendors }}</span></div>
      <div class="kpi card"><em>游客退款累计</em><b class="money neg">¥{{ stats.refundTotal.toLocaleString() }}</b><span class="muted">在途 ¥{{ stats.openRefund.toLocaleString() }}</span></div>
      <div class="kpi card"><em>供应商赔付到账</em><b class="money">¥{{ stats.compensationTotal.toLocaleString() }}</b><span class="muted">已结案召回</span></div>
    </div>

    <div class="bar">
      <div class="filters">
        <button :class="{ on: filter === '' }" @click="filter = ''">全部</button>
        <button :class="{ on: filter === 'issued' }" @click="filter = 'issued'">待受理 {{ counts.issued || '' }}</button>
        <button :class="{ on: filter === 'processing' }" @click="filter = 'processing'">处置中 {{ counts.processing || '' }}</button>
        <button :class="{ on: filter === 'closed' }" @click="filter = 'closed'">已结案 {{ counts.closed || '' }}</button>
        <button :class="{ on: filter === 'closed_false' }" @click="filter = 'closed_false'">误报</button>
        <button :class="{ on: filter === 'cancelled' }" @click="filter = 'cancelled'">已撤销</button>
      </div>
      <button class="primary" @click="openCreate">＋ 新增供应商批次召回</button>
    </div>

    <div class="table card">
      <div class="thead head">
        <span>召回单</span><span>供应商</span><span>问题物资</span><span>等级</span><span>隔离量</span>
        <span>退货/销毁</span><span>游客退款</span><span>供应商赔付</span><span>受影响商铺</span><span>状态</span><span>操作</span>
      </div>
      <div class="trow head" v-for="r in filtered" :key="r.id">
        <span><b>{{ r.code }}</b><em class="muted code">第{{ r.create_day }}天</em></span>
        <span>{{ r.supplier_name }}</span>
        <span>{{ r.material_name }}<em class="muted code">{{ r.reason }}</em></span>
        <span><i class="sev" :class="'sev-' + r.severity">{{ r.severity_name }}</i></span>
        <span><b>{{ r.batch_qty }} {{ r.unit }}</b><em v-if="r.remain_quarantine" class="tag tag-warn">隔离中 {{ r.remain_quarantine }}</em></span>
        <span>{{ r.returned_qty }} / {{ r.destroyed_qty }}<em class="muted code">¥{{ r.return_amount + r.destroy_cost }}</em></span>
        <span>{{ r.refund_qty }}<em class="muted code">¥{{ r.refund_amount }}</em></span>
        <span class="money">¥{{ r.compensation_amount.toLocaleString() }}<em v-if="r.penalty_amount" class="muted code">罚则 ¥{{ r.penalty_amount }}</em></span>
        <span>{{ r.affected_vendor_count }} 家</span>
        <span><i class="dot" :style="{ color: st(r.status).c }">●</i>{{ st(r.status).t }}</span>
        <span class="ops"><button class="ghost" @click="openDetail(r)">处置详情</button></span>
      </div>
      <div class="muted empty" v-if="!filtered.length">暂无召回单。发现供应商批次质量问题时，可发起召回联动供应商、园方与联营商户共同处置。</div>
    </div>

    <!-- ============ 弹窗：发起召回 ============ -->
    <div class="modal" v-if="createModal" @click.self="createModal = false">
      <div class="modal-box card wide">
        <h3>🚨 新增供应商批次召回</h3>
        <div class="form">
          <div class="form-row">
            <label>问题物资
              <select v-model.number="form.material_id" @change="loadCandidates">
                <option v-for="m in store.materials" :key="m.id" :value="m.id">{{ m.name }}（可售 {{ m.qty_on_hand }} {{ m.unit }}）</option>
              </select>
            </label>
            <label>责任供应商
              <select v-model.number="form.supplier_id">
                <option v-for="s in store.suppliers" :key="s.id" :value="s.id">{{ s.name }}（{{ s.category }}）</option>
              </select>
            </label>
          </div>
          <div class="form-row">
            <label>严重等级
              <select v-model.number="form.severity">
                <option :value="1">一般（质量瑕疵）</option>
                <option :value="2">严重（变质/异物）</option>
                <option :value="3">紧急（食品安全/健康危害）</option>
              </select>
            </label>
            <label>隔离范围
              <select v-model="form.mode">
                <option value="all">该物资全部在库批次</option>
                <option value="pick">指定批次</option>
              </select>
            </label>
          </div>
          <label>召回原因 <input v-model="form.reason" placeholder="如：检出微生物超标 / 混入异物 / 防腐剂超量" /></label>
          <div v-if="form.mode === 'pick'" class="batchpick">
            <div class="bp-h"><span></span><span>批次号</span><span>入库日/到期</span><span>可用量</span></div>
            <label class="bp-r" v-for="b in candidates" :key="b.id">
              <input type="checkbox" :checked="form.batchIds.includes(b.id)" @change="toggleBatch(b.id, $event.target.checked)" />
              <span>{{ b.code }}</span>
              <span>{{ b.receive_day }} / {{ b.expire_day || '—' }}</span>
              <span>{{ b.qty_remain - (b.quarantined_qty || 0) }}</span>
            </label>
            <div class="muted" v-if="!candidates.length">该物资暂无在库批次</div>
            <div class="muted" v-if="form.batchIds.length">已选 {{ form.batchIds.length }} 批，共隔离 {{ pickQty }}</div>
          </div>
          <p class="muted tip">发起后将：① 立即隔离批次停售；② 通知销售过该物资的自营/联营商铺下架并联系游客退货；③ 自动生成餐饮质量投诉与事件通知。</p>
        </div>
        <div class="acts"><button class="primary" @click="submitCreate">发起召回</button><button class="ghost" @click="createModal = false">取消</button></div>
      </div>
    </div>

    <!-- ============ 弹窗：召回处置详情 ============ -->
    <div class="modal" v-if="detail" @click.self="closeDetail">
      <div class="modal-box card wide">
        <h3>🚨 {{ detail.recall.code }}
          <i class="dot" :style="{ color: st(detail.recall.status).c }">●</i>{{ st(detail.recall.status).t }}
        </h3>
        <div class="d-meta">
          <span>供应商：<b>{{ detail.recall.supplier_name }}</b></span>
          <span>物资：<b>{{ detail.recall.material_name }}</b></span>
          <span>等级：<i class="sev" :class="'sev-' + detail.recall.severity">{{ detail.recall.severity_name }}</i></span>
          <span>原因：{{ detail.recall.reason }}</span>
          <span v-if="detail.recall.complaint_code">关联投诉：<b>{{ detail.recall.complaint_code }}</b></span>
        </div>

        <!-- 步骤总览 -->
        <div class="steps">
          <div class="step" :class="{ on: ['issued','processing','closed','closed_false'].includes(detail.recall.status) }">① 发起隔离</div>
          <div class="step" :class="{ on: ['processing','closed'].includes(detail.recall.status) }">② 供应商受理</div>
          <div class="step" :class="{ on: detail.recall.vendors.some(v => ['acknowledged','refunded'].includes(v.status)) }">③ 商户协同</div>
          <div class="step" :class="{ on: detail.recall.refund_qty > 0 }">④ 退货退款</div>
          <div class="step" :class="{ on: detail.recall.returned_qty + detail.recall.destroyed_qty > 0 }">⑤ 退供/销毁</div>
          <div class="step" :class="{ on: detail.recall.compensation_amount > 0 }">⑥ 供应商赔付</div>
          <div class="step" :class="{ on: detail.recall.status === 'closed' }">⑦ 结案</div>
        </div>

        <!-- 受影响商铺（园方 + 联营商户协同） -->
        <div class="block">
          <b>受影响商铺协同（{{ detail.recall.vendors.length }} 家）</b>
          <div class="mini-table">
            <div class="mini-head vh"><span>商铺</span><span>类型</span><span>净售出</span><span>已退款</span><span>待退</span><span>状态</span><span>本次退款</span><span>操作</span></div>
            <div class="mini-row vh" v-for="rv in detail.recall.vendors" :key="rv.id">
              <span>{{ rv.vendor_name }}</span>
              <span><i class="tag" :class="rv.is_partner ? 'tag-on' : 'tag-off'">{{ rv.is_partner ? '联营' : '自营' }}</i></span>
              <span>{{ rv.sold_qty }}</span>
              <span>{{ rv.refund_qty }}<em class="muted code">¥{{ rv.refund_amount }}</em></span>
              <span>{{ rv.remain_qty }}</span>
              <span><i class="dot" :style="{ color: (VSTATUS[rv.status] || {}).c }">●</i>{{ (VSTATUS[rv.status] || {}).t }}</span>
              <span>
                <input type="number" style="width:80px" v-model.number="refundMap[rv.vendor_id]" :min="1" :max="rv.remain_qty" :disabled="rv.remain_qty<=0" />
              </span>
              <span class="ops">
                <button class="ghost" v-if="rv.is_partner && rv.status==='notified'" @click="doAck(rv.vendor_id)">商户确认</button>
                <button class="succ" v-if="rv.remain_qty>0 && ['notified','acknowledged'].includes(rv.status)" @click="doRefund(rv)">退货退款</button>
                <button class="ghost" v-if="rv.remain_qty>0 && ['notified','acknowledged'].includes(rv.status)" @click="doNone(rv)">无在途/线下退</button>
              </span>
            </div>
            <div class="muted empty" v-if="!detail.recall.vendors.length">无销售过该物资的商铺</div>
          </div>
          <p class="muted tip">自营商铺退款由园方直接退现金；联营商铺园方代退后按负向红冲行在下期结算扣回，问题商品不回库。</p>
        </div>

        <!-- 批次处置 -->
        <div class="block" v-if="['issued','processing'].includes(detail.recall.status)">
          <b>隔离批次处置</b>
          <div class="qline">
            <span>仍隔离 <b>{{ detail.recall.remain_quarantine }} {{ detail.recall.unit }}</b></span>
            <label>退供应商数量 <input type="number" v-model.number="returnQty" min="0" :max="detail.recall.remain_quarantine" /></label>
            <button class="primary" @click="doReturn">退回供应商</button>
            <label>销毁数量 <input type="number" v-model.number="destroyQty" min="0" :max="detail.recall.remain_quarantine" /></label>
            <button class="danger" @click="doDestroy">现场销毁</button>
          </div>
          <p class="muted tip">退回供应商：货款先冲未付应付、已付部分退现金并计采购退货；现场销毁：按批次成本核销物料损失（由供应商赔付）。</p>
        </div>

        <!-- 赔付 -->
        <div class="block" v-if="['issued','processing'].includes(detail.recall.status)">
          <b>供应商赔付</b>
          <div class="comp">
            <span class="tag">批次货款损失 ¥{{ detail.quote.goodsLoss }}</span>
            <span class="tag">游客退款 ¥{{ detail.quote.refund }}</span>
            <span class="tag tag-warn">严重度罚则 ¥{{ detail.quote.penalty }}</span>
            <span class="tag">仍隔离批次成本 ¥{{ detail.quote.remainStockCost }}</span>
            <label>本次赔付 <input type="number" v-model.number="compAmount" min="0" /></label>
            <button class="succ" @click="doComp">赔付到账 ¥{{ compAmount || 0 }}</button>
          </div>
          <p class="muted tip">建议赔付 ¥{{ detail.quote.suggested }}（货款损失 + 游客退款 + 罚则）；仍隔离批次建议先退供/销毁后再赔付。</p>
        </div>

        <!-- 结案动作 -->
        <div class="d-acts" v-if="['issued','processing'].includes(detail.recall.status)">
          <button class="primary" v-if="detail.recall.status==='issued'" @click="doAccept">供应商受理</button>
          <button class="succ" :disabled="detail.recall.remain_quarantine>0" @click="doClose">完成召回闭环结案</button>
          <button class="ghost" @click="doFalse">误报结案（解除隔离）</button>
          <button class="danger" v-if="detail.recall.status==='issued'" @click="doCancel">撤销召回</button>
        </div>
        <p class="muted tip" v-if="detail.recall.remain_quarantine>0 && ['issued','processing'].includes(detail.recall.status)">存在未处置隔离批次时不可结案，请先全部退回供应商或销毁。</p>

        <!-- 时间线 -->
        <div class="logs">
          <b class="muted">处置时间线</b>
          <div v-for="lg in detail.logs" :key="lg.id" class="log-line">
            <span class="muted">第{{ lg.day }}天</span><i class="tag">{{ LOG_ACTOR[lg.actor] || lg.actor }}</i>{{ lg.note }}
          </div>
        </div>
        <div class="acts"><button class="ghost" @click="closeDetail">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recall { display: flex; flex-direction: column; gap: 14px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; }
.kpi { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; }
.kpi em { font-style: normal; font-size: 12px; color: var(--muted); }
.kpi b { font-size: 21px; }
.kpi span { font-size: 11px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.filters button.on { border-color: var(--blue); color: var(--blue); }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; gap: 8px; align-items: center; padding: 10px 12px; font-size: 13px; min-width: 1080px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.head { grid-template-columns: .9fr 1.1fr 1.3fr .7fr .9fr 1fr .9fr 1fr .8fr 1fr .8fr; }
.code { display: block; font-size: 11px; font-style: normal; }
.dot { font-style: normal; font-size: 10px; }
.ops { display: flex; gap: 6px; }
.ops button { padding: 5px 10px; font-size: 12px; }
.empty { padding: 18px; text-align: center; }
.sev { font-style: normal; font-size: 11px; border-radius: 6px; padding: 2px 8px; border: 1px solid var(--border); }
.sev-1 { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.12); }
.sev-2 { color: var(--orange, #ff9e64); border-color: rgba(255,158,100,.45); background: rgba(255,158,100,.12); }
.sev-3 { color: var(--red); border-color: rgba(255,107,107,.45); background: rgba(255,107,107,.12); }
.tag-on { color: var(--green); border-color: rgba(109,213,160,.4); background: rgba(109,213,160,.12); }
.tag-off { color: var(--muted); border-color: var(--border); background: var(--panel2); }
.tag-warn { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.12); }
.tag { font-size: 11px; border: 1px solid var(--border); border-radius: 6px; padding: 1px 7px; font-style: normal; display: inline-block; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal-box { width: min(520px,94vw); max-height: 88vh; overflow-y: auto; }
.modal-box.wide { width: min(820px,95vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.acts { display: flex; gap: 8px; }
.tip { font-size: 11.5px; margin-top: 6px; line-height: 1.6; }
.batchpick { border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.bp-h, .bp-r { display: grid; grid-template-columns: 30px 1fr 1fr 80px; gap: 8px; font-size: 12px; align-items: center; }
.bp-h { color: var(--muted); }
.bp-r { background: var(--panel2); border-radius: 6px; padding: 5px 8px; }
.d-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; margin: 10px 0; }
.steps { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
.step { font-size: 11.5px; padding: 4px 9px; border-radius: 20px; border: 1px solid var(--border); color: var(--muted); background: var(--panel2); }
.step.on { color: var(--green); border-color: rgba(109,213,160,.5); background: rgba(109,213,160,.1); }
.block { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 12px; }
.block > b { display: block; margin-bottom: 8px; }
.mini-table { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.mini-head, .mini-row { display: grid; grid-template-columns: 1.2fr .7fr .6fr .8fr .6fr 1fr .9fr 1.4fr; gap: 8px; padding: 8px 10px; font-size: 12.5px; align-items: center; }
.mini-head { background: var(--panel2); color: var(--muted); font-size: 11.5px; }
.mini-row { border-top: 1px solid var(--border); }
.mini-row input { width: 80px; }
.qline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.qline label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); }
.qline input { width: 90px; }
.comp { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.comp label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); }
.comp input { width: 100px; }
.d-acts { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
.logs { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px; max-height: 170px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.log-line { font-size: 12px; display: flex; gap: 8px; align-items: center; }
.log-line .muted { white-space: nowrap; }
</style>
