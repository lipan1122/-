import { all } from "@/lib/db";
import { todayStr } from "@/lib/utils";
import { getSession, hasPermission } from "@/lib/session";

export const dynamic = "force-dynamic";

/** 手机号脱敏：13812340001 → 138****0001 */
function maskMobile(mobile: string | null): string {
  const s = String(mobile ?? "").replace(/\s/g, "");
  if (!s) return "";
  if (s.length < 7) return "***";
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 会员 CSV 导出 */
export async function GET() {
  const user = await getSession();
  if (!user) return new Response("未登录", { status: 401 });

  /*
   * 权限边界（上线前加固）：
   * 原来只校验登录 —— 任何角色（含客房阿姨）都能一键导出全店客人手机号。
   * 现在必须有 member.view_sensitive（权限矩阵里只有 admin / frontdesk / cashier）。
   */
  if (!hasPermission(user.role, "member.view_sensitive", user.hotelId)) {
    return new Response("无权导出会员数据", { status: 403 });
  }

  /*
   * 手机号脱敏：
   * member.view_sensitive 只代表「能导会员数据」，不等于能看客人敏感信息 ——
   * 明文手机号归 guest.view_sensitive（只有 admin / frontdesk）。
   * 没有它的账号（目前是 cashier）导出的手机号一律打码成 138****0001。
   */
  const canSeeSensitive = hasPermission(user.role, "guest.view_sensitive", user.hotelId);

  const rows = all<{
    name: string;
    mobile: string | null;
    vip_level: number | null;
    note: string | null;
    total_spend: number | null;
    stay_count: number | null;
    created_at: string | null;
  }>(
    `SELECT g.name, g.mobile, g.vip_level, g.note,
            COALESCE((SELECT SUM(s.rate * COALESCE(s.nights,1)) FROM stays s
                      WHERE s.guest_id = g.id OR s.guest_name = g.name), 0) AS total_spend,
            COALESCE((SELECT COUNT(*) FROM stays s
                      WHERE s.guest_id = g.id OR s.guest_name = g.name), 0) AS stay_count,
            g.created_at
     FROM guests g
     WHERE g.hotel_id = ? AND COALESCE(g.deleted, 0) = 0
     ORDER BY g.id`,
    [user.hotelId]
  );

  const header = [
    "姓名",
    canSeeSensitive ? "手机号" : "手机号（脱敏）",
    "会员等级",
    "备注",
    "累计消费",
    "入住次数",
    "建档时间",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const cells = [
      r.name ?? "",
      canSeeSensitive ? (r.mobile ?? "") : maskMobile(r.mobile),
      r.vip_level ? `VIP${r.vip_level}` : "非会员",
      r.note ?? "",
      Number(r.total_spend ?? 0).toFixed(2),
      String(r.stay_count ?? 0),
      (r.created_at ?? "").slice(0, 19).replace("T", " "),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    lines.push(cells.join(","));
  }

  const csv = "\uFEFF" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="members-${todayStr()}.csv"`,
      // 含客人数据，禁止中间层缓存
      "cache-control": "no-store",
    },
  });
}
