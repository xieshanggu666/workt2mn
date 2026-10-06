<script setup>
import { ref, computed, reactive } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()

// 多角色视角：运营（全流程）/ 安保（现场处置）/ 游客（上报与理赔）
const ROLES = [
  { k: 'operations', name: '运营指挥', icon: '🎛️' },
  { k: 'security', name: '安保现场', icon: '🛡️' },
  { k: 'visitor', name: '游客端', icon: '🧑‍🎤' }
]
const role = ref('operations')

const tabs = [
  { k: 'active', label: '应急处置中' },
  { k: 'review', label: '待复盘' },
  { k: 'closed', label: '已结案' },
  { k: 'all', label: '全部' }
]
const tab = ref('active')
const ACTIVE = ['reported', 'graded', 'contained', 'evacuating', 'controlled']

const list = computed(() => {
  const all = store.incidents
  if (tab.value === 'active') return all.filter(i => ACTIVE.includes(i.status))
  if (tab.value === 'review') return all.filter(i => i.status === 'reopened')
  if (tab.value === 'closed') return all.filter(i => ['closed_review', 'closed_false'].includes(i.status))
  return all
})

const TYPES = computed(() => Object.entries(store.emergencyConst.types || {}).map(([k, v]) => ({ k, ...v })))
const sevName = s => store.emergencyConst.severityNames?.[s] || '待分级'
const slaHours = s => store.emergencyConst.controlSla?.[s] || '-'
const rescueCost = s => store.emergencyConst.rescueCost?.[s] || 0

const sevCls = s => `sev${s}`
function statusMeta(st) {
  return ({
    reported: { label: '待分级', cls: 'st-report' },
    graded: { label: '已分级', cls: 'st-graded' },
    contained: { label: '已封控', cls: 'st-contained' },
    evacuating: { label: '疏散中', cls: 'st-evac' },
    controlled: { label: '已控场', cls: 'st-controlled' },
    reopened: { label: '待复盘', cls: 'st-reopen' },
    closed_review: { label: '复盘结案', cls: 'st-done' },
    closed_false: { label: '误报关闭', cls: 'st-false' }
  })[st] || { label: st, cls: '' }
}

const stats = computed(() => store.incidentStats)

// ---------------- 上报事件 ----------------
const blankReport = () => ({ type: 'fire', title: '', desc: '', location: '', zone_id: null })
const reportForm = reactive(blankReport())
const reportMsg = ref('')
async function submitReport() {
  if (!reportForm.title.trim()) { reportMsg.value = '请填写事件标题/简述'; return }
  const r = await store.reportIncident({
    ...reportForm,
    reporter_role: role.value === 'visitor' ? 'visitor' : (role.value === 'security' ? 'security' : 'operations'),
    request_id: newRequestId()
  })
  if (r?.ok) {
    reportMsg.value = `已上报 ${r.code}，等待运营值班分级`
    Object.assign(reportForm, blankReport())
    selectIncident(r.id)
  } else reportMsg.value = r?.msg || '上报失败'
}

// ---------------- 分级 ----------------
const gradeForm = reactive({ severity: 2, rides: [], zones: [], parkWide: false, autoZone: true })
function initGrade(i) {
  gradeForm.severity = i.severity >= 1 ? i.severity : (store.emergencyConst.types?.[i.type]?.defSev || 2)
  gradeForm.rides = []
  gradeForm.zones = i.zone_id ? [i.zone_id] : []
  gradeForm.parkWide = false
  gradeForm.autoZone = true
}
async function doGrade(i) {
  const r = await store.gradeIncident(i.id, {
    severity: gradeForm.severity,
    lockdown: {
      rides: gradeForm.rides,
      zones: gradeForm.zones,
      park_wide: gradeForm.parkWide || gradeForm.severity === 4,
      auto_zone: gradeForm.autoZone
    },
    request_id: newRequestId()
  })
  if (r?.ok) actionMsg.value = r.status === 'contained' ? `已分级并完成封控（设施退款 ${r.refundRideQty || 0} 人）` : '已分级，请尽快组织封控'
  else actionMsg.value = r?.msg || '分级失败'
}

// 追加封控
const lockForm = reactive({ rides: [], zones: [], parkWide: false })
function initLock(i) { lockForm.rides = []; lockForm.zones = i.zone_id ? [i.zone_id] : []; lockForm.parkWide = false }
async function doLockdown(i) {
  const r = await store.lockdownIncident(i.id, {
    rides: lockForm.rides, zones: lockForm.zones, park_wide: lockForm.parkWide || i.severity === 4, request_id: newRequestId()
  })
  actionMsg.value = r?.ok ? `已封控，联动设施预约退款 ${r.refundRideQty || 0} 人` : (r?.msg || '封控失败')
}

