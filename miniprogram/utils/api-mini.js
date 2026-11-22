/**
 * 住客端业务接口（13 个新页面统一走这里，不直接拼 URL）
 *
 * ── 为什么不再各页面直接 api.requestWithAuth('/api/mini/...') ──
 * 新接口（stays / folio / invoices / notifications / hotel ...）分批交付，
 * 页面必须在「接口还没上线」时**优雅降级**成「功能准备中」，而不是弹一个
 * 「服务端返回 HTTP 404」或者白屏。降级判断只应该写一遍，所以收敛到这里。
 *
 * ── 降级判定（normalize）──
 *   命中任一条件 → 归一成 code = 'NOT_READY'：
 *     · HTTP 404 / 405 / 501   → Next 路由还没实现（不存在路径返回 404 HTML 页）
 *     · body.code 是 NOT_IMPLEMENTED / NOT_READY / ENDPOINT_MISSING
 *   其余错误**原样抛出**：500 是真故障，不能伪装成「准备中」；
 *   UNAUTHORIZED 交给 requestWithAuth 自动重登（GET）或提示用户重新提交（POST）。
 *
 * ── 超时 ──
 *   默认 15s（见 utils/api.js 的 TIMEOUT）。POST 类操作给 20s：
 *   续住 / 换房要现算远期库存，比查房慢，15s 在弱网下容易误判失败让用户重提交。
 *
 * ── 安全边界 ──
 *   路径里的 :id 只是「定位资源」，**不是授权条件**。
 *   服务端必须自己校验 stay_id / booking_id 归属当前 token 的用户，否则就是把
 *   越权入口开在了 URL 里（清单第四节：不信任客户端 hotelId / guestId / stayId）。
 *   本文件里的注释在对应接口处都再标了一次。
 */

const api = require('./api');

/** 服务端「接口还没实现」时归一成的业务码（页面据此显示「功能准备中」） */
const NOT_READY = 'NOT_READY';

/** 视为「路由未实现」的 HTTP 状态码 */
const NOT_READY_STATUS = { 404: true, 405: true, 501: true };

/** 视为「路由未实现」的业务码 */
const NOT_READY_CODES = {
  NOT_IMPLEMENTED: true,
  NOT_READY: true,
  ENDPOINT_MISSING: true,
  ROUTE_NOT_FOUND: true,
};

/** 默认超时（毫秒）：普通读接口 */
const TIMEOUT_READ = 15000;

/** 写操作超时（毫秒）：需要现算库存 / 报价，放宽一点 */
const TIMEOUT_WRITE = 20000;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 构造「功能准备中」错误 */
function makeNotReady(extra) {
  var err = new Error('该功能正在对接中，请稍后重试，或直接联系酒店前台');
  err.code = NOT_READY;
  err.notReady = true;
  if (extra) {
    for (var k in extra) {
      if (hasOwn(extra, k)) err[k] = extra[k];
    }
  }
  return err;
}

/**
 * 把底层错误归一化
 *
 * 注意：这里**故意不吞掉 message**。服务端已经给了可以直接展示的中文
 * （如「续住日期与已有预订冲突」），页面拿 error.message 就能用。
 *
 * 「404 一律当未实现」是错的：后端对「订单不存在 / 无权查看」也用 404 + JSON，
 * 那种必须照实显示。所以只有 **404 + 非 JSON 响应体**（Next 的默认 404 HTML 页）
 * 才算路由没上线。api.js 已经把 nonJson 标记带上来了。
 */
function normalize(err) {
  if (!err) return err;
  var code = String(err.code || '');

  // 登录过期：交给页面/requestWithAuth 处理，不做降级
  if (code === 'UNAUTHORIZED') return err;

  if (NOT_READY_CODES[code]) return makeNotReady({ statusCode: err.statusCode, original: err });

  if (err.statusCode && NOT_READY_STATUS[err.statusCode]) {
    // nonJson 明确为 false（服务端回了 JSON）时保留真实错误，不伪装成「对接中」
    if (err.nonJson === false) return err;
    return makeNotReady({ statusCode: err.statusCode, original: err });
  }
  return err;
}

