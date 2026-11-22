/**
 * 整改验收：认证安全（P0-2.1 / P0-2.2）
 *
 * 1. 正确密码能登录
 * 2. 错误密码不能登录
 * 3. 伪造 pms_user Cookie（Base64 用户 JSON）→ 必须被拒
 * 4. 伪造 pms_sid → 必须被拒
 * 5. 删除 session 后原 Cookie 失效
 * 6. 停用用户后旧 session 立即失效
 * 7. 数据库密码字段不是明文
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const BASE = { host: "localhost", port: 3100 };
const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

function req(path, { method = "GET", body = null, cookie = null, headers = {} } = {}) {
  return new Promise((res, rej) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body) {
      h["content-type"] = "application/x-www-form-urlencoded";
      h["content-length"] = Buffer.byteLength(body);
    }
    const r = http.request({ ...BASE, path, method, headers: h }, (y) => {
      let d = "";
      y.setEncoding("utf8");
      y.on("data", (c) => (d += c));
      y.on("end", () => res({ status: y.statusCode, location: y.headers.location || "", setCookie: y.headers["set-cookie"] || [], html: d }));
    });
    r.on("error", rej);
    if (body) r.write(body);
    r.end();
  });
}

async function login(username, password) {
  const body = new URLSearchParams({ username, password }).toString();
  const r = await req("/api/login", { method: "POST", body });
  const cookies = r.setCookie.map((c) => c.split(";")[0]);
  return { ...r, cookies, ok: r.html.includes("登录成功") };
}

/* 1 & 2 密码校验 */
const good = await login("admin", "admin123");
check("正确密码可登录", good.ok);
const bad = await login("admin", "wrong-password");
check("错误密码不能登录", !bad.ok);

/* 3 伪造 pms_user */
const fakeUser = Buffer.from(
  JSON.stringify({ id: 1, username: "admin", realName: "黑客", role: "admin", hotelId: 1, hotelName: "假酒店" }),
  "utf8"
).toString("base64url");
const rFakeUser = await req("/rooms", { cookie: `pms_user=${fakeUser}` });
check("伪造 pms_user Cookie 被拒（跳登录页）", rFakeUser.status === 307 && rFakeUser.location.includes("/login"), `got ${rFakeUser.status} ${rFakeUser.location}`);

/* 4 伪造 pms_sid */
const rFakeSid = await req("/rooms", { cookie: `pms_sid=deadbeefdeadbeefdeadbeef` });
check("伪造 pms_sid 被拒", rFakeSid.status === 307 && rFakeSid.location.includes("/login"), `got ${rFakeSid.status}`);

/* 5 删除 session 后失效 */
const c1 = good.cookies.join("; ");
const rOk = await req("/rooms", { cookie: c1 });
check("真实 session 可访问 /rooms", rOk.status === 200, `got ${rOk.status}`);
const sid = (good.cookies.find((c) => c.startsWith("pms_sid=")) || "").split("=")[1];
db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
const rGone = await req("/rooms", { cookie: c1 });
check("删除 session 后 Cookie 立即失效", rGone.status === 307 && rGone.location.includes("/login"), `got ${rGone.status}`);

/* 6 停用用户后旧 session 失效 */
const again = await login("front", "123456");
const frontCookie = again.cookies.join("; ");
const rBefore = await req("/rooms", { cookie: frontCookie });
check("前台登录后可访问 /rooms", rBefore.status === 200, `got ${rBefore.status}`);
db.prepare(`UPDATE users SET status = 0 WHERE username = 'front'`).run();
const rAfter = await req("/rooms", { cookie: frontCookie });
check("停用用户后旧 session 立即失效", rAfter.status === 307 && rAfter.location.includes("/login"), `got ${rAfter.status}`);
db.prepare(`UPDATE users SET status = 1 WHERE username = 'front'`).run();

/*
 * 7 密码字段非明文
 *
 * 整改指令 8.1/8.3 之后：密码在 password_hash，旧 password 列已清空（空串）。
 * 两道都要断言：
 *   · password_hash 全是 scrypt 哈希
 *   · password 列没有任何明文残留
 */
const rows = db.prepare(`SELECT username, password, password_hash FROM users`).all();
const allHashed = rows.every((r) => String(r.password_hash ?? "").startsWith("scrypt$"));
check("password_hash 均为 scrypt 哈希", allHashed, JSON.stringify(rows.map((r) => r.username)));

const plainLeft = rows.filter((r) => String(r.password ?? "") !== "").length;
check(
  "旧 password 列已清空（无明文残留）",
  plainLeft === 0,
  rows.filter((r) => String(r.password ?? "") !== "").map((r) => r.username).join(",")
);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
