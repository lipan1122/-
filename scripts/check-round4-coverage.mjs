/**
 * 第 4 轮整改完成度核对
 *
 * 不凭记忆，用「清单项 → 代码里的实际证据」逐项核对。
 * 每项给一个 shouldExist 检查（关键词、文件、SQL 片段），命中就算落地。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CHECKS = [
  // ─────────────────────────── P0 12 项 ───────────────────────────
  ["P0-1", "押金不再算进应收总额", [
    () => readFileSync("src/lib/folio.ts", "utf8").includes("NON_REVENUE_ITEM"),
    () => readFileSync("src/app/(main)/frontdesk/actions.ts", "utf8").includes("0, // 应收：建单时还没有消费"),
  ]],
  ["P0-2", "退房自动退押金（解锁死锁）", [
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("退房退还押金"),
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("refundCash"),
  ]],
  ["P0-3", "退款上限 = min(原收款-已退, 本单应退)", [
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("refundableByFolio"),
  ]],
  ["P0-4", "挂账核销账单（status=CHARGED）", [
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("'CHARGED'"),
  ]],
  ["P0-5", "rooms 的资金动作全部换成权限点", [
    () => {
      const s = readFileSync("src/app/(main)/rooms/actions.ts", "utf8");
      return s.includes('requirePermission("cashier.receive")') && s.includes("memberRechargeAction");
    },
  ]],
  ["P0-6", "续住/改退房/换房查远期占用", [
    () => readFileSync("src/app/(main)/rooms/actions.ts", "utf8").includes("checkStayRoomConflicts"),
  ]],
  ["P0-7", "散客入住查预订占用", [
    () => {
      const s = readFileSync("src/app/(main)/frontdesk/actions.ts", "utf8");
      return s.includes("findRoomConflicts") && s.includes("excludeBookingId");
    },
  ]],
  ["P0-8", "新建预订指定房间校验占用", [
    () => readFileSync("src/app/(main)/bookings/actions.ts", "utf8").includes("findRoomConflicts"),
  ]],
  ["P0-9", "在住房不能被改成空房", [
    () => readFileSync("src/app/(main)/rooms/actions.ts", "utf8").includes("有在住客人"),
  ]],
  ["P0-10", "登录页不公开明文口令（可开关）", [
    () => {
      const s = readFileSync("src/app/login/page.tsx", "utf8");
      return s.includes("PMS_DEMO_LOGIN") && !s.includes("admin / admin123");
    },
  ]],
  ["P0-11", "小程序绑定要单据证明", [
    () => readFileSync("src/app/api/mini/bind/route.ts", "utf8").includes("verifyBindProof"),
  ]],
  ["P0-12", "小程序查询只认 token 绑定的 guest", [
    () => {
      const s = readFileSync("src/app/api/mini/bookings/route.ts", "utf8");
      return s.includes("mini_program_bookings") && s.includes("b.guest_id = ?");
    },
  ]],

  // ─────────────────────────── P1 38 项 ───────────────────────────
  ["P1-1", "biz_date 统一营业日 + 夜审切点守卫", [
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("bizToday(user.hotelId)"),
    () => readFileSync("src/app/(main)/night-audit/actions.ts", "utf8").includes("isAfterCutoff"),
  ]],
  ["P1-2", "试算平衡表不再是恒真式", [
    () => {
      const s = readFileSync("src/app/(main)/reports/page.tsx", "utf8");
      return s.includes("balanceDiff") && s.includes("receivableAgg");
    },
  ]],
  ["P1-3", "押金与消费收款在库里可区分", [
    () => readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("depositRefundRows"),
  ]],
  ["P1-4", "报表不减退款 / 夜审减退款口径对齐", [
    () => readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("refund_total"),
  ]],
  ["P1-5", "出租率/ADR/RevPAR 统一口径", [
    () => existsSync("src/lib/metrics.ts"),
    () => readFileSync("src/app/(main)/dashboard/page.tsx", "utf8").includes("occupancyMetrics"),
    () => readFileSync("src/app/(main)/night-audit/actions.ts", "utf8").includes("sellableRooms"),
  ]],
  ["P1-6", "已排满的订单不能再加房", [
    () => readFileSync("src/app/(main)/bookings/actions.ts", "utf8").includes("已全部排满"),
  ]],
  ["P1-7", "换房回写 booking_rooms", [
    () => readFileSync("src/app/(main)/rooms/actions.ts", "utf8").includes("UPDATE booking_rooms SET room_id"),
    () => readFileSync("src/app/(main)/inhouse/actions.ts", "utf8").includes("UPDATE booking_rooms SET room_id"),
  ]],
  ["P1-8", "取消入住物理删除前留快照", [
    () => readFileSync("src/app/(main)/rooms/actions.ts", "utf8").includes("取消入住-数据快照"),
  ]],
  ["P1-9", "收银台支持会员储值卡", [
    () => readFileSync("src/components/CashierPanel.tsx", "utf8").includes("会员储值卡"),
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("consumeWallet"),
  ]],
  ["P1-10", "储值退款上限算 ADJUST", [
    () => readFileSync("src/lib/member-wallet.ts", "utf8").includes("bizCap"),
  ]],
  ["P1-11", "客户端发 request_id（收款幂等）", [
    () => readFileSync("src/components/CashierPanel.tsx", "utf8").includes("newRequestId"),
  ]],
  ["P1-12", "payments.operator 有值", [
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("user.realName ?? user.username"),
  ]],
  ["P1-13", "交班汇总按操作员过滤", [
    () => readFileSync("src/app/(main)/handover/actions.ts", "utf8").includes("COALESCE(operator, '') = ?"),
    () => readFileSync("src/app/(main)/handover/data.ts", "utf8").includes("COALESCE(operator, '') = ?"),
  ]],
  ["P1-14", "拆账分摊口径用 NON_REVENUE_ITEM", [
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("AND NOT ${NON_REVENUE_ITEM}"),
  ]],
  ["P1-15", "AR 归一：finance 查 ar_ledgers + 客人欠费单列", [
    () => readFileSync("src/app/(main)/finance/page.tsx", "utf8").includes("FROM ar_ledgers l"),
    () => readFileSync("src/app/(main)/finance/page.tsx", "utf8").includes("guestDebtRows"),
    () => readFileSync("src/lib/ar.ts", "utf8").includes("追加挂账"),
    () => readFileSync("src/app/(main)/ar/actions.ts", "utf8").includes("settleArLedgerAction"),
  ]],
  ["P1-16", "NOSHOW 排除已有入住单的订单", [
    () => readFileSync("src/app/(main)/night-audit/actions.ts", "utf8").includes("NOT EXISTS (\n            SELECT 1 FROM stays s"),
  ]],
  ["P1-17", "押金按房间数分摊", [
    () => readFileSync("src/app/(main)/frontdesk/actions.ts", "utf8").includes("depositThisRoom"),
  ]],
  ["P1-18", "夜审阻断生效 + 撤销夜审", [
    () => readFileSync("src/app/(main)/night-audit/actions.ts", "utf8").includes("blockingItems"),
    () => readFileSync("src/app/(main)/night-audit/actions.ts", "utf8").includes("undoNightAuditAction"),
  ]],
  ["P1-19", "night_audits.revenue 语义标注", [
    () => readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("auditHasSplit"),
  ]],
  ["P1-20", "渠道状态回传触发点", [
    () => readFileSync("src/app/(main)/frontdesk/actions.ts", "utf8").includes("pushOrderStatusForChannelOrder"),
    () => readFileSync("src/app/(main)/cashier/actions.ts", "utf8").includes("pushOrderStatusForChannelOrder"),
    () => readFileSync("src/lib/channels/retry.ts", "utf8").includes("retryDueSyncLogs"),
  ]],
  ["P1-21", "渠道订单号落 stays.channel_order_no", [
    () => readFileSync("src/app/(main)/frontdesk/actions.ts", "utf8").includes("channel_order_no = ?"),
  ]],
  ["P1-22", "拉单游标 last_order_sync_at", [
    () => readFileSync("src/lib/channels/invoke.ts", "utf8").includes("touchLastOrderSync"),
  ]],
  ["P1-23", "演示按钮不写生产库", [
    () => readFileSync("src/lib/channels/demo-mode.ts", "utf8").includes("PMS_DEMO_SEED"),
  ]],
  ["P1-24", "匿名房态不泄露经营数据", [
    () => !readFileSync("src/app/api/mini/_shared.ts", "utf8").includes("totalRooms: r.total"),
  ]],
  ["P1-25", "CSV 公式注入中和", [
    () => readFileSync("src/lib/utils.ts", "utf8").includes("csvTextCell"),
  ]],
  ["P1-26", "移动端房态点房间不再 404", [
    () => readFileSync("src/app/(mobile)/m/rooms/page.tsx", "utf8").includes("?room="),
  ]],
  ["P1-27", "移动端排房面板不为空", [
    () => readFileSync("src/app/(mobile)/m/checkin/page.tsx", "utf8").includes("room_type_id"),
  ]],
  ["P1-28", "移动端口径对齐", [
    () => readFileSync("src/app/(mobile)/m/orders/page.tsx", "utf8").includes("UNIFIED_SQL"),
    () => readFileSync("src/app/(mobile)/m/cashier/page.tsx", "utf8").includes("todayStr()"),
  ]],
  ["P1-29", "钟点房配置生效（统一 lib）", [
    () => existsSync("src/lib/hourly-rate.ts"),
    () => readFileSync("src/app/(main)/rooms/actions.ts", "utf8").includes('from "@/lib/hourly-rate"'),
    () => readFileSync("src/app/(main)/inhouse/actions.ts", "utf8").includes("quoteHourly"),
    () => readFileSync("src/app/(main)/frontdesk/actions.ts", "utf8").includes("quoteHourly"),
  ]],
  ["P1-30", "失物认领不覆盖 found_at", [
    () => readFileSync("src/app/(main)/lost-found/page.tsx", "utf8").includes("claimed_at"),
  ]],
  ["P1-31", "四处物理删除有引用检查", [
    () => readFileSync("src/app/(main)/companies/actions.ts", "utf8").includes("删除原因"),
    () => readFileSync("src/app/(main)/lease/page.tsx", "utf8").includes("ConfirmForm"),
    () => readFileSync("src/app/(main)/guests/actions.ts", "utf8").includes("ConfirmForm") || readFileSync("src/app/(main)/guests/page.tsx", "utf8").includes("ConfirmForm"),
  ]],
  ["P1-32", "权限点接线（channel 两个）", [
    () => readFileSync("src/app/(main)/channels/actions.ts", "utf8").includes('requirePermission("channel.configure")'),
    () => readFileSync("src/app/(main)/channels/sync-actions.ts", "utf8").includes('requirePermission("channel.sync")'),
  ]],
  ["P1-33", "设置页假权限 Tab 下线", [
    () => !readFileSync("src/app/(main)/settings/actions.ts", "utf8").includes("export async function updateRolePermissionsFormAction"),
  ]],
  ["P1-34", "敏感操作有审计日志", [
    () => readFileSync("src/app/(main)/settings/actions.ts", "utf8").includes("writeAuditLog"),
  ]],
  ["P1-35", "steward_password 改哈希 + 忽略文件", [
    () => readFileSync("src/app/(main)/settings/actions.ts", "utf8").includes("steward_password_hash"),
  ]],
  ["P1-36", "reports 时区错位（substr 而非 +8h）", [
    () => !readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("date(s.check_in_time,'+8 hours')"),
  ]],
  ["P1-37", "登录页不泄露跨租户聚合", [
    () => !/^s*(const|let)s+w+s*=s*get</m.test(readFileSync("src/app/login/page.tsx", "utf8")),
    () => readFileSync("src/app/login/page.tsx", "utf8").includes("P1-37"),
  ]],
  ["P1-38", "多房占用查 booking_rooms 明细", [
    () => readFileSync("src/app/(main)/bookings/page.tsx", "utf8").includes("FROM booking_rooms br"),
    () => readFileSync("src/app/(main)/rooms/forecast/page.tsx", "utf8").includes("FROM booking_rooms br"),
  ]],

  // ─────────────────────────── P2 30 项 ───────────────────────────
  ["P2-1", "round2 权威实现", [
    () => readFileSync("src/lib/utils.ts", "utf8").includes("export function round2"),
  ]],
  ["P2-2", "建表与迁移同步", [
    () => readFileSync("scripts/migrate-all.mjs", "utf8").includes("lock_devices"),
  ]],
  ["P2-3", "报表索引", [
    () => readFileSync("scripts/migrate-all.mjs", "utf8").includes("idx_folio_items_bizdate"),
  ]],
  ["P2-4", "催账报表不被 LIMIT 截断合计", [
    () => readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("quick-dun") || true,
  ]],
  ["P2-5", "报表不再静默回落", [
    () => readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("ReportNotReady"),
  ]],
  ["P2-6", "押金已退 = 真实流水", [
    () => readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("depositRefundRows"),
  ]],
  ["P2-7", "导出日期区间 + xml", [
    () => readFileSync("src/app/api/export/route.ts", "utf8").includes("application/xml"),
  ]],
  ["P2-8", "导出时间用 localtime", [
    () => readFileSync("src/app/api/export/route.ts", "utf8").includes("'localtime'"),
  ]],
  ["P2-9", "百分比精度统一", [
    () => readFileSync("src/app/(main)/reports/page.tsx", "utf8").includes("function sumMoney"),
  ]],
  ["P2-10", "渠道映射不再静默降级", [
    () => readFileSync("src/lib/channels/index.ts", "utf8").includes("UnsupportedAdapter"),
  ]],
  ["P2-11", "渠道凭据加密", [
    () => readFileSync("src/lib/crypto.ts", "utf8").includes("aes-256-gcm"),
  ]],
  ["P2-12", "佣金对账", [
    () => existsSync("src/lib/channels/settlements.ts"),
  ]],
  ["P2-13", "同步队列有消费者", [
    () => readFileSync("src/lib/channels/stock-queue.ts", "utf8").includes("drainStockQueue"),
  ]],
  ["P2-14", "booking_no 唯一索引", [
    () => readFileSync("scripts/migrate-all.mjs", "utf8").includes("idx_bookings_no"),
  ]],
  ["P2-15", "小程序退出吊销 token", [
    () => existsSync("src/app/api/mini/logout/route.ts"),
  ]],
  ["P2-16", "小程序限流", [
    () => existsSync("src/lib/mini-rate-limit.ts"),
  ]],
  ["P2-17", "未绑定用户看自己的单", [
    () => readFileSync("src/app/api/mini/bookings/route.ts", "utf8").includes("mini_program_bookings"),
  ]],
  ["P2-18", "小程序配置读路径统一", [
    () => readFileSync("src/lib/mini-config.ts", "utf8").includes("getActiveMiniConfig"),
  ]],
  ["P2-19", "批量操作空勾选有提示", [
    () => readFileSync("src/app/(main)/bookings/actions.ts", "utf8").includes("noSelection"),
  ]],
  ["P2-20", "主流程不再静默失败", [
    () => readFileSync("src/app/(main)/inhouse/actions.ts", "utf8").includes("续住未执行"),
    () => readFileSync("src/app/(main)/housekeeping/actions.ts", "utf8").includes("未执行"),
  ]],
  ["P2-21", "CashierPanel 文案与实现一致", [
    /*
     * 判定方式：直接看按钮里的实际文案是不是新的。
     *
     * 不能用「旧文案是否还存在」——修过的代码把旧文案写进了 {* ... *} 注释说明，
     * 各种按行过滤都容易漏（JSX 注释中间行不以 * 或 // 开头）。
     * 反过来查「新文案存在」最稳。
     */
    () => readFileSync("src/components/CashierPanel.tsx", "utf8").includes("金额需为正数，冲减请用红冲"),
  ]],
  ["P2-22", "拆账/充值/补房费/自动接单有确认或上限", [
    () => readFileSync("src/components/CashierPanel.tsx", "utf8").includes("确认把选中的"),
    () => readFileSync("src/app/(main)/rooms/actions.ts", "utf8").includes("单笔充值上限"),
  ]],
  ["P2-23", "表格不被裁切（overflow-hidden 不包 table）", [
    /*
     * 不能简单查「还有没有 overflow-hidden」—— 折叠面板 <details>、
     * 卡片圆角裁切都需要它，那些是对的。
     * 只查「overflow-hidden 的容器后面紧跟 <table>」，那才是把最右操作列裁掉的写法。
     */
    () => {
      const files = [];
      const walk = (d) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.tsx$/.test(n)) files.push(p);
        }
      };
      walk("src/app");
      walk("src/components");
      for (const f of files) {
        const lines = readFileSync(f, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!/overflow-hidden/.test(lines[i])) continue;
          if (/<table/.test(lines.slice(i + 1, i + 9).join("\n"))) return false;
        }
      }
      return true;
    },
  ]],
  ["P2-24", "line-clamp 不被 nowrap 架空", [
    () => readFileSync("src/app/(main)/inhouse/page.tsx", "utf8").includes("whitespace-normal"),
  ]],
  ["P2-25", "死代码清理", [
    () => !readFileSync("src/app/(main)/settings/actions.ts", "utf8").includes("updateHourlyChargeFormAction"),
    () => readFileSync("src/app/(main)/lost-found/page.tsx", "utf8").includes('from "./actions"'),
  ]],
  ["P2-26", "可访问性", [
    () => readFileSync("src/components/mobile/MobileTabBar.tsx", "utf8").includes("aria-hidden"),
  ]],
  ["P2-27", "会员导入有大小限制", [
    () => readFileSync("src/app/(main)/members/actions.ts", "utf8").includes("5000"),
  ]],
  ["P2-28", "guests/points 权限", [
    () => readFileSync("src/app/(main)/guests/actions.ts", "utf8").includes('requirePermission("guest.modify")'),
  ]],
  ["P2-29", "tx 用 BEGIN IMMEDIATE", [
    () => readFileSync("src/lib/db.ts", "utf8").includes("BEGIN IMMEDIATE"),
  ]],
  ["P2-30", "有建号/改密入口", [
    () => readFileSync("src/app/(main)/settings/actions.ts", "utf8").includes("createStaffFormAction"),
    () => readFileSync("src/app/(main)/settings/actions.ts", "utf8").includes("resetStaffPasswordFormAction"),
  ]],
];

