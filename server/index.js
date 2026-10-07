import express from 'express'
import db, { getSetting, setSetting, tx } from './db.js'
import {
  initReservationContext, ensureSlots, syncRideSlots,
  autoCheckin, expireNoShow, autoBookDemand, retryPendingOverbookRefunds,
  createReservation, cancelReservation, rescheduleReservation, checkinReservation,
  listSlots, listReservations, reservationLogs, updateSlot, reservationStats,
  refundReservation, autoBookMember
} from './reservations.js'
import {
  initMaintenanceContext, backfillMaintenanceOrders, processMaintenance,
  createMaintenanceOrder, assignMaintenanceOrder, cancelMaintenanceOrder,
  cancelOrdersByRide, releaseStaffOrders, listMaintenanceOrders,
  maintenanceOrderDetail, maintenanceStats, staffLoad
} from './maintenance.js'
import {
  initMemberContext, bindReservationAutoBook,
  registerMember, applyCard, topup, redeemPoints, vendorSpend, buyEntryTicket,
  setFrozen, adjustPoints, setOwner, sweepExpiredCards, autoMemberEconomy,
  listMembers, memberDetail, listCardProducts, listBenefitProducts,
  getConfig, saveConfig, updateCardProduct, memberStats, compAwardPoints,
  quoteReservation as memberQuote, onReservationBooked, onReservationRefund as onReservationRefunded
} from './members.js'
import {
  initSchedulingContext, processScheduling, dayCloseSummary,
  createSchedule, cancelSchedule, checkin as scheduleCheckin, leavePost,
  releaseStaffSchedules, requestSwap, approveSwap, rejectSwap,
  requestOvertime, approveOvertime, rejectOvertime, cancelRequest,
  listSchedules, listAttendance, listRequests as listShiftRequests,
  shiftLogs, schedulingStats, coverageForDay, staffDutyState, writeWorkCompletion,
  listShiftTemplates, demandForDay, dispatchPlan, runDynamicDispatch, maybeDispatchAfter,
  createDispatchPlan, approveDispatchPlan, rejectDispatchPlan, getDispatchPlan, listDispatchPlans,
  refreshAutoDispatchPlan, expireDispatchPlans
} from './scheduling.js'
import {
  initGroupContext, submitGroup, confirmGroup, rejectGroup, cancelGroup,
  payBalance, checkinGroupItem, refundGroupLeg, rerouteGroupItem,
  refundInterruptedItem, handleParkOutageGroupRows, refundGroupsByRide,
  autoSimulateGroup, autoGroupTick, listGroups, groupDetail, groupStats, GROUP_CONST
} from './groups.js'
import {
  initFlowContext, refreshForecastSnapshots, settleForecastLearning,
  runReconcile, listFindings, ignoreFinding, closedLoopOverview, reconcileStats
} from './flow.js'
import {
  initEmergencyContext, reportIncident, gradeIncident, lockdownIncident,
  startEvacuation, reportEvacuation, controlIncident, reopenIncident, reviewIncident,
  closeFalseIncident, assignIncidentStaff, acknowledgeStaff, standDownStaff,
  fileClaim, payClaim, rejectClaim, escalateFromComplaint, processIncidents,
  maybeSpawnIncident, activeCrowdFactor, listIncidents, incidentDetail, incidentStats,
  EMERGENCY_CONST
} from './emergency.js'
import { emergencyCloseEntrySlots, emergencyReopenEntrySlots } from './reservations.js'
import { initRideContext, upgradeRide } from './rides.js'
import {
  initProcurementContext, processProcurementTick,
  listSuppliers, supplierDetail, saveSupplier,
  listMaterials, materialMovements, saveMaterial, setVendorMaterials, autoLinkVendor,
  applyVendorSales, reserveVendorStock, customerReturn, partnerCogs,
  createOrder, submitOrder, approveOrder, rejectOrder, receiveOrder, payOrder, purchaseReturn,
  listOrders, orderDetail, listBatches, listReturns,
  createStocktake, submitStocktake, approveStocktake, cancelStocktake, listStocktakes, stocktakeDetail,
  listInventoryFindings, resolveInventoryFinding, ignoreInventoryFinding, procurementStats
} from './procurement.js'
import {
  initPartnerContext,
  applyPartner, withdrawApplication, approveApplication, rejectApplication,
  listApplications, applicationDetail,
  listContracts, contractDetail, terminateContract, activeContract as activePartnerContract,
  recordSale as partnerRecordSale, isPartnerVendor,
  organicReturn, recordReturn as partnerRecordReturn,
  levyComplaintFine,
  issueSettlement, paySettlement, retryOverdueSettlements, autoIssueSettlements,
  listSales as listPartnerSales, listSettlements, settlementDetail, listFines,
  partnerStats, PARTNER_CONST
} from './partners.js'
import {
  initGiftContext,
  createFamily, inviteFamily, leaveFamily, removeFamilyMember, dissolveFamily,
  listFamilies, familyDetail,
  applyGift, cancelGiftApplication, approveGift, rejectGift, claimGift, declineGift, recallGift,
  sweepExpiredGifts, reconcileGifts,
  listGifts, giftDetail, claimableGiftsFor, giftStats, getGiftConfig, saveGiftConfig
} from './gifts.js'
import {
  initRecallContext,
  createRecall, acceptRecall, acknowledgeVendor, vendorRefund, markVendorNone,
  returnBatches, destroyBatches, payCompensation, compensationQuote,
  closeRecall, closeFalseRecall, cancelRecall,
  listRecalls, recallDetail, recallStats
} from './recalls.js'
import {
  initCompensationContext, runCompensations, retryTask as retryCompensationTask,
  resolveTaskManual as resolveCompensationManual, markObsolete as markCompensationObsolete,
  listCompensations, compensationDetail, compensationStats as compensationStatsFn
} from './compensation.js'
import { enqueueGroupOutageCompensations } from './groups.js'

const app = express()
app.use(express.json())

// 请求追踪：每个 API 请求分配请求号（响应头 X-Request-Id + 响应体 reqId），前端报错可凭此定位
app.use((req, res, next) => {
  req.reqId = 'R' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6)
  res.setHeader('X-Request-Id', req.reqId)
  next()
})

const PORT = 4150
const HOURS_PER_DAY = 10   // 9:00 ~ 18:00
const OPEN_HOUR = 9
const TICK_MS = 2000

// 分期贷款参数：每 1 个游戏日 = 1 期
const LOAN_PERIOD_CHOICES = [5, 10, 20, 30]   // 可选期数(天)
const LOAN_RATE_CHOICES = [0.005, 0.01, 0.02] // 可选每期利率
const LOAN_MIN = 1000
const LOAN_MAX = 5000000
const OVERDUE_PENALTY = 0.02                  // 逾期挂账每日罚息 2%

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// ---------------- 工具 ----------------
const state = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  reputation: () => num(getSetting('reputation'), 70),
  ticket: () => num(getSetting('ticket'), 120),
  guestBase: () => num(getSetting('guestBase'), 600),
  wordOfMouth: () => num(getSetting('wordOfMouth'), 0)   // 投诉补救口碑 -10 ~ +10
}

const allZones = () => db.prepare('SELECT * FROM zones ORDER BY id').all()
const openZones = () => db.prepare('SELECT * FROM zones WHERE open=1').all()
const allRides = () => db.prepare('SELECT * FROM rides ORDER BY id').all()
const operatingRides = () => db.prepare("SELECT * FROM rides WHERE status='operating'").all()
const allVendors = () => db.prepare('SELECT * FROM vendors ORDER BY id').all()
const allStaff = () => db.prepare('SELECT * FROM staff ORDER BY id').all()

function logFinance(day, label, amount, detail) {
  db.prepare('INSERT INTO finance(tick,day,label,amount,detail) VALUES(?,?,?,?,?)')
    .run(state.tick(), day, label, Math.round(amount), detail || '')
}

// 分时预约模块共享：时钟 / 现金 / 财务流水 / 投诉建单
initReservationContext({
  logFinance,
  createComplaint: (payload) => createComplaint(payload)
})

// 检修工单模块共享：时钟 / 现金 / 财务流水 / 停运时段联动 / 完工联动设施类投诉 / 排班在岗校验 / 完工回写
initMaintenanceContext({
  logFinance,
  syncRideSlots: (ride) => syncRideSlots(ride),
  linkComplaintsToRide: (rideId, staffId) => linkComplaintsToRide(rideId, staffId),
  staffDutyState: (staffId) => staffDutyState(staffId),
  onWorkComplete: (staffId, kind, meta) => writeWorkCompletion(staffId, kind, meta)
})

// 排班与工时结算模块共享：时钟 / 现金 / 财务流水 / 投诉岗位映射（用于岗位覆盖校验）
// 惰性读取（COMPLAINT_CATS 在本文件后段定义），避免初始化时引用未声明常量
initSchedulingContext({
  logFinance,
  complaintRoles: new Proxy({}, { get: (_t, cat) => COMPLAINT_CATS[cat]?.roles || [] })
})

// 会员与权益中心：时钟 / 现金 / 财务流水
initMemberContext({
  logFinance,
  // 会员商铺消费前先校验并冻结库存：库存不足直接整单失败（与支付同一事务，不发生扣款成功却无货）
  // 联营商铺按联营模式打标扣库存（批次成本随结算扣收，流水记 partner_sale）
  reserveVendorStock: (vendorId, qty) => reserveVendorStock(vendorId, qty, { partner: isPartnerVendor(vendorId) }),
  // 联营分账钩子：会员在联营商铺消费成交后，按合同扣点/会员优惠分摊写流水（在会员支付事务内）
  partnerSaleHook: (vendorId, payload) => partnerRecordSale(vendorId, { ...payload, source: 'member' })
})
// 物资采购与库存：财务流水（采购付款/退货/报损/盘亏）
initProcurementContext({ logFinance })
// 园区联营商户结算：注入库存/退货/批次成本与财务流水，接线销售分账、库存消耗与结算
initPartnerContext({
  logFinance,
  applyVendorSales: (vendorId, qty) => applyVendorSales(vendorId, qty, { partner: true }),
  reserveVendorStock: (vendorId, qty) => reserveVendorStock(vendorId, qty, { partner: true }),
  customerReturn: (vendorId, qty, opts) => customerReturn(vendorId, qty, { ...opts, partner: true }),
  partnerCogs: (vendorId, from, to) => partnerCogs(vendorId, from, to),
  autoLinkVendor: (vendorId, type) => autoLinkVendor(vendorId, type)
})
// 设施域服务：时钟 / 现金 / 财务流水（升级扣款与流水同事务原子提交）
initRideContext({ logFinance })
// 权益转赠与家庭账户：撤回已用于在途预约的转赠权益时，同事务园方原因取消预约
// （refundReservation 内层 tx 并入外层事务；全额退款、释放名额，会员侧积分回退/券返还联动作用于受赠人）
initGiftContext({
  cancelReservationPark: (reservationId, note) => refundReservation(reservationId, 'park', note)
})
// 预约 ↔ 会员双向联动：预约侧注入会员报价/下单/退款回调；会员侧绑定会员模拟下单入口
initReservationContext({
  quoteReservation: (...args) => memberQuote(...args),
  onReservationBooked: (...args) => onReservationBooked(...args),
  onReservationRefunded: (...args) => onReservationRefunded(...args)
})
bindReservationAutoBook((slot, payload) => autoBookMember(slot, payload))

// 领队组团模块共享：时钟 / 现金 / 财务流水 / 投诉建单
initGroupContext({
  logFinance,
  createComplaint: (payload) => createComplaint(payload)
})
// 预约停运联动 → 团行程重排/退款（同一事务内执行）；主事务异常回滚后团行程挂入统一补偿队列重试
initReservationContext({
  handleParkOutageGroup: (rows, info) => handleParkOutageGroupRows(rows, info),
  handleParkOutageGroupFailed: (rows, info) => enqueueGroupOutageCompensations(rows, info),
  // 全园封控（特别重大安全事件未复园）：新生成的未来入园时段默认关闭，防止封控期被下单
  isParkClosed: () => db.prepare("SELECT COUNT(*) n FROM incidents WHERE severity=4 AND status IN ('graded','contained','evacuating','controlled')").get().n > 0
})

// 统一可恢复补偿队列：设施停运后的预约退款 / 团队行程 / 联营（召回）退款统一排队重试，
// 每个任务独立事务同步现金·库存·投诉·账单四个口径；处理器幂等，人工处理后不重复扣款/退款。
initCompensationContext({
  day: () => state.day(),
  hour: () => state.hour(),
  tick: () => state.tick()
})

// 统一客流预测与资源调度闭环：库存/团单在事务提交后刷新统一预测快照，并按动态模式触发调度重排
initFlowContext({
  dispatchAfter: (reason) => maybeDispatchAfter(reason)
})
// 启动即生成首版未来三天统一预测快照（闭环看板/排班需求画像的事实源）
try { refreshForecastSnapshots() } catch (e) { console.error('[flow] 初始预测快照失败:', e) }

// 园区应急指挥：安全事件 发现→分级→封控→疏散→复园→复盘
// 复用设施停运/预约退款联动、投诉建单与闭环、排班在岗校验与应急岗位动态调度、财务流水
initEmergencyContext({
  logFinance,
  syncRideSlots: (ride) => syncRideSlots(ride),
  closeEntrySlots: () => emergencyCloseEntrySlots(),
  reopenEntrySlots: () => emergencyReopenEntrySlots(),
  createComplaint: (payload) => createComplaint(payload),
  closeComplaintLinked: (cid, inc, kind, meta) => closeLinkedComplaint(cid, inc, kind, meta),
  staffDutyState: (staffId) => staffDutyState(staffId),
  dispatchAfter: (reason) => { try { maybeDispatchAfter(reason) } catch { /* 调度失败不阻塞应急流程 */ } }
})

// 供应商批次召回：注入时钟/现金/财务、投诉建单与召回闭环、联营红冲与联营判定
// 投诉联动：发起召回自动建餐饮质量投诉；结案/误报/撤销时把该投诉随召回闭环（退款赔付已在召回侧完成）
initRecallContext({
  day: () => state.day(),
  hour: () => state.hour(),
  tick: () => state.tick(),
  deductCash: (amount) => setSetting('cash', Math.round(state.cash() - amount)),
  addCash: (amount) => setSetting('cash', Math.round(state.cash() + amount)),
  logFinance: (day, label, amount, detail) => logFinance(day, label, amount, detail),
  createComplaint: (payload) => createComplaint(payload),
  closeComplaint: (cid, kind, meta) => {
    if (kind === 'recall_closed') {
      db.prepare(`UPDATE complaints SET status='closed_resolved', compensation='cash', comp_cost=?,
                  rating=4, close_reason=?, closed_tick=?, closed_day=? WHERE id=?`)
        .run(meta.compensation || meta.refund || 0,
             `供应商批次召回 ${meta.recallCode || ''} 已完成隔离、退货退款与赔付，投诉随召回闭环`,
             state.tick(), state.day(), cid)
      logComplaint(cid, 'resolve', `关联供应商批次召回 ${meta.recallCode || ''} 闭环：游客退款 ¥${meta.refund || 0}、供应商赔付 ¥${meta.compensation || 0}，投诉结案`)
    } else {
      // recall_false：误报/撤销，批次复检合格，中性结案（不补偿现金、不触发差评）
      db.prepare(`UPDATE complaints SET status='closed_force', close_reason=?, closed_tick=?, closed_day=? WHERE id=?`)
        .run(`供应商批次召回 ${meta.recallCode || ''} 经核实批次合格（${meta.note || '误报/已撤销'}），现场无质量问题`,
             state.tick(), state.day(), cid)
      logComplaint(cid, 'force', `关联召回 ${meta.recallCode || ''} 为误报/已撤销，投诉中性闭环`)
    }
  },
  organicPartnerReturn: (vendorId, qty, opts) => organicReturn(vendorId, qty, opts),
  isPartnerVendor: (vendorId) => isPartnerVendor(vendorId)
})

// ---------------- 分期贷款 ----------------
const activeLoans = () => db.prepare("SELECT * FROM loans WHERE status='active' ORDER BY id").all()

// 未偿本金合计（剩余本金，不含利息）
function loanDebt() {
  return activeLoans().reduce((s, l) => s + l.remain_principal, 0)
}

// 贷款汇总：剩余本金、挂账(逾期)金额、逾期贷款数
function debtSummary() {
  const ls = activeLoans()
  return {
    remainPrincipal: ls.reduce((s, l) => s + l.remain_principal, 0),
    arrears: ls.reduce((s, l) => s + l.arrears_p + l.arrears_i, 0),
    overdueCount: ls.filter(l => l.arrears_p + l.arrears_i > 0).length
  }
}

// 等额本息每期应还（末期靠尾款兜底，保证正好还清）
function calcInstallment(principal, rate, periods) {
  if (!rate) return Math.round(principal / periods)
  const pay = principal * rate * Math.pow(1 + rate, periods) / (Math.pow(1 + rate, periods) - 1)
  return Math.round(pay)
}

