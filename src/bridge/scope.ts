// 判断一个会话的工作目录是否属于被监视的仓库（含它的 git worktree）：只做路径比较，外加一次只读的 git 查询。不写任何文件。

import { execFile } from "node:child_process";
import path from "node:path";

/** 规范化路径便于比较：绝对路径、正斜杠、无末尾斜杠；Windows 下整体小写（路径大小写不敏感）。 */
export function normalizePath(p: string): string {
  const slashed = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** 规范化后相等，或以 parent + "/" 开头。按整段比较，所以 `example-docs` 不在 `example` 之下。 */
export function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(`${p}/`);
}

const GIT_TIMEOUT_MS = 3000;

/**
 * git 认定的公共 .git 目录（worktree 指回主仓库的 .git）。
 * 任何失败都返回 null：不是仓库、目录不存在、git 不在 PATH、超时，或参数本身不合法。绝不抛出。
 */
export function gitCommonDir(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    } catch {
      // 参数不合法（比如含空字符）时 execFile 同步抛错，回调不会再来，这里直接当作失败
      resolve(null);
    }
  });
}

/**
 * 找出 cwd 所属的被监视仓库：先看 cwd 是否在某个仓库目录之下，不在再看它是不是该仓库的 worktree。
 * 命中返回 repos 里的原值（不是规范化后的），否则返回 null。
 */
export async function resolveWatchedRepo(
  cwd: string,
  repos: string[],
  commonDir: (cwd: string) => Promise<string | null> = gitCommonDir,
): Promise<string | null> {
  const direct = repos.find((repo) => isUnder(cwd, repo));
  if (direct !== undefined) return direct;
  const common = await commonDir(cwd);
  if (common === null) return null;
  return repos.find((repo) => isUnder(common, path.join(repo, ".git"))) ?? null;
}
