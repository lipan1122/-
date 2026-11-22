import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { todayStr } from "@/lib/utils";
import { completeTaskFormAction, setRoomCleanFormAction } from "./actions";
import BatchCleanPanel from "@/components/BatchCleanPanel";
import MaintenanceModal, { type MaintenanceRoom } from "@/components/MaintenanceModal";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type HkStats = {
  pending: number;
  vd: number;
  od: number;
  done_today: number;
};

type HkTask = {
  id: number;
  room_no: string | null;
  room_type_name: string | null;
  task_type: string | null;
  status: string;
  assignee: string | null;
  created_at: string | null;
  note: string | null;
  photos: string | null;
};

type DirtyRoom = {
  id: number;
  room_no: string;
  floor: number | null;
  room_type_name: string | null;
};

type FloorRow = { floor: number };
type AssigneeRow = { assignee: string };

const TASK_TYPE_CLS: Record<string, string> = {
  打扫: "border-brand-200 bg-brand-50 text-brand-700",
  查房: "border-blue-200 bg-blue-50 text-blue-700",
  维修: "border-amber-200 bg-amber-50 text-amber-700",
};

/** 任务状态筛选项（白名单，非法值一律当不筛） */
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "PENDING", label: "待打扫" },
  { value: "DOING", label: "进行中" },
  { value: "DONE", label: "已完成" },
  { value: "CANCELLED", label: "已取消" },
];
const STATUS_VALUES = STATUS_OPTIONS.map((o) => o.value);