// 日结扣款（每天 1 期）；cash 为入参形式，返回 { cash, overdueHits, overdueIds }
function settleLoans(cash, day) {
  let overdueHits = 0
  const overdueIds = []
  for (const l of activeLoans()) {
    let dueP = 0, dueI = 0
    if (l.arrears_p + l.arrears_i > 0) {
      // 有逾期挂账：按挂账总额每日加罚息，先清欠账，不顺延新一期
      const penalty = Math.round((l.arrears_p + l.arrears_i) * OVERDUE_PENALTY)
      dueP = l.arrears_p
      dueI = l.arrears_i + penalty
    } else if (l.paid_periods < l.periods) {
      // 正常到期：末期收剩余本金 + 当期利息
      dueI = Math.round(l.remain_principal * l.rate)
      dueP = l.paid_periods + 1 >= l.periods
        ? l.remain_principal
        : Math.min(l.installment - dueI, l.remain_principal)
    } else continue

    const due = dueP + dueI
    const wasOverdue = (l.arrears_p + l.arrears_i) > 0
    if (cash >= due) {
      // 足额还款
      cash -= due
      if (dueI > 0) logFinance(day, '利息', -dueI, `贷款 #${l.id} 第${l.paid_periods + 1}期利息${wasOverdue ? '(含罚息)' : ''}`)
      if (dueP > 0) logFinance(day, '贷款', -dueP, `偿还贷款 #${l.id} 第${l.paid_periods + 1}期本金`)
      const remainPrincipal = Math.max(0, l.remain_principal - dueP)
      const paidPeriods = wasOverdue ? l.paid_periods : l.paid_periods + 1
      // 逾期补缴可能使本金先于期数归零，本金还清即结清
      const finished = remainPrincipal <= 0
      const upd = finished
        ? db.prepare("UPDATE loans SET remain_principal=?, paid_periods=?, arrears_p=0, arrears_i=0, status='done' WHERE id=?")
        : db.prepare('UPDATE loans SET remain_principal=?, paid_periods=?, arrears_p=0, arrears_i=0 WHERE id=?')
      upd.run(remainPrincipal, paidPeriods, l.id)
    } else {
      // 现金不足：按 利息(含罚息) → 本金 的顺序部分偿还，余额挂账并转逾期
      let avail = Math.max(0, cash)
      const payI = Math.min(dueI, avail)
      avail -= payI
      const payP = Math.min(dueP, avail)
      avail -= payP
      cash -= payI + payP
      if (payI > 0) logFinance(day, '利息', -Math.round(payI), `贷款 #${l.id} 部分付息(现金不足)`)
      if (payP > 0) logFinance(day, '贷款', -Math.round(payP), `贷款 #${l.id} 部分还本(现金不足)`)
      const leftI = dueI - payI
      const leftP = dueP - payP
      db.prepare('UPDATE loans SET remain_principal=?, arrears_p=?, arrears_i=?, overdue_days=overdue_days+1 WHERE id=?')
        .run(Math.max(0, l.remain_principal - payP), Math.round(leftP), Math.round(leftI), l.id)
      overdueHits += 1
      overdueIds.push(l.id)
    }
  }
  return { cash, overdueHits, overdueIds }
}

// ---------------- 游客投诉与服务补救 ----------------
// 投诉处置时限（游戏小时）：一般 8h / 严重 5h / 紧急 3h；升级后按新等级重置时限
const SEV_SLA = { 1: 8, 2: 5, 3: 3 }
const SEV_NAMES = { 1: '一般', 2: '严重', 3: '紧急' }
const OPEN_COMPLAINT_STATUSES = ['open', 'processing', 'ready']

const COMPLAINT_CATS = {
  queue:    { name: '排队秩序', icon: '⏳', roles: ['保安', '安保'] },
  hygiene:  { name: '环境卫生', icon: '🧹', roles: ['保洁'] },
  facility: { name: '设施故障', icon: '🛠️', roles: ['维修'] },
  safety:   { name: '安全隐患', icon: '🚨', roles: ['保安', '安保'] },
  food:     { name: '餐饮质量', icon: '🍔', roles: ['保洁'] },
  service:  { name: '服务态度', icon: '💁', roles: [] },      // 无专属岗位，任何员工均可受理
  pricing:  { name: '价格争议', icon: '💰', roles: [] },
  missing:  { name: '物品遗失', icon: '🎒', roles: ['保安', '安保'] }
}

const COMPLAINT_TPL = {
  queue: ['排队两小时游玩五分钟，队伍完全没人疏导！', '快速通道和普通队混在一起，秩序混乱。', '大热天排队区没有遮阳和饮水，太遭罪了。'],
  hygiene: ['卫生间又脏又臭，垃圾桶都溢出来了。', '休息区长椅上全是食物残渣，没人打扫。', '地面黏糊糊的，孩子差点滑倒。'],
  facility: ['设施运行时异响很大，坐着心里发慌。', '排到了却临时停运，白等一个多小时。', '安全压杠松动，工作人员也不仔细检查。'],
  safety: ['人流挤在一起没有保安疏导，感觉要出踩踏事故。', '护栏间隙太大，小孩能钻过去，太危险。', '夜间照明不足，台阶处差点摔倒。'],
  food: ['餐食是凉的，而且吃出异物，要求给个说法！', '饮料淡得像白水，价格还贵得离谱。', '吃完园内餐食后肚子不舒服。'],
  service: ['工作人员态度恶劣，问个路都不耐烦。', '检票员当众呵斥游客，体验极差。', '咨询台没人值守，等了半天没人理。'],
  pricing: ['园内物价是外面三倍，标价也不醒目。', '买了联票却多项设施另收费，涉嫌误导。', '纪念品结账价格和标签不一致。'],
  missing: ['孩子在园区走失半小时，广播寻人不及时。', '随身包在寄存处丢失，园方互相推诿。', '手机落在设施上，工作人员不配合查找。']
}

// 补偿方案：score 决定游客满意度，ticket 成本随当日票价浮动；points 为会员积分补偿（0 现金成本）
const COMP_OPTIONS = {
  apology:  { name: '真诚道歉', cost: 0,    score: 6 },
  ticket:   { name: '赠门票',   cost: 0,    score: 14 },
  fastpass: { name: '快速通行券', cost: 150, score: 20 },
  voucher:  { name: '消费券',   cost: 300,  score: 26 },
  cash:     { name: '现金补偿', cost: 600,  score: 34 },
  points:   { name: '会员积分', cost: 0,    score: 22, memberOnly: true }
}

