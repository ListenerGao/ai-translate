# ai-translate

本地离线翻译工具：用本机运行的 Index-Translate 模型翻译网页文章，翻译内容不出本机。

## 当前状态

第一阶段的浏览器插件已完成（2026-10-19 验收通过），在 Chrome 开发者模式下加载使用。第二阶段进行中：插件已改连本机翻译服务 `aitd`（缓存、术语表、模型都由它管，模型用到时自动启动、空闲 30 分钟停掉），命令行 `ait` 还没做，进度见 `ROADMAP.md`。打开英文文章页会自动开始翻译（也可以点工具栏的「译」图标在弹窗里开关，或按 `Alt+T`），屏幕内和下方约 1 屏的段落先翻，译文用绿色（`#00bb7c`）和原文区分，往下滑接着翻，再按一次还原页面。5 个单词起的译文放在原文下方；1~4 个单词的短文本（标题、菜单、表格单元格）放得下时译文跟在同一行右边，放不下也放到下方。正文、标题、列表、表格都会翻，导航、按钮、代码块不翻。段落里的链接、加粗、斜体在译文里保留（链接能点），行内代码和图片原样保留、不翻译；个别段落模型没保住格式时，这一段的译文按纯文本显示。

- 自动开启：只对「英文且像文章」的页面自动开启；搜索结果、列表、目录、首页不会自动开
- 工具栏弹窗（点「译」图标）：选原文语言和目标语言，看 aitd 和模型的状态（运行中 / 启动中 / 已休眠 / 没启动）和量化版本，按网站设成「总是翻译 / 从不翻译」，切换双语对照 / 仅译文（`⌥⇧M`，当前页面立即生效），开关当前页翻译（`⌥T`）。快捷键可在 `chrome://extensions/shortcuts` 改
- 划词翻译与朗读：在任意网页选中英文，旁边出现一条小工具条 -- 点翻译图标（中→A）弹出翻译卡片：上面是原文（长了可以展开），下面是译文，可以复制；卡片右上角能临时换目标语言、固定卡片（固定后点别处、滚动页面都不关，按 Esc 或点 × 关闭）。点工具条或卡片里原文下方的喇叭朗读选中的原文（不读译文，不用先翻译），再点一次停止。朗读只用 macOS 本机语音（英文默认 Samantha，装了高品质语音时优先用），文字不出本机
- 模型用 Index-Translate-2B（Q8_0）。另一个候选 Q4_K_M 单条快约两成，盲评 32 条和 Q8_0 打平（各胜 12 条、差不多 8 条），默认版本等译文质量评估后再定；想试 Q4_K_M：`scripts/download-model.sh Q4_K_M` 下载后用 `AIT_QUANT=Q4_K_M npm run aitd` 启动。盲评页在 `docs/quant-blind-test.html`，评测结论和术语、质检清单在 `docs/glossary-and-qa-checklist.html`

## 使用

需要 macOS（Apple Silicon）、Homebrew、Node 22（`nvm`）和 Chrome。

1. 安装 llama.cpp：`brew install llama.cpp`
2. 下载模型（约 2.1 GB，下载后校验 sha256）：`scripts/download-model.sh`
3. 启动本机翻译服务 aitd（前台运行，只监听 `127.0.0.1:8790`）：`nvm use && npm install && npm run aitd`。首次运行会生成密钥，存在 `~/Library/Application Support/ai-translate/api-key`。模型不用单独启动：第一次翻译时 aitd 自动启动 `llama-server`（`127.0.0.1:8791`），空闲 30 分钟停掉；不要同时开着 `scripts/start-model.sh`，两者都用 8791
4. 构建插件：`npm run build`，产物在 `apps/extension/dist/`
5. 加载插件：Chrome 打开 `chrome://extensions`，打开右上角「开发者模式」，点「加载已解压的扩展程序」，选 `apps/extension/dist/`
6. 填密钥：插件详情里打开「扩展程序选项」，运行 `pbcopy < ~/Library/Application\ Support/ai-translate/api-key` 后粘贴到「密钥」，保存，点「测试连接」。服务地址默认 `http://127.0.0.1:8790`，旧版存的 8791 会自动改过来
7. 打开一篇英文文章，会自动开始翻译；没有自动开启的页面，点「译」图标在弹窗里点「翻译」，或按 `Alt+T`

设置页还能改目标语言、显示方式（双语对照 / 只看译文）、术语表（存在 aitd 里，插件和以后的命令行共用；一行一条 `原文=译文`，写错的行不让保存；另有 4 条内置术语 `mockup=设计稿`、`single source of truth=单一事实来源`、`sequence transduction=序列转导`、`under the hood=底层`，一直生效，自己写同一个原文会覆盖），以及「英文文章页自动开启翻译」「划词翻译」两个开关。

## 开发

先 `nvm use`，再在仓库根目录运行：

- `npm run typecheck`：类型检查
- `npm test`：单测
- `npm run build`：打包插件
- `npm run e2e`：用 Playwright 自带的 Chromium 加载插件跑端到端测试（首次先 `npm run e2e:install`）
- `npm run check-page -- <网址> [--scroll] [--shot 截图.png]`：用真实模型翻译一个真实网页，输出出译文的耗时；`--scroll` 从头滚到尾列出漏翻的文字。脚本自己起一个临时 aitd（不碰你的缓存），需要 `scripts/start-model.sh` 开着模型服务（`AIT_MODEL_URL` 可改地址）
- `npm run qa`：译文回归检查。用正在运行的模型服务把 `tests/quality/samples.json` 的 71 条样例全部翻一遍，自动查残留英文、数字丢失、格式标记、内置术语等硬伤，再和基线 `tests/quality/baseline.json` 比，报告写到 `.tmp/qa/`；出现基线没有的新问题时退出码为 1。换模型、换量化版本、改提示词或术语后跑一次，人看过报告后用 `npm run qa -- --update-baseline` 更新基线；`--endpoint` 指定别的模型服务地址
- `npm run aitd`：前台启动本机翻译服务 aitd。用到时自动启动模型、空闲 30 分钟停掉；模型默认用 8791 端口，和 `scripts/start-model.sh` 冲突，二选一。设 `AIT_MODEL_URL=http://127.0.0.1:8791` 则改连已经开着的模型服务（调试用）

目录说明见 `AGENTS.md`。

## 文档

- 架构：`docs/architecture-v1.html`（浏览器打开）
- 进度、待办与决策：`ROADMAP.md`
- 项目约定：`AGENTS.md`
- 施工清单：`goals/`
