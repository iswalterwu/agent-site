import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { gitCommonDir, isUnder, normalizePath, resolveWatchedRepo } from "../../src/bridge/scope";
import { mkTmpDir } from "../harness/wait";

// 临时仓库里跑 git：带上提交身份，不依赖本机的 git 配置
function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
}

it("Windows 路径：斜杠与大小写不敏感", async () => {
  const repos = ["D:/work/example"];
  expect(await resolveWatchedRepo("D:\\work\\example\\frontend", repos, async () => null)).toBe("D:/work/example");
  expect(await resolveWatchedRepo("d:/work/example", repos, async () => null)).toBe("D:/work/example");
});
it("前缀陷阱：example-docs 不属于 example", async () => {
  expect(await resolveWatchedRepo("D:/work/example-docs", ["D:/work/example"], async () => null)).toBeNull();
});
it("仓库的 git worktree 也算", async () => {
  const repo = mkTmpDir(); git(repo, "init", "-q"); git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(mkTmpDir(), "wt"); git(repo, "worktree", "add", "-q", wt);
  expect(await resolveWatchedRepo(wt, [repo])).toBe(repo);
});
it("无关目录与 git 失败返回 null", async () => {
  expect(await resolveWatchedRepo(mkTmpDir(), ["D:/work/example"])).toBeNull();
  expect(await gitCommonDir(path.join(mkTmpDir(), "missing"))).toBeNull();
});

// 以下是补充的测试：目录正好等于仓库根、gitCommonDir 对真实仓库的结果、非法路径不抛出。
it("目录正好等于仓库路径（忽略末尾斜杠）也算属于该仓库", async () => {
  expect(isUnder("D:/work/example/", "D:/work/example")).toBe(true);
  expect(await resolveWatchedRepo("D:/work/example", ["D:/work/example"], async () => null)).toBe("D:/work/example");
});
it("gitCommonDir 对普通仓库返回它的 .git；传入非法路径也不抛出", async () => {
  const repo = mkTmpDir(); git(repo, "init", "-q");
  const common = await gitCommonDir(repo);
  expect(common).not.toBeNull();
  expect(normalizePath(common as string)).toBe(normalizePath(path.join(repo, ".git")));
  await expect(gitCommonDir("bad\0dir")).resolves.toBeNull();
});
