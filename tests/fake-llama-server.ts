// 假的 llama-server：给 aitd 的模型进程管理测试用。参数和真的一样，只认 --port 和 --api-key-file。
// 行为用环境变量控制：
// - FAKE_LLAMA_START_MS：启动后过多久才开始监听（模拟加载模型），默认 0
// - FAKE_LLAMA_FAIL：设了就把它打印到 stderr，然后以退出码 1 退出（模拟启动失败）
// - FAKE_LLAMA_DELAY_MS：每个翻译请求的耗时，默认 0
// - FAKE_LLAMA_STARTS：每次启动往这个文件追加一行进程号，用来数启动了几次
// 另外看 -m 指定的模型文件内容（测试里的模型文件是小文本）：以 broken 开头时启动失败（模拟文件损坏）；
// 有别的内容时译文带上它，如「【译 Q4_K_M】原文」，用来看出是哪个模型文件在翻
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { startMockServer } from "./mock-server.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = process.env;

if (env.FAKE_LLAMA_STARTS !== undefined) appendFileSync(env.FAKE_LLAMA_STARTS, `${process.pid}\n`);
console.error("main: loading model");
if (env.FAKE_LLAMA_FAIL !== undefined) {
  console.error(env.FAKE_LLAMA_FAIL);
  process.exit(1);
}
const modelFile = arg("-m");
const modelText = modelFile !== undefined && existsSync(modelFile) ? readFileSync(modelFile, "utf8").trim() : "";
if (modelText.startsWith("broken")) {
  console.error("error: failed to load model");
  process.exit(1);
}
await new Promise((r) => setTimeout(r, Number(env.FAKE_LLAMA_START_MS ?? 0)));
const key = readFileSync(arg("--api-key-file") ?? "", "utf8").trim();
const server = await startMockServer({ apiKey: key, port: Number(arg("--port")), delayMs: Number(env.FAKE_LLAMA_DELAY_MS ?? 0) });
if (modelText !== "") server.setResponder((req) => ({ content: `【译 ${modelText}】${req.source}` }));
console.error("main: server is listening");
process.on("SIGTERM", () => process.exit(0));
