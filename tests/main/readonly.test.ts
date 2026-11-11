import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { SiteEngine } from "../../src/main/engine";
import { fourSessionWorld } from "../fixtures/world";
import { min } from "../fixtures/logs";
import { sleep } from "../harness/wait";

it("引擎读过后仓库含 .git、worktree 和三种日志的 hash、size、mtime 全不变", async () => {
  const w = fourSessionWorld();
  const manifest = () => [w.repo, w.wt, ...Object.values(w.roots)].flatMap(d => readdirSync(d, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => { const p = path.join(e.parentPath, e.name), s = statSync(p);
      return `${p}|${s.size}|${s.mtimeMs}|${createHash("sha256").update(readFileSync(p)).digest("hex")}`; })).sort();
  const before = manifest(), e = new SiteEngine({ settings: w.settings, roots: w.roots, pollMs: 100, now: () => min(10) });
  try { await e.start(); await sleep(500); await e.refresh(); expect(e.snapshot().sites.flatMap(site => site.workers)).toHaveLength(5); }
  finally { e.stop(); }
  expect(manifest()).toEqual(before);
});
