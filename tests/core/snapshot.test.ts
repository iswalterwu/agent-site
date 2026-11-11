import { expect, it } from "vitest";
import { applyEvents, newSession } from "../../src/core/session";
import { DEFAULT_THRESHOLDS } from "../../src/core/status";
import type { FeatureInput, Harness, IntentCard, SiteConfig, SiteEvent, Slice, SourceStatus } from "../../src/core/types";
import { buildSnapshot } from "../../src/core/snapshot";
import { siteOf, snapshotOf } from "../harness/site";
import { activeSite } from "../../src/core/site";
import type { SiteSnapshot, SiteView, SessionState, FeatureInput as FeatureInputT } from "../../src/core/types";
import { bandCard } from "../../src/core/building";
const min = (n: number) => n * 60_000;
const NOW = min(30);
const cfg: SiteConfig = { thresholds: DEFAULT_THRESHOLDS, style: "tower", pins: {}, features: [
  { name: "data-layer", placement: "band", materials: [{ material: "brick", share: 100 }] },
  { name: "settings", placement: "band", materials: [{ material: "brick", share: 60 }, { material: "metal", share: 40 }] },
  { name: "desktop-shell", placement: "crown", materials: [{ material: "metal", share: 100 }] },
  { name: "dev-harness", placement: "office", materials: [] }] };
const step = (done: boolean) => ({ text: "步", done });
const slice = (id: string, o: Partial<Slice> = {}): Slice => ({ id, title: `切片 ${id}`, done: false, current: false, steps: [], ...o });
const card = (o: Partial<IntentCard> = {}): IntentCard => ({ title: "T", risk: "低", ac: 2, open: 1, openItems: [], slices: [], ...o });
const feat = (name: string, c: IntentCard | "unreadable"): FeatureInput => ({
  name, specsDir: `D:/r/specs/${name}`, ...(c === "unreadable" ? { error: "unreadable" as const } : { card: c }) });
const session = (key: string, level: number, events: SiteEvent[], harness: Harness = "pi") => applyEvents(newSession({
  key, harness, nativeId: key.split(":")[1], file: `${key}.jsonl`, cwd: "D:/r", startedAt: events[0].ts, level }), events);
const source = (root: string): SourceStatus => ({ root, present: true, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null });
const SOURCES = { pi: source("P"), claude: source("C"), dsh: source("D") };
const FEATURES = [
  feat("agent-dock", card({ slices: [slice("S1", { done: true }), slice("S2", { current: true, steps: [step(true), step(false)] }), slice("S3")] })),
  feat("data-layer", card({ slices: [slice("S1", { done: true }), slice("S2", { done: true })] })),
  feat("desktop-shell", "unreadable"),
  feat("dev-harness", card({ slices: [slice("S1", { done: true })] })),
  feat("empty-card", card()),
];
const s1 = session("pi:s1", 1, [{ kind: "prompt", ts: min(0), text: "# data-layer Plan R1：写计划\n- 你是协调者", from: "user" },
  { kind: "text", ts: min(5), text: "计划写好了。要我提交吗？" }, { kind: "turn_end", ts: min(5) }]);
const s2 = session("claude:s2", 2, [{ kind: "tool_call", ts: min(25), id: "r", call: { tool: "Read", op: "read", paths: ["src/x.ts"] } }], "claude");
const s3 = session("pi:s3", 1, [{ kind: "text", ts: NOW - 25 * 3_600_000, text: "很久以前" }]);
const s4 = session("pi:s4", 1, [{ kind: "text", ts: min(29), text: "密钥是 sk-abcdefgh12345678 别外传" }]);
const snapshot = snapshotOf({ now: NOW, repo: { path: "D:/r", name: "R" }, features: FEATURES, sessions: [s1, s2, s3, s4],
  config: cfg, sources: SOURCES, diagnostics: [] });
const snap = activeSite(snapshot)!;

