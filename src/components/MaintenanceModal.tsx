"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMaintenanceTaskAction } from "@/app/(main)/housekeeping/actions";

/** 可选房间：空房（VC/VD）与维修房（OOO），由服务端算好传进来 */
export type MaintenanceRoom = {
  id: number;
  roomNo: string;
  floor: number | null;
  status: string;
};

const ROOM_STATUS_LABEL: Record<string, string> = {
  VC: "空净",
  VD: "空脏",
  OOO: "维修",
  OC: "在住净",
  OD: "在住脏",
  LOCK: "锁房",
};

/** 单张图片上限：200KB（base64 后约 273KB，落在 actions.ts 的 300K 字符限制内） */
const MAX_FILE_BYTES = 200 * 1024;

/**
 * 报修弹窗（整改报告第 10 节：客房支持维修图片和备注）
 *
 * 说明：
 *   - 图片不做服务器上传，用 FileReader 直接读成 data URL，随表单一起写进
 *     housekeeping.photos（JSON 数组），所以只支持 1 张、且限制 200KB；
 *   - 提交走 createMaintenanceTaskAction：写维修任务 + 房间置 OOO。
 */
export default function MaintenanceModal({ rooms }: { rooms: MaintenanceRoom[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoTip, setPhotoTip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  /** 关闭时把弹窗内部状态清干净，下次打开是空表单 */
  const close = () => {
    setOpen(false);
    setPhotos([]);
    setPhotoTip(null);
    setError(null);
    setOk(null);
  };

  /** 选图：只留 1 张，超过 200KB 或非图片直接拒绝并提示 */
  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setPhotos([]);
    setPhotoTip(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPhotoTip("只能选择图片文件");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setPhotoTip(`图片不能超过 200KB（当前 ${Math.round(file.size / 1024)}KB），请压缩后再选`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setPhotos([reader.result]);
    };
    reader.onerror = () => setPhotoTip("读取图片失败，请重试");
    reader.readAsDataURL(file);
  };

  /** 提交：前端先校验，再调服务端 action，成功后刷新页面数据 */
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const roomId = String(fd.get("room_id") ?? "");
    const note = String(fd.get("note") ?? "").trim();

    if (!roomId) {
      setError("请选择要报修的房间");
      return;
    }
    if (!note) {
      setError("请填写维修说明");
      return;
    }

    fd.set("photos", JSON.stringify(photos));
    setError(null);
    setOk(null);

    startTransition(async () => {
      try {
        await createMaintenanceTaskAction(fd);
        form.reset();
        setPhotos([]);
        setPhotoTip(null);
        setOk("报修已提交，房间已置为维修 OOO");
        router.refresh();
      } catch (err) {
        /*
         * 服务端校验失败时会 redirect(/housekeeping?err=…)，Next 用 digest 以 NEXT_REDIRECT
         * 开头的特殊错误来实现跳转。这里必须原样抛出，否则会被下面这行吞成一句「NEXT_REDIRECT」。
         */
        const digest = (err as { digest?: unknown } | null)?.digest;
        if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw err;
        setError(err instanceof Error ? err.message : "提交失败，请重试");
      }
    });
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-primary px-3 py-1 text-[12px]">
        报修
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]" data-keep-open>
          <div className="w-[520px] max-w-[94vw] rounded-lg bg-white shadow-2xl">
            {/* 标题栏 */}
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">新建维修任务</span>
              <button
                type="button"
                onClick={close}
                className="text-[15px] text-gray-400 hover:text-red-600"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>

            <form onSubmit={submit} className="space-y-3 p-4">
              <div>
                <label className="label">房间 *</label>
                <select name="room_id" className="input" defaultValue="" required>
                  <option value="">请选择房间</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.roomNo} · {r.floor != null ? `${r.floor} 层` : "楼层未知"} ·{" "}
                      {ROOM_STATUS_LABEL[r.status] ?? r.status}
                    </option>
                  ))}
                </select>
                {rooms.length === 0 && (
                  <div className="mt-1 text-[11px] text-amber-600">当前没有可报修的房间（空房 / 维修房为空）</div>
                )}
              </div>

              <div>
                <label className="label">维修说明 *</label>
                <textarea
                  name="note"
                  rows={3}
                  required
                  placeholder="例如：卫生间花洒漏水，需更换软管"
                  className="input resize-y"
                />
              </div>

              <div>
                <label className="label">维修图片（可选，限 1 张 / 200KB）</label>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={pickFile}
                    className="block w-full text-[12px] text-gray-600 file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-gray-300 file:bg-white file:px-2.5 file:py-1 file:text-[12px] file:text-gray-700 hover:file:border-brand-400 hover:file:text-brand-600"
                  />
                  {photos.length > 0 && (
                    <img src={photos[0]} alt="维修图片预览" className="h-10 w-10 rounded border border-gray-200 object-cover" />
                  )}
                </div>
                <div className="mt-1 text-[11px] text-gray-400">
                  图片不上传到服务器，直接转成 data URL 存进任务记录的 photos 字段
                </div>
                {photoTip && <div className="mt-1 text-[11px] text-amber-600">{photoTip}</div>}
              </div>

              {error && (
                <div className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11.5px] text-red-600">
                  {error}
                </div>
              )}
              {ok && (
                <div className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11.5px] text-emerald-700">
                  {ok}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
                <button type="button" onClick={close} className="btn-default px-3 py-1 text-[12px]">
                  取消
                </button>
                <button type="submit" disabled={pending} className="btn-primary px-3 py-1 text-[12px]">
                  {pending ? "提交中…" : "提交报修"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
