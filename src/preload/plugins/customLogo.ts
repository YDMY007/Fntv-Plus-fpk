// preload/plugins/customLogo.ts — 首页 Logo 自定义（网页版）
// ─────────────────────────────────────────────────────────────────────────────
// 替换 fnOS 首页顶部居中的「飞牛影视」标识。设置入口挂在设置面板「通用」卡
// （embyWall.ts 调 buildCustomLogoUI(container)）。与桌面版的差异：
//   · 预设 PNG 不走 fs——后端 /app/fntvplus/api/bridge/logos/<file>（Go embed，7 天缓存）
//   · 目标元素是 fnOS 原生首页 logo（非桌面自注入的 #tb-logo）——选择器试探单
//   · 仅首页应用（/v 或 /v/）；常驻 MO 守护防 React 重渲染冲掉
// 持久化：localStorage 'fntvLogo.custom' = {type:'default'|'preset'|'custom', presetId?}；
//   自定义上传 dataURL 存 'fntvLogo.customData'（原图 ≤1.5MB）。
// ─────────────────────────────────────────────────────────────────────────────
import { registerHook, HookType } from '../core/hooks';

const CHOICE_KEY = 'fntvLogo.custom';
const CUSTOM_DATA_KEY = 'fntvLogo.customData';
const LOGO_API_BASE = '/app/fntvplus/api/bridge/logos/';
const MARK_ATTR = 'data-fntv-logo-applied';
const ORIG_ATTR = 'data-fntv-logo-orig';

export interface LogoChoice { type: 'default' | 'preset' | 'custom'; presetId?: string; }
export interface PresetLogo { id: string; name: string; file: string; group: '国内平台' | '国际平台'; lightBody?: boolean; }

/** 内置预设清单（与后端 logos/ 目录一一对应；lightBody=官方形态即白色主体，深色背景更清晰）。 */
export const PRESETS: PresetLogo[] = [
  { id: 'cn_iqiyi', name: '爱奇艺', file: 'cn_iqiyi.png', group: '国内平台' },
  { id: 'cn_tencent', name: '腾讯视频', file: 'cn_tencent.png', group: '国内平台' },
  { id: 'cn_youku', name: '优酷', file: 'cn_youku.png', group: '国内平台' },
  { id: 'cn_mango', name: '芒果TV', file: 'cn_mango.png', group: '国内平台', lightBody: true },
  { id: 'cn_migu', name: '咪咕视频', file: 'cn_migu.png', group: '国内平台' },
  { id: 'cn_xigua', name: '西瓜视频', file: 'cn_xigua.png', group: '国内平台' },
  { id: 'cn_bilibili', name: '哔哩哔哩', file: 'cn_bilibili.png', group: '国内平台' },
  { id: 'intl_netflix', name: 'Netflix', file: 'intl_netflix.png', group: '国际平台' },
  { id: 'intl_disneyplus', name: 'Disney+', file: 'intl_disneyplus.png', group: '国际平台', lightBody: true },
  { id: 'intl_disney', name: 'Disney', file: 'intl_disney.png', group: '国际平台' },
  { id: 'intl_prime', name: 'Prime Video', file: 'intl_prime.png', group: '国际平台', lightBody: true },
  { id: 'intl_hbomax', name: 'HBO Max', file: 'intl_hbomax.png', group: '国际平台' },
  { id: 'intl_hbomax_word', name: 'HBO Max 字标', file: 'intl_hbomax_word.png', group: '国际平台', lightBody: true },
  { id: 'intl_hbo', name: 'HBO', file: 'intl_hbo.png', group: '国际平台' },
  { id: 'intl_appletv', name: 'Apple TV+', file: 'intl_appletv.png', group: '国际平台' },
  { id: 'intl_hulu', name: 'Hulu', file: 'intl_hulu.png', group: '国际平台', lightBody: true },
  { id: 'intl_peacock', name: 'Peacock', file: 'intl_peacock.png', group: '国际平台', lightBody: true },
  { id: 'intl_paramount', name: 'Paramount+', file: 'intl_paramount.png', group: '国际平台' },
  { id: 'intl_youtube', name: 'YouTube', file: 'intl_youtube.png', group: '国际平台' },
  { id: 'intl_spotify', name: 'Spotify', file: 'intl_spotify.png', group: '国际平台' },
  { id: 'intl_twitch', name: 'Twitch', file: 'intl_twitch.png', group: '国际平台' },
  { id: 'intl_crunchyroll', name: 'Crunchyroll', file: 'intl_crunchyroll.png', group: '国际平台' },
  { id: 'intl_vimeo', name: 'Vimeo', file: 'intl_vimeo.png', group: '国际平台' },
  { id: 'intl_dailymotion', name: 'Dailymotion', file: 'intl_dailymotion.png', group: '国际平台' },
];

