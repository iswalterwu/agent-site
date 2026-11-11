import fs, { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SiteEngine } from "../../src/main/engine";
import { JsonlTail } from "../../src/main/readers/jsonl";
import * as discovery from "../../src/main/discover";
import * as intentCard from "../../src/main/intent-card";
import { activeSite } from "../../src/core/site";
import type { SiteSnapshot, SiteView } from "../../src/core/types";
import { emptyWorld, fourSessionWorld, piFile, type World } from "../fixtures/world";
import { appendJsonl, appendZstd, ccUser, dshHeader, dshUser, min, piAssistant, piHeader, piResult, piUser, writeJsonl } from "../fixtures/logs";
import { mkTmpDir, sleep, waitFor } from "../harness/wait";
import { git, card, makeRepo } from "../fixtures/repo";
import { defaultSettings } from "../../src/main/settings";

const engines: SiteEngine[] = [];
/** 样例里只有一个工地；直接取它看工人和楼段 */
const view = (s: SiteSnapshot): SiteView => {
  const site = activeSite(s);
  if (site === null) throw new Error("snapshot has no site");
  return site;
};
/** 按工地路径取某个工地（快照里的 key 是规范化后的小写路径，比较用 path） */
const at = (s: SiteSnapshot, path: string): SiteView => {
  const site = s.sites.find(item => item.path === path);
  if (site === undefined) throw new Error(`snapshot has no site ${path}`);
  return site;
};
const allWorkers = (s: SiteSnapshot) => s.sites.flatMap(site => site.workers);
const baseNameOf = (p: string) => path.basename(p);
function engine(w: World, opts: Partial<ConstructorParameters<typeof SiteEngine>[0]> = {}): SiteEngine {
  const e = new SiteEngine({ settings: w.settings, roots: w.roots, now: () => min(10), watch: false, minIntervalMs: 0, ...opts });
  engines.push(e); return e;
}
afterEach(() => { engines.forEach(e => e.stop()); engines.length = 0; vi.restoreAllMocks(); syncBuiltinESMExports(); vi.useRealTimers(); });
function addPi(w: World, id = "p"): string {
  const f = piFile(w.roots.pi, id);
  writeJsonl(f, [piHeader(w.repo, { id, t: min(0) }), piUser("开工", min(1))]); return f;
}

