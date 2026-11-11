import { execFile } from "node:child_process";
import path from "node:path";
import { gitCommonDir, normalizePath } from "../bridge/scope.js";

export function gitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 3000, windowsHide: true }, (error, stdout) => {
        const branch = stdout?.trim();
        resolve(error || !branch || branch === "HEAD" ? null : branch);
      });
    } catch { resolve(null); }
  });
}

/** 工作树根：子模块和独立 git-dir 的公共目录不在 `<根>/.git`，只能靠它认出真正的仓库根 */
export function gitToplevel(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel"],
        { encoding: "utf8", timeout: 3000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
    } catch { resolve(null); }
  });
}

/**
 * 工地键：git 仓库用公共目录归一后的仓库根（worktree 归到主仓库），不是仓库就用工作目录本身。
 * key 是规范化后的路径，用来判等（Windows 不分大小写）；path 是原样的路径，用来显示和读 specs。
 */
export interface SiteKey { key: string; path: string; kind: "git" | "dir" }

interface SiteKeyDeps {
  commonDir?: (cwd: string) => Promise<string | null>;
  toplevel?: (cwd: string) => Promise<string | null>;
}

/** 跑一次 git 认仓库；失败、超时、不是仓库都按普通目录处理，绝不抛出 */
export async function siteKeyOf(cwd: string, deps: SiteKeyDeps = {}): Promise<SiteKey> {
  const common = await (deps.commonDir ?? gitCommonDir)(cwd);
  if (common === null) return { key: normalizePath(cwd), path: path.resolve(cwd), kind: "dir" };
  // 普通仓库和它的 link worktree：公共目录都是 <仓库根>/.git，仓库根就是它的父目录
  if (path.basename(common) === ".git") return { key: normalizePath(path.dirname(common)), path: path.resolve(path.dirname(common)), kind: "git" };
  // 别的（子模块、独立 git-dir、裸仓库）：判等用公共目录——同一个仓库的各个工作树共享它，不会被拆成两个工地；
  // 读 specs 用这次会话所在的工作树根，它才是真正的代码目录（`worktree list` 在这种仓库里给的是 git 目录，不能用）
  const root = (await (deps.toplevel ?? gitToplevel)(cwd)) ?? common;
  return { key: normalizePath(common), path: path.resolve(root), kind: "git" };
}