// 疏散 / 控场
const evacQty = ref(20)
const casualties = ref(0)
async function doEvac(i, start) {
  const r = start
    ? await store.startEvacuation(i.id, { qty: evacQty.value, request_id: newRequestId() })
    : await store.reportEvacuation(i.id, evacQty.value)
  if (r?.ok) actionMsg.value = start ? '已启动疏散' : `疏散进展已上报，累计 ${r.evacuatedQty} 人`
  else actionMsg.value = r?.msg || '操作失败'
}
async function doControl(i) {
  const r = await store.controlIncident(i.id, { casualties: casualties.value, request_id: newRequestId() })
  actionMsg.value = r?.ok ? '已确认控场，可复园评估' : (r?.msg || '操作失败')
}

// 复园 / 误报
const reopenCost = ref(null)
async function doReopen(i) {
  const r = await store.reopenIncident(i.id, { cost: reopenCost.value, request_id: newRequestId() })
  if (r?.ok) actionMsg.value = `已复园：恢复 ${r.restoredRides} 设施 / ${r.reopenedZones} 区域，结算 ¥${(r.rescueCost + r.subsidy).toLocaleString()}`
  else actionMsg.value = r?.msg || '复园失败'
}
async function doFalse(i) {
  const r = await store.closeFalseIncident(i.id, { request_id: newRequestId() })
  actionMsg.value = r?.ok ? '已按误报关闭并解除封控' : (r?.msg || '操作失败')
}

// ---------------- 复盘 ----------------
const reviewForm = reactive({ cause: '', actions: '', lessons: '', rating: 4 })
function initReview(i) {
  reviewForm.cause = i.review_cause || ''
  reviewForm.actions = i.review_actions || ''
  reviewForm.lessons = i.review_lessons || ''
  reviewForm.rating = i.review_rating || 4
}
async function doReview(i) {
  if (!reviewForm.cause.trim()) { actionMsg.value = '请填写事故原因认定'; return }
  const r = await store.reviewIncident(i.id, { ...reviewForm, request_id: newRequestId() })
  if (r?.ok) actionMsg.value = `复盘结案，处置评分 ${r.rating} 星，声誉回补 +${r.repRecover}`
  else actionMsg.value = r?.msg || '复盘失败'
}

// ---------------- 岗位调度 ----------------
const activeStaff = computed(() => store.staff.filter(s => s.active))
const assignStaffId = ref(null)
const assignTask = ref('control')
const TASKS = [
  { k: 'control', name: '封控警戒' }, { k: 'evacuate', name: '疏散引导' },
  { k: 'rescue', name: '抢险救援' }, { k: 'medical', name: '医疗救护' }
]
async function doAssign(i) {
  if (!assignStaffId.value) { actionMsg.value = '请选择调派员工'; return }
  const r = await store.assignIncidentStaff(i.id, assignStaffId.value, assignTask.value)
  actionMsg.value = r?.ok ? '已调派，等待安保到场确认' : (r?.msg || '调派失败')
}
async function doAck(l) { const r = await store.acknowledgeIncidentStaff(l.id); actionMsg.value = r?.ok ? '已到场' : (r?.msg || '操作失败') }
async function doStand(l) { const r = await store.standDownIncidentStaff(l.id); actionMsg.value = r?.ok ? '已撤防' : (r?.msg || '操作失败') }

// ---------------- 游客理赔 ----------------
const claimForm = reactive({ guest_name: '', guest_phone: '', item: '医疗及财物损失', amount_req: 500 })
async function doClaim(i) {
  if (claimForm.amount_req <= 0) { actionMsg.value = '请填写理赔金额'; return }
  const r = await store.fileIncidentClaim(i.id, { ...claimForm, request_id: newRequestId() })
  actionMsg.value = r?.ok ? `理赔 ${r.code} 已提交，等待运营核定` : (r?.msg || '提交失败')
}
const payAmount = ref({})
async function doPayClaim(c) {
  const amount = payAmount.value[c.id] != null ? payAmount.value[c.id] : c.amount_req
  const r = await store.payIncidentClaim(c.id, { amount, request_id: newRequestId() })
  actionMsg.value = r?.ok ? `已赔付 ¥${r.amount}，财务已出账` : (r?.msg || '赔付失败')
}
async function doRejectClaim(c) {
  const r = await store.rejectIncidentClaim(c.id, { note: '核定不属于园方责任范围', request_id: newRequestId() })
  actionMsg.value = r?.ok ? '已驳回' : (r?.msg || '操作失败')
}

