// src/shim/electron.js — 浏览器端 electron 垫片（仅 web 注入/演示用）。
// 真实环境由 Fntv-Plus 主进程提供 ipcRenderer；这里用浏览器能力做最小可用实现，
// 让「复用原 preload 代码」无需改写即可在浏览器里跑起来。
//
// 策略：设置类调用（settings:get/set-*）走 localStorage 镜像；其余调用安全 no-op。
// 目的不是 100% 还原客户端行为，而是让被复用的代码能 import、能 boot、能在真实影视页面上渲染。

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
    // 其它一律安全 no-op
    return Promise.resolve(undefined);
  },
  send(/* channel, ...args */) { /* no-op：浏览器无主进程通道 */ },
  on(/* channel, cb */) { return () => {}; },
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
