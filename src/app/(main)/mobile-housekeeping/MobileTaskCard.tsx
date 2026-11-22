"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  completeTaskAction,
  reviewTaskAction,
  setRoomCleanFormAction,
  startTaskAction,
} from "@/app/(main)/housekeeping/actions";

type Task = {
  id: number;
  /** 房间 ID（置净要用） */
  roomId: number;
  roomNo: string;
  floor: number | null;
  taskType: string;
  status: string;
  /**
   * 验收状态（第 5 轮 P1-4）
   *
   * NULL = 无需审核（维修/查房），PENDING_REVIEW = 打扫完等主管验收，
   * APPROVED / REJECTED = 已验收通过 / 已打回重做。
   */
  reviewStatus: string | null;
  reviewedBy: string | null;
  assignee: string | null;
  note: string | null;
  createdAt: string | null;
  roomStatus: string;
};

function SubmitButton({ label, busyLabel, className }: { label: string; busyLabel: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? busyLabel : label}
    </button>
  );
}

/**
 * 移动端客房任务卡（整改报告 P2-10 + 第 5 轮 P1-4）
 *
 * 目标用户是打扫阿姨：手机上一屏看几个房间，一个大按钮点完成。
 * 不用下拉菜单、不用进二级页面。
 *
 * 第 5 轮 P1-4 补的两件事：
 *   ① 「开始打扫」：PENDING → DOING，房态页「打扫中」标签就靠这个状态；
 *      没有它，任务永远停在 PENDING，那个标签永远是 0 条。
 *   ② 验收区：打扫完成后任务进入 PENDING_REVIEW，主管在这里点
 *      「验收通过 / 打回重做」，与房态页「待审」标签同口径。
 */
