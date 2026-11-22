/**
 * 续住申请（清单第八节「续住」）
 *
 * 打开方式：/pages/extend/index?stayId=12（在住服务 → 续住）
 *
 * ── 数据来源 ──
 *   GET /api/mini/stays/current   当前在住（房间号 / 原离店日 / 房型）
 *   GET /api/mini/rooms?checkIn=&checkOut=  续住区间的参考价（可选，失败不挡提交）
 *   POST /api/mini/stays/:id/extend  { request_id, newCheckOutDate }
 *
 * ── 价格为什么不在这里算 ──
 *   续住 = 现查远期库存 + 现算价格，而且要和 PC 端 extendStayAction 用同一套
 *   库存冲突算法（清单第 203 行）。客户端算出来的数字只能当「参考价」，
 *   真实金额、真实库存一律以服务端返回为准。页面上的参考价必须标「参考」，
 *   否则客人会拿着小程序截图跟前台争价格。
 *
 * ── 失败要说得清楚（清单第 205-211 行）──
 *   房量不足 / 日期不合法 / 账单未结 / 订单状态不允许 / 需要到前台处理。
 *   服务端已经给中文 message，这里直接展示；另外按 code 给一句「下一步怎么做」，
 *   免得客人看到「续住失败」四个字只能打电话。
 */
const format = require('../../utils/format');
const date = require('../../utils/date');
const api = require('../../utils/api');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 失败码 → 下一步建议（服务端 message 之外的补充指引） */
const HINTS = {
  INVENTORY_NOT_ENOUGH: '该房型在续住区间已订满，可换房型或联系前台安排。',
  ROOM_NOT_ENOUGH: '该房型在续住区间已订满，可换房型或联系前台安排。',
  BAD_DATE: '续住日期必须晚于当前离店日期。',
  FOLIO_UNPAID: '账单还有未结金额，请先到前台结清再续住。',
  STAY_STATUS: '当前住宿状态不支持续住，请联系前台处理。',
  FRONT_DESK_REQUIRED: '该情况需要到前台办理续住。',
  NOT_INHOUSE: '当前没有在住记录，无法续住。',
};

