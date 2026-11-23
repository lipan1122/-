#!/usr/bin/env node
/**
 * 动作层权限验收（55 个 Server Action）
 *
 * ── 为什么要有这个脚本 ──
 * 很多 Server Action 原来只 `await requireUser()`（只校验登录），
 * 前台 / 收银 / 客房账号可以直接构造请求调用越权的写动作。
 * 「补了权限点」不等于「运行时真会拒」：权限点拼错、守卫写在写库之后、
 * 权限点没进 role_permissions、会话里的酒店 id 没校验……静态 grep 都看不出来。
 * 所以本脚本分三段，静态 + 运行时都要过：
 *
 *   一、【静态源码校验】逐模块解析 actions.ts
 *      - 每个导出 action 必须在函数体最前面调用
 *        requirePermission / requirePermissionOrRedirect / requireAdmin，
 *        或是对「已有守卫的内部函数」的直通包装（如 goods 的进货/退货/报废 → applyStockMove）
 *      - 权限点必须存在于 src/lib/session.ts 的 PERMISSIONS 表，并与期望表一致
 *      - 权限校验必须发生在任何写库（run/tx/INSERT/UPDATE/DELETE）之前
 *      - 受限角色必须不在权限点的允许列表里（admin 由 hasPermission 默认全通过）
 *      - ensure*Schema 这类「懒建表」动作必须校验 hotelId 与会话一致（否则能往别家灌种子）
 *      - 权限点在副本库 role_permissions 里的角色集合必须与常量表一致
 *      - 同文件未被本脚本纳入运行时的导出函数，必须仍然有守卫（不静默漏登记）
 *
 *   二、【运行时校验：真调真实 Server Action】—— 本段默认必跑
 *      用 scripts/helpers/action-harness.mjs 的底座：
 *        真库 --VACUUM INTO--> .tmp/<tag>/data/pms.db（真库零写入）
 *        注入 globalThis.__pmsDb + registerHooks 替换 next/* → 动态 import 真实 actions.ts
 *        用副本库 sessions 表造真会话，像页面一样 new FormData() 调 action
 *      每个 action 四步（25 个老 action 之外的本轮 30 个逐个跑）：
 *        ① 无权角色 → 必须被拒（redirect /no-permission?p=<权限点>，或 FORBIDDEN 抛错）
 *        ② 有权角色 → 必须放行（不返回 /no-permission，并核对真实写库副作用）
 *        ③ 副本库给一个原本没权限的角色 **加上** 权限点 → 同一个 action 放行
 *           （证明判断真的走 role_permissions，而不是白名单写死）
 *        ④ 再把那一行权限 **删掉** → 同一个 action 又被拒
 *           （证明「撤销权限后真被拒」，而不是「反正谁都拒」的假通过）
 *
 *   三、【跨酒店隔离】A 店身份不能操作 B 店数据
 *      - ensure*Schema 用别家 hotelId 调用 → FORBIDDEN
 *      - 别的酒店的失物 / 餐券 / 租赁物品 → 查不到、改不动、数据零变化
 *
 *   四、【HTTP 运行时校验，可选】服务在 3100 且构建不旧时，
 *      用 front / cashier / housekeeper 账号登录，以 MPA 表单方式真实 POST 到页面路由。
 *      服务没起 / 构建早于源码 → 跳过并说明原因（--require-http 可要求必须跑）。
 *
 * 用法：
 *   node scripts/test-action-permissions.mjs              # 静态 + 运行时（harness）+ 可选 HTTP
 *   node scripts/test-action-permissions.mjs --no-http    # 不做 HTTP 段（运行时段照样跑）
 *   PMS_REQUIRE_HTTP=1 node scripts/test-action-permissions.mjs
 *   PMS_BASE=http://localhost:3100 node scripts/test-action-permissions.mjs
 *
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */
import fs from "node:fs";
import path from "node:path";

import { createActionHarness } from "./helpers/action-harness.mjs";

const ROOT = process.cwd();
const BASE = process.env.PMS_BASE || "http://localhost:3100";
const NO_HTTP = process.argv.includes("--no-http") || process.env.PMS_NO_HTTP === "1";

/* ============================================================ 期望表 */

/**
 * 老 25 个受检 action（夜审 2 / 预订 15 / 在住 8）。
 * 这些 action 的运行时面由本脚本的 HTTP 段覆盖；harness 段只覆盖 NEW_MODULES。
 */
const MODULES = [
  {
    file: "src/app/(main)/night-audit/actions.ts",
    page: "/night-audit",
    actions: {
      // 夜审：过账全店房费 + 批量 NOSHOW + 重算所有账单 + 写营收汇总 → 仅 admin
      runNightAuditAction: {
        permission: "night_audit.run",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        // 运行时不能拿「有权限的角色」去真跑夜审（会写库），只验证受限角色被拦
        skipAllowedRuntime: true,
        params: {},
      },
      // 第 4 轮 P1-18：撤销夜审（冲正房费 + 还原 NOSHOW + 删营收日报）→ 仅 admin
      undoNightAuditAction: {
        permission: "night_audit.undo",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        skipAllowedRuntime: true,
        params: { reason: "权限测试" },
      },
    },
  },
  {
    file: "src/app/(main)/bookings/actions.ts",
    page: "/bookings",
    actions: {
      createBookingAction: { permission: "booking.create", rejected: ["cashier", "housekeeping"], params: {} },
      cancelBookingAction: { permission: "booking.cancel", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      confirmBookingAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      deleteBookingAction: { permission: "booking.delete", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      batchConfirmBookingsAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchCancelBookingsAction: { permission: "booking.cancel", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchDeleteBookingsAction: { permission: "booking.delete", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchCancelTeamRoomsAction: { permission: "booking.cancel", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchAdjustRateBookingsAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { ids: "999999", rate: "1" } },
      updateBookingRemarkAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      updateOrderRemarkAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      assignRoomAction: { permission: "booking.assign_room", rejected: ["cashier", "housekeeping"], params: { bookingId: 999999, roomIds: "" } },
      // 调价给负数 → 命中「请填写正确的房价」提前返回，无库写入
      adjustPriceAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999, rate: "-1" } },
      // 不传 id → 直接 redirect 返回，无库写入
      freeUpgradeAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: {} },
      joinGroupAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: {} },
    },
  },
  {
    file: "src/app/(main)/inhouse/actions.ts",
    page: "/inhouse",
    actions: {
      extendStayAction: { permission: "checkin.create", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999 } },
      changeRoomAction: { permission: "booking.assign_room", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999, new_room_id: 1 } },
      postRoomChargeAction: { permission: "folio.post_charge", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999 } },
      // 不传参数会去批量补过「昨日在住」的房费 → 只验证受限角色被拦，不让有权限角色真跑
      postAllMissingRoomChargesAction: {
        permission: "folio.post_charge",
        rejected: ["cashier", "housekeeping"],
        skipAllowedRuntime: true,
        params: {},
      },
      requestCancelAction: { permission: "checkin.cancel", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999, reason: "验收探针" } },
      approveCancelAction: { permission: "checkin.cancel", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      rejectCancelAction: { permission: "checkin.cancel", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      convertStayModeAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999, mode: "daily", nights: 1 } },
    },
  },
];

/**
 * 本轮新补权限点的 30 个 action（fix-perm-stock 补了 26 个 + 同文件里另外 4 个
 * 同样有权限点、但从未在本脚本做过运行时验证的写动作）。
 *
 * 字段说明：
 *   permission  期望权限点（"@requireAdmin" 表示只允许管理员）
 *   rejected    必须被拒的角色（同时用于静态「不在允许列表」与运行时拒绝面）
 *   hotelArg    ensure*Schema 的酒店 id 入参 → 静态校验跨酒店守卫
 *   delegateTo  直通包装：函数体只 await 一个内部函数，守卫在被委托的函数里
 *   runtime     运行时真调配置
 *     call      "fd" = 像页面一样传 FormData；"pos" = 位置参数（completeTaskAction(taskId) 这类）
 *     params/args  FormData 字段 / 位置参数，传函数则用运行时上下文（动态 id）
 *     allowed   有权限的角色（第一个用于「放行」断言）
 *     probe     用于「③ 授权后放行 / ④ 撤权后拒绝」对照的角色（构造上不放权限）
 *     effects   放行后核对真实写库副作用（证明不是「只跳过权限校验不干活」）
 *   other      同文件其它导出函数：必须仍有守卫，运行时由对应脚本覆盖（本脚本不重复跑）
 *   delegated  表单包装：只做参数转换并 await 受保护动作，逐个核对「包装没绕开守卫」
 */