it("楼段顺序：配置顺序 → 未归类叠在上面 → 穹顶最后；办公室单列", () => {
  expect(snap.bands.map((b) => [b.feature, b.placement, b.configured])).toEqual([
    ["data-layer", "band", true], ["agent-dock", "band", false], ["empty-card", "band", false], ["desktop-shell", "crown", true]]);
  expect(snap.bands[1].materials).toEqual([{ material: "concrete", share: 100 }]);
  expect(snap.office.map((o) => o.feature)).toEqual(["dev-harness"]);
  expect(snapshot.diagnostics).toEqual([
    "feature agent-dock 不在 settings.json 的 features 里，先按未归类画在最上面",
    "feature empty-card 不在 settings.json 的 features 里，先按未归类画在最上面"]);
});
it("小人：按派工抬头定位、角色、可能在等你；超过时限的不上工地", () => {
  expect(snap.workers.map((w) => w.key)).toEqual(["pi:s1", "claude:s2", "pi:s4"]);
  expect(snap.workers[0]).toMatchObject({ location: { kind: "band", feature: "data-layer", floor: "S2" }, role: "foreman",
    roleReason: "dispatch", status: "waiting", statusSince: min(5), bubble: "可能：要我提交吗？", statusDetail: "计划写好了。要我提交吗？",
    readOnly: true, lastUserAt: min(0) });
  expect(snap.workers[1]).toMatchObject({ location: { kind: "gate" }, status: "working", role: "worker", lastUserAt: null, parentKey: null });
  expect(snap.workers[1].statusDetail).toBe("最近：看 x.ts");
});
it("显示前脱敏", () => {
  expect(snap.workers[2].bubble).toBe("密钥是 sk-*** 别外传");
  expect(JSON.stringify(snapshot)).not.toContain("abcdefgh12345678");
});
it("脚手架、篷布与彩带", () => {
  const [dl, ad, em, ds] = snap.bands;
  expect([dl.scaffold, dl.ribbon]).toEqual([["S2"], "orange"]);
  expect([ad.scaffold, ad.ribbon, ad.card.status]).toEqual([["S2"], "grey", "in-progress"]);
  expect([em.plan, em.tarp, em.scaffold, em.card.slices]).toEqual([null, "图纸未拆切片", [], { total: 0, done: 0 }]);
  expect([ds.plan, ds.tarp, ds.card.title, ds.card.status, ds.scaffold]).toEqual([null, "图纸读不出", null, null, []]);
});
it("等你清单：回合结束的等待", () => {
  expect(snap.designer.waiting).toEqual([{ kind: "turn_end", key: "pi:s1", since: min(5), text: "可能：要我提交吗？" }]);
});
it("历史分组", () => {
  const old = session("pi:old", 1, [{ kind: "text", ts: min(0), text: "好了。" }, { kind: "turn_end", ts: min(0) }]);
  const s = siteOf({ now: min(0) + 25 * 3_600_000, repo: { path: "D:/r", name: "R" }, features: [feat("data-layer", card())], sessions: [old],
    config: { ...cfg, thresholds: { ...DEFAULT_THRESHOLDS, onsiteHours: 48 } }, sources: SOURCES, diagnostics: [] });
  expect(s.designer.waiting).toEqual([{ kind: "history", key: "pi:old", since: min(0), text: "可能：好了。" }]);
  expect(s.workers[0].status).toBe("waiting");   // 上工地时限 48 小时，人还在
});
it("SITE-2：两个工地各自成楼，当前工地认快照里指定的那个，指定的没了退回第一个", () => {
  const a = { key: "D:/a", path: "D:/a", name: "a", kind: "git" as const, mini: false, features: [FEATURES[1]], backlog: [], sessions: [s1] };
  const b = { key: "D:/b", path: "D:/b", name: "b", kind: "dir" as const, mini: true, features: [], backlog: [], sessions: [s2] };
  const two = buildSnapshot({ now: NOW, sites: [a, b], active: "D:/b", config: cfg, sources: SOURCES, diagnostics: [] });
  expect(two.sites.map((site) => [site.key, site.name, site.bands.length])).toEqual([["D:/a", "a", 1], ["D:/b", "b", 1]]);
  expect(activeSite(two)?.key).toBe("D:/b");
  // 工地的工人只出现在自己的楼里
  expect(two.sites[0].workers.map((w) => w.key)).toEqual(["pi:s1"]);
  expect(two.sites[1].workers.map((w) => w.key)).toEqual(["claude:s2"]);
  const gone = buildSnapshot({ now: NOW, sites: [a, b], active: "D:/z", config: cfg, sources: SOURCES, diagnostics: [] });
  expect(activeSite(gone)?.key).toBe("D:/a");
  const empty = buildSnapshot({ now: NOW, sites: [], active: null, config: cfg, sources: SOURCES, diagnostics: [] });
  expect([empty.sites, empty.active, activeSite(empty)]).toEqual([[], null, null]);
});
it("SITE-4：没有意图卡的工地是一层混凝土矮楼，卡片里没有任何数字", () => {
  const site = siteOf({ now: NOW, repo: { path: "D:/work/example", name: "example" }, features: [], backlog: [], sessions: [s1],
    config: cfg, sources: SOURCES, diagnostics: [], mini: true });
  expect([site.mini, site.bands.length]).toEqual([true, 1]);
  expect(site.bands[0]).toMatchObject({ feature: "example", placement: "band", mini: true, tarp: null,
    plan: { floors: [{ id: "S1", kind: "built" }] },
    materials: [{ material: "concrete", share: 100 }], card: { title: null, risk: null, ac: null, open: null, slices: null, current: null, status: null } });
  expect(site.bands[0].card.specsDir).toBe("D:/work/example");
  // 工人站在矮楼里，气泡照常；矮楼不搭脚手架
  expect(site.workers.map((w) => [w.key, w.location])).toEqual([["pi:s1", { kind: "band", feature: "example", floor: "S1" }]]);
  expect(site.bands[0].scaffold).toEqual([]);
  // 矮楼不因为"没有意图卡"再报一条未配置提示
  expect(snapshotOf({ now: NOW, repo: { path: "D:/work/example", name: "example" }, features: [], backlog: [], sessions: [s1],
    config: cfg, sources: SOURCES, diagnostics: [], mini: true }).diagnostics).toEqual([]);
});
it("快照里没有旧模型字段", () => {
  const band = snap.bands[0];
  expect(Object.keys(band)).toEqual(["feature", "placement", "materials", "configured", "style", "stage", "plan", "tarp", "scaffold", "ribbon", "card", "mini"]);
  expect(Object.keys(band.card)).toEqual(["title", "risk", "ac", "open", "openItems", "slices", "current", "status", "source", "specsDir"]);
  for (const key of ["stateFile", "gate", "tasks", "review"]) {
    expect(band).not.toHaveProperty(key);
    expect(band.card).not.toHaveProperty(key);
  }
  expect(JSON.stringify(snap)).not.toMatch(/"stateFile"|"gate1"|"gate2"|"reviewRounds"|"tape"/);
});
it("楼段卡：标题、风险、验收例子数、待定数、切片与当前步骤进度（A4）", () => {
  expect(snap.bands[1].card).toEqual({ title: "T", risk: "低", ac: 2, open: 1, openItems: [], slices: { total: 3, done: 1 },
    current: { id: "S2", title: "切片 S2", stepsDone: 1, stepsTotal: 2 }, status: "in-progress", source: "card", specsDir: "D:/r/specs/agent-dock" });
  expect(bandCard(feat("x", card({ slices: [slice("S1", { done: true })] }))).status).toBe("done");
});
it("保留截断前的最近测试失败，后续通过或未完成则清除", () => {
  const test = (id: string, ts: number): SiteEvent => ({ kind: "tool_call", ts, id, call: { tool: "bash", op: "shell", paths: [], command: "npx vitest run" } });
  const failure: SiteEvent[] = [test("a", 1), { kind: "tool_result", ts: 2, id: "a", ok: true, failed: 3 }, ...Array.from({length: 22}, (_, i): SiteEvent => ({ kind: "text", ts: i + 3, text: `action ${i}` }))];
  const make = (events: SiteEvent[]) => siteOf({ now: 30, repo: { path: "r", name: "r" }, features: [], sessions: [session("pi:t", 1, events)], config: cfg, sources: SOURCES, diagnostics: [] }).workers[0];
  expect(make(failure).lastTestFailure).toEqual({ at: 1, text: "vitest ✗ 3" });
  expect(make([...failure, test("b", 26)]).lastTestFailure).toBeNull();
  expect(make([...failure, test("b", 26), {kind: "tool_result", ts: 27, id: "b", ok: true}]).lastTestFailure).toBeNull();
});
it("待答提问进入近期等待，24 小时历史边界独立于在场阈值", () => {
  const now = 100_000_000;
  const ask = session("claude:ask", 2, [{kind: "tool_call", ts: now - 100, id: "a", call: {tool: "AskUserQuestion", op: "ask", paths: [], title: "继续？"}}], "claude");
  const old = session("pi:old", 1, [{kind: "turn_end", ts: now - 86_400_001}]);
  const boundary = session("pi:boundary", 1, [{kind: "turn_end", ts: now - 86_400_000}]);
  const s = siteOf({now, repo: {path: "r", name: "r"}, features: [], sessions: [ask, old, boundary], config: {...cfg, thresholds: {...DEFAULT_THRESHOLDS, onsiteHours: 48}}, sources: SOURCES, diagnostics: []});
  expect(s.designer.waiting).toEqual([{kind: "turn_end", key: "pi:boundary", since: now - 86_400_000, text: "可能：回合结束"}, {kind: "turn_end", key: "claude:ask", since: now - 100, text: "可能：继续？"}, {kind: "history", key: "pi:old", since: now - 86_400_001, text: "可能：回合结束"}]);
});
it("快照复制嵌套输入并在卡片字段脱敏", () => {
  const feature = feat("data-layer", card({ title: "x".repeat(190) + " sk-abcdefgh12345678" }));
  const todos = [{text: "sk-abcdefgh12345678", status: "pending" as const}];
  const sess = session("pi:t", 1, [{kind: "tool_call", ts: 1, id: "a", call: {tool: "Todo", op: "todo", paths: [], todos}}]);
  const src = {pi: source("P"), claude: source("C"), dsh: source("D")};
  const config = {...cfg, features: cfg.features.map(f => ({...f, materials: f.materials.map(m => ({...m}))}))};
  const built = snapshotOf({now: 2, repo: {path: "r", name: "r"}, features: [feature], sessions: [sess], config, sources: src, diagnostics: []});
  const s = activeSite(built)!;
  expect(JSON.stringify(built)).not.toContain("abcdefgh12345678");
  expect(s.bands[0].card.title).toContain("sk-***");
  s.bands[0].materials[0].share = 1; s.bands[0].card.slices!.total = 5; s.workers[0].todos![0].text = "changed"; built.sources.pi.root = "changed";
  expect(config.features[0].materials[0].share).toBe(100); expect(feature.card!.slices).toEqual([]); expect(todos[0].text).toBe("sk-abcdefgh12345678"); expect(src.pi.root).toBe("P");
});
it("篷布楼段仍可定位但不画脚手架；钉住的切片有效就用，未知则回落", () => {
  const s = session("pi:pin", 1, [{kind: "text", ts: 1, text: "working"}]);
  const build = (features: FeatureInput[], pins: SiteConfig["pins"]) =>
    siteOf({now: 2, repo: {path: "r", name: "r"}, features, sessions: [s], config: {...cfg, pins}, sources: SOURCES, diagnostics: []});
  const tarp = build([feat("settings", "unreadable")], {"pi:pin": {feature: "settings", floor: "S2"}});
  expect(tarp.workers[0].location).toEqual({kind: "band", feature: "settings", floor: "S1"});
  expect(tarp.bands[0]).toMatchObject({tarp: "图纸读不出", scaffold: [], ribbon: "green"});
  const done = card({ slices: [slice("S1", { done: true }), slice("S2", { done: true })] });
  const pinned = build([feat("data-layer", done)], {"pi:pin": {feature: "data-layer", floor: "S1"}});
  expect(pinned.workers[0].location).toEqual({kind: "band", feature: "data-layer", floor: "S1"});
  expect(pinned.bands[0].scaffold).toEqual(["S1"]);
  const unknown = build([feat("data-layer", done)], {"pi:pin": {feature: "data-layer", floor: "gone"}});
  expect(unknown.workers[0].location).toEqual({kind: "band", feature: "data-layer", floor: "S2"});
  expect(unknown.bands[0].scaffold).toEqual(["S2"]);
  const unfinished = card({ slices: [slice("S1", { done: true }), slice("S2"), slice("S3")] });
  const fallback = build([feat("data-layer", unfinished)], {"pi:pin": {feature: "data-layer", floor: "gone"}});
  expect(fallback.workers[0].location).toEqual({kind: "band", feature: "data-layer", floor: "S2"});
  expect(fallback.bands[0].scaffold).toEqual(["S2"]);
});
it("彩带仅当最新动作是 API 错误时显示红色", () => {
  const s = session("pi:pin", 1, [{kind: "api_error", ts: 1, message: "x", rateLimited: false}, {kind: "text", ts: 2, text: "继续"}]);
  const result = siteOf({now: 3, repo: {path: "r", name: "r"}, features: [feat("data-layer", card())], sessions: [s], config: {...cfg, pins: {"pi:pin": {feature: "data-layer"}}}, sources: SOURCES, diagnostics: []});
  expect(result.bands[0].ribbon).toBe("green");
});
it("脱敏输入诊断和生成的未配置提示，同时保留身份字段和输入", () => {
  const name = "sk-abcdefgh12345678";
  const diagnostics = ["first ghp_abcdefghijklmnopqrstuv", "second"];
  const feature = feat(name, card());
  const repo = {path: `D:/${name}`, name};
  const result = snapshotOf({now: 1, repo, features: [feature], sessions: [], config: cfg, sources: SOURCES, diagnostics});
  expect(result.diagnostics).toEqual(["first ghp_***", "second", "feature sk-*** 不在 settings.json 的 features 里，先按未归类画在最上面"]);
  expect(result.sites[0].path).toBe(repo.path);
  expect(result.sites[0].name).toBe("sk-***");
  expect(result.sites[0].bands[0].feature).toBe(name);
  expect(result.sites[0].bands[0].card.specsDir).toBe(feature.specsDir);
  expect(diagnostics).toEqual(["first ghp_abcdefghijklmnopqrstuv", "second"]);
  expect(feature.name).toBe(name);
});
it("脱敏各来源错误并保留空值、根路径和输入", () => {
  const sources = {pi: {...source("D:/sk-abcdefgh12345678"), lastError: "sk-abcdefgh12345678"},
    claude: {...source("C"), lastError: "ghp_abcdefghijklmnopqrstuv"}, dsh: {...source("D"), lastError: null}};
  const before = structuredClone(sources);
  const result = snapshotOf({now: 1, repo: {path: "r", name: "r"}, features: [], sessions: [], config: cfg, sources, diagnostics: []});
  expect(result.sources.pi.lastError).toBe("sk-***");
  expect(result.sources.claude.lastError).toBe("ghp_***");
  expect(result.sources.dsh.lastError).toBeNull();
  expect(result.sources.pi.root).toBe("D:/sk-abcdefgh12345678");
  expect(sources).toEqual(before);
});
it("DSH 错误脱敏，其他来源的空值不变", () => {
  const sources = {pi: source("P"), claude: source("C"), dsh: {...source("D"), lastError: "sk-abcdefgh12345678"}};
  const result = snapshotOf({now: 1, repo: {path: "r", name: "r"}, features: [], sessions: [], config: cfg, sources, diagnostics: []});
  expect([result.sources.pi.lastError, result.sources.claude.lastError, result.sources.dsh.lastError]).toEqual([null, null, "sk-***"]);
  expect(sources.dsh.lastError).toBe("sk-abcdefgh12345678");
});
it("仓库显示名和模型显示名脱敏，模型角色仍按原始值推断", () => {
  const secret = "sk-abcdefgh12345678";
  const model = `gpt-${secret}-astra`;
  const s = session("pi:model", 2, [{kind: "model", ts: 1, model, explicit: true}]);
  const repo = {path: `D:/${secret}`, name: `repo ${secret}`};
  const result = snapshotOf({now: 2, repo, features: [], sessions: [s], config: cfg, sources: SOURCES, diagnostics: []});
  expect(result.sites[0].name).toBe("repo sk-***");
  expect(result.sites[0].workers[0].model).toBe("gpt-sk-***");
  expect(result.sites[0].workers[0]).toMatchObject({role: "worker", roleReason: "model", modelFamily: "gpt", key: "pi:model", file: "pi:model.jsonl", cwd: "D:/r"});
  expect(result.sites[0].path).toBe(`D:/${secret}`);
  expect(repo.name).toBe(`repo ${secret}`);
  expect(s.model).toBe(model);
});

