// Package bridge —— danmaku.go：网页端弹幕数据链（danmaku:prepare 的 Go 后端）。
// 移植桌面版 third_party/uosc_danmaku/bili_danmaku.js 的核心流程（第一版走经典稳态链）：
//   WBI 签名搜索 PGC（番剧 season_type=1 / 国创 4）→ season_id → pgc/view/web/season
//   → 按 ep 选集（序号直取 → 标题含集数 → 首集）→ list.so?oid=cid 拉 XML 弹幕 → 解析
//   → 屏蔽过滤（类型 + 黑名单）→ 磁盘缓存（config 同目录 danmaku-cache/）。
// 登录态：可选携带设置面板粘贴的 bili_cookie（SESSDATA），弹幕数量更全；匿名亦可用。
// 元数据（标题/集数/季）由前端直连 play/info 解析后传入（httpOnly 断链，见 lc-057/061）。
package bridge

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"strings"
	"time"
)

const biliWebAPI = "https://api.bilibili.com"

// biliEncTable WBI mixin 重排表（B站官方算法，与桌面版 bili_danmaku.js ENC 一致）
var biliEncTable = [64]int{46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52}

var biliNavKey struct {
	once  sync.Once
	ik, sk string
}

// biliUA B站请求统一 UA（匿名/登录态均建议浏览器 UA）
const biliUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// biliNav 拉取 wbi_img 两个 key（会话缓存一次）。
func biliNavKeys() (string, string) {
	biliNavKey.once.Do(func() {
		client := &http.Client{Timeout: 10 * time.Second}
		req, _ := http.NewRequest(http.MethodGet, biliWebAPI+"/x/web-interface/nav", nil)
		req.Header.Set("User-Agent", biliUA)
		if resp, err := client.Do(req); err == nil {
			var out struct {
				Data struct {
					WbiImg struct {
						ImgURL string `json:"img_url"`
						SubURL string `json:"sub_url"`
					} `json:"wbi_img"`
				} `json:"data"`
			}
			_ = json.NewDecoder(io.LimitReader(resp.Body, 1024*1024)).Decode(&out)
			resp.Body.Close()
			ik := path.Base(out.Data.WbiImg.ImgURL)
			if ext := filepath.Ext(ik); ext != "" {
				ik = strings.TrimSuffix(ik, ext)
			}
			sk := path.Base(out.Data.WbiImg.SubURL)
			if ext := filepath.Ext(sk); ext != "" {
				sk = strings.TrimSuffix(sk, ext)
			}
			biliNavKey.ik, biliNavKey.sk = ik, sk
		}
	})
	return biliNavKey.ik, biliNavKey.sk
}

// biliWbiSign WBI 签名：params + wts 排序拼接 → md5(qs + mixinKey) → 返回含 w_rid 的 query 串。
func biliWbiSign(params map[string]string) string {
	ik, sk := biliNavKeys()
	mixinArr := make([]byte, 0, 64)
	all := ik + sk
	for _, i := range biliEncTable {
		if i < len(all) {
			mixinArr = append(mixinArr, all[i])
		}
	}
	mixin := string(mixinArr)
	if len(mixin) > 32 {
		mixin = mixin[:32]
	}
	keys := make([]string, 0, len(params)+1)
	for k := range params {
		keys = append(keys, k)
	}
	keys = append(keys, "wts")
	sort.Strings(keys)
	vals := map[string]string{}
	for k, v := range params {
		vals[k] = v
	}
	vals["wts"] = strconv.FormatInt(time.Now().Unix(), 10)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, url.QueryEscape(k)+"="+url.QueryEscape(vals[k]))
	}
	qs := strings.Join(pairs, "&")
	sum := md5.Sum([]byte(qs + mixin))
	return qs + "&w_rid=" + hex.EncodeToString(sum[:])
}

// biliGet 带 UA/cookie 的 B站 GET → JSON map。
func (b *Bridge) danmakuGetJSON(rawURL string) (int, map[string]any, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", biliUA)
	req.Header.Set("Referer", "https://www.bilibili.com/")
	if ck := strings.TrimSpace(getSetting(b.cfg, "biliCookie")); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 16*1024*1024)).Decode(&out)
	return resp.StatusCode, out, nil
}

var reEpInTitle = regexp.MustCompile(`(?i)(?:^|[^A-Za-z\d])(?:e\.?p\.?\s*|episode\s*|#\s*)\s*0*([0-9]+)`)

