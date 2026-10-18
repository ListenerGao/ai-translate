# Goal 1：滑动翻译 MVP -- Index-Translate-2B 边滑动边翻译

> 状态：**已完成**（2026-10-18 17:40）。清单 2026-10-18 15:49，16:14 按确认结果重写
> 系列：共 3 个 Goal，按顺序做 -- 1 滑动翻译 MVP → [2 保留段内格式](20261018-1549-2-inline-format.md) → [3 划词翻译与英文自动开启](20261018-1549-3-selection-auto.md)（含量化对比和总验收）。架构见 `docs/architecture-v1.html`

## 目标

打开一篇英文文章，点工具栏按钮或按快捷键后，插件把屏幕内和下方约 1 屏的段落逐段发给本机 `llama-server`（Index-Translate-2B），译文以双语对照插在原段落下方。继续往下滑，新进入范围的段落接着翻；滑过还没开始翻的段落撤销；往回滑命中缓存直接显示。翻译内容不出本机。

同时搭好后面两个 Goal 和第二阶段要复用的骨架：`Translator` 接口、`packages/core`、段落协议、在所有网页常驻的轻量 content script。

## 已确认（2026-10-18 16:05）

- llama.cpp 用 Homebrew 全局安装（16:10 已装，0.7.0，带入依赖 libomp 23.1.3、ggml 0.27.0）
- 开发和联调用 Q8_0；Q8_0 与 Q4_K_M 的对比放到 Goal 3 最后
- 插件直连 `llama-server`，暂不写 `aitd`；`packages/core` 用 TypeScript
- Node 22（`.nvmrc`）+ npm workspaces；项目 `.npmrc` 用 npmmirror；开发依赖 `typescript`、`esbuild`、`@playwright/test`、`@types/chrome`；单测用 Node 内置测试器
- `git init`（16:10 已初始化，只 init 不提交）
- 安装插件时即申请所有网站权限
- 划词翻译、英文自动开启、保留段内格式都要做，分别在 Goal 2、3

## 不做

- 保留段内链接、加粗等格式（Goal 2；本 Goal 按纯文本翻译整段）
- 划词翻译、英文网页自动开启、按网站设置（Goal 3）
- Q4_K_M 下载和对比（Goal 3 最后）
- `aitd` 服务、`ait` 命令行、桌面应用（只留接口）
- 输入框翻译、PDF、图片翻译；表格按单元格逐个翻译，不做跨单元格的整体处理
- Firefox、Safari、应用商店上架
- 提交、推送（未经主人要求不做）

## 依赖

- 网络：Hugging Face 下载模型（走本机代理）；npm 依赖走项目 `.npmrc` 的 npmmirror（全局配置的公司内网源当前连不上）
- CP6 需要主人在自己的 Chrome 里手动加载插件（开发者模式 → 加载已解压的扩展程序）

## 范围

| 允许修改 | 禁止修改 |
|---|---|
| 新建 `packages/core/`、`apps/extension/`、`scripts/`、`tests/` | `docs/architecture-v1.html`（V1 定稿，只读） |
| 根配置：`package.json`、`package-lock.json`、`tsconfig*.json`、`.nvmrc`、`.npmrc`、`playwright.config.ts`、`.gitignore` | 全局 npm 配置、全局 Node 版本、全局 Python 环境、其他项目 |
| `AGENTS.md`、`README.md`、`ROADMAP.md`、`goals/`、`docs/` 下新增说明 | llama.cpp 以外的任何全局安装 |
| `~/Library/Application Support/ai-translate/`（`models/`、`api-key`） | |

## 接口决策

### 目录

```
ai-translate/
├── packages/core/src/
│   ├── protocol.ts         段落协议与 Translator 接口
│   ├── prompt.ts           instTrans prompt
│   ├── glossary.ts         术语表解析与命中
│   ├── validate.ts         结果校验
│   ├── cache-key.ts        缓存键
│   └── models.ts           模型配置
├── apps/extension/
│   ├── manifest.json
│   └── src/
│       ├── background/     调度队列、LlamaServerTranslator、IndexedDB 缓存
│       ├── content/        段落提取、视口观察、插入译文
│       └── options/        设置页
├── scripts/
│   ├── download-model.sh   下载 GGUF 并校验 sha256
│   └── start-model.sh      前台启动 llama-server
└── tests/
    ├── e2e/                Playwright 用例
    ├── fixtures/           测试页面
    └── mock-server.ts      模拟 llama-server，延迟可调，记录收到的请求
```

