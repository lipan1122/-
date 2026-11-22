import { NextResponse } from "next/server";
import { all } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/session";

/**
 * 数据导出（Excel 2003 XML Spreadsheet）
 *
 * ── 为什么是 .xml 而不是 .xls（整改清单 P2-7）──
 * 本文件输出的是 SpreadsheetML 2003（`<?mso-application progid="Excel.Sheet"?>`），
 * 它既不是 BIFF 的 .xls，也不是 OOXML 的 .xlsx。以前文件名给 .xls、content-type 给
 * `application/vnd.ms-excel`，Excel 2016+ 打开时会弹「文件格式与扩展名不一致」——
 * 文件其实能开，但那句警告让用户以为导出坏了。少一个依赖（没有引入 xlsx/exceljs）
 * 的前提下，正确做法是让扩展名说真话：`.xml` + `application/xml`。
 * Excel / WPS 都能直接打开，下载下来也不会再触发格式告警。
 *
 * ── 日期区间（P2-7）──
 * 每个数据集都支持 from/to；「夜审记录」原来完全忽略区间、导出全量历史，
 * 而页面文案却写着「按当前报表日期区间导出」。现在两者一致。
 *
 * ── 上限（P2-7）──
 * 单次最多 EXPORT_LIMIT 条，超过时截断并在副标题里明确提示，避免在浏览器里
 * 拼一个几十万行的 XML 字符串（服务端 OOM / 下载后 Excel 也打不开）。
 *
 * 用法：
 *   /api/export?type=guests
 *   /api/export?type=bookings&from=2026-11-01&to=2026-11-30
 *   /api/export?type=stays
 *   /api/export?type=folio-items&from=...&to=...
 *   /api/export?type=payments&from=...&to=...
 *   /api/export?type=night-audits&from=...&to=...
 */

/** 单次导出行数上限（P2-7） */
const EXPORT_LIMIT = 50000;

type Column = { key: string; label: string; width?: number; money?: boolean; date?: boolean };

type Dataset = {
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  /** 哪些角色能导出（permission 为空时才使用；保留给尚未迁到权限点的数据集） */
  allow: string[];
  /**
   * 该数据集要求的权限点（上线前加固）
   *
   * 有 permission 时优先按权限点判断（admin 由 hasPermission 默认全通过），
   * 不再信任 allow 角色白名单 —— 角色权限在设置页改了之后这里立即生效。
   */
  permission?: string;
};

function xmlEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, " ");
}