// ---------------- 详情时间线 ----------------
const detail = ref(null)
const detailLogs = ref([])
const actionMsg = ref('')
async function selectIncident(id) {
  const r = await store.incidentDetail(id)
  if (r?.incident) { detail.value = r.incident; detailLogs.value = r.logs || []; initGrade(r.incident); initLock(r.incident); initReview(r.incident) }
}
function closeDetail() { detail.value = null }
const ACTION_LABEL = {
  report: '发现上报', auto_grade: '系统自动分级', grade: '事件分级', lockdown: '封控',
  evacuate: '启动疏散', evacuate_progress: '疏散进展', control: '控场确认', reopen: '复园',
  review: '复盘结案', false: '误报关闭', escalate: '自动升级', link_complaint: '联动投诉',
  dispatch_staff: '调派人员', ack_staff: '人员到场', stand_staff: '人员撤防',
  claim: '游客理赔', claim_pay: '理赔赔付', claim_reject: '理赔驳回'
}
const TASK_STATUS = { assigned: '已调派·待到场', acknowledged: '已到场', stood_down: '已撤防' }
const CLAIM_STATUS = { submitted: '待核定', paid: '已赔付', rejected: '已驳回', withdrawn: '已撤回' }

// 可操作按钮是否对当前角色可见
const canOps = computed(() => role.value === 'operations')
const canSecurity = computed(() => ['operations', 'security'].includes(role.value))

// 状态流转进度条：contained / evacuating 为并行分支，controlled 之后两者都算完成
function flowOn(current, node) {
  const order = ['reported', 'graded', 'contained', 'evacuating', 'controlled', 'reopened', 'closed_review']
  const idx = Object.fromEntries(order.map((k, i) => [k, i]))
  if (current === 'closed_false') return false
  if (node === 'evacuating') return ['evacuating', 'controlled', 'reopened', 'closed_review'].includes(current)
  if (node === 'contained') return ['contained', 'evacuating', 'controlled', 'reopened', 'closed_review'].includes(current)
  return idx[current] >= idx[node]
}
</script>