// biliPickEpisode 选集（桌面版 _pick_episode 同逻辑）：序号直取 → 标题含集数 → 首集。
func biliPickEpisode(eps []map[string]any, epNum int64) map[string]any {
	if len(eps) == 0 {
		return nil
	}
	if epNum >= 1 && int(epNum) <= len(eps) {
		return eps[epNum-1]
	}
	if epNum > 0 {
		for _, e := range eps {
			tt := jsStr(e["title"]) + " " + jsStr(e["long_title"])
			loc := reEpInTitle.FindStringSubmatchIndex(tt)
			// Go regexp 不支持负向先行：手动校验捕获组之后不能再跟数字（等价 (?!...)
			if loc != nil && loc[3] >= len(tt)-0 {
				// 捕获组右邻是字符串末尾 → 数字完整
				if n, err := strconv.ParseInt(tt[loc[2]:loc[3]], 10, 64); err == nil && n == epNum {
					return e
				}
			} else if loc != nil {
				next := tt[loc[3]]
				if next < '0' || next > '9' {
					if n, err := strconv.ParseInt(tt[loc[2]:loc[3]], 10, 64); err == nil && n == epNum {
						return e
					}
				}
			}
		}
	}
	return eps[0]
}

// biliSearchPGC WBI 签名搜索 PGC（seasonType 1=番剧 4=国创），返回 season_id 候选（按标题相似度降序）。
func (b *Bridge) biliSearchPGC(title string, seasonNum int64, seasonType string) []struct {
	ID    int64
	Title string
	Sim   float64
} {
	type cand struct {
		ID    int64
		Title string
		Sim   float64
	}
	q := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(title, "（", "("), "）", ")"))
	reYearTail := regexp.MustCompile(`\s*\(\d{4}\)\s*$`)
	q = strings.TrimSpace(reYearTail.ReplaceAllString(q, ""))
	if q == "" {
		return nil
	}
	signed := biliWbiSign(map[string]string{
		"keyword":     q,
		"search_type": seasonType,
		"page":        "1",
	})
	_, out, err := b.danmakuGetJSON(biliWebAPI + "/x/web-interface/wbi/search/type?" + signed)
	if err != nil || out == nil {
		return nil
	}
	result, _ := out["result"].([]any)
	qn := jsNormTitle(q)
	type Cand = struct {
		ID    int64
		Title string
		Sim   float64
	}
	var cands []Cand
	for _, v := range result {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		sid := int64(jsNum(m["season_id"]))
		if sid <= 0 {
			continue
		}
		t := jsStr(m["title"])
		// B站搜索结果标题里关键词带 <em class="keyword"> 高亮，先剥掉
		t = strings.ReplaceAll(strings.ReplaceAll(t, `<em class="keyword">`, ""), "</em>", "")
		tn := jsNormTitle(t)
		sim := 0.5
		switch {
		case tn == qn && qn != "":
			sim = 1.0
		case qn != "" && (strings.Contains(tn, qn) || strings.Contains(qn, tn)):
			sim = 0.8
		}
		// 季数精确匹配加权（season_title 形如「第 2 季」）
		if seasonNum > 0 {
			st := jsNormTitle(jsStr(m["season_title"]))
			if st != "" && strings.Contains(st, strconv.FormatInt(seasonNum, 10)+"季") {
				sim += 0.1
			}
		}
		cands = append(cands, Cand{ID: sid, Title: t, Sim: sim})
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].Sim > cands[j].Sim })
	return cands
}

// biliSeasonEpisodes season_id → 全集列表（main_section episodes）。
func (b *Bridge) biliSeasonEpisodes(seasonID int64) []map[string]any {
	_, out, err := b.danmakuGetJSON(fmt.Sprintf("%s/pgc/view/web/season?season_id=%d", biliWebAPI, seasonID))
	if err != nil || out == nil {
		return nil
	}
	if res, _ := out["result"].(map[string]any); res != nil {
		if eps, _ := res["episodes"].([]any); len(eps) > 0 {
			return toMapSlice(eps)
		}
		if ms, _ := res["main_section"].(map[string]any); ms != nil {
			if eps, _ := ms["episodes"].([]any); len(eps) > 0 {
				return toMapSlice(eps)
			}
		}
	}
	return nil
}

