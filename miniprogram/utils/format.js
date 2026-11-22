/**
 * 展示格式化工具（13 个新页面共用）
 *
 * ── 为什么要单独一层 ──
 * 旧页面的 money / fmtTime 是每个页面各写一份的（index.js、booking.js、orders.js、member.js
 * 各有一个 money()）。新页面有 13 个，再复制 13 份必然出现「同一个金额在 A 页两位小数、
 * 在 B 页一位小数」这种低级不一致。所以金额、日期、手机号脱敏、状态标签全部收敛到这里。
 *
 * ── 约定 ──
 *   · WXML 里只做 `{{item.amountText}}` 插值，不做算术、不 slice、不三元拼字符串
 *   · 服务端可能给 ISO（2026-11-18T06:30:00.000Z）、本地串（2026-11-18 06:30:00）
 *     或纯日期（2026-11-18），三种都要能吃下
 *   · 拿不到值一律返回 '—'（而不是空串）：空串在卡片里看起来像样式塌了
 *   · 状态中文优先用服务端下发的 statusLabel —— 本文件里的 STATUS_LABEL 只是兜底，
 *     不能让客户端成为状态文案的权威来源（新增状态时页面才不会显示英文枚举）
 */

/** 两位补零 */
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 转数字：NaN / 空串 / undefined 一律 0 */
function num(n) {
  var v = Number(n);
  return isFinite(v) ? v : 0;
}

/** 金额：两位小数（'0.00'） */
function money(n) {
  return num(n).toFixed(2);
}

/**
 * 金额带占位：null / undefined / '' → '—'
 *
 * 与 money() 的区别：money(null) 会显示 ¥0.00，而「0.00」和「还没算出来」
 * 是两件事 —— 押金未配置时显示 ¥0.00 会让客人以为不需要押金。
 */
function moneyOrDash(n) {
  if (n === null || n === undefined || n === '') return '—';
  return money(n);
}

/** 整数（间数 / 人数 / 积分），非数字 → 0 */
function int(n) {
  return Math.trunc(num(n));
}

/** 带单位的数量：2 间 / 3 位 / 1 份 */
function count(n, unit) {
  return int(n) + (unit || '');
}

/** 是否为「本地口径」的日期串（无 Z、无时区偏移） */
function isLocalDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !/Z$/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s);
}

/**
 * 统一成 YYYY-MM-DD
 *
 * 带 Z / 时区偏移的串必须经 Date 转本地时区，否则东八区会少一天（见 utils/date.js 的注释）。
 */
