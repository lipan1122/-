/**
 * 客房服务（清单第八节「早餐和客房服务」）
 *
 * 打开方式：/pages/services/index?stayId=12
 *
 * ── 三条提交通道（都不接受客户端伪造 stayId）──
 *   叫醒    POST /api/mini/stays/:id/wakeup      { request_id, wakeupTime, note }
 *   早餐    POST /api/mini/breakfast             { request_id, stayId, count, remark }
 *   其他    POST /api/mini/stays/:id/service     { request_id, service_type, note, expect_time, quantity }
 *
 *   为什么叫醒和早餐要单独接口：它们在前台侧是不同的工单（叫醒要定时任务、
 *   早餐要出餐券并计费），混进通用 service 会变成前台无法处理的「杂项」。
 *
 * ── 服务请求列表 ──
 *   GET /api/mini/service-orders            我的服务请求（服务端按 mini_user_id 过滤）
 *   POST /api/mini/service-orders/:id/cancel 只能取消 PENDING 的（服务端再判一次）
 *
 * ── 状态处理 ──
 *   · 提交中按钮 disabled + request_id 复用（服务请求重复提交 = 前台收到 5 个送水工单）
 *   · 提交成功后重新拉列表，不本地插一条假记录（会把「已受理」和「待受理」搞混）
 *   · 列表接口未就绪时只降级列表区，提交区仍然可用
 */
const format = require('../../utils/format');
const date = require('../../utils/date');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 服务类型：channel 决定走哪个接口 */
const SERVICES = [
  { key: 'SUPPLIES', label: '补充用品', desc: '毛巾 / 拖鞋 / 洗漱包', channel: 'service' },
  { key: 'DELIVERY', label: '送物到房', desc: '送水 / 冰桶 / 充电器', channel: 'service' },
  { key: 'CLEANING', label: '客房清扫', desc: '打扫 / 换床品', channel: 'service' },
  { key: 'REPAIR', label: '维修报修', desc: '空调 / 水龙头 / 灯', channel: 'service' },
  { key: 'WAKEUP', label: '叫醒服务', desc: '指定时间叫醒', channel: 'wakeup' },
  { key: 'BREAKFAST', label: '早餐购买', desc: '并入房间账单', channel: 'breakfast' },
  { key: 'COMPLAINT', label: '投诉建议', desc: '反馈问题与意见', channel: 'service' },
];

/** 可取消的状态（服务端还会再判一次，这里只是别给必然失败的按钮） */
const CANCELABLE = { PENDING: true, SUBMITTED: true };

function findService(key) {
  for (var i = 0; i < SERVICES.length; i += 1) {
    if (SERVICES[i].key === key) return SERVICES[i];
  }
  return SERVICES[0];
}

