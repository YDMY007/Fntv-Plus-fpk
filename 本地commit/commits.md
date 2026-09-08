# 本地 Commit 日志（fntvplus 项目 · 回退锚点）

> 本文件为 fntvplus 项目的本地 commit 回退锚点日志。
>
> - **标识符** = 本地轻量 tag `lc-NNN`（如 `lc-001`）。回退：`git -C D:/GitHub/Fntv-Plus-Desktop/fntvplus checkout lc-NNN`
> - 查 hash：`git rev-parse --short lc-NNN`。回到最新：`git checkout main`
> - 本地 commit/tag **不 push**（遵循"不主动 push"约定）。
> - 规则：每次改动由 AI 自动本地 commit，并 append 一行到此表，同时打 `lc-NNN` tag。
> - 本项目从 `lc-001` 开始编号（与 Fntv-Plus 仓库的 lc 序列互不干扰）。

| 标识符 | 日期 | 说明 |
|--------|------|------|
| lc-001 | 2026-09-07 | 初始化项目：复用 Fntv-Plus preload（embyWall 海报墙/轮播/沉浸式美化 + core/*）逐字复制到 src/preload/；新增 web-entry.ts（DOM ready 后 runHooks(OnReady) 触发自注册的 embyWall）+ src/shim/electron.js 浏览器垫片（settings:* → localStorage，其余 no-op）+ scripts/build-userjs.mjs（esbuild 打包为 dist/fntv-plus.user.js）；dev 静态服务 scripts/serve.mjs + 冒烟 scripts/smoke.mjs + demo/host.html；建立本地 commit 工作流（lc-001 起）与 .gitignore；完善开发文档 §5.5 复用机制 |
| lc-002 | 2026-09-07 | 实现方案 D「Go 反代注入后端」（M1 骨架跑通）：src/go/ 下 cmd/fntvplus（flag + 上游推导）+ internal/{config,inject,proxy,admin}；反代剥离 /app/fntvplus 前缀回环影视 /v，text/html 注入 payload 引用块（带 FNTV_PLUS_INJECT_BEGIN/END 幂等标记），非 HTML（含视频 206）原样流式透传；payload 经 //go:embed 打进单二进制、独立端点长缓存 + 内容哈希版本；管理页 + /api/settings 增强总开关（存 TRIM_PKGETC/config.json）；cmd/mockupstream 联调假影视；integration_test.go 断言注入/206/设置/幂等，go test 全绿，linux amd64/arm64 交叉编译通过。配套 FPK 打包骨架：manifest、config/{privilege,resource}、cmd/{main,install_callback,uninstall_callback}、app/ui/config 桌面入口、wizard/install、scripts/build-fpk.sh；清理构建产物并把 server/ 等加入 .gitignore；更新开发文档 §5.5 与项目记忆（注入宿主：未做→已做） |
| lc-003 | 2026-09-07 | 一键打包成飞牛应用（exe）：新增 tools/buildfpk/main.go（Go 源码）编译为根目录 build-fpk.exe——自动查 tools/fnpack.exe 或 Downloads 下 fnpack*；一键链路 = node 重建 dist payload → 同步到 //go:embed 目录 → 交叉编译 linux/amd64 后端到 app/server/fntvplus（fnpack 只打包 app/ 内容，根目录 server/ 不进包）→ fnpack build 产出 fntvplus.fpk；附 一键打包.bat（chcp 65001 + pause）。实跑验证：fpk 5.2MB，app.tgz 含 server/fntvplus + ui/config，与 cmd/main 的 $TRIM_APPDEST/server/fntvplus 对齐。补齐 fnpack 必需文件：ICON.PNG/ICON_256.PNG（占位图）+ cmd/{install_init,uninstall_init,config_init,config_callback,upgrade_init,upgrade_callback}；发现 wizard/install 目录存在即触发严格 schema 校验（空目录也失败）→ 暂移除向导，样例存 docs/wizard-install.example.json 待研究官方 schema；修 install_callback payload 路径（app/server/payload → server/payload，app/ 解包落 TRIM_APPDEST 根）；build-fpk.sh 输出改到 app/server/（arm64 加 WITH_ARM64=1）；.gitignore 增加 build-fpk.exe/tools//*.fpk |
| lc-004 | 2026-09-08 | 修复 NAS 安装后 not found（后端未启动）：根因是 Windows fnpack 打包所有文件权限位 0666、二进制无可执行位 → cmd/main 的 nohup Permission denied。修复：install_callback 与 cmd/main 启动前 chmod +x 二进制；cmd/main 加诊断日志（start/stop 各步落 $TRIM_PKGVAR/fntvplus.log，BIN 缺失时 ls TRIM_APPDEST 辅助定位解包路径）。管理页升级（用户要求"配置 UI + 实时日志"）：新增 /app/fntvplus/api/status（版本/上游连通性探测/payload 哈希/日志路径）+ /api/logs（tail N 行）；管理页加「运行状态」卡（5s 自动刷新，上游不通给 FNTV_UPSTREAM 提示）与「实时日志」卡（行数可选 + 自动刷新 + 贴底滚动）。go vet/test 全绿，mock 上游端到端验证 status/logs/注入。版本 0.2.0（manifest 与 Go const 同步） |
| lc-005 | 2026-09-08 | 修复桌面入口 not found（v0.3.0）：查官方文档 developer.fnnas.com 纠正端口服务模式——不存在 /app/<appname> 自动网关路由，app/ui/config 必须带 protocol=http + port=22350（fnOS 直连 NAS:端口打开入口）；后端监听 127.0.0.1 → 0.0.0.0；未知路径兜底由 404 改为全量反代上游（SPA 静态资源不全在 /v/ 下）；官方文档还确认 wizard/install 是合法目录（install/upgrade/uninstall/config 四类）、manifest 全字段语义。E2E 验证注入/admin/status/未知路径透传后重打包 |
| lc-006 | 2026-09-08 | 上游地址管理页热修改：config.upstream 运行时生效（代理每请求取生效值，空/非法回退启动推导值）；状态卡上游地址可编辑+保存；status 上报 upstream/upstream_default；启动仅在配置为空时写入推导值不覆盖自定义。E2E 双向验证（清空→回退不通✓，热切→连通+注入✓） |
| lc-007 | 2026-09-08 | 上游不可用出错页升级为自助修复页：502 内嵌上游地址输入框（预填当前生效值）+「保存并重试」自动刷新，不再是一行纯文本；用户反馈找不到填地址入口。干净环境回归：502✓/预填✓/保存后注入✓ |
| lc-008 | 2026-09-08 | 修复增强不生效：embyWall 的 isFntvTvPage()（preload/core/pageMode.ts）要求 pathname 以 /v 开头，桌面入口 /app/fntvplus/v/ 不满足 → TV 改造全跳过，用户看到原样影视页；桌面入口 URL 改为 /v/（后端裸 /v/ 路由已有），SPA 视角与桌面版 Electron 一致；代理加注入成功日志便于实时日志确认 |
| lc-009 | 2026-09-08 | 应用中心打开应用 → 配置页（desktop_applaunchname 改指 fntvplus.Settings），配置+状态+实时日志作为主入口；影视 Plus 仍走桌面图标 |
| lc-010 | 2026-09-08 | 桌面入口 iframe→url：点应用在新浏览器标签页打开完整网页（非 fnOS 应用小窗），两入口（影视 Plus/设置）都改 |
| lc-011 | 2026-09-08 | 日志入口三件套：payload 诊断回传（web/diag.ts 拦 [EmbyWall]/[fntv] console + 全局错误 → POST /api/client-log）；后端落 client.log（5MB 轮转）+ logs 接口合并后端/前端两路；注入页左下角半透明「日志」按钮 → 设置页。轮播墙失败原因从此可在实时日志看到 |
| lc-012 | 2026-09-08 | 修海报墙全挂：根因=网页端无 fnos-gen-authx 签名器（undefined 头被序列化发出去全拒）。diag 钩 XHR/fetch 捕获页面自身 Authx 供 shim 回放；fetch 剥离坏 Authx 头（sys/img cookie 直取）；shim 默认开 embyWall 日志总开关（[DIAG] fetchImg 带状态码可见）。用户日志证据：item/list invalid sign code=5000 → DOM 兜底选出 18 项 → lc-768 全部海报无法加载 |
| lc-013 | 2026-09-08 | 版本 0.4.0。新约定：每次更新打包版本号 +0.1（manifest 与 src/go/cmd/fntvplus/main.go 的 appVersion 两处同步改） |
| lc-014 | 2026-09-08 | v0.5.0 彻底修签名：从桌面版 fnosAuth.js 提取 Authx 算法（KEY+SECRET+md5 拼接），shim 本地 genAuthx 真签名（md5.ts 移植 uuid 包实现，5/5 向量过）；不再依赖捕获回放，item/{guid} 等任意接口可签 |
| lc-015 | 2026-09-08 | v0.6.0 飞牛影视特化：设置面板精简（通用整页删/外观只留两滑块/播放只留片头片尾+滚轮横滚；弹幕/账号/网络/手柄/诊断/关于保留；隐藏原始播放按钮游离）。手术式改法：cats 数组裁剪 + buildAppearanceControls 瘦身，孤儿卡不挂载即不可见，回填处 null/变量守卫已核对 |
| lc-016 | 2026-09-08 | v0.7.0 外观卡恢复主题模式三选一（浅色/深色/跟随系统）——用户要求保留 |
| lc-017 | 2026-09-08 | v0.8.0：网络分类删「网络与代理」卡（自定义代理+TMDB直连保留）；侧边栏左下角「切换系统页面/切换NAS界面」按钮移除（侧栏只剩 设置→软件反馈建议） |
| lc-018 | 2026-09-08 | v0.9.0 修反馈弹窗：qrcode.png 内嵌 Go 后端直出（/app/fntvplus/qrcode.png），shim app:qr-image fetch→dataUri；app:open-external → window.open 新标签。E2E：端点 200/image/png/97619B/有效 PNG 头 |
| lc-019 | 2026-09-08 | v0.10.0 日志入口收敛：左下角悬浮按钮删；诊断与日志卡四按钮（日志文件/报错日志/导出日志/MPV日志）删，替换为实时日志查看器（/api/logs 轮询 5s 自动刷新，合并后端+前端两路，防定时器泄漏） |
| lc-020 | 2026-09-08 | v0.10.1 删两条刷屏日志：fetchImg 成功逐条打→仅失败留证据；lc-925 图标反色每次调度打→删除（异常日志保留） |
| lc-021 | 2026-09-08 | v0.11.0 补回观影记录：watchHistory.ts 插件从未被 web-entry import（lc-001 只挂 embyWall）——补 import；Authx 真签名使网页端能拉已观看数据 |
| lc-022 | 2026-09-08 | v0.12.0 外观卡只留主题模式三选一：亚克力透明度/背景模糊两滑块移除（buildAppearanceControls 删除；启动默认值不变） |
| lc-023 | 2026-09-08 | v0.13.0 删「切换NAS界面」残余：非影视页零注入（返回影视/外部播放浮动按钮删除，IPC no-op 残留根源）；视频预览外放保留（lc-389） |
| lc-024 | 2026-09-08 | v0.14.0 实时日志「自动刷新」开关改胶囊样式（原生 checkbox 深色主题显示异常→track+knob 自绘，与面板开关统一） |
| lc-025 | 2026-09-08 | v0.15.0 设置面板重排：8类→6类（外观=主题+界面交互；播放=片头片尾+手柄；弹幕；账号与网络合并；诊断与日志；关于），界面与浏览卡更名界面交互 |
| lc-026 | 2026-09-08 | v0.16.0 账号与网络全面移植：internal/bridge 包（fnOS 签名桥/白名单外代理/TMDB 图+logo+详情/Trakt 凭证+设备授权+scrobble+sync/Bangumi 日历/豆瓣状态占位）；config Extra 平铺任意键（自定义 Marshal/Unmarshal）；settings API GetMap；shim 全通道映射（settings 服务端持久化+trakt 9 通道+tmdb 3 通道+bangumi/douban）。待续：豆瓣评分增强/Bangumi 同步核心/Trakt 搜索匹配细化 |
| lc-027 | 2026-09-08 | v0.17.0 移植收尾：douban/watched（全库钻取进度分析，桌面同形状）、douban/enrich（TMDB 分类/评分+豆瓣评分尽力抓）、bangumi/sync-progress（搜条目→标集/条目）；修 douban/status 路由误删；shim 对应三通道映射 |
| lc-028 | 2026-09-08 | v0.18.0 免梯子直连移植：tmdb/update-ip（CheckTMDB hosts→api/image IP 持久化，force 语义与桌面一致）；tmdbClient IP 直连（DialTLS 连 IP+SNI 用域名）；配自定义代理可走代理拉取。被墙时错误文案与桌面一致 |
| lc-029 | 2026-09-08 | v0.19.0 日志治理：后端启动清零 client.log（日志=本次运行会话）；diag 时间戳带日期。用户看到的 [lc-925] 刷屏是旧会话历史条目（payload 已无此日志，repo/dist/embed 三处 0 命中已验证） |
| lc-030 | 2026-09-08 | v0.20.0 实时日志「自动刷新」开关移除——始终自动刷新（5s），保留手动刷新按钮 |
| lc-032 | 2026-09-08 | v0.21.0 品牌化：display_name=Fntv-Plus；双入口独立图标（fntv_*/setting_* 64+256，2048 原图归档 docs/）；应用中心图标换新 |
| lc-033 | 2026-09-08 | v0.22.0 图标统一：全部入口/应用中心统一蓝牛主图标；冰块设置图白边为其画风自带（像素分析：全图不透明），按统一要求弃用 |
| lc-034 | 2026-09-08 | v0.23.0 图标统一为冰块图（应用中心+双入口全部用户指定冰块图） |
| lc-035 | 2026-09-08 | v0.24.0 图标更新：用户重制 jpeg 两张——主入口/应用中心用主图，设置入口独立图标（64/256 双档），原图归档 docs/ |
| lc-036 | 2026-09-08 | v0.25.0 修 TMDB search 401：TMDB 双格式鉴权（v3 api_key / v4 Bearer JWT 双支持，与桌面一致），非 200 附 Key 格式诊断 |
| lc-037 | 2026-09-08 | v0.26.0 修免梯子直连保存后显示未开启：set-tmdb-direct 复合对象拆 tmdbDirectConnect/tmdbDirectIp 两字段（与桌面 config 对齐），Go 读键同步修正；连带修 dandanplay-credentials 双参数拆分 |