### 模型服务

```bash
AIT_HOME="$HOME/Library/Application Support/ai-translate"
llama-server -m "$AIT_HOME/models/Index-Translate-2B.Q8_0.gguf" \
  --host 127.0.0.1 --port 8791 -c 16384 -np 4 -ngl 99 \
  --reasoning off --chat-template-kwargs '{"enable_thinking":false}' \
  --api-key-file "$AIT_HOME/api-key" --alias index-translate-2b
```

- `scripts/download-model.sh` 用 `curl` 下载（原生支持本机的 HTTP / SOCKS 代理，能断点续传），先下到 `.part`，sha256 和 Hugging Face 记录一致才改名
- `scripts/start-model.sh` 前台运行上面的命令；首次运行生成 32 字节随机密钥写入 `$AIT_HOME/api-key`（权限 600），`--api-key-file` 让密钥不出现在进程参数里
- 不加 `--mmproj`：第一版不做图片翻译
- `-np 4`：4 个槽位并行，每个槽位 4096 token 上下文

### 请求

- `POST http://127.0.0.1:8791/v1/chat/completions`，请求头 `Authorization: Bearer <密钥>`
- 请求体：`model: "index-translate-2b"`、一条 user 消息（prompt）、`temperature: 0`、`max_tokens: 1024`（官方默认：贪心解码、输出上限 1024）、`chat_template_kwargs: {"enable_thinking": false}`
- 发送前校验服务地址的主机是 `127.0.0.1` 或 `localhost`，不是就拒绝（AGENTS 红线）
- 单段超时 30 秒；校验不通过重试 1 次，仍失败就保留原文并在段落下标记

### Prompt（照抄官方 `inference/llm/translate.py`）

无术语命中：

```
请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。

{原文}
```

有术语命中：

```
请将以下文本翻译成中文，并且严格遵循所有约束要求。

【源文】
{原文}

【约束要求】
1. 【硬性要求】专名/术语对照: 原文A→译文A、原文B→译文B

只输出译文，不要有任何额外说明。
```

- 只放本段出现的术语（忽略大小写匹配）；一条都没命中就用无术语格式
- 语言名用官方 `LANG_NAMES`（`zh` → 中文，`en` → 英语）；指定源语言时写「以下英语文本」，自动识别时省略
- prompt 带版本号，进缓存键；改模板就升版本，旧缓存自然失效

### 段落协议（`packages/core/src/protocol.ts`）

```ts
export interface Segment {
  id: string;          // 段落 id，插件里对应一个 DOM 节点
  text: string;
  context?: string;    // 上一段原文，可选；第一版不发送，接口先留着
}

export interface TranslateRequest {
  segments: Segment[];
  source: string;      // "auto" 或语言代码
  target: string;
  model: string;       // 对应一组模型配置
  glossary?: { from: string; to: string }[];
}

export interface TranslateResult {
  id: string;
  text: string;
  cached: boolean;
}

export interface Translator {
  // 逐段返回结果；signal 用来撤销已经滑过的段落
  translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateResult>;
}
```

### 调度与缓存

- 优先级 = 段落到视口的距离（视口内为 0），越近越先翻；并发上限 = 槽位数 4。Goal 3 的划词请求会插到最前
- `IntersectionObserver` 的 `rootMargin` 为 `0px 0px 100% 0px`：段落进入范围就入队；离开范围且还没开始，就用 `AbortSignal` 撤销
- 在途请求完成后照常插入译文并写缓存；同一段重复入队只翻一次
- 缓存键：`sha256(prompt 版本 | 模型 | 目标语言 | 本段命中的术语 | 原文)`；存 IndexedDB，上限 2 万条，按最近使用淘汰

### 段落提取与显示

