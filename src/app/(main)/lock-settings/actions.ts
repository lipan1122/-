"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/** 门锁设置：配置项统一存在 settings 表，key 以 lock_ 前缀区分 */

const VENDOR_LABEL: Record<string, string> = {
  quhu: "去呼呼门锁",
  other: "其他门锁",
};

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function back(key: "err" | "msg", message: string): never {
  redirect(`/lock-settings?${key}=${encodeURIComponent(message)}`);
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

/** op_logs 不存在时静默跳过，避免旧库保存报错 */
function logOp(hotelId: number, operator: string, action: string, detail: string): void {
  const exists =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)?.n ?? 0;
  if (exists === 0) {
    run(`CREATE TABLE IF NOT EXISTS op_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      operator TEXT,
      action TEXT,
      detail TEXT,
      created_at TEXT
    )`);
  }
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

/**
 * 保存门锁设置：厂商 / 接口地址 / 酒店编码 / 启用开关
 * 全部写入 settings 表，页面下次渲染即回显
 */
export async function saveLockSettingsAction(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const hotelId = user.hotelId;

  const vendorRaw = str(formData.get("lock_vendor"));
  const apiUrl = str(formData.get("lock_api_url"));
  const hotelCode = str(formData.get("lock_hotel_code"));
  const enabledRaw = str(formData.get("lock_enabled"));

  const vendor = vendorRaw === "other" ? "other" : "quhu";
  const enabled = enabledRaw === "1" ? "1" : "0";

  if (apiUrl && !/^https?:\/\/\S+$/i.test(apiUrl)) back("err", "接口地址需以 http:// 或 https:// 开头");
  if (apiUrl.length > 200) back("err", "接口地址不能超过 200 个字符");
  if (hotelCode.length > 40) back("err", "酒店编码不能超过 40 个字符");

  upsertSetting(hotelId, "lock_vendor", vendor);
  upsertSetting(hotelId, "lock_api_url", apiUrl);
  upsertSetting(hotelId, "lock_hotel_code", hotelCode);
  upsertSetting(hotelId, "lock_enabled", enabled);

  revalidatePath("/lock-settings");

  back("msg", `门锁设置已保存：${VENDOR_LABEL[vendor]} · ${enabled === "1" ? "已启用" : "未启用"}`);
}

/**
 * 测试门锁接口连通性：
 * 1. 读取已保存的接口地址 / 酒店编码，缺失或不合法直接失败
 * 2. 模拟一次握手（真实环境由门锁厂商 SDK 完成）
 * 3. 无论成功失败都写 op_logs 留痕
 */
export async function testLockConnectionAction(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const hotelId = user.hotelId;

  const vendor = get<{ value: string | null }>(
    `SELECT value FROM settings WHERE hotel_id = ? AND key = 'lock_vendor' LIMIT 1`,
    [hotelId]
  )?.value;
  const apiUrl = get<{ value: string | null }>(
    `SELECT value FROM settings WHERE hotel_id = ? AND key = 'lock_api_url' LIMIT 1`,
    [hotelId]
  )?.value;
  const hotelCode = get<{ value: string | null }>(
    `SELECT value FROM settings WHERE hotel_id = ? AND key = 'lock_hotel_code' LIMIT 1`,
    [hotelId]
  )?.value;
  const enabled = get<{ value: string | null }>(
    `SELECT value FROM settings WHERE hotel_id = ? AND key = 'lock_enabled' LIMIT 1`,
    [hotelId]
  )?.value;

  const vendorLabel = VENDOR_LABEL[vendor ?? "quhu"] ?? "去呼呼门锁";
  const url = (apiUrl ?? "").trim();
  const code = (hotelCode ?? "").trim();

  const fail = (reason: string): never => {
    logOp(
      user.hotelId,
      user.realName,
      "门锁连接测试",
      `${vendorLabel} · 接口地址 ${url || "未配置"} · 酒店编码 ${code || "未配置"} · 连接失败：${reason}`
    );
    revalidatePath("/lock-settings");
    return back("err", `连接失败：${reason}`);
  };

  if (!url) fail("尚未配置接口地址，请先保存设置");
  if (!/^https?:\/\/\S+$/i.test(url)) fail("接口地址格式不正确，需以 http:// 或 https:// 开头");
  if (!code) fail("尚未配置酒店编码，请先保存设置");

  // 模拟握手：真实部署时替换为厂商 SDK 的连通性探测
  const latency = Math.floor(Math.random() * 60) + 25;
  const okDetail = `${vendorLabel} · ${url} · 酒店编码 ${code} · 连接成功（模拟 HTTP 200，${latency}ms）· 启用状态：${
    enabled === "1" ? "已启用" : "未启用"
  }`;

  logOp(hotelId, user.realName, "门锁连接测试", okDetail);
  revalidatePath("/lock-settings");

  back("msg", `连接成功：${vendorLabel} · 接口响应正常（模拟 ${latency}ms）`);
}

/** 门锁管理卡类型：MASTER 主卡 / GUEST 客卡 / CLEAN 清洁卡 */
const CARD_TYPE_LABEL: Record<string, string> = {
  MASTER: "主卡",
  GUEST: "客卡",
  CLEAN: "清洁卡",
};

/** lock_logs / lock_cards 懒建表（与页面保持同一份结构，旧库首次访问自动补齐） */
function ensureLockTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS lock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      room_no TEXT NOT NULL,
      card_no TEXT NOT NULL,
      action TEXT NOT NULL,
      operator TEXT,
      created_at TEXT
    );
  `);
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS lock_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      card_no TEXT NOT NULL,
      room_no TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'VALID',
      valid_from TEXT,
      valid_to TEXT,
      created_at TEXT
    );
  `);
}

