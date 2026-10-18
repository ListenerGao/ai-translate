#!/usr/bin/env bash
# 下载 Index-Translate-2B 的 GGUF 到 $AIT_HOME/models，并按 Hugging Face 记录的 sha256 校验。
# 用法：scripts/download-model.sh [量化版本]，默认 Q8_0（另一个候选是 Q4_K_M）
# 访问不了 huggingface.co 时，设置 HF_ENDPOINT 换成镜像站。
set -euo pipefail

AIT_HOME="${AIT_HOME:-$HOME/Library/Application Support/ai-translate}"
HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"
REPO="IndexTeam/Index-Translate-2B-GGUF"
QUANT="${1:-Q8_0}"
FILE="Index-Translate-2B.${QUANT}.gguf"
DEST="$AIT_HOME/models"

mkdir -p "$DEST"

expected="$(curl -fsSL "$HF_ENDPOINT/api/models/$REPO/tree/main" \
  | python3 -c 'import json, sys; f = sys.argv[1]; print(next(x["lfs"]["oid"] for x in json.load(sys.stdin) if x["path"] == f))' "$FILE")"

# 先下到 .part，校验通过再改名；中断后重跑会断点续传
if [[ ! -f "$DEST/$FILE" ]]; then
  curl -fL --retry 3 -C - -o "$DEST/$FILE.part" "$HF_ENDPOINT/$REPO/resolve/main/$FILE"
  actual="$(shasum -a 256 "$DEST/$FILE.part" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "sha256 不一致：期望 $expected，实际 $actual。删除 $DEST/$FILE.part 后重新下载" >&2
    exit 1
  fi
  mv "$DEST/$FILE.part" "$DEST/$FILE"
else
  actual="$(shasum -a 256 "$DEST/$FILE" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || { echo "已有文件 sha256 不一致：$DEST/$FILE" >&2; exit 1; }
fi
echo "模型已就绪：$DEST/$FILE"
