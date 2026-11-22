/**
 * 我的订单
 *
 * 接口：GET /api/mini/bookings（需要 Bearer token）
 * 返回：{ bound, total, bookings: [{ bookingNo, roomTypeName, checkInDate, checkOutDate,
 *        nights, roomCount, amount, status, statusLabel }] }
 *
 * 每次 onShow 都重新拉一次：下单成功后是 switchTab 过来的，列表必须是最新的。
 */
const api = require('../../utils/api');

/** 状态 → chip 配色（与 app.wxss 里的 chip-* 对应） */
const CHIP = {
  PENDING: 'chip-orange',
  CONFIRMED: 'chip',
  CHECKED_IN: 'chip-green',
  CHECKED_OUT: 'chip-gray',
  CANCELLED: 'chip-gray',
  NOSHOW: 'chip-red',
};

function money(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return v.toFixed(2);
}

/** ISO 时间 → YYYY-MM-DD HH:mm（列表里只展示到分钟） */
function fmtTime(raw) {
  if (!raw) return '—';
  var s = String(raw);
  // 服务端存的是 UTC ISO：2026-11-18T06:30:00.000Z
  var d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ');
  function p(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    loading: true,
    error: '',
    bound: true,
    bookings: [],
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(function () {
      wx.stopPullDownRefresh();
    });
  },

  load() {
    var that = this;
    this.setData({ loading: true, error: '' });

    return api
      .requestWithAuth('/api/mini/bookings')
      .then(function (data) {
        var list = ((data && data.bookings) || []).map(function (b) {
          return Object.assign({}, b, {
            amountText: money(b.amount),
            chipClass: CHIP[b.status] || 'chip-gray',
            createdAtText: fmtTime(b.createdAt),
          });
        });
        that.setData({
          loading: false,
          bound: data && data.bound !== false,
          bookings: list,
        });
      })
      .catch(function (err) {
        that.setData({
          loading: false,
          error: (err && err.message) || '加载失败，请下拉重试',
          bookings: [],
        });
      });
  },

  goBook() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },
});
