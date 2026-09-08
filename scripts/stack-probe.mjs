// scripts/stack-probe.mjs — 主线程卡死时用 CDP Debugger.pause 抓调用栈（V8 可在 JS 执行中中断）。
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payloadArg = process.argv[2] || path.join(root, 'dist/fntv-plus.user.js');
const hostPage = path.join(root, 'demo/host.html');

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

const client = await page.context().newCDPSession(page);
await client.send('Debugger.enable');
const scripts = new Map();
client.on('Debugger.scriptParsed', (s) => scripts.set(s.scriptId, s.url));
let dumped = false;
client.on('Debugger.paused', (ev) => {
  if (dumped) return;
  dumped = true;
  console.log('=== PAUSED reason=' + ev.reason + ' ===');
  for (const f of ev.callFrames.slice(0, 25)) {
    const url = f.url || scripts.get(f.location.scriptId) || '?';
    console.log(`  ${f.functionName || '(anonymous)'}  @ ${url}:${f.location.lineNumber + 1}:${f.location.columnNumber}`);
  }
});

await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.endsWith('.js')) route.fulfill({ path: payloadArg, contentType: 'text/javascript' });
  else route.fulfill({ path: hostPage, contentType: 'text/html' });
});

page.goto('http://fntv.test/v/', { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
await client.send('Debugger.pause').catch((e) => console.log('pause failed: ' + e.message));
await new Promise((r) => setTimeout(r, 2500));
if (!dumped) console.log('未捕获到暂停事件（可能主线程并非 JS 死循环，或被 GC/编译阻塞）');
console.log('ERRORS=' + (errs.length ? errs.join('\n') : 'none'));
await browser.close();
process.exit(0);
