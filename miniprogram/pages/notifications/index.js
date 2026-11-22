/**
 * 通知中心（清单第八节「通知中心」/ 第二节第 12 条）
 *
 * 打开方式：/pages/notifications/index（会员中心 / 在住服务 / 客房服务）
 *
 * ── 数据来源 ──
 *   GET  /api/mini/notifications        我的通知（服务端只按 mini_user_id 下发，不按手机号群发）
 *   POST /api/mini/notifications/read   { ids: [1,2] } 或 { all: true }
 *
 * ── 为什么通知要单独一页而不是塞进消息列表 ──
 *   清单要求覆盖：预订成功 / 取消 / 确认 / 已排房 / 入住提醒 / 续住结果 / 换房结果 /
 *   服务请求受理与完成 / 退房完成 / 发票开具。这些通知都带「下一步动作」，
 *   点进去要能到对应页面（订单详情 / 在住服务 / 服务列表 / 发票）。
 *   所以每条通知读的是 refType + refId，而不是一段纯文本。
 *
 * ── 状态处理 ──
 *   · 未读数显示在标题栏右侧的 chip 上；点「全部已读」后本地先把 read 置 true（避免等接口回来）
 *   · 接口未就绪 → 整页降级「通知功能准备中」，不显示假通知
 *   · 单条已读上报失败不弹错（下次进来会重新上报），但会保留未读状态
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 通知类型 → 中文兜底（服务端有 typeLabel 时优先用服务端的） */
const TYPE_LABEL = {
  BOOKING_CREATED: '预订成功',
  BOOKING_CANCELLED: '预订取消',
  BOOKING_CONFIRMED: '订单确认',
  ROOM_ASSIGNED: '房间已分配',
  CHECKIN_REMINDER: '入住提醒',
  CHECKOUT_DONE: '退房完成',
  EXTEND_RESULT: '续住结果',
  CHANGE_ROOM_RESULT: '换房结果',
  SERVICE_ACCEPTED: '服务已受理',
  SERVICE_DONE: '服务已完成',
  INVOICE_ISSUED: '发票开具',
};

/** 通知类型 → 点击后去哪（refType 优先，其次按 type 前缀猜） */
function targetOf(note) {
  var refType = String(format.first(note, ['refType', 'ref_type'], '')).toUpperCase();
  var refId = format.first(note, ['refId', 'ref_id', 'bizId'], '');
  var type = String(format.first(note, ['type'], '')).toUpperCase();

  if (refType === 'BOOKING' || type.indexOf('BOOKING') === 0 || type === 'ROOM_ASSIGNED' || type === 'CHECKIN_REMINDER') {
    return refId
      ? '/pages/order-detail/index?bookingId=' + encodeURIComponent(refId)
      : '/pages/orders/orders';
  }
  if (refType === 'STAY' || type.indexOf('EXTEND') === 0 || type.indexOf('CHANGE_ROOM') === 0 || type === 'CHECKOUT_DONE') {
    return refId ? '/pages/in-stay/index' : '/pages/in-stay/index';
  }
  if (refType === 'SERVICE' || type.indexOf('SERVICE') === 0) {
    return '/pages/services/index';
  }
  if (refType === 'INVOICE' || type.indexOf('INVOICE') === 0) {
    return '/pages/invoices/index';
  }
  return '';
}

Page({
  data: Object.assign(state.baseData(), {
    notifications: [],
    unreadCount: 0,
    marking: false,
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
        return mini.notifications({ limit: 50 });
      },
      onSuccess: function (data) {
        var list = state.pickList(data, ['notifications', 'items', 'list']);
        var mapped = list.map(function (it) {
          var note = it || {};
          var type = String(format.first(note, ['type'], '')).toUpperCase();
          var read = note.read === true || note.isRead === true || note.status === 'READ';
          return {
            notificationId: format.first(note, ['id', 'notificationId'], ''),
            title: format.first(note, ['title'], TYPE_LABEL[type] || '通知'),
            content: format.first(note, ['content', 'body', 'message'], ''),
            typeLabel: format.first(note, ['typeLabel'], TYPE_LABEL[type] || ''),
            read: read,
            createdAtText: format.dateTime(format.first(note, ['createdAt', 'created_at', 'time'], '')),
            url: targetOf(note),
            expanded: false,
          };
        });
        var unread = 0;
        for (var i = 0; i < mapped.length; i += 1) if (!mapped[i].read) unread += 1;
        var serverUnread = format.first(data || {}, ['unreadCount', 'unread'], null);
        return {
          notifications: mapped,
          unreadCount: serverUnread === null ? unread : format.int(serverUnread),
        };
      },
    });
  },

  /** 点一条：展开正文 + 上报已读 + 有下一步就跳 */
  onTapNote(e) {
    var that = this;
    var index = Number(e.currentTarget.dataset.index);
    var list = this.data.notifications;
    if (!(index >= 0) || !list[index]) return;
    var note = list[index];
    var patch = {};
    patch['notifications[' + index + '].expanded'] = !note.expanded;
    this.setData(patch);

    if (note.read) return;

    // 本地先置已读（不等接口），失败时下次拉取会重新显示未读
    var p2 = {};
    p2['notifications[' + index + '].read'] = true;
    p2.unreadCount = Math.max(0, this.data.unreadCount - 1);
    this.setData(p2);

    if (!note.notificationId) return;
    mini.readNotifications({ ids: [note.notificationId] }).catch(function () {
      // 静默：未读状态以服务端为准，下次进入会重新同步
    });
  },

  /** 通知里的「去处理」按钮 */
  onGo(e) {
    var url = e.currentTarget.dataset.url;
    if (!url) return;
    if (url === '/pages/orders/orders') {
      wx.switchTab({ url: url });
      return;
    }
    wx.navigateTo({ url: url });
  },

  onMarkAll() {
    var that = this;
    if (this.data.unreadCount === 0 || this.data.marking) return;

    this.setData({ marking: true });
    mini
      .readNotifications({ all: true })
      .then(function () {
        var list = that.data.notifications.map(function (n) {
          return Object.assign({}, n, { read: true });
        });
        that.setData({ notifications: list, unreadCount: 0, marking: false });
        state.toast('已全部标为已读', 'success');
      })
      .catch(function (err) {
        var d = state.describeError(err);
        that.setData({ marking: false, notReady: d.notReady, notReadyMsg: d.notReadyMsg, error: d.notReady ? '' : d.message });
      });
  },

  goMember() {
    wx.switchTab({ url: '/pages/member/member' });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },
});
