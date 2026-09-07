// scripts/smoke.mjs — 注入后冒烟测试：确认复用的 payload 能加载、boot、且不抛错。
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const { chromium } = pw;

const URL = process.env.URL || 'http://localhost:8137/demo/host.html';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE.ERR: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const boot = await page.evaluate(() => typeof window.__FNTV_BOOT__);
const homepage = await page.evaluate(() => !!document.querySelector('#homePage'));
const injected = await page.evaluate(() => !!document.querySelector('style[id^="fntv"], style[id*="embywall"], style[id*="EmbyWall"]'));

console.log('BOOT_TYPE=' + boot);
console.log('HOMEPAGE_PRESENT=' + homepage);
console.log('STYLE_INJECTED=' + injected);
console.log('ERRORS=' + (errors.length ? '\n' + errors.join('\n') : 'none'));

await browser.close();
process.exit(errors.length ? 1 : 0);
