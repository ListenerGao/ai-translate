# Goal 9：开箱即用的发布包 -- 同事解压、下载模型后就能用

> 状态：**进行中**（清单 2026-10-21 18:42；主人 2026-10-21 定「按推荐来」，插件提示是主人追加的要求）：CP0~CP4 已完成（2026-10-21 20:48；21:17、21:36 按主人要求补上插件连接的服务地址、8790 被占时自动换端口）；主人本地验证通过（22:04），22:15 复检时发现找不到模型的说明只写了开发脚本，改好后 Build 4 打 zip，等 CP5 发给同事试用

## 目标

同事（Apple Silicon 的 Mac，macOS 14 以上）拿到一个 zip：

1. 解压，把 `AI Translate.app` 拖进「应用程序」，打开；第一次被系统拦下时到「系统设置 → 隐私与安全性」点「仍要打开」
2. App 自己启动本机翻译服务 aitd 和模型服务，不用装 Homebrew、nvm / Node、llama.cpp、Xcode，不用跑任何脚本
3. 第一次打开时还没有模型：App 引导下载 Q4_K_M（1.3 GB），下完自动用上
4. 按 App 的提示在 Chrome 里加载 zip 里附的插件文件夹，在 App 的「Chrome 插件连接」里核对服务地址、点「复制密钥」粘贴到插件设置
5. 按 `⌥D` 时按提示打开辅助功能权限后就能划词
6. App 关着时，插件明确提示「打开 AI Translate 桌面应用」

## 已确认（主人 2026-10-21 定，全部按推荐）

1. **aitd 由 App 带起来**：App 打开时启动 App 里带的 aitd，App 退出时一起停；检测到 8790 上已经有 aitd（主人电脑上的开机自启）就直接用它，不另起
2. **签名**：继续用主人电脑上的自签名证书（单独钥匙串里那张），App 和里面的 Node、llama-server 都用它签；同事更新 App 后辅助功能授权不丢；不做付费的 Developer ID 签名和公证
3. **只做 Apple Silicon**（arm64），不做 Intel
4. **插件**：zip 里附插件文件夹，同事在 Chrome 开发者模式里加载；不上架应用商店
5. **新手引导推荐 Q4_K_M**（1.3 GB，盲评和 Q8_0 打平、快约两成）
6. **追加**：用户关了 App 时，插件给出相应提示

## 默认做法（不需要确认，有异议再说）

