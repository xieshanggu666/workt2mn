import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 可用 PARK_DB_PATH 覆盖（测试传 ':memory:' 隔离真实库）
const DB_PATH = process.env.PARK_DB_PATH || join(__dirname, 'park.db')

const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  theme TEXT NOT NULL,           -- 奇幻/冒险/水上/未来/儿童
  unlocked INTEGER NOT NULL DEFAULT 1,
  capacity INTEGER NOT NULL DEFAULT 200,
  cleanliness INTEGER NOT NULL DEFAULT 80,  -- 清洁度 0-100
  scenery INTEGER NOT NULL DEFAULT 60,      -- 景观值 0-100
  open INTEGER NOT NULL DEFAULT 1,
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 过山车/旋转木马/摩天轮/跳楼机/水上漂流/碰碰车/海盗船/云霄飞车
  zone_id INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'operating', -- operating/maintenance/closed
  capacity INTEGER NOT NULL DEFAULT 20,     -- 单轮载客
  cycle_min REAL NOT NULL DEFAULT 5,        -- 运行周期(游戏分钟)
  build_cost INTEGER NOT NULL DEFAULT 5000,
  run_cost INTEGER NOT NULL DEFAULT 60,     -- 每施工时段运行成本
  thrill INTEGER NOT NULL DEFAULT 50,       -- 刺激度
  attr REAL NOT NULL DEFAULT 60,            -- 游客吸引度
  health REAL NOT NULL DEFAULT 100,         -- 健康度 0-100
  queue INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 30,
  play_count INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,           -- 累计收入
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 餐饮/纪念品/饮品
  zone_id INTEGER NOT NULL DEFAULT 1,
  rent INTEGER NOT NULL DEFAULT 800,
  margin REAL NOT NULL DEFAULT 0.6,
  price INTEGER NOT NULL DEFAULT 25,
  sold INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  staff_id INTEGER,
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- 保安/保洁/维修/员工管理员
  zone_id INTEGER NOT NULL DEFAULT 1,
  wage INTEGER NOT NULL DEFAULT 300,
  skill INTEGER NOT NULL DEFAULT 1,
  morale INTEGER NOT NULL DEFAULT 80,      -- 满意度 0-100
  active INTEGER NOT NULL DEFAULT 1,
  assigned_ride_id INTEGER
);

CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,        -- 该时段入园人数
  satisfaction REAL NOT NULL DEFAULT 70,
  eat REAL NOT NULL DEFAULT 40,  -- 人均消费期望
  total_spend INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  label TEXT NOT NULL,           -- 门票/游乐/餐饮/纪念品/工资/租金/运营/消费/建设/升级/扩建/活动/贷款/利息
  amount INTEGER NOT NULL,       -- 正负(贷款正数=放款/本金返还，负数=偿还本金；利息负数=付息/罚息)
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal INTEGER NOT NULL,        -- 借款本金
  rate REAL NOT NULL,                -- 每期(每日)利率
  periods INTEGER NOT NULL,          -- 总期数(天)
  installment INTEGER NOT NULL,      -- 每期等额本息应还
  remain_principal INTEGER NOT NULL, -- 剩余本金(含已到期未还的本金)
  paid_periods INTEGER NOT NULL DEFAULT 0,
  arrears_p INTEGER NOT NULL DEFAULT 0, -- 逾期挂账本金
  arrears_i INTEGER NOT NULL DEFAULT 0, -- 逾期挂账利息(含罚息)
  overdue_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active/done
  start_day INTEGER NOT NULL,
  created_tick INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  impact INTEGER NOT NULL DEFAULT 0,  -- 影响力影响声誉/客流
  status TEXT NOT NULL DEFAULT 'active', -- active/resolved
  feedback TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',             -- 投诉单号 TS0001
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  category TEXT NOT NULL,                    -- queue/hygiene/facility/safety/food/service/pricing/missing
  severity INTEGER NOT NULL DEFAULT 1,       -- 1 一般 / 2 严重 / 3 紧急
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',      -- ride/vendor/zone
  target_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',       -- open/processing/ready/closed_resolved/closed_force/closed_timeout
  assignee_id INTEGER,                       -- 受理员工
  progress REAL NOT NULL DEFAULT 0,          -- 处置进度 0-100
  deadline_tick INTEGER NOT NULL,            -- 限时处置截止时刻(tick=游戏小时)
  escalated INTEGER NOT NULL DEFAULT 0,      -- 是否经历过升级
  escalations INTEGER NOT NULL DEFAULT 0,
  compensation TEXT NOT NULL DEFAULT '',     -- apology/ticket/fastpass/voucher/cash
  comp_cost INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0,         -- 游客结案评价 1-5
  close_reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'guest',      -- guest 游客自发 / manual 前台登记
  resolved_tick INTEGER NOT NULL DEFAULT 0,  -- 现场处置完成(待确认补偿)时刻
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS complaint_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,                      -- submit/assign/ready/resolve/escalate/auto_escalate/unassign/force/timeout
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaint_logs_cid ON complaint_logs(complaint_id);

-- 分时预约库存：scope=entry 为入园时段（ride_id 恒 NULL），scope=ride 为设施分时时段
CREATE TABLE IF NOT EXISTS reservation_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                 -- entry / ride
  ride_id INTEGER,                     -- entry 时段为 NULL
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  capacity INTEGER NOT NULL,           -- 时段容量（运营可调）
  oversell INTEGER NOT NULL DEFAULT 0, -- 超售余量（爽约率对冲，运营可调）
  booked_count INTEGER NOT NULL DEFAULT 0,
  checked_count INTEGER NOT NULL DEFAULT 0,
  noshow_count INTEGER NOT NULL DEFAULT 0,
  refund_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'  -- open / closed
);
-- NULL 在 UNIQUE 中互不相等，entry/ride 各建部分唯一索引保证同一时段只有一条库存
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_entry ON reservation_slots(day,hour) WHERE scope='entry';
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_ride ON reservation_slots(ride_id,day,hour) WHERE scope='ride';

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',        -- 预约号 YY0001
  guest_name TEXT NOT NULL DEFAULT '游客',
  guest_phone TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,                  -- entry / ride
  ride_id INTEGER,
  slot_id INTEGER,
  slot_day INTEGER NOT NULL,
  slot_hour INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,       -- 人数
  amount INTEGER NOT NULL DEFAULT 0,   -- 预收款（下单时即收取，现金制）
  status TEXT NOT NULL DEFAULT 'booked',-- booked/checked/noshow/refunded/refunded_half
  reason TEXT NOT NULL DEFAULT '',      -- guest/late/park/overbook/noshow
  source TEXT NOT NULL DEFAULT 'guest', -- guest 游客端 / auto 模拟客流 / manual 前台
  reschedules INTEGER NOT NULL DEFAULT 0,
  refund_amount INTEGER NOT NULL DEFAULT 0, -- 已退金额（退款留痕，幂等重放/对账用）
  refund_fee INTEGER NOT NULL DEFAULT 0,    -- 退款手续费（当日取消扣 50%）
  created_tick INTEGER NOT NULL,
  created_day INTEGER NOT NULL,
  checked_tick INTEGER NOT NULL DEFAULT 0,
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reservations_slot ON reservations(slot_day,slot_hour,status);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);

CREATE TABLE IF NOT EXISTS reservation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,  -- create/auto_book/checkin/reschedule/auto_reschedule/noshow/cancel/refund/split
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reservation_logs_rid ON reservation_logs(reservation_id);

-- 异常补偿队列：自动/人工核销遇超售且退款事务失败（系统异常已回滚）时持久化挂起，
-- 引擎每小时先重试补退、再跑爽约扫描；挂起期间预约保持 booked，不会被误按爽约没收。
-- 每张预约同一时刻至多一条 pending（部分唯一索引），成功补退/预约已被他途处理后置 done/obsolete。
CREATE TABLE IF NOT EXISTS reservation_pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT 'overbook_refund', -- overbook_refund 超售全额退款补退
  status TEXT NOT NULL DEFAULT 'pending',         -- pending 待重试 / done 已补退 / obsolete 预约已被他途处理
  attempts INTEGER NOT NULL DEFAULT 0,            -- 已尝试次数
  last_error TEXT NOT NULL DEFAULT '',            -- 最近一次失败错误码与信息（可追踪）
  created_tick INTEGER NOT NULL,
  created_day INTEGER NOT NULL,
  updated_tick INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rsv_pending_one ON reservation_pending_actions(reservation_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_rsv_pending_status ON reservation_pending_actions(status);

-- 设施检修工单：报修后进入排队，维修员工接单后按游戏时间推进，支持转派与离岗接续
CREATE TABLE IF NOT EXISTS maintenance_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- 工单号 WX0001
  ride_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued 排队待接单 / processing 检修中 / done 已完工 / cancelled 已撤销
  source TEXT NOT NULL DEFAULT 'manual',   -- manual 人工报修 / auto 故障自动停运 / system 兼容既有检修状态补建
  assignee_id INTEGER,                     -- 接单维修员工
  progress REAL NOT NULL DEFAULT 0,        -- 检修进度 0-100，按游戏小时推进
  cost INTEGER NOT NULL DEFAULT 0,         -- 检修费用（报修时按健康度核定，完工结算入账）
  create_tick INTEGER NOT NULL,
  create_day INTEGER NOT NULL,
  start_tick INTEGER NOT NULL DEFAULT 0,   -- 最近一次接单/转派到手时刻
  completed_tick INTEGER NOT NULL DEFAULT 0,
  completed_day INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_maint_ride ON maintenance_orders(ride_id);
CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_orders(status);
CREATE INDEX IF NOT EXISTS idx_maint_assignee ON maintenance_orders(assignee_id);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,                    -- create/assign/transfer/release/complete/cancel
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_maint_logs_oid ON maintenance_logs(order_id);

-- 幂等请求键：同一 scope+key 的重复请求（双击/重试/网络重发）直接返回首次执行结果，不产生重复副作用
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,           -- create / cancel / reschedule / checkin / member_card / member_redeem
  key TEXT NOT NULL,             -- 客户端请求号（UUID）
  response TEXT NOT NULL,        -- 首次执行结果快照（JSON）
  created_tick INTEGER NOT NULL DEFAULT 0,
  created_day INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_scope_key ON idempotency_keys(scope,key);

-- ---------------- 游客会员与权益中心 ----------------
-- 会员卡商品（运营可配置：银卡/金卡/钻石卡，价格、有效期、折扣、积分倍率、开卡赠权益）
CREATE TABLE IF NOT EXISTS card_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier TEXT NOT NULL UNIQUE,        -- silver/gold/diamond（无卡普通会员 tier=none，不在此表）
  name TEXT NOT NULL,
  price INTEGER NOT NULL,           -- 购卡价（¥）
  valid_days INTEGER NOT NULL,      -- 有效期（游戏日）
  point_mul REAL NOT NULL DEFAULT 1,-- 积分倍率
  discount_entry REAL NOT NULL DEFAULT 1,  -- 入园门票折扣（1=不打折，0.9=9 折）
  discount_ride REAL NOT NULL DEFAULT 1,   -- 设施票价折扣
  discount_vendor REAL NOT NULL DEFAULT 1, -- 商铺消费折扣
  give_ticket INTEGER NOT NULL DEFAULT 0,  -- 开卡赠免票券
  give_voucher INTEGER NOT NULL DEFAULT 0, -- 开卡赠消费券（张，每张面额 voucher_face）
  give_fastpass INTEGER NOT NULL DEFAULT 0,-- 开卡赠快速通行券
  bonus_points INTEGER NOT NULL DEFAULT 0, -- 开卡赠送积分
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 会员档案（注册即普通会员 none；购卡/升级/到期驱动 card_tier 与状态流转）
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',          -- 会员号 HY0001
  name TEXT NOT NULL DEFAULT '游客',
  phone TEXT NOT NULL DEFAULT '',
  card_tier TEXT NOT NULL DEFAULT 'none', -- none/silver/gold/diamond
  status TEXT NOT NULL DEFAULT 'active',  -- active/frozen/expired（到期由日结扫描置 expired）
  points INTEGER NOT NULL DEFAULT 0,      -- 当前可用积分
  total_points INTEGER NOT NULL DEFAULT 0,-- 累计获得积分
  balance INTEGER NOT NULL DEFAULT 0,     -- 储值余额（¥，充值为负债，消费才确认收入）
  card_expire_day INTEGER NOT NULL DEFAULT 0, -- 会员卡到期游戏日（0=无卡）
  join_day INTEGER NOT NULL,
  owner_staff_id INTEGER,                 -- 归属运营人员（会员专员）
  created_tick INTEGER NOT NULL DEFAULT 0,
  last_active_tick INTEGER NOT NULL DEFAULT 0
);
-- 空手机号允许多条（散客现场注册），仅对非空手机号唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_phone ON members(phone) WHERE phone IS NOT NULL AND phone<>'';
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status, card_tier);