export default function MobileTaskCard({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);

  const [, startAction] = useActionState(async () => {
    await startTaskAction(task.id);
    return null;
  }, null);
  const [, completeAction] = useActionState(async () => {
    await completeTaskAction(task.id);
    return null;
  }, null);
  const [, cleanAction] = useActionState(async () => {
    const fd = new FormData();
    fd.set("roomId", String(task.roomId));
    await setRoomCleanFormAction(fd);
    return null;
  }, null);
  const [, approveAction] = useActionState(async () => {
    await reviewTaskAction(task.id, true);
    return null;
  }, null);
  const [, rejectAction] = useActionState(async () => {
    await reviewTaskAction(task.id, false);
    return null;
  }, null);

  /** 等验收：任务已 DONE 但 review_status 还是 PENDING_REVIEW */
  const awaitingReview = task.reviewStatus === "PENDING_REVIEW" && task.status === "DONE";
  /** 打回重做：任务已退回 PENDING（status 不再是 DONE），卡片按待办显示 */
  const rejected = task.reviewStatus === "REJECTED" && task.status === "PENDING";
  /** 真正收工：已完成且没有待验收（APPROVED 或本来就不需要验收） */
  const done = task.status === "DONE" && !awaitingReview;
  const doing = task.status === "DOING";

  const typeCls =
    task.taskType === "退房打扫"
      ? "bg-[#fdf3f3] text-[#c0392b]"
      : task.taskType === "维修"
        ? "bg-[#fff7e6] text-[#b07d2e]"
        : "bg-[#f1f9f3] text-[#1e8e3e]";

  const statusText = awaitingReview ? "待验收" : doing ? "打扫中" : rejected ? "已打回，需重做" : "";

  return (
    <div
      className={`rounded-[6px] border bg-white p-3 shadow-sm ${
        done ? "border-gray-200 opacity-60" : awaitingReview ? "border-violet-200" : "border-[#e5e5e5]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[22px] font-bold leading-none tabular-nums text-gray-900">{task.roomNo}</span>
          {task.floor != null && <span className="text-[12px] text-gray-400">{task.floor} 楼</span>}
        </div>
        <div className="flex items-center gap-1">
          {statusText && (
            <span
              className={`rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium ${
                awaitingReview
                  ? "bg-[#f3ecff] text-[#6b3fb5]"
                  : doing
                    ? "bg-[#eaf2ff] text-[#2b6cb0]"
                    : "bg-[#fdf3f3] text-[#c0392b]"
              }`}
            >
              {statusText}
            </span>
          )}
          <span className={`rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium ${typeCls}`}>{task.taskType}</span>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-gray-500">
        <span>房态 {task.roomStatus}</span>
        <span>打扫员 {task.assignee ?? "未指派"}</span>
        {awaitingReview && task.reviewedBy == null && <span>等待主管验收</span>}
        {task.note && <span className="truncate">{task.note}</span>}
      </div>

      {awaitingReview ? (
        /* 验收区：主管专用，两个大按钮 */
        <div className="mt-2.5">
          <div className="flex gap-2">
            <form action={approveAction} className="flex-1">
              <SubmitButton
                label="验收通过"
                busyLabel="提交中…"
                className="inline-flex h-10 w-full items-center justify-center rounded-[4px] bg-[#32c141] text-[14px] font-medium text-white active:bg-[#2bb038] disabled:bg-[#c9c9c9]"
              />
            </form>
            <form action={rejectAction} className="flex-1">
              <SubmitButton
                label="打回重做"
                busyLabel="提交中…"
                className="inline-flex h-10 w-full items-center justify-center rounded-[4px] border border-[#e0b4b4] bg-white text-[14px] font-medium text-[#c0392b] active:bg-[#fdf3f3] disabled:text-[#c9c9c9]"
              />
            </form>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-gray-400">
            验收通过后这间房正式收工；打回重做会把任务退回待打扫，房间仍是空净的会一起改回空脏。
          </p>
        </div>
      ) : done ? (
        <div className="mt-2.5 rounded-[4px] bg-gray-50 py-2 text-center text-[12px] text-gray-400">
          {task.reviewStatus === "APPROVED" ? `已验收${task.reviewedBy ? `（${task.reviewedBy}）` : ""}` : "已完成"}
        </div>
      ) : (
        <>
          <div className="mt-2.5 flex gap-2">
            {/* PENDING → DOING：房态页「打扫中」标签的数据来源（第 5 轮 P1-4） */}
            {task.status === "PENDING" && (
              <form action={startAction} className="flex-1">
                <SubmitButton
                  label="开始打扫"
                  busyLabel="处理中…"
                  className="inline-flex h-10 w-full items-center justify-center rounded-[4px] border border-[#32c141] bg-white text-[14px] font-medium text-[#1e8e3e] active:bg-[#f1f9f3] disabled:text-[#c9c9c9]"
                />
              </form>
            )}
            <form action={completeAction} className="flex-1">
              <SubmitButton
                label="完成打扫"
                busyLabel="处理中…"
                className="inline-flex h-10 w-full items-center justify-center rounded-[4px] bg-[#32c141] text-[14px] font-medium text-white active:bg-[#2bb038] disabled:bg-[#c9c9c9]"
              />
            </form>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-10 w-12 items-center justify-center rounded-[4px] border border-[#dcdcdc] text-[14px] text-gray-500 active:bg-gray-50"
              aria-label="更多操作"
            >
              ⋯
            </button>
          </div>

          {open && (
            <div className="mt-2 rounded-[4px] border border-[#eee] bg-[#fafafa] p-2">
              <form action={cleanAction}>
                <SubmitButton
                  label="房间置净（不需打扫）"
                  busyLabel="置净中…"
                  className="inline-flex h-9 w-full items-center justify-center rounded-[4px] border border-[#32c141] bg-white text-[13px] text-[#32c141] active:bg-[#f1f9f3] disabled:text-[#c9c9c9]"
                />
              </form>
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-gray-400">
                客人只是整理、不需要全面打扫时用这个；置净后房间可直接排房，任务同样会进入待验收。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