- 按页面实际排版找段落，不看标签名（CP6 试用后由固定标签名改为此法，见 CP6 结果）：一段文字所在的最近一个「自成一块」的元素就是它的段落，普通块、列表项、表格单元格都算；链接、加粗等行内元素的文字算进外层段落；直接写在 flex / grid 容器里的零散文字跳过（多是按钮、工具栏）
- 跳过 `pre`、`code`、`script`、`style`、`nav`、`aside`、`footer`、`form`、`textarea`、`button`、`[contenteditable]`、`svg`、`math`，导航 / 菜单 / 工具栏 / 标签栏这几种 `role` 的区域，`aria-hidden="true"` 的区域，以及插件自己插入的节点
- 跳过少于 2 个字符、没有字母的段落，以及已经是目标语言的段落：中日韩目标按文字比例判断（汉字占字母一半以上即视为中文），同步、够快；其他目标语言一律翻译（实现时由 `chrome.i18n.detectLanguage` 改为此法）
- 译文插在块内、紧跟段落自己最后一段文字之后（嵌套的子列表留在后面，标题开头的锚点图标留在前面）：自定义元素 `<ait-translation lang="zh-CN">`；「只看译文」模式隐藏原文，还原时全部撤回
- 译文位置看实际排版（主人 CP6 定，要保证美观）：1~4 个单词的短文本先试着放在同一行右边，原文本身折行、或译文接在后面会折行就改到原文下方；5 个单词起直接放原文下方。中日韩等不靠空格分词的文字不套用单词数规则，放原文下方
- 译文和原文一样（品牌名、产品名原样输出）时不显示；Translator 对「两次都原样照抄」照常返回，不再当成翻译失败
- 段落对照，译文用不同颜色和原文区分（主人 CP6 定）：浅色区域深青色 `#0f766e`，深色区域浅青色 `#5eead4`；按段落背后第一个不透明背景色判断深浅，找不到时看页面是否声明深色配色方案（不看文字颜色，浅灰副标题会被误判）；不用蓝色，免得和链接混淆

### 插件

- MV3；权限 `storage`、`scripting`；host 权限 `http://*/*`、`https://*/*`（安装时申请）
- content script 静态注册到所有 http / https 页面，体积保持小；没开启翻译时不观察段落、不发请求
- 点工具栏按钮或按快捷键（默认 `Alt+T`，可在 `chrome://extensions/shortcuts` 改）切换当前标签页的翻译；图标角标显示「译」表示已开启
- 安装或更新插件后，对已打开的标签页用 `chrome.scripting` 补注入一次，免得要刷新页面
- content script 和后台用 `chrome.runtime.connect` 长连接通信，消息四种：`enqueue`、`cancel`、`result`、`error`
- 设置项存 `chrome.storage.local`：服务地址（默认 `http://127.0.0.1:8791`）、密钥、目标语言、显示模式、术语表
- 出错提示分两类（实现时调整，避免整页几十段重复同一句）：服务没启动、密钥不对、没填密钥、地址不对是整页问题，页面右上角提示一次，附「打开设置」，段落保持未翻译，改好设置后自动重新翻；超时、服务出错、译文不合格在段落下显示一行
- e2e 无法点浏览器工具栏，测试在后台 service worker 里直接调用工具栏按钮用的同一个切换函数

## 检查点

### CP0 文档（已完成）

- `AGENTS.md`、`CLAUDE.md`、`README.md`、`ROADMAP.md`、`.gitignore`、3 份施工清单
- **验证**：`AGENTS.md` 不超过 16KB；看板解析函数能读出 ROADMAP 四节和 README 定位
- **结果**（15:49）：`AGENTS.md` 2782 字节；看板解析出当前阶段、进行中 0、待办 4、阻塞 1，README 定位正常。16:14 按确认结果改了 `AGENTS.md` 的权限红线和已定决策

### CP1 模型服务

- 安装 llama.cpp；`git init`；`scripts/download-model.sh Q8_0`
- 冒烟样例放 `.tmp/goal-1-scroll-translate/cp1/`：
  - 10 段英文（博客、新闻、技术文档各取几段，含专有名词和代码名），逐段跑一遍，再 4 段并行跑一遍
  - 5 段带链接、加粗标记的英文，测 2B 能不能保住标记（给 Goal 2 提前探路，只记录，不影响本 CP 通过）
