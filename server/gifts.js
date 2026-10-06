import db, { getSetting, setSetting, tx } from './db.js'

// 会员权益转赠与家庭账户：
// 会员发起转赠（指定受赠人 / 家庭共享池）→ 运营审核（家庭池可免审自动通过）
//   → 发放待领取 → 受赠人领取入账 → 预约名额/商铺消费/积分储值核销 → 捐赠人/运营撤回（未用返还）
//   → 受赠人拒绝 / 到期未领自动回补捐赠人。
// 一致性：券类权益申请即逐张锁定（不可重复转赠/核销），积分储值申请即托管扣减；
// 全部多步写入包裹事务 + request_id 幂等；撤回已预约权益时同事务原子取消预约释放名额（园方全额退款），
// 预约退款既有的积分回退/券返还联动自然回流受赠人，再把权益返还捐赠人。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

export const GIFT_ERR = {
  NOT_FOUND: 'GIFT_NOT_FOUND',
  FAMILY_NOT_FOUND: 'FAMILY_NOT_FOUND',
  BAD_STATE: 'GIFT_BAD_STATE',
  BAD_ARG: 'GIFT_BAD_ARGUMENT',
  DISABLED: 'GIFT_DISABLED',
  FROZEN: 'MEMBER_FROZEN',
  SELF_GIFT: 'GIFT_SELF_NOT_ALLOWED',
  NOT_DONOR: 'GIFT_NOT_DONOR',
  NOT_RECIPIENT: 'GIFT_NOT_RECIPIENT',
  NOT_HEAD: 'FAMILY_NOT_HEAD',
  FAMILY_FULL: 'FAMILY_FULL',
  ALREADY_IN_FAMILY: 'FAMILY_ALREADY_MEMBER',
  HEAD_LEAVE: 'FAMILY_HEAD_CANNOT_LEAVE',
  TIER_LOCKED: 'GIFT_TIER_LOCKED',
  INSUF_POINTS: 'INSUFFICIENT_POINTS',
  INSUF_BALANCE: 'INSUFFICIENT_BALANCE',
  BENEFIT_NOT_FOUND: 'BENEFIT_NOT_FOUND',
  BENEFIT_UNUSABLE: 'BENEFIT_UNUSABLE',
  BENEFIT_MISMATCH: 'BENEFIT_SCOPE_MISMATCH',
  TOO_MANY_ITEMS: 'GIFT_TOO_MANY_ITEMS',
  USED_NO_RECALL: 'GIFT_USED_CANNOT_RECALL',
  INSUF_RECALL: 'GIFT_RECALL_INSUFFICIENT',
  TX_FAILED: 'TX_FAILED'
}

const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })
class TxError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra }
}
function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxError) return fail(e.code, e.message, e.extra)
    // SQLite 约束冲突（并发下家庭成员唯一索引等）：归一化为业务错误
    if (String(e?.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
      return fail(GIFT_ERR.ALREADY_IN_FAMILY, '该会员已在一个家庭账户中，不可重复加入')
    }
    console.error('[gifts] 事务执行失败，已整体回滚:', e)
    return fail(GIFT_ERR.TX_FAILED, '转赠系统繁忙，本次操作未生效，请稍后重试')
  }
}
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== GIFT_ERR.TX_FAILED) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  // 由 index.js 注入：撤回已用于在途预约的转赠权益时，原子取消预约（园方全额退款、释放名额、券返还）
  cancelReservationPark: null
}
export function initGiftContext(deps = {}) { Object.assign(ctx, deps) }

const TIER_RANK = { none: 0, silver: 1, gold: 2, diamond: 3 }
const BENEFIT_KINDS = ['ticket', 'voucher', 'fastpass']
const KIND_NAME = { points: '积分', balance: '储值', ticket: '免票券', voucher: '消费券', fastpass: '快速通行券' }
const KIND_ICON = { points: '⭐', balance: '💰', ticket: '🎟️', voucher: '🧧', fastpass: '⚡' }
const STATUS_NAME = {
  pending: '待审核', approved: '待领取', claimed: '已领取', declined: '已拒绝',
  rejected: '已驳回', cancelled: '已撤回申请', recalled: '已撤回', expired: '已过期回补'
}

function cfgEnabled() { return String(getSetting('memberEnabled', '1')) === '1' && String(getSetting('giftEnabled', '1')) === '1' }
function cfgAutoApproveFamily() { return num(getSetting('giftFamilyAutoApprove'), 1) ? 1 : 0 }
function cfgClaimDays() { return Math.max(1, Math.round(num(getSetting('giftClaimDays'), 7))) }
function cfgMaxItems() { return Math.max(1, Math.round(num(getSetting('giftMaxItems'), 20))) }
function cfgMinTierRank() { return TIER_RANK[String(getSetting('giftMinTier', 'none') || 'none')] ?? 0 }

function getMember(id) { return db.prepare('SELECT * FROM members WHERE id=?').get(id) }
function getGift(id) { return db.prepare('SELECT * FROM member_gifts WHERE id=?').get(id) }
function getFamily(id) { return db.prepare('SELECT * FROM family_groups WHERE id=?').get(id) }
function getBenefit(id) { return db.prepare('SELECT * FROM member_benefits WHERE id=?').get(id) }

function assertActiveMember(id) {
  const m = getMember(num(id))
  if (!m) throw new TxError(GIFT_ERR.NOT_FOUND, '会员不存在')
  if (m.status === 'frozen') throw new TxError(GIFT_ERR.FROZEN, '该会员账户已冻结，暂不可进行转赠/领取操作')
  return m
}
function effectiveTierRank(member) {
  if (member.card_tier === 'none' || !member.card_tier || member.card_expire_day < ctx.day()) return 0
  return TIER_RANK[member.card_tier] ?? 0
}