it("初始为空；四种会话各就各位，别处的会话单独成工地，来源数和坏行正确", async () => {
  const w = fourSessionWorld(), e = engine(w);
  expect(e.snapshot().sites).toEqual([]);
  await e.refresh(); const s = e.snapshot();
  expect(view(s).workers.map(w => [w.key, w.level, w.parentKey])).toEqual([
    ["pi:p1", 1, null], ["claude:c1", 1, null], ["claude:c1/a1", 2, "claude:c1"], ["dsh:d1", 2, "dsh:dp"]]);
  expect(view(s).workers[0]).toMatchObject({ location: { kind: "band", feature: "data-layer", floor: "S2" }, status: "waiting", bubble: "可能：要提交吗？" });
  expect(view(s).workers[1].location).toEqual({ kind: "band", feature: "settings", floor: "S2" });
  expect(view(s).workers[2].location).toEqual({ kind: "gate" });
  expect(view(s).workers[3]).toMatchObject({ status: "working" });
  expect(view(s).workers[3].actions.at(-1)).toEqual({ kind: "test", at: min(6), text: "vitest …", outcome: "pending" });
  // 别处的会话（p9）也上工地，只是自己一个矮楼，所以 pi 来源有 2 个会话
  expect([s.sources.pi.sessions, s.sources.claude.sessions, s.sources.claude.badLines, s.sources.dsh.sessions]).toEqual([2, 2, 1, 1]);
  expect(s.sites.filter(site => site.path === w.repo)).toHaveLength(1);
  expect(s.sites.filter(site => site.mini)).toHaveLength(1);
  expect(view(s).bands.map(b => b.feature)).toEqual(["data-layer", "settings"]);
});
it("SITE-1：别处的会话自己成一个工地；分支只为有 cwd 的会话取一次并缓存", async () => {
  const w = emptyWorld(), outside = mkTmpDir();
  writeJsonl(piFile(w.roots.pi, "out"), [piHeader(outside, { id: "out", t: min(0) }), piUser("别处的工作", min(1))]);
  writeJsonl(piFile(w.roots.pi, "in"), [piHeader(w.repo, { id: "in", t: min(0) }), piUser("看一下", min(1))]);
  const seen: string[] = [];
  const e = engine(w, { gitBranch: async (cwd) => { seen.push(cwd); return "settings-work"; } });
  await e.refresh();
  const s = e.snapshot();
  expect(s.sites.map(site => site.path).sort()).toEqual([outside, w.repo].sort());
  expect(at(s, w.repo).workers.map(x => x.key)).toEqual(["pi:in"]);
  expect(at(s, outside).workers.map(x => x.key)).toEqual(["pi:out"]);
  expect(at(s, outside)).toMatchObject({ mini: true, kind: "dir", name: path.basename(outside) });
  expect(seen).toContain(w.repo);
  expect(at(s, w.repo).workers[0].attribution).toMatchObject({ rule: "branch", feature: "settings" });
  const before = seen.length;
  await e.refresh();
  expect(seen.length).toBe(before);
});
it("SITE-2：两个仓库的会话各进各的工地，每个工地只读自己的 specs；当前工地是最近有事件的那个", async () => {
  const w = emptyWorld();
  const other = makeRepo({ git: true, cards: { "other-work": card({ name: "other-work" }) } });
  writeJsonl(piFile(w.roots.pi, "a"), [piHeader(w.repo, { id: "a", t: min(0) }), piUser("看 data-layer", min(1))]);
  writeJsonl(piFile(w.roots.pi, "b"), [piHeader(other, { id: "b", t: min(0) }), piUser("看 other-work", min(6))]);
  const e = engine(w);
  await e.refresh();
  const s = e.snapshot();
  expect(s.sites.map(site => site.path).sort()).toEqual([other, w.repo].sort());
  // 各读各的：仓库 T 只有自己的两张卡，另一个仓库只有 other-work
  expect(at(s, w.repo).bands.map(band => band.feature)).toEqual(["data-layer", "other-work", "settings"].filter(f => f !== "other-work"));
  expect(at(s, other).bands.map(band => band.feature)).toEqual(["other-work"]);
  expect(at(s, other).mini).toBe(false);
  // 最近有事件的是 b（min(6)）
  expect(activeSite(s)?.path).toBe(other);
  // 再让 T 那边动一下，当前工地跟着换
  appendJsonl(piFile(w.roots.pi, "a"), [piAssistant([{ type: "text", text: "看完了" }], { t: min(9) })]);
  await e.refresh();
  expect(activeSite(e.snapshot())?.path).toBe(w.repo);
});
it("SITE-4：仓库里没有意图卡就是矮楼，别处的会话也是矮楼", async () => {
  const w = emptyWorld();
  const bare = makeRepo({ git: true });
  writeJsonl(piFile(w.roots.pi, "bare"), [piHeader(bare, { id: "bare", t: min(0) }), piUser("干活", min(1))]);
  writeJsonl(piFile(w.roots.pi, "loose"), [piHeader(mkTmpDir(), { id: "loose", t: min(0) }), piUser("散步", min(1))]);
  const e = engine(w);
  await e.refresh();
  const s = e.snapshot();
  expect(s.sites.map(site => site.mini)).toEqual([true, true]);
  for (const site of s.sites) {
    // 名字牌是工地名（目录名），一层混凝土矮楼、不盖篷布，工人站在里面
    expect(site.bands.map(band => [band.feature, band.mini, band.tarp])).toEqual([[baseNameOf(site.path), true, null]]);
    expect(site.bands[0].card.slices).toBeNull();
    expect(site.workers).toHaveLength(1);
  }
});
it("SITE-4：有意图卡但没切片的工地不画矮楼，三个 feature 各占一段篷布", async () => {
  const w = emptyWorld();
  const repo = makeRepo({ git: true, cards: {
    alpha: card({ name: "alpha", slices: [] }),
    beta: "# beta：还没拆\n\n## 目标\n\n说明。\n",
    gamma: card({ name: "gamma", slices: [] }),
  } });
  for (const feature of ["alpha", "beta", "gamma"]) {
    const file = path.join(repo, "specs", feature, "spec.md");
    writeJsonl(piFile(w.roots.pi, feature), [
      piHeader(repo, { id: feature, t: min(0) }), piUser("干活", min(1)),
      piAssistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: file } }], { t: min(2) }),
      piResult("t1", "read", { t: min(3) }),
    ]);
  }
  const e = engine(w);
  await e.refresh();
  const site = at(e.snapshot(), repo);
  expect(site.mini).toBe(false);
  expect(site.bands.map(band => [band.feature, band.mini, band.tarp])).toEqual([
    ["alpha", false, "图纸未拆切片"], ["beta", false, "图纸读不出"], ["gamma", false, "图纸未拆切片"]]);
  expect(site.workers.map(worker => worker.location)).toEqual([
    { kind: "band", feature: "alpha", floor: "S1" },
    { kind: "band", feature: "beta", floor: "S1" },
    { kind: "band", feature: "gamma", floor: "S1" },
  ]);
});

