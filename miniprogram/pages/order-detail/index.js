/**
 * 订单详情（清单第八节「订单详情」）
 *
 * 打开方式：/pages/order-detail/index?bookingId=3
 *   从「我的订单」点卡片进来；只传 bookingId，其余全部由服务端按 token 判定归属。
 *
 * 数据来源：GET /api/mini/bookings/:id
 *   → { bookingId, bookingNo, status, statusLabel, statusTimeline[],
 *       roomTypeName, roomNo, checkInDate, checkOutDate, nights, roomCount,
 *       amount, paidAmount, payStatus, payStatusLabel, depositAmount, depositStatus,
 *       guestName, mobile(已脱敏), arrivalTime, remark, cancelPolicy, verifyCode,
 *       invoiceStatus, canCancel, hotel: { name, address, phone } }
 *
 * ── 页面的 4 个动作 ──
 *   1. 取消预订  POST /api/mini/bookings/:id/cancel   ← 幂等 request_id，超时重试不会重复取消
 *   2. 修改预订  POST /api/mini/bookings/:id/modify   ← 入住人 / 到店时间 / 备注
 *   3. 联系前台  wx.makePhoneCall（号码来自服务端；没有号码就跳联系酒店页）
 *   4. 点卡片去「入住前服务」「发票」
 *
 * ── 状态处理 ──
 *   · loading / error + 重试 / notReady（取消、修改接口未上线时单独降级）
 *   · 订单还在 PENDING/CONFIRMED 时每 30s 轮询一次（前台排房后客人能在页面上看到变化），
 *     onHide 自动停（小程序后台频繁请求会被微信判违规，也白耗流量）
 *   · 取消/修改成功后立刻重新拉详情，不靠本地拼状态
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 允许小程序自助取消的状态：已入住及之后只能前台处理 */
const CANCELABLE = { PENDING: true, CONFIRMED: true };

/** 需要轮询的状态（等前台确认 / 排房 / 入住） */
const POLLING = { PENDING: true, CONFIRMED: true };

/** 状态时间线：服务端没给就按 status 推导到当前状态的进度（只是展示，不是业务判定） */
const TIMELINE = [
  { key: 'PENDING', label: '已提交' },
  { key: 'CONFIRMED', label: '已确认' },
  { key: 'CHECKED_IN', label: '已入住' },
  { key: 'CHECKED_OUT', label: '已离店' },
];
const STATUS_ORDER = { PENDING: 0, CONFIRMED: 1, CHECKED_IN: 2, CHECKED_OUT: 3 };

function deriveTimeline(order) {
  var status = String(order.status || '').toUpperCase();
  if (status === 'CANCELLED' || status === 'NOSHOW') {
    return [{ label: '已提交', at: order.createdAtText, done: true }, { label: '已取消', at: order.cancelTimeText, done: true }];
  }
  var rank = STATUS_ORDER[status] === undefined ? 0 : STATUS_ORDER[status];
  return TIMELINE.map(function (t, i) {
    return { label: t.label, at: i === rank ? order.updatedAtText : '', done: i <= rank };
  });
}

/** 服务端已给 statusTimeline 时规范成 { label, at, done } */
function normalizeTimeline(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map(function (t) {
    var item = t || {};
    return {
      label: format.first(item, ['label', 'statusLabel', 'status'], ''),
      at: format.dateTime(format.first(item, ['at', 'time', 'createdAt'], '')),
      done: item.done !== false,
    };
  });
}

