// 启动 aitd：npm run aitd。前台运行，Ctrl+C 退出。
// CP2 阶段连一个已经在运行的 llama-server（scripts/start-model.sh 启动，和它共用 api-key）；CP3 改为 aitd 自己按需启动模型。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startAitd } from "./app.ts";
import { ExternalModel } from "./model.ts";

// 数据目录里的文件只给自己读写
process.umask(0o077);

const home = process.env.AIT_HOME ?? join(homedir(), "Library", "Application Support", "ai-translate");
const port = Number(process.env.AIT_PORT ?? 8790);
const modelEndpoint = process.env.AIT_MODEL_URL ?? "http://127.0.0.1:8791";
const keyFile = join(home, "api-key");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

mkdirSync(home, { recursive: true });
if (!existsSync(keyFile) || readFileSync(keyFile, "utf8").trim() === "") {
  writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  console.log(`已生成 API 密钥：${keyFile}（复制到插件设置页）`);
}
chmodSync(keyFile, 0o600);
const apiKey = readFileSync(keyFile, "utf8").trim();

const aitd = await startAitd({
  port,
  apiKey,
  home,
  model: new ExternalModel({ endpoint: modelEndpoint, apiKey }),
  version,
  echoLog: true,
});
console.log(`aitd ${version} 已启动：${aitd.url}（模型服务 ${modelEndpoint}）`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void aitd.close().then(() => process.exit(0));
  });
}
