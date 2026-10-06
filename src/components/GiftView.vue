<script setup>
import { ref, computed } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()

function errText(r, fallback = '操作失败，请稍后重试') {
  if (r?.ok) return ''
  const msg = r?.msg || fallback
  const tag = r?.code ? `〔${r.code}${r.reqId ? ' · ' + r.reqId : ''}〕` : ''
  return msg + tag
}

const tabs = [
  { k: 'family', label: '👨‍👩‍👧 家庭账户' },
  { k: 'apply', label: '🎁 发起转赠' },
  { k: 'claim', label: '📥 领取中心' },
  { k: 'ops', label: '🗂️ 审核与撤回' }
]
const tab = ref('family')
const stats = computed(() => store.giftStats)
const cfg = computed(() => store.giftConfig)

// 当前操作身份（会员/受赠人视角）
const actorId = ref(store.members[0]?.id || null)
const actor = computed(() => store.members.find(m => m.id === +actorId.value) || null)
const staffId = ref(store.memberSpecialists[0]?.id || store.supervisors[0]?.id || null)

const KIND_NAME = { points: '积分', balance: '储值', ticket: '免票券', voucher: '消费券', fastpass: '快速通行券' }
const KIND_ICON = { points: '⭐', balance: '💰', ticket: '🎟️', voucher: '🧧', fastpass: '⚡' }
const STATUS_BADGE = {
  pending: 'st-pending', approved: 'st-approved', claimed: 'st-claimed',
  declined: 'st-declined', rejected: 'st-rejected', cancelled: 'st-cancelled',
  recalled: 'st-recalled', expired: 'st-expired'
}

// ============ 家庭账户 ============
const famForm = ref({ name: '', member_id: null })
const famMsg = ref(null)
async function createFam() {
  famMsg.value = null
  const r = await store.createFamily({ member_id: +famForm.value.member_id || actorId.value, name: famForm.value.name })
  famMsg.value = r?.ok ? { ok: true, text: `家庭账户创建成功：${r.code}` } : { ok: false, text: errText(r) }
  if (r?.ok) famForm.value.name = ''
}
const inviteMid = ref({})
async function invite(fam) {
  const mid = +inviteMid.value[fam.id]
  if (!mid) return
  const r = await store.inviteFamily(fam.id, { member_id: mid, staff_id: +staffId.value || null })
  if (!r?.ok) alert(errText(r, '邀请失败'))
  inviteMid.value[fam.id] = ''
}
async function leave(fam) {
  const r = await store.leaveFamily(fam.id, actorId.value)
  if (!r?.ok) alert(errText(r, '退出失败'))
}
async function removeMember(fam, memberId) {
  const r = await store.removeFamilyMember(fam.id, { member_id: memberId, staff_id: +staffId.value || null })
  if (!r?.ok) alert(errText(r, '移除失败'))
}
async function dissolve(fam) {
  if (!confirm(`解散家庭账户「${fam.name}」？在途待审核/待领取的家庭共享转赠将自动回补捐赠人。`)) return
  const r = await store.dissolveFamily(fam.id, { staff_id: +staffId.value || null })
  if (!r?.ok) alert(errText(r, '解散失败'))
}
const famDetailId = ref(null)
const famDetail = ref(null)
async function openFam(fam) {
  famDetailId.value = fam.id
  const d = await store.familyDetail(fam.id)
  famDetail.value = d?.data || null
}