const NEW_MODULES = [
  {
    key: "ar",
    file: "src/app/(main)/ar/actions.ts",
    page: "/ar",
    actions: {
      // 懒建表 + 首次写 AR 种子账户：写动作，不能是匿名可调 RPC（选点理由见源码注释）
      ensureArSchema: {
        permission: "cashier.view",
        rejected: ["housekeeping"],
        hotelArg: true,
        runtime: {
          call: "pos",
          args: (c) => [c.hotelId],
          allowed: ["frontdesk"],
          probe: "housekeeping",
          effects: (c) => [
            fx(
              "ensureArSchema 被前台放行后本店 AR 种子账户存在（真建表 + 写种子）",
              (c.h.one(`SELECT COUNT(*) AS n FROM ar_accounts WHERE hotel_id = 1`)?.n ?? 0) > 0
            ),
          ],
        },
      },
    },
    other: {
      postArAction: "scripts/test-ar-permissions.mjs",
      payArAction: "scripts/test-ar-permissions.mjs",
      transferArAction: "scripts/test-ar-permissions.mjs",
      writeOffArAction: "scripts/test-ar-permissions.mjs",
      settleArLedgerAction: "scripts/test-ar-permissions.mjs",
    },
  },
  {
    key: "goods",
    file: "src/app/(main)/goods/actions.ts",
    page: "/goods",
    // 进货 / 退货 / 报废三个导出都只是 await applyStockMove(...) 的直通包装
    helpers: { applyStockMove: "settings.manage" },
    actions: {
      ensureGoodsSchema: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        hotelArg: true,
        runtime: {
          call: "pos",
          args: (c) => [c.hotelId],
          allowed: ["admin"],
          probe: "cashier",
          effects: (c) => [
            fx(
              "ensureGoodsSchema 被放行后商品档案表可读（真建表 + 写种子）",
              (c.h.one(`SELECT COUNT(*) AS n FROM goods WHERE hotel_id = 1`)?.n ?? 0) > 0
            ),
          ],
        },
      },
      // 包装动作：自身没有 requirePermission，守卫在 applyStockMove 里 —— 正是要防的「包装绕开守卫」
      purchaseAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        delegateTo: "applyStockMove",
        runtime: {
          call: "fd",
          params: { goods_id: 999999, qty: 1, note: "权限验收探针" },
          allowed: ["admin"],
          probe: "cashier",
        },
      },
    },
    other: {
      createCategoryAction: "scripts/test-goods-permissions.mjs",
      saveGoodsAction: "scripts/test-goods-permissions.mjs",
      toggleGoodsStatusAction: "scripts/test-goods-permissions.mjs",
      returnAction: "scripts/test-goods-permissions.mjs",
      rejectAction: "scripts/test-goods-permissions.mjs",
    },
  },
  {
    key: "hk",
    file: "src/app/(main)/housekeeping/actions.ts",
    page: "/housekeeping",
    actions: {
      // 完成客房任务会把 VD 置 VC 并写房态日志 → 与「改房态」同一把锁
      completeTaskAction: {
        permission: "room.change_status",
        rejected: ["cashier"],
        runtime: {
          call: "pos",
          args: (c) => [c.ids.taskId],
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => {
            const task = c.h.one(`SELECT status, review_status FROM housekeeping WHERE id = ?`, [c.ids.taskId]);
            const room = c.h.one(`SELECT status FROM rooms WHERE id = ?`, [c.ids.roomVD1]);
            return [
              fx("completeTaskAction 放行后任务置 DONE", task?.status === "DONE", `实际 ${task?.status}`),
              fx(
                "completeTaskAction 放行后对应空脏房置 VC（真改房态）",
                room?.status === "VC",
                `实际 ${room?.status}`
              ),
            ];
          },
        },
      },
      // 脏房置净：VD → VC，最典型的房态变更
      setRoomCleanAction: {
        permission: "room.change_status",
        rejected: ["cashier"],
        runtime: {
          call: "pos",
          args: (c) => [c.ids.roomVD2],
          allowed: ["housekeeping"],
          probe: "cashier",
          effects: (c) => {
            const room = c.h.one(`SELECT status FROM rooms WHERE id = ?`, [c.ids.roomVD2]);
            return [fx("setRoomCleanAction 放行后房间置 VC（客房账号也能干活）", room?.status === "VC", `实际 ${room?.status}`)];
          },
        },
      },
    },
    delegated: {
      startTaskFormAction: "startTaskAction",
      reviewTaskFormAction: "reviewTaskAction",
      completeTaskFormAction: "completeTaskAction",
      setRoomCleanFormAction: "setRoomCleanAction",
    },
    other: {
      startTaskAction: "scripts/test-room-status.mjs",
      reviewTaskAction: "scripts/test-room-status.mjs",
      createMaintenanceTaskAction: "scripts/test-room-status.mjs",
    },
  },
  {
    key: "idv",
    file: "src/app/(main)/id-verify/actions.ts",
    page: "/id-verify",
    actions: {
      ensureIdVerifySchema: {
        permission: "guest.view_sensitive",
        rejected: ["cashier", "housekeeping"],
        runtime: {
          call: "pos",
          args: () => [],
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => [
            fx(
              "ensureIdVerifySchema 放行后核验日志表存在（真建表）",
              Boolean(c.h.one(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'id_verify_logs'`))
            ),
          ],
        },
      },
      verifyIdAction: {
        permission: "guest.view_sensitive",
        rejected: ["cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: { name: "权限验收-核验", id_no: "110101199003071234" },
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => [
            fx(
              "verifyIdAction 放行后写入核验日志（敏感信息操作留痕）",
              (c.h.one(`SELECT COUNT(*) AS n FROM id_verify_logs WHERE hotel_id = 1 AND name = ?`, ["权限验收-核验"])?.n ?? 0) >= 1
            ),
          ],
        },
      },
    },
  },
  {
    key: "lf",
    file: "src/app/(main)/lost-found/actions.ts",
    page: "/lost-found",
    actions: {
      createLostItemAction: {
        permission: "room.change_status",
        rejected: ["cashier"],
        runtime: {
          call: "fd",
          params: (c) => ({ name: c.ids.lfName, place: "大堂", room_no: "PA-1", desc: "运行时权限验收" }),
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => {
            const row = c.h.one(`SELECT id, hotel_id, status FROM lost_items WHERE hotel_id = 1 AND item_name = ?`, [c.ids.lfName]);
            return [
              fx("createLostItemAction 放行后真的登记了失物", Boolean(row)),
              fx("createLostItemAction 写入行带本店 hotel_id", row?.hotel_id === 1, `实际 ${row?.hotel_id}`),
            ];
          },
        },
      },
      claimLostItemAction: {
        permission: "room.change_status",
        rejected: ["cashier"],
        runtime: {
          call: "fd",
          params: (c) => ({ id: c.ids.lfClaim, claimant: "权限验收客人" }),
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => [
            fx(
              "claimLostItemAction 放行后失物置 CLAIMED",
              c.h.one(`SELECT status FROM lost_items WHERE id = ?`, [c.ids.lfClaim])?.status === "CLAIMED"
            ),
          ],
        },
      },
      markReturnedAction: {
        permission: "room.change_status",
        rejected: ["cashier"],
        runtime: {
          call: "fd",
          params: (c) => ({ id: c.ids.lfReturn }),
          // 客房账号也能标记归还（room.change_status 授权 housekeeping）
          allowed: ["housekeeping"],
          probe: "cashier",
          effects: (c) => [
            fx(
              "markReturnedAction 放行后失物置 RETURNED（客房账号可操作）",
              c.h.one(`SELECT status FROM lost_items WHERE id = ?`, [c.ids.lfReturn])?.status === "RETURNED"
            ),
          ],
        },
      },
      deleteLostItemAction: {
        permission: "room.change_status",
        rejected: ["cashier"],
        runtime: {
          call: "fd",
          params: (c) => ({ id: c.ids.lfDelete, reason: "运行时权限验收" }),
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => [
            fx(
              "deleteLostItemAction 放行后记录真的被删",
              (c.h.one(`SELECT COUNT(*) AS n FROM lost_items WHERE id = ?`, [c.ids.lfDelete])?.n ?? 0) === 0
            ),
          ],
        },
      },
    },
  },
  {
    key: "mv",
    file: "src/app/(main)/meal-vouchers/actions.ts",
    page: "/meal-vouchers",
    actions: {
      redeemVoucherAction: {
        permission: "cashier.receive",
        rejected: ["housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => ({ code: c.ids.voucherA }),
          allowed: ["cashier"],
          probe: "housekeeping",
          effects: (c) => [
            fx(
              "redeemVoucherAction 放行后餐券按券号核销（USED）",
              c.h.one(`SELECT status FROM meal_vouchers WHERE id = ?`, [c.ids.voucherAId])?.status === "USED"
            ),
          ],
        },
      },
      redeemVoucherByIdAction: {
        permission: "cashier.receive",
        rejected: ["housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => ({ id: c.ids.voucherBId }),
          allowed: ["cashier"],
          probe: "housekeeping",
          effects: (c) => [
            fx(
              "redeemVoucherByIdAction 放行后按 id 核销（USED）",
              c.h.one(`SELECT status FROM meal_vouchers WHERE id = ?`, [c.ids.voucherBId])?.status === "USED"
            ),
          ],
        },
      },
      voidVoucherAction: {
        permission: "breakfast.void",
        rejected: ["cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => ({ id: c.ids.voucherCId }),
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => [
            fx(
              "voidVoucherAction 放行后未用券置 VOID",
              c.h.one(`SELECT status FROM meal_vouchers WHERE id = ?`, [c.ids.voucherCId])?.status === "VOID"
            ),
          ],
        },
      },
    },
  },
  {
    key: "notices",
    file: "src/app/(main)/notices/actions.ts",
    page: "/notices",
    actions: {
      createNoticeAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => ({ title: c.ids.noticeTitle, content: "运行时权限验收公告", level: "normal" }),
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => [
            fx(
              "createNoticeAction 放行后公告入库",
              Boolean(c.h.one(`SELECT id FROM notices WHERE hotel_id = 1 AND title = ?`, [c.ids.noticeTitle]))
            ),
          ],
        },
      },
      deleteNoticeAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => ({ id: c.ids.noticeDel }),
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => [
            fx(
              "deleteNoticeAction 放行后公告真的被删",
              (c.h.one(`SELECT COUNT(*) AS n FROM notices WHERE id = ?`, [c.ids.noticeDel])?.n ?? 0) === 0
            ),
          ],
        },
      },
    },
  },
  {
    key: "points",
    file: "src/app/(main)/points/actions.ts",
    page: "/points",
    actions: {
      ensurePointsSchema: {
        permission: "member.view_sensitive",
        rejected: ["housekeeping"],
        hotelArg: true,
        runtime: {
          call: "pos",
          args: (c) => [c.hotelId],
          allowed: ["cashier"],
          probe: "housekeeping",
          effects: (c) => [
            fx(
              "ensurePointsSchema 放行后积分商品表可读（真建表 + 写种子）",
              (c.h.one(`SELECT COUNT(*) AS n FROM score_goods WHERE hotel_id = 1`)?.n ?? 0) > 0
            ),
          ],
        },
      },
      // 兑换会扣会员积分 + 减库存 == 会员权益写操作
      redeemPointsAction: {
        permission: "member.manage",
        rejected: ["cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => {
            c.marks.ptStockBefore = c.h.one(`SELECT stock FROM score_goods WHERE id = ?`, [c.ids.scoreGoods])?.stock ?? -1;
            return { guest_id: c.ids.vipGuest, goods_id: c.ids.scoreGoods };
          },
          allowed: ["frontdesk"],
          probe: "cashier",
          effects: (c) => {
            const stockAfter = c.h.one(`SELECT stock FROM score_goods WHERE id = ?`, [c.ids.scoreGoods])?.stock ?? -2;
            const spend = c.h.one(
              `SELECT COUNT(*) AS n FROM score_records WHERE hotel_id = 1 AND guest_id = ? AND type = 'SPEND'`,
              [c.ids.vipGuest]
            )?.n ?? 0;
            return [
              fx(
                "redeemPointsAction 放行后积分商品库存 -1",
                stockAfter === c.marks.ptStockBefore - 1,
                `扣减前 ${c.marks.ptStockBefore} / 扣减后 ${stockAfter}`
              ),
              fx("redeemPointsAction 放行后写入 SPEND 积分流水", spend >= 1, `实际 ${spend} 条`),
            ];
          },
        },
      },
      // 手工调积分等于直接发钱 → requireAdmin
      adjustPointsAction: {
        permission: "@requireAdmin",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: { guest_id: 999999, direction: "+", amount: 1, note: "权限验收探针" },
          allowed: ["admin"],
          // 管理员在 hasPermission 里短路，无法用「撤权」验证，因此不做 ③④
        },
      },
    },
    other: {
      createScoreCodeAction: "scripts/test-member-permissions.mjs",
      toggleScoreCodeAction: "scripts/test-member-permissions.mjs",
      createScoreGoodsAction: "scripts/test-member-permissions.mjs",
      toggleScoreGoodsAction: "scripts/test-member-permissions.mjs",
    },
  },
  {
    key: "rental",
    file: "src/app/(main)/rental/actions.ts",
    page: "/rental",
    actions: {
      ensureRentalSchema: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        hotelArg: true,
        runtime: {
          call: "pos",
          args: (c) => [c.hotelId],
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => [
            fx(
              "ensureRentalSchema 放行后出借物品表有种子数据（真建表 + 写种子）",
              (c.h.one(`SELECT COUNT(*) AS n FROM rental_items WHERE hotel_id = 1`)?.n ?? 0) > 0
            ),
          ],
        },
      },
      rentItemAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: { item_id: 999999, qty: 1, room_no: "PA-1" },
          allowed: ["admin"],
          probe: "frontdesk",
        },
      },
      returnRentalAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: { id: 999999 },
          allowed: ["admin"],
          probe: "frontdesk",
        },
      },
    },
  },
  {
    key: "shop",
    file: "src/app/(main)/shop/actions.ts",
    page: "/shop",
    actions: {
      ensureShopPageSchema: {
        permission: "cashier.view",
        rejected: ["housekeeping"],
        hotelArg: true,
        runtime: {
          call: "pos",
          args: (c) => [c.hotelId],
          allowed: ["cashier"],
          probe: "housekeeping",
          effects: (c) => [
            fx(
              "ensureShopPageSchema 放行后商超相关表存在（真建表）",
              (c.h.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'shop_%'`)?.length ?? 0) > 0
            ),
          ],
        },
      },
      // 购物车结算：主售卖路径，收款权限
      sellCartAction: {
        permission: "cashier.receive",
        rejected: ["housekeeping"],
        runtime: {
          call: "fd",
          params: { items: "[]" },
          allowed: ["cashier"],
          probe: "housekeeping",
        },
      },
      // 撤销销售单 = 退款，cashier.refund（admin / cashier）
      voidSaleAction: {
        permission: "cashier.refund",
        rejected: ["frontdesk", "housekeeping"],
        runtime: {
          call: "fd",
          params: { id: 999999, reason: "权限验收探针" },
          allowed: ["cashier"],
          probe: "frontdesk",
        },
      },
    },
    other: {
      sellAction: "scripts/test-shop-permissions.mjs",
      toggleItemStatusAction: "scripts/test-shop-permissions.mjs",
    },
  },
  {
    key: "sms",
    file: "src/app/(main)/sms/actions.ts",
    page: "/sms",
    actions: {
      ensureSmsSeed: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        hotelArg: true,
        runtime: {
          call: "pos",
          args: (c) => [c.hotelId],
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => [
            fx(
              "ensureSmsSeed 放行后短信模板表有种子数据（真建表 + 写种子）",
              (c.h.one(`SELECT COUNT(*) AS n FROM sms_templates WHERE hotel_id = 1`)?.n ?? 0) > 0
            ),
          ],
        },
      },
      createTemplateAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => ({ code: c.ids.tplCode, name: "权限验收模板", content: "您好{name}", scene: "checkin" }),
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => [
            fx(
              "createTemplateAction 放行后模板入库",
              Boolean(c.h.one(`SELECT id FROM sms_templates WHERE hotel_id = 1 AND code = ?`, [c.ids.tplCode.toUpperCase()]))
            ),
          ],
        },
      },
      updateTemplateAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => ({
            id: c.ids.tplEditId,
            code: c.ids.tplEditCode,
            name: "权限验收模板-改名",
            content: "您好{name}，已改名",
            scene: "checkin",
          }),
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => [
            fx(
              "updateTemplateAction 放行后模板名称真的变了",
              c.h.one(`SELECT name FROM sms_templates WHERE id = ?`, [c.ids.tplEditId])?.name === "权限验收模板-改名"
            ),
          ],
        },
      },
      toggleTemplateAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => {
            c.marks.tplStatusBefore = c.h.one(`SELECT status FROM sms_templates WHERE id = ?`, [c.ids.tplToggleId])?.status;
            return { id: c.ids.tplToggleId };
          },
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => {
            const after = c.h.one(`SELECT status FROM sms_templates WHERE id = ?`, [c.ids.tplToggleId])?.status;
            return [
              fx(
                "toggleTemplateAction 放行后模板启停状态翻转",
                after !== c.marks.tplStatusBefore && (after === "ENABLED" || after === "DISABLED"),
                `${c.marks.tplStatusBefore} → ${after}`
              ),
            ];
          },
        },
      },
      // 发送短信：会写 sms_sends 并对客发送，属系统配置 + 对客通道
      sendSmsAction: {
        permission: "settings.manage",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        runtime: {
          call: "fd",
          params: (c) => {
            c.marks.smsBefore = c.h.one(`SELECT COUNT(*) AS n FROM sms_sends WHERE hotel_id = 1`)?.n ?? 0;
            return { template_id: c.ids.tplSendId, mobile: "13800000000", guest_name: "权限验收客" };
          },
          allowed: ["admin"],
          probe: "frontdesk",
          effects: (c) => {
            const after = c.h.one(`SELECT COUNT(*) AS n FROM sms_sends WHERE hotel_id = 1`)?.n ?? 0;
            return [
              fx(
                "sendSmsAction 放行后真的写了一条发送记录",
                after === c.marks.smsBefore + 1,
                `${c.marks.smsBefore} → ${after}`
              ),
            ];
          },
        },
      },
    },
    other: {
      saveSmsSettingsAction: "源码 requireAdmin 单独校验",
    },
  },
];

