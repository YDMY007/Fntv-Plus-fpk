// src/preload/web/playSync.ts — 网页端 Bangumi 同步触发器（[v0.50.0] 新增）。
// ─────────────────────────────────────────────────────────────────────────────
// 桌面版的豆瓣/Bangumi 同步挂在主进程 media.ts 的 MPV 进度事件上；网页端「原生网页
// 播放」没有 MPV，fnOS 原生前端自己向上报进度——此前双同步在网页端完全没有触发点。
//
// 做法：包装页面 fetch/XHR，拦截 fnOS 原生前端发出的 POST /v/api/v1/play/record
// （浏览器自动携带全部会话 cookie 含 httpOnly，鉴权天然可靠），从请求体提取
// item_guid/ts/duration → 前端直连 /v/api/v1/play/info 拿条目元数据（同源+本地签名）→
// invoke('bangumi:sync-progress', guid, percentage, item) 交给后端标 Bangumi
// （后端用 token 调 bgm.tv，不依赖 fnOS cookie）。
// 豆瓣同步需要豆瓣账号 cookie，网页端无登录途径，暂不实现。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import logger from '../core/logger';

const log = logger.component('play-sync');

// 会话级去重（与桌面版 markedSet/missSet 同语义；重启后重置，Bangumi 端重复标「看过」幂等无害）
const marked = new Set<string>();
const missed = new Set<string>();
// 桌面版白名单（fn_api/types.ts SYNCABLE_ITEM_TYPES）
const SYNCABLE = ['Movie', 'Episode', 'TvSeries', 'TV'];

let _lastFire = 0;

/** 前端直连 play/info（同源 fetch 全 cookie + 本地 genAuthx 签名，lc-057 已验证路径） */
async function fetchPlayInfo(guid: string): Promise<any | null> {
  try {
    const path = '/v/api/v1/play/info';
    const payload = { item_guid: guid };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', path, payload);
    const resp = await fetch(location.origin + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Authx': authx, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return null;
    const j: any = await resp.json();
    return (j && j.data && j.data.item) ? j.data.item : null;
  } catch {
    return null;
  }
}

/** 处理一次 play/record 上报体 */
function handleRecord(body: any): void {
  try {
    if (!body || typeof body !== 'object') return;
    const guid = String(body.item_guid || body.itemGuid || '');
    const ts = Number(body.ts || 0);
    const duration = Number(body.duration || 0);
    if (!guid || !(ts > 0) || !(duration > 0)) return;
    const percentage = Math.min(100, (ts / duration) * 100);
    if (percentage < 5) return; // 开播前百分比恒 0，跳过（桌面 media.ts 同款语义）
    if (marked.has(guid) || missed.has(guid)) return; // 去重
    const now = Date.now();
    if (now - _lastFire < 3000) return; // 全局节流，防上报风暴
    _lastFire = now;

    void (async () => {
      const item = await fetchPlayInfo(guid);
      if (!item) { missed.add(guid); return; }
      const type = String(item.type || '');
      if (!SYNCABLE.includes(type)) { missed.add(guid); return; } // 直播/其他视频不同步
      try {
        const r: any = await ipcRenderer.invoke('bangumi:sync-progress', guid, percentage, item);
        if (r && r.ok && String(r.message || '').includes('已标记')) {
          marked.add(guid);
          log.info('[play-sync]', String(r.message), `（${Math.floor(percentage)}%）`);
        } else if (r && !r.ok) {
          // 未达阈值/未开启/未配 Token：不记 miss（后续上报还会到达阈值；用户可能随时开启）
          const msg = String((r && r.message) || '');
          if (msg.indexOf('未达阈值') === -1 && msg.indexOf('未开启') === -1 && msg.indexOf('Token') === -1) {
            missed.add(guid);
          }
        }
      } catch {
        /* invoke 异常忽略，下次上报再试 */
      }
    })();
  } catch {
    /* ignore */
  }
}

/** 包装页面 fetch/XHR，监听 /v/api/v1/play/record 上报（diag 之后再挂一层，纯透传不改变行为） */
export function installPlayRecordHook(): void {
  try {
    const origFetch = window.fetch;
    window.fetch = function (input: any, init?: any) {
      try {
        const url = typeof input === 'string' ? input : ((input && input.url) || '');
        if (init && String(init.method || '').toUpperCase() === 'POST'
          && String(url).indexOf('/v/api/v1/play/record') !== -1 && init.body) {
          try {
            handleRecord(typeof init.body === 'string' ? JSON.parse(init.body) : init.body);
          } catch { /* body 非 JSON 忽略 */ }
        }
      } catch { /* ignore */ }
      return origFetch.call(this, input, init);
    };
    // XHR 兜底（fnOS 原生前端若用 XHR 上报）
    const XOpen = XMLHttpRequest.prototype.open as any;
    const XSend = XMLHttpRequest.prototype.send as any;
    (XMLHttpRequest.prototype as any).open = function (this: any, method: string, url: string, ...rest: any[]) {
      try {
        (this as any).__fntvMethod = String(method || '');
        (this as any).__fntvUrl = String(url || '');
      } catch { /* ignore */ }
      return XOpen.apply(this, [method, url, ...rest] as any);
    };
    (XMLHttpRequest.prototype as any).send = function (this: any, body?: any) {
      try {
        if (body && typeof body === 'string'
          && (this as any).__fntvMethod === 'POST'
          && String((this as any).__fntvUrl || '').indexOf('/v/api/v1/play/record') !== -1) {
          handleRecord(JSON.parse(body));
        }
      } catch { /* ignore */ }
      return XSend.apply(this, [body] as any);
    };
    log.info('[play-sync] play/record 拦截已挂载（网页端 Bangumi 同步触发器）');
  } catch (e) {
    logger.error('[play-sync] 挂载失败', String(e));
  }
}

installPlayRecordHook(); // 模块加载即自动安装（与 diag 同款，先于所有插件）
