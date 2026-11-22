/**
 * 服务端请求封装（原生小程序，不依赖任何第三方框架）
 *
 * ── 只改一个地方 ──
 * 把下面的 BASE_URL 改成你自己部署的 PMS 地址：
 *   · 必须是 https:// 的已备案域名（微信要求 request 合法域名，不能填 IP / 不能 http）
 *   · 本地调试可以先用 http://127.0.0.1:3100，但要在开发者工具里勾选
 *     「详情 → 本地设置 → 不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」
 *
 * ── 接口约定 ──
 * 服务端统一返回 { ok, data?, error?, code? }：
 *   · ok === true  → resolve(data)
 *   · ok === false → reject(Error)，error.message 可直接展示给用户，error.code 用于分支处理
 *   · HTTP 401     → reject 且 code === 'UNAUTHORIZED'，调用方（requestWithAuth）会重新登录
 *
 * ── token ──
 * 登录一次拿 7 天 token，存 wx.storage（key = pms_mini_token）。
 * 请求时放 `Authorization: Bearer <token>`；PC 端用 Cookie，两边互不影响。
 */

/** 服务端地址：改成你的域名（不要以 / 结尾） */
const BASE_URL = 'http://127.0.0.1:3100';

/** token 存储 key */
const TOKEN_KEY = 'pms_mini_token';

/** 最近一次登录返回的会员信息（避免每次进页面都请求） */
const USER_KEY = 'pms_mini_user';

/** 单次请求超时（毫秒）：微信默认 60s，太久会让用户以为卡死 */
const TIMEOUT = 15000;

/** 正在进行的登录 Promise（多个页面同时 ensureLogin 时只发一次请求） */
var loginPromise = null;

/* ------------------------------- 本地存储 -------------------------------- */

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

function setToken(token) {
  try {
    wx.setStorageSync(TOKEN_KEY, token || '');
  } catch (e) {
    /* 存储失败不影响本次会话使用内存里的 token */
  }
}

function clearToken() {
  try {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(USER_KEY);
  } catch (e) {
    /* ignore */
  }
}

function getUser() {
  try {
    return wx.getStorageSync(USER_KEY) || null;
  } catch (e) {
    return null;
  }
}

function setUser(info) {
  try {
    wx.setStorageSync(USER_KEY, info || null);
  } catch (e) {
    /* ignore */
  }
}

/**
 * 只清会员信息缓存，**保留 token**
 *
 * 注销小程序绑定（POST /api/mini/member/unbind）之后：同一微信的 openid 身份没变，
 * token 依然有效，只是不再关联客史。所以不能调 clearToken（那会把用户踢回登录流程），
 * 但必须清掉缓存的 guestName，否则下单页会继续预填已经解绑的姓名。
 */
function clearUser() {
  try {
    wx.removeStorageSync(USER_KEY);
  } catch (e) {
    /* ignore */
  }
}

/* -------------------------------- 错误 ---------------------------------- */

/** 构造带 code 的错误对象，页面据此区分业务码 */
function makeError(code, message, extra) {
  var err = new Error(message || '请求失败');
  err.code = code || 'ERROR';
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) err[k] = extra[k];
    }
  }
  return err;
}

/** wx.login 的 Promise 版 */
function wxLogin() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: function (res) {
        if (res && res.code) resolve(res.code);
        else reject(makeError('AUTH_FAILED', 'wx.login 没有返回 code，请重试'));
      },
      fail: function () {
        reject(makeError('AUTH_FAILED', 'wx.login 调用失败，请重试'));
      },
    });
  });
}

/**
 * 底层请求
 * @param {string} path   接口路径（以 / 开头），如 '/api/mini/rooms'
 * @param {object} options { method, data, auth, header, timeout }
 * @returns {Promise<any>} resolve 服务端 data 字段
 *
 * `timeout` 是可选覆盖（毫秒）：默认 15s。在住服务里的续住 / 换房要现算远期库存，
 * 比查房慢，调用方（utils/api-mini.js）对写操作传 20s，避免弱网下正常请求被误判超时。
 */