it("等你的现在保留问题结尾，不按 200 字截断；在干只看当前回合", () => {
  const long = `${"甲".repeat(210)}请确认是否提交？`;
  const waited = session("pi:long", 1, [
    { kind: "prompt", ts: min(0), text: "开始", from: "user" },
    { kind: "text", ts: min(1), text: long },
    { kind: "turn_end", ts: min(1) },
  ]);
  const third = snapshotOf({ now: min(2), repo: { path: "D:/r", name: "R" }, features: FEATURES, sessions: [waited],
    config: cfg, sources: SOURCES, diagnostics: [] });
  expect(third.sites[0].workers[0].statusDetail).toContain("请确认是否提交？");

  const read = { tool: "Read", op: "read" as const, paths: ["task-b.ts"] };
  const nextTurn = session("pi:next", 1, [
    { kind: "prompt", ts: min(0), text: "第一轮", from: "user" },
    { kind: "text", ts: min(1), text: "第一轮完成了。" },
    { kind: "turn_end", ts: min(1) },
    { kind: "prompt", ts: min(1), text: "第二轮的提示，和上一轮末尾同一时间", from: "user" },
    { kind: "tool_call", ts: min(1), id: "r", call: read },
  ]);
  const fourth = snapshotOf({ now: min(4), repo: { path: "D:/r", name: "R" }, features: FEATURES, sessions: [nextTurn],
    config: cfg, sources: SOURCES, diagnostics: [] });
  expect(fourth.sites[0].workers[0].statusDetail).toBe("最近：看 task-b.ts");
});