it("SITE-2：工地超过 12 个只画最近的 12 个，丢掉的写进诊断", async () => {
  const w = emptyWorld();
  const dirs = Array.from({ length: 13 }, (_, i) => makeRepo({ git: true }));
  dirs.forEach((dir, i) => writeJsonl(piFile(w.roots.pi, `s${i}`), [piHeader(dir, { id: `s${i}`, t: min(0) }), piUser("干活", min(i))]));
  const e = engine(w);
  await e.refresh();
  const s = e.snapshot();
  expect(s.sites).toHaveLength(12);
  // 最久没动静的那个（min(0) 的那个）被丢掉，其余全在
  expect(s.sites.map(site => site.path)).not.toContain(dirs[0]);
  expect(s.sites.map(site => site.path).sort()).toEqual(dirs.slice(1).sort());
  expect(s.diagnostics).toEqual([`工地超过 12 个，按最近活动只画前 12 个：${path.basename(dirs[0])} 没画`]);
  expect(activeSite(s)?.path).toBe(dirs[12]);
});
it("SITE-1：同一个目录先按普通目录认、五分钟后认出是仓库，工地跟着变", async () => {
  const w = emptyWorld();
  const dir = mkTmpDir();
  writeJsonl(piFile(w.roots.pi, "late"), [piHeader(dir, { id: "late", t: min(0) }), piUser("在干", min(1))]);
  let now = min(2);
  // 头两次判成普通目录（比如 git 一时超时），之后才认成仓库
  let calls = 0;
  const e = engine(w, { now: () => now, siteKey: async (cwd) => {
    calls += 1;
    return calls < 2 ? { key: cwd.toLowerCase(), path: cwd, kind: "dir" } : { key: cwd.toLowerCase(), path: cwd, kind: "git" };
  } });
  await e.refresh();
  expect(e.snapshot().sites.map(site => site.kind)).toEqual(["dir"]);
  now += 6 * 60_000;
  await e.refresh();
  expect(e.snapshot().sites.map(site => site.kind)).toEqual(["git"]);
});
it("SITE-4：没有工作目录的会话不进任何工地，诊断里留一条", async () => {
  const w = emptyWorld();
  writeJsonl(piFile(w.roots.pi, "nocwd"), [piHeader("", { id: "nocwd", t: min(0) }), piUser("没有工作目录", min(1))]);
  const e = engine(w);
  await e.refresh();
  expect(e.snapshot().sites).toEqual([]);
  expect(e.snapshot().diagnostics.filter(note => note.includes("没有工作目录"))).toHaveLength(1);
});
it("SITE-2：两个同名目录各自成一个工地，名字加序号区分", async () => {
  const w = emptyWorld();
  const base = mkTmpDir();
  const left = path.join(base, "a", "example"), right = path.join(base, "b", "example");
  mkdirSync(left, { recursive: true }); mkdirSync(right, { recursive: true });
  writeJsonl(piFile(w.roots.pi, "left"), [piHeader(left, { id: "left", t: min(0) }), piUser("左", min(1))]);
  writeJsonl(piFile(w.roots.pi, "right"), [piHeader(right, { id: "right", t: min(0) }), piUser("右", min(2))]);
  const e = engine(w);
  await e.refresh();
  expect(e.snapshot().sites.map(site => [site.path, site.name]).sort()).toEqual([[left, "example"], [right, "example #2"]].sort());
});
it("大于 576KB 的 pi 同时保留头部派工和尾部状态", async () => {
  const w = emptyWorld(), e = engine(w);
  const padding = Array.from({ length: 700 }, (_, i) => piAssistant([{ type: "text", text: `${i} ${"x".repeat(1000)}` }], { t: min(2) }));
  writeJsonl(piFile(w.roots.pi, "big"), [piHeader(w.repo, { id: "big" }), piUser("# settings Review R1：审", min(1)), ...padding,
    piAssistant([{ type: "text", text: "审完了。要签 Gate 2 吗？" }], { t: min(8) })]);
  await e.refresh(); expect(view(e.snapshot()).workers[0]).toMatchObject({ location: { kind: "band", feature: "settings", floor: "S2" },
    status: "waiting", bubble: "可能：要签 Gate 2 吗？", attribution: { rule: "dispatch" } });
});
it("追加增量并在截断后丢掉旧身份、调用和错误计数", async () => {
  const w = emptyWorld(), f = addPi(w), e = engine(w);
  appendJsonl(f, [piAssistant([{ type: "toolCall", id: "c", name: "read", arguments: { path: "a.ts" } }], { t: min(2) }), { type: "alien" }]);
  appendFileSync(f, "{bad\n"); await e.refresh();
  expect(view(e.snapshot()).workers[0]?.status).toBe("working");
  appendJsonl(f, [piResult("c", "read", { t: min(3) }), piAssistant([{ type: "text", text: "看完了。" }], { t: min(4) })]);
  await e.refresh(); expect(view(e.snapshot()).workers[0]).toMatchObject({ status: "waiting", bubble: "可能：看完了。" });
  writeJsonl(f, [piHeader(w.repo, { id: "replacement" }), piUser("重来", min(1))]); await e.refresh();
  expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["pi:replacement"]);
  expect(view(e.snapshot()).workers[0]).toMatchObject({ status: "working", actions: [] });
  expect(e.snapshot().sources.pi).toMatchObject({ sessions: 1, badLines: 0, unknownRecords: 0 });
});
it("目录新增被发现，目录消失不会变成来源错误", async () => {
  const w = emptyWorld(), e = engine(w); await e.refresh(); expect(e.snapshot().sites).toEqual([]);
  addPi(w); await e.refresh(); expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["pi:p"]);
  rmSync(path.join(w.roots.pi, "--x--"), { recursive: true }); await e.refresh();
  expect(e.snapshot().sources.pi.lastError).toBeNull();
});
it("半行头和没有 cwd 的 Claude 在文件变动后从头重试且不重复计数", async () => {
  const w = emptyWorld(), f = piFile(w.roots.pi, "p"), c = path.join(w.roots.claude, "proj", "c.jsonl"), e = engine(w);
  mkdirSync(path.dirname(f)); const header = JSON.stringify(piHeader(w.repo, { id: "p" }));
  writeFileSync(f, header.slice(0, 30)); writeJsonl(c, [{ type: "user", timestamp: new Date(min(2)).toISOString(), message: { content: "earlier" } }]);
  appendFileSync(c, "{bad\n"); await e.refresh(); expect(allWorkers(e.snapshot())).toEqual([]);
  appendFileSync(f, `${header.slice(30)}\n`); appendJsonl(f, [piUser("start", min(1))]);
  appendJsonl(c, [ccUser({ sid: "ignored-id", cwd: w.repo, text: "ready", t: min(3) })]); await e.refresh();
  expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["pi:p", "claude:c"]);
  expect(view(e.snapshot()).workers[1].startedAt).toBe(min(2));
  expect(e.snapshot().sources.claude.badLines).toBe(1); await e.refresh(); expect(e.snapshot().sources.claude.badLines).toBe(1);
});
it("Claude 子会话使用自己的 cwd、时间、深度和每批最后分支", async () => {
  const w = emptyWorld(), e = engine(w), f = path.join(w.roots.claude, "proj", "parent", "subagents", "agent-child.jsonl");
  writeJsonl(f, [ccUser({ sid: "parent", cwd: w.wt, branch: "data-layer-work", text: "hi", t: min(3) }),
    ccUser({ sid: "parent", cwd: w.repo, branch: "settings-work", text: "go", t: min(4) })]);
  writeFileSync(f.replace(/\.jsonl$/, ".meta.json"), '{"spawnDepth":3}');
  await e.refresh(); expect(view(e.snapshot()).workers[0]).toMatchObject({ key: "claude:parent/child", parentKey: "claude:parent", level: 4,
    cwd: w.wt, startedAt: min(3), attribution: { rule: "branch", feature: "settings" } });
  appendJsonl(f, [ccUser({ sid: "parent", cwd: w.repo, branch: "data-layer-next", text: "next", t: min(5) })]);
  await e.refresh(); expect(view(e.snapshot()).workers[0]).toMatchObject({ cwd: w.wt, startedAt: min(3), attribution: { feature: "data-layer" } });
});
it("名为 subagents 的项目里的 Claude 主文件仍是一级会话", async () => {
  const w = emptyWorld(), e = engine(w);
  writeJsonl(path.join(w.roots.claude, "subagents", "main.jsonl"), [ccUser({ sid: "other", cwd: w.repo, text: "go" })]);
  await e.refresh(); expect(view(e.snapshot()).workers[0]).toMatchObject({ key: "claude:main", nativeId: "main", level: 1, parentKey: null });
});
it("Claude sidecar 静态符号链接不能读取日志根外文件或改变子会话层级", async () => {
  const w = emptyWorld(), e = engine(w), f = path.join(w.roots.claude, "proj", "parent", "subagents", "agent-child.jsonl");
  writeJsonl(f, [ccUser({ sid: "parent", cwd: w.repo, text: "go" })]);
  const sidecar = f.replace(/\.jsonl$/, ".meta.json"), external = path.join(mkTmpDir(), "synthetic-meta.json");
  writeFileSync(external, '{"spawnDepth":9}'); fs.symlinkSync(external, sidecar, "file");
  const reads = vi.spyOn(fsPromises, "readFile");
  syncBuiltinESMExports();
  await e.refresh();
  expect.soft(view(e.snapshot()).workers[0]).toMatchObject({ key: "claude:parent/child", level: 2 });
  expect.soft(e.snapshot().sources.claude.lastError).toBeNull();
  expect(reads.mock.calls.map(args => String(args[0]))).not.toContain(sidecar);
  expect(reads.mock.calls.map(args => String(args[0]))).not.toContain(external);
});
it.each(["regular", "missing", "malformed", "directory", "dangling-link"] as const)("Claude sidecar %s 按普通文件或无 metadata 处理", async kind => {
  const w = emptyWorld(), e = engine(w), f = path.join(w.roots.claude, "proj", "parent", "subagents", "agent-child.jsonl");
  writeJsonl(f, [ccUser({ sid: "parent", cwd: w.repo, text: "go" })]);
  const sidecar = f.replace(/\.jsonl$/, ".meta.json");
  if (kind === "regular") writeFileSync(sidecar, '{"spawnDepth":3}');
  if (kind === "malformed") writeFileSync(sidecar, "{bad");
  if (kind === "directory") mkdirSync(sidecar);
  if (kind === "dangling-link") fs.symlinkSync(path.join(mkTmpDir(), "missing.json"), sidecar, "file");
  await e.refresh();
  expect(view(e.snapshot()).workers[0]).toMatchObject({ key: "claude:parent/child", level: kind === "regular" ? 4 : 2 });
  expect(e.snapshot().sources.claude.lastError).toBeNull();
});
it.each(["lstat", "readFile"] as const)("Claude sidecar 的 %s 非 ENOENT 失败仍隔离并可重试", async method => {
  const w = emptyWorld(), e = engine(w), f = path.join(w.roots.claude, "proj", "parent", "subagents", "agent-child.jsonl");
  addPi(w); writeJsonl(f, [ccUser({ sid: "parent", cwd: w.repo, text: "go" })]);
  const sidecar = f.replace(/\.jsonl$/, ".meta.json"); writeFileSync(sidecar, '{"spawnDepth":3}');
  const real = fsPromises[method];
  const failure = vi.spyOn(fsPromises, method).mockImplementation((async (...args: unknown[]) => {
    if (String(args[0]) === sidecar) throw Object.assign(new Error("synthetic sidecar access denied"), { code: "EACCES" });
    return Reflect.apply(real, fsPromises, args);
  }) as typeof real);
  syncBuiltinESMExports();
  await e.refresh();
  expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["pi:p"]);
  expect(e.snapshot().sources.claude.lastError).toBe("synthetic sidecar access denied");
  failure.mockRestore(); syncBuiltinESMExports(); await e.refresh();
  expect(view(e.snapshot()).workers.find(w => w.key === "claude:parent/child")?.level).toBe(4);
  expect(e.snapshot().sources.claude.lastError).toBeNull();
});
it("pi 和 DSH 的当前分支按 cwd 共用 60 秒缓存，过期追加时重新查询", async () => {
  const w = emptyWorld(); git(w.repo, "checkout", "-b", "settings-active");
  const f = addPi(w), d = path.join(w.roots.dsh, "proj", "d", "session.v4.jsonl.zstd");
  appendZstd(d, [dshHeader(w.repo, { id: "d" }), dshUser("go")]);
  let now = min(2); const e = engine(w, { now: () => now }); await e.refresh();
  expect(view(e.snapshot()).workers.map(w => w.attribution)).toEqual([
    expect.objectContaining({ feature: "settings", rule: "branch" }), expect.objectContaining({ feature: "settings", rule: "branch" })]);
  git(w.repo, "checkout", "-b", "data-layer-active"); now += 59_999;
  appendJsonl(f, [piUser("still cached", now)]); appendZstd(d, [dshUser("still cached", { t: now })]); await e.refresh();
  expect(view(e.snapshot()).workers.every(w => "feature" in w.attribution && w.attribution.feature === "settings")).toBe(true);
  now += 1; appendJsonl(f, [piUser("expiry", now)]); appendZstd(d, [dshUser("expiry", { t: now })]); await e.refresh();
  expect(view(e.snapshot()).workers.map(w => w.attribution)).toEqual([
    expect.objectContaining({ feature: "data-layer", rule: "branch" }), expect.objectContaining({ feature: "data-layer", rule: "branch" })]);
});
it("SITE-6：会话文件没了之后它的状态跟着清掉，来源统计归零", async () => {
  const w = emptyWorld(), f = addPi(w);
  const e = engine(w, { now: () => min(10) }); await e.refresh();
  expect(e.snapshot().sources.pi.sessions).toBe(1);
  fs.rmSync(f);
  await e.refresh();
  expect(e.snapshot().sources.pi.sessions).toBe(0);
  expect(e.snapshot().sites).toEqual([]);
  // 同一个路径又出现文件：当成新会话重新读进来
  appendJsonl(f, [piHeader(w.repo, { id: "p", t: min(11) }), piUser("又开工了", min(11))]);
  await e.refresh();
  expect(e.snapshot().sources.pi.sessions).toBe(1);
  expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["pi:p"]);
});
it("SITE-6：窗口期外但文件还在的会话保留状态——重新读只看头尾两段，中间那段恢复不出来", async () => {
  const w = emptyWorld(), f = addPi(w);
  appendJsonl(f, [piAssistant([{ type: "text", text: "开工" }], { model: "head-model", t: min(2) })]);
  let now = min(10); const e = engine(w, { now: () => now }); await e.refresh();
  expect(view(e.snapshot()).workers[0]?.model).toBe("head-model");
  // 先把切换模型放到头部 64 KB 之外，增量读能读到它
  appendJsonl(f, [
    ...Array.from({ length: 1000 }, (_, i) => piUser("填充".repeat(40) + i, min(2))),
    piAssistant([{ type: "text", text: "中段" }], { model: "mid-model", t: min(3) }), piUser("后面还有", min(4))]);
  now = min(11); await e.refresh();
  expect(view(e.snapshot()).workers[0]?.model).toBe("mid-model");
  // 再在尾巴上堆一大段，让 mid-model 落到"头尾两段都够不着"的位置：这时重新读出来的只会是 head-model
  appendJsonl(f, Array.from({ length: 3000 }, (_, i) => piUser("尾巴".repeat(40) + i, min(5))));
  now = min(12); await e.refresh();
  // 对照：此刻从零开始读这个文件只能看到头尾两段，中段的 mid-model 读不到
  const cold = engine(w, { now: () => now }); await cold.refresh();
  expect(view(cold.snapshot()).workers[0]?.model).toBe("head-model");
  expect(view(e.snapshot()).workers[0]?.model).toBe("mid-model"); // 增量读到的还留着
  // 过窗口期、文件不再被改：状态仍然留着（要是丢了，重新读只能看到头尾，模型会退回 head-model）
  now = min(30 * 60); fs.utimesSync(f, min(1) / 1000, min(1) / 1000);
  await e.refresh();
  expect((e as unknown as { trackers: Map<string, unknown> }).trackers.size).toBe(1);
  appendJsonl(f, [piUser("又来了", now)]);
  await e.refresh();
  expect(view(e.snapshot()).workers[0]?.model).toBe("mid-model");
});
it("SITE-6：键缓存闲置一小时就清掉，同一个 cwd 再来会话时重新认一次", async () => {
  // 会话不在 settings.repos 里，才走"按 cwd 认工地"这条会缓存的路径
  const w = emptyWorld(), elsewhere = mkTmpDir(), f = piFile(w.roots.pi, "x");
  const write = (id: string, at: number): void => writeJsonl(f, [piHeader(elsewhere, { id, t: at }), piUser("开工", at)]);
  write("x", min(1));
  let now = min(10), asked = 0;
  const e = engine(w, { now: () => now, siteKey: async (cwd) => { asked += 1; return { key: cwd.toLowerCase(), path: cwd, kind: "git" }; } });
  await e.refresh();
  expect(asked).toBe(1);
  // 59 分钟时又来了一个同一目录的会话：命中缓存，这次命中把"最后使用"续上
  now = min(10 + 59); const g = piFile(w.roots.pi, "y");
  writeJsonl(g, [piHeader(elsewhere, { id: "y", t: now }), piUser("开工", now)]);
  await e.refresh();
  expect(asked).toBe(1);
  // 中间空转几轮：离第一次算已经 90 分钟，但离最后使用只有 31 分钟，缓存还得在
  now = min(10 + 90); await e.refresh();
  expect(asked).toBe(1);
  // 再过 30 分钟（离第一次算 120 分钟）：仍然命中，不重新问
  now = min(10 + 110); const h = piFile(w.roots.pi, "z");
  writeJsonl(h, [piHeader(elsewhere, { id: "z", t: now }), piUser("开工", now)]);
  await e.refresh();
  expect(asked).toBe(1);
  // 离最后使用（120 分钟那个点）满一小时：空转的一轮把它清掉，之后再来同一个目录的会话要重新问
  now = min(10 + 172); await e.refresh();
  const k = piFile(w.roots.pi, "w");
  writeJsonl(k, [piHeader(elsewhere, { id: "w", t: now }), piUser("开工", now)]);
  await e.refresh();
  expect(asked).toBe(2);
});
it("SITE-6：分支缓存也是闲置一小时才清：会话没了之后先是保留，满了才删", async () => {
  const w = emptyWorld(), f = addPi(w);
  let now = min(10), asked = 0;
  const e = engine(w, { now: () => now, gitBranch: async () => { asked += 1; return "main"; } });
  await e.refresh();
  const branches = (): Map<string, unknown> => (e as unknown as { branches: Map<string, unknown> }).branches;
  expect(asked).toBe(1);
  expect(branches().size).toBe(1);
  // 会话文件没了：之后不会再问 git，缓存按"最后使用"算
  fs.rmSync(f); await e.refresh();
  now = min(10 + 30); await e.refresh();
  expect(branches().size).toBe(1);
  now = min(10 + 61); await e.refresh();
  expect(branches().size).toBe(0);
  expect(asked).toBe(1); // 中间一直没有重问
});
it("SITE-6：工地从快照里消失后，它的 specs 缓存也跟着清掉；回来时重新读", async () => {
  const w = emptyWorld(); const f = addPi(w);
  let now = min(10);
  const read = vi.spyOn(intentCard, "readFeatures");
  const e = engine(w, { now: () => now }); await e.refresh();
  expect(read).toHaveBeenCalledTimes(1);
  await e.refresh();
  expect(read).toHaveBeenCalledTimes(1); // 指纹没变：用缓存
  // 窗口期外：工地和它的 specs 缓存一起没了
  now = min(10 + 25 * 60); fs.utimesSync(f, min(1) / 1000, min(1) / 1000);
  await e.refresh();
  expect(e.snapshot().sites).toEqual([]);
  await e.refresh(); // 清 specs 缓存用的是上一轮快照，晚一轮才看到工地没了
  expect((e as unknown as { featureCache: Map<string, unknown> }).featureCache.size).toBe(0);
  // 又追加了新东西：重新发现、重新读一次 specs
  appendJsonl(f, [piUser("又开工了", now)]);
  await e.refresh();
  expect(e.snapshot().sites).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(2);
});
it("每种来源只把 null 转换结果计为未知，已知空记录不计，坏 JSON 单独计", async () => {
  const w = emptyWorld(), e = engine(w), p = addPi(w);
  appendJsonl(p, [{ type: "custom" }, { type: "alien" }]); appendFileSync(p, "{bad\n");
  const c = path.join(w.roots.claude, "proj", "c.jsonl");
  writeJsonl(c, [ccUser({ sid: "c", cwd: w.repo, text: "hi" }), { type: "progress" }, {}]); appendFileSync(c, "{bad\n");
  appendZstd(path.join(w.roots.dsh, "proj", "d", "session.v4.jsonl.zstd"), [dshHeader(w.repo), dshUser("hi"), { type: "turn/start" }, { type: "alien" }]);
  await e.refresh(); await e.refresh();
  expect([e.snapshot().sources.pi, e.snapshot().sources.claude, e.snapshot().sources.dsh].map(s => [s.badLines, s.unknownRecords])).toEqual([[1, 1], [1, 1], [0, 1]]);
});
it("来源发现失败隔离：坏 pi 根不阻塞 Claude 和 DSH", async () => {
  const w = fourSessionWorld(); w.roots.pi = path.join(w.repo, "bad-root"); writeFileSync(w.roots.pi, "not a directory");
  const e = engine(w); await e.refresh();
  expect(e.snapshot().sources.pi.lastError).toEqual(expect.any(String));
  expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["claude:c1", "claude:c1/a1", "dsh:d1"]);
});
it("坏压缩文件隔离同来源和其他来源的好文件", async () => {
  const w = fourSessionWorld(), f = path.join(w.roots.dsh, "proj", "broken", "session.v4.jsonl.zstd");
  mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, "broken-frame"); const e = engine(w); await e.refresh();
  expect(e.snapshot().sources.dsh.lastError).toEqual(expect.any(String)); expect(view(e.snapshot()).workers).toHaveLength(4);
});
it("读取失败不提交 fingerprint，原样文件下一轮仍能读到", async () => {
  const w = emptyWorld(); addPi(w); const e = engine(w);
  vi.spyOn(JsonlTail.prototype, "read").mockRejectedValueOnce(new Error("locked"));
  await e.refresh(); expect(e.snapshot().sources.pi.lastError).toContain("locked"); expect(allWorkers(e.snapshot())).toEqual([]);
  await e.refresh(); expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["pi:p"]);
});
it("不变文件不重读；新会话文件出现就认出来，cwd 变了就换工地", async () => {
  const w = emptyWorld(), f = addPi(w), e = engine(w); await e.refresh();
  const read = vi.spyOn(JsonlTail.prototype, "read").mockRejectedValue(new Error("unexpected read"));
  await e.refresh(); expect(e.snapshot().sources.pi.lastError).toBeNull(); read.mockRestore();
  const other = piFile(w.roots.pi, "other"), elsewhere = mkTmpDir();
  writeJsonl(other, [piHeader(elsewhere, { id: "other" })]); await e.refresh();
  expect(at(e.snapshot(), elsewhere).workers.map(w => w.key)).toEqual(["pi:other"]);
  expect(at(e.snapshot(), w.repo).workers.map(w => w.key)).toEqual(["pi:p"]);
  // 新开一个在仓库里干的会话：它出现在仓库那个工地，别处那个仍在自己的矮楼里
  const moved = piFile(w.roots.pi, "other2");
  writeJsonl(moved, [piHeader(w.repo, { id: "other2" }), piUser("new", min(2))]);
  await e.refresh();
  expect(at(e.snapshot(), w.repo).workers.map(w => w.key).sort()).toEqual(["pi:other2", "pi:p"]);
  expect(at(e.snapshot(), elsewhere).workers.map(w => w.key)).toEqual(["pi:other"]);
  expect(fs.statSync(f).size).toBeGreaterThan(0);
});
it("refresh 串行排队，前一轮拒绝不会毒化后一轮", async () => {
  const w = emptyWorld(); addPi(w); const e = engine(w), real = discovery.discover;
  let release!: () => void, entered = false;
  vi.spyOn(discovery, "discover").mockImplementationOnce(async (...args) => { entered = true; await new Promise<void>(r => { release = r; }); return real(...args); });
  const first = e.refresh(); await expect(waitFor(() => entered)).resolves.toBeUndefined();
  let secondDone = false; const second = e.refresh().then(() => { secondDone = true; }); await sleep(20);
  expect(secondDone).toBe(false); release(); await Promise.all([first, second]); expect(view(e.snapshot()).workers).toHaveLength(1);
  vi.spyOn(intentCard, "featuresStamp").mockRejectedValueOnce(new Error("round failed"));
  const failed = e.refresh(), recovered = e.refresh(); await expect(failed).rejects.toThrow("round failed"); await recovered;
  expect(view(e.snapshot()).workers.map(w => w.key)).toEqual(["pi:p"]);
});
it("推送忽略 at；取消订阅生效，配置诊断按顺序进入安全展示边界", async () => {
  const w = emptyWorld(), f = addPi(w); let now = min(2); const e = engine(w, { now: () => now, diagnostics: ["first", "Bearer secret-value", "last"] });
  const got: SiteSnapshot[] = [], off = e.onSnapshot(s => got.push(s)); await e.refresh(); now += 1; await e.refresh();
  expect(got).toHaveLength(1); expect(e.snapshot().at).toBe(now); expect(e.snapshot().diagnostics).toEqual(["first", "Bearer ***", "last"]);
  appendJsonl(f, [piAssistant([{ type: "text", text: "完成。" }], { t: min(2) })]); await e.refresh(); expect(got).toHaveLength(2);
  off(); appendJsonl(f, [piUser("again", min(3))]); await e.refresh(); expect(got).toHaveLength(2);
});
it("节流只在最短间隔后推送最新内容，A→B→A 不推送", async () => {
  const w = emptyWorld(); addPi(w); let now = min(2); const e = engine(w, { now: () => now, minIntervalMs: 250 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); const got: SiteSnapshot[] = []; e.onSnapshot(s => got.push(s));
  // 改 features 配置就能改快照内容：整栋楼的材质跟着变
  const material = (m: "brick" | "metal") => { w.settings.features = [{ name: "data-layer", placement: "band", materials: [{ material: m, share: 100 }] }]; };
  const shown = () => got.map(s => view(s).bands[0]?.materials[0]?.material ?? null);
  await e.refresh(); expect(got).toHaveLength(1);
  material("metal"); now += 100; await e.refresh();
  material("brick"); now += 50; await e.refresh(); expect(got).toHaveLength(1);
  now += 99; await vi.advanceTimersByTimeAsync(149); expect(got).toHaveLength(1);
  now += 1; await vi.advanceTimersByTimeAsync(1); expect(shown()).toEqual(["brick", "brick"]);
  material("metal"); now += 10; await e.refresh();
  material("brick"); now += 10; await e.refresh(); now += 250; await vi.advanceTimersByTimeAsync(250);
  expect(shown()).toEqual(["brick", "brick"]);
});
it.each([[true, 2000, 3000], [false, 200, 1000]] as const)("追加后及时刷新 watch=%s", async (watch, pollMs, within) => {
  const w = emptyWorld(), f = piFile(w.roots.pi, "live"), t = Date.now();
  writeJsonl(f, [piHeader(w.repo, { id: "live", t }), piUser("go", t)]);
  const e = engine(w, { now: Date.now, watch, pollMs, minIntervalMs: 250 }), got: SiteSnapshot[] = []; e.onSnapshot(s => got.push(s));
  await e.start(); appendJsonl(f, [piAssistant([{ type: "text", text: "完成。" }], { t: Date.now() })]);
  await expect(waitFor(() => { const last = got.at(-1); return last !== undefined && activeSite(last)?.workers[0]?.status === "waiting"; }, within)).resolves.toBeUndefined();
});
it("watch 在轮询之前发现日志与意图卡的变化，错误后轮询继续", async () => {
  const w = emptyWorld(), f = addPi(w), watchers: fs.FSWatcher[] = [], real = fs.watch;
  vi.spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
    const watcher = real(...args); watchers.push(watcher); return watcher;
  }) as typeof fs.watch);
  const e = engine(w, { watch: true, pollMs: 1200 }); await e.start();
  appendJsonl(f, [piAssistant([{ type: "text", text: "watched" }], { t: min(3) })]);
  await expect(waitFor(() => view(e.snapshot()).workers[0]?.status === "waiting", 1000)).resolves.toBeUndefined();
  writeFileSync(path.join(w.repo, "specs", "settings", "spec.md"), card({ name: "settings", slices: ["- S1：一刀 ✓"] }));
  await expect(waitFor(() => view(e.snapshot()).bands.find(b => b.feature === "settings")?.card.status === "done", 1000)).resolves.toBeUndefined();
  for (const watcher of watchers) watcher.emit("error", new Error("watch failed"));
  appendJsonl(f, [piUser("poll fallback", min(4))]);
  await expect(waitFor(() => view(e.snapshot()).workers[0]?.status === "working", 2000)).resolves.toBeUndefined();
});
it("stop 清除 watcher、轮询、去抖和待推送，start 未完成时 stop 也有效", async () => {
  const w = emptyWorld(), f = addPi(w), e = engine(w, { watch: true, pollMs: 50, minIntervalMs: 1000 });
  const got: SiteSnapshot[] = []; e.onSnapshot(s => got.push(s)); await e.start();
  appendJsonl(f, [piAssistant([{ type: "text", text: "done" }], { t: min(2) })]); await e.refresh();
  e.stop(); const before = e.snapshot(); appendJsonl(f, [piUser("after stop", min(3))]); await sleep(1150);
  expect(got).toHaveLength(1); expect(e.snapshot()).toBe(before);
  const e2 = engine(w, { watch: true, pollMs: 20 }); const starting = e2.start(); e2.stop(); await starting;
  const after = e2.snapshot(); appendJsonl(f, [piUser("later", min(4))]); await sleep(200); expect(e2.snapshot()).toBe(after);
});

