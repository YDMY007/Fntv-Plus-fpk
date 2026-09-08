// Package bridge —— sync.go：豆瓣观影记录/详情补全 + Bangumi 同步核心（桌面版忠实移植）。
package bridge

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
)

// fnItem fnOS 媒体条目（只取用到的字段，JSON 容错解析）。
type fnItem struct {
	GUID              string  `json:"guid"`
	ParentGUID        string  `json:"parent_guid"`
	Title             string  `json:"title"`
	ParentTitle       string  `json:"parent_title"`
	TVTitle           string  `json:"tv_title"`
	Type              string  `json:"type"`
	TrimID            string  `json:"trim_id"`
	DoubanID          string  `json:"douban_id"`
	Watched           int     `json:"watched"`
	WatchedTS         float64 `json:"watched_ts"`
	Duration          float64 `json:"duration"`
	Runtime           float64 `json:"runtime"`
	SeasonNumber      int64   `json:"season_number"`
	EpisodeNumber     int64   `json:"episode_number"`
	ParentIndexNumber int64   `json:"parent_index_number"`
	IndexNumber       int64   `json:"index_number"`
	VoteAverage       float64 `json:"vote_average"`
	AirDate           string  `json:"air_date"`
	ReleaseDate       string  `json:"release_date"`
}

