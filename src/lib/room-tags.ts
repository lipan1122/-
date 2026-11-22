/**
 * 房态快捷标签（第 5 轮 P1-4）
 *
 * ── 背景 ──
 * 去呼呼房态页提供 12 个常用标签：钟点 / 联房 / 欠费 / 未成年 / 会员 / 团队 /
 * 免费 / 自用 / 待打扫 / 打扫中 / 待审 / 常客。
 * 本地原来只定义了「钟点、联房」两个（欠费只算了统计没进标签栏），
 * 且数量与筛选口径各写一份，容易对不上。
 *
 * ── 这个文件为什么是纯函数 ──
 * 标签要同时被两边用：
 *   · 服务端（rooms/page.tsx）—— 统计每个标签的房间数（SQL）
 *   · 客户端（RoomBoard.tsx）—— 点击标签过滤房间（JS）
 * 两边判定条件必须**完全一致**，否则会出现「标签写 3 间、点进去 2 间」。
 *
 * 而 `src/lib/metrics.ts` 那种导入了 `@/lib/db` 的服务端模块不能进客户端组件，
 * 所以把「判定条件」抽成本文件：**不 import 任何服务端模块**，
 * 只导出 JS 判定函数 + 与之等价的 SQL 片段（片段由服务端页面拼接，客户端只用函数）。
 *
 * ── 字段来源（已用 PRAGMA table_info 逐张表核对） ──
 *   钟点   stays.rate_code = '钟点' 或 stays.nights = 0
 *   联房   room_links（同一 link_no 组内的在住单数 > 1）
 *   欠费   folios.balance > 0.01
 *   未成年 guests.id_no（18 位身份证第 7-14 位是生日，推算 < 18 岁）
 *   会员   stays.member_card 非空 或 guests.vip_level > 0
 *   团队   stays.team_name 非空
 *   免费   stays.rate = 0
 *   自用   stays.self_use = 1（入住单上的显式标记，与免费房无关）
 *   待打扫 housekeeping.status = 'PENDING'（task_type='打扫'）
 *   打扫中 housekeeping.status = 'DOING'（task_type='打扫'）
 *   待审   housekeeping.review_status = 'PENDING_REVIEW'（task_type='打扫'）
 *   常客   guests 在该酒店的历史入住次数 >= 3
 *
 * ── 第 5 轮 P1-4 修正的三处语义错误（上一版做错了） ──
 * 1. 「打扫中」上一版标成「缺字段」是错的：housekeeping.status 本来就有 DOING，
 *    只是当时没有把任务推进到 DOING 的入口（只有 PENDING → DONE），库里没数据
 *    被误判成没字段。现在补了「开始打扫」动作，标签直接查 DOING。
 * 2. 「待审」上一版映射 cancel_requests.status = 'PENDING'，语义完全不对：
 *    那是**取消入住审批**（客人要退房，等主管批不批），不是客房打扫验收。
 *    现在改为 housekeeping.review_status = 'PENDING_REVIEW'，见下一条。
 * 3. 客房审核是独立维度，新增 housekeeping.review_status（迁移第 20 段）：
 *    status 表达任务流转（PENDING / DOING / DONE / CANCELLED），
 *    review_status 表达验收结果（NULL / PENDING_REVIEW / APPROVED / REJECTED）。
 *    混在一个字段里会让「已打扫但未验收」和「打扫中」无法区分。
 * 4. 「自用」新增 stays.self_use（同样在迁移第 20 段），**不拿 rate=0 当自用**：
 *    免费房有促销/赔付/招待等多种来源，用房价反推入住性质必然算错。
 *
 * 12 个标签现在全部有真实数据来源（available 均为 true），不再有灰显项。
 */

/** 12 个快捷标签的 key（顺序即界面顺序，与去呼呼一致） */
export type RoomTagKey =
  | "hourly"
  | "linked"
  | "owed"
  | "minor"
  | "member"
  | "team"
  | "free"
  | "selfUse"
  | "dirty"
  | "cleaning"
  | "pendingApprove"
  | "regular";

