<script setup>
import { ref, computed, onMounted } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const tab = ref('pending')
const kindFilter = ref('')
const list = ref([])
const stats = ref({ pending: 0, pendingByKind: { reservation: 0, group: 0, partner: 0 }, doneToday: 0 })
const loading = ref(false)
const msg = ref(null)
const detailLogs = ref([])
const detailTask = ref(null)

const KIND = {
  reservation_refund: { name: '散客预约退款', icon: '📅', tone: 'rsv' },
  group_outage: { name: '团队行程重排/退款', icon: '🧑‍✈️', tone: 'grp' },
  partner_refund: { name: '联营退款红冲', icon: '🤝', tone: 'ptn' }
}
const STATUS = { pending: '待补偿', done: '已补偿', obsolete: '已作废' }

async function load() {
  loading.value = true
  try {
    const r = await store.outageTasks(tab.value, kindFilter.value)
    list.value = r.list || []
    stats.value = r.stats || stats.value
  } finally {
    loading.value = false
  }
}
onMounted(load)

function kindName(k) { return KIND[k]?.name || k }
function kindIcon(k) { return KIND[k]?.icon || '🔧' }
function statusName(s) { return STATUS[s] || s }

function summarize(t) {
  const p = t.payloadObj || {}
  if (t.kind === 'reservation_refund') return `预约 #${p.reservationId || t.ref_id} · ${p.note || '园方全额退款'}`
  if (t.kind === 'group_outage') {
    const ride = p.ride?.name ? `「${p.ride.name}」` : '入园时段'
    return `团队 #${p.groupId || t.ref_id} · ${ride}停运 · ${(p.itemIds || []).length} 个行程待${p.mode === 'destroy' ? '退款' : '重排/退款'}`
  }
  if (t.kind === 'partner_refund') return `商铺 #${p.vendorId || t.ref_id} · 退款 ¥${p.refund} × ${p.qty} 份 · ${p.note || ''}`
  return ''
}

async function retryAll() {
  msg.value = null
  const r = await store.retryOutageTasks()
  if (r.ok) {
    msg.value = { ok: true, text: `本轮完成 ${r.done} 个、作废 ${r.obsolete} 个、仍失败 ${r.failed} 个；剩余挂起 ${r.remaining} 个` }
    await Promise.all([load(), store.refresh()])
  } else {
    msg.value = { ok: false, text: r.msg || '重试失败，请稍后再试' }
  }
}

async function showDetail(t) {
  detailTask.value = t
  const r = await store.outageTaskLogs(t.id)
  detailLogs.value = r.logs || []
}
function closeDetail() { detailTask.value = null; detailLogs.value = [] }

function switchTab(t, kind = '') {
  tab.value = t
  kindFilter.value = kind
  load()
}

const pendingTotal = computed(() => stats.value.pending || 0)
</script>