/** 任务状态 → 徽标文案/配色 */
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "待打扫", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  DOING: { label: "进行中", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  DONE: { label: "已完成", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  CANCELLED: { label: "已取消", cls: "border-gray-200 bg-gray-50 text-gray-500" },
};

/** searchParams 的值可能是数组，取第一个 */
function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** ISO 时间 → 「MM-DD HH:mm」 */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 解析任务上的 photos（JSON 数组文本），返回可用的图片地址 */
function parsePhotoList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * 客房中心
 *
 * 支持按楼层 / 任务状态 / 打扫员筛选（整改报告第 10 节）：
 * 全部走 URL searchParams 在服务端筛选，刷新、分享链接都能保留条件，
 * 不需要客户端状态；筛选同时作用于「客房任务」和「脏房列表」两张表。
 */
export default async function HousekeepingPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const sp = await searchParams;

  /* ---------- 筛选参数：?floor=2&hk_status=PENDING&assignee=赵阿姨 ---------- */
  const floorParam = first(sp.floor).trim();
  const floorNum = Number(floorParam);
  const floorFilter = floorParam !== "" && Number.isFinite(floorNum) ? Math.trunc(floorNum) : null;
  const statusParam = first(sp.hk_status).trim();
  const statusFilter = STATUS_VALUES.includes(statusParam) ? statusParam : "";
  const assigneeFilter = first(sp.assignee).trim();
  const isFiltering = floorFilter != null || statusFilter !== "" || assigneeFilter !== "";
  /* P2-20：actions 层操作失败后 redirect 回来的原因（原来失败时静默 return，页面什么都不显示） */
  const actionError = first(sp.err).trim();

  /* ---------- 概览数字：始终是酒店总量，不随筛选变化 ---------- */
  const stats =
    get<HkStats>(
      `SELECT
         (SELECT COUNT(*) FROM housekeeping WHERE hotel_id = ? AND status = 'PENDING') AS pending,
         (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'VD') AS vd,
         (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'OD') AS od,
         (SELECT COUNT(*) FROM housekeeping
           WHERE hotel_id = ? AND status = 'DONE' AND date(done_at, 'localtime') = ?) AS done_today`,
      [hotelId, hotelId, hotelId, hotelId, today]
    ) ?? { pending: 0, vd: 0, od: 0, done_today: 0 };

  /* ---------- 客房任务（按筛选条件拼 WHERE，参数顺序与占位符一致） ---------- */
  const taskWhere: string[] = ["h.hotel_id = ?"];
  const taskParams: unknown[] = [hotelId];
  if (floorFilter != null) {
    taskWhere.push("r.floor = ?");
    taskParams.push(floorFilter);
  }
  if (statusFilter) {
    taskWhere.push("h.status = ?");
    taskParams.push(statusFilter);
  }
  if (assigneeFilter) {
    taskWhere.push("h.assignee = ?");
    taskParams.push(assigneeFilter);
  }

  const tasks = all<HkTask>(
    `SELECT h.id, h.task_type, h.status, h.assignee, h.created_at, h.note, h.photos,
            r.room_no, rt.name AS room_type_name
     FROM housekeeping h
     LEFT JOIN rooms r ON r.id = h.room_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     WHERE ${taskWhere.join(" AND ")}
     ORDER BY CASE h.status WHEN 'PENDING' THEN 0 ELSE 1 END, h.created_at DESC, h.id DESC
     LIMIT 50`,
    taskParams
  );

  /* ---------- 空脏房列表：楼层直接过滤；状态/人员靠「该房存在匹配任务」来过滤 ---------- */
  const dirtyWhere: string[] = ["r.hotel_id = ?", "r.status = 'VD'"];
  const dirtyParams: unknown[] = [hotelId];
  if (floorFilter != null) {
    dirtyWhere.push("r.floor = ?");
    dirtyParams.push(floorFilter);
  }
  if (statusFilter || assigneeFilter) {
    const subWhere: string[] = ["h2.hotel_id = r.hotel_id", "h2.room_id = r.id"];
    if (statusFilter) {
      subWhere.push("h2.status = ?");
      dirtyParams.push(statusFilter);
    }
    if (assigneeFilter) {
      subWhere.push("h2.assignee = ?");
      dirtyParams.push(assigneeFilter);
    }
    dirtyWhere.push(`EXISTS (SELECT 1 FROM housekeeping h2 WHERE ${subWhere.join(" AND ")})`);
  }

  const dirtyRooms = all<DirtyRoom>(
    `SELECT r.id, r.room_no, r.floor, rt.name AS room_type_name
     FROM rooms r
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     WHERE ${dirtyWhere.join(" AND ")}
     ORDER BY r.floor, r.room_no`,
    dirtyParams
  );

  /* ---------- 筛选下拉的候选值 ---------- */
  const floorRows = all<FloorRow>(
    `SELECT DISTINCT floor FROM rooms WHERE hotel_id = ? AND floor IS NOT NULL ORDER BY floor`,
    [hotelId]
  );
  const assigneeRows = all<AssigneeRow>(
    `SELECT DISTINCT assignee FROM housekeeping
      WHERE hotel_id = ? AND assignee IS NOT NULL AND TRIM(assignee) <> ''
      ORDER BY assignee`,
    [hotelId]
  );

  /* ---------- 报修弹窗可选房间：空房 VD/VC + 维修房 OOO ---------- */
  const maintenanceRooms = all<MaintenanceRoom>(
    `SELECT id, room_no AS roomNo, floor, status
     FROM rooms
     WHERE hotel_id = ? AND status IN ('VC','VD','OOO')
     ORDER BY floor, sort, room_no`,
    [hotelId]
  );

  /** 当前筛选条件的中文描述（列表标题用） */
  const filterDesc = [
    floorFilter != null ? `${floorFilter} 层` : "",
    statusFilter ? (STATUS_BADGE[statusFilter]?.label ?? statusFilter) : "",
    assigneeFilter ? assigneeFilter : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const cards = [
    {
      label: "待打扫任务",
      value: String(stats.pending),
      unit: "条",
      sub: "待客房处理",
      tone: "bg-brand-50 text-brand-600",
    },
    {
      label: "脏房 VD",
      value: String(stats.vd),
      unit: "间",
      sub: "空脏待清理",
      tone: "bg-amber-50 text-amber-600",
    },
    {
      label: "在住脏房 OD",
      value: String(stats.od),
      unit: "间",
      sub: "退房后转脏房",
      tone: "bg-violet-50 text-violet-600",
    },
    {
      label: "已完成今日",
      value: String(stats.done_today),
      unit: "条",
      sub: today,
      tone: "bg-emerald-50 text-emerald-600",
    },
  ];

  return (
    <div className="space-y-4 p-4">
      {actionError && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-rose-500 px-4 py-2.5">
          <span role="alert" className="text-[12px] text-rose-600">
            {actionError}
          </span>
          <Link href="/housekeeping" className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
            关闭
          </Link>
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">客房中心</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            今日 {today} · 待打扫 {stats.pending} 条 · 空脏 {stats.vd} 间 · 在住脏房 {stats.od} 间
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500">
            置净后房态变为空净 VC，可在房态图继续排房
          </span>
          {/* 报修：写维修任务 + 房间置 OOO（报告第 10 节） */}
          <MaintenanceModal rooms={maintenanceRooms} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-gray-500">{c.label}</span>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold ${c.tone}`}
              >
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

      {/* 筛选栏：URL 参数 + 服务端筛选，提交即改地址栏，刷新/分享都保留条件 */}
      <form method="get" action="/housekeeping" className="card flex flex-wrap items-end gap-3 px-4 py-3">
        <div className="min-w-[120px]">
          <label className="label">楼层</label>
          <select name="floor" defaultValue={floorFilter != null ? String(floorFilter) : ""} className="input">
            <option value="">全部楼层</option>
            {floorRows.map((f) => (
              <option key={f.floor} value={f.floor}>
                {f.floor} 层
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[120px]">
          <label className="label">状态</label>
          <select name="hk_status" defaultValue={statusFilter} className="input">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value || "all"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[140px]">
          <label className="label">打扫员</label>
          <select name="assignee" defaultValue={assigneeFilter} className="input">
            <option value="">全部人员</option>
            {assigneeRows.map((a) => (
              <option key={a.assignee} value={a.assignee}>
                {a.assignee}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button type="submit" className="btn-primary">
            筛选
          </button>
          <Link href="/housekeeping" className="btn-default px-2.5 py-1 text-[12px]">
            重置
          </Link>
        </div>
        <span className="ml-auto text-[11px] text-gray-400">
          {isFiltering ? `已筛选（${filterDesc}）` : "未筛选"} · 任务 {tasks.length} 条 · 空脏房{" "}
          {dirtyRooms.length} 间
        </span>
      </form>

      {/* 批量置净（报告 P2-10）：始终按当前筛选后的空脏房呈现 */}
      <BatchCleanPanel rooms={dirtyRooms.map((r) => ({ id: r.id, roomNo: r.room_no, floor: r.floor ?? null }))} />

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="card overflow-x-auto">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
            <span className="text-[13px] font-semibold text-gray-800">客房任务</span>
            <span className="text-[11px] text-gray-400">
              待打扫 {stats.pending} 条 / 共 {tasks.length} 条{isFiltering ? `（筛选：${filterDesc}）` : ""}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">打扫员</th>
                  <th className="th">任务类型</th>
                  <th className="th">房间号</th>
                  <th className="th">日期时间</th>
                  <th className="th text-right">费用</th>
                  <th className="th">状态</th>
                  <th className="th">工作内容</th>
                  <th className="th">反馈</th>
                  <th className="th">操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan={9} className="td py-10 text-center text-gray-400">
                      {isFiltering ? "当前筛选条件下没有找到相关数据！" : "没有找到相关数据！"}
                    </td>
                  </tr>
                )}
                {tasks.map((t) => {
                  // 维修任务带图片：最多展示 3 张缩略图，剩下的用「+N」表示
                  const thumbs = t.task_type === "维修" ? parsePhotoList(t.photos) : [];
                  const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.PENDING;
                  return (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="td text-gray-600">{t.assignee ?? "未指派"}</td>
                      <td className="td">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[11px] ${
                            TASK_TYPE_CLS[t.task_type ?? ""] ?? "border-gray-200 bg-gray-100 text-gray-500"
                          }`}
                        >
                          {t.task_type ?? "打扫"}
                        </span>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-10 items-center justify-center rounded-md bg-amber-50 text-[11px] font-semibold text-amber-700">
                            {t.room_no ?? "—"}
                          </span>
                          <span className="text-[12px] text-gray-500">{t.room_type_name ?? "房型未知"}</span>
                        </div>
                      </td>
                      <td className="td tabular-nums text-gray-500">{fmtTime(t.created_at)}</td>
                      <td className="td text-right tabular-nums text-gray-500">¥0.00</td>
                      <td className="td">
                        <span className={`rounded border px-1.5 py-0.5 text-[11px] ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="td max-w-[260px]">
                        <div className="truncate text-[12px] text-gray-500">{t.note || "打扫卫生,更换布草"}</div>
                        {thumbs.length > 0 && (
                          <div className="mt-1 flex items-center gap-1">
                            {thumbs.slice(0, 3).map((src, i) => (
                              <img
                                key={`${t.id}-${i}`}
                                src={src}
                                alt={`${t.room_no ?? "房间"}维修图片 ${i + 1}`}
                                className="h-8 w-8 rounded object-cover"
                              />
                            ))}
                            {thumbs.length > 3 && (
                              <span className="text-[11px] text-gray-400">+{thumbs.length - 3}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="td max-w-[160px] truncate text-[12px] text-gray-400">
                        {t.status === "DONE" ? "已完成" : "—"}
                      </td>
                      <td className="td">
                        {t.status === "DONE" ? (
                          <span className="text-[12px] text-gray-300">—</span>
                        ) : (
                          <form action={completeTaskFormAction}>
                            <input type="hidden" name="taskId" value={t.id} />
                            <button type="submit" className="btn-primary px-2.5 py-0.5 text-[12px]">
                              完成
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
            <span className="text-[13px] font-semibold text-gray-800">脏房列表</span>
            <span className="text-[11px] text-gray-400">
              {dirtyRooms.length} 间空脏{isFiltering ? "（已筛选）" : ""}
            </span>
          </div>
          <div className="divide-y divide-gray-50">
            {dirtyRooms.length === 0 && (
              <div className="px-4 py-10 text-center text-[12px] text-gray-400">
                {isFiltering ? "当前筛选条件下没有空脏房" : "暂无空脏房，所有房间房态正常"}
              </div>
            )}
            {dirtyRooms.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex h-8 w-11 items-center justify-center rounded-md bg-amber-50 text-[12px] font-semibold text-amber-700">
                  {r.room_no}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-gray-800">{r.room_type_name ?? "房型未知"}</div>
                  <div className="text-[11px] text-gray-400">
                    {r.floor != null ? `${r.floor} 层` : "楼层未知"} · 空脏 VD
                  </div>
                </div>
                <form action={setRoomCleanFormAction}>
                  <input type="hidden" name="roomId" value={r.id} />
                  <button type="submit" className="btn-default px-2.5 py-1 text-[12px]">
                    置净
                  </button>
                </form>
              </div>
            ))}
          </div>
          {dirtyRooms.length > 0 && (
            <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
              置净会写入房态变更日志（VD → VC）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
