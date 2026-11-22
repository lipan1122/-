"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { ensureMiniSchema, saveMiniProgramConfig } from "@/lib/mini-config";
import { nowIso } from "@/lib/utils";

/**
 * 微酒店配置：主存储仍是 settings 表（key 以 wechat_ 前缀区分）
 *
 * 但系统里还有第二个入口 `/settings?tab=miniprogram`，写的是 mini_program_config 表。
 * 读路径已在 src/lib/mini-config.ts 里统一成「优先 mini_program_config，回退 wechat_*」，
 * 这里把写入路径也收敛掉：保存 / 清空时同步 mini_program_config，
 * 让两个页面无论从哪个入口看都拿到同一份配置（用户不必猜该信哪个页面）。
 */

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function back(key: "err" | "msg", message: string): never {
  redirect(`/wechat?${key}=${encodeURIComponent(message)}`);
}

/** settings 表 upsert（同 key 历史重复行一并更新，避免回显不一致） */
function upsertSetting(hotelId: number, key: string, value: string): void {
  const existing = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
  if (existing) {
    run(`UPDATE settings SET value = ? WHERE hotel_id = ? AND key = ?`, [value, hotelId, key]);
  } else {
    run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
  }
}

/**
 * 保存微酒店配置：AppID / AppSecret / 商户号 / 模板消息 ID / 启用开关
 * AppSecret 留空表示保留原值（页面不会回显明文密钥）
 */
export async function saveWechatConfigAction(formData: FormData): Promise<void> {
  // 权限边界（上线前加固）：这里写入 AppID / AppSecret / 商户号，属于系统级配置，仅 admin 可改
  const user = await requireAdmin();
  const hotelId = user.hotelId;

  const appId = str(formData.get("wechat_appid"));
  const secret = str(formData.get("wechat_secret"));
  const mchId = str(formData.get("wechat_mch_id"));
  const templateId = str(formData.get("wechat_template_id"));
  const enabledRaw = str(formData.get("wechat_enabled"));
  const enabled = enabledRaw === "1" ? "1" : "0";

  if (appId && !/^[0-9A-Za-z_-]{6,64}$/.test(appId)) back("err", "AppID 应为 6-64 位字母、数字、下划线或短横线");
  if (secret && !/^[0-9A-Za-z_-]{8,64}$/.test(secret)) back("err", "AppSecret 应为 8-64 位字母、数字、下划线或短横线");
  if (mchId && !/^\d{6,20}$/.test(mchId)) back("err", "商户号应为 6-20 位数字");
  if (templateId && !/^[0-9A-Za-z_-]{10,64}$/.test(templateId)) {
    back("err", "模板消息 ID 应为 10-64 位字母、数字、下划线或短横线");
  }
  // 已保存过密钥时，本次留空也视为「已具备启用条件」
  const savedSecret =
    get<{ value: string | null }>(
      `SELECT value FROM settings WHERE hotel_id = ? AND key = 'wechat_secret' LIMIT 1`,
      [hotelId]
    )?.value ?? "";
  const hasSecret = Boolean(secret || savedSecret);

  if (enabled === "1" && (!appId || !hasSecret)) back("err", "启用微酒店前请先填写 AppID 与 AppSecret");
  if (enabled === "1" && !mchId) back("err", "启用微酒店前请先填写微信商户号");

  upsertSetting(hotelId, "wechat_appid", appId);
  // 密钥留空不覆盖：页面不回显明文，避免误清空
  if (secret) upsertSetting(hotelId, "wechat_secret", secret);
  upsertSetting(hotelId, "wechat_mch_id", mchId);
  upsertSetting(hotelId, "wechat_template_id", templateId);
  upsertSetting(hotelId, "wechat_enabled", enabled);

  /*
   * 写入路径收敛：同步一份到 mini_program_config（小程序侧读取的权威表）。
   *
   * AppSecret 留空 = 保留原值，所以镜像时要用「表单新值 || 已存密钥」，
   * 否则 mini_program_config 会拿到空密钥，小程序登录立刻 NOT_CONFIGURED。
   * mchKey 只在 /settings?tab=miniprogram 维护，这里传 undefined 表示沿用旧值。
   */
  saveMiniProgramConfig({
    hotelId,
    appId,
    appSecret: secret || savedSecret,
    mchId,
    enabled: enabled === "1",
  });

  revalidatePath("/wechat");
  revalidatePath("/settings");

  back("msg", `微酒店配置已保存：${enabled === "1" ? "已启用" : "未启用"}（AppSecret ${secret ? "已更新" : "未修改"}）`);
}

/** 清空微酒店配置（保留启用开关为停用），便于换绑小程序 */
export async function clearWechatConfigAction(formData: FormData): Promise<void> {
  /* 上线前加固：清空微信配置属高危写操作，与 saveWechatConfigAction 同等要求 admin */
  const user = await requireAdmin();
  void formData;

  const keys = ["wechat_appid", "wechat_secret", "wechat_mch_id", "wechat_template_id"];
  const existed =
    all<{ key: string }>(
      `SELECT key FROM settings WHERE hotel_id = ? AND key IN (${keys.map(() => "?").join(",")})`,
      [user.hotelId, ...keys]
    ).length > 0;
  if (!existed) back("err", "当前没有可清空的微酒店配置");

  for (const key of keys) upsertSetting(user.hotelId, key, "");
  upsertSetting(user.hotelId, "wechat_enabled", "0");

  /*
   * 写入路径收敛：/wechat 清空配置时，mini_program_config 里的同一份配置必须一起清。
   * 读路径优先读 mini_program_config —— 只清 settings 的话，小程序登录仍会按
   * 那张表里的旧 AppID/AppSecret 放行，管理员以为已停用、实际还能登录。
   * mch_key 只属于小额支付、不在本页维护，保持不动（停用后 /api/mini/login 直接拒绝）。
   */
  ensureMiniSchema();
  run(
    `UPDATE mini_program_config
        SET app_id = '', app_secret = '', mch_id = '', enabled = 0, updated_at = ?
      WHERE hotel_id = ?`,
    [nowIso(), user.hotelId]
  );

  revalidatePath("/wechat");
  revalidatePath("/settings");

  back("msg", "微酒店配置已清空，启用状态已置为停用");
}
