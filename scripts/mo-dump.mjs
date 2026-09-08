// scripts/mo-dump.mjs — 主线程被 MutationObserver 自激卡死时，dump 触发它的 mutation records。
import path from 'path';
import { fileURLToPath } from 'url';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostPage = path.join(root, 'demo/host.html');
const payload = process.argv[2] || path.join(root, 'dist/fntv-plus.user.js');

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const client = await page.context().newCDPSession(page);
await client.send('Debugger.enable');
let dumped = false;
client.on('Debugger.paused', async (ev) => {
  if (dumped || ev.reason !== 'other' && ev.reason !== 'debugCommand') return;
  const top = ev.callFrames[0];
  const name = top?.functionName || '(anonymous)';
  if (ev.reason === 'debugCommand') {
    // 由 debugger 语句触发，才 dump
  }
  dumped = true;
  console.log('=== 自激点: ' + name + ' @ line ' + (top?.location.lineNumber + 1));
});

await page.addInitScript(() => {
  const OrigMO = window.MutationObserver;
  window.__MO = [];
  let created = 0;
  const desc = (n) => {
    if (!n) return 'null';
    const cls = (n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className) || '';
    return (n.nodeName || '?') + (n.id ? '#' + n.id : '') + (cls ? '.' + String(cls).slice(0, 30) : '');
  };
  const chain = (n) => {
    const out = [];
    let e = n;
    for (let i = 0; i < 3 && e; i++) { out.push(desc(e)); e = e.parentElement; }
    return out.join(' < ');
  };
  function Patched(cb) {
    const myIdx = created++;
    let calls = 0;
    const createdAt = (new Error().stack || '').split('\n').slice(1, 4).join(' | ');
    const obs = new OrigMO(function (recs, o) {
      const n = ++calls;
      if (n < 3 || n === 40) {
        const brief = recs.slice(0, 3).map((r) => ({
          tgt: chain(r.target),
          add: Array.from(r.addedNodes).slice(0, 3).map(desc),
          rem: Array.from(r.removedNodes).slice(0, 3).map(desc),
        }));
        console.log('MO[o' + myIdx + ']#' + n + ' ' + JSON.stringify(brief));
      }
      if (n === 40) { console.log('MO_SELF_LOOP o' + myIdx + ' created@ ' + createdAt); debugger; }
      return cb(recs, o);
    });
    return obs;
  }
  Patched.prototype = OrigMO.prototype;
  window.MutationObserver = Patched;
});

page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('MO[o') || t.startsWith('MO_SELF_LOOP')) console.log(t.slice(0, 600));
});

await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.endsWith('.js')) route.fulfill({ path: payload, contentType: 'text/javascript' });
  else route.fulfill({ path: hostPage, contentType: 'text/html' });
});
page.goto('http://fntv.test/v/', { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 6000));
await browser.close();
process.exit(0);
