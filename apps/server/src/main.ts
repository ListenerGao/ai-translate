// 启动 aitd：npm run aitd。前台运行，Ctrl+C 退出。
// 默认由 aitd 自己按需启动 llama-server、空闲停止；设了 AIT_PRELOAD_SECONDS 时启动后过这么多秒就加载模型，AIT_IDLE_MINUTES=0 表示不空闲停止
// （开机自启的配置里两个都设了，见 scripts/aitd-service.sh）。设了 AIT_MODEL_URL 时改连那个已经在运行的 llama-server（调试用，和它共用 api-key）。
// 发布包里的桌面应用用自带的 Node 跑打包好的单文件（apps/server/build.mjs），设 AIT_EXIT_WITH_PARENT=1：App 退出或崩溃后跟着退出（Goal 9）。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startAitd } from "./app.ts";
import { ModelCatalog, chooseQuant, modelFile } from "./catalog.ts";
import { Logger } from "./log.ts";
import { ExternalModel, ManagedModel, type ModelBackend } from "./model.ts";

// 数据目录里的文件只给自己读写
process.umask(0o077);

const env = process.env;
const home = env.AIT_HOME ?? join(homedir(), "Library", "Application Support", "ai-translate");
const port = Number(env.AIT_PORT ?? 8790);
const modelsDir = join(home, "models");
const settingsFile = join(home, "settings.json");
// 用哪个量化版本：AIT_QUANT（固定）> 桌面应用里选的（settings.json）> Q8_0；选中的没有文件时用本机已有的
const { quant, pinned } = chooseQuant(env.AIT_QUANT, settingsFile, modelsDir);
const keyFile = join(home, "api-key");
// 打包成单文件时版本号在构建时写进去（apps/server/build.mjs）；直接跑源码时读 package.json
declare const AITD_BUILD_VERSION: string | undefined;
const version =
  typeof AITD_BUILD_VERSION === "string"
    ? AITD_BUILD_VERSION
    : (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

mkdirSync(join(home, "logs"), { recursive: true });
if (!existsSync(keyFile) || readFileSync(keyFile, "utf8").trim() === "") {
  writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  console.log(`已生成 API 密钥：${keyFile}（复制到插件设置页）`);
}
chmodSync(keyFile, 0o600);
const apiKey = readFileSync(keyFile, "utf8").trim();
const log = new Logger(join(home, "logs", "aitd.log"), { echo: true });

const managed =
  env.AIT_MODEL_URL === undefined
    ? new ManagedModel({
        command: env.AIT_LLAMA_SERVER ?? "llama-server",
        modelFile: modelFile(modelsDir, quant),
        quant,
        port: Number(env.AIT_LLAMA_PORT ?? 8791),
        runDir: join(home, "run"),
        idleMs: Number(env.AIT_IDLE_MINUTES ?? 30) * 60_000,
        log: (event, fields) => log.info(event, fields),
      })
    : null;
const model: ModelBackend = managed ?? new ExternalModel({ endpoint: env.AIT_MODEL_URL ?? "", apiKey });

const catalog = managed === null ? {} : { catalog: new ModelCatalog({ modelsDir, settingsFile, model: managed, pinned, log: (event, fields) => log.info(event, fields) }) };
const aitd = await startAitd({ port, apiKey, home, model, version, log, ...catalog });
const preloadSeconds = env.AIT_PRELOAD_SECONDS === undefined ? NaN : Number(env.AIT_PRELOAD_SECONDS);
if (managed !== null && preloadSeconds >= 0) setTimeout(() => void managed.preload(), preloadSeconds * 1000).unref();
console.log(
  managed === null
    ? `aitd ${version} 已启动：${aitd.url}（连已在运行的模型服务 ${env.AIT_MODEL_URL}）`
    : `aitd ${version} 已启动：${aitd.url}（模型 ${quant}，${preloadSeconds >= 0 ? `${preloadSeconds} 秒后加载` : "用到时自动启动"}）`,
);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void aitd
    .close()
    .then(() => model.close())
    .finally(() => process.exit(0));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
// 由桌面应用带起来时：App 退出或崩溃后，它给的标准输入管道会关掉，aitd 跟着退出、停掉模型，不留孤儿进程
if (env.AIT_EXIT_WITH_PARENT === "1") {
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.resume();
}
// 其他原因退出（未捕获的异常等）：把模型进程一起带走，不留孤儿
process.on("exit", () => managed?.killNow());
