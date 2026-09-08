// scripts/bisect-plugins.mjs — 二分定位：哪个插件在 /v/ 页面初始化时阻塞主线程。
// 每轮动态生成 entry（diag + 插件子集静态 import）→ esbuild 打包 → route 加载 →
// 5s 内 BOOT 挂载判定通过/卡死。用法：node scripts/bisect-plugins.mjs [插件名...]
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { build } from 'esbuild';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = path.join(root, 'src/preload/plugins');

const ALL = fs.readdirSync(pluginsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .filter((n) => !['titlebar', 'dialogUI'].includes(n));

const only = process.argv.slice(2);
const LIST = only.length ? ALL.filter((n) => only.includes(n)) : ALL;
console.log('插件池(' + LIST.length + '): ' + LIST.join(', '));

function buildSubset(subset, outfile) {
  const imports = subset.map((n) => `import './preload/plugins/${n}';`).join('\n');
  const entry = `
import { installDiag } from './preload/web/diag';
import { runHooks, HookType } from './preload/core/hooks';
installDiag();
${imports}
function boot() { try { runHooks(HookType.OnReady); } catch (e) { console.error('boot failed', e); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
window.__FNTV_BOOT_DONE = true;
`;
  const tmpEntry = path.join(root, 'src/web-entry.bisect.ts');
  fs.writeFileSync(tmpEntry, entry);
  return build({
    entryPoints: [tmpEntry],
    bundle: true,
    format: 'iife',
    outfile,
    platform: 'browser',
    target: ['es2019'],
    alias: {
      electron: path.join(root, 'src/shim/electron.js'),
      fs: path.join(root, 'src/shim/node_fs.js'),
      path: path.join(root, 'src/shim/node_path.js'),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
}

async function check(outfile) {
  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let bootOk = false;
  page.on('console', (m) => { if (m.text().includes('hooks fired')) bootOk = true; });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('.js')) route.fulfill({ path: outfile, contentType: 'text/javascript' });
    else route.fulfill({ path: path.join(root, 'demo/host.html'), contentType: 'text/html' });
  });
  try {
    await page.goto('http://fntv.test/v/', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(4000);
  } catch {
    await browser.close();
    return { ok: false, reason: 'domcontentloaded 超时（同步阻塞）' };
  }
  const state = await Promise.race([
    page.evaluate(() => ({ boot: typeof window.__FNTV_BOOT__, btn: !!document.getElementById('fnos-settings-btn') })),
    new Promise((r) => setTimeout(() => r({ ok: false, reason: 'evaluate 超时（主线程卡死）' }), 5000)),
  ]).catch(() => ({ ok: false, reason: 'evaluate 异常' }));
  await browser.close();
  if (state && state.ok === false) return state;
  return { ok: true, boot: state.boot, btn: state.btn };
}

// 全量基线
const full = path.join(root, 'dist/bisect-full.js');
await buildSubset(LIST, full);
const fullRes = await check(full);
console.log('全量基线: ' + JSON.stringify(fullRes));
if (fullRes.ok) {
  console.log('全量不卡 → 问题在别处（可能需真实环境）');
  process.exit(0);
}

// 逐个排除定位
const culprits = [];
for (const suspect of LIST) {
  const subset = LIST.filter((n) => n !== suspect);
  const out = path.join(root, 'dist/bisect-one.js');
  await buildSubset(subset, out);
  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let pass = false;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('.js')) route.fulfill({ path: out, contentType: 'text/javascript' });
    else route.fulfill({ path: path.join(root, 'demo/host.html'), contentType: 'text/html' });
  });
  try {
    await page.goto('http://fntv.test/v/', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(4000);
    pass = await page.evaluate(() => typeof window.__FNTV_BOOT__ === 'function');
  } catch { pass = true; } // 还卡 → 排除该插件后仍卡
  await browser.close();
  console.log('排除 ' + suspect + ' → ' + (pass ? '恢复正常 ← 嫌疑插件' : '仍卡'));
  if (pass) culprits.push(suspect);
}
console.log('嫌疑插件: ' + (culprits.join(', ') || '(未定位到单个，需组合分析)'));
process.exit(0);
