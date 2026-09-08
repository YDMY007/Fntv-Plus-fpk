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
