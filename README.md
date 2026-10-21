# ai-translate

本地离线翻译工具：用本机运行的 Index-Translate 模型翻译网页、Markdown 文档和字幕，翻译内容不出本机。

## 当前状态

第一阶段的浏览器插件（2026-10-19 验收通过）和第二阶段的本机翻译服务 `aitd`、命令行 `ait`（2026-10-20 验收通过）都已完成。第三阶段的桌面应用 AI Translate 已经能用：菜单栏、翻译窗口、文件翻译、设置、全局快捷键划词、模型下载与切换，等第三阶段总验收，进度见 `ROADMAP.md`。插件在 Chrome 开发者模式下加载使用。

## 功能一览

| 功能 | 在哪用 | 说明 |
|---|---|---|
| 网页滑动翻译 | 浏览器插件 | 英文文章页自动开启，边滑边翻；译文插在原文旁边，可切换「双语对照 / 只看译文」 |
| 划词翻译 | 浏览器插件、桌面应用 | 插件里选中文字点图标；桌面应用在任何 App 里选中文字按 `⌥D`。弹出翻译卡片：可复制、临时换目标语言、固定 |
| 划词朗读 | 浏览器插件 | 用 macOS 本机语音朗读选中的原文 |
| 文字翻译 | 桌面应用、命令行 `ait` | 桌面应用左边贴原文、右边边输入边出译文；命令行 `ait "文字"`、`pbpaste \| ait` |
| Markdown 翻译 | 桌面应用、命令行 `ait` | 拖进桌面应用窗口或 `ait translate`，保留文档结构和格式，写到 `文件.zh.md` |
| SRT 字幕翻译 | 桌面应用、命令行 `ait` | 序号、时间轴不变，可输出双语字幕 |
| 术语表 | 插件设置页、桌面应用设置、命令行 | 三处共用一份；另有 4 条内置术语 |
| 翻译缓存 | 本机服务 `aitd` | 插件、桌面应用、命令行共用，翻过的段落再翻立即返回 |

翻译和朗读都在本机完成：插件、桌面应用、命令行只连本机地址，朗读只用本机语音，不接任何在线翻译服务。

## 工作方式

```
Chrome 插件 ───┐
桌面应用 ──────┼──> aitd（127.0.0.1:8790）──> llama-server（127.0.0.1:8791）
命令行 ait ────┘     缓存、术语表、排队调度      Index-Translate-2B 模型
```

- `aitd` 是本机翻译服务：管模型进程、排队调度、缓存和术语表。插件和桌面应用的文字翻译优先；命令行和桌面应用的文件翻译是批量任务，最多占模型 4 路里的 3 路，留 1 路给前面这些
- `aitd` 只监听 `127.0.0.1`，除健康检查外都要带密钥，网页里的脚本调不了它；模型服务用 `aitd` 每次生成的一次性密钥，插件、桌面应用和命令行都连不上它
- 架构说明见 `docs/architecture-v2.html`
- 模型默认用 Index-Translate-2B 的 Q8_0 量化版本（约 2.1 GB），用 Apple Silicon 的 GPU 运行

## 安装

需要 macOS（Apple Silicon）、Homebrew、Node 22（用 `nvm` 管理）和 Chrome 120 以上；桌面应用另外要 macOS 14 以上和 Xcode 16 以上（Swift 6）。

1. 安装 llama.cpp：`brew install llama.cpp`
2. 在仓库目录装依赖：`nvm use && npm install`
3. 下载模型（下载后校验 sha256，存到 `~/Library/Application Support/ai-translate/models/`）：`scripts/download-model.sh`
4. 启动本机翻译服务 `aitd`，二选一：
   - **开机自启（推荐）**：`scripts/aitd-service.sh install`。登录后自动运行，异常退出自动拉起；登录后等 60 秒加载模型，之后一直常驻（约多占 0.5 GB 内存），用的时候不用等模型启动
   - **前台运行**：`npm run aitd`，关掉终端就停。第一次翻译时自动启动模型（多等约 1~3 秒），空闲 30 分钟停掉

   首次启动会生成密钥，存在 `~/Library/Application Support/ai-translate/api-key`（权限 600）
