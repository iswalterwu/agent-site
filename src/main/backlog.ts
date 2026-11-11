// 工地自己的待办清单：specs/backlog.md 里以 "- " 开头的一行一条。
// 外部输入，只在这层解析；坏文件当没有，绝不抛出。

import fs from "node:fs/promises";
import path from "node:path";

/** 最多收这么多条：清单里再多也没人看 */
const BACKLOG_MAX = 20;

export async function readBacklog(repo: string): Promise<string[]> {
  try {
    const raw = (await fs.readFile(path.join(repo, "specs", "backlog.md"), "utf8")).replace(/^﻿/, "");
    return raw.split(/\r?\n/)
      .filter(line => line.startsWith("- "))
      .map(line => line.slice(2).trim())
      .filter(text => text !== "")
      .slice(0, BACKLOG_MAX);
  } catch {
    return [];
  }
}

/** （mtime、大小）拼成的指纹：待做池改了要能重读 */
export async function backlogStamp(repo: string): Promise<string> {
  try {
    const stat = await fs.stat(path.join(repo, "specs", "backlog.md"));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "gone";
  }
}
