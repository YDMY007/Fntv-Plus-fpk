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
