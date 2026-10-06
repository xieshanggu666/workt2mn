// 会员权益转赠与家庭账户一致性测试：
// 家庭组约束 / 申请锁定托管 / 审核发放 / 受赠领取入账 / 拒绝驳回撤回回补 /
// 券类转移核销 / 撤回已预约权益（原子取消预约释放名额+退款回补）/ 商铺消费联动 /
// 家庭池先领先得 / 到期自动回补 / 幂等 / 冻结与自赠防护 / 锁孤儿自愈（内存库隔离）
// 运行：node --test server/gifts.test.js（需 Node ≥ 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const M = await import('./members.js')
const G = await import('./gifts.js')
const RSV = await import('./reservations.js')

// ---- 共享上下文 ----
const finLogs = []
M.initMemberContext({ logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }) })
RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: () => ({ id: 1, code: 'TS0001' }),
  quoteReservation: (...a) => M.quoteReservation(...a),
  onReservationBooked: (...a) => M.onReservationBooked(...a),
  onReservationRefunded: (...a) => M.onReservationRefund(...a)
})
// 撤回已用于在途预约的转赠权益：同事务园方原因取消预约（复用退款核心，内层 tx 并入外层）
G.initGiftContext({
  cancelReservationPark: (reservationId, note) => RSV.refundReservation(reservationId, 'park', note)
})
M.bindReservationAutoBook((slot, p) => RSV.autoBookMember(slot, p))

const cash = () => Number(getSetting('cash'))
const member = id => db.prepare('SELECT * FROM members WHERE id=?').get(id)
const benefit = id => db.prepare('SELECT * FROM member_benefits WHERE id=?').get(id)
const giftRow = id => db.prepare('SELECT * FROM member_gifts WHERE id=?').get(id)
const pointRows = id => db.prepare('SELECT * FROM member_point_logs WHERE member_id=? ORDER BY id').all(id)

function mkMember(name, phone, tier = 'gold') {
  const r = M.registerMember({ name, phone })
  if (tier) M.applyCard(r.id, tier, { requestId: `card-${r.id}` })
  return r.id
}
function grantVoucher(memberId, amount = 30) {
  // 通过运营调分 + 积分兑换获得消费券
  M.adjustPoints(memberId, 1000, { note: '测试充点' })
  M.redeemPoints(memberId, 'voucher', { requestId: `rv-${memberId}` })
  return db.prepare("SELECT id FROM member_benefits WHERE member_id=? AND kind='voucher' AND status='unused' ORDER BY id DESC LIMIT 1").get(memberId).id
}
function grantTicket(memberId) {
  // 金卡开卡赠送 1 张免票券
  return db.prepare("SELECT id FROM member_benefits WHERE member_id=? AND kind='ticket' AND status='unused' ORDER BY id LIMIT 1").get(memberId).id
}

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 100000)
  setSetting('ticket', 100)
  setSetting('pointRate', 1)
  RSV.ensureSlots()
})

