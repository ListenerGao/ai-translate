// ait：命令行翻译。文字、标准输入、Markdown、SRT 都交给本机翻译服务 aitd（batch 通道），和浏览器共用缓存和术语表，翻译内容不出本机。
import {
  AITD_API,
  MODEL_PROFILES,
  SrtFormatError,
  TranslateError,
  aitdHealth,
  aitdStatus,
  documentSegments,
  languageName,
  parseDocument,
  parseGlossary,
  renderDocument,
  type GlossaryEntry,
  type UnitOutcome,
} from "@ai-translate/core";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CliError, EXIT, connect, serviceError, translateAll, type Connection } from "./client.ts";
import { detectFormat, outputTarget, readSource, writeOutput } from "./files.ts";

const HELP = `ait：用本机模型翻译，内容不出本机

用法：
  ait [文字]                  翻译文字；不给文字时读标准输入（如 pbpaste | ait）
  ait translate <文件>        翻译 .md / .markdown / .srt 文件，默认写到原文件旁边（如 README.zh.md）
  ait status                  看 aitd、模型和缓存的状态

选项：
  --to <语言>        目标语言，默认 zh
  --from <语言>      原文语言，默认 auto（自动识别）
  --glossary <文件>  本次额外用的术语表（一行一条 原文=译文），和 aitd 的术语表合并，冲突时以它为准
  --bilingual        翻译文件时输出双语
  -o <路径>          输出到指定文件；-o - 打到终端
  --force            输出文件已存在时覆盖
  -h, --help         显示帮助
  -v, --version      显示版本

退出码：0 成功；1 参数或文件错误；2 aitd 没启动或密钥不对；3 有段落未翻译（已保留原文）`;

interface Options {
  to: string;
  from: string;
  /** --glossary 的文件路径，用到时再读 */
  glossaryFile?: string;
  bilingual: boolean;
  output?: string;
  force: boolean;
}

function parse(argv: string[]): { command: string; args: string[]; options: Options; help: boolean; version: boolean } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        to: { type: "string", default: "zh" },
        from: { type: "string", default: "auto" },
        glossary: { type: "string" },
        bilingual: { type: "boolean", default: false },
        output: { type: "string", short: "o" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    throw new CliError(EXIT.usage, `${err instanceof Error ? err.message : String(err)}（ait --help 看用法）`);
  }
  const { values, positionals } = parsed;
  if (languageName(values.to) === undefined) throw new CliError(EXIT.usage, `不支持的目标语言：${values.to}`);
  if (values.from !== "auto" && languageName(values.from) === undefined) throw new CliError(EXIT.usage, `不支持的原文语言：${values.from}`);
  const [first, ...rest] = positionals;
  const command = first === "status" || first === "translate" ? first : "text";
  return {
    command,
    args: command === "text" ? positionals : rest,
    options: {
      to: values.to,
      from: values.from,
      ...(values.glossary === undefined ? {} : { glossaryFile: values.glossary }),
      bilingual: values.bilingual,
      ...(values.output === undefined ? {} : { output: values.output }),
      force: values.force,
    },
    help: values.help,
    version: values.version,
  };
}