Page({
  data: Object.assign(state.baseData(), {
    stayId: '',
    stay: null,

    /* 提交区 */
    services: SERVICES,
    selectedKey: 'SUPPLIES',
    selectedLabel: '补充用品',
    selectedChannel: 'service',
    quantity: 1,
    note: '',
    expectClock: '',
    wakeupClock: '07:00',
    breakfastCount: 1,

    /* 列表区 */
    orders: [],
    ordersLoading: false,
    ordersError: '',
    ordersNotReady: false,
    ordersNotReadyMsg: '',
    /** 只有这一块在提交（与整页 submit 分离，避免互相影响） */
    serviceSubmitting: false,
  }),

  onLoad(options) {
    var o = options || {};
    this.setData({ stayId: o.stayId || o.id || '' });
    this.load();
    this.loadOrders();
  },

  onShow() {
    state.onPageVisible(this);
    state.refreshOnShow(this, 'onShowRefresh');
  },

  onPullDownRefresh() {
    var that = this;
    Promise.all([this.load(), this.loadOrders()]).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  onShowRefresh() {
    this.load();
    this.loadOrders();
  },

  onRetry(e) {
    // data-key="orders" 的重试按钮只刷列表，其余刷在住信息
    var key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key) || 'main';
    if (key === 'orders') return this.loadOrders();
    return state.retry(this, e);
  },

  /* ------------------------------ 在住信息 ------------------------------ */

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
        if (!raw) return { stay: null };
        return {
          stay: {
            roomNo: format.first(raw, ['roomNo', 'room_no'], '—'),
            roomTypeName: format.first(raw, ['roomTypeName', 'room_type_name'], ''),
            guestName: format.maskName(format.first(raw, ['guestName', 'guest_name'], '')),
            checkOutText: format.dateCN(
              format.dateOnly(format.first(raw, ['expectCheckOut', 'expect_check_out', 'checkOutDate'], ''))
            ),
          },
        };
      },
      onError: function (err, d) {
        if (d.code === 'NO_STAY') return { stay: null };
        return {};
      },
    });
  },

  /* ------------------------------ 服务列表 ------------------------------ */

  loadOrders() {
    var that = this;
    this.setData({ ordersLoading: true, ordersError: '', ordersNotReady: false, ordersNotReadyMsg: '' });

    return mini
      .serviceOrders({ limit: 20 })
      .then(function (data) {
        var list = state.pickList(data, ['serviceOrders', 'orders', 'items', 'list']);
        var mapped = list.map(function (it) {
          var row = it || {};
          var status = String(format.first(row, ['status'], '')).toUpperCase();
          return {
            orderId: format.first(row, ['id', 'orderId', 'serviceOrderId'], ''),
            serviceLabel: format.first(row, ['serviceLabel', 'serviceTypeLabel'], format.first(row, ['service_type', 'serviceType'], '服务')),
            statusLabel: format.statusLabel(status, format.first(row, ['statusLabel'], '')),
            chipClass: format.statusChip(status),
            note: format.first(row, ['note', 'remark'], ''),
            createdAtText: format.dateTime(format.first(row, ['createdAt', 'created_at'], '')),
            canCancel: CANCELABLE[status] === true,
          };
        });
        that.setData({ orders: mapped, ordersLoading: false });
      })
      .catch(function (err) {
        var d = state.describeError(err);
        that.setData({
          orders: [],
          ordersLoading: false,
          ordersNotReady: d.notReady,
          ordersNotReadyMsg: d.notReadyMsg,
          ordersError: d.notReady ? '' : d.message,
        });
        return null;
      });
  },

  onCancelOrder(e) {
    var that = this;
    var dataset = e.currentTarget.dataset || {};
    var orderId = dataset.id;
    var label = dataset.label || '服务请求';
    if (!orderId) return;

    state.confirm('取消请求', '确认取消「' + label + '」的请求吗？前台可能已经开始处理。', '确认取消').then(function (ok) {
      if (!ok) return null;
      return state
        .submit(that, {
          key: 'cancel-' + orderId,
          loadingText: '取消中',
          request: function () {
            return mini.cancelServiceOrder(orderId, {});
          },
          onSuccess: function () {
            state.toast('已取消', 'success');
            that.loadOrders();
          },
        })
        .then(function () {
          // 取消失败（例如已受理）时刷新列表，让状态与真实情况对齐
          that.loadOrders();
        });
    });
  },

  /* ------------------------------ 提交表单 ------------------------------ */

  onSelectService(e) {
    var key = e.currentTarget.dataset.key;
    var svc = findService(key);
    this.setData({
      selectedKey: svc.key,
      selectedLabel: svc.label,
      selectedChannel: svc.channel,
    });
    // 换类型说明换了业务，幂等键必须换新
    state.resetRequest(this, 'service');
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
    state.resetRequest(this, 'service');
  },

  onExpectChange(e) {
    this.setData({ expectClock: e.detail.value });
    state.resetRequest(this, 'service');
  },

  onWakeupChange(e) {
    this.setData({ wakeupClock: e.detail.value });
    state.resetRequest(this, 'service');
  },

  onQtyMinus() {
    if (this.data.quantity <= 1) return;
    this.setData({ quantity: this.data.quantity - 1 });
    state.resetRequest(this, 'service');
  },

  onQtyPlus() {
    if (this.data.quantity >= 20) {
      state.toast('单次最多 20 份');
      return;
    }
    this.setData({ quantity: this.data.quantity + 1 });
    state.resetRequest(this, 'service');
  },

  onBreakfastMinus() {
    if (this.data.breakfastCount <= 1) return;
    this.setData({ breakfastCount: this.data.breakfastCount - 1 });
    state.resetRequest(this, 'service');
  },

  onBreakfastPlus() {
    if (this.data.breakfastCount >= 10) {
      state.toast('单次最多 10 份');
      return;
    }
    this.setData({ breakfastCount: this.data.breakfastCount + 1 });
    state.resetRequest(this, 'service');
  },

  onSubmit() {
    var that = this;
    var stay = this.data.stay;
    if (!stay) {
      state.toast('请先确认已办理入住');
      return;
    }

    var channel = this.data.selectedChannel;
    var note = String(this.data.note || '').trim();
    var expectTime = this.data.expectClock ? date.today() + ' ' + this.data.expectClock : '';

    if (channel === 'COMPLAINT' && !note) {
      state.toast('请填写反馈内容');
      return;
    }

    state
      .submit(this, {
        key: 'service',
        flag: 'serviceSubmitting',
        loadingText: '提交中',
        request: function (rid) {
          if (channel === 'wakeup') {
            var wakeDate = date.today();
            return mini.wakeup(that.data.stayId, {
              request_id: rid,
              // 叫醒时间：今天是可选的最早日期，跨天叫醒（次日凌晨）交给前台确认
              wakeupTime: wakeDate + ' ' + that.data.wakeupClock,
              note: note || undefined,
            });
          }
          if (channel === 'breakfast') {
            return mini.breakfast({
              request_id: rid,
              stayId: that.data.stayId,
              count: that.data.breakfastCount,
              remark: note || undefined,
            });
          }
          return mini.stayService(that.data.stayId, {
            request_id: rid,
            service_type: that.data.selectedKey,
            quantity: that.data.quantity,
            expect_time: expectTime || undefined,
            note: note || undefined,
          });
        },
        onSuccess: function () {
          wx.showModal({
            title: '已提交',
            content:
              that.data.selectedLabel + '请求已提交，前台处理后会通过「通知中心」告知。' +
              (channel === 'breakfast' ? '\n早餐费用并入房间账单。' : ''),
            showCancel: false,
            confirmText: '知道了',
          });
          that.setData({ note: '', quantity: 1, breakfastCount: 1 });
          that.loadOrders();
        },
      });
  },

  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  goNotifications() {
    wx.navigateTo({ url: '/pages/notifications/index' });
  },
});
