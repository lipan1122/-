/**
 * 换房申请（清单第八节「换房申请」）
 *
 * 打开方式：/pages/change-room/index?stayId=12
 *
 * ── 数据来源 ──
 *   GET /api/mini/stays/current                  当前房间 / 离店日 / 房型
 *   GET /api/mini/rooms?checkIn=&checkOut=       实时可换房型（用当前在住区间查）
 *   POST /api/mini/stays/:id/change-room         { request_id, targetRoomTypeId, reason, note }
 *
 * ── 小程序不能自己换房（清单第 226 行）──
 *   除非酒店明确允许自助换房，否则这里只提交「申请」：
 *   前台审核 → 更新 room / stay / room_logs → 渠道和门锁状态同步。
 *   所以页面文案一律是「申请」「审核」，成功后也不显示「已换房」，
 *   只说「已提交，等待前台处理」—— 说错一句，客人会拿着行李下楼。
 *
 * ── 状态处理 ──
 *   房量接口未就绪时看不到可换房型 → 允许「不指定房型」提交（由前台安排），
 *   而不是把整页禁用掉。
 */
const format = require('../../utils/format');
const date = require('../../utils/date');
const api = require('../../utils/api');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 换房原因（提交给前台的分类字段） */
const REASONS = [
  { value: 'FACILITY', label: '房间设施问题' },
  { value: 'NOISE', label: '噪音 / 楼层朝向' },
  { value: 'SIZE', label: '房间太小 / 需要加床' },
  { value: 'TYPE', label: '想换房型' },
  { value: 'OTHER', label: '其他原因' },
];

const HINTS = {
  NO_ROOM: '所选房型当时已无可用房，可改选其他房型或联系前台。',
  INVENTORY_NOT_ENOUGH: '所选房型当时已无可用房，可改选其他房型或联系前台。',
  STAY_STATUS: '当前住宿状态不支持换房，请联系前台。',
  FRONT_DESK_REQUIRED: '该情况需要到前台办理。',
};

Page({
  data: Object.assign(state.baseData(), {
    stayId: '',
    stay: null,
    reasons: REASONS,
    reasonIndex: 0,
    note: '',
    /** 可选房型（来自实时房量接口；为空时允许不指定房型） */
    roomTypes: [],
    typeReady: false,
    selectedTypeId: '',
    selectedTypeName: '',
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
        var raw = state.pickObject(payload.res, ['stay', 'current', 'inhouse'], ['stayId', 'roomNo']);
        if (!raw) return { stay: null, roomTypes: [], typeReady: false };

        var checkOutDate = format.dateOnly(format.first(raw, ['expectCheckOut', 'expect_check_out', 'checkOutDate'], ''));
        var stay = {
          roomNo: format.first(raw, ['roomNo', 'room_no'], '—'),
          roomTypeName: format.first(raw, ['roomTypeName', 'room_type_name'], ''),
          roomTypeId: format.first(raw, ['roomTypeId', 'room_type_id'], ''),
          guestName: format.maskName(format.first(raw, ['guestName', 'guest_name'], '')),
          checkOutDate: checkOutDate,
          checkOutText: format.dateCN(checkOutDate),
        };
        that.setData({ stay: stay });
        that.loadRoomTypes(checkOutDate);
        return { stay: stay };
      },
      onError: function (err, d) {
        if (d.code === 'NO_STAY') return { stay: null };
        return {};
      },
    });
  },

  /**
   * 可换房型：用「今天 → 当前离店日」查实时可售
   *
   * 失败不挡提交：接口没就绪时页面显示「由前台安排房型」，客人仍能提申请。
   */
  loadRoomTypes(checkOutDate) {
    var that = this;
    var today = date.today();
    var checkOut = checkOutDate && checkOutDate > today ? checkOutDate : date.addDays(today, 1);

    return api
      .request('/api/mini/rooms?checkIn=' + today + '&checkOut=' + checkOut)
      .then(function (data) {
        var list = (data && data.roomTypes) || [];
        var currentId = Number(that.data.stay && that.data.stay.roomTypeId) || 0;
        var options = [];
        for (var i = 0; i < list.length; i += 1) {
          var t = list[i] || {};
          var remaining = format.int(t.remainingRooms);
          // 当前房型也保留（客人可能只是想换朝向/楼层），售完的排除
          if (remaining <= 0 || t.soldOut === true) continue;
          options.push({
            roomTypeId: String(t.roomTypeId),
            name: format.first(t, ['name'], '房型'),
            bedType: format.first(t, ['bedType'], ''),
            maxOccupancy: format.int(t.maxOccupancy),
            remainingText: '剩 ' + remaining + ' 间',
            priceText: format.moneyOrDash(format.first(t, ['avgPrice', 'basePrice'], null)),
            isCurrent: Number(t.roomTypeId) === currentId,
          });
        }
        that.setData({ roomTypes: options, typeReady: options.length > 0 });
      })
      .catch(function () {
        that.setData({ roomTypes: [], typeReady: false });
      });
  },

  onSelectType(e) {
    var id = e.currentTarget.dataset.id;
    var name = e.currentTarget.dataset.name || '';
    // 再点一次取消选择 → 交给前台安排
    if (String(this.data.selectedTypeId) === String(id)) {
      this.setData({ selectedTypeId: '', selectedTypeName: '' });
    } else {
      this.setData({ selectedTypeId: String(id), selectedTypeName: name });
    }
    state.resetRequest(this, 'change');
  },

  onReasonChange(e) {
    this.setData({ reasonIndex: Number(e.detail.value) || 0 });
    state.resetRequest(this, 'change');
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
    state.resetRequest(this, 'change');
  },

  onSubmit() {
    var that = this;
    if (!this.data.stay) {
      state.toast('没有可换房的在住订单');
      return;
    }
    var reason = REASONS[this.data.reasonIndex] || REASONS[0];
    var targetName = this.data.selectedTypeName || '由前台安排';

    state
      .confirm(
        '提交换房申请',
        '目标房型：' + targetName + '\n原因：' + reason.label + '\n\n换房需前台审核并安排房间，审核通过后才生效；在此期间请留在原房间。',
        '提交申请'
      )
      .then(function (ok) {
        if (!ok) return null;
        return state.submit(that, {
          key: 'change',
          loadingText: '提交中',
          request: function (rid) {
            return mini.changeRoom(that.data.stayId, {
              request_id: rid,
              targetRoomTypeId: that.data.selectedTypeId ? Number(that.data.selectedTypeId) : undefined,
              reason: reason.label,
              reasonCode: reason.value,
              note: String(that.data.note || '').trim() || undefined,
            });
          },
          onSuccess: function () {
            wx.showModal({
              title: '换房申请已提交',
              content: '前台审核后会通过「通知中心」告知结果，也可以直接联系前台确认进度。',
              showCancel: false,
              confirmText: '知道了',
            });
            // 提交成功后清掉原因与备注（幂等键已随成功失效）
            that.setData({ note: '', selectedTypeId: '', selectedTypeName: '' });
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
