import Link from "next/link";
import ConfirmForm from "@/components/ConfirmForm";
import { ChannelMatrix } from "@/components/ChannelMatrix";

import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, todayStr } from "@/lib/utils";
import { capabilityNote, channelCapability } from "@/lib/channels";
import { formatCommissionPercent } from "@/lib/channels/common";
import { pendingStockCount, recentStockQueue } from "@/lib/channels/stock-queue";
import { summarizeSettlements, type SettlementChannelSummary } from "@/lib/channels/settlements";
import {
  autoAcceptAllAction,
  deleteChannelRatePlanAction,
  rebuildChannelSettlementsAction,
  saveChannelAction,
  saveChannelRatePlanAction,
  saveChannelRoomTypeAction,
  toggleAutoImportAction,
  toggleOversellAction,
} from "./actions";
import {
  // 真实直连同步（整改清单 4.1 / P1-20 / P2-13）：走 src/lib/channels 的适配器，统一经 invokeWithLog 留痕。
  // 整改清单 P1-23：原来与这里并列的 4 个「演示」动作（随机造单 / 只写日志的推送 / 假测试连接）
  // 已整体删除 —— 它们会往生产库写随机渠道订单并自动建正式预订。
  pullOrdersAction as pullChannelOrdersAction,
  pushRatesAction as pushChannelRatesAction,
  testConnectionSyncAction,
  retryChannelSyncLogAction,
  retryDueSyncLogsAction,
  drainStockQueueAction,
} from "./sync-actions";

export const dynamic = "force-dynamic";

/** 渠道在矩阵里展示的顺序与分组 */
const MATRIX_CHANNELS: { type: string; label: string; tone: string }[] = [
  { type: "ctrip", label: "携程", tone: "bg-[#e8f0ff] text-[#1a5fd0]" },
  { type: "meituan", label: "美团酒店", tone: "bg-[#fff7d6] text-[#b8860b]" },
  { type: "meituan_homestay", label: "美团民宿", tone: "bg-[#fff1e6] text-[#c2701a]" },
  { type: "fliggy", label: "飞猪", tone: "bg-[#eafff0] text-[#2a9d3a]" },
  { type: "douyin", label: "抖音来客", tone: "bg-[#f0f0f3] text-[#161823]" },
  { type: "elong", label: "艺龙", tone: "bg-[#f0ebff] text-[#6d3fd0]" },
];

const DAYS = 14;

/** 渠道同步动作的中文名（页面「直连同步」摘要用） */
const SYNC_ACTION_LABEL: Record<string, string> = {
  PUSH_RATES: "推送房量",
  PULL_ORDERS: "拉取订单",
  PUSH_STATUS: "状态回传",
  TEST_CONNECTION: "测试连接",
};

/** 每个渠道展开后的子页面（去呼呼左侧二级菜单） */
const CHANNEL_SUB_MENU = [
  { key: "room-status", label: "房态与房量" },
  { key: "room-match", label: "房型与匹配" },
  { key: "batch-status", label: "批量修改房态" },
  { key: "cancel-policy", label: "取消政策" },
  { key: "multi-store", label: "多店管理" },
  // 整改清单 P2-12：原来没有任何渠道账单 / 佣金对账的地方，佣金只是报表里的估算列
  { key: "settlements", label: "佣金对账" },
];

/** 能力标签的配色（直连 / 沙箱 / 无直连 三态必须一眼可辨） */
const CAPABILITY_TONE: Record<string, string> = {
  direct: "bg-[#eef9f0] text-[#2a9d5c]",
  sandbox: "bg-[#fffbe6] text-[#b8860b]",
  unsupported: "bg-[#f5f5f5] text-[#999]",
};

const CAPABILITY_LABEL: Record<string, string> = {
  direct: "直连",
  sandbox: "沙箱",
  unsupported: "无直连能力",
};

/** 去呼呼直连管理左侧渠道菜单 */
const SIDE_MENU = [
  { code: 'ctrip', label: '携程', tone: 'bg-[#e8f0ff] text-[#1a5fd0]', letter: '携' },
  { code: 'fliggy', label: '飞猪', tone: 'bg-[#fff3e0] text-[#e07b1a]', letter: '飞' },
  { code: 'meituan_homestay', label: '美团民宿', tone: 'bg-[#fff7d6] text-[#b8860b]', letter: '民' },
  { code: 'meituan', label: '美团酒店', tone: 'bg-[#fff7d6] text-[#b8860b]', letter: '美' },
  { code: 'douyin', label: '抖音', tone: 'bg-[#f0f0f3] text-[#161823]', letter: '抖' },
  { code: 'douyin_voucher', label: '抖音预售券', tone: 'bg-[#f0f0f3] text-[#161823]', letter: '券' },
];

type Search = { date?: string; type?: string; q?: string; tab?: string; ch?: string };

/** 一条渠道同步日志（老库缺扩展列时后端补成 NULL / 0，页面展示逻辑不用分叉） */
type SyncLogRow = {
  id: number;
  channel_type: string | null;
  action: string | null;
  status: string | null;
  message: string | null;
  error_code: string | null;
  retry_count: number | null;
  created_at: string | null;
  /* 整改清单 4.2 新增：请求编号 / 耗时 / 成功失败条数（老库缺列时后端补 NULL，按可选处理） */
  request_no?: string | null;
  duration_ms?: number | null;
  success_count?: number | null;
  fail_count?: number | null;
};

/* ------------------------------------------------------------------ *
 * 渠道子页面：房型与匹配 / 批量修改房态 / 取消政策 / 多店管理
 * ------------------------------------------------------------------ */

