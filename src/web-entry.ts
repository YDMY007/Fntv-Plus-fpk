// src/web-entry.ts — 网页端/注入引导入口（FPK 注入的 user.js 即从这里打包）。
//
// 关键：不修改被复用的原代码。embyWall.ts 在模块加载时通过
// `registerHook(HookType.OnReady, handle)` 自注册，因此这里只需：
//   1) 先装诊断回传（捕获 embyWall 的 console 日志与全局错误 → 后端 client.log）
//   2) import embyWall（触发其副作用：注册 hook）
//   3) DOM ready 后 runHooks(OnReady) 即可启动海报墙/轮播/沉浸式美化
//
// 这也意味着：演示页与真实注入页共用同一份 embyWall 代码，零重复。

import { installDiag } from './preload/web/diag';

installDiag();

import './preload/plugins/embyWall';
import { runHooks, HookType } from './preload/core/hooks';

declare const window: any;
declare const document: any;

/** 左下角「日志」小按钮：常驻入口，点开设置页（配置+运行状态+实时日志）。 */
function ensureLogButton(): void {
  try {
    if (document.getElementById('fntv-log-btn')) return;
    if (!document.body) return;
    const b = document.createElement('div');
    b.id = 'fntv-log-btn';
    b.textContent = '日志';
    b.title = '影视 Plus 设置 / 实时日志';
    const s = b.style as any;
    s.position = 'fixed';
    s.left = '8px';
    s.bottom = '8px';
    s.zIndex = '2147483646';
    s.padding = '2px 9px';
    s.borderRadius = '10px';
    s.fontSize = '11px';
    s.lineHeight = '16px';
    s.background = 'rgba(0,0,0,.35)';
    s.color = '#fff';
    s.cursor = 'pointer';
    s.opacity = '.3';
    s.transition = 'opacity .2s';
    s.userSelect = 'none';
    b.addEventListener('mouseenter', () => (b.style.opacity = '1'));
    b.addEventListener('mouseleave', () => (b.style.opacity = '.3'));
    b.addEventListener('click', () => {
      try {
        window.open('/app/fntvplus/admin/', '_blank');
      } catch (_) {}
    });
    document.body.appendChild(b);
  } catch (_) {}
}

function boot() {
  try {
    runHooks(HookType.OnReady);
    console.log('[fntv-web] embyWall hooks fired (OnReady)');
  } catch (e) {
    console.error('[fntv-web] boot failed', e);
  }
  ensureLogButton();
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