- **验证**：
  - 能加载模型（Index-Translate 基于 Qwen3.5，先确认这版 llama.cpp 支持）
  - 输出不含 `<think>`，只有译文
  - 不带密钥请求返回 401；`lsof` 确认只监听 `127.0.0.1`
  - 记录单段首 token 时间和总时长、单路和 4 路的 token/s、内存占用
- **预期**：数据写进 ROADMAP「最近验证」；按实测定 CP6 的速度门槛（初值：首段 3 秒内出译文，首屏 6 秒内全部出译文）
- **结果**（16:19，样例和脚本在 `.tmp/goal-1-scroll-translate/cp1/`，10 段为按三类文体自写的英文）：
  - 加载正常：启动 3 秒就绪，4 个槽位各 4096 token
  - 单段 0.30~0.59 秒出完整译文（读入原文 55~98 毫秒），生成约 93 token/s；4 段并行 0.97 秒全部完成，合计 137 token/s
  - 10 段输出都没有思考内容；术语表生效（liveness probe → 存活探针）
  - 不带密钥、密钥错误都返回 401；只监听 `127.0.0.1:8791`；进程参数里看不到密钥
  - 内存：物理占用 0.93 GB（峰值 1.0 GB），含模型文件映射的 RSS 2.93 GB
  - 格式探路（写法 A）：5/5 段标记全部保住，个别标记内多出空格（如 `<g1> 速度显著更快</g1>`），Goal 2 要处理标记两侧空白
  - 发现：代码名 `initialDelaySeconds` 在纯文本里被译成「初始延迟秒数」，Goal 2 把行内代码当原样保留的元素后可解决
  - CP6 速度门槛按实测收紧为：首段 1.5 秒内出译文，首屏 3 秒内全部出译文（留出插件自身开销）

### CP2 工程骨架

- `.nvmrc`（22）、`.npmrc`（npmmirror）、根 `package.json`（workspaces）、`tsconfig`、esbuild 构建脚本、Playwright 配置
- 空插件：manifest、空后台、空 content script
- 补齐 `AGENTS.md` 的验证命令
- **验证**：`npm run typecheck`、`npm test`、`npm run build`、`npm run e2e` 都能跑通；e2e 只检查插件能加载、后台 service worker 存在
- **结果**（16:19）：四条命令都通过，e2e 1 条用例 3.2 秒。依赖实装 `typescript` 7.0.2、`esbuild` 0.28.2、`@playwright/test` 1.64.1、`@types/chrome` 0.3.5；Playwright 的 Chromium 装在 `node_modules` 里（`PLAYWRIGHT_BROWSERS_PATH=0`）。core 只能用 `globals.d.ts` 里声明的 Web 标准对象（`AbortSignal`、`TextEncoder`、`URL`、`crypto.subtle`），用到 DOM 或 Node 专有 API 时类型检查报错

### CP3 packages/core

- 协议类型、prompt、术语表、校验、缓存键、模型配置
- 单测：
  - prompt：无术语、有术语、术语都没命中退回无术语格式、源语言自动和指定；和官方 `translate.py` 生成的 5 个样例逐字比对（样例生成脚本放 `.tmp/`）
  - 术语表：空行、缺 `=`、重复原文、前后空格
  - 校验：空输出、含 `<think>`、和原文完全相同、长度超过原文 4 倍、明显不是目标语言
  - 缓存键：同输入结果稳定；术语、模型、prompt 版本任一变化，键就变
- **验证**：`npm test` 全过；`packages/core` 里搜不到 `chrome.`、`document`、`window`、`node:` 引用
- **结果**（16:38）：core 6 个模块 32 条单测全过；5 个官方对照样例由官方 `trans_prompt` 生成（fixture 在 `packages/core/src/fixtures/official-prompts.json`），逐字一致；新增 `endpoint.ts` 校验服务地址只能是本机；core 非测试文件里搜不到禁用引用

### CP4 后台

- `LlamaServerTranslator`、调度队列、IndexedDB 缓存、读取设置
- 单测：
  - 调度（假 Translator）：按优先级出队；并发不超过 4；未开始的能撤销；在途的完成后写缓存；同一段重复入队只翻一次
  - Translator（对 `tests/mock-server.ts`）：正常返回、401、500、超时、返回思考内容时重试 1 次后标记失败、服务地址不是本机时拒绝发送
