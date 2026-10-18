// 打包插件到 apps/extension/dist/：后台是 ES 模块，content script 必须是 IIFE（MV3 的 content script 不支持 ES 模块）。
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = { bundle: true, target: "chrome120", logLevel: "warning", legalComments: "none" };

await Promise.all([
  build({ ...common, entryPoints: [here("./src/background/index.ts")], outfile: `${dist}background.js`, format: "esm" }),
  build({ ...common, entryPoints: [here("./src/content/index.ts")], outfile: `${dist}content.js`, format: "iife" }),
  build({ ...common, entryPoints: [here("./src/options/index.ts")], outfile: `${dist}options.js`, format: "esm" }),
  build({ ...common, entryPoints: [here("./src/popup/index.ts")], outfile: `${dist}popup.js`, format: "esm" }),
]);
await cp(here("./manifest.json"), `${dist}manifest.json`);
await cp(here("./options.html"), `${dist}options.html`);
await cp(here("./popup.html"), `${dist}popup.html`);
await cp(here("./icons/"), `${dist}icons/`, { recursive: true });

console.log(`built ${dist}`);
