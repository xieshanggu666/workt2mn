<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const DOMAIN = {
  reservation: { t: '预约退款', icon: '📅' },
  group: { t: '团队行程', icon: '🧑‍✈️' },
  partner: { t: '联营退款', icon: '🤝' }
}
const STATUS = {
  pending: { t: '待补偿', c: 'var(--accent2)' },
  processing: { t: '执行中', c: 'var(--blue)' },
  done: { t: '已补偿', c: 'var(--green)' },
  manual: { t: '人工已处理', c: '#8b5cf6' },
  obsolete: { t: '已作废', c: 'var(--muted)' }
}
const st = s => STATUS[s] || { t: s, c: 'var(--muted)' }
const dm = d => DOMAIN[d] || { t: d, icon: '🧾' }

const stats = computed(() => store.compensationStats)

const filter = ref('open')
const domainFilter = ref('')
const list = computed(() => {
  return store.compensations.filter(t => {
    if (domainFilter.value && t.domain !== domainFilter.value) return false
    if (filter.value === 'open') return ['pending', 'processing'].includes(t.status)
    if (filter.value === 'manual') return t.needs_manual === 1 && t.status === 'pending'
    if (filter.value === 'done') return t.status === 'done'
    if (filter.value === 'closed') return ['manual', 'obsolete'].includes(t.status)
    return true
  })
})

function refLabel(t) {
  const p = t.payload_obj || {}
  if (t.domain === 'reservation') {
    const kind = p.reason === 'overbook' ? '超售' : '停运'
    return `${kind}补退 · 预约 #${p.reservationId || t.ref_id}`
  }
  if (t.domain === 'group') return `团队行程 · 团单 #${p.groupId || t.ref_id}`
  if (t.domain === 'partner') {
    return `召回退款 · 召回 #${p.recallId} / 商铺 #${p.vendorId} · ${p.qty || ''}份`
  }
  return `${t.ref_type} #${t.ref_id ?? '-'}`
}

// 四口径同步结果（成功任务快照）
function channels(t) {
  const r = t.result_obj || {}
  const out = []
  if (r.cash) out.push({ k: '现金', v: `¥${r.cash}`, icon: '💰' })
  if (r.stock) out.push({ k: '库存', v: r.stock, icon: '📦' })
  if (r.complaint) out.push({ k: '投诉', v: r.complaint, icon: '🗂️' })
  if (r.bill) out.push({ k: '账单', v: r.bill, icon: '🧾' })
  return out
}

const busy = ref({})
async function act(fn, id, ...args) {
  busy.value[id] = true
  try { await fn(id, ...args) } finally { busy.value[id] = false }
}
function retry(t) {
  if (!confirm(`立即重新执行补偿任务 ${t.code}？\n系统会在独立事务中同步现金/库存/投诉/账单，处理器幂等，不会重复扣款或退款。`)) return
  act(store.retryCompensation.bind(store), t.id, '人工在补偿队列页触发立即重试')
}
function manual(t) {
  const note = prompt(`登记「人工已处理」${t.code}：\n请填写线下/业务侧的处理说明（系统将停止自动重试，不再触碰现金与库存）：`, '线下已完成退款/账单红冲，凭证已留档')
  if (note === null) return
  act(store.resolveCompensationManual.bind(store), t.id, note)
}
function obsolete(t) {
  if (!confirm(`确认任务 ${t.code} 业务已无需补偿（预约已他途处置 / 联营红冲已在后续账单冲减）？\n任务将作废且不再执行。`)) return
  act(store.obsoleteCompensation.bind(store), t.id, '人工核对确认无需补偿')
}
</script>

