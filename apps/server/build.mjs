// 打包 aitd 到 apps/server/dist/aitd.mjs（可以传别的输出路径）：单个文件，发布包里的桌面应用用自带的 Node 运行（Goal 9）。
// 版本号在构建时写进去：打包后找不到 package.json
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const outfile = process.argv[2] ? resolve(process.argv[2]) : here("./dist/aitd.mjs");
const { version } = JSON.parse(readFileSync(here("./package.json"), "utf8"));
await build({
  entryPoints: [here("./src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  legalComments: "none",
  define: { AITD_BUILD_VERSION: JSON.stringify(version) },
});
console.log(`built ${outfile}`);
