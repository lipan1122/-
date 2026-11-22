/**
 * 在住服务（清单第八节「在住服务」）
 *
 * 打开方式：/pages/in-stay/index（会员中心 / 订单详情 / 首页入口）
 *
 * 数据来源：GET /api/mini/stays/current
 *   → { stayId, roomNo, roomTypeName, guestName(已脱敏), checkInTime, expectCheckOut,
 *       nights, folio: { totalCharge, totalPaid, balance }, depositAmount, status }
 *   没有在住时服务端可能返回 data = null 或 { stay: null } —— 两种都按空状态处理。
 *
 * ── 为什么这一页是所有在住服务的入口 ──
 * 续住 / 换房 / 延迟退房 / 客房服务 / 账单，全部都需要 stayId。让每个页面各自
 * 去猜 stayId 是错的（也是越权风险）：这里拿到 stayId 后**只通过 URL 传给子页做定位**，
 * 子页每次都会重新向服务端确认真实归属（服务端不信任客户端传的 stayId）。
 *
 * ── 状态处理 ──
 *   · 在住期间每 60s 轮询一次：前台换房审核通过、续住成功、账单有新消费，
 *     客人回到页面就能看到；onHide 停止，避免后台空跑
 *   · 接口未就绪 → 整页降级，但保留「我的订单」「联系酒店」出口
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 在住服务入口（顺序 = 客人最常用的顺序） */
const ENTRIES = [
  { key: 'folio', label: '当前账单', desc: '明细与余额', url: '/pages/folio/index', primary: true },
  { key: 'extend', label: '续住', desc: '延长离店日', url: '/pages/extend/index' },
  { key: 'changeRoom', label: '换房', desc: '需前台审核', url: '/pages/change-room/index' },
  { key: 'lateCheckout', label: '延迟退房', desc: '可能产生费用', url: '/pages/late-checkout/index' },
  { key: 'services', label: '客房服务', desc: '送物 / 维修 / 叫醒', url: '/pages/services/index' },
  { key: 'invoices', label: '发票', desc: '查看 / 申请', url: '/pages/invoices/index' },
  { key: 'notifications', label: '通知', desc: '服务进度', url: '/pages/notifications/index' },
  { key: 'contact', label: '联系酒店', desc: '电话 / 地址', url: '/pages/contact/index' },
];

Page({
  data: Object.assign(state.baseData(), {
    entries: ENTRIES,
    stay: null,
    hasStay: false,
    /** 账单摘要（服务端给才有；没有就不显示那块） */
    folioReady: false,
  }),

  onLoad() {
    this.load();
  },

  onShow() {
    state.onPageVisible(this);
    state.refreshOnShow(this, 'load');
    // 在住期间状态会变（换房 / 续住 / 新消费），60s 轮询一次就够
    state.startPolling(this, 'load', 60000);
  },

  onHide() {
    state.onPageHide(this);
  },

  onUnload() {
    state.onPageHide(this);
  },

  onPullDownRefresh() {
    this.load().then(function () {
      wx.stopPullDownRefresh();
    });
  },

  onRetry(e) {
    return state.retry(this, e);
  },

  load() {
    var that = this;
    return state.load(this, {
      request: function () {
        return mini.currentStay();
      },
      onSuccess: function (data) {
        var raw = state.pickObject(data, ['stay', 'current', 'inhouse'], ['stayId', 'roomNo', 'checkInTime']);
        // 服务端明确回了 null / 或对象里没有任何在住字段 → 视为没有在住
        var stayId = raw ? format.first(raw, ['stayId', 'stay_id', 'id'], '') : '';
        if (!raw || !stayId) {
          state.stopPolling(that);
          return { stay: null, hasStay: false, folioReady: false };
        }

        var folio = raw.folio || raw.bill || {};
        var balanceRaw = format.first(folio, ['balance'], format.first(raw, ['balance', 'folioBalance'], null));
        var totalCharge = format.first(folio, ['totalCharge', 'total'], null);
        var totalPaid = format.first(folio, ['totalPaid', 'paid'], null);

        var stay = {
          stayId: String(stayId),
          roomNo: format.first(raw, ['roomNo', 'room_no', 'roomName'], '未排房'),
          roomTypeName: format.first(raw, ['roomTypeName', 'room_type_name'], ''),
          guestName: format.maskName(format.first(raw, ['guestName', 'guest_name'], '')),
          checkInText: format.dateTime(format.first(raw, ['checkInTime', 'check_in_time'], '')),
          checkOutDate: format.dateOnly(format.first(raw, ['expectCheckOut', 'expect_check_out', 'checkOutDate'], '')),
          checkOutText: format.dateCN(format.dateOnly(format.first(raw, ['expectCheckOut', 'expect_check_out', 'checkOutDate'], ''))),
          nights: format.int(format.first(raw, ['nights'], 0)),
          statusLabel: format.statusLabel(
            format.first(raw, ['status'], ''),
            format.first(raw, ['statusLabel'], '在住')
          ),
          balanceText: balanceRaw === null || balanceRaw === '' ? '' : format.money(balanceRaw),
          balanceNegative: format.num(balanceRaw) < 0,
          totalChargeText: totalCharge === null ? '' : format.money(totalCharge),
          totalPaidText: totalPaid === null ? '' : format.money(totalPaid),
          depositText: format.moneyOrDash(format.first(raw, ['depositAmount', 'deposit'], null)),
          depositStatus: format.first(raw, ['depositStatusLabel'], format.first(raw, ['depositStatus'], '')),
        };

        return {
          stay: stay,
          hasStay: true,
          folioReady: balanceRaw !== null && balanceRaw !== '',
        };
      },
    });
  },

  /** 服务入口：统一从这里跳，URL 只带定位参数（stayId），不带任何授权信息 */
  onEntryTap(e) {
    var url = e.currentTarget.dataset.url;
    if (!url) return;
    var stayId = this.data.stay && this.data.stay.stayId;
    if (!stayId) {
      state.toast('还没有在住信息，请先确认已办理入住');
      return;
    }
    wx.navigateTo({ url: url + '?stayId=' + encodeURIComponent(stayId) });
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },
});