<template>
  <div class="em">
    <!-- 角色切换 -->
    <div class="rolebar card">
      <div class="rb-title">🚨 园区应急指挥中心
        <span class="muted">发现 → 分级 → 封控 → 疏散 → 复园 → 复盘</span>
      </div>
      <div class="roles">
        <button v-for="r in ROLES" :key="r.k" :class="{ on: role === r.k }" @click="role = r.k">
          {{ r.icon }} {{ r.name }}
        </button>
      </div>
    </div>

    <!-- 态势统计 -->
    <div class="stat-grid">
      <div class="card stat" :class="{ alert: stats.open }"><span>🚨</span><b>{{ stats.open }}</b><em>在途安全事件</em></div>
      <div class="card stat" :class="{ alert: stats.bySeverity[3] + stats.bySeverity[4] }">
        <span>🔴</span><b>{{ stats.bySeverity[3] + stats.bySeverity[4] }}</b><em>重大/特别重大</em>
      </div>
      <div class="card stat" :class="{ alert: stats.overdue }"><span>⏰</span><b :class="{ neg: stats.overdue }">{{ stats.overdue }}</b><em>超封控时限</em></div>
      <div class="card stat" :class="{ alert: stats.pendingClaims }"><span>🩹</span><b>{{ stats.pendingClaims }}</b><em>理赔待核定</em></div>
      <div class="card stat"><span>💰</span><b class="money neg">¥{{ stats.costToday.toLocaleString() }}</b><em>今日抢险/补贴</em></div>
      <div class="card stat"><span>📋</span><b>{{ stats.avgRating || '—' }}</b><em>复盘平均评分</em></div>
    </div>

    <div v-if="actionMsg" class="flash">{{ actionMsg }}</div>

    <div class="cols">
      <!-- 左：事件列表 -->
      <div class="left card">
        <h3>📥 安全事件
          <span class="tag" v-if="stats.open">{{ stats.open }} 在途</span>
        </h3>
        <div class="tabs">
          <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
        </div>
        <div class="ilist">
          <div v-for="i in list" :key="i.id" class="iitem" :class="[sevCls(i.severity), { overdue: i.overdue, dim: ['closed_review','closed_false'].includes(i.status) }]">
            <div class="ii-head">
              <span class="big-ic">{{ i.type_icon }}</span>
              <div class="ii-title">
                <b>{{ i.title }}</b>
                <em class="muted">{{ i.code }} · 第{{ i.create_day }}天 · {{ i.source === 'auto' ? '安保巡报' : i.source === 'visitor' ? '游客上报' : i.source === 'complaint' ? '投诉转报' : i.source === 'ops' ? '运营发现' : '安保发现' }}{{ i.zone_name ? ' · ' + i.zone_name : '' }}</em>
              </div>
              <span class="badge sev" :class="sevCls(i.severity)">{{ i.severity_name }}</span>
              <span class="badge" :class="statusMeta(i.status).cls">{{ i.status_icon }} {{ statusMeta(i.status).label }}</span>
              <button class="ghost timeline-btn" @click="selectIncident(i.id)">处置台</button>
            </div>
            <p class="content">{{ i.desc || '（无详细描述）' }}</p>
            <div class="ii-meta">
              <span v-if="i.evacuated_qty">🏃 已疏散 <b>{{ i.evacuated_qty }}</b> 人</span>
              <span v-if="i.casualties">🤕 伤员 <b class="neg">{{ i.casualties }}</b></span>
              <span v-if="i.refund_ride_qty">🎫 设施退款 <b>{{ i.refund_ride_qty }}</b></span>
              <span v-if="i.refund_entry_qty">🚪 入园退款 <b>{{ i.refund_entry_qty }}</b></span>
              <span v-if="i.staff.length">🛡️ 应急编组 <b>{{ i.staff.length }}</b></span>
              <span v-if="i.claims.length">🩹 理赔 <b>{{ i.claims.length }}</b></span>
              <span class="sla" :class="{ red: i.overdue }" v-if="['graded','contained','evacuating'].includes(i.status)">
                {{ i.overdue ? '⚠️ 已超封控时限，将自动升级' : `封控时限 ${slaHours(i.severity)}h` }}
              </span>
            </div>
          </div>
          <div class="muted empty" v-if="!list.length">当前没有对应状态的安全事件。</div>
        </div>
      </div>

      <!-- 右：上报 + 说明 -->
      <div class="right">
        <div class="card">
          <h3>{{ role === 'visitor' ? '🆘 游客紧急上报/求助' : '📡 新事件上报' }}</h3>
          <div class="rfields">
            <label>事件类型
              <select v-model="reportForm.type">
                <option v-for="t in TYPES" :key="t.k" :value="t.k">{{ t.icon }} {{ t.name }}</option>
              </select>
            </label>
            <label v-if="role !== 'visitor'">事发区域
              <select v-model.number="reportForm.zone_id">
                <option :value="null">园区整体/未定</option>
                <option v-for="z in store.zones" :key="z.id" :value="z.id">{{ z.name }}</option>
              </select>
            </label>
            <input v-model="reportForm.title" maxlength="40" :placeholder="role === 'visitor' ? '简述发生了什么（如：设施区域有烟雾）' : '事件标题'" />
            <input v-model="reportForm.location" maxlength="40" placeholder="具体地点（可选）" />
            <textarea v-model="reportForm.desc" rows="2" maxlength="200" placeholder="现场情况描述"></textarea>
            <button class="primary" @click="submitReport">{{ role === 'visitor' ? '一键紧急上报' : '上报至应急指挥中心' }}</button>
            <em v-if="reportMsg" class="mmsg">{{ reportMsg }}</em>
          </div>
        </div>

        <div class="card tips">
          <h3>🔁 联动与处置规则</h3>
          <ul>
            <li><b>分级即封控</b>：2 级以上默认封锁事发区域并停运区内设施，在途预约/团行程<b>园方全额退款</b>；4 级全园封控。</li>
            <li>封控后组织<b>疏散</b>、核定伤员并<b>控场</b>，确认安全后<b>复园</b>（自动恢复设施/区域、重开时段）。</li>
            <li>可向事件<b>调派安保</b>（到场确认/撤防），复园时按岗位发放<b>应急补贴</b>并结算<b>抢险费</b>。</li>
            <li>游客可登记<b>理赔</b>，运营核定现金赔付（计入应急补偿），关联投诉自动闭环。</li>
            <li>超封控时限未控场事件<b>自动升级</b>、在途重大事件持续拉低声誉与客流；及时复盘可回补声誉。</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 处置台弹层 -->
    <div class="mask" v-if="detail" @click.self="closeDetail">
      <div class="dialog card">
        <div class="d-head">
          <h3>{{ detail.type_icon }} {{ detail.title }}
            <span class="badge sev" :class="sevCls(detail.severity)">{{ detail.severity_name }}</span>
            <span class="badge" :class="statusMeta(detail.status).cls">{{ statusMeta(detail.status).label }}</span>
          </h3>
          <button class="ghost x" @click="closeDetail">✕</button>
        </div>
        <p class="content">{{ detail.desc || '（无详细描述）' }}</p>
        <div class="d-meta muted">
          {{ detail.code }} · 第{{ detail.create_day }}天发现 · {{ detail.zone_name || '园区整体' }}{{ detail.location ? ' · ' + detail.location : '' }}
        </div>

        <!-- 状态流转进度条 -->
        <div class="flow">
          <template v-for="(s, idx) in ['reported','graded','contained','evacuating','controlled','reopened','closed_review']" :key="s">
            <span class="node" :class="{ on: flowOn(detail.status, s), skip: detail.status === 'closed_false' }">{{ statusMeta(s).label }}</span>
            <i v-if="idx < 6" class="arrow">→</i>
          </template>
        </div>

        <!-- 待分级 -->
        <div v-if="detail.status === 'reported'" class="panel">
          <h4>🚩 运营分级（{{ canOps ? '' : '仅运营指挥可操作' }}）</h4>
          <div class="sevpick" :class="{ dis: !canOps }">
            <button v-for="s in [1,2,3,4]" :key="s" :class="['sevbtn','sev'+s, { on: gradeForm.severity === s }]" @click="canOps && (gradeForm.severity = s)">
              <b>{{ s }} 级</b><em>{{ sevName(s) }}</em><em class="sla">封控时限 {{ slaHours(s) }}h</em>
            </button>
          </div>
          <label class="chk" v-if="canOps && detail.zone_id">
            <input type="checkbox" v-model="gradeForm.autoZone" /> 分级同时封锁事发区域「{{ detail.zone_name }}」并停运区内设施（2级以上默认）
          </label>
          <div class="lockpick" v-if="canOps">
            <label>额外封控设施（可选，多选）
              <select v-model.number="gradeForm.rides" multiple size="3">
                <option v-for="r in store.rides.filter(x => x.status === 'operating')" :key="r.id" :value="r.id">{{ r.name }}（{{ r.status === 'operating' ? '运营中' : r.status }}）</option>
              </select>
            </label>
          </div>
          <label class="chk" v-if="canOps"><input type="checkbox" v-model="gradeForm.parkWide" :disabled="gradeForm.severity === 4" /> 全园封控（关停全部入园时段，在途入园预约全额退款；4级强制）</label>
          <button class="primary" :disabled="!canOps" @click="doGrade(detail)">确认分级并启动响应</button>
        </div>

        <!-- 已分级：封控 -->
        <div v-else-if="detail.status === 'graded'" class="panel">
          <h4>🚧 现场封控</h4>
          <div v-if="canOps">
            <label>封控区域
              <select v-model.number="lockForm.zones" multiple size="3">
                <option v-for="z in store.zones" :key="z.id" :value="z.id">{{ z.name }}</option>
              </select>
            </label>
            <label>停运设施
              <select v-model.number="lockForm.rides" multiple size="3">
                <option v-for="r in store.rides.filter(x => x.status === 'operating')" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </label>
            <label class="chk"><input type="checkbox" v-model="lockForm.parkWide" :disabled="detail.severity === 4" /> 全园封控（4级强制）</label>
            <div class="btnrow">
              <button class="primary" @click="doLockdown(detail)">确认封控</button>
              <button class="succ" @click="doEvac(detail, true)">直接封控并疏散</button>
              <button class="ghost" v-if="canOps" @click="doFalse(detail)">误报关闭</button>
            </div>
          </div>
        </div>

        <!-- 已封控：疏散/控场/复园 -->
        <div v-else-if="detail.status === 'contained'" class="panel">
          <h4>🏃 疏散与控场</h4>
          <div class="btnrow" v-if="canSecurity">
            <label class="inline">本批疏散 <input type="number" min="0" v-model.number="evacQty" style="width:80px" /> 人</label>
            <button class="primary" @click="doEvac(detail, true)">启动疏散</button>
            <label class="inline">伤员 <input type="number" min="0" v-model.number="casualties" style="width:70px" /> 人</label>
            <button class="succ" @click="doControl(detail)">无疏散·直接控场</button>
          </div>
          <div class="btnrow" v-if="canOps">
            <button class="ghost" @click="doFalse(detail)">误报关闭</button>
          </div>
        </div>

        <!-- 疏散中 -->
        <div v-else-if="detail.status === 'evacuating'" class="panel">
          <h4>🏃 疏散进行中 · 已疏散 {{ detail.evacuated_qty }} 人</h4>
          <div class="btnrow" v-if="canSecurity">
            <label class="inline">新增疏散 <input type="number" min="0" v-model.number="evacQty" style="width:80px" /> 人</label>
            <button class="primary" @click="doEvac(detail, false)">上报疏散进展</button>
            <label class="inline">伤员 <input type="number" min="0" v-model.number="casualties" style="width:70px" /> 人</label>
            <button class="succ" @click="doControl(detail)">疏散完毕·控场</button>
          </div>
        </div>

        <!-- 已控场：复园 -->
        <div v-else-if="detail.status === 'controlled'" class="panel">
          <h4>🌤️ 复园评估与恢复</h4>
          <div class="muted" v-if="detail.targets.length">封控对象：{{ detail.targets.filter(t=>t.restored_tick===0).map(t => (t.target_type==='ride'?'设施':'区域')+'「'+t.target_name+'」').join('、') || '均已恢复' }}</div>
          <label class="inline" v-if="canOps">抢险费用（留空按等级核定 ¥{{ rescueCost(detail.severity).toLocaleString() }}）
            <input type="number" min="0" v-model.number="reopenCost" placeholder="自动" style="width:110px" />
          </label>
          <button class="succ" :disabled="!canOps" @click="doReopen(detail)">确认现场安全 · 复园</button>
        </div>

        <!-- 已复园：复盘 -->
        <div v-else-if="detail.status === 'reopened'" class="panel">
          <h4>📋 事故复盘</h4>
          <div class="rfields" v-if="canOps">
            <label>事故原因认定 *<input v-model="reviewForm.cause" maxlength="100" /></label>
            <label>整改措施<textarea v-model="reviewForm.actions" rows="2" maxlength="300"></textarea></label>
            <label>经验教训<textarea v-model="reviewForm.lessons" rows="2" maxlength="300"></textarea></label>
            <label>处置评分
              <select v-model.number="reviewForm.rating">
                <option :value="5">★★★★★ 处置出色</option>
                <option :value="4">★★★★ 良好</option>
                <option :value="3">★★★ 合格</option>
                <option :value="2">★★ 迟缓</option>
                <option :value="1">★ 处置失当</option>
              </select>
            </label>
            <button class="primary" @click="doReview(detail)">提交复盘结案</button>
          </div>
          <p class="muted" v-else>仅运营指挥可提交复盘。</p>
        </div>

        <!-- 结案信息 -->
        <div v-else class="panel donepanel">
          <h4 v-if="detail.status === 'closed_review'">✅ 已复盘结案 · 处置评分 {{ detail.review_rating }} 星（声誉回补 +{{ detail.review_rep_recover }}）</h4>
          <h4 v-else>❔ 已按误报关闭</h4>
          <p class="muted" v-if="detail.review_cause"><b>原因：</b>{{ detail.review_cause }}</p>
          <p class="muted" v-if="detail.review_actions"><b>整改：</b>{{ detail.review_actions }}</p>
          <p class="muted" v-if="detail.review_lessons"><b>教训：</b>{{ detail.review_lessons }}</p>
        </div>

        <!-- 岗位调度 -->
        <div class="panel" v-if="ACTIVE.includes(detail.status)">
          <h4>🛡️ 应急岗位编组（{{ detail.staff.length }}）</h4>
          <div class="staffrows">
            <div v-for="s in detail.staff" :key="s.id" class="srow">
              <b>{{ s.staff_name }}</b><em>{{ s.staff_role }} · {{ s.task_name }}</em>
              <span class="tag" :class="s.status">{{ TASK_STATUS[s.status] }}</span>
              <em class="money neg">补贴 ¥{{ s.subsidy }}</em>
              <span class="grow"></span>
              <button v-if="s.status === 'assigned' && canSecurity" class="ghost sm" @click="doAck(s)">到场确认</button>
              <button v-if="s.status === 'acknowledged' && canSecurity" class="ghost sm" @click="doStand(s)">撤防</button>
            </div>
          </div>
          <div class="btnrow" v-if="canOps">
            <select v-model.number="assignStaffId">
              <option :value="null" disabled>选择员工（优先保安）…</option>
              <option v-for="s in activeStaff" :key="s.id" :value="s.id">{{ s.name }} · {{ s.role }} · Lv.{{ s.skill }}</option>
            </select>
            <select v-model="assignTask">
              <option v-for="t in TASKS" :key="t.k" :value="t.k">{{ t.name }}</option>
            </select>
            <button class="primary" @click="doAssign(detail)">调派</button>
          </div>
        </div>

        <!-- 封控对象 -->
        <div class="panel" v-if="detail.targets.length">
          <h4>🚧 封控对象与退款联动</h4>
          <div class="trows">
            <div v-for="t in detail.targets" :key="t.id" class="trow">
              {{ t.target_type === 'ride' ? '🎢 设施' : '🗺️ 区域' }}「{{ t.target_name }}」
              <span class="tag" :class="t.restored_tick ? 'restored' : 'locked'">{{ t.restored_tick ? '已复园恢复' : '封控中' }}</span>
            </div>
          </div>
          <p class="muted smtxt">设施停运已联动关停时段、在途散客预约园方全额退款、团队行程重排或退款；入园/设施合计退款 {{ detail.refund_ride_qty + detail.refund_entry_qty }} 人。</p>
        </div>

        <!-- 游客理赔 -->
        <div class="panel" v-if="detail.status !== 'closed_false'">
          <h4>🩹 游客理赔（{{ detail.claims.length }}）· 已赔付 ¥{{ detail.claim_paid_total.toLocaleString() }}</h4>
          <div class="claimrows">
            <div v-for="c in detail.claims" :key="c.id" class="crow">
              <b>{{ c.code }}</b><em>{{ c.guest_name }} · {{ c.item }}</em>
              <span>申请 <b class="money neg">¥{{ c.amount_req }}</b></span>
              <span class="tag" :class="c.status">{{ CLAIM_STATUS[c.status] }}</span>
              <span v-if="c.status === 'paid'">赔付 <b class="money neg">¥{{ c.amount_pay }}</b></span>
              <span class="grow"></span>
              <template v-if="c.status === 'submitted' && canOps">
                <input type="number" min="0" v-model.number="payAmount[c.id]" :placeholder="c.amount_req" style="width:90px" />
                <button class="succ sm" @click="doPayClaim(c)">核定赔付</button>
                <button class="danger sm" @click="doRejectClaim(c)">驳回</button>
              </template>
            </div>
          </div>
          <div class="btnrow claimform" v-if="ACTIVE.includes(detail.status) || detail.status === 'reopened'">
            <input v-model="claimForm.guest_name" placeholder="游客称呼" style="width:110px" />
            <input v-model="claimForm.item" placeholder="理赔事项" />
            <input type="number" min="1" v-model.number="claimForm.amount_req" placeholder="申请金额" style="width:110px" />
            <button class="primary" @click="doClaim(detail)">游客登记理赔</button>
          </div>
        </div>

        <!-- 时间线 -->
        <h4>🕒 处置时间线</h4>
        <div class="logs">
          <div v-for="l in detailLogs" :key="l.id" class="log">
            <span class="dot"></span>
            <b>{{ ACTION_LABEL[l.action] || l.action }}</b>
            <em class="muted">{{ l.actor_name }} · 第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.em { display: flex; flex-direction: column; gap: 14px; }