function num(value: FormDataEntryValue | null): number {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 校验 YYYY-MM-DD 日期字符串 */
function isDateStr(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00`);
  return !Number.isNaN(d.getTime());
}

/**
 * 新增门锁管理卡：
 * 1. 卡号必填且本店唯一
 * 2. 房号须为 rooms 表里的真实房号
 * 3. 有效期起止为 YYYY-MM-DD，止不能早于起
 * 4. 写入 lock_cards（状态默认 VALID）并留痕 op_logs
 */
export async function addLockCardAction(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const hotelId = user.hotelId;
  ensureLockTables();

  const cardNo = str(formData.get("card_no"));
  const roomNo = str(formData.get("room_no"));
  const typeRaw = str(formData.get("type"));
  const validFrom = str(formData.get("valid_from"));
  const validTo = str(formData.get("valid_to"));

  if (!cardNo) back("err", "请输入管理卡卡号");
  if (cardNo.length > 40) back("err", "卡号不能超过 40 个字符");
  if (!roomNo) back("err", "请选择管理卡绑定的房号");
  if (!isDateStr(validFrom) || !isDateStr(validTo)) back("err", "有效期起止格式不正确，应为 YYYY-MM-DD");
  if (validTo < validFrom) back("err", "有效期止不能早于有效期起");

  const type = CARD_TYPE_LABEL[typeRaw] ? typeRaw : "GUEST";

  const hasRooms =
    (get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'rooms'`)?.n ?? 0) > 0;
  if (hasRooms) {
    const room = get<{ room_no: string }>(`SELECT room_no FROM rooms WHERE hotel_id = ? AND room_no = ?`, [
      hotelId,
      roomNo,
    ]);
    if (!room) back("err", `房号 ${roomNo} 不存在，请先在房号 / 房态维护中添加`);
  }

  const dup = get<{ id: number }>(`SELECT id FROM lock_cards WHERE hotel_id = ? AND card_no = ?`, [hotelId, cardNo]);
  if (dup) back("err", `卡号 ${cardNo} 已存在，请勿重复发卡`);

  run(
    `INSERT INTO lock_cards (hotel_id, card_no, room_no, type, status, valid_from, valid_to, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [hotelId, cardNo, roomNo, type, "VALID", validFrom, validTo, nowIso()]
  );

  logOp(
    hotelId,
    user.realName,
    "门锁管理卡新增",
    `卡号 ${cardNo} · ${CARD_TYPE_LABEL[type]} · 房号 ${roomNo} · 有效期 ${validFrom} ~ ${validTo}`
  );
  revalidatePath("/lock-settings");

  back("msg", `已新增${CARD_TYPE_LABEL[type]} ${cardNo}（房号 ${roomNo}，有效期 ${validFrom} ~ ${validTo}）`);
}

/** 作废门锁管理卡：状态置为 INVALID，失效卡不可再用于开门 */
export async function voidLockCardAction(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const hotelId = user.hotelId;
  ensureLockTables();

  const id = num(formData.get("id"));
  if (!id) back("err", "没有找到要作废的管理卡");

  const row = get<{ card_no: string; status: string }>(
    `SELECT card_no, status FROM lock_cards WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) back("err", "该管理卡不存在或已删除");
  if (row.status === "INVALID") back("err", `卡号 ${row.card_no} 已经是失效状态`);

  run(`UPDATE lock_cards SET status = 'INVALID' WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  logOp(hotelId, user.realName, "门锁管理卡作废", `卡号 ${row.card_no} 已作废`);
  revalidatePath("/lock-settings");

  back("msg", `卡号 ${row.card_no} 已作废，不能再用于开门`);
}

/** 绑定 / 解绑房间门锁（去呼呼「门锁管理」：每个房间绑定一把锁） */
export async function bindLockAction(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const hotelId = user.hotelId;
  const roomId = Math.trunc(Number(formData.get("roomId")));
  const action = String(formData.get("op") ?? "bind");
  if (!roomId) return;

  run(`CREATE TABLE IF NOT EXISTS lock_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    lock_code TEXT,
    status TEXT NOT NULL DEFAULT 'BOUND',
    signal INTEGER,
    battery INTEGER,
    bound_at TEXT,
    UNIQUE (hotel_id, room_id)
  )`);

  if (action === "unbind") {
    run(`DELETE FROM lock_devices WHERE hotel_id = ? AND room_id = ?`, [hotelId, roomId]);
    run(
      `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
      [hotelId, user.realName, "解绑门锁", `房间ID ${roomId}`, nowIso()]
    );
  } else {
    const code = `LK${String(roomId).padStart(4, "0")}${String(Date.now()).slice(-4)}`;
    const exists = get<{ id: number }>(
      `SELECT id FROM lock_devices WHERE hotel_id = ? AND room_id = ?`,
      [hotelId, roomId]
    );
    if (exists) {
      run(`UPDATE lock_devices SET lock_code = ?, status = 'BOUND', bound_at = ? WHERE id = ? AND hotel_id = ?`, [
        code, nowIso(), exists.id, hotelId,
      ]);
    } else {
      const seed = (roomId * 7) % 60;
      run(
        `INSERT INTO lock_devices (hotel_id, room_id, lock_code, status, signal, battery, bound_at)
         VALUES (?,?,?,?,?,?,?)`,
        [hotelId, roomId, code, "BOUND", 60 + seed, 40 + ((roomId * 13) % 60), nowIso()]
      );
    }
    run(
      `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
      [hotelId, user.realName, "绑定门锁", `房间ID ${roomId} → ${code}`, nowIso()]
    );
  }
  revalidatePath("/lock-settings");
}
