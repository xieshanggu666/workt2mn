<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const tab = ref('applications')
const tabs = [
  { k: 'applications', icon: '📝', label: '入驻审核' },
  { k: 'contracts', icon: '🤝', label: '联营合同' },
  { k: 'sales', icon: '🧾', label: '分账流水' },
  { k: 'settlements', icon: '💰', label: '结算账单' }
]

const stats = computed(() => store.partnerStats)
const zoneName = id => store.zones.find(z => z.id === id)?.name || ''

// ---------------- 入驻申请 ----------------
const applyOpen = ref(false)
const appFilter = ref('applied')
const appForm = ref({
  mode: 'existing', vendor_id: null, name: '', contact: '', phone: '',
  type: '餐饮', zone_id: 1, license: '', proposal: '',
  commission_rate: 0.2, settle_period_days: 7, deposit: 5000
})
const appList = computed(() => store.partnerApplications.filter(a => !appFilter.value || a.status === appFilter.value))

function openApply() {
  appForm.value = {
    mode: 'existing', vendor_id: store.vendors[0]?.id || null, name: '', contact: '', phone: '',
    type: '餐饮', zone_id: 1, license: '', proposal: '',
    commission_rate: 0.2, settle_period_days: 7, deposit: 5000
  }
  applyOpen.value = true
}
function submitApply() {
  const f = appForm.value
  store.applyPartner({ ...f, applicant_staff_id: store.supervisors[0]?.id || null })
  applyOpen.value = false
}
function onModeChange() {
  if (appForm.value.mode === 'existing') {
    const v = store.vendors.find(x => x.id === Number(appForm.value.vendor_id))
    if (v) { appForm.value.name = v.name; appForm.value.type = v.type; appForm.value.zone_id = v.zone_id }
  }
}
function withdraw(a) { if (confirm(`确认撤回 ${a.code} 的入驻申请？`)) store.withdrawPartnerApplication(a.id) }

// 审核弹窗
const reviewOpen = ref(false)
const reviewTarget = ref(null)
const reviewForm = ref({ commission_rate: 0.2, settle_period_days: 7, deposit: 5000, member_discount_share: 1, staff_id: null })
function openReview(a) {
  reviewTarget.value = a
  reviewForm.value = {
    commission_rate: a.commission_rate, settle_period_days: a.settle_period_days, deposit: a.deposit,
    member_discount_share: 1, staff_id: store.supervisors[0]?.id || null
  }
  reviewOpen.value = true
}
function confirmApprove() {
  store.approvePartnerApplication(reviewTarget.value.id, {
    commission_rate: Number(reviewForm.value.commission_rate),
    settle_period_days: Number(reviewForm.value.settle_period_days),
    deposit: Number(reviewForm.value.deposit),
    member_discount_share: Number(reviewForm.value.member_discount_share),
    staff_id: reviewForm.value.staff_id
  })
  reviewOpen.value = false
}
function reject(a) {
  const reason = prompt('驳回原因：', '资质不符')
  if (reason !== null) store.rejectPartnerApplication(a.id, { reason, staff_id: store.supervisors[0]?.id || null })
}

const APP_STATUS = {
  applied: { t: '待审核', c: 'var(--accent2)' },
  approved: { t: '已签约', c: 'var(--green)' },
  rejected: { t: '已驳回', c: 'var(--red)' },
  withdrawn: { t: '已撤回', c: 'var(--muted)' }
}
// 申请表扣点按百分数输入（底层存 0~1 小数）
const applyRatePct = computed({
  get: () => Math.round((Number(appForm.value.commission_rate) || 0) * 100),
  set: v => { appForm.value.commission_rate = Math.max(5, Math.min(80, Number(v) || 0)) / 100 }
})
const reviewRatePct = computed({
  get: () => Math.round((Number(reviewForm.value.commission_rate) || 0) * 100),
  set: v => { reviewForm.value.commission_rate = Math.max(5, Math.min(80, Number(v) || 0)) / 100 }
})

// ---------------- 合同 ----------------
const contractFilter = ref('active')
const contractList = computed(() => store.partnerContracts.filter(c => !contractFilter.value || c.status === contractFilter.value))
function terminate(c) {
  if (!confirm(`确认终止与「${c.vendor_name}」的合同 ${c.code}？\n终止后将生成清算账单，未结销售/退货/罚没与保证金一并清算。`)) return
  // 第二步：确定=扣没保证金；取消=保证金随清算账退还
  const forfeit = c.deposit > 0
    ? confirm(`是否扣没保证金 ¥${c.deposit.toLocaleString()}？\n\n【确定】商户违约，全额扣没\n【取消】正常解约，保证金随清算账退还商户`)
    : false
  const reason = prompt('终止原因：', forfeit ? '商户违规，按约扣没保证金' : '协议到期正常解约')
  if (reason === null) return
  store.terminatePartnerContract(c.id, { reason, forfeit_deposit: forfeit })
}
function issueBill(c) {
  if (!confirm(`为「${c.vendor_name}」立即生成当期结算账单？`)) return
  store.issuePartnerSettlement(c.id, {})
}