// ============ 发起转赠 ============
const form = ref({
  donor_id: null, kind: 'points', amount: 100,
  target: 'member', recipient_id: null, family_id: null,
  benefit_ids: [], reason: ''
})
const donorBenefits = ref([])
const applyMsg = ref(null)
const busy = ref(false)
async function loadDonorBenefits() {
  donorBenefits.value = []
  form.value.benefit_ids = []
  if (['ticket', 'voucher', 'fastpass'].includes(form.value.kind) && form.value.donor_id) {
    const d = await store.memberDetail(form.value.donor_id)
    donorBenefits.value = (d?.benefits || []).filter(b => b.kind === form.value.kind && b.status === 'unused')
  }
}
function toggleBenefit(id, checked) {
  const set = new Set(form.value.benefit_ids)
  checked ? set.add(id) : set.delete(id)
  form.value.benefit_ids = [...set]
}
const donorFamilies = computed(() => store.families.filter(f => f.active_members.some(m => m.member_id === +form.value.donor_id)))
async function submitGift() {
  if (busy.value) return
  applyMsg.value = null
  const f = form.value
  if (f.target === 'member' && !f.recipient_id) { applyMsg.value = { ok: false, text: '请选择受赠会员' }; return }
  if (f.target === 'family' && !f.family_id) { applyMsg.value = { ok: false, text: '请选择家庭共享池' }; return }
  busy.value = true
  try {
    const payload = {
      donor_member_id: f.donor_id, target: f.target, kind: f.kind, reason: f.reason,
      request_id: newRequestId()
    }
    if (f.target === 'member') payload.recipient_member_id = f.recipient_id
    else payload.family_id = f.family_id
    if (f.kind === 'points' || f.kind === 'balance') payload.amount = +f.amount
    else payload.benefit_ids = f.benefit_ids
    const r = await store.applyGift(payload)
    if (r?.ok) {
      applyMsg.value = {
        ok: true,
        text: `转赠申请已提交：${r.code}${r.auto_approved ? '（家庭共享池免审，已进入待领取）' : '，等待运营审核'}`
      }
      form.value.amount = 100; form.value.benefit_ids = []; form.value.reason = ''
      loadDonorBenefits()
    } else {
      applyMsg.value = { ok: false, text: errText(r) }
    }
  } finally { busy.value = false }
}

// ============ 领取中心 ============
const claimable = computed(() =>
  store.gifts.filter(g => g.status === 'approved' &&
    (g.recipient_member_id === +actorId.value ||
      (g.target === 'family' && store.families.some(f => f.id === g.family_id && f.active_members.some(m => m.member_id === +actorId.value)))))
)
async function claim(g) {
  const r = await store.claimGift(g.id, actorId.value)
  if (!r?.ok) alert(errText(r, '领取失败'))
}
async function decline(g) {
  if (!confirm('确认拒绝该笔转赠？积分/储值/券将回补捐赠人。')) return
  const r = await store.declineGift(g.id, actorId.value)
  if (!r?.ok) alert(errText(r, '操作失败'))
}
// 捐赠人视角：我发起的在途转赠（可撤回）
const myOpenGifts = computed(() =>
  store.gifts.filter(g => g.donor_member_id === +actorId.value && ['pending', 'approved', 'claimed'].includes(g.status))
)
async function donorRecall(g) {
  if (!confirm('确认撤回该笔转赠？未使用权益将返还；受赠人已用于在途预约的票券会同步取消预约并全额退款。')) return
  const r = await store.recallGift(g.id, { donor_member_id: actorId.value, reason: '捐赠人申请撤回' })
  if (!r?.ok) alert(errText(r, '撤回失败'))
}
async function donorCancel(g) {
  const r = await store.cancelGift(g.id, actorId.value)
  if (!r?.ok) alert(errText(r, '撤回失败'))
}

// ============ 运营审核 / 撤回 ============
const reviewList = computed(() => store.gifts.filter(g => g.status === 'pending'))
const openList = computed(() => store.gifts.filter(g => ['approved', 'claimed'].includes(g.status)))
async function approve(g) {
  const r = await store.approveGift(g.id, +staffId.value || null)
  if (!r?.ok) alert(errText(r, '审核失败'))
}
const rejectId = ref(null)
const rejectReason = ref('')
async function reject(g) {
  const reason = (rejectReason.value || '').trim()
  if (!reason) { rejectId.value = g.id; rejectReason.value = ''; return }
  const r = await store.rejectGift(g.id, { staff_id: +staffId.value || null, reason })
  if (r?.ok) { rejectId.value = null; rejectReason.value = '' } else alert(errText(r, '驳回失败'))
}
async function opsRecall(g) {
  if (!confirm('运营撤回该笔转赠？未使用权益返还捐赠人；已在途预约的票券同步取消并全额退款释放名额。')) return
  const r = await store.recallGift(g.id, { staff_id: +staffId.value || null, reason: '运营风控撤回' })
  if (!r?.ok) alert(errText(r, '撤回失败'))
}

