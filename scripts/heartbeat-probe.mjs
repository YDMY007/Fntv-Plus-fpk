// scripts/heartbeat-probe.mjs — 全量 payload 加载后探测主线程心跳：
// 连续 evaluate('1') 判断 main thread 是否被同步代码卡死。
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payload = path.join(root, 'dist/fntv-plus.user.js');
const hostPage = path.join(root, 'demo/host.html');

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join('|').substring(0, 200)));
await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.endsWith('.js')) route.fulfill({ path: payload, contentType: 'text/javascript' });
  else route.fulfill({ path: hostPage, contentType: 'text/html' });
});
await page.goto('http://fntv.test/v/', { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  const ok = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), 800)),
  ]);
  console.log(`心跳${i + 1}: ${ok ? '活' : '卡'} (${Date.now() - t0}ms)`);
  await new Promise((r) => setTimeout(r, 400));
}
const ready = await Promise.race([
  page.evaluate(() => document.readyState).catch(() => 'EVAL_FAIL'),
  new Promise((r) => setTimeout(() => r('TIMEOUT'), 2000)),
]);
console.log('readyState=' + ready);
console.log('ERRORS=' + (errs.length ? '\n' + errs.join('\n') : 'none'));
await browser.close();