// ---------------- 家庭账户 ----------------
test('家庭账户：户主建组、唯一在组约束、邀请/退出/移除/解散全流程', () => {
  const a = mkMember('家庭户主', '13910000001')
  const b = mkMember('家庭成员B', '13910000002', 'silver')
  const c = mkMember('家庭成员C', '13910000003', 'none')

  const cf = G.createFamily({ memberId: a, name: '王家' })
  assert.equal(cf.ok, true)
  const fid = cf.id
  // 户主重复建组被拒
  assert.equal(G.createFamily({ memberId: a, name: '第二个' }).code, G.GIFT_CONST && 'FAMILY_ALREADY_MEMBER')
  // 户主不可退出
  assert.equal(G.leaveFamily({ familyId: fid, memberId: a }).ok, false)
  // 邀请成员
  assert.equal(G.inviteFamily({ familyId: fid, memberId: b, actorMemberId: a }).ok, true)
  assert.equal(G.inviteFamily({ familyId: fid, memberId: b, actorMemberId: a }).code, 'FAMILY_ALREADY_MEMBER')
  // 非户主邀请被拒
  assert.equal(G.inviteFamily({ familyId: fid, memberId: c, actorMemberId: b }).ok, false)
  // 运营可代操作
  assert.equal(G.inviteFamily({ familyId: fid, memberId: c, staffId: 7 }).ok, true)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM family_members WHERE family_id=? AND status='active'").get(fid).n, 3)
  // 成员退出
  assert.equal(G.leaveFamily({ familyId: fid, memberId: b }).ok, true)
  // 已不在组不可再退
  assert.equal(G.leaveFamily({ familyId: fid, memberId: b }).ok, false)
  // 户主移除
  assert.equal(G.removeFamilyMember({ familyId: fid, memberId: c, actorMemberId: a }).ok, true)
  assert.equal(G.removeFamilyMember({ familyId: fid, memberId: a, actorMemberId: a }).ok, false, '户主不可移除')
  // 解散
  assert.equal(G.dissolveFamily({ familyId: fid, actorMemberId: a }).ok, true)
  assert.equal(getFamilyStatus(fid), 'dissolved')
  // 解散后原成员可建新组
  assert.equal(G.createFamily({ memberId: b, name: '李家' }).ok, true)
})
function getFamilyStatus(id) { return db.prepare('SELECT status FROM family_groups WHERE id=?').get(id).status }

test('家庭解散：在途待领取家庭池转赠自动回补捐赠人', () => {
  const d = mkMember('池捐赠人', '13910000011')
  const e = mkMember('池成员E', '13910000012', 'silver')
  const fam = G.createFamily({ memberId: d, name: '散伙家庭' })
  G.inviteFamily({ familyId: fam.id, memberId: e, actorMemberId: d })
  // 关闭免审：制造一笔待审核 + 一笔待领取
  G.saveGiftConfig({ familyAutoApprove: 0 })
  const g1 = G.applyGift({ donorMemberId: d, target: 'family', familyId: fam.id, kind: 'points', amount: 80, requestId: 'fg-1' })
  assert.equal(g1.status, 'pending')
  G.approveGift({ giftId: g1.id, staffId: 7, requestId: 'g1-app' })
  const ptsAfterApprove = member(d).points
  // 解散：待领取积分回补
  const dis = G.dissolveFamily({ familyId: fam.id, actorMemberId: d })
  assert.equal(dis.ok, true)
  assert.equal(member(d).points, ptsAfterApprove + 80, '解散后积分回补捐赠人')
  assert.equal(giftRow(g1.id).status, 'expired')
  G.saveGiftConfig({ familyAutoApprove: 1 })
})

