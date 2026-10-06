import db, { getSetting, setSetting, tx } from './db.js'

// 设施域服务：设施刺激度升级（现金扣款 + 财务流水 + 属性提升必须同一事务原子提交）
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 由 index.js 注入共享上下文（时钟、现金、财务流水）
const ctx = {
  day: () => num(getSetting('day'), 1),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null
}
export function initRideContext(deps) {
  Object.assign(ctx, deps)
}

// 升级业务参数：每点刺激度升级费用、单次升级幅度上下限、刺激度上限
export const RIDE_UPGRADE = {
  COST_PER_POINT: 3000,
  MIN_POINTS: 1,
  MAX_POINTS: 50,
  THRILL_CAP: 100
}

// 设施刺激度升级：
//   thrill += points、attr += points*0.3、现金扣 points*3000 并写「升级」财务流水。
// 四步在同一事务提交：任一步失败（含财务流水写入异常）整体回滚，
// 不会出现「钱扣了属性没涨」或「属性涨了钱没扣」的半完成状态。
// 入参严格校验：必须为有限正数整数；负数/0/非数/小数一律拒绝，
// 杜绝负升级反向刷钱、压低刺激度的漏洞。
export function upgradeRide(rideId, rawPoints) {
  const points = num(rawPoints, NaN)
  if (!Number.isFinite(points) || !Number.isInteger(points) || points < RIDE_UPGRADE.MIN_POINTS) {
    return { ok: false, code: 'BAD_UPGRADE', msg: '升级幅度需为大于 0 的整数' }
  }
  if (points > RIDE_UPGRADE.MAX_POINTS) {
    return { ok: false, code: 'BAD_UPGRADE', msg: `单次升级幅度不能超过 ${RIDE_UPGRADE.MAX_POINTS} 点` }
  }

  try {
    return tx(() => {
      const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(rideId)
      if (!ride) return { ok: false, code: 'RIDE_NOT_FOUND', status: 404, msg: '设施不存在' }

      // 在途检修工单期间设施停运，不允许升级（完工恢复运营后再升级）
      const openOrder = db.prepare("SELECT id FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing')").get(rideId)
      if (openOrder) return { ok: false, code: 'RIDE_IN_MAINTENANCE', status: 400, msg: '该设施有在途检修工单，完工恢复运营后才可升级' }

      const room = RIDE_UPGRADE.THRILL_CAP - ride.thrill
      if (room <= 0) return { ok: false, code: 'THRILL_FULL', msg: `「${ride.name}」刺激度已达上限 ${RIDE_UPGRADE.THRILL_CAP}` }
      if (points > room) return { ok: false, code: 'THRILL_CAP', msg: `「${ride.name}」刺激度最多还可提升 ${room} 点（上限 ${RIDE_UPGRADE.THRILL_CAP}）` }

      const cost = points * RIDE_UPGRADE.COST_PER_POINT
      const cash = ctx.cash()
      if (cash < cost) return { ok: false, code: 'NO_CASH', status: 400, msg: `资金不足，本次升级需 ¥${cost.toLocaleString()}` }

      // 扣款、流水、属性提升同一事务：BEGIN IMMEDIATE 已锁库，现金读到扣减间无并发穿插
      setSetting('cash', Math.round(cash - cost))
      db.prepare('UPDATE rides SET thrill=thrill+?, attr=attr+? WHERE id=?')
        .run(points, Math.round(points * 0.3 * 10) / 10, rideId)
      ctx.logFinance?.(ctx.day(), '升级', -cost,
        `升级设施「${ride.name}」刺激度 +${points}（${ride.thrill} → ${ride.thrill + points}）`)

      return {
        ok: true,
        cost,
        thrill: ride.thrill + points,
        attr: Math.round((ride.attr + points * 0.3) * 10) / 10,
        cash: Math.round(cash - cost)
      }
    })
  } catch (e) {
    console.error('[rides] 设施升级失败，已整体回滚:', e)
    return { ok: false, code: 'TX_FAILED', status: 500, msg: '升级失败，本次操作未生效，请稍后重试' }
  }
}
