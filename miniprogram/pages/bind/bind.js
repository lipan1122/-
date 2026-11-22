/**
 * 绑定手机号（整改清单 P0-11）
 *
 * ── 接口变化 ──
 * 旧：POST /api/mini/bind { mobile, guestName }
 *   服务端只按手机号匹配酒店既有客史，命中就绑定 —— 任何人输入别人手机号
 *   即可读到对方的储值余额与全部订单（越权）。
 * 新：POST /api/mini/bind { mobile, guestName, bookingNo?, roomNo? }
 *   必须再提供「只有本人/前台才知道」的单据信息：
 *     · 入住单号（预订号，通常 BK 开头，可在「我的订单」里看到）
 *     · 或 在住房间号（房卡上的号码）
 *   服务端会核对「该单据登记的 mobile === 本次填写的 mobile」，三项一致才绑定。
 *
 * ── 为什么用弹窗收集单号，而不是在页面上加输入框 ──
 * 本批只授权改 `bind.js`（`bind.wxml` 不在写作用域内），
 * 所以用 `wx.showModal` 的 editable 模式（基础库 2.17.1+）收集单号。
 * 若后续允许改 wxml，建议把单号做成正式输入框（体验更好、可校验格式）。
 *
 * ── 绑定失败时为什么会看到具体原因 ──
 * 服务端返回的是「可指导下一步」的文案（例如「预订号是否完整（BK 开头）」
 * 「换过手机号请到前台更新」），页面直接展示 error.message，不做二次包装 ——
 * 笼统的「绑定失败」只会让客人反复重试或直接放弃。
 */
const api = require('../../utils/api');

/** 判断是否像预订号：BK 开头 */
function looksLikeBookingNo(v) {
  return /^bk/i.test(v);
}

/** 纯数字：可能是房间号，也可能是没抄 BK 前缀的预订号 —— 两个字段都带上，服务端依次尝试 */
function isPureDigits(v) {
  return /^\d+$/.test(v);
}

Page({
  data: {
    guestName: '',
    mobile: '',
    submitting: false,
    error: '',
    tip: '',
    /** 本次填写的入住单号 / 房间号（只在当前页面生命周期内使用，不写 storage） */
    proof: '',
  },

  onLoad() {
    // 已登录过的姓名预填，减少一次输入（手机号不预填，要求用户自己确认）
    var user = api.getUser() || {};
    if (user.guestName) this.setData({ guestName: user.guestName });
  },

  onNameInput(e) {
    this.setData({ guestName: e.detail.value, error: '' });
  },

  onMobileInput(e) {
    this.setData({ mobile: e.detail.value, error: '' });
  },

  /**
   * 让客人填写「入住单号 / 房间号」
   *
   * 用 Promise 包一层，onSubmit 里链式调用；用户取消或留空都 reject，
   * 由调用方展示 error（不静默返回，否则用户按了按钮像没反应）。
   */
  askProof() {
    var that = this;
    return new Promise(function (resolve, reject) {
      wx.showModal({
        title: '验证入住信息',
        content: '为了确认手机号是本人的，请填写入住单号（BK 开头）或房间号',
        editable: true,
        placeholderText: '如 BK3012 或 8001',
        confirmText: '确定',
        cancelText: '取消',
        success: function (res) {
          if (!res.confirm) {
            reject(new Error('已取消，需要填写入住单号或房间号才能绑定'));
            return;
          }
          var proof = (res.content || '').trim();
          if (!proof) {
            reject(new Error('请填写入住时登记的房间号或入住单号（预订号通常以 BK 开头）'));
            return;
          }
          that.setData({ proof: proof });
          resolve(proof);
        },
        fail: function () {
          reject(new Error('无法打开验证窗口，请升级微信后重试，或到酒店前台绑定'));
        },
      });
    });
  },

  /** 组装绑定入参：按填写内容推断是预订号还是房间号 */
  buildPayload(mobile, guestName, proof) {
    var payload = { mobile: mobile, guestName: guestName };
    if (looksLikeBookingNo(proof)) {
      // 明确是预订号：只传 bookingNo，服务端的错误文案才会聚焦「预订号」
      payload.bookingNo = proof.toUpperCase();
    } else if (isPureDigits(proof)) {
      // 纯数字：可能是房间号，也可能是省略 BK 的预订号 → 两个字段都传，服务端依次校验
      payload.bookingNo = proof;
      payload.roomNo = proof;
    } else {
      payload.bookingNo = proof;
    }
    return payload;
  },

  onSubmit() {
    if (this.data.submitting) return;
    var that = this;

    var guestName = (this.data.guestName || '').trim();
    var mobile = (this.data.mobile || '').trim();

    if (!guestName) {
      this.setData({ error: '请填写姓名' });
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      this.setData({ error: '请填写正确的 11 位手机号（入住登记时预留的号码）' });
      return;
    }

    this.setData({ submitting: true, error: '', tip: '' });

    /*
     * 第一次提交要收集单号；已经填过（例如上一次校验失败，服务端提示了具体原因）
     * 就直接复用，免得用户每次重试都重新输一遍。
     */
    var proofPromise = this.data.proof
      ? Promise.resolve(this.data.proof)
      : this.askProof();

    proofPromise
      .then(function (proof) {
        wx.showLoading({ title: '绑定中', mask: true });
        return api
          .requestWithAuth('/api/mini/bind', {
            method: 'POST',
            data: that.buildPayload(mobile, guestName, proof),
          })
          .then(function (data) {
            wx.hideLoading();
            that.setData({
              submitting: false,
              proof: '',
              // 服务端只回打码姓名，不再回 matched / VIP 等级真值（防止响应体变成查询接口）
              tip: '你好，' + (data.guestName || guestName) + '，已关联酒店会员档案',
            });
            wx.showToast({ title: '绑定成功', icon: 'success' });
            // 1.5 秒后返回，让用户看到提示
            setTimeout(function () {
              wx.navigateBack({
                fail: function () {
                  wx.switchTab({ url: '/pages/member/member' });
                },
              });
            }, 1500);
          });
      })
      .catch(function (err) {
        wx.hideLoading();
        // 校验类失败不保留单号：让用户重新确认后再填（避免拿错值反复提交）
        var code = err && err.code;
        var keepProof = code === 'RATE_LIMITED' || code === 'BIND_LOCKED';
        that.setData({
          submitting: false,
          proof: keepProof ? that.data.proof : '',
          error: (err && err.message) || '绑定失败，请稍后重试或到酒店前台办理',
        });
      });
  },
});
