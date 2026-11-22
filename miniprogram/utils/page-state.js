/**
 * 小程序页面统一状态机（加载 / 空 / 失败 / 未就绪 / 登录过期 / 防重复提交 / 返回刷新）
 *
 * ── 为什么要有这一层 ──
 * 清单第 472-484 行要求**每个**页面都处理：加载状态、空状态、网络失败、登录过期、
 * 房量变化、重复提交、返回后刷新、订单状态变化、日期金额格式、隐私说明、用户协议。
 * 13 个页面各写一遍，一定会漏（漏的通常是「登录过期」和「重复提交」这两条，
 * 因为它们不在正常路径上，平时测不出来，出问题就是重复下单 / 卡死）。
 * 所以这里做成 4 个纯函数，页面只写「怎么发请求」和「成功后 setData 什么」。
 *
 * ── 状态字段约定（页面 data 里必须有）──
 *   loading     正在加载（骨架/文案）
 *   error       要展示给用户的错误文案（'' = 无错误）
 *   errorCode   业务码，页面可据此给不同引导
 *   notReady    true = 接口还没上线 → 显示「功能准备中」而不是报错
 *   notReadyMsg 未就绪文案（服务端或默认文案）
 *   submitting  提交中（按钮 disabled）
 *
 * ── 幂等 request_id ──
 * submit() 会为每个 key 生成一次 request_id 并**缓存到成功为止**：
 *   · 网络超时 → 用户再点一次「提交」→ 复用同一个 request_id → 服务端命中幂等，不会重复建单
 *   · 成功后清掉 → 下一次操作是新单
 *   · 用户改了表单内容 → 页面调 resetRequest() 换新 id（内容变了就不是同一次提交）
 */

const api = require('./api');
const mini = require('./api-mini');

/** request_id 前缀（服务端只当作不透明字符串） */
const REQ_PREFIX = 'mini';

/** 登录过期弹窗的去重窗口（毫秒）：一个页面并发 3 个请求同时 401 时只弹一次 */
const AUTH_PROMPT_GAP = 5000;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 页面初始 data：页面用 Object.assign(state.baseData(), { ...页面自己的字段 })
 */
function baseData() {
  return {
    loading: true,
    error: '',
    errorCode: '',
    notReady: false,
    notReadyMsg: '',
    authExpired: false,
    submitting: false,
    /** 是否已完成过一次加载（空状态判断用：没加载完不要闪「暂无数据」） */
    loaded: false,
  };
}

/**
 * 错误归一化：把底层 Error 翻译成页面能直接用的 4 个判断
 *
 * 注意 NOT_CONFIGURED（小程序未配置 AppID）与 NOT_READY（接口没上线）都是
 * 「还没准备好」，但文案必须不同：前者是管理员要去系统设置里填 AppID，
 * 让客人看到「功能准备中」毫无意义。
 */
function describeError(err) {
  var code = (err && err.code) || 'ERROR';
  var message = (err && err.message) || '加载失败，请重试';

  if (code === 'UNAUTHORIZED') {
    return { code: code, message: '登录已过期，请重新登录', notReady: false, notReadyMsg: '', authExpired: true };
  }
  if (code === 'NOT_CONFIGURED') {
    return {
      code: code,
      message: message,
      notReady: true,
      notReadyMsg: '小程序还没有完成配置（AppID / AppSecret），请联系酒店管理员',
      authExpired: false,
    };
  }
  if (code === 'NOT_READY' || (err && err.notReady)) {
    return { code: code, message: message, notReady: true, notReadyMsg: message, authExpired: false };
  }
  if (code === 'TIMEOUT') {
    return { code: code, message: '网络超时，请检查网络后重试', notReady: false, notReadyMsg: '', authExpired: false };
  }
  return { code: code, message: message, notReady: false, notReadyMsg: '', authExpired: false };
}

/** 统一的 toast（小程序原生 toast 文案过长会截断，这里截到 20 字内） */
function toast(msg, icon) {
  var text = String(msg || '').trim();
  if (!text) return;
  wx.showToast({ title: text.length > 20 ? text.slice(0, 19) + '…' : text, icon: icon || 'none' });
}

