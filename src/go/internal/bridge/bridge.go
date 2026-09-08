// Package bridge —— 网页端服务桥：把桌面版主进程的网络能力搬到飞牛后端。
//
// 桌面版的账号同步/外部 API 依赖 Electron 主进程（Node axios + config 持久化）；
// FPK 网页端没有主进程，由本包在 Go 后端提供等价能力：
//
//	POST /app/fntvplus/api/bridge/fnos        通用 fnOS 签名桥（本地 Authx 签名 + 浏览器 cookie 转发）
//	POST /app/fntvplus/api/bridge/proxy       白名单外部代理（trakt/bgm/tmdb/douban 等域，解决 CORS）
//	GET  /app/fntvplus/api/bridge/tmdb/img    TMDB 图片代理（image.tmdb.org 直出）
//	POST /app/fntvplus/api/bridge/trakt/*     Trakt 设备授权/凭证/scrobble/同步
//	GET  /app/fntvplus/api/bridge/bangumi/calendar  Bangumi 日历
//	POST /app/fntvplus/api/bridge/douban/status     豆瓣登录状态（网页端暂未适配登录）
//
// 安全边界：proxy 域名白名单；fnOS 桥只接受 /v/api/ 开头的路径；cookie 由前端显式转发。
package bridge

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"time"

	"fntvplus/internal/config"
)

const authxKey = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"
const authxSecret = "16CCEB3D-AB42-077D-36A1-F355324E4237"

// 白名单后缀：proxy 只放行这些外部域（含子域）。
var proxyAllowSuffix = []string{
	"trakt.tv", "api.trakt.tv", "auth.trakt.tv",
	"bgm.tv", "api.bgm.tv",
	"themoviedb.org", "api.themoviedb.org", "image.tmdb.org",
	"douban.com", "movie.douban.com", "frodo.douban.com",
	"wj.qq.com", "qm.qq.com", "github.com",
}

// Bridge 持有配置与上游地址。
type Bridge struct {
	cfg      *config.Config
	upstream string
	client   *http.Client
}

// New 构造 Bridge。
func New(cfg *config.Config, upstream string) *Bridge {
	return &Bridge{
		cfg:      cfg,
		upstream: strings.TrimRight(upstream, "/"),
		client:   &http.Client{Timeout: 20 * time.Second},
	}
}

// Mount 注册全部 bridge 路由。
func (b *Bridge) Mount(mux *http.ServeMux) {
	mux.HandleFunc("/app/fntvplus/api/bridge/fnos", b.handleFnOS)
	mux.HandleFunc("/app/fntvplus/api/bridge/proxy", b.handleProxy)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/img", b.handleTMDBImage)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/logo", b.tmdbLogo)
	mux.HandleFunc("/app/fntvplus/api/bridge/tmdb/show", b.tmdbShow)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/credentials", b.traktCredsHandler())
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/status", b.traktStatusHandler())
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/device/start", b.traktDeviceStart)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/device/cancel", b.traktDeviceCancel)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/disconnect", b.traktDisconnect)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/scrobble", b.traktScrobble)
	mux.HandleFunc("/app/fntvplus/api/bridge/trakt/sync-watched", b.traktSyncWatched)
	mux.HandleFunc("/app/fntvplus/api/bridge/bangumi/calendar", b.bangumiCalendar)
	mux.HandleFunc("/app/fntvplus/api/bridge/douban/status", b.doubanStatus)
}

