/**
 * 下单页
 *
 * 参数（从首页带过来）：
 *   roomTypeId / name / checkIn / checkOut / totalPrice（单间区间总价）/ remaining
 *
 * 提交：POST /api/mini/bookings（经 utils/page-state.js 的 submit，带幂等键 requestId）
 *   成功 → 弹出订单号 → 切到「我的订单」
 *   失败 → 弹窗展示服务端文案（房量不足 / 手机号格式 / 未登录等）
 *
 * 注意：金额只作展示，服务端会按房价日历重算，客户端改不了价。
 */
const api = require('../../utils/api');
const date = require('../../utils/date');
const state = require('../../utils/page-state');

/** 单笔最多订几间（与后端 MAX_ROOM_COUNT 一致） */
const MAX_ROOM_COUNT = 5;

/**
 * 幂等键标识：utils/page-state.js 按这个 key 生成 requestId 并缓存在页面实例上。
 * 提交失败（网络超时 / 未登录）后用户再点一次会**复用同一个 requestId**，
 * 服务端据此返回原订单而不是新建第二张（清单第 109 行「网络超时重试不重复建单」）。
 */
const SUBMIT_KEY = 'booking-create';

function money(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return v.toFixed(2);
}

Page({
  data: {
    roomTypeId: 0,
    roomTypeName: '',
    checkIn: '',
    checkOut: '',
    nights: 1,
    /** 单间区间总价（服务端算好的参考价） */
    perRoomPrice: 0,
    perRoomText: '0.00',
    /** 可订间数上限（受剩余房量与 MAX_ROOM_COUNT 双重限制） */
    maxCount: 1,
    countRange: ['1 间'],
    countIndex: 0,
    roomCount: 1,
    guestName: '',
    mobile: '',
    remark: '',
    totalText: '0.00',
    submitting: false,
    error: '',
    /** 隐私说明 + 用户协议是否已勾选（未勾选不允许提交） */
    agreed: false,
  },

  onLoad(options) {
    var opts = options || {};
    var checkIn = opts.checkIn || date.today();
    var checkOut = opts.checkOut || date.addDays(checkIn, 1);
    var nights = date.nights(checkIn, checkOut) || 1;
    var perRoom = Number(opts.totalPrice) || 0;
    var remaining = Number(opts.remaining) || 1;
    var maxCount = Math.min(MAX_ROOM_COUNT, Math.max(1, remaining));

    var countRange = [];
    for (var i = 1; i <= maxCount; i += 1) countRange.push(i + ' 间');

    // 已绑定会员的话，把姓名 / 手机号预填上（登录返回里带了 guestName）
    var user = api.getUser() || {};

    this.setData({
      roomTypeId: Number(opts.roomTypeId) || 0,
      roomTypeName: opts.name ? decodeURIComponent(opts.name) : '房型',
      checkIn: checkIn,
      checkOut: checkOut,
      nights: nights,
      perRoomPrice: perRoom,
      perRoomText: money(perRoom),
      maxCount: maxCount,
      countRange: countRange,
      roomCount: 1,
      guestName: user.guestName || '',
      totalText: money(perRoom),
    });

    wx.setNavigationBarTitle({ title: this.data.roomTypeName || '填写订单' });
  },

  onNameInput(e) {
    // 表单内容变了就不是「同一次提交」：换一个幂等键，避免旧请求的重试结果被套用
    state.resetRequest(this, SUBMIT_KEY);
    this.setData({ guestName: e.detail.value });
  },

  onMobileInput(e) {
    state.resetRequest(this, SUBMIT_KEY);
    this.setData({ mobile: e.detail.value });
  },

  onRemarkInput(e) {
    state.resetRequest(this, SUBMIT_KEY);
    this.setData({ remark: e.detail.value });
  },

  onCountChange(e) {
    var index = Number(e.detail.value) || 0;
    var count = index + 1;
    state.resetRequest(this, SUBMIT_KEY);
    this.setData({
      countIndex: index,
      roomCount: count,
      totalText: money(this.data.perRoomPrice * count),
    });
  },

  /* ------------------------- 隐私说明 / 用户协议 ------------------------- */

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed, error: '' });
  },

  /** 隐私说明：只写本小程序真实做的事，不抄模板条款 */
  onShowPrivacy() {
    wx.showModal({
      title: '隐私说明',
      content:
        '本小程序仅用于查房、预订、在住服务与会员查询。\n' +
        '· 手机号、姓名在服务端脱敏存储与展示\n' +
        '· 身份证信息仅做入住前预录入，到店仍需人证核验\n' +
        '· 订单只对下单本人或已绑定身份的会员可见\n' +
        '· 不采集通讯录、位置等与住宿无关的信息\n' +
        '· 同一微信只能绑定一个手机号，可在会员中心解绑',
      showCancel: false,
      confirmText: '我知道了',
    });
  },

  /** 用户协议：把「到店付款 / 申请类操作需前台确认」讲清楚，避免纠纷 */
  onShowTerms() {
    wx.showModal({
      title: '用户协议',
      content:
        '1. 房价与房量由酒店系统实时计算，以提交时服务端结果为准。\n' +
        '2. 本小程序默认到店付款，不发起在线支付；押金到店按酒店规定收取。\n' +
        '3. 取消、修改需符合订单的取消政策，是否收费以政策与前台确认为准。\n' +
        '4. 续住、换房、延迟退房均为申请，需前台审核后生效。\n' +
        '5. 入住需按公安要求实名登记并人证核验，小程序不能代替现场核验。',
      showCancel: false,
      confirmText: '我知道了',
    });
  },

  /** 提交订单（防重复点击 + 幂等键复用，全部由 utils/page-state.js 的 submit 统一处理） */
  onSubmit() {
    // 提交中再点一次直接忽略（按钮同时 disabled，双保险）
    if (this.data.submitting) return;

    // 协议必须先勾选：下单前用户要看见「到店付款 / 取消政策 / 实名登记」这三件事
    if (!this.data.agreed) {
      var tip = '请先阅读并同意《隐私说明》和《用户协议》';
      this.setData({ error: tip });
      wx.showToast({ title: tip, icon: 'none' });
      return;
    }

    var guestName = (this.data.guestName || '').trim();
    var mobile = (this.data.mobile || '').trim();
    var error = '';

    if (!guestName) error = '请填写入住人姓名';
    else if (!/^1[3-9]\d{9}$/.test(mobile)) error = '请填写正确的 11 位手机号';

    if (error) {
      this.setData({ error: error });
      wx.showToast({ title: error, icon: 'none' });
      return;
    }

    var that = this;

    /*
     * 统一写请求执行器（清单第 109 行「request_id 幂等」）：
     *   · submit 会把 data.submitting 置 true 并在结束时复位，页面不再自己管 loading；
     *   · requestId 由 state.submit 生成并缓存：提交失败后重试复用同一个 id，
     *     服务端 (hotel_id, mini_request_id) 唯一索引命中即返回原订单，不会重复建单；
     *   · 成功后 page-state 自动丢弃该 id，下一张单是新键。
     */
    state.submit(this, {
      key: SUBMIT_KEY,
      loadingText: '提交中',
      request: function (requestId) {
        return api.requestWithAuth('/api/mini/bookings', {
          method: 'POST',
          data: {
            /* 幂等键：同一次提交（含网络超时后的重试）始终是同一个值 */
            requestId: requestId,
            roomTypeId: that.data.roomTypeId,
            checkInDate: that.data.checkIn,
            checkOutDate: that.data.checkOut,
            roomCount: that.data.roomCount,
            guestName: guestName,
            mobile: mobile,
            remark: that.data.remark,
          },
        });
      },
      onSuccess: function (data) {
        var result = data || {};
        /*
         * replayed = 服务端命中幂等键（这张单之前已经建好了，本次没有新建）。
         * 文案必须区分：否则客人看到「预订成功」会以为又下了一张单，
         * 转身去问前台「为什么我有两张订单」。
         */
        var replayed = result.replayed === true || result.duplicated === true;
        wx.showModal({
          title: replayed ? '订单已提交' : '预订成功',
          content:
            '订单号：' + (result.bookingNo || '') + '\n' +
            (result.roomTypeName || that.data.roomTypeName) + ' · ' +
            (result.roomCount || that.data.roomCount) + ' 间 · ' +
            (result.nights || that.data.nights) + ' 晚' +
            (replayed ? '\n（该订单此前已提交成功，无需重复下单）' : ''),
          showCancel: false,
          confirmText: '查看订单',
          success: function () {
            // switchTab 不能带参数，订单页 onShow 会自己拉列表
            wx.switchTab({ url: '/pages/orders/orders' });
          },
        });
      },
      onError: function (err) {
        wx.showModal({
          title: '下单失败',
          content: (err && err.message) || '请稍后重试',
          showCancel: false,
        });
      },
    });
  },
});
