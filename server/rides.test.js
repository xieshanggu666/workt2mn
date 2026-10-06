// 设施刺激度升级安全与原子性测试：
//   1) 输入校验：负数/0/非数/小数/超限一律拒绝，杜绝负升级反向刷钱、压低刺激度
//   2) 扣款 + 财务流水 + thrill/attr 提升同一事务原子提交：
//      事务中段（财务流水写入）失败整体回滚，现金、设施属性、流水三者保持一致
// 运行：node --experimental-sqlite --test server/rides.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RIDES = await import('./rides.js')

// ---- 测试上下文：记录财务流水，可注入故障 ----
const finLogs = []
let failOnUpgradeFinance = false   // 升级流水写入失败（模拟事务中段异常）
RIDES.initRideContext({
  logFinance: (day, label, amount, detail) => {
    if (failOnUpgradeFinance && label === '升级') throw new Error('模拟升级流水写入失败')
    finLogs.push({ day, label, amount, detail })
  }
})

const cash = () => Number(getSetting('cash'))
const rideById = id => db.prepare('SELECT * FROM rides WHERE id=?').get(id)
const insertRide = (over = {}) =>
  Number(db.prepare(`INSERT INTO rides(name,type,zone_id,status,capacity,cycle_min,build_cost,run_cost,thrill,attr,price,pos_row,pos_col)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(over.name || '测试设施', over.type || '过山车', 1, over.status || 'operating',
         20, 5, 30000, 100, over.thrill ?? 50, over.attr ?? 70, 30, 0, 0).lastInsertRowid)

before(() => {
  setSetting('day', 1)
  setSetting('tick', 0)
  setSetting('cash', 100000)
})

test('正常升级：thrill/attr 提升、现金按 3000/点 扣减、升级流水入账', () => {
  const id = insertRide({ thrill: 60, attr: 70 })
  const before = rideById(id)
  const cash0 = cash()
  const r = RIDES.upgradeRide(id, 10)
  assert.equal(r.ok, true)
  assert.equal(r.cost, 30000)

  const after = rideById(id)
  assert.equal(after.thrill, before.thrill + 10, '刺激度应 +10')
  assert.equal(after.attr, Math.round((before.attr + 3) * 10) / 10, '吸引度应按 0.3/点 提升')
  assert.equal(cash(), cash0 - 30000, '现金应扣减 30000，不允许负升级反向加钱')
  const log = finLogs.find(f => f.label === '升级' && f.detail.includes(after.name))
  assert.ok(log, '应写升级财务流水')
  assert.equal(log.amount, -30000, '流水金额应为负（支出）')
})

test('负数升级被拒绝：现金不增加、刺激度不下降、无流水', () => {
  const id = insertRide({ thrill: 60, attr: 70 })
  const before = rideById(id)
  const cash0 = cash()
  const logs0 = finLogs.length

  for (const bad of [-1, -10, -0.01]) {
    const r = RIDES.upgradeRide(id, bad)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BAD_UPGRADE')
  }
  assert.equal(cash(), cash0, '现金必须保持不变（漏洞：负升级曾反向加钱）')
  const after = rideById(id)
  assert.equal(after.thrill, before.thrill, '刺激度不得被负升级压低')
  assert.equal(after.attr, before.attr, '吸引度不得变动')
  assert.equal(finLogs.length, logs0, '不得写入任何财务流水')
})

test('0 / 非数 / 小数 / 超限值被拒绝', () => {
  const id = insertRide()
  const cash0 = cash()
  for (const bad of [0, NaN, null, undefined, '', 'abc', 1.5, 101, 1000, Infinity, -Infinity]) {
    const r = RIDES.upgradeRide(id, bad)
    assert.equal(r.ok, false, `入参 ${JSON.stringify(bad)} 应被拒绝`)
  }
  assert.equal(cash(), cash0, '非法入参不得扣款')
  assert.equal(rideById(id).thrill, 50, '非法入参不得改动设施')
})

test('设施不存在：返回 404，不动现金', () => {
  const cash0 = cash()
  const r = RIDES.upgradeRide(999999, 10)
  assert.equal(r.ok, false)
  assert.equal(r.status, 404)
  assert.equal(cash(), cash0)
})

test('资金不足：拒绝升级且设施与现金均不变', () => {
  const id = insertRide()
  setSetting('cash', 1000)
  const before = rideById(id)
  const r = RIDES.upgradeRide(id, 10)   // 需 30000
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_CASH')
  assert.equal(cash(), 1000)
  const after = rideById(id)
  assert.equal(after.thrill, before.thrill)
  assert.equal(after.attr, before.attr)
  assert.ok(!finLogs.some(f => f.label === '升级' && f.detail.includes(after.name)), '不应写流水')
  setSetting('cash', 100000)
})

test('刺激度上限 100：超出剩余空间的升级被拒绝，达上限后不可再升', () => {
  const id = insertRide({ thrill: 95 })
  const cash0 = cash()
  let r = RIDES.upgradeRide(id, 10)    // 仅剩 5 点空间
  assert.equal(r.ok, false)
  assert.equal(r.code, 'THRILL_CAP')
  assert.equal(rideById(id).thrill, 95)
  assert.equal(cash(), cash0)

  r = RIDES.upgradeRide(id, 5)
  assert.equal(r.ok, true)
  assert.equal(rideById(id).thrill, 100)

  r = RIDES.upgradeRide(id, 1)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'THRILL_FULL')
})

test('在途检修工单期间拒绝升级', () => {
  const id = insertRide()
  db.prepare(`INSERT INTO maintenance_orders(code,ride_id,status,source,progress,cost,create_tick,create_day)
              VALUES(?,?, 'queued','manual',0,1000,0,1)`).run('WXTEST', id)
  const cash0 = cash()
  const r = RIDES.upgradeRide(id, 10)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'RIDE_IN_MAINTENANCE')
  assert.equal(cash(), cash0)
  assert.equal(rideById(id).thrill, 50)
})

test('原子性：财务流水写入失败时整体回滚（现金与设施属性均不落库）', () => {
  const id = insertRide({ thrill: 50, attr: 70 })
  const before = rideById(id)
  const cash0 = cash()
  const logs0 = finLogs.length
  failOnUpgradeFinance = true
  try {
    const r = RIDES.upgradeRide(id, 10)
    assert.equal(r.ok, false, '中段失败应返回失败')
    assert.equal(r.code, 'TX_FAILED')
  } finally {
    failOnUpgradeFinance = false
  }
  assert.equal(cash(), cash0, '回滚后现金不得被扣减')
  const after = rideById(id)
  assert.equal(after.thrill, before.thrill, '回滚后刺激度不得变动')
  assert.equal(after.attr, before.attr, '回滚后吸引度不得变动')
  assert.equal(finLogs.length, logs0, '失败流水不得留在财务账中')
})
