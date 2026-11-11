// 测试用的假仓库：在 mkTmpDir() 建的临时目录里写 specs/<feature>/spec.md，需要时 git init。
// git 一律带三个 -c，不依赖本机全局的 git 身份和签名设置。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmpDir } from "../harness/wait";

/** 在 dir 里跑 git，返回 stdout */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 一张最小可读的意图卡；slices 按行原样写，默认三片（一片 ✓、一片当前、一片未拆） */
export function card(o: { name?: string; risk?: "低" | "中" | "高"; ac?: string[]; open?: string[]; slices?: string[] } = {}): string {
  return [
    `# ${o.name ?? "示例功能"}：一句话`,
    "",
    "## 目标",
    "",
    "说明。",
    "",
    "## 范围",
    "",
    "- 做：x",
    "- 不做：y",
    "",
    "## 验收例子",
    "",
    ...(o.ac ?? ["A1：例子", "A2：例子"]).map(a => `- ${a}`),
    "",
    "## 风险",
    "",
    `- 风险档：${o.risk ?? "低"}`,
    "- 风险加项：无",
    "- 验收方式：每刀验收",
    "",
    "## 切片",
    "",
    ...(o.slices ?? ["- S1：第一刀 ✓", "  - [x] 做完了", "- S2：进行中（当前）", "  - [x] 第一步", "  - [ ] 第二步", "- S3：还没拆"]),
    "",
    "## 待定",
    "",
    ...(o.open ?? []).map(item => `- ${item}`),
    "",
  ].join("\n");
}

/** cards：feature → spec.md 内容；files：feature → 额外文件名（写空文件）；git：是否初始化 */
export function makeRepo(o: { cards?: Record<string, string>; files?: Record<string, string[]>; git?: boolean } = {}): string {
  const repo = mkTmpDir();
  for (const [feature, text] of Object.entries(o.cards ?? {})) write(path.join(repo, "specs", feature, "spec.md"), text);
  for (const [feature, files] of Object.entries(o.files ?? {}))
    for (const file of files) write(path.join(repo, "specs", feature, file), "");
  if (o.git) {
    git(repo, "init");
    git(repo, "commit", "--allow-empty", "-m", "init");
  }
  return repo;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