/** 兼容桌面 titlebar 的导出（网页端 titlebar 不挂载，仅保签名）。 */
export function registerDefaultLogo(_uri: string): void { /* 网页端默认=fnOS 原生元素原样，无需登记 */ }

export function getChoice(): LogoChoice {
  try {
    const raw = localStorage.getItem(CHOICE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c && (c.type === 'preset' || c.type === 'custom' || c.type === 'default')) return c;
    }
  } catch { /* ignore */ }
  return { type: 'default' };
}

export function setChoice(c: LogoChoice): void {
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

export function resolveLogoSrc(): string {
  const c = getChoice();
  if (c.type === 'custom') {
    try { return localStorage.getItem(CUSTOM_DATA_KEY) || ''; } catch { return ''; }
  }
  if (c.type === 'preset' && c.presetId) {
    const p = PRESETS.find((x) => x.id === c.presetId);
    if (p) return LOGO_API_BASE + p.file;
  }
  return '';
}

/** 首页判定：裸 /v 或 /v/ */
function isHomePage(): boolean {
  return /^\/v\/?$/.test(location.pathname || '');
}

/** 首页 fnOS 原生 logo 定位（[v0.93.0] 重写）：
 *  限定首页顶部区域（top<160px）+ 「飞牛」特征（alt/title/src 含 飞牛/logo/brand），
 *  上一版宽泛试探单（header img/table img）会误中头像等无关图片（用户实测"功能有问题"）。
 *  返回 {el, isImg}：img 直接换 src；文字版 logo 换 innerHTML。 */
function findHomeLogo(): { el: HTMLElement; isImg: boolean } | null {
  const scope = document.querySelectorAll('img, [class*="logo" i], [alt*="logo" i], [title*="logo" i]');
  let fallbackText: HTMLElement | null = null;
  for (const node of Array.from(scope)) {
    const el = node as HTMLElement;
    if (!el.getBoundingClientRect || !el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top > 160 || rect.width < 8 || rect.width > 600) continue;
    const tag = el.tagName.toLowerCase();
    const attrs = ((el.getAttribute('alt') || '') + ' ' + (el.getAttribute('title') || '') + ' '
      + (el.getAttribute('src') || '') + ' ' + (el.className || '')).toLowerCase();
    if (tag === 'img') {
      if (/飞牛|fnos|logo|brand/.test(attrs)) return { el, isImg: true };
      // 顶部区域的孤立 img 且明显是标识（宽<300 高<80）→ 弱匹配兜底
      if (rect.height <= 80 && !el.closest('a')) fallbackText = fallbackText || el;
    } else if ((el.textContent || '').includes('飞牛影视')) {
      fallbackText = fallbackText || el;
    }
  }
  // 文字版兜底：找包含「飞牛影视」的最小元素（含该文本的最深层节点）
  if (!fallbackText) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '');
      if (t.includes('飞牛影视')) {
        const pe = n.parentElement;
        if (pe) {
          const r = pe.getBoundingClientRect();
          if (r.top <= 160 && r.width < 600) fallbackText = pe;
        }
        break;
      }
    }
  }
  return fallbackText ? { el: fallbackText, isImg: fallbackText.tagName.toLowerCase() === 'img' } : null;
}

/** 应用当前选择到首页 logo（首次替换记原始内容，恢复默认时还原）。 */
function applyLogo(): void {
  if (!isHomePage()) return;
  const found = findHomeLogo();
  if (!found) {
    const w = window as any;
    if (!w.__fntvLogoHintShown) {
      w.__fntvLogoHintShown = true;
      console.log('[customLogo] 未定位到首页 Logo——请在 F12 选中该 Logo 元素复制 outerHTML 发给开发者以精确适配');
    }
    return;
  }
  const el = found.el;
  const src = resolveLogoSrc();
  if (!src) {
    // 恢复默认：还原首次替换前保存的原始内容
    const orig = el.getAttribute(ORIG_ATTR);
    if (orig) {
      if (found.isImg) el.setAttribute('src', orig);
      else el.innerHTML = orig;
    }
    el.removeAttribute(MARK_ATTR);
    return;
  }
  if (found.isImg) {
    if (!el.getAttribute(ORIG_ATTR)) el.setAttribute(ORIG_ATTR, el.getAttribute('src') || '');
    if (el.getAttribute('src') === src) return; // 已是目标图，防 MO 循环
    el.setAttribute('src', src);
  } else {
    if (!el.getAttribute(ORIG_ATTR)) el.setAttribute(ORIG_ATTR, el.innerHTML);
    if (el.getAttribute(MARK_ATTR) === '1') return;
    el.innerHTML = '<img src="' + src + '" alt="飞牛影视" style="height:30px;width:auto;object-fit:contain;display:block;pointer-events:none">';
  }
  el.setAttribute(MARK_ATTR, '1');
}