-- 购卡/续费/升级订单（财务入账与对账留痕）
CREATE TABLE IF NOT EXISTS member_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',          -- HK0001
  member_id INTEGER NOT NULL,
  type TEXT NOT NULL,                     -- new/renew/upgrade
  tier TEXT NOT NULL,
  price INTEGER NOT NULL,
  staff_id INTEGER,
  day INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_morders_member ON member_orders(member_id);

-- 积分账户流水（获取/消费/回退/调整/过期，逐条可对账）
CREATE TABLE IF NOT EXISTS member_point_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  change INTEGER NOT NULL,                -- 正=获取，负=消费/回退
  balance_after INTEGER NOT NULL,
  source TEXT NOT NULL,                   -- card/entry/ride/vendor/redeem/refund/adjust/expire/comp
  ref_type TEXT NOT NULL DEFAULT '',      -- reservation/vendor/order/complaint/benefit
  ref_id INTEGER,
  day INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mpoints_member ON member_point_logs(member_id);

-- 积分兑换商品（运营可配置：储值/消费券/免票券/快速通行券）
CREATE TABLE IF NOT EXISTS benefit_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,       -- balance/voucher/ticket/fastpass
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- balance/voucher/ticket/fastpass
  points_cost INTEGER NOT NULL,    -- 兑换所需积分
  amount INTEGER NOT NULL DEFAULT 0, -- balance/voucher 的面额（¥）；券类为 0
  qty INTEGER NOT NULL DEFAULT 1,  -- 单次兑换发放数量
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 会员权益账户（开卡赠送 / 积分兑换所得，逐条核销与退还）
CREATE TABLE IF NOT EXISTS member_benefits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- balance/voucher/ticket/fastpass
  source TEXT NOT NULL,             -- card/redeem
  ref_id INTEGER,                  -- 来源订单/兑换记录
  amount INTEGER NOT NULL DEFAULT 0,-- 储值/消费券面额（¥）
  status TEXT NOT NULL DEFAULT 'unused', -- unused/used/expired/refunded
  expire_day INTEGER NOT NULL DEFAULT 0, -- 到期游戏日（0=随卡；券类固定有效期）
  used_tick INTEGER NOT NULL DEFAULT 0,
  used_ref_type TEXT NOT NULL DEFAULT '', -- reservation/vendor
  used_ref_id INTEGER,
  created_tick INTEGER NOT NULL DEFAULT 0,
  created_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mbenefits_member ON member_benefits(member_id, status);

-- 会员生命周期时间线（注册/购卡/续费/升级/冻结/解冻/到期/兑换/充值/调整）
CREATE TABLE IF NOT EXISTS member_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,             -- register/card/renew/upgrade/freeze/unfreeze/expire/redeem/topup/adjust/ticket/vendor
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mlogs_member ON member_logs(member_id);

-- ---------------- 员工排班与工时结算 ----------------
-- 班次模板：运营主管可配置；跨日夜班 cross_day=1（如 17:00~次日09:00）
CREATE TABLE IF NOT EXISTS shift_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,        -- morning/mid/evening/night
  name TEXT NOT NULL,
  start_hour INTEGER NOT NULL,
  end_hour INTEGER NOT NULL,
  cross_day INTEGER NOT NULL DEFAULT 0, -- 下班是否跨到次日
  standard_hours REAL NOT NULL DEFAULT 5, -- 结算基准工时（跨日夜班含闭园时段，按基准工时计薪）
  color TEXT NOT NULL DEFAULT '#66a6ff',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 排班单：员工 × 游戏日 × 班次；status scheduled/swap/cancelled
CREATE TABLE IF NOT EXISTS staff_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',     -- PB0001
  staff_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  day INTEGER NOT NULL,              -- 上班所属游戏日（跨日夜班归当日）
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled 已排 / swap 调班中 / cancelled 已取消
  source TEXT NOT NULL DEFAULT 'manual', -- manual 主管手排 / auto 基础自动补位 / dispatch 动态调度按缺口补位
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
-- 同一员工同一游戏日只允许一个有效（非取消）排班
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_staff_day ON staff_schedules(staff_id,day) WHERE status<>'cancelled';
CREATE INDEX IF NOT EXISTS idx_sched_day ON staff_schedules(day,status);
CREATE INDEX IF NOT EXISTS idx_sched_shift ON staff_schedules(shift_id);

-- 考勤工时单：上班自动生成，离岗/完工回写，下班自动结算入工资财务（跨日夜班次日闭园结算）
CREATE TABLE IF NOT EXISTS staff_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',     -- KQ0001
  schedule_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  day INTEGER NOT NULL,              -- 排班所属游戏日（结算日：非跨日=当日，跨日=次日）
  shift_id INTEGER NOT NULL,
  cross_day INTEGER NOT NULL DEFAULT 0,
  checkin_tick INTEGER NOT NULL DEFAULT 0,  -- 实际上班时刻（线性游戏小时）
  checkout_tick INTEGER NOT NULL DEFAULT 0, -- 实际下班时刻；0=在岗未下班
  work_ticks INTEGER NOT NULL DEFAULT 0,    -- 已出勤游戏小时数（随引擎每小时累计）
  status TEXT NOT NULL DEFAULT 'checked_in', -- checked_in 在岗 / checked_out 已结算 / absent 旷工 / leave 离岗
  late INTEGER NOT NULL DEFAULT 0,          -- 是否迟到（调班/加班后上班晚于班次开始）
  overtime_ticks INTEGER NOT NULL DEFAULT 0,-- 已批加班小时数（1.5 倍时薪）
  ot_approved INTEGER NOT NULL DEFAULT 0,   -- 加班申请是否已主管审批
  leave_tick INTEGER NOT NULL DEFAULT 0,    -- 离岗时刻（非下班离岗）
  satisfaction_delta INTEGER NOT NULL DEFAULT 0, -- 本班满意度变动（完工回写/迟到/旷工/离岗累计）
  pay INTEGER NOT NULL DEFAULT 0,           -- 结算工资（基准工时+加班，实际进工资财务流水）
  settle_day INTEGER NOT NULL DEFAULT 0,    -- 实际结算游戏日
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_sched ON staff_attendance(schedule_id);
CREATE INDEX IF NOT EXISTS idx_att_staff_day ON staff_attendance(staff_id,day);
CREATE INDEX IF NOT EXISTS idx_att_status ON staff_attendance(status);

-- 调班 / 加班协作申请：员工发起，运营主管审批
CREATE TABLE IF NOT EXISTS shift_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',     -- TB0001
  kind TEXT NOT NULL,                -- swap 调班 / overtime 加班
  staff_id INTEGER NOT NULL,
  schedule_id INTEGER,               -- 关联排班（调班原排班 / 加班当值排班）
  day INTEGER NOT NULL,
  -- 调班：目标同事与目标班次（可换日换班）；加班：当前班次延后下班时长
  target_staff_id INTEGER,
  target_shift_id INTEGER,
  target_day INTEGER,
  ot_ticks INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending 待批 / approved 已批 / rejected 驳回 / cancelled 已取消
  source TEXT NOT NULL DEFAULT 'staff',    -- staff 员工发起 / dispatch 系统紧急加班调令（动态调度生成）
  approver_id INTEGER,
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  handle_tick INTEGER NOT NULL DEFAULT 0,
  handle_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_freq_status ON shift_requests(status,kind);
CREATE INDEX IF NOT EXISTS idx_freq_staff ON shift_requests(staff_id);

-- 排班 / 考勤 / 调班全生命周期时间线
CREATE TABLE IF NOT EXISTS shift_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER,
  attendance_id INTEGER,
  request_id INTEGER,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL, -- schedule/autofill/cancel/checkin/late/leave/checkout/absent/swap_request/swap_approve/swap_reject/ot_request/ot_approve/ot_reject
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER,
  approver_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shiftlogs_sched ON shift_logs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_shiftlogs_att ON shift_logs(attendance_id);
CREATE INDEX IF NOT EXISTS idx_shiftlogs_req ON shift_logs(request_id);

-- ---------------- 领队组团：入园 + 多设施行程团队预约 ----------------
-- 团单：领队提交（pending）→ 运营确认锁定名额并收订金（confirmed）→ 分批核销/尾款结算 → 完成/爽约结案/取消
CREATE TABLE IF NOT EXISTS group_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',            -- 团号 TU0001
  leader_name TEXT NOT NULL,                -- 领队姓名
  leader_phone TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL,                     -- 团队总人数
  visit_day INTEGER NOT NULL,               -- 入园游戏日
  entry_hour INTEGER NOT NULL,              -- 入园时段
  status TEXT NOT NULL DEFAULT 'pending',   -- pending/confirmed/settled/completed/cancelled/rejected/closed_noshow
  total_amount INTEGER NOT NULL DEFAULT 0,      -- 应收原额（提交时按牌价核定）
  receivable_amount INTEGER NOT NULL DEFAULT 0, -- 当前应收（部分退团/园方退一程逐额冲减）
  deposit_rate REAL NOT NULL DEFAULT 0.3,       -- 订金比例
  deposit_amount INTEGER NOT NULL DEFAULT 0,    -- 已收订金
  paid_balance INTEGER NOT NULL DEFAULT 0,      -- 已收尾款（可分批）
  refunded_amount INTEGER NOT NULL DEFAULT 0,   -- 已现金退还领队金额
  fee_amount INTEGER NOT NULL DEFAULT 0,        -- 没收/手续费累计（爽约、当日退团）
  source TEXT NOT NULL DEFAULT 'leader',        -- leader 领队端 / auto 模拟团
  note TEXT NOT NULL DEFAULT '',
  created_tick INTEGER NOT NULL,
  created_day INTEGER NOT NULL,
  confirm_tick INTEGER NOT NULL DEFAULT 0,
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_groups_status ON group_orders(status);
CREATE INDEX IF NOT EXISTS idx_groups_day ON group_orders(visit_day);