function logComplaint(cid, action, note, staffId = null) {
  db.prepare('INSERT INTO complaint_logs(complaint_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(cid, state.tick(), state.day(), state.hour(), action, note || '', staffId)
}

function createComplaint({ category, severity, title, content, target, source, memberId = null }) {
  const cat = COMPLAINT_CATS[category] ? category : 'service'
  const sev = Math.max(1, Math.min(3, Math.round(severity || 1)))
  const r = db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source,member_id)
                        VALUES(?,?,?,?,?,?,?,?,?,'open',?,?,?)`)
    .run('', state.tick(), state.day(), cat, sev, title, content || '', target?.type || '', target?.id ?? null,
         state.tick() + SEV_SLA[sev], source || 'guest', memberId ?? null)
  const id = Number(r.lastInsertRowid)
  const code = 'TS' + String(id).padStart(4, '0')
  db.prepare('UPDATE complaints SET code=? WHERE id=?').run(code, id)
  logComplaint(id, 'submit', source === 'manual' ? '前台登记游客反馈' : '游客通过客服热线提交投诉')
  // 动态调度联动：新增投诉产生岗位需求，自动为未来班段补齐匹配排班（紧急缺口转加班调令待审批）
  try { maybeDispatchAfter(`新投诉${code}岗位需求`) } catch { /* 调度失败不阻塞建单 */ }
  return { id, code }
}

function pickComplaintTarget(cat, rides, vendors, zones) {
  const none = { type: '', id: null, name: '' }
  const pick = arr => arr[Math.floor(Math.random() * arr.length)]
  const openZoneIds = new Set(zones.filter(z => z.unlocked && z.open).map(z => z.id))
  if (cat === 'queue' || cat === 'facility') {
    const inPark = rides.filter(r => openZoneIds.has(r.zone_id))
    const pool = cat === 'queue'
      ? inPark.filter(r => r.queue > r.capacity * 2)
      : inPark.filter(r => r.health < 60)
    const r = pick(pool.length ? pool : inPark)
    return r ? { type: 'ride', id: r.id, name: r.name } : none
  }
  if (cat === 'hygiene') {
    const openZones = zones.filter(z => z.unlocked && z.open)
    const dirty = openZones.filter(z => z.cleanliness < 60)
    const z = pick(dirty.length ? dirty : openZones)
    return z ? { type: 'zone', id: z.id, name: z.name } : none
  }
  if (cat === 'food' || cat === 'pricing') {
    const inPark = vendors.filter(v => openZoneIds.has(v.zone_id))
    const pool = cat === 'food' ? inPark.filter(v => v.type !== '纪念品') : inPark
    const v = pick(pool.length ? pool : inPark)
    return v ? { type: 'vendor', id: v.id, name: v.name } : none
  }
  return none
}

// 每小时根据园区运营状况随机生成投诉（游客反馈入口）
function maybeSpawnComplaints(entering, satisfaction) {
  const openCount = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN ('open','processing','ready')").get().n
  if (openCount >= 15) return
  const rides = allRides()
  const ops = operatingRides()
  const zones = allZones()
  const longQueue = ops.filter(r => r.queue > r.capacity * 4).length
  const broken = rides.filter(r => r.status === 'maintenance').length
  const avgClean = zones.length ? zones.reduce((s, z) => s + z.cleanliness, 0) / zones.length : 70
  const protest = allEvents.actives().some(e => e.type === 'protest')
  const staffCount = allStaff().filter(s => s.active).length
  const chance = 0.10
    + longQueue * 0.05
    + broken * 0.05
    + Math.max(0, 60 - avgClean) * 0.004
    + Math.min(0.12, entering / 6000)
    + (protest ? 0.18 : 0)
    + (staffCount < 3 ? 0.06 : 0)
    + (satisfaction < 55 ? 0.06 : 0)
  if (Math.random() >= chance) return

  // 按当前园区状况加权选择投诉类别
  const weights = [
    ['queue', 1 + longQueue * 2.5],
    ['hygiene', 1 + Math.max(0, 60 - avgClean) / 6],
    ['facility', 1 + broken * 2.5],
    ['safety', protest ? 3 : 0.6],
    ['food', 1],
    ['service', staffCount < 4 ? 2.2 : 1],
    ['pricing', state.ticket() > 160 ? 2 : 0.8],
    ['missing', 0.5]
  ]
  const totalW = weights.reduce((s, w) => s + w[1], 0)
  let roll = Math.random() * totalW, category = 'service'
  for (const [k, w] of weights) { roll -= w; if (roll <= 0) { category = k; break } }

  // 严重度：安全类更可能升级
  const sr = Math.random()
  const severity = category === 'safety'
    ? (sr < 0.18 ? 3 : sr < 0.55 ? 2 : 1)
    : (sr < 0.07 ? 3 : sr < 0.30 ? 2 : 1)

  const target = pickComplaintTarget(category, rides, allVendors(), zones)
  const tpls = COMPLAINT_TPL[category]
  const content = tpls[Math.floor(Math.random() * tpls.length)]
  const title = `${COMPLAINT_CATS[category].name}投诉 · ${target.name || '园区整体'}`
  createComplaint({ category, severity, title, content, target, source: 'guest' })
}

// 紧急投诉超时未处置：游客公开差评，声誉/口碑受损
function timeoutCloseComplaint(c) {
  db.prepare(`UPDATE complaints SET status='closed_timeout', close_reason='限时内未处置，游客愤而离场并公开差评', closed_tick=?, closed_day=? WHERE id=?`)
    .run(state.tick(), state.day(), c.id)
  logComplaint(c.id, 'timeout', '紧急投诉超时未处置，游客公开差评')
  const wom = Math.max(-10, state.wordOfMouth() - 2)
  setSetting('wordOfMouth', Math.round(wom * 10) / 10)
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), state.day(), 'complaint', '投诉超时引发差评', `「${c.title}」未在限时内处置，游客在社交平台公开差评，口碑受损。`, -2, 'active')
  return 6
}

// 投诉处置主循环：受理中推进进度；超时自动升级或结案；待确认补偿久置自动致歉结案。返回本时段声誉扣分
function processComplaints() {
  const tick = state.tick()
  let repPenalty = 0
  const open = db.prepare("SELECT * FROM complaints WHERE status IN ('open','processing','ready')").all()
  const upd = db.prepare('UPDATE complaints SET status=?, progress=?, deadline_tick=?, severity=?, escalated=?, escalations=?, resolved_tick=? WHERE id=?')
  for (const c of open) {
    if (c.status === 'ready') {
      if (tick - (c.resolved_tick || c.tick) >= 6) {
        doResolveComplaint(c.id, 'apology', true)
      }
      continue
    }
    if (tick > c.deadline_tick) {
      if (c.severity < 3) {
        // 限时未处置：自动升级一级，时限重置，声誉受损
        const sev = c.severity + 1
        upd.run(c.status, c.progress, tick + SEV_SLA[sev], sev, 1, c.escalations + 1, c.resolved_tick, c.id)
        logComplaint(c.id, 'auto_escalate', `超过限时未处置，自动升级为「${SEV_NAMES[sev]}」`)
        repPenalty += sev * 1.2
      } else {
        repPenalty += timeoutCloseComplaint(c)
      }
      continue
    }
    if (c.status === 'processing') {
      const st = c.assignee_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(c.assignee_id) : null
      if (!st || !st.active) {
        upd.run('open', c.progress, c.deadline_tick, c.severity, c.escalated, c.escalations, c.resolved_tick, c.id)
        logComplaint(c.id, 'unassign', '受理员工离岗，投诉退回待受理')
        continue
      }
      // 排班在岗门控：当日有排班但当前不在班（未打卡/已下班）→ 处置挂起不推进，到班继续；当日无排班则退回待受理
      const duty = staffDutyState(st.id)
      if (!duty.scheduled) {
        upd.run('open', c.progress, c.deadline_tick, c.severity, c.escalated, c.escalations, c.resolved_tick, c.id)
        logComplaint(c.id, 'unassign', `${st.name} 当日无排班，投诉退回待受理`)
        continue
      }
      if (!duty.onDuty) continue
      const meta = COMPLAINT_CATS[c.category] || COMPLAINT_CATS.service
      const match = !meta.roles.length || meta.roles.includes(st.role)
      const rate = (8 + st.skill * 5 + st.morale / 12) * (match ? 1.5 : 1)
      const progress = c.progress + rate
      if (progress >= 100) {
        upd.run('ready', 100, c.deadline_tick, c.severity, c.escalated, c.escalations, tick, c.id)
        logComplaint(c.id, 'ready', `${st.name} 完成现场处置，等待补偿确认`, st.id)
      } else {
        upd.run('processing', Math.round(progress * 10) / 10, c.deadline_tick, c.severity, c.escalated, c.escalations, c.resolved_tick, c.id)
      }
    }
  }
  return repPenalty
}

// 补偿结案：依据处置质量、补偿档次、等待时长与升级记录计算游客评价，回流声誉/口碑/员工满意度
function doResolveComplaint(id, compKey, auto = false) {
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c) return { ok: false, msg: '投诉不存在' }
  if (c.status !== 'ready') return { ok: false, msg: '需先指派员工完成现场处置' }
  const opt = COMP_OPTIONS[compKey] || COMP_OPTIONS.apology
  // 会员积分补偿：仅会员本人投诉可用，0 现金成本，积分由会员中心发放并留痕
  if (compKey === 'points') {
    if (!c.member_id) return { ok: false, msg: '积分补偿仅对会员本人投诉生效，请改选其他补偿方案' }
    const m = db.prepare('SELECT id,status FROM members WHERE id=?').get(c.member_id)
    if (!m) return { ok: false, msg: '会员档案不存在，无法发放积分补偿' }
    if (m.status === 'frozen') return { ok: false, msg: '该会员账户已冻结，暂不可发放积分，请解冻后结案' }
  }
  const cost = compKey === 'ticket' ? state.ticket() : opt.cost
  let cash = state.cash()
  if (cash < cost) return { ok: false, msg: `资金不足，该补偿方案需 ¥${cost.toLocaleString()}` }

  const st = c.assignee_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(c.assignee_id) : null
  const meta = COMPLAINT_CATS[c.category] || COMPLAINT_CATS.service
  const match = st && (!meta.roles.length || meta.roles.includes(st.role))
  const quality = st ? Math.min(100, st.skill * 18 + st.morale * 0.4 + (match ? 15 : 0)) : 30
  const waited = Math.max(0, state.tick() - c.tick)
  let rating = 1.6 + quality / 30 + opt.score / 12 - (waited > 24 ? 0.6 : waited > 12 ? 0.3 : 0) - (c.escalated ? 0.3 : 0)
  rating = Math.max(1, Math.min(5, Math.round(rating)))

  cash -= cost
  setSetting('cash', Math.round(cash))
  const repGain = 1.2 + rating * 0.8 + c.severity * 0.4
  setSetting('reputation', Math.round(Math.max(5, Math.min(100, state.reputation() + repGain)) * 10) / 10)
  const wom = Math.max(-10, Math.min(10, state.wordOfMouth() + (rating - 3) * 0.8))
  setSetting('wordOfMouth', Math.round(wom * 10) / 10)
  if (st) db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.max(20, Math.min(100, st.morale + (rating >= 4 ? 4 : rating === 3 ? 1 : -3))), st.id)
  if (cost > 0) logFinance(state.day(), '补偿', -cost, `投诉 ${c.code}「${opt.name}」`)
  let pointsAwarded = 0
  if (compKey === 'points') {
    // 积分补偿在会员中心独立事务发放（失败不结案，前端可重试）
    const pr = compAwardPoints(c.member_id, num(getSetting('pointsComp'), 300), c.id, { staffId: st?.id ?? null })
    if (!pr.ok) return { ok: false, msg: pr.msg || '积分补偿发放失败，请稍后重试' }
    pointsAwarded = pr.points
  }

  db.prepare(`UPDATE complaints SET status='closed_resolved', compensation=?, comp_cost=?, rating=?, close_reason=?, closed_tick=?, closed_day=? WHERE id=?`)
    .run(compKey, cost, rating, auto ? '超时未确认补偿，系统自动以真诚道歉结案' : '补偿方案确认，游客满意离园', state.tick(), state.day(), id)
  logComplaint(id, 'resolve', `${auto ? '系统自动' : '确认'}补偿「${opt.name}」${cost ? `，支出 ¥${cost}` : ''}${pointsAwarded ? `，发放 ${pointsAwarded} 积分` : ''}，游客评价 ${rating} 星`, st?.id ?? null)
  // 完工回写排班工时模块：当值受理员工本班满意度 +2（结算时落士气与工资）
  if (st) writeWorkCompletion(st.id, 'complaint', { code: c.code })
  // 联营联动：现金补偿结案且责任在联营商户时，按严重度罚没商户待结算款（园区收回补偿成本）
  // 幂等：同一投诉已生成过罚没则不重复（结案更新已落库，仅补偿后置环节失败重试时保护）
  let partnerFine = null
  if (cost > 0) {
    const dupFine = db.prepare('SELECT id FROM partner_fines WHERE complaint_id=?').get(id)
    if (!dupFine) {
      try { partnerFine = levyComplaintFine({ ...c, comp_cost: cost }) } catch (e) { console.error('[partners] 投诉罚没失败:', e) }
      if (partnerFine) logComplaint(id, 'resolve', `联营商户责任，按严重度罚没待结算款 ¥${partnerFine.amount}`, st?.id ?? null)
    }
  }
  return { ok: true, rating, cost, points: pointsAwarded, partnerFine }
}

// 不予补偿直接结案：游客不满，声誉与口碑受损
function forceCloseComplaint(id) {
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c || !OPEN_COMPLAINT_STATUSES.includes(c.status)) return { ok: false, msg: '投诉不存在或已结案' }
  db.prepare(`UPDATE complaints SET status='closed_force', close_reason='园方未予补偿，游客不满离去', closed_tick=?, closed_day=? WHERE id=?`)
    .run(state.tick(), state.day(), id)
  logComplaint(id, 'force', '园方未予补偿直接结案，游客不满')
  setSetting('reputation', Math.round(Math.max(5, state.reputation() - (2 + c.severity)) * 10) / 10)
  const wom = Math.max(-10, state.wordOfMouth() - 1)
  setSetting('wordOfMouth', Math.round(wom * 10) / 10)
  return { ok: true }
}

// 应急模块联动：事件复盘/误报关闭、理赔赔付/驳回时，把关联安全投诉做无争议闭环
// kind: event_review 事件复盘（正向关闭，不补偿现金，补偿已在理赔/应急侧完成）/
//       event_false 误报关闭 / claim_paid 理赔已赔付（视同现金补偿结案）/ claim_rejected 理赔驳回
function closeLinkedComplaint(cid, inc, kind = 'event_review', meta = {}) {
  if (!cid) return
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(cid)
  if (!c || !OPEN_COMPLAINT_STATUSES.includes(c.status)) return
  if (kind === 'claim_paid') {
    db.prepare(`UPDATE complaints SET status='closed_resolved', compensation='cash', comp_cost=?,
                rating=4, close_reason=?, closed_tick=?, closed_day=? WHERE id=?`)
      .run(meta.amount || 0, `安全事件理赔 ${meta.claimCode || ''} 已现金赔付，投诉随事件处置闭环`, state.tick(), state.day(), cid)
    logComplaint(cid, 'resolve', `关联安全事件理赔 ${meta.claimCode || ''} 已赔付 ¥${meta.amount || 0}，投诉闭环`)
  } else if (kind === 'event_review') {
    db.prepare(`UPDATE complaints SET status='closed_resolved', compensation='apology', comp_cost=0,
                rating=4, close_reason=?, closed_tick=?, closed_day=? WHERE id=?`)
      .run('关联安全事件已完成应急处置并复盘结案，现场安全已恢复', state.tick(), state.day(), cid)
    logComplaint(cid, 'resolve', `关联安全事件 ${inc?.code || ''} 复盘结案，投诉随应急处置闭环`)
  } else {
    // 误报关闭 / 理赔驳回：园方已核实处置，做中性结案（不触发差评）
    const reason = kind === 'claim_rejected'
      ? `理赔 ${meta.claimCode || ''} 经核定不符合赔付范围${meta.note ? `：${meta.note}` : ''}，现场已处置`
      : '关联安全事件经核实为误报，现场无安全隐患'
    db.prepare(`UPDATE complaints SET status='closed_force', close_reason=?, closed_tick=?, closed_day=? WHERE id=?`)
      .run(reason, state.tick(), state.day(), cid)
    logComplaint(cid, 'force', reason)
  }
}

// 检修完工联动：维修工在现场可一并处置针对该设施的「设施故障」投诉
// 待受理的同设施设施类投诉由其接手并记 40% 处置进度；已由其本人推进的直接完成现场处置待补偿
function linkComplaintsToRide(rideId, staffId) {
  if (!staffId) return
  const st = db.prepare('SELECT * FROM staff WHERE id=?').get(staffId)
  if (!st || !st.active) return
  const rows = db.prepare(`SELECT * FROM complaints WHERE category='facility' AND target_type='ride' AND target_id=?
                           AND status IN ('open','processing')`).all(rideId)
  for (const c of rows) {
    if (c.status === 'processing' && c.assignee_id === staffId) {
      db.prepare('UPDATE complaints SET status=?, progress=100, resolved_tick=? WHERE id=?')
        .run('ready', state.tick(), c.id)
      logComplaint(c.id, 'ready', `${st.name} 随设施检修完工一并完成现场处置，等待补偿确认`, staffId)
    } else if (c.status === 'open') {
      db.prepare("UPDATE complaints SET status='processing', assignee_id=?, progress=40 WHERE id=?").run(staffId, c.id)
      logComplaint(c.id, 'assign', `设施检修完工，${st.name} 现场接手处置该故障投诉`, staffId)
    }
  }
}

function enrichComplaints(rows) {
  const tick = state.tick()
  const rides = allRides(), vendors = allVendors(), zones = allZones()
  const memberRows = db.prepare('SELECT id,code,name,card_tier FROM members').all()
  const memberMap = new Map(memberRows.map(m => [m.id, m]))
  return rows.map(c => {
    const st = c.assignee_id ? db.prepare('SELECT id,name,role,skill,morale FROM staff WHERE id=?').get(c.assignee_id) : null
    const target = c.target_type === 'ride' ? rides.find(r => r.id === c.target_id)
      : c.target_type === 'vendor' ? vendors.find(v => v.id === c.target_id)
      : c.target_type === 'zone' ? zones.find(z => z.id === c.target_id) : null
    const meta = COMPLAINT_CATS[c.category] || COMPLAINT_CATS.service
    const active = ['open', 'processing'].includes(c.status)
    const m = c.member_id ? memberMap.get(c.member_id) : null
    return {
      ...c,
      category_name: meta.name,
      category_icon: meta.icon,
      severity_name: SEV_NAMES[c.severity],
      remain_ticks: active ? c.deadline_tick - tick : 0,
      overdue: active && tick > c.deadline_tick,
      assignee_name: st?.name || '',
      assignee_role: st?.role || '',
      role_match: st ? (!meta.roles.length || meta.roles.includes(st.role)) : false,
      target_name: target?.name || '',
      member_code: m?.code || '',
      member_name: m?.name || '',
      member_tier: m?.card_tier || ''
    }
  })
}

function complaintStats() {
  const open = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN ('open','processing','ready')").get().n
  const overdue = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN ('open','processing') AND deadline_tick < ?").get(state.tick()).n
  const todayClosed = db.prepare('SELECT COUNT(*) n FROM complaints WHERE closed_day=?').get(state.day()).n
  const resolved = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status='closed_resolved'").get().n
  const total = db.prepare('SELECT COUNT(*) n FROM complaints').get().n
  const avgRating = db.prepare("SELECT AVG(rating) a FROM complaints WHERE status='closed_resolved' AND rating>0").get().a || 0
  const compTotal = db.prepare("SELECT COALESCE(SUM(comp_cost),0) s FROM complaints WHERE status='closed_resolved'").get().s || 0
  return { open, overdue, todayClosed, resolved, total, avgRating: Math.round(avgRating * 10) / 10, compTotal }
}

// ---------------- 游戏主循环 ----------------
function tick() {
  let day = state.day()
  let hour = state.hour() + 1
  let cash = state.cash()
  let rep = state.reputation()
  const ticket = state.ticket()
  const base = state.guestBase()

  let tickCount = state.tick() + 1
  setSetting('tick', tickCount)

  // 跨天结算
  let overdueHits = 0
  let overdueIds = []
  if (hour > OPEN_HOUR + HOURS_PER_DAY - 1) {
    hour = OPEN_HOUR
    // 日结工资：不再按在册员工发固定日薪，改为每张考勤单下班时按「基准工时+加班」逐条结算入财务流水
    // （含跨日夜班：次日 9:00 下班，结算计入次日）；这里只做闭园汇总与旷工预警事件
    const wageSummary = dayCloseSummary(day)
    if (wageSummary.settledCount > 0) {
      logFinance(day, '工资', 0, `排班工时结算汇总：${wageSummary.settledCount} 人下班/离岗结算，工资 ¥${wageSummary.totalPay}（逐条流水见当日考勤），加班 ${wageSummary.overtimeHours}h`)
    }
    if (wageSummary.absent > 0) {
      db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
        .run(state.tick(), day, 'staff', '员工旷工预警',
          `今日有 ${wageSummary.absent} 名排班员工未打卡上班，已按旷工处理（无薪并扣减满意度）。运营主管请核查排班覆盖与人员安排。`, -1, 'active')
    }
    // 日结租金：联营商铺按销售流水分账，不收固定租金（rent 签约时已置 0）；仅自营商铺收租
    const rent = allVendors().filter(v => !isPartnerVendor(v.id)).reduce((s, v) => s + v.rent, 0)
    cash -= rent
    logFinance(day, '租金', -rent, '当日自营商铺租金（联营按流水分账，不收租）')
    // 联营商户结算：账期到期自动生成结算账单（draft，不自动付款）；先补付历史挂账单
    try {
      const retry = retryOverdueSettlements()
      if (retry.count > 0) logFinance(day, '商户结算', -retry.paid, `补付 ${retry.count} 张联营挂账账单`)
      const issued = autoIssueSettlements(day)
      if (issued.length) {
        db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
          .run(state.tick(), day, 'partner', '联营账期结算单已生成',
            `${issued.length} 家联营商户账期到期，已自动生成结算账单，请在「联营商户」页核对并支付。`, 0, 'resolved')
      }
    } catch (e) { console.error('[partners] 日结联营出账失败:', e) }
    // 日结分期贷款：同步扣款；现金不足时按 利息→本金 部分偿还并转逾期挂账
    const settled = settleLoans(cash, day)
    cash = settled.cash
    overdueHits = settled.overdueHits
    overdueIds = settled.overdueIds
    // 会员卡到期日结扫描：过有效期等级降级为普通会员（积分/储值保留），记录状态流转
    const expiredCards = sweepExpiredCards(day + 1)
    if (expiredCards > 0) {
      db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
        .run(state.tick(), day, 'member', '会员卡集中到期',
          `日结扫描发现 ${expiredCards} 张会员卡已过有效期，已自动降级为普通会员（积分与储值余额保留）。会员专员可跟进续费转化。`, 0, 'resolved')
    }
    // 权益转赠日结扫描：超过领取有效期未领取的转赠自动回补捐赠人（积分/储值/券同口径返还）
    const expiredGifts = sweepExpiredGifts(day + 1)
    if (expiredGifts > 0) {
      db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
        .run(state.tick(), day, 'member', '转赠权益到期未领自动回补',
          `日结扫描发现 ${expiredGifts} 笔权益转赠超过领取有效期未被领取，已自动回补捐赠人（积分/储值/券按原口径返还，家庭共享池转赠同步处理）。`, 0, 'resolved')
    }
    day += 1
    setSetting('day', day)
    // 统一客流闭环：新一天首个 tick 对「刚结束的一天」回填实际客流、计算预测命中率并学习散客外推系数。
    // 此时昨日全部营业小时已结束、visitors 完整；幂等（快照已 settled 自动跳过）。
    try { settleForecastLearning(day - 1) } catch (e) { console.error('[flow] 预测学习失败:', e) }
  }
  setSetting('hour', hour)

  // ---- 分时预约闭环 ----
  ensureSlots()                       // 维护未来三天的入园/设施时段库存
  // 统一可恢复补偿队列（必须最先执行）：停运后的预约退款 / 团队行程 / 联营退款逐任务独立事务重试，
  // 成功才同步现金/库存/投诉/账单并释放名额；仍失败的保持挂起，不会被下面的爽约扫描误没收。
  const compRecovered = runCompensations()
  if (compRecovered.done > 0) {
    console.log(`[compensation] 统一补偿恢复 ${compRecovered.done} 个任务（${compRecovered.qty} 人/份，现金 ¥${compRecovered.cash}）；失败 ${compRecovered.failed}、待人工 ${compRecovered.manual}、剩余 ${compRecovered.remaining}`)
  }
  if (compRecovered.manual > 0) {
    const lastEvt = db.prepare("SELECT id FROM events WHERE type='compensation' AND day=? ORDER BY id DESC LIMIT 1").get(day)
    if (!lastEvt) {
      db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
        .run(tickCount, day, 'compensation', '停运补偿多次失败 · 待人工核对',
          `${compRecovered.manual} 个停运补偿任务（预约退款/团队行程/联营退款）自动重试多次未成功，已转入人工补偿队列。挂起期间预约保持待核销、不会按爽约没收，联营红冲不重复入账；请在「停运补偿」页核对现金/库存/账单后人工处理或再次重试。`,
          -1, 'active')
    }
  }
  // 异常恢复必须先于爽约扫描：超售退款事务失败的挂起单先尝试补退（内部驱动统一补偿队列），
  // 补退成功才释放名额/退现金，仍失败则保持 booked，且不会被下面的爽约扫描误没收
  const overbookRetry = retryPendingOverbookRefunds()
  if (overbookRetry.recovered > 0) {
    console.log(`[reservations] 超售补退恢复 ${overbookRetry.recovered} 单 / ${overbookRetry.qty} 人，退款 ¥${overbookRetry.amount}；剩余挂起 ${overbookRetry.remaining}`)
  }
  expireNoShow(hour)                  // 过时段未核销 → 爽约，预收款没收（挂起补退单除外）
  // 入园时段（9~18点）核销当前时段预约：容量内放行，超售自动改签/退款
  let reservedEntry = 0
  const reservedRiders = new Map()
  if (hour >= OPEN_HOUR && hour <= OPEN_HOUR + HOURS_PER_DAY - 1) {
    const arrival = autoCheckin(hour)
    reservedEntry = arrival.entry
    arrival.ride.forEach((qty, rid) => reservedRiders.set(rid, qty))
    // 新增挂起（退款事务失败）：预约保持待核销、未计入已安置/已退款，登记经营异常事件提醒人工跟进
    if (arrival.pendingNew > 0) {
      db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
        .run(tickCount, day, 'reservation', '超售退款事务失败 · 已挂起自动补退',
          `${arrival.pendingNew} 张超售预约退款事务执行失败，已整体回滚（现金未退、库存未释放、未计入已安置/退款），预约保持待核销并进入自动补退队列；系统每小时重试，期间不会按爽约没收预收款。财务与库存口径保持一致，请关注补退结果。`,
          -1, 'active')
    }
    // 领队组团：自动收尾款 + 到点分批/整团核销（入园优先），回写同一套客流与设施游玩量
    const groupArrival = autoGroupTick()
    reservedEntry += groupArrival.entry
    groupArrival.rides.forEach((qty, rid) =>
      reservedRiders.set(rid, (reservedRiders.get(rid) || 0) + qty))
  }
  // 模拟领队提交团队行程（低频，为明天自动确认锁定名额，订金即时入账）
  autoSimulateGroup()

  // 入园人数模型（散客侧：预约到场已计入实际客流，不再重复收取门票）
  const retail = hour <= 6 ? 0.5 : hour >= 16 ? 0.6 : 1   // 早晚人少
  const priceFactor = Math.max(0.2, 2.0 - ticket / 100)     // 价越高人越少
  const repFactor = 0.4 + rep / 100
  const zoneFactor = 1
  // 投诉补救口碑回流：每点口碑约影响 ±1.2% 客流
  const complaintFactor = Math.max(0.7, 1 + state.wordOfMouth() * 0.012)
  // 在途安全事件按最高等级折减散客客流（封控/疏散期间游客避险、到访下降）
  const emergencyFactor = activeCrowdFactor()
  // 分时预约已锁定部分客流：散客 = 自然需求；总入园 = 散客 + 预约核销到场
  const walkIn = Math.round(base * retail * priceFactor * repFactor * zoneFactor * complaintFactor * emergencyFactor * (0.85 + Math.random() * 0.3))
  const entering = walkIn + reservedEntry
  const satisfaction = computeSatisfaction(reservedEntry, entering)
  // 游客反馈：运营状况驱动随机投诉
  maybeSpawnComplaints(entering, satisfaction)
  const avgSpend = 40 + satisfaction / 5 + Math.random() * 15
  const spend = Math.round(entering * (avgSpend * 0.15 + ticket * 0.5)) // 门票为主的收入模型

  // 门票收入：仅散客现场购票；预约门票已在下单时预收
  const ticketRev = Math.round(walkIn * ticket)
  cash += ticketRev
  if (ticketRev > 0) logFinance(day, '门票', ticketRev, `散客入园 ${walkIn} 人·当日票`)

  const zones = allZones()
  // 游客在各开放的游玩区域分配
  const ops = operatingRides()
  const totalAttr = ops.reduce((s, r) => s + r.attr * (r.health / 100), 1)
  let rideIncome = 0
  const rideStmt = db.prepare('UPDATE rides SET queue=?, play_count=play_count+?, rev=rev+?, health=? WHERE id=?')
  const newRides = ops.map(r => {
    const share = (r.attr * (r.health / 100)) / totalAttr
    // 设施预约核销游客走快速通道：直接游玩、不排队，费用已在预约时预收
    const reserved = reservedRiders.get(r.id) || 0
    const organic = Math.max(0, Math.min(Math.round(walkIn * 1.6 * share), r.capacity * 6) - reserved)
    const riders = organic + reserved
    const income = Math.round(organic * r.price)
    rideIncome += income
    cash += income
    // 健康度随时间小幅衰减
    const decay = r.thrill > 80 ? 1.8 : r.thrill > 50 ? 1.1 : 0.7
    const health = Math.max(0, r.health - decay)
    const queue = Math.max(0, organic - r.capacity * 2) * 0.6
    rideStmt.run(Math.round(queue), riders, income, Math.round(health * 10) / 10, r.id)
    return { ...r, riders, income }
  }).filter(Boolean)
  if (rideIncome > 0) logFinance(day, '游乐', rideIncome, '散客游乐设施营收（预约已预收）')

  // 设施运行成本
  let runCost = 0
  ops.forEach(r => {
    if (r.status === 'operating') { runCost += r.run_cost; cash -= r.run_cost }
  })
  if (runCost > 0) logFinance(day, '运营', -runCost, '设施运行成本')

  // 清扫/安保维护 = 保洁保安数量相关；干净度随时间降低
  const cleaters = allStaff().filter(s => s.role === '保洁' && s.active).length
  const guards = allStaff().filter(s => s.role === '保安' && s.active).length
  for (const z of zones) {
    let c = z.cleanliness
    c -= 2.5
    if (cleaters > 0) c += 3.5 * Math.min(cleaters, 3)
    c = Math.max(5, Math.min(100, c))
    const scenery = z.scenery + (z.scenery < 60 ? 0.2 : 0)
    db.prepare('UPDATE zones SET cleanliness=? WHERE id=?').run(Math.round(c), z.id)
  }

  // 商铺营收：销售实时联动库存（FEFO 扣减，未挂物资的商铺不受限）；缺货部分记流失营收并触发预警
  const activeZoneIds = zones.filter(z => z.open).map(z => z.id)
  const vendors = allVendors().filter(v => activeZoneIds.includes(v.zone_id))
  const vStmt = db.prepare('UPDATE vendors SET sold=sold+?, rev=rev+? WHERE id=?')
  let vendorIncome = 0
  for (const v of vendors) {
    const zone = zones.find(z => z.id === v.zone_id)
    const zFlow = (zone ? zone.capacity : 150) * (satisfaction / 100)
    const demand = Math.round(Math.min(zFlow / 8, entering / 6) * (0.8 + Math.random() * 0.4))
    const partnerContract = isPartnerVendor(v) ? activePartnerContract(v.id) : null
    if (partnerContract) {
      // 联营商铺：销售扣库存（partner_sale 批次成本随结算扣收）+ 按销售流水分账，与现金/库存同事务
      tx(() => {
        // applyVendorSales 内部嵌套事务并入外层；联营模式打标扣减
        const cap = applyVendorSales(v.id, demand, { partner: true })
        if (cap.sold <= 0) return
        const gross = Math.round(cap.sold * v.price)
        // 散客无会员优惠：账单额=牌价；园方代收全额现金，扣点归园方、余额为对商户负债（结算时支付）
        partnerRecordSale(v.id, { qty: cap.sold, gross, bill: gross, source: 'organic', note: '散客 tick 销售' })
        cash += gross
        vendorIncome += gross
        vStmt.run(cap.sold, gross, v.id)
      })
    } else {
      // 自营商铺：applyVendorSales 内部事务扣减批次库存；库存不足时 sold 截断为可售量，lost 记缺货流失
      const cap = applyVendorSales(v.id, demand)
      const sold = cap.sold
      const income = Math.round(sold * v.price * v.margin)
      vendorIncome += income
      cash += income
      vStmt.run(sold, income, v.id)
    }
  }
  if (vendorIncome > 0) logFinance(day, '商业', vendorIncome, '商铺营收（含联营代收）')

  // 需求侧：模拟游客为未来三天的入园/设施时段下单预约（预收款即入账）
  autoBookDemand(allRides(), base, priceFactor, repFactor * complaintFactor)

  // 会员经济：会员按卡等级折扣自助预约（复用预约事务/库存一致性）、商铺储值/券消费、散客办卡转化
  autoMemberEconomy({ rides: ops, vendors })

  // 员工满意度
  const sm = db.prepare('UPDATE staff SET morale=? WHERE id=?')
  allStaff().forEach(s => {
    if (!s.active) return
    let m = s.morale + (s.wage > 360 ? 1.2 : -0.3) + (Math.random() * 1 - 0.5)
    m = Math.max(20, Math.min(100, m))
    sm.run(Math.round(m), s.id)
  })

  // 事件影响
  const es = allEvents.actives()
  let eventRepShift = 0
  for (const e of es) {
    if (e.impact && e.status === 'active') eventRepShift += (e.impact > 0 ? 0.8 : -1.6)
  }

  // 排班与工时结算：自动排班、到点打卡、出勤工时累计、下班结算入工资财务（跨日夜班次日结算）
  // 必须先于投诉/检修推进：本小时开始即打卡在岗，后续派工推进的在岗校验才放行
  processScheduling()

  // 投诉处置：推进受理进度，超时自动升级 / 公开差评，返回本时段声誉扣分
  const complaintPenalty = processComplaints()

  // 设施检修工单：维修员工接单后按游戏时间推进，离岗退回排队，完工恢复运营并结算费用
  processMaintenance()

  // 园区应急指挥：上报后久未分级自动核定、超封控时限未控场自动升级（返回声誉扣分）
  const emergencyPenalty = processIncidents()

  // 物资采购与库存：缺货自动补货草稿、已批准采购单自动到货、批次过期报损、缺货/临期/逾期应付巡检
  processProcurementTick()
  // 在途重大事件持续侵蚀声誉（游客对园区安全失去信心）
  const severeOpen = db.prepare(`SELECT COUNT(*) n FROM incidents
    WHERE status IN ('graded','contained','evacuating','controlled') AND severity>=3`).get().n
  const emergencyDrag = severeOpen * 0.8 + (emergencyPenalty || 0)

  // 声誉演化：满意度+事件+预算健康度+超时投诉+在途安全事件
  const budgetHealth = cash > 0 ? Math.min(1, cash / 200000) : -0.4
  rep = Math.max(5, Math.min(100, rep + (satisfaction - 70) * 0.15 + budgetHealth * 2 + eventRepShift - complaintPenalty - emergencyDrag))

  // 贷款逾期：信用受损（本次日结新产生的逾期，每条 -1.5 声誉）
  if (overdueHits > 0) {
    rep = Math.max(5, rep - 1.5 * overdueHits)
    const ids = overdueIds.join('、#')
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(tickCount, day, 'overdue', '贷款还款逾期', `日结时现金不足以偿还分期贷款 #${ids}，欠款已挂账并按日计 2% 罚息，后续日结将优先补扣。`, -2, 'active')
  }

  // 满意度驱动消费
  const eatSpend = Math.round(entering * avgSpend * 0.3)
  cash += eatSpend
  if (eatSpend > 0) logFinance(day, '消费', eatSpend, '园内消费')

  db.prepare('INSERT INTO visitors(tick,day,hour,count,satisfaction,eat,total_spend) VALUES(?,?,?,?,?,?,?)')
    .run(tickCount, day, hour, entering, Math.round(satisfaction * 10) / 10, Math.round(avgSpend * 10) / 10, Math.round(spend * 10) / 10)

  // 服务口碑自然回落，避免一次补偿永久加成
  const womNow = state.wordOfMouth()
  if (womNow !== 0) setSetting('wordOfMouth', Math.round(womNow * 0.98 * 100) / 100)

  setSetting('cash', Math.round(cash))
  setSetting('reputation', Math.round(rep * 10) / 10)

  // 随机事件
  maybeSpawnEvent(day)

  checkBrokenDown(day)

  // 园区应急指挥：低频模拟巡报安全事件（安保巡报，进入待分级）
  if (hour >= OPEN_HOUR && hour <= OPEN_HOUR + HOURS_PER_DAY - 1) {
    try {
      const spawned = maybeSpawnIncident()
      if (spawned?.ok) {
        db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
          .run(tickCount, day, 'emergency', '安保巡报安全事件',
            `应急指挥中心收到一条安全事件巡报（${spawned.code}），请运营值班主管立即核实并分级，组织封控与疏散。`, -2, 'active')
      }
    } catch (e) { console.error('[emergency] 模拟事件生成失败:', e) }
  }

  // 统一客流预测与资源调度闭环：每小时刷新未来三天预测快照（库存/团单变化后统一口径）
  try { refreshForecastSnapshots() } catch (e) { console.error('[flow] 预测快照刷新失败:', e) }
  // 闭环一致性巡检：库存计数器漂移自动自愈；资金/团账/跨日排班冲突只告警不擅改
  // 整点巡检落事件（与上次结果去重，避免刷屏）
  try {
    const rc = runReconcile({ autoHeal: true })
    if (rc.found > 0 && rc.blocks > 0) {
      const lastEvt = db.prepare("SELECT id FROM events WHERE type='reconcile' AND day=? ORDER BY id DESC LIMIT 1").get(day)
      if (!lastEvt) {
        db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
          .run(tickCount, day, 'reconcile', '闭环巡检发现排班/预约/财务口径异常',
            `本轮巡检发现 ${rc.found} 项偏差（严重 ${rc.blocks} 项，已自愈 ${rc.healed} 项）。计数器漂移已自动校正；资金/团账/跨日排班冲突需人工在「客流调度闭环」页核对处理。`,
            -1, 'active')
      }
    }
  } catch (e) { console.error('[flow] 闭环一致性巡检失败:', e) }

  // 权益转赠一致性巡检：锁定权益残留自动解锁；已领取转赠明细缺失仅告警待人工核对
  try {
    const gr = reconcileGifts()
    if (gr.healedCount > 0 || gr.findings.length) {
      tx(() => {
        for (const h of gr.healed) {
          db.prepare(`INSERT INTO reconcile_findings(code,kind,level,ref_type,ref_id,day,title,detail,expected,actual,status,tick,created_day,heal_tick)
                      VALUES(?,?, 'warn', 'member_benefit',NULL,?,?,?, '{}','{}', 'healed', ?, ?, ?)`)
            .run('', h.kind, day, h.title, h.detail, state.tick(), day, state.tick())
          const id = db.prepare('SELECT last_insert_rowid id FROM reconcile_findings').get().id
          db.prepare('UPDATE reconcile_findings SET code=? WHERE id=?').run('RC' + String(id).padStart(4, '0'), id)
        }
        for (const f of gr.findings) {
          const dup = db.prepare("SELECT id FROM reconcile_findings WHERE kind=? AND ref_id=? AND status='open'").get(f.kind, f.ref)
          if (dup) continue
          db.prepare(`INSERT INTO reconcile_findings(code,kind,level,ref_type,ref_id,day,title,detail,expected,actual,status,tick,created_day)
                      VALUES(?,?,?,?,?,?,?,?,?, '{}','{}','open',?,?)`)
            .run('', f.kind, f.level, 'gift', f.ref, day,
              `转赠单 #${f.gift} 明细与受赠权益不一致`,
              '已领取的转赠明细缺少受赠人权益记录，可能存在权益流失，请人工核对（系统不擅自改写权益）',
              state.tick(), day)
          const id = db.prepare('SELECT last_insert_rowid id FROM reconcile_findings').get().id
          db.prepare('UPDATE reconcile_findings SET code=? WHERE id=?').run('RC' + String(id).padStart(4, '0'), id)
        }
      })
    }
  } catch (e) { console.error('[gifts] 转赠一致性巡检失败:', e) }
}

