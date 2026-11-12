import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const project = path.resolve(__dirname, "../..");
const fixture = path.join(project, "tests/fixtures/distribution.py");
const checker = path.join(project, "scripts/check_distribution.py");
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function artifacts(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-site-artifacts-")); homes.push(root);
  execFileSync("python", [fixture, root, "create"]);
  if (mode === "secret") fs.writeFileSync(path.join(root, "app/main.cjs"), 'const token = "sk-abcdefgh12345678";');
  execFileSync(process.execPath, ["--input-type=module", "-e", `import {createPackage} from '@electron/asar'; await createPackage(${JSON.stringify(path.join(root, "app"))},${JSON.stringify(path.join(root, "app.asar"))});`], { cwd: project });
  execFileSync("python", [fixture, root, mode]);
  return spawnSync("python", [checker, "--artifacts", path.join(root, "out"), "--vendor", path.join(root, "vendor")], { cwd: root, encoding: "utf8" });
}

it("DIST-10：归档预检接受完整白名单制品、精确版本及同名校验值", () => {
  const result = artifacts("valid");
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("0.1.0");
});

it.each(["extra", "extra-directory", "manifest", "plugin", "checksum", "secret", "truncated", "invalid-deflate"])("DIST-10：拒绝损坏或泄漏候选 %s，错误不回显秘密或堆栈", mode => {
  const result = artifacts(mode);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("Distribution check failed:");
  expect(result.stderr).not.toContain("Traceback"); expect(result.stderr).not.toContain("sk-abcdefgh12345678");
});
