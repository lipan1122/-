/**
 * 酒店会员端小程序（原生 WXML/WXSS/JS，不依赖任何框架）
 *
 * 启动时做一次「静默登录」：wx.login → 服务端 /api/mini/login → 拿 7 天 token 存本地。
 * 登录失败不阻塞首页 —— 查房量 / 房价不需要登录，只有下单、我的订单、会员中心才需要 token。
 */
const api = require('./utils/api');

App({
  globalData: {
    /** 服务端地址（唯一来源见 utils/api.js 的 BASE_URL） */
    baseUrl: api.BASE_URL,
    token: '',
    /** 登录返回的会员信息：{ hasGuest, guestName } */
    userInfo: null,
  },

  onLaunch() {
    api.ensureLogin()
      .then((data) => {
        this.globalData.token = api.getToken();
        this.globalData.userInfo = data || null;
      })
      .catch((err) => {
        /*
         * 常见原因：
         *   NOT_CONFIGURED —— 管理员还没在系统设置里填 AppID/AppSecret
         *   NETWORK        —— 服务端地址错 / 没配服务器域名 / https 证书问题
         * 这里只打日志，不弹窗打断用户（首页仍可查房）。
         */
        console.warn('[app] 静默登录失败：', err && err.code, err && err.message);
      });
  },

  onShow() {},

  onError(msg) {
    console.error('[app] onError:', msg);
  },
});
