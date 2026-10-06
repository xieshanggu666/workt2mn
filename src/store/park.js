import { defineStore } from 'pinia'

const BASE = '/api'

// 生成幂等请求号：同一意图的双击/重试携带同一 requestId，服务端只执行一次
export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  try {
    const r = await fetch(BASE + path, opt)
    const data = await r.json().catch(() => null)
    if (!data) return { ok: false, code: 'BAD_RESPONSE', msg: `服务响应异常（HTTP ${r.status}），请稍后重试` }
    return data
  } catch (e) {
    // 网络中断/超时：请求可能未送达或已送达，提示用户勿盲目重复提交（携带幂等键的操作可安全重试）
    return { ok: false, code: 'NETWORK', msg: '网络异常，请求未送达，请检查连接后重试' }
  }
}

function emptyReservationStats() {
  return {
    todayCap: 0, todayBooked: 0, todayChecked: 0, todayRefunded: 0, todayFill: 0,
    pendingOrders: 0, pendingQty: 0, noshowToday: 0, refundOrdersToday: 0, refundAmountToday: 0,
    soldAheadQty: 0, soldAheadAmount: 0, oversoldPending: 0, calendar: []
  }
}

function emptyMemberStats() {
  return {
    total: 0, silver: 0, gold: 0, diamond: 0, activeCards: 0, frozen: 0, expiring: 0,
    pointsOutstanding: 0, balanceLiability: 0, cardRevToday: 0, topupToday: 0,
    vendorToday: 0, redeemToday: 0, memberOrdersToday: 0
  }
}

function emptySchedulingStats() {
  return {
    day: 1, todayScheduled: 0, onDuty: 0, absentToday: 0, lateToday: 0,
    overtimeHoursToday: 0, settledToday: 0, payToday: 0, pendingRequests: 0,
    coverageWarnings: 0, coverageBlocks: 0,
    dispatchOtRequests: 0, dispatchFilledToday: 0, nightOnDuty: 0, flowToday: 0,
    pendingPlanCount: 0, pendingPlanWage: 0, pendingAutoPlanId: null, pendingAutoPlanCode: '', approvalMode: 0
  }
}

function emptyGroupStats() {
  return {
    pending: 0, pendingQty: 0, activeToday: 0, activeQtyToday: 0, interrupted: 0,
    depositToday: 0, balanceToday: 0, refundToday: 0, checkedToday: 0
  }
}

function emptyIncidentStats() {
  return {
    open: 0, bySeverity: { 1: 0, 2: 0, 3: 0, 4: 0 }, overdue: 0, pendingClaims: 0,
    claimPayToday: 0, costToday: 0, closedToday: 0, totalCost: 0, totalClaimPaid: 0, avgRating: 0
  }
}

function emptyProcurementStats() {
  return {
    draft: 0, submitted: 0, receiving: 0,
    openFindings: 0, criticalFindings: 0,
    findingsByType: { shortage: 0, expiry: 0, price: 0, stock_diff: 0, payable: 0 },
    lowStock: 0, outStock: 0, expiringBatches: 0, stockValue: 0,
    payable: 0, overduePayable: 0, lostToday: { qty: 0, rev: 0 }, spoilTodayQty: 0, costToday: 0
  }
}

function emptyGiftStats() {
  return {
    pendingReview: 0, awaitingClaim: 0, expiredClaim: 0, claimedToday: 0, recalledToday: 0,
    claimedTotal: 0, familyActive: 0, familyMembers: 0, escrowPoints: 0, escrowBalance: 0
  }
}

function emptyRecallStats() {
  return {
    open: 0, issued: 0, processing: 0, closed: 0, openBatchQty: 0, openRefund: 0,
    pendingVendors: 0, pendingRefundVendors: 0, compensationTotal: 0, refundTotal: 0
  }
}