it("WINDOW-29：待做池跟意图卡同一份缓存——文件没变就不重读，mtime 变了才重读", async () => {
  const w = emptyWorld(), f = addPi(w);
  const dir = path.join(w.repo, "specs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "backlog.md");
  writeFileSync(file, "- 第一条\n");
  // 固定一个能精确往返的 mtime：后面要靠"mtime 不变"来证明缓存命中
  utimesSync(file, 1_700_000_000, 1_700_000_000);
  const stamp = statSync(file).mtimeMs;
  const e = engine(w, { now: () => min(3) });
  await e.refresh();
  expect(view(e.snapshot()).backlog).toEqual(["第一条"]);
  // 同样大小、mtime 也拨回去：指纹没变，缓存照旧（不重读）
  writeFileSync(file, "- 第二条\n");
  utimesSync(file, stamp / 1000, stamp / 1000);
  await e.refresh();
  expect(view(e.snapshot()).backlog).toEqual(["第一条"]);
  // mtime 变了：重读
  utimesSync(file, stamp / 1000 + 5, stamp / 1000 + 5);
  await e.refresh();
  expect(view(e.snapshot()).backlog).toEqual(["第二条"]);
  void f;
});

// CONTROL-12：桥接的 site_todo 结果写进会话日志后，App 从 details.todos 出待办楼段
it("CONTROL-12：site_todo 的结果进日志后按待办出楼段", async () => {
  const repo = makeRepo({ git: true });
  const w: World = { repo, wt: repo, roots: { pi: mkTmpDir(), claude: mkTmpDir(), dsh: mkTmpDir() },
    settings: { ...defaultSettings(), repos: [{ path: repo, name: "T" }], features: [] } };
  const todos = [{ text: "读图纸", status: "completed" }, { text: "砌墙", status: "in_progress" }];
  const result = piResult("t1", "site_todo", { t: min(2) });
  (result.message as Record<string, unknown>).details = { todos };
  // 后面这条的 status 不合法，真实 pi 会挡在工具外；它的 toolCall 原文仍然进日志，不能改待办
  const rejected = piAssistant([{ type: "toolCall", id: "t2", name: "site_todo",
    arguments: { todos: [{ text: "被拒", status: "doing" }] } }], { t: min(3) });
  writeJsonl(piFile(w.roots.pi, "todo"), [
    piHeader(repo, { id: "todo", t: min(0) }), piUser("开工", min(1)),
    piAssistant([{ type: "toolCall", id: "t1", name: "site_todo", arguments: { todos } }], { t: min(1) }), result,
    rejected,
  ]);
  const e = engine(w);
  await e.refresh();
  const site = at(e.snapshot(), repo);
  expect(site.mini).toBe(false);
  expect(site.bands.map(band => [band.feature, band.card.source, band.card.slices, band.plan?.floors.map(floor => floor.kind)]))
    .toEqual([["开工", "todos", { total: 2, done: 1 }, ["built", "progress"]]]);
});
