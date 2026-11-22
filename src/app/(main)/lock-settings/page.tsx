import Link from "next/link";
import { all, get, getDb, run, tx } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, nowIso, todayStr } from "@/lib/utils";
import {
  addLockCardAction,
  bindLockAction,
  saveLockSettingsAction,
  testLockConnectionAction,
  voidLockCardAction,
} from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type SettingRow = { key: string; value: string | null };

type TestLogRow = { id: number; detail: string | null; created_at: string | null; operator: string | null };

type VendorOption = { value: string; label: string; hint: string };

type RoomOption = { room_no: string; floor: number | null };

type LockLogRow = {
  id: number;
  room_no: string;
  card_no: string;
  action: string;
  operator: string | null;
  created_at: string | null;
};

type LockCardRow = {
  id: number;
  card_no: string;
  room_no: string;
  type: string;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string | null;
};

/** 门锁管理卡种子：类型 MASTER 主卡 / GUEST 客卡 / CLEAN 清洁卡，status VALID 有效 / INVALID 失效 */
type CardSeed = { card_no: string; type: string; status: string; fromOffset: number; toOffset: number };

const VENDORS: VendorOption[] = [
  { value: "quhu", label: "去呼呼门锁", hint: "去呼呼云锁，按酒店编码 + 接口地址接入" },
  { value: "other", label: "其他", hint: "其他厂商门锁，需自备接口地址与对接文档" },
];

const LOG_ACTIONS = ["开门", "关门"];

