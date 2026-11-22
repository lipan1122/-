/**
 * 首页：查房 + 房型列表
 *
 * 接口：GET /api/mini/rooms?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
 * 返回：{ checkIn, checkOut, nights, roomTypes: [...] }
 *
 * 交互约定：
 *   · 进来先按「今天 → 明天」查一次
 *   · 改日期后必须 checkOut > checkIn，否则自动顺延一天（避免用户选到过去）
 *   · 点「立即预订」把房型 / 日期 / 单间总价带到下单页
 */
const api = require('../../utils/api');
const date = require('../../utils/date');

/** 金额展示：两位小数 */
function money(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return v.toFixed(2);
}

Page({
  data: {
    checkIn: '',
    checkOut: '',
    minDate: '',
    nights: 1,
    roomTypes: [],
    loading: false,
    error: '',
  },

  onLoad() {
    var today = date.today();
    var tomorrow = date.addDays(today, 1);
    this.setData({
      checkIn: today,
      checkOut: tomorrow,
      minDate: today,
      nights: 1,
    });

    // 静默登录：失败不影响查房（下单 / 订单 / 会员才需要 token）
    api.ensureLogin().catch(function (err) {
      console.warn('[index] 静默登录失败：', err && err.code, err && err.message);
    });

    this.loadRooms();
  },

  onShow() {
    // 从下单页返回时刷新剩余房量（第一次 onShow 紧跟在 onLoad 后，不重复请求）
    if (this.loadedOnce) this.loadRooms();
    this.loadedOnce = true;
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    this.loadRooms().then(function () {
      wx.stopPullDownRefresh();
    });
  },

  onCheckInChange(e) {
    var checkIn = e.detail.value;
    var checkOut = this.data.checkOut;
    // 入住日必须早于离店日；相等或颠倒时自动顺延一天
    if (checkOut <= checkIn) checkOut = date.addDays(checkIn, 1);
    this.setData({
      checkIn: checkIn,
      checkOut: checkOut,
      nights: date.nights(checkIn, checkOut) || 1,
    });
  },

  onCheckOutChange(e) {
    var checkOut = e.detail.value;
    var checkIn = this.data.checkIn;
    if (checkOut <= checkIn) {
      wx.showToast({ title: '离店日期需晚于入住日期', icon: 'none' });
      return;
    }
    this.setData({ checkOut: checkOut, nights: date.nights(checkIn, checkOut) || 1 });
  },

  onQuery() {
    this.loadRooms();
  },

  /** 查房量 */
  loadRooms() {
    var that = this;
    var checkIn = this.data.checkIn;
    var checkOut = this.data.checkOut;

    if (!checkIn || !checkOut || checkOut <= checkIn) {
      this.setData({ error: '请选择正确的入住 / 离店日期' });
      return Promise.resolve();
    }

    this.setData({ loading: true, error: '' });
    wx.showLoading({ title: '查询中', mask: true });

    return api
      .request('/api/mini/rooms?checkIn=' + checkIn + '&checkOut=' + checkOut)
      .then(function (data) {
        wx.hideLoading();
        var list = (data && data.roomTypes) || [];
        list = list.map(function (t) {
          return Object.assign({}, t, {
            totalPriceText: money(t.totalPrice),
            avgPriceText: money(t.avgPrice),
          });
        });
        that.setData({
          roomTypes: list,
          nights: (data && data.nights) || date.nights(checkIn, checkOut) || 1,
          loading: false,
        });
      })
      .catch(function (err) {
        wx.hideLoading();
        that.setData({
          loading: false,
          error: (err && err.message) || '查询失败，请稍后重试',
        });
      });
  },

  /** 去下单页 */
  onBook(e) {
    var ds = e.currentTarget.dataset;
    var remaining = Number(ds.remaining) || 0;
    if (remaining <= 0) {
      wx.showToast({ title: '该房型已售完', icon: 'none' });
      return;
    }
    var url =
      '/pages/booking/booking?roomTypeId=' +
      encodeURIComponent(ds.id) +
      '&name=' +
      encodeURIComponent(ds.name || '') +
      '&checkIn=' +
      this.data.checkIn +
      '&checkOut=' +
      this.data.checkOut +
      '&totalPrice=' +
      encodeURIComponent(ds.total) +
      '&remaining=' +
      remaining;
    wx.navigateTo({ url: url });
  },

  /** 房型详情：图片 / 床型 / 面积 / 设施 / 取消政策 / 价格日历 */
  onRoomDetail(e) {
    var ds = e.currentTarget.dataset;
    var url =
      '/pages/room-detail/index?roomTypeId=' +
      encodeURIComponent(ds.id) +
      '&name=' +
      encodeURIComponent(ds.name || '') +
      '&checkIn=' +
      this.data.checkIn +
      '&checkOut=' +
      this.data.checkOut;
    wx.navigateTo({ url: url });
  },

  /** 联系酒店：电话 / 地址 / 地图（号码由服务端下发，页面不写死） */
  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  /** 在住服务：已办理入住时从首页一步到位 */
  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },
});
