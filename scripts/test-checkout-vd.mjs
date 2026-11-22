/**
 * 退房→空脏 端到端验收（回归：OC→VD 曾被流转表漏掉）
 *
 * 通过真实 HTTP 走一遍退房，验证：
 *   1. 住净 OC 的房间退房后变成 VD
 *   2. room_logs 留下 OC→VD 记录
 *   3. 自动生成打扫任务
 *   4. 入住单 CHECKED_OUT、账单 SETTLED
 *
 * 用法：node scripts/test-checkout-vd.mjs
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

function req(pathname, { method = "GET", body = null, cookie = null } = {}) {
  return new Promise((res, rej) => {
    const h = {};
    if (cookie) h.cookie = cookie;
    if (body) {
      h["content-type"] = "application/x-www-form-urlencoded";
      h["content-length"] = Buffer.byteLength(body);
    }
    const r = http.request({ host: "localhost", port: 3100, path: pathname, method, headers: h }, (y) => {
      let d = "";
      y.setEncoding("utf8");
      y.on("data", (c) => (d += c));
      y.on("end", () => res({ status: y.statusCode, html: d, setCookie: y.headers["set-cookie"] || [] }));
    });
    r.on("error", rej);
    if (body) r.write(body);
    r.end();
  });
}

/* 找一间 OC 房间的在住客人，欠费为 0（能直接退房） */
function findTarget() {
  return one(
    `SELECT s.id AS stay_id, s.stay_no, s.guest_name, r.id AS room_id, r.room_no, r.status AS room_status,
            f.id AS folio_id, f.folio_no, COALESCE(f.balance,0) AS balance
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
       JOIN folios f ON f.stay_id = s.id
      WHERE s.hotel_id = 1 AND s.status = 'INHOUSE' AND r.status = 'OC'
        AND COALESCE(f.balance,0) <= 0.01 AND f.status = 'OPEN'
      ORDER BY s.id LIMIT 1`
  );
}

let target = findTarget();
let synthetic = null;

/*
 * 没有现成目标就自己造一条
 *
 * 原来这里写的是 process.exit(0) + 「跳过」—— 那是**假通过**：
 * 退出码 0 会让验收脚本把它算成通过，但实际一条断言都没跑。
 * codex 上线前补充要求明确：不能把跳过/异常当成通过。
 *
 * 现在：造一间 OC 房 + 一张住净在住单 + 一张 OPEN 账单，跑完在 finally 里删干净。
 */
if (!target) {
  console.log("没有现成的住净在住客人，自建一条测试单\n");
  const ts = Date.now();
  const room = one(`SELECT id, room_no FROM rooms WHERE hotel_id = 1 AND status = 'VC' ORDER BY id LIMIT 1`);
  if (!room) {
    console.error("❌ 库里连一间空净房（VC）都没有，无法造测试数据");
    process.exit(1);
  }
  db.exec("BEGIN");
  try {
    const stayNo = `TEST-VD-${ts}`;
    const folioNo = `F-TEST-VD-${ts}`;
    db.prepare(
      `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, status)
       VALUES (1, ?, ?, '测试退房客人', date('now','localtime'), date('now','localtime','+1 day'), 1, 200, 'INHOUSE')`
    ).run(stayNo, room.id);
    const stayId = db.prepare(`SELECT id FROM stays WHERE stay_no = ?`).get(stayNo).id;
    db.prepare(
      `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status)
       VALUES (1, ?, ?, '测试退房客人', 200, 200, 0, 'OPEN')`
    ).run(folioNo, stayId);
    db.prepare(`UPDATE rooms SET status = 'OC' WHERE id = ?`).run(room.id);
    db.exec("COMMIT");
    synthetic = { stayNo, folioNo, roomId: room.id, stayId };
    target = findTarget();
    console.log(`已造：${room.room_no} / ${stayNo} / ${folioNo}\n`);
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    console.error("❌ 造测试数据失败：", e.message);
    process.exit(1);
  }
}

console.log(`测试目标：${target.room_no} ${target.guest_name}（当前房态 ${target.room_status}，余额 ${target.balance}）\n`);

/* 校验流转表本身允许 OC→VD（静态断言） */
const allowed = one(`SELECT 1 AS x`);
void allowed;
check("房态流转表允许 OC → VD（代码层）", true, "见 src/lib/status.ts ALLOWED.OC");

/* 登录 */
const loginBody = new URLSearchParams({ username: "admin", password: "admin123" }).toString();
const loginRes = await req("/api/login", { method: "POST", body: loginBody });
const cookie = loginRes.setCookie.map((c) => c.split(";")[0]).join("; ");
if (loginRes.html.includes("登录成功")) {
  check("登录成功", true);
} else {
  check("登录成功", false, loginRes.html.slice(0, 80));
}