const pctText = r => `${Math.round(r * 100)}%`

// ---------------- 销售流水 ----------------
const salesVendor = ref('')
const salesKind = ref('')
const salesRows = computed(() => store.partnerSales.filter(s =>
  (!salesVendor.value || s.vendor_id === Number(salesVendor.value)) &&
  (!salesKind.value || s.kind === salesKind.value)))

// ---------------- 结算账单 ----------------
const billFilter = ref('')
const billList = computed(() => store.partnerSettlements.filter(b => !billFilter.value || b.status === billFilter.value))
function pay(b) {
  if (!confirm(`支付联营账单 ${b.code}：向「${b.vendor_name}」支付 ¥${b.payable}？`)) return
  store.payPartnerSettlement(b.id, store.supervisors[0]?.id || null)
}
const BILL_STATUS = {
  draft: { t: '待支付', c: 'var(--accent2)' },
  paid: { t: '已支付', c: 'var(--green)' },
  overdue: { t: '挂账', c: 'var(--red)' }
}
const billStatus = s => BILL_STATUS[s] || { t: s, c: 'var(--muted)' }
</script>

<template>
  <div class="partner">
    <!-- 顶部统计 -->
    <div class="stats-grid">
      <div class="card stat"><em>履约中合同</em><b>{{ stats.contracts.active }}</b><span class="muted">已终止 {{ stats.contracts.terminated }}</span></div>
      <div class="card stat"><em>入驻待审核</em><b class="warn">{{ stats.applications.applied }}</b><span class="muted">累计签约 {{ stats.applications.approved }}</span></div>
      <div class="card stat"><em>今日分账流水</em><b class="money">{{ stats.today.bill.toLocaleString() }}</b><span class="muted">园方扣点 ¥{{ stats.today.parkShare }} · 商户 ¥{{ stats.today.merchantShare }}</span></div>
      <div class="card stat"><em>今日退货/罚没</em><b class="neg">{{ Math.abs(stats.today.refund) }}</b><span class="muted">投诉罚没 ¥{{ stats.today.fines }}</span></div>
      <div class="card stat"><em>待支付账单</em><b class="warn">{{ stats.bills.draft }}</b><span class="muted">挂账 {{ stats.bills.overdue }} 笔</span></div>
      <div class="card stat"><em>待付商户款</em><b class="money neg">¥{{ stats.bills.payable.toLocaleString() }}</b><span class="muted">今日已付 ¥{{ stats.bills.paidToday }}</span></div>
    </div>

    <div class="bar card">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">
          <span>{{ t.icon }}</span>{{ t.label }}
          <i v-if="t.k === 'applications' && stats.applications.applied" class="badge">{{ stats.applications.applied }}</i>
          <i v-if="t.k === 'settlements' && stats.bills.draft + stats.bills.overdue" class="badge red">{{ stats.bills.draft + stats.bills.overdue }}</i>
        </button>
      </div>
      <button v-if="tab === 'applications'" class="primary" @click="openApply">＋ 新入驻申请</button>
    </div>

    <!-- 入驻审核 -->
    <template v-if="tab === 'applications'">
      <div class="filter">
        <button v-for="f in [['applied','待审核'],['approved','已签约'],['rejected','已驳回'],['withdrawn','已撤回'],['','全部']]" :key="f[0]"
                :class="{ on: appFilter === f[0] }" @click="appFilter = f[0]">{{ f[1] }}</button>
      </div>
      <div class="card table-card">
        <table>
          <thead><tr><th>申请号</th><th>商户</th><th>联系人</th><th>类型/区域</th><th>申请扣点</th><th>账期</th><th>保证金</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="a in appList" :key="a.id">
              <td>{{ a.code }}</td>
              <td><b>{{ a.name }}</b><div class="muted sm">{{ a.vendor_name ? '存量转联营：' + a.vendor_name : '新商户入驻' }}</div></td>
              <td>{{ a.contact }}<div class="muted sm">{{ a.phone }}</div></td>
              <td>{{ a.type }} / {{ a.zone_name }}</td>
              <td>{{ pctText(a.commission_rate) }}</td>
              <td>{{ a.settle_period_days }} 天</td>
              <td class="money">¥{{ a.deposit.toLocaleString() }}</td>
              <td><span class="tag" :style="{ color: APP_STATUS[a.status].c, borderColor: APP_STATUS[a.status].c + '66' }">{{ APP_STATUS[a.status].t }}</span></td>
              <td class="ops">
                <button v-if="a.status === 'applied'" class="succ" @click="openReview(a)">审核签约</button>
                <button v-if="a.status === 'applied'" class="danger" @click="reject(a)">驳回</button>
                <button v-if="a.status === 'applied'" class="ghost" @click="withdraw(a)">撤回</button>
                <span v-else class="muted sm">{{ a.reviewer_name ? '审核：' + a.reviewer_name : '' }}{{ a.reject_reason ? ' · ' + a.reject_reason : '' }}</span>
              </td>
            </tr>
            <tr v-if="!appList.length"><td colspan="9" class="muted center">暂无申请</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 合同 -->
    <template v-if="tab === 'contracts'">
      <div class="filter">
        <button :class="{ on: contractFilter === 'active' }" @click="contractFilter = 'active'">履约中</button>
        <button :class="{ on: contractFilter === 'terminated' }" @click="contractFilter = 'terminated'">已终止</button>
        <button :class="{ on: contractFilter === '' }" @click="contractFilter = ''">全部</button>
      </div>
      <div class="contracts">
        <div class="card cc" v-for="c in contractList" :key="c.id">
          <div class="cc-head">
            <b>{{ c.code }} · {{ c.vendor_name }}</b>
            <span class="tag" :style="{ color: c.status === 'active' ? 'var(--green)' : 'var(--muted)' }">
              {{ c.status === 'active' ? '履约中' : '已终止' }}
            </span>
          </div>
          <div class="cc-grid">
            <div><em>园方扣点</em><b>{{ pctText(c.commission_rate) }}</b></div>
            <div><em>会员优惠商户承担</em><b>{{ pctText(c.member_discount_share) }}</b></div>
            <div><em>结算周期</em><b>{{ c.settle_period_days }} 天</b></div>
            <div><em>保证金</em><b class="money">¥{{ c.deposit.toLocaleString() }}</b></div>
            <div><em>生效日</em><b>第 {{ c.start_day }} 天</b></div>
            <div><em>待付账单</em><b :class="c.pending_payable ? 'money neg' : ''">¥{{ c.pending_payable.toLocaleString() }}（{{ c.pending_bills }} 笔）</b></div>
          </div>
          <div class="cc-ops" v-if="c.status === 'active'">
            <button class="primary" @click="issueBill(c)">立即出账</button>
            <button class="danger" @click="terminate(c)">终止合同/清算</button>
          </div>
        </div>
        <div v-if="!contractList.length" class="muted center pad">暂无合同</div>
      </div>
    </template>

    <!-- 分账流水 -->
    <template v-if="tab === 'sales'">
      <div class="filter">
        <select v-model="salesVendor"><option value="">全部商铺</option><option v-for="v in store.vendors" :key="v.id" :value="v.id">{{ v.name }}</option></select>
        <button :class="{ on: salesKind === '' }" @click="salesKind = ''">全部</button>
        <button :class="{ on: salesKind === 'sale' }" @click="salesKind = 'sale'">销售</button>
        <button :class="{ on: salesKind === 'return' }" @click="salesKind = 'return'">退货红冲</button>
      </div>
      <div class="card table-card">
        <table>
          <thead><tr><th>流水号</th><th>商铺</th><th>类型</th><th>来源</th><th>会员</th><th>数量</th><th>牌价</th><th>成交</th><th>会员优惠(商户承担)</th><th>商户分账</th><th>园方扣点</th><th>账单</th></tr></thead>
          <tbody>
            <tr v-for="s in salesRows" :key="s.id" :class="{ ret: s.kind === 'return' }">
              <td>{{ s.code }}</td>
              <td>{{ s.vendor_name }}</td>
              <td><span :class="s.kind === 'return' ? 'ret-tag' : 'sale-tag'">{{ s.kind === 'return' ? '退货' : '销售' }}</span></td>
              <td>{{ s.source === 'member' ? '会员' : '散客' }}</td>
              <td>{{ s.member_code || '-' }}</td>
              <td>{{ s.qty }}</td>
              <td :class="s.gross < 0 ? 'neg' : ''">{{ s.gross }}</td>
              <td :class="s.bill_amount < 0 ? 'neg' : ''">{{ s.bill_amount }}</td>
              <td>{{ s.member_discount }}<span class="muted">（{{ s.merchant_discount_borne }}）</span></td>
              <td :class="s.merchant_share < 0 ? 'neg' : 'money'">{{ s.merchant_share }}</td>
              <td>{{ s.park_share }}</td>
              <td>{{ s.settlement_code || '未出账' }}</td>
            </tr>
            <tr v-if="!salesRows.length"><td colspan="12" class="muted center">暂无流水</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 结算账单 -->
    <template v-if="tab === 'settlements'">
      <div class="filter">
        <button :class="{ on: billFilter === '' }" @click="billFilter = ''">全部</button>
        <button :class="{ on: billFilter === 'draft' }" @click="billFilter = 'draft'">待支付</button>
        <button :class="{ on: billFilter === 'overdue' }" @click="billFilter = 'overdue'">挂账</button>
        <button :class="{ on: billFilter === 'paid' }" @click="billFilter = 'paid'">已支付</button>
      </div>
      <div class="card table-card">
        <table>
          <thead><tr><th>账单号</th><th>商户</th><th>账期</th><th>类型</th><th>净销量</th><th>成交额</th><th>商户分账</th><th>优惠承担</th><th>库存成本</th><th>投诉罚没</th><th>保证金</th><th>应付</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="b in billList" :key="b.id">
              <td>{{ b.code }}</td>
              <td>{{ b.vendor_name }}</td>
              <td class="sm">{{ b.period_from }}~{{ b.period_to }}</td>
              <td>{{ b.source === 'terminate' ? '终止清算' : '周期账' }}</td>
              <td>{{ b.sale_count }}</td>
              <td>{{ b.bill_amount }}</td>
              <td class="money">{{ b.merchant_share }}</td>
              <td class="neg">{{ b.merchant_discount_borne }}</td>
              <td class="neg">{{ b.cogs }}</td>
              <td class="neg">{{ b.fines }}</td>
              <td class="sm"><span v-if="b.deposit_offset" class="neg">扣没 {{ b.deposit_offset }}</span><span v-else-if="b.deposit_refund" class="money">退 {{ b.deposit_refund }}</span><span v-else>-</span></td>
              <td><b class="money neg">¥{{ b.payable.toLocaleString() }}</b></td>
              <td><span class="tag" :style="{ color: billStatus(b.status).c, borderColor: billStatus(b.status).c + '66' }">{{ billStatus(b.status).t }}</span></td>
              <td class="ops">
                <button v-if="b.status !== 'paid'" class="succ" @click="pay(b)">{{ b.status === 'overdue' ? '补付' : '支付' }}</button>
                <span v-else class="muted sm">第 {{ b.pay_day }} 天已付</span>
              </td>
            </tr>
            <tr v-if="!billList.length"><td colspan="14" class="muted center">暂无账单</td></tr>
          </tbody>
        </table>
      </div>
      <p class="muted sm tip">说明：应付 = 商户分账 − 会员优惠商户承担 − 消耗园区库存批次成本（FEFO）− 投诉罚没 − 保证金扣没 + 保证金退还；净额为负时自动结转下期冲抵，不出账单。</p>
    </template>

    <!-- 新入驻申请弹窗 -->
    <div class="modal" v-if="applyOpen" @click.self="applyOpen = false">
      <div class="modal-box card">
        <h3>📝 联营商户入驻申请</h3>
        <div class="form">
          <label class="row2">
            <span>入驻方式</span>
            <select v-model="appForm.mode">
              <option value="existing">存量商铺转联营</option>
              <option value="new">新商户入驻（审核通过后建铺）</option>
            </select>
          </label>
          <label class="row2" v-if="appForm.mode === 'existing'">
            <span>选择商铺</span>
            <select v-model="appForm.vendor_id" @change="onModeChange">
              <option v-for="v in store.vendors" :key="v.id" :value="v.id">{{ v.name }}（{{ v.type }}）</option>
            </select>
          </label>
          <label class="row2"><span>商户/品牌名称</span><input v-model="appForm.name" placeholder="必填" /></label>
          <label class="row2"><span>联系人</span><input v-model="appForm.contact" placeholder="必填" /></label>
          <label class="row2"><span>联系电话</span><input v-model="appForm.phone" /></label>
          <div class="row2-3">
            <label><span>类型</span>
              <select v-model="appForm.type" :disabled="appForm.mode === 'existing'"><option>餐饮</option><option>饮品</option><option>纪念品</option></select>
            </label>
            <label><span>区域</span>
              <select v-model.number="appForm.zone_id" :disabled="appForm.mode === 'existing'"><option v-for="z in store.zones.filter(z=>z.unlocked)" :key="z.id" :value="z.id">{{ z.name }}</option></select>
            </label>
            <label><span>资质编号</span><input v-model="appForm.license" placeholder="营业执照" /></label>
          </div>
          <div class="row2-3">
            <label><span>申请扣点 %</span><input type="number" step="1" min="5" max="80" v-model.number="applyRatePct" /></label>
            <label><span>结算周期(天)</span><select v-model.number="appForm.settle_period_days"><option v-for="p in store.partnerConst.periodChoices" :key="p" :value="p">{{ p }}</option></select></label>
            <label><span>保证金 ¥</span><input type="number" min="0" step="500" v-model.number="appForm.deposit" /></label>
          </div>
          <label class="row2"><span>经营方案</span><textarea v-model="appForm.proposal" rows="2" placeholder="拟售商品/服务承诺"></textarea></label>
        </div>
        <div class="acts">
          <button class="primary" @click="submitApply">提交申请</button>
          <button class="ghost" @click="applyOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 审核签约弹窗 -->
    <div class="modal" v-if="reviewOpen" @click.self="reviewOpen = false">
      <div class="modal-box card">
        <h3>✅ 审核联营签约 · {{ reviewTarget.code }}</h3>
        <p class="muted sm">{{ reviewTarget.name }} · {{ reviewTarget.contact }} {{ reviewTarget.phone }}</p>
        <div class="form">
          <div class="row2-3">
            <label><span>核定扣点 %</span><input type="number" step="1" min="5" max="80" v-model.number="reviewRatePct" /></label>
            <label><span>结算周期(天)</span><select v-model.number="reviewForm.settle_period_days"><option v-for="p in store.partnerConst.periodChoices" :key="p" :value="p">{{ p }}</option></select></label>
            <label><span>保证金 ¥</span><input type="number" min="0" step="500" v-model.number="reviewForm.deposit" /></label>
          </div>
          <label class="row2"><span>会员优惠商户承担比例</span>
            <select v-model.number="reviewForm.member_discount_share">
              <option :value="1">100%（商户全额让利，园方仅按成交额抽成）</option>
              <option :value="0.5">50%（商户与园方各承担一半优惠）</option>
              <option :value="0">0%（会员折扣全部由园方承担）</option>
            </select>
          </label>
          <p class="muted sm tip">签约即向商户收取保证金（园方代管）；新商户审核通过后自动建铺（园区不承担建设费），存量商铺转联营后停收固定租金，改按销售流水分账。</p>
        </div>
        <div class="acts">
          <button class="succ" @click="confirmApprove">通过并签约</button>
          <button class="ghost" @click="reviewOpen = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.partner { display: flex; flex-direction: column; gap: 14px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.stat b { font-size: 24px; }
