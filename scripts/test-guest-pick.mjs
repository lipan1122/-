#!/usr/bin/env node
/**
 * 入住表单「选择已有客史」验收（上线评审 P1）
 *
 * ── 缺陷 ──
 * 服务端 `checkInAction` 早就支持 `guest_id_<i>`（逐间指定客史），但入住表单
 * 没有对应选择字段：同名客人（两份「张伟」档案）在前台没有任何区分手段，
 * 只能碰运气填证件号/手机号；填错就把入住单、历史账单、会员储值挂到别人头上。
 *
 * ── 本次修复 ──
 *   1. 新增 `searchGuestsAction(query)`：按证件号 / 手机号 / 姓名查客史，
 *      候选**服务端脱敏**（手机 138****1234、证件 3301********1234），最多 10 条，
 *      权限 guest.view_sensitive（admin / frontdesk）；
 *   2. `CheckInForm` 每行住客加「查老客」：输满手机号/身份证自动查，命中 1 条给
 *      「用这个」，命中多条给脱敏候选列表，选中后表单带隐藏字段 `guest_id_<i>`；
 *      不选则不带该字段（服务端按新客建档 / 唯一口径匹配）。
 *
 * ── 本脚本验的东西 ──
 *   A. 静态：检索 action、脱敏、10 条上限、权限点、表单隐藏字段与旧机制 `guest_id_${gi}` 都在
 *   B. 同名两位客人（不同身份证）：能按姓名搜到多条、按手机号/证件精确命中唯一一条
 *   C. 分别用 guest_id_0 指定 A / B 入住 → stays.guest_id 分别正确，账单互不串
 *   D. 会员储值归属（member_wallet_ledger.member_id === stays.guest_id）：A 扣款不影响 B
 *   E. 不选客史：全新客人 → 新客建档；同名 + 给证件号 → 自动命中老客；同名 + 不给身份 → 拒绝
 *   F. 脱敏：返回值里没有完整手机号 / 身份证（连 11 位以上连续数字都没有）
 *   G. 权限：cashier 被拒、frontdesk 放行、未登录被拒
 *
 * 全程在 `data/pms.db --VACUUM INTO--> .tmp/guest-pick-<时间戳>/data/pms.db` 副本上跑，
 * 真库只读；副本目录进程退出时删除。真调 src 里的 `searchGuestsAction` / `checkInAction`。
 *
 * 用法：node scripts/test-guest-pick.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */

import fs from "node:fs";
import path from "node:path";

import { createActionHarness, createChecker, isOk, msgOf } from "./helpers/action-harness.mjs";

const { check, section, done } = createChecker();
const h = await createActionHarness({ tag: "guest-pick" });
const { one, all, run, invoke, localDate, hotelId: HOTEL } = h;

const TODAY = localDate(0);
const TOMORROW = localDate(1);
const STAMP = String(h.stamp);
/** 读源码做静态断言（跟随 h.srcRoot，便于 mutation 自检） */
const readSrc = (rel) => fs.readFileSync(path.join(h.srcRoot, ...rel.split("/")), "utf8");
/** 截出某个 export 函数的函数体（到下一个 export 为止） */
function funcBody(src, name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}