/**
 * 统一的读请求执行器
 *
 * @param {object} page Page 实例
 * @param {object} opts
 *   @param {function} request         必填，返回 Promise（通常 () => mini.hotel()）
 *   @param {function} [onSuccess]     (data) => patch   返回要 setData 的字段
 *   @param {function} [onError]       (err, d) => patch 返回额外的 setData 字段
 *   @param {string}  [key]            多路请求的标识（重试按钮带 data-key），默认 'main'
 *   @param {function} [emptyWhen]     (data) => boolean   true 视为空状态
 * @returns {Promise<any|null>} 失败 resolve(null)，**不 reject** —— 让 onPullDownRefresh 的
 *                              .then(stopPullDownRefresh) 一定会执行
 */
function load(page, opts) {
  var o = opts || {};
  var key = o.key || 'main';

  // 记住 loader：重试按钮、登录后重登都用它，页面不用自己再传一遍参数
  page.__loaders = page.__loaders || {};
  page.__loaders[key] = function () {
    return load(page, o);
  };
  page.__reload = function () {
    return page.__loaders[key]();
  };

  page.setData({ loading: true, error: '', errorCode: '', notReady: false, notReadyMsg: '' });

  return Promise.resolve()
    .then(function () {
      return o.request();
    })
    .then(function (data) {
      var patch = {};
      if (o.onSuccess) patch = o.onSuccess(data) || {};
      var next = Object.assign(
        { loading: false, error: '', errorCode: '', notReady: false, notReadyMsg: '', loaded: true },
        patch
      );
      page.setData(next);
      return data;
    })
    .catch(function (err) {
      var d = describeError(err);
      var extra = o.onError ? o.onError(err, d) || {} : {};
      page.setData(
        Object.assign(
          {
            loading: false,
            loaded: true,
            authExpired: d.authExpired,
            notReady: d.notReady,
            notReadyMsg: d.notReadyMsg || d.message,
            error: d.notReady ? '' : d.message,
            errorCode: d.code,
          },
          extra
        )
      );
      if (d.authExpired) handleAuthExpired(page, d);
      return null;
    });
}

/**
 * 重试按钮
 *
 * WXML: <button bindtap="onRetry" data-key="main">重试</button>
 * 页面里写 onRetry(e) { state.retry(this, e); } 即可，不用自己知道 key。
 */
function retry(page, e) {
  var ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
  var key = ds.key || 'main';
  var loader = page.__loaders && page.__loaders[key];
  if (!loader) {
    // 还没加载过（例如在 onLoad 之前点了重试）：退化成整页刷新
    if (typeof page.onRetryFallback === 'function') page.onRetryFallback();
    return Promise.resolve(null);
  }
  return loader();
}

/**
 * 登录过期处理：清 token → 弹窗让用户选「重新登录」或「去绑定」
 *
 * 为什么要弹窗而不是直接跳 bind 页：
 *   客人可能只是 7 天 token 自然过期，重新静默登录就能继续；
 *   直接跳「绑定手机号」会让老用户以为自己的绑定丢了。
 */
function handleAuthExpired(page, d) {
  var now = Date.now();
  if (page.__authPromptAt && now - page.__authPromptAt < AUTH_PROMPT_GAP) return;
  page.__authPromptAt = now;

  api.clearToken();

  wx.showModal({
    title: '登录已过期',
    content: '需要重新登录后才能继续。如果一直失败，可以到「绑定手机号」确认身份。',
    confirmText: '重新登录',
    cancelText: '去绑定',
    success: function (res) {
      if (res.confirm) {
        wx.showLoading({ title: '重新登录中', mask: true });
        api
          .ensureLogin()
          .then(function () {
            wx.hideLoading();
            toast('已重新登录', 'success');
            if (page.__reload) return page.__reload();
            return null;
          })
          .catch(function (err) {
            wx.hideLoading();
            page.setData({
              loading: false,
              error: (err && err.message) || '登录失败，请稍后重试',
              errorCode: (err && err.code) || 'AUTH_FAILED',
            });
          });
        return;
      }
      wx.navigateTo({ url: '/pages/bind/bind' });
    },
  });
}

