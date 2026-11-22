"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, getDb, run } from "@/lib/db";
import { requireAdmin, requireUser } from "@/lib/session";
import { nowIso, todayStr } from "@/lib/utils";

/**
 * 短信服务（去呼呼智能短信）不在 init-db.mjs 内，
 * 首次导入本模块时懒创建，避免页面查询不到表。
 */
const SMS_DDL = `
CREATE TABLE IF NOT EXISTS sms_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT 'CHECKIN',
  status TEXT NOT NULL DEFAULT 'ENABLED',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sms_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  template_id INTEGER,
  mobile TEXT NOT NULL,
  guest_name TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SENT',
  error TEXT,
  sent_at TEXT
);
`;

// 顶部懒创建：页面导入本模块即执行（CREATE TABLE IF NOT EXISTS 幂等）
getDb().exec(SMS_DDL);

/** 模板场景：入住 / 退房 / 生日 / 营销（"use server" 文件只能导出 async 函数，故不导出） */
const SMS_SCENES = ["CHECKIN", "CHECKOUT", "BIRTHDAY", "MARKETING"];

const PROVIDERS = ["aliyun", "tencent", "yuntongxun"];

const FAILURE_REASONS = [
  "网关返回：短信签名校验失败",
  "运营商通道超时，请稍后重试",
  "该号码已停机或不在服务区",
  "账户余额不足，请充值后重发",
];

/** 发送成功率（模拟网关回执，按 95% 计） */
const SUCCESS_RATE = 0.95;

/** 模拟短信余额基数（剩余条数 = sms_balance - 已发送成功条数） */
const BALANCE_BASE = 5000;

/** 首次访问种子：5 个常用模板 */
const TEMPLATE_SEEDS: { code: string; name: string; scene: string; content: string }[] = [
  {
    code: "CHECKIN_WELCOME",
    name: "入住欢迎",
    scene: "CHECKIN",
    content:
      "尊敬的{客人姓名}，欢迎入住本酒店！您的房间为{房号}，入住日期{入住日期}。如需帮助请随时联系前台，祝您入住愉快。",
  },
  {
    code: "CHECKOUT_THANKS",
    name: "退房感谢",
    scene: "CHECKOUT",
    content: "尊敬的{客人姓名}，感谢您入住本酒店并选择{房号}房，期待您的再次光临，祝您一路顺风。",
  },
  {
    code: "BIRTHDAY_GREET",
    name: "生日祝福",
    scene: "BIRTHDAY",
    content: "尊敬的{客人姓名}，祝您生日快乐！本店为您准备了生日专属礼遇，凭此短信到前台即可领取。",
  },
  {
    code: "MARKETING_PROMO",
    name: "促销通知",
    scene: "MARKETING",
    content:
      "尊敬的{客人姓名}，本店限时推出入住优惠，{入住日期}起预订可享 8 折，名额有限，欢迎致电前台预订。",
  },
  {
    code: "WAKEUP_REMIND",
    name: "叫醒提醒",
    scene: "CHECKIN",
    content: "尊敬的{客人姓名}，您在{房号}房登记的叫醒服务已确认，我们将准时提醒您，祝您晚安。",
  },
];

/** 占位符替换：{客人姓名} {房号} {入住日期} */
function fillTemplate(tpl: string, guestName: string, roomNo: string, checkIn: string): string {
  return tpl
    .split("{客人姓名}")
    .join(guestName)
    .split("{房号}")
    .join(roomNo)
    .split("{入住日期}")
    .join(checkIn);
}

function sceneOf(value: FormDataEntryValue | null): string {
  const scene = String(value ?? "").trim().toUpperCase();
  return SMS_SCENES.includes(scene) ? scene : "CHECKIN";
}

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function back(tab: string, key: "msg" | "err", message: string): never {
  redirect(`/sms?tab=${encodeURIComponent(tab)}&${key}=${encodeURIComponent(message)}`);
}

/** settings 表 upsert（同 key 只保留一行，避免回显不一致） */
function upsertSetting(hotelId: number, key: string, value: string): void {
  const existing = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
  if (existing) {
    run(`UPDATE settings SET value = ? WHERE hotel_id = ? AND key = ?`, [value, hotelId, key]);
  } else {
    run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
  }
}

/**
 * 懒建表 + 首次种子：模板 5 条、发送记录 20 条（SENT / FAILED 混合）、短信设置默认值。
 * 已存在数据时只补齐缺失项，不覆盖用户改动。
 */