// doubanWatched POST {cookie, force}：忠实移植桌面版 getWatchedItems——
// item/list 全库 → 6 并发逐项钻取（季→集，累加时长+统计已看）→ 仅保留有观看记录者 →
// buildLocalWatchItem 形状（列表页只展示本地播放记录，TMDB/豆瓣评分留给 enrich 按需查）。
func (b *Bridge) doubanWatched(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Cookie string `json:"cookie"`
		Force  bool   `json:"force"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req)
	if req.Cookie == "" {
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "libraryTotal": 0, "note": "缺少登录 cookie"})
		return
	}
	listBody, _ := json.Marshal(map[string]any{
		"parent_guid": "", "exclude_folder": 1,
		"sort_column": "sort_title", "sort_type": "ASC",
	})
	resp, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/item/list", listBody, req.Cookie)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "libraryTotal": 0, "note": err.Error()})
		return
	}
	data, _ := resp["data"].(map[string]any)
	rawList, _ := data["list"].([]any)
	libraryTotal := len(rawList)
	if t, ok := data["total"].(float64); ok && int(t) > len(rawList) {
		libraryTotal = int(t)
	}
	type pair struct {
		it fnItem
		a  analyzeResult
	}
	results := make([]pair, len(rawList))
	// 6 并发钻取（与桌面版 mapLimit(list, 6) 一致）
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup
	for i, raw := range rawList {
		wg.Add(1)
		var it fnItem
		bts, _ := json.Marshal(raw)
		_ = json.Unmarshal(bts, &it)
		go func(idx int, it fnItem) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[idx] = pair{it: it, a: b.analyzeItem(it, req.Cookie)}
		}(i, it)
	}
	wg.Wait()
	out := []map[string]any{}
	for _, p := range results {
		if p.a.AnyWatch {
			out = append(out, buildLocalWatchItem(p.it, p.a))
		}
	}
	done := 0
	for _, m := range out {
		if v, ok := m["progress"].(float64); ok && v >= 1 {
			done++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "items": out, "libraryTotal": libraryTotal, "watchedCount": done,
	})
}

// analyzeResult 单项观看分析结果。
type analyzeResult struct {
	TotalRuntimeMS int64
	Progress       float64
	AnyWatch       bool
	Started        bool
	LastPlayed     int64
}

// analyzeItem 忠实移植桌面版：电影看 watched/watched_ts；剧集钻取 季→集 累加时长+统计已看。
func (b *Bridge) analyzeItem(it fnItem, cookie string) analyzeResult {
	empty := analyzeResult{}
	lpMs := int64(0)
	if it.WatchedTS > 0 {
		lpMs = int64(it.WatchedTS * 1000)
	}
	t := strings.ToLower(it.Type)
	if t == "movie" {
		totalSec := it.Duration
		if totalSec <= 0 && it.Runtime > 0 {
			totalSec = it.Runtime * 60
		}
		rtMS := int64(totalSec * 1000)
		if it.Watched == 1 {
			return analyzeResult{rtMS, 1, true, false, lpMs}
		}
		if it.WatchedTS > 0 {
			return analyzeResult{rtMS, 0, true, true, lpMs}
		}
		return empty
	}
	totalSec, totalEp, watchedEp := 0.0, 0, 0
	addLeaf := func(leaf fnItem) {
		if leaf.Duration > 0 {
			totalSec += leaf.Duration
		} else if leaf.Runtime > 0 {
			totalSec += leaf.Runtime * 60
		}
		totalEp++
		if leaf.Watched == 1 {
			watchedEp++
		}
	}
	childrenBody, _ := json.Marshal(map[string]any{
		"parent_guid": it.GUID, "exclude_folder": 1,
		"sort_column": "sort_title", "sort_type": "ASC",
	})
	if children, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/item/list", childrenBody, cookie); err == nil {
		if cd, ok := children["data"].(map[string]any); ok {
			if cl, ok := cd["list"].([]any); ok {
				for _, raw := range cl {
					bts, _ := json.Marshal(raw)
					var c fnItem
					_ = json.Unmarshal(bts, &c)
					ct := strings.ToLower(c.Type)
					if ct == "episode" || ct == "movie" {
						addLeaf(c)
					} else if eps, err := b.callFnOSJSON(http.MethodGet, "/v/api/v1/episode/list/"+c.GUID, nil, cookie); err == nil {
						if el, ok := eps["data"].([]any); ok {
							for _, er := range el {
								b2, _ := json.Marshal(er)
								var leaf fnItem
								_ = json.Unmarshal(b2, &leaf)
								addLeaf(leaf)
							}
						}
					}
				}
			}
		}
	}
	// 兜底：单层剧集结构（子级钻取无果时 episode/list/{本条目}）
	if totalEp == 0 {
		if eps, err := b.callFnOSJSON(http.MethodGet, "/v/api/v1/episode/list/"+it.GUID, nil, cookie); err == nil {
			if el, ok := eps["data"].([]any); ok {
				for _, er := range el {
					b2, _ := json.Marshal(er)
					var leaf fnItem
					_ = json.Unmarshal(b2, &leaf)
					addLeaf(leaf)
				}
			}
		}
	}
	rtMS := int64(0)
	if totalSec > 0 {
		rtMS = int64(totalSec * 1000)
	} else if it.Runtime > 0 {
		rtMS = int64(it.Runtime * 60)
	}
	if it.Watched == 1 || (totalEp > 0 && watchedEp == totalEp) {
		return analyzeResult{rtMS, 1, true, false, lpMs}
	}
	if watchedEp > 0 {
		p := 0.0
		if totalEp > 0 {
			p = float64(watchedEp) / float64(totalEp)
		}
		return analyzeResult{rtMS, p, true, true, lpMs}
	}
	return empty
}

// buildLocalWatchItem 桌面版同形状条目（仅本地播放字段，评分留给 enrich 按需查）。
func buildLocalWatchItem(it fnItem, a analyzeResult) map[string]any {
	return map[string]any{
		"guid": it.GUID, "parent_guid": it.ParentGUID,
		"douban_id": it.DoubanID, "title": it.Title,
		"tv_title": it.TVTitle, "parent_title": it.ParentTitle,
		"type": it.Type, "category": "", "genres": []any{},
		"air_date": it.AirDate, "release_date": it.ReleaseDate,
		"watched": it.Watched, "started": boolToInt(a.Started),
		"last_played": a.LastPlayed, "progress": a.Progress,
		"total_runtime_ms": a.TotalRuntimeMS,
		"fnos_rating":      it.VoteAverage,
		"tmdb_rating":      0, "tmdb_votes": 0,
		"douban_rating": 0, "douban_votes": 0,
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// doubanEnrich {item}：TMDB 分类/类型/评分（+ 有 douban_id 时尽力抓豆瓣评分）。
// 精简移植 enrichWithTmdb + fetchDoubanRating（豆瓣无 cookie 常被拒，失败静默 0）。
func (b *Bridge) doubanEnrich(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Item fnItem `json:"item"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req)
	it := req.Item
	mt := "tv"
	if strings.ToLower(it.Type) == "movie" {
		mt = "movie"
	}
	category := "剧集"
	if mt == "movie" {
		category = "电影"
	}
	year := it.ReleaseDate
	if year == "" {
		year = it.AirDate
	}
	if len(year) > 4 {
		year = year[:4]
	}
	out := map[string]any{
		"category": category, "genres": []any{},
		"tmdb_rating": 0, "tmdb_votes": 0,
		"douban_rating": 0, "douban_votes": 0,
	}
	if b.tmdbAPIKey() == "" {
		out["note"] = "未配置 TMDB API Key，仅返回基础分类"
		writeJSON(w, http.StatusOK, out)
		return
	}
	params := map[string]string{"query": it.Title}
	if year != "" {
		if mt == "movie" {
			params["year"] = year
		} else {
			params["first_air_date_year"] = year
		}
	}
	st, res, err := b.tmdbGet("/search/"+mt, params)
	if err != nil || st != http.StatusOK {
		note := "TMDB 搜索失败"
		if err != nil {
			note += "（" + err.Error() + "）"
		} else {
			note += fmt.Sprintf("（%d）", st)
		}
		out["note"] = note
		writeJSON(w, http.StatusOK, out)
		return
	}
	results, _ := res["results"].([]any)
	if len(results) == 0 {
		out["note"] = "TMDB 搜索无结果"
		writeJSON(w, http.StatusOK, out)
		return
	}
	first, _ := results[0].(map[string]any)
	if gid, ok := first["genre_ids"].([]any); ok {
		gl := out["genres"].([]any)
		for _, g := range gid {
			gl = append(gl, tmdbGenreName(mt, toInt64(g)))
		}
		out["genres"] = gl
		// 动漫判定（TV + Animation genre 16）
		if mt == "tv" {
			for _, g := range gid {
				if toInt64(g) == 16 {
					out["category"] = "动漫"
				}
			}
		}
	}
	if va, ok := first["vote_average"].(float64); ok {
		out["tmdb_rating"] = va
	}
	if vc, ok := first["vote_count"].(float64); ok {
		out["tmdb_votes"] = int64(vc)
	}
	if mt == "tv" {
		if st2, det, err := b.tmdbGet("/tv/"+fmt.Sprintf("%d", toInt64(first["id"])), nil); err == nil && st2 == http.StatusOK {
			if status, ok := det["status"].(string); ok {
				out["air_status"] = tmdbAirStatusCN(status)
			}
		}
	}
	if id := strings.TrimSpace(it.DoubanID); isAllDigits(id) {
		if rating, votes := b.fetchDoubanRating(id); rating > 0 {
			out["douban_rating"] = rating
			out["douban_votes"] = votes
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// fetchDoubanRating 抓 movie.douban.com 条目页正则取评分/人数（无 cookie 尽力而为，失败静默 0）。
func (b *Bridge) fetchDoubanRating(doubanID string) (float64, int64) {
	req, _ := http.NewRequest(http.MethodGet, "https://movie.douban.com/subject/"+doubanID+"/", nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	resp, err := b.client.Do(req)
	if err != nil {
		return 0, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, 0
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	html := string(data)
	re := regexp.MustCompile(`v:average">([0-9.]+)`)
	votesRe := regexp.MustCompile(`v:votes">(\d+)`)
	rating := 0.0
	if m := re.FindStringSubmatch(html); len(m) > 1 {
		_, _ = fmt.Sscanf(m[1], "%f", &rating)
	}
	votes := int64(0)
	if m := votesRe.FindStringSubmatch(html); len(m) > 1 {
		_, _ = fmt.Sscanf(m[1], "%d", &votes)
	}
	return rating, votes
}

/* ========== Bangumi 同步核心 ========== */

const bangumiAPI = "https://api.bgm.tv"

// bangumiReq 带可选 token 的 bgm.tv 调用。
func (b *Bridge) bangumiReq(method, path string, token string, body any) (int, map[string]any, error) {
	var reader io.Reader
	if body != nil {
		bd, _ := json.Marshal(body)
		reader = strings.NewReader(string(bd))
	}
	req, err := http.NewRequest(method, bangumiAPI+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", "Fntv-Plus-Web/0.15.0 (https://github.com/YDMY007/Fntv-Plus)")
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024)).Decode(&out)
	return resp.StatusCode, out, nil
}

// bangumiSyncProgress {guid, percentage, cookie}：播放进度 → Bangumi 标记（在看/看过）。
// 忠实移植 syncOnProgress：TV → 搜索条目 → 定位集 → 标集看过；Movie → 标条目看过/在看。
func (b *Bridge) bangumiSyncProgress(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GUID       string  `json:"guid"`
		Percentage float64 `json:"percentage"`
		Cookie     string  `json:"cookie"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}
	token := getSetting(b.cfg, "bangumiToken")
	if token == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "未配置 Bangumi Token"})
		return
	}
	if req.Percentage < 0 {
		req.Percentage = 0
	}
	body, _ := json.Marshal(map[string]any{"item_guid": req.GUID})
	pr, err := b.callFnOSJSON(http.MethodPost, "/v/api/v1/play/info", body, req.Cookie)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "读取播放信息失败: " + err.Error()})
		return
	}
	data, _ := pr["data"].(map[string]any)
	item, _ := data["item"].(map[string]any)
	if item == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "读取播放信息失败"})
		return
	}
	isEpisode := strings.EqualFold(fmt.Sprintf("%v", item["type"]), "Episode")
	showTitle := firstNonEmpty(str(item["parent_title"]), str(item["tv_title"]))
	epNum := toInt64(item["episode_number"])
	if epNum <= 0 {
		epNum = toInt64(item["index_number"])
	}
	movieTitle := str(item["title"])
	if isEpisode {
		if showTitle == "" || epNum <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "缺少剧集标题/集号"})
			return
		}
		st, sr, err := b.bangumiReq(http.MethodGet, "/v0/search/subject?q="+url.QueryEscape(showTitle)+"&type=2", token, nil)
		if err != nil || st != http.StatusOK {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("Bangumi 搜索失败(%d)", st)})
			return
		}
		subjectID := findBangumiSubjectID(sr)
		if subjectID <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "Bangumi 未找到条目: " + showTitle})
			return
		}
		st, er, err := b.bangumiReq(http.MethodGet, fmt.Sprintf("/v0/episodes?subject_id=%d&type=0&limit=100", subjectID), token, nil)
		if err != nil || st != http.StatusOK {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "拉取集列表失败"})
			return
		}
		epID := findBangumiEpisodeID(er, int(epNum))
		if epID <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("未找到第 %d 集", epNum)})
			return
		}
		if st, _, err := b.bangumiReq(http.MethodPost, fmt.Sprintf("/v0/episode/%d/status/watched", epID), token, map[string]any{}); err != nil || st >= 400 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("标记集失败(%d)", st)})
			return
		}
		bangumiMarkSubject(b, token, subjectID, req.Percentage >= 100)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subject_id": subjectID, "episode_id": epID, "message": fmt.Sprintf("已标记 %s 第 %d 集", showTitle, epNum)})
		return
	}
	if movieTitle == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "缺少影片标题"})
		return
	}
	st, sr, err := b.bangumiReq(http.MethodGet, "/v0/search/subject?q="+url.QueryEscape(movieTitle)+"&type=1", token, nil)
	if err != nil || st != http.StatusOK {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": fmt.Sprintf("Bangumi 搜索失败(%d)", st)})
		return
	}
	subjectID := findBangumiSubjectID(sr)
	if subjectID <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "Bangumi 未找到条目: " + movieTitle})
		return
	}
	bangumiMarkSubject(b, token, subjectID, req.Percentage >= 100)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subject_id": subjectID, "message": "已标记 " + movieTitle})
}

func bangumiMarkSubject(b *Bridge, token string, subjectID int64, watched bool) {
	path := fmt.Sprintf("/v0/subject/%d/status/watched", subjectID)
	if !watched {
		path = fmt.Sprintf("/v0/subject/%d/status/do", subjectID)
	}
	_, _, _ = b.bangumiReq(http.MethodPost, path, token, map[string]any{})
}

func findBangumiSubjectID(resp map[string]any) int64 {
	if data, ok := resp["data"].([]any); ok && len(data) > 0 {
		if first, ok := data[0].(map[string]any); ok {
			return toInt64(first["id"])
		}
	}
	if subs, ok := resp["subjects"].([]any); ok && len(subs) > 0 {
		if first, ok := subs[0].(map[string]any); ok {
			return toInt64(first["id"])
		}
	}
	return 0
}

func findBangumiEpisodeID(resp map[string]any, epNum int) int64 {
	if data, ok := resp["data"].([]any); ok {
		for _, raw := range data {
			if e, ok := raw.(map[string]any); ok {
				if toInt64(e["ep"]) == int64(epNum) || toInt64(e["number"]) == int64(epNum) {
					return toInt64(e["id"])
				}
			}
		}
		if epNum <= len(data) {
			if e, ok := data[epNum-1].(map[string]any); ok {
				return toInt64(e["id"])
			}
		}
	}
	return 0
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// tmdbGenreName TMDB genre_id → 中文名（静态映射，标准 ID 表）。
func tmdbGenreName(mediaType string, id int64) string {
	m := map[string]map[int64]string{
		"movie": {28: "动作", 12: "冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 99: "纪录片", 18: "剧情", 10751: "家庭", 14: "奇幻", 36: "历史", 27: "恐怖", 10402: "音乐", 9648: "悬疑", 10749: "爱情", 878: "科幻", 10770: "电视电影", 53: "惊悚", 10752: "战争", 37: "西部"},
		"tv":    {10759: "动作冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 99: "纪录片", 18: "剧情", 10751: "家庭", 10762: "儿童", 9648: "悬疑", 10763: "新闻", 10764: "真人秀", 10765: "科幻奇幻", 10766: "肥皂剧", 10767: "脱口秀", 10768: "战争政治", 37: "西部"},
	}
	if m2, ok := m[mediaType]; ok {
		if name, ok := m2[id]; ok {
			return name
		}
	}
	return fmt.Sprintf("genre_%d", id)
}

// tmdbAirStatusCN TMDB status → 中文播出状态。
func tmdbAirStatusCN(status string) string {
	switch status {
	case "Returning Series":
		return "连载中"
	case "Planned":
		return "计划中"
	case "In Production":
		return "制作中"
	case "Ended":
		return "已完结"
	case "Canceled":
		return "已取消"
	}
	return status
}