/**
 * 只读操作白名单：允许继续用 requireUser() 的导出函数。
 */
const READ_ONLY = {};

/* ============================================================ 工具 */

let pass = 0;
let fail = 0;
const failures = [];
/** HTTP 运行时段被跳过的原因（非空 = 本次没跑 HTTP 段，汇总里必须说出来） */
let runtimeSkipReason = "";
/**
 * 是否要求 HTTP 运行时段必须执行：
 *   · 默认不要求（本地/本轮禁止 next build 时也能跑，跳过会打印原因）
 *   · PMS_REQUIRE_HTTP=1 或 --require-http → 跳过即判红，CI / 发布前用它防「假通过」
 */
const REQUIRE_HTTP = process.env.PMS_REQUIRE_HTTP === "1" || process.argv.includes("--require-http");

function skipRuntime(reason) {
  console.log(`  ⏭️  ${reason}`);
  if (REQUIRE_HTTP) {
    fail += 1;
    failures.push(`HTTP 运行时段未执行：${reason}（--require-http / PMS_REQUIRE_HTTP=1 要求必须跑）`);
    return;
  }
  runtimeSkipReason = reason;
}

const check = (ok, label, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${extra ? ` :: ${extra}` : ""}`);
    console.log(`  ❌ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

/** 运行时副作用的断言小结构 */
const fx = (label, ok, extra = "") => ({ label, ok, extra });

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const fmtTime = (ms) =>
  new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/* ============================================================ 1. 解析权限表 */

function parsePermissionTable() {
  const src = read("src/lib/session.ts");
  const start = src.indexOf("const PERMISSIONS");
  if (start < 0) throw new Error("src/lib/session.ts 里找不到 PERMISSIONS 表");
  const open = src.indexOf("{", start);
  // 表结束：从 open 开始找第一处 "\n};"
  const end = src.indexOf("\n};", open);
  if (end < 0) throw new Error("PERMISSIONS 表结构异常：找不到结束的 }");
  const body = src.slice(open + 1, end);

  /** @type {Record<string, string[]>} */
  const table = {};
  const re = /"([a-zA-Z0-9_.]+)"\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const roles = m[2]
      .split(",")
      .map((r) => r.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    table[m[1]] = roles;
  }
  return { src, table };
}

/* ============================================================ 2. 静态校验 */

/** 取一个导出函数的函数体（到下一个 export 或文件尾） */
function sliceFunction(src, name) {
  const sig = `export async function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const nextExport = src.indexOf("\nexport ", start + sig.length);
  const end = nextExport < 0 ? src.length : nextExport;
  return src.slice(start, end);
}

/** 函数体里第一处写库操作的下标（用于断言「权限校验在写库之前」） */
function firstMutationIndex(body) {
  const patterns = [
    /(?:^|\n)\s*run\s*\(/,
    /(?:^|\n)\s*tx\s*\(/,
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
  ];
  let min = -1;
  for (const p of patterns) {
    const m = body.match(p);
    if (m && m.index !== undefined && m.index + m[0].length > 0) {
      const at = m.index + (m[0].startsWith("\n") ? 1 : 0);
      if (min < 0 || at < min) min = at;
    }
  }
  return min;
}

/**
 * 找函数体开头的权限守卫
 *
 * @returns {{kind: string, permission: string|null, target?: string, at: number, label: string}|null}
 */
function findGuard(body, helpers = {}) {
  if (!body) return null;
  // 只看开头：守卫必须是最前面几行（注释允许），不能藏在业务逻辑后面
  const head = body.slice(0, 1600);
  let m = head.match(/requirePermissionOrRedirect\(\s*"([^"]+)"\s*\)/);
  if (m) {
    return { kind: "redirect", permission: m[1], at: body.indexOf(m[0]), label: `requirePermissionOrRedirect("${m[1]}")` };
  }
  m = head.match(/requirePermission\(\s*"([^"]+)"\s*\)/);
  if (m) {
    return { kind: "throw", permission: m[1], at: body.indexOf(m[0]), label: `requirePermission("${m[1]}")` };
  }
  m = head.match(/requireAdmin\(\s*\)/);
  if (m) {
    return { kind: "admin", permission: "@requireAdmin", at: body.indexOf(m[0]), label: "requireAdmin()" };
  }
  m = head.match(/requireRole\(\s*"([^"]+)"\s*\)/);
  if (m) {
    return { kind: "role", permission: `@role:${m[1]}`, at: body.indexOf(m[0]), label: `requireRole("${m[1]}")` };
  }
  // 直通包装：函数体只 await 一个内部受保护函数（如 goods.purchaseAction → applyStockMove）
  m = head.match(/await\s+([A-Za-z0-9_]+)\s*\(/);
  if (m && Object.prototype.hasOwnProperty.call(helpers, m[1])) {
    return { kind: "delegate", permission: helpers[m[1]], target: m[1], at: body.indexOf(m[0]), label: `委托 ${m[1]}()（内部权限点 ${helpers[m[1]]}）` };
  }
  return null;
}

function parseSessionImport(src) {
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/session"\s*;/);
  return m
    ? m[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

/** 权限点 → 副本库 role_permissions 里的角色集合（缓存 + 断言去重） */
function makeDbRoles(h) {
  const cache = new Map();
  const checked = new Set();
  const rolesOf = (perm) => {
    if (!cache.has(perm)) {
      cache.set(
        perm,
        h
          .all(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission = ? ORDER BY role`, [perm])
          .map((r) => r.role)
      );
    }
    return cache.get(perm);
  };
  return { rolesOf, checked, cache };
}

