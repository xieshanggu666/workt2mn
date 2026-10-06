<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const buildOpen = ref(false)
const build = ref({ type: '餐饮', zone_id: 1, name: '' })
const types = ['餐饮', '纪念品', '饮品']

const list = computed(() => store.vendors)
const typeIcon = t => ({ '餐饮':'🍔', '饮品':'🥤', '纪念品':'🎁' }[t])

// 联营状态：按合同表标注履约中/已终止（租金 0 且有合同即为联营铺）
const partnerContractOf = (id) => store.partnerContracts.find(c => c.vendor_id === id && c.status === 'active')
const partnerEndedOf = (id) => store.partnerContracts.find(c => c.vendor_id === id && c.status === 'terminated')

// 库存联动：商铺所挂物资的最低库存状态（未挂物资=不受库存管理）
function vStock(v) {
  const linked = store.materials.filter(m => m.vendors.some(x => x.id === v.id))
  if (!linked.length) return null
  const worst = linked.some(m => m.stock_status === 'out') ? 'out'
    : linked.some(m => m.stock_status === 'low') ? 'low' : 'ok'
  return { worst, linked }
}

function submit() {
  store.buildVendor({ ...build.value, name: build.value.name || `新${build.value.type}摊` })
  buildOpen.value = false
  build.value.name = ''
}
</script>

<template>
  <div class="vendors">
    <div class="bar">
      <span class="gm">累计商铺营收：<b class="money">{{ store.vendors.reduce((s,v)=>s+v.rev,0).toLocaleString() }}</b></span>
      <button class="primary" @click="buildOpen = true">＋ 开设商铺</button>
    </div>

    <div class="cards">
      <div class="vcard card" v-for="v in list" :key="v.id">
        <div class="vhead">
          <span class="big-ic">{{ typeIcon(v.type) }}</span>
          <div>
            <b>{{ v.name }}</b>
            <em class="muted">{{ v.type }} · {{ store.zones.find(z=>z.id===v.zone_id)?.name }}</em>
          </div>
          <span class="inv-badge" :class="vStock(v)?.worst || 'none'" :title="vStock(v) ? vStock(v).linked.map(m=>m.name+'('+m.qty_on_hand+')').join('、') : '未挂物资，不受库存联动'">
            {{ vStock(v) ? (vStock(v).worst==='out' ? '📦 断货' : vStock(v).worst==='low' ? '📦 偏低' : '📦 充足') : '未管库存' }}
          </span>
          <span v-if="partnerContractOf(v.id)" class="partner-badge" :title="'联营扣点 ' + Math.round(partnerContractOf(v.id).commission_rate*100) + '%，按流水分账不收租'">🤝 联营 {{ Math.round(partnerContractOf(v.id).commission_rate*100) }}%</span>
          <span v-else-if="partnerEndedOf(v.id)" class="partner-badge ended">已解约</span>
          <button class="ghost danger" @click="store.delVendor(v.id)">✕</button>
        </div>
        <div class="vmeta">
          <div><em>单价</em><b class="money">{{ v.price }}</b></div>
          <div><em>毛利率</em><b>{{ Math.round(v.margin*100) }}%</b></div>
          <div><em>月租</em><b :class="partnerContractOf(v.id) ? 'partner-rent' : 'money neg'">{{ partnerContractOf(v.id) ? '联营免租' : v.rent }}</b></div>
        </div>
        <div class="vbottom">
          <span class="muted">累计售出 {{ v.sold }} 件</span><span class="money">¥{{ v.rev.toLocaleString() }}</span>
        </div>
        <div class="vprice">
          <input type="range" min="10" max="120" v-model.number="v.price" @change="store.updateVendor(v.id,{price:v.price})" />
          <span class="muted">时价 {{ v.price }}</span>
        </div>
      </div>
    </div>

    <div class="modal" v-if="buildOpen">
      <div class="modal-box card">
        <h3>🏪 开设新商铺</h3>
        <div class="form">
          <label>商铺类型
            <select v-model="build.type"><option v-for="t in types" :key="t" :value="t">{{ t }}</option></select>
          </label>
          <label>所属区域
            <select v-model.number="build.zone_id"><option v-for="z in store.zones.filter(z=>z.unlocked)" :key="z.id" :value="z.id">{{ z.name }}</option></select>
          </label>
          <label>名称 <input v-model="build.name" placeholder="留空自动命名" /></label>
        </div>
        <div class="acts">
          <button class="primary" @click="submit">确认开店</button>
          <button class="ghost" @click="buildOpen=false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vendors { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; }
.gm { font-size: 13px; color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
.vhead { display: flex; align-items: center; gap: 10px; }
.big-ic { font-size: 34px; }
.vhead b { display: block; }
.vhead em { font-style: normal; font-size: 12px; }
.vhead .ghost { margin-left: auto; }
.inv-badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); white-space: nowrap; }
.inv-badge.ok { color: var(--green); border-color: rgba(109,213,160,.4); background: rgba(109,213,160,.12); }
.inv-badge.low { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.12); }
.inv-badge.out { color: var(--red); border-color: rgba(255,107,107,.45); background: rgba(255,107,107,.15); }
.inv-badge.none { color: var(--muted); }
.partner-badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; color: var(--purple); border: 1px solid rgba(167,139,250,.5); background: rgba(167,139,250,.12); white-space: nowrap; }
.partner-badge.ended { color: var(--muted); border-color: var(--border); background: var(--panel2); }
.partner-rent { color: var(--purple); font-size: 13px; }
.vmeta { display: flex; gap: 8px; margin: 12px 0; }
.vmeta div { background: var(--panel2); flex: 1; text-align: center; border-radius: 8px; padding: 8px; }
.vmeta em { display: block; font-style: normal; font-size: 11px; color: var(--muted); }
.vmeta b { font-size: 16px; }
.vbottom { display: flex; justify-content: space-between; font-size: 13px; }
.vprice { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.vprice input { flex: 1; accent-color: var(--accent); }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { width: min(420px, 92vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.acts { display: flex; gap: 8px; }
</style>