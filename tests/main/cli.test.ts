import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { SiteSnapshot } from "../../src/core/types";
import { card, makeRepo } from "../fixtures/repo";
import { piHeader, piUser, writeJsonl } from "../fixtures/logs";
import { mkTmpDir } from "../harness/wait";

it("快照 CLI 只读临时 home 与明确指定的临时 repo，stdout 只有 JSON", () => {
  expect(existsSync("src/main/snapshot-cli.ts")).toBe(true);
  const home = mkTmpDir(), data = mkTmpDir(), temp = mkTmpDir(), t = Date.now();
  const repo = makeRepo({ git: true, cards: { "data-layer": card({ name: "data-layer" }) } });
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ repos: [{ path: repo, name: "T" }], extraPathRules: [] }));
  writeJsonl(path.join(home, ".pi", "agent", "sessions", "--x--", "s.jsonl"), [piHeader(repo, { id: "p5", t }), piUser("开工", t)]);
  const env = { ...process.env, USERPROFILE: home, HOME: home, AGENT_SITE_HOME: data, APPDATA: data, TMP: temp, TEMP: temp };
  const out = execFileSync(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm run -s snapshot"] : ["run", "-s", "snapshot"], { env, encoding: "utf8" });
  const snap = JSON.parse(out) as SiteSnapshot;
  expect(snap.sites.map(site => site.name)).toEqual(["T"]); expect(snap.sites[0].bands.map(b => b.feature)).toEqual(["data-layer"]);
  expect(snap.sites[0].workers.map(w => w.key)).toEqual(["pi:p5"]); expect(snap.sources.claude.present).toBe(false);
});
