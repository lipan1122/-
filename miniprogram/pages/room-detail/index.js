/**
 * 房型详情（清单第八节「房型详情」）
 *
 * 打开方式：/pages/room-detail/index?roomTypeId=3&checkIn=2026-11-18&checkOut=2026-11-20
 *
 * 数据来源：GET /api/mini/room-types/:id?checkIn=&checkOut=
 *   → { roomTypeId, name, bedType, area, maxOccupancy, floor,
 *       breakfast, facilities[], images[], cancelPolicy, checkInTime, checkOutTime,
 *       deposit, basePrice, avgPrice, totalPrice, remainingRooms, soldOut,
 *       calendar: [{ date, price, available }] }
 *
 * ── 三条硬规则（清单第 81 行：不要在页面写死虚假信息）──
 *   1. 图片 / 设施 / 早餐 / 取消政策 / 押金全部来自服务端。没配就显示「暂无图片」「以酒店
 *      确认为准」—— 绝不写死「含双早」「免费取消」这类承诺，那是要赔钱的。
 *   2. 价格只作展示：下单和最终金额由服务端按房价日历重算，客户端改不了价。
 *   3. 接口没上线时整页降级成「功能准备中」，并保留「联系酒店」出口（客人不能卡死）。
 */
const format = require('../../utils/format');
const date = require('../../utils/date');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 服务端图片字段可能是 string / [{ url }]，统一成 URL 数组 */
function toImages(raw) {
  if (!raw) return [];
  var list = Array.isArray(raw) ? raw : String(raw).split(',');
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    var v = list[i];
    var url = typeof v === 'string' ? v : v && (v.url || v.src || v.imageUrl || v.image_url);
    if (url) out.push(String(url));
  }
  return out;
}

/** 设施可能是 ['空调','WiFi'] 或 [{ name }] 或 '空调,WiFi' */
function toFacilities(raw) {
  if (!raw) return [];
  var list = Array.isArray(raw) ? raw : String(raw).split(',');
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    var v = list[i];
    var name = typeof v === 'string' ? v : v && (v.name || v.label || v.title);
    if (name) out.push(String(name).trim());
  }
  return out;
}

/** 每晚价格日历（空日历不报错，页面显示「价格日历准备中」） */
function toCalendar(raw) {
  var list = Array.isArray(raw) ? raw : [];
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    var d = list[i] || {};
    var day = format.dateOnly(d.date || d.day);
    if (!day) continue;
    out.push({
      date: day,
      dayText: day.slice(5),
      weekText: format.dateCN(day).split(' ')[1] || '',
      priceText: format.moneyOrDash(d.price),
      soldOut: d.available === false || d.soldOut === true,
    });
  }
  return out;
}

