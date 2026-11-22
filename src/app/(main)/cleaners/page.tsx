import { all, get, getDb, run, tx } from "@/lib/db";
import { hasPermission, requireUser } from "@/lib/session";
import { addDays, nowIso, todayStr } from "@/lib/utils";
import { addCleanerAction, setCleanerStatusAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type CleanerRow = {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  created_at: string | null;
  area: string | null;
  room_count: number | null;
};

type PerfRow = { name: string; today: number; week: number; month: number; total: number };

type FloorAgg = { name: string; floor: number; n: number };

type RoomSeed = { id: number; floor: number | null };

/** 种子打扫员：姓名与既有 housekeeping.assignee 对齐，负责楼层用于生成可读的业绩数据 */
const SEED_CLEANERS: { name: string; phone: string; floors: number[] }[] = [
  { name: "赵阿姨", phone: "138 0000 1001", floors: [2, 3] },
  { name: "钱阿姨", phone: "138 0000 1002", floors: [4] },
  { name: "孙阿姨", phone: "138 0000 1003", floors: [5, 6] },
];

/** 历史业绩回补天数（含今天之外） */
const HISTORY_DAYS = 14;

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "在岗", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  INACTIVE: { label: "已停用", cls: "border-gray-200 bg-gray-100 text-gray-500" },
};

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** 「MM-DD」 */
function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/** 本周一（周一起算） */
function weekStartOf(today: string): string {
  const d = new Date(`${today}T00:00:00`);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return todayStr(d);
}

/** 插入一条「已完成」的客房打扫任务（演示业绩数据） */
function insertDoneTask(
  hotelId: number,
  roomId: number,
  assignee: string,
  day: string,
  hour: number,
  minute: number,
  now: Date
): void {
  // 用分钟偏移构造时间，避免 hour / minute 溢出组合出的非法时间
  const created = new Date(`${day}T00:00:00`);
  created.setMinutes(hour * 60 + minute);
  let done = new Date(created.getTime() + (20 + ((roomId * 7) % 30)) * 60000);
  let started = created;
  // 今天的数据可能早于当前时刻，避免出现「未来完成」
  if (done.getTime() > now.getTime()) {
    done = now;
    started = new Date(now.getTime() - 25 * 60000);
  }
  run(
    `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at, done_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [hotelId, roomId, "打扫", "DONE", assignee, "演示业绩数据", started.toISOString(), done.toISOString()]
  );
}

/**
 * 回补业绩数据：仅当本酒店还没有任何已完成（done_at 非空）的客房任务时执行，
 * 给 3 名打扫员生成今日 2 间 + 最近 14 天的已完成任务，业绩报表因此有真实统计。
 */
function seedPerformance(hotelId: number): void {
  const doneCount =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM housekeeping WHERE hotel_id = ? AND done_at IS NOT NULL`,
      [hotelId]
    )?.n ?? 0;
  if (doneCount > 0) return;

  const rooms = all<RoomSeed>(`SELECT id, floor FROM rooms WHERE hotel_id = ? ORDER BY floor, room_no`, [hotelId]);
  if (rooms.length === 0) return;

  const today = todayStr();
  const now = new Date();

  tx(() => {
    SEED_CLEANERS.forEach((cleaner, idx) => {
      const pool = rooms.filter((r) => cleaner.floors.includes(Number(r.floor)));
      const usable = pool.length > 0 ? pool : rooms;

      // 今日已完成 2 间
      for (let k = 0; k < 2; k += 1) {
        const room = usable[(idx * 2 + k) % usable.length];
        insertDoneTask(hotelId, room.id, cleaner.name, today, 8 + k, 5 + k * 35, now);
      }

      // 最近 14 天：每人每天 1-3 间
      for (let d = 1; d <= HISTORY_DAYS; d += 1) {
        const day = todayStr(addDays(today, -d));
        const count = 1 + ((idx + d) % 3);
        for (let k = 0; k < count; k += 1) {
          const room = usable[(idx * 5 + d * 3 + k) % usable.length];
          insertDoneTask(hotelId, room.id, cleaner.name, day, 8 + k, 10 + k * 25, now);
        }
      }
    });
  });
}

