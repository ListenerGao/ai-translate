#!/usr/bin/env bash
# 前台启动本机 llama-server（Index-Translate-2B）：只监听 127.0.0.1，必须带 API 密钥。
# 用法：scripts/start-model.sh [量化版本]，默认 Q8_0；端口用环境变量 AIT_PORT 改，默认 8791
set -euo pipefail

AIT_HOME="${AIT_HOME:-$HOME/Library/Application Support/ai-translate}"
QUANT="${1:-Q8_0}"
PORT="${AIT_PORT:-8791}"
MODEL="$AIT_HOME/models/Index-Translate-2B.${QUANT}.gguf"
KEY_FILE="$AIT_HOME/api-key"

command -v llama-server >/dev/null || { echo "缺少 llama-server：brew install llama.cpp" >&2; exit 1; }
[[ -f "$MODEL" ]] || { echo "模型不存在：$MODEL。先运行 scripts/download-model.sh $QUANT" >&2; exit 1; }

if [[ ! -s "$KEY_FILE" ]]; then
  mkdir -p "$AIT_HOME"
  (umask 077 && openssl rand -hex 32 > "$KEY_FILE")
  echo "已生成 API 密钥：$KEY_FILE（复制到插件设置页）"
fi
chmod 600 "$KEY_FILE"

# 关思考的两个参数照官方示例同时加；--api-key-file 让密钥不出现在进程参数里
exec llama-server -m "$MODEL" \
  --host 127.0.0.1 --port "$PORT" -c 16384 -np 4 -ngl 99 \
  --reasoning off --chat-template-kwargs '{"enable_thinking":false}' \
  --api-key-file "$KEY_FILE" --alias index-translate-2b
