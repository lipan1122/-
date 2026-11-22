/**
 * 小程序：酒店基础信息（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * GET /api/mini/hotel
 *
 * 返回客人需要的那几项：酒店名称 / 地址 / 电话 / 营业时间 / 地图坐标 / 入离时间 /
 * 押金说明 / 停车说明，以及「在线支付是否开通」这一个支付口径字段。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、这个接口刻意**不返回**什么（清单第四节：不返回经营数据）
 * ══════════════════════════════════════════════════════════════════════════
 * 不返回：房间总数 / 出租率 / 在住数 / 今日营收 / 房价水平 / 员工数量 / 会员总数。
 * 这是匿名接口（客人还没登录就要能看酒店在哪），一旦返回经营数据，
 * 竞对按天采集就能推算入住率与营收。只有 hotels 表的展示字段会出现在响应里。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、营业时间 / 地图坐标 / 押金说明从哪来（清单第 81 行同一原则）
 * ══════════════════════════════════════════════════════════════════════════
 * 清单原话是「如果数据库没有图片和设施字段，增加明确的数据表或配置字段，
 * 不要在页面写死虚假信息」。本接口同理：
 *   · hotels 表只有 name / address / phone / logo —— 直接用；
 *   · 入住 / 离店时间读 settings 的 check_in_time / check_out_time
 *     （「设置 → 系统设置」已有的两个配置项，PC 端也在用同一对 key），
 *     缺失时才回落到行业通用值 14:00 / 12:00，并在 unconfigured 里标出来；
 *   · 营业时间 / 地图坐标 / 地图跳转链接 / 押金说明 / 停车说明 / 酒店简介
 *     **数据库里没有**。这里不编造：读 settings 的可选 key
 *     （hotel_business_hours / hotel_latitude / hotel_longitude / hotel_map_url /
 *      hotel_deposit_note / hotel_parking_note / hotel_intro），
 *     没配置就返回 null，并在 unconfigured 数组里逐项列明「未配置」，
 *     由小程序页面显示「请咨询前台」，而不是画一个假地图坐标或假押金金额。
 *   这些 key 是纯文本配置，管理员在「设置」里补一行就能生效，不需要改代码。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、租户从哪来
 * ══════════════════════════════════════════════════════════════════════════
 * 不接受任何客户端传入的 hotelId（清单第四节：不信任客户端 hotelId）。
 * 与 /api/mini/rooms 完全同一口径：resolveMiniHotelId() 由服务端配置决定落哪家店。
 */

import { all, get } from "@/lib/db";
import { getActiveMiniConfig, getMiniProgramConfig, resolveMiniHotelId } from "@/lib/mini-config";
import { rateLimit } from "@/lib/mini-rate-limit";
import { fail, ok } from "../_shared";

export const dynamic = "force-dynamic";

/* ============================================================ 公开接口限流
 *
 * 与 /api/mini/rooms 同一份实现、同一量级阈值：首页会并行拉 /hotel + /rooms，
 * 60 对正常用户偏紧，120 对脚本仍然毫无用处。限流放在最前面，
 * 非法请求也计数（否则脚本可以免费刷解析逻辑）。
 */
const HOTEL_RATE_LIMIT_PER_MINUTE = 120;

/** hotels 表里能对外展示的列（没有任何经营字段） */
type HotelRow = {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  logo: string | null;
};

/**
 * settings 可选配置 key → 响应字段。
 *
 * 为什么放在一张表里而不是散着写：这些 key 目前**没有**管理页面，
 * 集中列出来才能一眼看清「哪些字段本来就没有、需要管理员补配置」，
 * 也方便将来给设置页加表单时直接复用这批 key 名。
 */
const OPTIONAL_SETTINGS = {
  businessHours: "hotel_business_hours",
  latitude: "hotel_latitude",
  longitude: "hotel_longitude",
  mapUrl: "hotel_map_url",
  depositNote: "hotel_deposit_note",
  parkingNote: "hotel_parking_note",
  intro: "hotel_intro",
} as const;

/** 未配置时在 unconfigured 里展示给前端的中文名（前端据此显示「未配置」占位） */
const FIELD_LABEL: Record<keyof typeof OPTIONAL_SETTINGS, string> = {
  businessHours: "酒店营业时间",
  latitude: "地图纬度",
  longitude: "地图经度",
  mapUrl: "地图跳转链接",
  depositNote: "押金说明",
  parkingNote: "停车说明",
  intro: "酒店简介",
};

/** 去空 + 去首尾空格；空返回 null（响应里明确是 null，而不是空串） */
function orNull(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return v ? v : null;
}

/** HH:MM 合法性（入离时间会被小程序直接展示，脏值宁可回落默认值） */
function isHhMm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** 读一组 settings key（表不存在 / 老库缺行都返回空 Map，不抛错；同 key 多行取最早一条） */
function readSettings(hotelId: number, keys: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (keys.length === 0) return map;
  try {
    const rows = all<{ key: string; value: string | null }>(
      `SELECT key, value FROM settings
        WHERE hotel_id = ? AND key IN (${keys.map(() => "?").join(",")})
        ORDER BY id`,
      [hotelId, ...keys]
    );
    for (const row of rows) {
      if (!map.has(row.key)) map.set(row.key, (row.value ?? "").trim());
    }
  } catch {
    /* settings 表在极老库里可能不存在：当成「全部未配置」处理 */
  }
  return map;
}