// 详情时间线
const detail = ref(null)
async function openDetail(g) {
  const d = await store.giftDetail(g.id)
  detail.value = d?.data || null
}
const LOG_LABEL = {
  apply: '发起申请', cancel: '撤回申请', approve: '审核通过', auto_approve: '免审自动通过',
  reject: '审核驳回', claim: '受赠领取', decline: '受赠拒绝', recall: '撤回',
  expire: '到期回补', reservation_cancel: '联动取消预约'
}
const ROLE_LABEL = { donor: '捐赠人', recipient: '受赠人', operations: '运营', system: '系统' }

// 运营配置
const cfgForm = ref(null)
function editCfg() { cfgForm.value = { ...cfg.value } }
async function saveCfg() {
  const r = await store.saveGiftConfig({
    enabled: cfgForm.value.enabled, familyAutoApprove: cfgForm.value.familyAutoApprove,
    claimDays: +cfgForm.value.claimDays, maxItems: +cfgForm.value.maxItems, minTier: cfgForm.value.minTier
  })
  if (r?.ok) cfgForm.value = null
  else alert(errText(r, '配置保存失败'))
}

function giftTarget(g) {
  return g.target === 'family' ? `家庭池·${g.family_name}` : `${g.recipient_name || '—'}（${g.recipient_code}）`
}
function giftContent(g) {
  if (g.kind === 'points') return `⭐ ${g.amount.toLocaleString()} 积分`
  if (g.kind === 'balance') return `💰 ¥${g.amount}`
  return `${KIND_ICON[g.kind]} ${KIND_NAME[g.kind]}×${g.qty}${g.amount ? `（面额 ¥${g.amount}）` : ''}`
}
</script>