function colName(i: number): string {
  // 0 → A, 25 → Z, 26 → AA
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildXls(title: string, columns: Column[], rows: Record<string, unknown>[], subtitle: string): string {
  const head = columns
    .map(
      (c) =>
        `<Cell ss:StyleID="head"><Data ss:Type="String">${xmlEscape(c.label)}</Data></Cell>`
    )
    .join("");

  const body = rows
    .map((r) => {
      const cells = columns
        .map((c) => {
          const v = r[c.key];
          if (c.money) {
            return `<Cell ss:StyleID="money"><Data ss:Type="Number">${Number(v ?? 0)}</Data></Cell>`;
          }
          if (c.date) {
            return `<Cell ss:StyleID="text"><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`;
          }
          return `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`;
        })
        .join("");
      return `<Row>${cells}</Row>`;
    })
    .join("");

  const colDefs = columns
    .map((c) => `<Column ss:Width="${c.width ?? 90}"/>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="title">
      <Font ss:Bold="1" ss:Size="14"/>
    </Style>
    <Style ss:ID="sub">
      <Font ss:Color="#666666" ss:Size="10"/>
    </Style>
    <Style ss:ID="head">
      <Font ss:Bold="1"/>
      <Interior ss:Color="#EAF3EF" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
      </Borders>
    </Style>
    <Style ss:ID="money">
      <NumberFormat ss:Format="#,##0.00"/>
    </Style>
    <Style ss:ID="text">
      <NumberFormat ss:Format="@"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="${xmlEscape(title).slice(0, 30)}">
    <Table>
      ${colDefs}
      <Row><Cell ss:MergeAcross="${Math.max(0, columns.length - 1)}" ss:StyleID="title"><Data ss:Type="String">${xmlEscape(
        title
      )}</Data></Cell></Row>
      <Row><Cell ss:MergeAcross="${Math.max(0, columns.length - 1)}" ss:StyleID="sub"><Data ss:Type="String">${xmlEscape(
        subtitle
      )}</Data></Cell></Row>
      <Row></Row>
      <Row>${head}</Row>
      ${body}
    </Table>
  </Worksheet>
</Workbook>`;
}

function ymd(v: string | null | undefined): string {
  if (!v) return "";
  return String(v).slice(0, 10);
}

/** 手机号脱敏：13812340001 → 138****0001 */
function maskMobile(mobile: unknown): string {
  const s = String(mobile ?? "").replace(/\s/g, "");
  if (!s) return "";
  if (s.length < 7) return "***";
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 证件号脱敏：110101199001011234 → 1101**********1234 */
function maskIdNo(idNo: unknown): string {
  const s = String(idNo ?? "").trim();
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}${"*".repeat(s.length - 8)}${s.slice(-4)}`;
}

export async function GET(req: Request) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const hotelId = user.hotelId;
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  let dataset: Dataset;

  /*
   * 敏感信息权限（上线前加固）：决定导出表里的手机号 / 证件号给不给明文。
   * guest.view_sensitive 只有 admin / frontdesk 有，收银导出的名单必须是脱敏的。
   */
  const canSeeSensitive = hasPermission(user.role, "guest.view_sensitive", user.hotelId);

  switch (type) {
    case "guests":
      dataset = {
        title: "宾客列表",
        // 权限矩阵里 guest.view_sensitive 只给 admin / frontdesk，收银不该出现在这个白名单里
        allow: ["admin", "frontdesk"],
        // 真正的判定走权限点（见 switch 之后的校验），allow 只是兜底
        permission: "guest.view_sensitive",
        columns: [
          { key: "name", label: "客人姓名", width: 90 },
          { key: "mobile", label: canSeeSensitive ? "手机" : "手机（脱敏）", width: 100 },
          { key: "id_no", label: canSeeSensitive ? "证件号" : "证件号（脱敏）", width: 150 },
          { key: "vip_level", label: "会员等级", width: 70 },
          { key: "company", label: "协议单位", width: 110 },
          { key: "created_at", label: "建档时间", width: 120 },
        ],
        rows: all(
          `SELECT name, COALESCE(mobile,'') AS mobile, COALESCE(id_no,'') AS id_no,
                  COALESCE(vip_level,0) AS vip_level, COALESCE(company,'') AS company,
                  substr(COALESCE(datetime(created_at,'localtime'),''),1,16) AS created_at
             FROM guests WHERE hotel_id = ? AND COALESCE(deleted,0) = 0 ORDER BY id DESC
             LIMIT ${EXPORT_LIMIT + 1}`,
          [hotelId]
        ).map((r) => ({
          ...r,
          // 纵深防御：即使将来放开了本数据集的权限点，没有 guest.view_sensitive 也拿不到明文
          mobile: canSeeSensitive ? r.mobile : maskMobile(r.mobile),
          id_no: canSeeSensitive ? r.id_no : maskIdNo(r.id_no),
        })),
      };
      break;

    case "bookings":
      dataset = {
        title: "预订列表",
        allow: ["admin", "frontdesk"],
        columns: [
          { key: "booking_no", label: "预订号", width: 80 },
          { key: "guest_name", label: "客人", width: 80 },
          { key: "mobile", label: "手机", width: 100 },
          { key: "room_type", label: "房型", width: 90 },
          { key: "room_no", label: "房号", width: 60 },
          { key: "check_in_date", label: "到店", width: 85, date: true },
          { key: "check_out_date", label: "离店", width: 85, date: true },
          { key: "nights", label: "晚数", width: 50 },
          { key: "room_count", label: "房数", width: 50 },
          { key: "rate", label: "房价", width: 70, money: true },
          { key: "channel", label: "渠道", width: 80 },
          { key: "status", label: "状态", width: 80 },
        ],
        rows: all(
          `SELECT b.booking_no, b.guest_name, COALESCE(b.mobile,'') AS mobile,
                  COALESCE(rt.name,'') AS room_type, COALESCE(r.room_no,'') AS room_no,
                  b.check_in_date, b.check_out_date, COALESCE(b.nights,0) AS nights,
                  COALESCE(b.room_count,1) AS room_count, COALESCE(b.rate,0) AS rate,
                  COALESCE(c.name,'散客') AS channel, b.status
             FROM bookings b
             LEFT JOIN room_types rt ON rt.id = b.room_type_id
             LEFT JOIN rooms r ON r.id = b.room_id
             LEFT JOIN channels c ON c.id = b.channel_id
            WHERE b.hotel_id = ?
              ${from ? "AND b.check_in_date >= ?" : ""}
              ${to ? "AND b.check_in_date <= ?" : ""}
            ORDER BY b.check_in_date DESC, b.id DESC
            LIMIT ${EXPORT_LIMIT + 1}`,
          [hotelId, ...(from ? [from] : []), ...(to ? [to] : [])]
        ),
      };
      break;

    case "stays":
      dataset = {
        title: "在住与历史入住",
        /*
         * 上线前加固：这份导出含客人手机号（敏感个人信息）。
         * 绑定 guest.view_sensitive 权限点（只给 admin/frontdesk），
         * 收银员导出会 403 —— 与权限矩阵保持一致，不再靠角色白名单。
         */
        allow: ["admin", "frontdesk"],
        permission: "guest.view_sensitive",
        columns: [
          { key: "stay_no", label: "入住单号", width: 80 },
          { key: "guest_name", label: "客人", width: 80 },
          { key: "mobile", label: "手机", width: 100 },
          { key: "room_no", label: "房号", width: 60 },
          { key: "check_in", label: "入住", width: 85, date: true },
          { key: "expect_out", label: "预离", width: 85, date: true },
          { key: "actual_out", label: "实离", width: 85, date: true },
          { key: "nights", label: "晚数", width: 50 },
          { key: "rate", label: "房价", width: 70, money: true },
          { key: "balance", label: "余额", width: 70, money: true },
          { key: "status", label: "状态", width: 80 },
        ],
        rows: all(
          `SELECT s.stay_no, s.guest_name, COALESCE(s.mobile,'') AS mobile, r.room_no,
                  substr(COALESCE(datetime(s.check_in_time,'localtime'),''),1,10) AS check_in,
                  s.expect_check_out AS expect_out, COALESCE(s.actual_check_out,'') AS actual_out,
                  COALESCE(s.nights,0) AS nights, COALESCE(s.rate,0) AS rate,
                  COALESCE(f.balance,0) AS balance, s.status
             FROM stays s
             LEFT JOIN rooms r ON r.id = s.room_id
             LEFT JOIN folios f ON f.stay_id = s.id
            WHERE s.hotel_id = ?
              ${from ? "AND date(s.check_in_time,'localtime') >= ?" : ""}
              ${to ? "AND date(s.check_in_time,'localtime') <= ?" : ""}
            ORDER BY s.id DESC
            LIMIT ${EXPORT_LIMIT + 1}`,
          [hotelId, ...(from ? [from] : []), ...(to ? [to] : [])]
        ),
      };
      break;

    case "folio-items":
      dataset = {
        title: "账务流水明细",
        allow: ["admin", "cashier"],
        columns: [
          { key: "biz_date", label: "营业日", width: 85, date: true },
          { key: "folio_no", label: "账单号", width: 80 },
          { key: "room_no", label: "房号", width: 60 },
          { key: "guest_name", label: "客人", width: 80 },
          { key: "item_type", label: "类型", width: 60 },
          { key: "description", label: "项目", width: 160 },
          { key: "qty", label: "数量", width: 50 },
          { key: "price", label: "单价", width: 70, money: true },
          { key: "amount", label: "金额", width: 80, money: true },
        ],
        rows: all(
          `SELECT fi.biz_date, f.folio_no, COALESCE(f.room_no,'') AS room_no,
                  COALESCE(f.guest_name,'') AS guest_name, fi.item_type,
                  COALESCE(fi.description,'') AS description,
                  COALESCE(fi.qty,1) AS qty, COALESCE(fi.price,0) AS price, COALESCE(fi.amount,0) AS amount
             FROM folio_items fi
             JOIN folios f ON f.id = fi.folio_id
            WHERE fi.hotel_id = ?
              ${from ? "AND fi.biz_date >= ?" : ""}
              ${to ? "AND fi.biz_date <= ?" : ""}
            ORDER BY fi.biz_date DESC, fi.id DESC
            LIMIT ${EXPORT_LIMIT + 1}`,
          [hotelId, ...(from ? [from] : []), ...(to ? [to] : [])]
        ),
      };
      break;

    case "payments":
      dataset = {
        title: "收款流水",
        allow: ["admin", "cashier"],
        columns: [
          { key: "biz_date", label: "营业日", width: 85, date: true },
          { key: "pay_no", label: "收款单号", width: 80 },
          { key: "folio_no", label: "账单号", width: 80 },
          { key: "method", label: "方式", width: 70 },
          { key: "amount", label: "金额", width: 80, money: true },
          { key: "remark", label: "备注", width: 160 },
          { key: "operator", label: "操作人", width: 80 },
        ],
        rows: all(
          `SELECT p.biz_date, COALESCE(p.pay_no,'') AS pay_no, COALESCE(f.folio_no,'') AS folio_no,
                  COALESCE(p.method,'') AS method, COALESCE(p.amount,0) AS amount,
                  COALESCE(p.remark,'') AS remark, COALESCE(p.operator,'') AS operator
             FROM payments p
             LEFT JOIN folios f ON f.id = p.folio_id
            WHERE p.hotel_id = ?
              ${from ? "AND p.biz_date >= ?" : ""}
              ${to ? "AND p.biz_date <= ?" : ""}
            ORDER BY p.id DESC
            LIMIT ${EXPORT_LIMIT + 1}`,
          [hotelId, ...(from ? [from] : []), ...(to ? [to] : [])]
        ),
      };
      break;

    case "night-audits":
      /*
       * 夜审记录导出（整改清单 P2-7 / P2-8 / P1-19）
       *
       * P2-7 日期区间：原来 SQL 里没有 from/to，页面却写着「按当前报表日期区间导出」，
       *      点一下导出的是全部历史。现在与页面 href 传的区间一致。
       * P2-8 执行时间：原来 `substr(created_at,1,16)` 直接截 UTC 串，
       *      Excel 里比页面（本地时间）早 8 小时。改用 'localtime' 修饰符 ——
       *      它对 UTC 串（历史 nowIso）和带 +08:00 的本地串（新的 nowLocalIso）
       *      都能算出同一个本地时间；硬编码 '+8 hours' 会把后者重复加一次。
       * P1-19 营收口径：兼容列 revenue 新行是净额、历史行是毛额。直接导出 revenue
       *      混合口径，所以按「有无分列数据」取值，并单列一列写明该行口径，
       *      与 reports/page.tsx 的 auditHasSplit() 判定一致。
       * 出租率：库里存 0~1 比率，导出成「65.22%」字符串 —— 否则 Excel 里
       *      0.6522 挂在「出租率」列头下很容易被读成 0.65%。
       */
      dataset = {
        title: "夜审记录",
        allow: ["admin", "cashier"],
        columns: [
          { key: "biz_date", label: "营业日", width: 90, date: true },
          { key: "status", label: "状态", width: 70 },
          { key: "rooms_sold", label: "售出房", width: 70 },
          { key: "occupancy_text", label: "出租率", width: 70 },
          { key: "revenue", label: "营收", width: 90, money: true },
          { key: "revenue_basis", label: "营收口径", width: 90 },
          { key: "operator", label: "操作人", width: 80 },
          { key: "created_at", label: "执行时间", width: 130 },
        ],
        rows: all(
          `SELECT biz_date, status, COALESCE(rooms_sold,0) AS rooms_sold,
                  printf('%.2f%%', COALESCE(occupancy,0) * 100) AS occupancy_text,
                  CASE
                    WHEN COALESCE(revenue_room,0) <> 0 OR COALESCE(revenue_food,0) <> 0
                      OR COALESCE(revenue_other,0) <> 0 OR COALESCE(refund_total,0) <> 0
                    THEN COALESCE(revenue_net,0) ELSE COALESCE(revenue,0)
                  END AS revenue,
                  CASE
                    WHEN COALESCE(revenue_room,0) <> 0 OR COALESCE(revenue_food,0) <> 0
                      OR COALESCE(revenue_other,0) <> 0 OR COALESCE(refund_total,0) <> 0
                    THEN '净额' ELSE '毛额（历史行）'
                  END AS revenue_basis,
                  COALESCE(operator,'') AS operator,
                  substr(COALESCE(datetime(created_at,'localtime'),''),1,16) AS created_at
             FROM night_audits WHERE hotel_id = ?
               ${from ? "AND biz_date >= ?" : ""}
               ${to ? "AND biz_date <= ?" : ""}
             ORDER BY biz_date DESC
             LIMIT ${EXPORT_LIMIT + 1}`,
          [hotelId, ...(from ? [from] : []), ...(to ? [to] : [])]
        ),
      };
      break;

    default:
      return NextResponse.json(
        {
          error: "未知的导出类型",
          types: ["guests", "bookings", "stays", "folio-items", "payments", "night-audits"],
        },
        { status: 400 }
      );
  }

  /*
   * 权限校验（报告 P0-3：服务端必须自己校验，不能只藏按钮）
   *
   * 上线前加固：含客人敏感信息的导出不再用「角色白名单」拍脑袋判断 ——
   * 声明了 permission 的数据集直接查权限点（设置页改完立刻生效），
   * 其余数据集暂时保留 allow 白名单。
   */
  if (dataset.permission) {
    if (!hasPermission(user.role, dataset.permission, user.hotelId)) {
      return NextResponse.json({ error: "当前角色无权导出该数据" }, { status: 403 });
    }
  } else if (user.role !== "admin" && !dataset.allow.includes(user.role)) {
    return NextResponse.json({ error: "当前角色无权导出该数据" }, { status: 403 });
  }

  /*
   * 行数上限（整改清单 P2-7）
   *
   * 各数据集 SQL 统一 `LIMIT EXPORT_LIMIT + 1`：多查一条只为判断「是否被截断」。
   * 截断必须写在副标题里 —— 静默截断比直接报错更危险，用户会拿一份不全的流水去对账。
   */
  const truncated = dataset.rows.length > EXPORT_LIMIT;
  if (truncated) dataset.rows = dataset.rows.slice(0, EXPORT_LIMIT);

  const range =
    from || to ? `　范围：${from || "不限"} ~ ${to || "不限"}` : "";
  const limitNote = truncated
    ? `　⚠ 已达单次导出上限 ${EXPORT_LIMIT} 条，本次仅含前 ${EXPORT_LIMIT} 条，请缩小日期区间分批导出`
    : "";
  const subtitle = `导出时间：${now.toLocaleString("zh-CN")}　操作人：${user.realName ?? user.username}${range}　共 ${dataset.rows.length} 条${limitNote}`;

  const xml = buildXls(dataset.title, dataset.columns, dataset.rows, subtitle);
  /*
   * 扩展名与真实格式一致（P2-7）：内容是 SpreadsheetML 2003，不是 BIFF 的 .xls。
   * 用 .xml + application/xml 打开时不会再弹「文件格式与扩展名不一致」。
   */
  const filename = `${dataset.title}-${stamp}.xml`;

  return new NextResponse(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`,
      "cache-control": "no-store",
    },
  });
}