function sameSet(a, b) {
  const A = [...new Set(a)].sort();
  const B = [...new Set(b)].sort();
  return A.length === B.length && A.every((x, i) => x === B[i]);
}

/**
 * 静态校验一个模块
 *
 * @param {{file: string, actions: object, other?: object, delegated?: object, helpers?: object}} mod
 * @param {Record<string, string[]>} table 常量权限表
 * @param {{rolesOf: Function, checked: Set}} db
 * @param {boolean} isNew 新补权限的模块（标签文案不同）
 */
function auditModule(mod, table, db, isNew = false) {
  console.log(`\n=== ${isNew ? "[新补] " : ""}${mod.file} ===`);
  const src = read(mod.file);
  const whitelist = READ_ONLY[mod.file] ?? [];
  const helpers = mod.helpers ?? {};
  const delegated = mod.delegated ?? {};
  const other = mod.other ?? {};

  /* 2.1 import 必须带权限校验函数 */
  const imported = parseSessionImport(src);
  const guardImports = imported.filter((x) =>
    ["requirePermission", "requirePermissionOrRedirect", "requireAdmin", "requireRole"].includes(x)
  );
  check(guardImports.length > 0, `import 里包含权限校验函数（当前：${imported.join(", ") || "无"}）`);

  /* 2.2 找出所有导出函数 */
  const exported = [];
  const re = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) exported.push(m[1]);

  /* 2.3 期望表 ↔ 源码双向一致（同文件的其它导出必须登记为 other / delegated） */
  const expected = Object.keys(mod.actions);
  for (const name of exported) {
    if (expected.includes(name)) continue;
    if (whitelist.includes(name)) continue;
    if (Object.prototype.hasOwnProperty.call(other, name)) continue;
    if (Object.prototype.hasOwnProperty.call(delegated, name)) continue;
    check(false, `${name} 未在期望/只读白名单/其它导出中登记（新增 action 请补登记）`);
  }
  for (const name of expected) {
    if (!exported.includes(name)) check(false, `${name} 在源码里不存在（期望表过期）`);
  }

  /* 2.4 逐个受检 action */
  for (const name of exported) {
    if (whitelist.includes(name)) {
      console.log(`  ⚪ ${name} 只读操作（白名单，允许 requireUser）`);
      pass += 1;
      continue;
    }
    const spec = mod.actions[name];
    if (!spec) continue; // 上面已经报过「未登记」

    const body = sliceFunction(src, name);
    if (!body) {
      check(false, `${name} 函数体解析失败`);
      continue;
    }

    const guard = findGuard(body, helpers);
    if (!guard) {
      check(false, `${name} 缺权限校验`, "（函数体开头 1600 字符内没有 requirePermission/requirePermissionOrRedirect/requireAdmin/委托）");
      continue;
    }
    check(true, `${name} 有服务端权限校验（${guard.label}）`);

    /* 2.4.1 权限点与期望一致 */
    check(
      guard.permission === spec.permission,
      `${name} 权限点符合期望（期望 ${spec.permission}，实际 ${guard.permission}）`
    );

    /* 2.4.2 权限点 / 管理员 / 受限角色 */
    if (spec.permission !== "@requireAdmin") {
      const roles = table[spec.permission];
      check(Array.isArray(roles) && roles.length > 0, `${name} 权限点 ${spec.permission} 已在 session.ts PERMISSIONS 中定义`);
      if (Array.isArray(roles)) {
        // admin 必须通过（hasPermission 里 admin 短路 + 表里也允许）
        check(roles.includes("admin"), `${name} 权限点 ${spec.permission} 允许 admin`);
        // 受限角色必须被拒
        for (const role of spec.rejected) {
          check(!roles.includes(role), `${name} 拒绝 ${role}（权限点 ${spec.permission} 允许：${roles.join(" / ")}）`);
        }
      }
      /* 2.4.3 副本库 role_permissions 与常量表一致（每个权限点只算一次） */
      if (!db.checked.has(spec.permission)) {
        db.checked.add(spec.permission);
        const dbRoles = db.rolesOf(spec.permission);
        const constRoles = table[spec.permission] ?? [];
        check(
          dbRoles.length > 0,
          `权限点 ${spec.permission} 在副本库 role_permissions 里有配置（实际：${dbRoles.join(" / ") || "无"}）`
        );
        check(
          sameSet(dbRoles, constRoles),
          `权限点 ${spec.permission} 库里的角色与常量表一致（库：${dbRoles.join(" / ")}｜常量：${constRoles.join(" / ")}）`
        );
      }
    } else {
      check(guard.kind === "admin" || guard.kind === "role", `${name} 用 requireAdmin() 锁到管理员（实际 ${guard.label}）`);
    }

    /* 2.4.4 权限校验必须发生在任何写库操作之前 */
    if (guard.kind === "delegate") {
      const targetBody = sliceFunction(src, guard.target);
      const targetGuard = findGuard(targetBody ?? "", {});
      const permIdx = targetGuard ? targetGuard.at : -1;
      const mutIdx = firstMutationIndex(targetBody ?? "");
      check(
        Boolean(targetGuard) && permIdx >= 0 && (mutIdx < 0 || permIdx < mutIdx),
        `${name} 的委托目标 ${guard.target}() 权限校验在写库之前`
      );
      // 包装自身不能先写库再委托
      check(
        body.indexOf("await " + guard.target) >= 0 && (firstMutationIndex(body) < 0 || body.indexOf("await " + guard.target) < firstMutationIndex(body)),
        `${name} 只做参数转换后立刻委托，没有绕过守卫的写库`
      );
    } else {
      const permIdx = guard.at;
      const mutIdx = firstMutationIndex(body);
      check(
        permIdx >= 0 && (mutIdx < 0 || permIdx < mutIdx),
        `${name} 权限校验在写库之前`,
        mutIdx >= 0 && permIdx > mutIdx ? "（发现写库早于权限校验）" : ""
      );
    }

    /* 2.4.5 ensure*Schema 必须校验 hotelId 与会话一致（否则能往别家灌种子） */
    if (spec.hotelArg) {
      check(
        /!==\s*user\.hotelId/.test(body) && /FORBIDDEN/.test(body),
        `${name} 校验 hotelId 与会话一致（跨店初始化被 FORBIDDEN 拒绝）`
      );
    }
  }

  /* 2.5 内部受保护函数：helpers（被多个导出共用）必须有守卫 */
  for (const [fn, perm] of Object.entries(helpers)) {
    // 非导出函数：从 `async function <fn>(` 切到下一个 export（导出动作里的引用不算定义）
    const start = src.indexOf(`async function ${fn}(`);
    const nextExport = start < 0 ? -1 : src.indexOf("\nexport ", start);
    const sliced = start < 0 ? null : src.slice(start, nextExport < 0 ? src.length : nextExport);
    const g = findGuard(sliced ?? "", {});
    check(Boolean(g) && g.permission === perm, `内部共用函数 ${fn}() 有权限守卫（期望 ${perm}，实际 ${g?.label ?? "无"}）`);
  }

  /* 2.6 表单包装：必须真的委托给受保护动作（防止漏加 guard 的「影子入口」） */
  for (const [wrapper, target] of Object.entries(delegated)) {
    const body = sliceFunction(src, wrapper);
    check(Boolean(body) && body.includes(`await ${target}(`), `${wrapper} 是表单包装，直接 await ${target}()`);
    const g = findGuard(sliceFunction(src, target) ?? "", helpers);
    check(Boolean(g), `${wrapper} 委托的 ${target}() 有权限守卫（${g?.label ?? "无"}）`);
  }

  /* 2.7 其它导出（本脚本不做运行时）：必须仍然有守卫，不允许「未登记就没人管」 */
  for (const [name, reason] of Object.entries(other)) {
    const body = sliceFunction(src, name);
    check(Boolean(body), `${name} 存在于源码（本脚本运行时由 ${reason} 覆盖）`);
    const g = findGuard(body ?? "", helpers);
    check(Boolean(g), `${name} 有服务端权限守卫（${g?.label ?? "无"}），运行时由 ${reason} 覆盖`);
  }

  /* 2.8 写操作文件不应再残留 requireUser（只读白名单存在时除外） */
  const requireUserLeft = (src.match(/requireUser\s*\(/g) || []).length;
  if (whitelist.length === 0) {
    check(
      requireUserLeft === 0,
      `文件内没有残留 requireUser()（写操作已全部改为权限校验）`,
      `（残留 ${requireUserLeft} 处）`
    );
  } else {
    check(requireUserLeft > 0, `只读白名单存在，允许保留 requireUser()`);
  }
}