5. 构建插件和命令行：`npm run build`
6. 加载插件：Chrome 打开 `chrome://extensions`，打开右上角「开发者模式」，点「加载已解压的扩展程序」，选 `apps/extension/dist/`
7. 填密钥：运行 `pbcopy < ~/Library/Application\ Support/ai-translate/api-key` 复制密钥；在插件详情里打开「扩展程序选项」，粘贴到「密钥」，点「保存」，再点「测试连接」
8. 安装命令行（可选）：`scripts/install-cli.sh install`，装到 `~/.local/bin/ait`（固定用 Node 22，不受终端默认 Node 版本影响）。新开终端运行 `ait status`，显示「aitd 0.1.0 正常」就装好了
9. 安装桌面应用（可选）：`scripts/install-desktop.sh install`，编译后装到 `~/Applications/AI Translate.app` 并启动，Dock 和菜单栏出现蓝底白色「中→A」图标。第一次安装会生成一张只给这个 App 签名的本机证书，放在单独的钥匙串文件 `~/Library/Application Support/ai-translate/signing/` 里，登录钥匙串不动；身份固定，以后更新 App 不用重新授权。第一次打开时默认登记「登录时自动打开」，可在 App 设置里关。要用 `⌥D` 划词，第一次按时按提示在「系统设置 → 隐私与安全性 → 辅助功能」里打开 AI Translate（要读别的 App 里选中的文字），打开后不用重启

卸载：`scripts/aitd-service.sh uninstall` 停掉开机自启；`scripts/install-cli.sh uninstall` 删掉 `ait`；卸载桌面应用前先在它的设置里关掉「登录时自动打开」，再运行 `scripts/install-desktop.sh uninstall`；在 `chrome://extensions` 移除插件。

## 使用

### 网页翻译

- **自动开启**：打开「英文且像文章」的页面会自动开始翻译；搜索结果、列表、目录、首页不会自动开。点工具栏的 AI Translate 图标（蓝底白色「中→A」），弹窗会显示当前页面的判断结果
- **手动开关**：在弹窗里点「翻译」，或按 `⌥T`（Alt+T）；再按一次还原页面
- **翻译顺序**：先翻屏幕内和下方约 1 屏的段落，往下滑接着翻；翻过的段落存在缓存里，再打开同一页面直接显示
- **显示**：译文用绿色（`#00bb7c`）和原文区分。5 个单词起的段落，译文放在原文下方；1~4 个单词的短文本（标题、菜单、表格单元格）放得下时，译文跟在同一行右边，放不下也放到下方。按 `⌥⇧M` 或在弹窗里切换「双语对照 / 只看译文」，当前页面立即生效
- **翻译范围**：正文、标题、列表、表格都翻；导航、菜单、按钮、表单、代码块不翻；目标语言是中文、日文、韩文时，已经是这种文字的段落不翻
- **格式**：段落里的链接、加粗、斜体在译文里保留（链接能点），行内代码和图片原样保留、不翻译；个别段落模型没保住格式时，这一段的译文按纯文本显示
- **出错时**：服务没启动、密钥不对这类问题在页面右上角提示；某一段没翻好时，在这一段下方提示并保留原文。处理办法见下面「常见问题」

### 划词翻译与朗读

- 在任意网页选中文字（2000 字以内；目标语言是中日韩时，选中的已经是这种文字就不出现），选区末尾旁边出现一条小工具条：翻译图标（中→A）和喇叭
- **点翻译图标**：弹出翻译卡片，上面是原文（长了可以展开），下面是译文，可以复制。卡片右上角能临时换目标语言，也能固定卡片：固定后点别处、滚动页面都不关，按 Esc 或点 × 关闭
- **点喇叭**：朗读选中的原文，不读译文，也不用先翻译；再点一次停止。只用 macOS 本机语音（英文默认 Samantha，装了高品质语音时优先用），文字不出本机
- 页面没开启滑动翻译时也能用；不想要可以在设置页关掉「划词翻译」

### 工具栏弹窗

点工具栏的 AI Translate 图标：

