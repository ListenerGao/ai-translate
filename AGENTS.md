# ai-translate 项目约定

本地离线翻译工具：模型跑在本机，翻译内容不出本机。第一阶段的浏览器插件（Chrome / Edge，用 Index-Translate-2B 边滑动边翻译网页文章）已完成；第二阶段做本机服务 `aitd` 和命令行 `ait`，插件改连 `aitd`；桌面应用到第三阶段再建。

## 红线

- 翻译内容不得发往本机以外的地址。允许的外网请求只有下载模型和安装依赖；不接入任何在线翻译 API（包括 Index-Translate 官方免费 API），除非主人明确要求。插件代码必须校验服务地址（aitd）的主机是 `127.0.0.1` 或 `localhost`，不是就拒绝发送。划词朗读只用本机语音（`SpeechSynthesisVoice.localService` 为 true），不用 Chrome 的联网语音。
- 本地模型服务只监听 `127.0.0.1`，必须带 API 密钥。aitd 同样只监听 `127.0.0.1`：除 `/health` 外必须带密钥，拒绝非本机 `Host` 和网页来源（`Origin` 不是 `chrome-extension://`），不返回 CORS 头；日志只记事件、计数、耗时和错误码，不记原文、译文和密钥。密钥只存放在 `~/Library/Application Support/ai-translate/api-key`（权限 600）和插件的 `chrome.storage.local`，不进代码、仓库、日志和截图。
- 模型文件（`*.gguf`）不进仓库，统一放 `~/Library/Application Support/ai-translate/models/`。
- 不改全局 npm 配置和全局 Node 版本：Node 版本由 `.nvmrc` 指定，npm 源由项目 `.npmrc` 指定。
- 插件权限只有 `storage`、`scripting`，host 权限 `http://*/*`、`https://*/*`（安装时即申请「读取和更改所有网站上的数据」，主人 2026-10-18 定）。content script 在所有网页运行，没开启翻译时只做本地检测（页面语言、是否像文章、划词图标），不发任何请求。新增权限先问主人。
- `docs/architecture-v1.html` 是定稿版本，只读；架构变化另出新版本文件。

## 已定决策

- 模型：Index-Translate-2B（GGUF，`llama-server` 运行）。模型配置预留 9B 等其他模型，切换只改配置。
- 架构以 `docs/architecture-v1.html` 为准：第一阶段插件直连 `llama-server`，暂不写 `aitd`；翻译核心 `packages/core` 用 TypeScript。
- 开发环境：Node 22（`.nvmrc`）+ npm workspaces；开发依赖只有 `typescript`、`esbuild`、`@playwright/test`、`@types/chrome`、`@types/node`（aitd 类型检查用），单测用 Node 内置测试器。新增依赖先说明理由。
- 一段一个请求，不把多段打包成 JSON；prompt 照抄官方 instTrans 格式，细节见 Goal 1 清单「接口决策」。
- `packages/core` 不得引用 `chrome.*`、DOM 和 Node 内置模块，保证第二阶段的 `aitd`、`ait` 能直接复用。

## 目录约定

当前结构。预留的 `apps/desktop` 到第三阶段再建，不提前建空目录。

```
packages/core/      翻译核心：段落协议、Translator 接口与 llama-server 实现、aitd 客户端、prompt、术语表、结果校验、缓存键与缓存接口、调度队列、翻译流水线、错误码、模型配置
apps/extension/     浏览器插件：后台调度与缓存、网页端段落提取与渲染、划词翻译、英文文章检测与自动开启、工具栏弹窗、设置页
apps/server/        aitd 本机翻译服务：HTTP 接口、鉴权、调度、SQLite 缓存、术语表文件、日志、模型进程管理
apps/cli/           命令行 ait：文字、标准输入、Markdown、SRT 交给 aitd 的 batch 通道（第二阶段开发中）
scripts/            模型下载、模型启动、图标生成脚本，aitd 开机自启（`aitd-service.sh`），命令行安装（`install-cli.sh`），译文回归检查（`qa.ts`、`qa/`）
tests/              e2e 用例、测试页面、模拟模型服务、译文回归的样例和基线（`quality/`）
docs/               架构与说明文档
goals/              Goal 施工清单
```

- 任务临时文件放 `.tmp/<task-slug>/`，正式流程不依赖其中内容。

## 验证命令

先 `nvm use`（读 `.nvmrc`，Node 22），再在仓库根目录运行：

- `npm run typecheck`：core 和插件分别类型检查；core 不带 DOM、Node 类型，只认 `packages/core/src/globals.d.ts` 里声明的 Web 标准对象
- `npm test`：单测，Node 内置测试器，文件名 `*.test.ts`
- `npm run build`：打包插件到 `apps/extension/dist/`
- `npm run e2e`：构建后用 Playwright 自带的 Chromium 加载插件跑 e2e；首次先 `npm run e2e:install`（浏览器装进 `node_modules`，不动全局）
- `npm run qa`：译文回归检查（要模型服务在运行）；换模型、量化版本、提示词或内置术语后必须跑，出现新问题退出码为 1
- `npm run aitd`：前台启动 aitd（端口 `AIT_PORT`，默认 8790），用到时自动启动模型（`AIT_LLAMA_PORT` 默认 8791，和 `start-model.sh` 冲突）；`AIT_MODEL_URL` 改连已在运行的模型服务
- 真实模型：`scripts/download-model.sh`、`scripts/start-model.sh`；真实网页检查：`npm run check-page -- <网址> [--scroll] [--shot 截图.png]`

## 文档入口

- 项目说明与使用：`README.md`
- 进度、待办、阻塞与决策：`ROADMAP.md`
- 架构：`docs/architecture-v1.html`（浏览器打开）
- 施工清单：`goals/`
