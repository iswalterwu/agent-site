import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { gitBranch, siteKeyOf } from "../../src/main/repo.js";
import { normalizePath } from "../../src/bridge/scope.js";
import { mkTmpDir } from "../harness/wait.js";
import { git, makeRepo } from "../fixtures/repo.js";

describe("工地键", () => {
  it("SITE-1：仓库里的会话归到仓库根，worktree 归到同一个工地", async () => {
    const repo = makeRepo({ git: true });
    const wt = path.join(mkTmpDir(), "wt");
    git(repo, "worktree", "add", "-q", "-b", "wt-branch", wt);
    mkdirSync(path.join(repo, "src"), { recursive: true });
    // key 是判等用的规范化路径，path 是原样的仓库根
    expect(await siteKeyOf(path.join(repo, "src"))).toEqual({ key: normalizePath(repo), path: path.resolve(repo), kind: "git" });
    expect(await siteKeyOf(wt)).toEqual({ key: normalizePath(repo), path: path.resolve(repo), kind: "git" });
  });

  it("SITE-1：不是 git 仓库的目录自己成一个工地，用运行目录当键", async () => {
    const dir = mkTmpDir();
    expect(await siteKeyOf(dir)).toEqual({ key: normalizePath(dir), path: path.resolve(dir), kind: "dir" });
    // Windows 上大小写不同也是同一个工地
    expect(await siteKeyOf(dir.toUpperCase())).toEqual({ key: normalizePath(dir), path: path.resolve(dir.toUpperCase()), kind: "dir" });
  });

  it("SITE-1：子模块和独立 git-dir 用公共目录判等、用工作树根读 specs", async () => {
    const main = mkTmpDir(), wt = mkTmpDir(), gitDir = path.join(mkTmpDir(), "repo.git");
    const commonDir = async (): Promise<string> => gitDir;
    // 仓库本身和它的 link worktree：同一个公共目录 → 同一个工地
    expect(await siteKeyOf(main, { commonDir, toplevel: async () => main }))
      .toEqual({ key: normalizePath(gitDir), path: path.resolve(main), kind: "git" });
    expect(await siteKeyOf(wt, { commonDir, toplevel: async () => wt }))
      .toEqual({ key: normalizePath(gitDir), path: path.resolve(wt), kind: "git" });
    // 拿不到工作树根时退回公共目录
    expect(await siteKeyOf(wt, { commonDir, toplevel: async () => null }))
      .toEqual({ key: normalizePath(gitDir), path: path.resolve(gitDir), kind: "git" });
  });

  it("SITE-1：真实的独立 git-dir 仓库和它的 worktree 归到同一个工地，子模块用自己的公共目录", async () => {
    const base = mkTmpDir(), repo = path.join(base, "main"), gitDir = path.join(base, "meta.git");
    mkdirSync(repo, { recursive: true });
    git(base, "init", "-q", `--separate-git-dir=${gitDir}`, repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = path.join(base, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", wt);
    const main = await siteKeyOf(repo), side = await siteKeyOf(wt);
    expect(main.kind).toBe("git");
    expect(side.key).toBe(main.key);
    expect(main.path).toBe(path.resolve(repo));
    expect(side.path).toBe(path.resolve(wt));

    // 子模块：公共目录是 <super>/.git/modules/<name>，specs 从子模块目录读
    const sub = path.join(base, "sub");
    mkdirSync(sub, { recursive: true });
    git(sub, "init", "-q");
    git(sub, "commit", "-q", "--allow-empty", "-m", "init");
    const superRepo = path.join(base, "super");
    mkdirSync(superRepo, { recursive: true });
    git(superRepo, "init", "-q");
    git(superRepo, "commit", "-q", "--allow-empty", "-m", "init");
    git(superRepo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    const nested = await siteKeyOf(path.join(superRepo, "sub"));
    expect(nested.kind).toBe("git");
    expect(nested.path).toBe(path.resolve(path.join(superRepo, "sub")));
    expect(nested.key).toContain("modules");
  });

  it("SITE-1：git 查不出来（超时、没有 git、目录不存在）也按运行目录处理，不抛错", async () => {
    const dir = mkTmpDir();
    expect(await siteKeyOf(dir, { commonDir: async () => null }))
      .toEqual({ key: normalizePath(dir), path: path.resolve(dir), kind: "dir" });
  });

  it("返回分支名；游离头和不是仓库的目录给 null", async () => {
    const repo = makeRepo({ git: true });
    git(repo, "switch", "-q", "-c", "review/desktop-shell-r3");
    expect(await gitBranch(repo)).toBe("review/desktop-shell-r3");
    git(repo, "checkout", "-q", "--detach");
    expect(await gitBranch(repo)).toBeNull();
    expect(await gitBranch(mkTmpDir())).toBeNull();
  });
});
