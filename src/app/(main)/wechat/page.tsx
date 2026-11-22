import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { clearWechatConfigAction, saveWechatConfigAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type SettingRow = { key: string; value: string | null };

/** 小程序码占位图形：11 × 11 棋盘，按坐标生成稳定花纹（不依赖随机数，服务端渲染一致） */
const QR_SIZE = 11;
const QR_CELLS: boolean[] = Array.from({ length: QR_SIZE * QR_SIZE }, (_, index) => {
  const row = Math.floor(index / QR_SIZE);
  const col = index % QR_SIZE;
  const isFinder =
    (row < 3 && col < 3) || (row < 3 && col > QR_SIZE - 4) || (row > QR_SIZE - 4 && col < 3);
  if (isFinder) return true;
  return (row * 3 + col * 5 + row * col) % 7 < 3;
});

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function WechatPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;

  const ok = first(sp.msg);
  const err = first(sp.err);

  const settings = all<SettingRow>(`SELECT key, value FROM settings WHERE hotel_id = ?`, [user.hotelId]);
  const config = new Map<string, string>(settings.map((s) => [s.key, s.value ?? ""]));

  const appId = config.get("wechat_appid") ?? "";
  const secret = config.get("wechat_secret") ?? "";
  const mchId = config.get("wechat_mch_id") ?? "";
  const templateId = config.get("wechat_template_id") ?? "";
  const enabled = config.get("wechat_enabled") === "1";

  const statusItems: { label: string; configured: boolean; hint: string }[] = [
    { label: "AppID", configured: Boolean(appId), hint: appId || "未配置" },
    { label: "AppSecret", configured: Boolean(secret), hint: secret ? "已配置（不回显明文）" : "未配置" },
    { label: "微信商户号", configured: Boolean(mchId), hint: mchId || "未配置" },
    { label: "模板消息 ID", configured: Boolean(templateId), hint: templateId || "未配置" },
  ];
  const configuredCount = statusItems.filter((item) => item.configured).length;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">微酒店</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            微信小程序预订入口配置 · 共 {configuredCount} / 4 项已填写
          </p>
        </div>
        <span
          className={`rounded-md border px-2.5 py-1 text-[11px] ${
            enabled
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-gray-200 bg-white text-gray-500"
          }`}
        >
          {enabled ? "微酒店已启用" : "微酒店未启用"}
        </span>
      </div>

      {ok && <div className="card border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">{ok}</div>}
      {err && <div className="card border-l-4 border-l-rose-500 px-4 py-2.5 text-[12px] text-rose-600">{err}</div>}

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="border-b border-gray-100 px-4 py-2.5">
            <div className="text-[13px] font-semibold text-gray-800">小程序配置</div>
            <div className="mt-0.5 text-[11px] text-gray-400">
              配置保存在系统参数（settings）中，AppSecret 不回显，留空表示保留原值
            </div>
          </div>
          <form action={saveWechatConfigAction} className="grid gap-3 px-4 py-3 md:grid-cols-2">
            <div>
              <label className="label">AppID</label>
              <input
                name="wechat_appid"
                defaultValue={appId}
                maxLength={64}
                placeholder="wx 开头的小程序 AppID"
                autoComplete="off"
                className="input"
              />
            </div>
            <div>
              <label className="label">AppSecret</label>
              <input
                name="wechat_secret"
                type="password"
                maxLength={64}
                placeholder={secret ? "已配置，留空不修改" : "小程序 AppSecret"}
                autoComplete="new-password"
                className="input"
              />
            </div>
            <div>
              <label className="label">微信商户号（mch_id）</label>
              <input
                name="wechat_mch_id"
                defaultValue={mchId}
                maxLength={20}
                inputMode="numeric"
                placeholder="8-10 位数字商户号"
                autoComplete="off"
                className="input tabular-nums"
              />
            </div>
            <div>
              <label className="label">模板消息 ID</label>
              <input
                name="wechat_template_id"
                defaultValue={templateId}
                maxLength={64}
                placeholder="订单通知模板 ID"
                autoComplete="off"
                className="input"
              />
            </div>
            <div>
              <label className="label">启用开关</label>
              <select name="wechat_enabled" defaultValue={enabled ? "1" : "0"} className="input">
                <option value="1">启用</option>
                <option value="0">停用</option>
              </select>
            </div>
            <div className="flex items-end">
              <p className="text-[11px] leading-relaxed text-gray-400">
                启用前必须先填写 AppID、AppSecret 与商户号，否则保存会被拒绝
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <button className="btn-primary">保存配置</button>
              <button formAction={clearWechatConfigAction} className="btn-danger">
                清空配置
              </button>
              <span className="text-[11px] text-gray-400">清空会同时把启用状态置为停用，可重新填写换绑</span>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="border-b border-gray-100 px-4 py-2.5">
            <div className="text-[13px] font-semibold text-gray-800">小程序码</div>
            <div className="mt-0.5 text-[11px] text-gray-400">上线后由微信接口生成，当前为占位图</div>
          </div>
          <div className="flex flex-col items-center gap-3 px-4 py-4">
            <div className="flex h-[148px] w-[148px] items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50">
              <div className="rounded bg-white p-2">
                <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${QR_SIZE}, 4px)` }}>
                  {QR_CELLS.map((filled, index) => (
                    <span
                      key={index}
                      className={`h-[4px] w-[4px] ${filled ? "bg-gray-700" : "bg-transparent"}`}
                      aria-hidden
                    />
                  ))}
                </div>
                <div className="mt-2 text-center text-[10px] text-gray-400">小程序码占位</div>
              </div>
            </div>
            <p className="text-center text-[11px] leading-relaxed text-gray-400">
              客人在微信中扫码进入小程序，可选择房型与日期自助下单，
              订单会进入「渠道预订」列表。
            </p>
            <span
              className={`rounded px-2 py-0.5 text-[11px] ${
                enabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {enabled ? "入口可用" : "入口不可用"}
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">配置状态</div>
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
          {statusItems.map((item) => (
            <div key={item.label} className="rounded-md border border-gray-200 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-gray-700">{item.label}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    item.configured ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {item.configured ? "已配置" : "未配置"}
                </span>
              </div>
              <div className="mt-1 truncate text-[11px] text-gray-400" title={item.hint}>
                {item.hint}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">接入说明</div>
        <ul className="space-y-1.5 px-4 py-3 text-[11px] leading-relaxed text-gray-500">
          <li>· AppID / AppSecret 用于小程序登录与网页授权（换取 openid），密钥只在服务端保存，页面不会回显明文。</li>
          <li>· 微信商户号（mch_id）用于小程序内微信支付，未配置时只能「到店付款」。</li>
          <li>· 模板消息 ID 用于订单确认、预抵提醒等订阅消息推送。</li>
          <li>· 小程序码当前为占位图，需在小程序后台生成体验版 / 正式版二维码后替换。</li>
          <li>· 启用后小程序下单会写入渠道预订，客人到店后由前台排房办理入住。</li>
          <li>· 全部配置存于 settings 表（wechat_appid / wechat_secret / wechat_mch_id / wechat_template_id / wechat_enabled）。</li>
        </ul>
      </div>
    </div>
  );
}