- **语言**：选原文语言（默认自动检测）和目标语言；改了之后，正在翻译的页面按新语言重翻
- **模型状态**：

  | 显示 | 意思 |
  |---|---|
  | 运行中 | 模型已加载，可以直接翻 |
  | 启动中 | 模型正在加载，几秒后就好 |
  | 已休眠 | 模型没加载，第一次翻译时自动启动（多等约 1~3 秒） |
  | aitd 没启动、连不上 aitd | 本机翻译服务没运行，见「常见问题」 |
  | 还没填密钥、密钥不对 | 到设置页填写密钥 |
  | 版本对不上 | 插件和 `aitd` 不是同一版本：`npm run build` 后在 `chrome://extensions` 重新加载插件，并重启 `aitd` |
  | 出错 | 模型启动失败，鼠标停在状态上看原因 |

- **当前网站**：设成「自动（英文文章才翻译）」「总是翻译」或「从不翻译」
- **显示方式**：「翻译」左边的小方块按钮，点一下在双语对照和只看译文之间切换（鼠标停上去显示当前方式）
- **翻译 / 还原**：开关当前页面的翻译

快捷键可以在 `chrome://extensions/shortcuts` 改。

### 设置页

在插件详情里打开「扩展程序选项」：

- **本机翻译服务地址**：默认 `http://127.0.0.1:8790`，只能填本机地址（`127.0.0.1` 或 `localhost`）；旧版存的 8791 会自动改过来
- **密钥**：粘贴 `api-key` 文件里的密钥，点「测试连接」检查
- **翻译成**：中文、英语、日语、韩语、法语、德语、西班牙语
- **显示方式**：双语对照 / 只看译文
- **术语表**：一行一条 `原文=译文`，`#` 开头的行是注释，写错的行不让保存。术语表存在 `aitd` 里，插件和命令行共用；只有段落里出现的术语才会发给模型。另有 4 条内置术语一直生效：`mockup=设计稿`、`single source of truth=单一事实来源`、`sequence transduction=序列转导`、`under the hood=底层`；自己写了同一个原文时以自己的为准
- **开关**：「英文文章页自动开启翻译」「划词翻译」

### 桌面应用