/* ============================================================ 3. 运行时（真调 action） */

/**
 * 准备运行时环境：
 *   · 副本库（VACUUM INTO）+ 注入 __pmsDb
 *   · import 真实 session.ts / 11 个 actions.ts
 *   · 用副本库 sessions 表造 4 个角色的真会话 + 1 个二店管理会话
 *   · 造运行时需要的业务数据（VD 房 / 客房任务 / 餐券 / 失物 / 公告 …）
 */
async function prepareRuntime() {
  const h = await createActionHarness({ tag: "action-perm55" });
  const session = await h.importModule("lib/session.ts");

  /** 各模块的真实源码（import 一次，全部历史调用都命中同一实例） */
  const mods = {};
  for (const mod of NEW_MODULES) {
    mods[mod.key] = await h.importModule(mod.file.replace(/^src\//, ""));
  }

  const nowIso = () => new Date().toISOString();
  const sidOf = {};

  /** 造会话：优先复用副本库里该角色的启用用户，没有就自己建（空库也能跑） */
  const makeSession = (role, hotelId, suffix = "") => {
    let u = h.one(
      `SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? AND role = ? AND status = 1 ORDER BY id LIMIT 1`,
      [hotelId, role]
    );
    if (!u) {
      const username = `perm55-${role}-${h.stamp}${suffix}`;
      const id = h.run(
        `INSERT INTO users (hotel_id, username, password, real_name, role, status) VALUES (?,?,?,?,?,1)`,
        [hotelId, username, "x", `权限验收${role}`, role]
      ).lastInsertRowid;
      u = { id, username, real_name: `权限验收${role}`, role, hotel_id: hotelId };
    }
    const sid = `perm55-${role}-${h.stamp}${suffix}`;
    h.run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
      sid,
      JSON.stringify({
        id: u.id,
        username: u.username,
        realName: u.real_name,
        role,
        hotelId: u.hotel_id,
        hotelName: "权限验收酒店",
      }),
      nowIso(),
      new Date(Date.now() + 3600 * 1000).toISOString(),
    ]);
    return sid;
  };

  sidOf.admin = h.ADMIN_SID;
  for (const role of ["frontdesk", "cashier", "housekeeping"]) sidOf[role] = makeSession(role, 1);
  // 二店（跨酒店隔离用）：酒店 2 的管理员，权限上全通过 → 剩下的只可能是数据隔离在挡
  sidOf.h2 = makeSession("admin", 2, "-h2");

  /* ---------- 造数：全部只写副本库 ---------- */
  const ids = {};
  const marks = {};
  const suffix = h.stamp.slice(-6);
  const today = h.localDate();
  const now = nowIso();

  const roomTypeId = h.createRoomType({ name: "权限验收房型" });
  const rooms = h.createRooms(3, { roomTypeId, status: "VD", prefix: "PA" });
  ids.roomVD1 = rooms[0].id;
  ids.roomVD2 = rooms[1].id;
  ids.roomVD3 = rooms[2].id;

  // 一条待打扫任务（completeTaskAction 用）；room_id 指向空脏房，完成时应 VD → VC
  ids.taskId = h.run(
    `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
     VALUES (1,?,?,?,?,?,?)`,
    [ids.roomVD1, "打扫", "PENDING", "", "", now]
  ).lastInsertRowid;

  // 失物：待认领 / 待归还 / 待删除 各一条（不用 action 造，避免被测对象自己造数据自己验）
  const insertLost = (name) =>
    h.run(
      `INSERT INTO lost_items (hotel_id, item_name, keeper, room_no, note, status, found_at, created_at)
       VALUES (1,?,?,?,?,?,?,?)`,
      [name, "大堂", "PA-1", "", "PENDING", today, now]
    ).lastInsertRowid;
  ids.lfName = `权限验收失物-${suffix}`;
  ids.lfClaim = insertLost(`待认领-${suffix}`);
  ids.lfReturn = insertLost(`待归还-${suffix}`);
  ids.lfDelete = insertLost(`待删除-${suffix}`);

  // 餐券：按券号核销 / 按 id 核销 / 作废 各一张（都是当天的 UNUSED 券）
  const insertVoucher = (code) =>
    h.run(
      `INSERT INTO meal_vouchers (hotel_id, code, room_no, guest_name, type, date, status, created_at)
       VALUES (1,?,?,?,?,?,?,?)`,
      [code, "PA-1", "权限验收客", "早餐", today, "UNUSED", now]
    ).lastInsertRowid;
  ids.voucherA = `PVA${suffix}`;
  ids.voucherAId = insertVoucher(ids.voucherA);
  ids.voucherB = `PVB${suffix}`;
  ids.voucherBId = insertVoucher(ids.voucherB);
  ids.voucherC = `PVC${suffix}`;
  ids.voucherCId = insertVoucher(ids.voucherC);
  ids.voucherX = `PVX${suffix}`; // 跨酒店隔离用（二店身份不能核销它）
  ids.voucherXId = insertVoucher(ids.voucherX);

  // 公告：待删的一条
  ids.noticeTitle = `权限验收公告-${suffix}`;
  ids.noticeDel = h.run(
    `INSERT INTO notices (hotel_id, title, content, author, level, created_at) VALUES (1,?,?,?,?,?)`,
    [`待删公告-${suffix}`, "", "权限验收", "normal", now]
  ).lastInsertRowid;

  // 短信模板：待编辑 / 待启停 / 待发送各一条（直接种，避免依赖 ensureSmsSeed 的种子内容）
  const insertTpl = (code, status = "ENABLED") =>
    h.run(
      `INSERT INTO sms_templates (hotel_id, code, name, content, scene, status, created_at) VALUES (1,?,?,?,?,?,?)`,
      [code, `权限验收模板-${code}`, "您好{name}，欢迎入住{room}", "checkin", status, now]
    ).lastInsertRowid;
  ids.tplCode = `PT${suffix}`;
  ids.tplEditCode = `PE${suffix}`;
  ids.tplEditId = insertTpl(ids.tplEditCode);
  ids.tplToggleId = insertTpl(`PG${suffix}`);
  ids.tplSendId = insertTpl(`PS${suffix}`);

  // 积分：先由 admin 调 ensurePointsSchema 建表 + 种子，再挑一个会员余额够的客人与最低价商品
  ids.vipGuest = h.one(
    `SELECT g.id
       FROM guests g
       LEFT JOIN score_records r ON r.hotel_id = g.hotel_id AND r.guest_id = g.id
      WHERE g.hotel_id = 1 AND g.vip_level > 0 AND COALESCE(g.deleted, 0) = 0
      GROUP BY g.id
     HAVING COALESCE(SUM(r.points), 0) >= 100
      ORDER BY COALESCE(SUM(r.points), 0) DESC
      LIMIT 1`
  )?.id;
  // 积分商品用原值的「探针商品」，不依赖种子内容
  const ensureGoodsId = h.one(`SELECT id FROM score_goods WHERE hotel_id = 1 ORDER BY id LIMIT 1`)?.id;
  ids.scoreGoods =
    ensureGoodsId ??
    h.run(
      `INSERT INTO score_goods (hotel_id, name, points, stock, status, note, created_at)
       VALUES (1,?,?,?,?,?,?)`,
      [`权限验收积分商品-${suffix}`, 100, 50, "ACTIVE", "", now]
    ).lastInsertRowid;

  // 跨酒店：二店的一条失物（一店身份不能删它）
  ids.h2LostItem = h.run(
    `INSERT INTO lost_items (hotel_id, item_name, keeper, room_no, note, status, found_at, created_at)
     VALUES (2,?,?,?,?,?,?,?)`,
    [`二店失物-${suffix}`, "", "", "", "PENDING", today, now]
  ).lastInsertRowid;

  return { h, session, mods, sidOf, ids, marks, suffix, today, hotelId: 1 };
}

