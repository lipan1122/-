import Link from "next/link";
import { all } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import MobileTaskCard from "./MobileTaskCard";

export const dynamic = "force-dynamic";

type TaskRow = {
  id: number;
  room_id: number;
  room_no: string;
  floor: number | null;
  task_type: string;
  status: string;
  /** 验收状态：NULL / PENDING_REVIEW / APPROVED / REJECTED（第 5 轮 P1-4） */
  review_status: string | null;
  reviewed_by: string | null;
  assignee: string | null;
  note: string | null;
  created_at: string | null;
  room_status: string;
};

/**
 * 移动端客房任务（整改报告 P2-10）
 *
 * 阿姨在手机上打开，看到自己名下的待打扫房间，一个大按钮点完成。
 * 没登录的人会被 layout 拦到登录页。
 */
export default async function MobileHousekeepingPage({
  searchParams,
}: {
  searchParams: Promise<{ assignee?: string }>;
}) {
  const user = await requirePermission("room.change_status");
  const sp = await searchParams;
  const hotelId = user.hotelId;
  const today = bizToday(hotelId);

  /* 打扫员筛选：默认只看自己的（非 admin 时），admin 可切换 */
  const requested = typeof sp.assignee === "string" ? sp.assignee.trim() : "";
  const defaultAssignee = user.role === "admin" ? "" : user.realName;
  const assignee = requested || defaultAssignee;

  const assignees = all<{ assignee: string | null }>(
    `SELECT DISTINCT assignee FROM housekeeping
      WHERE hotel_id = ? AND status IN ('PENDING','DOING') AND assignee IS NOT NULL AND assignee <> ''
      ORDER BY assignee`,
    [hotelId]
  ).map((r) => r.assignee as string);

  const tasks = all<TaskRow>(
    `SELECT h.id, r.id AS room_id, r.room_no, r.floor, COALESCE(h.task_type,'打扫') AS task_type, h.status,
            h.review_status, h.reviewed_by,
            h.assignee, h.note, h.created_at, r.status AS room_status
       FROM housekeeping h
       JOIN rooms r ON r.id = h.room_id
      WHERE h.hotel_id = ? AND h.status IN ('PENDING','DOING')
        ${assignee ? "AND h.assignee = ?" : ""}
      ORDER BY CASE h.status WHEN 'PENDING' THEN 0 ELSE 1 END, r.floor, r.room_no`,
    assignee ? [hotelId, assignee] : [hotelId]
  );

  /*
   * 待验收任务（第 5 轮 P1-4）
   *
   * 单独查一份，不塞进上面的待办列表：验收是**主管**的动作，打扫阿姨手机页
   * 默认只该看到自己要做的活。这里按「当前筛选的打扫员」取，
   * 主管在顶部切到「全部」就能看到全店待验收。
   */
  const reviewTasks = all<TaskRow>(
    `SELECT h.id, r.id AS room_id, r.room_no, r.floor, COALESCE(h.task_type,'打扫') AS task_type, h.status,
            h.review_status, h.reviewed_by,
            h.assignee, h.note, h.created_at, r.status AS room_status
       FROM housekeeping h
       JOIN rooms r ON r.id = h.room_id
      WHERE h.hotel_id = ? AND h.review_status = 'PENDING_REVIEW'
        ${assignee ? "AND h.assignee = ?" : ""}
      ORDER BY h.done_at DESC, h.id DESC
      LIMIT 20`,
    assignee ? [hotelId, assignee] : [hotelId]
  );

  const doneToday =
    all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM housekeeping
        WHERE hotel_id = ? AND status = 'DONE' AND date(done_at) = ?
          ${assignee ? "AND assignee = ?" : ""}`,
      assignee ? [hotelId, today, assignee] : [hotelId, today]
    )[0]?.c ?? 0;

  return (
    <div className="mx-auto max-w-[520px] pb-16">
      {/* 顶部吸顶条 */}
      <div className="sticky top-0 z-10 border-b border-[#e5e5e5] bg-white/95 px-3 py-2.5 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold text-gray-900">客房任务</div>
            <div className="mt-0.5 text-[11.5px] text-gray-500">
              {today} · 待办 {tasks.length} 间 · 今日已完成 {doneToday} 间
            </div>
          </div>
          <Link
            href="/housekeeping"
            className="inline-flex h-8 items-center rounded-[4px] border border-[#dcdcdc] px-2.5 text-[12px] text-gray-600"
          >
            电脑版
          </Link>
        </div>

        {/* 打扫员切换 */}
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
          <Link
            href="/mobile-housekeeping"
            className={`inline-flex h-7 shrink-0 items-center rounded-full px-3 text-[12px] ${
              !requested && !defaultAssignee
                ? "bg-[#32c141] text-white"
                : !requested && defaultAssignee === user.realName && user.role !== "admin"
                  ? "bg-[#32c141] text-white"
                  : "border border-[#dcdcdc] bg-white text-gray-600"
            }`}
          >
            {user.role === "admin" ? "全部" : "我的"}
          </Link>
          {assignees.map((a) => (
            <Link
              key={a}
              href={`/mobile-housekeeping?assignee=${encodeURIComponent(a)}`}
              className={`inline-flex h-7 shrink-0 items-center rounded-full px-3 text-[12px] ${
                assignee === a ? "bg-[#32c141] text-white" : "border border-[#dcdcdc] bg-white text-gray-600"
              }`}
            >
              {a}
            </Link>
          ))}
        </div>
      </div>

      {/* 任务卡片 */}
      <div className="space-y-2 px-3 pt-3">
        {tasks.length === 0 && (
          <div className="rounded-[6px] border border-dashed border-[#dcdcdc] bg-white py-16 text-center">
            <div className="text-[15px] text-gray-500">全部打扫完了 🎉</div>
            <div className="mt-1 text-[12px] text-gray-400">
              {assignee ? `${assignee} 名下暂无待办任务` : "暂无待办任务"}
            </div>
          </div>
        )}
        {tasks.map((t) => (
          <MobileTaskCard
            key={t.id}
            task={{
              id: t.id,
              roomId: t.room_id,
              roomNo: t.room_no,
              floor: t.floor,
              taskType: t.task_type,
              status: t.status,
              reviewStatus: t.review_status,
              reviewedBy: t.reviewed_by,
              assignee: t.assignee,
              note: t.note,
              createdAt: t.created_at,
              roomStatus: t.room_status,
            }}
          />
        ))}

        {/*
         * 待验收区（第 5 轮 P1-4）
         *
         * 打扫完的任务不再直接算「收工」：主管在手机上点「验收通过」，
         * 或者「打回重做」把任务退回待打扫。房态页「待审」标签数的就是这里。
         */}
        {reviewTasks.length > 0 && (
          <div className="pt-3">
            <div className="mb-1.5 flex items-baseline justify-between px-0.5">
              <span className="text-[13px] font-semibold text-gray-800">
                待验收（{reviewTasks.length}）
              </span>
              <span className="text-[11px] text-gray-400">主管验收后才算收工</span>
            </div>
            <div className="space-y-2">
              {reviewTasks.map((t) => (
                <MobileTaskCard
                  key={`review-${t.id}`}
                  task={{
                    id: t.id,
                    roomId: t.room_id,
                    roomNo: t.room_no,
                    floor: t.floor,
                    taskType: t.task_type,
                    status: t.status,
                    reviewStatus: t.review_status,
                    reviewedBy: t.reviewed_by,
                    assignee: t.assignee,
                    note: t.note,
                    createdAt: t.created_at,
                    roomStatus: t.room_status,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