- **验证**：`npm test` 全过
- **结果**（16:38）：调度、Translator、缓存流水线共 25 条单测全过（总计 57 条）。实现中补了一个竞态：撤销消息可能在查缓存期间到达，那时任务还没进队列，于是每段配一个撤销信号，查完缓存、入队前再检查一次。IndexedDB 打不开时退回内存缓存

### CP5 网页端与 e2e

- 段落提取、视口观察、`MutationObserver`、插入译文、开关与还原、错误提示、设置页
- e2e 用模拟服务（固定延迟 300 毫秒，记录请求）和两个测试页面：
  - `long-article.html`：60 段，夹代码块、导航、中文段落
  - `infinite-scroll.html`：滚到底自动追加段落
- **e2e 用例与预期**：
  1. 没开启翻译时打开页面、上下滚动：模拟服务收不到任何请求
  2. 开启后只请求视口内和下方 1 屏的段落
  3. 快速滚到底：滑过但没开始的段落被撤销，模拟服务收到的请求数明显少于段落总数
  4. 滚回顶部：不产生新请求（缓存命中）
  5. 代码块、导航、中文段落不请求、不插入
  6. 追加的新段落进入范围后被翻译
  7. 关闭并还原：插件插入的节点全部移除，页面 DOM 和开启前一致
  8. 模拟服务返回 401：页面提示「密钥不对」；改对密钥后自动重新翻译
  9. 后台被回收后继续滚动，仍能翻译
- **验证**：`npm run e2e` 全过
- **结果**（16:38）：e2e 10 条全过（滑动翻译 9 条、设置页 1 条、加载 1 条，用时约 23 秒）。几点说明：
  - 用例 9 原计划空闲等 30 秒，实测 Playwright 连着后台时它不会休眠（等 40 秒也没被回收），改为用调试接口 `ServiceWorker.stopAllWorkers` 直接停掉后台，并断言后台确实重启过；真实 Chrome 里的空闲休眠留到 CP6 观察
  - 用例 2 的断言改为「请求的段落不超出开启时的范围、开启时视口内的段落全部被请求」：译文插入会把下方段落推出范围，那些还没开始的段落会被撤销，这是预期行为
  - 新增插件图标（蓝底白字「译」，`scripts/make-icons.mjs` 生成）和设置页（服务地址、密钥、目标语言、显示方式、术语表、测试连接）
  - 真实模型预检（Playwright 的 Chromium + 本机 2B Q8_0，30 段文章页，3 次）：首段 0.21~0.34 秒出译文，首屏 7 段 1.16~1.34 秒全部出完，达到门槛

### CP6 真实模型联调与主人试用（阻塞：主人操作）

- 启动真实服务；主人在自己的 Chrome 加载 `apps/extension/dist/`，在设置页填密钥
- 3 篇真实文章：博客、新闻、技术文档各 1 篇，主人可以指定
- **验证**：
  - Chrome 本地网络访问限制：没有弹窗，请求没被拦；记下 Chrome 版本
  - 首段、首屏耗时达到 CP1 定的门槛
  - 主人通读后给出译文质量和使用体验的结论，问题记进 ROADMAP
