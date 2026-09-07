// Package admin —— Fntv-Plus 影视增强的管理页与设置 API。
//
// 管理页运行在 /app/fntvplus/admin/（fnOS 微应用环境，可加载官方 JS SDK 读系统语言/主题），
// 但本后端不依赖 SDK：管理页通过我们自己的 /app/fntvplus/api/* 读写配置/状态/日志。
// 配置存于 TRIM_PKGETC/config.json（见 internal/config），反代注入逻辑实时读取总开关。
package admin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"fntvplus/internal/config"
	"fntvplus/internal/inject"
)

// Info 是状态/日志 API 所需的运行时信息（由 cmd 装配层注入）。
type Info struct {
	Version  string // 应用版本（与 manifest version 保持一致）
	VarDir   string // TRIM_PKGVAR，运行时目录（fntvplus.log 所在）
	Upstream string // 回环上游地址（如 http://127.0.0.1:5666）
	Injector *inject.Injector
}

// SettingsAPI 处理 GET（读配置）/ POST（改配置）。
func SettingsAPI(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, cfg.Get())
		case http.MethodPost:
			var patch map[string]any
			if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
				return
			}
			if err := cfg.Update(patch); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, cfg.Get())
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

// StatusAPI 返回运行自检信息：版本 / 上游连通性 / payload 哈希 / 增强开关 / 日志路径。
func StatusAPI(cfg *config.Config, info Info) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		upstreamOK := false
		if info.Upstream != "" {
			client := &http.Client{Timeout: 2 * time.Second}
			if resp, err := client.Get(strings.TrimRight(info.Upstream, "/") + "/v/"); err == nil {
				upstreamOK = resp.StatusCode < 500
				_ = resp.Body.Close()
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"version":             info.Version,
			"upstream":            info.Upstream,
			"upstream_ok":         upstreamOK,
			"enhancement_enabled": cfg.Get().EnhancementEnabled,
			"payload_hash":        info.Injector.Hash(),
			"payload_bytes":       info.Injector.Len(),
			"log_file":            filepath.Join(info.VarDir, "fntvplus.log"),
			"now":                 time.Now().Format(time.RFC3339),
		})
	}
}

// LogsAPI 返回 fntvplus.log 尾部内容（?lines=N，默认 300，最大 2000）。
func LogsAPI(info Info) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		lines := 300
		if v := r.URL.Query().Get("lines"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				lines = n
			}
		}
		if lines > 2000 {
			lines = 2000
		}
		logPath := filepath.Join(info.VarDir, "fntvplus.log")
		data, err := tailFile(logPath, 512*1024)
		if err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("(暂无日志: " + err.Error() + ")"))
			return
		}
		all := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
		if len(all) > lines {
			all = all[len(all)-lines:]
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(strings.Join(all, "\n")))
	}
}