Page({
  data: Object.assign(state.baseData(), {
    roomTypeId: '',
    checkIn: '',
    checkOut: '',
    nights: 1,
    /** 格式化后的房型详情 */
    detail: null,
    images: [],
    hasImages: false,
    facilities: [],
    calendar: [],
    calendarReady: false,
    soldOut: false,
    remainingRooms: 0,
    remainingText: '',
    priceText: '—',
    totalText: '—',
  }),

  onLoad(options) {
    var o = options || {};
    var checkIn = o.checkIn || date.today();
    var checkOut = o.checkOut || date.addDays(checkIn, 1);
    this.setData({
      roomTypeId: o.roomTypeId || o.id || '',
      checkIn: checkIn,
      checkOut: checkOut,
      nights: date.nights(checkIn, checkOut) || 1,
    });
    this.load();
  },

  /** 返回本页时刷新：价格与房量可能已经变了（清单「返回后刷新」「房量变化」） */
  onShow() {
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
    var id = this.data.roomTypeId;

    if (!id) {
      this.setData({ loading: false, loaded: true, error: '缺少房型参数，请从房型列表重新进入' });
      return Promise.resolve(null);
    }

    return state.load(this, {
      request: function () {
        return mini.roomType(id, { checkIn: that.data.checkIn, checkOut: that.data.checkOut });
      },
      onSuccess: function (data) {
        var d = state.pickObject(data, ['roomType', 'detail', 'item'], ['roomTypeId', 'name', 'id']);
        if (!d) {
          return { detail: null, error: '房型信息不存在或已下架', loaded: true };
        }

        var images = toImages(d.images || d.imageList || d.imageUrls);
        var facilities = toFacilities(d.facilities || d.amenities);
        var calendar = toCalendar(d.calendar || d.priceCalendar || d.rates);
        var remaining = format.int(format.first(d, ['remainingRooms', 'remaining', 'availableRooms'], 0));
        var soldOut = d.soldOut === true || remaining <= 0;

        if (d.name) wx.setNavigationBarTitle({ title: String(d.name) });

        return {
          detail: {
            name: format.first(d, ['name', 'roomTypeName'], '房型'),
            code: format.first(d, ['code'], ''),
            bedType: format.first(d, ['bedType', 'bed_type'], ''),
            areaText: format.first(d, ['areaText'], d.area ? d.area + '㎡' : ''),
            floorText: format.first(d, ['floorText'], d.floor ? '第 ' + d.floor + ' 层' : ''),
            maxOccupancy: format.int(format.first(d, ['maxOccupancy', 'max_occupancy'], 0)),
            breakfastText: format.first(d, ['breakfastText'], format.first(d, ['breakfast', 'breakfastDesc'], '')),
            cancelPolicy: format.first(d, ['cancelPolicy', 'cancel_policy'], ''),
            checkInTime: format.timeOnly(format.first(d, ['checkInTime', 'check_in_time'], '')),
            checkOutTime: format.timeOnly(format.first(d, ['checkOutTime', 'check_out_time'], '')),
            depositText: format.moneyOrDash(format.first(d, ['deposit', 'depositAmount'], null)),
            depositNote: format.first(d, ['depositNote'], ''),
            basePriceText: format.moneyOrDash(format.first(d, ['basePrice'], null)),
            avgPriceText: format.moneyOrDash(format.first(d, ['avgPrice'], null)),
            totalText: format.moneyOrDash(format.first(d, ['totalPrice'], null)),
            desc: format.first(d, ['description', 'desc'], ''),
          },
          images: images,
          hasImages: images.length > 0,
          facilities: facilities,
          calendar: calendar,
          calendarReady: calendar.length > 0,
          soldOut: soldOut,
          remainingRooms: remaining,
          remainingText: remaining > 0 ? '剩 ' + remaining + ' 间' : '已售完',
          priceText: format.moneyOrDash(format.first(d, ['avgPrice', 'basePrice'], null)),
          totalText: format.moneyOrDash(format.first(d, ['totalPrice'], null)),
        };
      },
    });
  },

  /** 联系酒店（接口没上线时也能用：转联系页，联系页自己会降级） */
  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  /** 去下单：把房型 / 日期 / 单间总价带过去（金额仍由服务端重算） */
  goBooking() {
    if (this.data.soldOut) {
      state.toast('该房型在所选日期已售完');
      return;
    }
    var detail = this.data.detail || {};
    // remaining 直接取服务端数值，不从「剩 3 间」里抠数字（更容易出错）
    var remaining = format.int(this.data.remainingRooms);
    var url =
      '/pages/booking/booking?roomTypeId=' +
      encodeURIComponent(this.data.roomTypeId) +
      '&name=' +
      encodeURIComponent(detail.name || '') +
      '&checkIn=' +
      this.data.checkIn +
      '&checkOut=' +
      this.data.checkOut +
      '&totalPrice=' +
      encodeURIComponent(format.num(this.data.totalText)) +
      '&remaining=' +
      remaining;
    wx.navigateTo({ url: url });
  },
});