- **打开**：点 Dock 或菜单栏的「中→A」图标，或者在启动台、聚焦搜索里找「AI Translate」；登录后自动打开（可在设置里关）。关掉窗口 App 不退出，`⌘Q` 才退出
- **菜单栏**：第一行是翻译服务状态（运行中 / 启动中 / 已休眠 / aitd 没启动 / 密钥不对 / 出错，说法和插件弹窗一致），下面是「打开翻译窗口」「翻译文件…」「设置…」「重启翻译服务」「退出」。启动中时图标右边有个圆圈，有问题时有个实心点；右键 Dock 图标也有前三项。别的 App 全屏时，系统不让 Dock 里常驻的 App 把菜单弹到那个全屏界面上，这时点菜单栏图标会切回桌面、直接打开翻译窗口；回到桌面再点图标就是菜单
- **翻译窗口**：顶部是原文语言和目标语言（原文选了具体语言后，中间的 ⇄ 能互换方向，译文翻好时会搬到左边翻回去），左边贴原文，停手 0.5 秒自动翻，`⌘↩` 立即翻；按空行分段，哪段先翻好先显示哪段，改了一段只重翻这一段。原文、译文按段落对齐一起滚动；在一边选中文字，另一边对应的段落加浅底色。右上角复制全部译文，左上角显示字数、一键清空。关掉窗口时清空原文和译文（翻过的内容在缓存里，再翻立即出）
- **划词翻译**：在任何 App 里选中文字按 `⌥D`，鼠标旁边弹出翻译卡片，原来的 App 还在前台。原文超过 3 行折叠，点 ⌄ 展开；译文按段显示，复制按钮或 `⌘C` 复制全部，选中一部分时 `⌘C` 只复制选中的；点语言胶囊或 `⌘L` 临时换目标语言（只对这张卡片，不改设置）；点图钉或 `⌘P` 固定，固定后点别处不关、可以拖动，再按 `⌥D` 原地换成新内容；`Esc`、`⌘W`、点 ×、点卡片外面或切到别的 App 关闭。没选中文字时按 `⌥D` 什么都不做；超过 5000 字放进翻译窗口
- **取词方式**：先用系统的辅助功能接口读选中的文字（备忘录、预览这类原生 App），读不到再模拟一次 `⌘C`，取完把剪贴板原样恢复（Chrome、VS Code、微信这类）。只在按快捷键时读一次，只发给本机 `aitd`，不记录、不存历史。没打开辅助功能权限时按 `⌥D` 会弹出说明；不想授权也可以按 `⌥A` 打开翻译窗口，把文字粘贴进去翻
- **文件翻译**：把 `.md`、`.markdown`、`.srt` 文件拖进翻译窗口，或者 `⌘O` 选文件，弹出文件卡片：可选「双语」，译文写到原文件旁边（规则和 `ait translate` 相同，结果逐字一致）；输出文件已存在时可以覆盖、另存为或取消；翻译中显示进度、可以取消；完成后能「在访达中显示」，没翻成的段落列出行号并保留原文。不支持的文件弹框提示；只认 UTF-8，单个文件最多 900 KB（更大的用 `ait`）
- **模型**（设置里的「模型」页）：上面是本机已有的量化版本，能「设为当前」、删除（正在用的删不了，删除前确认）；下面是 Hugging Face 上还能下载的版本，点「下载」显示进度，可以取消，再点「继续下载」从断开的地方接着下，下完按 sha256 校验，一次下一个，关掉设置窗口也接着下。只有 Q8_0、Q4_K_M 评测过译文质量。下载走系统网络设置（系统代理自动生效），访问不了 Hugging Face 时在页面下方换成镜像地址（如 `https://hf-mirror.com`）；下载前看剩余空间，至少要多留 500 MB。这是桌面应用唯一的外网请求，只下模型文件，不发送翻译内容
- **设置**（`⌘,`，左边选页）：「通用」里是默认翻译成（和翻译窗口的目标语言是同一个设置）、登录时自动打开；「快捷键」里改全局快捷键（点组合键后按新的，`Esc` 取消，鼠标移上去点 × 清空，「恢复默认」），和系统或别的 App 冲突时标红说明，下面是辅助功能权限的状态和打开入口；「术语表」和插件设置页、命令行同一份，写错的行逐行标出，`⌘S` 保存，没保存就关窗口会提醒；「翻译服务」显示状态、模型、缓存条数，「重启翻译服务」后马上重新加载模型；「模型」见上一条；「关于」是版本信息
- **快捷键**：全局的 `⌥D` 划词翻译、`⌥A` 打开翻译窗口（在任何 App 里都能按，设置里可改；菜单栏菜单的「打开翻译窗口」旁边标着当前的组合键）；App 里 `⌘N` 打开翻译窗口，`⌘O` 翻译文件，`⌘,` 设置，`⌘↩` 立即翻译，`⌘W` 关窗口，`⌘Q` 退出
- **更新**：改了 `apps/desktop` 的代码后重新运行 `scripts/install-desktop.sh install`（会先退出正在运行的 App 再替换）

### 命令行 ait

```sh
ait "Hello world"                                    # 翻一句，译文打到终端
pbpaste | ait                                        # 翻剪贴板里的文字，空行分段
pbpaste | ait --to ja                                # 翻成日文
ait translate README.md                              # 翻 Markdown，写到 README.zh.md
ait translate 说明.md --to en                         # 中文文档翻成英文，写到 说明.en.md
ait translate talk.srt                               # 翻字幕，写到 talk.zh.srt
ait translate talk.srt --bilingual -o talk.双语.srt   # 双语字幕
ait translate README.md -o -                         # 译文打到终端，不写文件
ait status                                           # 看 aitd、模型、队列和缓存
```

