#!/usr/bin/env bash
# 打发布包（Goal 9）：同事解压后把 App 拖进「应用程序」、按引导下载模型就能用，不用装 Node、llama.cpp、Xcode。
# 用法：scripts/package-release.sh [--no-zip]
#   --no-zip：只组装到 release/<名字>/（App、插件、说明都在），不打 zip，本地先试；试好后不带它再运行一次
# 产出 release/AI-Translate-<版本>-macos-arm64.zip（release/ 不进仓库），里面：
#   AI Translate.app（带 Node、打成单文件的 aitd 和 ait、llama.cpp 的 llama-server）、Chrome 插件/、使用说明.txt、
#   LICENSE、THIRD_PARTY_NOTICES.md、release-manifest.json（版本、源码提交、每个文件的 sha256）
# 构建机要有：Apple Silicon、Xcode、nvm 里的 Node 22（.nvmrc）、自签名证书（第一次 scripts/install-desktop.sh build 时生成）。
# llama.cpp 用 GitHub 上的官方发布包：固定版本、校验 sha256，缓存在 release/cache/；整个脚本只有这一步联网。
set -euo pipefail

ZIP=true
case "${1:-}" in
  "") ;;
  --no-zip) ZIP=false ;;
  *) echo "用法：scripts/package-release.sh [--no-zip]" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
CACHE="$OUT/cache"
LLAMA_TAG="b11669"
LLAMA_SHA256="dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-macos-arm64.tar.gz"
INFO="$ROOT/apps/desktop/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO")"
NAME="AI-Translate-$VERSION-macos-arm64"
STAGE="$OUT/$NAME"
APP="$STAGE/AI Translate.app"

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

# llama-server 用到的库：从它开始顺着 otool -L 里的 @rpath 依赖找（库按 @loader_path 放在同一个目录）
llama_files() {
  python3 - "$1" <<'PY'
import os, subprocess, sys
src = sys.argv[1]
need, todo = set(), ["llama-server"]
while todo:
    name = todo.pop()
    if name in need:
        continue
    need.add(name)
    lines = subprocess.run(["otool", "-L", os.path.join(src, name)], capture_output=True, text=True, check=True).stdout.splitlines()[1:]
    for line in lines:
        dep = line.strip().split(" ")[0]
        if dep.startswith("@rpath/"):
            todo.append(dep[len("@rpath/"):])
print("\n".join(sorted(need)))
PY
}

node="$(node_path)"
[[ -x "$node" ]] || { echo "找不到 Node $(cat "$ROOT/.nvmrc")：先运行 nvm install" >&2; exit 1; }
lipo -archs "$node" | grep -q arm64 || { echo "构建机的 Node 不是 arm64：发布包只支持 Apple Silicon" >&2; exit 1; }
commit="$(git -C "$ROOT" rev-parse --short HEAD)"
dirty="$([[ -n "$(git -C "$ROOT" status --porcelain)" ]] && echo true || echo false)"

echo "1/6 构建插件、命令行、aitd 单文件"
"$node" "$ROOT/apps/extension/build.mjs" >/dev/null
"$node" "$ROOT/apps/cli/build.mjs" >/dev/null
"$node" "$ROOT/apps/server/build.mjs" >/dev/null

echo "2/6 构建桌面应用"
"$ROOT/scripts/install-desktop.sh" build >/dev/null

echo "3/6 准备 llama.cpp $LLAMA_TAG"
mkdir -p "$CACHE"
tarball="$CACHE/llama-$LLAMA_TAG-bin-macos-arm64.tar.gz"
if ! echo "$LLAMA_SHA256  $tarball" | shasum -a 256 -c - >/dev/null 2>&1; then
  curl -fL --retry 3 -o "$tarball.part" "$LLAMA_URL"
  if ! echo "$LLAMA_SHA256  $tarball.part" | shasum -a 256 -c - >/dev/null; then
    rm -f "$tarball.part"
    echo "llama.cpp 发布包的 sha256 对不上：$LLAMA_URL" >&2
    exit 1
  fi
  mv "$tarball.part" "$tarball"