function computeSatisfaction(reserved = 0, total = 0) {
  const zones = allZones()
  const avgClean = zones.length ? zones.reduce((s, z) => s + z.cleanliness, 0) / zones.length : 70
  const ops = operatingRides()
  const openRatio = (allRides().length ? ops.length / allRides().length : 1)
  let sat = 50
  sat += (avgClean - 60) * 0.5
  sat += openRatio * 35
  const longQueue = ops.filter(r => r.queue > r.capacity * 4).length
  sat -= longQueue * 3
  // 未结投诉持续拉低满意度（按严重度，上限 15），服务口碑小幅回流
  const drag = db.prepare("SELECT COALESCE(SUM(severity),0) s FROM complaints WHERE status IN ('open','processing','ready')").get().s
  sat -= Math.min(15, drag * 0.8)
  // 在途安全事件：封控/疏散期间现场游客体验显著下降（按最高等级，上限 18）
  const incRow = db.prepare(`SELECT MAX(severity) s, COUNT(*) n FROM incidents
    WHERE status IN ('graded','contained','evacuating','controlled') AND severity>=1`).get()
  if (incRow.s) sat -= Math.min(18, incRow.s * 4 + Math.min(6, incRow.n * 2))
  sat += Math.max(-10, Math.min(10, state.wordOfMouth())) * 0.5
  sat += state.reputation() * 0.2
  // 分时预约核销占比越高，入园/排队越有序，满意度小幅加成（上限 +4）
  if (total > 0) sat += Math.min(4, (reserved / total) * 8)
  return Math.max(10, Math.min(100, sat))
}

// ---------------- 事件系统 ----------------
const allEvents = {
  actives: () => db.prepare("SELECT * FROM events WHERE status='active'").all()
}

const EVENT_POOL = [
  { type: 'weather', title: '午后阵雨', desc: '降雨影响游客体验，入园客流下降，清洁压力增大。', impact: -1 },
  { type: 'crowd', title: '客流高峰', desc: '游客激增，设施队列变长，需增派保洁缓解拥挤。', impact: 1 },
  { type: 'fault', title: '设备故障隐患', desc: '一台高刺激设施发出异响，建议立即停运检修。', impact: -2 },
  { type: 'celebrity', title: '明星到访', desc: '知名艺人入园引发关注，声望提升，周边商铺客流大增。', impact: 2 },
  { type: 'protest', title: '排队投诉潮', desc: '游客因排队时间过长集中投诉。', impact: -2 },
  { type: 'fever', title: '节令热潮', desc: '季节主题推动消费，游客日均消费上升。', impact: 1 }
]

function maybeSpawnEvent(day) {
  if (Math.random() > 0.12) return
  const ev = EVENT_POOL[Math.floor(Math.random() * EVENT_POOL.length)]
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), day, ev.type, ev.title, ev.desc, ev.impact, 'active')
}

function checkBrokenDown(day) {
  // 健康度跌破红线：自动停运并生成检修工单（进入排队，待维修员工接单）
  // 停运联动在工单创建时完成（关停时段、在途预约园方全额退款、生成投诉）
  const bad = db.prepare("SELECT * FROM rides WHERE health<25 AND status='operating'").all()
  for (const r of bad) {
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(state.tick(), day, 'fault', '设备突发故障', `「${r.name}」健康度过低已自动停运，检修工单已进入维修队列，请尽快安排维修工接单。`, -1, 'active')
    createMaintenanceOrder(r.id, 'auto')
  }
}

// 兼容既有检修状态：为已停运检修但无在途工单的设施补建排队工单
backfillMaintenanceOrders()

// 启动循环
tick()
setInterval(tick, TICK_MS)

// ---------------- API ----------------
app.get('/api/state', (req, res) => {
  const rides = allRides().map(r => {
    const mo = db.prepare(`SELECT * FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing') ORDER BY id DESC LIMIT 1`).get(r.id)
    return mo ? { ...r, maint_order_id: mo.id, maint_status: mo.status } : r
  })
  const loadMap = staffLoad()
  const visitors = db.prepare('SELECT * FROM visitors ORDER BY id DESC LIMIT 60').all().reverse()
  const fin = db.prepare('SELECT * FROM finance ORDER BY id DESC LIMIT 80').all().reverse()
  const loans = activeLoans().map(l => {
    const arrears = l.arrears_p + l.arrears_i
    const nextI = l.paid_periods < l.periods ? Math.round(l.remain_principal * l.rate) : 0
    const nextP = l.paid_periods + 1 >= l.periods ? l.remain_principal : Math.min(l.installment - nextI, l.remain_principal)
    return {
      ...l,
      ratePct: Math.round(l.rate * 1000) / 10,
      arrears,
      nextDue: l.paid_periods < l.periods ? nextP + nextI : 0,
      nextPrincipal: nextP,
      nextInterest: nextI,
      over: arrears > 0
    }
  })
  return res.json({
    clock: { day: state.day(), hour: state.hour(), tick: state.tick() },
    cash: state.cash(),
    reputation: state.reputation(),
    ticket: state.ticket(),
    loan: loanDebt(),
    loans,
    debt: debtSummary(),
    loanChoices: { periods: LOAN_PERIOD_CHOICES, rates: LOAN_RATE_CHOICES.map(r => Math.round(r * 1000) / 10) },
    visitorToday: visitors.filter(v => v.day === state.day()).reduce((s, v) => s + v.count, 0),
    visitors,
    zones: allZones(),
    rides,
    vendors: allVendors(),
    staff: allStaff().map(s => ({ ...s, maint_load: loadMap.get(s.id) || 0 })),
    maintenanceOrders: listMaintenanceOrders({ limit: 100 }),
    maintenanceStats: maintenanceStats(),
    events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 40').all(),
    complaints: enrichComplaints(db.prepare('SELECT * FROM complaints ORDER BY id DESC LIMIT 60').all()),
    complaintStats: complaintStats(),
    wordOfMouth: state.wordOfMouth(),
    reservationStats: reservationStats(),
    entrySlots: listSlots({ scope: 'entry' }),
    reservations: listReservations({ limit: 100 }),
    // 领队组团
    groupStats: groupStats(),
    groups: listGroups({ limit: 60 }),
    groupConfig: {
      enabled: num(getSetting('groupEnabled'), 1) ? 1 : 0,
      depositRate: num(getSetting('groupDepositRate'), 0.3),
      minQty: GROUP_CONST.MIN_GROUP_QTY,
      maxQty: GROUP_CONST.MAX_GROUP_QTY,
      days: GROUP_CONST.GENERATE_DAYS,
      entryHours: GROUP_CONST.ENTRY_HOURS,
      rideHours: GROUP_CONST.RIDE_HOURS
    },
    // 会员与权益中心
    memberConfig: getConfig(),
    memberStats: memberStats(),
    members: listMembers({ limit: 200 }),
    cardProducts: listCardProducts(),
    benefitProducts: listBenefitProducts(),
    // 员工排班与工时结算
    shifts: listShiftTemplates(),
    schedules: listSchedules({ from: state.day(), to: state.day() + 3, limit: 600 }),
    // 今日考勤：当日结算（含昨日上班今日下班的跨日夜班）+ 当前仍在岗
    attendance: listAttendance({ settleDay: state.day(), limit: 200 })
      .concat(listAttendance({ status: 'checked_in', limit: 100 }))
      .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i),
    shiftRequests: listShiftRequests({ status: 'pending' }).concat(
      listShiftRequests({ limit: 60 }).filter(r => r.status !== 'pending').slice(0, 30)
    ),
    schedulingStats: schedulingStats(),
    coverageToday: coverageForDay(state.day()),
    dispatchPlan: dispatchPlan({ horizon: 3 }),
    dispatchPlans: listDispatchPlans({ limit: 20 }),
    // 统一客流预测与资源调度闭环（统一预测 + 缺口画像 + 一致性巡检）
    closedLoop: closedLoopOverview({ horizon: 3, demandProvider: d => demandForDay(d) }),
    reconcileList: listFindings({ status: 'open', limit: 50 }),
    // 园区应急指挥：安全事件状态机与统计（在途事件置前）
    incidents: listIncidents({ limit: 80 }),
    incidentStats: incidentStats(),
    emergencyConst: {
      severityNames: EMERGENCY_CONST.SEVERITY_NAMES,
      controlSla: EMERGENCY_CONST.CONTROL_SLA,
      rescueCost: EMERGENCY_CONST.RESCUE_COST,
      staffSubsidy: EMERGENCY_CONST.STAFF_SUBSIDY,
      types: Object.fromEntries(Object.entries(EMERGENCY_CONST.TYPES).map(([k, v]) => [k, { name: v.name, icon: v.icon, defSev: v.defSev }]))
    },
    finance: fin,
    // 物资采购与库存
    suppliers: listSuppliers(),
    materials: listMaterials(),
    purchaseOrders: listOrders({ limit: 100 }),
    purchaseStats: procurementStats(),
    inventoryFindings: listInventoryFindings({ status: 'open', limit: 50 }),
    stockBatches: listBatches({ expiring: true, limit: 50 }),
    stocktakes: listStocktakes({ limit: 30 }),
    purchaseReturns: listReturns({ limit: 50 }),
    // 园区联营商户结算
    partnerStats: partnerStats(),
    partnerApplications: listApplications({ limit: 50 }),
    partnerContracts: listContracts({ limit: 50 }),
    partnerSales: listPartnerSales({ limit: 60 }),
    partnerSettlements: listSettlements({ limit: 50 }),
    partnerConst: { periodChoices: PARTNER_CONST.PERIOD_CHOICES, fineMul: PARTNER_CONST.FINE_MUL, fineMin: PARTNER_CONST.FINE_MIN },
    // 会员权益转赠与家庭账户
    giftStats: giftStats(),
    giftConfig: getGiftConfig(),
    families: listFamilies({ limit: 100 }),
    gifts: listGifts({ limit: 120 }),
    // 供应商批次召回（供应商×园方×联营商户协同）
    recalls: listRecalls({ limit: 100 }),
    recallStats: recallStats(),
    // 统一可恢复补偿队列（停运预约退款 / 团队行程 / 联营退款）
    compensations: listCompensations({ limit: 120 }),
    compensationStats: compensationStatsFn(),
    avgs: {
      satisfaction: computeSatisfaction(),
      openRatio: rides.length ? operatingRides().length / rides.length : 0
    }
  })
})