export async function ensureSmsSeed(hotelId: number): Promise<void> {
  /*
   * 权限边界（上线前加固）：建表 / 种子助手不该是可匿名调用的 RPC 端点。
   * 它被 sms/page.tsx 直接 import，去掉 export 会打断页面编译，这里补登录守卫；
   * 同时酒店 id 必须与 session 一致，避免拿着别家 hotelId 往别家写种子数据。
   */
  const user = await requireUser();
  if (Number(hotelId) !== user.hotelId) throw new Error("FORBIDDEN: 不能为其他酒店初始化短信数据");
  getDb().exec(SMS_DDL);

  const tplCount =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM sms_templates WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (tplCount === 0) {
    const now = nowIso();
    for (const t of TEMPLATE_SEEDS) {
      run(
        `INSERT INTO sms_templates (hotel_id, code, name, content, scene, status, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [hotelId, t.code, t.name, t.content, t.scene, "ENABLED", now]
      );
    }
  }

  const templates = all<{ id: number; content: string }>(
    `SELECT id, content FROM sms_templates WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const sendCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM sms_sends WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (sendCount === 0 && templates.length > 0) {
    const stays = all<{
      guest_name: string | null;
      mobile: string | null;
      room_no: string;
      check_in_time: string | null;
    }>(
      `SELECT s.guest_name, s.mobile, s.check_in_time, r.room_no
       FROM stays s JOIN rooms r ON r.id = s.room_id
       WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
       ORDER BY r.sort, r.room_no`,
      [hotelId]
    );
    const guests =
      stays.length > 0
        ? stays
        : [{ guest_name: "散客", mobile: "13800000000", room_no: "301", check_in_time: null }];

    const dayOfMonth = new Date().getDate();

    for (let i = 0; i < 20; i += 1) {
      const tpl = templates[i % templates.length];
      const guest = guests[i % guests.length];
      const guestName = guest.guest_name ?? "客人";
      const roomNo = guest.room_no ?? "—";
      const checkIn = guest.check_in_time ? guest.check_in_time.slice(0, 10) : todayStr();
      const mobile = guest.mobile && /^1\d{10}$/.test(guest.mobile) ? guest.mobile : `1380013${String(8000 + i)}`;
      const failed = i % 4 === 3;
      // 发送时间落在本月内（跨月时收敛到本月 1 日），保证「本月发送量」统计有数据
      const daysBack = Math.min(i, Math.max(0, dayOfMonth - 1));
      const sentAt = new Date(Date.now() - daysBack * 86400000 - (i % 5) * 1800000).toISOString();

      run(
        `INSERT INTO sms_sends (hotel_id, template_id, mobile, guest_name, content, status, error, sent_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          tpl.id,
          mobile,
          guestName,
          fillTemplate(tpl.content, guestName, roomNo, checkIn),
          failed ? "FAILED" : "SENT",
          failed ? FAILURE_REASONS[i % FAILURE_REASONS.length] : null,
          sentAt,
        ]
      );
    }
  }

  const settingDefaults: [string, string][] = [
    ["sms_provider", "aliyun"],
    ["sms_sign", "去呼呼酒店"],
    ["sms_balance", String(BALANCE_BASE)],
  ];
  for (const [key, value] of settingDefaults) {
    const exists = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
    if (!exists) run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
  }
}

/** 新增短信模板 */
export async function createTemplateAction(formData: FormData) {
  const user = await requireUser();
  await ensureSmsSeed(user.hotelId);

  const code = str(formData.get("code")).toUpperCase();
  const name = str(formData.get("name"));
  const scene = sceneOf(formData.get("scene"));
  const content = str(formData.get("content"));

  if (!code || !name || !content) back("templates", "err", "模板代码、模板名称、模板内容不能为空");

  const dup = get<{ id: number }>(`SELECT id FROM sms_templates WHERE hotel_id = ? AND code = ?`, [
    user.hotelId,
    code,
  ]);
  if (dup) back("templates", "err", `模板代码 ${code} 已存在，请换一个`);

  run(
    `INSERT INTO sms_templates (hotel_id, code, name, content, scene, status, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [user.hotelId, code, name, content, scene, "ENABLED", nowIso()]
  );
  revalidatePath("/sms");
  back("templates", "msg", `模板「${name}」已新增`);
}

/** 编辑短信模板（代码 / 名称 / 场景 / 内容） */
export async function updateTemplateAction(formData: FormData) {
  const user = await requireUser();
  await ensureSmsSeed(user.hotelId);

  const id = Number(formData.get("id") ?? 0);
  if (!id) back("templates", "err", "缺少模板 id");

  const existed = get<{ id: number }>(`SELECT id FROM sms_templates WHERE hotel_id = ? AND id = ?`, [
    user.hotelId,
    id,
  ]);
  if (!existed) back("templates", "err", "模板不存在或已删除");

  const code = str(formData.get("code")).toUpperCase();
  const name = str(formData.get("name"));
  const scene = sceneOf(formData.get("scene"));
  const content = str(formData.get("content"));
  if (!code || !name || !content) back("templates", "err", "模板代码、模板名称、模板内容不能为空");

  const dup = get<{ id: number }>(`SELECT id FROM sms_templates WHERE hotel_id = ? AND code = ? AND id <> ?`, [
    user.hotelId,
    code,
    id,
  ]);
  if (dup) back("templates", "err", `模板代码 ${code} 已被其他模板占用`);

  run(`UPDATE sms_templates SET code = ?, name = ?, content = ?, scene = ? WHERE hotel_id = ? AND id = ?`, [
    code,
    name,
    content,
    scene,
    user.hotelId,
    id,
  ]);
  revalidatePath("/sms");
  back("templates", "msg", `模板「${name}」已更新`);
}

/** 启用 / 停用短信模板 */
export async function toggleTemplateAction(formData: FormData) {
  const user = await requireUser();
  await ensureSmsSeed(user.hotelId);

  const id = Number(formData.get("id") ?? 0);
  if (!id) back("templates", "err", "缺少模板 id");

  const row = get<{ name: string; status: string }>(
    `SELECT name, status FROM sms_templates WHERE hotel_id = ? AND id = ?`,
    [user.hotelId, id]
  );
  if (!row) back("templates", "err", "模板不存在或已删除");

  const next = row.status === "ENABLED" ? "DISABLED" : "ENABLED";
  run(`UPDATE sms_templates SET status = ? WHERE hotel_id = ? AND id = ?`, [next, user.hotelId, id]);
  revalidatePath("/sms");
  back("templates", "msg", `模板「${row.name}」已${next === "ENABLED" ? "启用" : "停用"}`);
}

/** 发送短信：渲染占位符后写入 sms_sends（95% 成功率模拟网关回执） */
export async function sendSmsAction(formData: FormData) {
  const user = await requireUser();
  await ensureSmsSeed(user.hotelId);

  const templateId = Number(formData.get("template_id") ?? 0);
  const tpl = get<{ id: number; name: string; content: string; status: string }>(
    `SELECT id, name, content, status FROM sms_templates WHERE hotel_id = ? AND id = ?`,
    [user.hotelId, templateId]
  );
  if (!tpl) back("send", "err", "请先选择短信模板");
  if (tpl.status !== "ENABLED") back("send", "err", `模板「${tpl.name}」已停用，启用后才能发送`);

  const stayId = Number(formData.get("stay_id") ?? 0);
  const manualMobile = str(formData.get("mobile"));
  const manualName = str(formData.get("guest_name"));

  let mobile = manualMobile;
  let guestName = manualName;
  let roomNo = "";
  let checkIn = todayStr();

  if (stayId) {
    const stay = get<{
      guest_name: string | null;
      mobile: string | null;
      room_no: string;
      check_in_time: string | null;
    }>(
      `SELECT s.guest_name, s.mobile, s.check_in_time, r.room_no
       FROM stays s JOIN rooms r ON r.id = s.room_id
       WHERE s.hotel_id = ? AND s.id = ? AND s.status = 'INHOUSE'`,
      [user.hotelId, stayId]
    );
    if (!stay) back("send", "err", "所选客人不在住或已退房，请刷新后重试");
    if (!mobile) mobile = stay.mobile ?? "";
    if (!guestName) guestName = stay.guest_name ?? "客人";
    roomNo = stay.room_no;
    if (stay.check_in_time) checkIn = stay.check_in_time.slice(0, 10);
  }

  if (!/^1\d{10}$/.test(mobile)) back("send", "err", "手机号格式不正确，请输入 11 位手机号");
  if (!guestName) guestName = "客人";

  const content = fillTemplate(tpl.content, guestName, roomNo || "—", checkIn);
  const ok = Math.random() < SUCCESS_RATE;
  const error = ok ? null : FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)];

  run(
    `INSERT INTO sms_sends (hotel_id, template_id, mobile, guest_name, content, status, error, sent_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [user.hotelId, tpl.id, mobile, guestName, content, ok ? "SENT" : "FAILED", error, nowIso()]
  );

  revalidatePath("/sms");
  back(
    "records",
    "msg",
    ok ? `「${tpl.name}」已发送给 ${guestName}（${mobile}）` : `发送失败：${error ?? "网关异常"}`
  );
}

/** 保存短信设置：服务商 / 签名 */
export async function saveSmsSettingsAction(formData: FormData) {
  // 权限边界（上线前加固）：短信通道是系统级配置（/sms 页面本身是 ADMIN_ONLY），仅 admin 可改
  const user = await requireAdmin();
  await ensureSmsSeed(user.hotelId);

  const rawProvider = str(formData.get("sms_provider"));
  const provider = PROVIDERS.includes(rawProvider) ? rawProvider : "aliyun";
  const sign = str(formData.get("sms_sign"));

  if (!sign) back("settings", "err", "短信签名不能为空（通常为门店名称，2-12 个字）");
  if (sign.length < 2 || sign.length > 12) back("settings", "err", "短信签名长度需在 2-12 个字之间");

  upsertSetting(user.hotelId, "sms_provider", provider);
  upsertSetting(user.hotelId, "sms_sign", sign);

  revalidatePath("/sms");
  back("settings", "msg", "短信设置已保存");
}