function dateOnly(raw) {
  if (!raw) return '';
  var s = String(raw);
  if (isLocalDateStr(s)) return s.slice(0, 10);
  var d = new Date(s);
  if (isNaN(d.getTime())) return s.length >= 10 ? s.slice(0, 10) : s;
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 统一成 YYYY-MM-DD HH:mm（拿不到 → '—'） */
function dateTime(raw) {
  if (!raw) return '—';
  var s = String(raw);
  if (isLocalDateStr(s)) return s.slice(0, 16).replace('T', ' ');
  var d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ');
  return dateOnly(s) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 只要时分：'14:30'（到店时间 / 叫醒时间） */
function timeOnly(raw) {
  if (!raw) return '';
  var s = String(raw);
  var m = s.match(/(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : s;
}

/** 中文日期：11月18日 周二（比 2026-11-18 更适合卡片标题） */
var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dateCN(raw) {
  var d = dateOnly(raw);
  if (!d) return '—';
  var p = d.split('-');
  if (p.length !== 3) return d;
  var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var w = isNaN(dt.getTime()) ? '' : ' ' + WEEK[dt.getDay()];
  return Number(p[1]) + '月' + Number(p[2]) + '日' + w;
}

/**
 * 手机号脱敏：138****8000
 *
 * 服务端已经打过码（含 * ）时**原样返回** —— 再处理一次会把 138****8000 变成 138*********，
 * 那种东西一看就是客户端乱动过的。只有拿到完整 11 位时才在本地兜底打码。
 */
function maskMobile(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (s.indexOf('*') >= 0) return s;
  if (/^1[3-9]\d{9}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-4);
  return s;
}

/** 姓名脱敏：张三 → 张*；欧阳修 → 欧*修（与后端 maskGuestName 同口径） */
function maskName(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (s.indexOf('*') >= 0) return s;
  if (s.length === 1) return s;
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*' + s.slice(-1);
}

/**
 * 身份证脱敏：前 6 后 4，中间 8 个星
 *
 * 小程序只做「预录入」，不做人证核验（没有读卡器，也没有公安接口）。
 * 展示层同样不允许出现完整号码 —— 用户截图转发就等于泄露。
 */
function maskIdNo(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (s.indexOf('*') >= 0) return s;
  if (s.length < 8) return s.slice(0, 2) + '****';
  return s.slice(0, 6) + '********' + s.slice(-4);
}

/** 状态 → chip 配色（与 app.wxss 的 chip-* 一一对应） */
var STATUS_CHIP = {
  PENDING: 'chip-orange',
  CONFIRMED: 'chip',
  CHECKED_IN: 'chip-green',
  INHOUSE: 'chip-green',
  CHECKED_OUT: 'chip-gray',
  CANCELLED: 'chip-gray',
  NOSHOW: 'chip-red',
  COMPLETED: 'chip-green',
  PROCESSING: 'chip-orange',
  DONE: 'chip-green',
  CLOSED: 'chip-gray',
  REJECTED: 'chip-red',
  PAID: 'chip-green',
  UNPAID: 'chip-orange',
  REFUNDED: 'chip-gray',
};

function statusChip(status) {
  return STATUS_CHIP[String(status || '').toUpperCase()] || 'chip-gray';
}

/**
 * 状态中文兜底
 *
 * 服务端有 statusLabel 时页面直接用服务端的；这里只处理服务端漏字段的情况，
 * 免得卡片上出现 CONFIRMED 这种英文字。
 */
var STATUS_LABEL = {
  PENDING: '待确认',
  CONFIRMED: '已确认',
  CHECKED_IN: '已入住',
  INHOUSE: '在住',
  CHECKED_OUT: '已离店',
  CANCELLED: '已取消',
  NOSHOW: '未到店',
  COMPLETED: '已完成',
  PROCESSING: '处理中',
  DONE: '已完成',
  CLOSED: '已关闭',
  REJECTED: '已拒绝',
  PAID: '已支付',
  UNPAID: '未支付',
  REFUNDED: '已退款',
};

function statusLabel(status, fallback) {
  if (fallback) return fallback;
  var key = String(status || '').toUpperCase();
  return STATUS_LABEL[key] || (key ? key : '—');
}

/**
 * 金额合计（客户端只做展示汇总，真实金额永远以服务端为准）
 *
 * 用于「N 项明细合计」这类纯展示场景；账单余额、订单金额必须用服务端字段。
 */
function sum(list, field) {
  var total = 0;
  for (var i = 0; i < (list || []).length; i += 1) {
    total += num(list[i] && list[i][field || 'amount']);
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

/** 现在时刻（本地口径 YYYY-MM-DD HH:mm），用于「期望时间」默认值 */
function nowText() {
  var d = new Date();
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}

/**
 * 多字段名兜底取值
 *
 * 后端 21 个新接口是分批交付的，同一个概念在不同 route 里可能叫 roomTypeName /
 * room_type_name / roomType。页面显示不能因为一个字段名对不上就整块空白，
 * 所以用 keys 依次尝试。注意：**只做字段名兼容，不做假值兜底** ——
 * 全部 key 都没有就返回 fallback（默认空串），绝不编造业务数据。
 */
function first(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback === undefined ? '' : fallback;
  for (var i = 0; i < (keys || []).length; i += 1) {
    var v = obj[keys[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback === undefined ? '' : fallback;
}

module.exports = {
  pad2: pad2,
  num: num,
  money: money,
  moneyOrDash: moneyOrDash,
  int: int,
  count: count,
  dateOnly: dateOnly,
  dateTime: dateTime,
  timeOnly: timeOnly,
  dateCN: dateCN,
  maskMobile: maskMobile,
  maskName: maskName,
  maskIdNo: maskIdNo,
  statusChip: statusChip,
  statusLabel: statusLabel,
  sum: sum,
  nowText: nowText,
  first: first,
};