-- 团行程明细：1 条入园 + N 条设施；锁定后一一对应 source='group' 的预约单（0 元，款项走团账）
CREATE TABLE IF NOT EXISTS group_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- entry 入园 / ride 设施
  ride_id INTEGER,                          -- entry 为 NULL
  slot_id INTEGER,                          -- 锁定后关联的分时库存
  slot_day INTEGER NOT NULL,
  slot_hour INTEGER NOT NULL,
  qty INTEGER NOT NULL,                     -- 该程总人数
  unit_price INTEGER NOT NULL DEFAULT 0,   -- 单人牌价（提交时快照）
  amount INTEGER NOT NULL DEFAULT 0,       -- 该程应收 = qty*unit_price
  checked_qty INTEGER NOT NULL DEFAULT 0,  -- 已分批核销人数
  refunded_qty INTEGER NOT NULL DEFAULT 0, -- 已退团/停运退款人数
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/active/interrupted/rerouted/refund_park/refund_guest/noshow/checked
  reservation_id INTEGER,                  -- 关联 reservations.id（重排停运时可能换单）
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gitems_group ON group_items(group_id);
CREATE INDEX IF NOT EXISTS idx_gitems_status ON group_items(status);

-- 团账务流水：订金/尾款/退款/没收逐笔留痕，供财务对账
CREATE TABLE IF NOT EXISTS group_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- deposit/balance/refund_park/refund_guest/fee/noshow
  amount INTEGER NOT NULL,                  -- 正=向领队收款，负=退还给领队（fee/noshow 为没收收入，记正）
  day INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gpay_group ON group_payments(group_id);

-- 分批核销批次（闸机/设施口逐批放行，每批一条）
CREATE TABLE IF NOT EXISTS group_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',    -- manual 人工 / auto 引擎自动
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gcheckin_group ON group_checkins(group_id);

-- 团生命周期时间线（提交/确认/收订金/核销批次/退团/重排/停运/退款/爽约结案）
CREATE TABLE IF NOT EXISTS group_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_glog_group ON group_logs(group_id);

-- ---------------- 统一客流预测与资源调度闭环 ----------------
-- 客流预测日快照：引擎每小时把「预约库存（散客/团队/会员）+ 散客外推 + 自适应修正」的统一预测落库，
-- 是动态排班需求画像、跨日夜班衔接与前端闭环看板共同的事实源；日结时回填实际客流做精度学习。
CREATE TABLE IF NOT EXISTS flow_forecast_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day INTEGER NOT NULL,                  -- 预测的目标游戏日
  hour INTEGER NOT NULL DEFAULT 0,       -- 0=全日汇总；否则为该营业小时的预测
  predicted_flow INTEGER NOT NULL DEFAULT 0,  -- 统一预测客流（入园预约 + 团队 + 设施折算 + 散客外推，已乘自适应系数）
  reserve_entry INTEGER NOT NULL DEFAULT 0,   -- 散客/会员入园预约在途人数
  group_entry INTEGER NOT NULL DEFAULT 0,     -- 团队入园名额（已确认 + 待确认按置信折算）
  reserve_ride INTEGER NOT NULL DEFAULT 0,    -- 设施预约折算客流（含团队行程）
  walkin_forecast INTEGER NOT NULL DEFAULT 0, -- 散客（非预约）外推预测
  member_share REAL NOT NULL DEFAULT 0,       -- 预约中会员占比（0~1）
  actual_flow INTEGER NOT NULL DEFAULT 0,    -- 日结回填：当日实际入园/折算客流
  accuracy REAL NOT NULL DEFAULT 0,           -- 日结回填：预测命中率（0~1）
  adjust_factor REAL NOT NULL DEFAULT 1,      -- 本快照采用的散客外推自适应系数
  settled INTEGER NOT NULL DEFAULT 0,         -- 0 进行中 / 1 日结已回填学习
  update_tick INTEGER NOT NULL DEFAULT 0,
  update_day INTEGER NOT NULL DEFAULT 0,
  settle_tick INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_snap_day_hour ON flow_forecast_snapshots(day,hour);
CREATE INDEX IF NOT EXISTS idx_flow_snap_settled ON flow_forecast_snapshots(settled,day);

-- 闭环一致性巡检结果（每小时引擎巡检 + 手动触发）：排班/预约/库存/团账/财务口径不一致时落库告警
-- auto_heal=1 的项（如时段计数器漂移）会被安全自愈；资金/团账类只告警不自动改写，等待人工核对。
CREATE TABLE IF NOT EXISTS reconcile_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',          -- RC0001
  kind TEXT NOT NULL,                     -- slot_counter/finance_refund/finance_wage/group_ledger/attendance/schedule_conflict
  level TEXT NOT NULL DEFAULT 'warn',     -- warn 预警 / block 严重不一致
  ref_type TEXT NOT NULL DEFAULT '',      -- slot/reservation/group/attendance/schedule
  ref_id INTEGER,
  day INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  expected TEXT NOT NULL DEFAULT '',      -- 期望值快照（JSON）
  actual TEXT NOT NULL DEFAULT '',        -- 实际值快照（JSON）
  status TEXT NOT NULL DEFAULT 'open',    -- open 未处理 / healed 已自愈 / ignored 已忽略
  tick INTEGER NOT NULL,
  created_day INTEGER NOT NULL,
  heal_tick INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reconcile_status ON reconcile_findings(status,kind);
CREATE INDEX IF NOT EXISTS idx_reconcile_ref ON reconcile_findings(ref_type,ref_id);

-- ---------------- 动态排班跨日计划预览与审批 ----------------
-- 跨日调度计划：动态调度引擎对未来 horizon 天做「干跑（dry-run）」推演的结果，
-- 主管审批前不产生真实排班/调令；审批通过时在同一事务内二次校验并原子落地。
-- source=manual 主管手动生成预览 / auto 引擎每小时联动（预约客流/检修工单/投诉优先级）自动生成待批计划。
CREATE TABLE IF NOT EXISTS dispatch_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',          -- JH0001
  status TEXT NOT NULL DEFAULT 'pending', -- pending 待审批 / approved 已批准 / rejected 已驳回 / obsolete 被新计划取代 / expired 已过期
  source TEXT NOT NULL DEFAULT 'manual',  -- manual / auto
  horizon INTEGER NOT NULL DEFAULT 3,
  day_from INTEGER NOT NULL,
  day_to INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  demand_snapshot TEXT NOT NULL DEFAULT '', -- 生成时需求快照（JSON）：每日预约客流/检修工单/投诉/班段需求
  demand_signature TEXT NOT NULL DEFAULT '',-- 需求指纹：读取时重算对比，变化即标记计划已过时
  est_wage INTEGER NOT NULL DEFAULT 0,    -- 预估工资合计（基准工时工资 + 加班溢价，元）
  est_ot_wage INTEGER NOT NULL DEFAULT 0, -- 预估加班工资金额（元）
  item_count INTEGER NOT NULL DEFAULT 0,
  schedule_count INTEGER NOT NULL DEFAULT 0,
  ot_count INTEGER NOT NULL DEFAULT 0,
  applied_schedules INTEGER NOT NULL DEFAULT 0, -- 审批实际落地排班数（二次校验失效的条目跳过）
  applied_ots INTEGER NOT NULL DEFAULT 0,       -- 审批实际生成紧急调令数
  skipped_items INTEGER NOT NULL DEFAULT 0,
  approver_id INTEGER,
  approve_note TEXT NOT NULL DEFAULT '',
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  handle_tick INTEGER NOT NULL DEFAULT 0,
  handle_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dplan_status ON dispatch_plans(status,source);
CREATE INDEX IF NOT EXISTS idx_dplan_days ON dispatch_plans(day_from,day_to);

-- 计划条目：每条 = 一个拟新增排班（schedule）或一条拟生成的系统紧急加班调令（overtime）
-- reason_snapshot 记录该条目联动的缺口依据（班段客流峰值/检修工单/投诉优先级分值），审批页可追溯。
CREATE TABLE IF NOT EXISTS dispatch_plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,         -- 推演顺序（按日×班段×优先级）
  kind TEXT NOT NULL,                     -- schedule 新增排班 / overtime 紧急加班调令
  day INTEGER NOT NULL,                   -- 排班所属游戏日（跨日夜班归上班日）
  band TEXT NOT NULL DEFAULT '',          -- morning/mid/evening/night
  role TEXT NOT NULL DEFAULT '',          -- 保安/安保 / 保洁 / 维修工
  staff_id INTEGER NOT NULL,
  shift_id INTEGER,                       -- schedule：目标班次；overtime：当值班次
  schedule_id INTEGER,                    -- overtime：当值排班单；审批后 schedule 条目回写新建排班 id
  ot_ticks INTEGER NOT NULL DEFAULT 0,    -- overtime：加班小时数
  status TEXT NOT NULL DEFAULT 'pending', -- pending 待批 / applied 已落地 / skipped 已跳过（审批时已失效/冗余）
  est_wage INTEGER NOT NULL DEFAULT 0,    -- 该条目预估工资（schedule=基准工时工资；overtime=1.5 倍加班溢价）
  allow_started INTEGER NOT NULL DEFAULT 0, -- 生成时该班次是否已开始（审批允许补入刚开始的班段）
  reason_snapshot TEXT NOT NULL DEFAULT '', -- 缺口依据 JSON（客流峰值/工单号/投诉号与统一优先级分值）
  note TEXT NOT NULL DEFAULT '',
  ref_request_id INTEGER                  -- overtime 审批落地后回写 shift_requests.id
);
CREATE INDEX IF NOT EXISTS idx_dpitem_plan ON dispatch_plan_items(plan_id,seq);
CREATE INDEX IF NOT EXISTS idx_dpitem_status ON dispatch_plan_items(status,kind);

-- ========== 园区应急指挥：安全事件 发现→分级→封控→疏散→复园 状态机 ==========
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',            -- EM0001
  type TEXT NOT NULL,                       -- fire/facility/crowd/food/medical/weather/security/power/missing/other
  title TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',        -- 事发地点文字描述
  zone_id INTEGER,                          -- 事发区域
  severity INTEGER NOT NULL DEFAULT 0,      -- 0 待分级 / 1 一般 / 2 较大 / 3 重大 / 4 特别重大
  status TEXT NOT NULL DEFAULT 'reported',  -- reported/graded/contained/evacuating/controlled/reopened/closed_review/closed_false
  source TEXT NOT NULL DEFAULT 'patrol',    -- patrol 安保巡报 / visitor 游客上报 / ops 运营发现 / auto 模拟 / complaint 投诉转报
  reporter_role TEXT NOT NULL DEFAULT 'security', -- operations / security / visitor
  casualties INTEGER NOT NULL DEFAULT 0,    -- 受伤人数（控场时核定）
  evacuated_qty INTEGER NOT NULL DEFAULT 0, -- 已疏散人数
  refund_ride_qty INTEGER NOT NULL DEFAULT 0,  -- 封控停运设施联动退款人数
  refund_entry_qty INTEGER NOT NULL DEFAULT 0, -- 区域封控关停入园预约影响人数
  subsidy_total INTEGER NOT NULL DEFAULT 0, -- 应急岗位调度补贴合计（复园时结算）
  rescue_cost INTEGER NOT NULL DEFAULT 0,   -- 应急抢险费用（复园时结算）
  control_deadline_tick INTEGER NOT NULL DEFAULT 0, -- 分级后完成封控的处置时限
  contained_tick INTEGER NOT NULL DEFAULT 0,
  reopened_tick INTEGER NOT NULL DEFAULT 0,
  reopened_day INTEGER NOT NULL DEFAULT 0,
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT NOT NULL DEFAULT '',
  review_cause TEXT NOT NULL DEFAULT '',    -- 事故原因
  review_actions TEXT NOT NULL DEFAULT '',  -- 整改措施
  review_lessons TEXT NOT NULL DEFAULT '',  -- 经验教训
  review_rating INTEGER NOT NULL DEFAULT 0, -- 复盘评分 1-5（处置质量）
  review_rep_recover INTEGER NOT NULL DEFAULT 0, -- 复盘声誉回补
  complaint_id INTEGER,                     -- 投诉转报来源 / 游客理赔关联投诉
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_sev ON incidents(severity,status);