- **结果**（17:02，进行中）：
  - 主人的 Chrome：没有本地网络访问授权弹窗，请求没被拦；速度很快
  - 漏翻：Hugging Face 文档页（`https://huggingface.co/docs/hub/enterprise-sso`）的 div 标题和整张对比表没翻。原因是按固定标签名找段落，用 div、表格装文字的页面会漏。改为按排版找段落后，同一页面用真实模型完整滚一遍，翻译段落从 27 段增加到 73 段，只剩页底两个按钮式翻页链接按规则跳过（诊断脚本 `.tmp/goal-1-scroll-translate/cp6/coverage.mjs`）
  - 主人要求：保持段落对照，译文换颜色区分，已实现
  - 主人反馈选中文字没有划词图标：划词翻译在 Goal 3，尚未实现
  - 新增 e2e 用例 10（div、表格、列表、行内混排、界面元素和隐藏内容）和用例 11（译文颜色），e2e 共 12 条全过；用例 4 的断言改为「翻过的内容只请求一次」（关闭还原后页面变短，范围里多出的未翻段落第一次请求属正常）
  - 17:09 主人反馈插件错误页出现「Unchecked runtime.lastError: The page keeping the extension port is moved into back/forward cache」：Chrome 123 起页面进入往返缓存时会关掉插件长连接，后台断开处理没读 lastError 所以报错；顺带发现真问题：后退回原页面后网页端仍往已关闭的连接发消息，往下滑不再翻译。修复：离开页面（pagehide）时主动断开、后退回来（pageshow）时重连并重新排队（Chrome 官方建议），发送失败自动重连一次，前后台断开处理都读 lastError。新增 e2e 用例 12（Playwright 默认关掉往返缓存，该用例单独打开），撤掉修复时失败、恢复后通过；e2e 共 13 条全过
  - 17:18 主人看到「Hub」的译文「枢纽」放在下方撑高了标题，提议放右边。定案：单个单词不翻；2~5 个单词的短文本译文跟在同一行右边；更长的放下方。用真实页面截图复核时又发现两处并修复：标题开头有块级锚点图标时译文被插到原文前面（插入位置改为段落自己最后一段文字之后）；译文和原文一样时显示成「Hugging Face Hugging Face」（改为不显示）。新增单测 5 条（单词数规则、照抄原文照常返回），e2e 用例 13、14，单测 62 条、e2e 15 条全过；截图在 `.tmp/goal-1-scroll-translate/cp6/hf-after2.png`、`hf-table.png`
  - 17:26 主人指出窄栏里的短文本译文接在折行的原文后面又被折开（「加速推 / 理的更快示例」），要求按内容长度判断、保证美观。改为先放右边再量实际排版，放不下就改到下方；同时发现浅灰色副标题的译文用了浅青色、在浅色背景上看不清（按文字颜色判断深浅的缺陷），改为按背景色判断。新增 e2e 断言（窄栏折行、译文放不下、浅灰文字配色），e2e 15 条全过；真实页面截图 `.tmp/goal-1-scroll-translate/cp6/hf-after3.png` 复核通过
  - 17:32 主人改定：1~4 个单词先试着放右边，5 个单词起放下方；单个单词恢复翻译（推翻 17:18 的「单个单词不翻」）。单测 61 条、e2e 15 条全过，真实页面截图 `.tmp/goal-1-scroll-translate/cp6/hf-after4.png` 复核
  - 17:40 主人定：译文质量留到日常使用中对比，不再单独试另外 2 篇，CP6 按此收口

### CP7 回归与文档

- typecheck、test、build、e2e 全部重跑
- README 写清使用步骤：安装 llama.cpp、下载模型、启动服务、加载插件、填密钥；`AGENTS.md` 验证命令；ROADMAP 更新
- 清理 `.tmp/goal-1-scroll-translate/`
- **验证**：新开终端按 README 从零走一遍
- **结果**（17:40）：
  - typecheck 通过；单测 61 条、e2e 15 条全过
  - 从零走一遍：把 75 个应入库的文件复制到干净目录，`npm ci`、typecheck、build、单测全部通过；安装 llama.cpp、下载模型、启动服务、加载插件、填密钥这几步在 CP1、CP6 已实际走过
  - 仓库里搜不到密钥，没有 `*.gguf`；`AGENTS.md` 3887 字节
  - 三个真实网页诊断脚本合并成 `scripts/check-page.mjs`（`npm run check-page`），Goal 2、3 继续用；`.tmp/goal-1-scroll-translate/` 已清理

## 验收标准

1. e2e 1~9 全过：没开启时不发请求、只翻视口和下方 1 屏、滑过撤销、回滑命中缓存、跳过代码和中文、新内容会翻、能完整还原、错误有提示、后台休眠后能恢复
2. 服务只监听 `127.0.0.1`，不带密钥被拒；服务地址不是本机时插件拒绝发送；仓库里搜不到密钥，没有 `*.gguf`
3. prompt 和官方格式逐字一致
4. 真实模型下首段、首屏耗时达到 CP1 定的门槛
5. 主人在自己的 Chrome 上用 3 篇真实文章试用，并给出结论
6. `packages/core` 不依赖浏览器和 Node API；换 `Translator` 实现不需要改网页端代码
7. README、AGENTS、ROADMAP 已同步；除 llama.cpp 外没有全局改动

