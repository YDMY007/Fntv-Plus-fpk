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

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
}

const ipcRenderer = {
  invoke(channel, ...args) {
    if (channel === 'settings:get') return Promise.resolve(loadSettings());
    if (typeof channel === 'string' && channel.startsWith('settings:set-')) {
      // settings:set-perf-mode / set-hide-play ... 尽力把值落进镜像
      const key = channel.replace('settings:set-', '');
      const s = loadSettings();
      s[key] = args[0];
      saveSettings(s);
      return Promise.resolve();
    }
    if (channel === 'settings:list-changelogs') return Promise.resolve([]);
    if (channel === 'settings:read-changelog') return Promise.resolve({ content: '' });
    if (channel === 'settings:check-update') return Promise.resolve();
    if (channel === 'get-version') return Promise.resolve({ version: '0.0.0-web' });
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