- **App 里带的东西**（`Contents/Resources/Runtime/`）：Node 22 运行时（取自构建机 nvm 里 `.nvmrc` 对应的官方二进制，约 106 MB）、esbuild 打成单文件的 `aitd.mjs` 和 `ait.mjs`、llama.cpp 官方发布的 macOS arm64 包（固定版本，下载时校验 sha256，带 Metal，不依赖 Homebrew）。这些不是新依赖：项目现在就用 Node 22 和 llama.cpp，只是从「让同事自己装」改成「随 App 带上」
- **aitd 跟着 App**：App 用子进程启动 aitd（环境变量指向 App 里的 llama-server），App 退出时发 SIGTERM；aitd 加一个开关，父进程没了（标准输入关闭）就自己退出，App 崩溃也不留孤儿进程。开机 10 秒后预加载模型、之后常驻（和开机自启的设置一致）
- **「重启翻译服务」**：aitd 是 App 带起来的就重启子进程；是开机自启的就照旧 `launchctl kickstart`
- **模型回退**：aitd 启动时选中的版本（`settings.json` 或默认 Q8_0）文件不存在、又没被 `AIT_QUANT` 固定时，改用本机已有的版本（Q8_0 > Q4_K_M > 其余按大小），免得只下了 Q4_K_M 还报「模型文件不存在」
- **新手引导**：App 发现本机一个模型都没有时弹窗：说明要下载约 1.3 GB 的模型，按钮「下载 Q4_K_M」（复用「模型」页的下载，可以换镜像），下完设为当前；也可以「稍后」去「模型」页自己选
- **插件连接**：「设置 → 翻译服务」加「Chrome 插件连接」：显示 App 连的服务地址（插件设置的「本机翻译服务地址」填同一个）和「复制地址」「复制密钥」按钮；密钥只在主人点按钮时进剪贴板（主人 2026-10-21 要求：只给密钥不够，还要给地址）
- **命令行（可选）**：「设置 → 通用」加「安装命令行工具」：在 `~/.local/bin/ait` 写一个小脚本，用 App 里的 Node 跑 App 里的 `ait.mjs`
- **插件提示**：连不上 aitd 时，插件弹窗和网页里的提示改成「本机翻译服务没有运行：打开 AI Translate 桌面应用（会自动启动它）；从源码安装的见 README「常见问题」」
- **打包脚本** `scripts/package-release.sh`：构建插件、命令行、aitd 单文件和桌面应用，放进运行时，逐个签名，用 `ditto` 打成 `release/AI-Translate-<版本>-macos-arm64.zip`（`release/` 不进仓库）。zip 里：`AI Translate.app`、`Chrome 插件/`、`使用说明.txt`、`LICENSE`、`THIRD_PARTY_NOTICES.md`（Node、llama.cpp 的许可，模型条款指向 Hugging Face）、`release-manifest.json`（版本、构建号、源码提交、每个文件的 sha256）
- **调试**：App 认 `AIT_HOME`（密钥文件和数据目录），配合已有的 `AIT_URL`，能在主人电脑上用全新数据目录、别的端口实测内置 aitd，不碰主人在用的那套

## 不做

- 付费的 Developer ID 签名和苹果公证、上架 Chrome 应用商店、Intel Mac、自动更新
- 发布到 GitHub Releases 等公开渠道（对外发布，主人要求时再做）
- 把 aitd 注册成系统后台服务（`SMAppService`）：App 退出后插件、命令行就用不了，提示里说清楚
- 图片翻译（ROADMAP 待办里，另起 Goal）
- 提交、推送（未经主人要求不做）

## 依赖

- Goal 6~8 完成（桌面应用、模型页）
- 主人电脑上的自签名证书（Goal 6 生成）
- 打包时能访问 GitHub 下载 llama.cpp 官方发布包（经系统代理）

## 范围

| 允许修改 | 禁止修改 |
|---|---|
| `apps/desktop/`：带起 aitd、新手引导、复制密钥、安装命令行工具 | 插件和命令行的翻译行为 |
| `apps/server/`：单文件打包入口、父进程退出时退出、模型回退、版本号注入 | aitd 的接口和安全规则 |
| `apps/extension/`：连不上 aitd 时的提示文字 | 主人在用的开机自启 aitd、`~/Applications` 里的 App（实测用临时目录、别的端口） |
| `scripts/package-release.sh`、`.gitignore`（`release/`）、`README.md`、`AGENTS.md`、`ROADMAP.md`、`goals/` | 登录钥匙串、系统设置 |

## 检查点

### CP0 实测

- llama.cpp 官方 macOS arm64 发布包：和主人现在用的 Homebrew 版本对应的版本号、文件结构、依赖（`otool -L` 不能指向 `/opt/homebrew`）；放到 App 目录里能跑、用 GPU（Metal），翻译速度和 Homebrew 版差不多
- Node 二进制放进 App 目录、跑 esbuild 打的 aitd 单文件：`node:sqlite`、缓存、术语表正常
- 签名后打 zip，在新目录解压：签名完整；加上下载标记（`com.apple.quarantine`）后系统的评估结果（预期拦下，要「仍要打开」）
- 大小：App、zip
- **验证**：数据写进本文件「CP0 结果」

#### CP0 结果（2026-10-21 19:00）

