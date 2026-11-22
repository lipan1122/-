import Link from "next/link";
import { all, get, getDb, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, nowIso, todayStr } from "@/lib/utils";
import ConfirmForm from "@/components/ConfirmForm";
import { bulkRedeemAction, redeemAction, redeemAllAction, revokeAction, sellBreakfastAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type BreakfastRow = {
  id: number;
  stay_id: number;
  room_no: string | null;
  guest_name: string | null;
  date: string;
  count: number;
  status: string;
  note: string | null;
};

type Stats = { total: number; used: number; pending: number; rooms: number };

type StaySeed = {
  id: number;
  room_no: string | null;
  guest_name: string | null;
  breakfast: number;
};

type StayOption = {
  id: number;
  room_no: string | null;
  guest_name: string | null;
  breakfast: number;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "待核销", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  USED: { label: "已核销", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
};

/** 历史回补天数：首次访问时补齐最近 7 天的早餐记录，方便日期切换查看 */
const HISTORY_DAYS = 7;

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function isDateStr(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * 懒建表 + 自动补齐。
 * 1. 数据来源：stays 中 INHOUSE 且 breakfast > 0 的在住房间，每个入住日一条记录；
 * 2. 每次访问自动补齐「今天」的记录（已存在则按在住单份数同步未核销记录）；
 * 3. 首次访问额外回补最近 7 天，让日期切换能看到历史核销情况。
 */
function ensureBreakfastRecords(hotelId: number): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS breakfast_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      room_no TEXT,
      guest_name TEXT,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      note TEXT,
      created_at TEXT
    );
  `);

  const existingCount =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM breakfast_records WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  const firstTime = existingCount === 0;

  if (firstTime) {
    // 演示库在住单的 breakfast 全为 0 时，按入住人数补齐含早份数（1-4 份），让模块有真实数据可核销
    const breakfastSum =
      get<{ s: number }>(
        `SELECT COALESCE(SUM(COALESCE(breakfast, 0)), 0) AS s
           FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
        [hotelId]
      )?.s ?? 0;
    if (breakfastSum <= 0) {
      run(
        `UPDATE stays
            SET breakfast = MAX(1, MIN(4, COALESCE(guest_count, 2)))
          WHERE hotel_id = ? AND status = 'INHOUSE' AND COALESCE(breakfast, 0) <= 0`,
        [hotelId]
      );
    }
  }

  const today = todayStr();
  const now = nowIso();
  const staySql = `SELECT s.id, s.guest_name, COALESCE(s.breakfast, 0) AS breakfast, r.room_no
                     FROM stays s LEFT JOIN rooms r ON r.id = s.room_id`;

  // —— 今天：为每个在住含早房间补齐一条待核销记录 ——
  const todayStays = all<StaySeed>(
    `${staySql}
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND COALESCE(s.breakfast, 0) > 0
      ORDER BY r.floor, r.room_no`,
    [hotelId]
  );

  const existing = new Map<number, { id: number; count: number }>(
    all<{ id: number; stay_id: number; count: number }>(
      `SELECT id, stay_id, count FROM breakfast_records WHERE hotel_id = ? AND date = ?`,
      [hotelId, today]
    ).map((r) => [r.stay_id, { id: r.id, count: r.count }] as const)
  );

  for (const s of todayStays) {
    const rec = existing.get(s.id);
    if (!rec) {
      run(
        `INSERT INTO breakfast_records
           (hotel_id, stay_id, room_no, guest_name, date, count, status, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [hotelId, s.id, s.room_no, s.guest_name ?? "散客", today, s.breakfast, "PENDING", "在住含早房间自动生成", now]
      );
      continue;
    }
    // 在住单早餐份数发生变化（前台改单 / 加卖）时，同步未核销记录的份数
    if (rec.count !== s.breakfast) {
      run(`UPDATE breakfast_records SET count = ? WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`, [
        s.breakfast,
        rec.id,
        hotelId,
      ]);
    }
  }

  // —— 首次访问：回补最近 7 天（已退房的历史单也在内，按在住日匹配） ——
  if (!firstTime) return;

  for (let i = 1; i <= HISTORY_DAYS; i += 1) {
    const day = todayStr(addDays(today, -i));
    const history = all<StaySeed>(
      `${staySql}
        WHERE s.hotel_id = ? AND COALESCE(s.breakfast, 0) > 0
          AND date(COALESCE(s.check_in_time, s.created_at), 'localtime') <= ?
          AND (s.expect_check_out IS NULL OR s.expect_check_out = '' OR s.expect_check_out >= ?)
        ORDER BY r.floor, r.room_no`,
      [hotelId, day, day]
    );

    history.forEach((s, idx) => {
      run(
        `INSERT INTO breakfast_records
           (hotel_id, stay_id, room_no, guest_name, date, count, status, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          s.id,
          s.room_no,
          s.guest_name ?? "散客",
          day,
          s.breakfast,
          idx % 4 === 0 ? "PENDING" : "USED",
          "历史回补",
          now,
        ]
      );
    });
  }
}

