/**
 * 小程序：叫醒服务
 *
 * POST /api/mini/stays/:id/wakeup   { wakeTime: "07:30" | "2026-11-23 07:30", note?, requestId }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、两处落库，各有各的用处
 * ══════════════════════════════════════════════════════════════════════════
 *   1. `mini_service_requests`（service_type = WAKEUP, status = PENDING）
 *      —— 客人侧台账：他能在小程序「服务请求」里看到自己提过什么、处理了没有。
 *      同时这张表的 (hotel_id, request_id) 唯一索引就是叫醒的幂等凭证。
 *   2. `wake_up_calls` —— PC 端真正执行叫醒的地方（收银台 / 客人档案 / 客房都在读，
 *      见 src/app/(main)/rooms/actions.ts 的 setWakeUpAction）。
 *      只写台账不写这张表，客人提了叫醒前台根本看不到，等于没提。
 *
 * 两处写入在**同一个事务**里，且只有在台账行是新建时才写 wake_up_calls ——
 * 同一个 requestId 重放不会给客人登记两次叫醒（真实酒店里重复叫醒是投诉级别的错误）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、时间怎么归一
 * ══════════════════════════════════════════════════════════════════════════
 *   客户端可以只给 HH:MM（小程序通常这么给），也可以给完整 `YYYY-MM-DD HH:MM`。
 *   只给时间时按「下一个还没到的时刻」理解：
 *     · 现在 06:00，客人要 07:30 → 今天 07:30
 *     · 现在 22:00，客人要 07:30 → 明天 07:30
 *   绝不允许排到过去（否则 PC 端会看到一条永远叫不响的记录）。
 *   落库格式与 PC 端一致：`YYYY-MM-DD HH:MM`。
 */

import { getDb, run } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { fail, str } from "../../../_shared";
import { submitStayApplication } from "../_stay-actions";

export const dynamic = "force-dynamic";

/** 叫醒最多提前多少天登记（再远的客人大概率会改主意，也会让 PC 端列表变噪音） */
const MAX_WAKEUP_DAYS_AHEAD = 30;

/** HH:MM 校验 */
function isHourMinute(value: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return false;
  return Number(m[1]) >= 0 && Number(m[1]) <= 23 && Number(m[2]) >= 0 && Number(m[2]) <= 59;
}

/** `YYYY-MM-DD HH:MM` 校验（日期段必须是真实日期） */
function isFullDateTime(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, min] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const real =
    dt.getUTCFullYear() === Number(y) &&
    dt.getUTCMonth() === Number(mo) - 1 &&
    dt.getUTCDate() === Number(d);
  return real && Number(h) <= 23 && Number(min) <= 59;
}

/** 日期加一天（字符串运算，不经过时区） */
function addOneDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** 本地当前时间 HH:MM（用于判断「只给时间」时算今天还是明天） */
function nowLocalHHMM(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地时间戳 `YYYY-MM-DD HH:MM:SS`（与 PC 端 wake_up_calls.created_at 口径一致） */
function nowLocalStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把客户端时间归一成 `YYYY-MM-DD HH:MM`（且一定不在过去）。返回空串表示格式非法。
 */
function normalizeWakeTime(raw: string, today: string, nowHHMM: string): string {
  const v = raw.trim().replace("T", " ");
  if (isFullDateTime(v)) return v;
  if (!isHourMinute(v)) return "";
  /* 只给了时间：已经过去的点排到明天，避免「叫醒时间在过去」的脏数据 */
  return v <= nowHHMM ? `${addOneDay(today)} ${v}` : `${today} ${v}`;
}

/**
 * 老库兜底：wake_up_calls 目前是「懒建表」（PC 端 rooms/actions.ts 第一次叫醒时建）。
 * 全新库 / 没人用过叫醒的库上，本接口必须先保证表存在，否则第一次叫醒就 no such table。
 * DDL 与 PC 端 setWakeUpAction 里的逐列一致。
 */
function ensureWakeUpCallsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS wake_up_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      room_no TEXT,
      wake_time TEXT NOT NULL,
      note TEXT,
      status TEXT DEFAULT 'PENDING',
      created_at TEXT
    );
  `);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  /** prepare 里算好的归一化时间；sideEffect / extra 复用同一份（不重复解析） */
  let plannedWakeTime = "";

  return submitStayApplication({
    req,
    scope: "mini:stay:wakeup",
    params: ctx.params,
    serviceType: "WAKEUP",
    prepare: (_stay, body, hotelId) => {
      const raw = str(body.wakeTime) || str(body.time);
      if (!raw) return { response: fail("BAD_REQUEST", "请选择叫醒时间", 400) };

      const today = bizToday(hotelId);
      const wakeTime = normalizeWakeTime(raw, today, nowLocalHHMM());
      if (!wakeTime) {
        return { response: fail("BAD_REQUEST", "叫醒时间格式应为 HH:MM（例如 07:30）", 400) };
      }

      /* 上限：最多提前 30 天 */
      let limit = today;
      for (let i = 0; i < MAX_WAKEUP_DAYS_AHEAD; i += 1) limit = addOneDay(limit);
      if (wakeTime.slice(0, 10) > limit) {
        return { response: fail("BAD_REQUEST", `叫醒时间最多可提前 ${MAX_WAKEUP_DAYS_AHEAD} 天登记`, 400) };
      }

      const note = str(body.note).slice(0, 120);
      plannedWakeTime = wakeTime;
      return { note: `叫醒 ${wakeTime}${note ? `；备注：${note}` : ""}` };
    },
    sideEffect: ({ hotelId, stay }) => {
      ensureWakeUpCallsTable();
      run(
        `INSERT INTO wake_up_calls (hotel_id, stay_id, room_no, wake_time, note, status, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [hotelId, stay.id, stay.roomNo, plannedWakeTime, "小程序提交", "PENDING", nowLocalStamp()]
      );
    },
    extra: () => ({ wakeTime: plannedWakeTime }),
  });
}
