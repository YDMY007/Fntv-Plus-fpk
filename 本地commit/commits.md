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
