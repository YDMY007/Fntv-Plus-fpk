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
      const p = apiPost('/app/fntvplus/api/settings', { [key]: args[0] });
      p.then(() => {
        const s = loadSettings();
        s[key] = args[0];
        saveSettings(s);
      }).catch(() => {});
      return p;
    }
    if (typeof channel === 'string' && channel.startsWith('settings:get-')) {
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
    if (channel === 'tmdb:update-ip') return Promise.resolve(undefined);

    /* ── Bangumi / 豆瓣 ── */
    if (channel === 'bangumi:calendar') {
      return fetch('/app/fntvplus/api/bridge/bangumi/calendar').then((r) => r.json()).catch(() => []);
    }
    if (channel === 'douban:login-status') {
      return apiPost('/app/fntvplus/api/bridge/douban/status', {}).then((s) => ({ loggedIn: !!s.loggedIn, note: s.note }));
    }
    if (channel === 'douban:get-watched-items') {
      // 精简移植：经 fnOS 签名桥拉已识别作品（豆瓣评分增强待后续版本）
      return apiPost('/app/fntvplus/api/bridge/fnos', {
        method: 'POST',
        path: '/v/api/v1/item/list',
        body: {
          tags: { type: ['Movie', 'TV'] }, sort_type: 'DESC', sort_column: 'create_time',
          exclude_grouped_video: 1, page: 1, page_size: 200,
        },
        cookie: document.cookie,
      }).then((j) => (j && j.data && Array.isArray(j.data.list))
        ? j.data.list.map((it) => ({
            guid: it.item_guid || it.guid,
            title: it.title,
            type: it.type,
            trim_id: it.trim_id,
            poster: it.poster,
            watched: true,
          }))
        : []);
    }
    if (channel === 'douban:enrich-one') return Promise.resolve(null);
    if (channel === 'douban:scan-watched-manual') return Promise.resolve({ ok: false, message: '网页端豆瓣扫描未适配' });
    if (typeof channel === 'string' && channel.startsWith('douban:')) return Promise.resolve(undefined);

    /* ── 会话/窗口/杂项 ── */
    if (channel === 'settings:list-changelogs') return Promise.resolve([]);
    if (channel === 'settings:read-changelog') return Promise.resolve({ content: '' });
    if (channel === 'settings:check-update') return Promise.resolve();
    if (channel === 'get-version') return Promise.resolve({ version: '0.15.0-web' });
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
  removeAllListeners() {},
};

const shell = {
  openExternal() {},
  openPath() {},
  showItemInFolder() {},
};

export { ipcRenderer, shell };
