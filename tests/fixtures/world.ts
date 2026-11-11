import { appendFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Roots } from "../../src/main/discover";
import { defaultSettings, type Settings } from "../../src/main/settings";
import { mkTmpDir } from "../harness/wait";
import { git, card, makeRepo } from "./repo";
import { appendZstd, ccAssistant, ccUser, dshCall, dshHeader, min, piAssistant, piHeader, piUser, writeJsonl } from "./logs";

export interface World { repo: string; wt: string; roots: Roots; settings: Settings }
export function emptyWorld(): World {
  const repo = makeRepo({ git: true, cards: { "data-layer": card({ name: "data-layer" }), settings: card({ name: "settings" }) } });
  const wt = path.join(mkTmpDir(), "wt");
  git(repo, "worktree", "add", "-b", "test-world", wt);
  return { repo, wt, roots: { pi: mkTmpDir(), claude: mkTmpDir(), dsh: mkTmpDir() },
    settings: { ...defaultSettings(), repos: [{ path: repo, name: "T" }], features: [
      { name: "data-layer", placement: "band", materials: [{ material: "brick", share: 100 }] },
      { name: "settings", placement: "band", materials: [{ material: "concrete", share: 100 }] }] } };
}
export function piFile(root: string, id: string): string { return path.join(root, "--x--", `2026-11-04T08-00-00-000Z_${id}.jsonl`); }
export function fourSessionWorld(): World {
  const w = emptyWorld(), { repo, wt, roots } = w;
  writeJsonl(piFile(roots.pi, "p1"), [piHeader(repo, { id: "p1", t: min(0) }), piUser("# data-layer Plan R1：写计划\n- 你是协调者", min(1)),
    piAssistant([{ type: "text", text: "写好了。要提交吗？" }], { t: min(5) })]);
  writeJsonl(piFile(roots.pi, "p9"), [piHeader(mkTmpDir(), { id: "p9", t: min(0) }), piUser("别处的会话", min(1))]);
  const main = path.join(roots.claude, "proj", "c1.jsonl"), S = { sid: "c1", cwd: wt };
  writeJsonl(main, [ccUser({ ...S, text: "看看 settings", t: min(2) }), ccAssistant({ ...S, t: min(3),
    blocks: [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: `${wt}/specs/settings/spec.md` } }] })]);
  appendFileSync(main, "{oops\n");
  const child = path.join(roots.claude, "proj", "c1", "subagents", "agent-a1.jsonl");
  writeJsonl(child, [ccUser({ ...S, agentId: "a1", text: "查一下", origin: "coordinator", t: min(3) }),
    ccAssistant({ ...S, agentId: "a1", t: min(4), blocks: [{ type: "tool_use", id: "u2", name: "Read", input: { file_path: "src/x.ts" } }] })]);
  writeFileSync(child.replace(/\.jsonl$/, ".meta.json"), '{"agentType":"Explore","spawnDepth":1}');
  appendZstd(path.join(roots.dsh, "--x--", "d1", "session.v4.jsonl.zstd"),
    [dshHeader(repo, { id: "d1", depth: 1, parent: "dp", t: min(4) }), dshCall("k1", "pwsh", { command: "npx vitest run" }, { t: min(6) })]);
  return w;
}
