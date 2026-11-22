"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { completeTaskAction, setRoomCleanFormAction } from "@/app/(main)/housekeeping/actions";

type Task = {
  id: number;
  /** 房间 ID（置净要用） */
  roomId: number;
  roomNo: string;
  floor: number | null;
  taskType: string;
  status: string;
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
 * 移动端客房任务卡（整改报告 P2-10）
 *
 * 目标用户是打扫阿姨：手机上一屏看几个房间，一个大按钮点完成。
 * 不用下拉菜单、不用进二级页面。
 */
export default function MobileTaskCard({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
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

  const done = task.status === "DONE";
  const typeCls =
    task.taskType === "退房打扫"
      ? "bg-[#fdf3f3] text-[#c0392b]"
      : task.taskType === "维修"
        ? "bg-[#fff7e6] text-[#b07d2e]"
        : "bg-[#f1f9f3] text-[#1e8e3e]";

  return (
    <div
      className={`rounded-[6px] border bg-white p-3 shadow-sm ${
        done ? "border-gray-200 opacity-60" : "border-[#e5e5e5]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[22px] font-bold leading-none tabular-nums text-gray-900">{task.roomNo}</span>
          {task.floor != null && <span className="text-[12px] text-gray-400">{task.floor} 楼</span>}
        </div>
        <span className={`rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium ${typeCls}`}>{task.taskType}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-gray-500">
        <span>房态 {task.roomStatus}</span>
        <span>打扫员 {task.assignee ?? "未指派"}</span>
        {task.note && <span className="truncate">{task.note}</span>}
      </div>

      {done ? (
        <div className="mt-2.5 rounded-[4px] bg-gray-50 py-2 text-center text-[12px] text-gray-400">已完成</div>
      ) : (
        <>
          <div className="mt-2.5 flex gap-2">
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
                客人只是整理、不需要全面打扫时用这个；置净后房间可直接排房。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
