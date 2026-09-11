// proxy.mjs —— 飞牛影视(trim.media) 系统层「多源」刮削代理
//
// 支持的数据源：
//   • 原生 TMDB      —— 飞牛官方 mediasvc 本身就是 TMDB，始终透明转发（电影/剧集/人物/图片）。
//   • Bangumi (bg)   —— 番剧动画专用源，注入搜索候选 + 接管详情/单集（中文优先，封面走 Bangumi 图）。
//   • TMDB 直连 (tm) —— 可选增强：用自己的 TMDB_API_KEY 直连 TMDB 官方检索/详情（需 INJECT_TMDB=1）。
//   • IMDB (im)      —— 可选增强：IMDB 候选（im<imdbId>），详情优先 OMDb、否则 TMDB find 反查（需 INJECT_IMDB=1 + 至少一个 key）。
//
// 令牌前缀（用于在请求里识别该走哪个源）：
//   bg<id>    → Bangumi
//   tm<id>    → TMDB 直连（id 为 TMDB 数字 id）
//   im<imdbId>→ IMDB（imdbId 形如 tt1234567，完整令牌如 imtt1234567）
//   其余（tt\d+ 等）→ 飞牛原生 mediasvc，直接转发
//
// 依赖：仅 Node 内置模块（http/https/zlib/fs），fetch 需 Node ≥ 18。
// 运行：node proxy.mjs；环境变量见下方配置。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7788);
const UPSTREAM = process.env.UPSTREAM || 'https://mediasvc.fnnas.com';

// ---- 各源配置（均为可选，缺 key 自动降级） ----
const BGM_API = 'https://api.bgm.tv';
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const OMDB_API = 'https://www.omdbapi.com';
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';

const INJECT_BANGUMI = (process.env.INJECT_BANGUMI || '1') !== '0';
const INJECT_TMDB = (process.env.INJECT_TMDB || '0') !== '0' && !!TMDB_API_KEY;
const INJECT_IMDB = (process.env.INJECT_IMDB || '0') !== '0';

const LOG = join(__dirname, 'proxy.log');

// ---- 日志（绝不因写日志崩溃） ----
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

// ---- 加载 Bangumi token：优先环境变量，否则从 Fntv-Plus 的 config.json 复用 ----
function loadBgmToken() {
  if (process.env.BGM_TOKEN) return process.env.BGM_TOKEN;
  const appData = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
  const candidates = ['fntv', 'fntv-dev', 'Fntv-Plus', 'Fntv-Plus-dev'];
  for (const name of candidates) {
    const p = join(appData, name, 'config.json');
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (cfg && cfg.bangumiToken) { log('[bgm] 已从 Fntv-Plus 配置复用 token:', name); return cfg.bangumiToken; }
      }
    } catch {}
  }
  return '';
}
const BGM_TOKEN = loadBgmToken();
const BGM_UA = 'YDMY007/Fntv-Plus-scraper (https://github.com/YDMY007/Fntv-Plus)';

// ---- 内存缓存（带容量上限 CACHE_MAX，避免常驻容器长期运行后内存膨胀） ----
const CACHE_MAX = 2000;
function cacheSet(map, k, v) {
  if (!map.has(k) && map.size >= CACHE_MAX) {
    const first = map.keys().next().value;   // Map 保持插入顺序，淘汰最早一项
    if (first !== undefined) map.delete(first);
  }
  map.set(k, v);
}

const bgmSearchCache = new Map();
const bgmSubjectCache = new Map();
const bgmEpisodeCache = new Map();
const tmdbSearchCache = new Map();
const bgToTmdb = new Map();   // "bg<id>" -> 原生 TMDB trimId（单集剧照兜底）
const tmToImdb = new Map();   // "tm<id>" -> imdbId（单集退化用）