<template>
  <div class="gf">
    <!-- 指标 -->
    <div class="stat-grid">
      <div class="card stat"><span>🗂️</span><b :class="stats.pendingReview ? 'neg' : ''">{{ stats.pendingReview }}</b><em>待运营审核</em></div>
      <div class="card stat"><span>📥</span><b :class="stats.expiredClaim ? 'neg' : ''">{{ stats.awaitingClaim }}</b><em>待领取转赠</em></div>
      <div class="card stat"><span>⏰</span><b class="neg">{{ stats.expiredClaim }}</b><em>领取即将/已到期</em></div>
      <div class="card stat"><span>✅</span><b>{{ stats.claimedTotal }}</b><em>累计已领取</em></div>
      <div class="card stat"><span>👨‍👩‍👧</span><b>{{ stats.familyActive }}</b><em>家庭账户 / {{ stats.familyMembers }} 成员</em></div>
      <div class="card stat"><span>⭐</span><b>{{ stats.escrowPoints.toLocaleString() }}</b><em>托管积分</em></div>
      <div class="card stat"><span class="money">¥</span><b class="money">{{ stats.escrowBalance.toLocaleString() }}</b><em>托管储值</em></div>
      <div class="card stat"><span>↩️</span><b>{{ stats.recalledToday }}</b><em>今日撤回</em></div>
    </div>

    <!-- 身份条 -->
    <div class="card idbar">
      <span>🎭 当前操作身份（会员/受赠人视角）：</span>
      <select v-model.number="actorId">
        <option v-for="m in store.members.slice(0, 120)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }} · {{ m.tier_name }}</option>
      </select>
      <span class="muted" v-if="actor">⭐{{ actor.points }} · 💰¥{{ actor.balance }}</span>
      <span class="sep">|</span>
      <span>🧑‍💼 经办运营：</span>
      <select v-model.number="staffId">
        <option :value="null">不指定</option>
        <option v-for="s in [...store.memberSpecialists, ...store.supervisors]" :key="s.id" :value="s.id">{{ s.name }}（{{ s.role }}）</option>
      </select>
      <span class="muted" v-if="!cfg.enabled" style="color:var(--red)">⚠️ 转赠功能已停用（运营配置可开启）</span>
    </div>

    <div class="tabs card">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
    </div>

    <!-- ============ 家庭账户 ============ -->
    <div v-if="tab === 'family'" class="fam-wrap">
      <div class="card">
        <h3>➕ 新建家庭账户</h3>
        <div class="line">
          <label>户主会员
            <select v-model.number="famForm.member_id">
              <option :value="null">使用当前身份</option>
              <option v-for="m in store.members.slice(0, 120)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }}</option>
            </select>
          </label>
          <label>家庭名称<input v-model="famForm.name" maxlength="20" placeholder="如：王家一家人" /></label>
          <button class="primary" @click="createFam">创建家庭</button>
        </div>
        <em v-if="famMsg" class="msg" :class="{ err: !famMsg.ok }">{{ famMsg.text }}</em>
        <p class="muted tips">户主创建家庭后可邀请注册会员加入；一名会员同一时刻只能属于一个家庭。家庭共享池转赠可配置免审，池内成员先领先得。</p>
      </div>

      <div class="card">
        <h3>🏠 家庭账户列表（{{ store.families.length }}）</h3>
        <div class="fam-grid">
          <div v-for="f in store.families" :key="f.id" class="fam-card" :class="{ dissolved: f.status !== 'active' }">
            <div class="fh">
              <b>{{ f.name }}</b>
              <em>{{ f.code }}</em>
              <span class="tag" :class="f.status === 'active' ? 'st-active' : 'st-dissolved'">{{ f.status === 'active' ? '正常' : '已解散' }}</span>
            </div>
            <div class="members">
              <span v-for="m in f.active_members" :key="m.id" class="member-chip">
                {{ m.role === 'head' ? '👑' : '👤' }}{{ m.member_name }}
                <em class="muted" v-if="f.status === 'active' && m.role !== 'head' && (f.head_member_id === actorId || staffId)">
                  <a @click="removeMember(f, m.member_id)">移除</a>
                </em>
              </span>
              <em v-if="!f.active_members.length" class="muted">无在组成员</em>
            </div>
            <div class="fam-ops" v-if="f.status === 'active'">
              <select v-model.number="inviteMid[f.id]">
                <option :value="null">选择会员邀请…</option>
                <option v-for="m in store.members.slice(0, 120)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }}</option>
              </select>
              <button class="succ sm" @click="invite(f)">邀请加入</button>
              <button class="ghost sm" v-if="f.active_members.some(m => m.member_id === actorId && m.role === 'member')" @click="leave(f)">我要退出</button>
              <button class="danger sm" v-if="f.head_member_id === actorId || staffId" @click="dissolve(f)">解散家庭</button>
              <button class="ghost sm" @click="openFam(f)">时间线</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 发起转赠 ============ -->
    <div v-if="tab === 'apply'" class="apply-wrap">
      <div class="card">
        <h3>🎁 发起权益转赠</h3>
        <div class="form-grid">
          <label class="fld">捐赠会员
            <select v-model.number="form.donor_id" @change="loadDonorBenefits">
              <option :value="null">选择会员…</option>
              <option v-for="m in store.members.slice(0, 120)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }}（⭐{{ m.points }} / 💰¥{{ m.balance }}）</option>
            </select>
          </label>
          <label class="fld">转赠内容
            <select v-model="form.kind" @change="loadDonorBenefits">
              <option value="points">⭐ 积分</option>
              <option value="balance">💰 储值</option>
              <option value="ticket">🎟️ 免票券（分时入园）</option>
              <option value="voucher">🧧 消费券（商铺）</option>
              <option value="fastpass">⚡ 快速通行券</option>
            </select>
          </label>
        </div>

        <label class="fld" v-if="form.kind === 'points'">转赠积分数量
          <input type="number" min="1" max="100000" v-model.number="form.amount" />
        </label>
        <label class="fld" v-else-if="form.kind === 'balance'">转赠储值金额（¥）
          <input type="number" min="10" max="50000" step="10" v-model.number="form.amount" />
        </label>
        <div class="fld" v-else>
          <span>选择要转赠的{{ KIND_NAME[form.kind] }}（已选 {{ form.benefit_ids.length }} 张，单笔最多 {{ cfg.maxItems }} 张）</span>
          <div class="bn-list">
            <label v-for="b in donorBenefits" :key="b.id" class="bn-item">
              <input type="checkbox" :value="b.id" :checked="form.benefit_ids.includes(b.id)"
                     @change="toggleBenefit(b.id, $event.target.checked)" />
              <span>{{ KIND_ICON[b.kind] }} #{{ b.id }} <em class="muted">面额 ¥{{ b.amount }} · 第{{ b.expire_day }}天到期</em></span>
            </label>
            <em v-if="!donorBenefits.length" class="muted">该会员没有可用的{{ KIND_NAME[form.kind] }}。</em>
          </div>
        </div>

        <div class="seg">
          <button :class="{ on: form.target === 'member' }" @click="form.target = 'member'">指定受赠会员</button>
          <button :class="{ on: form.target === 'family' }" @click="form.target = 'family'">家庭共享池</button>
        </div>
        <label class="fld" v-if="form.target === 'member'">受赠会员
          <select v-model.number="form.recipient_id">
            <option :value="null">选择会员…</option>
            <option v-for="m in store.members.filter(x => x.id !== form.donor_id).slice(0, 120)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }}</option>
          </select>
        </label>
        <label class="fld" v-else>目标家庭（捐赠人须为在组成员）
          <select v-model.number="form.family_id">
            <option :value="null">选择家庭…</option>
            <option v-for="f in donorFamilies" :key="f.id" :value="f.id">{{ f.code }} · {{ f.name }}</option>
          </select>
        </label>
        <label class="fld">留言（选填）<input v-model="form.reason" maxlength="100" placeholder="给受赠人/运营的话" /></label>
        <button class="primary wide" :disabled="busy || !form.donor_id || !cfg.enabled" @click="submitGift">提交转赠申请</button>
        <em v-if="applyMsg" class="msg" :class="{ err: !applyMsg.ok }">{{ applyMsg.text }}</em>
        <p class="muted tips">
          提交后积分/储值即托管扣减、券类逐张锁定，不可重复使用；指定受赠人需运营审核，家庭共享池{{ cfg.familyAutoApprove ? '开启免审，提交即进入共享池' : '需运营审核' }}。
          受赠人需在 {{ cfg.claimDays }} 个游戏日内领取，逾期自动回补。
        </p>
      </div>

      <div class="card">
        <h3>↩️ 我发起的在途转赠（{{ myOpenGifts.length }}）</h3>
        <div class="table">
          <div class="thead"><span>转赠单</span><span>内容</span><span>去向</span><span>状态</span><span>操作</span></div>
          <div class="trow" v-for="g in myOpenGifts" :key="g.id">
            <span><b>{{ g.code }}</b><em class="muted">第{{ g.create_day }}天</em></span>
            <span>{{ giftContent(g) }}</span>
            <span>{{ giftTarget(g) }}</span>
            <span><span class="tag" :class="STATUS_BADGE[g.status]">{{ g.status_name }}</span><em v-if="g.expired_claim" class="muted neg">已超领取期</em></span>
            <span class="ops">
              <button class="ghost sm" v-if="g.status === 'pending'" @click="donorCancel(g)">撤回申请</button>
              <button class="ghost sm" v-else @click="donorRecall(g)">撤回转赠</button>
              <button class="ghost sm" @click="openDetail(g)">详情</button>
            </span>
          </div>
          <div v-if="!myOpenGifts.length" class="muted empty">暂无在途转赠。</div>
        </div>
      </div>
    </div>

    <!-- ============ 领取中心 ============ -->
    <div v-if="tab === 'claim'" class="card">
      <h3>📥 {{ actor?.name }} 的待领取权益（{{ claimable.length }}）</h3>
      <div class="gift-grid">
        <div v-for="g in claimable" :key="g.id" class="gift-card">
          <div class="gh">
            <b>{{ g.code }}</b>
            <span class="tag st-approved">待领取</span>
            <em class="muted" :class="{ neg: g.expired_claim }">第{{ g.claim_deadline_day }}天前领取</em>
          </div>
          <div class="gcontent">{{ giftContent(g) }}</div>
          <div class="muted meta">来自 {{ g.donor_name }}（{{ g.donor_code }}）· {{ g.target === 'family' ? `家庭共享池「${g.family_name}」` : '指定赠送' }}</div>
          <div v-if="g.reason" class="muted note">💬 {{ g.reason }}</div>
          <div class="gops">
            <button class="succ" @click="claim(g)">立即领取</button>
            <button class="ghost" v-if="g.target === 'member'" @click="decline(g)">婉拒</button>
          </div>
        </div>
      </div>
      <div v-if="!claimable.length" class="muted empty">当前身份暂无待领取的转赠权益。</div>

      <h3 style="margin-top:18px">📜 与我相关的最近转赠</h3>
      <div class="table">
        <div class="thead"><span>转赠单</span><span>内容</span><span>捐赠人</span><span>状态</span><span></span></div>
        <div class="trow" v-for="g in store.gifts.filter(x => x.recipient_member_id === actorId).slice(0, 20)" :key="g.id">
          <span><b>{{ g.code }}</b></span>
          <span>{{ giftContent(g) }}</span>
          <span>{{ g.donor_name }}</span>
          <span><span class="tag" :class="STATUS_BADGE[g.status]">{{ g.status_name }}</span></span>
          <span><button class="ghost sm" @click="openDetail(g)">详情</button></span>
        </div>
      </div>
    </div>

    <!-- ============ 审核与撤回 ============ -->
    <div v-if="tab === 'ops'" class="ops-wrap">
      <div class="card">
        <h3>✅ 待审核转赠（{{ reviewList.length }}）</h3>
        <div class="table">
          <div class="thead w6"><span>转赠单</span><span>捐赠人</span><span>内容</span><span>去向</span><span>留言</span><span>操作</span></div>
          <div class="trow w6" v-for="g in reviewList" :key="g.id">
            <span><b>{{ g.code }}</b><em class="muted">第{{ g.create_day }}天</em></span>
            <span>{{ g.donor_name }}<em class="muted">{{ g.donor_code }}</em></span>
            <span>{{ giftContent(g) }}</span>
            <span>{{ giftTarget(g) }}</span>
            <span class="muted">{{ g.reason || '—' }}</span>
            <span class="ops" v-if="rejectId !== g.id">
              <button class="succ sm" @click="approve(g)">通过</button>
              <button class="danger sm" @click="reject(g)">驳回</button>
            </span>
            <span class="reject-line" v-else>
              <input v-model="rejectReason" placeholder="驳回原因" maxlength="100" />
              <button class="danger sm" @click="reject(g)">确认驳回</button>
              <button class="ghost sm" @click="rejectId = null">取消</button>
            </span>
          </div>
          <div v-if="!reviewList.length" class="muted empty">暂无待审核转赠。</div>
        </div>
      </div>

      <div class="card">
        <h3>🔁 已发放转赠监控与撤回（{{ openList.length }}）</h3>
        <div class="table">
          <div class="thead w6"><span>转赠单</span><span>内容</span><span>捐赠人→受赠</span><span>状态</span><span>领取期限</span><span>操作</span></div>
          <div class="trow w6" v-for="g in openList" :key="g.id">
            <span><b>{{ g.code }}</b><em class="muted">{{ g.target === 'family' ? '家庭池' : '指定' }}</em></span>
            <span>{{ giftContent(g) }}</span>
            <span>{{ g.donor_name }} → <b v-if="g.target === 'member'">{{ g.recipient_name || '待领取' }}</b><b v-else>{{ g.recipient_name || '池内待领' }}</b></span>
            <span><span class="tag" :class="STATUS_BADGE[g.status]">{{ g.status_name }}</span></span>
            <span><em class="muted" :class="{ neg: g.expired_claim }">{{ g.status === 'approved' ? `第${g.claim_deadline_day}天` : '已领取' }}</em></span>
            <span class="ops">
              <button class="danger sm" @click="opsRecall(g)">运营撤回</button>
              <button class="ghost sm" @click="openDetail(g)">详情</button>
            </span>
          </div>
          <div v-if="!openList.length" class="muted empty">暂无已发放转赠。</div>
        </div>
      </div>

      <div class="card">
        <h3>⚙️ 转赠运营配置</h3>
        <button class="ghost" @click="editCfg">编辑配置</button>
        <div v-if="!cfgForm" class="cfg-list">
          <div><span>转赠功能</span><b :class="cfg.enabled ? 'money' : 'neg'">{{ cfg.enabled ? '运行中' : '已停用' }}</b></div>
          <div><span>家庭共享池免审</span><b>{{ cfg.familyAutoApprove ? '开启（自动通过）' : '关闭（需审核）' }}</b></div>
          <div><span>领取有效期</span><b>{{ cfg.claimDays }} 游戏日</b></div>
          <div><span>单笔券类上限</span><b>{{ cfg.maxItems }} 张</b></div>
          <div><span>最低转赠卡等级</span><b>{{ { none: '普通会员', silver: '银卡', gold: '金卡', diamond: '钻石' }[cfg.minTier] }}</b></div>
        </div>
        <div v-else class="cfg-form">
          <label class="fld row2"><span>启用转赠功能</span><input type="checkbox" v-model="cfgForm.enabled" /></label>
          <label class="fld row2"><span>家庭共享池免审自动通过</span><input type="checkbox" v-model="cfgForm.familyAutoApprove" /></label>
          <label class="fld row2"><span>领取有效期（1~60 游戏日）</span><input type="number" min="1" max="60" v-model.number="cfgForm.claimDays" /></label>
          <label class="fld row2"><span>单笔券类上限（1~100）</span><input type="number" min="1" max="100" v-model.number="cfgForm.maxItems" /></label>
          <label class="fld row2"><span>最低转赠卡等级</span>
            <select v-model="cfgForm.minTier"><option value="none">普通会员</option><option value="silver">银卡</option><option value="gold">金卡</option><option value="diamond">钻石</option></select>
          </label>
          <button class="primary" @click="saveCfg">保存配置</button>
        </div>
      </div>
    </div>

    <!-- 家庭时间线弹窗 -->
    <div class="mask" v-if="famDetail" @click.self="famDetail = null">
      <div class="dialog card">
        <h3>👨‍👩‍👧 {{ famDetail.name }} <em class="muted">{{ famDetail.code }}</em>
          <button class="ghost x" @click="famDetail = null">✕</button>
        </h3>
        <div class="logs">
          <div v-for="l in (famDetail.logs || []).slice().reverse()" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ { create: '创建家庭', invite: '邀请加入', join: '加入', leave: '成员退出', remove: '移除成员', dissolve: '解散' }[l.action] || l.action }}</b>
            <em class="muted">第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 转赠详情弹窗 -->
    <div class="mask" v-if="detail" @click.self="detail = null">
      <div class="dialog card wide-dlg">
        <h3>🎁 转赠单 {{ detail.code }}
          <span class="tag" :class="STATUS_BADGE[detail.status]">{{ detail.status_name }}</span>
          <button class="ghost x" @click="detail = null">✕</button>
        </h3>
        <div class="d-grid">
          <div><em>捐赠人</em><b>{{ detail.donor_name }}（{{ detail.donor_code }}）</b></div>
          <div><em>{{ detail.target === 'family' ? '家庭共享池' : '受赠人' }}</em><b>{{ detail.target === 'family' ? detail.family_name : `${detail.recipient_name}（${detail.recipient_code}）` }}</b></div>
          <div><em>内容</em><b>{{ giftContent(detail) }}</b></div>
          <div><em>领取期限</em><b>{{ detail.status === 'pending' ? '审核后起算' : `第${detail.claim_deadline_day}天` }}</b></div>
        </div>
        <h4>券类明细（{{ (detail.items || []).length }}）</h4>
        <div class="ben-list">
          <div v-for="it in detail.items" :key="it.id" class="ben-row">
            <span>#{{ it.seq + 1 }} 原权益 #{{ it.benefit_id }}<em class="muted" v-if="it.amount"> 面额 ¥{{ it.amount }}</em></span>
            <span class="tag" :class="{ 'st-unused': it.status === 'locked', 'st-claimed': it.status === 'gifted', 'st-refunded': it.status === 'returned' }">
              {{ { locked: '已锁定', gifted: '已转移', returned: '已返还' }[it.status] }}
            </span>
            <em class="muted" v-if="it.reservation_id">已联动取消预约 #{{ it.reservation_id }}</em>
          </div>
          <div v-if="!(detail.items || []).length" class="muted">{{ detail.kind === 'points' ? `⭐ ${detail.amount} 积分` : `💰 储值 ¥${detail.amount}` }}（账户类，无券明细）</div>
        </div>
        <h4>🕘 流转时间线</h4>
        <div class="logs">
          <div v-for="l in (detail.logs || []).slice().reverse()" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ LOG_LABEL[l.action] || l.action }}</b>
            <em class="muted">{{ ROLE_LABEL[l.actor_role] || l.actor_role }} · 第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gf { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.neg { color: var(--red); }
.money { color: var(--green); }

.idbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.idbar select { min-width: 200px; }
.idbar .sep { color: var(--border); }
.tabs { display: flex; gap: 8px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }

.line { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.line label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
.line input, .line select { min-width: 180px; }
.tips { font-size: 12px; line-height: 1.7; margin-top: 10px; }
.msg { display: block; margin-top: 10px; font-size: 12.5px; color: var(--green); font-style: normal; }
.msg.err { color: var(--red); }
.wide { width: 100%; padding: 10px; margin-top: 8px; }

.fam-wrap, .apply-wrap, .ops-wrap { display: flex; flex-direction: column; gap: 14px; }
.fam-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 12px; }
.fam-card { border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--panel2); display: flex; flex-direction: column; gap: 10px; }
.fam-card.dissolved { opacity: .55; }
.fh { display: flex; align-items: center; gap: 8px; }
.fh em { font-style: normal; font-size: 11px; color: var(--muted); }
.members { display: flex; flex-wrap: wrap; gap: 6px; }
.member-chip { font-size: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 20px; padding: 3px 10px; }
.member-chip a { color: var(--red); cursor: pointer; margin-left: 4px; }
.fam-ops { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.fam-ops select { flex: 1; min-width: 140px; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); margin: 10px 0; }
.fld.row2 { flex-direction: row; align-items: center; justify-content: space-between; }
.fld.row2 input[type=number] { width: 140px; }
.seg { display: flex; gap: 6px; margin: 8px 0; }
.seg button { padding: 7px 16px; font-size: 13px; }
.seg button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.bn-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.bn-item { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text); background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.bn-item em { font-style: normal; font-size: 11px; }

