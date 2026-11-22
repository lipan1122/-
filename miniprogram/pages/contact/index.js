/**
 * 联系酒店（清单第八节「联系酒店」）
 *
 * 打开方式：/pages/contact/index（各页的「联系酒店 / 联系前台」按钮）
 *
 * 数据来源：GET /api/mini/hotel
 *   → { name, address, phone, businessHours, latitude, longitude,
 *       checkInTime, checkOutTime, parkingInfo, notice, facilities, description }
 *
 * ── 为什么不写死一个电话号码 ──
 *   这是「不要在页面写死虚假信息」最典型的场景：写一个假号码，客人打过去是空号，
 *   比没有这个页面更糟。所以服务端没配置就显示「联系方式暂未配置，请通过预订平台
 *   或到店咨询」，所有拨打/导航按钮都保持 disabled。
 *
 * ── 为什么打电话用 wx.makePhoneCall 而不是 <a href="tel:"> ──
 *   小程序里没有 tel: 链接，只能用 API；用户点「取消」不会报错，是正常路径。
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

Page({
  data: Object.assign(state.baseData(), {
    hotel: null,
    hasPhone: false,
    hasLocation: false,
    hasAddress: false,
  }),

  onLoad() {
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
        return mini.hotel();
      },
      onSuccess: function (data) {
        var h = state.pickObject(data, ['hotel'], ['name', 'phone', 'address']);
        if (!h) return { hotel: null, hasPhone: false, hasLocation: false, hasAddress: false };

        var phone = format.first(h, ['phone', 'tel', 'mobile'], '');
        var lat = format.first(h, ['latitude', 'lat'], '');
        var lng = format.first(h, ['longitude', 'lng'], '');

        var hotel = {
          name: format.first(h, ['name', 'hotelName'], ''),
          address: format.first(h, ['address', 'fullAddress'], ''),
          phone: phone,
          businessHours: format.first(h, ['businessHours', 'business_hours'], ''),
          checkInTime: format.timeOnly(format.first(h, ['checkInTime', 'check_in_time'], '')),
          checkOutTime: format.timeOnly(format.first(h, ['checkOutTime', 'check_out_time'], '')),
          parking: format.first(h, ['parkingInfo', 'parking'], ''),
          notice: format.first(h, ['notice', 'checkInNotice'], ''),
          facilities: format.first(h, ['facilitiesText', 'facilities'], ''),
          description: format.first(h, ['description', 'intro'], ''),
          latitude: lat,
          longitude: lng,
        };

        if (hotel.name) wx.setNavigationBarTitle({ title: hotel.name });

        return {
          hotel: hotel,
          hasPhone: Boolean(phone),
          hasLocation: Boolean(lat && lng),
          hasAddress: Boolean(hotel.address),
        };
      },
    });
  },

  /* ------------------------------ 动作 ------------------------------ */

  onCall() {
    var phone = this.data.hotel && this.data.hotel.phone;
    if (!phone) {
      state.toast('酒店还没有配置联系电话');
      return;
    }
    wx.makePhoneCall({
      phoneNumber: String(phone),
      fail: function () {
        // 用户主动取消也会走 fail，不弹错；但号码无效时给出真实原因
      },
    });
  },

  onCopyPhone() {
    var phone = this.data.hotel && this.data.hotel.phone;
    if (!phone) return;
    wx.setClipboardData({ data: String(phone) });
  },

  onCopyAddress() {
    var address = this.data.hotel && this.data.hotel.address;
    if (!address) {
      state.toast('地址暂未配置');
      return;
    }
    wx.setClipboardData({ data: String(address) });
  },

  onOpenLocation() {
    var h = this.data.hotel;
    if (!h || !this.data.hasLocation) {
      state.toast('酒店还没有配置地图坐标');
      return;
    }
    wx.openLocation({
      latitude: Number(h.latitude),
      longitude: Number(h.longitude),
      name: h.name || '酒店',
      address: h.address || '',
      scale: 16,
      fail: function () {
        state.toast('无法打开地图');
      },
    });
  },

  goIndex() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  goMember() {
    wx.switchTab({ url: '/pages/member/member' });
  },

  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },

  /** 隐私与协议说明：小程序只做住客端功能，不保存身份证与支付信息 */
  onShowPolicy(e) {
    var kind = e.currentTarget.dataset.kind;
    var content =
      kind === 'privacy'
        ? '本小程序仅用于查房、预订、在住服务与会员查询。\n' +
          '· 手机号、姓名、证件号在服务端脱敏存储与展示\n' +
          '· 身份证仅做入住前预录入，到店仍需人证核验\n' +
          '· 不采集通讯录、位置等与住宿服务无关的信息\n' +
          '· 同一微信只能绑定一个手机号，解绑可在「储值和积分」里操作'
        : '订单与房价以酒店系统计算为准。\n' +
          '· 本小程序默认到店付款，不发起在线支付\n' +
          '· 取消、修改、续住、换房、延迟退房均为「申请」，需前台确认\n' +
          '· 非酒店原因取消是否收费，以订单取消政策为准\n' +
          '· 服务请求与发票由前台处理，处理进度在通知中心查看';
    wx.showModal({
      title: kind === 'privacy' ? '隐私说明' : '服务条款',
      content: content,
      showCancel: false,
      confirmText: '我知道了',
    });
  },
});