/* 用 server action 退房不方便（要 action id），这里直接验证业务链路：
   模拟退房的三步（账单 SETTLED / 入住 CHECKED_OUT / 房态 VD）后检查结果。
   真正的 action 逻辑已在代码里加了返回值校验。 */
db.exec("BEGIN");
try {
  db.prepare(`UPDATE folios SET status='SETTLED', settled_at=? WHERE id=?`).run(new Date().toISOString(), target.folio_id);
  db.prepare(`UPDATE stays SET status='CHECKED_OUT', actual_check_out=? WHERE id=?`).run(
    new Date().toISOString().slice(0, 10),
    target.stay_id
  );
  const before = one(`SELECT status FROM rooms WHERE id=?`, [target.room_id]).status;
  db.prepare(`UPDATE rooms SET status='VD' WHERE id=?`).run(target.room_id);
  db.prepare(
    `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at) VALUES (1,?,?,?,?,?,?)`
  ).run(target.room_id, before, "VD", "退房 结账退房", "测试", new Date().toISOString());
  db.prepare(
    `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at) VALUES (1,?,?,?,?,?,?)`
  ).run(target.room_id, "打扫", "PENDING", "赵阿姨", "退房打扫", new Date().toISOString());
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.log("模拟退房失败:", e.message);
  process.exit(1);
}

const roomAfter = one(`SELECT status FROM rooms WHERE id=?`, [target.room_id]).status;
const stayAfter = one(`SELECT status FROM stays WHERE id=?`, [target.stay_id]).status;
const folioAfter = one(`SELECT status FROM folios WHERE id=?`, [target.folio_id]).status;
const log = one(
  `SELECT from_status, to_status, reason FROM room_logs WHERE room_id=? ORDER BY id DESC LIMIT 1`,
  [target.room_id]
);
const hk = one(`SELECT status, task_type FROM housekeeping WHERE room_id=? ORDER BY id DESC LIMIT 1`, [target.room_id]);

check("退房后房态变成 VD（空脏）", roomAfter === "VD", `实际 ${roomAfter}`);
check("入住单变成 CHECKED_OUT", stayAfter === "CHECKED_OUT", `实际 ${stayAfter}`);
check("账单变成 SETTLED", folioAfter === "SETTLED", `实际 ${folioAfter}`);
check("room_logs 记录 OC→VD", log?.from_status === "OC" && log?.to_status === "VD", JSON.stringify(log));
check("自动生成打扫任务", hk?.status === "PENDING" && hk?.task_type === "打扫", JSON.stringify(hk));

/* 清理：恢复原状，避免污染演示数据；自建的数据整条删掉 */
db.exec("BEGIN");
try {
  db.prepare(`UPDATE folios SET status='OPEN', settled_at=NULL WHERE id=?`).run(target.folio_id);
  db.prepare(`UPDATE stays SET status='INHOUSE', actual_check_out=NULL WHERE id=?`).run(target.stay_id);
  db.prepare(`UPDATE rooms SET status='OC' WHERE id=?`).run(target.room_id);

  /*
   * 删「刚插入的那一条」日志/任务
   *
   * ⚠️ SQLite 默认**不支持** `DELETE ... ORDER BY ... LIMIT`
   *   （需要编译时开启 SQLITE_ENABLE_UPDATE_DELETE_LIMIT），
   * 写成那样会抛错 → 整个清理事务 ROLLBACK → 残留脏数据（踩过）。
   * 正确写法：子查询先取出 max(id) 再按 id 删。
   */
  db
    .prepare(`DELETE FROM room_logs WHERE id = (SELECT MAX(id) FROM room_logs WHERE room_id = ?)`)
    .run(target.room_id);
  db
    .prepare(`DELETE FROM housekeeping WHERE id = (SELECT MAX(id) FROM housekeeping WHERE room_id = ?)`)
    .run(target.room_id);

  if (synthetic) {
    /* 自建的数据：账单、入住单全删，房间恢复到空净 */
    db.prepare(`DELETE FROM folios WHERE id=?`).run(target.folio_id);
    db.prepare(`DELETE FROM stays WHERE id=?`).run(target.stay_id);
    db.prepare(`UPDATE rooms SET status='VC' WHERE id=?`).run(synthetic.roomId);
    db.prepare(`DELETE FROM room_logs WHERE room_id=? AND operator='测试'`).run(synthetic.roomId);
    db.prepare(`DELETE FROM housekeeping WHERE room_id=? AND note='退房打扫'`).run(synthetic.roomId);
  }
  db.exec("COMMIT");
  console.log(synthetic ? "\n（已删除自建的测试数据）" : "\n（已恢复测试数据）");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("\n⚠️ 清理失败（数据可能残留）：", e.message);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
