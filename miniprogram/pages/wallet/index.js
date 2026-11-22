/**
 * 储值和积分（清单第八节「储值和积分」/ 第 244-264 行）
 *
 * 打开方式：/pages/wallet/index（会员中心 → 储值和积分）
 *
 * ── 数据来源 ──
 *   GET /api/mini/member           摘要（储值余额 / 积分 / 等级 / 卡名 / 有效期）
 *   GET /api/mini/member/ledger?type=wallet|points  明细
 *   POST /api/mini/member/unbind   注销小程序绑定（第 262 行）
 *
 * ── 口径（清单第 264 行）──
 *   储值统一用 member_wallet_ledger + member_id，禁止旧的 guest_name 维度。
 *   页面不显示充值入口：储值充值需要收款/发票，属于前台业务，小程序里做一个
 *   「充值」按钮却没有支付通道，就是在骗用户（清单第十节：不伪装成功）。
 *
 * ── 状态处理 ──
 *   · 未绑定（NOT_BOUND）→ 引导去绑定，不是报错
 *   · 明细接口未就绪 → 只降级明细区，摘要照常显示
 *   · 切 tab 时按 type 重新拉明细（缓存上次结果避免来回请求）
 */
const format = require('../../utils/format');
const api = require('../../utils/api');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 流水方向 → 展示 */
const DIRECTION = {
  IN: { label: '收入', cls: 'in' },
  OUT: { label: '支出', cls: 'out' },
  REFUND: { label: '退款', cls: 'in' },
  ADJUST: { label: '调整', cls: 'out' },
};

Page({
  data: Object.assign(state.baseData(), {
    bound: true,
    member: null,

    /** 'wallet' | 'points' */
    tab: 'wallet',
    records: [],
    recordsReady: false,
    recordsLoading: false,
    recordsError: '',
    recordsNotReady: false,
    recordsNotReadyMsg: '',
  }),

  onLoad() {
    // 首屏：摘要 + 明细一起拉（onShowRefresh 内做顺序控制，避免未绑定也请求明细）
    this.onShowRefresh();
  },

  onShow() {
    state.onPageVisible(this);
    // 从绑定页返回时会员信息会变，必须重新拉
    state.refreshOnShow(this, 'onShowRefresh');
  },

  onPullDownRefresh() {
    this.onShowRefresh().then(function () {
      wx.stopPullDownRefresh();
    });
  },

  onShowRefresh() {
    return this.load().then(this.loadRecords.bind(this));
  },

  onRetry(e) {
    var key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key) || 'main';
    if (key === 'records') return this.loadRecords();
    return state.retry(this, e);
  },

  /* ------------------------------ 摘要 ------------------------------ */

  load() {
    var that = this;
    return state.load(this, {
      request: function () {
        return mini.member();
      },
      onSuccess: function (data) {
        if (!data) return { bound: false, member: null };
        var m = state.pickObject(data, ['member'], ['balance', 'points']);
        if (!m) return { bound: false, member: null };

        var discount = format.num(format.first(m, ['discount'], 1));
        var discountText = discount > 0 && discount < 1 ? String(Math.round(discount * 100) / 10) : '';

        return {
          bound: data.bound === false ? false : true,
          member: {
            guestName: format.maskName(format.first(m, ['guestName', 'name'], '')),
            mobile: format.maskMobile(format.first(m, ['mobile'], '')),
            levelLabel: format.first(m, ['levelLabel'], '普通客人'),
            cardName: format.first(m, ['cardName'], ''),
            balanceText: format.money(format.first(m, ['balance'], 0)),
            pointsText: String(format.int(format.first(m, ['points'], 0))),
            rechargeTotalText: format.money(format.first(m, ['rechargeTotal'], 0)),
            consumeTotalText: format.money(format.first(m, ['consumeTotal'], 0)),
            totalSpendText: format.money(format.first(m, ['totalSpend'], 0)),
            stayCount: format.int(format.first(m, ['stayCount'], 0)),
            discountText: discountText,
            validUntil: format.dateOnly(format.first(m, ['cardExpireAt', 'validUntil', 'expireAt'], '')),
          },
        };
      },
      onError: function (err, d) {
        if (d.code === 'NOT_BOUND') return { bound: false, member: null };
        return {};
      },
    });
  },

  /* ------------------------------ 明细 ------------------------------ */

  loadRecords() {
    var that = this;
    if (!this.data.bound) {
      this.setData({ records: [], recordsLoading: false });
      return Promise.resolve(null);
    }
    this.setData({ recordsLoading: true, recordsError: '', recordsNotReady: false, recordsNotReadyMsg: '' });

    return mini
      .memberLedger({ type: this.data.tab, limit: 30 })
      .then(function (data) {
        var list = state.pickList(data, ['records', 'ledger', 'items', 'list']);
        var mapped = list.map(function (it) {
          var row = it || {};
          var dir = String(format.first(row, ['direction', 'type'], '')).toUpperCase();
          var dirInfo = DIRECTION[dir] || { label: format.first(row, ['typeLabel'], '变动'), cls: '' };
          var amount = format.first(row, ['amount', 'points', 'change'], 0);
          var isPoints = that.data.tab === 'points';
          return {
            recordId: format.first(row, ['id', 'recordId'], ''),
            title: format.first(row, ['title', 'description', 'remark'], dirInfo.label),
            dirLabel: dirInfo.label,
            dirClass: dirInfo.cls,
            amountText: isPoints ? format.int(amount) : format.money(amount),
            unitText: isPoints ? '分' : '',
            balanceText: format.first(row, ['balanceAfter', 'balance'], null) === null ? '' : format.money(format.first(row, ['balanceAfter', 'balance'], 0)),
            createdAtText: format.dateTime(format.first(row, ['createdAt', 'created_at', 'time'], '')),
          };
        });
        that.setData({ records: mapped, recordsReady: true, recordsLoading: false });
      })
      .catch(function (err) {
        var d = state.describeError(err);
        that.setData({
          records: [],
          recordsLoading: false,
          recordsReady: false,
          recordsNotReady: d.notReady,
          recordsNotReadyMsg: d.notReadyMsg,
          recordsError: d.notReady ? '' : d.message,
        });
        return null;
      });
  },

  onTabTap(e) {
    var tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) return;
    this.setData({ tab: tab, records: [] });
    this.loadRecords();
  },

  /* ------------------------------ 解绑 ------------------------------ */

  onUnbind() {
    var that = this;
    state
      .confirm(
        '注销绑定',
        '注销后本机将不再显示会员等级、储值余额、积分和历史订单，需要重新绑定手机号才能恢复。储值余额本身不会消失。',
        '确认注销'
      )
      .then(function (ok) {
        if (!ok) return null;
        return state.submit(that, {
          key: 'unbind',
          loadingText: '处理中',
          request: function (rid) {
            return mini.unbind({ request_id: rid });
          },
          onSuccess: function () {
            // 只清会员信息缓存，保留 token：同一微信身份没变，只是不再关联客史
            api.clearUser();
            that.setData({ bound: false, member: null, records: [], recordsReady: false });
            wx.showToast({ title: '已注销绑定', icon: 'success' });
          },
        });
      });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  goMember() {
    wx.switchTab({ url: '/pages/member/member' });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },
});
