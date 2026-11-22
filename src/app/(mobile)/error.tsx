"use client";

/**
 * 移动端错误边界（整改 P2-26h：全站原来没有 error.tsx）
 *
 * 之前任何一个页面抛错，手机上只能看到 Next 默认的英文错误页 / 白屏。
 * 这里给员工端一个能重试、能回工作台的兜底页面。
 */
export default function MobileError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-[520px] px-4 py-16 text-center">
      <div className="text-[15px] font-semibold text-gray-900">页面出错了</div>
      <p className="mt-2 text-[12px] leading-[18px] text-[#8b949e]">
        刚才这一步没有完成，数据没有被写入。可以重试一次，或者回工作台继续别的操作。
        {error.digest && <span className="mt-1 block font-mono text-[10.5px] text-[#b0b8bf]">错误号 {error.digest}</span>}
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-9 items-center rounded-[4px] bg-[#1e8e3e] px-4 text-[12.5px] text-white"
        >
          重试
        </button>
        <a href="/m" className="inline-flex h-9 items-center rounded-[4px] border border-[#dcdcdc] px-4 text-[12.5px] text-gray-700">
          回工作台
        </a>
      </div>
    </div>
  );
}