/** 拼 query（undefined / null / '' 一律忽略，避免 checkIn=undefined 打给服务端） */
function buildQuery(query) {
  if (!query) return '';
  var parts = [];
  for (var k in query) {
    if (!hasOwn(query, k)) continue;
    var v = query[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** 路径参数编码：id 可能是数字或字符串，统一 encode */
function seg(id) {
  return encodeURIComponent(String(id === undefined || id === null ? '' : id));
}

/** 底层：统一走 requestWithAuth（带 token + 401 自动重登） */
function send(method, path, options) {
  var o = options || {};
  var timeout = o.timeout || (method === 'GET' ? TIMEOUT_READ : TIMEOUT_WRITE);
  return api
    .requestWithAuth(path + buildQuery(o.query), { method: method, data: o.body, timeout: timeout })
    .catch(function (err) {
      throw normalize(err);
    });
}

function get(path, query, timeout) {
  return send('GET', path, { query: query, timeout: timeout });
}

function post(path, body, timeout) {
  return send('POST', path, { body: body || {}, timeout: timeout });
}

/** 统一判断「这个错误是不是接口还没上线」 */
function isNotReady(err) {
  return Boolean(err && (err.notReady === true || err.code === NOT_READY));
}

/* ========================================================================== */
/*                        酒店 / 房型 / 订单（8 个接口）                        */
/* ========================================================================== */

/**
 * 酒店基础信息（名称 / 地址 / 电话 / 营业时间 / 地图坐标）
 *
 * 联系页、房型详情页、入住前服务页都要用。**不做本地兜底文案里的具体数据** ——
 * 不知道酒店叫什么就显示「酒店信息暂未配置」，绝不编一个酒店名和电话出来。
 */
function hotel() {
  return get('/api/mini/hotel');
}

/**
 * 房型详情 + 每晚价格日历
 * @param {number|string} roomTypeId 房型 id
 * @param {{checkIn?:string, checkOut?:string}} query 日期区间（服务端按区间算价与可售）
 */
function roomType(roomTypeId, query) {
  return get('/api/mini/room-types/' + seg(roomTypeId), query);
}

/**
 * 订单详情
 *
 * 服务端必须只允许「当前微信用户自己创建的单」或「已安全绑定 guest_id 的单」，
 * 否则改一个 URL 数字就能读别人的订单（清单第四节）。
 */
function bookingDetail(bookingId) {
  return get('/api/mini/bookings/' + seg(bookingId));
}

/** 取消预订：{ request_id, reason? } —— 幂等键由 page-state 复用，超时重试不会重复取消 */
function cancelBooking(bookingId, body) {
  return post('/api/mini/bookings/' + seg(bookingId) + '/cancel', body);
}

/** 修改预订：{ request_id, guestName?, arrivalTime?, remark?, idType?, idNo? } */
function modifyBooking(bookingId, body) {
  return post('/api/mini/bookings/' + seg(bookingId) + '/modify', body);
}

/* ========================================================================== */
/*                            在住 / 账单 / 在住服务                           */
/* ========================================================================== */

/** 当前在住（没有在住时服务端回 data = null 或 { stay: null }，页面按空状态处理） */
function currentStay() {
  return get('/api/mini/stays/current');
}

/**
 * 当前账单明细
 *
 * stayId 只是路径定位；服务端必须校验该 stay 属于当前 token 用户（不允许客户端伪造）。
 */
function folio(stayId) {
  return get('/api/mini/stays/' + seg(stayId) + '/folio');
}

/** 申请续住：{ request_id, newCheckOutDate } —— 服务端查远期库存 + 重算价格 */
function extendStay(stayId, body) {
  return post('/api/mini/stays/' + seg(stayId) + '/extend', body);
}

/** 申请换房：{ request_id, targetRoomTypeId?, targetRoomId?, reason, note? } */
function changeRoom(stayId, body) {
  return post('/api/mini/stays/' + seg(stayId) + '/change-room', body);
}

/** 申请延迟退房：{ request_id, targetTime: '14:00', note? } */
function lateCheckout(stayId, body) {
  return post('/api/mini/stays/' + seg(stayId) + '/late-checkout', body);
}

/** 叫醒服务：{ request_id, wakeupTime: 'YYYY-MM-DD HH:mm', note? } */
function wakeup(stayId, body) {
  return post('/api/mini/stays/' + seg(stayId) + '/wakeup', body);
}

/**
 * 客房服务（送物 / 维修 / 清扫 / 补充用品 / 投诉建议）
 * body: { request_id, service_type, note?, expect_time?, quantity? }
 */
function stayService(stayId, body) {
  return post('/api/mini/stays/' + seg(stayId) + '/service', body);
}

/** 我的服务请求列表（?status= / ?limit=） */
function serviceOrders(query) {
  return get('/api/mini/service-orders', query);
}

/**
 * 取消服务请求
 *
 * 只能取消自己提交的、且还没被前台受理（PENDING）的请求 —— 这条规则在服务端，
 * 页面只负责在按钮上先隐藏「已受理」的取消入口，避免给客人一个必然失败的按钮。
 */
function cancelServiceOrder(orderId, body) {
  return post('/api/mini/service-orders/' + seg(orderId) + '/cancel', body || {});
}

/** 早餐预购：{ request_id, stayId?, bookingId?, count, date?, remark? } */
function breakfast(body) {
  return post('/api/mini/breakfast', body);
}

/* ========================================================================== */
/*                              发票 / 会员 / 通知                              */
/* ========================================================================== */

/** 发票列表 */
function invoices(query) {
  return get('/api/mini/invoices', query);
}

/** 申请开票：{ request_id, bookingId?, stayId?, type, title, taxNo, email?, amount? } */
function createInvoice(body) {
  return post('/api/mini/invoices', body);
}

/** 会员摘要（余额 / 积分 / 等级）—— 与会员中心同一接口 */
function member() {
  return get('/api/mini/member');
}

/**
 * 会员流水：储值 + 积分明细
 * @param {{type?:'wallet'|'points', limit?:number}} query
 *
 * 储值口径必须是 member_wallet_ledger + member_id（清单第 264 行），
 * 不能用旧 guest_name 维度的 member_wallet 单独记账。
 */
function memberLedger(query) {
  return get('/api/mini/member/ledger', query);
}

/** 注销小程序绑定：{ request_id } */
function unbind(body) {
  return post('/api/mini/member/unbind', body || {});
}

/** 通知列表（?unread=1 / ?limit=） */
function notifications(query) {
  return get('/api/mini/notifications', query);
}

/** 标记已读：{ ids: [1,2] } 或 { all: true } */
function readNotifications(body) {
  return post('/api/mini/notifications/read', body || {});
}

module.exports = {
  NOT_READY: NOT_READY,
  TIMEOUT_READ: TIMEOUT_READ,
  TIMEOUT_WRITE: TIMEOUT_WRITE,
  isNotReady: isNotReady,
  normalize: normalize,

  hotel: hotel,
  roomType: roomType,
  bookingDetail: bookingDetail,
  cancelBooking: cancelBooking,
  modifyBooking: modifyBooking,

  currentStay: currentStay,
  folio: folio,
  extendStay: extendStay,
  changeRoom: changeRoom,
  lateCheckout: lateCheckout,
  wakeup: wakeup,
  stayService: stayService,
  serviceOrders: serviceOrders,
  cancelServiceOrder: cancelServiceOrder,
  breakfast: breakfast,

  invoices: invoices,
  createInvoice: createInvoice,
  member: member,
  memberLedger: memberLedger,
  unbind: unbind,
  notifications: notifications,
  readNotifications: readNotifications,
};
