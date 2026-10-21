#!/usr/bin/env bash
# 桌面应用 AI Translate：编译、组装 .app、用本机自签名证书签名、安装到 ~/Applications。
# 用法：scripts/install-desktop.sh build | install | uninstall | sign <路径>…
#   build      编译并组装到 apps/desktop/build/AI Translate.app（不安装）
#   install    build 后装到 ~/Applications/AI Translate.app 并启动（已装的先退出再替换）
#   uninstall  退出并删除 ~/Applications/AI Translate.app
#   sign       用同一张证书给指定的文件或 App 签名（发布包脚本 scripts/package-release.sh 用：先签 App 里的 Node、llama-server，再签 App）
# 签名证书放在单独的钥匙串文件 $AIT_HOME/signing/ 里，第一次 build 时自动生成（主人 2026-10-20 授权），登录钥匙串不动。
# 身份固定，更新 App 后辅助功能授权仍然有效。只管自己装的 App：同名但不是本项目的就不动它。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/apps/desktop"
NAME="AI Translate"
BUNDLE_ID="com.listenergao.ai-translate.desktop"
BUILD_APP="$PKG/build/$NAME.app"
TARGET="$HOME/Applications/$NAME.app"
AIT_HOME="${AIT_HOME:-$HOME/Library/Application Support/ai-translate}"
SIGN_DIR="$AIT_HOME/signing"
KEYCHAIN="$SIGN_DIR/signing.keychain-db"
IDENTITY="AI Translate Local Signing"

# 第一次用时生成自签名的代码签名证书，放进单独的钥匙串文件（密码随机生成，存在同目录，权限 600）
ensure_identity() {
  if [[ -f "$KEYCHAIN" ]] && security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$IDENTITY\""; then
    return
  fi
  echo "生成本机签名证书（只给这个 App 签名）：$SIGN_DIR"
  (
    umask 077
    mkdir -p "$SIGN_DIR"
    chmod 700 "$SIGN_DIR"
    [[ -f "$SIGN_DIR/keychain-password" ]] || /usr/bin/openssl rand -hex 32 >"$SIGN_DIR/keychain-password"
    local pw tmp p12pw before
    pw="$(cat "$SIGN_DIR/keychain-password")"
    tmp="$(mktemp -d)"
    cat >"$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 3650 -config "$tmp/cert.cnf" 2>/dev/null
    p12pw="$(/usr/bin/openssl rand -hex 16)"
    /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" -passout "pass:$p12pw" -name "$IDENTITY"
    before="$(security list-keychains -d user)"
    [[ -f "$KEYCHAIN" ]] || security create-keychain -p "$pw" "$KEYCHAIN"
    security set-keychain-settings "$KEYCHAIN"
    security unlock-keychain -p "$pw" "$KEYCHAIN"
    security import "$tmp/id.p12" -k "$KEYCHAIN" -P "$p12pw" -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pw" "$KEYCHAIN" >/dev/null
    # create-keychain 会把新钥匙串加进搜索列表：恢复原样
    restore_search_list "$before"
    rm -rf "$tmp"
  )
}

# 把 security list-keychains 的输出（每行一个带引号的路径）原样设回去
restore_search_list() {
  local list=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#\"}"
    line="${line%\"}"
    [[ -n "$line" ]] && list+=("$line")
  done <<<"$1"
  security list-keychains -d user -s "${list[@]}"
}

# codesign 只在搜索列表里找私钥：签名时临时加入单独的钥匙串，签完（出错时也一样）恢复
sign() {
  ensure_identity
  local before
  before="$(security list-keychains -d user)"
  security unlock-keychain -p "$(cat "$SIGN_DIR/keychain-password")" "$KEYCHAIN"
  restore_search_list "$before"$'\n'"\"$KEYCHAIN\""
  local rc=0
  codesign --force --sign "$IDENTITY" "$1" 2>/dev/null || rc=$?
  restore_search_list "$before"
  [[ $rc -eq 0 ]] || { echo "签名失败：$1" >&2; exit 1; }
}

build() {
  swift build -c release --package-path "$PKG"
  local bin
  bin="$(swift build -c release --package-path "$PKG" --show-bin-path)/AITranslate"
  rm -rf "${BUILD_APP:?}"
  mkdir -p "$BUILD_APP/Contents/MacOS" "$BUILD_APP/Contents/Resources"
  cp "$bin" "$BUILD_APP/Contents/MacOS/AITranslate"
  cp "$PKG/Info.plist" "$BUILD_APP/Contents/Info.plist"
  cp "$PKG/Resources/AppIcon.icns" "$BUILD_APP/Contents/Resources/AppIcon.icns"
  sign "$BUILD_APP"
  codesign --verify --strict "$BUILD_APP"
  echo "已构建：$BUILD_APP"
}

ours() {
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TARGET/Contents/Info.plist" 2>/dev/null)" == "$BUNDLE_ID" ]]
}

# 退出正在运行的 App（只认装在 ~/Applications 的这一个）
quit_installed() {
  local pids
  pids="$(pgrep -f "^$TARGET/Contents/MacOS/AITranslate" || true)"
  [[ -z "$pids" ]] && return
  # shellcheck disable=SC2086
  kill $pids
  for _ in $(seq 1 50); do
    pgrep -f "^$TARGET/Contents/MacOS/AITranslate" >/dev/null || return 0
    sleep 0.1
  done
  echo "AI Translate 没有退出，先手动退出再试" >&2
  exit 1
}

install() {
  if [[ -e "$TARGET" ]] && ! ours; then
    echo "$TARGET 已经存在，而且不是本项目的 App：先确认它是什么，移走后再安装" >&2
    exit 1
  fi
  build
  quit_installed
  mkdir -p "$HOME/Applications"
  rm -rf "${TARGET:?}"
  ditto "$BUILD_APP" "$TARGET"
  open "$TARGET"
  echo "已安装并启动：$TARGET（Dock 和菜单栏里的「中→A」图标）"
}

uninstall() {
  if [[ ! -e "$TARGET" ]]; then
    echo "没有安装"
    return
  fi
  if ! ours; then
    echo "$TARGET 不是本项目的 App，没有动它" >&2
    exit 1
  fi
  quit_installed
  rm -rf "${TARGET:?}"
  echo "已卸载：$TARGET"
}

case "${1:-}" in
  build) build ;;
  install) install ;;
  uninstall) uninstall ;;
  sign)
    shift
    for path in "$@"; do sign "$path"; done
    ;;
  *)
    echo "用法：scripts/install-desktop.sh build | install | uninstall | sign <路径>…" >&2
    exit 2
    ;;
esac
