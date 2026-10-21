#!/usr/bin/env bash
# 把命令行 ait 装成全局命令：打包 apps/cli/dist/ait.mjs，在 ~/.local/bin/ait 放一个启动脚本。
# 用法：scripts/install-cli.sh install | uninstall
# 启动脚本里写死 nvm 里 Node 22 的绝对路径（.nvmrc），不受终端默认 Node 版本影响；升级 Node 后重新 install。
# 只管自己装的 ait：同名命令不是本脚本装的就不动它。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/ait"
BUNDLE="$ROOT/apps/cli/dist/ait.mjs"
MARK="# ai-translate ait 启动脚本"

ours() { [[ -f "$TARGET" ]] && grep -qF "$MARK" "$TARGET"; }

# 按 .nvmrc 找 nvm 里的 Node：先找 $NVM_DIR（默认 ~/.nvm），再找用 Homebrew 装的 nvm（nvm.sh 不兼容 set -u，临时关掉）
node_path() {
  set +u
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  local script
  for script in "$NVM_DIR/nvm.sh" "$(brew --prefix nvm 2>/dev/null)/nvm.sh"; do
    # shellcheck disable=SC1090
    [[ -s "$script" ]] && source "$script" >/dev/null 2>&1 && break
  done
  command -v nvm >/dev/null 2>&1 || { echo "找不到 nvm：先安装 nvm（见 README「从源码安装」），再运行 nvm install" >&2; exit 1; }
  nvm which "$(cat "$ROOT/.nvmrc")" 2>/dev/null | tail -1
  set -u
}

install() {
  local node
  node="$(node_path)"
  [[ -x "$node" ]] || { echo "找不到 Node $(cat "$ROOT/.nvmrc")：先运行 nvm install" >&2; exit 1; }
  if [[ -e "$TARGET" || -L "$TARGET" ]] && ! ours; then
    echo "$TARGET 已经存在，而且不是本脚本装的：先确认它是什么，移走后再安装" >&2
    exit 1
  fi
  "$node" "$ROOT/apps/cli/build.mjs" >/dev/null
  mkdir -p "$BIN_DIR"
  cat > "$TARGET" <<EOF
#!/bin/sh
$MARK（$ROOT/scripts/install-cli.sh 生成，卸载：scripts/install-cli.sh uninstall）
if [ ! -f "$BUNDLE" ]; then
  echo "找不到 $BUNDLE ：在 $ROOT 运行 npm run build" >&2
  exit 1
fi
exec "$node" "$BUNDLE" "\$@"
EOF
  chmod 755 "$TARGET"
  echo "已安装：$TARGET（$("$TARGET" --version)，Node $("$node" -v)）"
  echo "改了 apps/cli 或 packages/core 的代码后运行 npm run build，ait 才会用上新代码"
}

uninstall() {
  if ours; then
    rm -f "$TARGET"
    echo "已卸载：$TARGET"
  elif [[ -e "$TARGET" || -L "$TARGET" ]]; then
    echo "$TARGET 不是本脚本装的，没有动它" >&2
    exit 1
  else
    echo "没有安装"
  fi
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  *)
    echo "用法：scripts/install-cli.sh install | uninstall" >&2
    exit 2
    ;;
esac