app.get('/api/summary', (req, res) => {
  const riders = db.prepare("SELECT SUM(play_count) n, SUM(rev) s FROM rides").get()
  return res.json({
    totalRidePlays: riders.n || 0,
    totalRideRev: riders.s || 0,
    totalVisitors: (db.prepare('SELECT SUM(count) n FROM visitors').get().n || 0),
    totalEvents: db.prepare('SELECT COUNT(*) n FROM events').get().n,
    finance: db.prepare('SELECT label, SUM(amount) amount FROM finance GROUP BY label').all()
  })
})

// ---- 设施 ----
app.post('/api/rides', (req, res) => {
  const b = req.body || {}
  const type = b.type || '过山车'
  const zone_id = num(b.zone_id, 1)
  const name = b.name || `${type} · 新建`
  const preset = {
    '过山车': [32, 6, 60000, 260, 92], '旋转木马': [40, 4, 20000, 70, 15],
    '摩天轮': [24, 12, 45000, 150, 45], '跳楼机': [20, 8, 35000, 130, 88],
    '碰碰车': [12, 5, 26000, 95, 60], '海盗船': [30, 7, 38000, 140, 78],
    '水上漂流': [28, 9, 42000, 160, 82], '云霄飞车': [22, 10, 52000, 200, 90]
  }[type] || [20, 5, 30000, 100, 60]
  const [capacity, cycle, cost, run_cost, thrill] = preset
  let cash = state.cash()
  if (cash < cost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= cost
  setSetting('cash', Math.round(cash))
  const r = db.prepare('INSERT INTO rides(name,type,zone_id,status,capacity,cycle_min,build_cost,run_cost,thrill,attr,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(name, type, zone_id, 'operating', capacity, cycle, cost, run_cost, thrill, 60 + thrill * 0.2, Math.max(20, Math.round(thrill * 0.6)), req.body.pos_row || 0, req.body.pos_col || 0)
  logFinance(state.day(), '建设', -cost, `建造 ${name}`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/rides/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}

  // 检修：不再即时修复，改为创建检修工单（排队待维修员工接单，按游戏时间推进，完工结算恢复）
  if (b.repair) {
    const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(id)
    if (!ride) return res.status(404).json({ ok: false, msg: '设施不存在' })
    const r = createMaintenanceOrder(id, 'manual')
    if (!r.ok) return res.status(400).json(r)
    maybeDispatchAfter(`检修工单${r.code}维修工需求`)
    return res.json(r)
  }

  // 升级刺激度：输入严格校验（拒绝负数/0/非数），扣款 + 财务流水 + 属性提升同一事务原子提交
  if (b.upgrade !== undefined) {
    const r = upgradeRide(id, b.upgrade)
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, code: r.code, msg: r.msg, reqId: req.reqId })
    return res.json({ ok: true, cost: r.cost, thrill: r.thrill, attr: r.attr, cash: r.cash, reqId: req.reqId })
  }

  const sets = []
  const vals = []
  if (b.status) {
    // 在途检修工单期间不允许直接改运营状态：完工自动恢复，需撤销请先撤销工单
    const openOrder = db.prepare("SELECT id FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing')").get(id)
    if (openOrder) return res.status(400).json({ ok: false, msg: '该设施有在途检修工单，工单完工后自动恢复运营' })
    sets.push('status=?'); vals.push(b.status)
  }
  if (b.price) { sets.push('price=?'); vals.push(num(b.price)) }
  if (b.name) { sets.push('name=?'); vals.push(b.name) }
  if (!sets.length) return res.json({ ok: false, msg: '无更新项' })
  vals.push(id)
  // 设施开放/停运与分时预约联动同一事务提交：停运强制退款在途预约，恢复重新开放时段；
  // 联动失败（关时段/退款/投诉任一步异常）整体回滚，设施状态一并还原，避免半完成状态
  try {
    tx(() => {
      db.prepare(`UPDATE rides SET ${sets.join(',')} WHERE id=?`).run(...vals)
      if (b.status) {
        const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(id)
        const sync = syncRideSlots(ride)
        if (sync && !sync.ok) throw new Error(sync.msg || '预约时段联动失败')
      }
    })
  } catch (e) {
    console.error(`[rides] 设施 #${id} 状态变更联动失败，已整体回滚 [${req.reqId}]:`, e)
    return res.status(500).json({ ok: false, code: 'TX_FAILED', msg: '状态变更联动失败，本次操作未生效，请稍后重试', reqId: req.reqId })
  }
  res.json({ ok: true })
})

app.delete('/api/rides/:id', (req, res) => {
  const id = num(req.params.id)
  // 拆除前对在途预约按园方原因全额退款（散客逐单容错；团行程走团账同事务回退）
  try {
    tx(() => {
      const pending = db.prepare("SELECT * FROM reservations WHERE ride_id=? AND status='booked'").all(id)
      for (const r of pending) {
        if (r.source === 'group' && r.group_item_id) continue
        refundReservation(r, 'park', '设施拆除，园方强制退款')
      }
      refundGroupsByRide(id)
      // 在途检修工单作废
      cancelOrdersByRide(id)
      db.prepare('DELETE FROM rides WHERE id=?').run(id)
    })
  } catch (e) {
    console.error(`[rides] 设施 #${id} 拆除联动失败，已整体回滚 [${req.reqId}]:`, e)
    return res.status(500).json({ ok: false, code: 'TX_FAILED', msg: '拆除联动失败，本次操作未生效，请稍后重试', reqId: req.reqId })
  }
  res.json({ ok: true })
})

// ---- 商铺 ----
app.post('/api/vendors', (req, res) => {
  const b = req.body || {}
  const type = b.type || '餐饮'
  const preset = { '餐饮': [0.62, 1000, 32], '纪念品': [0.7, 1200, 45], '饮品': [0.72, 600, 18] }[type] || [0.6, 800, 25]
  const [margin, rent, price] = preset
  let cash = state.cash()
  const buildCost = 8000
  if (cash < buildCost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= buildCost
  setSetting('cash', Math.round(cash))
  const r = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
    .run(b.name || `新${type}摊`, type, num(b.zone_id, 1), rent, margin, price, b.pos_row || 0, b.pos_col || 0)
  logFinance(state.day(), '建设', -buildCost, `开设 ${type} 商铺`)
  const vid = Number(r.lastInsertRowid)
  autoLinkVendor(vid, type)
  res.json({ ok: true, id: vid })
})

app.post('/api/vendors/:id/materials', (req, res) => {
  reply(req, res, setVendorMaterials(num(req.params.id), req.body?.material_ids || []))
})

app.post('/api/vendors/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.price) db.prepare('UPDATE vendors SET price=? WHERE id=?').run(num(b.price), id)
  if (b.staff_id !== undefined) {
    const sid = b.staff_id ? num(b.staff_id) : null
    db.prepare('UPDATE vendors SET staff_id=? WHERE id=?').run(sid, id)
    if (sid) db.prepare("UPDATE staff SET assigned_ride_id=NULL WHERE id=?").run(sid)
  }
  res.json({ ok: true })
})

app.delete('/api/vendors/:id', (req, res) => {
  db.prepare('DELETE FROM vendors WHERE id=?').run(num(req.params.id))
  res.json({ ok: true })
})

// ---- 园区联营商户：入驻申请 → 审核签约 → 销售分账 → 结算账单 ----
// 入驻申请（新商户 / 存量商铺转联营）
app.get('/api/partner/applications', (req, res) =>
  res.json({ ok: true, list: listApplications({ status: req.query.status || null }) }))
app.get('/api/partner/applications/:id', (req, res) => {
  const d = applicationDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '申请不存在' })
  res.json({ ok: true, data: d })
})
app.post('/api/partner/applications', (req, res) =>
  reply(req, res, applyPartner({ ...(req.body || {}), applicant_staff_id: num(req.body?.applicant_staff_id) || null })))
app.post('/api/partner/applications/:id/withdraw', (req, res) =>
  reply(req, res, withdrawApplication(num(req.params.id), { staffId: num(req.body?.staff_id) || null })))
app.post('/api/partner/applications/:id/approve', (req, res) => {
  const b = req.body || {}
  reply(req, res, approveApplication(num(req.params.id), {
    staffId: num(b.staff_id) || null,
    commissionRate: b.commission_rate === undefined || b.commission_rate === '' ? null : num(b.commission_rate),
    period: b.settle_period_days ? num(b.settle_period_days) : null,
    deposit: b.deposit === undefined || b.deposit === '' ? null : num(b.deposit),
    memberDiscountShare: b.member_discount_share === undefined || b.member_discount_share === '' ? null : num(b.member_discount_share),
    endDay: num(b.end_day)
  }))
})
app.post('/api/partner/applications/:id/reject', (req, res) =>
  reply(req, res, rejectApplication(num(req.params.id), { reason: req.body?.reason || '', staffId: num(req.body?.staff_id) || null })))

// 合同
app.get('/api/partner/contracts', (req, res) =>
  res.json({ ok: true, list: listContracts({ status: req.query.status || null, vendorId: req.query.vendor_id ? num(req.query.vendor_id) : null }) }))
app.get('/api/partner/contracts/:id', (req, res) => {
  const d = contractDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '合同不存在' })
  res.json({ ok: true, ...d })
})
app.post('/api/partner/contracts/:id/terminate', (req, res) => {
  const b = req.body || {}
  reply(req, res, terminateContract(num(req.params.id), {
    reason: b.reason || '', forfeitDeposit: !!b.forfeit_deposit, staffId: num(b.staff_id) || null
  }))
})

// 销售流水 / 退货红冲
app.get('/api/partner/sales', (req, res) => {
  const q = req.query || {}
  res.json({ ok: true, list: listPartnerSales({
    vendorId: q.vendor_id ? num(q.vendor_id) : null, kind: q.kind || null,
    unsettledOnly: q.unsettled === '1', limit: num(q.limit, 100)
  }) })
})
app.post('/api/partner/sales/:id/return', (req, res) => {
  // 指定原单的会员联营退货：仅红冲分账（退款/库存走会员退货或前台销售退货入口）
  const b = req.body || {}
  const sale = db.prepare('SELECT vendor_id FROM partner_sales WHERE id=?').get(num(req.params.id))
  if (!sale) return res.status(404).json({ ok: false, msg: '销售流水不存在' })
  reply(req, res, partnerRecordReturn(sale.vendor_id, num(req.params.id), {
    qty: num(b.qty, 1), refund: num(b.refund), complaintId: num(b.complaint_id) || null, note: b.note || ''
  }))
})
app.get('/api/partner/fines', (req, res) =>
  res.json({ ok: true, list: listFines({ vendorId: req.query.vendor_id ? num(req.query.vendor_id) : null, unsettledOnly: req.query.unsettled === '1' }) }))

// 结算账单
app.get('/api/partner/settlements', (req, res) =>
  res.json({ ok: true, list: listSettlements({ status: req.query.status || null, vendorId: req.query.vendor_id ? num(req.query.vendor_id) : null }) }))
app.get('/api/partner/settlements/:id', (req, res) => {
  const d = settlementDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '账单不存在' })
  res.json({ ok: true, ...d })
})
app.post('/api/partner/contracts/:id/settle', (req, res) =>
  reply(req, res, issueSettlement(num(req.params.id), { note: req.body?.note || '' })))
app.post('/api/partner/settlements/:id/pay', (req, res) =>
  reply(req, res, paySettlement(num(req.params.id), { staffId: num(req.body?.staff_id) || null })))

// ---- 物资采购与库存 ----
// 供应商
app.get('/api/suppliers', (req, res) => res.json({ ok: true, list: listSuppliers({ status: req.query.status || null }) }))
app.get('/api/suppliers/:id', (req, res) => {
  const d = supplierDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '供应商不存在' })
  res.json({ ok: true, ...d })
})
app.post('/api/suppliers', (req, res) => reply(req, res, saveSupplier(req.body || {})))
app.post('/api/suppliers/:id', (req, res) => reply(req, res, saveSupplier(req.body || {}, num(req.params.id))))

// 物资目录
app.get('/api/materials', (req, res) => res.json({ ok: true, list: listMaterials() }))
app.get('/api/materials/:id/movements', (req, res) =>
  res.json({ ok: true, list: materialMovements(num(req.params.id), { limit: num(req.query.limit, 100) }) }))
app.post('/api/materials', (req, res) => reply(req, res, saveMaterial(req.body || {})))
app.post('/api/materials/:id', (req, res) => reply(req, res, saveMaterial(req.body || {}, num(req.params.id))))

// 采购单
app.get('/api/purchase-orders', (req, res) =>
  res.json({ ok: true, list: listOrders({ status: req.query.status || null, supplierId: req.query.supplier_id ? num(req.query.supplier_id) : null }) }))
app.get('/api/purchase-orders/:id', (req, res) => {
  const d = orderDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '采购单不存在' })
  res.json({ ok: true, ...d })
})
app.post('/api/purchase-orders', (req, res) => reply(req, res, createOrder(req.body || {})))
app.post('/api/purchase-orders/:id/submit', (req, res) => reply(req, res, submitOrder(num(req.params.id))))
app.post('/api/purchase-orders/:id/approve', (req, res) => reply(req, res, approveOrder(num(req.params.id), { staffId: num(req.body?.staff_id) || null })))
app.post('/api/purchase-orders/:id/reject', (req, res) => reply(req, res, rejectOrder(num(req.params.id), { note: req.body?.note || '' })))
app.post('/api/purchase-orders/:id/receive', (req, res) =>
  reply(req, res, receiveOrder(num(req.params.id), req.body?.receives || [], { note: req.body?.note || '' })))
app.post('/api/purchase-orders/:id/pay', (req, res) =>
  reply(req, res, payOrder(num(req.params.id), num(req.body?.amount))))

// 退货：purchase=采购退供应商；sale=游客销售退货回补+退款（联营商户同时红冲分账流水）
app.post('/api/purchase-returns', (req, res) => reply(req, res, purchaseReturn(req.body || {})))
app.post('/api/sales-returns', (req, res) => {
  const vendorId = num(req.body?.vendor_id)
  const qty = num(req.body?.qty)
  const partner = isPartnerVendor(vendorId)
  // 联营退货：采购事务回补库存（partner_sale_return）成功后，再写负向分账流水
  const r = customerReturn(vendorId, qty, { reason: req.body?.reason || '', partner })
  if (r.ok && partner) {
    const pr = organicReturn(vendorId, qty, {
      refund: r.refund, complaintId: num(req.body?.complaint_id) || null, reason: req.body?.reason || ''
    })
    if (!pr.ok) return reply(req, res, pr)
    r.partner_return = pr
  }
  reply(req, res, r)
})
app.get('/api/purchase-returns', (req, res) => res.json({ ok: true, list: listReturns({ kind: req.query.kind || null }) }))

// 入库批次
app.get('/api/stock-batches', (req, res) =>
  res.json({ ok: true, list: listBatches({ materialId: req.query.material_id ? num(req.query.material_id) : null, expiring: req.query.expiring === '1' }) }))

// 盘点
app.get('/api/stocktakes', (req, res) => res.json({ ok: true, list: listStocktakes({ status: req.query.status || null }) }))
app.get('/api/stocktakes/:id', (req, res) => {
  const d = stocktakeDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '盘点单不存在' })
  res.json({ ok: true, stocktake: d })
})
app.post('/api/stocktakes', (req, res) => reply(req, res, createStocktake(req.body || {})))
app.post('/api/stocktakes/:id/submit', (req, res) => reply(req, res, submitStocktake(num(req.params.id), req.body?.actuals || [])))
app.post('/api/stocktakes/:id/approve', (req, res) => reply(req, res, approveStocktake(num(req.params.id), { note: req.body?.note || '' })))
app.post('/api/stocktakes/:id/cancel', (req, res) => reply(req, res, cancelStocktake(num(req.params.id))))

