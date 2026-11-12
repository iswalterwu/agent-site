import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const script = path.resolve(__dirname, "../../scripts/prepare-release.mjs");
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-site-release-")); homes.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main"); git("config", "user.name", "Synthetic Contributors"); git("config", "user.email", "noreply@example.test");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"synthetic","version":"0.1.0"}'); git("add", "."); git("commit", "-m", "synthetic source");
  return { root, git, check: () => spawnSync(process.execPath, [script, "--check-source"], { cwd: root, encoding: "utf8" }) };
}

it("DIST-10：正式发行只接受干净的已同步公开提交，不从私人开发仓库出包", () => {
  const repo = repository();
  expect(repo.check().status).not.toBe(0);
  repo.git("remote", "add", "origin", "https://example.test/private.git");
  expect(repo.check().status).not.toBe(0);
  repo.git("remote", "set-url", "origin", "https://github.com/iswalterwu/agent-site.git");
  expect(repo.check().status).not.toBe(0);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  expect(repo.check().status).toBe(0);
  fs.writeFileSync(path.join(repo.root, "extra.txt"), "unreviewed input");
  const dirty = repo.check(); expect(dirty.status).not.toBe(0); expect(dirty.stderr).toContain("clean"); expect(dirty.stderr).not.toContain(" at ");
  fs.rmSync(path.join(repo.root, "extra.txt"));
  fs.writeFileSync(path.join(repo.root, "package.json"), '{"name":"synthetic","version":"0.1.1"}'); repo.git("add", "."); repo.git("commit", "-m", "not yet synchronized");
  expect(repo.check().status).not.toBe(0);
});

it("DIST-10：发行命令未知参数给可读错误，不构建、不联网或上传", () => {
  const repo = repository();
  const result = spawnSync(process.execPath, [script, "--upload"], { cwd: repo.root, encoding: "utf8" });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("Usage:"); expect(result.stderr).not.toContain(" at ");
  expect(fs.existsSync(path.join(repo.root, "dist"))).toBe(false);
});