fi
llama_dir="$CACHE/llama-$LLAMA_TAG"
if [[ ! -x "$llama_dir/llama-server" ]]; then
  rm -rf "$llama_dir" "$CACHE/extract"
  mkdir -p "$CACHE/extract"
  tar -xzf "$tarball" -C "$CACHE/extract"
  mv "$CACHE/extract/llama-$LLAMA_TAG" "$llama_dir"
  rmdir "$CACHE/extract"
fi

echo "4/6 组装 App"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "$ROOT/apps/desktop/build/AI Translate.app" "$APP"
helpers="$APP/Contents/Helpers"
runtime="$APP/Contents/Resources/Runtime"
licenses="$APP/Contents/Resources/Licenses"
mkdir -p "$helpers/llama" "$runtime" "$licenses"
# 可执行文件放 Contents/Helpers（签名要求，这里不能放文本文件），JS 和许可证放 Contents/Resources
cp "$node" "$helpers/node"
cp "$ROOT/apps/server/dist/aitd.mjs" "$ROOT/apps/cli/dist/ait.mjs" "$runtime/"
while IFS= read -r file; do
  cp -P "$llama_dir/$file" "$helpers/llama/"
  if [[ -L "$llama_dir/$file" ]]; then cp "$llama_dir/$(readlink "$llama_dir/$file")" "$helpers/llama/"; fi
done < <(llama_files "$llama_dir")
cp "$llama_dir/LICENSE" "$licenses/llama.cpp-LICENSE"
cp "$(dirname "$node")/../LICENSE" "$licenses/node-LICENSE"
cp "$ROOT/LICENSE" "$licenses/ai-translate-LICENSE"

echo "5/6 签名（由内到外：库、llama-server、Node、App）"
targets=()
while IFS= read -r -d '' file; do targets+=("$file"); done < <(find "$helpers/llama" -type f -name '*.dylib' -print0)
targets+=("$helpers/llama/llama-server" "$helpers/node" "$APP")
"$ROOT/scripts/install-desktop.sh" sign "${targets[@]}"
codesign --verify --deep --strict "$APP"

echo "6/6 打包"
cp -R "$ROOT/apps/extension/dist" "$STAGE/Chrome 插件"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
node_version="$("$node" -v)"
cat > "$STAGE/使用说明.txt" <<EOF
AI Translate $VERSION（Build $BUILD）· 本地离线翻译，翻译内容不出本机

需要：Apple Silicon（M 系列芯片）的 Mac，macOS 14 以上；模型约占 1.3 GB 磁盘。

安装
1. 把「AI Translate.app」拖进「应用程序」文件夹，从那里打开（直接在「下载」里打开会被要求先拖进去）。
2. 第一次打开时系统会说无法验证开发者（App 没有做付费的苹果公证）：打开「系统设置 → 隐私与安全性」，
   在下面找到 AI Translate，点「仍要打开」，再确认一次。以后就不会再拦。
3. 按引导下载模型（Index-Translate-2B 的 Q4_K_M，约 1.3 GB），下完就能翻译；菜单栏会出现「中→A」图标。
   访问不了 Hugging Face 时，到「设置 → 模型」把下载地址换成镜像（如 https://hf-mirror.com）。

Chrome 插件（网页边滑边翻、划词）
1. 先把「Chrome 插件」文件夹放到一个不会删的位置（比如「文稿」），Chrome 每次都从那里读。
2. Chrome 打开 chrome://extensions，打开右上角「开发者模式」，点「加载已解压的扩展程序」，选这个文件夹。
3. 打开 AI Translate 的「设置 → 翻译服务」，看「Chrome 插件连接」：插件设置（扩展程序选项）里的「本机翻译服务地址」
   和那里显示的一样就不用改（默认 http://127.0.0.1:8790）；点「复制密钥」，粘贴到插件设置的「密钥」，点「保存」，再点「测试连接」。
4. 插件要 AI Translate 开着才能翻译（本机翻译服务由它启动）；关掉后插件会提示打开它。