function request(path, options) {
  var opts = options || {};
  var timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : TIMEOUT;
  var header = { 'content-type': 'application/json' };
  if (opts.header) {
    for (var k in opts.header) {
      if (Object.prototype.hasOwnProperty.call(opts.header, k)) header[k] = opts.header[k];
    }
  }
  if (opts.auth) {
    var token = getToken();
    if (token) header.Authorization = 'Bearer ' + token;
  }

  return new Promise(function (resolve, reject) {
    wx.request({
      url: BASE_URL + path,
      method: opts.method || 'GET',
      data: opts.data,
      header: header,
      timeout: timeout,
      success: function (res) {
        var body = res && res.data ? res.data : {};

        if (res.statusCode === 401) {
          reject(makeError('UNAUTHORIZED', body.error || '登录已过期，请重新进入小程序', { statusCode: 401 }));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          /*
           * nonJson 用来区分「路由根本不存在」和「业务失败」：
           *   · 不存在的 Next 路由 → 404 + HTML 错误页 → body 是字符串
           *   · 业务失败（订单不存在 / 无权查看）→ 404 + JSON { ok:false, code, error }
           * 上层（utils/api-mini.js）只把前者降级成「功能准备中」，
           * 后者必须把服务端的中文错误原样展示，否则「订单不存在」会被说成「对接中」。
           */
          var nonJson = !(body && typeof body === 'object');
          reject(
            makeError(body.code || 'HTTP_ERROR', body.error || '服务端返回 HTTP ' + res.statusCode, {
              statusCode: res.statusCode,
              nonJson: nonJson,
            })
          );
          return;
        }
        if (body.ok === false) {
          reject(makeError(body.code || 'BIZ_ERROR', body.error || '操作失败'));
          return;
        }
        resolve(body.data === undefined ? {} : body.data);
      },
      fail: function (err) {
        var detail = err && err.errMsg ? err.errMsg : '未知错误';
        /*
         * wx.request 把「超时」和「连不上」都丢进 fail 回调，但两者对用户是两件事：
         *   request:fail timeout             → 网络慢，重试就好
         *   request:fail ssl hand shake ...  → 域名白名单 / 证书 / BASE_URL 配错了
         * 所以超时单独归一成 TIMEOUT，页面据此给「重试」而不是「检查服务器地址」。
         */
        if (/timeout/i.test(detail)) {
          reject(makeError('TIMEOUT', '网络超时，请检查网络后重试'));
          return;
        }
        reject(
          makeError(
            'NETWORK',
            '网络请求失败：' + detail + '\n请检查 BASE_URL 是否正确、服务端是否启动、服务器域名白名单是否已配置'
          )
        );
      },
    });
  });
}

/**
 * 登录：wx.login 拿 code → 换 token
 *
 * 未配置 AppID/AppSecret 时服务端返回 code = NOT_CONFIGURED，
 * 这里的 error.message 就是给管理员看的提示（「小程序未配置…」），直接展示即可。
 */
function login() {
  return wxLogin()
    .then(function (code) {
      return request('/api/mini/login', { method: 'POST', data: { code: code } });
    })
    .then(function (data) {
      if (!data || !data.token) throw makeError('AUTH_FAILED', '登录失败：服务端没有返回 token');
      setToken(data.token);
      setUser({ hasGuest: !!data.hasGuest, guestName: data.guestName || '' });
      return data;
    });
}

/**
 * 确保已登录：本地有 token 就直接用（服务端会校验有效期），
 * 没有就静默登录一次。多个页面同时调用只会发一次请求。
 */
function ensureLogin() {
  var token = getToken();
  if (token) return Promise.resolve(getUser() || {});
  if (loginPromise) return loginPromise;

  loginPromise = login().then(
    function (data) {
      loginPromise = null;
      return data;
    },
    function (err) {
      loginPromise = null;
      throw err;
    }
  );
  return loginPromise;
}

/**
 * 需要登录的请求
 *
 * token 过期（401）时自动重新登录并重试**一次**，但只对 GET 重试：
 * POST（下单 / 绑定）重试可能造成重复下单，宁可让用户看到「请重新提交」。
 */
function requestWithAuth(path, options) {
  var opts = options || {};
  var method = (opts.method || 'GET').toUpperCase();

  return ensureLogin().then(function () {
    return request(path, { method: method, data: opts.data, auth: true }).catch(function (err) {
      if (err.code !== 'UNAUTHORIZED') throw err;
      clearToken();
      return ensureLogin().then(function () {
        if (method !== 'GET') {
          throw makeError('UNAUTHORIZED', '登录状态已刷新，请重新提交本次操作');
        }
        return request(path, { method: method, data: opts.data, auth: true });
      });
    });
  });
}

module.exports = {
  BASE_URL: BASE_URL,
  request: request,
  requestWithAuth: requestWithAuth,
  ensureLogin: ensureLogin,
  login: login,
  getToken: getToken,
  clearToken: clearToken,
  clearUser: clearUser,
  getUser: getUser,
};