export async function GET(req: Request) {
  /* ---------- 0. 限流（放在最前，非法请求也计数） ---------- */
  const limited = rateLimit(req, { scope: "mini:hotel", limit: HOTEL_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "查询过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  /* ---------- 1. 租户由服务端决定，不看请求参数 ---------- */
  const hotelId = resolveMiniHotelId();

  const hotel = get<HotelRow>(`SELECT id, name, address, phone, logo FROM hotels WHERE id = ?`, [hotelId]);
  if (!hotel) {
    /* 空库 / 配置指向不存在的酒店：如实告知未配置，而不是返回一个空壳酒店 */
    return fail("NOT_CONFIGURED", "酒店信息尚未配置，请联系酒店", 200);
  }

  /* ---------- 2. 必填字段与可选字段 ---------- */
  const keys = [
    "check_in_time",
    "check_out_time",
    ...Object.values(OPTIONAL_SETTINGS),
  ];
  const settings = readSettings(hotelId, keys);

  const rawCheckIn = settings.get("check_in_time") ?? "";
  const rawCheckOut = settings.get("check_out_time") ?? "";
  const checkInConfigured = isHhMm(rawCheckIn);
  const checkOutConfigured = isHhMm(rawCheckOut);
  /* 未配置时用行业通用值，但一定进 unconfigured —— 页面要能看出这是默认值 */
  const checkInTime = checkInConfigured ? rawCheckIn : "14:00";
  const checkOutTime = checkOutConfigured ? rawCheckOut : "12:00";

  const optional: Record<keyof typeof OPTIONAL_SETTINGS, string | null> = {
    businessHours: orNull(settings.get(OPTIONAL_SETTINGS.businessHours)),
    latitude: orNull(settings.get(OPTIONAL_SETTINGS.latitude)),
    longitude: orNull(settings.get(OPTIONAL_SETTINGS.longitude)),
    mapUrl: orNull(settings.get(OPTIONAL_SETTINGS.mapUrl)),
    depositNote: orNull(settings.get(OPTIONAL_SETTINGS.depositNote)),
    parkingNote: orNull(settings.get(OPTIONAL_SETTINGS.parkingNote)),
    intro: orNull(settings.get(OPTIONAL_SETTINGS.intro)),
  };

  /* ---------- 3. 没有配置的字段逐项列明（清单第 81 行：不许写死虚假信息） ---------- */
  const unconfigured: string[] = [];
  if (!checkInConfigured) unconfigured.push("入住时间（settings.check_in_time，当前显示默认 14:00）");
  if (!checkOutConfigured) unconfigured.push("离店时间（settings.check_out_time，当前显示默认 12:00）");
  for (const key of Object.keys(optional) as (keyof typeof OPTIONAL_SETTINGS)[]) {
    if (optional[key] === null) unconfigured.push(`${FIELD_LABEL[key]}（未配置 ${OPTIONAL_SETTINGS[key]}）`);
  }
  if (orNull(hotel.address) === null) unconfigured.push("酒店地址（hotels.address 为空）");
  if (orNull(hotel.phone) === null) unconfigured.push("酒店电话（hotels.phone 为空）");

  /* ---------- 4. 支付口径：默认到店付款，绝不显示虚假的在线支付（清单第五节） ---------- */
  const cfg = getMiniProgramConfig(hotelId);
  const onlinePayConfigured = Boolean(cfg && (cfg.mchId || "").trim());
  /*
   * 小程序登录是否可用：用 /api/mini/login 判定「可用配置」的同一个函数
   * （getActiveMiniConfig 会在 mini_program_config 没有可用配置时回退读
   *  /wechat 页写入 settings 的 wechat_*），所以本字段与「客人到底能不能登录」
   *  永远一致。只回布尔，不回 AppID / AppSecret 任何一个字符。
   */
  const miniConfigured = Boolean(getActiveMiniConfig());
  return ok({
    /* 展示字段（没有经营数据） */
    name: hotel.name,
    address: orNull(hotel.address),
    phone: orNull(hotel.phone),
    logo: orNull(hotel.logo),
    intro: optional.intro,

    /* 营业时间 / 入离时间 */
    businessHours: optional.businessHours,
    checkInTime,
    checkOutTime,

    /* 地图入口：坐标缺失时为 null，前端隐藏「导航」按钮而不是跳到一个假位置 */
    location: {
      latitude: optional.latitude,
      longitude: optional.longitude,
      mapUrl: optional.mapUrl,
      /** 三项都缺时页面显示「请咨询前台」 */
      configured: Boolean(optional.latitude && optional.longitude) || Boolean(optional.mapUrl),
    },

    /* 入住须知类文案（全为「未配置」占位，不编造） */
    depositNote: optional.depositNote,
    parkingNote: optional.parkingNote,

    /* 联系前台 */
    contact: {
      phone: orNull(hotel.phone),
      /** 小程序端「联系前台」按钮：电话缺失时前端应提示到店咨询 */
      available: Boolean(orNull(hotel.phone)),
    },

    /* 支付：当前项目默认到店付款；即使配了商户号也只是「具备在线支付条件」，
       真正开通还要服务端统一下单能力，所以 onlinePayEnabled 恒为 false（不误导客人）。 */
    payment: {
      mode: "PAY_AT_HOTEL",
      label: "到店付款",
      onlinePayEnabled: false,
      onlinePayConfigured,
    },

    currency: "CNY",

    /** 小程序登录配置状态（能否登录；只回布尔，不回任何密钥/AK） */
    miniConfigured,

    /** 没有配置的字段（含用了默认值的入离时间），页面据此显示「未配置」 */
    unconfigured,
  });
}