| 项目 | 结果 |
|---|---|
| llama.cpp 官方包 | `b11669`，和主人在用的 Homebrew 版同一提交（`620d2225c`）；macOS arm64 包 12.2 MB，sha256 `dbed5549…13fd`（GitHub 发布页给的）。`llama-server` 用到 10 个库，共 28 MB，都在包里、按 `@loader_path` 找；另外只弱链接系统的 `/usr/lib/librdma.dylib`（没有也能跑）；要求 macOS 13.3 以上 |
| GPU | 能看到 `MTL0: Apple M4 Pro`；同样 Q4_K_M、同样参数：生成 124 tok/s、提示处理 938 tok/s，Homebrew 版 118 / 913，一样快 |
| Node | 构建机 nvm 里的官方 v22.21.1，arm64，112 MB |
| aitd 单文件 | esbuild 打成 81 KB；在没有 Homebrew、nvm 的干净环境（`env -i`）里用 App 里的 Node 跑：生成密钥、用官方 `llama-server` 加载模型、翻译 1.1 秒，再翻命中缓存 0.14 秒（`node:sqlite` 正常）。读版本号的 `new URL("../package.json")` 打包后找不到文件，要改成构建时写进去 |
| 目录 | 可执行文件放 `Contents/Helpers/`（Node、`llama-server` 和它的库），JS 和许可证放 `Contents/Resources/`；Helpers 里放了文本文件会让整个 App 签名失败（被当成没签名的代码） |
| 签名 | `codesign --keychain` 找不到私钥（私钥仍要在钥匙串搜索列表里），沿用安装脚本「临时加入搜索列表、签完恢复」的做法；由内到外逐个签（库 → `llama-server` → Node → App），`codesign --verify --deep --strict` 通过，搜索列表签完恢复原样 |
| 打包 | `ditto -c -k --sequesterRsrc --keepParent` 打 zip：46 MB（App 解开 139 MB）；解压到新目录后签名完整，Node、`llama-server` 能运行 |
| 系统评估 | `spctl` 对没公证的 App 一律 rejected（来源 AI Translate Local Signing），加了下载标记也一样：同事第一次打开会被拦，要到「隐私与安全性」点「仍要打开」；实机界面留到 CP5 |
| 另外 | 从「下载」文件夹直接打开时，系统会把 App 搬到临时只读位置运行：App 要检测到并提示先拖进「应用程序」（加到 CP2）；主人电脑上已有同一个 Bundle ID 的开发版（`~/Applications`），发布版不要再装到 `/Applications`，实测用临时目录 |

### CP1 aitd 单文件和跟随 App

- esbuild 打 `aitd.mjs`（版本号在构建时写进去，不再运行时读 `package.json`）；父进程退出时退出的开关；模型回退
- **单测预期**：选中的版本没有文件时用已有的（Q8_0 > Q4_K_M > 其余按大小），被 `AIT_QUANT` 固定时不回退；开关打开时标准输入关闭就退出、模型进程一起停；单文件 aitd 能启动并翻译
- **验证**：typecheck、`npm test`、e2e 全过
- **结果（2026-10-21 20:31）**：`apps/server/build.mjs` 把 aitd 打成单文件（81 KB，版本号构建时写进去，直接跑源码时照旧读 `package.json`）；`AIT_EXIT_WITH_PARENT=1` 时标准输入关掉就走和 SIGTERM 一样的退出流程；`chooseQuant` 给了模型目录时，选中的版本没有文件就改用本机已有的（Q8_0 > Q4_K_M > 其余里最大的），被 `AIT_QUANT` 固定、一个都没有时不回退。新增单测 3 条（`release.test.ts` 2 条：真的打出单文件、在干净的 `PATH` 里跑，版本号、回退到 Q4_K_M、翻译、关管道后 aitd 和模型进程都退出；没设开关时关标准输入照常运行；`catalog.test.ts` 回退 1 条）。顺带把 Goal 8 切换顺序那条单测改成等 aitd 报「进行中」再切换（并行跑测试时碰到过一次失败：只等 100 毫秒，机器忙时第一段还没开始）。typecheck 通过，`npm test` 206 条（连跑 8 遍全过）、e2e 44 条全过