/** 统一把 action 的返回/跳转/抛错归一成可断言的形状 */
async function callPositional(fn, args) {
  try {
    const out = await fn(...args);
    return { kind: "returned", result: out, message: String(out?.error ?? out?.ok ?? "") };
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (msg.startsWith("NEXT_REDIRECT:")) {
      const url = msg.slice("NEXT_REDIRECT:".length);
      let q;
      try {
        q = new URL(url, "http://localhost").searchParams;
      } catch {
        q = new URLSearchParams();
      }
      const errText = q.get("err");
      return { kind: errText ? "err" : "ok", url, message: errText || q.get("msg") || q.get("ok") || "" };
    }
    if (msg === "NEXT_NOT_FOUND") return { kind: "notfound", message: msg };
    return { kind: "threw", message: msg };
  }
}

/** 被权限拦下的判据：redirect /no-permission?p=xxx（requirePermissionOrRedirect）或 FORBIDDEN 抛错（requirePermission/requireAdmin） */
function denialOf(result, permission) {
  if (result?.url && result.url.startsWith("/no-permission")) {
    const p = new URL(result.url, "http://localhost").searchParams.get("p") ?? "";
    return { ok: p === permission, how: `redirect ${result.url}` };
  }
  if (result?.kind === "threw" && /^FORBIDDEN/.test(result.message)) {
    const ok = permission === "@requireAdmin" ? true : result.message.includes(permission);
    return { ok, how: `throw ${result.message}` };
  }
  return { ok: false, how: describeResult(result) };
}

function describeResult(r) {
  if (!r) return "无返回";
  if (r.url) return `${r.kind} ${r.url}`;
  return `${r.kind}${r.message ? ` ${r.message}` : ""}`;
}

const resolveValue = (v, ctx) => (typeof v === "function" ? v(ctx) : v);

/** 以某个角色调用 action（真实会话 + 真实 FormData / 位置参数） */
async function callAs(ctx, mod, name, spec, role) {
  const fn = ctx.mods[mod.key]?.[name];
  if (typeof fn !== "function") throw new Error(`action 未加载：${mod.file}#${name}`);
  ctx.h.useSession(ctx.sidOf[role]);
  if (!ctx.sidOf[role]) throw new Error(`没有 ${role} 的会话`);
  const rt = spec.runtime;
  if (rt.call === "pos") {
    const args = resolveValue(rt.args, ctx) ?? [];
    return callPositional(fn, args);
  }
  const params = resolveValue(rt.params, ctx) ?? {};
  return ctx.h.invoke(fn, params);
}

/** 改副本库 role_permissions 并让权限缓存立即失效（与设置页保存同一路径） */
function setRolePermission(ctx, role, permission, on) {
  const table = "role_permissions";
  if (on) {
    const existed = ctx.h.one(
      `SELECT id FROM ${table} WHERE hotel_id = 1 AND role = ? AND permission = ? LIMIT 1`,
      [role, permission]
    );
    if (!existed) {
      ctx.h.run(`INSERT INTO ${table} (hotel_id, role, permission, created_at) VALUES (1,?,?,?)`, [
        role,
        permission,
        new Date().toISOString(),
      ]);
    }
  } else {
    ctx.h.run(`DELETE FROM ${table} WHERE hotel_id = 1 AND role = ? AND permission = ?`, [role, permission]);
  }
  ctx.session.invalidatePermissionCache(1);
}

function rolePermissionRows(ctx, role, permission) {
  return ctx.h.all(`SELECT id FROM role_permissions WHERE hotel_id = 1 AND role = ? AND permission = ?`, [role, permission]);
}

/* ---------- 运行时主流程 ---------- */

const evidence = { revoked: [], allowed: [], effects: [] };

function recordEvidence(bucket, entry) {
  if (bucket.length < 12) bucket.push(entry);
}