// 异常对账
app.get('/api/inventory-findings', (req, res) =>
  res.json({ ok: true, list: listInventoryFindings({ status: req.query.status || null, type: req.query.type || null }) }))
app.post('/api/inventory-findings/:id/resolve', (req, res) => reply(req, res, resolveInventoryFinding(num(req.params.id), req.body?.note || '')))
app.post('/api/inventory-findings/:id/ignore', (req, res) => reply(req, res, ignoreInventoryFinding(num(req.params.id), req.body?.note || '')))

// ---- 员工 ----
const ROLES = ['保安', '保洁', '维修', '会员专员', '运营主管']
app.post('/api/staff', (req, res) => {
  const b = req.body || {}
  const role = b.role || '保安'
  if (!ROLES.includes(role)) return res.status(400).json({ ok: false, msg: '非法岗位' })
  const wage = role === '维修' ? 380 : role === '会员专员' ? 340 : role === '运营主管' ? 420 : role === '保洁' ? 300 : 320
  const r = db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,?,?,?,?,?)')
    .run(b.name || `新员工`, role, num(b.zone_id, 1), wage, 1, 80, 1)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/staff/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.zone_id) db.prepare('UPDATE staff SET zone_id=? WHERE id=?').run(num(b.zone_id), id)
  if (b.active !== undefined) {
    db.prepare('UPDATE staff SET active=? WHERE id=?').run(b.active ? 1 : 0, id)
    // 维修工离岗：在修工单退回排队、进度保留，等待其他维修工接续
    if (!b.active) {
      releaseStaffOrders(id)
      // 排班联动：未来排班取消、待审批调班作废、在岗考勤立即按实际工时离岗结算
      releaseStaffSchedules(id)
      // 动态调度联动：离岗腾出的岗位缺口自动补位（紧急缺口转加班调令待审批）
      maybeDispatchAfter('员工离岗后岗位缺口补齐')
    }
  }
  if (b.assignRide) db.prepare('UPDATE staff SET assigned_ride_id=? WHERE id=?').run(num(b.assignRide), id)
  if (b.assignVendor) db.prepare('UPDATE staff SET assigned_ride_id=? WHERE id=?').run(num(b.assignVendor), id)
  res.json({ ok: true })
})

// ---- 区域 ----
app.post('/api/zones/:id/unlock', (req, res) => {
  const id = num(req.params.id)
  const z = db.prepare('SELECT * FROM zones WHERE id=?').get(id)
  if (!z) return res.status(404).json({ ok: false })
  let cash = state.cash()
  const cost = 80000
  if (cash < cost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= cost
  setSetting('cash', Math.round(cash))
  db.prepare('UPDATE zones SET unlocked=1, open=1 WHERE id=?').run(id)
  logFinance(state.day(), '扩建', -cost, `开放「${z.name}」`)
  res.json({ ok: true })
})

app.post('/api/zones/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.open !== undefined) db.prepare('UPDATE zones SET open=? WHERE id=?').run(b.open ? 1 : 0, id)
  if (b.scenery !== undefined) db.prepare('UPDATE zones SET scenery=? WHERE id=?').run(num(b.scenery), id)
  res.json({ ok: true })
})

// ---- 票务 / 分期贷款 ----
app.post('/api/ticket', (req, res) => {
  const p = num(req.body?.price, 120)
  setSetting('ticket', Math.max(10, Math.min(500, p)))
  res.json({ ok: true, ticket: num(getSetting('ticket')) })
})

// 申请分期贷款：可选期数(天)与每期利率，等额本息
app.post('/api/loan', (req, res) => {
  const amount = Math.round(num(req.body?.amount))
  const periods = Math.round(num(req.body?.periods, 10))
  // 前端以百分数传入（1 表示每期 1%）
  const rate = req.body?.ratePct !== undefined
    ? num(req.body.ratePct) / 100
    : num(req.body?.rate, 0.01)
  if (!Number.isFinite(amount) || amount < LOAN_MIN || amount > LOAN_MAX) {
    return res.status(400).json({ ok: false, msg: `贷款金额需在 ${LOAN_MIN.toLocaleString()} ~ ${LOAN_MAX.toLocaleString()} 之间` })
  }
  if (!Number.isInteger(periods) || periods < 1 || periods > 60) {
    return res.status(400).json({ ok: false, msg: '期数需为 1~60 之间的整数（天）' })
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.05) {
    return res.status(400).json({ ok: false, msg: '每期利率需在 0% ~ 5% 之间' })
  }
  const installment = calcInstallment(amount, rate, periods)
  const day = state.day()
  const r = db.prepare(`INSERT INTO loans(principal,rate,periods,installment,remain_principal,start_day,created_tick)
                        VALUES(?,?,?,?,?,?,?)`)
    .run(amount, rate, periods, installment, amount, day, state.tick())
  const cash = state.cash() + amount
  setSetting('cash', Math.round(cash))
  logFinance(day, '贷款', amount, `取得分期贷款 #${r.lastInsertRowid}：${periods} 期 · 每期 ${Math.round(rate * 1000) / 10}% · 月供 ¥${installment.toLocaleString()}`)
  res.json({ ok: true, id: Number(r.lastInsertRowid), installment, periods, ratePct: Math.round(rate * 1000) / 10, loan: loanDebt() })
})

// 提前结清单笔贷款：仅收取剩余本金与已产生的逾期利息/罚息，豁免未到期利息
app.post('/api/loans/:id/repay', (req, res) => {
  const id = num(req.params.id)
  const l = db.prepare("SELECT * FROM loans WHERE id=? AND status='active'").get(id)
  if (!l) return res.status(404).json({ ok: false, msg: '贷款不存在或已结清' })
  const need = l.remain_principal + l.arrears_i
  const cash = state.cash()
  if (cash < need) return res.status(400).json({ ok: false, msg: `资金不足，结清需 ¥${need.toLocaleString()}` })
  const day = state.day()
  if (l.arrears_i > 0) logFinance(day, '利息', -l.arrears_i, `贷款 #${l.id} 结清逾期利息/罚息`)
  logFinance(day, '贷款', -l.remain_principal, `提前结清贷款 #${l.id} 本金`)
  setSetting('cash', Math.round(cash - need))
  db.prepare("UPDATE loans SET remain_principal=0, arrears_p=0, arrears_i=0, status='done' WHERE id=?").run(l.id)
  res.json({ ok: true, loan: loanDebt() })
})

// ---- 活动与事件 ----
app.post('/api/events', (req, res) => {
  const b = req.body || {}
  let cash = state.cash()
  const budget = num(b.budget, 8000)
  if (cash < budget) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= budget
  setSetting('cash', Math.round(cash))
  const impact = b.type === '烟火' || b.type === '花车巡游' ? 2 : 1
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), state.day(), b.type, b.title || `${b.type}活动`, b.desc || '策划的园区活动', impact, 'active')
  logFinance(state.day(), '活动', -budget, `举办 ${b.title || '活动'}`)
  res.json({ ok: true })
})

app.post('/api/events/:id/resolve', (req, res) => {
  const id = num(req.params.id)
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(id)
  if (!ev) return res.status(404).json({ ok: false })
  db.prepare("UPDATE events SET status='resolved', feedback=? WHERE id=?").run('通过决策处理', id)
  // 处理得当可挽回部分声誉损失
  if (ev.impact < 0) {
    let rep = state.reputation() + Math.abs(ev.impact) * 5
    setSetting('reputation', Math.max(5, Math.min(100, rep)))
  }
  res.json({ ok: true })
})

// ---- 游客投诉与服务补救 ----
app.get('/api/complaints', (req, res) => {
  const rows = db.prepare('SELECT * FROM complaints ORDER BY id DESC LIMIT 120').all()
  res.json({ list: enrichComplaints(rows), stats: complaintStats() })
})

// 前台登记游客反馈（手动建单）
app.post('/api/complaints', (req, res) => {
  const b = req.body || {}
  const category = COMPLAINT_CATS[b.category] ? b.category : 'service'
  const severity = Math.max(1, Math.min(3, Math.round(num(b.severity, 1))))
  const content = String(b.content || '').trim()
  if (!content) return res.status(400).json({ ok: false, msg: '请填写游客反馈内容' })
  if (content.length > 200) return res.status(400).json({ ok: false, msg: '反馈内容请控制在 200 字以内' })
  let target = { type: '', id: null, name: '' }
  if (b.target_type === 'ride') { const r = allRides().find(x => x.id === num(b.target_id)); if (r) target = { type: 'ride', id: r.id, name: r.name } }
  else if (b.target_type === 'vendor') { const v = allVendors().find(x => x.id === num(b.target_id)); if (v) target = { type: 'vendor', id: v.id, name: v.name } }
  else if (b.target_type === 'zone') { const z = allZones().find(x => x.id === num(b.target_id)); if (z) target = { type: 'zone', id: z.id, name: z.name } }
  // 会员本人投诉（可积分补偿结案）：校验会员档案
  let memberId = null
  if (b.member_id) {
    const m = db.prepare('SELECT id FROM members WHERE id=?').get(num(b.member_id))
    if (m) memberId = m.id
  }
  const title = `${COMPLAINT_CATS[category].name}投诉 · ${target.name || '园区整体'}`
  const r = createComplaint({ category, severity, title, content, target, source: 'manual', memberId })
  res.json({ ok: true, ...r })
})

// 指派员工受理（员工处理：技能/满意度/岗位匹配决定处置速度与结案评价）
app.post('/api/complaints/:id/assign', (req, res) => {
  const id = num(req.params.id)
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c || !OPEN_COMPLAINT_STATUSES.includes(c.status)) return res.status(400).json({ ok: false, msg: '投诉不存在或已结案' })
  const st = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(num(req.body?.staff_id))
  if (!st) return res.status(400).json({ ok: false, msg: '员工不存在或已离岗' })
  // 排班校验：当日必须有排班；已排班但尚未到班也可先接单（到班打卡后开始推进）
  const duty = staffDutyState(st.id)
  if (!duty.scheduled) return res.status(400).json({ ok: false, code: 'NOT_SCHEDULED', msg: duty.msg || `${st.name} 今日无排班，不能受理投诉`, reqId: req.reqId })
  db.prepare("UPDATE complaints SET status='processing', assignee_id=? WHERE id=?").run(st.id, id)
  logComplaint(id, 'assign', `指派 ${st.name}（${st.role}）受理`, st.id)
  res.json({ ok: true })
})

// 升级投诉：严重度 +1，时限按新等级重置，需更高技能员工接手
app.post('/api/complaints/:id/escalate', (req, res) => {
  const id = num(req.params.id)
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c || !OPEN_COMPLAINT_STATUSES.includes(c.status)) return res.status(400).json({ ok: false, msg: '投诉不存在或已结案' })
  if (c.severity >= 3) return res.status(400).json({ ok: false, msg: '已是最高等级，无法继续升级' })
  const sev = c.severity + 1
  db.prepare('UPDATE complaints SET severity=?, escalated=1, escalations=escalations+1, deadline_tick=? WHERE id=?')
    .run(sev, state.tick() + SEV_SLA[sev], id)
  logComplaint(id, 'escalate', `管理层介入，投诉升级为「${SEV_NAMES[sev]}」，限时 ${SEV_SLA[sev]} 小时`)
  res.json({ ok: true })
})

// 确认补偿方案并结案（补偿记录 + 声誉/口碑/员工满意度回流）
app.post('/api/complaints/:id/resolve', (req, res) => {
  const id = num(req.params.id)
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c) return res.status(404).json({ ok: false, msg: '投诉不存在' })
  if (c.status !== 'ready') return res.status(400).json({ ok: false, msg: '需先指派员工完成现场处置，才能确认补偿' })
  const comp = COMP_OPTIONS[req.body?.compensation] ? req.body.compensation : 'apology'
  res.json(doResolveComplaint(id, comp))
})

// 不予补偿直接结案：游客不满，扣减声誉与口碑
app.post('/api/complaints/:id/close', (req, res) => {
  res.json(forceCloseComplaint(num(req.params.id)))
})

// 单条投诉详情 + 处理时间线
app.get('/api/complaints/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(num(req.params.id))
  if (!c) return res.status(404).json({ ok: false })
  const logs = db.prepare('SELECT * FROM complaint_logs WHERE complaint_id=? ORDER BY id').all(c.id)
  res.json({ complaint: enrichComplaints([c])[0], logs })
})

// ---- 设施检修工单 ----
// 工单列表（默认全部，可按状态过滤）
app.get('/api/maintenance', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listMaintenanceOrders({ status: q.status || null, limit: 200 }),
    stats: maintenanceStats()
  })
})

// 工单详情 + 处理时间线
app.get('/api/maintenance/:id', (req, res) => {
  const detail = maintenanceOrderDetail(num(req.params.id))
  if (!detail) return res.status(404).json({ ok: false })
  res.json(detail)
})

// 接单 / 转派（仅在岗维修员工，每人同时只接一个在修工单）
app.post('/api/maintenance/:id/assign', (req, res) => {
  const r = assignMaintenanceOrder(num(req.params.id), num(req.body?.staff_id))
  if (r.ok) maybeDispatchAfter('检修工单派工后维修工需求平衡')
  res.status(r.ok ? 200 : 400).json(r)
})

// 撤销排队中（未接单）的工单，设施恢复运营
app.post('/api/maintenance/:id/cancel', (req, res) => {
  const r = cancelMaintenanceOrder(num(req.params.id))
  res.status(r.ok ? 200 : 400).json(r)
})

// ---- 员工排班与工时结算 ----
// 班次模板 / 排班 / 考勤查询
app.get('/api/schedules', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listSchedules({
      day: q.day !== undefined ? num(q.day) : null,
      staffId: q.staffId ? num(q.staffId) : null,
      status: q.status || null,
      limit: 600
    }),
    shifts: listShiftTemplates({ activeOnly: q.all === '1' ? false : true }),
    stats: schedulingStats(),
    coverage: coverageForDay(q.day !== undefined ? num(q.day) : state.day())
  })
})

app.get('/api/attendance', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listAttendance({
      day: q.day !== undefined ? num(q.day) : null,
      staffId: q.staffId ? num(q.staffId) : null,
      status: q.status || null,
      settleDay: q.settleDay !== undefined ? num(q.settleDay) : null,
      limit: 300
    }),
    stats: schedulingStats()
  })
})

app.get('/api/shift-requests', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listShiftRequests({ status: q.status && q.status !== 'all' ? q.status : null, kind: q.kind || null }),
    stats: schedulingStats()
  })
})

// 排班时间线（排班/考勤/申请联动查询）
app.get('/api/schedules/logs', (req, res) => {
  const q = req.query || {}
  res.json({ logs: shiftLogs({
    scheduleId: q.scheduleId ? num(q.scheduleId) : null,
    attendanceId: q.attendanceId ? num(q.attendanceId) : null,
    requestId: q.requestId ? num(q.requestId) : null
  }) })
})

// 运营主管排班（幂等）：返回当日岗位覆盖预警
app.post('/api/schedules', (req, res) => {
  const b = req.body || {}
  reply(req, res, createSchedule({
    staffId: num(b.staff_id),
    shiftId: num(b.shift_id),
    day: num(b.day, state.day()),
    note: String(b.note || ''),
    requestId: idemKey(req)
  }))
})

// 取消排班（未打卡）
app.post('/api/schedules/:id/cancel', (req, res) => {
  reply(req, res, cancelSchedule(num(req.params.id), { requestId: idemKey(req) }))
})

// 员工/前台手动打卡（引擎也会在到点时自动打卡）
app.post('/api/schedules/:id/checkin', (req, res) => {
  reply(req, res, scheduleCheckin(num(req.params.id), { requestId: idemKey(req) }))
})

// 员工中途离岗：当前考勤立即按实际工时折算结算
app.post('/api/attendance/:id/leave', (req, res) => {
  const b = req.body || {}
  reply(req, res, leavePost(num(req.params.id), { reason: String(b.reason || ''), requestId: idemKey(req) }))
})

// 员工发起调班（协作，待主管审批）
app.post('/api/schedules/:id/swap', (req, res) => {
  const b = req.body || {}
  reply(req, res, requestSwap({
    staffId: num(b.staff_id),
    scheduleId: num(req.params.id),
    targetStaffId: num(b.target_staff_id),
    targetShiftId: num(b.target_shift_id),
    targetDay: num(b.target_day),
    reason: String(b.reason || ''),
    requestId: idemKey(req)
  }))
})

// 员工发起加班申请（当值，1~4h，主管审批后按 1.5 倍时薪结算）
app.post('/api/schedules/:id/overtime', (req, res) => {
  const b = req.body || {}
  reply(req, res, requestOvertime({
    staffId: num(b.staff_id),
    scheduleId: num(req.params.id),
    ticks: num(b.ticks, 1),
    reason: String(b.reason || ''),
    requestId: idemKey(req)
  }))
})

// 运营主管：批准 / 驳回调班
app.post('/api/shift-requests/:id/approve', (req, res) => {
  const id = num(req.params.id)
  const rq = db.prepare('SELECT kind FROM shift_requests WHERE id=?').get(id)
  if (!rq) return res.status(404).json({ ok: false, msg: '申请不存在' })
  const approverId = num(req.body?.approver_id) || null
  const r = rq.kind === 'swap' ? approveSwap(id, approverId) : approveOvertime(id, approverId)
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId })
})

app.post('/api/shift-requests/:id/reject', (req, res) => {
  const id = num(req.params.id)
  const rq = db.prepare('SELECT kind FROM shift_requests WHERE id=?').get(id)
  if (!rq) return res.status(404).json({ ok: false, msg: '申请不存在' })
  const approverId = num(req.body?.approver_id) || null
  const r = rq.kind === 'swap' ? rejectSwap(id, approverId, String(req.body?.note || '')) : rejectOvertime(id, approverId, String(req.body?.note || ''))
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId })
})

// 员工撤回本人申请
app.post('/api/shift-requests/:id/cancel', (req, res) => {
  const r = cancelRequest(num(req.params.id), num(req.body?.staff_id))
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId })
})

