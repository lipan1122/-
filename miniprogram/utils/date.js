/**
 * 日期工具（小程序端）
 *
 * 为什么不用 new Date('2026-11-18')：
 *   iOS 的 JSCore 对 `YYYY-MM-DD` 字符串按 UTC 解析，东八区会少一天，
 *   小程序里表现为「今天」变成「昨天」。所以一律拆成数字后用 new Date(y, m-1, d) 构造本地时间。
 */

/** 两位补零 */
function pad2(n) {
  return String(n).padStart ? String(n).padStart(2, '0') : (n < 10 ? '0' + n : '' + n);
}

/** Date → YYYY-MM-DD */
function fmt(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/** 今天（本地时间） */
function today() {
  return fmt(new Date());
}

/** YYYY-MM-DD → Date（本地 0 点） */
function parse(str) {
  var p = String(str || '').split('-');
  if (p.length !== 3) return new Date();
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

/** 日期加减天数，返回 YYYY-MM-DD */
function addDays(str, n) {
  var d = parse(str);
  d.setDate(d.getDate() + n);
  return fmt(d);
}

/** 相差天数（b - a），非法输入返回 0 */
function nights(a, b) {
  var diff = parse(b).getTime() - parse(a).getTime();
  var n = Math.round(diff / 86400000);
  return n > 0 ? n : 0;
}

/** 月-日（列表里展示「11-18」比「2026-11-18」清爽） */
function shortDate(str) {
  var s = String(str || '');
  return s.length >= 10 ? s.slice(5) : s;
}

module.exports = {
  pad2: pad2,
  fmt: fmt,
  today: today,
  parse: parse,
  addDays: addDays,
  nights: nights,
  shortDate: shortDate,
};