/** --glossary 的文件：格式和设置页一样；有写错的行就不翻，免得术语没生效还以为生效了 */
function readGlossary(file: string | undefined): GlossaryEntry[] {
  if (file === undefined) return [];
  if (!existsSync(file)) throw new CliError(EXIT.usage, `找不到术语表文件：${file}`);
  const { entries, errors } = parseGlossary(readFileSync(file, "utf8"));
  if (errors.length > 0) throw new CliError(EXIT.usage, `术语表 ${file} 有错误：${errors.map((e) => `第 ${e.line} 行${e.message}`).join("；")}`);
  return entries;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 翻一段文字：空行分段，每段一个请求项；没翻成的段落保留原文，退出码 3 */
async function translateText(conn: Connection, input: string, options: Options, signal: AbortSignal): Promise<number> {
  const paragraphs = input.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
  if (paragraphs.length === 0) throw new CliError(EXIT.usage, "没有要翻译的文字（ait --help 看用法）");
  const segments = paragraphs.map((text, i) => ({ id: `p${i}`, text }));
  const results = await translateAll(conn, segments, { source: options.from, target: options.to, glossary: readGlossary(options.glossaryFile), signal });
  let failed = 0;
  const out = segments.map((s) => {
    const r = results.get(s.id);
    if (r?.text !== undefined) return r.text;
    failed++;
    process.stderr.write(`第 ${Number(s.id.slice(1)) + 1} 段未翻译，已保留原文。${r?.error ?? "没有返回"}\n`);
    return s.text;
  });
  process.stdout.write(`${out.join("\n\n")}\n`);
  return failed > 0 ? EXIT.partial : EXIT.ok;
}

/** 进度写到 stderr，只在 stderr 是终端时显示，不污染重定向的输出 */
function progress(): ((done: number, total: number) => void) | undefined {
  if (!process.stderr.isTTY) return undefined;
  return (done, total) => process.stderr.write(`\r已完成 ${done} / ${total}${done === total ? "\n" : ""}`);
}

/** 翻一个文件：文件和输出位置有问题先报错，不白翻；没有要翻的段落时不连 aitd */
async function translateFile(file: string, options: Options, signal: AbortSignal): Promise<number> {
  const format = detectFormat(file);
  const source = readSource(file);
  const target = outputTarget(file, options.to, options);
  const glossary = readGlossary(options.glossaryFile);
  let doc;
  try {
    doc = parseDocument(format, source);
  } catch (err) {
    if (err instanceof SrtFormatError) throw new CliError(EXIT.usage, `${file} 第 ${err.line} 行格式不对：${err.message}`);
    throw err;
  }
  let outcomes: ReadonlyMap<string, UnitOutcome> = new Map();
  if (doc.units.length === 0) {
    process.stderr.write("没有要翻译的文字（只有代码块、空字幕等），原样输出\n");
  } else {
    const onProgress = progress();
    outcomes = await translateAll(connect(), documentSegments(doc), { source: options.from, target: options.to, glossary, signal, ...(onProgress ? { onProgress } : {}) });
  }
  // 拆段和重组和 aitd 的 /api/translate-document 共用 core 的同一份代码，两边输出逐字一致
  const { text: output, failed } = renderDocument(doc, outcomes, { bilingual: options.bilingual });
  // 没翻成的段落保留原文，stderr 列出行号，退出码 3
  for (const f of failed) process.stderr.write(`第 ${f.line} 行未翻译，已保留原文。${f.error}\n`);
  if (target === null) process.stdout.write(output);
  else {
    writeOutput(target, output);
    process.stderr.write(`已写入 ${target}\n`);
  }
  return failed.length > 0 ? EXIT.partial : EXIT.ok;
}

async function status(conn: Connection): Promise<number> {
  const api = await aitdHealth(conn.endpoint);
  if (api === null) throw serviceError(new TranslateError("unreachable"), conn);
  if (api !== AITD_API) throw new CliError(EXIT.service, "本机翻译服务和命令行的版本对不上：两边更新到同一版本");
  let st;
  try {
    st = await aitdStatus(conn);
  } catch (err) {
    throw serviceError(err, conn);
  }
  const STATE = { ready: "运行中", starting: "启动中", stopped: "已休眠（用到时自动启动）", error: "出错" } as const;
  const name = MODEL_PROFILES[st.model.model]?.label ?? st.model.model;
  const model = `${name}${st.model.quant ? ` ${st.model.quant}` : ""}，${STATE[st.model.state]}${st.model.detail ? `：${st.model.detail}` : ""}`;
  process.stdout.write(
    [`aitd ${st.version} 正常（${conn.endpoint}）`, `模型：${model}`, `队列：排队 ${st.queue.pending}，进行中 ${st.queue.active}`, `缓存：${st.cache.entries} 条`].join("\n") + "\n",
  );
  return EXIT.ok;
}

async function main(argv: string[]): Promise<number> {
  const { command, args, options, help, version } = parse(argv);
  if (help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  if (version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`ait ${pkg.version}\n`);
    return EXIT.ok;
  }
  // Ctrl+C：断开连接，aitd 撤销还没开始的段落；已经翻好的留在缓存里，重跑时直接命中
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    process.stderr.write("\n已中断\n");
    process.exit(130);
  });

  if (command === "translate") {
    const [file] = args;
    if (file === undefined) throw new CliError(EXIT.usage, "缺少要翻译的文件：ait translate <文件>");
    if (args.length > 1) throw new CliError(EXIT.usage, "一次只翻一个文件：ait translate <文件>");
    return translateFile(file, options, controller.signal);
  }
  const conn = connect();
  if (command === "status") return status(conn);
  if (args.length === 0 && process.stdin.isTTY) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.usage;
  }
  const input = args.length > 0 ? args.join(" ") : await readStdin();
  return translateText(conn, input, options, controller.signal);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`出错了：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(EXIT.usage);
  },
);
