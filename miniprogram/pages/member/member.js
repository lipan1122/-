/**
 * 会员中心
 *
 * 接口：GET /api/mini/member（需要 Bearer token）
 *   成功：{ guestId, guestName, mobile(已打码), level, levelLabel, cardName, discount,
 *           balance, rechargeTotal, consumeTotal, points, pointsEarned,
 *           totalSpend, stayCount, joinedAt }
 *   未绑定：HTTP 200 + { ok:false, code:'NOT_BOUND' }
 *
 * 显示约定：
 *   · 手机号是服务端打码后的 138****8000，页面原样展示
 *   · 折扣 0.9 → 9 折（由 discountText 提供，WXML 里不做数学运算）
 */
const api = require('../../utils/api');

function money(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return v.toFixed(2);
}

/** 0.9 → 9，0.85 → 8.5 */
function discountText(d) {
  var v = Number(d);
  if (!isFinite(v) || v <= 0 || v >= 1) return '';
  return String(Math.round(v * 100) / 10);
}

Page({
  data: {
    loading: true,
    error: '',
    bound: false,
    member: null,
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
      .requestWithAuth('/api/mini/member')
      .then(function (data) {
        var dText = discountText(data.discount);
        var m = Object.assign({}, data, {
          balanceText: money(data.balance),
          totalSpendText: money(data.totalSpend),
          discountText: dText,
          /** 会员卡 + 折扣一行显示：金卡 · 9 折 / 普通客人 */
          cardText: data.cardName + (dText ? ' · ' + dText + ' 折' : ''),
        });
        that.setData({ loading: false, bound: true, member: m });
      })
      .catch(function (err) {
        // 未绑定不是异常：引导用户去绑定页
        if (err && err.code === 'NOT_BOUND') {
          that.setData({ loading: false, bound: false, member: null, error: '' });
          return;
        }
        that.setData({
          loading: false,
          error: (err && err.message) || '加载失败，请下拉重试',
        });
      });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  /** 在住服务：当前房间 / 离店日 / 账单 / 续住 / 换房 / 延迟退房 / 客房服务 */
  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },

  /** 储值和积分：余额、流水明细、注销绑定 */
  goWallet() {
    wx.navigateTo({ url: '/pages/wallet/index' });
  },

  /** 发票列表 + 申请开票 */
  goInvoices() {
    wx.navigateTo({ url: '/pages/invoices/index' });
  },

  /** 通知中心：预订 / 续住 / 换房 / 服务请求 / 发票进度 */
  goNotifications() {
    wx.navigateTo({ url: '/pages/notifications/index' });
  },

  /** 联系酒店：电话 / 地址 / 地图（号码来自服务端，页面不写死） */
  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  onLogout() {
    var that = this;
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新进入小程序才能恢复登录状态',
      success: function (res) {
        if (!res.confirm) return;
        /*
         * 整改 P2-15：先吊销服务端 token，再清本地。
         *
         * 旧实现只调 api.clearToken()，服务端 mini_program_users.session_token
         * 仍然有效（7 天）—— 手机转手 / token 泄露时，「退出」并不能止损。
         * 这里用 api.request（而不是 requestWithAuth）：退出场景不该因为 401
         * 自动重新登录一次再吊销新 token，那是反向操作。
         * 服务端吊销失败（断网 / token 已过期）也要完成本地退出，
         * 不能让用户被卡在「退不出去」的状态；但顺序不能反 ——
         * 本地 token 清掉后就没有凭证去调吊销接口了。
         */
        api
          .request('/api/mini/logout', { method: 'POST', auth: true })
          .catch(function () {
            /* 服务端吊销失败不阻断本地退出，下次进入小程序会重新登录 */
          })
          .then(function () {
            api.clearToken();
            that.setData({ bound: false, member: null });
            wx.showToast({ title: '已退出登录', icon: 'success' });
            // 回首页重新静默登录（下次进入任意 tab 时会自动换新 token）
            wx.switchTab({
              url: '/pages/index/index',
              success: function () {
                api.ensureLogin().catch(function () {});
              },
            });
          });
      },
    });
  },
});
