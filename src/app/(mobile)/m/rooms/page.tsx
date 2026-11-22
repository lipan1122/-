import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import { isAssignable } from "@/lib/room-status";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 移动端房态（F13）
 *
 * 桌面房态图是「左侧列表 + 右侧 17 天网格」，手机上根本没法看。
 * 这里换成：按楼层分组的房间卡片，一眼看清每间房住着谁、还能住几天。
 *
 * 筛选：?filter=all|vacant|occupied|overdue|dirty
 * 详情：?room=<房间 ID>（就地展开，不再跳不存在的 /m/rooms/[id]）
 *
 * 第 4 轮整改：
 *   P1-26 原来点房间跳 `/m/rooms/${stay_id}`，但移动端没有这个动态路由 → 100% 404。
 *         改成同一个页面里用 `?room=` 就地展开房间/在住单详情。
 *   P1-28d 空房口径统一到 `isAssignable`（VC 或 VD），跟办入住页、桌面端一致。
 */

type RoomCell = {
  id: number;
  room_no: string;
  floor: number | null;
  status: string;
  room_type: string | null;
  guest_name: string | null;
  stay_id: number | null;
  expect_out: string | null;
  balance: number | null;
};

/** 单间房的详情（含在住单与账单，仅当前酒店） */
type RoomDetail = {
  id: number;
  room_no: string;
  floor: number | null;
  status: string;
  room_type: string | null;
  stay_id: number | null;
  stay_no: string | null;
  guest_name: string | null;
  mobile: string | null;
  check_in_time: string | null;
  expect_check_out: string | null;
  nights: number | null;
  rate: number | null;
  folio_no: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  balance: number | null;
};

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "vacant", label: "空房" },
  { key: "occupied", label: "在住" },
  { key: "overdue", label: "逾期" },
  { key: "dirty", label: "脏房" },
];

const STATUS_LABEL: Record<string, string> = {
  VC: "空净",
  VD: "空脏",
  OC: "在住净",
  OD: "在住脏",
  OOO: "维修",
  LOCK: "锁房",
};

/** 空房状态的提示语（详情面板里用） */
const VACANT_HINT: Record<string, string> = {
  VC: "空净房，可以直接排房入住。",
  VD: "空脏房，需先在电脑版客房中心置净，客人到店前也可直接排房。",
  OOO: "维修房，完成维修并置净后才能排房。",
  LOCK: "锁房，需在电脑版房态页解锁后才能排房。",
};