export type RoomTagDef = {
  key: RoomTagKey;
  label: string;
  /** 悬浮提示：判定口径说明 */
  hint: string;
  /**
   * 是否已具备数据来源（false = 缺字段，界面灰显、不可点击）
   *
   * 第 5 轮 P1-4 修正后 12 个标签全部为 true（「自用 / 打扫中 / 待审」
   * 三个原来有问题或灰显的标签都已接上真实字段）。
   */
  available: boolean;
  /** 缺字段时的说明（available=false 时展示；当前没有标签用到，保留给以后新增标签） */
  missing?: string;
};

export const ROOM_TAGS: RoomTagDef[] = [
  {
    key: "hourly",
    label: "钟点",
    hint: "在住单的价码为「钟点」或晚数为 0",
    available: true,
  },
  {
    key: "linked",
    label: "联房",
    hint: "room_links 里同一联房组内有 2 间及以上在住",
    available: true,
  },
  {
    key: "owed",
    label: "欠费",
    hint: "账单余额 > 0.01（欠款未结清）",
    available: true,
  },
  {
    key: "minor",
    label: "未成年",
    hint: "在住客人身份证号（18 位）推算年龄小于 18 岁",
    available: true,
  },
  {
    key: "member",
    label: "会员",
    hint: "入住单有会员卡号，或客史档案 VIP 等级 > 0",
    available: true,
  },
  {
    key: "team",
    label: "团队",
    hint: "入住单团队名称非空",
    available: true,
  },
  {
    key: "free",
    label: "免费",
    hint: "当日房价为 0（免单 / 赠送 / 赔付等；自用房请在入住时勾选「自用」，不靠房价推断）",
    available: true,
  },
  {
    key: "selfUse",
    label: "自用",
    hint: "入住单勾选了「自用」（stays.self_use = 1），与房价为 0 无关",
    available: true,
  },
  {
    key: "dirty",
    label: "待打扫",
    hint: "该房有 PENDING 状态的打扫任务",
    available: true,
  },
  {
    key: "cleaning",
    label: "打扫中",
    hint: "该房有 DOING 状态的打扫任务（阿姨在客房中心/手机上点过「开始打扫」）",
    available: true,
  },
  {
    key: "pendingApprove",
    label: "待审",
    hint: "该房打扫已完成、等主管验收（housekeeping.review_status = PENDING_REVIEW）；与取消入住审批无关",
    available: true,
  },
  {
    key: "regular",
    label: "常客",
    hint: "该客人在本酒店历史入住次数 ≥ 3",
    available: true,
  },
];

/** 标签定义按 key 取（界面渲染用） */
export const ROOM_TAG_MAP: Record<RoomTagKey, RoomTagDef> = ROOM_TAGS.reduce(
  (acc, t) => {
    acc[t.key] = t;
    return acc;
  },
  {} as Record<RoomTagKey, RoomTagDef>
);

/** 全部标签 key（统计结果、props 校验用） */
export const ROOM_TAG_KEYS: RoomTagKey[] = ROOM_TAGS.map((t) => t.key);

/**
 * 判定一个标签需要的最小房间字段集
 *
 * 用结构类型而不是 import RoomRow，避免 lib ←→ component 的循环依赖；
 * RoomBoard 的 RoomRow 只要字段名对上即可直接传入。
 */
