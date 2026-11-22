import { getSession, hasPermission } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * 会员导入模版（CSV）
 *
 * 整改 5.3：下载类 Route Handler 不能匿名开放。
 * 模板本身只是表头 + 示例行、不含真实数据，但它属于「会员导入」这条后台流程的入口：
 * 匿名可达等于给外部一个零成本的后台功能探测点，也绕过了页面层的模块守卫。
 * 权限点用 session.ts 权限表里的 "report.view_operation"（admin / frontdesk / cashier），
 * 与 requirePermission 共用同一张表；这里手写 getSession + hasPermission 而不是直接调
 * requirePermission，是因为 Route Handler 需要返回明确的 HTTP 状态 ——
 * requirePermission 在未登录时会 redirect("/login")，对下载接口会变成
 * 「200 + 登录页 HTML」，前端既拿不到 CSV，也看不到明确的 401/403。
 */
export async function GET() {
  const user = await getSession();
  if (!user) return new Response("未登录", { status: 401 });
  if (!hasPermission(user.role, "report.view_operation", user.hotelId)) {
    return new Response("无权限", { status: 403 });
  }

  const header = ["姓名", "手机号", "会员等级", "会员卡号", "备注"];
  const sample = [
    ["张三", "13800001111", "VIP1", "M0001", "示例行，导入前请删除"],
    ["李四", "13800002222", "VIP2", "M0002", ""],
  ];
  const lines = [header.join(","), ...sample.map((r) => r.map((v) => `"${v}"`).join(","))];
  const csv = "\uFEFF" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="members-template.csv"',
    },
  });
}