/** 生成 request_id（对服务端是不透明字符串；同一操作复用同一个） */
function genRequestId(key) {
  var rand = Math.random().toString(36).slice(2, 10);
  return REQ_PREFIX + '-' + String(key || 'req') + '-' + Date.now().toString(36) + '-' + rand;
}

/** 取得（或创建）某操作的 request_id，成功前一直复用 */
function requestId(page, key) {
  page.__reqIds = page.__reqIds || {};
  var k = key || 'submit';
  if (!page.__reqIds[k]) page.__reqIds[k] = genRequestId(k);
  return page.__reqIds[k];
}

/** 用户改了表单内容：换一个新的 request_id（内容变了，幂等键也必须变） */
function resetRequest(page, key) {
  page.__reqIds = page.__reqIds || {};
  delete page.__reqIds[key || 'submit'];
}

/**
 * 统一的写请求执行器（防重复提交 + 幂等键复用 + 错误展示）
 *
 * @param {object} page
 * @param {object} opts
 *   @param {function} request   (requestId) => Promise
 *   @param {function} [onSuccess] (data, requestId) => void
 *   @param {function} [onError]   (err, d) => void   业务侧额外处理（如保留表单）
 *   @param {string}  [key]        幂等键标识，默认 'submit'
 *   @param {string}  [flag]       提交中标记字段名，默认 'submitting'
 *   @param {string}  [loadingText] wx.showLoading 文案（不传则不显示遮罩）
 * @returns {Promise<any|null>}
 */
function submit(page, opts) {
  var o = opts || {};
  var flag = o.flag || 'submitting';
  var key = o.key || 'submit';

  // 防重复提交：提交中再点一次直接忽略（按钮同时 disabled，双保险）
  if (page.data[flag]) return Promise.resolve(null);

  var rid = requestId(page, key);
  var patch = { error: '', errorCode: '', notReady: false, notReadyMsg: '' };
  patch[flag] = true;
  page.setData(patch);
  if (o.loadingText) wx.showLoading({ title: o.loadingText, mask: true });

  return Promise.resolve()
    .then(function () {
      return o.request(rid);
    })
    .then(function (data) {
      if (o.loadingText) wx.hideLoading();
      // 只有成功才丢弃幂等键：失败保留 → 用户重试命中服务端幂等，不会重复建单
      if (page.__reqIds) delete page.__reqIds[key];
      var p = {};
      p[flag] = false;
      page.setData(p);
      if (o.onSuccess) o.onSuccess(data, rid);
      return data;
    })
    .catch(function (err) {
      if (o.loadingText) wx.hideLoading();
      var d = describeError(err);
      var p = {};
      p[flag] = false;
      p.authExpired = d.authExpired;
      p.notReady = d.notReady;
      p.notReadyMsg = d.notReadyMsg || d.message;
      p.error = d.notReady ? '' : d.message;
      p.errorCode = d.code;
      page.setData(p);
      if (d.authExpired) handleAuthExpired(page, d);
      if (o.onError) o.onError(err, d);
      return null;
    });
}

/**
 * 返回页面时刷新关键数据
 *
 * 用法：
 *   onShow() { state.refreshOnShow(this, 'load'); }
 *
 * 第一次 onShow 紧跟 onLoad，不重复请求（onLoad 已经在拉了）；
 * 之后每次返回（改完日期、下完单、前台处理完服务请求）都刷一次 ——
 * 这是清单「返回后刷新」和「订单状态变化」的实现方式。
 */
function refreshOnShow(page, methodName, delayMs) {
  if (!page.__shownOnce) {
    page.__shownOnce = true;
    return;
  }
  var fn = page[methodName || 'load'];
  if (typeof fn !== 'function') return;
  var run = function () {
    fn.call(page);
  };
  if (delayMs) setTimeout(run, delayMs);
  else run();
}

/**
 * 轮询（订单状态 / 在住服务状态变化）
 *
 * 只在页面可见时轮询，onHide / onUnload 自动停 —— 小程序后台挂着还能发请求
 * 会被微信判为「后台频繁请求」，也白白耗用户流量。
 */