// ---------------- 指定转赠：积分 ----------------
test('积分转赠：申请托管 → 审核通过 → 受赠领取入账；冻结/自赠/余额不足防护', () => {
  const donor = mkMember('积分捐赠人', '13910000021')
  const recv = mkMember('积分受赠人', '13910000022', 'none')
  const donorPts = member(donor).points
  const recvPts = member(recv).points

  // 自赠被拒
  assert.equal(G.applyGift({ donorMemberId: donor, target: 'member', recipientMemberId: donor, kind: 'points', amount: 10, requestId: 'self' }).code, 'GIFT_SELF_NOT_ALLOWED')
  // 余额不足（金卡开卡 150 分，转 500 超出余额）
  assert.equal(G.applyGift({ donorMemberId: donor, target: 'member', recipientMemberId: recv, kind: 'points', amount: 500, requestId: 'poor' }).code, 'INSUFFICIENT_POINTS')
  // 冻结
  M.setFrozen(recv, true)
  assert.equal(G.applyGift({ donorMemberId: donor, target: 'member', recipientMemberId: recv, kind: 'points', amount: 10, requestId: 'fz' }).code, 'MEMBER_FROZEN')
  M.setFrozen(recv, false)

  const ap = G.applyGift({ donorMemberId: donor, target: 'member', recipientMemberId: recv, kind: 'points', amount: 100, reason: '生日快乐', requestId: 'pt-1' })
  assert.equal(ap.ok, true)
  assert.equal(ap.status, 'pending', '指定转赠默认需审核')
  assert.equal(member(donor).points, donorPts - 100, '申请即托管扣减')
  // 券类计数不影响积分；待审核期间捐赠人积分不可重复挪用（已扣减）
  // 幂等重放不重复扣
  const ap2 = G.applyGift({ donorMemberId: donor, target: 'member', recipientMemberId: recv, kind: 'points', amount: 100, requestId: 'pt-1' })
  assert.equal(ap2.replay, true)
  assert.equal(member(donor).points, donorPts - 100)

  // 非受赠人不能领（审核通过后再试，避免先命中状态校验）
  assert.equal(G.approveGift({ giftId: ap.id, staffId: 7, requestId: 'ap-0' }).ok, true)
  assert.equal(G.claimGift({ giftId: ap.id, memberId: donor, requestId: 'c-x' }).code, 'GIFT_NOT_RECIPIENT')
  // 审核幂等重放不重复发放
  assert.equal(G.approveGift({ giftId: ap.id, staffId: 7, requestId: 'ap-0' }).replay, true)
  assert.equal(giftRow(ap.id).status, 'approved')
  // 受赠领取
  const cl = G.claimGift({ giftId: ap.id, memberId: recv, requestId: 'cl-1' })
  assert.equal(cl.ok, true)
  assert.equal(member(recv).points, recvPts + 100, '领取后积分入账受赠人')
  assert.equal(giftRow(ap.id).status, 'claimed')
  // 已领取不可重复领
  assert.equal(G.claimGift({ giftId: ap.id, memberId: recv, requestId: 'cl-2' }).ok, false)
})