// tailFile 读取文件末尾 maxBytes 字节（丢弃被截断的首行残段）。
func tailFile(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	offset := int64(0)
	if st.Size() > maxBytes {
		offset = st.Size() - maxBytes
	}
	buf := make([]byte, st.Size()-offset)
	if _, err := f.ReadAt(buf, offset); err != nil {
		return nil, err
	}
	if offset > 0 {
		// 丢弃首行残段
		if i := strings.IndexByte(string(buf), '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	return buf, nil
}

// Page 返回极简管理页（增强总开关 + 运行状态 + 实时日志）。
func Page(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(adminHTML))
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// adminHTML 是管理页（纯前端，调用 /app/fntvplus/api/*）。
const adminHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>影视 Plus 设置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #888; font-size: 13px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 16px 20px; margin-top: 16px; }
  label { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  input[type=checkbox] { width: 18px; height: 18px; }
  .hint { color: #888; font-size: 13px; margin-top: 8px; }
  .status { margin-left: auto; font-size: 13px; color: #2a8; }
  table { width: 100%; font-size: 13px; border-collapse: collapse; }
  td { padding: 4px 0; }
  td.k { color: #888; width: 110px; vertical-align: top; }
  .ok { color: #2a8; font-weight: 600; }
  .bad { color: #c44; font-weight: 600; }
  pre { background: #8881; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.5;
        max-height: 380px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 8px 0 0; }
  .row { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
  button { padding: 4px 12px; border-radius: 8px; border: 1px solid #8886; background: transparent; cursor: pointer; }
  button.on { border-color: #2a8; color: #2a8; }
  select { padding: 3px 6px; }
</style>
</head>
<body>
  <h1>影视 Plus · 设置</h1>
  <div class="sub">版本 <span id="v">-</span> · payload <span id="ph">-</span></div>

  <div class="card">
    <label>
      <input type="checkbox" id="enh">
      <span>启用网页端增强（海报墙 / 轮播 / 沉浸式美化）</span>
      <span class="status" id="status"></span>
    </label>
    <div class="hint">关闭后反代完全透传，等价于原版飞牛影视。设置保存在 NAS 上，多设备共享。</div>
  </div>

  <div class="card">
    <b style="font-size:14px">运行状态</b> <span style="font-size:12px;color:#888">每 5 秒自动刷新</span>
    <table style="margin-top:8px">
      <tr><td class="k">影视上游</td><td><span id="up">-</span></td></tr>
      <tr><td class="k">上游地址</td><td id="upurl">-</td></tr>
      <tr><td class="k">日志文件</td><td id="logfile">-</td></tr>
    </table>
    <div class="hint">「影视上游」不通 = 后端连不上飞牛影视网页服务，注入不会生效（多半是上游端口推导错了，可在 NAS 上设置环境变量 FNTV_UPSTREAM 修正）。</div>
  </div>

  <div class="card">
    <div class="row">
      <b style="font-size:14px">实时日志</b>
      <select id="lines"><option>100</option><option selected>300</option><option>1000</option></select>
      <label style="gap:4px"><input type="checkbox" id="auto" checked> 自动刷新</label>
      <button id="refresh">刷新</button>
    </div>
    <pre id="log">加载中…</pre>
  </div>

  <script>
    const $ = (s) => document.querySelector(s);
    const API = '/app/fntvplus/api';

    async function loadSettings() {
      try {
        const c = await (await fetch(API + '/settings')).json();
        $('#enh').checked = !!c.enhancement_enabled;
      } catch (e) { $('#status').textContent = '读取失败'; }
    }
    $('#enh').addEventListener('change', async (e) => {
      $('#status').textContent = '保存中…';
      try {
        await fetch(API + '/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enhancement_enabled: e.target.checked })
        });
        $('#status').textContent = '已保存';
      } catch (err) { $('#status').textContent = '保存失败'; }
    });

    async function loadStatus() {
      try {
        const s = await (await fetch(API + '/status')).json();
        $('#v').textContent = s.version || '-';
        $('#ph').textContent = (s.payload_hash || '-') + ' (' + Math.round((s.payload_bytes||0)/1024) + 'KB)';
        $('#up').innerHTML = s.upstream_ok ? '<span class="ok">连通 ✓</span>' : '<span class="bad">不通 ✗</span>';
        $('#upurl').textContent = s.upstream || '-';
        $('#logfile').textContent = s.log_file || '-';
      } catch (e) { $('#up').innerHTML = '<span class="bad">状态读取失败</span>'; }
    }

    async function loadLogs() {
      try {
        const t = await (await fetch(API + '/logs?lines=' + $('#lines').value)).text();
        const pre = $('#log');
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = t;
        if (stick) pre.scrollTop = pre.scrollHeight;
      } catch (e) { $('#log').textContent = '日志读取失败: ' + e; }
    }

    $('#refresh').addEventListener('click', () => { loadStatus(); loadLogs(); });
    $('#lines').addEventListener('change', loadLogs);

    loadSettings(); loadStatus(); loadLogs();
    setInterval(loadStatus, 5000);
    setInterval(() => { if ($('#auto').checked) loadLogs(); }, 5000);
  </script>
</body>
</html>`