/** 懒建表 + 首次种子：建表、写入 3 名打扫员、回补业绩数据 */
function ensureCleaners(hotelId: number): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS cleaners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    );
  `);

  const existing = get<{ n: number }>(`SELECT COUNT(*) AS n FROM cleaners WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (existing > 0) return;

  const now = nowIso();
  for (const c of SEED_CLEANERS) {
    run(`INSERT INTO cleaners (hotel_id, name, phone, status, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      c.name,
      c.phone,
      "ACTIVE",
      now,
    ]);
  }

  seedPerformance(hotelId);
}

export default async function CleanersPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  /*
   * 打扫员档案 = 人事配置（整改清单 第六轮 一.9）：写操作要 settings.manage。
   * housekeeper 岗位能进本页看自己的业绩，但**不能改档案** ——
   * 服务端 addCleanerAction / setCleanerStatusAction 会直接 FORBIDDEN，页面也按同一权限隐藏入口。
   */
  const canManage = hasPermission(user.role, "settings.manage", hotelId);
  const today = todayStr();
  const sp = await searchParams;

  const msg = first(sp.msg);
  const err = first(sp.err);

  ensureCleaners(hotelId);

  const weekStart = weekStartOf(today);
  const month = today.slice(0, 7);

  const cleaners = all<CleanerRow>(
    `SELECT id, name, phone, status, created_at, area, room_count
       FROM cleaners
      WHERE hotel_id = ?
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, id`,
    [hotelId]
  );

  const perfRows = all<PerfRow>(
    `SELECT h.assignee AS name,
            SUM(CASE WHEN date(h.done_at, 'localtime') = ? THEN 1 ELSE 0 END) AS today,
            SUM(CASE WHEN date(h.done_at, 'localtime') >= ? THEN 1 ELSE 0 END) AS week,
            SUM(CASE WHEN strftime('%Y-%m', h.done_at, 'localtime') = ? THEN 1 ELSE 0 END) AS month,
            COUNT(*) AS total
       FROM housekeeping h
      WHERE h.hotel_id = ? AND h.status = 'DONE' AND h.done_at IS NOT NULL AND COALESCE(h.assignee, '') <> ''
      GROUP BY h.assignee`,
    [today, weekStart, month, hotelId]
  );

  const floorRows = all<FloorAgg>(
    `SELECT h.assignee AS name, r.floor AS floor, COUNT(*) AS n
       FROM housekeeping h JOIN rooms r ON r.id = h.room_id
      WHERE h.hotel_id = ? AND h.status = 'DONE' AND h.done_at IS NOT NULL
        AND COALESCE(h.assignee, '') <> '' AND r.floor IS NOT NULL
      GROUP BY h.assignee, r.floor
      ORDER BY COUNT(*) DESC, r.floor`,
    [hotelId]
  );

  const perfMap = new Map<string, PerfRow>(perfRows.map((p) => [p.name, p] as const));
  const floorMap = new Map<string, number[]>();
  for (const f of floorRows) {
    const arr = floorMap.get(f.name) ?? [];
    if (!arr.includes(Number(f.floor))) arr.push(Number(f.floor));
    floorMap.set(f.name, arr);
  }

  const activeCount = cleaners.filter((c) => c.status === "ACTIVE").length;
  const totalToday = perfRows.reduce((sum, p) => sum + Number(p.today ?? 0), 0);
  const totalWeek = perfRows.reduce((sum, p) => sum + Number(p.week ?? 0), 0);
  const totalMonth = perfRows.reduce((sum, p) => sum + Number(p.month ?? 0), 0);
  const totalAll = perfRows.reduce((sum, p) => sum + Number(p.total ?? 0), 0);

  const orphanNames = perfRows.map((p) => p.name).filter((n) => !cleaners.some((c) => c.name === n));

  const cards = [
    {
      label: "在岗打扫员",
      value: activeCount,
      unit: "名",
      sub: `共 ${cleaners.length} 名在册`,
      cls: "bg-brand-50 text-brand-600",
    },
    {
      label: "今日已打扫",
      value: totalToday,
      unit: "间",
      sub: today,
      cls: "bg-emerald-50 text-emerald-600",
    },
    {
      label: "本月已打扫",
      value: totalMonth,
      unit: "间",
      sub: `${month} 累计`,
      cls: "bg-violet-50 text-violet-600",
    },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">打扫员设置与业绩</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {today} · 在岗 {activeCount} 名 · 今日打扫 {totalToday} 间 · 本周 {totalWeek} 间 · 本月 {totalMonth} 间
          </p>
        </div>
        <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500">
          业绩口径：housekeeping 中已完成任务数（按 done_at 统计）
        </span>
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

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">打扫员列表 · {cleaners.length} 名</span>
          {canManage ? (
          <form action={addCleanerAction} className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              name="name"
              required
              maxLength={20}
              placeholder="姓名，如 王阿姨"
              className="input h-8 w-36"
            />
            <input type="text" name="phone" placeholder="电话（可空）" className="input h-8 w-40" />
            <button type="submit" className="btn-primary h-8">
              新增打扫员
            </button>
          </form>
          ) : (
            <span className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-500">
              只读：改档案需要「系统设置」权限
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">姓名</th>
                <th className="th">打扫区域</th>
                <th className="th text-right">房间数量</th>
                <th className="th">状态</th>
                <th className="th">电话</th>
                <th className="th text-right">今日打扫</th>
                <th className="th text-right">本月打扫</th>
                <th className="th text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {cleaners.length === 0 && (
                <tr>
                  <td colSpan={8} className="td py-10 text-center text-[12px] text-gray-400">
                    <span className="text-[#f0a020]">⚠</span> 暂无打扫员信息
                  </td>
                </tr>
              )}
              {cleaners.map((c) => {
                const perf = perfMap.get(c.name);
                const st = STATUS_LABEL[c.status] ?? { label: c.status, cls: "border-gray-200 bg-gray-100 text-gray-500" };
                const active = c.status === "ACTIVE";
                const area = c.area;
                const roomCount = c.room_count;
                return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 text-[12px] font-semibold text-brand-700">
                          {c.name.slice(0, 1)}
                        </span>
                        <span className="font-medium text-gray-800">{c.name}</span>
                      </div>
                    </td>
                    <td className="td text-gray-600">{area || "—"}</td>
                    <td className="td text-right tabular-nums text-gray-800">{roomCount ?? 0} 间</td>
                    <td className="td">
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="td tabular-nums text-gray-600">{c.phone ?? "—"}</td>
                    <td className="td text-right tabular-nums text-gray-800">{perf ? perf.today : 0} 间</td>
                    <td className="td text-right tabular-nums text-gray-800">{perf ? perf.month : 0} 间</td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1.5">
                        {canManage ? (
                        <form action={setCleanerStatusAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="status" value={active ? "INACTIVE" : "ACTIVE"} />
                          <button
                            type="submit"
                            className={
                              active ? "btn-danger px-2 py-0.5 text-[12px]" : "btn-default px-2 py-0.5 text-[12px]"
                            }
                          >
                            {active ? "停用" : "启用"}
                          </button>
                        </form>
                        ) : (
                          <span className="text-[11px] text-gray-300">无权限</span>
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
          <span>数据表 cleaners · 状态 ACTIVE 在岗 / INACTIVE 已停用（停用后不参与派单，历史业绩保留）</span>
          <span>在岗 {activeCount} 名 / 停用 {cleaners.length - activeCount} 名</span>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">业绩报表 · 按打扫员汇总</span>
          <span className="text-[11px] text-gray-400">本周从周一（{weekStart}）起算 · 本月 {month}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">打扫员</th>
                <th className="th">负责楼层</th>
                <th className="th text-right">今日完成</th>
                <th className="th text-right">本周完成</th>
                <th className="th text-right">本月完成</th>
                <th className="th text-right">累计完成</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              {cleaners.length === 0 && (
                <tr>
                  <td colSpan={7} className="td py-10 text-center text-[12px] text-gray-400">
                    暂无打扫员，无法统计业绩
                  </td>
                </tr>
              )}
              {cleaners.map((c) => {
                const perf = perfMap.get(c.name) ?? { name: c.name, today: 0, week: 0, month: 0, total: 0 };
                const floors = floorMap.get(c.name) ?? [];
                const st = STATUS_LABEL[c.status] ?? { label: c.status, cls: "border-gray-200 bg-gray-100 text-gray-500" };
                return (
                  <tr key={`perf-${c.id}`} className="hover:bg-gray-50">
                    <td className="td font-medium text-gray-800">{c.name}</td>
                    <td className="td">
                      {floors.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {floors.slice(0, 4).map((f) => (
                            <span
                              key={f}
                              className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-600"
                            >
                              {Number(f)} 层
                            </span>
                          ))}
                          {floors.length > 4 && <span className="text-[11px] text-gray-400">等 {floors.length} 层</span>}
                        </div>
                      ) : (
                        <span className="text-[12px] text-gray-300">未派单</span>
                      )}
                    </td>
                    <td className="td text-right tabular-nums text-gray-800">{perf.today} 间</td>
                    <td className="td text-right tabular-nums text-gray-800">{perf.week} 间</td>
                    <td className="td text-right tabular-nums text-gray-800">{perf.month} 间</td>
                    <td className="td text-right tabular-nums text-gray-500">{perf.total} 间</td>
                    <td className="td">
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {cleaners.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50">
                  <td className="td font-medium text-gray-700">合计</td>
                  <td className="td text-[12px] text-gray-400">{floorRows.length} 条楼层记录</td>
                  <td className="td text-right font-medium tabular-nums text-gray-800">{totalToday} 间</td>
                  <td className="td text-right font-medium tabular-nums text-gray-800">{totalWeek} 间</td>
                  <td className="td text-right font-medium tabular-nums text-gray-800">{totalMonth} 间</td>
                  <td className="td text-right font-medium tabular-nums text-gray-700">{totalAll} 间</td>
                  <td className="td text-[11px] text-gray-400">在岗 {activeCount} 名</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          <span>
            统计来源：housekeeping 表 status = DONE 且 done_at 非空的任务 · 负责楼层按打扫过的房间楼层汇总
          </span>
          <span>
            未登记在册的打单人：{orphanNames.length > 0 ? orphanNames.join("、") : "无"}
          </span>
        </div>
      </div>

      <p className="text-[11px] text-gray-400">
        首次进入自动建表并写入 3 名打扫员（赵阿姨 / 钱阿姨 / 孙阿姨）；若本店还没有已完成的客房任务，会回补最近{" "}
        {HISTORY_DAYS} 天的演示业绩数据，方便查看今日 / 本周 / 本月汇总。
      </p>
    </div>
  );
}
