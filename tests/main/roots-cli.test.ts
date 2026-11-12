import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { beforeAll, expect, it } from "vitest";
import { mkTmpDir } from "../harness/wait";

let dir: string;
let script: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  dir = mkTmpDir();
  const home = path.join(dir, "user");
  fs.mkdirSync(home);
  script = path.join(dir, "snapshot.mjs");
  buildSync({ entryPoints: [path.resolve(__dirname, "../../src/main/snapshot-cli.ts")], outfile: script,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_SITE_HOME: path.join(dir, "app-data"), DSH_HOME: "",
    NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "", APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local") };
});

it.skipIf(process.platform !== "win32")("DIST-7：实际snapshot入口拒绝非法控制字符，不输出成功快照", () => {
  for (const code of [1, 10, 31]) {
    const root = path.join(dir, `bad${String.fromCharCode(code)}root`);
    const result = spawnSync(process.execPath, [script, "--dsh-home", root], { cwd: dir, env, encoding: "utf8", timeout: 15000, windowsHide: true });
    expect(result.status, `control ${code}`).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).not.toBe("");
    expect(result.stderr).not.toContain("\n    at ");
    expect(fs.existsSync(root)).toBe(false);
  }
});

it("DIST-7：实际snapshot入口仍接受合法但尚不存在的根且不创建目录", () => {
  const root = path.join(dir, "not-created");
  const result = spawnSync(process.execPath, [script, "--dsh-home", root], { cwd: dir, env, encoding: "utf8", timeout: 15000, windowsHide: true });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).sources.dsh.present).toBe(false);
  expect(fs.existsSync(root)).toBe(false);
});