function logGift(giftId, action, { note = '', actorRole = 'operations', actorMemberId = null, staffId = null } = {}) {
  db.prepare(`INSERT INTO member_gift_logs(gift_id,tick,day,hour,action,actor_role,actor_member_id,staff_id,note)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(giftId, ctx.tick(), ctx.day(), ctx.hour(), action, actorRole, actorMemberId, staffId, note)
}
function logFamily(familyId, action, { memberId = null, note = '', staffId = null } = {}) {
  db.prepare(`INSERT INTO family_logs(family_id,member_id,tick,day,hour,action,note,staff_id)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(familyId, memberId, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}
function logMember(memberId, action, note = '', staffId = null) {
  db.prepare('INSERT INTO member_logs(member_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(memberId, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}

// 积分变动（与会员中心同口径）：余额不为负，total_points 仅累计正向获取
function changePoints(memberId, delta, note = '') {
  const m = getMember(memberId)
  if (!m) throw new TxError(GIFT_ERR.NOT_FOUND, '会员不存在')
  const after = Math.max(0, m.points + delta)
  const real = after - m.points
  db.prepare('UPDATE members SET points=?, total_points=total_points+? WHERE id=?')
    .run(after, real > 0 ? real : 0, memberId)
  db.prepare(`INSERT INTO member_point_logs(member_id,change,balance_after,source,ref_type,ref_id,day,tick,note)
              VALUES(?,?,?, 'gift','gift',NULL,?,?,?)`)
    .run(memberId, real, after, ctx.day(), ctx.tick(), note)
  return { change: real, after }
}

// ---------------- 家庭账户 ----------------
export function createFamily({ memberId, name = '', note = '' } = {}) {
  if (!cfgEnabled()) return fail(GIFT_ERR.DISABLED, '转赠/家庭账户功能已停用')
  const nm = String(name || '').trim().slice(0, 20) || '我的家庭'
  return runAtomic(() => {
    const m = assertActiveMember(memberId)
    const inFam = db.prepare("SELECT family_id FROM family_members WHERE member_id=? AND status='active'").get(m.id)
    if (inFam) throw new TxError(GIFT_ERR.ALREADY_IN_FAMILY, '该会员已在一个家庭账户中，请先退出原家庭')
    const r = db.prepare(`INSERT INTO family_groups(code,name,head_member_id,status,member_count,note,create_day,create_tick)
                          VALUES(?,?,?, 'active',1,?,?,?)`)
      .run('', nm, m.id, String(note || '').slice(0, 100), ctx.day(), ctx.tick())
    const id = Number(r.lastInsertRowid)
    const code = 'JT' + String(id).padStart(4, '0')
    db.prepare('UPDATE family_groups SET code=? WHERE id=?').run(code, id)
    db.prepare(`INSERT INTO family_members(family_id,member_id,role,status,join_day,join_tick)
                VALUES(?,?,'head','active',?,?)`).run(id, m.id, ctx.day(), ctx.tick())
    logFamily(id, 'create', { memberId: m.id, note: `创建家庭账户「${nm}」` })
    logMember(m.id, 'gift', `创建家庭账户「${nm}」（${code}）并成为户主`)
    return { ok: true, id, code }
  })
}

// 邀请成员：户主或运营（staffId 非空）可操作
export function inviteFamily({ familyId, memberId, actorMemberId = null, staffId = null } = {}) {
  return runAtomic(() => {
    const fam = getFamily(num(familyId))
    if (!fam || fam.status !== 'active') throw new TxError(GIFT_ERR.FAMILY_NOT_FOUND, '家庭账户不存在或已解散')
    if (!staffId && fam.head_member_id !== num(actorMemberId)) {
      throw new TxError(GIFT_ERR.NOT_HEAD, '仅户主可邀请家庭成员（运营人员可代为操作）')
    }
    const target = assertActiveMember(memberId)
    if (target.id === fam.head_member_id) throw new TxError(GIFT_ERR.BAD_ARG, '该会员已是本家庭户主')
    const exists = db.prepare("SELECT id FROM family_members WHERE family_id=? AND member_id=? AND status='active'")
      .get(fam.id, target.id)
    if (exists) throw new TxError(GIFT_ERR.ALREADY_IN_FAMILY, '该会员已在本家庭中')
    db.prepare(`INSERT INTO family_members(family_id,member_id,role,status,join_day,join_tick)
                VALUES(?,?,'member','active',?,?)`).run(fam.id, target.id, ctx.day(), ctx.tick())
    db.prepare('UPDATE family_groups SET member_count=member_count+1 WHERE id=?').run(fam.id)
    logFamily(fam.id, 'invite', { memberId: target.id, staffId, note: `邀请 ${target.name} 加入家庭` })
    logMember(target.id, 'gift', `加入家庭账户「${fam.name}」（${fam.code}）`, staffId)
    return { ok: true }
  })
}

function loadActiveFamily(familyId, memberId) {
  const row = db.prepare("SELECT * FROM family_members WHERE family_id=? AND member_id=? AND status='active'")
    .get(num(familyId), num(memberId))
  if (!row) throw new TxError(GIFT_ERR.NOT_FOUND, '该会员不在此家庭账户中')
  return row
}

// 成员主动退出（户主不可退出，需先解散）
export function leaveFamily({ familyId, memberId } = {}) {
  return runAtomic(() => {
    const fam = getFamily(num(familyId))
    if (!fam || fam.status !== 'active') throw new TxError(GIFT_ERR.FAMILY_NOT_FOUND, '家庭账户不存在或已解散')
    const fm = loadActiveFamily(fam.id, memberId)
    if (fm.role === 'head') throw new TxError(GIFT_ERR.HEAD_LEAVE, '户主不可直接退出，请解散家庭账户')
    db.prepare("UPDATE family_members SET status='left', leave_day=?, leave_tick=? WHERE id=?")
      .run(ctx.day(), ctx.tick(), fm.id)
    db.prepare('UPDATE family_groups SET member_count=MAX(1,member_count-1) WHERE id=?').run(fam.id)
    logFamily(fam.id, 'leave', { memberId: fm.member_id, note: '成员主动退出家庭' })
    logMember(fm.member_id, 'gift', `退出家庭账户「${fam.name}」`)
    return { ok: true }
  })
}

// 户主/运营移除成员
export function removeFamilyMember({ familyId, memberId, actorMemberId = null, staffId = null } = {}) {
  return runAtomic(() => {
    const fam = getFamily(num(familyId))
    if (!fam || fam.status !== 'active') throw new TxError(GIFT_ERR.FAMILY_NOT_FOUND, '家庭账户不存在或已解散')
    if (!staffId && fam.head_member_id !== num(actorMemberId)) {
      throw new TxError(GIFT_ERR.NOT_HEAD, '仅户主可移除家庭成员（运营人员可代为操作）')
    }
    const fm = loadActiveFamily(fam.id, memberId)
    if (fm.role === 'head') throw new TxError(GIFT_ERR.BAD_ARG, '户主不可被移除，如需注销请解散家庭账户')
    db.prepare("UPDATE family_members SET status='left', leave_day=?, leave_tick=? WHERE id=?")
      .run(ctx.day(), ctx.tick(), fm.id)
    db.prepare('UPDATE family_groups SET member_count=MAX(1,member_count-1) WHERE id=?').run(fam.id)
    logFamily(fam.id, 'remove', { memberId: fm.member_id, staffId, note: '成员被移出家庭' })
    logMember(fm.member_id, 'gift', `被移出家庭账户「${fam.name}」`, staffId)
    return { ok: true }
  })
}

// 解散家庭：在途（待审核/待领取）的家庭池转赠单同事务自动回补捐赠人；已领取的不受影响
export function dissolveFamily({ familyId, actorMemberId = null, staffId = null } = {}) {
  return runAtomic(() => {
    const fam = getFamily(num(familyId))
    if (!fam || fam.status !== 'active') throw new TxError(GIFT_ERR.FAMILY_NOT_FOUND, '家庭账户不存在或已解散')
    if (!staffId && fam.head_member_id !== num(actorMemberId)) {
      throw new TxError(GIFT_ERR.NOT_HEAD, '仅户主可解散家庭账户（运营人员可代为操作）')
    }
    // 在途家庭池转赠：待审核按撤回申请处理、待领取按过期回补处理，积分/储值/券全部返还捐赠人
    const pending = db.prepare("SELECT * FROM member_gifts WHERE family_id=? AND status='pending'").all(fam.id)
    for (const g of pending) returnToDonor(g, 'cancelled', { note: '家庭账户解散，待审核转赠自动回补', actorRole: 'system' })
    const approved = db.prepare("SELECT * FROM member_gifts WHERE family_id=? AND status='approved'").all(fam.id)
    for (const g of approved) returnToDonor(g, 'expired', { note: '家庭账户解散，待领取转赠自动回补', actorRole: 'system' })

    db.prepare("UPDATE family_members SET status='left', leave_day=?, leave_tick=? WHERE family_id=? AND status='active'")
      .run(ctx.day(), ctx.tick(), fam.id)
    db.prepare("UPDATE family_groups SET status='dissolved', member_count=0, dissolve_day=?, dissolve_tick=? WHERE id=?")
      .run(ctx.day(), ctx.tick(), fam.id)
    logFamily(fam.id, 'dissolve', { memberId: fam.head_member_id, staffId, note: '家庭账户解散' })
    logMember(fam.head_member_id, 'gift', `解散家庭账户「${fam.name}」，在途家庭共享转赠已回补各捐赠人`, staffId)
    return { ok: true, returned: pending.length + approved.length }
  })
}

function familyMemberIds(familyId) {
  return db.prepare("SELECT member_id FROM family_members WHERE family_id=? AND status='active'").all(familyId).map(r => r.member_id)
}

function enrichFamily(f) {
  const members = db.prepare(`SELECT fm.*, m.code member_code, m.name member_name, m.card_tier, m.status member_status
                              FROM family_members fm JOIN members m ON m.id=fm.member_id
                              WHERE fm.family_id=? ORDER BY fm.role DESC, fm.id`).all(f.id)
  const head = members.find(x => x.role === 'head')
  return {
    ...f,
    head_name: head?.member_name || '',
    members: members.map(x => ({ ...x, active_now: x.status === 'active' })),
    active_members: members.filter(x => x.status === 'active'),
    pending_gifts: db.prepare("SELECT COUNT(*) n FROM member_gifts WHERE family_id=? AND status IN ('pending','approved')").get(f.id).n
  }
}

export function listFamilies({ status = null, memberId = null, q = '', limit = 100 } = {}) {
  const conds = [], vals = []
  if (status && status !== 'all') { conds.push('g.status=?'); vals.push(status) }
  else { conds.push("g.status='active'") }
  if (memberId) {
    conds.push('EXISTS(SELECT 1 FROM family_members fm WHERE fm.family_id=g.id AND fm.member_id=? AND fm.status=\'active\')')
    vals.push(memberId)
  }
  if (q) { conds.push('(g.name LIKE ? OR g.code LIKE ?)'); vals.push(`%${q}%`, `%${q}%`) }
  const rows = db.prepare(`SELECT g.* FROM family_groups g WHERE ${conds.join(' AND ')} ORDER BY g.id DESC LIMIT ?`)
    .all(...vals, num(limit, 100))
  return rows.map(enrichFamily)
}
export function familyDetail(id) {
  const f = getFamily(id)
  if (!f) return null
  const d = enrichFamily(f)
  d.logs = db.prepare('SELECT * FROM family_logs WHERE family_id=? ORDER BY id').all(id)
  d.gifts = db.prepare('SELECT * FROM member_gifts WHERE family_id=? ORDER BY id DESC LIMIT 50').all(id)
    .map(g => ({ ...g, kind_name: KIND_NAME[g.kind], status_name: STATUS_NAME[g.status] }))
  return d
}

// ---------------- 转赠申请 ----------------
// payload:
//   target 'member'|'family'；recipientMemberId（member）/ familyId（family）
//   kind points/balance（amount）或 ticket/voucher/fastpass（benefitIds 逐张）
export function applyGift(payload = {}) {
  if (!cfgEnabled()) return fail(GIFT_ERR.DISABLED, '权益转赠功能已停用')
  return idempotent('gift_apply', payload.requestId, () => runAtomic(() => {
    const donor = assertActiveMember(payload.donorMemberId)
    if (effectiveTierRank(donor) < cfgMinTierRank()) {
      throw new TxError(GIFT_ERR.TIER_LOCKED, '当前会员等级不满足转赠门槛，请到会员中心办理对应卡种')
    }
    const kind = String(payload.kind || '')
    if (!KIND_NAME[kind]) throw new TxError(GIFT_ERR.BAD_ARG, '转赠内容类型无效')
    const target = payload.target === 'family' ? 'family' : 'member'

    let recipient = null, family = null
    if (target === 'member') {
      recipient = assertActiveMember(payload.recipientMemberId)
      if (recipient.id === donor.id) throw new TxError(GIFT_ERR.SELF_GIFT, '不可向自己转赠权益')
    } else {
      family = getFamily(num(payload.familyId))
      if (!family || family.status !== 'active') throw new TxError(GIFT_ERR.FAMILY_NOT_FOUND, '家庭账户不存在或已解散')
      loadActiveFamily(family.id, donor.id)   // 仅家庭成员可向家庭共享池转赠
    }

    let qty = 1, amount = 0
    const benefitIds = Array.isArray(payload.benefitIds) ? payload.benefitIds.map(x => num(x)).filter(Boolean) : []
    if (kind === 'points') {
      amount = Math.round(num(payload.amount))
      if (amount < 1 || amount > 100000) throw new TxError(GIFT_ERR.BAD_ARG, '转赠积分需在 1 ~ 100,000 之间')
      if (donor.points < amount) throw new TxError(GIFT_ERR.INSUF_POINTS, `积分余额不足，转赠需 ${amount} 积分（当前 ${donor.points}）`)
    } else if (kind === 'balance') {
      amount = Math.round(num(payload.amount))
      if (amount < 10 || amount > 50000) throw new TxError(GIFT_ERR.BAD_ARG, '转赠储值需在 ¥10 ~ ¥50,000 之间')
      if (donor.balance < amount) throw new TxError(GIFT_ERR.INSUF_BALANCE, `储值余额不足，转赠需 ¥${amount}（当前 ¥${donor.balance}）`)
    } else {
      if (!benefitIds.length) throw new TxError(GIFT_ERR.BAD_ARG, '请选择要转赠的券类权益')
      if (benefitIds.length > cfgMaxItems()) throw new TxError(GIFT_ERR.TOO_MANY_ITEMS, `单笔转赠最多 ${cfgMaxItems()} 张`)
      if (new Set(benefitIds).size !== benefitIds.length) throw new TxError(GIFT_ERR.BAD_ARG, '转赠权益存在重复选择')
      qty = benefitIds.length
    }
    const reason = String(payload.reason || '').slice(0, 100)

    // 建转赠单
    const gr = db.prepare(`INSERT INTO member_gifts
        (code,donor_member_id,recipient_member_id,family_id,target,kind,qty,amount,status,reason,create_day,create_tick)
        VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)`)
      .run('', donor.id, recipient?.id ?? null, family?.id ?? null, target, kind, qty,
        kind === 'voucher' ? 0 : amount, reason, ctx.day(), ctx.tick())
    const giftId = Number(gr.lastInsertRowid)
    const code = 'ZZ' + String(giftId).padStart(4, '0')
    db.prepare('UPDATE member_gifts SET code=? WHERE id=?').run(code, giftId)

    // 托管：积分/储值申请即扣减（驳回/撤回/过期同口径返还）；券类逐张锁定
    if (kind === 'points') {
      changePoints(donor.id, -amount, `转赠 ${code} 申请托管（${target === 'family' ? '家庭共享池' : `受赠人 ${recipient.name}`}）`)
    } else if (kind === 'balance') {
      const u = db.prepare('UPDATE members SET balance=balance-? WHERE id=? AND balance>=?').run(amount, donor.id, amount)
      if (u.changes === 0) throw new TxError(GIFT_ERR.INSUF_BALANCE, '储值余额不足，转赠未提交')
      logMember(donor.id, 'gift', `转赠储值 ¥${amount}（${code}）申请已提交，金额托管中`)
    } else {
      let sumAmount = 0
      benefitIds.forEach((bid, i) => {
        const bn = getBenefit(bid)
        if (!bn || bn.member_id !== donor.id) throw new TxError(GIFT_ERR.BENEFIT_NOT_FOUND, '转赠权益不存在或不属于该会员')
        if (bn.kind !== kind) throw new TxError(GIFT_ERR.BENEFIT_MISMATCH, `所选权益不全是「${KIND_NAME[kind]}」`)
        if (bn.status !== 'unused') throw new TxError(GIFT_ERR.BENEFIT_UNUSABLE, '存在已核销/已锁定/已返还的权益，不可转赠')
        if (bn.expire_day < ctx.day()) throw new TxError(GIFT_ERR.BENEFIT_UNUSABLE, '存在已过期权益，不可转赠')
        const lu = db.prepare("UPDATE member_benefits SET status='locked', gift_id=?, gift_item_id=NULL WHERE id=? AND status='unused'")
          .run(giftId, bn.id)
        if (lu.changes === 0) throw new TxError(GIFT_ERR.BENEFIT_UNUSABLE, '权益已被其他操作占用，请刷新后重试')
        db.prepare('INSERT INTO member_gift_items(gift_id,seq,benefit_id,amount,status) VALUES(?,?,?,?,\'locked\')')
          .run(giftId, i, bn.id, bn.amount)
        sumAmount += num(bn.amount)
      })
      if (kind === 'voucher') db.prepare('UPDATE member_gifts SET amount=? WHERE id=?').run(sumAmount, giftId)
      db.prepare('UPDATE member_gifts SET benefit_count=? WHERE id=?').run(benefitIds.length, giftId)
      logMember(donor.id, 'gift', `转赠 ${KIND_NAME[kind]}×${qty}（${code}）申请已提交，权益已锁定待运营审核`)
    }
    logGift(giftId, 'apply', { actorRole: 'donor', actorMemberId: donor.id, note: reason || '发起转赠申请' })

    // 家庭共享池 + 免审开关：同一事务内自动审核通过，进入待领取
    let auto = false
    if (target === 'family' && cfgAutoApproveFamily()) {
      doApprove(getGift(giftId), { auto: true })
      auto = true
    }
    return { ok: true, id: giftId, code, status: auto ? 'approved' : 'pending', auto_approved: auto ? 1 : 0 }
  }))
}

// 捐赠人撤回待审核申请
export function cancelGiftApplication({ giftId, donorMemberId, requestId = '' } = {}) {
  return idempotent('gift_cancel', requestId, () => runAtomic(() => {
    const g = getGift(num(giftId))
    if (!g) throw new TxError(GIFT_ERR.NOT_FOUND, '转赠单不存在')
    if (g.donor_member_id !== num(donorMemberId)) throw new TxError(GIFT_ERR.NOT_DONOR, '仅捐赠人可撤回申请')
    if (g.status !== 'pending') throw new TxError(GIFT_ERR.BAD_STATE, '当前状态不可撤回申请（审核完成后请使用撤回）')
    return returnToDonor(g, 'cancelled', { actorRole: 'donor', actorMemberId: g.donor_member_id, note: '捐赠人撤回转赠申请' })
  }))
}

// 审核通过（核心，不包幂等，供 apply 自动审核与 API 复用）
function doApprove(g, { auto = false, staffId = null } = {}) {
  const u = db.prepare("UPDATE member_gifts SET status='approved', auto_approved=?, staff_id=?, review_day=?, review_tick=?, claim_deadline_day=? WHERE id=? AND status='pending'")
    .run(auto ? 1 : 0, staffId, ctx.day(), ctx.tick(), ctx.day() + cfgClaimDays(), g.id)
  if (u.changes === 0) throw new TxError(GIFT_ERR.BAD_STATE, '转赠单状态已变化，审核未执行，请刷新后重试')
  const note = auto ? '家庭共享池转赠免审自动通过' : '运营审核通过，等待受赠人领取'
  logGift(g.id, auto ? 'auto_approve' : 'approve', { actorRole: 'operations', staffId, note })
  logMember(g.donor_member_id, 'gift', `转赠单 ${g.code} 审核通过，${g.target === 'family' ? '已进入家庭共享池' : '待受赠人领取'}`, staffId)
  return { ok: true }
}
export function approveGift({ giftId, staffId = null, requestId = '' } = {}) {
  return idempotent('gift_approve', requestId, () => runAtomic(() => {
    const g = getGift(num(giftId))
    if (!g) throw new TxError(GIFT_ERR.NOT_FOUND, '转赠单不存在')
    if (g.status !== 'pending') throw new TxError(GIFT_ERR.BAD_STATE, '该转赠单不在待审核状态')
    return doApprove(g, { staffId })
  }))
}

// 运营驳回：托管积分/储值与锁定券全部返还捐赠人
export function rejectGift({ giftId, staffId = null, reason = '', requestId = '' } = {}) {
  return idempotent('gift_reject', requestId, () => runAtomic(() => {
    const g = getGift(num(giftId))
    if (!g) throw new TxError(GIFT_ERR.NOT_FOUND, '转赠单不存在')
    if (g.status !== 'pending') throw new TxError(GIFT_ERR.BAD_STATE, '该转赠单不在待审核状态，不可驳回')
    return returnToDonor(g, 'rejected', {
      staffId, note: `运营驳回${reason ? '：' + String(reason).slice(0, 100) : ''}`
    })
  }))
}

// 回补捐赠人（驳回/撤回/拒绝/过期/解散）：积分储值返还、券解锁；调用方须已校验状态
function returnToDonor(g, closeStatus, { note = '', actorRole = 'operations', actorMemberId = null, staffId = null } = {}) {
  const donorId = g.donor_member_id
  if (g.kind === 'points') {
    changePoints(donorId, g.amount, `转赠单 ${g.code} 回补积分（${STATUS_NAME[closeStatus] || closeStatus}）`)
  } else if (g.kind === 'balance') {
    db.prepare('UPDATE members SET balance=balance+? WHERE id=?').run(g.amount, donorId)
  }
  // 待领取/待审核阶段：明细仍为 locked，捐赠人原权益处于 locked → 解锁
  const items = db.prepare('SELECT * FROM member_gift_items WHERE gift_id=? AND status=?').all(g.id, 'locked')
  for (const it of items) {
    db.prepare("UPDATE member_benefits SET status='unused', gift_id=NULL, gift_item_id=NULL WHERE id=? AND status='locked'")
      .run(it.benefit_id)
    db.prepare("UPDATE member_gift_items SET status='returned', note=? WHERE id=?").run(note.slice(0, 100), it.id)
  }
  db.prepare(`UPDATE member_gifts SET status=?, reject_reason=?, close_day=?, close_tick=?, close_note=?,
              review_tick=CASE WHEN review_tick=0 THEN ? ELSE review_tick END
              WHERE id=?`)
    .run(closeStatus, closeStatus === 'rejected' ? note.slice(0, 100) : g.reject_reason,
      ctx.day(), ctx.tick(), note.slice(0, 100), ctx.tick(), g.id)
  const actionMap = { cancelled: 'cancel', rejected: 'reject', declined: 'decline', expired: 'expire', recalled: 'recall' }
  logGift(g.id, actionMap[closeStatus] || 'cancel', { actorRole, actorMemberId, staffId, note })
  logMember(donorId, 'gift', `转赠单 ${g.code} ${STATUS_NAME[closeStatus] || closeStatus}，${g.kind === 'points' ? `${g.amount} 积分` : g.kind === 'balance' ? `储值 ¥${g.amount}` : `${g.benefit_count || g.qty} 张${KIND_NAME[g.kind]}`}已回补`, staffId)
  return { ok: true }
}

// 受赠人领取（member：本人；family：任意在组成员，先领先得，整包领取）
export function claimGift({ giftId, memberId, requestId = '' } = {}) {
  return idempotent('gift_claim', requestId, () => runAtomic(() => {
    const g = getGift(num(giftId))
    if (!g) throw new TxError(GIFT_ERR.NOT_FOUND, '转赠单不存在')
    if (g.status !== 'approved') throw new TxError(GIFT_ERR.BAD_STATE, '该转赠单不在可领取状态（可能已被领取/撤回/过期）')
    const claimer = assertActiveMember(memberId)
    if (g.target === 'member') {
      if (g.recipient_member_id !== claimer.id) throw new TxError(GIFT_ERR.NOT_RECIPIENT, '仅指定受赠人本人可领取')
    } else {
      loadActiveFamily(g.family_id, claimer.id)
    }

    // 积分/储值入账受赠人
    if (g.kind === 'points') {
      changePoints(claimer.id, g.amount, `领取转赠单 ${g.code}（捐赠人 #${g.donor_member_id}）`)
    } else if (g.kind === 'balance') {
      db.prepare('UPDATE members SET balance=balance+? WHERE id=?').run(g.amount, claimer.id)
    } else {
      // 券类：捐赠人原权益置 gifted，受赠人名下生成同面额/同到期日新权益
      const items = db.prepare('SELECT * FROM member_gift_items WHERE gift_id=? ORDER BY seq').all(g.id)
      for (const it of items) {
        if (it.status !== 'locked') throw new TxError(GIFT_ERR.BAD_STATE, '转赠权益状态异常，请联系运营核对')
        const src = getBenefit(it.benefit_id)
        if (!src || src.member_id !== g.donor_member_id || src.status !== 'locked') {
          throw new TxError(GIFT_ERR.BENEFIT_UNUSABLE, '待转赠权益已不可用（可能已过期或被处置），请联系运营')
        }
        const r = db.prepare(`INSERT INTO member_benefits(member_id,kind,source,ref_id,amount,status,expire_day,created_tick,created_day,gift_id,gift_item_id,origin_member_id)
                              VALUES(?,?,'gift',?,?, 'unused',?,?,?,?,?,?)`)
          .run(claimer.id, g.kind, g.id, src.amount, src.expire_day, ctx.tick(), ctx.day(),
               g.id, it.id, g.donor_member_id)
        const newId = Number(r.lastInsertRowid)
        db.prepare("UPDATE member_benefits SET status='gifted' WHERE id=?").run(src.id)
        db.prepare("UPDATE member_gift_items SET status='gifted', gifted_benefit_id=? WHERE id=?").run(newId, it.id)
      }
    }

    const cu = db.prepare("UPDATE member_gifts SET status='claimed', recipient_member_id=?, claim_day=?, claim_tick=? WHERE id=? AND status='approved'")
      .run(claimer.id, ctx.day(), ctx.tick(), g.id)
    if (cu.changes === 0) throw new TxError(GIFT_ERR.BAD_STATE, '转赠单已被其他成员领取或状态已变化')
    logGift(g.id, 'claim', { actorRole: 'recipient', actorMemberId: claimer.id, note: g.target === 'family' ? '家庭成员领取共享池转赠' : '受赠人领取' })
    logMember(claimer.id, 'gift',
      `领取转赠单 ${g.code}：${g.kind === 'points' ? `${g.amount} 积分` : g.kind === 'balance' ? `储值 ¥${g.amount}` : `${g.qty} 张${KIND_NAME[g.kind]}`}（来自会员 #${g.donor_member_id}）`)
    return { ok: true }
  }))
}

// 指定受赠人拒绝领取：回补捐赠人（家庭共享池不可拒绝，可由捐赠人撤回）
export function declineGift({ giftId, memberId, requestId = '' } = {}) {
  return idempotent('gift_decline', requestId, () => runAtomic(() => {
    const g = getGift(num(giftId))
    if (!g) throw new TxError(GIFT_ERR.NOT_FOUND, '转赠单不存在')
    if (g.target !== 'member') throw new TxError(GIFT_ERR.BAD_ARG, '家庭共享池转赠不可拒绝，可由捐赠人撤回')
    if (g.status !== 'approved') throw new TxError(GIFT_ERR.BAD_STATE, '该转赠单不在待领取状态')
    if (g.recipient_member_id !== num(memberId)) throw new TxError(GIFT_ERR.NOT_RECIPIENT, '仅指定受赠人本人可拒绝')
    return returnToDonor(g, 'declined', { actorRole: 'recipient', actorMemberId: g.recipient_member_id, note: '受赠人拒绝领取' })
  }))
}

// 撤回已发放/待领取转赠：捐赠人本人或运营（staffId 非空）
// 待领取：积分储值/券直接回补；已领取：未用积分储值冲回、未用券返还，
// 已用于在途预约的票券同事务原子取消预约（园方全额退款释放名额，积分回退/券返还联动作用于受赠人）后再返还；
// 已在商铺核销或预约已结束的权益不可撤回。
export function recallGift({ giftId, donorMemberId = null, staffId = null, reason = '', requestId = '' } = {}) {
  return idempotent('gift_recall', requestId, () => runAtomic(() => {
    const g = getGift(num(giftId))
    if (!g) throw new TxError(GIFT_ERR.NOT_FOUND, '转赠单不存在')
    if (!staffId && g.donor_member_id !== num(donorMemberId)) throw new TxError(GIFT_ERR.NOT_DONOR, '仅捐赠人或运营可撤回')
    if (!['approved', 'claimed'].includes(g.status)) {
      throw new TxError(GIFT_ERR.BAD_STATE, '当前状态不可撤回（待审核申请请使用「撤回申请」）')
    }
    const note = String(reason || '').slice(0, 100)

    if (g.status === 'approved') {
      returnToDonor(g, 'recalled', {
        actorRole: staffId ? 'operations' : 'donor', actorMemberId: g.donor_member_id, staffId,
        note: note || (staffId ? '运营撤回转赠' : '捐赠人撤回转赠')
      })
      return { ok: true, reservations_cancelled: 0 }
    }

    // ---- 已领取：从受赠人处冲回 ----
    const recipientId = g.recipient_member_id
    const recipient = getMember(recipientId)
    if (!recipient) throw new TxError(GIFT_ERR.NOT_FOUND, '受赠人档案不存在')

    if (g.kind === 'points') {
      if (recipient.points < g.amount) {
        throw new TxError(GIFT_ERR.INSUF_RECALL, `受赠人当前积分 ${recipient.points} 不足 ${g.amount}，无法整笔撤回（已部分消费）`)
      }
      changePoints(recipientId, -g.amount, `转赠单 ${g.code} 被撤回，积分返还捐赠人`)
      changePoints(g.donor_member_id, g.amount, `转赠单 ${g.code} 撤回回补积分`)
    } else if (g.kind === 'balance') {
      const u = db.prepare('UPDATE members SET balance=balance-? WHERE id=? AND balance>=?').run(g.amount, recipientId, g.amount)
      if (u.changes === 0) {
        throw new TxError(GIFT_ERR.INSUF_RECALL, `受赠人当前储值余额不足 ¥${g.amount}，无法整笔撤回（已部分消费）`)
      }
      db.prepare('UPDATE members SET balance=balance+? WHERE id=?').run(g.amount, g.donor_member_id)
    } else {
      let reservationsCancelled = 0
      const items = db.prepare('SELECT * FROM member_gift_items WHERE gift_id=? ORDER BY seq').all(g.id)
      for (const it of items) {
        const nb = getBenefit(it.gifted_benefit_id)
        if (!nb || nb.member_id !== recipientId) throw new TxError(GIFT_ERR.BAD_STATE, '转赠权益数据异常，请人工核对')
        if (nb.status === 'used') {
          // 已用于在途预约：园方原因原子取消预约（全额退款、释放名额、积分回退；既有联动把券返还为 unused）
          if (nb.used_ref_type === 'reservation' && nb.used_ref_id) {
            const rsv = db.prepare("SELECT * FROM reservations WHERE id=? AND status='booked'").get(nb.used_ref_id)
            if (rsv) {
              if (!ctx.cancelReservationPark) throw new TxError(GIFT_ERR.TX_FAILED, '预约联动未就绪，撤回未执行')
              const r = ctx.cancelReservationPark(rsv.id, `转赠单 ${g.code} 撤回，权益回收，园方取消预约并全额退款`)
              if (!r?.ok) throw new TxError(r.code || GIFT_ERR.TX_FAILED, r.msg || '关联预约取消失败，撤回未执行')
              db.prepare('UPDATE member_gift_items SET reservation_id=? WHERE id=?').run(rsv.id, it.id)
              logGift(g.id, 'reservation_cancel', { actorRole: 'system', note: `撤回联动取消预约 ${rsv.code}（全额退款释放名额）` })
              reservationsCancelled++
            }
          }
          const cur = getBenefit(nb.id)
          if (!cur || cur.status !== 'unused') {
            throw new TxError(GIFT_ERR.USED_NO_RECALL, '转赠权益已在商铺核销或预约已结束，不可撤回（仅未使用或在途预约的权益可撤回）')
          }
        } else if (nb.status !== 'unused') {
          throw new TxError(GIFT_ERR.USED_NO_RECALL, '存在已过期或已处置的转赠权益，不可整笔撤回')
        }
        // 受赠人权益结回收（置 refunded 留痕），捐赠人原权益解锁返还
        db.prepare("UPDATE member_benefits SET status='refunded' WHERE id=?").run(nb.id)
        const du = db.prepare("UPDATE member_benefits SET status='unused', gift_id=NULL, gift_item_id=NULL WHERE id=? AND status='gifted'")
          .run(it.benefit_id)
        if (du.changes === 0) {
          // 捐赠人原权益异常（理论上不会发生）：整体回滚
          throw new TxError(GIFT_ERR.BAD_STATE, '捐赠人原权益状态异常，撤回已中止')
        }
        db.prepare("UPDATE member_gift_items SET status='returned' WHERE id=?").run(it.id)
      }
      logMember(recipientId, 'gift', `转赠单 ${g.code} 被撤回，${g.qty} 张${KIND_NAME[g.kind]}已返还捐赠人${reservationsCancelled ? `，关联 ${reservationsCancelled} 笔在途预约已取消退款` : ''}`, staffId)
      db.prepare("UPDATE member_gifts SET status='recalled', close_day=?, close_tick=?, close_note=?, staff_id=? WHERE id=? AND status='claimed'")
        .run(ctx.day(), ctx.tick(), note, staffId, g.id)
      logGift(g.id, 'recall', { actorRole: staffId ? 'operations' : 'donor', actorMemberId: g.donor_member_id, staffId, note: note || '撤回已领取转赠' })
      logMember(g.donor_member_id, 'gift', `撤回转赠单 ${g.code}：${g.qty} 张${KIND_NAME[g.kind]}已返还${reservationsCancelled ? `，联动取消预约 ${reservationsCancelled} 笔` : ''}`, staffId)
      return { ok: true, reservations_cancelled: reservationsCancelled }
    }

    // 积分/储值路径收尾
    logMember(recipientId, 'gift', `转赠单 ${g.code} 被撤回，${KIND_NAME[g.kind]}已返还捐赠人`, staffId)
    db.prepare("UPDATE member_gifts SET status='recalled', close_day=?, close_tick=?, close_note=?, staff_id=? WHERE id=? AND status='claimed'")
      .run(ctx.day(), ctx.tick(), note, staffId, g.id)
    logGift(g.id, 'recall', { actorRole: staffId ? 'operations' : 'donor', actorMemberId: g.donor_member_id, staffId, note: note || '撤回已领取转赠' })
    logMember(g.donor_member_id, 'gift', `撤回转赠单 ${g.code}：${g.kind === 'points' ? `${g.amount} 积分` : `储值 ¥${g.amount}`}已回补`, staffId)
    return { ok: true, reservations_cancelled: 0 }
  }))
}

// 引擎日结调用：待领取转赠超过领取有效期未领，自动回补捐赠人
export function sweepExpiredGifts(day = ctx.day()) {
  const rows = db.prepare("SELECT * FROM member_gifts WHERE status='approved' AND claim_deadline_day>0 AND claim_deadline_day<?").all(day)
  let n = 0
  for (const g of rows) {
    tx(() => {
      const cur = getGift(g.id)
      if (!cur || cur.status !== 'approved') return
      returnToDonor(cur, 'expired', { actorRole: 'system', note: `超过 ${cur.claim_deadline_day} 天领取有效期未领取，系统自动回补捐赠人` })
    })
    n++
  }
  return n
}

// ---------------- 查询 / 统计 / 配置 ----------------
function giftItems(giftId) {
  return db.prepare(`SELECT gi.*,
      (SELECT m.code FROM members m WHERE m.id=mb.member_id) holder_code,
      (SELECT m.name FROM members m WHERE m.id=mb.member_id) holder_name
      FROM member_gift_items gi LEFT JOIN member_benefits mb ON mb.id=gi.gifted_benefit_id
      WHERE gi.gift_id=? ORDER BY gi.seq`).all(giftId)
}
function enrichGift(g) {
  const donor = getMember(g.donor_member_id)
  const recipient = g.recipient_member_id ? getMember(g.recipient_member_id) : null
  const fam = g.family_id ? getFamily(g.family_id) : null
  const staff = g.staff_id ? db.prepare('SELECT id,name FROM staff WHERE id=?').get(g.staff_id) : null
  return {
    ...g,
    kind_name: KIND_NAME[g.kind], kind_icon: KIND_ICON[g.kind], status_name: STATUS_NAME[g.status] || g.status,
    donor_code: donor?.code || '', donor_name: donor?.name || '',
    recipient_code: recipient?.code || '', recipient_name: recipient?.name || '',
    family_name: fam?.name || '',
    staff_name: staff?.name || '',
    can_claim: g.status === 'approved',
    expired_claim: g.status === 'approved' && g.claim_deadline_day < ctx.day() ? 1 : 0,
    items: giftItems(g.id)
  }
}

export function listGifts({ status = null, donorMemberId = null, recipientMemberId = null, familyId = null, q = '', limit = 100 } = {}) {
  const conds = [], vals = []
  if (status && status !== 'all') { conds.push('g.status=?'); vals.push(status) }
  if (donorMemberId) { conds.push('g.donor_member_id=?'); vals.push(donorMemberId) }
  // 受赠视角：指定受赠人 + 其所在家庭的共享池转赠
  if (recipientMemberId) {
    const famIds = db.prepare("SELECT family_id FROM family_members WHERE member_id=? AND status='active'").all(recipientMemberId).map(r => r.family_id)
    conds.push('(g.recipient_member_id=? OR (g.target=\'family\' AND g.family_id IN (' + (famIds.length ? famIds.map(() => '?').join(',') : '0') + ')))')
    vals.push(recipientMemberId, ...famIds)
  }
  if (familyId) { conds.push('g.family_id=?'); vals.push(familyId) }
  if (q) { conds.push('(g.code LIKE ? OR md.name LIKE ? OR mr.name LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  const sql = `SELECT g.* FROM member_gifts g
               LEFT JOIN members md ON md.id=g.donor_member_id
               LEFT JOIN members mr ON mr.id=g.recipient_member_id
               WHERE ${conds.length ? conds.join(' AND ') : '1=1'} ORDER BY g.id DESC LIMIT ?`
  return db.prepare(sql).all(...vals, num(limit, 100)).map(enrichGift)
}

export function giftDetail(id) {
  const g = getGift(id)
  if (!g) return null
  const d = enrichGift(g)
  d.logs = db.prepare('SELECT * FROM member_gift_logs WHERE gift_id=? ORDER BY id').all(id)
  return d
}

// 待某会员领取的转赠（指定受赠 + 家庭共享池）
export function claimableGiftsFor(memberId) {
  return listGifts({ status: 'approved', recipientMemberId: memberId, limit: 50 })
}

export function giftStats() {
  const day = ctx.day()
  const escrowPoints = num(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM member_gifts WHERE kind='points' AND status IN ('pending','approved')").get().s)
  const escrowBalance = num(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM member_gifts WHERE kind='balance' AND status IN ('pending','approved')").get().s)
  return {
    pendingReview: db.prepare("SELECT COUNT(*) n FROM member_gifts WHERE status='pending'").get().n,
    awaitingClaim: db.prepare("SELECT COUNT(*) n FROM member_gifts WHERE status='approved'").get().n,
    expiredClaim: db.prepare("SELECT COUNT(*) n FROM member_gifts WHERE status='approved' AND claim_deadline_day<?").get(day).n,
    claimedToday: db.prepare("SELECT COUNT(*) n FROM member_gifts WHERE status='claimed' AND claim_day=?").get(day).n,
    recalledToday: db.prepare("SELECT COUNT(*) n FROM member_gifts WHERE status='recalled' AND close_day=?").get(day).n,
    claimedTotal: db.prepare("SELECT COUNT(*) n FROM member_gifts WHERE status='claimed'").get().n,
    familyActive: db.prepare("SELECT COUNT(*) n FROM family_groups WHERE status='active'").get().n,
    familyMembers: db.prepare("SELECT COUNT(*) n FROM family_members WHERE status='active'").get().n,
    escrowPoints, escrowBalance
  }
}

export function getGiftConfig() {
  return {
    enabled: cfgEnabled(),
    familyAutoApprove: cfgAutoApproveFamily(),
    claimDays: cfgClaimDays(),
    maxItems: cfgMaxItems(),
    minTier: String(getSetting('giftMinTier', 'none') || 'none')
  }
}
export function saveGiftConfig(patch = {}) {
  return runAtomic(() => {
    if (patch.enabled !== undefined) {
      // 会员总开关仍由会员中心配置控制；这里仅切换转赠模块自身开关
      setSetting('giftEnabled', patch.enabled ? 1 : 0)
    }
    if (patch.familyAutoApprove !== undefined) setSetting('giftFamilyAutoApprove', patch.familyAutoApprove ? 1 : 0)
    if (patch.claimDays !== undefined) {
      const v = Math.round(num(patch.claimDays, 7)); if (v < 1 || v > 60) throw new TxError(GIFT_ERR.BAD_ARG, '领取有效期需在 1 ~ 60 游戏日之间')
      setSetting('giftClaimDays', v)
    }
    if (patch.maxItems !== undefined) {
      const v = Math.round(num(patch.maxItems, 20)); if (v < 1 || v > 100) throw new TxError(GIFT_ERR.BAD_ARG, '单笔转赠张数需在 1 ~ 100 之间')
      setSetting('giftMaxItems', v)
    }
    if (patch.minTier !== undefined) {
      const v = String(patch.minTier)
      if (!(v in TIER_RANK)) throw new TxError(GIFT_ERR.BAD_ARG, '最低转赠等级无效')
      setSetting('giftMinTier', v)
    }
    return { ok: true, config: getGiftConfig() }
  })
}

// ---------------- 一致性巡检：锁定/转移权益与转赠单口径自愈 ----------------
// ① 状态为 locked 但无 pending/approved 明细引用的权益（异常残留）→ 安全解锁；
// ② claimed 单的 gifted 明细须有受赠人新权益；异常仅告警（不擅改资金）。
// 返回 { healed, findings:[{title,detail,level}] }，由 index.js 引擎每小时调用并落 reconcile_findings。
export function reconcileGifts() {
  const healed = []
  const findings = []
  tx(() => {
    // 锁孤儿：权益 locked，但不存在任何 locked 状态明细关联它（有 gift_id 但单子已关闭而未解锁）
    const orphans = db.prepare(`
      SELECT b.* FROM member_benefits b
      WHERE b.status='locked'
        AND NOT EXISTS(SELECT 1 FROM member_gift_items gi
                       JOIN member_gifts g ON g.id=gi.gift_id
                       WHERE gi.benefit_id=b.id AND gi.status='locked' AND g.status IN ('pending','approved'))`)
      .all()
    for (const b of orphans) {
      db.prepare("UPDATE member_benefits SET status='unused', gift_id=NULL, gift_item_id=NULL WHERE id=? AND status='locked'").run(b.id)
      healed.push({ kind: 'gift_lock', title: `权益 #${b.id} 转赠锁残留已自动解锁`, detail: '锁定状态无在途转赠单引用，按事实自愈解锁' })
    }
    // 已领取单明细完整性
    const bad = db.prepare(`
      SELECT gi.id, gi.gift_id FROM member_gift_items gi
      JOIN member_gifts g ON g.id=gi.gift_id
      WHERE g.status='claimed' AND gi.status='gifted'
        AND (gi.gifted_benefit_id IS NULL
             OR NOT EXISTS(SELECT 1 FROM member_benefits b WHERE b.id=gi.gifted_benefit_id))`)
      .all()
    for (const x of bad) {
      const exists = db.prepare("SELECT id FROM reconcile_findings WHERE kind='gift_item' AND ref_id=? AND status='open'").get(x.id)
      if (!exists) findings.push({ kind: 'gift_item', level: 'block', ref: x.id, gift: x.gift_id })
    }
    return { ok: true }
  })
  return { ok: true, healedCount: healed.length, healed, findings }
}

export const GIFT_CONST = { KIND_NAME, KIND_ICON, STATUS_NAME, BENEFIT_KINDS, TIER_RANK }