### CP2 桌面应用带起 aitd、新手引导、复制密钥、命令行

- App 启动：8790 上已经有 aitd 就用它；没有就启动 App 里的；退出时停掉自己启动的；「重启翻译服务」分两种情况；aitd 起不来时菜单栏和设置里说明原因
- 新手引导、复制密钥、安装命令行工具
- **单测**：判断用哪个 aitd、启动参数和环境变量、模型都没有时要不要弹引导
- **验证**：Swift 单测；用 `AIT_HOME`（全新目录）+ 别的端口启动 App，确认带起的 aitd 能翻译、退出 App 后进程都没了；截图核对引导和按钮
- **结果（2026-10-21 20:48）**：Kit 加 `EmbeddedRuntime.swift`（数据目录认 `AIT_HOME`；找 App 里带的 Node、`aitd.mjs`、`ait.mjs`、`llama-server`，缺一个就当开发版；启动 aitd 的参数和环境变量：PATH 只给 `/usr/bin:/bin`，端口跟着 App 连的地址，10 秒后预加载、常驻，`AIT_EXIT_WITH_PARENT=1`，调试用的 `AIT_*` 透传；用哪个 aitd；从临时位置打开的判断；「安装命令行工具」写的脚本，自己的和开发脚本装的可以替换，别人的不动）；App 加 `AitdSupervisor`（打开时已有 aitd 就用，没有就用标准输入管道带起 App 里的，正常退出时 SIGTERM 等 3 秒，「重启翻译服务」分自己带起的 / 开机自启两种）、`OnboardingWindow`（介绍 → 下载进度 → 校验 → 加载 → 怎么用翻译窗口、划词、插件和复制密钥）、「设置 → 翻译服务」的「复制密钥」、「设置 → 通用」的「安装命令行工具」（只在发布包里显示）、从「下载」里直接打开时提示先拖进「应用程序」；aitd 没启动时的提示按开发版 / 发布包分开写。新增 Swift 单测 6 条，共 93 条全过。用 CP4 打出的包实测（全新数据目录、8797/8798 端口）：App 带起 Node → aitd → llama-server，翻译正常；`kill -9` App 后 0.4 秒内 aitd 和模型进程都退出、端口空出；正常退出（只给这个进程发退出事件）后 aitd 记「stopped」、进程都没了；用默认地址（主人的开机自启 aitd 在跑）时不另起、退出后主人的 aitd 照常；引导两种状态、两个设置页截图核对

### CP3 插件提示

- 连不上 aitd 时弹窗、网页提示改成打开桌面应用；e2e 里相关文字的断言同步
- **验证**：typecheck、单测、e2e 全过；截图
- **结果（2026-10-21 20:48）**：插件弹窗和网页里的提示改成「打开 AI Translate 桌面应用就会启动它；从源码安装的，在项目目录运行 scripts/aitd-service.sh install 或 npm run aitd」，标题仍是「aitd 没启动」（和桌面应用菜单栏一致）；e2e 加了这句的断言。typecheck 通过，`npm test` 206 条、e2e 44 条全过

### CP4 打包脚本