async function auditRuntime(ctx) {
  const { h } = ctx;

  /* 3.0 环境自检 */
  console.log("\n=== 运行时校验 A：真调真实 Server Action（副本库 + 真实会话 + 凭据表开关权限） ===");
  check(Boolean(h.dbPath) && fs.existsSync(h.dbPath), "副本库已生成（VACUUM INTO，真库只读）");
  check(Boolean(ctx.session?.hasPermission), "已加载真实 src/lib/session.ts（权限判断不是脚本模拟）");
  check(
    Object.keys(ctx.sidOf).length >= 5 && Boolean(ctx.sidOf.frontdesk && ctx.sidOf.cashier && ctx.sidOf.housekeeping && ctx.sidOf.h2),
    "已造出 admin / frontdesk / cashier / housekeeping + 二店 5 个真实会话（sessions 表）"
  );
  check(
    ctx.h.one(`SELECT COUNT(*) AS n FROM role_permissions WHERE hotel_id = 1`)?.n >= 4,
    "副本库 role_permissions 有配置（权限判断走库而不是常量兜底）"
  );

  /* 3.1 逐个 action 四步矩阵 */
  let index = 0;
  const total = NEW_MODULES.reduce((n, m) => n + Object.keys(m.actions).length, 0);

  for (const mod of NEW_MODULES) {
    for (const [name, spec] of Object.entries(mod.actions)) {
      index += 1;
      const rt = spec.runtime;
      if (!rt) {
        check(false, `${name} 缺运行时配置（新补的权限点必须有运行时验证）`);
        continue;
      }
      console.log(`\n--- [${index}/${total}] ${mod.file} → ${name}（${spec.permission}） ---`);

      /* ① 无权角色必须被拒 */
      for (const role of spec.rejected) {
        const r = await callAs(ctx, mod, name, spec, role);
        const d = denialOf(r, spec.permission);
        check(
          d.ok,
          `${name} 拒绝 ${role}（${spec.permission}）`,
          d.ok ? "" : `实际：${describeResult(r)}`
        );
        if (d.ok) {
          recordEvidence(evidence.revoked, {
            action: `${mod.file}#${name}`,
            permission: spec.permission,
            role,
            how: d.how,
          });
        }
      }

      /* ② 有权角色必须放行 + 真实副作用 */
      const allowedRole = rt.allowed[0];
      const allowedResult = await callAs(ctx, mod, name, spec, allowedRole);
      const allowedDenied = denialOf(allowedResult, spec.permission);
      check(
        !allowedDenied.ok,
        `${name} 允许 ${allowedRole}（有权限时能执行，不是一刀切全拒）`,
        `实际：${describeResult(allowedResult)}`
      );
      if (!allowedDenied.ok) {
        recordEvidence(evidence.allowed, {
          action: `${mod.file}#${name}`,
          permission: spec.permission,
          role: allowedRole,
          how: describeResult(allowedResult),
        });
      }
      for (const e of rt.effects?.(ctx) ?? []) {
        check(e.ok, e.label, e.extra ? `（${e.extra}）` : "");
        if (e.ok) recordEvidence(evidence.effects, { action: `${mod.file}#${name}`, how: e.label });
      }

      /* ③④ 授权 → 放行，撤权 → 拒（证明判断真的跟着 role_permissions 走） */
      if (spec.permission !== "@requireAdmin" && rt.probe) {
        const probe = rt.probe;
        const original = rolePermissionRows(ctx, probe, spec.permission);
        // 前置条件：probe 必须「构造上本来没有」该权限点，否则③④不成立
        check(
          original.length === 0,
          `${name} 的对照角色 ${probe} 原本没有 ${spec.permission}（授权/撤权对照才有意义）`,
          `实际已配置 ${original.length} 行`
        );

        /* ③ 授权 → 放行 */
        setRolePermission(ctx, probe, spec.permission, true);
        let grantedResult = null;
        try {
          grantedResult = await callAs(ctx, mod, name, spec, probe);
        } finally {
          restoreRolePermission(ctx, probe, spec.permission, original);
        }
        const grantedDenied = denialOf(grantedResult ?? { kind: "threw", message: "未执行" }, spec.permission);
        check(
          !grantedDenied.ok,
          `${name} 给 ${probe} 加上 ${spec.permission} 后放行（运行时确实按库里的凭据表判断）`,
          `实际：${describeResult(grantedResult)}`
        );

        /* ④ 撤权 → 又被拒（把这一行权限从副本库删掉，缓存立即失效） */
        setRolePermission(ctx, probe, spec.permission, false);
        let revokedResult = null;
        try {
          revokedResult = await callAs(ctx, mod, name, spec, probe);
        } finally {
          restoreRolePermission(ctx, probe, spec.permission, original);
        }
        const revokedDenied = denialOf(revokedResult ?? { kind: "returned" }, spec.permission);
        check(
          revokedDenied.ok,
          `${name} 撤销 ${probe} 的 ${spec.permission} 后被拒（${revokedDenied.how}）`,
          revokedDenied.ok ? "" : `实际：${describeResult(revokedResult)}`
        );
        if (revokedDenied.ok) {
          recordEvidence(evidence.revoked, {
            action: `${mod.file}#${name}`,
            permission: spec.permission,
            role: `${probe}（刚撤销 ${spec.permission}）`,
            how: revokedDenied.how,
          });
        }

        /* 收尾：确认副本库凭据表已恢复到矩阵开始前的样子 */
        const restored = rolePermissionRows(ctx, probe, spec.permission);
        check(
          restored.length === original.length,
          `${name} 的临时授权已还原（${probe} 的 ${spec.permission} 恢复为 ${original.length} 行）`,
          `实际 ${restored.length} 行`
        );
      }
    }
  }
}

/* ---------- 3.2 跨酒店隔离 ---------- */

async function auditCrossHotel(ctx) {
  const { h } = ctx;
  console.log("\n=== 运行时校验 B：跨酒店隔离（A 店身份不能操作 B 店数据） ===");

  const modByKey = (key) => NEW_MODULES.find((m) => m.key === key);

  /* B1. ensure*Schema 用别家 hotelId 调用 → FORBIDDEN（否则能往别家灌种子数据） */
  for (const [key, fn, label] of [
    ["ar", "ensureArSchema", "应收"],
    ["points", "ensurePointsSchema", "积分"],
    ["sms", "ensureSmsSeed", "短信"],
  ]) {
    h.useSession(ctx.sidOf.admin);
    const r = await callPositional(ctx.mods[key][fn], [2]);
    check(
      r.kind === "threw" && /FORBIDDEN/.test(r.message),
      `${fn}(2) 用一店管理员身份调用被拒（不能为其他酒店初始化${label}数据）`,
      `实际：${describeResult(r)}`
    );
  }

  /* B2. 二店身份不能删一店的失物记录（一店记录在二店视野里不存在） */
  h.useSession(ctx.sidOf.h2);
  const before = h.one(`SELECT status FROM lost_items WHERE id = ?`, [ctx.ids.lfDelete]);
  const delH2 = await h.invoke(ctx.mods.lf.deleteLostItemAction, {
    id: ctx.ids.lfDelete,
    reason: "跨店试探",
  });
  const after = h.one(`SELECT status FROM lost_items WHERE id = ?`, [ctx.ids.lfDelete]);
  check(
    delH2.kind === "err" && /未找到/.test(delH2.message ?? ""),
    "二店管理员删除一店失物 → 业务层查不到（未找到该失物记录）",
    `实际：${describeResult(delH2)}`
  );
  check(
    Boolean(before) && Boolean(after) && before.status === after.status,
    "一店失物记录在跨店删除尝试后零变化",
    `实际 ${before?.status} → ${after?.status}`
  );

  /* B3. 二店身份不能核销一店的餐券 */
  h.useSession(ctx.sidOf.h2);
  const vBefore = h.one(`SELECT status FROM meal_vouchers WHERE id = ?`, [ctx.ids.voucherXId])?.status;
  const vH2 = await h.invoke(ctx.mods.mv.redeemVoucherByIdAction, { id: ctx.ids.voucherXId });
  const vAfter = h.one(`SELECT status FROM meal_vouchers WHERE id = ?`, [ctx.ids.voucherXId])?.status;
  check(
    vBefore === "UNUSED" && vAfter === "UNUSED" && vH2.kind === "returned",
    "二店管理员按 id 核销一店餐券 → 影响 0 行（餐券仍 UNUSED）",
    `实际 ${vBefore} → ${vAfter}（${describeResult(vH2)}）`
  );

  /* B4. 二店身份租不到一店的物品（查询带 hotel_id，物品不存在） */
  h.useSession(ctx.sidOf.h2);
  const rH2 = await h.invoke(ctx.mods.rent.rentItemAction, { item_id: 1, qty: 1, room_no: "PA-1" });
  check(
    rH2.kind === "err" && /物品不存在/.test(rH2.message ?? ""),
    "二店管理员租一店物品 → 物品不存在（查询带 hotel_id）",
    `实际：${describeResult(rH2)}`
  );

  /* B5. 二店身份改不到一店的公告（deleteNotice 也是 settings.manage → 二店 admin 权限全通过，靠 hotel_id 挡） */
  h.useSession(ctx.sidOf.h2);
  const noticeBefore = h.one(`SELECT COUNT(*) AS n FROM notices WHERE id = ?`, [ctx.ids.noticeDel])?.n ?? 0;
  const nH2 = await h.invoke(ctx.mods.notices.deleteNoticeAction, { id: ctx.ids.noticeDel });
  const noticeAfter = h.one(`SELECT COUNT(*) AS n FROM notices WHERE id = ?`, [ctx.ids.noticeDel])?.n ?? 0;
  check(
    noticeBefore === 1 && noticeAfter === 1 && nH2.kind === "returned",
    "二店管理员按 id 删除一店公告 → 影响 0 行（公告仍在）",
    `实际 ${noticeBefore} → ${noticeAfter}（${describeResult(nH2)}）`
  );

  const mod = modByKey("lf");
  void mod;
}

/* ============================================================ 4. HTTP 运行时校验（可选） */