test('积分转赠：运营驳回与捐赠人撤回申请均回补；已领取撤回从受赠人冲回', () => {
  const d = mkMember('回补捐赠', '13910000031')
  const r1 = mkMember('驳回受赠', '13910000032', 'none')
  const base = member(d).points

  const g1 = G.applyGift({ donorMemberId: d, recipientMemberId: r1, kind: 'points', amount: 60, requestId: 'rj-1' })
  assert.equal(G.rejectGift({ giftId: g1.id, staffId: 7, reason: '风控', requestId: 'rj-x' }).ok, true)
  assert.equal(member(d).points, base, '驳回后积分回补')
  assert.equal(giftRow(g1.id).status, 'rejected')
  assert.equal(G.approveGift({ giftId: g1.id, requestId: 'rj-a' }).ok, false, '已驳回不可再审')

  // 捐赠人撤回申请
  const r2 = mkMember('撤申受赠', '13910000033', 'none')
  const g2 = G.applyGift({ donorMemberId: d, recipientMemberId: r2, kind: 'points', amount: 40, requestId: 'cx-1' })
  assert.equal(G.cancelGiftApplication({ giftId: g2.id, donorMemberId: d, requestId: 'cx-x' }).ok, true)
  assert.equal(member(d).points, base, '撤回申请后积分回补')

  // 已领取撤回：从受赠人积分冲回捐赠人
  const r3 = mkMember('撤回受赠', '13910000034', 'none')
  const g3 = G.applyGift({ donorMemberId: d, recipientMemberId: r3, kind: 'points', amount: 50, requestId: 'rc-1' })
  G.approveGift({ giftId: g3.id, staffId: 7, requestId: 'rc-a' })
  G.claimGift({ giftId: g3.id, memberId: r3, requestId: 'rc-c' })
  const dBefore = member(d).points
  assert.equal(G.recallGift({ giftId: g3.id, donorMemberId: d, requestId: 'rc-r' }).ok, true)
  assert.equal(member(d).points, dBefore + 50, '撤回回补捐赠人')
  assert.equal(member(r3).points, 0, '受赠人积分被扣回（无其他积分）')
  assert.equal(giftRow(g3.id).status, 'recalled')
  // 受赠人已消费导致积分不足：撤回拒绝（不虚报）
  const r4 = mkMember('消费受赠', '13910000035', 'none')
  const g4 = G.applyGift({ donorMemberId: d, recipientMemberId: r4, kind: 'points', amount: 70, requestId: 'rc2-1' })
  G.approveGift({ giftId: g4.id, staffId: 7, requestId: 'rc2-a' })
  G.claimGift({ giftId: g4.id, memberId: r4, requestId: 'rc2-c' })
  M.adjustPoints(r4, -member(r4).points, { note: '受赠人已用掉积分' })
  const bad = G.recallGift({ giftId: g4.id, staffId: 7, requestId: 'rc2-r' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'GIFT_RECALL_INSUFFICIENT')
})

// ---------------- 储值转赠 ----------------
test('储值转赠：托管不产生现金流水；领取后受赠人可在商铺消费（负债转收入）', () => {
  const d = mkMember('储值捐赠', '13910000041')
  const r = mkMember('储值受赠', '13910000042', 'none')
  M.topup(d, 200, { requestId: 'top-d' })
  const cash0 = cash()
  const g = G.applyGift({ donorMemberId: d, recipientMemberId: r, kind: 'balance', amount: 120, requestId: 'bal-1' })
  assert.equal(g.ok, true)
  assert.equal(cash(), cash0, '转赠托管不产生现金变动')
  assert.equal(member(d).balance, 80)
  G.approveGift({ giftId: g.id, staffId: 7, requestId: 'bal-a' })
  G.claimGift({ giftId: g.id, memberId: r, requestId: 'bal-c' })
  assert.equal(member(r).balance, 120)
  // 受赠人在商铺用转赠来的储值消费
  const v = db.prepare('SELECT * FROM vendors ORDER BY id LIMIT 1').get()
  const sp = M.vendorSpend(r, v.id, { payMethod: 'balance' })
  assert.equal(sp.ok, true)
  assert.equal(sp.balancePart, sp.bill)
  assert.ok(finLogs.some(f => f.label === '商业' && f.amount === sp.bill), '储值消费确认商业收入')
})

// ---------------- 券类转赠 + 预约名额/退款联动 ----------------
test('免票券转赠：锁定不可二转 → 领取转移 → 受赠人0元预约占用名额 → 撤回原子取消预约退款并回补', () => {
  const d = mkMember('票券捐赠', '13910000051')   // 金卡含 1 免票券
  const r = mkMember('票券受赠', '13910000052', 'none')
  const ticketId = grantTicket(d)
  assert.equal(benefit(ticketId).status, 'unused')

  const g = G.applyGift({ donorMemberId: d, recipientMemberId: r, kind: 'ticket', benefitIds: [ticketId], requestId: 'tk-1' })
  assert.equal(g.ok, true)
  assert.equal(benefit(ticketId).status, 'locked', '申请后权益锁定')
  // 锁定期间不可再转/不可用于预约
  const quoteLocked = M.quoteReservation(d, { scope: 'entry', qty: 1, benefitId: ticketId, entryPrice: 100 })
  assert.equal(quoteLocked.ok, false)
  // 同一张券不可重复申请
  const dup = G.applyGift({ donorMemberId: d, recipientMemberId: r, kind: 'ticket', benefitIds: [ticketId], requestId: 'tk-dup' })
  assert.equal(dup.ok, false)

  G.approveGift({ giftId: g.id, staffId: 7, requestId: 'tk-a' })
  // 审核通过待领取阶段仍锁定，受赠人尚未持有
  assert.equal(benefit(ticketId).status, 'locked')
  assert.equal(G.claimGift({ giftId: g.id, memberId: r, requestId: 'tk-c' }).ok, true)
  // 转移：捐赠人原券 gifted，受赠人持有新券 unused
  assert.equal(benefit(ticketId).status, 'gifted')
  const items = db.prepare('SELECT * FROM member_gift_items WHERE gift_id=?').all(g.id)
  assert.equal(items.length, 1)
  const newBn = benefit(items[0].gifted_benefit_id)
  assert.equal(newBn.member_id, r)
  assert.equal(newBn.status, 'unused')
  assert.equal(newBn.origin_member_id, d)

  // 受赠人用转赠免票券预约未来入园时段（0 元，占用名额）
  const slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=3 AND hour=11").get()
  const book = RSV.createReservation({ scope: 'entry', slotId: slot.id, qty: 1, memberId: r, benefitId: newBn.id, requestId: 'tk-book' })
  assert.equal(book.ok, true)
  assert.equal(db.prepare('SELECT amount FROM reservations WHERE id=?').get(book.id).amount, 0)
  assert.equal(benefit(newBn.id).status, 'used')
  assert.equal(db.prepare('SELECT booked_count FROM reservation_slots WHERE id=?').get(slot.id).booked_count, 1)

  // 捐赠人撤回：在途预约原子取消（园方全额退款释放名额，0 元单无现金），券返还受赠人后再回补捐赠人
  const cashBefore = cash()
  const rc = G.recallGift({ giftId: g.id, donorMemberId: d, requestId: 'tk-r' })
  assert.equal(rc.ok, true)
  assert.equal(rc.reservations_cancelled, 1)
  const rsv = db.prepare('SELECT * FROM reservations WHERE id=?').get(book.id)
  assert.equal(rsv.status, 'refunded', '关联预约已退款关闭')
  assert.equal(db.prepare('SELECT booked_count FROM reservation_slots WHERE id=?').get(slot.id).booked_count, 0, '名额已释放')
  assert.equal(cash(), cashBefore, '0 元免票券预约退款不产生现金变动')
  // 受赠人新券结回收、捐赠人原券解锁返还
  assert.equal(benefit(newBn.id).status, 'refunded')
  assert.equal(benefit(ticketId).status, 'unused', '权益最终返还捐赠人可再用')
  assert.equal(giftRow(g.id).status, 'recalled')

  // 捐赠人拿回券后可正常 0 元预约（端到端回补可用）
  const slot2 = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=3 AND hour=12").get()
  const rebook = RSV.createReservation({ scope: 'entry', slotId: slot2.id, qty: 1, memberId: d, benefitId: ticketId, requestId: 'tk-rebook' })
  assert.equal(rebook.ok, true)
})

test('消费券转赠：受赠人商铺核销后不可撤回（已核销权益保护）', () => {
  const d = mkMember('消费券捐', '13910000061', 'silver')  // 银卡含 1 消费券
  const r = mkMember('消费券受', '13910000062', 'none')
  const vid = grantVoucher(d, 30)
  const g = G.applyGift({ donorMemberId: d, recipientMemberId: r, kind: 'voucher', benefitIds: [vid], requestId: 'vc-1' })
  G.approveGift({ giftId: g.id, staffId: 7, requestId: 'vc-a' })
  G.claimGift({ giftId: g.id, memberId: r, requestId: 'vc-c' })
  const newId = db.prepare('SELECT gifted_benefit_id FROM member_gift_items WHERE gift_id=?').get(g.id).gifted_benefit_id
  const v = db.prepare('SELECT * FROM vendors ORDER BY id LIMIT 1').get()
  const sp = M.vendorSpend(r, v.id, { payMethod: 'voucher', benefitId: newId })
  assert.equal(sp.ok, true)
  assert.equal(benefit(newId).status, 'used')
  const rc = G.recallGift({ giftId: g.id, staffId: 7, requestId: 'vc-r' })
  assert.equal(rc.ok, false)
  assert.equal(rc.code, 'GIFT_USED_CANNOT_RECALL', '商铺已核销消费券不可撤回')
})

// ---------------- 家庭共享池 ----------------
test('家庭共享池：免审自动通过，池内成员先领先得，池外成员不可领', () => {
  const h = mkMember('池户主', '13910000071')
  const m1 = mkMember('池成员一', '13910000072', 'none')
  const m2 = mkMember('池成员二', '13910000073', 'none')
  const outsider = mkMember('池外人', '13910000074', 'none')
  const fam = G.createFamily({ memberId: h, name: '共享池家庭' })
  G.inviteFamily({ familyId: fam.id, memberId: m1, actorMemberId: h })
  G.inviteFamily({ familyId: fam.id, memberId: m2, actorMemberId: h })

  const g = G.applyGift({ donorMemberId: h, target: 'family', familyId: fam.id, kind: 'points', amount: 90, requestId: 'pool-1' })
  assert.equal(g.ok, true)
  assert.equal(g.auto_approved, 1, '家庭池免审自动通过')
  assert.equal(giftRow(g.id).status, 'approved')
  // 池外人不可领
  assert.equal(G.claimGift({ giftId: g.id, memberId: outsider, requestId: 'pool-out' }).code, 'GIFT_NOT_FOUND')
  // 先领先得
  const before1 = member(m1).points
  assert.equal(G.claimGift({ giftId: g.id, memberId: m1, requestId: 'pool-c1' }).ok, true)
  assert.equal(member(m1).points, before1 + 90)
  assert.equal(giftRow(g.id).recipient_member_id, m1)
  // 第二名成员再领已被领走
  assert.equal(G.claimGift({ giftId: g.id, memberId: m2, requestId: 'pool-c2' }).ok, false)

  // 非家庭成员不能向该池转赠
  assert.equal(G.applyGift({ donorMemberId: outsider, target: 'family', familyId: fam.id, kind: 'points', amount: 10, requestId: 'pool-x' }).ok, false)
})

// ---------------- 拒绝 / 到期 ----------------
test('受赠人拒绝与到期未领自动回补', () => {
  const d = mkMember('拒绝捐赠', '13910000081')
  const r = mkMember('拒绝受赠', '13910000082', 'none')
  const base = member(d).points

  const g1 = G.applyGift({ donorMemberId: d, recipientMemberId: r, kind: 'points', amount: 30, requestId: 'dc-1' })
  G.approveGift({ giftId: g1.id, staffId: 7, requestId: 'dc-a' })
  assert.equal(G.declineGift({ giftId: g1.id, memberId: r, requestId: 'dc-d' }).ok, true)
  assert.equal(member(d).points, base, '拒绝后回补捐赠人')
  assert.equal(giftRow(g1.id).status, 'declined')

  // 到期未领
  const g2 = G.applyGift({ donorMemberId: d, recipientMemberId: r, kind: 'points', amount: 25, requestId: 'ex-1' })
  G.approveGift({ giftId: g2.id, staffId: 7, requestId: 'ex-a' })
  const deadline = giftRow(g2.id).claim_deadline_day
  const n = G.sweepExpiredGifts(deadline + 1)
  assert.equal(n >= 1, true)
  assert.equal(giftRow(g2.id).status, 'expired')
  assert.equal(member(d).points, base, '到期回补后捐赠人积分还原')
})

// ---------------- 巡检自愈 ----------------
test('一致性巡检：锁定权益残留（无在途转赠单引用）自动解锁自愈', () => {
  const d = mkMember('巡检捐赠', '13910000091')
  const r = mkMember('巡检受赠', '13910000092', 'none')
  const ticketId = grantTicket(d)
  const g = G.applyGift({ donorMemberId: d, recipientMemberId: r, kind: 'ticket', benefitIds: [ticketId], requestId: 'heal-1' })
  assert.equal(g.ok, true, `转赠申请应成功：${g.code || ''} ${g.msg || ''}`)
  assert.equal(benefit(ticketId).status, 'locked')
  // 异常场景：转赠单被外部置为关闭态但券未解锁（模拟状态漂移）
  db.prepare("UPDATE member_gifts SET status='rejected' WHERE id=?").run(g.id)
  db.prepare("UPDATE member_gift_items SET status='returned' WHERE gift_id=?").run(g.id)
  const rep = G.reconcileGifts()
  assert.equal(rep.ok, true)
  assert.equal(rep.healedCount >= 1, true, '锁孤儿被自愈')
  assert.equal(benefit(ticketId).status, 'unused', '残留锁已解锁')
})