const CARD_TYPES: { value: string; label: string; cls: string }[] = [
  { value: "MASTER", label: "主卡", cls: "border-violet-200 bg-violet-50 text-violet-700" },
  { value: "GUEST", label: "客卡", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  { value: "CLEAN", label: "清洁卡", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
];

const CARD_STATUS: Record<string, { label: string; cls: string }> = {
  VALID: { label: "有效", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  INVALID: { label: "失效", cls: "border-gray-200 bg-gray-100 text-gray-500" },
};

const LOCK_LOGS_DDL = `
  CREATE TABLE IF NOT EXISTS lock_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    room_no TEXT NOT NULL,
    card_no TEXT NOT NULL,
    action TEXT NOT NULL,
    operator TEXT,
    created_at TEXT
  );
`;

const LOCK_CARDS_DDL = `
  CREATE TABLE IF NOT EXISTS lock_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    card_no TEXT NOT NULL,
    room_no TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'VALID',
    valid_from TEXT,
    valid_to TEXT,
    created_at TEXT
  );
`;

/** 10 张管理卡种子：2 主卡 / 5 客卡 / 3 清洁卡，其中 3 张已失效（含过期作废） */
const LOCK_CARD_SEEDS: CardSeed[] = [
  { card_no: "MK-0001", type: "MASTER", status: "VALID", fromOffset: -90, toOffset: 275 },
  { card_no: "MK-0002", type: "MASTER", status: "INVALID", fromOffset: -240, toOffset: -5 },
  { card_no: "GK-0001", type: "GUEST", status: "VALID", fromOffset: -2, toOffset: 3 },
  { card_no: "GK-0002", type: "GUEST", status: "VALID", fromOffset: -1, toOffset: 4 },
  { card_no: "GK-0003", type: "GUEST", status: "VALID", fromOffset: 0, toOffset: 2 },
  { card_no: "GK-0004", type: "GUEST", status: "INVALID", fromOffset: -20, toOffset: -2 },
  { card_no: "GK-0005", type: "GUEST", status: "VALID", fromOffset: -3, toOffset: 1 },
  { card_no: "HK-0001", type: "CLEAN", status: "VALID", fromOffset: -180, toOffset: 185 },
  { card_no: "HK-0002", type: "CLEAN", status: "VALID", fromOffset: -120, toOffset: 245 },
  { card_no: "HK-0003", type: "CLEAN", status: "INVALID", fromOffset: -300, toOffset: -30 },
];

/** 种子日志使用的客卡卡号（与种子管理卡对齐） */
const LOG_CARD_POOL = ["GK-0001", "GK-0002", "GK-0003", "GK-0004", "GK-0005"];

const FALLBACK_OPERATORS = ["李前台", "张经理", "王收银"];

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function vendorLabel(v: string): string {
  return VENDORS.find((item) => item.value === v)?.label ?? "去呼呼门锁";
}

function cardTypeMeta(type: string): { label: string; cls: string } {
  const hit = CARD_TYPES.find((t) => t.value === type);
  return hit ? { label: hit.label, cls: hit.cls } : { label: type || "未知", cls: "border-gray-200 bg-gray-50 text-gray-600" };
}

/**
 * 懒建表 + 首次种子：
 * 1. lock_logs 为空时写入 20 条开关门记录（今日 12 条 + 昨日 8 条，房号取本店真实房号）
 * 2. lock_cards 为空时写入 10 张管理卡（房号同样取真实房号）
 */
function ensureLockData(hotelId: number): void {
  getDb().exec(LOCK_LOGS_DDL);
  getDb().exec(LOCK_CARDS_DDL);

  const rooms = all<RoomOption>(`SELECT room_no, floor FROM rooms WHERE hotel_id = ? ORDER BY floor, room_no`, [
    hotelId,
  ]);
  if (rooms.length === 0) return;

  const today = todayStr();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const logCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM lock_logs WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (logCount === 0) {
    const names = all<{ real_name: string | null }>(`SELECT real_name FROM users WHERE hotel_id = ? ORDER BY id`, [
      hotelId,
    ])
      .map((u) => (u.real_name ?? "").trim())
      .filter((n) => n.length > 0);
    const operators = names.length > 0 ? names : FALLBACK_OPERATORS;

    const entries: { at: Date; roomNo: string; cardNo: string; action: string; operator: string }[] = [];

    // 今日 12 条：营业时段内散开，且不晚于当前时间
    for (let i = 0; i < 12; i += 1) {
      const planned = todayStart.getTime() + (8 * 60 + i * 47) * 60000;
      const latest = now.getTime() - 60000;
      const at = new Date(Math.max(todayStart.getTime() + 1000, Math.min(planned, latest)));
      entries.push({
        at,
        roomNo: rooms[i % rooms.length].room_no,
        cardNo: LOG_CARD_POOL[i % LOG_CARD_POOL.length],
        action: i % 2 === 0 ? "开门" : "关门",
        operator: operators[i % operators.length],
      });
    }

    // 昨日 8 条：09:00 起，每 63 分钟一条
    const yesterdayStart = todayStart.getTime() - 86400000;
    for (let i = 0; i < 8; i += 1) {
      const at = new Date(yesterdayStart + (9 * 60 + i * 63) * 60000);
      entries.push({
        at,
        roomNo: rooms[(i + 5) % rooms.length].room_no,
        cardNo: LOG_CARD_POOL[(i + 2) % LOG_CARD_POOL.length],
        action: i % 2 === 1 ? "开门" : "关门",
        operator: operators[(i + 2) % operators.length],
      });
    }

    tx(() => {
      for (const e of entries) {
        run(
          `INSERT INTO lock_logs (hotel_id, room_no, card_no, action, operator, created_at) VALUES (?,?,?,?,?,?)`,
          [hotelId, e.roomNo, e.cardNo, e.action, e.operator, e.at.toISOString()]
        );
      }
    });
  }

  const cardCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM lock_cards WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (cardCount === 0) {
    tx(() => {
      LOCK_CARD_SEEDS.forEach((seed, idx) => {
        const room = rooms[idx % rooms.length];
        run(
          `INSERT INTO lock_cards (hotel_id, card_no, room_no, type, status, valid_from, valid_to, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            seed.card_no,
            room.room_no,
            seed.type,
            seed.status,
            todayStr(addDays(today, seed.fromOffset)),
            todayStr(addDays(today, seed.toOffset)),
            nowIso(),
          ]
        );
      });
    });
  }
}

export default async function LockSettingsPage({

 searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;

  run(`CREATE TABLE IF NOT EXISTS lock_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    lock_code TEXT,
    status TEXT NOT NULL DEFAULT 'BOUND',
    signal INTEGER,
    battery INTEGER,
    bound_at TEXT,
    UNIQUE (hotel_id, room_id)
  )`);
  const lockDevicesRows = all<{
    room_id: number; room_no: string; type_name: string | null;
    lock_code: string | null; status: string | null; signal: number | null; battery: number | null;
  }>(`SELECT r.id AS room_id, r.room_no, rt.name AS type_name, d.lock_code, d.status, d.signal, d.battery
     FROM rooms r
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN lock_devices d ON d.room_id = r.id AND d.hotel_id = r.hotel_id
     WHERE r.hotel_id = ? ORDER BY r.floor, r.room_no`, [user.hotelId]);  const sp = await searchParams;
  const today = todayStr();

  const ok = first(sp.msg);
  const err = first(sp.err);

  const roomFilter = first(sp.room).trim();
  const actionRaw = first(sp.action).trim();
  const actionFilter = LOG_ACTIONS.includes(actionRaw) ? actionRaw : "";

  ensureLockData(hotelId);

  const settings = all<SettingRow>(`SELECT key, value FROM settings WHERE hotel_id = ?`, [hotelId]);
  const settingMap = new Map<string, string>(settings.map((s) => [s.key, s.value ?? ""]));

  const vendor = settingMap.get("lock_vendor") === "other" ? "other" : "quhu";
  const apiUrl = settingMap.get("lock_api_url") ?? "";
  const hotelCode = settingMap.get("lock_hotel_code") ?? "";
  const enabled = settingMap.get("lock_enabled") === "1";

  const rooms = all<RoomOption>(`SELECT room_no, floor FROM rooms WHERE hotel_id = ? ORDER BY floor, room_no`, [
    hotelId,
  ]);

  const hasOpLogs =
    (get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)?.n ?? 0) > 0;

  const testLogs = hasOpLogs
    ? all<TestLogRow>(
        `SELECT id, detail, created_at, operator
           FROM op_logs
          WHERE hotel_id = ? AND action = '门锁连接测试'
          ORDER BY id DESC
          LIMIT 5`,
        [hotelId]
      )
    : [];

  // ---- 开关门记录（按房号 / 动作过滤）----
  const logWhere: string[] = ["hotel_id = ?"];
  const logParams: unknown[] = [hotelId];
  if (roomFilter) {
    logWhere.push("room_no = ?");
    logParams.push(roomFilter);
  }
  if (actionFilter) {
    logWhere.push("action = ?");
    logParams.push(actionFilter);
  }
  const logWhereSql = logWhere.join(" AND ");

  const lockLogs = all<LockLogRow>(
    `SELECT id, room_no, card_no, action, operator, created_at
       FROM lock_logs
      WHERE ${logWhereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT 50`,
    logParams
  );
  const lockLogTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM lock_logs WHERE ${logWhereSql}`, logParams)?.n ?? 0;

  // ---- 门锁管理卡 ----
  const lockCards = all<LockCardRow>(
    `SELECT id, card_no, room_no, type, status, valid_from, valid_to, created_at
       FROM lock_cards
      WHERE hotel_id = ?
      ORDER BY CASE status WHEN 'VALID' THEN 0 ELSE 1 END, card_no`,
    [hotelId]
  );

  // ---- 统计 ----
  const todayOpenCount =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lock_logs WHERE hotel_id = ? AND action = '开门' AND date(created_at, 'localtime') = ?`,
      [hotelId, today]
    )?.n ?? 0;
  const todayLogCount =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lock_logs WHERE hotel_id = ? AND date(created_at, 'localtime') = ?`,
      [hotelId, today]
    )?.n ?? 0;
  const cardTotal = lockCards.length;
  const invalidCardCount = lockCards.filter((c) => c.status === "INVALID").length;
  const validCardCount = cardTotal - invalidCardCount;
  const expiredCardCount = lockCards.filter((c) => c.status === "VALID" && c.valid_to !== null && c.valid_to < today).length;

  const configured = Boolean(apiUrl && hotelCode);
  const selectedVendor = VENDORS.find((item) => item.value === vendor) ?? VENDORS[0];

  const cards = [
    {
      label: "今日开门次数",
      value: todayOpenCount,
      unit: "次",
      sub: `今日开关门共 ${todayLogCount} 条记录 · ${today}`,
      cls: "bg-emerald-50 text-emerald-600",
    },
    {
      label: "管理卡数",
      value: cardTotal,
      unit: "张",
      sub: `有效 ${validCardCount} 张 · 主卡 / 客卡 / 清洁卡`,
      cls: "bg-brand-50 text-brand-600",
    },
    {
      label: "失效卡数",
      value: invalidCardCount,
      unit: "张",
      sub: `已作废 ${invalidCardCount} 张 · 有效但已过期 ${expiredCardCount} 张`,
      cls: "bg-rose-50 text-rose-600",
    },
  ];

  return (
    <div className="space-y-3 p-4">
      {/* 门锁管理：每个房间绑定一把门锁（对应去呼呼「门锁管理」页） */}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eee] px-3 py-2">
          <span className="text-[13px] font-semibold text-[#222]">房间门锁</span>
          <span className="text-[11px] text-[#999]">
            已绑定 {lockDevicesRows.filter((r) => r.lock_code).length} / {lockDevicesRows.length} 个房间
          </span>
        </div>
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0">
              <tr>
                <th className="th text-left">房型名称</th>
                <th className="th text-left">房间号</th>
                <th className="th text-left">门锁编码</th>
                <th className="th text-left">门锁状态</th>
                <th className="th text-right">信号强度</th>
                <th className="th text-right">剩余电量</th>
                <th className="th text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {lockDevicesRows.map((r) => (
                <tr key={r.room_id} className="hover:bg-[#fafcfb]">
                  <td className="td text-[#555]">{r.type_name ?? "-"}</td>
                  <td className="td font-medium tabular-nums text-[#222]">{r.room_no}</td>
                  <td className="td tabular-nums text-[#555]">{r.lock_code ?? "-"}</td>
                  <td className="td text-[#555]">{r.lock_code ? "已绑定" : "未绑定"}</td>
                  <td className="td text-right tabular-nums text-[#555]">{r.lock_code ? r.signal + "%" : "-"}</td>
                  <td className="td text-right tabular-nums text-[#555]">{r.lock_code ? r.battery + "%" : "-"}</td>
                  <td className="td text-right">
                    <form action={bindLockAction} className="inline-block">
                      <input type="hidden" name="roomId" value={r.room_id} />
                      <input type="hidden" name="op" value={r.lock_code ? "unbind" : "bind"} />
                      <button type="submit" className={r.lock_code ? "btn-default px-2 py-0.5 text-[12px]" : "btn-primary px-2 py-0.5 text-[12px]"}>
                        {r.lock_code ? "解绑" : "绑定门锁"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">门锁设置</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            客房门锁厂商、接口地址与酒店编码配置 · 开关门记录与门锁管理卡
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-md border px-2.5 py-1 text-[11px] ${
              enabled
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-gray-200 bg-white text-gray-500"
            }`}
          >
            {enabled ? "门锁已启用" : "门锁未启用"}
          </span>
          <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500">
            {configured ? "配置已填写" : "配置未完整"}
          </span>
        </div>
      </div>

      {ok && <div className="card border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">{ok}</div>}
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

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="border-b border-gray-100 px-4 py-2.5">
            <div className="text-[13px] font-semibold text-gray-800">门锁参数</div>
            <div className="mt-0.5 text-[11px] text-gray-400">
              保存后立即生效；接口地址由门锁厂商提供，酒店编码用于区分门店
            </div>
          </div>
          <form action={saveLockSettingsAction} className="grid gap-3 px-4 py-3 md:grid-cols-2">
            <div>
              <label className="label">门锁厂商 *</label>
              <select name="lock_vendor" defaultValue={vendor} className="input">
                {VENDORS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-gray-400">{selectedVendor.hint}</p>
            </div>
            <div>
              <label className="label">启用开关 *</label>
              <select name="lock_enabled" defaultValue={enabled ? "1" : "0"} className="input">
                <option value="1">启用</option>
                <option value="0">停用</option>
              </select>
              <p className="mt-1 text-[11px] text-gray-400">停用后前台不再向前台机发送制卡指令</p>
            </div>
            <div className="md:col-span-2">
              <label className="label">接口地址</label>
              <input
                name="lock_api_url"
                defaultValue={apiUrl}
                maxLength={200}
                placeholder="https://lock.example.com/api"
                autoComplete="off"
                className="input"
              />
              <p className="mt-1 text-[11px] text-gray-400">需以 http:// 或 https:// 开头，留空表示暂未对接</p>
            </div>
            <div>
              <label className="label">酒店编码</label>
              <input
                name="lock_hotel_code"
                defaultValue={hotelCode}
                maxLength={40}
                placeholder="如 QHH-HZ-001"
                autoComplete="off"
                className="input"
              />
            </div>
            <div className="flex items-end">
              <span className="text-[11px] text-gray-400">
                当前：{vendorLabel(vendor)} · {enabled ? "已启用" : "未启用"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <button className="btn-primary">保存设置</button>
              <span className="text-[11px] text-gray-400">保存写入 settings 表的 lock_vendor / lock_api_url / lock_hotel_code / lock_enabled</span>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="border-b border-gray-100 px-4 py-2.5">
            <div className="text-[13px] font-semibold text-gray-800">连接测试</div>
            <div className="mt-0.5 text-[11px] text-gray-400">使用已保存的接口地址与酒店编码发起一次探测</div>
          </div>
          <form action={testLockConnectionAction} className="px-4 py-3">
            <button className="btn-default w-full">测试连接</button>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
              测试结果（成功或失败）都会写入操作日志 op_logs，动作名「门锁连接测试」，
              可在
              <Link
                href={`/query-logs?type=${encodeURIComponent("门锁连接测试")}`}
                className="mx-0.5 text-brand-600 hover:underline"
              >
                查询日志
              </Link>
              中查看。
            </p>
          </form>
          <div className="border-t border-gray-100 px-4 py-3">
            <div className="text-[12px] font-medium text-gray-700">最近测试记录</div>
            {testLogs.length === 0 ? (
              <p className="mt-1.5 text-[11px] text-gray-400">暂无测试记录，点击上方按钮开始测试</p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {testLogs.map((log) => (
                  <li key={log.id} className="rounded border border-gray-100 bg-gray-50/60 px-2 py-1.5">
                    <div className="text-[11px] text-gray-400">
                      {fmtTime(log.created_at)} · {log.operator ?? "-"}
                    </div>
                    <div className="mt-0.5 break-all text-[11px] text-gray-600">{log.detail ?? "-"}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">
            开关门记录 · {lockLogTotal} 条
            {(roomFilter || actionFilter) && <span className="ml-1 text-[11px] font-normal text-brand-600">已筛选</span>}
          </span>
          <form action="/lock-settings" method="get" className="flex flex-wrap items-center gap-1.5">
            <select name="room" defaultValue={roomFilter} className="input h-8 w-32">
              <option value="">全部房号</option>
              {rooms.map((r) => (
                <option key={r.room_no} value={r.room_no}>
                  {r.room_no}
                </option>
              ))}
            </select>
            <select name="action" defaultValue={actionFilter} className="input h-8 w-28">
              <option value="">全部动作</option>
              {LOG_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-default h-8">
              筛选
            </button>
            {roomFilter || actionFilter ? (
              <Link href="/lock-settings" className="text-[12px] text-gray-500 hover:text-brand-600">
                清除
              </Link>
            ) : null}
          </form>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">时间</th>
                <th className="th">房号</th>
                <th className="th">卡号</th>
                <th className="th">动作</th>
                <th className="th">操作人</th>
              </tr>
            </thead>
            <tbody>
              {lockLogs.length === 0 && (
                <tr>
                  <td colSpan={5} className="td py-10 text-center text-[12px] text-gray-400">
                    {roomFilter || actionFilter ? "没有符合筛选条件的开关门记录" : "暂无开关门记录"}
                    <div className="mt-1 text-[11px] text-gray-400">
                      {roomFilter || actionFilter
                        ? "试试更换房号或动作后重新筛选"
                        : "首次访问会自动写入 20 条今日与昨日的演示记录"}
                    </div>
                  </td>
                </tr>
              )}
              {lockLogs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="td whitespace-nowrap tabular-nums text-gray-500">{fmtTime(log.created_at)}</td>
                  <td className="td">
                    <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[12px] font-semibold text-blue-700">
                      {log.room_no}
                    </span>
                  </td>
                  <td className="td font-medium text-gray-700">{log.card_no}</td>
                  <td className="td">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        log.action === "开门"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-gray-200 bg-gray-50 text-gray-600"
                      }`}
                    >
                      {log.action}
                    </span>
                  </td>
                  <td className="td text-gray-600">{log.operator ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          <span>数据表 lock_logs · 房号取自 rooms 表真实房号 · 最多展示最近 50 条{lockLogTotal > 50 ? `（共 ${lockLogTotal} 条）` : ""}</span>
          <span>
            当前筛选：房号 {roomFilter || "全部"} · 动作 {actionFilter || "全部"}
          </span>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">门锁管理卡 · {cardTotal} 张</span>
          <span className="text-[11px] text-gray-400">
            有效 {validCardCount} 张 · 失效 {invalidCardCount} 张 · 作废后不可再用于开门
          </span>
        </div>
        <form
          action={addLockCardAction}
          className="flex flex-wrap items-end gap-2 border-b border-gray-100 bg-gray-50/40 px-4 py-2.5"
        >
          <div>
            <label className="label">卡号 *</label>
            <input
              type="text"
              name="card_no"
              required
              maxLength={40}
              placeholder="如 GK-0006"
              autoComplete="off"
              className="input h-8 w-32"
            />
          </div>
          <div>
            <label className="label">房号 *</label>
            <select name="room_no" defaultValue={rooms[0]?.room_no ?? ""} className="input h-8 w-28">
              {rooms.map((r) => (
                <option key={r.room_no} value={r.room_no}>
                  {r.room_no}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">类型 *</label>
            <select name="type" defaultValue="GUEST" className="input h-8 w-24">
              {CARD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">有效期起 *</label>
            <input type="date" name="valid_from" defaultValue={today} className="input h-8 w-36" />
          </div>
          <div>
            <label className="label">有效期止 *</label>
            <input type="date" name="valid_to" defaultValue={todayStr(addDays(today, 30))} className="input h-8 w-36" />
          </div>
          <button type="submit" className="btn-primary h-8">
            新增管理卡
          </button>
          <span className="mb-1.5 ml-auto text-[11px] text-gray-400">卡号在本店唯一，新增即为「有效」状态</span>
        </form>
        {/* 温馨提示（去呼呼管理卡页顶部） */}
        <div className="mx-4 mt-3 rounded-[2px] border border-[#f5e6a8] bg-[#fffbe6] px-3 py-2">
          <div className="text-center text-[12px] font-medium text-[#8a6d1a]">温馨提示</div>
          <div className="mt-1 flex flex-wrap justify-center gap-x-6 gap-y-1 text-[11px] text-[#8a6d1a]">
            <span>1. <span className="text-[#e53935]">门锁失联</span>的房间是无法做管理卡的解绑和绑定；</span>
            <span>2. 一个房间最多能绑定<span className="text-[#e53935]">10 张</span>管理卡；</span>
            <span>3. 门锁在线的时候，解绑和绑定失败，请<span className="text-[#e53935]">重复操作</span>即可。</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th w-14 text-center">序号</th>
                <th className="th">管理卡名称</th>
                <th className="th">管理卡ID</th>
                <th className="th">房间号</th>
                <th className="th">更新时间</th>
                <th className="th text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {lockCards.length === 0 && (
                <tr>
                  <td colSpan={6} className="td py-12 text-center text-[12px] text-gray-400">
                    无管理卡数据
                  </td>
                </tr>
              )}
              {lockCards.map((card, idx) => {
                const tm = cardTypeMeta(card.type);
                const st = CARD_STATUS[card.status] ?? { label: card.status, cls: "border-gray-200 bg-gray-100 text-gray-500" };
                const expired = Boolean(card.valid_to && card.valid_to < today);
                const invalid = card.status === "INVALID";
                return (
                  <tr key={card.id} className="hover:bg-gray-50">
                    <td className="td text-center tabular-nums text-gray-500">{idx + 1}</td>
                    <td className="td">
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] ${tm.cls}`}>{tm.label}</span>
                      {!invalid && expired && (
                        <span className="ml-1 rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700">
                          已过期
                        </span>
                      )}
                    </td>
                    <td className="td font-medium tabular-nums text-gray-800">{card.card_no}</td>
                    <td className="td">
                      <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[12px] font-semibold text-blue-700">
                        {card.room_no}
                      </span>
                    </td>
                    <td className="td whitespace-nowrap tabular-nums text-gray-500">
                      {(card.created_at ?? "").slice(0, 16).replace("T", " ") || "-"}
                    </td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1.5">
                        {invalid ? (
                          <span className="text-[11px] text-gray-400">{card.valid_to && expired ? "已过期作废" : "已作废"}</span>
                        ) : (
                          <form action={voidLockCardAction}>
                            <input type="hidden" name="id" value={card.id} />
                            <button type="submit" className="btn-danger px-2 py-0.5 text-[12px]">
                              作废
                            </button>
                          </form>
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
          <span>
            数据表 lock_cards · 类型 主卡 MASTER / 客卡 GUEST / 清洁卡 CLEAN · 状态 VALID 有效 / INVALID 失效
          </span>
          <span>{today} 营业日 · 新增卡默认有效，作废操作会写入 op_logs</span>
        </div>
      </div>

      <div className="card">
        <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">接入说明</div>
        <ul className="space-y-1.5 px-4 py-3 text-[11px] leading-relaxed text-gray-500">
          <li>· 去呼呼门锁：向门锁厂商申请门店接入后，会拿到接口地址与酒店编码，填入上方保存即可。</li>
          <li>· 其他厂商：在「门锁厂商」选择「其他」，接口地址填写厂商提供的地址，酒店编码填写门店标识。</li>
          <li>· 启用开关关闭时，前台仍可办理入住，但不会生成制卡指令，退房也不会自动注销房卡。</li>
          <li>· 「测试连接」只做接口可达性探测，不会下发真实制卡任务，可放心在营业时间使用。</li>
          <li>· 开关门记录（lock_logs）与门锁管理卡（lock_cards）首次访问自动建表并写入演示数据，房号均取自 rooms 表。</li>
          <li>· 本页配置存于 settings 表（lock_vendor / lock_api_url / lock_hotel_code / lock_enabled），备份数据库即可迁移。</li>
        </ul>
      </div>
    </div>
  );
}