// 排班运营配置：自动补位开关 / 调度模式（auto 全员基础补位 / dynamic 需求动态调度）/ 加班倍率 / 客流承载参数
app.post('/api/schedule-config', (req, res) => {
  const b = req.body || {}
  if (b.auto_fill !== undefined) setSetting('scheduleAutoFill', b.auto_fill ? 1 : 0)
  if (b.mode !== undefined) setSetting('scheduleMode', b.mode === 'auto' ? 'auto' : 'dynamic')
  if (b.approval_mode !== undefined) setSetting('scheduleApproval', b.approval_mode ? 1 : 0)
  if (b.ot_rate_mul !== undefined) {
    const v = Math.max(1, Math.min(3, num(b.ot_rate_mul, 1.5)))
    setSetting('otRateMul', v)
  }
  if (b.guard_flow !== undefined) setSetting('dispatchGuardFlow', Math.max(100, Math.min(5000, num(b.guard_flow, 500))))
  if (b.clean_flow !== undefined) setSetting('dispatchCleanFlow', Math.max(100, Math.min(5000, num(b.clean_flow, 700))))
  if (b.night_guards_per_zone !== undefined) setSetting('dispatchNightGuardsPerZone', Math.max(0, Math.min(10, num(b.night_guards_per_zone, 0))))
  res.json({ ok: true, config: {
    autoFill: num(getSetting('scheduleAutoFill'), 1) ? 1 : 0,
    mode: getSetting('scheduleMode', 'dynamic'),
    approvalMode: num(getSetting('scheduleApproval'), 0) ? 1 : 0,
    otRateMul: num(getSetting('otRateMul'), 1.5),
    guardFlow: num(getSetting('dispatchGuardFlow'), 500),
    cleanFlow: num(getSetting('dispatchCleanFlow'), 700),
    nightGuardsPerZone: num(getSetting('dispatchNightGuardsPerZone'), 0)
  } })
})

// 动态调度计划（只读）：未来 3 天需求画像（预约客流/检修工单/投诉岗位）与覆盖缺口
app.get('/api/dispatch-plan', (req, res) => {
  res.json({ plan: dispatchPlan({ horizon: 3 }) })
})

// ---- 跨日计划预览与审批 ----
// 跨日计划列表（默认待审批；?status=all 查看全部）
app.get('/api/dispatch-plans', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listDispatchPlans({ status: q.status && q.status !== 'all' ? q.status : null, limit: 60 }),
    approvalMode: num(getSetting('scheduleApproval'), 0) ? 1 : 0
  })
})

// 跨日计划详情：逐条二次校验（可落地/已失效/冗余）+ 落地后岗位覆盖残余缺口 + 需求新鲜度
app.get('/api/dispatch-plans/:id', (req, res) => {
  const plan = getDispatchPlan(num(req.params.id))
  if (!plan) return res.status(404).json({ ok: false, msg: '跨日计划不存在' })
  res.json({ plan })
})

// 生成跨日计划预览（dry-run）：联动预约客流/检修工单/投诉优先级，只落计划单不写排班
app.post('/api/dispatch-plans', (req, res) => {
  const b = req.body || {}
  const r = createDispatchPlan({
    horizon: num(b.horizon, 3),
    reason: String(b.reason || '主管生成跨日调度预览'),
    source: 'manual',
    requestId: idemKey(req)
  })
  reply(req, res, r)
})

// 主管审批跨日计划：原子落地全部仍可落地条目；失效/冗余条目安全跳过
app.post('/api/dispatch-plans/:id/approve', (req, res) => {
  const b = req.body || {}
  const r = approveDispatchPlan(num(req.params.id), num(b.approver_id) || null, String(b.note || ''))
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId, plan: getDispatchPlan(num(req.params.id)) })
})

// 主管驳回跨日计划
app.post('/api/dispatch-plans/:id/reject', (req, res) => {
  const b = req.body || {}
  const r = rejectDispatchPlan(num(req.params.id), num(b.approver_id) || null, String(b.note || ''))
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId })
})

// 手动触发一次动态补位：按需求缺口自动排班；当天已开始班段的缺口转紧急加班调令（走主管审批）
// 审批模式下不直接补位，而是生成一份跨日待批计划预览（返回 plan_id 供前端跳转审批）
app.post('/api/dispatch/run', (req, res) => {
  const b = req.body || {}
  if (num(getSetting('scheduleApproval'), 0)) {
    const r = createDispatchPlan({
      horizon: 3,
      reason: String(b.reason || '主管手动生成跨日计划'),
      source: 'manual',
      requestId: idemKey(req)
    })
    return res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId, approvalMode: 1, plan: dispatchPlan({ horizon: 3 }) })
  }
  const r = runDynamicDispatch({
    horizon: 3,
    urgentOvertime: b.urgent_overtime !== false,
    reason: String(b.reason || '主管手动触发动态调度')
  })
  res.json({ ...r, reqId: req.reqId, plan: dispatchPlan({ horizon: 3 }) })
})

// 单日需求画像（覆盖预警页按日查看）
app.get('/api/coverage/:day', (req, res) => {
  const day = num(req.params.day, state.day())
  res.json({ coverage: coverageForDay(day), demand: demandForDay(day) })
})

// ---- 统一客流预测与资源调度闭环 ----
// 闭环总览（只读）：未来 3 天统一客流预测（散客/团队/会员 + 散客自适应外推）+ 班段需求画像 + 巡检统计
app.get('/api/closed-loop', (req, res) => {
  const horizon = Math.max(1, Math.min(7, num(req.query.horizon, 3)))
  res.json({
    overview: closedLoopOverview({ horizon, demandProvider: d => demandForDay(d) }),
    findings: listFindings({ status: req.query.all === '1' ? 'all' : 'open', limit: 200 })
  })
})

// 手动触发一致性巡检（库存计数器漂移自动自愈；资金类仅告警）
app.post('/api/reconcile/run', (req, res) => {
  const autoHeal = req.body?.auto_heal !== false
  const r = runReconcile({ autoHeal, logEvent: true })
  res.json({ ...r, reqId: req.reqId, findings: listFindings({ status: 'open', limit: 200 }) })
})

// 忽略一条巡检告警（人工已核对/确认无需处理）
app.post('/api/reconcile/:id/ignore', (req, res) => {
  res.json({ ...ignoreFinding(num(req.params.id)), reqId: req.reqId })
})

// ---- 统一可恢复补偿队列：停运后的预约退款 / 团队行程 / 联营退款 ----
// 任务由停运联动/召回退款异常路径自动挂入，引擎每小时独立事务重试；
// 人工可：立即重试 / 登记人工已处理（系统不再触达资金，防重复扣款退款）/ 核对后作废。
app.get('/api/compensations', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listCompensations({
      status: q.status || null,
      domain: q.domain || null,
      needsManual: q.needs_manual === '1' ? 1 : null,
      limit: 300
    }),
    stats: compensationStatsFn()
  })
})

app.get('/api/compensations/:id', (req, res) => {
  const d = compensationDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '补偿任务不存在' })
  res.json(d)
})

// 手动立即重试（现金/库存/投诉/账单在同一事务；幂等处理器保证不重复扣款/退款）
app.post('/api/compensations/:id/retry', (req, res) => {
  const b = req.body || {}
  const r = retryCompensationTask(num(req.params.id), { staffId: num(b.staff_id) || null, note: b.note || '人工触发立即重试' })
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId })
})

// 登记人工已处理：线下/业务侧已完成退款或账单红冲，系统停止自动重试（不再触碰现金/库存）
app.post('/api/compensations/:id/manual', (req, res) => {
  const b = req.body || {}
  const r = resolveCompensationManual(num(req.params.id), { staffId: num(b.staff_id) || null, note: b.note || '' })
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId })
})

// 人工核对确认业务已无需补偿（预约已他途核销/退款、联营红冲已在后续账单冲减）
app.post('/api/compensations/:id/obsolete', (req, res) => {
  const b = req.body || {}
  const r = markCompensationObsolete(num(req.params.id), { staffId: num(b.staff_id) || null, note: b.note || '' })
  res.status(r.ok ? 200 : 400).json({ ...r, reqId: req.reqId })
})

// ---- 分时预约：库存 / 下单 / 改签 / 取消 / 核销 ----
// 幂等键：body.request_id 优先，兼容 X-Idempotency-Key 头；同一键重复请求返回首次结果
const idemKey = req => String(req.body?.request_id || req.get('X-Idempotency-Key') || '').slice(0, 80)
// 统一响应：附带服务端请求号，前端可展示「错误码 · 请求号」便于追踪
const reply = (req, res, r, okStatus = 200) => res.status(r?.ok ? okStatus : 400).json({ ...r, reqId: req.reqId })

// 查询时段库存（入园 entry / 设施 ride），可按日期与设施过滤
app.get('/api/reservation-slots', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listSlots({
      scope: q.scope === 'ride' ? 'ride' : 'entry',
      rideId: q.rideId ? num(q.rideId) : null,
      day: q.day ? num(q.day) : null
    }),
    stats: reservationStats()
  })
})

// 运营调度：调整时段容量 / 超售额度 / 开关时段
app.post('/api/reservation-slots/:id', (req, res) => {
  reply(req, res, updateSlot(num(req.params.id), req.body || {}))
})

// 预约列表（可按状态/类型/日期过滤）
app.get('/api/reservations', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listReservations({
      status: q.status || null,
      scope: q.scope || null,
      day: q.day ? num(q.day) : null
    }),
    stats: reservationStats()
  })
})

// 游客下单：按日期 + 时段预约入园或设施（幂等：request_id 防重复提交）
app.post('/api/reservations', (req, res) => {
  const b = req.body || {}
  const scope = b.scope === 'ride' ? 'ride' : 'entry'
  const r = createReservation({
    scope,
    rideId: num(b.ride_id),
    slotId: num(b.slot_id),
    qty: num(b.qty, 1),
    guest_name: String(b.guest_name || '').trim(),
    guest_phone: String(b.guest_phone || '').trim(),
    source: b.source === 'manual' ? 'manual' : 'guest',
    memberId: b.member_id ? num(b.member_id) : null,
    benefitId: b.benefit_id ? num(b.benefit_id) : null,
    requestId: idemKey(req)
  })
  reply(req, res, r)
})

// 改签：目标时段有余量才可改，库存原子转移（幂等：重放不产生二次转移）
app.post('/api/reservations/:id/reschedule', (req, res) => {
  reply(req, res, rescheduleReservation(num(req.params.id), num(req.body?.slot_id), idemKey(req)))
})

// 取消：未开始全额退，当日取消退 50%，时段已过不可取消（幂等：重放不重复退款）
app.post('/api/reservations/:id/cancel', (req, res) => {
  reply(req, res, cancelReservation(num(req.params.id), idemKey(req)))
})

// 闸机 / 设施口扫码核销（幂等：重复扫码不重复放行）
app.post('/api/reservations/:id/checkin', (req, res) => {
  reply(req, res, checkinReservation(num(req.params.id), idemKey(req)))
})

// 预约详情时间线
app.get('/api/reservations/:id', (req, res) => {
  const id = num(req.params.id)
  const list = listReservations({ limit: 5000 }).filter(x => x.id === id)
  if (!list.length) return res.status(404).json({ ok: false })
  res.json({ reservation: list[0], logs: reservationLogs(id) })
})

// ---- 领队组团：行程提交 / 运营确认锁名额收订金 / 分批核销 / 尾款 / 部分退团 / 停运重排 ----
app.get('/api/groups', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listGroups({
      status: q.status || null,
      day: q.day ? num(q.day) : null,
      limit: 200
    }),
    stats: groupStats(),
    config: {
      enabled: num(getSetting('groupEnabled'), 1) ? 1 : 0,
      depositRate: num(getSetting('groupDepositRate'), 0.3),
      minQty: GROUP_CONST.MIN_GROUP_QTY,
      maxQty: GROUP_CONST.MAX_GROUP_QTY
    }
  })
})

app.get('/api/groups/:id', (req, res) => {
  const d = groupDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '团单不存在' })
  res.json(d)
})

// 领队提交入园 + 多设施行程（幂等）
app.post('/api/groups', (req, res) => {
  const b = req.body || {}
  reply(req, res, submitGroup({
    leader_name: String(b.leader_name || '').trim(),
    leader_phone: String(b.leader_phone || '').trim(),
    qty: num(b.qty, 10),
    itinerary: Array.isArray(b.itinerary) ? b.itinerary : [],
    note: String(b.note || ''),
    source: b.source === 'auto' ? 'auto' : 'leader',
    requestId: idemKey(req)
  }), 201)
})

// 运营确认：统一锁定各时段名额并收取订金（幂等）
app.post('/api/groups/:id/confirm', (req, res) => {
  reply(req, res, confirmGroup(num(req.params.id), { requestId: idemKey(req), staffId: num(req.body?.staff_id) || null }))
})

// 运营拒绝待确认团单
app.post('/api/groups/:id/reject', (req, res) => {
  reply(req, res, rejectGroup(num(req.params.id), {
    requestId: idemKey(req),
    reason: String(req.body?.reason || ''),
    staffId: num(req.body?.staff_id) || null
  }))
})

// 领队撤回待确认团单
app.post('/api/groups/:id/cancel', (req, res) => {
  reply(req, res, cancelGroup(num(req.params.id), { requestId: idemKey(req) }))
})

// 分批收取尾款（幂等）
app.post('/api/groups/:id/balance', (req, res) => {
  reply(req, res, payBalance(num(req.params.id), num(req.body?.amount), { requestId: idemKey(req) }))
})

// 分批核销某个行程（闸机入园 / 设施口；幂等）
app.post('/api/group-items/:id/checkin', (req, res) => {
  reply(req, res, checkinGroupItem(num(req.params.id), num(req.body?.qty, 1), {
    requestId: idemKey(req),
    source: req.body?.source === 'auto' ? 'auto' : 'manual'
  }))
})

// 领队部分退团（未来时段全额退已付部分；当日退扣 50% 手续费；幂等）
app.post('/api/group-items/:id/refund', (req, res) => {
  reply(req, res, refundGroupLeg(num(req.params.id), num(req.body?.qty, 1), { requestId: idemKey(req) }))
})

// 停运挂起/在途行程重排到新时段（幂等）
app.post('/api/group-items/:id/reroute', (req, res) => {
  reply(req, res, rerouteGroupItem(num(req.params.id), num(req.body?.slot_id), { requestId: idemKey(req) }))
})

// 停运挂起行程选择园方退款（幂等）
app.post('/api/group-items/:id/refund-outage', (req, res) => {
  reply(req, res, refundInterruptedItem(num(req.params.id), { requestId: idemKey(req) }))
})

// 团队模块运营配置：订金比例 / 模块开关
app.post('/api/group-config', (req, res) => {
  const b = req.body || {}
  if (b.deposit_rate !== undefined) {
    const v = Math.max(0, Math.min(1, num(b.deposit_rate, 0.3)))
    setSetting('groupDepositRate', v)
  }
  if (b.enabled !== undefined) setSetting('groupEnabled', b.enabled ? 1 : 0)
  res.json({ ok: true, config: {
    enabled: num(getSetting('groupEnabled'), 1) ? 1 : 0,
    depositRate: num(getSetting('groupDepositRate'), 0.3)
  } })
})

// ---- 游客会员与权益中心 ----
app.get('/api/members', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listMembers({ tier: q.tier || null, status: q.status || null, q: q.q || '', limit: 300 }),
    stats: memberStats(),
    config: getConfig(),
    cards: listCardProducts(),
    benefits: listBenefitProducts()
  })
})

app.get('/api/members/:id', (req, res) => {
  const d = memberDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '会员不存在' })
  res.json(d)
})

// 前台注册会员
app.post('/api/members', (req, res) => {
  const b = req.body || {}
  reply(req, res, registerMember({
    name: String(b.name || '').trim(),
    phone: String(b.phone || '').trim(),
    staffId: b.staff_id ? num(b.staff_id) : null
  }), 201)
})

// 会员核价预览（预约页选会员/权益时调用）：返回折后价与积分预估，不落库
app.post('/api/members/:id/quote', (req, res) => {
  const b = req.body || {}
  const m = db.prepare('SELECT id FROM members WHERE id=?').get(num(req.params.id))
  if (!m) return res.status(404).json({ ok: false, code: 'MEMBER_NOT_FOUND', msg: '会员不存在' })
  const ride = b.scope === 'ride' ? db.prepare('SELECT price FROM rides WHERE id=?').get(num(b.ride_id)) : null
  const q = memberQuote(num(req.params.id), {
    scope: b.scope === 'ride' ? 'ride' : 'entry',
    rideId: num(b.ride_id) || null,
    qty: num(b.qty, 1),
    benefitId: b.benefit_id ? num(b.benefit_id) : null,
    entryPrice: state.ticket(),
    ridePrice: ride?.price ?? 30
  })
  reply(req, res, q)
})

// 购卡 / 续费 / 升级（幂等）
app.post('/api/members/:id/cards/:tier', (req, res) => {
  const b = req.body || {}
  const tier = ['silver', 'gold', 'diamond'].includes(req.params.tier) ? req.params.tier : ''
  if (!tier) return res.status(400).json({ ok: false, code: 'CARD_NOT_FOUND', msg: '卡种无效', reqId: req.reqId })
  reply(req, res, applyCard(num(req.params.id), tier, {
    requestId: idemKey(req),
    staffId: b.staff_id ? num(b.staff_id) : null
  }))
})

// 储值充值（幂等）
app.post('/api/members/:id/topup', (req, res) => {
  reply(req, res, topup(num(req.params.id), num(req.body?.amount), {
    requestId: idemKey(req),
    staffId: req.body?.staff_id ? num(req.body.staff_id) : null
  }))
})

// 积分兑换权益（幂等）
app.post('/api/members/:id/redeem/:code', (req, res) => {
  reply(req, res, redeemPoints(num(req.params.id), String(req.params.code), { requestId: idemKey(req) }))
})

// 会员现场购优惠票（直接入园，不走预约；幂等）
app.post('/api/members/:id/tickets', (req, res) => {
  reply(req, res, buyEntryTicket(num(req.params.id), num(req.body?.qty, 1), { requestId: idemKey(req) }))
})