| 选项 | 作用 |
|---|---|
| `--to <语言>` | 目标语言，默认 `zh` |
| `--from <语言>` | 原文语言，默认自动识别 |
| `--bilingual` | 翻文件时输出双语：Markdown 每段原文后接译文，字幕原文在上、译文在下 |
| `-o <路径>` | 输出到指定文件；`-o -` 打到终端 |
| `--force` | 输出文件已存在时覆盖 |
| `--glossary <文件>` | 本次额外的术语表（一行一条 `原文=译文`），和 `aitd` 的术语表合并，冲突时以它为准 |
| `-h`、`-v` | 帮助、版本 |

- **语言**：`--to`、`--from` 支持 32 种语言代码，如 `zh`、`en`、`ja`、`ko`、`fr`、`de`、`es`、`pt`、`ru`、`ar`、`it`，完整列表见 `packages/core/src/languages.ts`
- **输出文件**：默认写到原文件旁边，文件名加目标语言（`README.zh.md`、`talk.ja.srt`）；已存在时不覆盖、报错，加 `--force` 覆盖，或用 `-o` 指定别的位置。`--bilingual` 也默认写到这个文件名，单语和双语都要时用 `-o` 区分
- **进度**：翻文件时终端显示「已完成 N / 总数」；按 Ctrl+C 中断后，已经翻好的段落留在缓存里，重跑时直接命中
- **Markdown**：标题、段落、列表、引用、表格单元格翻译；代码块、front matter、HTML 块、链接定义原样保留；段内的链接、加粗、行内代码保留。BOM 和 CRLF 换行原样保留
- **SRT 字幕**：只认 UTF-8（GBK 等先转码：`iconv -f GBK -t UTF-8 原文件 > 新文件`）。序号、时间轴不变，一条字幕的多行合成一行译文；开头的 `{\an8}` 等位置标记、斜体等格式保留；格式不对时报出第几行
- **和插件同时用**：浏览器的请求排在前面，命令行批量翻译最多占模型 4 路里的 3 路，滑动翻译照常进行
- **aitd 换了端口**：`AIT_URL=http://127.0.0.1:端口 ait …`

| 退出码 | 意思 |
|---|---|
| 0 | 成功 |
| 1 | 参数或文件错误（如输出文件已存在、文件不是 UTF-8） |
| 2 | `aitd` 没启动或密钥不对 |
| 3 | 有段落没翻成：保留原文，终端列出行号 |

### 本机翻译服务 aitd

开机自启的管理：

- `scripts/aitd-service.sh status`：看是否在运行；`install` 安装或更新配置；`uninstall` 卸载
- 重启（改了 `aitd` 的代码、想重新加载模型时）：`launchctl kickstart -k gui/$(id -u)/com.listenergao.ai-translate.aitd`
- 升级 Node 后重新运行 `scripts/aitd-service.sh install`（配置里写的是 Node 22 的绝对路径）
- 想改回「用到时启动、空闲 30 分钟停」：`AIT_PRELOAD_SECONDS=-1 AIT_IDLE_MINUTES=30 scripts/aitd-service.sh install`

数据目录 `~/Library/Application Support/ai-translate/`：

| 文件 | 内容 |
|---|---|
| `api-key` | 插件和命令行用的密钥（权限 600） |
| `models/` | 模型文件（`Index-Translate-2B.<量化版本>.gguf`；桌面应用下载中的是 `.part`） |
| `settings.json` | 桌面应用「模型」页选的量化版本，`aitd` 重启后照用 |
| `cache.db` | 翻译缓存，最多 10 万条，按最近使用淘汰 |
| `glossary.txt` | 术语表，在设置页第一次保存后生成 |
| `logs/` | `aitd.log`（每 5 MB 轮转）和开机自启的输出 `launchd.log`；只记事件、耗时和错误码，不记原文、译文和密钥 |
| `run/` | 模型进程的一次性密钥和进程号 |
| `signing/` | 桌面应用签名用的单独钥匙串和它的密码（目录权限 700），只给 AI Translate 签名 |

