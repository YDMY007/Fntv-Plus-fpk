// src/web-entry.ts — 网页端/注入引导入口（FPK 注入的 user.js 即从这里打包）。
//
// 关键：不修改被复用的原代码。embyWall.ts 在模块加载时通过
// `registerHook(HookType.OnReady, handle)` 自注册，因此这里只需：
//   1) 先装诊断回传（捕获 embyWall 的 console 日志与全局错误 → 后端 client.log）
//   2) import embyWall（触发其副作用：注册 hook）
//   3) DOM ready 后 runHooks(OnReady) 即可启动海报墙/轮播/沉浸式美化
//
// 这也意味着：演示页与真实注入页共用同一份 embyWall 代码，零重复。
// [飞牛影视特化 v0.10.0] 左下角悬浮「日志」按钮已移除——日志入口收敛到
// 侧边栏设置面板「诊断与日志」分类的实时日志查看器（数据源同一份 /app/fntvplus/api/logs）。

import { installDiag } from './preload/web/diag';

installDiag();

// [v0.30.0] 全插件挂载：与桌面版 preload 对齐（桌面是动态 require plugins 目录全部插件）。
//  新增插件文件后需在此同步补一行 import（esbuild 静态打包不支持目录扫描）。
import './preload/plugins/a11y';
import './preload/plugins/animeLib';
import './preload/plugins/autoplayNext';
import './preload/plugins/customLogo';
import './preload/plugins/danmakuHeat';
import './preload/plugins/danmakuWeb';
import './preload/plugins/dialogUI';
import './preload/plugins/embyWall';
import './preload/plugins/gamepad';
import './preload/plugins/gamepadFocus';
import './preload/plugins/glassUI';
import './preload/plugins/hotUpdates';
import './preload/plugins/listLayout';
import './preload/plugins/pageAnim';
import './preload/plugins/personWorks';
import './preload/plugins/playButton';
import './preload/plugins/playChoice';
import './preload/plugins/playMaskButton';
import './preload/plugins/playMemory';
import './preload/plugins/previewThumb';
import './preload/plugins/skipInject';
import './preload/plugins/titlebar';
import './preload/plugins/watchHistory';
import './preload/plugins/watchReport';
import './preload/plugins/watchedSync';
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