Page({
  data: Object.assign(state.baseData(), {
    stayId: '',
    stay: null,
    /** 可选的新离店日（最早 = 原离店日 + 1 天） */
    newCheckOutDate: '',
    minCheckOutDate: '',
    maxCheckOutDate: '',
    addedNights: 0,
    /** 参考价（来自房量接口，服务端未就绪时为 ''） */
    refPriceText: '',
    refReady: false,
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
          return mini.currentStay().then(function (res) {
            return { stayId: stayId, res: res };
          });
        });
      },
      onSuccess: function (payload) {
        var raw = state.pickObject(payload.res, ['stay', 'current', 'inhouse'], ['stayId', 'check_out_date', 'stayId']);
        if (!raw) return { stay: null };

        var checkOutDate = format.dateOnly(
          format.first(raw, ['expectCheckOut', 'expect_check_out', 'checkOutDate'], '')
        );
        // 没有离店日就没法算续住区间：交给服务端在提交时报错，页面先提示
        if (!checkOutDate) {
          return {
            stay: {
              roomNo: format.first(raw, ['roomNo', 'room_no'], '—'),
              roomTypeName: format.first(raw, ['roomTypeName', 'room_type_name'], ''),
              checkOutDate: '',
              checkOutText: '—',
            },
            minCheckOutDate: date.today(),
            newCheckOutDate: date.addDays(date.today(), 1),
          };
        }

        var minDate = date.addDays(checkOutDate, 1);
        // 保留用户已选的日期（只要它还在合法范围内），否则默认 +1 天
        var nextDate = that.data.newCheckOutDate && that.data.newCheckOutDate > checkOutDate ? that.data.newCheckOutDate : minDate;

        return {
          stay: {
            roomNo: format.first(raw, ['roomNo', 'room_no'], '—'),
            roomTypeName: format.first(raw, ['roomTypeName', 'room_type_name'], ''),
            guestName: format.maskName(format.first(raw, ['guestName', 'guest_name'], '')),
            checkOutDate: checkOutDate,
            checkOutText: format.dateCN(checkOutDate),
            roomTypeId: format.first(raw, ['roomTypeId', 'room_type_id'], ''),
          },
          minCheckOutDate: minDate,
          // 远期房态最多看到 62 天，这里给个 30 天的上限避免选到太远的日期
          maxCheckOutDate: date.addDays(checkOutDate, 30),
          newCheckOutDate: nextDate,
          addedNights: date.nights(checkOutDate, nextDate),
        };
      },
      onError: function (err, d) {
        if (d.code === 'NO_STAY') return { stay: null };
        return {};
      },
    }).then(function (data) {
      // 拿到在住信息后再查参考价（失败不影响主流程）
      that.loadRefPrice();
      return data;
    });
  },

  /**
   * 参考价：只作展示
   *
   * 用同房型在续住区间的均价 × 天数，服务端有房量接口就能算；接口没就绪就
   * 不显示价格，改成「提交后由酒店系统报价」。绝不本地编一个价格。
   *
   * 走的是公开接口 /api/mini/rooms（与首页查房同一个，匿名可访问），
   * 不算「绕过登录」；它只回房型级可售数量，不回全店物理房量。
   */
  loadRefPrice() {
    var that = this;
    var stay = this.data.stay;
    if (!stay || !stay.checkOutDate || !this.data.newCheckOutDate) return Promise.resolve();
    if (this.data.newCheckOutDate <= stay.checkOutDate) return Promise.resolve();

    return api
      .request('/api/mini/rooms?checkIn=' + stay.checkOutDate + '&checkOut=' + this.data.newCheckOutDate)
      .then(function (data) {
        var list = (data && data.roomTypes) || [];
        var roomTypeId = Number(stay.roomTypeId) || 0;
        var hit = null;
        for (var i = 0; i < list.length; i += 1) {
          if (roomTypeId && Number(list[i].roomTypeId) === roomTypeId) {
            hit = list[i];
            break;
          }
        }
        if (!hit && list.length === 1) hit = list[0];
        if (!hit) return;
        that.setData({
          refReady: true,
          refPriceText: format.money(hit.totalPrice),
          hint:
            '参考价 ¥' +
            format.money(hit.totalPrice) +
            '（续住区间可售 ' +
            format.int(hit.remainingRooms) +
            ' 间），以酒店确认为准。',
        });
      })
      .catch(function () {
        // 参考价失败静默：不影响提交，页面本来就不该把参考价当承诺
        that.setData({ refReady: false, refPriceText: '', hint: '' });
      });
  },

  onDateChange(e) {
    var value = e.detail.value;
    var stay = this.data.stay;
    if (stay && stay.checkOutDate && value <= stay.checkOutDate) {
      state.toast('续住后的离店日要晚于 ' + stay.checkOutDate);
      return;
    }
    this.setData({
      newCheckOutDate: value,
      addedNights: stay && stay.checkOutDate ? date.nights(stay.checkOutDate, value) : 0,
    });
    // 日期变了：参考价重查，幂等键也换新（内容变了就不是同一次提交）
    state.resetRequest(this, 'extend');
    this.loadRefPrice();
  },

  onSubmit() {
    var that = this;
    var stay = this.data.stay;
    if (!stay || !stay.checkOutDate) {
      state.toast('没有可续住的在住订单');
      return;
    }
    var newDate = this.data.newCheckOutDate;
    if (!newDate || newDate <= stay.checkOutDate) {
      state.toast('请选择晚于当前离店日的日期');
      return;
    }

    state
      .confirm(
        '确认续住',
        '续住到 ' + newDate + '（多住 ' + date.nights(stay.checkOutDate, newDate) + ' 晚）。\n提交后需前台确认房态与价格，确认前订单离店日不变。',
        '提交申请'
      )
      .then(function (ok) {
        if (!ok) return null;
        return state.submit(that, {
          key: 'extend',
          loadingText: '提交中',
          request: function (rid) {
            return mini.extendStay(that.data.stayId, { request_id: rid, newCheckOutDate: newDate });
          },
          onSuccess: function (data) {
            var amount = data && format.first(data, ['amount', 'totalPrice', 'extraCharge'], null);
            wx.showModal({
              title: '续住申请已提交',
              content:
                '新的离店日：' + newDate +
                (amount !== null && amount !== '' ? '\n续住金额 ¥' + format.money(amount) : '') +
                '\n前台确认后生效，可在「在住服务」查看最新离店日。',
              showCancel: false,
              confirmText: '好的',
              success: function () {
                wx.navigateBack({ fail: function () {} });
              },
            });
          },
          onError: function (err, d) {
            that.setData({ hint: HINTS[d.code] || '' });
            if (d.code === 'NO_STAY' || d.code === 'STAY_STATUS') that.load();
          },
        });
      });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },
});
