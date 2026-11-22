import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { all, run } from "@/lib/db";
import { isHashed, verifyPassword } from "@/lib/password";
import { cleanupExpiredSessions } from "@/lib/session";
import { checkLocked, clearFailures, clientIp, recordFailure } from "@/lib/login-guard";

function html(body: string) {
  return new NextResponse(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录中…</title></head><body>${body}</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

/** 登录查询返回的用户行（只声明用得到的列） */
type LoginUserRow = {
  id: number;
  username: string;
  real_name: string;
  role: string;
  hotel_id: number;
  hotel_name: string;
  /**
   * 唯一可信的密码来源（整改 8.1）。
   * 旧列 users.password 已在 migrate-all 第 14 段里清成 NULL，登录流程不查、也不比对它。
   */
  password_hash: string | null;
  status: number;
};

/** 生产环境（HTTPS）才加 secure，本地 http 调试不加，否则登录不生效 */
const IS_PROD = process.env.NODE_ENV === "production" && process.env.PMS_ALLOW_HTTP !== "1";

/**
 * 登录
 *
 * 整改报告 P0-2.1 / P0-2.2 / 8.1 / 8.3：
 *   - 只下发随机 session id（pms_sid），不再下发可伪造的用户信息 Cookie
 *   - 密码只认 users.password_hash（scrypt），校验不通过一律拒绝
 *   - **不存在明文比较分支**：旧列 users.password 不参与校验（迁移里已清成 NULL），
 *     迁移窗口期内 password_hash 为空就拒绝登录并提示管理员重置，绝不回退去比旧值
 *   - 登录失败不区分「账号不存在 / 密码错」，避免枚举账号
 *
 * 整改报告 P2-4：
 *   - 多店部署下同名账号不再静默串店（详见下面查询处的注释）
 *   - 登录成功后顺带清理过期会话（见 session.ts 的 cleanupExpiredSessions）
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  /*
   * 酒店标识（可选，P2-4）：多店部署时同名账号必须靠它区分。
   * 支持两种写法 —— hotels.code（如 YQ）或 hotels.id（数字），
   * 这样即使某家店没维护 code 列，运营也能用数字 ID 定位。
   * 单店部署留空即可，行为与改动前完全一致。
   */
  const hotelCode = String(form.get("hotel_code") ?? "").trim();

  if (!username || !password) {
    return html(`<p>请输入账号和密码，<a href="/login?error=1">返回登录</a></p>`);
  }

  /*
   * 暴力破解防护（上线前安全加固）
   *
   * 审计发现登录接口零防护：配合「登录页明文写着 admin/admin123」，
   * 任何人都能直接接管管理员；就算改了口令，没有限速也能慢慢猜。
   *
   * 这里在**验密码之前**先查锁定状态：
   *   · 已锁 → 直接返回「尝试过多」，不必浪费时间验密码
   *   · 也避免通过响应时间反推账号是否存在
   */
  const ip = clientIp(req);
  const lockedState = checkLocked(ip, username);
  if (lockedState.locked) {
    return html(
      `<p>尝试次数过多，请 ${lockedState.remainMinutes} 分钟后再试，<a href="/login?error=1">返回登录</a></p>`
    );
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   * 多店同名账号（整改 P2-4）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 旧写法是 `WHERE u.username = ?` + get()：只取第一行，两家店都有 admin 时，
   * 登录会静默进 id 最小的那家 —— 前台在 B 店却操作了 A 店的房态和账务，
   * 是跨租户越权，而且登录过程没有任何提示，事后很难发现。
   *
   * 现在按「先查全部匹配行，再判定行数」处理：
   *   0 行 → 统一「账号或密码不正确」（不暴露账号是否存在，保留防枚举语义）
   *   1 行 → 正常登录
   *   多行 → 明确提示「账号在多店重复，请补充酒店标识」
   *
   * 多行提示确实暴露了「该用户名存在」，但它只在同名账号跨店这个运营配置错误下出现：
   * 让前台/管理员立刻发现并补标识，比默不作声把人登进别家店安全得多。
   *
   * 填了酒店标识时，按 hotels.code（忽略大小写）或 hotels.id 过滤；
   * 过滤后仍多行（同一 code 被两家店共用）同样走重复提示，提示文案不猜具体是哪家。
   */
  const rows = all<LoginUserRow>(
    `SELECT u.id, u.username, u.real_name, u.role, u.hotel_id, h.name AS hotel_name,
            u.password_hash, u.status
       FROM users u JOIN hotels h ON h.id = u.hotel_id
      WHERE u.username = ?
        ${hotelCode ? "AND (h.code COLLATE NOCASE = ? OR CAST(h.id AS TEXT) = ?)" : ""}`,
    hotelCode ? [username, hotelCode, hotelCode] : [username]
  );

  const fail = () => {
    /*
     * 记一次失败（含审计）。
     * 同一 IP 或同一账号累计 5 次 → 锁 15 分钟，之后连验密码都跳过。
     */
    const r = recordFailure(ip, username, u?.hotel_id ?? null, username || "(空)");
    if (!r.ok && r.reason === "locked") {
      return html(
        `<p>尝试次数过多，请 ${r.remainMinutes} 分钟后再试，<a href="/login?error=1">返回登录</a></p>`
      );
    }
    const res = html(`<p>账号或密码不正确，<a href="/login?error=1">返回登录</a></p>`);
    res.cookies.set("pms_sid", "", { path: "/", maxAge: 0 });
    res.cookies.set("pms_user", "", { path: "/", maxAge: 0 });
    return res;
  };

  /*
   * 多店重复：不回写任何 Cookie，直接把原因告诉用户。
   * 文案里不插入 username（来自表单，插入 HTML 需要转义，这里直接用固定文案更安全）。
   */
  if (rows.length > 1) {
    return html(
      `<p>账号在多店重复，请补充酒店标识后重试，<a href="/login?error=dup">返回登录</a></p>`
    );
  }

  const u = rows[0];
  if (!u || Number(u.status) !== 1) return fail();

  /*
   * 密码校验（整改 8.1 / 8.3）：唯一数据源是 password_hash。
   *
   * 三条拒绝路径，没有一条会去比旧明文列：
   *   1) password_hash 为空 → 该账号还没迁移 / 本来就没密码：提示管理员重置，不放行
   *   2) password_hash 不是本模块产出的 scrypt 串 → 脏数据，按登录失败处理（不当明文比对）
   *   3) verifyPassword 不通过 → 统一「账号或密码不正确」
   *
   * 第 1 条故意给出可区分的提示：迁移窗口期只有极少数账号会命中，
   * 让前台知道该找管理员重置，比笼统的「密码错」少一轮排查。
   */
  const stored = u.password_hash ?? "";
  if (!stored) {
    return html(
      `<p>该账号尚未完成密码安全迁移，请联系管理员重置密码，<a href="/login?error=1">返回登录</a></p>`
    );
  }
  if (!isHashed(stored) || !verifyPassword(password, stored)) return fail();

  /* 登录成功：清掉失败计数 + 记审计（成功也留痕，方便发现异常 IP） */
  clearFailures(ip, username, u.hotel_id, u.username);

  const session = {
    id: u.id,
    username: u.username,
    realName: u.real_name,
    role: u.role,
    hotelId: u.hotel_id,
    hotelName: u.hotel_name,
  };

  const sid = randomUUID().replace(/-/g, "");
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  run(`INSERT INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    sid,
    JSON.stringify(session),
    now.toISOString(),
    expires.toISOString(),
  ]);

  /*
   * 整改 P2-4：会话表只增不删会一直堆过期记录。
   * 这里不引入额外定时器 —— 登录本身就是高频触发点，每次登录顺带清一次，
   * 成本是一次走 idx_sessions_expires 的 DELETE，换来 sessions 表永远只留有效会话；
   * 夜审里也有一次调用（夜审是每天一次的兜底），长期没人登录也不会无限堆积。
   */
  cleanupExpiredSessions();

  const res = html(`<p>登录成功，正在进入工作台…</p><script>location.replace("/dashboard")</script>`);
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 12,
    secure: IS_PROD,
  };
  res.cookies.set("pms_sid", sid, cookieOpts);
  // 旧 Cookie 一律清掉，不再使用
  res.cookies.set("pms_user", "", { path: "/", maxAge: 0 });
  return res;
}

/** GET 访问登录接口直接回登录页 */
export async function GET() {
  return NextResponse.redirect(new URL("/login", process.env.PMS_BASE_URL ?? "http://localhost:3100"));
}
