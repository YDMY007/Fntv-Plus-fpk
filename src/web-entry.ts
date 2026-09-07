// src/web-entry.ts — 网页端/注入引导入口（FPK 注入的 user.js 即从这里打包）。
//
// 关键：不修改被复用的原代码。embyWall.ts 在模块加载时通过
// `registerHook(HookType.OnReady, handle)` 自注册，因此这里只需：
//   1) import embyWall（触发其副作用：注册 hook）
//   2) DOM ready 后 runHooks(OnReady) 即可启动海报墙/轮播/沉浸式美化
//
// 这也意味着：演示页与真实注入页共用同一份 embyWall 代码，零重复。

import './preload/plugins/embyWall';
import { runHooks, HookType } from './preload/core/hooks';

declare const window: any;
declare const document: any;

function boot() {
  try {
    runHooks(HookType.OnReady);
    console.log('[fntv-web] embyWall hooks fired (OnReady)');
  } catch (e) {
    console.error('[fntv-web] boot failed', e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// 暴露到 window，方便调试 / 真实页面 SPA 路由切换时手动再触发
if (typeof window !== 'undefined') {
  window.__FNTV_BOOT__ = boot;
}
