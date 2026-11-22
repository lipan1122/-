/**
 * 入住前服务（清单第八节「入住前服务」）
 *
 * 打开方式：/pages/pre-stay/index?bookingId=3（订单详情页跳进来）
 *
 * ── 数据来源 ──
 *   GET /api/mini/bookings/:id   订单信息（入住日期 / 房型 / 已填的到店时间与特殊要求）
 *   GET /api/mini/hotel          酒店信息（地址 / 电话 / 入住须知 / 停车说明 / 设施）
 *   两个接口分别降级：酒店信息没就绪不影响填到店时间。
 *
 * ── 提交 ──
 *   POST /api/mini/bookings/:id/modify  { request_id, arrivalTime, arrivalType, specialRequests, guestName }
 *   POST /api/mini/breakfast            { request_id, bookingId, count, remark }
 *
 * ── 关于身份证预录入（清单第 156 行）──
 *   小程序没有读卡器、也没有公安接口，所以这里**只做预录入**：
 *     · 号码明文只在输入框里存在，提交后本地不写 storage
 *     · 提交后立刻把输入框清空，页面上只显示服务端回传的脱敏值
 *     · 页面明确写「到店仍需人证核验」，绝不提示「已完成核验」
 *   这不是体验问题，是合规问题：假装核验过会让酒店在检查时直接不合格。
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 到店时段：早到 / 准时 / 晚到（服务端按这个字段排房与提醒前台） */
const ARRIVAL_TYPES = [
  { value: 'EARLY', label: '提前到店', hint: '视房态尽量安排，可能需要等待' },
  { value: 'ONTIME', label: '准时到店', hint: '' },
  { value: 'LATE', label: '延迟到店', hint: '超过 20:00 到店请提前告知，避免房间被释放' },
];

/** 证件类型（仅预录入；具体支持哪些以酒店政策为准） */
const ID_TYPES = ['身份证', '护照', '港澳通行证', '台湾通行证', '其他'];