- `scripts/package-release.sh` 产出 zip；在新目录解压后检查签名、文件清单和 sha256；在全新数据目录、别的端口从 zip 里的 App 走一遍：带起 aitd → 引导 → 模型（用链接代替真的下载）→ 翻译；插件文件夹能被 Playwright 的 Chromium 加载
- **验证**：上面全过；记下 zip 大小
- **结果（2026-10-21 20:48）**：`scripts/package-release.sh` 六步（构建插件、命令行、aitd 单文件 → 构建桌面应用 → 下载并校验 llama.cpp `b11669`、缓存 → 组装：Node 和 `llama-server` 及 10 个库进 `Contents/Helpers`、JS 和许可证进 `Contents/Resources` → 用 `install-desktop.sh sign` 由内到外签名并 `codesign --verify --deep --strict` → 加「Chrome 插件」、使用说明、LICENSE、第三方声明、清单后 `ditto` 打 zip）。产出 zip 47 MB（App 解开 139 MB）。在新目录解压：清单里 35 个文件 sha256 全对、签名完整；「Chrome 插件」文件夹被 Playwright 的 Chromium 加载成功（权限仍只有 storage、scripting）；全新数据目录走一遍：一开始模型列表为空（会弹引导）、状态提示模型文件不存在 → 放好 Q4_K_M、设为当前后就绪 → 翻译正常 → 正常退出后进程都没了；加上下载标记后 `spctl` 拒绝（来源 AI Translate Local Signing），同事第一次打开要「仍要打开」

**补充（2026-10-21 21:17，主人要求「也要提供翻译服务地址」）**：「设置 → 翻译服务」的「插件密钥」一行改成「Chrome 插件连接」一节：「本机翻译服务地址」显示 App 连的地址和「复制地址」，「密钥」保留「复制密钥」；新手引导、使用说明、README 改成「核对服务地址、复制密钥」。端口被占：`AitdHosting` 多一种 `.portTaken`（aitd 健康检查不通、端口却能连上），App 打开和「重启翻译服务」时都不启动自己的 aitd，弹窗说明占着端口的程序。Swift 单测 94 条全过（新增端口检测 1 条、`portTaken` 断言）；重新打包后实测：用 Python 占住 8796、让 App 连它，App 不起 aitd、数据目录不生成文件；换成空闲的 8797，照常带起 aitd、`kill -9` App 后端口空出；设置页和引导截图核对

**补充 2（2026-10-21 21:36，主人要求「8790 被占就依次试 8791……」、快捷键提示放到标题右边、改 Build 号、先不打 zip）**：

- 端口：`AitdPorts` 给出要试的端口（上次用的排第一，再从 8790 往后 10 个），`AitdHosting.decide` 先找这些端口上已有的 aitd（健康检查回 aitd 的版本和接口号才算，模型服务的 `/health` 不算），没有再在第一个空端口启动 App 里的，模型服务用 aitd 后面第一个空端口；`AitdClient` 的地址放进共享的锁里，换端口后翻译窗口、划词、设置、模型页都跟着连新端口；用上的端口记在 App 的设置（`aitdPort`），设了 `AIT_URL` 调试时不记；App 装的 `ait` 启动脚本没设 `AIT_URL` 时用 `defaults read` 读这个端口。去掉单个端口被占时的弹窗和 `lsof`，10 个都被占才弹窗。设置页的地址每次显示时现读，打开时还在挑端口的话挑好后刷新一次
- 插件：去掉「存着旧默认地址 8791 就改成 8790」的迁移（每次后台启动都会跑，会把主人填的 8791 改回去；只有主人自己装过第一阶段，早已迁移过）；连不上时的提示加「已经开着的话，在它的「设置 → 翻译服务」核对服务地址」
- 快捷键提示：`SettingsRow` 加 `warning`，红色感叹号加文字放在标题右边，放不下（比如「必须包含 ⌃ 或 ⌥」那句长的）就放到标题下面（`ViewThatFits`）；提示文字按主人要求改成「快捷键被占用，换一个试试」「必须包含 ⌃ 或 ⌥：单用 ⌘ 会与各 App 的菜单快捷键冲突」
- 文字（主人改写）：快捷键页底部说明改成「点组合键后按下新的组合键，按 Esc 取消；鼠标悬停在组合键上点 × 清空，清空后不再生效。需包含 ⌃ 或 ⌥。」，辅助功能说明改成「划词翻译需读取其他 App 中选中的文字，仅在按下快捷键时读取一次，且只传给本机翻译服务，不记录。打开翻译窗口不需要此权限。」
- Build 号 1 → 2，主人本地验证通过后再加 1，复检修正说明后再加 1，发布用 Build 4；`package-release.sh` 加 `--no-zip`：只组装到 `release/AI-Translate-0.1.0-macos-arm64/`，同时删掉旧 zip
- 验证：Swift 单测 97 条（新增要试的端口、多端口选择、副本跟着换端口、端口情况 4 条），typecheck、`npm test` 206 条、e2e 44 条全过；`--no-zip` 组装的 App 实测：Python 占着 8796、`AIT_URL` 指 8796 时 aitd 起在 8797、模型服务端口 8798，没往主人的 App 设置里记端口；第二个实例找到 8797 上的 aitd 直接用，设置页显示 `http://127.0.0.1:8797`；快捷键页提示在标题右边、关于页 Build 2 截图核对；关掉后 8796~8798 都空出、没有残留进程，主人的开机自启 aitd 不受影响；`ait` 启动脚本读端口的三种情况（没记、记了 8797、设了 `AIT_URL`）用临时设置域实测
- 「放不下放到标题下面」只按布局推算（长提示约 300pt、标题左边可用约 280pt），没截到图：长提示要在录快捷键时按错才出现

