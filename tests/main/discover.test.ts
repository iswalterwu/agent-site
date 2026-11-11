import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { discover } from "../../src/main/discover.js";
import { mkTmpDir } from "../harness/wait.js";

const hooks = vi.hoisted(() => ({ beforeStat: (_file: unknown) => {} }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: (...args: Parameters<typeof actual.lstat>) => { hooks.beforeStat(args[0]); return actual.lstat(...args); } };
});

describe("discover", () => {
  it("finds only supported layouts and returns actual stats at the inclusive time boundary", async () => {
    const roots = { pi: mkTmpDir(), claude: mkTmpDir(), dsh: mkTmpDir() };
    const touch = (...parts: string[]) => { const file = path.join(...parts); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "not JSON"); return file; };
    const pi = touch(roots.pi, "project", "s.jsonl");
    const cc = touch(roots.claude, "project", "s.jsonl");
    const sub = touch(roots.claude, "project", "session", "subagents", "agent-a.jsonl");
    const dsh = touch(roots.dsh, "project", "session", "session.v4.jsonl.zstd");
    const old = touch(roots.pi, "project", "old.jsonl");
    touch(roots.pi, "s.jsonl"); touch(roots.pi, "project", "nested", "s.jsonl");
    touch(roots.claude, "project", "session", "subagents", "other.jsonl");
    touch(roots.claude, "project", "session", "tool-results", "x.jsonl");
    touch(roots.dsh, "project", "session.v4.jsonl.zstd");
    mkdirSync(path.join(roots.pi, "project", "directory.jsonl"));
    const cutoff = new Date("2025-01-01T00:00:00Z");
    for (const f of [pi, cc, sub, dsh]) utimesSync(f, cutoff, cutoff);
    utimesSync(old, new Date(cutoff.getTime() - 1000), new Date(cutoff.getTime() - 1000));
    const found = await discover(roots, cutoff.getTime());
    expect(found.map(({ harness, file }) => `${harness} ${file}`).sort()).toEqual([`pi ${pi}`, `claude ${cc}`, `claude ${sub}`, `dsh ${dsh}`].sort());
    for (const item of found) { const stat = statSync(item.file); expect(item.size).toBe(stat.size); expect(item.mtimeMs).toBe(stat.mtimeMs); }
  });
  it("returns no entries for missing roots", async () => {
    const missing = path.join(mkTmpDir(), "missing");
    expect(await discover({ pi: missing, claude: missing, dsh: missing }, 0)).toEqual([]);
  });
});

it("skips symbolic links to files and directories", async () => {
  const root = mkTmpDir(); const project = path.join(root, "project"); mkdirSync(project);
  const target = path.join(root, "target.jsonl"); writeFileSync(target, "x");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(target, path.join(project, "linked.jsonl"), "file");
  symlinkSync(project, path.join(root, "linked-project"), "junction");
  expect(await discover({ pi: root, claude: path.join(root, "missing"), dsh: path.join(root, "missing") }, 0)).toEqual([]);
});

it("skips a file removed between enumeration and stat", async () => {
  const root = mkTmpDir(); const project = path.join(root, "project"); mkdirSync(project);
  const file = path.join(project, "gone.jsonl"); writeFileSync(file, "x");
  const { unlinkSync } = await import("node:fs");
  hooks.beforeStat = (candidate) => { if (candidate === file) unlinkSync(file); };
  try { expect(await discover({ pi: root, claude: path.join(root, "missing"), dsh: path.join(root, "missing") }, 0)).toEqual([]); }
  finally { hooks.beforeStat = () => {}; }
});
