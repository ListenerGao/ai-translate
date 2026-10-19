// 启动 aitd：npm run aitd。前台运行，Ctrl+C 退出。
// 默认由 aitd 自己按需启动 llama-server、空闲停止；设了 AIT_MODEL_URL 时改连那个已经在运行的 llama-server（调试用，和它共用 api-key）。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startAitd } from "./app.ts";
import { Logger } from "./log.ts";
import { ExternalModel, ManagedModel, type ModelBackend } from "./model.ts";

// 数据目录里的文件只给自己读写
process.umask(0o077);

const env = process.env;
const home = env.AIT_HOME ?? join(homedir(), "Library", "Application Support", "ai-translate");
const port = Number(env.AIT_PORT ?? 8790);
const quant = env.AIT_QUANT ?? "Q8_0";
const keyFile = join(home, "api-key");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

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
        modelFile: join(home, "models", `Index-Translate-2B.${quant}.gguf`),
        quant,
        port: Number(env.AIT_LLAMA_PORT ?? 8791),
        runDir: join(home, "run"),
        idleMs: Number(env.AIT_IDLE_MINUTES ?? 30) * 60_000,
        log: (event, fields) => log.info(event, fields),
      })
    : null;
const model: ModelBackend = managed ?? new ExternalModel({ endpoint: env.AIT_MODEL_URL ?? "", apiKey });

const aitd = await startAitd({ port, apiKey, home, model, version, log });
console.log(
  managed === null
    ? `aitd ${version} 已启动：${aitd.url}（连已在运行的模型服务 ${env.AIT_MODEL_URL}）`
    : `aitd ${version} 已启动：${aitd.url}（模型 ${quant}，用到时自动启动）`,
);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void aitd
      .close()
      .then(() => model.close())
      .finally(() => process.exit(0));
  });
}
// 其他原因退出（未捕获的异常等）：把模型进程一起带走，不留孤儿
process.on("exit", () => managed?.killNow());