// 会员商铺消费：现金 / 储值 / 消费券
app.post('/api/members/:id/vendors/:vendorId/spend', (req, res) => {
  const b = req.body || {}
  reply(req, res, vendorSpend(num(req.params.id), num(req.params.vendorId), {
    payMethod: ['cash', 'balance', 'voucher'].includes(b.pay_method) ? b.pay_method : 'cash',
    benefitId: b.benefit_id ? num(b.benefit_id) : null,
    qty: num(b.qty, 1)
  }))
})

// 冻结 / 解冻
app.post('/api/members/:id/freeze', (req, res) => {
  const b = req.body || {}
  reply(req, res, setFrozen(num(req.params.id), b.frozen !== false, {
    reason: String(b.reason || '').slice(0, 100),
    staffId: b.staff_id ? num(b.staff_id) : null
  }))
})

// 运营手动调整积分
app.post('/api/members/:id/points', (req, res) => {
  const b = req.body || {}
  reply(req, res, adjustPoints(num(req.params.id), num(b.change), {
    note: String(b.note || '').slice(0, 100),
    staffId: b.staff_id ? num(b.staff_id) : null
  }))
})

// 归属运营人员（会员专员）
app.post('/api/members/:id/owner', (req, res) => {
  reply(req, res, setOwner(num(req.params.id), req.body?.staff_id ? num(req.body.staff_id) : null))
})

// 会员中心运营配置：积分倍率 / 积分补偿档 / 权益有效期 / 体系开关
app.post('/api/member-config', (req, res) => {
  reply(req, res, saveConfig(req.body || {}))
})

// 卡种运营配置（价格/有效期/折扣/赠送/上下架）
app.post('/api/card-products/:tier', (req, res) => {
  reply(req, res, updateCardProduct(String(req.params.tier), req.body || {}))
})

// ---- 会员权益转赠与家庭账户（会员 / 受赠人 / 运营三方协作） ----
// 家庭账户
app.get('/api/families', (req, res) => {
  const q = req.query || {}
  res.json({
    ok: true,
    list: listFamilies({ status: q.status || null, memberId: q.member_id ? num(q.member_id) : null, q: q.q || '' }),
    stats: giftStats(),
    config: getGiftConfig()
  })
})
app.get('/api/families/:id', (req, res) => {
  const d = familyDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '家庭账户不存在' })
  res.json({ ok: true, data: d })
})
app.post('/api/families', (req, res) => {
  const b = req.body || {}
  reply(req, res, createFamily({ memberId: num(b.member_id), name: b.name || '', note: b.note || '' }), 201)
})
app.post('/api/families/:id/invite', (req, res) => {
  const b = req.body || {}
  reply(req, res, inviteFamily({
    familyId: num(req.params.id), memberId: num(b.member_id),
    actorMemberId: b.actor_member_id ? num(b.actor_member_id) : null,
    staffId: b.staff_id ? num(b.staff_id) : null
  }))
})
app.post('/api/families/:id/leave', (req, res) => {
  reply(req, res, leaveFamily({ familyId: num(req.params.id), memberId: num(req.body?.member_id) }))
})
app.post('/api/families/:id/remove', (req, res) => {
  const b = req.body || {}
  reply(req, res, removeFamilyMember({
    familyId: num(req.params.id), memberId: num(b.member_id),
    actorMemberId: b.actor_member_id ? num(b.actor_member_id) : null,
    staffId: b.staff_id ? num(b.staff_id) : null
  }))
})
app.post('/api/families/:id/dissolve', (req, res) => {
  const b = req.body || {}
  reply(req, res, dissolveFamily({
    familyId: num(req.params.id),
    actorMemberId: b.actor_member_id ? num(b.actor_member_id) : null,
    staffId: b.staff_id ? num(b.staff_id) : null
  }))
})

// 权益转赠单
app.get('/api/gifts', (req, res) => {
  const q = req.query || {}
  res.json({
    ok: true,
    list: listGifts({
      status: q.status || null,
      donorMemberId: q.donor_id ? num(q.donor_id) : null,
      recipientMemberId: q.recipient_id ? num(q.recipient_id) : null,
      familyId: q.family_id ? num(q.family_id) : null,
      q: q.q || ''
    }),
    stats: giftStats(),
    config: getGiftConfig()
  })
})
app.get('/api/gifts/:id', (req, res) => {
  const d = giftDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '转赠单不存在' })
  res.json({ ok: true, data: d })
})

// 会员发起转赠（幂等）：指定受赠人或家庭共享池；券类传 benefit_ids，积分/储值传 amount
app.post('/api/gifts', (req, res) => {
  const b = req.body || {}
  reply(req, res, applyGift({
    donorMemberId: num(b.donor_member_id),
    target: b.target === 'family' ? 'family' : 'member',
    recipientMemberId: b.recipient_member_id ? num(b.recipient_member_id) : null,
    familyId: b.family_id ? num(b.family_id) : null,
    kind: String(b.kind || ''),
    amount: num(b.amount),
    benefitIds: b.benefit_ids || [],
    reason: String(b.reason || ''),
    requestId: idemKey(req)
  }), 201)
})
// 捐赠人撤回待审核申请
app.post('/api/gifts/:id/cancel', (req, res) => {
  reply(req, res, cancelGiftApplication({
    giftId: num(req.params.id), donorMemberId: num(req.body?.donor_member_id), requestId: idemKey(req)
  }))
})
// 运营审核通过 / 驳回
app.post('/api/gifts/:id/approve', (req, res) => {
  reply(req, res, approveGift({ giftId: num(req.params.id), staffId: num(req.body?.staff_id) || null, requestId: idemKey(req) }))
})
app.post('/api/gifts/:id/reject', (req, res) => {
  const b = req.body || {}
  reply(req, res, rejectGift({
    giftId: num(req.params.id), staffId: num(b.staff_id) || null, reason: String(b.reason || ''), requestId: idemKey(req)
  }))
})
// 受赠人领取（家庭池任意在组成员可领）/ 指定受赠人拒绝
app.post('/api/gifts/:id/claim', (req, res) => {
  reply(req, res, claimGift({ giftId: num(req.params.id), memberId: num(req.body?.member_id), requestId: idemKey(req) }))
})
app.post('/api/gifts/:id/decline', (req, res) => {
  reply(req, res, declineGift({ giftId: num(req.params.id), memberId: num(req.body?.member_id), requestId: idemKey(req) }))
})
// 捐赠人 / 运营撤回（已领取的未用权益冲回；已在途预约原子取消退款释放名额）
app.post('/api/gifts/:id/recall', (req, res) => {
  const b = req.body || {}
  reply(req, res, recallGift({
    giftId: num(req.params.id),
    donorMemberId: b.donor_member_id ? num(b.donor_member_id) : null,
    staffId: b.staff_id ? num(b.staff_id) : null,
    reason: String(b.reason || ''),
    requestId: idemKey(req)
  }))
})
// 转赠运营配置：模块开关 / 家庭池免审 / 领取有效期 / 单笔张数 / 最低转赠等级
app.post('/api/gift-config', (req, res) => {
  reply(req, res, saveGiftConfig(req.body || {}))
})

// ---------------- 供应商批次召回：供应商 / 园方 / 联营商户 三方协同 ----------------
app.get('/api/recalls', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listRecalls({ status: q.status && q.status !== 'all' ? q.status : null, limit: 200 }),
    stats: recallStats()
  })
})
app.get('/api/recalls/:id', (req, res) => {
  const d = recallDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '召回单不存在' })
  res.json({ ok: true, ...d })
})

// 发起召回：隔离批次（指定或该物资全部在库批次）、通知受影响商铺、联动餐饮投诉与事件
app.post('/api/recalls', (req, res) => {
  const b = req.body || {}
  reply(req, res, createRecall({
    supplier_id: num(b.supplier_id),
    material_id: num(b.material_id),
    batches: Array.isArray(b.batches) ? b.batches : [],
    reason: String(b.reason || ''),
    severity: num(b.severity, 2),
    notify_vendors: b.notify_vendors !== false,
    staffId: num(b.staff_id) || null
  }), 201)
})
// 供应商受理（issued→processing）
app.post('/api/recalls/:id/accept', (req, res) =>
  reply(req, res, acceptRecall(num(req.params.id), { staffId: num(req.body?.staff_id) || null, note: req.body?.note || '' })))
// 联营商户确认知悉
app.post('/api/recalls/:id/vendors/:vendorId/acknowledge', (req, res) =>
  reply(req, res, acknowledgeVendor(num(req.params.id), num(req.params.vendorId), { note: req.body?.note || '' })))
// 商铺为游客办理退货退款（自营退现金/联营红冲分账，问题品不回库）
app.post('/api/recalls/:id/vendors/:vendorId/refund', (req, res) =>
  reply(req, res, vendorRefund(num(req.params.id), num(req.params.vendorId), num(req.body?.qty, 1), {
    note: req.body?.note || '', staffId: num(req.body?.staff_id) || null
  })))
// 商铺确认无在途游客/已线下退换（放行结案，不再系统退款）
app.post('/api/recalls/:id/vendors/:vendorId/none', (req, res) =>
  reply(req, res, markVendorNone(num(req.params.id), num(req.params.vendorId), { note: req.body?.note || '' })))
// 隔离批次退回供应商（货款冲应付/退现金）
app.post('/api/recalls/:id/return', (req, res) =>
  reply(req, res, returnBatches(num(req.params.id), num(req.body?.qty), { staffId: num(req.body?.staff_id) || null })))
// 隔离批次现场销毁（核销物料成本）
app.post('/api/recalls/:id/destroy', (req, res) =>
  reply(req, res, destroyBatches(num(req.params.id), num(req.body?.qty), { staffId: num(req.body?.staff_id) || null, note: req.body?.note || '' })))
// 赔付报价（只读）
app.get('/api/recalls/:id/compensation', (req, res) =>
  res.json(compensationQuote(num(req.params.id))))
// 供应商赔付到账
app.post('/api/recalls/:id/compensation', (req, res) =>
  reply(req, res, payCompensation(num(req.params.id), num(req.body?.amount), { staffId: num(req.body?.staff_id) || null, note: req.body?.note || '' })))
// 结案（批次须已全部退供/销毁）
app.post('/api/recalls/:id/close', (req, res) =>
  reply(req, res, closeRecall(num(req.params.id), { note: req.body?.note || '', staffId: num(req.body?.staff_id) || null })))
// 误报结案（解除隔离恢复销售）
app.post('/api/recalls/:id/false', (req, res) =>
  reply(req, res, closeFalseRecall(num(req.params.id), { reason: req.body?.reason || '', staffId: num(req.body?.staff_id) || null })))
// 撤销（仅待受理）
app.post('/api/recalls/:id/cancel', (req, res) =>
  reply(req, res, cancelRecall(num(req.params.id), { reason: req.body?.reason || '', staffId: num(req.body?.staff_id) || null })))

// ---------------- 园区应急指挥：安全事件 发现→分级→封控→疏散→复园→复盘 ----------------
// 多角色协作：运营（分级/封控/复园/复盘/核定理赔）、安保（疏散上报/到场/撤防）、游客（上报/理赔）
app.get('/api/incidents', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listIncidents({ status: q.status || null, limit: 100 }),
    stats: incidentStats(),
    const: EMERGENCY_CONST
  })
})

app.get('/api/incidents/:id', (req, res) => {
  const d = incidentDetail(num(req.params.id))
  if (!d) return res.status(404).json({ ok: false, msg: '事件不存在' })
  res.json(d)
})

// 发现上报（运营/安保巡报/游客）；游客上报自动联动安全投诉
app.post('/api/incidents', (req, res) => {
  const b = req.body || {}
  reply(req, res, reportIncident({
    type: String(b.type || 'other'),
    title: String(b.title || ''),
    desc: String(b.desc || ''),
    location: String(b.location || ''),
    zoneId: b.zone_id ? num(b.zone_id) : null,
    reporterRole: ['operations', 'security', 'visitor'].includes(b.reporter_role) ? b.reporter_role : 'security',
    source: b.source === 'auto' ? 'auto' : '',
    complaintId: b.complaint_id ? num(b.complaint_id) : null,
    staffId: b.staff_id ? num(b.staff_id) : null,
    requestId: idemKey(req)
  }), 201)
})

// 分级（可同时封控指定设施/区域；4 级全园封控）→ graded/contained
app.post('/api/incidents/:id/grade', (req, res) => {
  const b = req.body || {}
  const lockdown = b.lockdown || {}
  reply(req, res, gradeIncident(num(req.params.id), {
    severity: num(b.severity),
    lockdown: {
      rides: Array.isArray(lockdown.rides) ? lockdown.rides.map(num) : [],
      zones: Array.isArray(lockdown.zones) ? lockdown.zones.map(num) : [],
      parkWide: !!lockdown.park_wide,
      autoZone: lockdown.auto_zone === false ? false : true
    },
    staffId: b.staff_id ? num(b.staff_id) : null,
    requestId: idemKey(req)
  }))
})

// 对已分级事件追加封控对象 → contained
app.post('/api/incidents/:id/lockdown', (req, res) => {
  const b = req.body || {}
  reply(req, res, lockdownIncident(num(req.params.id), {
    rides: Array.isArray(b.rides) ? b.rides.map(num) : [],
    zones: Array.isArray(b.zones) ? b.zones.map(num) : [],
    parkWide: !!b.park_wide,
    staffId: b.staff_id ? num(b.staff_id) : null,
    requestId: idemKey(req)
  }))
})

// 启动疏散（contained/graded → evacuating），首批疏散人数
app.post('/api/incidents/:id/evacuate', (req, res) => {
  const b = req.body || {}
  reply(req, res, startEvacuation(num(req.params.id), {
    qty: num(b.qty), staffId: b.staff_id ? num(b.staff_id) : null, requestId: idemKey(req)
  }))
})

// 安保现场上报疏散进展（增量）
app.post('/api/incidents/:id/evacuate/progress', (req, res) => {
  const b = req.body || {}
  reply(req, res, reportEvacuation(num(req.params.id), {
    qty: num(b.qty), staffId: b.staff_id ? num(b.staff_id) : null, requestId: idemKey(req)
  }))
})

// 控场（险情控制，核定伤员）→ controlled
app.post('/api/incidents/:id/control', (req, res) => {
  const b = req.body || {}
  reply(req, res, controlIncident(num(req.params.id), {
    casualties: num(b.casualties), staffId: b.staff_id ? num(b.staff_id) : null, requestId: idemKey(req)
  }))
})

// 复园：恢复封控对象/时段/区域，结算抢险费用与应急补贴 → reopened
app.post('/api/incidents/:id/reopen', (req, res) => {
  const b = req.body || {}
  reply(req, res, reopenIncident(num(req.params.id), {
    cost: b.cost != null ? num(b.cost) : null,
    staffId: b.staff_id ? num(b.staff_id) : null,
    requestId: idemKey(req)
  }))
})

// 事故复盘结案（原因/措施/教训/评分，声誉回补）→ closed_review
app.post('/api/incidents/:id/review', (req, res) => {
  const b = req.body || {}
  reply(req, res, reviewIncident(num(req.params.id), {
    cause: String(b.cause || ''),
    actions: String(b.actions || ''),
    lessons: String(b.lessons || ''),
    rating: num(b.rating, 3),
    staffId: b.staff_id ? num(b.staff_id) : null,
    requestId: idemKey(req)
  }))
})

// 误报关闭（恢复封控对象，不计抢险费用）→ closed_false
app.post('/api/incidents/:id/false', (req, res) => {
  const b = req.body || {}
  reply(req, res, closeFalseIncident(num(req.params.id), {
    reason: String(b.reason || ''),
    staffId: b.staff_id ? num(b.staff_id) : null,
    requestId: idemKey(req)
  }))
})

// 安全投诉转报为安全事件
app.post('/api/complaints/:id/escalate-incident', (req, res) => {
  const b = req.body || {}
  reply(req, res, escalateFromComplaint(num(req.params.id), {
    staffId: b.staff_id ? num(b.staff_id) : null, requestId: idemKey(req)
  }), 201)
})

// ---- 应急岗位调度（安保协作） ----
app.post('/api/incidents/:id/staff', (req, res) => {
  const b = req.body || {}
  reply(req, res, assignIncidentStaff(num(req.params.id), {
    staffId: num(b.staff_id),
    taskType: String(b.task_type || 'control'),
    note: String(b.note || ''),
    operatorId: b.operator_id ? num(b.operator_id) : null,
    requestId: idemKey(req)
  }))
})

app.post('/api/incident-staff/:id/acknowledge', (req, res) => {
  reply(req, res, acknowledgeStaff(num(req.params.id), { requestId: idemKey(req) }))
})

app.post('/api/incident-staff/:id/stand-down', (req, res) => {
  reply(req, res, standDownStaff(num(req.params.id), { requestId: idemKey(req) }))
})

// ---- 游客理赔（财务补偿联动） ----
app.post('/api/incidents/:id/claims', (req, res) => {
  const b = req.body || {}
  reply(req, res, fileClaim(num(req.params.id), {
    guestName: String(b.guest_name || ''),
    guestPhone: String(b.guest_phone || ''),
    memberId: b.member_id ? num(b.member_id) : null,
    item: String(b.item || ''),
    amountReq: num(b.amount_req),
    requestId: idemKey(req)
  }), 201)
})

app.post('/api/incident-claims/:id/pay', (req, res) => {
  const b = req.body || {}
  reply(req, res, payClaim(num(req.params.id), {
    amount: b.amount != null ? num(b.amount) : null,
    note: String(b.note || ''),
    handlerId: b.handler_id ? num(b.handler_id) : null,
    requestId: idemKey(req)
  }))
})

app.post('/api/incident-claims/:id/reject', (req, res) => {
  const b = req.body || {}
  reply(req, res, rejectClaim(num(req.params.id), {
    note: String(b.note || ''),
    handlerId: b.handler_id ? num(b.handler_id) : null,
    requestId: idemKey(req)
  }))
})

// 全局异常兜底：未捕获错误统一返回可追踪的 500（请求号写入服务端日志）
app.use((err, req, res, _next) => {
  console.error(`[api] 请求 ${req.reqId || '-'} ${req.method} ${req.path} 处理异常:`, err)
  res.status(500).json({ ok: false, code: 'INTERNAL', msg: '服务器内部错误，操作未生效，请稍后重试', reqId: req.reqId })
})

app.listen(PORT, () => console.log(`[PARK] API running at http://localhost:${PORT}`))