#!/bin/bash
# fnos-scraper 部署脚本 —— Fntv-Plus fpk 托管安装「方案 A:NAS 原生 Node 刮削代理」。
# 实现 PLAN-A-NAS原生部署实施方案.md §3/§4/§5 的交付物与执行顺序,供 cmd/install_callback 调用。
#
# 用法: bash scraper-deploy.sh --enable --token <BGM_TOKEN> --port <7788>
#      bash scraper-deploy.sh --disable            # 卸载还原(不删数据)
# 环境约定: 由 cmd/install_callback 提供 TRIM_APPDEST(app/ 解包根)。
# 幂等 + flock;与 trim.media 的操作只走 /var/apps/trim.media/cmd/main stop|start。
set -uo pipefail

ENABLE=0; DISABLE=0; BGM_TOKEN=""; SCRAPER_PORT="7788"
while [ $# -gt 0 ]; do
  case "$1" in
    --enable) ENABLE=1 ;;
    --disable) DISABLE=1 ;;
    --token) BGM_TOKEN="${2:-}"; shift ;;
    --port) SCRAPER_PORT="${2:-7788}"; shift ;;
  esac
  shift
done

DATA_DIR="/vol1/@appdata/fnos-scraper"
SS_PATH="/var/apps/trim.media/cmd/service-setup"
TRIM_MAIN="/var/apps/trim.media/cmd/main"
LOG="$DATA_DIR/fpk-deploy.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [scraper-deploy] $*" >> "$LOG"; }
fail() { log "FATAL: $*"; echo "[scraper-deploy] FATAL: $*" >&2; exit 1; }

mkdir -p "$DATA_DIR/backup" 2>/dev/null || fail "无法创建 $DATA_DIR(需要 root;fpk 生命周期以 root 运行)"

exec 9>"$DATA_DIR/lock" 2>/dev/null || fail "无法创建锁文件"
flock -n 9 || { log "另一部署进程在跑,跳过"; exit 0; }

# ── 卸载路径 ──
if [ "$DISABLE" = "1" ]; then
  log "==== disable requested ===="
  systemctl disable --now fnos-scraper-repair.path fnos-scraper-repair.service fnos-scraper.service >/dev/null 2>&1
  rm -f /etc/systemd/system/fnos-scraper.service /etc/systemd/system/fnos-scraper-repair.path /etc/systemd/system/fnos-scraper-repair.service
  systemctl daemon-reload >/dev/null 2>&1; systemctl reset-failed 2>/dev/null
  if [ -f "$DATA_DIR/backup/service-setup.last-good" ] && grep -q '^ITEM_OPT="--item=' "$SS_PATH" 2>/dev/null; then
    cp -a "$DATA_DIR/backup/service-setup.last-good" "$SS_PATH"
    [ -x "$TRIM_MAIN" ] && { "$TRIM_MAIN" stop >/dev/null 2>&1; "$TRIM_MAIN" start >/dev/null 2>&1; }
    log "service-setup 已还原, trim.media 已重启"
  fi
  log "==== disable done(数据保留于 $DATA_DIR) ===="
  exit 0
fi

# ── 部署路径 ──
log "==== deploy requested (port=$SCRAPER_PORT token=$([ -n "$BGM_TOKEN" ] && echo set || echo EMPTY)) ===="

# ① 环境检查:trim.media 存在性(非飞牛影视环境直接跳过,不算失败——fpk 可能装在无影视的机器)
[ -f "$SS_PATH" ] || { log "trim.media service-setup 不存在,跳过刮削代理部署(非影视环境或版本不匹配)"; exit 0; }

# ② Node 探测(顺序:nodejs_v22 应用 → @appcenter 全局 → PATH)
NODE_BIN=""
for cand in /vol1/@appcenter/nodejs_v22/bin/node /vol1/@appcenter/nodejs/bin/node; do
  [ -x "$cand" ] && { NODE_BIN="$cand"; break; }
done
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(find /vol1/@appcenter -maxdepth 3 -name node -type f 2>/dev/null | head -1)"
fi
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node 2>/dev/null)"
[ -z "$NODE_BIN" ] && fail "未找到 Node(≥18)。请在飞牛应用中心安装 Node.js 后重装本应用。"
log "NODE_BIN=$NODE_BIN ($("$NODE_BIN" --version 2>/dev/null))"

# ③ 部署代理文件与配置
cp -f "$TRIM_APPDEST/scraper/proxy.mjs" "$DATA_DIR/proxy.mjs" || fail "proxy.mjs 部署失败"
chmod +x "$DATA_DIR/proxy.mjs"
umask 077
{
  echo "PORT=$SCRAPER_PORT"
  echo "UPSTREAM=https://mediasvc.fnnas.com"
  echo "BGM_TOKEN=$BGM_TOKEN"
  echo "INJECT_BANGUMI=1"
  echo "INJECT_TMDB=0"
  echo "INJECT_IMDB=0"
} > "$DATA_DIR/env"
chmod 600 "$DATA_DIR/env"

# ④ systemd 单元(ExecStart 的 Node 路径注入)
cat > /etc/systemd/system/fnos-scraper.service <<UNIT
[Unit]
Description=fnOS multi-source scraper proxy (Bangumi/TMDB/IMDB) by Fntv-Plus
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $DATA_DIR/proxy.mjs
EnvironmentFile=$DATA_DIR/env
WorkingDirectory=$DATA_DIR
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/fnos-scraper-repair.path <<'UNIT'
[Unit]
Description=Watch trim.media service-setup for changes (app upgrade overwrite)