环境变量（`npm run aitd` 前设，或者在 `scripts/aitd-service.sh install` 前设，写进开机自启配置）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `AIT_PORT` | `8790` | `aitd` 的端口 |
| `AIT_LLAMA_PORT` | `8791` | 模型服务的端口 |
| `AIT_QUANT` | 不设（用桌面应用里选的，没选过是 `Q8_0`） | 量化版本；设了就固定用它，桌面应用里不能切换 |
| `AIT_PRELOAD_SECONDS` | 不设（开机自启为 `60`） | 启动后过多少秒加载模型；不设就等第一次翻译时再加载 |
| `AIT_IDLE_MINUTES` | `30`（开机自启为 `0`） | 空闲多少分钟后停掉模型；`0` 表示不停 |
| `AIT_MODEL_URL` | 不设 | 改连一个已经在运行的模型服务（调试用） |
| `AIT_HOME` | 上面的数据目录 | 数据目录 |

开机自启的 `install` 只读其中的 `AIT_QUANT`、`AIT_PRELOAD_SECONDS`、`AIT_IDLE_MINUTES` 三个。

换量化版本：Q4_K_M 单条快约两成，盲评 32 条和 Q8_0 打平（各胜 12 条、差不多 8 条）。在桌面应用「设置 → 模型」里下载、设为当前就行，`aitd` 等正在翻的段落翻完再换（一般几秒），插件、命令行和桌面应用一起换，重启后保留。不用桌面应用时：先 `scripts/download-model.sh Q4_K_M`，再 `AIT_QUANT=Q4_K_M scripts/aitd-service.sh install`（前台运行用 `AIT_QUANT=Q4_K_M npm run aitd`）；这样设了 `AIT_QUANT` 就固定用它，App 里不能切换。

## 常见问题

- **页面提示「本机翻译服务没启动」、弹窗显示「aitd 没启动」**：运行 `scripts/aitd-service.sh status`。显示「没有安装开机自启」就按「安装」第 4 步启动；显示「服务：连不上」就看 `~/Library/Application Support/ai-translate/logs/launchd.log`
- **「密钥不对」**：重新运行 `pbcopy < ~/Library/Application\ Support/ai-translate/api-key`，粘贴到设置页保存。命令行直接读这个文件，退出码 2 时先确认 `aitd` 在运行
- **aitd 起不来，日志里说端口被占用**：8790 或 8791 被别的程序占了，常见是还开着 `npm run aitd` 或 `scripts/start-model.sh`，停掉它们再试
- **模型状态显示「出错」**：鼠标停在状态上看原因。常见是模型文件没下载（运行 `scripts/download-model.sh`）或没装 llama.cpp（`brew install llama.cpp`）
- **`ait: command not found`**：`~/.local/bin` 不在 `PATH` 里，在 `~/.zshrc` 加一行 `export PATH="$HOME/.local/bin:$PATH"` 后新开终端
- **升级 Node 后 aitd 或 ait 用不了**：重新运行 `scripts/aitd-service.sh install` 和 `scripts/install-cli.sh install`
- **改了代码不生效**：插件和命令行要 `npm run build`，插件还要在 `chrome://extensions` 点重新加载；开机自启的 `aitd` 要用上面的命令重启（或在桌面应用里点「重启翻译服务」）；桌面应用要重新 `scripts/install-desktop.sh install`
- **桌面应用菜单栏显示「aitd 没启动」**：同第一条，先确认 `aitd` 在运行
- **按 `⌥D` 没反应**：先确认真的选中了文字（没选中时什么都不做）；再看设置「快捷键」页：`⌥D` 标红说明被别的 App 占了，换一个组合键；辅助功能显示没打开就点「打开系统设置」。还不行时可以按 `⌥A` 打开翻译窗口粘贴进去翻
- **VS Code 里没选中文字按 `⌥D`，翻出来的是整行**：VS Code 没选中时 `⌘C` 会复制光标所在的整行，划词取到的就是这一行；先选中再按
- **剪贴板工具（Paste、Maccy 等）里多出一条记录**：在 Chrome、微信这类 App 里划词要模拟一次 `⌘C`，剪贴板工具会记下这一条；剪贴板本身取完就恢复原样
- **输入框里按 `⌥D` 打不出「∂」**：`⌥D` 被划词占用了，需要打这个符号时在设置里换一个组合键

## 开发

