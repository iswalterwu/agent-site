import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseDistributionManifest } from "../../src/protocol/launch";

it("DIST-1、DIST-2、DIST-10：桌面打包只准备白名单资源和完整版本清单", () => {
  execFileSync(process.execPath, ["scripts/build-distribution.mjs", "prepare"], { cwd: path.resolve(__dirname, "../.."), timeout: 20000 });
  const root = path.resolve(__dirname, "../../dist/distribution");
  expect(fs.readdirSync(path.join(root, "app")).sort()).toEqual([
    "INSTALL.md", "INSTALL.zh-CN.md", "LICENSE", "THIRD-PARTY-NOTICES.txt", "icon-waiting.png", "icon.png", "index.html", "main.cjs", "package.json", "preload.cjs", "renderer.js",
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "agent-site.json"), "utf8"));
  expect(parseDistributionManifest(manifest)).toEqual({ product: "agent-site", version: "0.1.0", platform: "win32", arch: "x64", launchProtocol: 1 });
  const app = JSON.parse(fs.readFileSync(path.join(root, "app/package.json"), "utf8"));
  expect(app).toEqual({ name: "agent-site", version: "0.1.0", private: true, main: "main.cjs", license: "MIT",
    description: "Pixel-art desktop monitor for coding-agent sessions.", author: "agent-site contributors" });
  expect(fs.readFileSync(path.join(root, "app/INSTALL.md"), "utf8")).toContain("agent-site-0.1.0-win-x64.zip");
  expect(fs.readFileSync(path.join(root, "app/INSTALL.md"), "utf8")).toContain("(INSTALL.zh-CN.md)");
  expect(fs.readFileSync(path.join(root, "app/THIRD-PARTY-NOTICES.txt"), "utf8")).toContain("Einar Otto Stangvik");
});

it("DIST-10：打包命令未知操作给可读错误，不上传或返回堆栈", () => {
  const result = spawnSync(process.execPath, ["scripts/build-distribution.mjs", "not-a-command"], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("desktop | plugin | all | prepare");
  expect(result.stderr).not.toContain(" at ");
});