-- 事件全生命周期时间线：上报/分级/封控（设施停运·区域封锁）/疏散/控场/复园/复盘/误报关闭
CREATE TABLE IF NOT EXISTS incident_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,   -- report/grade/lockdown/evacuate/control/reopen/review/false/escalate/claim/...
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER,
  actor_role TEXT NOT NULL DEFAULT 'operations' -- operations/security/visitor/system
);
CREATE INDEX IF NOT EXISTS idx_incident_logs_iid ON incident_logs(incident_id);

-- 封控对象：事件封控时联动停运的设施 / 封锁的区域，复园（或误报关闭）时按原状态恢复
CREATE TABLE IF NOT EXISTS incident_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,                -- ride / zone
  target_id INTEGER NOT NULL,
  prev_status TEXT NOT NULL DEFAULT '',     -- 封控前状态（operating/maintenance；区域恒 1）
  locked_tick INTEGER NOT NULL DEFAULT 0,
  restored_tick INTEGER NOT NULL DEFAULT 0, -- 0 表示尚未复园恢复
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_incident_targets_inc ON incident_targets(incident_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_targets_one ON incident_targets(incident_id,target_type,target_id) WHERE restored_tick=0;

-- 应急岗位调度：事件响应调派的员工（安保为主，可含保洁/维修），到场确认/撤防，复园时按岗位补贴结算
CREATE TABLE IF NOT EXISTS incident_staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'control', -- control 封控警戒 / evacuate 疏散引导 / rescue 抢险救援 / medical 医疗救护
  status TEXT NOT NULL DEFAULT 'assigned',  -- assigned 已调派 / acknowledged 已到场 / stood_down 已撤防
  subsidy INTEGER NOT NULL DEFAULT 0,       -- 复园结算的应急补贴（元）
  assign_tick INTEGER NOT NULL DEFAULT 0,
  ack_tick INTEGER NOT NULL DEFAULT 0,
  stand_tick INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_incident_staff_inc ON incident_staff(incident_id,status);

-- 游客理赔：游客就安全事件登记损失，运营核定后现金赔付（财务补偿），关联投诉自动闭环
CREATE TABLE IF NOT EXISTS incident_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  code TEXT NOT NULL DEFAULT '',            -- CL0001
  guest_name TEXT NOT NULL DEFAULT '游客',
  guest_phone TEXT NOT NULL DEFAULT '',
  member_id INTEGER,
  item TEXT NOT NULL DEFAULT '',            -- 理赔事项（医疗/财物/门票损失…）
  amount_req INTEGER NOT NULL DEFAULT 0,    -- 游客申请金额
  amount_pay INTEGER NOT NULL DEFAULT 0,    -- 核定赔付金额
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted 待核定 / paid 已赔付 / rejected 已驳回 / withdrawn 已撤回
  complaint_id INTEGER,                     -- 登记时自动生成的安全投诉
  note TEXT NOT NULL DEFAULT '',
  handler_id INTEGER,
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  handle_tick INTEGER NOT NULL DEFAULT 0,
  handle_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incident_claims_inc ON incident_claims(incident_id,status);

-- ========================================================================
-- 园区物资采购与库存：供应商协同 → 采购单 → 入库批次（保质期/批次价）→ 库存
-- 库存联动：商铺销售实时扣减（缺货记录流失）、退货回补、盘点调整、缺货预警
-- 财务联动：采购应付/付款、退货冲抵、损耗成本全部入财务流水；异常对账独立闭环
-- ========================================================================

-- 供应商（运营与商铺共用档案：联系人/账期/评级/状态）
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- S0001
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '综合',    -- 食材/饮品原料/文创百货/综合
  pay_term_days INTEGER NOT NULL DEFAULT 0,-- 账期（天）：0=货到即付
  rating INTEGER NOT NULL DEFAULT 3,       -- 合作评级 1-5
  status TEXT NOT NULL DEFAULT 'active',   -- active 合作中 / suspended 暂停合作
  note TEXT NOT NULL DEFAULT '',
  created_day INTEGER NOT NULL DEFAULT 0
);

-- 物资目录（园区统一定义；可供应商铺类型用于采购选品匹配）
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- M0001
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '食材',    -- 食材/包材/饮品原料/文创百货
  unit TEXT NOT NULL DEFAULT '份',
  std_cost INTEGER NOT NULL DEFAULT 0,     -- 标准成本价（最近入库价自动回写）
  safety_stock INTEGER NOT NULL DEFAULT 0, -- 安全库存（低于即预警）
  shelf_days INTEGER NOT NULL DEFAULT 0,   -- 保质期（天）：0=无保质期
  auto_reorder INTEGER NOT NULL DEFAULT 0, -- 低于安全库存时自动生成补货草稿
  reorder_qty INTEGER NOT NULL DEFAULT 0,  -- 自动补货建议数量
  preferred_supplier_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active'    -- active / archived
);

-- 物资 ↔ 商铺：商铺销售哪些物资（1:1 主供物资；一个物资可供多铺）
CREATE TABLE IF NOT EXISTS vendor_materials (
  vendor_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  PRIMARY KEY (vendor_id, material_id)
);

-- 库存（按物资维度的总可用量，入库批次另表，先到期先出 FEFO）
CREATE TABLE IF NOT EXISTS inventory (
  material_id INTEGER PRIMARY KEY,
  qty_on_hand REAL NOT NULL DEFAULT 0,     -- 现存量（可用批次合计）
  qty_reserved REAL NOT NULL DEFAULT 0,    -- 占用（保留，暂为 0）
  updated_tick INTEGER NOT NULL DEFAULT 0
);

-- 入库批次：收货即按批次落库，携带批次成本与到期日，销售按 FEFO 消耗
CREATE TABLE IF NOT EXISTS inbound_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- RK0001
  order_id INTEGER,                        -- 来源采购单（盘盈/期初可空）
  material_id INTEGER NOT NULL,
  supplier_id INTEGER,
  qty_received REAL NOT NULL DEFAULT 0,    -- 入库数量
  qty_remain REAL NOT NULL DEFAULT 0,      -- 批次剩余（退货/报损会减少）
  unit_cost INTEGER NOT NULL DEFAULT 0,
  receive_day INTEGER NOT NULL DEFAULT 0,
  expire_day INTEGER NOT NULL DEFAULT 0,   -- 0=无保质期
  status TEXT NOT NULL DEFAULT 'in',       -- in 在库 / exhausted 耗尽 / closed 退货结清
  note TEXT NOT NULL DEFAULT ''
);

-- 采购单（运营提报 / 商铺协同 / 缺货自动草稿）→ 审批 → 发货 → 分批收货 → 结算
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- PO0001
  supplier_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',   -- manual 运营 / shop 商铺协同 / auto 缺货自动
  vendor_id INTEGER,                       -- 协同提报的商铺
  status TEXT NOT NULL DEFAULT 'draft',    -- draft/submitted/approved/received/partial/settled/cancelled
  total_amount INTEGER NOT NULL DEFAULT 0, -- 按下单行单价×数量合计
  paid_amount INTEGER NOT NULL DEFAULT 0,  -- 已付（含预付/付款单/退货冲抵累计，退货冲抵记负）
  pay_due_day INTEGER NOT NULL DEFAULT 0,  -- 应付日（审批日 + 供应商账期）
  note TEXT NOT NULL DEFAULT '',
  creator_id INTEGER,
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  submit_tick INTEGER NOT NULL DEFAULT 0,
  approve_tick INTEGER NOT NULL DEFAULT 0,
  close_tick INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  qty_ordered REAL NOT NULL DEFAULT 0,
  qty_received REAL NOT NULL DEFAULT 0,    -- 累计收货
  qty_returned REAL NOT NULL DEFAULT 0,    -- 累计退货
  unit_cost INTEGER NOT NULL DEFAULT 0
);

-- 采购付款单：对供应商应付的付款记录（预付/货到付/账期结算）
CREATE TABLE IF NOT EXISTS purchase_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- PAY0001
  order_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,       -- 正数=付款；退货冲抵由退货单体现，此处只记实付
  method TEXT NOT NULL DEFAULT 'cash',     -- cash 现金 / prepaid 预付结转
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);

-- 退货单：采购退货（退供应商，冲应付/退现金）与销售退货（游客退回，库存回补）
CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- RT0001
  kind TEXT NOT NULL DEFAULT 'purchase',   -- purchase 采购退货 / sale 销售退货
  order_id INTEGER,                        -- 采购退货关联采购单
  vendor_id INTEGER,                       -- 销售退货关联商铺
  batch_id INTEGER,                        -- 回补/退出的批次
  material_id INTEGER NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,       -- 采购退货=冲抵金额；销售退货=退款金额
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done',     -- done / rejected 驳回（销售退货）
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0
);

-- 库存流水：所有库存增减都在此留痕（采购入库/销售/销售退货/采购退货/盘盈盘亏/报损）
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  batch_id INTEGER,
  vendor_id INTEGER,
  change REAL NOT NULL DEFAULT 0,          -- 正=入，负=出
  qty_after REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',         -- in/sale/sale_return/purchase_return/adjust_gain/adjust_loss/spoil
  ref_type TEXT NOT NULL DEFAULT '',       -- order/batch/return/stocktake
  ref_id INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  tick INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stock_move_mat ON stock_movements(material_id,id);

-- 缺货流失：商铺在售但库存不足，记录损失的销量与营收（供补货决策与异常对账）
CREATE TABLE IF NOT EXISTS stock_lost_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER NOT NULL,
  material_id INTEGER,
  qty_lost REAL NOT NULL DEFAULT 0,
  lost_rev INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  tick INTEGER NOT NULL DEFAULT 0
);

-- 盘点单：商铺/仓库定期盘点，实盘与系统账的差异走审批调整（盘盈入库/盘亏报损）
CREATE TABLE IF NOT EXISTS stocktakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- PD0001
  scope TEXT NOT NULL DEFAULT 'all',       -- all 全仓 / vendor 按商铺 / material 指定物资
  vendor_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',     -- open 盘点中 / submitted 待审批 / adjusted 已调账 / cancelled
  diff_count INTEGER NOT NULL DEFAULT 0,
  diff_amount INTEGER NOT NULL DEFAULT 0,  -- 盘亏成本（负向）- 盘盈（正向）合计
  note TEXT NOT NULL DEFAULT '',
  creator_id INTEGER,
  create_day INTEGER NOT NULL DEFAULT 0,
  adjust_day INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stocktake_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  qty_book REAL NOT NULL DEFAULT 0,        -- 账面数
  qty_actual REAL NOT NULL DEFAULT 0,      -- 实盘数
  unit_cost INTEGER NOT NULL DEFAULT 0,
  adjusted INTEGER NOT NULL DEFAULT 0      -- 0 待处理 / 1 已调账
);