- 主人本地验证（2026-10-21 22:04）：自动换端口、快捷键提示和各处文字验证通过

### CP5 同事试用（阻塞：主人把 zip 发给同事）

- 同事在自己的 Mac 上从 zip 开始：拦截和「仍要打开」、新手引导下载模型、加载插件、核对服务地址和复制密钥、划词授权、关掉 App 后插件的提示
- **验证**：主人转达同事的结论

### CP6 回归与文档

- README 加「直接下载使用」和维护者打包步骤；`AGENTS.md` 签名证书用途、App 里带的运行时；ROADMAP 同步；清理 `.tmp/goal-9-release/`
- **验证**：typecheck、`npm test`、Swift 单测、e2e 全过

## 验收标准

1. 一台没装开发环境的 Apple Silicon Mac：解压 → 拖进「应用程序」→「仍要打开」→ 引导下载模型 → 插件、划词都能用，全程不用终端
2. 主人电脑上（已有开机自启的 aitd）装发布包里的 App 不冲突
3. App 退出后不留 aitd、llama-server 进程；插件提示打开桌面应用
4. 只连本机、不记原文译文、密钥只从 `api-key` 读等红线不变；App 唯一的外网请求仍是「模型」页
5. 同事试用确认（CP5）
6. 文档已同步；没有新增 npm 依赖和第三方 Swift 包（Node、llama.cpp 随 App 带上，许可写进第三方声明）

## 交付

- 改动文件清单；CP0 数据；`release/` 里的 zip 和它的清单；单测、e2e 输出；同事试用结论
- 未解决问题

## 风险与对策

- **llama.cpp 官方发布包和 Homebrew 版行为不同**（参数、Metal）：CP0 实测，固定版本号；不行就从源码编一份静态的（要构建机装 cmake，先问主人）
- **自签名 App 在同事电脑上被拦**：说明文档写清「仍要打开」的位置；macOS 15 起右键「打开」不再能绕过
- **插件文件夹被同事删掉**：说明里写「先把插件文件夹放到不会删的位置再加载」
- **App 包变大**（Node 约 106 MB）：zip 预计 60 MB 左右，可以接受；以后需要再考虑 Node 的单文件可执行程序（SEA）
- **同事电脑上 8790 端口被别的程序占了**：App 依次试 8791~8799（主人 2026-10-21 定），上次用的端口优先；10 个都被占才弹窗说明。插件的服务地址要改成 App 设置里显示的，App 装的 `ait` 自动跟着

## 通用约束

同 [Goal 6](20261020-1542-6-desktop-app.md)「通用约束」。另外：App 名字以外，不在公开仓库里写参考过的其他软件的信息。
