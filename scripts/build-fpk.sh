#!/usr/bin/env bash
# build-fpk.sh —— 为飞牛 FPK 构建 Go 后端二进制。
#
# 产物（相对 fntvplus 仓库根）：
#   server/fntvplus            linux/amd64 二进制（fnOS x86 包）
#   server/fntvplus-arm64      linux/arm64 二进制（fnOS arm 包）
#   app/server/payload/fntv-plus.user.js    payload 副本（后端以内置嵌入为准，此为手动覆盖/调试预留）
#
# 用法（在 fntvplus/ 仓库根执行）：
#   bash scripts/build-fpk.sh
#
# 前置：Go 1.23+（交叉编译无需目标平台工具链，纯标准库）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GO="${GO:-go}"

echo "==> building linux/amd64 ..."
( cd src/go && GOOS=linux GOARCH=amd64 "$GO" build -o "$ROOT/server/fntvplus" ./cmd/fntvplus )

echo "==> building linux/arm64 ..."
( cd src/go && GOOS=linux GOARCH=arm64 "$GO" build -o "$ROOT/server/fntvplus-arm64" ./cmd/fntvplus )

echo "==> copying payload (from dist/ if present) ..."
mkdir -p app/server/payload
if [ -f dist/fntv-plus.user.js ]; then
  cp dist/fntv-plus.user.js app/server/payload/fntv-plus.user.js
  echo "    copied dist/fntv-plus.user.js -> app/server/payload/"
else
  echo "    WARN: dist/fntv-plus.user.js not found (run 'node scripts/build-userjs.mjs' first). Backend still ships embedded payload."
fi

echo "==> done. Files:"
ls -la server/ app/server/payload/ 2>/dev/null