<template>
  <div class="comp">
    <div class="hero card">
      <div>
        <h3>🛟 停运补偿队列</h3>
        <p class="muted">
          设施停运 / 全园封控后的散客预约退款、团队行程重排退款、联营召回退款统一排队。
          每个任务独立事务重试，<b>现金 · 库存 · 投诉 · 账单</b> 同事务同步；
          处理器幂等——人工先处理后重试自动作废，<b style="color:var(--red)">绝不重复扣款或重复退款</b>。
        </p>
      </div>
      <div class="kpis">
        <div class="kpi" :class="{ alert: stats.pending }">
          <b>{{ stats.pending }}</b><span>自动重试中</span>
        </div>
        <div class="kpi" :class="{ alert: stats.needsManual }">
          <b>{{ stats.needsManual }}</b><span>待人工处理</span>
        </div>
        <div class="kpi"><b>{{ stats.doneToday }}</b><span>今日已补偿</span></div>
      </div>
    </div>

    <div class="filters">
      <button v-for="f in [['open','待补偿'],['manual','待人工'],['done','已补偿'],['closed','已终结'],['','全部']]" :key="f[0]"
              :class="{ on: filter === f[0] }" @click="filter = f[0]">{{ f[1] }}</button>
      <span class="sep"></span>
      <button v-for="d in [['','全部域'],['reservation','📅 预约'],['group','🧑‍✈️ 团队'],['partner','🤝 联营']]" :key="d[0]"
              class="mini" :class="{ on: domainFilter === d[0] }" @click="domainFilter = d[0]">{{ d[1] }}</button>
    </div>

    <div v-if="!list.length" class="empty card">✅ 当前没有匹配的补偿任务，停运退款均已闭环。</div>

    <div class="list">
      <div v-for="t in list" :key="t.id" class="task card" :class="{ manualq: t.needs_manual }">
        <div class="hd">
          <span class="code">{{ t.code }}</span>
          <span class="dom">{{ dm(t.domain).icon }} {{ dm(t.domain).t }}</span>
          <span class="tag" :style="{ color: st(t.status).c }">{{ st(t.status).t }}</span>
          <span v-if="t.needs_manual" class="tag need">⚠️ 多次失败转人工</span>
          <span class="spacer"></span>
          <span class="muted small">第 {{ t.created_day }} 天挂起 · 已尝试 {{ t.attempts }} 次</span>
        </div>
        <div class="bd">
          <div class="ref">{{ refLabel(t) }}</div>
          <div class="note" v-if="t.note">📝 {{ t.note }}</div>
          <div v-if="t.status === 'pending' && t.last_error" class="err">
            ⚠️ 最近失败：{{ t.last_error }}
          </div>
          <div class="channels" v-if="t.status === 'done' && channels(t).length">
            <span v-for="c in channels(t)" :key="c.k" class="ch">{{ c.icon }} <b>{{ c.k }}</b>：{{ c.v }}</span>
          </div>
          <div v-if="t.status === 'manual'" class="note muted">已由人工处理（经办 #{{ t.staff_id || '-' }}）：{{ t.result_obj?.note || t.note }}</div>
        </div>
        <div class="ft" v-if="['pending', 'processing'].includes(t.status)">
          <button class="primary" :disabled="busy[t.id]" @click="retry(t)">🔁 立即重试</button>
          <button @click="manual(t)">🖋️ 登记人工已处理</button>
          <button class="ghost" @click="obsolete(t)">✓ 核对后作废</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 18px; }
.hero h3 { margin: 0 0 6px; }
.hero p { margin: 0; max-width: 720px; line-height: 1.6; }
.kpis { display: flex; gap: 10px; }
.kpi { background: var(--card2, #f5f7fb); border-radius: 10px; padding: 10px 16px; text-align: center; min-width: 92px; }
.kpi b { font-size: 24px; display: block; }
.kpi span { font-size: 12px; color: var(--muted); }
.kpi.alert b { color: var(--red); }
.filters { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
.filters button { padding: 6px 14px; border-radius: 16px; border: 1px solid var(--border, #e3e6ee); background: #fff; cursor: pointer; font-size: 13px; }
.filters button.on { background: var(--blue, #4f7cff); color: #fff; border-color: var(--blue, #4f7cff); }
.filters .sep { width: 1px; height: 18px; background: var(--border, #e3e6ee); margin: 0 4px; }
.filters .mini { padding: 4px 10px; font-size: 12px; }
.empty { text-align: center; padding: 36px; color: var(--muted); }
.list { display: flex; flex-direction: column; gap: 10px; }
.task { padding: 12px 16px; border-left: 4px solid transparent; }
.task.manualq { border-left-color: var(--red); }
.hd { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.code { font-weight: 700; font-family: ui-monospace, monospace; }
.dom { color: var(--muted); font-size: 13px; }
.tag { font-size: 12px; font-weight: 600; }
.tag.need { color: var(--red); }
.spacer { flex: 1; }
.small { font-size: 12px; }
.ref { font-size: 14px; margin-bottom: 4px; }
.note { font-size: 12.5px; color: #555; margin: 2px 0; }
.err { font-size: 12.5px; color: var(--red); background: rgba(239, 68, 68, 0.08); padding: 6px 10px; border-radius: 6px; margin-top: 6px; }
.channels { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.ch { font-size: 12px; background: rgba(34, 197, 94, 0.08); color: #15803d; padding: 4px 10px; border-radius: 12px; }
.ft { display: flex; gap: 8px; margin-top: 10px; }
.ft button { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border, #e3e6ee); background: #fff; cursor: pointer; font-size: 13px; }
.ft .primary { background: var(--blue, #4f7cff); color: #fff; border-color: var(--blue, #4f7cff); }
.ft .ghost { color: var(--muted); }
.ft button:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