/* ========== 通用工具 ========== */

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func genAuthx(path, dataJSON string) string {
	nonce := fmt.Sprintf("%d", 100000+rand.Intn(900000))
	ts := time.Now().UnixMilli()
	sign := md5hex(strings.Join([]string{authxKey, path, nonce, fmt.Sprintf("%d", ts), md5hex(dataJSON), authxSecret}, "_"))
	return fmt.Sprintf("nonce=%s&timestamp=%d&sign=%s", nonce, ts, sign)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func getSetting(cfg *config.Config, key string) string {
	v, _ := cfg.GetSetting(key)
	return v
}

/* ========== fnOS 签名桥 ========== */

// handleFnOS 通用 fnOS 签名桥：{method, path, body, cookie}。
// path 必须以 /v/api/ 开头（白名单约束）；Authx 由后端本地签名；cookie 由前端转发。
func (b *Bridge) handleFnOS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Method string          `json:"method"`
		Path   string          `json:"path"`
		Body   json.RawMessage `json:"body"`
		Cookie string          `json:"cookie"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 512*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	if !strings.HasPrefix(req.Path, "/v/api/") {
		writeErr(w, http.StatusForbidden, "path 必须以 /v/api/ 开头")
		return
	}
	method := strings.ToUpper(req.Method)
	if method == "" {
		method = http.MethodGet
	}
	var bodyReader io.Reader
	dataJSON := ""
	if len(req.Body) > 0 && string(req.Body) != "null" {
		bodyReader = strings.NewReader(string(req.Body))
		dataJSON = string(req.Body)
	}
	req2, err := http.NewRequest(method, b.upstream+req.Path, bodyReader)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	req2.Header.Set("Authx", genAuthx(req.Path, dataJSON))
	req2.Header.Set("Content-Type", "application/json")
	if req.Cookie != "" {
		req2.Header.Set("Cookie", req.Cookie)
	}
	resp, err := b.client.Do(req2)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "upstream error: "+err.Error())
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}

/* ========== 白名单外部代理 ========== */

func hostAllowed(host string) bool {
	host = strings.ToLower(host)
	for _, suffix := range proxyAllowSuffix {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

// handleProxy 白名单外部代理：{url, method, body, headers}。不带本地 cookie。
func (b *Bridge) handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		URL     string            `json:"url"`
		Method  string            `json:"method"`
		Body    json.RawMessage   `json:"body"`
		Headers map[string]string `json:"headers"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		writeErr(w, http.StatusBadRequest, "bad url")
		return
	}
	if !hostAllowed(u.Hostname()) {
		writeErr(w, http.StatusForbidden, "域名不在白名单: "+u.Hostname())
		return
	}
	method := strings.ToUpper(req.Method)
	if method == "" {
		method = http.MethodGet
	}
	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = strings.NewReader(string(req.Body))
	}
	req2, err := http.NewRequest(method, req.URL, bodyReader)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	for k, v := range req.Headers {
		if strings.HasPrefix(strings.ToLower(k), "cookie") {
			continue // 不转发本地凭证
		}
		req2.Header.Set(k, v)
	}
	if req2.Header.Get("User-Agent") == "" {
		req2.Header.Set("User-Agent", "Fntv-Plus-Web/0.15.0 (https://github.com/YDMY007/Fntv-Plus)")
	}
	resp, err := b.client.Do(req2)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "fetch error: "+err.Error())
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}

/* ========== TMDB 图片 ========== */

// handleTMDBImage GET ?url=https://image.tmdb.org/... → {ok, dataUrl}（对齐桌面版 tmdb:image 契约）。
func (b *Bridge) handleTMDBImage(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() != "image.tmdb.org" || !strings.HasPrefix(u.Path, "/t/p/") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "仅支持 image.tmdb.org/t/p/ 路径"})
		return
	}
	resp, err := b.client.Get(raw)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": fmt.Sprintf("upstream %d", resp.StatusCode)})
		return
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "image/jpeg"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"dataUrl": "data:" + ct + ";base64," + b64encode(data),
	})
}

/* ========== Trakt ========== */

const traktAPI = "https://api.trakt.tv"
const traktAuth = "https://auth.trakt.tv"

func (b *Bridge) traktClientID() string  { return getSetting(b.cfg, "trakt_client_id") }
func (b *Bridge) traktSecret() string    { return getSetting(b.cfg, "trakt_client_secret") }
func (b *Bridge) traktToken() string     { return getSetting(b.cfg, "trakt_access_token") }
func (b *Bridge) traktRefresh() string   { return getSetting(b.cfg, "trakt_refresh_token") }
func (b *Bridge) traktExpiresAt() string { return getSetting(b.cfg, "trakt_expires_at") }

