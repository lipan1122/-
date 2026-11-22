import Link from "next/link";

/** 档案管理左侧菜单（与去呼呼一致）：客人档案 / 协议客户档案 / 智能短信（4 子项） */
const ARCHIVE_ITEMS = [
  { label: "客人档案", href: "/guests?view=profile" },
  { label: "协议客户档案", href: "/companies" },
];

const SMS_ITEMS = [
  { label: "自动短信服务", href: "/sms?tab=templates" },
  { label: "手动短信服务", href: "/sms?tab=send" },
  { label: "短信发送记录", href: "/sms?tab=logs" },
  { label: "短信充值记录", href: "/sms?tab=settings" },
];

export function ArchiveSidebar({ active }: { active: string }) {
  return (
    <aside className="w-[168px] shrink-0 border-r border-[#e8e8e8] bg-white py-2">
      {ARCHIVE_ITEMS.map((item) => {
        const on = item.label === active;
        return (
          <Link
                prefetch={false}
            key={item.label}
            href={item.href}
            className={`flex h-[34px] items-center border-l-[3px] pl-[13px] text-[13px] ${
              on
                ? "border-[#0f8f6f] bg-[#eef9f0] font-medium text-[#0f8f6f]"
                : "border-transparent text-[#555] hover:bg-[#f7f9f8]"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
      <details open={active.startsWith("短信")}>
        <summary className="flex h-[34px] cursor-pointer list-none items-center border-l-[3px] border-transparent pl-[13px] text-[13px] text-[#555] hover:bg-[#f7f9f8] [&::-webkit-details-marker]:hidden">
          智能短信
          <span className="ml-auto pr-2 text-[10px] text-[#bbb]">▾</span>
        </summary>
        {SMS_ITEMS.map((item) => {
          const on = item.label === active;
          return (
            <Link
                prefetch={false}
              key={item.label}
              href={item.href}
              className={`flex h-[32px] items-center border-l-[3px] pl-[29px] text-[12.5px] ${
                on
                  ? "border-[#0f8f6f] bg-[#eef9f0] font-medium text-[#0f8f6f]"
                  : "border-transparent text-[#666] hover:bg-[#f7f9f8]"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </details>
    </aside>
  );
}
