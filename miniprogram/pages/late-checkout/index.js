/**
 * 延迟退房申请（清单第八节「延迟退房」）
 *
 * 打开方式：/pages/late-checkout/index?stayId=12
 *
 * ── 数据来源 ──
 *   GET /api/mini/stays/current    当前离店日 + 房间
 *   GET /api/mini/hotel            标准退房时间（拿不到就显示「以酒店规定为准」）
 *   POST /api/mini/stays/:id/late-checkout  { request_id, targetTime, date, note }
 *
 * ── 费用不能自己算 ──
 *   延迟退房通常按小时计费（也有的酒店给免费 2 小时），规则在各酒店房价政策里。
 *   页面只提示「可能产生费用，以前台确认为准」，绝不显示一个本机算出来的金额 ——
 *   算错一次，前台就要跟客人吵一次。
 *
 * ── 时间选项是「申请时间」不是「保证」 ──
 *   房态紧张时前台会拒绝，所以按钮文案是「提交申请」，成功提示是「等待前台确认」。
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 可申请的退房时间（酒店可只批准其中部分；最终以前台确认为准） */
const TIME_OPTIONS = ['12:00', '13:00', '14:00', '15:00', '16:00', '18:00'];

const HINTS = {
  STAY_STATUS: '当前住宿状态不支持延迟退房，请联系前台。',
  ALREADY_CHECKED_OUT: '已经退房，无法再申请延迟退房。',
  FRONT_DESK_REQUIRED: '该情况需要到前台办理。',
  NO_ROOM: '该时间段房态紧张，前台可能无法批准，请换一个时间或联系前台。',
};

Page({
  data: Object.assign(state.baseData(), {
    stayId: '',
    stay: null,
    hotel: null,
    standardCheckOut: '',
    timeOptions: TIME_OPTIONS,
    targetTime: '',
    note: '',
    hint: '',
  }),

  onLoad(options) {
    var o = options || {};
    this.setData({ stayId: o.stayId || o.id || '' });
    this.load();
  },

  onShow() {
    state.onPageVisible(this);
    state.refreshOnShow(this, 'load');
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
        return state.ensureStayId(that).then(function (stayId) {
          return Promise.all([
            mini.currentStay(),
            mini.hotel().catch(function () {
              return null;
            }),
          ]).then(function (res) {
            return { stayId: stayId, stayRes: res[0], hotelRes: res[1] };
          });
        });
      },
      onSuccess: function (payload) {
        var raw = state.pickObject(payload.stayRes, ['stay', 'current', 'inhouse'], ['stayId', 'roomNo']);
        var hotelRaw = state.pickObject(payload.hotelRes, ['hotel'], ['name', 'checkOutTime']);
        var hotel = hotelRaw
          ? {
              name: format.first(hotelRaw, ['name', 'hotelName'], ''),
              phone: format.first(hotelRaw, ['phone', 'tel'], ''),
              checkOutTime: format.timeOnly(format.first(hotelRaw, ['checkOutTime', 'check_out_time'], '')),
            }
          : null;

        if (!raw) return { stay: null, hotel: hotel };

        var checkOutDate = format.dateOnly(format.first(raw, ['expectCheckOut', 'expect_check_out', 'checkOutDate'], ''));
        var standard = (hotel && hotel.checkOutTime) || '';

        return {
          stay: {
            roomNo: format.first(raw, ['roomNo', 'room_no'], '—'),
            roomTypeName: format.first(raw, ['roomTypeName', 'room_type_name'], ''),
            guestName: format.maskName(format.first(raw, ['guestName', 'guest_name'], '')),
            checkOutDate: checkOutDate,
            checkOutText: format.dateCN(checkOutDate),
            checkInText: format.dateTime(format.first(raw, ['checkInTime', 'check_in_time'], '')),
          },
          hotel: hotel,
          standardCheckOut: standard,
          // 默认选第一个晚于标准退房时间的选项（拿不到标准时间就默认 14:00）
          targetTime: that.pickDefaultTime(standard),
        };
      },
      onError: function (err, d) {
        if (d.code === 'NO_STAY') return { stay: null };
        return {};
      },
    });
  },

  /** 默认时间：比标准退房时间晚 2 小时（没标准时间就 14:00） */
  pickDefaultTime(standard) {
    if (!standard) return '14:00';
    var hh = Number(String(standard).slice(0, 2));
    if (!isFinite(hh)) return '14:00';
    var target = hh + 2;
    for (var i = 0; i < TIME_OPTIONS.length; i += 1) {
      if (Number(TIME_OPTIONS[i].slice(0, 2)) >= target) return TIME_OPTIONS[i];
    }
    return TIME_OPTIONS[TIME_OPTIONS.length - 1];
  },

  onTimeTap(e) {
    var value = e.currentTarget.dataset.time;
    if (!value) return;
    this.setData({ targetTime: value });
    state.resetRequest(this, 'late');
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
    state.resetRequest(this, 'late');
  },

  onSubmit() {
    var that = this;
    if (!this.data.stay) {
      state.toast('没有在住订单，无法申请延迟退房');
      return;
    }
    if (!this.data.targetTime) {
      state.toast('请选择希望退房的时间');
      return;
    }

    state
      .confirm(
        '确认申请',
        '申请延迟到 ' + this.data.targetTime + ' 退房。\n延迟退房可能需要支付额外费用，需前台确认房态后才能生效。',
        '提交申请'
      )
      .then(function (ok) {
        if (!ok) return null;
        return state.submit(that, {
          key: 'late',
          loadingText: '提交中',
          request: function (rid) {
            return mini.lateCheckout(that.data.stayId, {
              request_id: rid,
              targetTime: that.data.targetTime,
              date: that.data.stay.checkOutDate,
              note: String(that.data.note || '').trim() || undefined,
            });
          },
          onSuccess: function (data) {
            var fee = data && format.first(data, ['fee', 'amount', 'extraCharge'], null);
            wx.showModal({
              title: '申请已提交',
              content:
                '期望退房时间：' + that.data.targetTime +
                (fee !== null && fee !== '' ? '\n预计费用：¥' + format.money(fee) + '（以酒店确认为准）' : '\n费用以前台确认为准。') +
                '\n前台确认后会通过「通知中心」告知结果。',
              showCancel: false,
              confirmText: '知道了',
            });
          },
          onError: function (err, d) {
            that.setData({ hint: HINTS[d.code] || '' });
            if (d.code === 'NO_STAY' || d.code === 'ALREADY_CHECKED_OUT') that.load();
          },
        });
      });
  },

  onCallHotel() {
    var phone = this.data.hotel && this.data.hotel.phone;
    if (!phone) {
      wx.navigateTo({ url: '/pages/contact/index' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: String(phone) });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },
});
