// Package admin —— Fntv-Plus 影视增强的管理页与设置 API。
//
// 管理页运行在 /app/fntvplus/admin/（fnOS 微应用环境，可加载官方 JS SDK 读系统语言/主题），
// 但本后端不依赖 SDK：管理页通过我们自己的 /app/fntvplus/api/settings 读写配置。
// 配置存于 TRIM_PKGETC/config.json（见 internal/config），反代注入逻辑实时读取总开关。
package admin

import (
	"encoding/json"
	"net/http"

	"fntvplus/internal/config"
)

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

// Page 返回极简设置页（增强总开关）。
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

// adminHTML 是设置页（纯前端，调用 /api/settings）。
const adminHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>影视 Plus 设置</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 20px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 16px 20px; margin-top: 16px; }
  label { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  input[type=checkbox] { width: 18px; height: 18px; }
  .hint { color: #888; font-size: 13px; margin-top: 8px; }
  .status { margin-left: auto; font-size: 13px; color: #2a8; }
</style>
</head>
<body>
  <h1>影视 Plus · 设置</h1>
  <div class="card">
    <label>
      <input type="checkbox" id="enh">
      <span>启用网页端增强（海报墙 / 轮播 / 沉浸式美化）</span>
      <span class="status" id="status"></span>
    </label>
    <div class="hint">关闭后反代完全透传，等价于原版飞牛影视。设置保存在 NAS 上，多设备共享。</div>
  </div>
  <script>
    const $ = (s) => document.querySelector(s);
    async function load() {
      try {
        const r = await fetch('/app/fntvplus/api/settings');
        const c = await r.json();
        $('#enh').checked = !!c.enhancement_enabled;
      } catch (e) { $('#status').textContent = '读取失败'; }
    }
    $('#enh').addEventListener('change', async (e) => {
      $('#status').textContent = '保存中…';
      try {
        await fetch('/app/fntvplus/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enhancement_enabled: e.target.checked })
        });
        $('#status').textContent = '已保存';
      } catch (err) { $('#status').textContent = '保存失败'; }
    });
    load();
  </script>
</body>
</html>`