export type RoomTagFields = {
  /** 房态：VC/VD/OC/OD/OOO/LOCK */
  status: string;
  nights?: number | null;
  rate_code?: string | null;
  /** 当日房价（免费房 = 0） */
  rate?: number | null;
  /** 账单余额（> 0 即欠费） */
  balance?: number | null;
  member_card?: string | null;
  team_name?: string | null;
  /** 客人 VIP 等级（guests.vip_level） */
  guest_vip_level?: number | null;
  /** 客人身份证号（guests.id_no），未成年标签用生日推算 */
  guest_id_no?: string | null;
  /** 该客人在本酒店的历史入住次数（含本次） */
  guest_stay_count?: number | null;
  /** room_links 同一联房组内的在住间数 */
  link_room_count?: number | null;
  /** 该房 PENDING 打扫任务数（待打扫） */
  hk_pending?: number | null;
  /** 该房 DOING 打扫任务数（打扫中，第 5 轮 P1-4 修正） */
  hk_doing?: number | null;
  /** 该房 review_status = PENDING_REVIEW 的打扫任务数（待审，第 5 轮 P1-4 修正） */
  hk_review_pending?: number | null;
  /** 入住单是否自用（stays.self_use，1 = 自用；第 5 轮 P1-4 新增） */
  stay_self_use?: number | null;
  /**
   * 该入住单 PENDING 取消申请数
   *
   * 第 5 轮 P1-4 之后**不再**用于「待审」标签：取消入住审批与客房审核是两件事。
   * 字段与对应的 SQL 片段保留，只是不再参与任何标签判定。
   */
  pending_cancel_count?: number | null;
};

/** 房态是否在住（只有在住房间才谈得上客人相关标签） */
export function isInhouseStatus(status: string): boolean {
  return status === "OC" || status === "OD";
}

/**
 * 由 18 位身份证号推算生日（YYYYMMDD），非法返回 null
 *
 * 只做格式判断（第 7-14 位数字），不校验校验码 —— 校验码校验属于
 * id-verify 页的职责（那边有完整 GB 11643 加权算法），这里只负责「未成年」判定。
 */
export function birthYmdFromIdNo(idNo: string | null | undefined): string | null {
  const s = (idNo ?? "").trim();
  if (s.length !== 18) return null;
  const ymd = s.slice(6, 14);
  if (!/^\d{8}$/.test(ymd)) return null;
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return ymd;
}

