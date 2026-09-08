// src/shim/electron.js — 浏览器端 electron 垫片（仅 web 注入/演示用）。
// 真实环境由 Fntv-Plus 主进程提供 ipcRenderer；这里用浏览器能力做最小可用实现，
// 让「复用原 preload 代码」无需改写即可在浏览器里跑起来。
//
// 策略：设置类调用（settings:get/set-*）走 localStorage 镜像；其余调用安全 no-op。
// 目的不是 100% 还原客户端行为，而是让被复用的代码能 import、能 boot、能在真实影视页面上渲染。
//
// Authx 签名：桌面端由主进程 fnos-gen-authx 计算；网页端没有主进程，改为回放
// diag.ts 从页面自身请求里捕获的合法签名（item/list 等接口），未捕获到返回空串
// （images.ts/itemListApi 对空值会跳过或由 diag 剥离坏头，靠 cookie 直取同源图片）。

import { getCapturedAuthx } from '../preload/web/diag';
import { md5 } from './md5';

// fnOS 影视 API 鉴权签名（算法与桌面版主进程 fnosAuth.js 完全一致）：
// sign = md5([API_KEY, url, nonce, timestamp, md5(JSON.stringify(data)||''), API_SECRET].join('_'))
const AUTHX_KEY = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const AUTHX_SECRET = '16CCEB3D-AB42-077D-36A1-F355324E4237';

function genAuthx(url, data) {
  const nonce = String(Math.floor(Math.random() * (1000000 - 100000) + 100000));
  const timestamp = Date.now().toString();
  const dataJson = data ? JSON.stringify(data) : '';
  const signStr = [AUTHX_KEY, String(url), nonce, timestamp, md5(dataJson), AUTHX_SECRET].join('_');
  return 'nonce=' + nonce + '&timestamp=' + timestamp + '&sign=' + md5(signStr);
}

const LS_KEY = 'fntv:electron-settings';

// [v0.34.0] 浏览器全局兜底：部分桌面插件在模块顶层用 __dirname / require('electron')，
// esbuild 无法静态转换全局引用 → 运行时 ReferenceError 导致整个 IIFE 中断（页面静默变原生）。
// require('electron') 返回本垫片命名空间；__dirname 给出无害占位。
const shimExports = { ipcRenderer: null, shell: null };
try {
  if (typeof window !== 'undefined') {
    if (typeof window.require === 'undefined') {
      window.require = function (id) {
        if (id === 'electron' || id === 'electron/main') return shimExports;
        throw new Error('网页端不支持 Node 模块: ' + id);
      };
    }
    if (typeof window.__dirname === 'undefined') window.__dirname = '/fntv-web';
  }
} catch { /* ignore */ }

// settings:set-<后缀> → 服务端 config 键名映射（与桌面版 config.json 字段名对齐）
const SETTINGS_KEY_MAP = {
  'bangumi-token': 'bangumiToken',
  'bangumi-sync-enabled': 'bangumiSyncEnabled',
  'bangumi-sync-threshold': 'bangumiSyncThreshold',
  'tmdb-key': 'tmdbApiKey',
  'tmdb-direct': 'tmdbDirect',
  'custom-proxy': 'customProxy',
  'wheel-hscroll': 'wheelHScroll',
  'hide-play': 'hideOriginalPlayButton',
  'carousel-logo': 'carouselLogoEnabled',
  'detail-boxless': 'detailBoxless',
  'nas-proxy': 'nasProxyEnabled',
  'download-proxy': 'downloadProxyEnabled',
  'system-page-url': 'systemPageUrl',
  'smart-skip-enabled': 'smartSkipEnabled',
  'dandanplay-credentials': 'dandanplayCredentials',
  'exit-mode': 'exitMode',
  'custom-version': 'customVersion',
  'debug-enabled': 'debugEnabled',
  'debug-components': 'debugComponents',
  'danmu-api': 'danmuApi',
  'hot-source': 'hotSource',
};

function settingKey(suffix) {
  return SETTINGS_KEY_MAP[suffix] || String(suffix).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function apiGet(path) {
  return fetch(path, { credentials: 'include' }).then((r) => r.json());
}
function apiPost(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    credentials: 'include',
  }).then((r) => r.json());
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
}