// ---- 图片令牌：把任意图片 URL 映射成本代理路径，由 /bgm_img_* 反向代理输出 ----
// imgMap: token -> url ；imgByUrl: url -> token（O(1) 去重，避免旧实现逐条扫描 Map 的 O(n) 性能问题）
const imgMap = new Map();
const imgByUrl = new Map();
let imgCounter = 0;
function registerImg(url) {
  if (!url) return '';
  const hit = imgByUrl.get(url);
  if (hit) return '/' + hit;
  const token = `bgm_img_${imgCounter++}`;
  imgMap.set(token, url);
  imgByUrl.set(url, token);
  if (imgMap.size > CACHE_MAX) {                  // 同步淘汰，保持内存有界
    const t = imgMap.keys().next().value;
    const u = imgMap.get(t);
    imgMap.delete(t);
    imgByUrl.delete(u);
  }
  return '/' + token;
}
function bgmImageUrl(subject) {
  const im = (subject && subject.images) || {};
  return im.large || im.common || im.medium || '';
}

// ---- Bangumi API ----
async function bgmReq(path, opts = {}) {
  const r = await fetch(BGM_API + path, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': BGM_UA,
      'Content-Type': 'application/json',
      ...(BGM_TOKEN ? { Authorization: `Bearer ${BGM_TOKEN}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  if (!r.ok) throw new Error(`bgm ${path} -> ${r.status}`);
  return r.json();
}

// ---- TMDB 官方 API（需 key） ----
async function tmdbReq(path, params = {}) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY 未配置');
  const u = new URL(TMDB_API + path);
  u.searchParams.set('api_key', TMDB_API_KEY);
  if (!u.searchParams.has('language')) u.searchParams.set('language', 'zh-CN');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString(), { headers: { 'User-Agent': BGM_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`tmdb ${path} -> ${r.status}`);
  return r.json();
}

// ---- OMDb API（需 key，用于 IMDB 原生数据） ----
async function omdbReq(imdbId) {
  if (!OMDB_API_KEY) throw new Error('OMDB_API_KEY 未配置');
  const u = new URL(OMDB_API);
  u.searchParams.set('apikey', OMDB_API_KEY);
  u.searchParams.set('i', imdbId);
  u.searchParams.set('plot', 'full');
  const r = await fetch(u.toString(), { headers: { 'User-Agent': BGM_UA } });
  if (!r.ok) throw new Error(`omdb ${imdbId} -> ${r.status}`);
  const j = await r.json();
  if (j.Response === 'False') throw new Error('omdb: ' + (j.Error || 'not found'));
  return j;
}

function normTitle(s) { return (s || '').toLowerCase().replace(/\s+/g, ''); }
function titlesMatch(kw, s) {
  const n = normTitle(kw);
  const a = normTitle(s.name_cn), b = normTitle(s.name);
  return n.includes(a) || a.includes(n) || n.includes(b) || b.includes(n);
}

// ---- Bangumi 数据 ----
async function bgmSearchSubjects(kw) {
  if (bgmSearchCache.has(kw)) return bgmSearchCache.get(kw);
  try {
    const data = await bgmReq('/v0/search/subjects?limit=10', {
      method: 'POST',
      body: JSON.stringify({ keyword: kw, sort: 'match', filter: { type: [2, 6] } }),
    });
    const items = (data && data.data) || [];
    cacheSet(bgmSearchCache, kw, items);
    return items;
  } catch (e) { log('[bgm] search 失败:', kw, e.message); return []; }
}
async function bgmSubjectDetail(id) {
  if (bgmSubjectCache.has(id)) return bgmSubjectCache.get(id);
  const s = await bgmReq('/v0/subjects/' + id);
  cacheSet(bgmSubjectCache, id, s);
  return s;
}
async function bgmEpisodes(id) {
  if (bgmEpisodeCache.has(id)) return bgmEpisodeCache.get(id);
  try {
    const data = await bgmReq(`/v0/episodes?subject_id=${id}&type=0&limit=500`);
    const eps = ((data && data.data) || []).map(e => ({
      ep: Number(e.ep) || Number(e.sort) || 0,
      name: e.name || '',
      name_cn: e.name_cn || '',
      description: e.description || '',
      airdate: e.airdate || '',
      img: (e.images && (e.images.large || e.images.common || e.images.medium)) || '',
    }));
    cacheSet(bgmEpisodeCache, id, eps);
    return eps;
  } catch (e) { log('[bgm] episodes 失败:', id, e.message); return []; }
}

// ---- TMDB 搜索：派生 tm 候选 +（可选）im 候选 ----
async function buildTmdbCandidates(kw, upstreamList) {
  if (!INJECT_TMDB || !TMDB_API_KEY) return { tmdb: [], imdb: [] };
  if (tmdbSearchCache.has(kw)) return tmdbSearchCache.get(kw);
  let out = { tmdb: [], imdb: [] };
  try {
    const data = await tmdbReq('/search/multi', { query: kw, include_adult: 'false', page: '1' });
    const results = (data && data.results) || [];
    const dedupe = (name, type) => upstreamList.some(x => x.type === type && normTitle(x.name) === normTitle(name));
    for (const r of results.slice(0, 6)) {
      if (r.media_type !== 'tv' && r.media_type !== 'movie') continue;
      const isTv = r.media_type === 'tv';
      const name = isTv ? (r.name || r.original_name) : (r.title || r.original_title);
      const poster = registerImg(r.poster_path ? 'https://image.tmdb.org/t/p/w500' + r.poster_path : '');
      const date = isTv ? (r.first_air_date || '') : (r.release_date || '');
      const type = isTv ? 'tv' : 'movie';
      if (!dedupe(name, type)) {
        out.tmdb.push({ source: 'tmdb', sourceId: 'tm' + r.id, type, name, posterPath: poster, firstAirDate: date, voteAverage: r.vote_average || 0 });
      }
      // 派生 IMDB 候选
      let imdbId = r.imdb_id || '';
      if (!imdbId && isTv && INJECT_IMDB) {
        try { const ext = await tmdbReq(`/tv/${r.id}/external_ids`); imdbId = ext.imdb_id || ''; } catch {}
      }
      if (imdbId && INJECT_IMDB && !dedupe(name, type)) {
        out.imdb.push({ source: 'imdb', sourceId: 'im' + imdbId, type, name, posterPath: poster, firstAirDate: date });
        tmToImdb.set('tm' + r.id, imdbId);
      }
    }
    cacheSet(tmdbSearchCache, kw, out);
  } catch (e) { log('[tmdb] search 失败:', kw, e.message); }
  return out;
}

// ---- 构造搜索候选（混入 Bangumi 动画；封面用 Bangumi 图） ----
async function buildSearchCandidates(kw, upstreamList) {
  const items = await bgmSearchSubjects(kw);
  const anime = items.filter(s => s.type === 2 && titlesMatch(kw, s)).slice(0, 3);
  return anime.map(s => {
    const tmdb = upstreamList.find(x => x.type === 'tv' && titlesMatch(kw, x));
    if (tmdb && tmdb.sourceId) bgToTmdb.set('bg' + s.id, tmdb.sourceId);
    return {
      source: 'bangumi',
      sourceId: 'bg' + s.id,
      type: 'tv',
      name: s.name_cn || s.name,
      posterPath: registerImg(bgmImageUrl(s)),
      genres: [{ id: 3, trim_id: 3, name: '动画' }],
      productionCountries: [{ iso_3166_1: 'JP' }],
      firstAirDate: s.date || '',
      lastAirDate: s.date || '',
      numberOfSeasons: 1,
    };
  });
}

// ---- 通用：把 TMDB 详情（movie/tv）组装成飞牛结构 ----
async function buildDetailTmdb(sourceId, mediaType) {
  const id = Number(String(sourceId).replace(/^tm/, ''));
  const isMovie = mediaType === 'movie';
  const d = await tmdbReq(isMovie ? `/movie/${id}` : `/tv/${id}`);
  const poster = registerImg(d.poster_path ? 'https://image.tmdb.org/t/p/w500' + d.poster_path : '');
  const backdrop = registerImg(d.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + d.backdrop_path : '');
  const genres = (d.genres || []).map(g => ({ id: g.id, trim_id: g.id, name: g.name }));
  const countries = (d.production_countries || []).map(c => ({ iso_3166_1: c.iso_3166_1 }));
  const common = {
    trim_id: sourceId, id, imdb_id: d.imdb_id || '', pinYin: {},
    backdrop_path: backdrop, genres, overview: d.overview || '', poster_path: poster,
    production_countries: countries,
    status: isMovie ? (d.status || 'Released') : (d.status || 'Returning Series'),
    vote_average: d.vote_average || 0, vote_count: d.vote_count || 0,
    images: { backdrops: [], logos: [], posters: [] },
    keywords: { keywords: null }, alternative_titles: { titles: [] }, content_ratings: { results: [] },
    adult: isMovie ? !!d.adult : false,
    data_version: `${sourceId}-${isMovie ? (d.title || '') : (d.name || '')}-${isMovie ? (d.release_date || '') : (d.first_air_date || '')}`,
  };
  const payload = isMovie
    ? { ...common, release_date: d.release_date || '', title: d.title || d.original_title || '', original_title: d.original_title || '', runtime: d.runtime || 0 }
    : { ...common, first_air_date: d.first_air_date || '', last_air_date: d.last_air_date || d.first_air_date || '', name: d.name || d.original_name || '', number_of_episodes: d.number_of_episodes || 0, number_of_seasons: d.number_of_seasons || 1, origin_country: d.origin_country || [], original_name: d.original_name || '' };
  const cleanData = { trimId: sourceId, tmdbId: id, imdbId: d.imdb_id || '', doubanId: 0, pinYin: {} };
  return { code: 0, msg: '', data: { cleanData, [isMovie ? 'movie' : 'tv']: payload } };
}

// ---- 通用：把 IMDB 详情（movie/tv）组装成飞牛结构（优先 OMDb，否则 TMDB find 反查） ----
async function buildDetailImdb(sourceId, mediaType) {
  const imdbId = String(sourceId).replace(/^im/, '');
  let o = null;
  if (OMDB_API_KEY) {
    o = await omdbReq(imdbId);
  } else if (TMDB_API_KEY) {
    const f = await tmdbReq(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const list = mediaType === 'movie' ? (f.movie_results || []) : (f.tv_results || []);
    if (list.length) return buildDetailTmdb('tm' + list[0].id, mediaType);
    throw new Error('imdb 未匹配到 TMDB');
  } else {
    throw new Error('IMDB 源未配置 key（需 OMDB_API_KEY 或 TMDB_API_KEY）');
  }
  const poster = registerImg(o.Poster && o.Poster.startsWith('http') ? o.Poster : '');
  const genres = (o.Genre ? o.Genre.split(',').map(s => s.trim()) : []).map((g, i) => ({ id: i, trim_id: i, name: g }));
  const countries = (o.Country ? o.Country.split(',').map(s => s.trim()) : []).map(c => ({ iso_3166_1: c }));
  const common = {
    trim_id: sourceId, id: 0, imdb_id: imdbId, pinYin: {}, backdrop_path: '',
    genres, overview: o.Plot || '', poster_path: poster, production_countries: countries,
    status: mediaType === 'movie' ? 'Released' : 'Returning Series',
    vote_average: Number(o.imdbRating) || 0, vote_count: 0,
    images: { backdrops: [], logos: [], posters: [] },
    keywords: { keywords: null }, alternative_titles: { titles: [] }, content_ratings: { results: [] },
    adult: false, data_version: `${sourceId}-${o.Title || ''}`,
  };
  const payload = mediaType === 'movie'
    ? { ...common, release_date: o.Released || o.Year || '', title: o.Title || '', original_title: o.Title || '', runtime: 0 }
    : { ...common, first_air_date: o.Year || '', last_air_date: o.Year || '', name: o.Title || '', number_of_episodes: 0, number_of_seasons: 1, origin_country: [], original_name: o.Title || '' };
  const cleanData = { trimId: sourceId, tmdbId: 0, imdbId, doubanId: 0, pinYin: {} };
  return { code: 0, msg: '', data: { cleanData, [mediaType === 'movie' ? 'movie' : 'tv']: payload } };
}

// ---- 番剧详情：文字用 Bangumi，封面/背景用 Bangumi 图 ----
async function buildDetailTv(sourceId, authHeaders) {
  const id = Number(String(sourceId).replace(/^bg/, ''));
  const s = await bgmSubjectDetail(id);
  let native = null;
  const tmdbId = bgToTmdb.get(sourceId);
  if (tmdbId) {
    try {
      const fwd = await forwardAndParse(new URL('/detail/tv', UPSTREAM), 'POST',
        Buffer.from(JSON.stringify({ sourceId: tmdbId, source: 'trim_id', language: 'zh-CN', isRescrap: false })),
        { 'content-type': 'application/json', ...(authHeaders || {}) });
      native = (fwd.json && fwd.json.data && fwd.json.data.tv) || null;
    } catch (e) { log('[detail/tv] 原生转发失败:', e.message); }
  }
  const poster = registerImg(bgmImageUrl(s));
  const backdrop = registerImg(bgmImageUrl(s));
  const images = (native && native.images) || { backdrops: [], logos: [], posters: [] };
  const tv = {
    trim_id: sourceId, id, imdb_id: (native && native.imdb_id) || '', pinYin: (native && native.pinYin) || {},
    backdrop_path: backdrop, first_air_date: s.date || '',
    genres: [{ id: 3, trim_id: 3, name: '动画' }], last_air_date: s.date || '',
    name: s.name_cn || s.name, number_of_episodes: s.eps || 0, number_of_seasons: 1,
    origin_country: ['JP'], original_name: s.name,
    overview: s.summary || (native && native.overview) || '',
    poster_path: poster, production_countries: [{ iso_3166_1: 'JP' }],
    status: 'Returning Series',
    vote_average: (s.rating && s.rating.score) || (native && native.vote_average) || 0,
    vote_count: (s.rating && s.rating.total) || (native && native.vote_count) || 0,
    alternative_titles: (native && native.alternative_titles) || { titles: [] },
    content_ratings: (native && native.content_ratings) || { results: [] },
    images, keywords: (native && native.keywords) || { keywords: null },
    adult: false, data_version: `${sourceId}-${s.name_cn || s.name}-${s.date || ''}`,
  };
  const cleanData = (native && native.cleanData) || { trimId: sourceId, tmdbId: 0, imdbId: '', doubanId: 0, pinYin: {} };
  return { code: 0, msg: '', data: { cleanData, tv } };
}

// ---- 单集：bg=Bangumi；tm=TMDB 官方单集；im=退化 TMDB 单集（IMDB 无单集概念） ----
async function buildEpisode(nfo, authHeaders) {
  const id = Number(String(nfo.sourceId).replace(/^bg/, ''));
  const eps = await bgmEpisodes(id);
  const ep = eps.find(e => e.ep === nfo.episode);
  const name = ep ? (ep.name_cn || `第${nfo.episode}集`) : `第${nfo.episode}集`;
  const overview = ep ? ep.description : '';
  const airdate = ep ? ep.airdate : '';
  let still = registerImg(ep ? ep.img : '');
  if (!still) {
    const tmdbId = bgToTmdb.get(nfo.sourceId);
    if (tmdbId) {
      try {
        const fwd = await forwardAndParse(new URL('/search/item', UPSTREAM), 'POST',
          Buffer.from(JSON.stringify({
            fileName: nfo.fileName || '', language: 'zh-CN',
            nfo: { season: nfo.season, episode: nfo.episode, type: 'Episode', source: 'trim_id', sourceId: tmdbId },
            includeAdult: true,
          })), { 'content-type': 'application/json', ...(authHeaders || {}) });
        still = (fwd.json && fwd.json.data && fwd.json.data.episode && fwd.json.data.episode.still_path) || '';
      } catch (e) { log('[search/item] 原生剧照转发失败:', e.message); }
    }
  }
  const tmdbNum = Number(String(bgToTmdb.get(nfo.sourceId) || '').replace(/[^0-9]/g, '')) || 0;
  const episode = {
    trim_id: nfo.sourceId, tmdb_id: tmdbNum, imdb_id: '', pinYin: {},
    air_date: airdate, episode_number: nfo.episode, name, overview, runtime: 0,
    season_number: nfo.season, still_path: still, vote_average: 0, vote_count: 0,
    episode_imdb_id: '', data_version: `${nfo.sourceId}-${nfo.season}-${nfo.episode}-${name}`,
  };
  const cleanData = { trimId: nfo.sourceId, tmdbId: tmdbNum, imdbId: '', doubanId: 0, pinYin: {} };
  return { code: 0, msg: '', data: { cleanData, episode } };
}

async function buildEpisodeTmdb(sourceId, nfo) {
  const id = Number(String(sourceId).replace(/^tm/, ''));
  const ep = await tmdbReq(`/tv/${id}/season/${nfo.season}/episode/${nfo.episode}`, { language: 'zh-CN' });
  const still = registerImg(ep.still_path ? 'https://image.tmdb.org/t/p/w500' + ep.still_path : '');
  const episode = {
    trim_id: sourceId, tmdb_id: id, imdb_id: '', pinYin: {},
    air_date: ep.air_date || '', episode_number: nfo.episode,
    name: ep.name || `第${nfo.episode}集`, overview: ep.overview || '',
    runtime: ep.runtime || 0, season_number: nfo.season, still_path: still,
    vote_average: ep.vote_average || 0, vote_count: 0, episode_imdb_id: '',
    data_version: `${sourceId}-${nfo.season}-${nfo.episode}-${ep.name || ''}`,
  };
  const cleanData = { trimId: sourceId, tmdbId: id, imdbId: '', doubanId: 0, pinYin: {} };
  return { code: 0, msg: '', data: { cleanData, episode } };
}

function sendJson(res, obj) {
  const txt = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(txt) });
  res.end(txt);
}

// ---- 透明转发并取回解析后的 JSON ----
function forwardAndParse(parsedUrl, method, bodyBuffer, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(UPSTREAM);
    const h = { ...headers };
    delete h['host'];
    const upReq = https.request({
      method, hostname: u.hostname, port: u.port || 443,
      path: parsedUrl.pathname + parsedUrl.search, headers: h,
    }, (upRes) => {
      const cs = [];
      upRes.on('data', c => cs.push(c));
      upRes.on('end', () => {
        try {
          const raw = Buffer.concat(cs).toString('utf8');
          let json = null; try { json = JSON.parse(raw); } catch {}
          resolve({ status: upRes.statusCode, headers: upRes.headers, json });
        } catch (e) { reject(e); }
      });
    });
    upReq.on('error', reject);
    if (bodyBuffer && bodyBuffer.length) upReq.write(bodyBuffer);
    upReq.end();
  });
}

// ---- 透明转发官方 mediasvc（原生请求/图片直接走这里） ----
function forward(req, res, parsedUrl, bodyBuffer) {
  const u = new URL(UPSTREAM);
  const headers = { ...req.headers };
  delete headers['host'];
  const upReq = https.request({
    method: req.method, hostname: u.hostname, port: u.port || 443,
    path: parsedUrl.pathname + parsedUrl.search, headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upReq.on('error', (e) => {
    log('[forward] 错误:', parsedUrl.pathname, e.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: -1, msg: 'upstream error: ' + e.message }));
  });
  if (bodyBuffer && bodyBuffer.length) upReq.write(bodyBuffer);
  upReq.end();
}

// ---- 反向代理一张图片（Bangumi / TMDB / IMDB 共用 /bgm_img_*）；带超时防止连接挂死 ----
function serveImage(res, url) {
  const doGet = (target, depth) => {
    if (depth > 3) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('too many redirects'); return; }
    const req = https.get(target, {
      headers: { 'User-Agent': BGM_UA, Referer: 'https://bangumi.tv/' },
      timeout: 10000,
    }, (upRes) => {
      if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
        const next = new URL(upRes.headers.location, target).toString();
        upRes.resume();
        doGet(next, depth + 1);
        return;
      }
      res.writeHead(upRes.statusCode, {
        'content-type': upRes.headers['content-type'] || 'image/jpeg',
        'cache-control': 'public, max-age=86400',
      });
      upRes.pipe(res);
    });
    req.on('timeout', () => {
      req.destroy();
      if (!res.headersSent) { res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' }); res.end('image timeout'); }
    });
    req.on('error', (e) => {
      log('[img] 获取失败:', target, e.message);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('image error'); }
    });
  };
  doGet(url, 0);
}

// ---- 主服务器 ----
const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const bodyBuffer = Buffer.concat(chunks);
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    try {
      if (pathname === '/' || pathname === '/health' || pathname === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('fnos multi-source proxy OK');
        return;
      }
      if (pathname.startsWith('/bgm_img_')) {
        const url = imgMap.get(pathname.slice(1));
        if (!url) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('image not found'); return; }
        return serveImage(res, url);
      }

      if (req.method === 'POST') {
        let body = {};
        try { body = JSON.parse(bodyBuffer.toString('utf8') || '{}'); } catch {}

        // 搜索：原生 + Bangumi + TMDB 直连 + IMDB
        if (pathname === '/search/multi') {
          try {
            const fwd = await forwardAndParse(parsedUrl, 'POST', bodyBuffer, req.headers);
            let upstreamList = [];
            try { upstreamList = (fwd.json && fwd.json.data && fwd.json.data.list) || []; } catch {}
            let merged = upstreamList;
            if (INJECT_BANGUMI && BGM_TOKEN) {
              const cands = await buildSearchCandidates(body.keyword, upstreamList);
              if (cands.length) { merged = [...cands, ...merged]; log(`[search/multi] "${body.keyword}" 注入 Bangumi 候选 ${cands.length} 条`); }
            }
            const { tmdb, imdb } = await buildTmdbCandidates(body.keyword, upstreamList);
            if (tmdb.length || imdb.length) {
              merged = [...tmdb, ...imdb, ...merged];
              log(`[search/multi] "${body.keyword}" 注入 TMDB ${tmdb.length} / IMDB ${imdb.length} 候选`);
            }
            sendJson(res, { code: 0, msg: '', data: { list: merged } });
          } catch (e) {
            log('[search/multi] 失败:', e.message);
            sendJson(res, { code: -1, msg: e.message });
          }
          return;
        }

        // meta/diff：bg/tm/im 本地应答，原生转发
        if (pathname === '/meta/diff') {
          const tid = String(body.trimId || '');
          if (tid.startsWith('bg') || tid.startsWith('tm') || tid.startsWith('im')) {
            sendJson(res, { code: 0, msg: '', data: { hasDiff: false } });
            return;
          }
          return forward(req, res, parsedUrl, bodyBuffer);
        }

        // 番剧详情：bg→Bangumi；tm→TMDB；im→IMDB；其余转发
        if (pathname === '/detail/tv') {
          const sid = String(body.sourceId || '');
          try {
            if (sid.startsWith('bg')) { sendJson(res, await buildDetailTv(sid, req.headers)); return; }
            if (sid.startsWith('tm')) { sendJson(res, await buildDetailTmdb(sid, 'tv')); return; }
            if (sid.startsWith('im')) { sendJson(res, await buildDetailImdb(sid, 'tv')); return; }
          } catch (e) { log('[detail/tv] 失败:', sid, e.message); sendJson(res, { code: -1, msg: e.message }); return; }
          return forward(req, res, parsedUrl, bodyBuffer);
        }

        // 电影详情：tm→TMDB；im→IMDB；其余转发
        if (pathname === '/detail/movie') {
          const sid = String(body.sourceId || '');
          try {
            if (sid.startsWith('tm')) { sendJson(res, await buildDetailTmdb(sid, 'movie')); return; }
            if (sid.startsWith('im')) { sendJson(res, await buildDetailImdb(sid, 'movie')); return; }
          } catch (e) { log('[detail/movie] 失败:', sid, e.message); sendJson(res, { code: -1, msg: e.message }); return; }
          return forward(req, res, parsedUrl, bodyBuffer);
        }

        // 单集：bg→Bangumi；tm→TMDB 单集；im→退化 TMDB 单集；其余转发
        if (pathname === '/search/item') {
          const nfo = body.nfo || {};
          const sid = String(nfo.sourceId || '');
          try {
            if (sid.startsWith('bg')) { sendJson(res, await buildEpisode(nfo, req.headers)); return; }
            if (sid.startsWith('tm')) { sendJson(res, await buildEpisodeTmdb(sid, nfo)); return; }
            if (sid.startsWith('im')) {
              const tmId = [...tmToImdb].find(([, v]) => v === sid.slice(2))?.[0];
              if (tmId) { sendJson(res, await buildEpisodeTmdb(tmId, nfo)); return; }
              sendJson(res, { code: 0, msg: '', data: { cleanData: { trimId: sid, tmdbId: 0, imdbId: sid.slice(2), doubanId: 0, pinYin: {} }, episode: { trim_id: sid, tmdb_id: 0, imdb_id: '', pinYin: {}, air_date: '', episode_number: nfo.episode, name: `第${nfo.episode}集`, overview: '', runtime: 0, season_number: nfo.season, still_path: '', vote_average: 0, vote_count: 0, episode_imdb_id: '', data_version: `${sid}-${nfo.season}-${nfo.episode}` } } });
              return;
            }
          } catch (e) { log('[search/item] 失败:', sid, e.message); sendJson(res, { code: -1, msg: e.message }); return; }
          return forward(req, res, parsedUrl, bodyBuffer);
        }

        // 其余 POST（detail/person、detail/season、detail/episode、genres 等）全部转发
        return forward(req, res, parsedUrl, bodyBuffer);
      }

      // 其余 GET（lan/*、/t/p/* 原生图片等）转发
      return forward(req, res, parsedUrl, bodyBuffer);
    } catch (e) {
      log('[server] 未捕获异常:', e.message);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: -1, msg: e.message })); }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('========================================');
  log('fnos 多源刮削代理已启动');
  log('监听 :' + PORT + '  (0.0.0.0)');
  log('上游 mediasvc =', UPSTREAM);
  log('Bangumi :', INJECT_BANGUMI ? (BGM_TOKEN ? '开启(已加载token)' : '【缺 token，搜索不注入】') : '关闭');
  log('TMDB直连 :', INJECT_TMDB ? '开启(key已配置)' : (TMDB_API_KEY ? '关闭(需 INJECT_TMDB=1)' : '关闭(缺 TMDB_API_KEY)'));
  log('IMDB    :', INJECT_IMDB ? (OMDB_API_KEY || TMDB_API_KEY ? '开启' : '【缺 key，无法解析】') : '关闭');
  log('日志 ->', LOG);
  log('========================================');
});

server.on('error', (e) => {
  log('[server] 监听失败（端口可能被占用）:', e.message);
  process.exit(1);
});
