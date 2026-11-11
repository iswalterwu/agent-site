// 读被监视仓库的 specs/<feature>/spec.md：目录名就是 feature 名，Markdown 在这里一次性转成 IntentCard。
// 意图卡是外部输入，只在这层解析和校验；core 只消费确定类型。坏卡片记 unreadable，绝不抛出。

import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { backlogStamp } from "./backlog";
import type { FeatureInput, IntentCard, Risk, Slice, SliceStep } from "../core/types";

const H1 = /^#\s+(.+?)\s*$/;
const SECTION = /^##\s+(.+?)\s*$/;
const SLICE = /^-\s*(S\d+)\s*[：:]\s*(.+?)\s*$/;
const STEP = /^\s*-\s*\[([ xX])\]\s*(.*)$/;
/** 模板写 `- A1：`，被监视仓库也写 `- AC-001-1`；两种都算一条 */
const AC = /^-\s*(?:A\d+\s*[：:]|AC-\d)/;
/** `（当前）` 或 `（当前；说明）` */
const CURRENT = /[（(]当前(?:[；;][^）)]*)?[）)]/;
const OPEN = /^-\s+\S/;
/** 待定条目：列表项的正文，最多收这么多条（清单里再多也没人看） */
const OPEN_MAX = 20;
const RISK = /^-\s*风险档\s*[：:]\s*(低|中|高)/;

/** specs/ 下带 spec.md 的目录，按目录名的码元顺序排 */
export async function readFeatures(repo: string): Promise<FeatureInput[]> {
  const dir = path.join(repo, "specs");
  const names = await featureNames(dir);
  return Promise.all(names.map(name => readFeature(name, path.join(dir, name))));
}


/** 每份 spec.md 的（路径、mtime、大小）拼成的指纹：文件内容变了、增删了 feature 都能看出来 */
export async function featuresStamp(repo: string): Promise<string> {
  const dir = path.join(repo, "specs");
  const names = await featureNames(dir);
  const parts = await Promise.all(names.map(async (name) => {
    try {
      const stat = await fs.stat(path.join(dir, name, "spec.md"));
      return `${name}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${name}:gone`;
    }
  }));
  parts.push(`backlog:${await backlogStamp(repo)}`);
  return parts.join("|");
}

export function parseIntentCard(raw: string): IntentCard | null {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const titleLine = lines.find(line => H1.test(line));
  if (titleLine === undefined) return null;
  const sections = collectSections(lines);
  const sliceLines = sections.get("切片");
  if (sliceLines === undefined) return null;
  const slices = parseSlices(sliceLines);
  if (slices === null) return null;
  return {
    title: titleOf(titleLine),
    risk: riskOf(sections.get("风险") ?? []),
    ac: countMatches(sections.get("验收例子") ?? [], AC),
    open: countMatches(sections.get("待定") ?? [], OPEN),
    openItems: (sections.get("待定") ?? []).filter(line => OPEN.test(line))
      .map(line => line.replace(/^-\s+/, "").trim()).filter(text => text !== "").slice(0, OPEN_MAX),
    slices,
  };
}

async function featureNames(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = await Promise.all(entries.filter(e => e.isDirectory())
    .map(async e => (await isFile(path.join(dir, e.name, "spec.md"))) ? e.name : null));
  return names.filter((name): name is string => name !== null).sort();
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

async function readFeature(name: string, specsDir: string): Promise<FeatureInput> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(specsDir, "spec.md"), "utf8");
  } catch {
    return { name, specsDir, error: "unreadable" };
  }
  const card = parseIntentCard(raw);
  return card === null ? { name, specsDir, error: "unreadable" } : { name, specsDir, card };
}

function collectSections(lines: readonly string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const heading = SECTION.exec(line);
    if (heading !== null) {
      const known = sections.get(heading[1]);
      current = known ?? [];
      sections.set(heading[1], current);
      continue;
    }
    current?.push(line);
  }
  return sections;
}

/** `# <feature>：<一句话>` 取冒号后的说明；没有冒号就用整行 */
function titleOf(line: string): string {
  const rest = H1.exec(line)?.[1] ?? line;
  const colon = rest.search(/[：:]/);
  if (colon < 0) return rest;
  const tail = rest.slice(colon + 1).trim();
  return tail === "" ? rest.slice(0, colon).trim() : tail;
}

function riskOf(lines: readonly string[]): Risk | null {
  for (const line of lines) {
    const match = RISK.exec(line);
    if (match !== null) return match[1] as Risk;
  }
  return null;
}

function countMatches(lines: readonly string[], pattern: RegExp): number {
  return lines.filter(line => pattern.test(line)).length;
}

/** 切片行之间的缩进复选框属于上一个切片；重复的切片 id 算读不出 */
function parseSlices(lines: readonly string[]): Slice[] | null {
  const slices: Slice[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const slice = SLICE.exec(line);
    if (slice !== null) {
      if (seen.has(slice[1])) return null;
      seen.add(slice[1]);
      const rest = slice[2];
      const done = rest.endsWith("✓");
      const title = (done ? rest.slice(0, -1) : rest).replace(CURRENT, "").trim();
      slices.push({ id: slice[1], title, done, current: CURRENT.test(rest), steps: [] });
      continue;
    }
    const step = STEP.exec(line);
    if (step !== null && slices.length > 0) {
      const item: SliceStep = { text: step[2].trim(), done: step[1] !== " " };
      slices[slices.length - 1].steps.push(item);
    }
  }
  return slices;
}