let failed = 0;
try {
  /* ============================================================ 0. 装载真实实现 */
  const frontdesk = await h.importModule("app/(main)/frontdesk/actions.ts");
  const walletLib = await h.importModule("lib/member-wallet.ts");

  section("一、静态守卫：检索 action / 脱敏 / 上限 / 权限 / 表单隐藏字段");
  {
    const frontSrc = readSrc("app/(main)/frontdesk/actions.ts");
    const formSrc = readSrc("components/CheckInForm.tsx");
    const searchBody = funcBody(frontSrc, "searchGuestsAction");
    const checkinBody = funcBody(frontSrc, "checkInAction");

    check("新增 searchGuestsAction 服务端检索（真实导出，可调用）", typeof frontdesk.searchGuestsAction === "function");
    check("检索函数体存在且不写库（只有 SELECT，没有 INSERT/UPDATE/DELETE）", searchBody.length > 0 && !/^\s*(INSERT|UPDATE|DELETE)\s/im.test(searchBody.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n")));
    check("候选上限 10 条（GUEST_SEARCH_LIMIT = 10）", /GUEST_SEARCH_LIMIT\s*=\s*10/.test(frontSrc));
    check("检索要求 guest.view_sensitive 权限（与 guests 页/导出接口同口径）", /requirePermission\(\s*"guest\.view_sensitive"\s*\)/.test(searchBody));
    check("查询按 hotel_id 限定（不跨店串档）", /g\.hotel_id\s*=\s*\?/.test(searchBody) && /AND\s+COALESCE\(g\.deleted,\s*0\)\s*=\s*0/.test(searchBody));
    check("手机号脱敏：首 3 + 末 4，中间打码", /function maskMobile/.test(frontSrc) && /slice\(0, 3\)\}\*{4}\$\{v\.slice\(-4\)/.test(frontSrc));
    check("身份证脱敏：首 4 + 末 4，中间 8 位打码", /function maskIdNo/.test(frontSrc) && /"\*"\.repeat\(8\)/.test(frontSrc));
    check("返回给客户端的只有脱敏字段（mobileMasked / idNoMasked）", /mobileMasked:\s*maskMobile/.test(searchBody) && /idNoMasked:\s*maskIdNo/.test(searchBody));
    check("LIKE 通配符已转义（输入 % 不会列出全店客史）", /likeEscape/.test(searchBody) && /ESCAPE '!'/.test(searchBody));

    /* 旧机制没被破坏：test-guest-id-backfill 的静态断言依赖下面这行原样保留 */
    check("服务端仍保留 guest_id_${gi} 读取（原有机制未被改坏）", /readNum\(formData, `guest_id_\$\{gi\}`\)/.test(checkinBody));

    check("入住表单引入 searchGuestsAction", /searchGuestsAction/.test(formSrc));
    check("入住表单渲染隐藏字段 guest_id_<i>", /name=\{`guest_id_\$\{[A-Za-z]+\}`\}/.test(formSrc));
    check("隐藏字段后缀按「有名住客」计数（与 checkInAction 的 namedGuests 对齐）", /namedIndex/.test(formSrc) && /filter\(\(g\) => g\.name\.trim\(\)\)/.test(formSrc));
    check("选中老客时显示「用这个」按钮", /用这个/.test(formSrc));
    check("多条候选只展示脱敏字段（mobileMasked / idNoMasked）", /mobileMasked/.test(formSrc) && /idNoMasked/.test(formSrc));
    check("输入手机号/身份证自动查客史（防抖 setTimeout + 形状校验）", /setTimeout\(/.test(formSrc) && /ID_NO_SHAPE/.test(formSrc) && /MOBILE_SHAPE/.test(formSrc));
    check("改动身份字段会清掉已选客史（避免改完身份证仍挂旧客史）", /clearPick\(rowKey\)/.test(formSrc));
  }

  /* ============================================================ 1. 造数据 */
  section("二、造数：同名两位客人（不同身份证）+ 空房");
  const rt = h.createRoomType({ maxOccupancy: 2, basePrice: 300, name: "客史选择验收房型" });
  const rooms = h.createRooms(6, { roomTypeId: rt, status: "VC", prefix: "GST" });
  /* 多住客用例需要能住 3 人的房型（上面那档 max_occupancy=2 会被超员校验拦下） */
  const rtMulti = h.createRoomType({ maxOccupancy: 4, basePrice: 300, name: "多住客验收房型" });
  const multiRooms = h.createRooms(2, { roomTypeId: rtMulti, status: "VC", prefix: "MUL" });
  check("自建房型 + 6 间空净房 + 2 间多人房", Number.isFinite(rt) && rt > 0 && rooms.length === 6 && multiRooms.length === 2);

  let guestSeq = 0;
  function insertGuest({ name, mobile = null, idNo = null, vip = 0 }) {
    guestSeq += 1;
    return Number(
      run(
        `INSERT INTO guests (hotel_id, name, gender, id_type, id_no, mobile, vip_level, blacklist, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [HOTEL, name, "男", "身份证", idNo, mobile, vip, 0, new Date().toISOString()]
      ).lastInsertRowid
    );
  }

  /* 同名「张伟」：两份不同身份证/手机号。库里可能已有历史「张伟」档案，断言只看这两位的 id */
  const A_ID = `11010119900101${STAMP.slice(-4)}`;
  const B_ID = `11010119900202${STAMP.slice(-4)}`;
  const A_MOBILE = `138${STAMP.slice(-8)}`;
  const B_MOBILE = `139${STAMP.slice(-8)}`;
  const DUP_NAME = "张伟";
  const guestA = insertGuest({ name: DUP_NAME, mobile: A_MOBILE, idNo: A_ID, vip: 2 });
  const guestB = insertGuest({ name: DUP_NAME, mobile: B_MOBILE, idNo: B_ID });
  /* 第三位同名客人：只用于「同名多条 + 只给证件号 → 唯一口径自动命中」这一条（A 已入住，不能重复开房） */
  const C_ID = `11010119900303${STAMP.slice(-4)}`;
  const C_MOBILE = `136${STAMP.slice(-8)}`;
  const guestC = insertGuest({ name: DUP_NAME, mobile: C_MOBILE, idNo: C_ID });
  check("两位同名客人已建档（不同身份证/手机号）", guestA > 0 && guestB > 0 && guestA !== guestB, `#${guestA} / #${guestB}`);

  /* ============================================================ 2. 检索 */
  section("三、客史检索：同名多条 / 号码精确命中 / 脱敏");
  const byName = await frontdesk.searchGuestsAction(DUP_NAME);
  const nameIds = byName.ok ? byName.guests.map((g) => g.id) : [];
  const candA = byName.ok ? byName.guests.find((g) => g.id === guestA) : undefined;
  const candB = byName.ok ? byName.guests.find((g) => g.id === guestB) : undefined;
  check("按姓名搜到多条同名候选（≥2）", byName.ok === true && nameIds.length >= 2, JSON.stringify(byName).slice(0, 160));
  check("两位同名验收客人都在候选里", Boolean(candA) && Boolean(candB));
  check("同名候选 matchedBy = name", candA?.matchedBy === "name" && candB?.matchedBy === "name");
  check("候选不超过 10 条", nameIds.length <= 10, `${nameIds.length} 条`);

  const byMobile = await frontdesk.searchGuestsAction(A_MOBILE);
  check(
    "按手机号精确命中唯一一条（就是 A）",
    byMobile.ok === true && byMobile.guests.length === 1 && byMobile.guests[0].id === guestA,
    JSON.stringify(byMobile).slice(0, 160)
  );
  check("手机命中 matchedBy = mobile", byMobile.ok === true && byMobile.guests[0]?.matchedBy === "mobile");

  const byIdNo = await frontdesk.searchGuestsAction(A_ID);
  check(
    "按身份证号精确命中唯一一条（就是 A）",
    byIdNo.ok === true && byIdNo.guests.length === 1 && byIdNo.guests[0].id === guestA,
    JSON.stringify(byIdNo).slice(0, 160)
  );
  check("证件命中 matchedBy = id_no", byIdNo.ok === true && byIdNo.guests[0]?.matchedBy === "id_no");

  const byTail = await frontdesk.searchGuestsAction(B_MOBILE.slice(-4));
  check(
    "只报手机后 4 位也能搜到（tail 匹配）",
    byTail.ok === true && byTail.guests.some((g) => g.id === guestB),
    JSON.stringify(byTail).slice(0, 160)
  );

  section("四、脱敏：返回值里没有任何完整手机号 / 身份证");
  {
    const raw = JSON.stringify(byName);
    check("返回值包含完整手机号 A → 失败", !raw.includes(A_MOBILE), "泄露 A 手机号");
    check("返回值包含完整手机号 B → 失败", !raw.includes(B_MOBILE), "泄露 B 手机号");
    check("返回值包含完整身份证 A → 失败", !raw.includes(A_ID), "泄露 A 证件号");
    check("返回值包含完整身份证 B → 失败", !raw.includes(B_ID), "泄露 B 证件号");
    check("返回值里没有 11 位以上连续数字（手机/证件原文的哨兵）", !/\d{11,}/.test(raw), (raw.match(/\d{11,}/) ?? [""])[0]);
    check(
      "手机号按 138****1234 形式展示",
      candA?.mobileMasked === `${A_MOBILE.slice(0, 3)}****${A_MOBILE.slice(-4)}`,
      candA?.mobileMasked
    );
    check(
      "身份证按 3301********1234 形式展示（中间 8 位打码）",
      candA?.idNoMasked === `${A_ID.slice(0, 4)}********${A_ID.slice(-4)}`,
      candA?.idNoMasked
    );
    check("脱敏字段里仍保留可核对的尾号（末 4 位一致）", candA?.mobileMasked.endsWith(A_MOBILE.slice(-4)) && candA?.idNoMasked.endsWith(A_ID.slice(-4)));
  }

  section("五、检索边界：空查询 / 短查询 / 通配符 / 10 条上限");
  {
    const empty = await frontdesk.searchGuestsAction("   ");
    check("空查询返回空列表（不查库、不报错）", empty.ok === true && empty.guests.length === 0);
    const oneChar = await frontdesk.searchGuestsAction("张");
    check("1 位查询返回空列表（避免整表扫描）", oneChar.ok === true && oneChar.guests.length === 0);
    const percent = await frontdesk.searchGuestsAction("%%");
    check("通配符 % 被转义，不会列出全店客史", percent.ok === true && percent.guests.length === 0, `${percent.ok ? percent.guests.length : percent.error} 条`);

    const limitName = `限额客${STAMP}`;
    for (let i = 0; i < 12; i += 1) insertGuest({ name: limitName });
    const limited = await frontdesk.searchGuestsAction(limitName);
    check("同名 12 份档案只返回 10 条（上限生效）", limited.ok === true && limited.guests.length === 10, `${limited.ok ? limited.guests.length : limited.error} 条`);
  }

  /* ============================================================ 3. 入住归属 */
  section("六、同名两位客人分别入住：guest_id_<i> 指定谁就挂谁");
  const baseForm = {
    mode: "day",
    check_in_date: TODAY,
    check_out_date: TOMORROW,
    nights: 1,
    rate_code: "门市价",
    pay_type: "到店付款",
  };
  async function checkIn({ roomId, name, mobile = "", idNo = "", guestId = null, deposit = 0 }) {
    const fields = {
      ...baseForm,
      room_id: String(roomId),
      guest_count: "1",
      guest_name_0: name,
      guest_mobile_0: mobile,
      guest_id_type_0: "身份证",
      guest_id_no_0: idNo,
      guest_gender_0: "男",
      guest_breakfast_0: "0",
      deposit: String(deposit),
    };
    if (guestId != null) fields.guest_id_0 = String(guestId);
    return invoke(frontdesk.checkInAction, fields);
  }
  const stayOfRoom = (roomId) =>
    one(`SELECT id, guest_id, guest_name, mobile, room_id, status FROM stays WHERE hotel_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL, roomId]);

  const resA = await checkIn({ roomId: rooms[0].id, name: DUP_NAME, mobile: A_MOBILE, idNo: A_ID, guestId: guestA });
  check("A 用 guest_id_0 办理入住成功", isOk(resA), msgOf(resA));
  const stayA = stayOfRoom(rooms[0].id);
  check("A 的入住单 stays.guest_id 指向 A 的客史", Number(stayA?.guest_id) === guestA, `guest_id=${stayA?.guest_id} 期望 ${guestA}`);

  const resB = await checkIn({ roomId: rooms[1].id, name: DUP_NAME, mobile: B_MOBILE, idNo: B_ID, guestId: guestB });
  check("B 用 guest_id_0 办理入住成功（同名不影响）", isOk(resB), msgOf(resB));
  const stayB = stayOfRoom(rooms[1].id);
  check("B 的入住单 stays.guest_id 指向 B 的客史", Number(stayB?.guest_id) === guestB, `guest_id=${stayB?.guest_id} 期望 ${guestB}`);
  check("两张入住单挂的是不同客史（同名已被区分开）", Number(stayA?.guest_id) !== Number(stayB?.guest_id));

  /* 同名多条 + 只给其中一位的证件号、不选客史 → 唯一口径（证件号）自动命中该客史，不是新建 */
  const resAuto = await checkIn({ roomId: rooms[2].id, name: DUP_NAME, mobile: "", idNo: C_ID });
  check("同名多条但不选客史、提供 C 的身份证号 → 自动命中", isOk(resAuto), msgOf(resAuto));
  const stayAuto = stayOfRoom(rooms[2].id);
  check("自动命中的入住单 guest_id = C", Number(stayAuto?.guest_id) === guestC, `guest_id=${stayAuto?.guest_id} 期望 ${guestC}`);
  check(
    "没有因此多建一份同名客史",
    Number(one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ? AND name = ? AND id_no = ?`, [HOTEL, DUP_NAME, C_ID])?.c ?? 0) === 1
  );

  section("六·补、多住客含空行：guest_id_<i> 的后缀必须是「有名住客序号」，不是行号");
  {
    const E_ID = `11010119900404${STAMP.slice(-4)}`;
    const E_MOBILE = `135${STAMP.slice(-8)}`;
    const guestE = insertGuest({ name: DUP_NAME, mobile: E_MOBILE, idNo: E_ID });
    const dupCountBefore = Number(
      one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ? AND name = ?`, [HOTEL, DUP_NAME])?.c ?? -1
    );
    const mainName = `主客验收${STAMP.slice(-6)}`;
    const mainIdNo = `11010119950404${STAMP.slice(-4)}`;
    const multiFields = {
      ...baseForm,
      room_id: String(multiRooms[0].id),
      guest_count: "3",
      guest_name_0: mainName,
      guest_mobile_0: `134${STAMP.slice(-8)}`,
      guest_id_no_0: mainIdNo,
      guest_id_type_0: "身份证",
      guest_gender_0: "男",
      /* 第 2 行留空：服务端按 namedGuests 过滤后，它不占序号 */
      guest_name_1: "",
      guest_name_2: DUP_NAME,
      guest_gender_2: "男",
    };
    const resMulti = await invoke(frontdesk.checkInAction, { ...multiFields, guest_id_1: String(guestE) });
    check("含空白行：按「有名住客序号」提交 guest_id_1 → 入住成功", isOk(resMulti), msgOf(resMulti));
    const stayMulti = stayOfRoom(multiRooms[0].id);
    const mainGuest = one(`SELECT id FROM guests WHERE hotel_id = ? AND id_no = ?`, [HOTEL, mainIdNo]);
    check(
      "主住客仍是有名住客第 0 位（表单第 1 行）",
      Number(stayMulti?.guest_id) === Number(mainGuest?.id),
      `guest_id=${stayMulti?.guest_id}`
    );
    check(
      "第 3 行同名住客按 guest_id_1 关联到既有档案，没有新建同名档",
      Number(one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ? AND name = ?`, [HOTEL, DUP_NAME])?.c ?? -1) ===
        dupCountBefore
    );

    /* 反例：若把行号当后缀（第 3 行 → guest_id_2），服务端读不到，必须落回同名歧义拒绝 */
    const wrong = await invoke(frontdesk.checkInAction, {
      ...multiFields,
      room_id: String(multiRooms[1].id),
      guest_name_0: `主客验收B${STAMP.slice(-6)}`,
      guest_mobile_0: `133${STAMP.slice(-8)}`,
      guest_id_no_0: `11010119950505${STAMP.slice(-4)}`,
      guest_id_2: String(guestE),
    });
    check(
      "反例：按行号提交 guest_id_2 不被识别 → 同名歧义拒绝",
      !isOk(wrong) && /同名客史/.test(msgOf(wrong)),
      msgOf(wrong).slice(0, 140)
    );
    check("反例被判拒后没有留下入住单", !stayOfRoom(multiRooms[1].id));
  }

  section("七、历史账单归属：同名两位客人互不串账");
  const foliosOfGuest = (gid) =>
    all(
      `SELECT f.id AS id, f.folio_no AS folioNo, f.guest_name AS guestName, s.guest_id AS stayGuestId
         FROM folios f JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
        WHERE f.hotel_id = ? AND s.guest_id = ?`,
      [HOTEL, gid]
    );
  const staysOfGuest = (gid) =>
    all(`SELECT id, room_id FROM stays WHERE hotel_id = ? AND guest_id = ? ORDER BY id`, [HOTEL, gid]);
  const foliosA = foliosOfGuest(guestA);
  const foliosB = foliosOfGuest(guestB);
  const folioAIds = foliosA.map((f) => f.id);
  const folioBIds = foliosB.map((f) => f.id);
  check("A 名下恰好有 1 张账单（本次入住）", foliosA.length === 1, JSON.stringify(foliosA));
  check("B 名下恰好有 1 张账单（本次入住）", foliosB.length === 1, JSON.stringify(foliosB));
  check("A 的账单不是 B 的账单（账单 ID 无交集）", folioAIds.every((id) => !folioBIds.includes(id)), `${folioAIds} vs ${folioBIds}`);
  check(
    "两张账单的 guest_name 都是「张伟」——所以只能靠 guest_id 归属，这正是本次修复点",
    foliosA[0]?.guestName === DUP_NAME && foliosB[0]?.guestName === DUP_NAME
  );
  check("按 guest_id 查 A 的账单，不会漏进 B 的房间", staysOfGuest(guestA).every((s) => s.room_id !== rooms[1].id));
  check("按 guest_id 查 B 的账单，不会漏进 A 的房间", staysOfGuest(guestB).every((s) => s.room_id !== rooms[0].id));

  /* 检索里的「入住次数」与账单归属同源（stays.guest_id），入住后应为 1 */
  const after = await frontdesk.searchGuestsAction(A_MOBILE);
  check(
    "入住后检索显示该客史「入住 1 次」",
    after.ok === true && after.guests[0]?.stayCount === 1,
    JSON.stringify(after).slice(0, 160)
  );

  /* ============================================================ 4. 会员储值归属 */
  section("八、会员储值归属：同名两位的储值账户互不影响");
  {
    const rechargeA = walletLib.rechargeWallet(HOTEL, guestA, 500, {
      operator: "验收",
      remark: "客史选择验收-A",
      requestId: `gp-recharge-a-${STAMP}`,
    });
    const rechargeB = walletLib.rechargeWallet(HOTEL, guestB, 800, {
      operator: "验收",
      remark: "客史选择验收-B",
      requestId: `gp-recharge-b-${STAMP}`,
    });
    check("A 充值 500 成功", !("error" in rechargeA), JSON.stringify(rechargeA));
    check("B 充值 800 成功", !("error" in rechargeB), JSON.stringify(rechargeB));
    check("A 储值余额 500", walletLib.getWalletBalance(HOTEL, guestA) === 500, String(walletLib.getWalletBalance(HOTEL, guestA)));
    check("B 储值余额 800", walletLib.getWalletBalance(HOTEL, guestB) === 800, String(walletLib.getWalletBalance(HOTEL, guestB)));

    /* 模拟收银台「储值卡扣房费」的链路：folios → stays → guest_id → consumeWallet */
    const charged = one(
      `SELECT s.guest_id AS guestId, f.id AS folioId
         FROM folios f JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
        WHERE f.id = ? AND f.hotel_id = ?`,
      [folioAIds[0], HOTEL]
    );
    check("从 A 的账单能 join 到 A 的 guest_id（储值扣款找人的前提）", Number(charged?.guestId) === guestA, JSON.stringify(charged));
    const consume = walletLib.consumeWallet(HOTEL, Number(charged?.guestId), 200, {
      operator: "验收",
      remark: "验收-扣房费 200",
      requestId: `gp-consume-${STAMP}`,
      refType: "folio",
      refId: Number(charged?.folioId),
    });
    check("A 储值扣 200 成功", !("error" in consume), JSON.stringify(consume));
    check("扣款后 A 余额 500 → 300", walletLib.getWalletBalance(HOTEL, guestA) === 300, String(walletLib.getWalletBalance(HOTEL, guestA)));
    check("同名 B 的储值余额不受影响（仍是 800）", walletLib.getWalletBalance(HOTEL, guestB) === 800, String(walletLib.getWalletBalance(HOTEL, guestB)));
    const ledgerA = one(
      `SELECT member_id AS memberId, biz_type AS bizType, amount, ref_type AS refType, ref_id AS refId
         FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`,
      [HOTEL, `gp-consume-${STAMP}`]
    );
    check(
      "储值流水记在 A 的 member_id 上，并关联到 A 的账单",
      Number(ledgerA?.memberId) === guestA && ledgerA?.bizType === "CONSUME" && Number(ledgerA?.amount) === -200 && Number(ledgerA?.refId) === Number(folioAIds[0]),
      JSON.stringify(ledgerA)
    );
    check(
      "储值账户 member_id 与入住单 stays.guest_id 完全一致（同一客人）",
      Number(ledgerA?.memberId) === Number(stayA?.guest_id) && Number(ledgerA?.memberId) !== Number(stayB?.guest_id)
    );
  }

  /* ============================================================ 5. 不选客史 */
  section("九、不选客史：全新客人 → 新客建档");
  {
    const newName = `新客验收${STAMP.slice(-6)}`;
    const newMobile = `137${STAMP.slice(-8)}`;
    const newIdNo = `11010119950202${STAMP.slice(-4)}`;
    const before = Number(one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ?`, [HOTEL])?.c ?? 0);
    const res = await checkIn({ roomId: rooms[3].id, name: newName, mobile: newMobile, idNo: newIdNo });
    check("不选客史、全新身份信息 → 入住成功", isOk(res), msgOf(res));
    const stay = stayOfRoom(rooms[3].id);
    const created = one(`SELECT id, name, mobile, id_no AS idNo FROM guests WHERE hotel_id = ? AND id_no = ?`, [HOTEL, newIdNo]);
    const afterCount = Number(one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ?`, [HOTEL])?.c ?? 0);
    check("新客已建档（guests +1）", Boolean(created) && afterCount === before + 1, `${before} → ${afterCount}`);
    check("入住单挂到新建的客史", Number(stay?.guest_id) === Number(created?.id), `guest_id=${stay?.guest_id} 新客=${created?.id}`);
    check("新客档里的手机号/证件号就是表单填的值", created?.mobile === newMobile && created?.idNo === newIdNo);
  }

  section("十、同名不选客史且不给身份 → 拒绝，并按 guest_id_<i> 重试成功");
  {
    const rejected = await checkIn({ roomId: rooms[4].id, name: DUP_NAME });
    const err = msgOf(rejected);
    check("同名多条 + 未指定客史 → 拒绝办理", !isOk(rejected) && Boolean(err), err.slice(0, 120));
    check("拒绝文案指明同名歧义并给出 guest_id_0 出路", /份同名客史/.test(err) && /guest_id_0/.test(err), err.slice(0, 160));
    check("被拒后没有留下入住单", !stayOfRoom(rooms[4].id));
    check(
      "被拒后没有偷偷新建同名客史",
      Number(one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ? AND name = ? AND id_no = ?`, [HOTEL, DUP_NAME, B_ID])?.c ?? 0) === 1
    );

    const retry = await checkIn({ roomId: rooms[5].id, name: DUP_NAME, guestId: guestB });
    check("带 guest_id_0=B 重试 → 成功", isOk(retry), msgOf(retry));
    check("重试后的入住单挂到 B 的客史", Number(stayOfRoom(rooms[5].id)?.guest_id) === guestB);
  }

  /* ============================================================ 6. 权限 */
  section("十一、权限：只有 guest.view_sensitive（admin / frontdesk）能查客史");
  {
    const mkSession = (role, label) => {
      const uname = `gp-${role}-${STAMP}`;
      const uid = Number(
        run(`INSERT INTO users (hotel_id, username, password, real_name, role, status) VALUES (?,?,?,?,?,1)`, [
          HOTEL,
          uname,
          "x",
          label,
          role,
        ]).lastInsertRowid
      );
      const sid = `gp-sid-${role}-${STAMP}`;
      run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
        sid,
        JSON.stringify({ id: uid, username: uname, realName: label, role, hotelId: HOTEL, hotelName: h.hotelName }),
        new Date().toISOString(),
        new Date(Date.now() + 3600 * 1000).toISOString(),
      ]);
      return sid;
    };

    h.useSession(mkSession("cashier", "验收收银"));
    const denied = await frontdesk.searchGuestsAction(DUP_NAME);
    check("cashier 无权限 → 拒绝且不返回任何候选", denied.ok === false && !denied.guests, JSON.stringify(denied));
    check("拒绝文案点名 guest.view_sensitive", denied.ok === false && /guest\.view_sensitive/.test(denied.error), denied.ok ? "" : denied.error);

    h.useSession(mkSession("frontdesk", "验收前台"));
    const allowedFront = await frontdesk.searchGuestsAction(DUP_NAME);
    check("frontdesk 有权限 → 正常返回候选", allowedFront.ok === true && allowedFront.guests.length >= 2);

    h.useSession(null);
    const anon = await frontdesk.searchGuestsAction(DUP_NAME);
    check("未登录 → 拒绝并提示重新登录", anon.ok === false && /登录/.test(anon.error), JSON.stringify(anon));

    h.useSession(h.ADMIN_SID);
    const back = await frontdesk.searchGuestsAction(DUP_NAME);
    check("切回 admin 会话 → 恢复可查", back.ok === true && back.guests.length >= 2);
  }

  /* ============================================================ 7. 真库零写入 */
  section("十二、真库零写入（全程只在副本上跑）");
  check("真库没有本次验收创建的同名客人", h.realCount(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ? AND id_no = ?`, [HOTEL, A_ID]) === 0);
  check("真库没有本次验收的入住单", h.realCount(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND room_id IN (?,?,?)`, [HOTEL, rooms[0].id, rooms[1].id, rooms[2].id]) === 0);
  check("真库没有本次验收的储值流水", h.realCount(`SELECT COUNT(*) AS c FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [HOTEL, `gp-consume-${STAMP}`]) === 0);
  check("副本库在 .tmp 下、真库文件仍是普通文件", fs.existsSync(h.dbPath) && fs.statSync(h.realDb).isFile(), `副本 ${h.dbPath}`);
} catch (e) {
  console.error("❌ 测试执行中断：", e?.stack ?? e);
  failed = 1;
} finally {
  failed = Math.max(failed, done());
  h.dispose();
}

process.exit(failed === 0 ? 0 : 1);