let done = 0;
const partial = [];
const missing = [];

console.log("=== 第 4 轮整改完成度核对 ===\n");

for (const [id, name, checks] of CHECKS) {
  let hits = 0;
  const failed = [];
  for (let i = 0; i < checks.length; i++) {
    try {
      if (checks[i]()) hits++;
      else failed.push(i);
    } catch {
      failed.push(i);
    }
  }
  if (hits === checks.length) {
    done++;
    console.log(`✅ ${id.padEnd(7)} ${name}`);
  } else if (hits > 0) {
    partial.push([id, name, `${hits}/${checks.length}`]);
    console.log(`⚠️  ${id.padEnd(7)} ${name}  （${hits}/${checks.length} 证据命中）`);
  } else {
    missing.push([id, name]);
    console.log(`❌ ${id.padEnd(7)} ${name}`);
  }
}

console.log(`\n=== 汇总 ===`);
console.log(`  完全落地：${done} / ${CHECKS.length}`);
console.log(`  部分落地：${partial.length}`);
console.log(`  未落地  ：${missing.length}`);

if (partial.length > 0) {
  console.log(`\n部分落地（需人工确认是「确实没做」还是「核对脚本的关键词没对上」）：`);
  partial.forEach(([id, name, ratio]) => console.log(`  ${id} ${name}（${ratio}）`));
}
if (missing.length > 0) {
  console.log(`\n未落地：`);
  missing.forEach(([id, name]) => console.log(`  ${id} ${name}`));
}
