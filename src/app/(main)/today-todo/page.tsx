import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TODO_TABS = [
  { key: "front", label: "前台任务" },
  { key: "channel", label: "直连订单消息" },
  { key: "shop", label: "餐饮及小商超订单" },
  { key: "abnormal", label: "异常检查" },
  { key: "lock", label: "门锁检查" },
  { key: "wake", label: "叫醒服务" },
  { key: "finance", label: "财务相关" },
];

const TODO_TAGS = [
  "全部",
  "门店消息",
  "价格调整建议",
  "商超订单消息",
  "开发票",
  "免费wifi",
  "客房服务",
  "清洁服务",
  "餐饮服务",
  "订房",
  "续住",
  "自定义",
  "门店过期提醒",
  "预离提醒",
  "预住提醒",
  "取消入住审批",
];

export default async function WorkbenchPage() {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const yesterday = todayStr(addDays(today, -1));

  const roomTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM rooms WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  const inhouse = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
    [hotelId]
  )?.n ?? 0;
  const arrivals = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings WHERE hotel_id = ? AND check_in_date = ? AND status IN ('PENDING','CONFIRMED')`,
    [hotelId, today]
  )?.n ?? 0;
  const departures = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out = ?`,
    [hotelId, today]
  )?.n ?? 0;
  const occupiedRooms = get<{ n: number }>(
    `SELECT COUNT(DISTINCT room_id) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
    [hotelId]
  )?.n ?? 0;
  const sellable = Math.max(0, roomTotal - occupiedRooms);

  /* 前台待办分类数量（对齐去呼呼工作台「前台待办」的角标） */
  const channelToday = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = ? AND date(imported_at) = ?`,
    [hotelId, today]
  )?.n ?? 0;
  const todoCounts: Record<string, number> = {
    front: arrivals + departures,
    channel: channelToday,
    shop: 0,
    abnormal: 0,
    lock: 0,
    wake: 0,
    finance: 0,
  };

  const occRate = roomTotal > 0 ? (occupiedRooms / roomTotal) * 100 : 0;

  // 房费与收款（今日）
  const fee = get<{ room_fee: number | null; other: number | null }>(
    `SELECT COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN amount ELSE 0 END),0) AS room_fee,
            COALESCE(SUM(CASE WHEN item_type <> 'ROOM' THEN amount ELSE 0 END),0) AS other
     FROM folio_items WHERE hotel_id = ? AND biz_date = ?`,
    [hotelId, today]
  ) ?? { room_fee: 0, other: 0 };
  const roomFee = Number(fee.room_fee ?? 0);
  const otherFee = Number(fee.other ?? 0);
  const nights = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
    [hotelId]
  )?.n ?? 0;
  const adr = nights > 0 ? roomFee / nights : 0;
  const revpar = roomTotal > 0 ? roomFee / roomTotal : 0;

  const payments = get<{ n: number | null }>(
    `SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE hotel_id = ? AND date(created_at, 'localtime') = ?`,
    [hotelId, today]
  )?.n ?? 0;

  // 保洁
  const hk = all<{ status: string }>(`SELECT status FROM housekeeping WHERE hotel_id = ?`, [hotelId]);
  const hkPending = hk.filter((h) => h.status === "PENDING").length;
  const hkDone = hk.filter((h) => h.status === "DONE").length;

  // 夜审
  const nightAudit = get<{ biz_date: string | null; operator: string | null }>(
    `SELECT biz_date, operator FROM night_audits WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`,
    [hotelId]
  );

  const notices = all<{ id: number; title: string; created_at: string | null }>(
    `SELECT id, title, created_at FROM notices WHERE hotel_id = ? ORDER BY id DESC LIMIT 5`,
    [hotelId]
  );

  const shifts = get<{ consume: number | null; receipt: number | null }>(
    `SELECT COALESCE(SUM(CASE WHEN item_type <> 'PAYMENT' THEN amount ELSE 0 END),0) AS consume,
            COALESCE(SUM(CASE WHEN item_type = 'PAYMENT' THEN amount ELSE 0 END),0) AS receipt
     FROM folio_items WHERE hotel_id = ? AND biz_date = ?`,
    [hotelId, today]
  ) ?? { consume: 0, receipt: 0 };

  const Card = ({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) => (
    <div className="rounded-[3px] border border-[#e8e8e8] bg-white">
      <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
        <span className="text-[13px] font-medium text-[#333]">{title}</span>
        {extra}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );

  const Stat = ({ label, value, unit, href }: { label: string; value: string | number; unit?: string; href?: string }) => (
    <div>
      <div className="text-[12px] text-[#888]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[20px] font-semibold tabular-nums text-[#222]">{value}</span>
        {unit && <span className="text-[11px] text-[#999]">{unit}</span>}
        {href && (
          <Link href={href} aria-label={`查看${label}`} className="ml-0.5 text-[12px] text-[#bbb] hover:text-[#2a9d5c]">
            ›
          </Link>
        )}
      </div>
    </div>
  );

  const Metric = ({ label, value, compare }: { label: string; value: string; compare?: string }) => (
    <div>
      <div className="text-[12px] text-[#888]">
        {label} <span className="text-[10px] text-[#ccc]">?</span>
      </div>
      <div className="mt-0.5 text-[19px] font-semibold tabular-nums text-[#222]">{value}</div>
      {compare && <div className="mt-0.5 text-[10.5px] text-[#999]">{compare}</div>}
    </div>
  );

  return (
    <div className="space-y-3 p-3">
      <div className="grid gap-3 xl:grid-cols-[1fr_1.4fr_1fr]">
        {/* 宾客接待列表 */}
        <Card title="宾客接待列表">
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
            <Stat label="当前在住(间)" value={inhouse} href="/inhouse" />
            <Stat label="今日预抵(间)" value={arrivals} href="/today-todo?tab=arrivals" />
            <Stat label="今日预离(间)" value={departures} href="/today-todo?tab=departures" />
            <Stat label="今日可售(间)" value={sellable} href="/rooms" />
            <Stat label="当前占房数(间)" value={occupiedRooms} href="/rooms" />
          </div>
        </Card>

        {/* 今日客房收益 */}
        <Card
          title="今日客房收益"
          extra={
            <Link href="/reports?r=room-revenue" className="text-[12px] text-[#2a9d5c] hover:underline">
              更多详情 ›
            </Link>
          }
        >
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
            <Metric label="预计出租率" value={`${occRate.toFixed(2)}%`} compare="上周周期 91.11%" />
            <Metric label="预计间夜数(间)" value={String(nights)} compare={`上周周期 ${nights}`} />
            <Metric label="预计平均房价(元)" value={adr.toFixed(2)} compare="上周周期 145.69" />
            <Metric label="预计客房收益(RevPAR)" value={revpar.toFixed(2)} compare="上周周期 132.74" />
            <Metric label="预计总房费(元)" value={roomFee.toFixed(2)} compare="上周周期 5973.19" />
            <Metric label="预计总收入(元)" value={(roomFee + otherFee).toFixed(2)} compare="上周周期 5973.19" />
          </div>
        </Card>

        {/* 保洁任务 */}
        <Card
          title="保洁任务"
          extra={
            <Link href="/housekeeping" className="text-[12px] text-[#2a9d5c] hover:underline">
              保洁预估表
            </Link>
          }
        >
          <div className="grid grid-cols-4 gap-y-3 text-center">
            {[
              ["保洁任务", hkPending],
              ["检查任务", 0],
              ["待定任务", hkPending],
              ["未分配", 0],
              ["已分配", 0],
              ["加急", 0],
              ["已完成", hkDone],
            ].map(([label, value], i) => (
              <div key={i} className={i === 0 ? "text-left" : ""}>
                <div className="text-[12px] text-[#888]">{label}</div>
                <div className={`mt-0.5 text-[16px] font-semibold tabular-nums ${String(value) !== "0" ? "text-[#e53935]" : "text-[#999]"}`}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.55fr_1fr]">
        {/* 前台待办 */}
        <div className="space-y-3">
          <div className="rounded-[3px] border border-[#e8e8e8] bg-white">
            <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-medium text-[#333]">前台待办</div>
            <div className="flex flex-wrap gap-1.5 border-b border-[#f8f8f8] px-3 py-2">
              {TODO_TABS.map((t, i) => (
                <span
                  key={t.key}
                  className={`rounded-[2px] px-2 py-1 text-[12px] ${
                    i === 0 ? "bg-[#3bd943] text-white" : "border border-[#e5e5e5] bg-white text-[#555]"
                  }`}
                >
                  {t.label} {todoCounts[t.key] ?? 0}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 border-b border-[#f8f8f8] px-3 py-2">
              {TODO_TAGS.map((tag, i) => (
                <span
                  key={tag}
                  className={`rounded-[2px] px-2 py-0.5 text-[11.5px] ${
                    i === 0 ? "bg-[#eef9f0] text-[#2a9d5c]" : "text-[#666]"
                  }`}
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 py-2">
              <button className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#999]" disabled>
                批量标记为已读
              </button>
              <button className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#999]" disabled>
                查看全部
              </button>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[#f2faf3]">
                  <th className="w-8 border-b border-[#e8e8e8] px-2 py-2"></th>
                  <th className="w-24 border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">类型</th>
                  <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">消息内容</th>
                  <th className="w-28 border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">发布时间</th>
                  <th className="w-16 border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={5} className="px-2 py-10 text-center text-[12px] text-[#999]">
                    暂无待办
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[#f0f0f0] px-3 py-2 text-[12px] text-[#666]">
              <span>共 0 条记录</span>
              <span className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[#bbb]">上一页</span>
              <span className="flex h-5 w-5 items-center justify-center rounded-[2px] bg-[#3bd943] text-white">1</span>
              <span className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[#bbb]">下一页</span>
            </div>
          </div>
        </div>

        {/* 右侧栏 */}
        <div className="space-y-3">
          <Card
            title="交接班"
            extra={
              <Link href="/reports?r=shift-report" className="text-[12px] text-[#2a9d5c] hover:underline">
                交班报表
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[12px] text-[#888]">消费合计</div>
                <div className="text-[17px] font-semibold tabular-nums text-[#222]">{Number(shifts.consume ?? 0).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-[12px] text-[#888]">收款合计</div>
                <div className="text-[17px] font-semibold tabular-nums text-[#222]">{Number(payments ?? 0).toFixed(2)}</div>
              </div>
            </div>
            <div className="mt-2 text-[11.5px] text-[#888]">
              班次：{today.slice(5)} 早班　操作人：{user.realName}
            </div>
          </Card>

          <Card
            title="夜审"
            extra={
              <Link href="/reports?r=night-audit" className="text-[12px] text-[#2a9d5c] hover:underline">
                夜审记录表
              </Link>
            }
          >
            <div className="text-[12px] text-[#555]">
              营业日：<b className="text-[#222]">{nightAudit?.biz_date ?? today}</b>　操作人：
              <b className="text-[#222]">{nightAudit?.operator ?? "系统"}</b>
            </div>
            <div className="mt-2 flex gap-1.5">
              <Link
                href="/night-audit"
                className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#666] hover:border-[#32c141] hover:text-[#2a9d5c]"
              >
                夜审步骤
              </Link>
              <span className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#666]">
                6点自动夜审已开启
              </span>
            </div>
          </Card>

          <Card
            title="公告"
            extra={
              <Link href="/notices" className="text-[12px] text-[#2a9d5c] hover:underline">
                全部 ›
              </Link>
            }
          >
            {notices.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-[#999]">暂无公告</div>
            ) : (
              <ul className="space-y-1.5">
                {notices.map((n) => (
                  <li key={n.id} className="truncate text-[12px] text-[#555]">
                    · {n.title}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-3 rounded-[3px] border border-[#e8e8e8] bg-white p-3">
            <div className="text-center">
              <div className="text-[12px] text-[#333]">扫码添加</div>
              <div className="text-[11px] text-[#999]">小管家企业微信</div>
              <div className="mx-auto mt-2 flex h-16 w-16 items-center justify-center rounded border border-dashed border-[#ddd] text-[10px] text-[#bbb]">
                二维码
              </div>
            </div>
            <div className="text-center">
              <div className="text-[12px] text-[#333]">扫码登录</div>
              <div className="text-[11px] text-[#999]">酒店管家PMS小程序</div>
              <div className="mx-auto mt-2 flex h-16 w-16 items-center justify-center rounded border border-dashed border-[#ddd] text-[10px] text-[#bbb]">
                二维码
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
