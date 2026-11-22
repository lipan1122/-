import Link from "next/link";
import { ArchiveSidebar } from "@/components/ArchiveSidebar";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { todayStr } from "@/lib/utils";
import {
  createTemplateAction,
  ensureSmsSeed,
  saveSmsSettingsAction,
  sendSmsAction,
  toggleTemplateAction,
  updateTemplateAction,
} from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type TemplateRow = {
  id: number;
  code: string;
  name: string;
  content: string;
  scene: string;
  status: string;
  created_at: string | null;
};

type SendRow = {
  id: number;
  mobile: string;
  guest_name: string | null;
  content: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  template_name: string | null;
};

type StayRow = {
  id: number;
  room_no: string;
  guest_name: string | null;
  mobile: string | null;
  check_in_time: string | null;
  expect_check_out: string | null;
};

type SendStats = {
  total: number;
  sent: number;
  month_total: number;
  month_sent: number;
  month_failed: number;
};

type SendCounts = { total: number; sent: number; failed: number };

type SettingRow = { key: string; value: string | null };

/** 顶部 tab：顺序即界面顺序 */
const TABS = [
  { key: "templates", label: "模板管理" },
  { key: "send", label: "发送短信" },
  { key: "records", label: "发送记录" },
  { key: "settings", label: "短信设置" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const SCENES = [
  { key: "CHECKIN", label: "入住", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { key: "CHECKOUT", label: "退房", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  { key: "BIRTHDAY", label: "生日", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  { key: "MARKETING", label: "营销", cls: "bg-violet-50 text-violet-700 border-violet-200" },
];

const SCENE_LABEL: Record<string, string> = {
  CHECKIN: "入住",
  CHECKOUT: "退房",
  BIRTHDAY: "生日",
  MARKETING: "营销",
};

const SCENE_CLS: Record<string, string> = {
  CHECKIN: "bg-emerald-50 text-emerald-700 border-emerald-200",
  CHECKOUT: "bg-blue-50 text-blue-700 border-blue-200",
  BIRTHDAY: "bg-amber-50 text-amber-700 border-amber-200",
  MARKETING: "bg-violet-50 text-violet-700 border-violet-200",
};

const PROVIDERS = [
  { key: "aliyun", label: "阿里云短信", hint: "三网合一通道，到达率约 99%" },
  { key: "tencent", label: "腾讯云短信", hint: "支持验证码与营销短信" },
  { key: "yuntongxun", label: "容联云通讯", hint: "老牌网关，支持语音短信" },
];

const PLACEHOLDERS = ["{客人姓名}", "{房号}", "{入住日期}"];

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function isTab(value: string): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return todayStr();
  return iso.slice(0, 10);
}

/** 占位符渲染（与 actions.ts 内保持一致，仅用于页面预览） */
function fillTemplate(tpl: string, guestName: string, roomNo: string, checkIn: string): string {
  return tpl
    .split("{客人姓名}")
    .join(guestName)
    .split("{房号}")
    .join(roomNo)
    .split("{入住日期}")
    .join(checkIn);
}

export default async function SmsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  await ensureSmsSeed(hotelId);

  const activeTab: TabKey = isTab(first(sp.tab)) ? (first(sp.tab) as TabKey) : "templates";
  const msg = first(sp.msg);
  const err = first(sp.err);

  const templates = all<TemplateRow>(
    `SELECT id, code, name, content, scene, status, created_at
     FROM sms_templates WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const stays = all<StayRow>(
    `SELECT s.id, s.guest_name, s.mobile, s.check_in_time, s.expect_check_out, r.room_no
     FROM stays s JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     ORDER BY r.sort, r.room_no`,
    [hotelId]
  );

  const settings = all<SettingRow>(`SELECT key, value FROM settings WHERE hotel_id = ?`, [hotelId]);
  const config = new Map<string, string>(settings.map((s) => [s.key, s.value ?? ""]));

  const provider = config.get("sms_provider") || "aliyun";
  const sign = config.get("sms_sign") || "";
  const providerLabel = PROVIDERS.find((p) => p.key === provider)?.label ?? "阿里云短信";

  const month = todayStr().slice(0, 7);
  const stats =
    get<SendStats>(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN substr(sent_at, 1, 7) = ? THEN 1 ELSE 0 END), 0) AS month_total,
         COALESCE(SUM(CASE WHEN substr(sent_at, 1, 7) = ? AND status = 'SENT' THEN 1 ELSE 0 END), 0) AS month_sent,
         COALESCE(SUM(CASE WHEN substr(sent_at, 1, 7) = ? AND status = 'FAILED' THEN 1 ELSE 0 END), 0) AS month_failed
       FROM sms_sends WHERE hotel_id = ?`,
      [month, month, month, hotelId]
    ) ?? { total: 0, sent: 0, month_total: 0, month_sent: 0, month_failed: 0 };

  const counts =
    get<SendCounts>(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed
       FROM sms_sends WHERE hotel_id = ?`,
      [hotelId]
    ) ?? { total: 0, sent: 0, failed: 0 };

  // 剩余条数 = 模拟余额基数 - 已发送成功条数
  const balanceBase = Number(config.get("sms_balance") ?? "5000") || 5000;
  const remaining = Math.max(0, balanceBase - (stats.sent ?? 0));
  const usedRatio = Math.min(100, Math.round(((stats.sent ?? 0) / balanceBase) * 100));
  const successRate = stats.month_total > 0 ? ((stats.month_sent ?? 0) / stats.month_total) * 100 : 0;
  const successRateText = stats.month_total > 0 ? `${successRate.toFixed(1)}%` : "—";

  // 模板编辑态
  const editId = Number(first(sp.edit) || 0);
  const editing = editId ? templates.find((t) => t.id === editId) ?? null : null;

  // 发送 tab：模板选择 + 预览
  const sendable = templates.filter((t) => t.status === "ENABLED");
  const tplParam = Number(first(sp.tpl) || 0);
  const selectedTpl = sendable.find((t) => t.id === tplParam) ?? sendable[0] ?? null;
  const sample = stays[0] ?? null;
  const sampleName = sample?.guest_name ?? "王小明";
  const sampleRoom = sample?.room_no ?? "301";
  const sampleCheckIn = fmtDate(sample?.check_in_time ?? null);
  const previewText = selectedTpl
    ? fillTemplate(selectedTpl.content, sampleName, sampleRoom, sampleCheckIn)
    : "";

  // 发送记录 tab：状态筛选
  const statusParam = first(sp.status);
  const statusFilter = statusParam === "SENT" || statusParam === "FAILED" ? statusParam : "";
  const records = all<SendRow>(
    `SELECT s.id, s.mobile, s.guest_name, s.content, s.status, s.error, s.sent_at,
            t.name AS template_name
     FROM sms_sends s LEFT JOIN sms_templates t ON t.id = s.template_id
     WHERE s.hotel_id = ? AND (? = '' OR s.status = ?)
     ORDER BY s.sent_at DESC, s.id DESC
     LIMIT 200`,
    [hotelId, statusFilter, statusFilter]
  );

  const tabHref = (tab: TabKey) => `/sms?tab=${tab}`;
  const currentHref = tabHref(activeTab);

  return (
    <div className="flex">
      <ArchiveSidebar
        active={
          activeTab === "templates"
            ? "自动短信服务"
            : activeTab === "send"
              ? "手动短信服务"
              : activeTab === "records"
                ? "短信发送记录"
                : "短信充值记录"
        }
      />
      <div className="min-w-0 flex-1 space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[15px] font-semibold text-[#222]">短信服务</h1>
          <p className="mt-0.5 text-[12px] text-[#888]">
            智能短信 · 自动短信 · 短信模板 · 发送记录 · 服务商：{providerLabel}
          </p>
        </div>
        <span className="rounded-[3px] border border-[#eee] bg-white px-2 py-[3px] text-[11px] text-[#888]">
          签名：{sign || "未设置"}
        </span>
      </div>

      {/* 统计 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card px-4 py-3">
          <div className="text-[11px] text-[#999]">本月发送量（{month}）</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-[#222]">
            {stats.month_total}
            <span className="ml-1 text-[12px] font-normal text-[#999]">条</span>
          </div>
          <div className="mt-0.5 text-[11px] text-[#999]">
            成功 {stats.month_sent} · 失败 {stats.month_failed}
          </div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-[11px] text-[#999]">本月成功率</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-[#222]">
            {successRateText}
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#f2f2f2]">
            <span
              className="block h-full rounded-full bg-emerald-500"
              style={{ width: `${stats.month_total > 0 ? Math.round(successRate) : 0}%` }}
            />
          </div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-[11px] text-[#999]">剩余条数（模拟余额 {balanceBase}）</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-[#222]">
            {remaining}
            <span className="ml-1 text-[12px] font-normal text-[#999]">条</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#f2f2f2]">
              <span className="block h-full rounded-full bg-brand-500" style={{ width: `${usedRatio}%` }} />
            </div>
            <span className="text-[11px] text-[#999]">已发 {stats.sent}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <nav className="sticky top-0 z-20 flex flex-wrap items-center gap-x-0.5 rounded-[4px] border border-[#eee] bg-white px-1.5 pt-1 pb-0">
        {TABS.map((tab) => {
          const active = tab.key === activeTab;
          const count =
            tab.key === "templates"
              ? templates.length
              : tab.key === "records"
                ? counts.total
                : tab.key === "send"
                  ? sendable.length
                  : undefined;
          return (
            <Link
              key={tab.key}
              href={tabHref(tab.key)}
              className={`flex items-center border-b-2 px-2 pt-1 pb-[6px] text-[13px] transition-colors ${
                active ? "border-[#32c141] font-medium text-[#222]" : "border-transparent text-[#888] hover:text-[#222]"
              }`}
            >
              {tab.label}
              {typeof count === "number" && (
                <span
                  className={`ml-1 rounded-[2px] px-1 text-[11px] leading-[15px] tabular-nums ${
                    active ? "bg-[#eef9ef] text-[#2a9d3a]" : "bg-[#f2f2f2] text-[#999]"
                  }`}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
        <span className="ml-auto pr-1 pb-[6px] text-[11px] text-[#bbb]">共 {TABS.length} 个页签</span>
      </nav>

      {msg && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">
          <span>{msg}</span>
          <Link href={currentHref} className="shrink-0 text-[11px] text-[#999] hover:text-[#222]">
            关闭
          </Link>
        </div>
      )}
      {err && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-rose-500 px-4 py-2.5 text-[12px] text-rose-600">
          <span>{err}</span>
          <Link href={currentHref} className="shrink-0 text-[11px] text-[#999] hover:text-[#222]">
            关闭
          </Link>
        </div>
      )}

      {/* Tab 1 模板管理 */}
      {activeTab === "templates" && (
        <>
          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <div>
                <div className="text-[13px] font-semibold text-[#222]">
                  {editing ? `编辑模板：${editing.name}` : "新增短信模板"}
                </div>
                <div className="mt-0.5 text-[11px] text-[#999]">
                  可用占位符：
                  {PLACEHOLDERS.map((p) => (
                    <code key={p} className="mx-0.5 rounded bg-[#f5f5f5] px-1 py-[1px] text-[11px] text-[#555]">
                      {p}
                    </code>
                  ))}
                  ，发送时自动替换为客人信息
                </div>
              </div>
              {editing && (
                <Link href={tabHref("templates")} className="btn-default h-[26px] px-2 text-[12px]">
                  取消编辑
                </Link>
              )}
            </div>
            <form
              key={editing ? `edit-${editing.id}` : "create"}
              action={editing ? updateTemplateAction : createTemplateAction}
              className="grid gap-3 px-4 py-3 md:grid-cols-4"
            >
              {editing && <input type="hidden" name="id" value={editing.id} />}
              <div>
                <label className="label">模板代码 *</label>
                <input
                  name="code"
                  required
                  maxLength={32}
                  defaultValue={editing?.code ?? ""}
                  placeholder="CHECKIN_WELCOME"
                  autoComplete="off"
                  className="input font-mono uppercase"
                />
              </div>
              <div>
                <label className="label">模板名称 *</label>
                <input
                  name="name"
                  required
                  maxLength={20}
                  defaultValue={editing?.name ?? ""}
                  placeholder="入住欢迎"
                  autoComplete="off"
                  className="input"
                />
              </div>
              <div>
                <label className="label">场景</label>
                <select name="scene" defaultValue={editing?.scene ?? "CHECKIN"} className="input">
                  {SCENES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <button className="btn-primary h-[30px]">{editing ? "保存修改" : "新增模板"}</button>
              </div>
              <div className="md:col-span-4">
                <label className="label">模板内容 *</label>
                <textarea
                  name="content"
                  required
                  rows={2}
                  maxLength={200}
                  defaultValue={editing?.content ?? ""}
                  placeholder="尊敬的{客人姓名}，欢迎入住本酒店！您的房间为{房号}，入住日期{入住日期}。"
                  className="input leading-[1.8]"
                />
              </div>
            </form>
          </div>

          <div className="card overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <div className="text-[13px] font-semibold text-[#222]">短信模板</div>
              <span className="text-[11px] text-[#999]">
                共 {templates.length} 个模板 · 启用 {sendable.length} 个
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">代码</th>
                    <th className="th">名称</th>
                    <th className="th">场景</th>
                    <th className="th">内容预览</th>
                    <th className="th">状态</th>
                    <th className="th text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.length === 0 && (
                    <tr>
                      <td className="td text-center text-[12px] text-[#999]" colSpan={6}>
                        暂无短信模板，请在上方新增
                      </td>
                    </tr>
                  )}
                  {templates.map((t) => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="td font-mono text-[12px] text-[#666]">{t.code}</td>
                      <td className="td text-[12px] font-medium text-[#222]">{t.name}</td>
                      <td className="td">
                        <span
                          className={`rounded-[3px] border px-1.5 py-[1px] text-[11px] ${
                            SCENE_CLS[t.scene] ?? "border-gray-200 bg-gray-100 text-gray-500"
                          }`}
                        >
                          {SCENE_LABEL[t.scene] ?? t.scene}
                        </span>
                      </td>
                      <td className="td max-w-[380px] truncate text-[12px] text-[#777]" title={t.content}>
                        {t.content}
                      </td>
                      <td className="td">
                        <span
                          className={`rounded-[3px] border px-1.5 py-[1px] text-[11px] ${
                            t.status === "ENABLED"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-gray-200 bg-gray-100 text-gray-500"
                          }`}
                        >
                          {t.status === "ENABLED" ? "启用" : "停用"}
                        </span>
                      </td>
                      <td className="td">
                        <div className="flex items-center justify-end gap-3">
                          <Link
                            href={`/sms?tab=templates&edit=${t.id}`}
                            className="text-[12px] text-brand-600 hover:underline"
                          >
                            编辑
                          </Link>
                          <form action={toggleTemplateAction}>
                            <input type="hidden" name="id" value={t.id} />
                            <button
                              className={`text-[12px] ${
                                t.status === "ENABLED"
                                  ? "text-[#999] hover:text-rose-600"
                                  : "text-emerald-600 hover:text-emerald-700"
                              }`}
                            >
                              {t.status === "ENABLED" ? "停用" : "启用"}
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Tab 2 发送短信 */}
      {activeTab === "send" && (
        <>
          {sendable.length === 0 ? (
            <div className="card px-4 py-[36px] text-center text-[12px] text-[#999]">
              暂无可发送的模板，请先到「模板管理」新增或启用模板
              <div className="mt-2">
                <Link href={tabHref("templates")} className="btn-default h-[26px] px-2 text-[12px]">
                  去模板管理
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="card overflow-hidden">
                <div className="border-b border-gray-100 px-4 py-2.5">
                  <div className="text-[13px] font-semibold text-[#222]">1. 选择模板</div>
                  <div className="mt-0.5 text-[11px] text-[#999]">点击模板即切换下方内容预览</div>
                </div>
                <div className="flex flex-wrap gap-2 px-4 py-3">
                  {sendable.map((t) => {
                    const active = selectedTpl?.id === t.id;
                    return (
                      <Link
                        key={t.id}
                        href={`/sms?tab=send&tpl=${t.id}`}
                        className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                          active
                            ? "border-brand-400 bg-brand-50 font-medium text-brand-700"
                            : "border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                        }`}
                      >
                        {t.name}
                        <span className="ml-1 text-[11px] text-[#999]">{SCENE_LABEL[t.scene] ?? t.scene}</span>
                      </Link>
                    );
                  })}
                </div>
                {selectedTpl && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#999]">
                      <span>
                        内容预览（示例：{sampleName} · {sampleRoom} 房 · {sampleCheckIn}）
                      </span>
                      <span>
                        模板：{selectedTpl.name}（{selectedTpl.code}）
                      </span>
                    </div>
                    <div className="mt-1.5 rounded-md bg-[#f7f8fa] px-3 py-2 text-[12px] leading-[1.9] text-[#444]">
                      {previewText}
                    </div>
                    <div className="mt-1.5 text-[11px] text-[#bbb]">
                      模板原文：{selectedTpl.content}
                    </div>
                  </div>
                )}
              </div>

              <div className="card overflow-hidden">
                <div className="border-b border-gray-100 px-4 py-2.5">
                  <div className="text-[13px] font-semibold text-[#222]">2. 选择收件人并发送</div>
                  <div className="mt-0.5 text-[11px] text-[#999]">
                    下拉选择在住客人（stays INHOUSE，共 {stays.length} 位），或直接手填手机号
                  </div>
                </div>
                <form action={sendSmsAction} className="grid gap-3 px-4 py-3 md:grid-cols-2">
                  <input type="hidden" name="template_id" value={selectedTpl?.id ?? 0} />
                  <div>
                    <label className="label">在住客人</label>
                    <select name="stay_id" defaultValue="" className="input">
                      <option value="">— 不选，手填手机号 —</option>
                      {stays.map((s) => (
                        <option key={s.id} value={s.id}>
                          {`${s.room_no} 房 · ${s.guest_name ?? "客人"} · ${s.mobile || "无手机号"}`}
                        </option>
                      ))}
                    </select>
                    {stays.length === 0 && (
                      <p className="mt-1 text-[11px] text-[#bbb]">当前没有在住客人，请使用手填手机号</p>
                    )}
                  </div>
                  <div>
                    <label className="label">手填手机号（填写后优先使用）</label>
                    <input
                      name="mobile"
                      maxLength={11}
                      inputMode="numeric"
                      placeholder="11 位手机号，如 13800138000"
                      autoComplete="off"
                      className="input tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="label">客人姓名（手填手机号时选填）</label>
                    <input
                      name="guest_name"
                      maxLength={20}
                      placeholder="默认记为「客人」"
                      autoComplete="off"
                      className="input"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <button className="btn-primary h-[30px]">发送短信</button>
                    <span className="pb-1 text-[11px] text-[#bbb]">按 95% 成功率模拟网关回执</span>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-[11px] leading-relaxed text-[#999]">
                      发送时会把
                      {PLACEHOLDERS.map((p) => (
                        <code key={p} className="mx-0.5 rounded bg-[#f5f5f5] px-1 py-[1px] text-[11px] text-[#555]">
                          {p}
                        </code>
                      ))}
                      替换为所选客人的姓名、房号与入住日期，结果写入发送记录。
                    </p>
                  </div>
                </form>
              </div>
            </>
          )}
        </>
      )}

      {/* Tab 3 发送记录 */}
      {activeTab === "records" && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
            <div>
              <div className="text-[13px] font-semibold text-[#222]">发送记录</div>
              <div className="mt-0.5 text-[11px] text-[#999]">按发送时间倒序，最多显示最近 200 条</div>
            </div>
            <div className="flex items-center gap-1">
              {[
                { key: "", label: "全部", count: counts.total },
                { key: "SENT", label: "已发送", count: counts.sent },
                { key: "FAILED", label: "失败", count: counts.failed },
              ].map((f) => {
                const active = statusFilter === f.key;
                return (
                  <Link
                    key={f.key || "all"}
                    href={f.key ? `/sms?tab=records&status=${f.key}` : `/sms?tab=records`}
                    className={`rounded-[3px] border px-2 py-[2px] text-[11px] transition-colors ${
                      active
                        ? "border-brand-300 bg-brand-50 font-medium text-brand-700"
                        : "border-gray-200 bg-white text-gray-500 hover:border-brand-300 hover:text-brand-600"
                    }`}
                  >
                    {f.label}
                    <span className="ml-1 tabular-nums text-[#999]">{f.count}</span>
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">时间</th>
                  <th className="th">手机号</th>
                  <th className="th">客人</th>
                  <th className="th">模板</th>
                  <th className="th">内容</th>
                  <th className="th">状态</th>
                  <th className="th">失败原因</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && (
                  <tr>
                    <td className="td text-center text-[12px] text-[#999]" colSpan={7}>
                      {statusFilter ? "该状态下暂无发送记录" : "暂无发送记录，去「发送短信」发一条试试"}
                    </td>
                  </tr>
                )}
                {records.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="td tabular-nums text-[12px] text-[#666]">{fmtTime(r.sent_at)}</td>
                    <td className="td tabular-nums text-[12px] text-[#222]">{r.mobile}</td>
                    <td className="td text-[12px] text-[#444]">{r.guest_name ?? "—"}</td>
                    <td className="td text-[12px] text-[#444]">{r.template_name ?? "—"}</td>
                    <td className="td max-w-[320px] truncate text-[12px] text-[#777]" title={r.content}>
                      {r.content}
                    </td>
                    <td className="td">
                      <span
                        className={`rounded-[3px] border px-1.5 py-[1px] text-[11px] ${
                          r.status === "SENT"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-rose-200 bg-rose-50 text-rose-600"
                        }`}
                      >
                        {r.status === "SENT" ? "已发送" : "发送失败"}
                      </span>
                    </td>
                    <td className="td max-w-[220px] truncate text-[12px] text-[#999]">{r.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 4 短信设置 */}
      {activeTab === "settings" && (
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="card overflow-hidden lg:col-span-2">
            <div className="border-b border-gray-100 px-4 py-2.5">
              <div className="text-[13px] font-semibold text-[#222]">短信设置</div>
              <div className="mt-0.5 text-[11px] text-[#999]">
                配置保存在系统参数（settings）中，key 为 sms_provider / sms_sign / sms_balance
              </div>
            </div>
            <form action={saveSmsSettingsAction} className="grid gap-3 px-4 py-3 md:grid-cols-2">
              <div>
                <label className="label">短信服务商</label>
                <select name="sms_provider" defaultValue={provider} className="input">
                  {PROVIDERS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-[#bbb]">
                  {PROVIDERS.find((p) => p.key === provider)?.hint ?? ""}
                </p>
              </div>
              <div>
                <label className="label">短信签名</label>
                <input
                  name="sms_sign"
                  defaultValue={sign}
                  maxLength={12}
                  placeholder="如：去呼呼酒店"
                  autoComplete="off"
                  className="input"
                />
                <p className="mt-1 text-[11px] text-[#bbb]">签名 2-12 个字，需与服务商后台备案的一致</p>
              </div>
              <div className="md:col-span-2">
                <label className="label">剩余条数（模拟余额）</label>
                <div className="flex items-center gap-3 rounded-md border border-gray-200 bg-[#fafafa] px-3 py-2">
                  <span className="text-[16px] font-semibold tabular-nums text-[#222]">{remaining} 条</span>
                  <span className="text-[11px] text-[#999]">
                    额度 {balanceBase} 条 · 已发送 {stats.sent} 条 · 已使用 {usedRatio}%
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[#bbb]">
                  余额为演示用模拟值，送达统计按发送记录实时计算
                </p>
              </div>
              <div className="flex items-end gap-2 md:col-span-2">
                <button className="btn-primary h-[30px]">保存设置</button>
                <span className="pb-1 text-[11px] text-[#bbb]">当前服务商：{providerLabel}</span>
              </div>
            </form>
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-[#222]">
              接入说明
            </div>
            <ul className="space-y-1.5 px-4 py-3 text-[11px] leading-relaxed text-[#777]">
              <li>· 模板场景：CHECKIN 入住 / CHECKOUT 退房 / BIRTHDAY 生日 / MARKETING 营销。</li>
              <li>· 占位符 {"{客人姓名}"}、{"{房号}"}、{"{入住日期}"} 会在发送时按所选客人替换。</li>
              <li>· 发送记录按 95% 成功率模拟网关回执，失败原因随记录保存。</li>
              <li>· 剩余条数为模拟余额（默认 5000），按已发送成功条数扣减。</li>
              <li>· 模板表 sms_templates、记录表 sms_sends 首次访问自动创建。</li>
            </ul>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
