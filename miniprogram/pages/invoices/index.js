/**
 * 发票列表 + 申请开票（清单第八节「发票」）
 *
 * 打开方式：/pages/invoices/index?bookingId=3 或 ?stayId=12（从订单详情 / 账单 / 会员中心进）
 *
 * ── 数据来源 ──
 *   GET  /api/mini/invoices    我的发票（服务端按 mini_user_id / guest_id 过滤）
 *   POST /api/mini/invoices    申请开票 { request_id, type, titleType, title, taxNo, email, bookingId?, stayId?, amount? }
 *
 * ── 关键约定 ──
 *   1. 开票金额不接受客户端输入：页面只展示关联订单/账单的金额，服务端按实际消费开票。
 *      让客人自己填金额 = 直接送一张虚开发票的入口。
 *   2. 税号（单位抬头）必填，个人抬头不需要 —— 这条校验放前端只是省一次往返，
 *      服务端必须再校验（发票开错要红冲，很麻烦）。
 *   3. 接口未就绪时列表与表单都降级，提示「到店/前台开具」，不显示假发票。
 */
const format = require('../../utils/format');
const mini = require('../../utils/api-mini');
const state = require('../../utils/page-state');

/** 发票类型 */
const TYPES = [
  { value: 'ELECTRONIC', label: '电子发票' },
  { value: 'PAPER', label: '纸质发票' },
];

/** 抬头类型 */
const TITLE_TYPES = [
  { value: 'PERSONAL', label: '个人' },
  { value: 'COMPANY', label: '单位' },
];

Page({
  data: Object.assign(state.baseData(), {
    bookingId: '',
    stayId: '',

    invoices: [],
    invoicesReady: false,

    /* 表单 */
    showForm: false,
    types: TYPES,
    typeIndex: 0,
    titleTypes: TITLE_TYPES,
    titleTypeIndex: 1,
    title: '',
    taxNo: '',
    email: '',
    /** 申请金额（只展示，不提交客户端金额） */
    amountText: '',
    submitting: false,
  }),

  onLoad(options) {
    var o = options || {};
    this.setData({ bookingId: o.bookingId || '', stayId: o.stayId || '' });
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
        return mini.invoices(that.data.bookingId ? { bookingId: that.data.bookingId } : undefined);
      },
      onSuccess: function (data) {
        var list = state.pickList(data, ['invoices', 'items', 'list']);
        var mapped = list.map(function (it) {
          var row = it || {};
          var status = String(format.first(row, ['status'], '')).toUpperCase();
          return {
            invoiceId: format.first(row, ['id', 'invoiceId'], ''),
            invoiceNo: format.first(row, ['invoiceNo', 'invoice_no'], ''),
            title: format.first(row, ['title', 'buyerName'], '—'),
            amountText: format.moneyOrDash(format.first(row, ['amount', 'totalAmount'], null)),
            typeLabel: format.first(row, ['typeLabel'], format.first(row, ['type'], '')),
            statusLabel: format.statusLabel(status, format.first(row, ['statusLabel'], '')),
            chipClass: format.statusChip(status),
            createdAtText: format.dateTime(format.first(row, ['createdAt', 'created_at'], '')),
            remark: format.first(row, ['remark', 'note'], ''),
          };
        });
        // 关联订单金额（用于表单里说明「本次可开票金额」）
        var amountRaw = format.first(data || {}, ['availableAmount', 'amount'], null);
        return {
          invoices: mapped,
          invoicesReady: true,
          amountText: amountRaw === null ? '' : format.money(amountRaw),
        };
      },
      onError: function (err, d) {
        if (d.notReady) return { invoices: [], invoicesReady: false };
        return { invoices: [] };
      },
    });
  },

  /* ------------------------------ 表单 ------------------------------ */

  onToggleForm() {
    this.setData({ showForm: !this.data.showForm, error: '' });
  },

  onTypeChange(e) {
    this.setData({ typeIndex: Number(e.detail.value) || 0 });
    state.resetRequest(this, 'invoice');
  },

  onTitleTypeChange(e) {
    var idx = Number(e.detail.value) || 0;
    var patch = { titleTypeIndex: idx };
    // 个人抬头不需要税号，切过去时清空，避免把上次的税号带进去
    if (TITLE_TYPES[idx].value === 'PERSONAL') patch.taxNo = '';
    this.setData(patch);
    state.resetRequest(this, 'invoice');
  },

  onInput(e) {
    var field = e.currentTarget.dataset.field;
    if (!field) return;
    var patch = {};
    patch[field] = e.detail.value;
    this.setData(patch);
    state.resetRequest(this, 'invoice');
  },

  onSubmit() {
    var that = this;
    var title = String(this.data.title || '').trim();
    var taxNo = String(this.data.taxNo || '').trim();
    var email = String(this.data.email || '').trim();
    var type = TYPES[this.data.typeIndex].value;
    var titleType = TITLE_TYPES[this.data.titleTypeIndex].value;

    if (!title) {
      state.toast('请填写发票抬头');
      return;
    }
    if (titleType === 'COMPANY' && !taxNo) {
      state.toast('单位抬头需要填写纳税人识别号');
      return;
    }
    if (type === 'ELECTRONIC' && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      state.toast('邮箱格式不正确');
      return;
    }

    state
      .submit(this, {
        key: 'invoice',
        flag: 'submitting',
        loadingText: '提交中',
        request: function (rid) {
          return mini.createInvoice({
            request_id: rid,
            type: type,
            titleType: titleType,
            title: title,
            taxNo: taxNo || undefined,
            email: email || undefined,
            bookingId: that.data.bookingId || undefined,
            stayId: that.data.stayId || undefined,
          });
        },
        onSuccess: function () {
          wx.showModal({
            title: '开票申请已提交',
            content: '前台开具后可在本页查看状态；电子发票会发送到你填写的邮箱（如果已配置邮件服务）。',
            showCancel: false,
            confirmText: '知道了',
          });
          that.setData({ showForm: false, title: '', taxNo: '', email: '' });
          that.load();
        },
      });
  },

  /** 复制发票号码（客人常要贴到报销系统） */
  onCopyNo(e) {
    var no = e.currentTarget.dataset.no;
    if (!no) return;
    wx.setClipboardData({ data: String(no) });
  },

  goContact() {
    wx.navigateTo({ url: '/pages/contact/index' });
  },

  goInStay() {
    wx.navigateTo({ url: '/pages/in-stay/index' });
  },
});