Page({
  data: Object.assign(state.baseData(), {
    bookingId: '',
    booking: null,
    hotel: null,

    /* 到店时间 */
    arrivalTypes: ARRIVAL_TYPES,
    arrivalType: 'ONTIME',
    arrivalClock: '14:00',

    /* 特殊要求 */
    specialRequests: '',

    /* 入住人 + 证件预录入 */
    guestName: '',
    idTypes: ID_TYPES,
    idTypeIndex: 0,
    idNo: '',
    /** 已提交过的证件脱敏值（服务端回传） */
    idNoMasked: '',

    /* 早餐预购 */
    breakfastCount: 0,
    breakfastRemark: '',
    breakfastSubmitting: false,
  }),

  onLoad(options) {
    var o = options || {};
    this.setData({ bookingId: o.bookingId || o.id || '' });
    if (!this.data.bookingId) {
      // 没有订单号也能进来（例如从在住页误入口）：只展示酒店须知，不显示表单
      this.loadHotelOnly();
      return;
    }
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

  /** 订单 + 酒店信息并行拉；订单未就绪时仍然展示酒店须知 */
  load() {
    var that = this;
    return state.load(this, {
      request: function () {
        return Promise.all([
          mini.bookingDetail(that.data.bookingId).catch(function (err) {
            // 订单接口未就绪 / 失败都不应该拖垮整页：酒店须知仍然有价值
            return { __error: err };
          }),
          mini.hotel().catch(function () {
            return null;
          }),
        ]);
      },
      onSuccess: function (res) {
        var bookingRes = res && res[0];
        var hotelRes = res && res[1];
        var patch = {};

        /* ---------------- 酒店信息（可能为空） ---------------- */
        patch.hotel = that.mapHotel(hotelRes);

        /* ---------------- 订单信息 ---------------- */
        var orderErr = bookingRes && bookingRes.__error;
        if (orderErr) {
          patch.booking = null;
          patch.notReady = !!orderErr.notReady;
          patch.notReadyMsg = orderErr.notReady
            ? orderErr.message
            : '';
          patch.error = orderErr.notReady ? '' : orderErr.message || '订单信加载失败';
          patch.errorCode = orderErr.code || '';
          return patch;
        }

        var b = state.pickObject(bookingRes, ['booking', 'order', 'detail'], ['bookingNo', 'checkInDate']);
        if (!b) {
          patch.booking = null;
          return patch;
        }

        var checkInDate = format.dateOnly(format.first(b, ['checkInDate', 'check_in_date'], ''));
        var arrivalRaw = format.first(b, ['arrivalTime', 'arrival_time'], '');
        var arrivalClock = arrivalRaw ? format.timeOnly(arrivalRaw) : '14:00';
        var arrivalType = String(format.first(b, ['arrivalType'], 'ONTIME')).toUpperCase();

        patch.booking = {
          bookingNo: format.first(b, ['bookingNo', 'booking_no'], '—'),
          roomTypeName: format.first(b, ['roomTypeName', 'room_type_name'], '—'),
          checkInDate: checkInDate,
          checkInText: format.dateCN(checkInDate),
          checkOutDate: format.dateOnly(format.first(b, ['checkOutDate', 'check_out_date'], '')),
          nights: format.int(format.first(b, ['nights'], 0)),
          roomCount: format.int(format.first(b, ['roomCount', 'room_count'], 1)),
          guestName: format.maskName(format.first(b, ['guestName', 'guest_name'], '')),
          statusLabel: format.statusLabel(
            format.first(b, ['status'], ''),
            format.first(b, ['statusLabel'], '')
          ),
          idNoMasked: format.maskIdNo(format.first(b, ['idNoMasked', 'id_no_masked', 'idNo'], '')),
        };
        patch.arrivalClock = arrivalClock;
        patch.arrivalType = ARRIVAL_TYPES.some(function (t) {
          return t.value === arrivalType;
        })
          ? arrivalType
          : 'ONTIME';
        patch.specialRequests = format.first(b, ['specialRequests', 'remark', 'note'], '');
        // 已脱敏的姓名不能回填到输入框（提交回去会把「张*」写进库）
        patch.guestName = '';
        patch.idNoMasked = patch.booking.idNoMasked;
        return patch;
      },
    });
  },

  /** 无订单：只拉酒店信息（入住须知 / 停车 / 电话） */
  loadHotelOnly() {
    var that = this;
    return state.load(this, {
      request: function () {
        return mini.hotel();
      },
      onSuccess: function (data) {
        return { hotel: that.mapHotel(data), booking: null };
      },
    });
  },

  mapHotel(data) {
    var h = state.pickObject(data, ['hotel'], ['name', 'phone', 'address']);
    if (!h) return null;
    return {
      name: format.first(h, ['name', 'hotelName'], ''),
      address: format.first(h, ['address'], ''),
      phone: format.first(h, ['phone', 'tel'], ''),
      businessHours: format.first(h, ['businessHours', 'business_hours'], ''),
      checkInTime: format.timeOnly(format.first(h, ['checkInTime', 'check_in_time'], '')),
      checkOutTime: format.timeOnly(format.first(h, ['checkOutTime', 'check_out_time'], '')),
      parking: format.first(h, ['parkingInfo', 'parking'], ''),
      notice: format.first(h, ['notice', 'checkInNotice'], ''),
      facilities: format.first(h, ['facilitiesText', 'facilities'], ''),
      latitude: format.first(h, ['latitude', 'lat'], ''),
      longitude: format.first(h, ['longitude', 'lng'], ''),
    };
  },

  /* ------------------------------ 表单交互 ------------------------------ */

  onArrivalTypeTap(e) {
    var value = e.currentTarget.dataset.value;
    if (!value) return;
    this.setData({ arrivalType: value });
    state.resetRequest(this, 'arrive');
  },

  onArrivalClockChange(e) {
    this.setData({ arrivalClock: e.detail.value });
    state.resetRequest(this, 'arrive');
  },

  onFieldInput(e) {
    var field = e.currentTarget.dataset.field;
    if (!field) return;
    var patch = {};
    patch[field] = e.detail.value;
    this.setData(patch);
    state.resetRequest(this, 'arrive');
  },

  onIdTypeChange(e) {
    this.setData({ idTypeIndex: Number(e.detail.value) || 0 });
    state.resetRequest(this, 'arrive');
  },

  /** 提交到店时间 / 特殊要求 / 入住人（证件只传号码，本地不留） */
  onSubmit() {
    var that = this;
    var b = this.data.booking;
    if (!b) {
      state.toast('没有关联订单，无法提交');
      return;
    }

    var idNo = String(this.data.idNo || '').trim();
    if (idNo && idNo.length < 6) {
      state.toast('证件号码不完整');
      return;
    }
    var arrivalTime = b.checkInDate ? b.checkInDate + ' ' + this.data.arrivalClock : '';

    state
      .submit(this, {
        key: 'arrive',
        flag: 'submitting',
        loadingText: '提交中',
        request: function (rid) {
          return mini.modifyBooking(that.data.bookingId, {
            request_id: rid,
            arrivalTime: arrivalTime,
            arrivalType: that.data.arrivalType,
            specialRequests: String(that.data.specialRequests || '').trim() || undefined,
            guestName: String(that.data.guestName || '').trim() || undefined,
            idType: idNo ? ID_TYPES[that.data.idTypeIndex] : undefined,
            // 身份证号只做预录入：提交后服务端脱敏存储，本地清空
            idNo: idNo || undefined,
          });
        },
        onSuccess: function () {
          state.toast('已提交，前台会尽快确认', 'success');
          // 本地立刻清空证件号，避免停留在页面上被旁人看到 / 被截图
          that.setData({ idNo: '', guestName: '' });
          that.load();
        },
      });
  },

  /* ------------------------------ 早餐预购 ------------------------------ */

  onBreakfastMinus() {
    if (this.data.breakfastCount <= 0) return;
    this.setData({ breakfastCount: this.data.breakfastCount - 1 });
    state.resetRequest(this, 'breakfast');
  },

  onBreakfastPlus() {
    if (this.data.breakfastCount >= 10) {
      state.toast('单次最多预购 10 份');
      return;
    }
    this.setData({ breakfastCount: this.data.breakfastCount + 1 });
    state.resetRequest(this, 'breakfast');
  },

  onSubmitBreakfast() {
    var that = this;
    var b = this.data.booking;
    if (this.data.breakfastCount <= 0) {
      state.toast('请先选择份数');
      return;
    }

    state
      .submit(this, {
        key: 'breakfast',
        flag: 'breakfastSubmitting',
        loadingText: '提交中',
        request: function (rid) {
          return mini.breakfast({
            request_id: rid,
            bookingId: that.data.bookingId,
            count: that.data.breakfastCount,
            date: b ? b.checkInDate : undefined,
            remark: String(that.data.breakfastRemark || '').trim() || undefined,
          });
        },
        onSuccess: function (data) {
          var amount = data && format.first(data, ['amount', 'totalAmount'], null);
          wx.showModal({
            title: '早餐预购已提交',
            content:
              '共 ' + that.data.breakfastCount + ' 份' +
              (amount !== null && amount !== '' ? '，参考金额 ¥' + format.money(amount) : '') +
              '\n费用并入房间账单，以酒店确认为准。',
            showCancel: false,
          });
          that.setData({ breakfastCount: 0, breakfastRemark: '' });
        },
      });
  },

  /* ------------------------------ 其他入口 ------------------------------ */

  onCallHotel() {
    var phone = this.data.hotel && this.data.hotel.phone;
    if (!phone) {
      wx.navigateTo({ url: '/pages/contact/index' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: String(phone) });
  },

  onOpenMap() {
    var h = this.data.hotel;
    if (!h || !h.latitude || !h.longitude) {
      wx.navigateTo({ url: '/pages/contact/index' });
      return;
    }
    wx.openLocation({
      latitude: Number(h.latitude),
      longitude: Number(h.longitude),
      name: h.name || '酒店',
      address: h.address || '',
      scale: 16,
    });
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },
});
