#!/bin/sh
# 假的 llama-server 可执行文件，见 fake-llama-server.ts。aitd 测试用 AIT_LLAMA_SERVER 指向它
exec node --disable-warning=ExperimentalWarning "$(dirname "$0")/fake-llama-server.ts" "$@"