<template>
  <div class="outage-wrap">
    <div class="hint-bar">
      <div>
        <b>🧯 设施停运统一补偿中心</b>
        <span class="muted">设施停运后的散客预约退款、团队行程重排/退款、联营退款红冲统一接入可恢复补偿队列：
          每笔补偿独立事务执行，失败自动每小时重试，成功才一次性同步库存、现金、投诉与账单；
          人工先行处理后任务自动作废，<b>绝不二次扣款或退款</b>。</span>
      </div>
      <div class="actions">
        <span class="badge red" v-if="pendingTotal">挂起 {{ pendingTotal }} 笔</span>
        <span class="badge ok" v-else>全部补偿已完成</span>
        <button class="btn primary" :disabled="loading || !pendingTotal" @click="retryAll">立即重试补偿</button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div class="msg okm" v-if="msg?.ok">{{ msg.text }}</div>
    <div class="msg errm" v-else-if="msg && !msg.ok">{{ msg.text }}</div>

    <div class="stat-row">
      <div class="stat-card"><div class="n">{{ stats.pendingByKind.reservation || 0 }}</div><div class="l">📅 散客预约待补退</div></div>
      <div class="stat-card"><div class="n">{{ stats.pendingByKind.group || 0 }}</div><div class="l">🧑‍✈️ 团队行程待补偿</div></div>
      <div class="stat-card"><div class="n">{{ stats.pendingByKind.partner || 0 }}</div><div class="l">🤝 联营退款待红冲</div></div>
      <div class="stat-card"><div class="n">{{ stats.doneToday || 0 }}</div><div class="l">✅ 今日已补偿</div></div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'pending' }" @click="switchTab('pending')">待补偿</button>
      <button :class="{ on: tab === 'done' }" @click="switchTab('done')">已补偿</button>
      <button :class="{ on: tab === 'obsolete' }" @click="switchTab('obsolete')">已作废（人工处置）</button>
      <button :class="{ on: tab === 'all' }" @click="switchTab('all')">全部</button>
      <span class="tab-sep"></span>
      <button :class="{ on: kindFilter === '' }" @click="switchTab(tab, '')">全部类型</button>
      <button v-for="(meta, k) in KIND" :key="k" :class="{ on: kindFilter === k }" @click="switchTab(tab, k)">
        {{ meta.icon }} {{ meta.name }}
      </button>
    </div>

    <table class="grid" v-if="list.length">
      <thead>
        <tr><th>#</th><th>类型</th><th>补偿内容</th><th>状态</th><th>尝试</th><th>最近错误</th><th>入队时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="t in list" :key="t.id" :class="{ fail: t.status === 'pending' }">
          <td>{{ t.id }}</td>
          <td><span :class="['tag', KIND[t.kind]?.tone]">{{ kindIcon(t.kind) }} {{ kindName(t.kind) }}</span></td>
          <td class="summary">{{ summarize(t) }}</td>
          <td>
            <span :class="['st', t.status]">{{ statusName(t.status) }}</span>
          </td>
          <td>{{ t.attempts }}</td>
          <td class="err" :title="t.last_error">{{ t.last_error || '—' }}</td>
          <td class="muted">第{{ t.created_day }}天</td>
          <td><button class="btn sm" @click="showDetail(t)">时间线</button></td>
        </tr>
      </tbody>
    </table>
    <div class="empty" v-else>当前没有{{ statusName(tab) !== tab ? statusName(tab) : '' }}补偿任务</div>

    <!-- 时间线弹层 -->
    <div class="modal" v-if="detailTask" @click.self="closeDetail">
      <div class="modal-card">
        <div class="modal-head">
          <b>补偿任务 #{{ detailTask.id }} · {{ kindName(detailTask.kind) }}</b>
          <button class="btn sm" @click="closeDetail">关闭</button>
        </div>
        <p class="muted">{{ summarize(detailTask) }}</p>
        <div class="logs">
          <div v-for="l in detailLogs" :key="l.id" class="logline">
            <span class="lt">第{{ l.day }}天</span>
            <span :class="['la', l.action]">{{ { enqueue: '入队', retry: '重试', done: '成功', observe: '作废' }[l.action] || l.action }}</span>
            <span class="ln">{{ l.note }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.outage-wrap { display: flex; flex-direction: column; gap: 12px; }
.hint-bar { display: flex; justify-content: space-between; gap: 16px; align-items: center;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.hint-bar .muted { display: block; margin-top: 4px; font-size: 12.5px; line-height: 1.6; }
.actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); }
.badge.red { color: var(--accent); border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.1); }
.badge.ok { color: #4caf7d; border-color: rgba(76,175,125,.4); background: rgba(76,175,125,.1); }
.btn { border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 8px; padding: 7px 12px; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.sm { padding: 3px 9px; font-size: 12px; }
.msg { padding: 9px 12px; border-radius: 8px; font-size: 13px; }
.okm { background: rgba(76,175,125,.12); color: #4caf7d; }
.errm { background: rgba(255,107,107,.12); color: var(--accent); }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.stat-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; text-align: center; }
.stat-card .n { font-size: 26px; font-weight: 700; }
.stat-card .l { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tabs button { border: 1px solid var(--border); background: transparent; color: var(--muted); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.tabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.tab-sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
.grid { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 12px; overflow: hidden; }
.grid th, .grid td { padding: 9px 10px; border-bottom: 1px solid var(--border); font-size: 13px; text-align: left; }
.grid th { color: var(--muted); font-weight: 500; font-size: 12px; }
.grid tr.fail { background: rgba(255,107,107,.05); }
.summary { max-width: 380px; }
.err { color: var(--accent); font-size: 12px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--muted); }
.tag { padding: 2px 8px; border-radius: 6px; font-size: 12px; white-space: nowrap; }
.tag.rsv { background: rgba(88,150,250,.15); color: #5896fa; }
.tag.grp { background: rgba(255,180,60,.15); color: #ffb43c; }
.tag.ptn { background: rgba(140,110,255,.15); color: #8c6eff; }
.st { padding: 2px 8px; border-radius: 6px; font-size: 12px; }
.st.pending { background: rgba(255,107,107,.15); color: var(--accent); }
.st.done { background: rgba(76,175,125,.15); color: #4caf7d; }
.st.obsolete { background: rgba(150,150,150,.15); color: var(--muted); }
.empty { text-align: center; color: var(--muted); padding: 40px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px; width: 560px; max-width: 92vw; max-height: 80vh; overflow: auto; }
.modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.logs { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.logline { display: flex; gap: 10px; align-items: baseline; font-size: 13px; border-left: 2px solid var(--border); padding-left: 10px; }
.lt { color: var(--muted); font-size: 12px; flex-shrink: 0; }
.la { flex-shrink: 0; font-size: 12px; padding: 1px 7px; border-radius: 5px; }
.la.enqueue { background: rgba(88,150,250,.15); color: #5896fa; }
.la.retry { background: rgba(255,107,107,.15); color: var(--accent); }
.la.done { background: rgba(76,175,125,.15); color: #4caf7d; }
.la.observe { background: rgba(150,150,150,.15); color: var(--muted); }
.ln { color: var(--text); }
</style>