export const useParkStore = defineStore('park', {
  state: () => ({
    data: null,
    loaded: false,
    speed: 1,
    lastTick: 0
  }),
  getters: {
    clock: s => s.data?.clock || { day: 1, hour: 9 },
    ticket: s => s.data?.ticket ?? 0,
    zones: s => s.data?.zones || [],
    rides: s => s.data?.rides || [],
    vendors: s => s.data?.vendors || [],
    staff: s => s.data?.staff || [],
    events: s => s.data?.events || [],
    finance: s => s.data?.finance || [],
    visitors: s => s.data?.visitors || [],
    loans: s => s.data?.loans || [],
    debt: s => s.data?.debt || { remainPrincipal: 0, arrears: 0, overdueCount: 0 },
    complaints: s => s.data?.complaints || [],
    complaintStats: s => s.data?.complaintStats || { open: 0, overdue: 0, todayClosed: 0, resolved: 0, total: 0, avgRating: 0, compTotal: 0 },
    maintenanceOrders: s => s.data?.maintenanceOrders || [],
    maintenanceStats: s => s.data?.maintenanceStats || { queued: 0, processing: 0, open: 0, doneToday: 0, costToday: 0 },
    openMaintenanceOrders: s => (s.data?.maintenanceOrders || []).filter(o => ['queued', 'processing'].includes(o.status)),
    wordOfMouth: s => s.data?.wordOfMouth ?? 0,
    entrySlots: s => s.data?.entrySlots || [],
    reservations: s => s.data?.reservations || [],
    reservationStats: s => s.data?.reservationStats || emptyReservationStats(),
    openComplaints: s => (s.data?.complaints || []).filter(c => ['open', 'processing', 'ready'].includes(c.status)),
    activeEvents: s => (s.data?.events || []).filter(e => e.status === 'active'),
    // 会员与权益
    members: s => s.data?.members || [],
    memberStats: s => s.data?.memberStats || emptyMemberStats(),
    memberConfig: s => s.data?.memberConfig || { enabled: true, pointRate: 1, pointsComp: 300, voucherFace: 30, benefitValidDays: 30 },
    cardProducts: s => s.data?.cardProducts || [],
    benefitProducts: s => s.data?.benefitProducts || [],
    memberSpecialists: s => (s.data?.staff || []).filter(x => x.role === '会员专员'),
    // 员工排班与工时结算
    shifts: s => s.data?.shifts || [],
    schedules: s => s.data?.schedules || [],
    attendance: s => s.data?.attendance || [],
    shiftRequests: s => s.data?.shiftRequests || [],
    schedulingStats: s => s.data?.schedulingStats || emptySchedulingStats(),
    coverageToday: s => s.data?.coverageToday || { warnings: [], rosterCount: 0 },
    dispatchPlanData: s => s.data?.dispatchPlan || { days: [], params: {}, mode: 'dynamic' },
    dispatchPlans: s => s.data?.dispatchPlans || [],
    supervisors: s => (s.data?.staff || []).filter(x => x.role === '运营主管'),
    // 领队组团
    groups: s => s.data?.groups || [],
    groupStats: s => s.data?.groupStats || emptyGroupStats(),
    groupConfig: s => s.data?.groupConfig || { enabled: 1, depositRate: 0.3, minQty: 5, maxQty: 120, days: 3, entryHours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18], rideHours: [9, 10, 11, 12, 13, 14, 15, 16, 17] },
    // 统一客流预测与资源调度闭环
    closedLoop: s => s.data?.closedLoop || { days: [], forecast: { factor: 1, days: [] }, reconcile: { open: 0, blocks: 0 } },
    reconcileList: s => s.data?.reconcileList || [],
    // 园区应急指挥
    incidents: s => s.data?.incidents || [],
    incidentStats: s => s.data?.incidentStats || emptyIncidentStats(),
    emergencyConst: s => s.data?.emergencyConst || { severityNames: {}, controlSla: {}, rescueCost: {}, staffSubsidy: {}, types: {} },
    activeIncidents: s => (s.data?.incidents || []).filter(i => ['reported', 'graded', 'contained', 'evacuating', 'controlled'].includes(i.status)),
    // 物资采购与库存
    suppliers: s => s.data?.suppliers || [],
    materials: s => s.data?.materials || [],
    purchaseOrders: s => s.data?.purchaseOrders || [],
    purchaseStats: s => s.data?.purchaseStats || emptyProcurementStats(),
    inventoryFindings: s => s.data?.inventoryFindings || [],
    stockBatches: s => s.data?.stockBatches || [],
    stocktakes: s => s.data?.stocktakes || [],
    purchaseReturns: s => s.data?.purchaseReturns || [],
    // 园区联营商户结算
    partnerStats: s => s.data?.partnerStats || { contracts: { active: 0, terminated: 0 }, applications: { applied: 0 }, bills: { draft: 0, overdue: 0, payable: 0, paidToday: 0, paidTotal: 0 }, today: { bill: 0, refund: 0, parkShare: 0, merchantShare: 0, fines: 0 } },
    partnerApplications: s => s.data?.partnerApplications || [],
    partnerContracts: s => s.data?.partnerContracts || [],
    partnerSales: s => s.data?.partnerSales || [],
    partnerSettlements: s => s.data?.partnerSettlements || [],
    partnerConst: s => s.data?.partnerConst || { periodChoices: [3, 7, 15, 30] },
    // 权益转赠与家庭账户
    families: s => s.data?.families || [],
    gifts: s => s.data?.gifts || [],
    giftStats: s => s.data?.giftStats || emptyGiftStats(),
    giftConfig: s => s.data?.giftConfig || { enabled: true, familyAutoApprove: 1, claimDays: 7, maxItems: 20, minTier: 'none' },
    // 供应商批次召回
    recalls: s => s.data?.recalls || [],
    recallStats: s => s.data?.recallStats || emptyRecallStats(),
    openRecalls: s => (s.data?.recalls || []).filter(r => ['issued', 'processing'].includes(r.status))
  },
  actions: {
    async refresh() {
      this.data = await j('GET', '/state')
      this.loaded = true
      if (this.data) this.lastTick = this.data.clock.tick
    },
    async api(method, path, body) {
      const r = await j(method, path, body)
      await this.refresh()
      return r
    },
    buildRide(payload) { return this.api('POST', '/rides', payload) },
    updateRide(id, payload) { return this.api('POST', `/rides/${id}`, payload) },
    delRide(id) { return this.api('DELETE', `/rides/${id}`) },
    buildVendor(payload) { return this.api('POST', '/vendors', payload) },
    updateVendor(id, payload) { return this.api('POST', `/vendors/${id}`, payload) },
    delVendor(id) { return this.api('DELETE', `/vendors/${id}`) },
    hire(payload) { return this.api('POST', '/staff', payload) },
    updateStaff(id, payload) { return this.api('POST', `/staff/${id}`, payload) },
    unlock(zoneId) { return this.api('POST', `/zones/${zoneId}/unlock`, {}) },
    updateZone(zoneId, payload) { return this.api('POST', `/zones/${zoneId}`, payload) },
    setTicket(price) { return this.api('POST', '/ticket', { price }) },
    takeLoan(amount, periods, ratePct) { return this.api('POST', '/loan', { amount, periods, ratePct }) },
    repayLoan(id) { return this.api('POST', `/loans/${id}/repay`, {}) },
    planEvent(payload) { return this.api('POST', '/events', payload) },
    resolveEvent(id) { return this.api('POST', `/events/${id}/resolve`, {}) },
    fileComplaint(payload) { return this.api('POST', '/complaints', payload) },
    assignComplaint(id, staff_id) { return this.api('POST', `/complaints/${id}/assign`, { staff_id }) },
    escalateComplaint(id) { return this.api('POST', `/complaints/${id}/escalate`, {}) },
    resolveComplaint(id, compensation) { return this.api('POST', `/complaints/${id}/resolve`, { compensation }) },
    closeComplaint(id) { return this.api('POST', `/complaints/${id}/close`, {}) },
    async complaintDetail(id) { return j('GET', `/complaints/${id}`) },
    // 分时预约（写操作携带 request_id 幂等键，重放返回首次结果不产生重复副作用）
    bookReservation(payload) { return this.api('POST', '/reservations', payload) },
    rescheduleReservation(id, slot_id, request_id) { return this.api('POST', `/reservations/${id}/reschedule`, { slot_id, request_id }) },
    cancelReservation(id, request_id) { return this.api('POST', `/reservations/${id}/cancel`, { request_id }) },
    checkinReservation(id, request_id) { return this.api('POST', `/reservations/${id}/checkin`, { request_id }) },
    updateSlot(id, payload) { return this.api('POST', `/reservation-slots/${id}`, payload) },
    async rideSlots(rideId, day) { return j('GET', `/reservation-slots?scope=ride&rideId=${rideId}${day ? `&day=${day}` : ''}`) },
    async reservationDetail(id) { return j('GET', `/reservations/${id}`) },
    // 设施检修工单
    assignMaintenance(id, staff_id) { return this.api('POST', `/maintenance/${id}/assign`, { staff_id }) },
    cancelMaintenance(id) { return this.api('POST', `/maintenance/${id}/cancel`, {}) },
    async maintenanceDetail(id) { return j('GET', `/maintenance/${id}`) },
    // 游客会员与权益中心
    registerMember(payload) { return this.api('POST', '/members', payload) },
    applyCard(id, tier, payload) { return this.api('POST', `/members/${id}/cards/${tier}`, payload) },
    memberTopup(id, amount, request_id) { return this.api('POST', `/members/${id}/topup`, { amount, request_id }) },
    redeemBenefit(id, code, request_id) { return this.api('POST', `/members/${id}/redeem/${code}`, { request_id }) },
    buyMemberTicket(id, qty, request_id) { return this.api('POST', `/members/${id}/tickets`, { qty, request_id }) },
    memberVendorSpend(id, vendorId, payload) { return this.api('POST', `/members/${id}/vendors/${vendorId}/spend`, payload) },
    freezeMember(id, frozen, reason) { return this.api('POST', `/members/${id}/freeze`, { frozen, reason }) },
    adjustMemberPoints(id, change, note) { return this.api('POST', `/members/${id}/points`, { change, note }) },
    setMemberOwner(id, staff_id) { return this.api('POST', `/members/${id}/owner`, { staff_id }) },
    saveMemberConfig(payload) { return this.api('POST', '/member-config', payload) },
    updateCardProduct(tier, payload) { return this.api('POST', `/card-products/${tier}`, payload) },
    async memberDetail(id) { return j('GET', `/members/${id}`) },
    async memberQuote(id, payload) { return j('POST', `/members/${id}/quote`, payload) },
    // 员工排班与工时结算
    scheduleShift(payload) { return this.api('POST', '/schedules', payload) },
    cancelSchedule(id, request_id) { return this.api('POST', `/schedules/${id}/cancel`, { request_id }) },
    checkinSchedule(id, request_id) { return this.api('POST', `/schedules/${id}/checkin`, { request_id }) },
    leaveAttendance(id, reason, request_id) { return this.api('POST', `/attendance/${id}/leave`, { reason, request_id }) },
    requestSwap(id, payload) { return this.api('POST', `/schedules/${id}/swap`, payload) },
    requestOvertime(id, payload) { return this.api('POST', `/schedules/${id}/overtime`, payload) },
    approveShiftRequest(id, approver_id) { return this.api('POST', `/shift-requests/${id}/approve`, { approver_id }) },
    rejectShiftRequest(id, approver_id, note) { return this.api('POST', `/shift-requests/${id}/reject`, { approver_id, note }) },
    cancelShiftRequest(id, staff_id) { return this.api('POST', `/shift-requests/${id}/cancel`, { staff_id }) },
    saveScheduleConfig(payload) { return this.api('POST', '/schedule-config', payload) },
    runDispatch(payload) { return this.api('POST', '/dispatch/run', payload || {}) },
    async coverageOf(day) { return j('GET', `/coverage/${day}`) },
    async dispatchPlanFetch() { return j('GET', '/dispatch-plan') },
    // 跨日计划预览与审批
    createDispatchPlan(payload) { return this.api('POST', '/dispatch-plans', payload) },
    async dispatchPlansList(status) { return j('GET', `/dispatch-plans?status=${status || 'pending'}`) },
    async dispatchPlanDetail(id) { return j('GET', `/dispatch-plans/${id}`) },
    approveDispatchPlan(id, approver_id, note) { return this.api('POST', `/dispatch-plans/${id}/approve`, { approver_id, note }) },
    rejectDispatchPlan(id, approver_id, note) { return this.api('POST', `/dispatch-plans/${id}/reject`, { approver_id, note }) },
    async scheduleLogs(payload) {
      const q = new URLSearchParams(Object.entries(payload).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, v])).toString()
      return j('GET', `/schedules/logs?${q}`)
    },
    // 领队组团
    submitGroup(payload) { return this.api('POST', '/groups', payload) },
    confirmGroup(id, request_id) { return this.api('POST', `/groups/${id}/confirm`, { request_id }) },
    rejectGroup(id, payload) { return this.api('POST', `/groups/${id}/reject`, payload) },
    cancelGroup(id, request_id) { return this.api('POST', `/groups/${id}/cancel`, { request_id }) },
    payGroupBalance(id, amount, request_id) { return this.api('POST', `/groups/${id}/balance`, { amount, request_id }) },
    checkinGroupItem(id, qty, request_id) { return this.api('POST', `/group-items/${id}/checkin`, { qty, request_id }) },
    refundGroupLeg(id, qty, request_id) { return this.api('POST', `/group-items/${id}/refund`, { qty, request_id }) },
    rerouteGroupItem(id, slot_id, request_id) { return this.api('POST', `/group-items/${id}/reroute`, { slot_id, request_id }) },
    refundOutageItem(id, request_id) { return this.api('POST', `/group-items/${id}/refund-outage`, { request_id }) },
    saveGroupConfig(payload) { return this.api('POST', '/group-config', payload) },
    async groupDetail(id) { return j('GET', `/groups/${id}`) },
    // 统一客流预测与资源调度闭环
    async closedLoop(horizon = 3) { return j('GET', `/closed-loop?horizon=${horizon}`) },
    runReconcile(autoHeal = true) { return this.api('POST', '/reconcile/run', { auto_heal: autoHeal }) },
    ignoreReconcile(id) { return this.api('POST', `/reconcile/${id}/ignore`, {}) },
    // 园区应急指挥：发现 / 分级 / 封控 / 疏散 / 控场 / 复园 / 复盘
    reportIncident(payload) { return this.api('POST', '/incidents', payload) },
    gradeIncident(id, payload) { return this.api('POST', `/incidents/${id}/grade`, payload) },
    lockdownIncident(id, payload) { return this.api('POST', `/incidents/${id}/lockdown`, payload) },
    startEvacuation(id, payload) { return this.api('POST', `/incidents/${id}/evacuate`, payload) },
    reportEvacuation(id, qty, staffId) { return this.api('POST', `/incidents/${id}/evacuate/progress`, { qty, staff_id: staffId, request_id: newRequestId() }) },
    controlIncident(id, payload) { return this.api('POST', `/incidents/${id}/control`, payload) },
    reopenIncident(id, payload) { return this.api('POST', `/incidents/${id}/reopen`, payload) },
    reviewIncident(id, payload) { return this.api('POST', `/incidents/${id}/review`, payload) },
    closeFalseIncident(id, payload) { return this.api('POST', `/incidents/${id}/false`, payload) },
    escalateIncidentFromComplaint(complaintId) { return this.api('POST', `/complaints/${complaintId}/escalate-incident`, { request_id: newRequestId() }) },
    assignIncidentStaff(id, staff_id, task_type, operator_id) {
      return this.api('POST', `/incidents/${id}/staff`, { staff_id, task_type, operator_id, request_id: newRequestId() })
    },
    acknowledgeIncidentStaff(linkId) { return this.api('POST', `/incident-staff/${linkId}/acknowledge`, { request_id: newRequestId() }) },
    standDownIncidentStaff(linkId) { return this.api('POST', `/incident-staff/${linkId}/stand-down`, { request_id: newRequestId() }) },
    fileIncidentClaim(id, payload) { return this.api('POST', `/incidents/${id}/claims`, payload) },
    payIncidentClaim(claimId, payload) { return this.api('POST', `/incident-claims/${claimId}/pay`, payload) },
    rejectIncidentClaim(claimId, payload) { return this.api('POST', `/incident-claims/${claimId}/reject`, payload) },
    async incidentDetail(id) { return j('GET', `/incidents/${id}`) },
    // 物资采购与库存
    saveSupplier(payload, id) { return this.api('POST', id ? `/suppliers/${id}` : '/suppliers', payload) },
    saveMaterial(payload, id) { return this.api('POST', id ? `/materials/${id}` : '/materials', payload) },
    setVendorMaterials(vendorId, material_ids) { return this.api('POST', `/vendors/${vendorId}/materials`, { material_ids }) },
    createPurchaseOrder(payload) { return this.api('POST', '/purchase-orders', payload) },
    submitPurchaseOrder(id) { return this.api('POST', `/purchase-orders/${id}/submit`, {}) },
    approvePurchaseOrder(id) { return this.api('POST', `/purchase-orders/${id}/approve`, {}) },
    rejectPurchaseOrder(id, note) { return this.api('POST', `/purchase-orders/${id}/reject`, { note }) },
    receivePurchaseOrder(id, receives, note) { return this.api('POST', `/purchase-orders/${id}/receive`, { receives, note }) },
    payPurchaseOrder(id, amount) { return this.api('POST', `/purchase-orders/${id}/pay`, { amount }) },
    purchaseReturn(payload) { return this.api('POST', '/purchase-returns', payload) },
    salesReturn(payload) { return this.api('POST', '/sales-returns', payload) },
    async purchaseOrderDetail(id) { return j('GET', `/purchase-orders/${id}`) },
    async supplierDetail(id) { return j('GET', `/suppliers/${id}`) },
    async materialMovements(id) { return j('GET', `/materials/${id}/movements`) },
    async stockBatches(query = '') { return j('GET', `/stock-batches${query}`) },
    async purchaseReturnsList(kind) { return j('GET', `/purchase-returns${kind ? `?kind=${kind}` : ''}`) },
    createStocktake(payload) { return this.api('POST', '/stocktakes', payload) },
    submitStocktake(id, actuals) { return this.api('POST', `/stocktakes/${id}/submit`, { actuals }) },
    approveStocktake(id, note) { return this.api('POST', `/stocktakes/${id}/approve`, { note }) },
    cancelStocktake(id) { return this.api('POST', `/stocktakes/${id}/cancel`, {}) },
    async stocktakeDetail(id) { return j('GET', `/stocktakes/${id}`) },
    async inventoryFindings(query = '') { return j('GET', `/inventory-findings${query}`) },
    resolveInventoryFinding(id, note) { return this.api('POST', `/inventory-findings/${id}/resolve`, { note }) },
    ignoreInventoryFinding(id, note) { return this.api('POST', `/inventory-findings/${id}/ignore`, { note }) },
    // 园区联营商户结算
    applyPartner(payload) { return this.api('POST', '/partner/applications', payload) },
    withdrawPartnerApplication(id, staff_id) { return this.api('POST', `/partner/applications/${id}/withdraw`, { staff_id }) },
    approvePartnerApplication(id, payload) { return this.api('POST', `/partner/applications/${id}/approve`, payload) },
    rejectPartnerApplication(id, payload) { return this.api('POST', `/partner/applications/${id}/reject`, payload) },
    terminatePartnerContract(id, payload) { return this.api('POST', `/partner/contracts/${id}/terminate`, payload) },
    issuePartnerSettlement(id, payload) { return this.api('POST', `/partner/contracts/${id}/settle`, payload || {}) },
    payPartnerSettlement(id, staff_id) { return this.api('POST', `/partner/settlements/${id}/pay`, { staff_id }) },
    partnerSalesReturn(saleId, payload) { return this.api('POST', `/partner/sales/${saleId}/return`, payload) },
    async partnerApplicationDetail(id) { return j('GET', `/partner/applications/${id}`) },
    async partnerContractDetail(id) { return j('GET', `/partner/contracts/${id}`) },
    async partnerSettlementDetail(id) { return j('GET', `/partner/settlements/${id}`) },
    async partnerSalesList(query = '') { return j('GET', `/partner/sales${query}`) },
    // 会员权益转赠与家庭账户
    createFamily(payload) { return this.api('POST', '/families', payload) },
    inviteFamily(id, payload) { return this.api('POST', `/families/${id}/invite`, payload) },
    leaveFamily(id, member_id) { return this.api('POST', `/families/${id}/leave`, { member_id }) },
    removeFamilyMember(id, payload) { return this.api('POST', `/families/${id}/remove`, payload) },
    dissolveFamily(id, payload) { return this.api('POST', `/families/${id}/dissolve`, payload) },
    async familyDetail(id) { return j('GET', `/families/${id}`) },
    applyGift(payload) { return this.api('POST', '/gifts', payload) },
    cancelGift(id, donor_member_id) { return this.api('POST', `/gifts/${id}/cancel`, { donor_member_id, request_id: newRequestId() }) },
    approveGift(id, staff_id) { return this.api('POST', `/gifts/${id}/approve`, { staff_id, request_id: newRequestId() }) },
    rejectGift(id, payload) { return this.api('POST', `/gifts/${id}/reject`, { ...payload, request_id: newRequestId() }) },
    claimGift(id, member_id) { return this.api('POST', `/gifts/${id}/claim`, { member_id, request_id: newRequestId() }) },
    declineGift(id, member_id) { return this.api('POST', `/gifts/${id}/decline`, { member_id, request_id: newRequestId() }) },
    recallGift(id, payload) { return this.api('POST', `/gifts/${id}/recall`, { ...payload, request_id: newRequestId() }) },
    saveGiftConfig(payload) { return this.api('POST', '/gift-config', payload) },
    async giftDetail(id) { return j('GET', `/gifts/${id}`) },
    // 供应商批次召回
    createRecall(payload) { return this.api('POST', '/recalls', payload) },
    acceptRecall(id, staff_id) { return this.api('POST', `/recalls/${id}/accept`, { staff_id }) },
    acknowledgeRecallVendor(id, vendorId, note) { return this.api('POST', `/recalls/${id}/vendors/${vendorId}/acknowledge`, { note }) },
    recallVendorRefund(id, vendorId, qty, note) { return this.api('POST', `/recalls/${id}/vendors/${vendorId}/refund`, { qty, note }) },
    recallVendorNone(id, vendorId, note) { return this.api('POST', `/recalls/${id}/vendors/${vendorId}/none`, { note }) },
    recallReturnBatches(id, qty) { return this.api('POST', `/recalls/${id}/return`, { qty }) },
    recallDestroyBatches(id, qty, note) { return this.api('POST', `/recalls/${id}/destroy`, { qty, note }) },
    async recallCompensationQuote(id) { return j('GET', `/recalls/${id}/compensation`) },
    recallPayCompensation(id, amount, note) { return this.api('POST', `/recalls/${id}/compensation`, { amount, note }) },
    closeRecall(id, note) { return this.api('POST', `/recalls/${id}/close`, { note }) },
    closeFalseRecall(id, reason) { return this.api('POST', `/recalls/${id}/false`, { reason }) },
    cancelRecall(id, reason) { return this.api('POST', `/recalls/${id}/cancel`, { reason }) },
    async recallDetail(id) { return j('GET', `/recalls/${id}`) }
  }
})