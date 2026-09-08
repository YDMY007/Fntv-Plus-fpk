// scripts/pair-test.mjs — embyWall × 每个候选插件逐对测试：定位与 embyWall 打 MutationObserver 乒乓的插件。
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { build } from 'esbuild';
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = path.join(root, 'src/preload/plugins');
const CANDIDATES = fs.readdirSync(pluginsDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .filter((n) => !['titlebar', 'dialogUI', 'embyWall'].includes(n));

function buildPair(other, outfile) {
  const entry = `
import { installDiag } from './preload/web/diag';
import { runHooks, HookType } from './preload/core/hooks';
import './preload/plugins/embyWall';
import './preload/plugins/${other}';
installDiag();
function boot() { try { runHooks(HookType.OnReady); } catch (e) { console.error('boot failed', e); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
window.__FNTV_BOOT_DONE = true;
`;
  fs.writeFileSync(path.join(root, 'src/web-entry.pair.ts'), entry);
  return build({
    entryPoints: [path.join(root, 'src/web-entry.pair.ts')],
    bundle: true, format: 'iife', outfile,
    platform: 'browser', target: ['es2019'],
    alias: {
      electron: path.join(root, 'src/shim/electron.js'),
      fs: path.join(root, 'src/shim/node_fs.js'),
      path: path.join(root, 'src/shim/node_path.js'),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
}

async function isStuck(other, outfile) {
  await buildPair(other, outfile);
  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('.js')) route.fulfill({ path: outfile, contentType: 'text/javascript' });
    else route.fulfill({ path: path.join(root, 'demo/host.html'), contentType: 'text/html' });
  });
  let stuckHard = false;
  try {
    await page.goto('http://fntv.test/v/', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(3500);
    stuckHard = await Promise.race([
      page.evaluate(() => 1).then(() => false).catch(() => true),
      new Promise((r) => setTimeout(() => r(true), 1200)),
    ]);
  } catch { stuckHard = true; }
  await browser.close();
  return stuckHard;
}

const out1 = path.join(root, 'dist/pair-test.js');
console.log('embyWall 单独: 正常（基线）');
for (const other of CANDIDATES) {
  const stuckHard = await isStuck(other, out1);
  console.log(`embyWall + ${other}: ${stuck ? '卡死 ← 嫌疑' : '正常'}`);
}
fs.rmSync(path.join(root, 'src/web-entry.pair.ts'), { force: true });
process.exit(0);