## 交付

- 改动文件清单
- `scripts/download-model.sh`、`scripts/start-model.sh`
- 能直接加载的插件 `apps/extension/dist/`
- 单测和 e2e 输出
- CP1 实测数据（含 Goal 2 探路结果）、CP6 试用结论
- 未解决问题

## 风险与对策

- **Chrome 本地网络访问限制拦请求**：Chrome 团队在扩展论坛答复，有对应 host 权限的插件不受影响；但 e2e 用的是 Playwright 自带的 Chromium，不代表正式版 Chrome，所以 CP6 在主人的 Chrome 上再测。被拦就记录现象、查官方文档再定方案，不擅自加权限
- **关思考参数不生效**：请求里同时带 `chat_template_kwargs`；校验拦下思考内容并重试
- **llama.cpp 不支持 Qwen3.5 结构**：CP1 第一步验证，加载失败就停下报告，不往下走
- **2B 质量不够**：模型配置切 9B 对比；专有名词用术语表兜底
- **content script 拖慢所有网页**：没开启时只挂一个消息监听，不扫描 DOM；CP5 量一下注入后的脚本体积和执行耗时
- **网站样式冲突**：译文节点用独立 class 并重置关键样式；冲突的站点记进问题清单
- **MV3 后台休眠**：长连接期间的消息会延长后台存活；e2e 9 专门覆盖休眠后恢复
- **正文提取误判**：先覆盖常见文章页，误判的站点记进问题清单，下一轮再改规则

## 通用约束（Goal 1~3 相同）

- 临时文件放 `.tmp/<goal-slug>/`，收尾时清理
- 跑命令前先 `nvm use`（读 `.nvmrc`）；npm 走项目 `.npmrc`
- 不动全局 Python 环境：缺 Python 包时换不依赖它的做法
- 未经主人要求不提交、不推送
- 每个 CP 完成后在本文件记「结果」，并同步 ROADMAP

## 收尾（2026-10-18 17:40）

- **验收**：
  1. e2e 全过：原定 9 条之外，又因试用反馈补了 6 条（div 与表格、短文本位置、锚点标题与品牌名、译文颜色、往返缓存、设置页），共 15 条 -- 达成
  2. 服务只监听 `127.0.0.1`、不带密钥 401；非本机地址插件拒绝发送；仓库无密钥、无模型文件 -- 达成
  3. prompt 与官方格式逐字一致（5 个对照样例） -- 达成
  4. 真实模型首段 0.21~0.34 秒、首屏 1.16~1.34 秒 -- 达成
  5. 主人在自己的 Chrome 上试用：无授权弹窗、速度快；据反馈改了漏翻、配色、译文位置、往返缓存；译文质量由主人在日常使用中对比 -- 按主人决定收口
  6. `packages/core` 不依赖浏览器和 Node API（类型检查强制）；`Translator` 可替换 -- 达成
  7. 文档同步；全局改动只有 llama.cpp（含 libomp、ggml） -- 达成
- **交付**：`packages/core`、`apps/extension`（`apps/extension/dist/` 可直接加载）、`scripts/download-model.sh`、`scripts/start-model.sh`、`scripts/make-icons.mjs`、`scripts/check-page.mjs`、单测与 e2e、本清单里的实测数据
- **和计划不同的地方**：段落识别改为按排版；整页错误改为右上角提示条；中文判断改为按文字比例；译文按长短和实际排版选择放右边或下方、按背景配色；e2e 9 用调试接口停掉后台模拟休眠
- **临时文件**：`.tmp/goal-1-scroll-translate/` 已清理，清单里提到的截图、冒烟样例和诊断脚本随之删除；诊断能力已并入 `scripts/check-page.mjs`
- **未解决**：真实 Chrome 里后台空闲休眠后的恢复只在自动化里模拟验证；译文质量待主人日常使用中评估