function RoomMatchPanel({
  rows,
  roomTypes,
  hotelName,
}: {
  rows: { channel_type: string; channel_room_name: string; room_type_id: number | null }[];
  roomTypes: { id: number; name: string }[];
  hotelName: string;
}) {
  const unmatched = rows.filter((r) => !r.room_type_id).length;

  return (
    <div className="space-y-3">
      {/* 顶部横幅：酒店名 + 优惠活动入口 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded-[2px] bg-[#3bd943] px-2 py-1 text-[12px] text-white">（预付）</span>
          <span className="text-[13px] font-semibold text-[#222]">{hotelName}</span>
        </div>
        <a href="#" className="text-[12px] text-[#2a9d5c] hover:underline">
          如何参加携程后台优惠活动?
        </a>
      </div>

      {/* 匹配表 */}
      <div className="overflow-x-auto rounded-[3px] border border-[#e5e5e5] bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#f2faf3]">
              <th className="w-[240px] border-b border-r border-[#e8e8e8] px-3 py-2.5 text-left text-[12.5px] font-medium text-[#555]">
                去呼呼客栈管家本地房型名称
              </th>
              <th className="border-b border-r border-[#e8e8e8] px-3 py-2.5 text-left text-[12.5px] font-medium text-[#555]">
                携程房型名称
                <span className="ml-2 text-[11.5px] text-[#999]">（{unmatched}个携程房型未匹配）</span>
                <button className="ml-2 rounded-[2px] bg-[#3bd943] px-2 py-0.5 text-[11.5px] text-white hover:bg-[#33cd3b]">
                  获取酒店最新房型
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {roomTypes.map((t) => {
              const match = rows.find((r) => r.room_type_id === t.id);
              return (
                <tr key={t.id} className="border-b border-[#f0f0f0]">
                  <td className="border-r border-[#f0f0f0] px-3 py-3 text-[12.5px] text-[#222]">{t.name}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {match ? (
                        <>
                          <span className="max-w-[380px] truncate text-[12.5px] text-[#333]">
                            {match.channel_room_name}
                          </span>
                          <button className="rounded-[2px] border border-[#ddd] px-2 py-0.5 text-[11.5px] text-[#888] hover:border-[#e53935] hover:text-[#e53935]">
                            解除匹配
                          </button>
                        </>
                      ) : null}
                      <button className="rounded-[2px] bg-[#3bd943] px-2 py-0.5 text-[11.5px] text-white hover:bg-[#33cd3b]">
                        匹配房型
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {roomTypes.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-10 text-center text-[12px] text-[#999]">
                  暂无本地房型
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 直连须知 */}
      <div className="rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2.5">
        <div className="mb-1 text-[13px] font-semibold text-[#222]">携程直连须知：</div>
        <ol className="space-y-1 text-[12px] leading-[20px] text-[#555]">
          <li>1.【房价】：请在携程 eBooking 后台维护；</li>
          <li>
            2.【房态】：携程订单会根据去呼呼 &lt;房态&gt; 首页的实时房量进行自动确认，
            <span className="text-[#e53935]">满房自动关房</span>。
          </li>
          <li>3.【优享会活动】：优享会活动不受直连影响，请登录携程 eBooking -&lt;促销推广&gt;-&lt;优享会&gt;-点击「修改」，勾选「选择支持直连叠加折扣的子酒店 ID」即可。</li>
          <li>4.【入离店审核】：直连订单在去呼呼系统中办理入离店操作后，订单状态会同步至携程，自动进行入离店审核；</li>
          <li>5.【订单通知】：为确保及时有效的接收订单信息，请绑定 &lt;微信通知&gt;（导航栏点击 &lt;更多&gt;-&lt;功能设置&gt;-&lt;通知设置&gt;-&lt;微信通知&gt;扫码添加微信号）。</li>
        </ol>
      </div>
    </div>
  );
}

function BatchStatusPanel({
  roomTypes,
  channelRoomTypes,
  hotelName,
}: {
  roomTypes: { id: number; name: string; total: number }[];
  channelRoomTypes: { channel_room_name: string; room_type_id: number | null }[];
  hotelName: string;
}) {
  return (
    <form method="post" action="/api/channels/batch-status" className="space-y-3">
      {/* 1. 选择房型 */}
      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[14px] font-semibold text-[#222]">1.选择房型</div>
        <div className="flex flex-wrap items-center gap-3 border-b border-[#f5f5f5] px-3 py-2">
          <div className="flex items-center gap-1">
            <input placeholder="支持房型名称搜索" className="input h-7 w-[200px] text-[12px]" />
            <button type="button" aria-label="按房型名称搜索" className="flex h-7 w-7 items-center justify-center rounded-[2px] border border-[#ddd] text-[12px] text-[#888]">
              🔍
            </button>
          </div>
          <label className="flex items-center gap-1 text-[12px] text-[#555]">
            <input type="radio" name="scope" value="all" defaultChecked className="accent-[#3bd943]" /> 全部房型
          </label>
          <label className="flex items-center gap-1 text-[12px] text-[#555]">
            <input type="radio" name="scope" value="prepay" className="accent-[#3bd943]" /> 预付
          </label>
          <span className="text-[#e5e5e5]">|</span>
          <span className="text-[12px] text-[#333]">⦿【预付】{hotelName}</span>
        </div>

        <div className="flex items-center gap-3 border-b border-[#f5f5f5] px-3 py-1.5 text-[12px]">
          <label className="flex items-center gap-1 text-[#555]">
            <input type="checkbox" className="h-3.5 w-3.5 accent-[#3bd943]" /> 全选
          </label>
          <button type="button" className="text-[#2a9d5c] hover:underline">
            取消选择
          </button>
        </div>

        <div className="divide-y divide-[#f8f8f8]">
          {channelRoomTypes.map((c, i) => (
            <label key={i} className="flex items-center gap-2 px-3 py-2 hover:bg-[#fafcfb]">
              <input type="checkbox" name="room" value={i} className="h-3.5 w-3.5 shrink-0 accent-[#3bd943]" />
              <span className="rounded-[2px] bg-[#fff2e9] px-1 text-[10.5px] text-[#e07b1a]">预付</span>
              <span className="truncate text-[12px] text-[#333]">{c.channel_room_name}</span>
            </label>
          ))}
          {channelRoomTypes.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-[#999]">暂无渠道房型</div>
          )}
        </div>
      </div>

      {/* 2. 选择时间 */}
      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[14px] font-semibold text-[#222]">2.选择时间</div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-[#555]">
          <span>
            已选择 <b className="text-[#222]">1</b> 天
          </span>
          <button type="button" className="text-[#2a9d5c] hover:underline">
            重置
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 text-[12px] text-[#555]">
          <span>适用日期：</span>
          <input type="date" name="start" className="input h-7 w-[140px] text-[12px]" />
          <span>至</span>
          <input type="date" name="end" className="input h-7 w-[140px] text-[12px]" />
          <button type="button" className="flex h-6 w-6 items-center justify-center rounded-full border border-[#3bd943] text-[13px] text-[#3bd943]">
            +
          </button>
        </div>
      </div>

      {/* 3. 设置房态 */}
      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[14px] font-semibold text-[#222]">3.设置房态</div>
        <div className="flex flex-wrap items-center gap-4 px-3 py-3 text-[12px] text-[#555]">
          <span>房态：</span>
          <label className="flex items-center gap-1">
            <input type="radio" name="status" value="keep" defaultChecked className="accent-[#3bd943]" /> 不变
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="status" value="open" className="accent-[#3bd943]" /> 有房
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="status" value="close" className="accent-[#3bd943]" /> 满房
          </label>
        </div>
      </div>

      <div className="flex justify-center py-2">
        <button className="rounded-[3px] bg-[#3bd943] px-16 py-2 text-[14px] font-medium text-white hover:bg-[#33cd3b]">
          保存
        </button>
      </div>
    </form>
  );
}

function CancelPolicyPanel({
  channelRoomTypes,
  hotelName,
}: {
  channelRoomTypes: { channel_room_name: string; room_type_id: number | null }[];
  hotelName: string;
}) {
  return (
    <form method="post" action="/api/channels/cancel-policy" className="space-y-3">
      {/* 1. 选择房型 */}
      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[14px] font-semibold text-[#222]">1.选择房型</div>
        <div className="flex flex-wrap items-center gap-3 border-b border-[#f5f5f5] px-3 py-2">
          <div className="flex items-center gap-1">
            <input placeholder="支持房型名称搜索" className="input h-7 w-[200px] text-[12px]" />
            <button type="button" aria-label="按房型名称搜索" className="flex h-7 w-7 items-center justify-center rounded-[2px] border border-[#ddd] text-[12px] text-[#888]">
              🔍
            </button>
          </div>
          <label className="flex items-center gap-1 text-[12px] text-[#555]">
            <input type="radio" name="scope" value="all" defaultChecked className="accent-[#3bd943]" /> 全部房型
          </label>
          <label className="flex items-center gap-1 text-[12px] text-[#555]">
            <input type="radio" name="scope" value="prepay" className="accent-[#3bd943]" /> 预付
          </label>
          <span className="text-[#e5e5e5]">|</span>
          <span className="text-[12px] text-[#333]">◯【预付】{hotelName}</span>
        </div>
        <div className="flex items-center gap-3 border-b border-[#f5f5f5] px-3 py-1.5 text-[12px]">
          <label className="flex items-center gap-1 text-[#555]">
            <input type="checkbox" className="h-3.5 w-3.5 accent-[#3bd943]" /> 全部
          </label>
          <button type="button" className="text-[#2a9d5c] hover:underline">
            取消选择
          </button>
        </div>
        <div className="divide-y divide-[#f8f8f8]">
          {channelRoomTypes.map((c, i) => (
            <label key={i} className="flex items-center gap-2 px-3 py-2 hover:bg-[#fafcfb]">
              <input type="checkbox" name="room" value={i} className="h-3.5 w-3.5 shrink-0 accent-[#3bd943]" />
              <span className="rounded-[2px] bg-[#fff2e9] px-1 text-[10.5px] text-[#e07b1a]">预付</span>
              <span className="truncate text-[12px] text-[#333]">{c.channel_room_name}</span>
            </label>
          ))}
          {channelRoomTypes.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-[#999]">暂无渠道房型</div>
          )}
        </div>
      </div>

      {/* 2. 选择日期（去呼呼原页面这里编号也是 1.，保持一致） */}
      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[14px] font-semibold text-[#222]">1.选择日期</div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-[#555]">
          <span>
            已选择 <b className="text-[#222]">1</b> 天
          </span>
          <button type="button" className="text-[#2a9d5c] hover:underline">
            重置
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 text-[12px] text-[#555]">
          <span>适用日期：</span>
          <input type="date" name="start" className="input h-7 w-[140px] text-[12px]" />
          <span>至</span>
          <input type="date" name="end" className="input h-7 w-[140px] text-[12px]" />
          <button type="button" className="flex h-6 w-6 items-center justify-center rounded-full border border-[#3bd943] text-[13px] text-[#3bd943]">
            +
          </button>
          <label className="flex items-center gap-1">
            <input type="checkbox" name="all_time" className="h-3.5 w-3.5 accent-[#3bd943]" /> 适用所有时间段
          </label>
          <span className="text-[#bbb]" title="勾选后该政策对所有时段生效">?</span>
        </div>
      </div>

      {/* 3. 设置取消和扣款政策 */}
      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[14px] font-semibold text-[#222]">
          3.设置取消和扣款政策
        </div>
        <div className="flex flex-wrap items-center gap-4 px-3 py-3 text-[12px] text-[#555]">
          <span>取消规则：</span>
          {[
            ["keep", "不变", true],
            ["free", "免费取消", false],
            ["limited", "限时取消", false],
            ["no", "不可取消", false],
            ["step", "阶梯取消", false],
          ].map(([val, label, checked]) => (
            <label key={String(val)} className="flex items-center gap-1">
              <input
                type="radio"
                name="rule"
                value={String(val)}
                defaultChecked={Boolean(checked)}
                className="accent-[#3bd943]"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="flex justify-center py-2">
        <button className="rounded-[3px] bg-[#3bd943] px-16 py-2 text-[14px] font-medium text-white hover:bg-[#33cd3b]">
          保存
        </button>
      </div>
    </form>
  );
}

function MultiStorePanel({
  hotels,
  syncRows,
}: {
  hotels: { id: number; name: string; address: string | null }[];
  syncRows: {
    channel_hotel_id: string;
    channel_hotel_name: string;
    version: string;
    order_sync: number;
    status_sync: number;
    price_sync: number;
  }[];
}) {
  return (
    <div className="space-y-3">
      {/* 顶部：直连版本 + 添加新店 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
        <div className="text-[12.5px] text-[#555]">
          当前直连版本：<b className="text-[#222]">1.0</b>
        </div>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-[3px] bg-[#3bd943] px-3 py-1.5 text-[12px] text-white hover:bg-[#33cd3b] [&::-webkit-details-marker]:hidden">
            添加新店
          </summary>
          <form
            method="post"
            action="/api/channels/add-store"
            className="absolute right-0 z-20 mt-1 flex w-[300px] flex-col gap-1.5 rounded border border-[#e5e5e5] bg-white p-2 shadow-lg"
          >
            <input name="channel_hotel_id" placeholder="渠道酒店 ID" className="input py-1 text-[12px]" required />
            <input name="channel_hotel_name" placeholder="渠道酒店名称" className="input py-1 text-[12px]" required />
            <input name="version" defaultValue="1.0" className="input py-1 text-[12px]" />
            <button className="rounded-[3px] bg-[#3bd943] py-1 text-[12px] text-white">确认添加</button>
          </form>
        </details>
      </div>

      {/* 门店同步表 */}
      <div className="overflow-x-auto rounded-[3px] border border-[#e5e5e5] bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#f2faf3]">
              <th className="border-b border-r border-[#e8e8e8] px-3 py-2.5 text-left text-[12.5px] font-medium text-[#555]">
                携程酒店ID
              </th>
              <th className="border-b border-r border-[#e8e8e8] px-3 py-2.5 text-left text-[12.5px] font-medium text-[#555]">
                携程酒店名称
              </th>
              <th className="w-24 border-b border-r border-[#e8e8e8] px-3 py-2.5 text-left text-[12.5px] font-medium text-[#555]">
                直连版本
              </th>
              <th className="w-24 border-b border-r border-[#e8e8e8] px-3 py-2.5 text-center text-[12.5px] font-medium text-[#555]">
                订单同步
              </th>
              <th className="w-28 border-b border-r border-[#e8e8e8] px-3 py-2.5 text-center text-[12.5px] font-medium text-[#555]">
                房态房量同步
              </th>
              <th className="w-24 border-b border-r border-[#e8e8e8] px-3 py-2.5 text-center text-[12.5px] font-medium text-[#555]">
                房价同步
              </th>
              <th className="border-b border-[#e8e8e8] px-3 py-2.5 text-left text-[12.5px] font-medium text-[#555]">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {syncRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-[12px] text-[#999]">
                  暂无已直连的渠道门店，点击右上角「添加新店」
                </td>
              </tr>
            )}
            {syncRows.map((r, i) => (
              <tr key={i} className="border-b border-[#f5f5f5] hover:bg-[#fafcfb]">
                <td className="px-3 py-3 text-[12px] tabular-nums text-[#333]">{r.channel_hotel_id}</td>
                <td className="px-3 py-3 text-[12px] text-[#333]">{r.channel_hotel_name}</td>
                <td className="px-3 py-3 text-[12px] tabular-nums text-[#555]">{r.version}</td>
                <td className="px-3 py-3 text-center">
                  <SyncDot on={Boolean(r.order_sync)} />
                </td>
                <td className="px-3 py-3 text-center">
                  <SyncDot on={Boolean(r.status_sync)} />
                </td>
                <td className="px-3 py-3 text-center">
                  <SyncDot on={Boolean(r.price_sync)} />
                </td>
                <td className="px-3 py-3">
                  <Link
                    href="/sms?tab=send"
                    className="text-[12px] text-[#2a9d5c] hover:underline"
                  >
                    解除直连联系在线客服
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-[#999]">
        已授权门店 {hotels.length} 家 · 同步状态由渠道接口回执决定，绿点为已同步，灰点为未开启。
      </div>
    </div>
  );
}

function SyncDot({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#3bd943] text-[10px] text-white">
      ✓
    </span>
  ) : (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#e5e5e5] text-[10px] text-white">
      ·
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 渠道佣金对账（整改清单 P2-12）
 *
 * 两侧并排：derived = 本系统按「渠道订单金额 × 渠道佣金率」推算；
 * channel = 渠道后台结算单（将来由导入写入，目前为 0 行）。
 * 差额不为 0 的行就是要拿渠道账单核对的渠道。
 * ------------------------------------------------------------------ */
function SettlementPanel({
  rows,
  from,
  to,
}: {
  rows: SettlementChannelSummary[];
  from: string;
  to: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2 rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
        <div>
          <div className="text-[13px] font-semibold text-[#222]">渠道佣金对账（{from} ~ {to}）</div>
          <div className="mt-0.5 text-[11px] text-[#999]">
            「系统推算」= 渠道订单金额 × 该渠道佣金率（配置在渠道卡片里）；「渠道结算单」需在渠道后台核对后录入，
            目前为空表示尚未导入。差额 = 渠道结算佣金 − 系统推算佣金。
          </div>
        </div>
        <form action={rebuildChannelSettlementsAction} className="flex items-end gap-1">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <button className="rounded-[3px] border border-[#b9e3c4] bg-white px-2.5 py-1 text-[12px] text-[#2a9d5c] hover:border-[#3bd943] hover:bg-[#eef9f0]">
            重建推算快照
          </button>
        </form>
      </div>

      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#fafafa] text-[11.5px] text-[#666]">
              <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">渠道</th>
              <th className="border-b border-[#f0f0f0] px-3 py-2 text-right font-medium">推订单数</th>
              <th className="border-b border-[#f0f0f0] px-3 py-2 text-right font-medium">系统推算佣金</th>
              <th className="border-b border-[#f0f0f0] px-3 py-2 text-right font-medium">渠道结算佣金</th>
              <th className="border-b border-[#f0f0f0] px-3 py-2 text-right font-medium">差额</th>
              <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const diff = Number(row.commissionDiff ?? 0);
              const tone = row.channelCount === 0 ? "text-[#999]" : Math.abs(diff) < 0.01 ? "text-[#2a9d5c]" : "text-[#d93026]";
              return (
                <tr key={row.channelType} className="border-b border-[#f5f5f5] text-[12px] text-[#444]">
                  <td className="px-3 py-1.5">{row.channelName}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{row.derivedCount}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">¥{row.derivedCommission.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {row.channelCount === 0 ? "未导入" : `¥${row.channelCommission.toFixed(2)}`}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${tone}`}>
                    {row.channelCount === 0 ? "—" : `¥${diff.toFixed(2)}`}
                  </td>
                  <td className={`px-3 py-1.5 ${tone}`}>
                    {row.channelCount === 0 ? "待导入渠道结算单" : Math.abs(diff) < 0.01 ? "已对平" : "有差额，需核对"}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[12px] text-[#999]">
                  该区间没有渠道订单。先到「房态与房量」拉取订单，或点上方「重建推算快照」。
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 主页面：直连管理（左侧渠道菜单 + 子页面）
 * ------------------------------------------------------------------ */
export default async function ChannelsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  const today = todayStr();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? (sp.date as string) : today;
  const startDate = new Date(`${start}T00:00:00`);
  const dates = Array.from({ length: DAYS }, (_, i) => {
    const d = addDays(startDate, i);
    return todayStr(d); // P1-6：本地日期，别用 toISOString（凌晨会落前一天）
  });

  const hotel = get<{ name: string }>(`SELECT name FROM hotels WHERE id = ?`, [hotelId]);

  /* P2-22d：一键自动接单是「误点即批量占房」的不可逆操作，确认框里要先说清待接单条数 */
  const pendingAutoCount =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? AND status = 'NEW'`,
      [hotelId]
    )?.c ?? 0;

  /*
   * 渠道配置：SELECT * 而不是点名取列。
   * 整改清单 P2-11 新增了 sandbox / endpoint / app_secret_enc / last_order_sync_at，
   * 老库（没跑迁移）点名查询会直接抛 SQL 错误把整页弄崩；SELECT * 缺列时字段就是 undefined，
   * 页面用可选值兜底即可。密钥列**不显示真实值**，只显示「已配置/未配置」。
   */
  const channels = all<{
    id: number;
    name: string;
    channel_type: string | null;
    enabled: number | null;
    auto_import: number | null;
    store_id: string | null;
    app_key: string | null;
    app_secret?: string | null;
    app_secret_enc?: string | null;
    commission: number | null;
    oversell?: number | null;
    sandbox?: number | null;
    endpoint?: string | null;
    last_sync_at?: string | null;
    last_order_sync_at?: string | null;
  }>(`SELECT * FROM channels WHERE hotel_id = ? ORDER BY COALESCE(sort, 100), id`, [hotelId]);

  const roomTypes = all<{ id: number; name: string; total: number }>(
    `SELECT rt.id, rt.name, COUNT(r.id) AS total
     FROM room_types rt
     LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.hotel_id = rt.hotel_id
     WHERE rt.hotel_id = ?
     GROUP BY rt.id ORDER BY rt.sort`,
    [hotelId]
  );

  const occupied = all<{ room_type_id: number; from_date: string; to_date: string }>(
    `SELECT r.room_type_id, date(s.check_in_time) AS from_date, s.expect_check_out AS to_date
       FROM stays s JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     UNION ALL
     SELECT room_type_id, check_in_date, check_out_date
       FROM bookings WHERE hotel_id = ? AND room_id IS NOT NULL AND status IN ('PENDING','CONFIRMED','CHECKED_IN')`,
    [hotelId, hotelId]
  );

  const pending = all<{ room_type_id: number | null; from_date: string; to_date: string; room_count: number | null }>(
    `SELECT room_type_id, check_in_date AS from_date, check_out_date AS to_date, room_count
       FROM bookings WHERE hotel_id = ? AND room_id IS NULL AND status IN ('PENDING','CONFIRMED')`,
    [hotelId]
  );

  const leftFor = (typeId: number, day: string) => {
    const rt = roomTypes.find((t) => t.id === typeId);
    if (!rt) return 0;
    let used = 0;
    for (const o of occupied) {
      if (o.room_type_id === typeId && o.from_date <= day && day < o.to_date) used++;
    }
    let pend = 0;
    for (const p of pending) {
      if (p.room_type_id === typeId && p.from_date <= day && day < p.to_date) pend += Math.max(1, Number(p.room_count ?? 1));
    }
    return Math.max(0, rt.total - used - pend);
  };

  /*
   * 超售开关的库结构由 scripts/migrate-all.mjs 保证（channels.oversell 早就在迁移里）。
   * 这里只用 PRAGMA 探测来兼容极端老库：**不再在 GET 渲染里执行 ALTER TABLE** ——
   * 页面渲染顺手改库结构是多实例部署下的经典事故（并发 ALTER 直接报错整页 500）。
   */
  const channelCols = new Set(all<{ name: string }>(`PRAGMA table_info(channels)`).map((c) => c.name));
  const oversellMap = new Map(
    (channelCols.has("oversell")
      ? all<{ channel_type: string; oversell: number | null }>(
          `SELECT channel_type, oversell FROM channels WHERE hotel_id = ?`,
          [hotelId]
        )
      : []
    ).map((r) => [r.channel_type, Number(r.oversell ?? 0)])
  );

  const q = (sp.q ?? "").trim();
  const rows = q ? roomTypes.filter((t) => t.name.includes(q)) : roomTypes;
  const tab = sp.tab ?? "room-status";

  /**
   * 最近同步记录（整改报告第 8 节：失败必须能看到错误原因和重试次数）。
   *
   * error_code / retry_count 是后加的列，没跑过迁移的老库直接点名查询会抛 SQL 错误，
   * 所以先看列是否存在再决定查什么，缺列就只查原有字段——页面宁可少显示两列，也不能整页崩掉。
   * 同步日志只取本店的，避免多租户下看到别家的失败详情。
   */
  const syncLogCols = new Set(all<{ name: string }>(`PRAGMA table_info(channel_sync_logs)`).map((c) => c.name));
  const syncLogSql = syncLogCols.has("error_code")
    ? `SELECT id, channel_type, action, status, message, error_code, retry_count, created_at
         FROM channel_sync_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 12`
    : `SELECT id, channel_type, action, status, message, NULL AS error_code, 0 AS retry_count, created_at
         FROM channel_sync_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 12`;
  let syncLogs: SyncLogRow[];
  try {
    syncLogs = all<SyncLogRow>(syncLogSql, [hotelId]);
  } catch {
    // 日志表还没建时这块直接留空，不能连带把房态矩阵和渠道卡片一起弄成错误页
    syncLogs = [];
  }

  /**
   * 每个渠道类型「最近一条同步记录」
   *
   * 整改清单 4.2 要求渠道行能直接看到最近一次同步结果（成功/失败、条数、耗时）。
   * 这依赖 4.2 新增的 success_count / fail_count / duration_ms 列，老库缺列时用
   * NULL / 0 占位 —— 页面宁可少显示两行摘要，也不能因为「库还没迁移」整页崩掉。
   * 按 id 倒序取 90 条再按 channel_type 取首条：渠道数量是个位数，一次查询足够。
   */
  const latestSyncByChannel = new Map<string, SyncLogRow>();
  try {
    const latestSql = `SELECT id, channel_type, action, status, message, created_at,
        ${syncLogCols.has("request_no") ? "request_no" : "NULL AS request_no"},
        ${syncLogCols.has("duration_ms") ? "duration_ms" : "NULL AS duration_ms"},
        ${syncLogCols.has("success_count") ? "success_count" : "0 AS success_count"},
        ${syncLogCols.has("fail_count") ? "fail_count" : "0 AS fail_count"}
      FROM channel_sync_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 90`;
    for (const row of all<SyncLogRow>(latestSql, [hotelId])) {
      const key = String(row.channel_type ?? "");
      if (!latestSyncByChannel.has(key)) latestSyncByChannel.set(key, row);
    }
  } catch {
    // 日志表缺失：按钮照样可用，只是不显示「最近一次」摘要
  }

  /* ---------- P2-13：库存待同步队列（谁在等推送、为什么等） ---------- */
  const stockPending = pendingStockCount(hotelId);
  const stockQueue = recentStockQueue(hotelId, 5);

  /* ---------- P2-10：渠道价格方案（推价时按它折算；没配就显式回退到基准价） ---------- */
  let ratePlans: {
    id: number;
    channel_type: string;
    rate_code: string;
    channel_rate_name: string | null;
    factor: number | null;
    room_type_id: number | null;
  }[] = [];
  try {
    ratePlans = all(`SELECT id, channel_type, rate_code, channel_rate_name, factor, room_type_id FROM channel_rate_plans WHERE hotel_id = ? ORDER BY channel_type, id`, [
      hotelId,
    ]);
  } catch {
    // 表还没迁移：卡片上不显示价格方案
    ratePlans = [];
  }
  const ratePlansByChannel = new Map<string, typeof ratePlans>();
  for (const plan of ratePlans) {
    const key = String(plan.channel_type ?? "");
    const list = ratePlansByChannel.get(key) ?? [];
    list.push(plan);
    ratePlansByChannel.set(key, list);
  }

  /* ---------- P2-12：渠道佣金对账（系统推算 vs 渠道结算单） ---------- */
  const settlementFrom = todayStr(addDays(new Date(`${today}T00:00:00`), -30));
  const settlementRows = tab === "settlements" ? summarizeSettlements(hotelId, { from: settlementFrom, to: today }) : [];

  /* ---------- P1-20：死信（重试超限，需人工处理） ---------- */
  let deadLetterCount = 0;
  try {
    deadLetterCount =
      get<{ c: number }>(`SELECT COUNT(*) AS c FROM channel_sync_dead_letter WHERE hotel_id = ?`, [hotelId])?.c ?? 0;
  } catch {
    // 死信表还没迁移：按 0 处理
  }

  return (
    <div className="flex">
      <aside className="w-[168px] shrink-0 border-r border-[#e8e8e8] bg-white py-2">
        <div className="px-3 py-2 text-[12px] text-[#888]">多渠道房态与房量</div>
        {SIDE_MENU.map((m) => {
          const open = (sp.ch ?? "ctrip") === m.code;
          return (
            <details key={m.code} open={open} className="group">
              <summary className="flex h-[34px] cursor-pointer list-none items-center gap-2 pl-[13px] text-[13px] text-[#555] hover:bg-[#f7f9f8] [&::-webkit-details-marker]:hidden">
                <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${m.tone}`}>{m.letter}</span>
                {m.label}
                <span className="ml-auto pr-2 text-[10px] text-[#bbb] group-open:rotate-180">▾</span>
              </summary>
              <div className="pb-1">
                {CHANNEL_SUB_MENU.map((sub) => {
                  const active = open && sub.key === tab;
                  return (
                    <a
                      key={sub.key}
                      href={`/channels?tab=${sub.key}&ch=${m.code}`}
                      className={`flex h-[32px] items-center border-l-[3px] pl-[29px] text-[12.5px] ${
                        active
                          ? "border-[#0f8f6f] bg-[#eef9f0] font-medium text-[#0f8f6f]"
                          : "border-transparent text-[#666] hover:bg-[#f7f9f8]"
                      }`}
                    >
                      {sub.label}
                    </a>
                  );
                })}
              </div>
            </details>
          );
        })}
        <Link
          href="/channels/upgrade"
          className="flex h-[34px] items-center gap-2 border-l-[3px] border-transparent pl-[13px] text-[13px] text-[#555] hover:bg-[#f7f9f8]"
        >
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#eef9f0] text-[9px] text-[#0f8f6f]">升</span>
          房型升级设置
        </Link>
      </aside>

      <div className="min-w-0 flex-1 space-y-3 p-4">
        <div className="text-[17px] font-semibold text-[#222]">{hotel?.name ?? "当前酒店"}</div>

        {tab === "room-match" && (
          <>
            <RoomMatchPanel
              rows={all<{ channel_type: string; channel_room_name: string; room_type_id: number | null }>(
                `SELECT channel_type, channel_room_name, room_type_id FROM channel_room_types WHERE hotel_id = ? ORDER BY id`,
                [hotelId]
              )}
              roomTypes={roomTypes}
              hotelName={hotel?.name ?? "当前酒店"}
            />

            {/* 整改清单 P2-10：映射的**写入路径**。
                没有它，「未配映射的房型不推送」就变成了永远推不出去 ——
                管理员必须能在页面上把渠道房型名绑到本系统房型。 */}
            <div className="rounded-[3px] border border-[#dfe7e3] bg-white p-3">
              <div className="text-[13px] font-semibold text-[#222]">补一条房型映射</div>
              <div className="mt-0.5 text-[11px] text-[#999]">
                渠道后台的房型名称必须与这里完全一致；同一渠道下同名会被覆盖（改绑），不会产生重复行。
              </div>
              <form action={saveChannelRoomTypeAction} className="mt-2 flex flex-wrap items-end gap-2">
                <label className="block text-[11px] text-[#666]">
                  渠道
                  <select name="channel_type" defaultValue={sp.ch ?? "ctrip"} className="input mt-0.5 h-7 w-[120px] text-[12px]">
                    {SIDE_MENU.map((m) => (
                      <option key={m.code} value={m.code}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[11px] text-[#666]">
                  本系统房型
                  <select name="room_type_id" className="input mt-0.5 h-7 w-[180px] text-[12px]">
                    {roomTypes.map((rt) => (
                      <option key={rt.id} value={rt.id}>
                        {rt.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block flex-1 text-[11px] text-[#666]">
                  渠道房型名称（与渠道后台一致）
                  <input
                    name="channel_room_name"
                    placeholder="如 悦享阔景特大床房（携程专享）"
                    className="input mt-0.5 h-7 w-full text-[12px]"
                  />
                </label>
                <button className="h-7 rounded-[3px] bg-[#3bd943] px-3 text-[12px] text-white hover:bg-[#33cd3b]">
                  保存映射
                </button>
              </form>
            </div>
          </>
        )}
        {tab === "batch-status" && (
          <BatchStatusPanel
            roomTypes={roomTypes}
            hotelName={hotel?.name ?? "当前酒店"}
            channelRoomTypes={all<{ channel_room_name: string; room_type_id: number | null }>(
              `SELECT channel_room_name, room_type_id FROM channel_room_types WHERE hotel_id = ? ORDER BY id`,
              [hotelId]
            )}
          />
        )}
        {tab === "cancel-policy" && (
          <CancelPolicyPanel
            hotelName={hotel?.name ?? "当前酒店"}
            channelRoomTypes={all<{ channel_room_name: string; room_type_id: number | null }>(
              `SELECT channel_room_name, room_type_id FROM channel_room_types WHERE hotel_id = ? ORDER BY id`,
              [hotelId]
            )}
          />
        )}
        {tab === "multi-store" && (
          <MultiStorePanel
            hotels={all<{ id: number; name: string; address: string | null }>(
              `SELECT id, name, address FROM hotels ORDER BY id`,
              []
            )}
            syncRows={all<{
              channel_hotel_id: string;
              channel_hotel_name: string;
              version: string;
              order_sync: number;
              status_sync: number;
              price_sync: number;
            }>(
              `SELECT channel_hotel_id, channel_hotel_name, version, order_sync, status_sync, price_sync
               FROM channel_stores WHERE hotel_id = ? ORDER BY id`,
              [hotelId]
            )}
          />
        )}

        {/* 整改清单 P2-12：渠道佣金对账（系统推算 vs 渠道结算单） */}
        {tab === "settlements" && (
          <SettlementPanel rows={settlementRows} from={settlementFrom} to={today} />
        )}

        {tab === "room-status" && (
          <>
            <form method="get" className="flex flex-wrap items-center gap-2 rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
              <input type="hidden" name="tab" value="room-status" />
              <input type="hidden" name="ch" value={sp.ch ?? "ctrip"} />
              <input type="date" name="date" defaultValue={start} className="input h-7 w-[132px]" />
              {MATRIX_CHANNELS.slice(0, 4).map((c) => (
                <label key={c.type} className="flex items-center gap-1 text-[12px] text-[#444]">
                  <input type="checkbox" checked={Boolean(oversellMap.get(c.type))} readOnly className="h-3.5 w-3.5 accent-[#32c141]" />
                  {c.label}
                  {!channels.some((ch) => ch.channel_type === c.type) && (
                    <span className="text-[11px] text-[#bbb]">去直连</span>
                  )}
                </label>
              ))}
              <input name="q" defaultValue={q} placeholder="请输入房型名称" className="input h-7 w-[180px]" />
              <button type="submit" className="h-7 rounded-[3px] bg-[#3bd943] px-3 text-[12px] text-white hover:bg-[#33cd3b]">
                搜索
              </button>
              <Link href="/logs" className="ml-auto rounded-[3px] border border-[#ddd] px-3 py-1 text-[12px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d3a]">
                操作日志
              </Link>
            </form>

            <div className="space-y-1 rounded-[3px] border border-[#f0f0f0] bg-white px-3 py-2 text-[11.5px] leading-[19px] text-[#666]">
              <div>
                说明：
                <span className="mx-1 rounded-[2px] bg-[#f5222d] px-1 text-white">已设超售</span>
                已关联多个物理房型，可实现该房型在 OTA 销量最大化【可随时调整超售各房型和超售数量】。
                <span className="mx-1 rounded-[2px] bg-[#52c41a] px-1 text-white">未设超售</span>
                可售数量为当前物理房型的数量【设置超售房型】。
              </div>
              <div>
                <span className="mr-1 rounded-[2px] bg-[#f5222d] px-1 text-white">已开超售</span>
                说明该房型在相应的 OTA 渠道启用了超售【可随时按渠道设置各 OTA 渠道的超售数量】。
              </div>
            </div>

            <ChannelMatrix
              channels={MATRIX_CHANNELS.map((c) => ({ type: c.type, label: c.label, tone: c.tone }))}
              dates={dates}
              today={today}
              oversell={Object.fromEntries(MATRIX_CHANNELS.map((c) => [c.type, Boolean(oversellMap.get(c.type))]))}
              rows={rows.map((rt) => ({
                roomTypeId: rt.id,
                roomTypeName: rt.name,
                total: rt.total,
                cells: dates.map((d) => ({ day: d, left: leftFor(rt.id, d) })),
              }))}
              onToggleOversell={toggleOversellAction}
            />

            <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
              <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
                <span className="text-[13px] font-semibold text-[#222]">渠道对接</span>
                <ConfirmForm
                  action={autoAcceptAllAction}
                  message={`确认自动接单？当前待接单 ${pendingAutoCount} 条`}
                  detail="系统会把所有渠道状态为「待接单」的订单批量导入预订并占用房间，接单后客人会收到确认，无法一键撤回。"
                  confirmLabel="确认接单"
                  danger={false}
                >
                  <button className="rounded-[3px] bg-[#3bd943] px-2.5 py-1 text-[12px] text-white hover:bg-[#33cd3b]">
                    一键自动接单
                  </button>
                </ConfirmForm>
              </div>
              <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
                {channels.map((c) => {
                  const meta = MATRIX_CHANNELS.find((m) => m.type === c.channel_type);
                  // 该渠道最近一次同步记录（4.2 新列可能为 NULL，展示处按 0 兜底）
                  const lastSync = latestSyncByChannel.get(String(c.channel_type ?? ""));
                  /*
                   * 整改清单 P2-11：密钥只判断「配没配」，绝不回显。
                   * 加密列优先；老库只有明文列时也认（迁移会把明文加密并清空）。
                   */
                  const secretConfigured = Boolean(c.app_secret_enc || c.app_secret);
                  const sandboxOn =
                    c.sandbox === null || c.sandbox === undefined ? !secretConfigured : Number(c.sandbox) === 1;
                  const capability = channelCapability(c.channel_type ?? "", { sandbox: sandboxOn });
                  const capabilityHint = capabilityNote(c.channel_type ?? "", { sandbox: sandboxOn });
                  return (
                    <div key={c.id} className="rounded-[3px] border border-[#eee] p-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded-[2px] px-1 text-[11px] ${meta?.tone ?? "bg-[#f5f5f5] text-[#666]"}`}>
                            {meta?.label ?? c.name}
                          </span>
                          <span className="text-[12px] font-medium text-[#222]">{c.name}</span>
                        </div>
                        {/* 整改清单 P2-10：能力三态（直连 / 沙箱 / 无直连能力）必须在卡片上就能看出来，
                            否则「去哪儿推送成功」这种假成功没人能发现 */}
                        <span className={`rounded-[2px] px-1 text-[10px] ${CAPABILITY_TONE[capability]}`}>
                          {CAPABILITY_LABEL[capability]}
                        </span>
                        <span
                          className={`rounded-[2px] px-1 text-[10px] ${
                            c.enabled ? "bg-[#eef9f0] text-[#2a9d5c]" : "bg-[#f5f5f5] text-[#999]"
                          }`}
                        >
                          {c.enabled ? "已启用" : "未启用"}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-[#999]">
                        {/* 整改清单 P2-12：库里可能存 0.15 也可能存 15，原来直接 toFixed 会显示成「0.1%」 */}
                        门店 {c.store_id ?? "未配置"} · 佣金 {formatCommissionPercent(c.commission)} · 端点{" "}
                        {c.endpoint ?? "渠道默认"}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between rounded bg-[#f7f8f9] px-2 py-1">
                        <span className="text-[11px] text-[#666]">
                          自动接单{" "}
                          <b className={c.auto_import ? "text-[#2a9d5c]" : "text-[#999]"}>
                            {c.auto_import ? "已开启" : "已关闭"}
                          </b>
                        </span>
                        <form action={toggleAutoImportAction}>
                          <input type="hidden" name="type" value={c.channel_type ?? ""} />
                          <button className="text-[11px] text-[#2a9d5c] hover:underline">
                            {c.auto_import ? "关闭" : "开启"}
                          </button>
                        </form>
                      </div>

                      {/* 真实直连同步（整改清单 4.1）：三个按钮都真正调用 src/lib/channels
                          下的适配器（凭据齐全 + 关掉沙箱才走真实渠道，否则走沙箱），
                          经 invokeWithLog 统一留痕（request_no / duration_ms / success_count / fail_count）。
                          整改清单 P1-23：这里原来还有一排「演示」按钮（随机造单 / 只写日志的推送 /
                          假测试连接），已全部下线 —— 它们会往生产库写随机渠道订单。 */}
                      <div className="mt-1.5 rounded-[3px] border border-[#dff3e4] bg-[#f7fdf9] p-1.5">
                        <div className="mb-1 flex items-center justify-between gap-1 text-[10.5px]">
                          <span className="font-medium text-[#2a9d5c]">直连同步</span>
                          <span className="truncate text-[#7a8a80]">
                            {lastSync
                              ? `${
                                  SYNC_ACTION_LABEL[lastSync.action ?? ""] ?? lastSync.action ?? "-"
                                } · ${lastSync.status === "SUCCESS" ? "成功" : "失败"} · ${
                                  lastSync.created_at
                                    ? new Date(lastSync.created_at).toLocaleString("zh-CN", { hour12: false })
                                    : "-"
                                }`
                              : "暂无记录"}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          <form action={pushChannelRatesAction}>
                            <input type="hidden" name="channel_id" value={c.id} />
                            <input type="hidden" name="days" value={DAYS} />
                            <button className="w-full rounded-[3px] border border-[#b9e3c4] bg-white py-0.5 text-[11px] text-[#2a9d5c] hover:border-[#3bd943] hover:bg-[#eef9f0]">
                              推送房量
                            </button>
                          </form>
                          <form action={pullChannelOrdersAction}>
                            <input type="hidden" name="channel_id" value={c.id} />
                            <button className="w-full rounded-[3px] border border-[#b9e3c4] bg-white py-0.5 text-[11px] text-[#2a9d5c] hover:border-[#3bd943] hover:bg-[#eef9f0]">
                              拉取订单
                            </button>
                          </form>
                          <form action={testConnectionSyncAction}>
                            <input type="hidden" name="channel_id" value={c.id} />
                            <button className="w-full rounded-[3px] border border-[#b9e3c4] bg-white py-0.5 text-[11px] text-[#2a9d5c] hover:border-[#3bd943] hover:bg-[#eef9f0]">
                              测试连接
                            </button>
                          </form>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[10px] text-[#7a8a80]">
                          <span>
                            上次成功 {Number(lastSync?.success_count ?? 0)} / 失败{" "}
                            {Number(lastSync?.fail_count ?? 0)}
                            {lastSync?.duration_ms ? ` · 耗时 ${Number(lastSync.duration_ms)}ms` : ""}
                          </span>
                          {lastSync?.request_no ? (
                            <span className="font-mono text-[#a8b4ad]" title={String(lastSync.request_no)}>
                              {String(lastSync.request_no).slice(0, 8)}
                            </span>
                          ) : (
                            <span />
                          )}
                        </div>
                      </div>

                      {/* 渠道凭据与沙箱配置（整改清单 P2-11 / P2-12）
                          原来 app_secret / sandbox / endpoint / commission 四列**全项目没有写入路径**，
                          真实直连只能靠手工改库。折叠起来避免把卡片撑长：默认不展开，
                          展开后密钥只显示掩码，留空 = 本次不改。 */}
                      <details className="mt-1.5 rounded-[3px] border border-[#eee] bg-white">
                        <summary className="cursor-pointer list-none px-2 py-1 text-[11px] text-[#666] [&::-webkit-details-marker]:hidden">
                          直连配置（凭据 / 沙箱 / 端点 / 佣金）
                          <span className="ml-1 text-[10px] text-[#aaa]">
                            密钥 {secretConfigured ? "已配置" : "未配置"} · 沙箱 {sandboxOn ? "开" : "关"}
                          </span>
                        </summary>
                        {capabilityHint && (
                          <div className="border-t border-[#f5f5f5] px-2 py-1 text-[10px] text-[#b8860b]">
                            {capabilityHint}
                          </div>
                        )}
                        <form action={saveChannelAction} className="space-y-1 border-t border-[#f5f5f5] px-2 py-1.5">
                          <input type="hidden" name="id" value={c.id} />
                          <label className="block text-[10px] text-[#999]">
                            门店 / 酒店 id
                            <input
                              name="store_id"
                              defaultValue={c.store_id ?? ""}
                              placeholder="渠道后台给的门店 id"
                              className="input mt-0.5 h-6 w-full text-[11px]"
                            />
                          </label>
                          <label className="block text-[10px] text-[#999]">
                            appKey
                            <input
                              name="app_key"
                              defaultValue={c.app_key ?? ""}
                              className="input mt-0.5 h-6 w-full text-[11px]"
                            />
                          </label>
                          <label className="block text-[10px] text-[#999]">
                            appSecret（留空 / 掩码 = 不改；保存后加密入库）
                            <input
                              name="app_secret"
                              type="password"
                              autoComplete="new-password"
                              placeholder={secretConfigured ? "••••••••" : "未配置"}
                              className="input mt-0.5 h-6 w-full text-[11px]"
                            />
                          </label>
                          <label className="block text-[10px] text-[#999]">
                            自定义端点（渠道测试网关 / 私有化部署，留空 = 渠道默认）
                            <input
                              name="endpoint"
                              defaultValue={c.endpoint ?? ""}
                              placeholder="https://open.ctrip.com"
                              className="input mt-0.5 h-6 w-full text-[11px]"
                            />
                          </label>
                          <label className="block text-[10px] text-[#999]">
                            佣金率 %（0~100 的百分数或 0~1 的小数）
                            <input
                              name="commission"
                              defaultValue={
                                Number(c.commission ?? 0) > 1
                                  ? String(Number(c.commission))
                                  : String(Math.round(Number(c.commission ?? 0) * 10000) / 100)
                              }
                              className="input mt-0.5 h-6 w-full text-[11px]"
                            />
                          </label>
                          <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[10.5px] text-[#666]">
                            <label className="flex items-center gap-1">
                              <input type="checkbox" name="enabled" defaultChecked={Boolean(c.enabled)} className="h-3 w-3" />
                              启用
                            </label>
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                name="auto_import"
                                defaultChecked={Boolean(c.auto_import)}
                                className="h-3 w-3"
                              />
                              自动接单
                            </label>
                            <label className="flex items-center gap-1">
                              <input type="checkbox" name="sandbox" defaultChecked={sandboxOn} className="h-3 w-3" />
                              沙箱（不发真实请求）
                            </label>
                            <button className="ml-auto rounded-[3px] bg-[#3bd943] px-2 py-0.5 text-[11px] text-white hover:bg-[#33cd3b]">
                              保存
                            </button>
                          </div>
                        </form>

                        {/* 价格方案（P2-10 问题 3）：没有这张表时推价只能按基准价 + 日志里写一句回退 */}
                        <div className="border-t border-[#f5f5f5] px-2 py-1.5">
                          <div className="text-[10px] text-[#999]">
                            渠道价格方案（系数 1.15 = 加价 15%；留空房型 = 本渠道通用）
                          </div>
                          {(ratePlansByChannel.get(String(c.channel_type ?? "")) ?? []).map((plan) => (
                            <div key={plan.id} className="mt-1 flex items-center justify-between gap-1 text-[10.5px] text-[#666]">
                              <span className="truncate">
                                {plan.rate_code} × {Number(plan.factor ?? 1)}
                                {plan.room_type_id ? `（房型 #${plan.room_type_id}）` : "（通用）"}
                              </span>
                              <form action={deleteChannelRatePlanAction}>
                                <input type="hidden" name="id" value={plan.id} />
                                <button className="text-[10px] text-[#d93026] hover:underline">删除</button>
                              </form>
                            </div>
                          ))}
                          <form action={saveChannelRatePlanAction} className="mt-1 grid grid-cols-[1fr_52px_auto] items-end gap-1">
                            <input type="hidden" name="channel_type" value={c.channel_type ?? ""} />
                            <label className="block text-[10px] text-[#999]">
                              方案编码
                              <input name="rate_code" placeholder="如 PREPAY" className="input mt-0.5 h-6 w-full text-[11px]" />
                            </label>
                            <label className="block text-[10px] text-[#999]">
                              系数
                              <input name="factor" defaultValue="1" className="input mt-0.5 h-6 w-full text-[11px]" />
                            </label>
                            <button className="h-6 rounded-[3px] border border-[#b9e3c4] px-1.5 text-[10.5px] text-[#2a9d5c] hover:bg-[#eef9f0]">
                              添加
                            </button>
                          </form>
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 最近同步记录（整改报告第 8 节）：失败必须给出错误码和重试次数，并能在原地重试。
                没有这块的话，失败只体现在 homepage 的一条告警里，运维点进来依然不知道是哪一次、
                什么原因、重试过没有。 */}
            <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
              <div className="flex flex-wrap items-center justify-between gap-1 border-b border-[#f0f0f0] px-3 py-2">
                <span className="text-[13px] font-semibold text-[#222]">最近同步记录</span>
                <span className="text-[11px] text-[#999]">近 24 小时有失败会进首页「渠道同步异常」告警</span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-[#fafafa] text-[11.5px] text-[#666]">
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">时间</th>
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">渠道</th>
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">动作</th>
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">状态</th>
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">错误码</th>
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">重试次数</th>
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">说明</th>
                    <th className="border-b border-[#f0f0f0] px-3 py-2 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {syncLogs.map((r) => {
                    const succeeded = r.status === "SUCCESS";
                    const retrying = r.status === "RETRYING";
                    const label = MATRIX_CHANNELS.find((m) => m.type === r.channel_type)?.label ?? r.channel_type ?? "-";
                    // 三色固定：成功绿、失败红、重试中黄，运维扫一眼就能定位要处理的行
                    const tone = succeeded
                      ? "bg-[#eef9f0] text-[#2a9d5c]"
                      : retrying
                        ? "bg-[#fffbe6] text-[#b8860b]"
                        : "bg-[#fdecea] text-[#d93026]";
                    return (
                      <tr key={r.id} className="border-b border-[#f5f5f5] text-[11.5px] text-[#444]">
                        <td className="px-3 py-1.5 text-[#888]">
                          {r.created_at ? new Date(r.created_at).toLocaleString("zh-CN", { hour12: false }) : "-"}
                        </td>
                        <td className="px-3 py-1.5">{label}</td>
                        <td className="px-3 py-1.5 text-[#666]">{r.action ?? "-"}</td>
                        <td className="px-3 py-1.5">
                          <span className={`rounded-[2px] px-1 ${tone}`}>
                            {succeeded ? "成功" : retrying ? "重试中" : "失败"}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-[#666]">{r.error_code ?? "-"}</td>
                        <td className="px-3 py-1.5 text-[#666]">{Number(r.retry_count ?? 0)}</td>
                        <td className="max-w-[420px] px-3 py-1.5 text-[#666]">
                          <span className="line-clamp-2">{r.message ?? "-"}</span>
                        </td>
                        <td className="px-3 py-1.5">
                          {/* 只给失败行重试入口：成功行没意义，重试中再点还会把次数刷虚。
                              整改清单 P1-20：这个按钮现在是**真的重调上游**（按原 action 重放），
                              不再只把日志改成 RETRYING 然后永久卡住。 */}
                          {!succeeded && !retrying && (
                            <form action={retryChannelSyncLogAction}>
                              <input type="hidden" name="log_id" value={r.id} />
                              <button className="rounded-[3px] border border-[#d8dde3] px-2 py-0.5 text-[11px] text-[#555] hover:border-[#d93026] hover:text-[#d93026]">
                                重试
                              </button>
                            </form>
                          )}
                          {(succeeded || retrying) && <span className="text-[11px] text-[#ccc]">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {syncLogs.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-[11.5px] text-[#999]">
                        暂无同步记录
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
              {/* 批量重试（P1-20 的消费者）+ 库存待同步队列（P2-13 的消费入口） */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#f0f0f0] px-3 py-2">
                <div className="text-[11px] text-[#666]">
                  库存待同步队列 <b className={stockPending > 0 ? "text-[#d93026]" : "text-[#2a9d5c]"}>{stockPending}</b> 条
                  {deadLetterCount > 0 && <span className="ml-2 text-[#d93026]">死信 {deadLetterCount} 条待人工处理</span>}
                  {stockQueue.length > 0 && (
                    <span className="ml-2 text-[#999]">
                      最近：{stockQueue[0]?.reason ?? "-"}（{Number(stockQueue[0]?.attempts ?? 0)} 次尝试）
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <form action={drainStockQueueAction}>
                    <button className="rounded-[3px] border border-[#b9e3c4] bg-white px-2.5 py-1 text-[11.5px] text-[#2a9d5c] hover:border-[#3bd943] hover:bg-[#eef9f0]">
                      立即处理待同步队列
                    </button>
                  </form>
                  <form action={retryDueSyncLogsAction}>
                    <button className="rounded-[3px] border border-[#d8dde3] px-2.5 py-1 text-[11.5px] text-[#555] hover:border-[#d93026] hover:text-[#d93026]">
                      重试全部到期失败
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