Page({
  data: Object.assign(state.baseData(), {
    bookingId: '',
    order: null,
    timeline: [],
    canCancel: false,
    canModify: false,
    showModify: false,
    form: { guestName: '', arrivalClock: '14:00', remark: '' },
    /** 时间线是否来自服务端（否则是本地推导，旁边要注明） */
    timelineFromServer: false,
  }),

  onLoad(options) {
    var o = options || {};
    this.setData({ bookingId: o.bookingId || o.id || '' });
    if (!this.data.bookingId) {
      this.setData({ loading: false, loaded: true, error: '缺少订单参数，请从「我的订单」重新进入' });
      return;
    }
    this.load();
  },

  /** 返回本页（例如从入住前服务页回来）时刷新状态 */
  onShow() {
    state.onPageVisible(this);
    state.refreshOnShow(this, 'load');
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
        return mini.bookingDetail(that.data.bookingId);
      },
      onSuccess: function (data) {
        var raw = state.pickObject(data, ['booking', 'order', 'detail'], ['bookingNo', 'bookingId']);
        if (!raw) {
          return { order: null, canCancel: false, canModify: false, error: '订单不存在或无权查看', loaded: true };
        }

        var status = String(format.first(raw, ['status'], '')).toUpperCase();
        var statusLabel = format.statusLabel(status, format.first(raw, ['statusLabel'], ''));
        var checkInDate = format.dateOnly(format.first(raw, ['checkInDate', 'check_in_date'], ''));
        var checkOutDate = format.dateOnly(format.first(raw, ['checkOutDate', 'check_out_date'], ''));
        var hotel = raw.hotel || {};

        var order = {
          bookingNo: format.first(raw, ['bookingNo', 'booking_no'], '—'),
          status: status,
          statusLabel: statusLabel,
          chipClass: format.statusChip(status),
          roomTypeName: format.first(raw, ['roomTypeName', 'room_type_name'], '—'),
          roomNo: format.first(raw, ['roomNo', 'room_no'], ''),
          checkInDate: checkInDate,
          checkOutDate: checkOutDate,
          checkInText: format.dateCN(checkInDate),
          checkOutText: format.dateCN(checkOutDate),
          nights: format.int(format.first(raw, ['nights'], 0)),
          roomCount: format.int(format.first(raw, ['roomCount', 'room_count'], 1)),
          amountText: format.moneyOrDash(format.first(raw, ['amount', 'totalPrice', 'total_amount'], null)),
          paidText: format.moneyOrDash(format.first(raw, ['paidAmount', 'paid_amount'], null)),
          dueText: format.moneyOrDash(format.first(raw, ['dueAmount', 'unpaidAmount'], null)),
          depositText: format.moneyOrDash(format.first(raw, ['depositAmount', 'deposit', 'deposit_amount'], null)),
          depositStatus: format.first(raw, ['depositStatusLabel'], format.first(raw, ['depositStatus'], '')),
          payStatusLabel: format.first(raw, ['payStatusLabel'], format.statusLabel(format.first(raw, ['payStatus', 'paymentStatus'], ''))),
          paymentMethod: format.first(raw, ['paymentMethod', 'payMethodLabel'], ''),
          guestName: format.maskName(format.first(raw, ['guestName', 'guest_name'], '')),
          mobile: format.maskMobile(format.first(raw, ['mobile', 'guestMobile'], '')),
          arrivalTime: format.dateTime(format.first(raw, ['arrivalTime', 'arrival_time'], '')),
          remark: format.first(raw, ['remark', 'note'], ''),
          cancelPolicy: format.first(raw, ['cancelPolicy', 'cancel_policy'], ''),
          verifyCode: format.first(raw, ['verifyCode', 'qrCode', 'checkInCode'], ''),
          invoiceStatus: format.first(raw, ['invoiceStatusLabel'], format.first(raw, ['invoiceStatus'], '')),
          createdAtText: format.dateTime(format.first(raw, ['createdAt', 'created_at'], '')),
          updatedAtText: format.dateTime(format.first(raw, ['updatedAt', 'updated_at'], '')),
          hotelName: format.first(hotel, ['name'], ''),
          hotelPhone: format.first(hotel, ['phone', 'tel'], ''),
          hotelAddress: format.first(hotel, ['address'], ''),
        };

        var canCancel = raw.canCancel !== undefined ? Boolean(raw.canCancel) : CANCELABLE[status] === true;
        var canModify = raw.canModify !== undefined ? Boolean(raw.canModify) : CANCELABLE[status] === true;
        var serverTimeline = normalizeTimeline(raw.statusTimeline || raw.timeline);

        // 等前台确认/排房的订单才轮询；已离店/已取消就别浪费请求
        if (POLLING[status]) state.startPolling(that, 'load', 30000);
        else state.stopPolling(that);

        return {
          order: order,
          canCancel: canCancel,
          canModify: canModify,
          timeline: serverTimeline.length ? serverTimeline : deriveTimeline(order),
          timelineFromServer: serverTimeline.length > 0,
          form: {
            guestName: order.guestName.indexOf('*') >= 0 ? '' : format.first(raw, ['guestName'], ''),
            arrivalClock: order.arrivalTime && order.arrivalTime !== '—' ? order.arrivalTime.slice(11, 16) : '14:00',
            remark: order.remark || '',
          },
        };
      },
    });
  },

  /* ------------------------------ 取消预订 ------------------------------ */

  onCancel() {
    var that = this;
    var order = this.data.order;
    if (!order) return;

    state
      .confirm(
        '取消预订',
        '订单 ' + order.bookingNo + '（' + order.roomTypeName + '）取消后不可恢复，确认取消吗？\n如需改期请先取消再重新预订，或联系前台。',
        '确认取消'
      )
      .then(function (ok) {
        if (!ok) return null;
        return state.submit(that, {
          key: 'cancel',
          loadingText: '取消中',
          request: function (rid) {
            return mini.cancelBooking(that.data.bookingId, { request_id: rid, reason: '用户在小程序取消' });
          },
          onSuccess: function () {
            state.toast('已提交取消', 'success');
            that.load();
          },
          onError: function (err, d) {
            // 已取消 / 已入住这类「状态不允许」的失败，重新拉一次详情让页面与真实状态对齐
            if (d.code === 'BOOKING_STATUS' || d.code === 'ALREADY_CANCELLED' || d.code === 'CANNOT_CANCEL') that.load();
          },
        });
      });
  },

  /* ------------------------------ 修改预订 ------------------------------ */

  onToggleModify() {
    this.setData({ showModify: !this.data.showModify, error: '' });
  },

  onFormInput(e) {
    var field = e.currentTarget.dataset.field;
    if (!field) return;
    var patch = {};
    patch['form.' + field] = e.detail.value;
    this.setData(patch);
    // 表单内容变了 → 幂等键必须换新，否则服务端会把新内容当成上一次已处理的请求
    state.resetRequest(this, 'modify');
  },

  onArrivalChange(e) {
    this.setData({ 'form.arrivalClock': e.detail.value });
    state.resetRequest(this, 'modify');
  },

  onSubmitModify() {
    var that = this;
    var order = this.data.order;
    var form = this.data.form;
    if (!order) return;

    var guestName = String(form.guestName || '').trim();
    // 已脱敏的姓名不能直接提交回去（服务端收到「张*」会当真名写库）
    if (guestName && guestName.indexOf('*') >= 0) {
      state.toast('请填写完整入住人姓名');
      return;
    }

    var arrivalTime = order.checkInDate ? order.checkInDate + ' ' + form.arrivalClock : '';

    state
      .submit(this, {
        key: 'modify',
        flag: 'submitting',
        loadingText: '提交中',
        request: function (rid) {
          return mini.modifyBooking(that.data.bookingId, {
            request_id: rid,
            guestName: guestName || undefined,
            arrivalTime: arrivalTime || undefined,
            remark: String(form.remark || '').trim() || undefined,
          });
        },
        onSuccess: function () {
          state.toast('已提交修改申请', 'success');
          that.setData({ showModify: false });
          that.load();
        },
      });
  },

  /* ------------------------------ 其他入口 ------------------------------ */

  onCallFrontDesk() {
    var phone = this.data.order && this.data.order.hotelPhone;
    if (!phone) {
      wx.navigateTo({ url: '/pages/contact/index' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: String(phone) });
  },

  onShowCode() {
    var code = this.data.order && this.data.order.verifyCode;
    if (!code) {
      state.toast('核验码由服务端下发，暂未生成');
      return;
    }
    wx.showModal({ title: '入住核验码', content: '到店向前台出示：' + code, showCancel: false });
  },

  goPreStay() {
    wx.navigateTo({ url: '/pages/pre-stay/index?bookingId=' + encodeURIComponent(this.data.bookingId) });
  },

  goInvoices() {
    wx.navigateTo({ url: '/pages/invoices/index?bookingId=' + encodeURIComponent(this.data.bookingId) });
  },

  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  onShowPolicy() {
    var text = this.data.order && this.data.order.cancelPolicy;
    wx.showModal({
      title: '取消政策',
      content: text || '该订单未单独配置取消政策，以酒店前台确认为准。',
      showCancel: false,
    });
  },
});
