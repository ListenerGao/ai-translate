#!/usr/bin/env bash
# aitd 开机自启：用户级 LaunchAgent，登录后自动启动，异常退出自动拉起；随时可以卸载。
# 用法：scripts/aitd-service.sh install | uninstall | status
# launchd 里没有 nvm 和 Homebrew 的 PATH：install 时把 Node 22 和 llama-server 的绝对路径写进 plist，升级 Node 后要重新 install。
# 开机后等 60 秒再加载模型（不和登录时的其他程序抢资源），之后常驻、不空闲停止，用的时候不用等模型启动。
# 换量化版本：在桌面应用「设置 → 模型」里切换（选择存在 settings.json，重启后照用）；
# 也可以 AIT_QUANT=Q4_K_M scripts/aitd-service.sh install，这样就固定用它，App 里不能切换
# 想改回用到时启动、空闲 30 分钟停：AIT_PRELOAD_SECONDS=-1 AIT_IDLE_MINUTES=30 scripts/aitd-service.sh install
set -euo pipefail

LABEL="com.listenergao.ai-translate.aitd"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AIT_HOME="$HOME/Library/Application Support/ai-translate"
LOG="$AIT_HOME/logs/launchd.log"
DOMAIN="gui/$(id -u)"
PORT=8790

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
healthy() { curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

# 按 .nvmrc 找 nvm 里的 Node：先找 $NVM_DIR（默认 ~/.nvm），再找用 Homebrew 装的 nvm（nvm.sh 不兼容 set -u，临时关掉）
node_path() {
  set +u
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  local script
  for script in "$NVM_DIR/nvm.sh" "$(brew --prefix nvm 2>/dev/null)/nvm.sh"; do
    # shellcheck disable=SC1090
    [[ -s "$script" ]] && source "$script" >/dev/null 2>&1 && break
  done
  command -v nvm >/dev/null 2>&1 || { echo "找不到 nvm：先安装 nvm（见 docs/development.md「从源码安装」），再运行 nvm install" >&2; exit 1; }
  nvm which "$(cat "$ROOT/.nvmrc")" 2>/dev/null | tail -1
  set -u
}

install() {
  local node llama quant_env=""
  node="$(node_path)"
  [[ -x "$node" ]] || { echo "找不到 Node $(cat "$ROOT/.nvmrc")：先运行 nvm install" >&2; exit 1; }
  llama="$(command -v llama-server || true)"
  [[ -n "$llama" ]] || { echo "找不到 llama-server：先运行 brew install llama.cpp" >&2; exit 1; }
  if loaded; then
    launchctl bootout "$DOMAIN/$LABEL"
    sleep 1
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "端口 $PORT 被占用（可能还开着 npm run aitd）：先停掉它再安装" >&2
    exit 1
  fi
  [[ -n "${AIT_QUANT:-}" ]] && quant_env="<key>AIT_QUANT</key><string>$AIT_QUANT</string>"
  mkdir -p "$HOME/Library/LaunchAgents" "$AIT_HOME/logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$ROOT/apps/server/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIT_LLAMA_SERVER</key><string>$llama</string>
    <key>AIT_PRELOAD_SECONDS</key><string>${AIT_PRELOAD_SECONDS:-60}</string>
    <key>AIT_IDLE_MINUTES</key><string>${AIT_IDLE_MINUTES:-0}</string>
    <key>PATH</key><string>$(dirname "$llama"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    $quant_env
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- 异常退出才拉起；正常退出（注销、卸载）不拉起 -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <!-- 生成的文件只给自己读写 -->
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  launchctl bootstrap "$DOMAIN" "$PLIST"
  for _ in $(seq 1 50); do
    if healthy; then
      echo "已安装并启动：http://127.0.0.1:$PORT（登录后自动启动；日志 $LOG）"
      return
    fi
    sleep 0.2
  done
  echo "已安装，但 10 秒内没有启动起来：看 $LOG" >&2
  exit 1
}

uninstall() {
  if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
  rm -f "$PLIST"
  echo "已卸载：不再开机自启（要用时运行 npm run aitd）"
}

status() {
  if ! loaded; then
    echo "没有安装开机自启"
    return
  fi
  launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|last exit code) =" | sed 's/^[[:space:]]*/  /'
  if healthy; then echo "  服务：正常（http://127.0.0.1:$PORT）"; else echo "  服务：连不上，看 $LOG"; fi
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *)
    echo "用法：scripts/aitd-service.sh install | uninstall | status" >&2
    exit 2
    ;;
esac