常见问题
- 插件提示连不上，但 AI Translate 开着：本机的 8790 端口被别的程序占着时，App 会自动换成 8791 等端口，
  把插件设置里的「本机翻译服务地址」改成「设置 → 翻译服务」里显示的地址（点「复制地址」）。

划词翻译
在任何 App 里选中文字按 ⌥D，鼠标旁边弹出译文；第一次按时按提示到「系统设置 → 隐私与安全性 → 辅助功能」打开 AI Translate。
按 ⌥A 打开翻译窗口；快捷键在「设置 → 快捷键」里改。

命令行（可选）
「设置 → 通用」点「安装命令行工具」，终端里就能用 ait，比如 ait "Hello world"。

更新
退出 AI Translate，用新版本替换「应用程序」里的 App 再打开；模型、设置、密钥都保留。
插件文件夹也换成新的，再在 chrome://extensions 点插件的「重新加载」。

隐私
翻译全部在本机完成。只有下载模型时联网（Hugging Face 或你填的镜像），不发送任何翻译内容。

源码和更多说明：https://github.com/ListenerGao/ai-translate（MIT 许可证）
EOF
cat > "$STAGE/THIRD_PARTY_NOTICES.md" <<EOF
# 第三方组件

AI Translate 自己的代码以 MIT 许可证发布（见 \`LICENSE\`）。App 里还带了下面这些组件，许可证全文在 \`AI Translate.app/Contents/Resources/Licenses/\`：

| 组件 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| Node.js | $node_version | 运行本机翻译服务 aitd 和命令行 ait | MIT（含它自带依赖的许可，见 \`node-LICENSE\`） |
| llama.cpp | $LLAMA_TAG（官方 macOS arm64 发布包） | 运行翻译模型（llama-server 和它的库） | MIT（见 \`llama.cpp-LICENSE\`） |

模型 Index-Translate-2B 不在包里，由 App 从 Hugging Face（IndexTeam/Index-Translate-2B-GGUF）下载，使用条款以它在 Hugging Face 上的说明为准。
EOF
python3 - "$STAGE" "$VERSION" "$BUILD" "$commit" "$dirty" "$LLAMA_TAG" "$node_version" <<'PY'
import hashlib, json, os, sys, time
stage, version, build, commit, dirty, llama, node = sys.argv[1:8]
files = {}
for base, dirs, names in os.walk(stage):
    for name in names:
        path = os.path.join(base, name)
        if os.path.islink(path) or name == "release-manifest.json":
            continue
        with open(path, "rb") as f:
            files[os.path.relpath(path, stage)] = hashlib.sha256(f.read()).hexdigest()
manifest = {
    "app": "AI Translate", "version": version, "build": build, "architecture": "arm64",
    "source": {"repository": "https://github.com/ListenerGao/ai-translate", "commit": commit, "uncommitted_changes": dirty == "true"},
    "runtime": {"node": node, "llama.cpp": llama},
    "signing": "self-signed: AI Translate Local Signing（未做苹果公证）",
    "created": time.strftime("%Y-%m-%d %H:%M", time.localtime()),
    "files": dict(sorted(files.items())),
}
with open(os.path.join(stage, "release-manifest.json"), "w") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
# 旧的 zip 先删掉，免得 --no-zip 时留着上一版被发出去
rm -f "$OUT/$NAME.zip"
if [[ $ZIP == false ]]; then
  echo "已组装（没打 zip）：$STAGE（App $(du -sh "$APP" | cut -f1 | tr -d ' ')；源码 $commit$([[ $dirty == true ]] && echo '，有未提交的改动')）"
  exit 0
fi
(cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent "$NAME" "$NAME.zip")
echo "已打包：$OUT/$NAME.zip（$(du -h "$OUT/$NAME.zip" | cut -f1 | tr -d ' ')；App 解开 $(du -sh "$APP" | cut -f1 | tr -d ' ')；源码 $commit$([[ $dirty == true ]] && echo '，有未提交的改动')）"