func toMapSlice(arr []any) []map[string]any {
	out := make([]map[string]any, 0, len(arr))
	for _, v := range arr {
		if m, ok := v.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// biliFetchDanmakuXML cid → 经典 list.so XML → 解析为 items（time/type/color/text），按 time 升序。
func (b *Bridge) biliFetchDanmakuXML(cid int64) []map[string]any {
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/x/v1/dm/list.so?oid=%d", biliWebAPI, cid), nil)
	req.Header.Set("User-Agent", biliUA)
	req.Header.Set("Referer", "https://www.bilibili.com/")
	if ck := strings.TrimSpace(getSetting(b.cfg, "biliCookie")); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	if len(data) < 16 {
		return nil
	}
	// XML 转义还原 + 属性解析
	reD := regexp.MustCompile(`<d p="([^"]+)"[^>]*>(.*?)</d>`)
	unescape := strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'", "&apos;", "'", "&amp;", "&")
	items := []map[string]any{}
	for _, m := range reD.FindAllStringSubmatch(string(data), -1) {
		p := strings.Split(m[1], ",")
		if len(p) < 5 {
			continue
		}
		t, perr := strconv.ParseFloat(p[0], 64)
		if perr != nil {
			continue
		}
		mode, _ := strconv.Atoi(p[1])
		color, _ := strconv.ParseInt(p[3], 10, 64)
		// 桌面 DanmakuItem.type 语义：1/2/3=滚动 4=底部 5=顶部（B站 mode 同义，6/7+ 归滚动）
		dmType := mode
		if dmType != 4 && dmType != 5 {
			dmType = 1
		}
		items = append(items, map[string]any{
			"time":  t,
			"type":  dmType,
			"color": color,
			"text":  unescape.Replace(m[2]),
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return jsNum(items[i]["time"]) < jsNum(items[j]["time"])
	})
	return items
}

// biliFilterDanmaku 屏蔽过滤：类型（1/2/3 滚动 4 底部 5 顶部，逗号分隔）+ 黑名单（每行一个子串）。
func (b *Bridge) biliFilterDanmaku(items []map[string]any) []map[string]any {
	blockTypes := map[int]bool{}
	for _, s := range strings.Split(getSetting(b.cfg, "biliDanmakuBlockTypes"), ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			blockTypes[n] = true
		}
	}
	var blacklist []string
	for _, ln := range strings.Split(getSetting(b.cfg, "biliDanmakuBlacklist"), "\n") {
		if s := strings.TrimSpace(ln); s != "" {
			blacklist = append(blacklist, s)
		}
	}
	if len(blockTypes) == 0 && len(blacklist) == 0 {
		return items
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if blockTypes[int(jsNum(it["type"]))] {
			continue
		}
		text := jsStr(it["text"])
		blocked := false
		for _, kw := range blacklist {
			if kw != "" && strings.Contains(text, kw) {
				blocked = true
				break
			}
		}
		if !blocked {
			out = append(out, it)
		}
	}
	return out
}

// danmakuPrepare POST {title, ep, season, isMovie, biliSearch} → B站弹幕搜索+拉取。
// 元数据（标题/集数/季）由前端直连 play/info 解析后传入；返回桌面版 danmaku:prepare 同形状。
func (b *Bridge) danmakuPrepare(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title      string  `json:"title"`
		Ep         int64   `json:"ep"`
		Season     int64   `json:"season"`
		IsMovie    bool    `json:"isMovie"`
		BiliSearch *bool   `json:"biliSearch"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "缺少标题"})
		return
	}
	biliSearch := req.BiliSearch == nil || *req.BiliSearch

	// 磁盘缓存（title|season|ep 键；缓存存未过滤原始条目，屏蔽设置改动即时生效）
	var cachePath string
	if base := b.cfg.Dir(); base != "" {
		dir := filepath.Join(base, "danmaku-cache")
		_ = os.MkdirAll(dir, 0o755)
		sum := md5.Sum([]byte(title + "|" + strconv.FormatInt(req.Season, 10) + "|" + strconv.FormatInt(req.Ep, 10)))
		cachePath = filepath.Join(dir, "dm_"+hex.EncodeToString(sum[:10])+".json")
	}
	if data, err := os.ReadFile(cachePath); err == nil && len(data) > 8 {
		var cached struct {
			Items []map[string]any `json:"items"`
			Meta  map[string]any   `json:"meta"`
		}
		if json.Unmarshal(data, &cached) == nil && len(cached.Items) > 0 {
			kept := b.biliFilterDanmaku(cached.Items)
			sort.SliceStable(kept, func(i, j int) bool { return jsNum(kept[i]["time"]) < jsNum(kept[j]["time"]) })
			logf("[danmaku] 缓存命中: %d 条 → 过滤后 %d 条", len(cached.Items), len(kept))
			writeJSON(w, http.StatusOK, map[string]any{
				"ok": true, "title": title, "ep": req.Ep, "isMovie": req.IsMovie,
				"count": len(kept), "items": kept, "source": "bilibili",
				"meta": cached.Meta, "fromCache": true,
			})
			return
		}
	}

	if !biliSearch {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "title": title, "ep": req.Ep, "isMovie": req.IsMovie, "count": 0, "error": "B站弹幕搜索未启用"})
		return
	}

	// ① WBI PGC 搜索（番剧 → 国创）→ season_id → 选集 → cid
	type hit struct {
		cid    int64
		aid    int64
		title  string
		source string
		sim    float64
		epid   any
	}
	var best *hit
	for _, st := range []string{"1", "4"} {
		for _, c := range b.biliSearchPGC(title, req.Season, st) {
			eps := b.biliSeasonEpisodes(c.ID)
			if len(eps) == 0 {
				continue
			}
			ep := biliPickEpisode(eps, req.Ep)
			if ep == nil {
				continue
			}
			cid := int64(jsNum(ep["cid"]))
			if cid <= 0 {
				continue
			}
			best = &hit{cid: cid, aid: int64(jsNum(ep["aid"])), title: c.Title, source: "bangumi", sim: c.Sim, epid: ep["id"]}
			break
		}
		if best != nil {
			break
		}
	}
	// ② 影视区兜底（media_ft 经通用 WBI 搜索）：取首个命中的普通视频 cid
	if best == nil {
		signed := biliWbiSign(map[string]string{"keyword": title, "search_type": "media_ft", "page": "1"})
		_, out, err := b.danmakuGetJSON(biliWebAPI + "/x/web-interface/wbi/search/type?" + signed)
		if err == nil && out != nil {
			if result, _ := out["result"].([]any); len(result) > 0 {
				for _, v := range result {
					m, ok := v.(map[string]any)
					if !ok {
						continue
					}
					var bvid string
					if data, _ := m["data"].([]any); len(data) > 0 {
						if dm, _ := data[0].(map[string]any); dm != nil {
							bvid = jsStr(dm["bvid"])
						}
					}
					if bvid == "" {
						bvid = jsStr(m["bvid"])
					}
					if bvid == "" {
						continue
					}
					// bvid → cid（view 接口）
					_, vo, err := b.danmakuGetJSON(biliWebAPI + "/x/web-interface/view?bvid=" + url.QueryEscape(bvid))
					if err != nil || vo == nil {
						continue
					}
					cid := int64(jsNum(vo["cid"]))
					if cid <= 0 {
						continue
					}
					best = &hit{cid: cid, title: jsStr(m["title"]), source: "video", sim: 0.6}
					break
				}
			}
		}
	}
	if best == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "title": title, "ep": req.Ep, "isMovie": req.IsMovie, "count": 0, "error": "未找到匹配的B站弹幕"})
		return
	}

	// ③ 拉弹幕 → 过滤
	items := b.biliFetchDanmakuXML(best.cid)
	if len(items) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "title": title, "ep": req.Ep, "isMovie": req.IsMovie, "count": 0, "error": "该集没有弹幕数据"})
		return
	}
	kept := b.biliFilterDanmaku(items)

	meta := map[string]any{
		"searchTitle": title, "matchedTitle": best.title, "source": best.source,
		"cid": best.cid, "sim": best.sim, "ep": req.Ep, "isMovie": req.IsMovie,
		"season": req.Season, "count": len(kept),
	}
	// 成功结果落盘（存未过滤原始条目，屏蔽设置改动即时生效）
	if cachePath != "" {
		if data, err := json.Marshal(map[string]any{"items": items, "meta": meta}); err == nil {
			tmp := cachePath + ".tmp"
			if os.WriteFile(tmp, data, 0o644) == nil {
				_ = os.Rename(tmp, cachePath)
			}
		}
	}
	maxScreen := int64(0)
	if ms, err := strconv.ParseInt(strings.TrimSpace(getSetting(b.cfg, "biliDanmakuMaxScreen")), 10, 64); err == nil && ms >= 0 {
		maxScreen = ms
	}
	logf("[danmaku] 弹幕就绪: title=%q cid=%d count=%d", title, best.cid, len(kept))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "title": title, "ep": req.Ep, "isMovie": req.IsMovie,
		"count": len(kept), "items": kept, "source": "bilibili",
		"meta": meta, "maxScreen": maxScreen,
	})
}

// danmakuCandidates / danmakuPick 手动搜索与选定：网页端暂未实现（占位明确报错）。
func (b *Bridge) danmakuCandidates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "网页端暂不支持手动搜索候选"})
}

func (b *Bridge) danmakuPick(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "网页端暂不支持手动选定弹幕"})
}