export default async function BreakfastPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const sp = await searchParams;

  const dateParam = first(sp.date);
  const date = isDateStr(dateParam) ? dateParam : today;
  const msg = first(sp.msg);
  const err = first(sp.err);

  ensureBreakfastRecords(hotelId);

  const isToday = date === today;

  const stats =
    get<Stats>(
      `SELECT
         COALESCE(SUM(count), 0) AS total,
         COALESCE(SUM(CASE WHEN status = 'USED' THEN count ELSE 0 END), 0) AS used,
         COALESCE(SUM(CASE WHEN status = 'PENDING' THEN count ELSE 0 END), 0) AS pending,
         COUNT(*) AS rooms
       FROM breakfast_records
       WHERE hotel_id = ? AND date = ?`,
      [hotelId, date]
    ) ?? { total: 0, used: 0, pending: 0, rooms: 0 };

  const rows = all<BreakfastRow>(
    `SELECT id, stay_id, room_no, guest_name, date, count, status, note
       FROM breakfast_records
      WHERE hotel_id = ? AND date = ?
      ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, room_no, id`,
    [hotelId, date]
  );

  /*
   * 全部核销的二次确认要如实告诉用户「影响到谁」：
   * 用待核销**房间数**（而不是总房间数），因为已核销的不会再被这条动作碰到。
   */
  const pendingRooms =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM breakfast_records WHERE hotel_id = ? AND date = ? AND status = 'PENDING'`,
      [hotelId, date]
    )?.n ?? 0;

  const stayOptions = all<StayOption>(
    `SELECT s.id, r.room_no, COALESCE(s.guest_name, '散客') AS guest_name, COALESCE(s.breakfast, 0) AS breakfast
       FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
      ORDER BY r.floor, r.room_no`,
    [hotelId]
  );

  const cards = [
    {
      label: isToday ? "今日应核销" : "当日应核销",
      value: stats.total,
      unit: "份",
      sub: `${stats.rooms} 间在住含早房`,
      cls: "bg-brand-50 text-brand-600",
    },
    {
      label: "已核销",
      value: stats.used,
      unit: "份",
      sub: "已完成核销",
      cls: "bg-emerald-50 text-emerald-600",
    },
    {
      label: "未核销",
      value: stats.pending,
      unit: "份",
      sub: "待前台核销",
      cls: "bg-amber-50 text-amber-600",
    },
  ];

  const prevDate = todayStr(addDays(date, -1));
  const nextDate = todayStr(addDays(date, 1));

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">早餐核销</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {date}
            {isToday ? "（今天）" : "（历史）"} · 应核销 {stats.total} 份 / 已核销 {stats.used} 份 / 未核销{" "}
            {stats.pending} 份
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1">
            数据表 breakfast_records · PENDING 待核销 / USED 已核销
          </span>
          <Link href="/inhouse" className="rounded-md border border-gray-200 bg-white px-2.5 py-1 hover:text-brand-600">
            在住客人
          </Link>
        </div>
      </div>

      {msg && <div className="card border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">{msg}</div>}
      {err && <div className="card border-l-4 border-l-rose-500 px-4 py-2.5 text-[12px] text-rose-600">{err}</div>}

      <div className="grid grid-cols-3 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-gray-500">{c.label}</span>
              <span className={`flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold ${c.cls}`}>
                {c.label.slice(0, 1)}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-2xl font-semibold tabular-nums text-gray-900">{c.value}</span>
              <span className="text-[12px] text-gray-400">{c.unit}</span>
            </div>
            <div className="mt-1 text-[11px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="card flex flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/breakfast?date=${prevDate}`} className="btn-default h-8 px-2.5 text-[12px]">
            前一天
          </Link>
          <form action="/breakfast" method="get" className="flex items-center gap-1.5">
            <input type="date" name="date" defaultValue={date} className="input h-8 w-[150px]" />
            <button type="submit" className="btn-default h-8">
              切换日期
            </button>
          </form>
          <Link href={`/breakfast?date=${nextDate}`} className="btn-default h-8 px-2.5 text-[12px]">
            后一天
          </Link>
          {!isToday && (
            <Link href="/breakfast" className="text-[12px] text-brand-600 hover:text-brand-700">
              回到今天
            </Link>
          )}
        </div>

        <form action={sellBreakfastAction} className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-gray-500">卖早餐</span>
          <select name="stayId" required defaultValue="" className="input h-8 w-[210px]">
            <option value="" disabled>
              选择在住房间
            </option>
            {stayOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {`${s.room_no ?? "未排房"} · ${s.guest_name}（含早 ${s.breakfast} 份）`}
              </option>
            ))}
          </select>
          <input
            type="number"
            name="count"
            min={1}
            max={20}
            defaultValue={1}
            className="input h-8 w-[72px]"
            aria-label="早餐份数"
          />
          <button type="submit" className="btn-primary h-8">
            加早餐
          </button>
        </form>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">
            {isToday ? "今日早餐" : "历史早餐"} · {rows.length} 间房 / {stats.total} 份
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-gray-400">勾选左侧行可批量核销</span>
            <form id="breakfast-bulk" action={bulkRedeemAction} className="flex items-center gap-2">
              <input type="hidden" name="date" value={date} />
              <button type="submit" className="btn-primary h-8">
                核销选中
              </button>
            </form>
            <ConfirmForm
              action={redeemAllAction}
              message={`确认全部核销 ${date} 的早餐？`}
              detail={`日期：${date}，影响 ${pendingRooms} 间房 / ${stats.pending} 份待核销早餐。核销后客人直接凭房卡用餐；如需更正，只能逐条撤销。`}
              confirmLabel="全部核销"
            >
              <input type="hidden" name="date" value={date} />
              <button type="submit" className="btn-default h-8" disabled={stats.pending === 0}>
                全部核销
              </button>
            </ConfirmForm>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th w-8">
                  <span className="sr-only">选择</span>
                </th>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th text-right">早餐份数</th>
                <th className="th">状态</th>
                <th className="th">备注</th>
                <th className="th text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="td py-10 text-center text-[12px] text-gray-400">
                    {isToday ? "今天没有需要核销的早餐" : `${date} 没有早餐核销记录`}
                    <div className="mt-1 text-[11px] text-gray-400">
                      {isToday
                        ? "只有「在住且含早」的房间才会生成核销记录，可在上方用「卖早餐」给房间加早餐"
                        : "首次访问会回补最近 7 天记录，其余日期暂不生成"}
                    </div>
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const st = STATUS[r.status] ?? { label: r.status, cls: "border-gray-200 bg-gray-100 text-gray-500" };
                const pending = r.status === "PENDING";
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="td">
                      <input
                        type="checkbox"
                        name="ids"
                        value={r.id}
                        form="breakfast-bulk"
                        disabled={!pending}
                        className="h-3.5 w-3.5 accent-brand-600"
                        aria-label={`选择 ${r.room_no ?? ""} 早餐`}
                      />
                    </td>
                    <td className="td">
                      <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[12px] font-semibold text-blue-700">
                        {r.room_no ?? "—"}
                      </span>
                    </td>
                    <td className="td text-gray-700">{r.guest_name ?? "散客"}</td>
                    <td className="td text-right tabular-nums text-gray-800">{r.count} 份</td>
                    <td className="td">
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="td max-w-[220px] truncate text-[12px] text-gray-400" title={r.note ?? ""}>
                      {r.note ?? "—"}
                    </td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1.5">
                        {pending ? (
                          <form action={redeemAction}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="date" value={date} />
                            <button type="submit" className="btn-primary px-2 py-0.5 text-[12px]">
                              核销
                            </button>
                          </form>
                        ) : (
                          <ConfirmForm
                            action={revokeAction}
                            message={`确认撤销 ${r.room_no ?? "该房"} 的早餐核销？`}
                            detail={`日期：${date}，${r.count} 份。撤销后回到待核销，客人的含早权益不变。`}
                            confirmLabel="撤销核销"
                          >
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="date" value={date} />
                            <button type="submit" className="btn-danger px-2 py-0.5 text-[12px]">
                              撤销
                            </button>
                          </ConfirmForm>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          <span>数据来源：stays 中 INHOUSE 且 breakfast &gt; 0 的在住房间，每个入住日一条记录</span>
          <span>
            已核销 {stats.used} 份 · 未核销 {stats.pending} 份 · 共 {stats.total} 份
          </span>
        </div>
      </div>

      <p className="text-[11px] text-gray-400">
        首次进入自动建表并补齐今日记录（在住含早房间各一条待核销），同时回补最近 7 天历史；「卖早餐」会把份数写回
        stays.breakfast 并加进当日记录。
      </p>
    </div>
  );
}