.table { overflow-x: auto; margin-top: 10px; }
.thead, .trow { display: grid; grid-template-columns: .8fr 1.2fr 1.4fr .8fr 1.6fr; gap: 8px; align-items: center; padding: 9px 8px; font-size: 13px; min-width: 760px; }
.thead.w6, .trow.w6 { grid-template-columns: .8fr .9fr 1.1fr 1.2fr 1.2fr 1.5fr; min-width: 900px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.trow em { display: block; font-style: normal; font-size: 11px; }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
button.sm { font-size: 11px; padding: 4px 9px; }
.empty { padding: 18px; text-align: center; }
.reject-line { display: flex; gap: 6px; align-items: center; grid-column: span 2; }
.reject-line input { flex: 1; }

.gift-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 12px; }
.gift-card { border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--panel2); display: flex; flex-direction: column; gap: 8px; }
.gh { display: flex; align-items: center; gap: 8px; }
.gh em { font-style: normal; font-size: 11px; margin-left: auto; }
.gcontent { font-size: 17px; font-weight: 700; }
.meta { font-size: 12px; }
.note { font-size: 12px; background: var(--panel); border-radius: 8px; padding: 6px 8px; }
.gops { display: flex; gap: 8px; margin-top: auto; }

.tag { display: inline-block; font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--border); white-space: nowrap; }
.st-pending { color: var(--accent2); border-color: rgba(255,209,102,.5); background: rgba(255,209,102,.1); }
.st-approved { color: #7cc7ff; border-color: rgba(124,199,255,.5); background: rgba(124,199,255,.1); }
.st-claimed, .st-active { color: var(--green); border-color: rgba(109,213,160,.5); background: rgba(109,213,160,.1); }
.st-declined, .st-cancelled, .st-recalled { color: var(--muted); }
.st-rejected, .st-expired, .st-dissolved { color: var(--red); border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.1); }
.st-unused { color: var(--accent2); }
.st-refunded { color: var(--muted); }

.cfg-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.cfg-list div { display: flex; justify-content: space-between; font-size: 13px; padding: 6px 0; border-bottom: 1px dashed var(--border); }
.cfg-form { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; max-width: 460px; }

.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(560px, 100%); max-height: 88vh; overflow-y: auto; }
.dialog.wide-dlg { width: min(680px, 100%); }
.dialog .x { margin-left: auto; }
.dialog h3 { display: flex; align-items: center; gap: 10px; }
.dialog h4 { margin: 16px 0 8px; font-size: 13px; }
.d-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin: 12px 0; }
.d-grid div { display: flex; justify-content: space-between; font-size: 13px; border-bottom: 1px dashed var(--border); padding: 5px 0; gap: 10px; }
.d-grid em { font-style: normal; color: var(--muted); }
.ben-list { display: flex; flex-direction: column; gap: 6px; }
.ben-row { display: flex; gap: 10px; align-items: center; font-size: 12.5px; padding: 7px 10px; background: var(--panel2); border-radius: 8px; flex-wrap: wrap; }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 14px 18px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .ldot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 2px; }
</style>