/** 构造 multipart/form-data 请求体（MPA 表单提交 Server Action 的形态） */
function multipartBody(actionId, fields) {
  const boundary = `----pmsPermCheck${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const push = (name, value) => {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  };
  // Next 的 MPA 表单提交用 $ACTION_ID_<id> 隐藏域标识要执行的 action
  push(`$ACTION_ID_${actionId}`, "");
  for (const [k, v] of Object.entries(fields)) push(k, String(v));
  const body = Buffer.from(`${chunks.join("")}--${boundary}--\r\n`, "utf8");
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: "manual",
  });
  const html = await res.text();
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { ok: html.includes("登录成功") && cookie.length > 0, cookie };
}

async function invokeAction(pagePath, actionId, fields, cookie) {
  const { body, contentType } = multipartBody(actionId, fields);
  const res = await fetch(`${BASE}${pagePath}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": contentType,
      "content-length": String(body.length),
      accept: "text/x-component",
    },
    body,
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, location: res.headers.get("location") || "", text };
}

/** 被服务端拒绝的判据：500，或响应里出现 FORBIDDEN（dev 构建会带错误文案） */
function isDenied(result) {
  return result.status >= 500 || /FORBIDDEN|无权执行|缺少权限/.test(result.text);
}

function loadActionIds() {
  const manifestPath = path.join(ROOT, ".next", "server", "server-reference-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const map = {};
  for (const [id, entry] of Object.entries(manifest.node ?? {})) {
    if (!entry || !entry.filename || !entry.exportedName) continue;
    map[`${entry.filename}#${entry.exportedName}`] = id;
  }
  return map;
}

async function httpRuntimeAudit() {
  console.log("\n=== 运行时校验 C：HTTP 段（front / cashier / housekeeper 直接构造请求） ===");

  if (NO_HTTP) {
    skipRuntime("已用 --no-http / PMS_NO_HTTP=1 关闭，跳过");
    return;
  }

  // 4.1 服务探活（3 秒超时；用 Promise.race 而不是 AbortSignal，避免脚本依赖未声明的全局）
  let alive = false;
  try {
    const probe = fetch(`${BASE}/login`);
    const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error("探活超时")), 3000));
    const res = await Promise.race([probe, timeout]);
    alive = res.status === 200;
  } catch {
    /* 服务没起 / 超时 → alive 保持 false */
  }
  if (!alive) {
    skipRuntime(`服务未启动（${BASE}）→ 跳过 HTTP 段；harness 运行时校验已覆盖 30 个新补 action（服务起来后可重跑）`);
    return;
  }

  // 4.2 构建是否比源码新：旧构建跑不出新代码，运行时结果无意义
  const buildIdPath = path.join(ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    skipRuntime("找不到 .next/BUILD_ID（非 next start 生产构建）→ 跳过 HTTP 段");
    return;
  }
  const buildTime = fs.statSync(buildIdPath).mtimeMs;
  const srcTime = Math.max(...MODULES.map((m) => fs.statSync(path.join(ROOT, m.file)).mtimeMs));
  if (buildTime < srcTime) {
    skipRuntime(
      `3100 上运行的是 ${fmtTime(buildTime)} 的预构建产物，早于本次源码修改（${fmtTime(srcTime)}）；` +
        "需要重新 next build / 启动后本段才会真正执行（本轮整改禁止 next build，故以静态 + harness 运行时为准）"
    );
    return;
  }

  // 4.3 账号准备（密码见 scripts/init-db.mjs 种子数据）
  const accounts = {
    frontdesk: ["front", "123456"],
    cashier: ["cashier", "123456"],
    housekeeping: ["housekeeper", "123456"],
  };
  const cookies = {};
  for (const [role, [user, pwd]] of Object.entries(accounts)) {
    const r = await login(user, pwd);
    check(r.ok, `登录 ${user}（${role}）成功`);
    cookies[role] = r.cookie;
  }

  // 4.4 action id 映射
  const ids = loadActionIds();
  if (!ids) {
    skipRuntime("找不到 .next/server/server-reference-manifest.json → 跳过运行时 action 调用");
    return;
  }

  // 4.5 逐个 action：受限角色必须被拒
  for (const mod of MODULES) {
    for (const [name, spec] of Object.entries(mod.actions)) {
      const actionId = ids[`${mod.file}#${name}`];
      if (!actionId) {
        check(false, `${name} 在构建产物里找不到 action id`, "（构建可能是旧的或该 action 未导出）");
        continue;
      }
      for (const role of spec.rejected) {
        const result = await invokeAction(mod.page, actionId, spec.params, cookies[role]);
        check(
          isDenied(result),
          `${name} 拒绝 ${role} 的越权请求`,
          `（HTTP ${result.status}${result.location ? ` → ${result.location}` : ""}）`
        );
      }
      if (spec.skipAllowedRuntime) {
        console.log(`  ⚪ ${name} 有权限角色会被真跑（会写库），HTTP 段只验证拒绝面，允许面由静态校验保证`);
        continue;
      }
      // 有权限的角色（前台）不应被拒：证明上面的 500 是权限拦截而不是参数错误
      const allowed = await invokeAction(mod.page, actionId, spec.params, cookies.frontdesk);
      check(!isDenied(allowed), `${name} 前台请求未被权限拦截（对照：HTTP ${allowed.status}）`);
    }
  }
}

/* ============================================================ 主流程 */

async function main() {
  console.log("========== 动作层权限验收（55 个 Server Action） ==========");
  console.log(`项目：${ROOT}`);

  const { src: sessionSrc, table } = parsePermissionTable();
  const permCount = Object.keys(table).length;
  console.log(`\n=== src/lib/session.ts PERMISSIONS ===`);
  check(permCount >= 26, `权限点表解析正常（${permCount} 个）`);
  check(
    /if\s*\(\s*role\s*===\s*"admin"\s*\)\s*return true;/.test(sessionSrc),
    "hasPermission 里 admin 默认全通过（不会误伤管理员）"
  );

  /* 副本库先起：静态段要用它核对 role_permissions 与常量表是否一致 */
  let ctx = null;
  try {
    ctx = await prepareRuntime();
  } catch (e) {
    console.error(`❌ 运行时环境准备失败：${e?.stack ?? e}`);
    process.exit(1);
  }
  ctx.constRoles = table;

  const db = makeDbRoles(ctx.h);

  /* 一、静态 */
  for (const mod of MODULES) auditModule(mod, table, db, false);
  for (const mod of NEW_MODULES) auditModule(mod, table, db, true);

  /* 二、运行时：真调 action */
  await auditRuntime(ctx);

  /* 三、跨酒店隔离 */
  await auditCrossHotel(ctx);

  /* 四、HTTP 段（可选） */
  await httpRuntimeAudit();

  /* 运行时证据（给验收报告直接引用） */
  console.log("\n=== 运行时证据 ===");
  console.log("① 撤权 → 被拒（10 例，完整列表见上方逐 action 的 ✅ 行）：");
  for (const [i, e] of evidence.revoked.slice(0, 10).entries()) {
    console.log(`   ${i + 1}. ${e.action}`);
    console.log(`      角色 ${e.role} · 权限点 ${e.permission} → ${e.how}`);
  }
  console.log("② 有权 → 放行并真实写库（10 例）：");
  for (const [i, e] of evidence.allowed.slice(0, 10).entries()) {
    console.log(`   ${i + 1}. ${e.action} · ${e.role} → ${e.how}`);
  }
  console.log("③ 放行后的真实副作用（10 例）：");
  for (const [i, e] of evidence.effects.slice(0, 10).entries()) {
    console.log(`   ${i + 1}. ${e.action} → ${e.how}`);
  }

  /* ---------- 汇总 ---------- */
  console.log("\n========== 汇总 ==========");
  const oldTotal = MODULES.reduce((n, m) => n + Object.keys(m.actions).length, 0);
  const newTotal = NEW_MODULES.reduce((n, m) => n + Object.keys(m.actions).length, 0);
  console.log(
    `受检 action：${oldTotal + newTotal} 个（夜审 2 / 预订 15 / 在住 8 / 本轮补权限 ${newTotal}，共 ${MODULES.length + NEW_MODULES.length} 个文件）`
  );
  console.log(`其中「真调 action」运行时验证：${newTotal} 个（每个 ①拒绝 ②放行 ③授权后放行 ④撤权后拒绝）`);
  console.log(`通过：${pass}    失败：${fail}`);
  /*
   * 跳过不是静默的：HTTP 段没跑时必须在最后一行说出来，避免「只看退出码 = 以为端到端过了」。
   * harness 运行时段（真调 action）没有跳过开关，一定执行。
   */
  if (runtimeSkipReason) {
    console.log(`⚠️  HTTP 段未执行：${runtimeSkipReason}`);
    console.log("    本次运行时段以 harness（真调真实 actions.ts）为准，HTTP 段只是补充");
  }
  if (fail > 0) {
    console.log("\n❌ 未通过项：");
    for (const f of failures) console.log(`   - ${f}`);
    console.log("\n结果：不通过 ❌");
    process.exit(1);
  }
  console.log("\n结果：全部通过 ✅（0 个 ❌）");
}

main().catch((e) => {
  console.error("脚本执行失败：", e);
  process.exit(1);
});
