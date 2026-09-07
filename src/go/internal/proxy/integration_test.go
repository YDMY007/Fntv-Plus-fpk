package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"fntvplus/internal/config"
	"fntvplus/internal/inject"
)

// upstreamHandler 模拟飞牛影视网页服务（与 cmd/mockupstream 等价，供测试内联使用）。
func upstreamHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v/", "/v/index.html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			io.WriteString(w, `<!doctype html><html><head><title>影视(mock)</title>`+
				`<link rel="stylesheet" href="/v/style.css"></head>`+
				`<body><div id="homeTab"><h1>影视首页（mock）</h1>`+
				`<video src="/v/video.mp4" controls></video></div></body></html>`)
		case "/v/style.css":
			w.Header().Set("Content-Type", "text/css")
			io.WriteString(w, "body{background:#111}")
		case "/v/api/hello":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"ok":true}`)
		case "/v/video.mp4":
			data := make([]byte, 1<<20)
			http.ServeContent(w, r, "video.mp4", time.Unix(0, 0), bytes.NewReader(data))
		default:
			http.NotFound(w, r)
		}
	})
	return mux
}

// testEnv 封装一套测试用的上游 + 反代 + 客户端。
// 客户端关闭 keep-alive，规避「嵌套 httptest 服务器 + 复用连接」导致的测试桩死锁
// （生产环境代理与上游是独立进程，不存在此问题）。
type testEnv struct {
	proxyURL string
	client   *http.Client
	inj      *inject.Injector
	cfg      *config.Config
	close    func()
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	up := httptest.NewServer(upstreamHandler())
	upURL, err := url.Parse(up.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}
	cfg := config.Default()
	inj, err := inject.New()
	if err != nil {
		t.Fatalf("inject.New: %v", err)
	}
	srv := NewServer(Deps{Upstream: upURL, Config: cfg, Injector: inj})
	proxySrv := httptest.NewServer(srv)
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	return &testEnv{
		proxyURL: proxySrv.URL,
		client:   client,
		inj:      inj,
		cfg:      cfg,
		close:    func() { proxySrv.Close(); up.Close() },
	}
}

func TestHTMLInjection(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	resp, err := env.client.Get(env.proxyURL + "/app/fntvplus/v/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("content-type = %q, want text/html", resp.Header.Get("Content-Type"))
	}
	s := string(body)
	if !strings.Contains(s, "<!-- FNTV_PLUS_INJECT_BEGIN -->") {
		t.Errorf("injection marker missing")
	}
	if !strings.Contains(s, "影视首页（mock）") {
		t.Errorf("upstream HTML not proxied through")
	}
	wantScript := "/app/fntvplus/__payload__/fntv-plus." + env.inj.Hash() + ".user.js"
	if !strings.Contains(s, wantScript) {
		t.Errorf("payload script tag missing, want %q", wantScript)
	}
	if !strings.Contains(resp.Header.Get("Cache-Control"), "no-store") {
		t.Errorf("injected HTML should set Cache-Control: no-store")
	}
}

func TestPayloadEndpoint(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	u := env.proxyURL + "/app/fntvplus/__payload__/fntv-plus." + env.inj.Hash() + ".user.js"
	resp, err := env.client.Get(u)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "application/javascript") {
		t.Errorf("content-type = %q, want application/javascript", resp.Header.Get("Content-Type"))
	}
	if len(body) != env.inj.Len() {
		t.Errorf("payload length = %d, want %d", len(body), env.inj.Len())
	}
	if !strings.Contains(string(body), "[fntv-web]") {
		t.Errorf("payload content mismatch (expected fntv-web marker)")
	}
}

func TestNonHTMLPassthroughAndRange(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	// CSS 透传（非 HTML，不应注入）。
	resp, _ := env.client.Get(env.proxyURL + "/v/style.css")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), "text/css") {
		t.Fatalf("css passthrough failed: %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if string(b) != "body{background:#111}" {
		t.Errorf("css body mismatch: %q", string(b))
	}

	// 视频 206 透传。
	req, _ := http.NewRequest("GET", env.proxyURL+"/v/video.mp4", nil)
	req.Header.Set("Range", "bytes=0-1023")
	resp2, err := env.client.Do(req)
	if err != nil {
		t.Fatalf("range get: %v", err)
	}
	b2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d, want 206", resp2.StatusCode)
	}
	if len(b2) != 1024 {
		t.Errorf("range body length = %d, want 1024", len(b2))
	}
	if resp2.Header.Get("Content-Range") == "" {
		t.Errorf("Content-Range header missing on 206 passthrough")
	}
}

func TestSettingsAPI(t *testing.T) {
	env := newTestEnv(t)
	defer env.close()

	// 初始：增强开启。
	resp, _ := env.client.Get(env.proxyURL + "/app/fntvplus/api/settings")
	var c map[string]any
	json.NewDecoder(resp.Body).Decode(&c)
	resp.Body.Close()
	if c["enhancement_enabled"] != true {
		t.Fatalf("default enhancement_enabled = %v, want true", c["enhancement_enabled"])
	}

	// 关闭增强 → 反代应透传、不注入。
	req, _ := http.NewRequest("POST", env.proxyURL+"/app/fntvplus/api/settings",
		bytes.NewReader([]byte(`{"enhancement_enabled":false}`)))
	req.Header.Set("Content-Type", "application/json")
	env.client.Do(req)

	resp2, _ := env.client.Get(env.proxyURL + "/app/fntvplus/v/")
	b2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if strings.Contains(string(b2), "<!-- FNTV_PLUS_INJECT_BEGIN -->") {
		t.Errorf("enhancement disabled but injection still present")
	}

	// 恢复开启（config 是同一实例，验证 Update 生效）。
	req3, _ := http.NewRequest("POST", env.proxyURL+"/app/fntvplus/api/settings",
		bytes.NewReader([]byte(`{"enhancement_enabled":true}`)))
	req3.Header.Set("Content-Type", "application/json")
	env.client.Do(req3)
	if !env.cfg.Get().EnhancementEnabled {
		t.Errorf("config not updated back to enabled")
	}
}

func TestInjectorIdempotent(t *testing.T) {
	inj, err := inject.New()
	if err != nil {
		t.Fatalf("inject.New: %v", err)
	}
	html := "<html><body>hi</body></html>"
	out1, ok1 := inj.Inject(html)
	if !ok1 || !strings.Contains(out1, "<!-- FNTV_PLUS_INJECT_BEGIN -->") {
		t.Fatalf("first inject failed: ok=%v", ok1)
	}
	out2, ok2 := inj.Inject(out1)
	if ok2 {
		t.Errorf("second inject should be no-op (idempotent), got ok=%v", ok2)
	}
	if out2 != out1 {
		t.Errorf("idempotent inject changed output")
	}
}