[Path]
PathChanged=/var/apps/trim.media/cmd/service-setup
Unit=fnos-scraper-repair.service

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/fnos-scraper-repair.service <<UNIT
[Unit]
Description=Re-apply --item hook after trim.media upgrade

[Service]
Type=oneshot
ExecStart=/bin/bash $DATA_DIR/repair.sh
UNIT
systemctl daemon-reload

# ⑤ 先启动代理并健康检查(顺序铁律:代理跑通才动 trim.media)
systemctl enable --now fnos-scraper.service fnos-scraper-repair.path
sleep 2
curl -fsS --max-time 5 "http://127.0.0.1:$SCRAPER_PORT/health" >/dev/null || fail "代理健康检查失败(journalctl -u fnos-scraper)"

# ⑥ service-setup 补丁(锚点式,幂等,失败自动回滚)
patch_service_setup() {
  set -euo pipefail
  if grep -q '^ITEM_OPT="--item=' "$SS_PATH"; then log "service-setup 已打过补丁,跳过"; return 0; fi
  grep -q '^# ITEM_OPT="--item="' "$SS_PATH" || { log "FATAL: 模板锚点缺失,fnOS 结构已变化,不盲改"; return 9; }
  cp -a "$SS_PATH" "$DATA_DIR/backup/service-setup.orig-$(date +%Y%m%d-%H%M%S)"
  cp -a "$SS_PATH" "$DATA_DIR/backup/service-setup.last-good"
  sed -i "s|^# ITEM_OPT=\"--item=\"\$|ITEM_OPT=\"--item=http://127.0.0.1:$SCRAPER_PORT\"|" "$SS_PATH"
  sed -i 's|^# SUBTITLE_OPT="--subtitle="$|SUBTITLE_OPT=""|' "$SS_PATH"
  sed -i 's|^\(SERVICE_COMMAND\[0\]=.*\)"$|\1 ${ITEM_OPT} ${SUBTITLE_OPT}"|' "$SS_PATH"
  if ! bash -n "$SS_PATH"; then
    cp -a "$DATA_DIR/backup/service-setup.last-good" "$SS_PATH"
    log "FATAL: 补丁后 bash -n 失败,已回滚"; return 8
  fi
  log "service-setup 补丁完成"
}

flock "$DATA_DIR/lock" bash -c "$(declare -f patch_service_setup log); \
  LOG='$LOG'; SS_PATH='$SS_PATH'; DATA_DIR='$DATA_DIR'; SCRAPER_PORT='$SCRAPER_PORT'; \
  patch_service_setup"
RC=$?
[ $RC -ne 0 ] && fail "service-setup 补丁失败(rc=$RC)"

# ⑦ 重启 trim.media(官方入口)+ 修复脚本(自愈单元用)
cat > "$DATA_DIR/repair.sh" <<REPAIR
#!/bin/bash
# 自愈:影视升级覆盖 service-setup 后由 fnos-scraper-repair.path 触发(去抖+幂等+flock)。
exec 9>"$DATA_DIR/lock"; flock -n 9 || exit 0
sleep 20
SS="$SS_PATH"
if grep -q '^ITEM_OPT="--item=' "\$SS"; then exit 0; fi
grep -q '^# ITEM_OPT="--item="' "\$SS" || exit 0   # 模板变了只静默退出,不盲改
cp -a "$DATA_DIR/backup/service-setup.last-good" /dev/null 2>/dev/null
sed -i "s|^# ITEM_OPT=\"--item=\"\$|ITEM_OPT=\"--item=http://127.0.0.1:$SCRAPER_PORT\"|" "\$SS"
sed -i 's|^# SUBTITLE_OPT="--subtitle="\$|SUBTITLE_OPT=""|' "\$SS"
sed -i 's|^\\(SERVICE_COMMAND\\[0\\]=.*\\)"\$|\\1 \${ITEM_OPT} \${SUBTITLE_OPT}"|' "\$SS"
bash -n "\$SS" || { cp -a "$DATA_DIR/backup/service-setup.last-good" "\$SS"; exit 8; }
/var/apps/trim.media/cmd/main stop >/dev/null 2>&1
/var/apps/trim.media/cmd/main start >/dev/null 2>&1
echo "\$(date '+%F %T') repair: hook re-applied" >> "$DATA_DIR/repair.log"
REPAIR
chmod +x "$DATA_DIR/repair.sh"

"$TRIM_MAIN" stop >/dev/null 2>&1
"$TRIM_MAIN" start >/dev/null 2>&1
sleep 2
curl -fsS --max-time 5 "http://127.0.0.1:8005/v/api/v1/sys/pid" >/dev/null || log "WARN: trim.media 探活失败(可能仍在启动,不影响部署)"

# ⑧ 端到端验证
PS_OK="$(ps -ef | grep '[t]rim-media' | grep -c -- '--item=' || true)"
log "==== deploy done. --item 在命令行: $PS_OK 处 ===="
if [ -z "$BGM_TOKEN" ]; then
  log "提示: 未配置 Bangumi Token——代理照常透传官方,番剧候选需在管理页写入 token 后重启 fnos-scraper"
fi
exit 0