// traktReq 带凭证调用 trakt API；401 时尝试刷新一次。
func (b *Bridge) traktReq(method, path string, body any) (int, map[string]any, error) {
	call := func() (int, []byte, error) {
		bd, _ := json.Marshal(body)
		req, err := http.NewRequest(method, traktAPI+path, strings.NewReader(string(bd)))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("trakt-api-version", "2")
		req.Header.Set("trakt-api-key", b.traktClientID())
		if tk := b.traktToken(); tk != "" {
			req.Header.Set("Authorization", "Bearer "+tk)
		}
		resp, err := b.client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
		return resp.StatusCode, data, nil
	}
	st, data, err := call()
	if err != nil {
		return 0, nil, err
	}
	if st == http.StatusUnauthorized {
		if b.traktRefreshToken() {
			st, data, err = call()
			if err != nil {
				return 0, nil, err
			}
		}
	}
	var out map[string]any
	if len(data) > 0 {
		_ = json.Unmarshal(data, &out)
		if out == nil {
			out = map[string]any{}
		}
	} else {
		out = map[string]any{}
	}
	return st, out, nil
}

// traktRefreshToken 用 refresh_token 换新 token 并持久化。
func (b *Bridge) traktRefreshToken() bool {
	rt := b.traktRefresh()
	id, sec := b.traktClientID(), b.traktSecret()
	if rt == "" || id == "" || sec == "" {
		return false
	}
	body, _ := json.Marshal(map[string]any{
		"refresh_token": rt, "client_id": id, "client_secret": sec,
		"redirect_uri": "urn:ietf:wg:oauth:2.0:oob", "grant_type": "refresh_token",
	})
	resp, err := b.client.Post(traktAuth+"/oauth/token", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK || out["access_token"] == nil {
		return false
	}
	_ = b.cfg.SetSetting("trakt_access_token", out["access_token"])
	if v, ok := out["refresh_token"]; ok {
		_ = b.cfg.SetSetting("trakt_refresh_token", v)
	}
	if v, ok := out["expires_in"]; ok {
		_ = b.cfg.SetSetting("trakt_expires_at", fmt.Sprintf("%d", time.Now().Add(time.Duration(toInt64(v))*time.Second).UnixMilli()))
	}
	return true
}

// traktCredsHandler 凭证存取（POST 保存 / GET 查询状态）。
func (b *Bridge) traktCredsHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			id, tk := b.traktClientID(), b.traktToken()
			masked := ""
			if len(id) > 8 {
				masked = id[:6] + "…" + id[len(id)-4:]
			} else if id != "" {
				masked = "…"
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"configured": id != "" && b.traktSecret() != "",
				"connected":  tk != "",
				"client_id":  masked,
				"expiresAt":  toInt64(b.traktExpiresAt()),
			})
		case http.MethodPost:
			var req struct {
				ClientID     string `json:"client_id"`
				ClientSecret string `json:"client_secret"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErr(w, http.StatusBadRequest, "bad json")
				return
			}
			id := strings.TrimSpace(req.ClientID)
			sec := strings.TrimSpace(req.ClientSecret)
			if id == "" || sec == "" {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Client ID 与 Secret 均必填"})
				return
			}
			// 换了应用（token 与 app 绑定）则丢弃旧 token
			if b.traktClientID() != "" && b.traktClientID() != id {
				_ = b.cfg.SetSetting("trakt_access_token", "")
				_ = b.cfg.SetSetting("trakt_refresh_token", "")
				_ = b.cfg.SetSetting("trakt_expires_at", "")
			}
			_ = b.cfg.SetSetting("trakt_client_id", id)
			_ = b.cfg.SetSetting("trakt_client_secret", sec)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func (b *Bridge) traktStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, tk := b.traktClientID(), b.traktToken()
		writeJSON(w, http.StatusOK, map[string]any{
			"configured": id != "" && b.traktSecret() != "",
			"connected":  tk != "",
			"expiresAt":  toInt64(b.traktExpiresAt()),
		})
	}
}

// traktDeviceStart 用已存凭证向 auth.trakt.tv 申请设备码（返回原文给页面展示）。
func (b *Bridge) traktDeviceStart(w http.ResponseWriter, r *http.Request) {
	id := b.traktClientID()
	if id == "" || b.traktSecret() == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先填写 Trakt Client ID 与 Secret"})
		return
	}
	body, _ := json.Marshal(map[string]any{"client_id": id})
	resp, err := b.client.Post(traktAuth+"/oauth/device/code", "application/json", strings.NewReader(string(body)))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK {
		out["error"] = fmt.Sprintf("device/code %d", resp.StatusCode)
	}
	writeJSON(w, resp.StatusCode, out)
}

// traktDeviceCancel 前端停止轮询即可（后端无持久轮询状态），占位幂等。
func (b *Bridge) traktDeviceCancel(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// traktDisconnect 吊销 token 并清空凭证。
func (b *Bridge) traktDisconnect(w http.ResponseWriter, r *http.Request) {
	if tk := b.traktToken(); tk != "" {
		body, _ := json.Marshal(map[string]any{"access_token": tk, "client_id": b.traktClientID(), "client_secret": b.traktSecret()})
		resp, err := b.client.Post(traktAuth+"/oauth/revoke", "application/json", strings.NewReader(string(body)))
		if err == nil {
			_ = resp.Body.Close()
		}
	}
	for _, k := range []string{"trakt_access_token", "trakt_refresh_token", "trakt_expires_at"} {
		_ = b.cfg.SetSetting(k, "")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// traktScrobble {action, guid, progress, cookie}：
// 后端用转发的 cookie + 本地 Authx 调 fnOS play/info 解析 trim_id → tmdb id → 调 trakt scrobble。
func (b *Bridge) traktScrobble(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action   string  `json:"action"`
		GUID     string  `json:"guid"`
		Progress float64 `json:"progress"`
		Cookie   string  `json:"cookie"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}
	if b.traktToken() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "Trakt 未连接"})
		return
	}
	pct := int(req.Progress + 0.5)
	if pct < 0 {
		pct = 0
	} else if pct > 100 {
		pct = 100
	}
	// fnOS play/info（签名 + cookie 转发）
	body, _ := json.Marshal(map[string]any{"item_guid": req.GUID})
	req2, _ := http.NewRequest(http.MethodPost, b.upstream+"/v/api/v1/play/info", strings.NewReader(string(body)))
	req2.Header.Set("Authx", genAuthx("/v/api/v1/play/info", string(body)))
	req2.Header.Set("Content-Type", "application/json")
	if req.Cookie != "" {
		req2.Header.Set("Cookie", req.Cookie)
	}
	resp, err := b.client.Do(req2)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "读取播放信息失败: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	var pr map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&pr)
	resp.Body.Close()
	data, _ := pr["data"].(map[string]any)
	item, _ := data["item"].(map[string]any)
	if item == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "读取播放信息失败"})
		return
	}
	trimID, _ := item["trim_id"].(string)
	tmdbID := trimToTmdb(trimID)
	isEpisode := fmt.Sprintf("%v", item["type"]) == "Episode"
	var traktBody map[string]any
	if isEpisode {
		if tmdbID <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "剧集缺少 TMDB id，无法 scrobble"})
			return
		}
		traktBody = map[string]any{
			"progress": pct,
			"show":     map[string]any{"ids": map[string]any{"tmdb": tmdbID}},
			"episode": map[string]any{
				"season": toInt64(item["season_number"]), "number": toInt64(item["episode_number"]),
			},
		}
	} else {
		if tmdbID <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "电影缺少 TMDB id，无法 scrobble"})
			return
		}
		traktBody = map[string]any{"progress": pct, "movie": map[string]any{"ids": map[string]any{"tmdb": tmdbID}}}
	}
	st, _, err := b.traktReq(http.MethodPost, "/scrobble/"+req.Action, traktBody)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	if st >= 400 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "code": st, "message": fmt.Sprintf("scrobble %d", st)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "code": st})
}