function startPolling(page, methodName, intervalMs) {
  stopPolling(page);
  var fn = page[methodName || 'load'];
  if (typeof fn !== 'function') return;
  page.__pollTimer = setInterval(function () {
    if (page.__hidden) return;
    fn.call(page);
  }, intervalMs || 30000);
}

function stopPolling(page) {
  if (page.__pollTimer) {
    clearInterval(page.__pollTimer);
    page.__pollTimer = null;
  }
}

/** 页面 onHide / onUnload 时调用：停轮询 + 打隐藏标记 */
function onPageHide(page) {
  page.__hidden = true;
  stopPolling(page);
}

/** 页面 onShow 时调用：恢复轮询（配合 refreshOnShow 使用） */
function onPageVisible(page) {
  page.__hidden = false;
}

/** 确认弹窗（Promise 化），用户点「确定」resolve(true) */
function confirm(title, content, confirmText) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || '确认',
      content: content || '',
      confirmText: confirmText || '确定',
      cancelText: '取消',
      success: function (res) {
        resolve(Boolean(res.confirm));
      },
      fail: function () {
        resolve(false);
      },
    });
  });
}

/**
 * 空状态判断辅助：把服务端可能的 3 种「没有数据」写法统一
 *   · data = null / undefined
 *   · data.list = []
 *   · data = { stay: null }
 */
function pickList(data, keys) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  var list = keys || ['list', 'items', 'rows'];
  for (var i = 0; i < list.length; i += 1) {
    var v = data[list[i]];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** 取对象里的第一个非空对象字段（如 currentStay 可能回 { stay } 或直接是 stay） */
function pickObject(data, keys, ownKeys) {
  if (!data || typeof data !== 'object') return null;
  var ks = keys || ['item', 'data', 'stay', 'booking', 'folio', 'detail', 'member', 'hotel'];
  for (var i = 0; i < ks.length; i += 1) {
    var v = data[ks[i]];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  // 本身就是目标对象（含页面关心的字段）
  if (ownKeys) {
    for (var j = 0; j < ownKeys.length; j += 1) {
      if (hasOwn(data, ownKeys[j])) return data;
    }
  }
  return data;
}

/**
 * 确保拿到 stayId（续住 / 换房 / 延迟退房 / 服务 / 账单都要用）
 *
 * 优先用页面参数；没传（从分享卡片、通知直接点进来）就问服务端要当前在住。
 * 拿不到时 reject(code = 'NO_STAY')，页面据此显示「当前没有在住订单」空状态。
 *
 * 注意：这里拿到的 stayId **只用于 URL 定位**。服务端对每个 /stays/:id/* 接口
 * 都必须自己校验归属，不能因为「客户端说是这个 stay」就放行（清单第四节）。
 */
function ensureStayId(page, hint) {
  var given = hint || (page && page.data && page.data.stayId) || '';
  if (given) return Promise.resolve(String(given));

  return mini.currentStay().then(function (res) {
    var stay = pickObject(res, ['stay', 'current', 'inhouse'], ['stayId', 'stay_id']);
    var id = stay ? formatFirst(stay, ['stayId', 'stay_id', 'id']) : '';
    if (!id) {
      var err = new Error('当前没有在住订单');
      err.code = 'NO_STAY';
      throw err;
    }
    if (page) page.setData({ stayId: String(id) });
    return String(id);
  });
}

/** 与 utils/format.js 的 first() 同义（避免 page-state 反向依赖展示层） */
function formatFirst(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback === undefined ? '' : fallback;
  for (var i = 0; i < (keys || []).length; i += 1) {
    var v = obj[keys[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback === undefined ? '' : fallback;
}

module.exports = {
  baseData: baseData,
  describeError: describeError,
  toast: toast,
  load: load,
  retry: retry,
  submit: submit,
  requestId: requestId,
  resetRequest: resetRequest,
  refreshOnShow: refreshOnShow,
  startPolling: startPolling,
  stopPolling: stopPolling,
  onPageHide: onPageHide,
  onPageVisible: onPageVisible,
  handleAuthExpired: handleAuthExpired,
  confirm: confirm,
  pickList: pickList,
  pickObject: pickObject,
  ensureStayId: ensureStayId,
};
