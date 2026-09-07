// src/preload/web/diag.ts — 网页注入环境的诊断日志回传（仅 web 用，桌面端走 IPC log-message）。
//
// 背景：轮播墙等 embyWall 功能失败时，诊断证据（[CAROUSEL]/[LAYOUT]/异常栈）只存在于
// 浏览器 console，后端日志看不到，用户也没有 devtools。这里把关键 console 输出与全局
// 错误批量回传给注入后端（POST /app/fntvplus/api/client-log），后端落 client.log，
// 管理页「实时日志」即可看到前端发生了什么。
//
// 只回传我们自己的输出（[EmbyWall]/[fntv 前缀）与 error 级别，不回传页面自身噪音。

const API = '/app/fntvplus/api/client-log';
const buf: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function fmt(a: any[]): string {
  return a
    .map((x) => {
      if (typeof x === 'string') return x;
      try {
        return JSON.stringify(x);
      } catch (_) {
        return String(x);
      }
    })
    .join(' ');
}

function push(line: string): void {
  if (buf.length > 500) buf.splice(0, buf.length - 500); // 防爆内存
  let t = '';
  try {
    t = new Date().toISOString().slice(11, 23);
  } catch (_) {}
  buf.push(t + ' ' + line);
  if (buf.length >= 20) flush();
  else if (!timer) timer = setTimeout(flush, 2000);
}

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buf.length) return;
  const body = buf.splice(0).join('\n');
  try {
    fetch(API, { method: 'POST', body, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }).catch(() => {});
  } catch (_) {
    /* 网络不可用时静默丢弃 */
  }
}

/** 拦截 console（仅捕获转发，原样放行）+ 全局错误钩子。在 payload boot 最前调用。 */
export function installDiag(): void {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const wrap = (origFn: (...a: any[]) => void, level: string) => (...args: any[]) => {
    try {
      const s = fmt(args);
      if (level === 'error' || s.startsWith('[EmbyWall]') || s.startsWith('[fntv')) {
        push('[' + level + '] ' + s);
      }
    } catch (_) {}
    origFn(...args);
  };
  console.log = wrap(orig.log, 'log');
  console.warn = wrap(orig.warn, 'warn');
  console.error = wrap(orig.error, 'error');

  try {
    window.addEventListener('error', (e: any) => {
      push('[onerror] ' + (e.message || String(e)) + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
    });
    window.addEventListener('unhandledrejection', (e: any) => {
      const r = e.reason;
      push('[unhandledrejection] ' + ((r && (r.stack || r.message)) || String(r)));
    });
    window.addEventListener('beforeunload', flush);
  } catch (_) {}

  push('[diag] installed @' + location.href);
}