.rolebar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.rb-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
.rb-title .muted { font-weight: 400; font-size: 12px; }
.roles { display: flex; gap: 8px; }
.roles button.on { border-color: var(--red); background: rgba(255,107,107,.16); color: var(--red); }

.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.neg { color: var(--red); }
.flash { background: rgba(109,213,160,.12); border: 1px solid rgba(109,213,160,.4); color: var(--green); padding: 8px 14px; border-radius: 10px; font-size: 13px; }

.cols { display: grid; grid-template-columns: 1.7fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 1050px) { .cols { grid-template-columns: 1fr; } }

.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tabs button { padding: 5px 14px; font-size: 12px; }
.tabs button.on { border-color: var(--red); background: rgba(255,107,107,.14); color: var(--red); }

.ilist { display: flex; flex-direction: column; gap: 10px; max-height: 620px; overflow-y: auto; padding-right: 4px; }
.iitem { border: 1px solid var(--border); border-left-width: 3px; border-radius: 10px; padding: 12px; background: rgba(255,255,255,.02); }
.iitem.sev0 { border-left-color: var(--accent2); }
.iitem.sev1 { border-left-color: var(--blue); }
.iitem.sev2 { border-left-color: var(--accent2); }
.iitem.sev3 { border-left-color: var(--red); }
.iitem.sev4 { border-left-color: #b3122e; box-shadow: 0 0 0 1px rgba(179,18,46,.3) inset; }
.iitem.overdue { background: rgba(255,107,107,.07); }
.iitem.dim { opacity: .85; }
.ii-head { display: flex; align-items: center; gap: 10px; }
.ii-head .big-ic { font-size: 20px; }
.ii-title { flex: 1; min-width: 0; }
.ii-title b { font-size: 14px; display: block; }
.ii-title em { font-style: normal; font-size: 11px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); white-space: nowrap; }
.badge.sev.sev1 { color: var(--blue); border-color: rgba(102,166,255,.5); }
.badge.sev.sev2 { color: var(--accent2); border-color: rgba(255,209,102,.5); }
.badge.sev.sev3 { color: #fff; background: var(--red); border-color: var(--red); }
.badge.sev.sev4 { color: #fff; background: #b3122e; border-color: #b3122e; }
.st-report { color: var(--accent2) !important; }
.st-graded { color: var(--accent2) !important; }
.st-contained { color: var(--purple) !important; }
.st-evac { color: #fff !important; background: var(--red) !important; border-color: var(--red) !important; }
.st-controlled { color: var(--blue) !important; }
.st-reopen { color: var(--green) !important; }
.st-done { color: var(--green) !important; }
.st-false { color: var(--muted) !important; }
.timeline-btn { font-size: 12px; padding: 4px 10px; }
.content { font-size: 13px; margin: 8px 0; }
.ii-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.ii-meta b { color: var(--text); }
.ii-meta .sla { margin-left: auto; }
.ii-meta .sla.red { color: var(--red); font-weight: 700; }
.empty { padding: 24px; text-align: center; }

.rfields { display: flex; flex-direction: column; gap: 8px; }
.rfields label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.mmsg { color: var(--green); font-size: 12px; font-style: normal; }
.tips ul { list-style: none; display: flex; flex-direction: column; gap: 9px; font-size: 12.5px; color: var(--muted); }
.tips li { padding-left: 16px; position: relative; line-height: 1.6; }
.tips li::before { content: '•'; position: absolute; left: 2px; color: var(--red); }
.tips b { color: var(--text); }

/* 处置台 */
.mask { position: fixed; inset: 0; background: rgba(5,8,18,.7); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(760px, 100%); max-height: 88vh; overflow-y: auto; }
.d-head { display: flex; align-items: flex-start; justify-content: space-between; }
.d-head h3 { font-size: 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.d-meta { font-size: 12px; margin-bottom: 10px; }

.flow { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; background: var(--panel2); border-radius: 10px; padding: 10px; margin-bottom: 12px; }
.flow .node { font-size: 11px; color: var(--muted); padding: 3px 8px; border-radius: 20px; border: 1px solid var(--border); }
.flow .node.on { color: #fff; background: var(--red); border-color: var(--red); }
.flow .arrow { color: var(--muted); font-size: 10px; font-style: normal; }

.panel { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: rgba(255,255,255,.02); }
.panel h4 { font-size: 13px; margin-bottom: 10px; }
.sevpick { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 10px; }
.sevpick.dis { opacity: .5; pointer-events: none; }
.sevbtn { display: flex; flex-direction: column; gap: 2px; padding: 10px 4px; align-items: center; }
.sevbtn b { font-size: 14px; }
.sevbtn em { font-style: normal; font-size: 11px; color: var(--muted); }
.sevbtn.sev1.on { border-color: var(--blue); background: rgba(102,166,255,.15); }
.sevbtn.sev2.on { border-color: var(--accent2); background: rgba(255,209,102,.15); }
.sevbtn.sev3.on { border-color: var(--red); background: rgba(255,107,107,.18); }
.sevbtn.sev4.on { border-color: #b3122e; background: rgba(179,18,46,.25); }
.chk { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin: 8px 0; }
.lockpick { margin: 8px 0; }
.lockpick label, .panel label { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.panel select[multiple] { min-height: 60px; }
.btnrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.inline { flex-direction: row !important; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }

.staffrows, .claimrows, .trows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.srow, .crow, .trow { display: flex; align-items: center; gap: 10px; font-size: 12.5px; flex-wrap: wrap; }
.srow em, .crow em { font-style: normal; color: var(--muted); }
.grow { flex: 1; }
.tag.assigned { color: var(--accent2); border-color: rgba(255,209,102,.5); }
.tag.acknowledged { color: #fff; background: var(--red); border-color: var(--red); }
.tag.stood_down { color: var(--muted); }
.tag.locked { color: var(--red); border-color: rgba(255,107,107,.5); }
.tag.restored { color: var(--green); border-color: rgba(109,213,160,.5); }
.tag.paid { color: var(--green); border-color: rgba(109,213,160,.5); }
.tag.rejected { color: var(--muted); }
.tag.submitted { color: var(--accent2); border-color: rgba(255,209,102,.5); }
.sm { padding: 4px 10px; font-size: 12px; }
.smtxt { font-size: 11px; margin-top: 6px; }
.claimform { margin-top: 6px; }
.donepanel { background: rgba(109,213,160,.06); }

.dialog h4 { font-size: 13px; margin: 14px 0 8px; }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 14px 20px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .dot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--red); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 3px; }
</style>