-- 异常对账：缺货/临期/价格差异/账实差异/应付异常，自动巡检生成或人工登记，处理闭环留痕
CREATE TABLE IF NOT EXISTS inventory_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'shortage',   -- shortage 缺货 / expiry 临期过期 / price 价格差异
                                           -- stock_diff 账实不符 / payable 应付异常
  severity TEXT NOT NULL DEFAULT 'warn',   -- info/warn/critical
  material_id INTEGER,
  supplier_id INTEGER,
  order_id INTEGER,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,       -- 涉及金额（如有）
  status TEXT NOT NULL DEFAULT 'open',     -- open 待处理 / resolved 已处理 / ignored 已忽略
  resolve_note TEXT NOT NULL DEFAULT '',
  create_day INTEGER NOT NULL DEFAULT 0,
  create_tick INTEGER NOT NULL DEFAULT 0,
  resolve_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inv_findings_status ON inventory_findings(status,type);

-- 采购库存操作日志（单据状态流转留痕）
CREATE TABLE IF NOT EXISTS purchase_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  tick INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);

-- ========================================================================
-- 园区联营商户结算：
--   商户申请入驻（新商户或存量商铺转联营）→ 审核签约（分成率/账期/保证金）
--   → 按销售流水实时分账（会员优惠按约分摊、消费券营销成本园方承担）
--   → 库存联动（FEFO 批次成本结算时扣收）→ 投诉处理（现金补偿按责罚没）
--   → 退货退款（红冲流水）→ 周期账单（生成/支付/挂账）
-- 联营商铺营收为「代收代付」：现金进园方账户形成对商户负债，账单支付时清偿。
-- ========================================================================

-- 入驻申请：status=applied 待审核 / approved 已通过签约 / rejected 已驳回 / withdrawn 已撤回
CREATE TABLE IF NOT EXISTS partner_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- LY0001
  vendor_id INTEGER,                       -- 存量商铺转联营时关联；新商户签约时回写
  name TEXT NOT NULL,                      -- 商户/品牌名称
  contact TEXT NOT NULL DEFAULT '',        -- 联系人
  phone TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '餐饮',       -- 餐饮/纪念品/饮品
  zone_id INTEGER NOT NULL DEFAULT 1,
  license TEXT NOT NULL DEFAULT '',        -- 营业执照/资质编号
  proposal TEXT NOT NULL DEFAULT '',       -- 经营方案/拟售商品
  commission_rate REAL NOT NULL DEFAULT 0.2, -- 申请分成率（园方扣点，0-1）
  settle_period_days INTEGER NOT NULL DEFAULT 7, -- 期望结算周期（天）
  deposit INTEGER NOT NULL DEFAULT 5000,   -- 保证金
  status TEXT NOT NULL DEFAULT 'applied',  -- applied/approved/rejected/withdrawn
  reject_reason TEXT NOT NULL DEFAULT '',
  contract_id INTEGER,                     -- 审核通过后生成的合同
  applicant_staff_id INTEGER,              -- 登记员工（招商专员/运营主管）
  reviewer_id INTEGER,                     -- 审核员工
  create_day INTEGER NOT NULL DEFAULT 0,
  create_tick INTEGER NOT NULL DEFAULT 0,
  review_day INTEGER NOT NULL DEFAULT 0,
  review_tick INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_papp_status ON partner_applications(status);

-- 联营合同：status=active 履约中 / terminated 已终止 / expired 到期未续
CREATE TABLE IF NOT EXISTS partner_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- HT0001
  application_id INTEGER,
  vendor_id INTEGER NOT NULL,
  commission_rate REAL NOT NULL DEFAULT 0.2, -- 园方分成（扣点）
  member_discount_share REAL NOT NULL DEFAULT 1, -- 会员优惠商户承担比例 0-1（其余园方承担）
  settle_period_days INTEGER NOT NULL DEFAULT 7, -- 结算周期
  deposit INTEGER NOT NULL DEFAULT 5000,   -- 保证金（签约时收取，终止清算时按约定退还/扣没）
  start_day INTEGER NOT NULL DEFAULT 0,
  end_day INTEGER NOT NULL DEFAULT 0,      -- 0=长期有效
  status TEXT NOT NULL DEFAULT 'active',   -- active/terminated
  sign_day INTEGER NOT NULL DEFAULT 0,
  sign_tick INTEGER NOT NULL DEFAULT 0,
  end_settlement_id INTEGER,               -- 终止清算账单
  signer_id INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pcontract_vendor ON partner_contracts(vendor_id,status);

-- 联营销售流水（退货为负向红冲行，与正向行同表；settlement_id=0 表示未入账）
CREATE TABLE IF NOT EXISTS partner_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- LS0001
  vendor_id INTEGER NOT NULL,
  contract_id INTEGER NOT NULL,
  member_id INTEGER,                       -- 会员消费（散客 NULL）
  source TEXT NOT NULL DEFAULT 'organic',  -- organic 散客 tick / member 会员消费
  qty REAL NOT NULL DEFAULT 0,             -- 正数=销售，负数=退货红冲
  gross INTEGER NOT NULL DEFAULT 0,        -- 牌价金额（退货按牌价，负数）
  bill_amount INTEGER NOT NULL DEFAULT 0,  -- 实际账单金额（含会员折扣后；红冲按实际退款额，负数）
  member_discount INTEGER NOT NULL DEFAULT 0, -- 会员优惠额（牌价-账单），商户按约分摊
  merchant_share INTEGER NOT NULL DEFAULT 0,  -- 商户应得（账单金额×(1-扣点)）
  park_share INTEGER NOT NULL DEFAULT 0,      -- 园方扣点（账单金额×扣点）
  merchant_discount_borne INTEGER NOT NULL DEFAULT 0, -- 会员优惠商户承担部分（结算时从应得扣减）
  park_discount_borne INTEGER NOT NULL DEFAULT 0,     -- 会员优惠园方承担部分（营销成本已在会员侧入账）
  commission_rate REAL NOT NULL DEFAULT 0.2,
  member_discount_share REAL NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'sale',       -- sale 销售 / return 退货红冲
  origin_sale_id INTEGER,                  -- 退货红冲关联原销售流水
  complaint_id INTEGER,                    -- 退货联动投诉（如有）
  settlement_id INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  tick INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_psales_vendor_day ON partner_sales(vendor_id,day);
CREATE INDEX IF NOT EXISTS idx_psales_settle ON partner_sales(settlement_id,kind);
CREATE INDEX IF NOT EXISTS idx_psales_origin ON partner_sales(origin_sale_id) WHERE kind='return';