/** 本地今天，格式 YYYYMMDD（与 SQL 里的 strftime('%Y%m%d','now','localtime') 同口径） */
function todayYmd(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/**
 * 是否未成年：生日晚于「18 年前的今天」
 *
 * 例：今天 2026-11-22 → 分界 2008-11-22；
 *   2008-11-23 出生 = 17 岁（未成年，成立）
 *   2008-11-21 出生 = 18 岁（成年，不成立）
 * 用字符串比较即可，两边都是 8 位数字。
 */
export function isMinorByIdNo(idNo: string | null | undefined, now: Date = new Date()): boolean {
  const ymd = birthYmdFromIdNo(idNo);
  if (!ymd) return false;
  const cutoff = `${Number(todayYmd(now).slice(0, 4)) - 18}${todayYmd(now).slice(4)}`;
  return ymd > cutoff;
}

/** 单标签判定（与下方 SQL 片段严格等价） */
export function matchesRoomTag(
  key: RoomTagKey,
  room: RoomTagFields,
  now: Date = new Date()
): boolean {
  switch (key) {
    case "hourly":
      return room.rate_code === "钟点" || room.nights === 0;
    case "linked":
      return (room.link_room_count ?? 0) > 1;
    case "owed":
      return (room.balance ?? 0) > 0.01;
    case "minor":
      return isMinorByIdNo(room.guest_id_no ?? null, now);
    case "member":
      return !!room.member_card?.trim() || (room.guest_vip_level ?? 0) > 0;
    case "team":
      return !!room.team_name?.trim();
    case "free":
      return room.rate === 0;
    case "selfUse":
      /* 第 5 轮 P1-4：只认入住单上的显式「自用」标记，不拿 rate=0 反推 */
      return (room.stay_self_use ?? 0) === 1;
    case "dirty":
      return (room.hk_pending ?? 0) > 0;
    case "cleaning":
      /* 第 5 轮 P1-4：housekeeping.status 本来就有 DOING，不再当「缺字段」 */
      return (room.hk_doing ?? 0) > 0;
    case "pendingApprove":
      /* 第 5 轮 P1-4：客房审核（review_status）而非取消入住审批（cancel_requests） */
      return (room.hk_review_pending ?? 0) > 0;
    case "regular":
      return (room.guest_stay_count ?? 0) >= 3;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * SQL 片段：只由服务端页面（rooms/page.tsx）拼接使用
 * ------------------------------------------------------------------ *
 *
 * 与上面 matchesRoomTag 一一对应，保证「统计数量」和「点击筛选」同口径。
 *
 * 别名约定（拼接处必须提供这些别名）：
 *   r = rooms        当前行房间
 *   s = stays        当前房间的在住单（LEFT JOIN … AND status='INHOUSE'）
 *   f = folios       该入住单的账务单（LEFT JOIN folios f ON f.stay_id = s.id）
 *   g = guests       该入住单的客人档案（LEFT JOIN guests g ON g.id = s.guest_id）
 *
 * 未成年 / 常客 的日期与次数都用子查询完成，片段本身不带绑定参数，
 * 便于任意地方拼接而不必对齐参数顺序。
 */
export const ROOM_TAG_SQL = {
  /** 钟点：价码为钟点或晚数为 0 */
  hourly: `(COALESCE(s.rate_code, '') = '钟点' OR COALESCE(s.nights, 1) = 0)`,

  /** 联房：同一 link_no 组内 ≥ 2 间在住（room_links 表口径） */
  linked: `(
    SELECT COUNT(*) FROM room_links rl2
      JOIN stays s2 ON s2.id = rl2.stay_id AND s2.status = 'INHOUSE'
     WHERE rl2.hotel_id = r.hotel_id
       AND rl2.link_no IN (SELECT rl.link_no FROM room_links rl
                            WHERE rl.hotel_id = r.hotel_id AND rl.stay_id = s.id)
  ) > 1`,

  /** 欠费：账单余额 > 0.01 */
  owed: `COALESCE(f.balance, 0) > 0.01`,

  /** 未成年：18 位身份证生日晚于「18 年前的今天」 */
  minor: `(
    length(COALESCE(g.id_no, '')) = 18
    AND substr(g.id_no, 7, 8) GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
    AND substr(g.id_no, 7, 8) > strftime('%Y%m%d', 'now', 'localtime', '-18 years')
  )`,

  /** 会员：入住单有会员卡号，或客史 VIP 等级 > 0 */
  member: `(COALESCE(TRIM(s.member_card), '') <> '' OR COALESCE(g.vip_level, 0) > 0)`,

  /** 团队：团队名非空 */
  team: `COALESCE(TRIM(s.team_name), '') <> ''`,

  /** 免费：当日房价为 0 */
  free: `COALESCE(s.rate, -1) = 0`,

  /**
   * 自用：入住单勾选了「自用」
   *
   * 第 5 轮 P1-4：改用 stays.self_use（迁移第 20 段新增）。
   * 这里刻意**不写** `OR s.rate = 0` —— 免费房不等于自用房。
   */
  selfUse: `COALESCE(s.self_use, 0) = 1`,

  /** 待打扫：有 PENDING 打扫任务 */
  dirty: `(
    SELECT COUNT(*) FROM housekeeping hk
     WHERE hk.hotel_id = r.hotel_id AND hk.room_id = r.id
       AND hk.task_type = '打扫' AND hk.status = 'PENDING'
  ) > 0`,

  /**
   * 打扫中：有 DOING 打扫任务
   *
   * 第 5 轮 P1-4：housekeeping.status 一直有 DOING（只是当时没有入口把任务
   * 从 PENDING 推进到 DOING，库里没数据被误判成缺字段）。入口补在
   * housekeeping 页「开始打扫」/ 移动端「开始打扫」。
   */
  cleaning: `(
    SELECT COUNT(*) FROM housekeeping hk
     WHERE hk.hotel_id = r.hotel_id AND hk.room_id = r.id
       AND hk.task_type = '打扫' AND hk.status = 'DOING'
  ) > 0`,

  /**
   * 待审：有打扫完成、等主管验收的任务
   *
   * 第 5 轮 P1-4：review_status = 'PENDING_REVIEW'。
   * 上一版查的是 cancel_requests.status = 'PENDING'（取消入住审批），
   * 语义完全不同，已删除该口径。
   */
  pendingApprove: `(
    SELECT COUNT(*) FROM housekeeping hk
     WHERE hk.hotel_id = r.hotel_id AND hk.room_id = r.id
       AND hk.task_type = '打扫' AND hk.review_status = 'PENDING_REVIEW'
  ) > 0`,

  /** 常客：本酒店历史入住次数 ≥ 3 */
  regular: `(
    SELECT COUNT(*) FROM stays s3
     WHERE s3.hotel_id = r.hotel_id AND s3.guest_id = s.guest_id
       AND s3.guest_id IS NOT NULL
       AND s3.status IN ('INHOUSE', 'CHECKED_OUT')
  ) >= 3`,
} as const;

/**
 * 行字段 SQL：房间列表查询里一并算好，供客户端筛选与卡片展示
 *
 * 与 ROOM_TAG_SQL 用同一批子查询表达式，避免「统计」和「明细」两套口径。
 */
export const ROOM_TAG_FIELD_SQL = {
  /** 联房：同一联房组内的在住间数 */
  link_room_count: `(
    SELECT COUNT(*) FROM room_links rl2
      JOIN stays s2 ON s2.id = rl2.stay_id AND s2.status = 'INHOUSE'
     WHERE rl2.hotel_id = r.hotel_id
       AND rl2.link_no IN (SELECT rl.link_no FROM room_links rl
                            WHERE rl.hotel_id = r.hotel_id AND rl.stay_id = s.id)
  )`,
  guest_vip_level: `g.vip_level`,
  guest_id_no: `g.id_no`,
  guest_stay_count: `(
    SELECT COUNT(*) FROM stays s3
     WHERE s3.hotel_id = r.hotel_id AND s3.guest_id = s.guest_id
       AND s3.guest_id IS NOT NULL
       AND s3.status IN ('INHOUSE', 'CHECKED_OUT')
  )`,
  hk_pending: `(
    SELECT COUNT(*) FROM housekeeping hk
     WHERE hk.hotel_id = r.hotel_id AND hk.room_id = r.id
       AND hk.task_type = '打扫' AND hk.status = 'PENDING'
  )`,
  /** 打扫中（第 5 轮 P1-4）：DOING 打扫任务数 */
  hk_doing: `(
    SELECT COUNT(*) FROM housekeeping hk
     WHERE hk.hotel_id = r.hotel_id AND hk.room_id = r.id
       AND hk.task_type = '打扫' AND hk.status = 'DOING'
  )`,
  /** 待审（第 5 轮 P1-4）：review_status = PENDING_REVIEW 的打扫任务数 */
  hk_review_pending: `(
    SELECT COUNT(*) FROM housekeeping hk
     WHERE hk.hotel_id = r.hotel_id AND hk.room_id = r.id
       AND hk.task_type = '打扫' AND hk.review_status = 'PENDING_REVIEW'
  )`,
  /** 自用（第 5 轮 P1-4）：stays.self_use，未勾选为 0 */
  stay_self_use: `COALESCE(s.self_use, 0)`,
  /**
   * 取消入住审批数
   *
   * 第 5 轮 P1-4 之后不再用于「待审」标签（那是客房验收，不是取消审批）。
   * 保留片段是因为房态行里可能仍要展示这个数字，删掉会连带改其他调用方。
   */
  pending_cancel_count: `(
    SELECT COUNT(*) FROM cancel_requests cr
     WHERE cr.hotel_id = r.hotel_id AND cr.stay_id = s.id AND cr.status = 'PENDING'
  )`,
} as const;
