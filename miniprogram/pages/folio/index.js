/**
 * 当前账单（清单第八节「当前账单」）
 *
 * 打开方式：/pages/folio/index?stayId=12（在住页 / 服务入口跳进来）
 *   没带 stayId 时先调 GET /api/mini/stays/current 取当前在住，再查账单 ——
 *   这样从「我的订单」或分享卡片直接进也不会白屏。
 *
 * 数据来源：GET /api/mini/stays/:id/folio
 *   → { stayId, roomNo, guestName(脱敏), items: [
 *         { date, type, typeLabel, description, quantity, unitPrice, amount } ],
 *       totalCharge, totalPaid, balance, depositAmount, depositStatus }
 *
 * ── 三条约定 ──
 *   1. 金额一律用服务端字段（totalCharge / totalPaid / balance）；明细行的 amount 只展示，
 *      页面不做「自己加一遍合计」再和余额对比 —— 那一定会因为四舍五入或漏项对不上。
 *   2. 明细为空显示「暂无消费明细」，不显示一张 ¥0.00 的空账单（容易让人以为系统坏了）。
 *   3. stayId 只是定位：服务端必须校验该 stay 属于当前用户，否则改 URL 就能读别人账单。
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 账单类型 → 中文（服务端有 typeLabel 时优先用服务端的） */
const TYPE_LABEL = {
  ROOM: '房费',
  FOOD: '餐饮',
  BREAKFAST: '早餐',
  SHOP: '商品',
  SERVICE: '服务',
  RENTAL: '租赁',
  DEPOSIT: '押金',
  PAYMENT: '付款',
  REFUND: '退款',
  OTHER: '其他',
};

function typeLabel(item) {
  var given = format.first(item, ['typeLabel', 'categoryLabel'], '');
  if (given) return given;
  var key = String(format.first(item, ['type', 'category'], '')).toUpperCase();
  return TYPE_LABEL[key] || (key || '消费');
}

Page({
  data: Object.assign(state.baseData(), {
    stayId: '',
    stay: null,
    items: [],
    summary: null,
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
        // 没有 stayId：先取当前在住（服务端只回本人的）
        if (that.data.stayId) return mini.folio(that.data.stayId);
        return mini.currentStay().then(function (stayRes) {
          var stay = state.pickObject(stayRes, ['stay', 'current', 'inhouse'], ['stayId', 'stay_id']);
          var stayId = stay ? format.first(stay, ['stayId', 'stay_id', 'id'], '') : '';
          if (!stayId) {
            var err = new Error('当前没有在住订单，无法查看账单');
            err.code = 'NO_STAY';
            throw err;
          }
          that.setData({ stayId: String(stayId) });
          return mini.folio(stayId);
        });
      },
      onSuccess: function (data) {
        var d = state.pickObject(data, ['folio', 'bill', 'detail'], ['items', 'totalCharge']);
        if (!d) return { items: [], summary: null };

        var list = Array.isArray(d.items) ? d.items : Array.isArray(d.details) ? d.details : [];
        var items = list.map(function (it) {
          var row = it || {};
          var amount = format.first(row, ['amount', 'total', 'money'], 0);
          return {
            date: format.dateOnly(format.first(row, ['date', 'bizDate', 'createdAt'], '')),
            typeLabel: typeLabel(row),
            description: format.first(row, ['description', 'name', 'itemName'], '消费'),
            quantityText: format.first(row, ['quantityText'], row.quantity !== undefined ? '×' + format.int(row.quantity) : ''),
            unitPriceText: row.unitPrice !== undefined ? '¥' + format.money(row.unitPrice) : '',
            amountText: format.money(amount),
            /** 负数 = 付款 / 冲账，绿色显示，避免客人以为被多收 */
            isCredit: format.num(amount) < 0,
          };
        });

        var totalCharge = format.first(d, ['totalCharge', 'total'], null);
        var totalPaid = format.first(d, ['totalPaid', 'paid'], null);
        var balance = format.first(d, ['balance', 'dueAmount'], null);

        return {
          items: items,
          stay: {
            roomNo: format.first(d, ['roomNo', 'room_no'], format.first(state.pickObject(data, ['stay', 'booking']) || {}, ['roomNo'], '')),
            guestName: format.maskName(format.first(d, ['guestName', 'guest_name'], '')),
            checkInText: format.dateTime(format.first(d, ['checkInTime', 'check_in_time'], '')),
            checkOutText: format.dateCN(format.dateOnly(format.first(d, ['expectCheckOut', 'expect_check_out'], ''))),
            statusLabel: format.statusLabel(format.first(d, ['status'], ''), format.first(d, ['statusLabel'], '在住')),
          },
          summary:
            totalCharge === null && balance === null
              ? null
              : {
                  totalChargeText: totalCharge === null ? '—' : format.money(totalCharge),
                  totalPaidText: totalPaid === null ? '—' : format.money(totalPaid),
                  balanceText: balance === null ? '—' : format.money(balance),
                  balanceNegative: format.num(balance) < 0,
                  depositText: format.moneyOrDash(format.first(d, ['depositAmount', 'deposit'], null)),
                  depositStatus: format.first(d, ['depositStatusLabel'], format.first(d, ['depositStatus'], '')),
                },
        };
      },
      onError: function (err, d) {
        if (d.code === 'NO_STAY') return { items: [], summary: null };
        return {};
      },
    });
  },

  /** 账单明细截图/转发都不合适：提示到前台核对（也是隐私说明的一部分） */
  onTip() {
    wx.showModal({
      title: '账单说明',
      content:
        '账单金额由酒店系统实时计算，以退房时前台出具的结算单为准。\n如对某一笔消费有疑问，请点「联系酒店」转前台核对。',
      showCancel: false,
    });
  },

  goServices() {
    wx.navigateTo({ url: '/pages/services/index?stayId=' + encodeURIComponent(this.data.stayId) });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },

  goInvoices() {
    wx.navigateTo({ url: '/pages/invoices/index?stayId=' + encodeURIComponent(this.data.stayId) });
  },
});
