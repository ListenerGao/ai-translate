// Goal 5 CP4：scripts/install-cli.sh。把 HOME 指到临时目录跑真脚本，不碰主人的 ~/.local/bin。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./install-cli.sh", import.meta.url));
let home: string;
let target: string;

function run(...args: string[]) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, NVM_DIR: process.env.NVM_DIR ?? join(homedir(), ".nvm") },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "ait-install-"));
  target = join(home, ".local", "bin", "ait");
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("install-cli.sh", () => {
  test("install：放好可执行的启动脚本，用 .nvmrc 的 Node 跑打包好的 ait；卸载后不留东西", () => {
    const installed = run("install");
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stdout, /已安装：.*ait（ait \d+\.\d+\.\d+，Node v22\./);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    const script = readFileSync(target, "utf8");
    assert.match(script, /\/v22\.[^/]+\/bin\/node" ".*apps\/cli\/dist\/ait\.mjs" "\$@"/);

    const version = spawnSync(target, ["--version"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^ait \d+\.\d+\.\d+\n$/);

    assert.equal(run("install").code, 0, "重复安装覆盖自己装的");
    assert.equal(run("uninstall").code, 0);
    assert.ok(!existsSync(target));
    assert.match(run("uninstall").stdout, /没有安装/);
  });

  test("同名的 ait 不是本脚本装的：安装和卸载都不动它，退出码 1", () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(target, "#!/bin/sh\necho someone else\n", { mode: 0o755 });
    const installed = run("install");
    assert.equal(installed.code, 1);
    assert.match(installed.stderr, /不是本脚本装的/);
    assert.equal(run("uninstall").code, 1);
    assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\necho someone else\n");
    rmSync(target);
  });

  test("参数不对：显示用法，退出码 2", () => {
    const r = run("bogus");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /用法/);
  });
});