// traktSyncWatched {cookie}：item/list 拉已识别作品 → 逐个解析 tmdb id → /sync/history 批量标记。
// 桌面版同名功能的精简移植（搜索匹配/进度细节后续补全）。
func (b *Bridge) traktSyncWatched(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Cookie string `json:"cookie"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	if b.traktToken() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "Trakt 未连接"})
		return
	}
	body, _ := json.Marshal(map[string]any{
		"tags":                  map[string]any{"type": []string{"Movie", "TV"}},
		"sort_type":             "DESC", "sort_column": "create_time",
		"exclude_grouped_video": 1, "page": 1, "page_size": 200,
	})
	list, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/item/list", json.RawMessage(body), req.Cookie)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "item/list 失败: " + err.Error()})
		return
	}
	data, _ := list["data"].(map[string]any)
	rawItems, _ := data["list"].([]any)
	movies, shows := []any{}, []any{}
	for _, raw := range rawItems {
		it, _ := raw.(map[string]any)
		tmdbID := trimToTmdb(fmt.Sprintf("%v", it["trim_id"]))
		if tmdbID <= 0 {
			continue
		}
		if fmt.Sprintf("%v", it["type"]) == "Episode" {
			continue
		}
		if fmt.Sprintf("%v", it["type"]) == "Movie" {
			movies = append(movies, map[string]any{"ids": map[string]any{"tmdb": tmdbID}})
		} else {
			shows = append(shows, map[string]any{"ids": map[string]any{"tmdb": tmdbID}})
		}
	}
	st, _, err := b.traktReq(http.MethodPost, "/sync/history", map[string]any{"movies": movies, "shows": shows})
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": st < 400, "code": st,
		"movies": len(movies), "shows": len(shows),
		"message": fmt.Sprintf("已提交 %d 部电影 / %d 部剧集", len(movies), len(shows)),
	})
}

/* ========== TMDB API（logo / show 详情）========== */

// tmdbAPIKey 设置面板填的 TMDB API Key（v3）。
func (b *Bridge) tmdbAPIKey() string { return getSetting(b.cfg, "tmdbApiKey") }

func (b *Bridge) tmdbGet(path string, params map[string]string) (int, map[string]any, error) {
	u, _ := url.Parse("https://api.themoviedb.org/3" + path)
	q := u.Query()
	q.Set("language", "zh-CN")
	for k, v := range params {
		q.Set(k, v)
	}
	q.Set("api_key", b.tmdbAPIKey())
	u.RawQuery = q.Encode()
	req, _ := http.NewRequest(http.MethodGet, u.String(), nil)
	req.Header.Set("Accept", "application/json")
	resp, err := b.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&out)
	return resp.StatusCode, out, nil
}

// tmdbLogo {mediaType, id|title} → {ok, logoPaths:[...]}（/images logos，zh/en/null 语言）。
func (b *Bridge) tmdbLogo(w http.ResponseWriter, r *http.Request) {
	if b.tmdbAPIKey() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 TMDB API Key"})
		return
	}
	var req struct {
		MediaType string `json:"mediaType"`
		ID        int64  `json:"id"`
		Title     string `json:"title"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	mt := req.MediaType
	if mt != "movie" && mt != "tv" {
		mt = "tv"
	}
	id := req.ID
	if id <= 0 && req.Title != "" {
		st, out, err := b.tmdbGet("/search/"+mt, map[string]string{"query": req.Title})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if st != http.StatusOK {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("search %d", st)})
			return
		}
		results, _ := out["results"].([]any)
		if len(results) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "搜索无结果"})
			return
		}
		first, _ := results[0].(map[string]any)
		id = toInt64(first["id"])
	}
	if id <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少 id/title"})
		return
	}
	st, out, err := b.tmdbGet("/"+mt+"/"+fmt.Sprintf("%d", id)+"/images", map[string]string{"include_image_language": "zh,en,null"})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if st != http.StatusOK {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("images %d", st)})
		return
	}
	logos, _ := out["logos"].([]any)
	paths := []string{}
	for _, raw := range logos {
		l, _ := raw.(map[string]any)
		if fp, ok := l["file_path"].(string); ok && fp != "" {
			paths = append(paths, fp)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": len(paths) > 0, "logoPaths": paths})
}

// tmdbShow {tmdbId?, title?, year?, mediaType, seasonNumber?, force} → {ok, data, fetchedAt}。
// 精简移植桌面版 tmdbSync：详情（+ 季集列表）+ 抓取时间戳。
func (b *Bridge) tmdbShow(w http.ResponseWriter, r *http.Request) {
	if b.tmdbAPIKey() == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未配置 TMDB API Key"})
		return
	}
	var req struct {
		TmdbID       int64  `json:"tmdbId"`
		Title        string `json:"title"`
		Year         string `json:"year"`
		MediaType    string `json:"mediaType"`
		SeasonNumber *int64 `json:"seasonNumber"`
		Force        bool   `json:"force"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	mt := req.MediaType
	if mt != "movie" && mt != "tv" {
		mt = "tv"
	}
	id := req.TmdbID
	if id <= 0 && req.Title != "" {
		params := map[string]string{"query": req.Title}
		if req.Year != "" {
			if mt == "movie" {
				params["year"] = req.Year
			} else {
				params["first_air_date_year"] = req.Year
			}
		}
		st, out, err := b.tmdbGet("/search/"+mt, params)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if st != http.StatusOK {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("search %d", st)})
			return
		}
		results, _ := out["results"].([]any)
		if len(results) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "搜索无结果"})
			return
		}
		first, _ := results[0].(map[string]any)
		id = toInt64(first["id"])
	}
	if id <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少 tmdbId/title"})
		return
	}
	st, data, err := b.tmdbGet("/"+mt+"/"+fmt.Sprintf("%d", id), nil)
	if err != nil || st != http.StatusOK {
		msg := fmt.Sprintf("details %d", st)
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
		return
	}
	// 剧集 + 指定季 → 附 season 集列表
	if mt == "tv" && req.SeasonNumber != nil && *req.SeasonNumber > 0 {
		_, season, err := b.tmdbGet("/tv/"+fmt.Sprintf("%d", id)+"/season/"+fmt.Sprintf("%d", *req.SeasonNumber), nil)
		if err == nil && season != nil {
			data["season"] = season
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": data, "fetchedAt": time.Now().UnixMilli()})
}

/* ========== Bangumi / 豆瓣 ========== */

// bangumiCalendar 代理 api.bgm.tv/calendar（bgm.tv 要求自定义 UA）。
func (b *Bridge) bangumiCalendar(w http.ResponseWriter, r *http.Request) {
	req, _ := http.NewRequest(http.MethodGet, "https://api.bgm.tv/calendar", nil)
	req.Header.Set("User-Agent", "Fntv-Plus-Web/0.15.0 (https://github.com/YDMY007/Fntv-Plus)")
	resp, err := b.client.Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}

// doubanStatus 网页端豆瓣登录暂未适配（桌面版依赖内嵌浏览器会话），如实告知。
func (b *Bridge) doubanStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "loggedIn": false,
		"note": "网页端暂不支持豆瓣登录（需浏览器 cookie，后续版本适配）",
	})
}

/* ========== 内部工具 ========== */

// callFnOSJSON 带签名 + cookie 的 fnOS 调用，解析 JSON 返回。
func (b *Bridge) callFnOSJSON(method, path string, body json.RawMessage, cookie string) (map[string]any, error) {
	var bodyReader io.Reader
	dataJSON := ""
	if len(body) > 0 {
		bodyReader = strings.NewReader(string(body))
		dataJSON = string(body)
	}
	req, err := http.NewRequest(method, b.upstream+path, bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authx", genAuthx(path, dataJSON))
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&out)
	return out, nil
}

// trimToTmdb trim_id（形如 tt123456 / 纯数字）→ TMDB 数字 id；解析失败返回 0。
func trimToTmdb(trimID string) int64 {
	s := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(trimID), "tt"), "TT")
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int64(s[i]-'0')
		if n > 1<<62 {
			return 0
		}
	}
	return n
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case string:
		var n int64
		_, _ = fmt.Sscanf(strings.TrimSpace(t), "%d", &n)
		return n
	}
	return 0
}

func b64encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}