export default async function MobileRoomsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; room?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.filter) ? sp.filter! : "all";
  const today = bizToday(user.hotelId);

  const rooms = all<RoomCell>(
    `SELECT r.id, r.room_no, r.floor, r.status, rt.name AS room_type,
            s.guest_name, s.id AS stay_id, s.expect_check_out AS expect_out,
            COALESCE(f.balance, 0) AS balance
       FROM rooms r
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
       LEFT JOIN folios f ON f.stay_id = s.id
      WHERE r.hotel_id = ?
      ORDER BY r.floor, r.room_no`,
    [user.hotelId]
  );

  /* 统计（始终按全量算，不受筛选影响，方便对比） */
  const stat = {
    vacant: rooms.filter((r) => isAssignable(r.status)).length,
    occupied: rooms.filter((r) => r.status === "OC" || r.status === "OD").length,
    overdue: rooms.filter((r) => r.status === "OC" || r.status === "OD").filter((r) => r.expect_out && r.expect_out < today).length,
    dirty: rooms.filter((r) => r.status === "VD" || r.status === "OD").length,
  };

  const shown = rooms.filter((r) => {
    switch (filter) {
      case "vacant":
        return isAssignable(r.status);
      case "occupied":
        return r.status === "OC" || r.status === "OD";
      case "overdue":
        return (r.status === "OC" || r.status === "OD") && r.expect_out != null && r.expect_out < today;
      case "dirty":
        return r.status === "VD" || r.status === "OD";
      default:
        return true;
    }
  });

  /* 按楼层分组 */
  const byFloor = new Map<number, RoomCell[]>();
  for (const r of shown) {
    const f = r.floor ?? 0;
    if (!byFloor.has(f)) byFloor.set(f, []);
    byFloor.get(f)!.push(r);
  }

  /* 详情：?room=<id>，按当前酒店过滤，不跨店读取 */
  const roomId = Number(sp.room);
  const detail =
    Number.isFinite(roomId) && roomId > 0
      ? get<RoomDetail>(
          `SELECT r.id, r.room_no, r.floor, r.status, rt.name AS room_type,
                  s.id AS stay_id, s.stay_no, s.guest_name, s.mobile,
                  s.check_in_time, s.expect_check_out, s.nights, s.rate,
                  f.folio_no, f.total_amount, f.paid_amount, f.balance
             FROM rooms r
             LEFT JOIN room_types rt ON rt.id = r.room_type_id
             LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
             LEFT JOIN folios f ON f.stay_id = s.id
            WHERE r.id = ? AND r.hotel_id = ?
            LIMIT 1`,
          [roomId, user.hotelId]
        )
      : undefined;

  const closeHref = filter === "all" ? "/m/rooms" : `/m/rooms?filter=${filter}`;

  return (
    <div className="mx-auto max-w-[520px]">
      {/* 吸顶筛选 */}
      <div className="sticky top-0 z-10 border-b border-[#e5e5e5] bg-white/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="text-[15px] font-semibold text-gray-900">房态</div>
          <div className="text-[11px] text-[#8b949e]">
            空 {stat.vacant} · 住 {stat.occupied} · 脏 {stat.dirty}
          </div>
        </div>
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            const n =
              f.key === "vacant" ? stat.vacant
              : f.key === "occupied" ? stat.occupied
              : f.key === "overdue" ? stat.overdue
              : f.key === "dirty" ? stat.dirty
              : rooms.length;
            return (
              <Link
                key={f.key}
                href={f.key === "all" ? "/m/rooms" : `/m/rooms?filter=${f.key}`}
                prefetch={false}
                aria-current={active ? "true" : undefined}
                aria-label={`筛选 ${f.label}（${n} 间）`}
                className={`inline-flex h-11 shrink-0 items-center rounded-full px-3 text-[12px] ${
                  active ? "bg-[#1e8e3e] text-white" : "border border-[#dcdcdc] bg-white text-gray-600"
                }`}
              >
                {f.label}
                <span className={`ml-1 ${active ? "text-white/70" : "text-[#b0b8bf]"}`}>{n}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* 房间/在住单详情（P1-26：就地展开，替代不存在的 /m/rooms/[id]） */}
      {detail && (
        <div className="mx-3 mt-3 rounded-[8px] border border-[#cfe3f7] bg-white p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[16px] font-semibold tabular-nums text-gray-900">{detail.room_no}</span>
                <span className="rounded-[2px] bg-[#f2f3f5] px-1 text-[10px] text-gray-600">
                  {STATUS_LABEL[detail.status] ?? detail.status}
                </span>
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-[#8b949e]">
                {detail.floor ?? "-"} 楼 · {detail.room_type ?? "未配房型"}
                {detail.stay_no && <span className="ml-1 font-mono">{detail.stay_no}</span>}
              </div>
            </div>
            <Link
              href={closeHref}
              prefetch={false}
              aria-label="关闭房间详情"
              className="shrink-0 rounded-[4px] border border-[#dcdcdc] px-2 py-1 text-[11px] text-[#5f6b76]"
            >
              关闭
            </Link>
          </div>

          {detail.stay_id ? (
            <>
              <div className="mt-2 border-t border-[#f0f0f0] pt-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[14px] font-medium text-gray-900">
                    {detail.guest_name ?? "在住客人"}
                  </span>
                  <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[#d9534f]">
                    {fmtMoney(detail.balance)}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-[#8b949e]">{detail.mobile ?? "无手机"}</div>
              </div>

              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px]">
                <div className="flex justify-between">
                  <dt className="text-[#8b949e]">入住</dt>
                  <dd className="tabular-nums text-gray-700">{(detail.check_in_time ?? "").slice(0, 10) || "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[#8b949e]">预离</dt>
                  <dd className="tabular-nums text-gray-700">{detail.expect_check_out ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[#8b949e]">房价</dt>
                  <dd className="tabular-nums text-gray-700">{fmtMoney(detail.rate)}/晚</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[#8b949e]">晚数</dt>
                  <dd className="tabular-nums text-gray-700">{detail.nights ?? 1} 晚</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[#8b949e]">消费</dt>
                  <dd className="tabular-nums text-gray-700">{fmtMoney(detail.total_amount)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[#8b949e]">已收</dt>
                  <dd className="tabular-nums text-gray-700">{fmtMoney(detail.paid_amount)}</dd>
                </div>
              </dl>

              <div className="mt-2 flex items-center gap-2">
                <Link
                  href={`/cashier?stay=${detail.stay_id}`}
                  prefetch={false}
                  className="inline-flex h-9 flex-1 items-center justify-center rounded-[4px] bg-[#1e8e3e] text-[12px] text-white"
                >
                  去收银台收款/退房
                </Link>
                {detail.folio_no && (
                  <span className="shrink-0 font-mono text-[10.5px] text-[#b0b8bf]">{detail.folio_no}</span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="mt-2 border-t border-[#f0f0f0] pt-2 text-[12px] leading-[18px] text-[#5f6b76]">
                {VACANT_HINT[detail.status] ?? "当前无在住客人。"}
              </div>
              <div className="mt-2 flex items-center gap-2">
                {isAssignable(detail.status) && (
                  <Link
                    href="/m/checkin"
                    prefetch={false}
                    className="inline-flex h-9 flex-1 items-center justify-center rounded-[4px] bg-[#2f80ed] text-[12px] text-white"
                  >
                    去办入住排房
                  </Link>
                )}
                <Link
                  href="/rooms"
                  prefetch={false}
                  className="inline-flex h-9 items-center justify-center rounded-[4px] border border-[#dcdcdc] px-3 text-[12px] text-gray-700"
                >
                  电脑版房态
                </Link>
              </div>
            </>
          )}
        </div>
      )}

      {shown.length === 0 && (
        <div className="px-3 py-16 text-center text-[13px] text-[#8b949e]">没有符合条件的房间</div>
      )}

      {/* 楼层分组 */}
      {[...byFloor.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([floor, list]) => (
          <div key={floor} className="px-3 pt-3">
            <div className="mb-1.5 text-[11px] font-medium text-[#8b949e]">{floor} 楼 · {list.length} 间</div>
            <div className="grid grid-cols-3 gap-2">
              {list.map((r) => {
                const isOccupied = r.status === "OC" || r.status === "OD";
                const isOverdue = isOccupied && r.expect_out != null && r.expect_out < today;
                const isDirty = r.status === "VD" || r.status === "OD";
                const selected = detail?.id === r.id;
                const href = `${filter === "all" ? "/m/rooms" : `/m/rooms?filter=${filter}`}${
                  filter === "all" ? "?" : "&"
                }room=${r.id}`;

                return (
                  <Link
                    key={r.id}
                    href={href}
                    prefetch={false}
                    aria-label={`房间 ${r.room_no} ${STATUS_LABEL[r.status] ?? r.status}${
                      isOccupied ? `，客人 ${r.guest_name ?? "在住"}` : ""
                    }，查看详情`}
                    aria-current={selected ? "true" : undefined}
                    className={`relative flex h-[76px] flex-col justify-between rounded-[6px] border p-2 active:opacity-80 ${
                      selected ? "ring-2 ring-[#2f80ed] ring-offset-1" : ""
                    } ${
                      isOccupied
                        ? "border-[#cfe3f7] bg-[#f3f8fd]"
                        : isDirty
                          ? "border-[#f3e0b8] bg-[#fffbf2]"
                          : r.status === "VC"
                            ? "border-[#c8e6c9] bg-[#f4faf5]"
                            : "border-[#e5e5e5] bg-white"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <span className="text-[15px] font-semibold tabular-nums text-gray-900">{r.room_no}</span>
                      <span
                        className={`rounded-[2px] px-1 text-[9.5px] leading-[14px] ${
                          isOccupied
                            ? "bg-[#2f80ed] text-white"
                            : isDirty
                              ? "bg-[#e8a33d] text-white"
                              : r.status === "VC"
                                ? "bg-[#1e8e3e] text-white"
                                : "bg-[#8b949e] text-white"
                        }`}
                      >
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </div>
                    <div className="truncate text-[10.5px] text-gray-600">
                      {isOccupied ? (r.guest_name ?? "在住") : (r.room_type ?? "—")}
                    </div>
                    {isOverdue && (
                      <span className="absolute bottom-1 right-1.5 text-[9.5px] font-medium text-[#d9534f]">
                        逾期
                      </span>
                    )}
                    {!isOverdue && isOccupied && Number(r.balance ?? 0) > 0.01 && (
                      <span className="absolute bottom-1 right-1.5 text-[9.5px] text-[#d9534f]">欠费</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

      <div className="px-3 py-6 text-center text-[10.5px] text-[#b0b8bf]">
        点房间就地查看详情 · 完整操作请用电脑版
      </div>
    </div>
  );
}