.stat b.warn { color: var(--accent2); }
.bar { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; }
.tabs { display: flex; gap: 6px; }
.tabs button { position: relative; background: transparent; }
.tabs button.on { background: var(--panel2); border-color: rgba(255,107,107,.5); color: var(--accent); }
.badge { position: absolute; top: -6px; right: -6px; background: var(--accent2); color: #221a00; font-size: 10px; font-style: normal; border-radius: 20px; padding: 0 5px; font-weight: 700; }
.badge.red { background: var(--red); color: #fff; }
.filter { display: flex; gap: 8px; flex-wrap: wrap; }
.filter button.on { background: var(--panel2); border-color: var(--accent); color: var(--accent); }
.table-card { padding: 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 12px; background: rgba(255,255,255,.02); position: sticky; top: 0; }
tr:last-child td { border-bottom: none; }
tr.ret td { background: rgba(255,107,107,.05); }
.center { text-align: center; }
.sm { font-size: 11px; }
.neg { color: var(--red) !important; }
.ops { display: flex; gap: 6px; }
.sale-tag { color: var(--green); }
.ret-tag { color: var(--red); }
.contracts { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; }
.cc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.cc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cc-grid div { background: var(--panel2); border-radius: 8px; padding: 8px 10px; }
.cc-grid em { display: block; font-style: normal; font-size: 11px; color: var(--muted); }
.cc-grid b { font-size: 15px; }
.cc-ops { display: flex; gap: 8px; margin-top: 12px; }
.pad { padding: 30px; }
.tip { margin-top: 8px; line-height: 1.7; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { width: min(620px, 94vw); max-height: 88vh; overflow-y: auto; }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.form .row2 { display: grid; grid-template-columns: 110px 1fr; align-items: center; gap: 10px; }
.row2-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.row2-3 label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
textarea { background: #10162a; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
.acts { display: flex; gap: 8px; }
</style>
