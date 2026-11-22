/**
 * 移动端加载骨架（整改 P2-26h：全站原来没有 loading.tsx）
 *
 * 只在 (mobile) 分组内生效，不会影响桌面端页面。
 * 用骨架块而不是「转圈」，避免移动网络下页面闪一下又是白屏。
 */
export default function MobileLoading() {
  return (
    <div className="mx-auto max-w-[520px]" role="status" aria-live="polite" aria-busy="true">
      <div className="border-b border-[#e5e5e5] bg-white/95 px-3 py-2">
        <div className="h-4 w-16 animate-pulse rounded bg-[#e9ebee]" />
        <div className="mt-2 flex gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-11 w-16 animate-pulse rounded-full bg-[#eef0f2]" />
          ))}
        </div>
      </div>
      <div className="space-y-2 px-3 py-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[76px] animate-pulse rounded-[8px] bg-white" />
        ))}
      </div>
      <span className="sr-only">加载中…</span>
    </div>
  );
}