/** 通用卡内嵌 UI（embyWall 设置面板「通用」卡调用）：分组预设 chips + 自定义上传 + 恢复默认。 */
export function buildCustomLogoUI(container: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-fnos-ui', '1');
  wrap.style.cssText = 'margin-top:18px;padding-top:10px;border-top:1px solid var(--fnos-ui-border2);';

  const title = document.createElement('div');
  title.textContent = '首页 Logo';
  title.style.cssText = 'font-size:10.5px;font-weight:600;color:var(--fnos-ui-sec);margin-bottom:4px;';
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
  hint.textContent = '替换首页顶部居中的「飞牛影视」标识（仅首页显示）。点选预设立即生效；或上传自己的图片（≤1.5MB）。⬛ = 白色主体，深色背景更清晰。';

  const groups: Array<['国内平台' | '国际平台', PresetLogo[]]> = [
    ['国内平台', PRESETS.filter((p) => p.group === '国内平台')],
    ['国际平台', PRESETS.filter((p) => p.group === '国际平台')],
  ];
  const renderChips = (): void => {
    wrap.querySelectorAll('.fntv-logo-chips').forEach((n) => n.remove());
    for (const [gname, list] of groups) {
      const gLabel = document.createElement('div');
      gLabel.textContent = gname;
      gLabel.style.cssText = 'font-size:10px;color:var(--fnos-ui-sec);margin:6px 0 4px;';
      wrap.appendChild(gLabel);
      const chips = document.createElement('div');
      chips.className = 'fntv-logo-chips';
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      const choice = getChoice();
      for (const p of list) {
        const chip = document.createElement('button');
        chip.type = 'button';
        const active = choice.type === 'preset' && choice.presetId === p.id;
        chip.style.cssText = 'padding:4px 10px;border-radius:7px;font-size:11px;cursor:pointer;'
          + (active
            ? 'background:var(--fnos-ui-accent);color:#fff;border:1px solid var(--fnos-ui-accent);'
            : 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);');
        chip.textContent = p.name + (p.lightBody ? ' ⬛' : '');
        if (p.lightBody) chip.title = '白色主体 Logo，深色背景更清晰';
        chip.addEventListener('click', () => {
          setChoice({ type: 'preset', presetId: p.id });
          applyLogo();
          renderChips();
        });
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
    }
  };

  const ops = document.createElement('div');
  ops.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
  const mkOp = (label: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'padding:5px 12px;border-radius:7px;font-size:11px;cursor:pointer;'
      + 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);';
    return b;
  };
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/webp,image/jpeg,image/svg+xml';
  fileInput.style.display = 'none';
  const uploadBtn = mkOp('上传自定义图片');
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > 1.5 * 1024 * 1024) {
      hint.textContent = '图片超过 1.5MB，请压缩后重试。';
      fileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      try {
        localStorage.setItem(CUSTOM_DATA_KEY, dataUrl);
      } catch {
        hint.textContent = '图片过大，本地存储写入失败，请压缩后重试。';
        return;
      }
      setChoice({ type: 'custom' });
      applyLogo();
      renderChips();
      hint.textContent = '已应用自定义 Logo。';
      fileInput.value = '';
    };
    reader.readAsDataURL(f);
  });
  const resetBtn = mkOp('恢复默认（飞牛影视）');
  resetBtn.addEventListener('click', () => {
    setChoice({ type: 'default' });
    applyLogo();
    renderChips();
    hint.textContent = '已恢复默认「飞牛影视」标识。';
  });
  ops.appendChild(uploadBtn);
  ops.appendChild(resetBtn);
  ops.appendChild(fileInput);

  wrap.appendChild(title);
  wrap.appendChild(hint);
  wrap.appendChild(ops);
  container.appendChild(wrap);
  renderChips();
}

registerHook(HookType.OnReady, () => { applyLogo(); });
registerHook(HookType.OnDomChange, () => { applyLogo(); });

export {};