-- 联营投诉处罚：投诉结案现金补偿且责任在联营商户时，按 severity 罚没商户待结算款（园方收入）
CREATE TABLE IF NOT EXISTS partner_fines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- CF0001
  vendor_id INTEGER NOT NULL,
  contract_id INTEGER NOT NULL,
  complaint_id INTEGER NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL DEFAULT 0,       -- 罚没金额（正数，结算时扣减）
  comp_cost INTEGER NOT NULL DEFAULT 0,    -- 客诉现金补偿额（处罚基数参考）
  reason TEXT NOT NULL DEFAULT '',
  settlement_id INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  tick INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pfines_vendor ON partner_fines(vendor_id,settlement_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pfines_complaint ON partner_fines(complaint_id);

-- 联营结算账单：按合同周期汇总未入账流水/红冲/罚没/批次成本，draft→paid（现金不足自动 overdue）
CREATE TABLE IF NOT EXISTS partner_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- JS0001
  vendor_id INTEGER NOT NULL,
  contract_id INTEGER NOT NULL,
  period_from INTEGER NOT NULL,
  period_to INTEGER NOT NULL,
  sale_count INTEGER NOT NULL DEFAULT 0,   -- 周期净销量（含红冲）
  gross INTEGER NOT NULL DEFAULT 0,        -- 周期净牌价额
  bill_amount INTEGER NOT NULL DEFAULT 0,  -- 周期净账单额（实际成交）
  merchant_share INTEGER NOT NULL DEFAULT 0,  -- 销售分账商户应得
  park_share INTEGER NOT NULL DEFAULT 0,      -- 园方扣点
  member_discount INTEGER NOT NULL DEFAULT 0, -- 会员优惠合计
  merchant_discount_borne INTEGER NOT NULL DEFAULT 0, -- 会员优惠商户承担
  cogs INTEGER NOT NULL DEFAULT 0,         -- 消耗园区库存批次成本（FEFO 汇总，商户承担）
  fines INTEGER NOT NULL DEFAULT 0,        -- 投诉罚没合计
  deposit_offset INTEGER NOT NULL DEFAULT 0,-- 保证金抵扣（终止清算扣没）
  deposit_refund INTEGER NOT NULL DEFAULT 0,-- 保证金退还（终止清算随账支付给商户）
  payable INTEGER NOT NULL DEFAULT 0,      -- 应付款 = 商户应得 - 商户承担优惠 - 成本 - 罚没 - 保证金抵扣 + 保证金退还（>=0）
  source TEXT NOT NULL DEFAULT 'periodic', -- periodic 周期账 / terminate 终止清算
  status TEXT NOT NULL DEFAULT 'draft',    -- draft 待支付 / paid 已支付 / overdue 资金不足挂账
  pay_day INTEGER NOT NULL DEFAULT 0,
  pay_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  create_tick INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_psettle_vendor ON partner_settlements(vendor_id,id);
CREATE INDEX IF NOT EXISTS idx_psettle_status ON partner_settlements(status);

-- 联营台账日志：申请/审核/签约/终止/出账/支付全流程留痕
CREATE TABLE IF NOT EXISTS partner_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type TEXT NOT NULL DEFAULT '',       -- application/contract/settlement/sale
  ref_id INTEGER NOT NULL DEFAULT 0,
  vendor_id INTEGER,
  tick INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plogs_ref ON partner_logs(ref_type,ref_id);

-- ========================================================================
-- 供应商批次召回：供应商 / 园方 / 联营商户 三方协同
--   园方发起召回 → 在库批次立即隔离（停售）→ 通知受影响自营/联营商铺
--   → 联营商户确认知悉 → 商铺按已售出量为游客退货退款（联营红冲分账）
--   → 园方将隔离批次退回供应商（货款冲应付/退现金）或现场销毁（核销）
--   → 供应商赔付货款损失/罚则 → 结案（关联餐饮投诉闭环、事件通知）
-- 召回期间在库批次不可销售；隔离量独立计量，退回/销毁时才核减库存并出库存流水。
-- ========================================================================

-- 召回单：发起即隔离批次并通知；issued→processing（供应商受理）→closed/closed_false/cancelled
CREATE TABLE IF NOT EXISTS recall_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',             -- ZH0001
  supplier_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',           -- 召回原因（质量/异物/过期/污染…）
  severity INTEGER NOT NULL DEFAULT 1,       -- 1 一般 / 2 严重 / 3 紧急（影响赔付罚则与投诉联动）
  status TEXT NOT NULL DEFAULT 'issued',     -- issued 已发起待受理 / processing 受理处置中 / closed 已结案 / closed_false 误报结案 / cancelled 已撤销
  -- 批次侧
  batch_qty REAL NOT NULL DEFAULT 0,         -- 发起时隔离的在库总量
  returned_qty REAL NOT NULL DEFAULT 0,      -- 已退供应商数量
  destroyed_qty REAL NOT NULL DEFAULT 0,     -- 已现场销毁数量
  released_qty REAL NOT NULL DEFAULT 0,      -- 撤销/误报解除隔离数量
  return_amount INTEGER NOT NULL DEFAULT 0,  -- 退供应商货款（冲应付+现金退回）
  destroy_cost INTEGER NOT NULL DEFAULT 0,   -- 现场销毁核销的物料成本
  -- 销售侧（按商铺已售出净量退款）
  affected_vendor_count INTEGER NOT NULL DEFAULT 0,
  refund_qty REAL NOT NULL DEFAULT 0,        -- 已完成游客退货退款的数量
  refund_amount INTEGER NOT NULL DEFAULT 0,  -- 游客退款金额（自营负商业流水；联营红冲）
  -- 赔付侧
  compensation_amount INTEGER NOT NULL DEFAULT 0, -- 供应商赔付到账（货款损失 + 罚则）
  penalty_amount INTEGER NOT NULL DEFAULT 0,      -- 其中罚则金额（严重度系数，仅展示拆分）
  complaint_id INTEGER,                      -- 发起时联动生成的餐饮质量投诉
  event_id INTEGER,                          -- 事件通知 id
  creator_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  accept_tick INTEGER NOT NULL DEFAULT 0,    -- 供应商受理时刻
  close_tick INTEGER NOT NULL DEFAULT 0,
  close_day INTEGER NOT NULL DEFAULT 0,
  close_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recall_status ON recall_orders(status);
CREATE INDEX IF NOT EXISTS idx_recall_supplier ON recall_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_recall_material ON recall_orders(material_id);

-- 受影响商铺：销售过该物资批次的自营/联营商铺，隔离时按已售净量登记，退货退款逐铺确认
CREATE TABLE IF NOT EXISTS recall_vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_id INTEGER NOT NULL,
  vendor_id INTEGER NOT NULL,
  is_partner INTEGER NOT NULL DEFAULT 0,     -- 0 自营 / 1 联营（退款口径与分账红冲不同）
  sold_qty REAL NOT NULL DEFAULT 0,          -- 发起时该铺已售出的净数量（需召回游客）
  refund_qty REAL NOT NULL DEFAULT 0,        -- 已退款数量
  refund_amount INTEGER NOT NULL DEFAULT 0,  -- 已退款金额
  status TEXT NOT NULL DEFAULT 'notified',   -- notified 已通知待处理 / acknowledged 商户已确认 / refunded 已退货退款 / none 无在途售出
  notified_tick INTEGER NOT NULL DEFAULT 0,
  notified_day INTEGER NOT NULL DEFAULT 0,
  ack_tick INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recall_vendors_recall ON recall_vendors(recall_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recall_vendors_one ON recall_vendors(recall_id,vendor_id);

-- 召回全生命周期时间线（发起/隔离/通知/受理/商户确认/退款/退回/销毁/赔付/结案/撤销）
CREATE TABLE IF NOT EXISTS recall_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_id INTEGER NOT NULL,
  vendor_id INTEGER,
  tick INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  hour INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'park',        -- park 园方 / supplier 供应商 / partner 联营商户 / system
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recall_logs_recall ON recall_logs(recall_id);

-- ========================================================================
-- 会员权益转赠与家庭账户：
--   会员发起转赠（指定受赠人 / 家庭共享池）→ 运营审核 → 发放（受赠人待领取 / 家庭池待领）
--   → 受赠人领取入账 → 预约/商铺核销 → 捐赠人/运营撤回（未用返还、已用冲积分/储值）
--   → 受赠人拒绝 / 到期未领自动回补；同步预约名额取消、退款权益返还与积分回退。
-- 权益券类（免票券/消费券/快速通行券）逐张锁定转移；积分/储值申请即托管，审核发放后入受赠人账户。
-- ========================================================================

-- 家庭账户（家庭组）：一名会员为户主创建，组员为注册会员；家庭共享池转赠仅同组可领
CREATE TABLE IF NOT EXISTS family_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',            -- JT0001
  name TEXT NOT NULL,                       -- 家庭名称
  head_member_id INTEGER NOT NULL,          -- 户主会员
  status TEXT NOT NULL DEFAULT 'active',    -- active 正常 / dissolved 已解散
  member_count INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  create_day INTEGER NOT NULL DEFAULT 0,
  create_tick INTEGER NOT NULL DEFAULT 0,
  dissolve_day INTEGER NOT NULL DEFAULT 0,
  dissolve_tick INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_family_head ON family_groups(head_member_id,status);

-- 家庭成员：一名会员同一时刻仅可在一个家庭（部分唯一索引）；户主不可移除/退出
CREATE TABLE IF NOT EXISTS family_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',      -- head 户主 / member 成员
  status TEXT NOT NULL DEFAULT 'active',    -- active 在组 / left 已退出/被移除
  join_day INTEGER NOT NULL DEFAULT 0,
  join_tick INTEGER NOT NULL DEFAULT 0,
  leave_day INTEGER NOT NULL DEFAULT 0,
  leave_tick INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fmember_one ON family_members(member_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_fmember_family ON family_members(family_id,status);

-- 家庭账户时间线（建组/邀请/入组/退出/移除/解散）
CREATE TABLE IF NOT EXISTS family_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL,
  member_id INTEGER,                        -- 关联动作会员（加入/退出者）
  tick INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  hour INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,                     -- create/invite/join/leave/remove/dissolve
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_family_logs ON family_logs(family_id);

-- 权益转赠单：捐赠人申请 → 运营审核 → 发放 → 受赠人领取/拒绝 → 核销/撤回/过期回补
CREATE TABLE IF NOT EXISTS member_gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',            -- ZZ0001
  donor_member_id INTEGER NOT NULL,         -- 捐赠会员
  recipient_member_id INTEGER,              -- 指定受赠人（家庭共享池为 NULL，池内成员先领先得）
  family_id INTEGER,                        -- target=family 时关联家庭组
  target TEXT NOT NULL DEFAULT 'member',    -- member 指定受赠人 / family 家庭共享池
  kind TEXT NOT NULL,                       -- points 积分 / balance 储值 / ticket 免票券 / voucher 消费券 / fastpass 快速通行券
  qty INTEGER NOT NULL DEFAULT 1,           -- 券类张数（积分/储值恒 1）
  amount INTEGER NOT NULL DEFAULT 0,        -- 积分数量 / 储值面额（券类为 0；消费券为张面额×张数冗余便于统计）
  status TEXT NOT NULL DEFAULT 'pending',   -- pending/approved/claimed/declined/rejected/cancelled/recalled/expired
  auto_approved INTEGER NOT NULL DEFAULT 0, -- 家庭池自动审核（免审）
  claim_deadline_day INTEGER NOT NULL DEFAULT 0, -- 领取有效期（发放后 N 游戏日，到期未领自动回补）
  reason TEXT NOT NULL DEFAULT '',          -- 捐赠人留言
  reject_reason TEXT NOT NULL DEFAULT '',
  staff_id INTEGER,                         -- 审核/撤回经办运营
  benefit_count INTEGER NOT NULL DEFAULT 0, -- 券类明细条数
  create_day INTEGER NOT NULL DEFAULT 0,
  create_tick INTEGER NOT NULL DEFAULT 0,
  review_day INTEGER NOT NULL DEFAULT 0,
  review_tick INTEGER NOT NULL DEFAULT 0,
  claim_day INTEGER NOT NULL DEFAULT 0,
  claim_tick INTEGER NOT NULL DEFAULT 0,
  close_day INTEGER NOT NULL DEFAULT 0,
  close_tick INTEGER NOT NULL DEFAULT 0,
  close_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gifts_status ON member_gifts(status,target);
CREATE INDEX IF NOT EXISTS idx_gifts_donor ON member_gifts(donor_member_id,id);
CREATE INDEX IF NOT EXISTS idx_gifts_recipient ON member_gifts(recipient_member_id,status);
CREATE INDEX IF NOT EXISTS idx_gifts_family ON member_gifts(family_id,status);

-- 转赠明细：券类逐张锁定（locked）→ 发放后原权益标记 gifted 转移到受赠人名下；撤回时原权益解锁返还
-- 积分/储值不产生权益明细（gifted_benefit_id 为发放到受赠人账户的新权益/流水引用，仅券类）
CREATE TABLE IF NOT EXISTS member_gift_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  benefit_id INTEGER NOT NULL,              -- 捐赠人被锁定的原始权益 id（member_benefits.id）
  gifted_benefit_id INTEGER,                -- 发放后受赠人名下的新权益 id
  amount INTEGER NOT NULL DEFAULT 0,        -- 该张面额（消费券）
  status TEXT NOT NULL DEFAULT 'locked',    -- locked 待审核锁定 / gifted 已转移待领取/已领取 / returned 撤回/拒绝/过期已返还捐赠人
  reservation_id INTEGER,                   -- 受赠人领取后用该权益预约的在途预约（撤回时联动取消）
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gift_items_gift ON member_gift_items(gift_id,seq);
CREATE INDEX IF NOT EXISTS idx_gift_items_benefit ON member_gift_items(benefit_id);
CREATE INDEX IF NOT EXISTS idx_gift_items_gifted ON member_gift_items(gifted_benefit_id);

-- 转赠全生命周期时间线（申请/撤回申请/审核通过/驳回/自动审核/领取/拒绝/运营撤回/捐赠人撤回/过期回补/预约联动）
CREATE TABLE IF NOT EXISTS member_gift_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_id INTEGER NOT NULL,
  tick INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  hour INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,     -- apply/cancel/approve/auto_approve/reject/claim/decline/recall/expire/reservation_cancel
  actor_role TEXT NOT NULL DEFAULT 'operations', -- donor/recipient/operations/system
  actor_member_id INTEGER,
  staff_id INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gift_logs_gift ON member_gift_logs(gift_id);
`)

// ---------- 轻量列迁移（兼容老库） ----------
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
// 退款金额/手续费留痕：幂等重放与财务对账
ensureColumn('reservations', 'refund_amount', "refund_amount INTEGER NOT NULL DEFAULT 0")
ensureColumn('reservations', 'refund_fee', "refund_fee INTEGER NOT NULL DEFAULT 0")
// 会员联动：下单会员、支付使用的权益（免票券/快速通行券）、实付积分获取留痕
ensureColumn('reservations', 'member_id', "member_id INTEGER")
ensureColumn('reservations', 'benefit_id', "benefit_id INTEGER")
// 投诉联动：会员本人投诉，可积分补偿结案
ensureColumn('complaints', 'member_id', "member_id INTEGER")
// 动态调度：排班/申请来源（manual/auto/dispatch；staff/dispatch）
ensureColumn('staff_schedules', 'source', "source TEXT NOT NULL DEFAULT 'manual'")
ensureColumn('shift_requests', 'source', "source TEXT NOT NULL DEFAULT 'staff'")
// 领队组团：source='group' 的预约单关联团行程明细 id（款项走团账，该预约 amount 恒为 0）
ensureColumn('reservations', 'group_item_id', "group_item_id INTEGER")
// 权益转赠：权益锁定/转移/返还溯源（locked 申请待审锁定；gifted 已随转赠单转移到受赠人名下）
ensureColumn('member_benefits', 'gift_item_id', "gift_item_id INTEGER")  // 关联 member_gift_items.id（锁定/新权益均回填）
ensureColumn('member_benefits', 'gift_id', "gift_id INTEGER")            // 关联转赠单 member_gifts.id
ensureColumn('member_benefits', 'origin_member_id', "origin_member_id INTEGER") // 受赠权益的原始捐赠人（转入新权益记录）
// 供应商批次召回：批次隔离量（独立计量，不计入可售；退回供应商/销毁时才核减库存）与在途召回单
ensureColumn('inbound_batches', 'quarantined_qty', "quarantined_qty REAL NOT NULL DEFAULT 0")
ensureColumn('inbound_batches', 'recall_id', "recall_id INTEGER")

// ---------- 事务 ----------
// 多步写入（库存/订单/现金/流水/日志）必须原子提交：任一步失败整体回滚，不留半完成状态。
// 嵌套调用并入外层事务（node:sqlite 单连接同步执行，靠深度计数避免嵌套 BEGIN 报错）。
let txDepth = 0
// 事务后回调队列：仅在事务成功 COMMIT 后执行（回滚一律丢弃）。
// 用于「库存/团单变化 → 客流预测快照与动态调度重算」这类闭环联动：
// 联动在提交后触发，保证读到的是已落库的一致状态，且联动异常不会污染/回滚主业务事务。
let afterCommitQueue = []
function afterCommit(fn) {
  if (typeof fn !== 'function') return
  if (txDepth > 0) afterCommitQueue.push(fn)
  else { try { fn() } catch (e) { console.error('[db] afterCommit 回调执行失败（不影响主事务）:', e) } }
}
function tx(fn) {
  if (txDepth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  txDepth++
  const pending = afterCommitQueue
  afterCommitQueue = []
  try {
    const r = fn()
    db.exec('COMMIT')
    const cbs = afterCommitQueue
    afterCommitQueue = pending
    // 提交成功后才触发联动；回调自身异常不影响已提交的业务结果
    for (const cb of cbs) { try { cb() } catch (e) { console.error('[db] afterCommit 联动失败（事务已提交，不影响业务结果）:', e) } }
    return r
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 连接已回滚时忽略 */ }
    // 回滚：丢弃本事务登记的全部联动，绝不让未生效的库存/订单变化触发重排
    afterCommitQueue = pending
    throw e
  } finally {
    txDepth--
  }
}

const now = () => new Date().toISOString()

// ---------- 种子数据 ----------
const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k)
  return r ? r.value : d
}
const setSetting = (k, v) => {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v))
}

function seed() {
  const c = db.prepare('SELECT COUNT(*) n FROM zones').get().n
  if (c > 0) return

  // 初始经营参数
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('ticket', 120)
  setSetting('reputation', 70)
  setSetting('cash', 200000)
  setSetting('guestBase', 600)
  setSetting('wordOfMouth', 0)   // 投诉补救口碑 -10 ~ +10，回流影响客流与满意度

  const iz = db.prepare('INSERT INTO zones(name,theme,unlocked,capacity,cleanliness,scenery,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
  const zones = [
    ['奇幻山谷', '奇幻', 1, 300, 85, 70, 1, 1],
    ['冒险岛', '冒险', 1, 260, 70, 65, 3, 1],
    ['未来世界', '未来', 0, 220, 60, 55, 1, 3],
    ['水上乐园', '水上', 0, 250, 75, 60, 3, 3],
    ['儿童王国', '儿童', 1, 180, 90, 75, 1, 2],
    ['美食广场', '美食', 1, 150, 85, 60, 3, 2]
  ]
  zones.forEach(z => iz.run(...z))
  const zoneMap = { 奇幻山谷: 1, 冒险岛: 2, 未来世界: 3, 水上乐园: 4, 儿童王国: 5, 美食广场: 6 }

  const ir = db.prepare('INSERT INTO rides(name,type,zone_id,status,capacity,cycle_min,build_cost,run_cost,thrill,attr,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const rides = [
    ['极速飞车', '过山车', 2, 'operating', 32, 6, 60000, 260, 92, 88, 60, 2, 2],
    ['旋转木马', '旋转木马', 5, 'operating', 40, 4, 20000, 70, 15, 75, 20, 2, 3],
    ['摩天轮', '摩天轮', 1, 'operating', 24, 12, 45000, 150, 45, 85, 45, 1, 3],
    ['跳楼机', '跳楼机', 2, 'operating', 20, 8, 35000, 130, 88, 80, 55, 3, 2],
    ['碰碰车', '碰碰车', 5, 'operating', 12, 5, 26000, 95, 60, 82, 35, 3, 3],
    ['海盗船', '海盗船', 2, 'operating', 30, 7, 38000, 140, 78, 84, 50, 4, 1],
    ['激流勇进', '水上漂流', 2, 'operating', 28, 9, 42000, 160, 82, 86, 55, 4, 2]
  ]
  rides.forEach(r => ir.run(...r))

  const iv = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
  const vendors = [
    ['爆米花小屋', '餐饮', 1, 900, 0.65, 28, 1, 4],
    ['纪念品旗舰店', '纪念品', 1, 1200, 0.7, 55, 1, 5],
    ['冰爽柠檬饮', '饮品', 5, 600, 0.72, 18, 2, 4],
    ['热狗快餐厅', '餐饮', 6, 1000, 0.62, 32, 4, 3],
    ['玩具总动员', '纪念品', 5, 900, 0.68, 45, 4, 4]
  ]
  vendors.forEach(v => iv.run(...v))

  const is = db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,assigned_ride_id) VALUES(?,?,?,?,?,?,?)')
  const staff = [
    ['张伟', '保安', 1, 320, 1, 85, null],
    ['李娜', '保洁', 1, 300, 1, 88, null],
    ['王强', '维修', 2, 380, 2, 78, 1],
    ['赵敏', '维修', 2, 360, 1, 80, 2],
    ['陈杰', '安保', 3, 320, 1, 82, null],
    ['刘洋', '保洁', 3, 300, 1, 79, null],
    ['孙莉', '会员专员', 1, 340, 2, 90, null],
    ['周涛', '会员专员', 1, 340, 1, 84, null],
    ['林岚', '运营主管', 1, 420, 2, 86, null]
  ]
  staff.forEach(s => is.run(...s))

  // 启动期财务记录（昨日）
  const nf = new Date().toISOString()
  const parseFinance = `INSERT OR IGNORE INTO settings(key,value) VALUES('seed_finance','1')`
  const f = db.prepare('INSERT INTO finance(tick,day,label,amount,detail) VALUES(?,?,?,?,?)')
  const pre = db.prepare('SELECT COUNT(*) n FROM finance').get().n
  if (pre === 0) {
    f.run(0, 0, '门票', 72000, '昨日门票收入')
    f.run(0, 0, '游乐', 48000, '昨日游乐设施收入')
    f.run(0, 0, '餐饮', 18000, '昨日餐饮收入')
    f.run(0, 0, '纪念品', 15000, '昨日纪念品收入')
    f.run(0, 0, '工资', -26000, '昨日工资支出')
    f.run(0, 0, '维护', -9000, '昨日设施维护')
  }

  // ---------- 会员与权益中心：卡种 / 积分商品 / 全局参数 / 示例会员 ----------
  const setIf = (k, v) => {
    if (!getSetting(k)) setSetting(k, String(v))
  }
  setIf('memberEnabled', 1)                // 会员体系开关（运营可停用）
  setIf('pointRate', 1)                    // 每 ¥10 实付 = 1 积分（再乘会员卡倍率）
  setIf('pointsComp', 300)                 // 投诉积分补偿档：结案赠送积分
  setIf('voucherFace', 30)                 // 消费券面额（¥）
  setIf('benefitValidDays', 30)            // 兑换/赠送券类权益有效期（游戏日）
  // 权益转赠与家庭账户参数
  setIf('giftEnabled', 1)                  // 转赠模块开关
  setIf('giftFamilyAutoApprove', 1)        // 家庭共享池转赠是否免审自动通过（1=自动）
  setIf('giftClaimDays', 7)                // 发放后受赠人领取有效期（游戏日，到期未领自动回补）
  setIf('giftMaxItems', 20)                // 单笔转赠券类最多张数
  setIf('giftMinTier', 'none')             // 允许发起转赠的最低卡等级（none/silver/gold/diamond）

  const ic = db.prepare(`INSERT OR IGNORE INTO card_products
      (tier,name,price,valid_days,point_mul,discount_entry,discount_ride,discount_vendor,give_ticket,give_voucher,give_fastpass,bonus_points,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const cards = [
    ['silver', '银卡', 299, 30, 1.2, 0.95, 0.95, 0.98, 0, 1, 0, 50, 1],
    ['gold', '金卡', 699, 60, 1.5, 0.9, 0.9, 0.95, 1, 2, 1, 150, 2],
    ['diamond', '钻石卡', 1299, 90, 2, 0.85, 0.85, 0.9, 2, 4, 2, 300, 3]
  ]
  cards.forEach(c => ic.run(...c))

  const ib = db.prepare(`INSERT OR IGNORE INTO benefit_products(code,name,kind,points_cost,amount,qty,sort)
      VALUES (?,?,?,?,?,?,?)`)
  const benefits = [
    ['balance', '储值 ¥30', 'balance', 500, 30, 1, 1],
    ['voucher', '消费券 ¥30', 'voucher', 300, 30, 1, 2],
    ['ticket', '免票券 ×1', 'ticket', 800, 0, 1, 3],
    ['fastpass', '快速通行券 ×1', 'fastpass', 200, 0, 1, 4]
  ]
  benefits.forEach(b => ib.run(...b))

  // ---------- 排班与工时结算：班次模板（含跨日夜班，用于跨日结算） ----------
  const ish = db.prepare(`INSERT OR IGNORE INTO shift_templates
      (code,name,start_hour,end_hour,cross_day,standard_hours,color,sort)
      VALUES (?,?,?,?,?,?,?,?)`)
  const shifts = [
    ['morning', '早班', 9, 14, 0, 5, '#66a6ff', 1],
    ['mid', '中班', 12, 17, 0, 5, '#6dd5a0', 2],
    ['evening', '晚班', 14, 18, 0, 4, '#a78bfa', 3],
    ['night', '夜班', 17, 9, 1, 6, '#ff9e64', 4]   // 跨日夜班：当日 17:00 至次日 09:00
  ]
  shifts.forEach(s => ish.run(...s))
  setIf('scheduleAutoFill', 1)            // 自动补位开关（引擎按需求为未来三天补齐缺口）
  setIf('scheduleMode', 'dynamic')        // dynamic 动态调度（按客流/工单/投诉）；auto 全员基础补位
  setIf('scheduleApproval', 0)            // 动态调度审批模式：1=跨日计划先预览待主管审批，0=引擎直接补位
  setIf('otRateMul', 1.5)                 // 加班时薪倍率
  setIf('dispatchGuardFlow', 500)         // 每名保安班段可承载的预约预测客流
  setIf('dispatchCleanFlow', 700)         // 每名保洁班段可承载的预约预测客流
  setIf('dispatchNightGuardsPerZone', 0)  // 夜勤保安区域配比（0=不强制）
  setIf('groupDepositRate', 0.3)          // 团队订金比例（运营确认时锁定名额并收取）
  setIf('groupEnabled', 1)                // 领队组团模块开关

  // 示例会员（新库首日建立；含一名金卡会员便于演示等级与权益流转）
  if (db.prepare('SELECT COUNT(*) n FROM members').get().n === 0) {
    const im = db.prepare(`INSERT INTO members(code,name,phone,card_tier,status,points,total_points,balance,card_expire_day,join_day,owner_staff_id,created_tick,last_active_tick)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const demo = [
      ['HY0001', '王小雨', '13800000001', 'gold', 'active', 420, 1180, 120, 45, 1, 7, 0, 0],
      ['HY0002', '李大壮', '13800000002', 'silver', 'active', 80, 260, 0, 20, 1, 8, 0, 0],
      ['HY0003', '陈小星', '', 'none', 'active', 15, 15, 0, 0, 1, null, 0, 0]
    ]
    demo.forEach(m => im.run(...m))

    // 示例购卡订单 + 开卡权益（与卡种配置一致，随卡有效期）
    const imo = db.prepare(`INSERT INTO member_orders(code,member_id,type,tier,price,staff_id,day,tick,note)
      VALUES(?,?,?,?,?,?,?,0,?)`)
    const iben = db.prepare(`INSERT INTO member_benefits(member_id,kind,source,ref_id,amount,status,expire_day,created_tick,created_day)
      VALUES(?,?,?,?,?,'unused',?,0,1)`)
    const ipl = db.prepare(`INSERT INTO member_point_logs(member_id,change,balance_after,source,ref_type,ref_id,day,tick,note)
      VALUES(?,?,?,?,?,?,1,0,?)`)
    const iml = db.prepare(`INSERT INTO member_logs(member_id,tick,day,hour,action,note,staff_id) VALUES(?,0,1,9,?,?,?)`)
    // 金卡（会员1）：¥699，60 天到第 60 天（示例设到期日 45），1 免票券 + 2 消费券 + 1 FP，150 开卡分
    let oid = Number(imo.run('HK0001', 1, 'new', 'gold', 699, 7, 1, '购买金卡').lastInsertRowid)
    iben.run(1, 'ticket', 'card', oid, 0, 45)
    iben.run(1, 'voucher', 'card', oid, 30, 45)
    iben.run(1, 'voucher', 'card', oid, 30, 45)
    iben.run(1, 'fastpass', 'card', oid, 0, 45)
    ipl.run(1, 150, 150, 'card', 'order', oid, '购买金卡赠送积分')
    iml.run(1, 'card', '购买金卡，赠免票券×1、消费券×2、快速通行券×1、150 积分', 7)
    // 银卡（会员2）：¥299，1 消费券，50 开卡分，到期日 20
    oid = Number(imo.run('HK0002', 2, 'new', 'silver', 299, 8, 1, '购买银卡').lastInsertRowid)
    iben.run(2, 'voucher', 'card', oid, 30, 20)
    ipl.run(2, 50, 50, 'card', 'order', oid, '购买银卡赠送积分')
    iml.run(2, 'card', '购买银卡，赠消费券×1、50 积分', 8)
    iml.run(3, 'register', '前台注册会员', null)
    iml.run(1, 'register', '前台注册会员', 7)
    iml.run(2, 'register', '前台注册会员', 8)
  }
}
seed()

// ---------- 老库兼容：幂等补齐排班模块基础数据（班次模板 / 运营主管 / 模块参数） ----------
function ensureScheduleBaseData() {
  const hasShifts = db.prepare('SELECT COUNT(*) n FROM shift_templates').get().n
  if (!hasShifts) {
    const ish = db.prepare(`INSERT INTO shift_templates
        (code,name,start_hour,end_hour,cross_day,standard_hours,color,sort)
        VALUES (?,?,?,?,?,?,?,?)`)
    ;[
      ['morning', '早班', 9, 14, 0, 5, '#66a6ff', 1],
      ['mid', '中班', 12, 17, 0, 5, '#6dd5a0', 2],
      ['evening', '晚班', 14, 18, 0, 4, '#a78bfa', 3],
      ['night', '夜班', 17, 9, 1, 6, '#ff9e64', 4]
    ].forEach(s => ish.run(...s))
  }
  if (!db.prepare("SELECT COUNT(*) n FROM staff WHERE role='运营主管'").get().n) {
    db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,?,?,?,?,?)')
      .run('林岚', '运营主管', 1, 420, 2, 80, 1)
  }
  for (const [k, v] of [
    ['scheduleAutoFill', 1],       // 自动补位总开关
    ['scheduleMode', 'dynamic'],   // auto=全员基础补位；dynamic=按客流/工单/投诉需求动态调度
    ['scheduleApproval', 0],       // 1=跨日动态调度计划需主管预览审批；0=引擎直接自动补位
    ['otRateMul', 1.5],
    // 动态调度参数：每个保安/保洁可承载的预约预测客流（人/班段）；夜班每个开放区域保安数
    ['dispatchGuardFlow', 500],
    ['dispatchCleanFlow', 700],
    ['dispatchNightGuardsPerZone', 0],  // 0=夜班不强制（按需动态补）；>0 时每 N 个区域至少 1 名夜勤保安
    ['groupDepositRate', 0.3],          // 团队订金比例
    ['groupEnabled', 1]                 // 领队组团模块开关
  ]) {
    if (!getSetting(k)) setSetting(k, String(v))
  }
}
ensureScheduleBaseData()

// ---------- 老库兼容：幂等补齐采购库存模块基础数据（供应商/物资/商铺供货物资/期初库存） ----------
function ensureProcurementBaseData() {
  const hasSupplier = db.prepare('SELECT COUNT(*) n FROM suppliers').get().n
  if (!hasSupplier) {
    const isup = db.prepare(`INSERT INTO suppliers(name,contact,phone,category,pay_term_days,rating,status,note,created_day)
                             VALUES(?,?,?,?,?,?, 'active',?,1)`)
    ;[
      ['鲜丰食材配送', '陈经理', '138-0010-2001', '食材', 7, 4, '日配生鲜，账期 7 天'],
      ['冰源饮品原料', '刘经理', '138-0010-2002', '饮品原料', 0, 5, '糖浆/杯材/冰块，货到即付'],
      ['欢乐文创供应链', '周经理', '138-0010-2003', '文创百货', 30, 4, '纪念品/玩具，月结 30 天'],
      ['绿岛包材商行', '吴店长', '138-0010-2004', '综合', 15, 3, '纸杯/包装袋/餐具耗材']
    ].forEach((s, i) => {
      const id = Number(isup.run(...s).lastInsertRowid)
      db.prepare('UPDATE suppliers SET code=? WHERE id=?').run('S' + String(id).padStart(4, '0'), id)
    })
  }

  const hasMat = db.prepare('SELECT COUNT(*) n FROM materials').get().n
  if (!hasMat) {
    // name, category, unit, std_cost, safety, shelfDays, auto, reorder, supplier
    const im = db.prepare(`INSERT INTO materials(name,category,unit,std_cost,safety_stock,shelf_days,auto_reorder,reorder_qty,preferred_supplier_id,status)
                           VALUES(?,?,?,?,?,?,?,?,?, 'active')`)
    const list = [
      ['爆米花原料(玉米粒+糖)', '食材', '份', 6, 60, 30, 1, 200, 1],
      ['热狗面包胚', '食材', '份', 5, 50, 5, 1, 180, 1],
      ['热狗肠', '食材', '根', 4, 50, 10, 1, 200, 1],
      ['柠檬糖浆', '饮品原料', '杯', 3, 60, 90, 1, 240, 2],
      ['一次性杯+吸管', '包材', '套', 1, 100, 0, 1, 400, 4],
      ['主题公仔玩偶', '文创百货', '个', 18, 20, 0, 1, 80, 3],
      ['纪念 T 恤', '文创百货', '件', 22, 15, 0, 1, 60, 3],
      ['益智玩具套装', '文创百货', '套', 15, 15, 0, 1, 60, 3]
    ]
    list.forEach(m => {
      const id = Number(im.run(...m).lastInsertRowid)
      db.prepare('UPDATE materials SET code=? WHERE id=?').run('M' + String(id).padStart(4, '0'), id)
    })
  }

  // 商铺 ↔ 物资：按商铺类型与名称关键词匹配（仅补未建立映射的商铺）
  const linked = db.prepare('SELECT COUNT(*) n FROM vendor_materials').get().n
  if (!linked) {
    const mats = db.prepare('SELECT * FROM materials').all()
    const byName = n => mats.find(m => m.name.includes(n))
    const il = db.prepare('INSERT OR IGNORE INTO vendor_materials(vendor_id,material_id) VALUES(?,?)')
    for (const v of db.prepare('SELECT * FROM vendors').all()) {
      const picks = []
      if (v.name.includes('爆米花')) picks.push(byName('爆米花'), mats.find(m => m.category === '包材'))
      else if (v.name.includes('热狗')) picks.push(byName('热狗面包胚'), byName('热狗肠'))
      else if (v.name.includes('柠檬')) picks.push(byName('柠檬糖浆'), mats.find(m => m.name.includes('杯')))
      else if (v.name.includes('纪念') && v.type === '纪念品') picks.push(byName('纪念 T 恤'), byName('主题公仔'))
      else if (v.name.includes('玩具')) picks.push(byName('益智玩具'), byName('主题公仔'))
      else if (v.type === '餐饮') picks.push(byName('爆米花'), mats.find(m => m.category === '包材'))
      else if (v.type === '饮品') picks.push(byName('柠檬糖浆'), mats.find(m => m.name.includes('杯')))
      else if (v.type === '纪念品') picks.push(byName('主题公仔'))
      picks.filter(Boolean).forEach(m => il.run(v.id, m.id))
    }
  }

  // 期初库存：给每个已映射物资补一笔期初入库批次（仅当物资无任何批次时）
  const day0 = Number(getSetting('day')) || 1
  for (const m of db.prepare('SELECT * FROM materials').all()) {
    const hasBatch = db.prepare('SELECT COUNT(*) n FROM inbound_batches WHERE material_id=?').get(m.id).n
    if (hasBatch) continue
    const initQty = Math.round(m.safety_stock * 2.4)
    const r = db.prepare(`INSERT INTO inbound_batches(order_id,material_id,supplier_id,qty_received,qty_remain,unit_cost,receive_day,expire_day,status,note)
                          VALUES(NULL,?,?,?,?,?,?,?, 'in','期初库存')`)
      .run(m.id, m.preferred_supplier_id, initQty, initQty, m.std_cost, day0,
           m.shelf_days > 0 ? day0 + m.shelf_days : 0)
    const bid = Number(r.lastInsertRowid)
    db.prepare('UPDATE inbound_batches SET code=? WHERE id=?').run('RK' + String(bid).padStart(4, '0'), bid)
    db.prepare(`INSERT INTO inventory(material_id,qty_on_hand,qty_reserved,updated_tick)
                VALUES(?,?,0,0) ON CONFLICT(material_id) DO UPDATE SET qty_on_hand=excluded.qty_on_hand`)
      .run(m.id, initQty)
    db.prepare(`INSERT INTO stock_movements(material_id,batch_id,vendor_id,change,qty_after,reason,ref_type,ref_id,day,tick)
                VALUES(?,?,NULL,?,?, 'in','batch',?,?,0)`)
      .run(m.id, bid, initQty, initQty, bid, day0)
  }
}
ensureProcurementBaseData()

export default db
export { now, getSetting, setSetting, tx, afterCommit }