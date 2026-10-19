// 打包命令行到 apps/cli/dist/ait.mjs：单个文件，装到 ~/.local/bin/ait 后由 Node 22 直接运行
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
await build({
  entryPoints: [here("./src/main.ts")],
  outfile: here("./dist/ait.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});
console.log(`built ${here("./dist/ait.mjs")}`);