先 `nvm use`，再在仓库根目录运行：

- `npm run typecheck`：类型检查
- `npm test`：单测
- `npm run build`：打包插件（`apps/extension/dist/`）和命令行（`apps/cli/dist/`）
- `npm run e2e`：用 Playwright 自带的 Chromium 加载插件跑端到端测试（首次先 `npm run e2e:install`）
- `npm run aitd`：前台启动 `aitd`。开机自启的 `aitd` 在运行时会冲突，用 `AIT_PORT`、`AIT_LLAMA_PORT` 换端口
- `npm run ait -- <参数>`：直接跑命令行源码（不用打包），参数和装好的 `ait` 一样，如 `npm run ait -- translate 文章.md`、`pbpaste | npm run -s ait`
- `npm run qa`：译文回归检查。把 `tests/quality/samples.json` 的 71 条样例全部翻一遍，自动查残留英文、数字丢失、格式标记、内置术语等硬伤，再和基线 `tests/quality/baseline.json` 比，报告写到 `.tmp/qa/`；出现基线没有的新问题时退出码为 1。换模型、换量化版本、改提示词或术语后跑一次，人看过报告后用 `npm run qa -- --update-baseline` 更新基线
- `npm run check-page -- <网址> [--scroll] [--shot 截图.png]`：用真实模型翻译一个真实网页，输出出译文的耗时；`--scroll` 从头滚到尾列出漏翻的文字。脚本自己起一个临时 `aitd`，不碰你的缓存
- `npm run desktop:test`：桌面应用的单测（Swift Testing，`apps/desktop` 里不依赖界面的 `AITranslateKit`）
- `npm run desktop:build`：编译桌面应用、组装并签名到 `apps/desktop/build/AI Translate.app`（不安装）。核对界面时可以带调试参数启动它，把窗口存成图片：`open -n "apps/desktop/build/AI Translate.app" --args --translate-text 文本文件 --snapshot 截图.png`，另有 `--translate-file 文件 [--bilingual] [--auto-start]`、`--scroll source|result 比例`（截图前先滚动翻译窗口）、`--settings [general|shortcuts|glossary|service|models|about] [--full]`（`--full` 截设置右边的整页）、`--about`、`--card 文本文件 [--languages]`（在屏幕中间弹出划词卡片，可打开语言列表）、`--dark`；环境变量 `AIT_URL` 可改连别的 `aitd` 地址（只能是本机）。`--download-model 版本 目录 [--stop-after-mb N]` 用 App 的下载器把一个版本下到指定目录（不动 `models/`），下到 N MB 时取消，用来实测下载和断点续传；`--probe 记录文件` 是取词实测：每按一次 `⌥D`，两种取词方法各试一次，只记 App、成没成功、字数、耗时和错误码，不记文字内容；要先退出装好的 App，快捷键才归它
- 图标：`PLAYWRIGHT_BROWSERS_PATH=0 node scripts/make-icons.mjs` 重新生成插件图标和桌面应用图标（白色「中→A」，底色 `#2852C8`）

`qa` 和 `check-page` 直连模型服务、用 `api-key` 文件里的密钥，而 `aitd` 管的模型用一次性密钥，连不上，要另开一个模型服务：`AIT_PORT=8792 scripts/start-model.sh`，再 `npm run qa -- --endpoint http://127.0.0.1:8792` 或 `AIT_MODEL_URL=http://127.0.0.1:8792 npm run check-page -- <网址>`。

目录说明见 `AGENTS.md`。

## 文档

- 架构：`docs/architecture-v2.html`（当前，浏览器打开）；`docs/architecture-v1.html`（第一版，只读）
- 译文质量：`docs/quality-review.html`（评测页）、`docs/quality-review-report.html`（评测报告）、`docs/glossary-and-qa-checklist.html`（评测结论、术语和质检清单）
- 量化盲评：`docs/quant-blind-test.html`
- 字幕 prompt 写法对比：`docs/srt-prompt-compare.html`
- 进度、待办与决策：`ROADMAP.md`
- 项目约定：`AGENTS.md`
- 施工清单：`goals/`