const ipcRenderer = {
  invoke(channel, ...args) {
    /* ── 设置：服务端持久化（NAS 端 config.json，跨浏览器共享）；失败回退 localStorage 镜像 ── */
    if (channel === 'settings:get') {
      return apiGet('/app/fntvplus/api/settings').catch(() => loadSettings());
    }
    if (typeof channel === 'string' && channel.startsWith('settings:set-')) {
      const key = settingKey(channel.replace('settings:set-', ''));
      // 特例：桌面版 handler 会拆字段的复合设置（键名与桌面 config.json 对齐）
      if (channel === 'settings:set-tmdb-direct') {
        const a = args[0] || {};
        return apiPost('/app/fntvplus/api/settings', {
          tmdbDirectConnect: !!a.enabled,
          tmdbDirectIp: a.ip || null,
        });
      }
      if (channel === 'settings:set-custom-proxy') {
        // 复合设置：(enabled, proxyUrl) → 桌面 config.json 两字段 customProxyEnabled + customProxy。
        // 此前无特例时通用逻辑把 args[0]（enabled 布尔）误存进 customProxy，URL 被丢弃 → 后端永远拿不到代理。
        return apiPost('/app/fntvplus/api/settings', {
          customProxyEnabled: !!args[0],
          customProxy: (typeof args[1] === 'string' ? args[1].trim() : ''),
        });
      }
      if (channel === 'settings:set-dandanplay-credentials') {
        return apiPost('/app/fntvplus/api/settings', {
          dandanplayAppId: String(args[0] || ''),
          dandanplayAppSecret: String(args[1] || ''),
        });
      }
      const p = apiPost('/app/fntvplus/api/settings', { [key]: args[0] });
      p.then(() => {
        const s = loadSettings();
        s[key] = args[0];
        saveSettings(s);
      }).catch(() => {});
      return p;
    }
    if (typeof channel === 'string' && channel.startsWith('settings:get-')) {
      // 特例：自定义代理回填需要 {enabled, proxyUrl} 复合形状（与桌面版 getCustomProxyConfig 对齐）
      if (channel === 'settings:get-custom-proxy') {
        return apiGet('/app/fntvplus/api/settings').then((s) => {
          const u = (s && typeof s.customProxy === 'string') ? s.customProxy.trim() : '';
          return { enabled: !!(s && s.customProxyEnabled) && !!u, proxyUrl: u };
        });
      }
      const key = settingKey(channel.replace('settings:get-', ''));
      return apiGet('/app/fntvplus/api/settings').then((s) => (s && s[key] !== undefined ? s[key] : loadSettings()[key]));
    }

    /* ── Trakt（后端 bridge：设备授权/凭证/scrobble/同步）── */
    if (channel === 'trakt:get-status') return apiGet('/app/fntvplus/api/bridge/trakt/status');
    if (channel === 'trakt:get-credentials') return apiGet('/app/fntvplus/api/bridge/trakt/credentials');
    if (channel === 'trakt:save-credentials') {
      return apiPost('/app/fntvplus/api/bridge/trakt/credentials', { client_id: args[0], client_secret: args[1] });
    }
    if (channel === 'trakt:device-start') return apiPost('/app/fntvplus/api/bridge/trakt/device/start', {});
    if (channel === 'trakt:device-cancel') return apiPost('/app/fntvplus/api/bridge/trakt/device/cancel', {});
    if (channel === 'trakt:disconnect') return apiPost('/app/fntvplus/api/bridge/trakt/disconnect', {});
    if (channel === 'trakt:scrobble') {
      return apiPost('/app/fntvplus/api/bridge/trakt/scrobble', {
        action: args[0], guid: args[1], progress: args[2], cookie: document.cookie,
      });
    }
    if (channel === 'trakt:sync-watched') {
      return apiPost('/app/fntvplus/api/bridge/trakt/sync-watched', { cookie: document.cookie });
    }
    if (channel === 'trakt:set-scrobble-enabled') {
      const key = 'traktScrobbleEnabled';
      const p = apiPost('/app/fntvplus/api/settings', { [key]: args[0] });
      p.then(() => {
        const s = loadSettings();
        s[key] = args[0];
        saveSettings(s);
      }).catch(() => {});
      return p;
    }
    if (channel === 'trakt:get-scrobble-enabled') {
      return apiGet('/app/fntvplus/api/settings').then((s) => !!s.traktScrobbleEnabled);
    }

    /* ── TMDB（图片/logo/详情经后端代理，规避 CORS 与网络问题）── */
    if (channel === 'tmdb:image' || channel === 'tmdb:img') {
      return fetch('/app/fntvplus/api/bridge/tmdb/img?url=' + encodeURIComponent(String(args[0] || '')))
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
    }
    if (channel === 'tmdb:logo') return apiPost('/app/fntvplus/api/bridge/tmdb/logo', args[0] || {});
    if (channel === 'tmdb:show') return apiPost('/app/fntvplus/api/bridge/tmdb/show', args[0] || {});
    if (channel === 'tmdb:season-episodes') {
      return apiPost('/app/fntvplus/api/bridge/tmdb/season-episodes', args[0] || {});
    }
    if (channel === 'tmdb:discover') {
      // 每日放送 TMDB 源：后端 /discover/movie + /discover/tv 合并（复用 Key 鉴权 + 免梯子直连）
      return apiPost('/app/fntvplus/api/bridge/tmdb/discover', { force: !!args[0] });
    }
    if (channel === 'tmdb:update-ip') {
      // 免梯子直连「更新 IP」：后端拉 CheckTMDB hosts 片段刷新直连 IP（force 覆盖手动值）
      return apiPost('/app/fntvplus/api/bridge/tmdb/update-ip', { force: true });
    }
    if (channel === 'tmdb:update-ip') return Promise.resolve(undefined);

    /* ── Bangumi / 豆瓣 ── */
    if (channel === 'bangumi:calendar') {
      // 每日放送 Bangumi 源：后端已包装成桌面版同形状 {ok, items}；失败也回 JSON（不吞错）
      return fetch('/app/fntvplus/api/bridge/bangumi/calendar')
        .then((r) => r.json())
        .catch(() => ({ ok: false, error: '网络错误：无法连接后端' }));
    }
    if (channel === 'douban:discover') {
      // 每日放送豆瓣源：后端 Rexxar movie_hot_gaia + tv_hot 合并（免 Key，国内直连）
      return apiPost('/app/fntvplus/api/bridge/douban/discover', { force: !!args[0] });
    }
    if (channel === 'douban:image') {
      // 豆瓣海报防盗链代理（后端带 UA+Referer 解 418，转 dataUrl）
      return fetch('/app/fntvplus/api/bridge/douban/image?url=' + encodeURIComponent(String(args[0] || '')))
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
    }
    if (channel === 'douban:login-status') {
      return apiPost('/app/fntvplus/api/bridge/douban/status', {}).then((s) => ({ loggedIn: !!s.loggedIn, note: s.note }));
    }
    if (channel === 'douban:get-watched-items') {
      // 忠实移植：后端钻取全库（季→集进度分析），返回桌面版同形状 { items, libraryTotal }
      return apiPost('/app/fntvplus/api/bridge/douban/watched', {
        cookie: document.cookie, force: !!args[0],
      });
    }
    if (channel === 'douban:enrich-one') {
      // 单条补全：TMDB 分类/类型/评分 + 豆瓣评分（item 无 guid 时静默 null）
      if (!args[0] || !args[0].guid) return Promise.resolve(null);
      return apiPost('/app/fntvplus/api/bridge/douban/enrich', { item: args[0], cookie: document.cookie })
        .then((r) => (r && r.category !== undefined ? { guid: args[0].guid, ...r } : null))
        .catch(() => null);
    }
    if (channel === 'bangumi:sync-progress') {
      return apiPost('/app/fntvplus/api/bridge/bangumi/sync-progress', {
        guid: args[0], percentage: args[1], cookie: document.cookie,
      });
    }
    if (channel === 'douban:enrich-one') return Promise.resolve(null);
    if (channel === 'douban:scan-watched-manual') return Promise.resolve({ ok: false, message: '网页端豆瓣扫描未适配' });
    if (typeof channel === 'string' && channel.startsWith('douban:')) return Promise.resolve(undefined);

    /* ── 会话/窗口/杂项 ── */
    if (channel === 'settings:list-changelogs') return Promise.resolve([]);
    if (channel === 'settings:read-changelog') return Promise.resolve({ content: '' });
    if (channel === 'settings:check-update') return Promise.resolve({ ok: false, message: '网页端更新走飞牛应用中心' });
    if (channel === 'get-version') return Promise.resolve({ version: '0.30.0-web' });

    /* ── 通用配置/缓存 ── */
    if (channel === 'get-config' || channel === 'get-play-button-config') {
      return apiGet('/app/fntvplus/api/settings').catch(() => ({}));
    }
    if (channel === 'library-index:read') {
      try {
        const v = localStorage.getItem('fntv:library-index');
        return Promise.resolve(v ? { ok: true, items: JSON.parse(v) } : { ok: false });
      } catch { return Promise.resolve({ ok: false }); }
    }
    if (channel === 'library-index:write') {
      try {
        localStorage.setItem('fntv:library-index', JSON.stringify(args[0] || []));
        return Promise.resolve({ ok: true });
      } catch { return Promise.resolve({ ok: false }); }
    }
    if (channel === 'log-message') return Promise.resolve(undefined); // emitLog 已并行 console.log，diag 会捕获

    /* ── 补丁/解锁（桌面版更新机制；网页端更新走应用中心）── */
    if (channel === 'settings:verify-unlock-code') return Promise.resolve({ ok: false, message: '网页端未适配解锁码' });
    if (channel === 'settings:check-patch' || channel === 'settings:apply-patch' || channel === 'settings:apply-test-patch' || channel === 'settings:rollback-patch') {
      return Promise.resolve({ ok: false, message: '网页端不支持补丁机制' });
    }
    if (channel === 'settings:list-test-patches') return Promise.resolve([]);

    /* ── 文件选择/诊断（桌面主进程 dialog；网页端不可用）── */
    if (channel === 'settings:pick-login-bg' || channel === 'settings:pick-mpv-path' || channel === 'settings:pick-pot-path') {
      return Promise.resolve({ ok: false, canceled: true });
    }
    if (channel === 'settings:clear-login-bg') return apiPost('/app/fntvplus/api/settings', { loginBg: null });
    if (channel === 'settings:clear-mpv-path') return apiPost('/app/fntvplus/api/settings', { mpvPath: '' });
    if (channel === 'settings:clear-pot-path') return apiPost('/app/fntvplus/api/settings', { potPath: '' });
    if (channel === 'settings:diagnostics') {
      return apiGet('/app/fntvplus/api/settings').then((s) => ({ ok: true, settings: s, ua: navigator.userAgent }));
    }
    if (channel === 'settings:test-custom-proxy') {
      return apiPost('/app/fntvplus/api/bridge/proxy/test', { proxyUrl: args[1] });
    }
    if (channel === 'settings:test-danmu-api') return apiPost('/app/fntvplus/api/bridge/danmu/test', { base: args[0] });

    /* ── 播放/媒体（网页端由原生 UI 承担；外部播放器不可用）── */
    if (channel === 'play-movie' || channel === 'external-play' || channel === 'pause' || channel === 'media:control') {
      return Promise.resolve(undefined);
    }
    if (channel === 'media:season-guid' || channel === 'skip:fetch-and-fill' || channel === 'skip:next-episode') {
      return Promise.resolve(undefined); // 片头片尾/选集回填数据源待接
    }
    if (channel === 'mpv:get-render-preset') return apiGet('/app/fntvplus/api/settings').then((s) => s.mpvRenderPreset);
    if (channel === 'mpv:set-render-preset') return apiPost('/app/fntvplus/api/settings', { mpvRenderPreset: args[0] });

    /* ── B 站扫码登录（后端桥：passport API + cookie 持久化到 NAS）── */
    if (channel === 'bili:qr-generate') return apiPost('/app/fntvplus/api/bridge/bili/qr-generate', {});
    if (channel === 'bili:qr-poll') return apiPost('/app/fntvplus/api/bridge/bili/qr-poll', { key: args[0] });
    if (channel === 'bili:cookie-status') return apiGet('/app/fntvplus/api/bridge/bili/status');
    if (channel === 'bili:qr-lib') {
      // 返回 qrcode.min.js 源码字符串（面板注入后客户端渲染二维码）
      return fetch('/app/fntvplus/api/bridge/bili/qr-lib').then((r) => r.text());
    }
    if (channel === 'bili:manual-cookie') return apiPost('/app/fntvplus/api/bridge/bili/manual', { raw: args[0] });
    if (channel === 'bili:clear') return apiPost('/app/fntvplus/api/bridge/bili/clear', {});
    if (channel === 'bili:open-danmaku-folder') return Promise.resolve(undefined);
    if (channel === 'danmaku:prepare') return Promise.resolve({ ok: false, message: '网页端暂未适配' });

    /* ── 人物页 TMDB 增强（fnOS person API → TMDB 链路待接）── */
    if (channel === 'person:tmdb-brief' || channel === 'person:tmdb-credits') return Promise.resolve(null);

    if (channel === 'settings:open-external') {
      try { window.open(String(args[0] || ''), '_blank', 'noopener'); } catch { /* ignore */ }
      return Promise.resolve();
    }
    if (channel === 'trakt:clear-credentials') {
      return apiPost('/app/fntvplus/api/bridge/trakt/disconnect', {});
    }

    if (channel === 'fnos-gen-authx') {
      // 本地真签名（与桌面版主进程同算法），不再依赖页面捕获回放；getCapturedAuthx 仅留作诊断对照
      return Promise.resolve(genAuthx(String(args[0] || ''), args[1]));
    }
    if (channel === 'app:open-external') {
      // 网页端：新标签页打开外链（桌面端由主进程 shell.openExternal）
      try { window.open(String(args[0] || ''), '_blank', 'noopener'); } catch { /* ignore */ }
      return Promise.resolve();
    }
    if (channel === 'app:qr-image') {
      // 网页端：二维码由后端内嵌直出（桌面端由主进程读 build/qrcode.png 返回 base64），
      // 这里 fetch 同源 PNG 转 dataUri，形状对齐桌面版 { ok, dataUri }
      return fetch('/app/fntvplus/qrcode.png')
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('http ' + r.status))))
        .then((blob) => new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve({ ok: true, dataUri: fr.result });
          fr.onerror = () => resolve({ ok: false });
          fr.readAsDataURL(blob);
        }))
        .catch(() => Promise.resolve({ ok: false }));
    }
    // 其它一律安全 no-op
    return Promise.resolve(undefined);
  },
  send(/* channel, ...args */) { /* no-op：浏览器无主进程通道 */ },
  on(channel, cb) {
    // 网页端没有主进程下发调试过滤 → 默认打开 embyWall 日志总开关，
    // 让 [DIAG] fetchImg 等诊断流进 console → diag 回传后端，用户在实时日志可见。
    if (channel === 'debug-filter' && typeof cb === 'function') {
      setTimeout(() => {
        try { cb({}, { enabled: true, components: {} }); } catch { /* ignore */ }
      }, 0);
    }
    return () => {};
  },
  once(channel, cb) {
    // 兼容 embyWall 的 get-version → version-info 握手
    if (channel === 'version-info') { try { cb({}, { version: '0.0.0-web' }); } catch {} }
    return () => {};
  },
  removeListener() {},
  off(channel, cb) { return this.removeListener(channel, cb); },
  removeAllListeners() {},
};

const shell = {
  openExternal() {},
  openPath() {},
  showItemInFolder() {},
};

shimExports.ipcRenderer = ipcRenderer;
shimExports.shell = shell;
try { if (typeof window !== 'undefined') window.__fntvShim = shimExports; } catch { /* ignore */ }
export { ipcRenderer, shell };
