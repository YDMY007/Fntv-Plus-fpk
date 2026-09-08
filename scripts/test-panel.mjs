// scripts/test-panel.mjs — 设置面板回归：route 拦截喂 host.html + payload（无端口依赖）→
// 点侧栏设置按钮 → 断言面板挂载/分类 pane 数量，收集全部页面错误。
// 用法：node scripts/test-panel.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostPage = path.join(root, 'demo/host.html');
const payload = path.join(root, 'dist/fntv-plus.user.js');

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join('|').substring(0, 250)));
// boot() 内部 try/catch 会 console.error，不会冒到 pageerror —— 必须一并收集
const warnLogs = [];
page.on('console', (m) => {
  const txt = m.text();
  if (m.type() === 'error') errs.push('CONSOLE.ERROR: ' + txt.substring(0, 400));
  // seg() 分段回填的失败只走 log()，不冒到 error —— 用它发现孤儿引用/静默失败
  if (/failed|not defined|is not a function|undefined/i.test(txt) && !/404/.test(txt)) {
    if (warnLogs.length < 10) warnLogs.push('WARN: ' + txt.substring(0, 220));
  }
});

await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.endsWith('.js')) route.fulfill({ path: payload, contentType: 'text/javascript' });
  else route.fulfill({ path: hostPage, contentType: 'text/html' });
});

await page.goto('http://fntv.test/v/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4500);

console.log('SETTINGS_BTN=' + await page.evaluate(() => !!document.getElementById('fnos-settings-btn')));
await page.evaluate(() => document.getElementById('fnos-settings-btn')?.click());
await page.waitForTimeout(3000);
console.log('PANEL_MOUNTED=' + await page.evaluate(() => !!document.getElementById('fnos-settings-panel')));
console.log('PANEL_DISPLAY=' + await page.evaluate(() => {
  const p = document.getElementById('fnos-settings-panel');
  return p ? getComputedStyle(p).display : 'no-panel';
}));
console.log('PANEL_BOX=' + await page.evaluate(() => {
  const p = document.getElementById('fnos-settings-panel');
  if (!p) return 'no-panel';
  const r = p.getBoundingClientRect();
  return Math.round(r.width) + 'x' + Math.round(r.height);
}));
console.log('PANE_COUNT=' + await page.evaluate(() => document.querySelectorAll('#fnos-settings-panel [data-cat]').length));
console.log('MASK_DISPLAY=' + await page.evaluate(() => {
  const m = document.getElementById('fnos-settings-mask');
  return m ? getComputedStyle(m).display : 'no-mask';
}));
// 外观卡「首页轮播图样式」切换（v0.12.0 精简时误删，v0.37.0 补回）
// 外观卡「剧集详情页美化」开关（同批被误删，一并补回）
console.log('BEAUTIFY_TOGGLE=' + await page.evaluate(() => {
  const el = document.getElementById('fnos-sw-beautify');
  return el ? 'present, checked=' + el.checked : 'missing';
}));
console.log('CAROUSEL_STYLE_SEG=' + await page.evaluate(() => {
  const seg = document.getElementById('fnos-carousel-style-seg');
  if (!seg) return 'missing';
  const cur = localStorage.getItem('fnos-carousel-style') || '4(default)';
  return seg.querySelectorAll('button').length + ' buttons, current=' + cur;
}));
// 点击第 2 个（横向轮播）应写入 localStorage（放在最后：点击会触发整页跳转）
console.log('CAROUSEL_STYLE_CLICK=' + await page.evaluate(() => {
  const seg = document.getElementById('fnos-carousel-style-seg');
  if (!seg) return 'no-seg';
  const before = localStorage.getItem('fnos-carousel-style') || '4';
  seg.querySelectorAll('button')[1].click();
  return before + ' -> ' + (localStorage.getItem('fnos-carousel-style') || '4');
}));
console.log('ERRORS=' + (errs.length ? '\n' + errs.join('\n') : 'none'));
console.log('WARN_LOGS=' + (warnLogs.length ? '\n' + warnLogs.join('\n') : 'none'));
await browser.close();
process.exit(errs.length ? 1 : 0);
