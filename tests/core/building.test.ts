import { expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../../src/core/status";
import type { FeatureInput, IntentCard, SessionState, SiteConfig, SiteInput, Slice, TodoItem, Worker } from "../../src/core/types";
import { bandCard, orderFeatures, resolveStyle, ribbonColor, stageOf } from "../../src/core/building";
import { buildSite } from "../../src/core/site";

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
const worker = (o: Partial<Worker>): Worker => ({ key: "k", harness: "pi", nativeId: "k", level: 1, parentKey: null, readOnly: true,
  role: "worker", roleReason: "level", model: null, modelFamily: "other", location: { kind: "gate" }, attribution: { rule: "none", detail: "" },
  status: "working", statusSince: 0, bubble: "", statusDetail: null, trace: [], actions: [], todos: null, lastTestFailure: null,
  startedAt: 0, lastEventAt: 0, lastUserAt: null, file: "f", cwd: "c", ...o });

it("多个未归类的 feature 按名字排；配置里有但没有意图卡的不画", () => {
  const got = orderFeatures([feat("zeta", card()), feat("alpha", card()), feat("data-layer", card())], cfg.features);
  expect(got.bands.map((b) => b.input.name)).toEqual(["data-layer", "alpha", "zeta"]);
  expect(got.office).toEqual([]);
});

it("彩带：橙 > 红 > 黄 > 绿 > 灰（P13）", () => {
  expect(ribbonColor("in-progress", [worker({ status: "waiting", statusDetail: "要提交吗？" }), worker({ status: "stalled" })])).toBe("orange");
  expect(ribbonColor("in-progress", [worker({ status: "waiting" }), worker({ lastTestFailure: { at: 1, text: "pytest ✗ 3" } })])).toBe("orange");
  expect(ribbonColor("in-progress", [worker({ lastTestFailure: { at: 1, text: "pytest ✗ 3" } }), worker({ status: "stalled" })])).toBe("red");
  expect(ribbonColor("in-progress", [worker({ actions: [{ kind: "api_error", at: 1, text: "限流，等待中" }] })])).toBe("red");
  expect(ribbonColor("in-progress", [worker({ status: "stalled" })])).toBe("yellow");
  expect(ribbonColor("in-progress", [worker({ status: "working" })])).toBe("green");
  expect(ribbonColor("in-progress", [worker({ status: "idle" })])).toBe("grey");
  expect(ribbonColor("done", [])).toBe("grey");
  expect(ribbonColor(null, [])).toBe("grey");
});

it("楼段卡：标题、风险、验收例子数、待定数、切片与当前步骤进度；文本脱敏", () => {
  const got = bandCard(feat("x", card({ title: "sk-abcdefgh12345678 功能", risk: "高", ac: 5, open: 2, slices: [
    slice("S1", { done: true }), slice("S2", { current: true, steps: [step(true), step(false)] })] })));
  expect(got).toEqual({ title: "sk-*** 功能", risk: "高", ac: 5, open: 2, openItems: [], slices: { total: 2, done: 1 },
    current: { id: "S2", title: "切片 S2", stepsDone: 1, stepsTotal: 2 }, status: "in-progress", source: "card", specsDir: "D:/r/specs/x" });
});

it("楼段卡：全部 ✓ 是 done；读不出时除 specsDir 外全是 null", () => {
  expect(bandCard(feat("x", card({ slices: [slice("S1", { done: true })] })))).toMatchObject({ status: "done", slices: { total: 1, done: 1 }, current: null });
  expect(bandCard(feat("x", "unreadable"))).toEqual({ title: null, risk: null, ac: null, open: null, openItems: null, slices: null,
    current: null, status: null, source: "card", specsDir: "D:/r/specs/x" });
});

it("WINDOW-28：快照里的待定文字和楼段名都先脱敏；同一个 feature 配了两处只收一次", () => {
  const site = buildSite({ key: "D:/r", path: "D:/r", name: "R", kind: "git", mini: false, backlog: [],
    features: [feat("x", card({ title: "sk-abcdefgh12345678 功能", openItems: ["密钥 sk-abcdefgh12345678"] }))],
    sessions: [] }, cfg, 0);
  expect(site.open).toEqual([{ feature: "sk-*** 功能", text: "密钥 sk-***" }]);
  expect(JSON.stringify(site)).not.toContain("abcdefgh12345678");
  // 同一个 feature 同时配成 band 和 office：待定只收一次，两处的卡片各留各的
  const twice = buildSite({ key: "D:/r", path: "D:/r", name: "R", kind: "git", mini: false, backlog: [],
    features: [feat("x", card({ openItems: ["一", "二"] }))], sessions: [] },
  { ...cfg, features: [{ name: "x", placement: "band", materials: [{ material: "brick", share: 100 }] },
    { name: "x", placement: "office", materials: [] }] }, 0);
  expect(twice.open.map(item => item.text)).toEqual(["一", "二"]);
});

it("WINDOW-29：快照里的待做先脱敏", () => {
  const site = buildSite({ key: "D:/r", path: "D:/r", name: "R", kind: "git", mini: false,
    features: [], backlog: ["加亮色主题 sk-abcdefgh12345678"], sessions: [] }, cfg, 0);
  expect(site.backlog).toEqual(["加亮色主题 sk-***"]);
  expect(JSON.stringify(site)).not.toContain("abcdefgh12345678");
});

it("WINDOW-30：楼段造型取 feature 自己的，没写就跟工地默认", () => {
  expect(resolveStyle("factory", "tower")).toBe("factory");
  expect(resolveStyle("storefront", "factory")).toBe("storefront");
  expect(resolveStyle(undefined, "storefront")).toBe("storefront");
});

it("WINDOW-31：阶段只看切片完成比例，没有切片是围挡、全部完成是竣工", () => {
  expect(stageOf(0, 0)).toBe("empty");
  expect(stageOf(3, 0)).toBe("empty");
  expect(stageOf(3, 1)).toBe("foundation");
  expect(stageOf(4, 2)).toBe("structure");
  expect(stageOf(3, 2)).toBe("structure");
  expect(stageOf(3, 3)).toBe("done");
  expect(stageOf(1, 1)).toBe("done");
});

it("WINDOW-30、WINDOW-31：快照里的楼段带上造型和阶段；篷布段是围挡，矮楼是竣工", () => {
  const config: SiteConfig = { ...cfg, style: "factory",
    features: cfg.features.map(f => f.name === "data-layer" ? { ...f, style: "storefront" as const } : f) };
  const input = { key: "D:/r", path: "D:/r", name: "R", kind: "git" as const, backlog: [], sessions: [],
    features: [feat("data-layer", card({ slices: [slice("S1", { done: true }), slice("S2")] })),
      feat("alpha", card({ slices: [slice("S1")] })), feat("tarp", card())] };
  const site = buildSite({ ...input, mini: false }, config, 0);
  expect(site.bands.map(b => [b.feature, b.style, b.stage])).toEqual([
    ["data-layer", "storefront", "structure"],
    ["alpha", "factory", "empty"],
    ["tarp", "factory", "empty"],
  ]);
  const mini = buildSite({ ...input, mini: true, features: [] }, config, 0);
  expect(mini.bands.map(b => [b.style, b.stage])).toEqual([["factory", "done"]]);
});

it("WINDOW-30、WINDOW-31：办公室也带造型和阶段，feature 覆盖顶层", () => {
  const config: SiteConfig = { ...cfg, style: "factory", features: [
    { name: "gov", placement: "office", materials: [], style: "storefront" },
    { name: "blank", placement: "office", materials: [] }] };
  const view = buildSite({ key: "D:/r", path: "D:/r", name: "R", kind: "git", mini: false, backlog: [],
    features: [feat("gov", card({ slices: [slice("S1", { done: true }), slice("S2")] })), feat("blank", "unreadable")],
    sessions: [] }, config, 0);
  expect(view.office.map(o => [o.feature, o.style, o.stage])).toEqual([
    ["gov", "storefront", "structure"],
    ["blank", "factory", "empty"],
  ]);
});

const todo = (text: string, status: TodoItem["status"]): TodoItem => ({ text, status });
const todoSession = (key: string, level: number, todos: TodoItem[], parentKey?: string): SessionState => ({
  meta: { key, harness: "pi", nativeId: key.split(":")[1], file: `${key}.jsonl`, cwd: "D:/r/a", startedAt: 0, level,
    ...(parentKey === undefined ? {} : { parentKey }) },
  events: [], calls: [], todos, lastEventAt: 0,
  firstPrompt: key === "pi:a" ? "修数据层" + String.fromCharCode(10) + "第二行" : key === "pi:b" ? "写测试" : "子 agent",
});
const todoSite = (sessions: SessionState[], features: FeatureInput[] = []): SiteInput =>
  ({ key: "D:/r", path: "D:/r", name: "R", kind: "git", mini: features.length === 0, features, backlog: [], sessions });

it("SITE-7：没有意图卡时按一级会话的待办出楼段，楼层按待办状态画", () => {
  const a = todoSession("pi:a", 1, [todo("读图纸", "completed"), todo("砌墙", "completed"), todo("验收", "in_progress"), todo("交付", "pending")]);
  const b = todoSession("pi:b", 1, [todo("写测试", "completed")]);
  const child = todoSession("pi:c", 2, [], "pi:a");
  const gate = todoSession("pi:g", 1, []);
  const view = buildSite(todoSite([a, b, child, gate]), cfg, 0);
  expect(view.mini).toBe(false);
  expect(view.bands.map(band => [band.feature, band.card.source, band.card.slices, band.stage, band.plan?.floors.map(floor => floor.kind)])).toEqual([
    ["修数据层", "todos", { total: 4, done: 2 }, "structure", ["built", "built", "progress", "planned"]],
    ["写测试", "todos", { total: 1, done: 1 }, "done", ["built"]],
  ]);
  expect(view.workers.map(worker => [worker.key, worker.location.kind === "band" ? worker.location.feature : worker.location.kind]))
    .toEqual([["pi:a", "修数据层"], ["pi:b", "写测试"], ["pi:c", "修数据层"], ["pi:g", "gate"]]);
  expect(view.bands[0].plan?.floors.map(floor => floor.id)).toEqual(["1", "2", "3", "4"]);
});

it("SITE-7：没有待办时仍是矮楼；有意图卡时待办不参与", () => {
  const empty = buildSite(todoSite([todoSession("pi:x", 1, [])]), cfg, 0);
  expect([empty.mini, empty.bands.length, empty.bands[0].mini]).toEqual([true, 1, true]);
  const withCard = buildSite(todoSite([todoSession("pi:a", 1, [todo("读图纸", "completed")])],
    [feat("x", card({ slices: [slice("S1")] }))]), cfg, 0);
  expect(withCard.bands.map(band => [band.feature, band.card.source])).toEqual([["x", "card"]]);
});

it("SITE-7：楼段名脱敏，超过 6 段 / 12 层时截断", () => {
  const many = Array.from({ length: 7 }, (_, i) => {
    const session = todoSession(`pi:s${i}`, 1, Array.from({ length: 13 }, (_, n) => todo(`待办 ${n}`, "pending")));
    session.firstPrompt = i === 0 ? "密钥 sk-abcdefgh12345678 的任务" : `任务 ${i}`;
    session.meta.startedAt = i;
    return session;
  });
  const view = buildSite(todoSite(many), cfg, 0);
  expect(view.bands).toHaveLength(6);
  expect(view.bands[0].feature).toContain("sk-***");
  expect(JSON.stringify(view)).not.toContain("abcdefgh12345678");
  expect(view.bands.every(band => band.plan?.floors.length === 12)).toBe(true);
});

it("SITE-7：楼层只画前 12 条，计数和阶段用完整待办列表", () => {
  const items = Array.from({ length: 13 }, (_, i) => todo(`待办 ${i + 1}`, i < 12 ? "completed" : "pending"));
  const view = buildSite(todoSite([todoSession("pi:a", 1, items)]), cfg, 0);
  const band = view.bands[0];
  expect(band.plan?.floors).toHaveLength(12);
  expect(band.card.slices).toEqual({ total: 13, done: 12 });
  expect(band.stage).toBe("structure");
  expect(band.card.current).toBeNull();
  expect(band.card.status).toBe("in-progress");
});

it("SITE-7：楼段名先脱敏再截断，长密钥不漏", () => {
  for (const token of ["ghp_abcdefghijklmnopqrstuvwxyz012345",
    "0123456789abcdef0123456789abcdef01234567",
    "Ab1xY9zQ2wE8rT4uK6mN8pR0sV3cB5dF7gH9jL1Q7"]) {
    const session = todoSession("pi:a", 1, [todo("读图纸", "completed")]);
    session.firstPrompt = `${token} 的任务`;
    const view = buildSite(todoSite([session]), cfg, 0);
    expect(view.bands[0].feature).not.toContain(token.slice(0, 8));
    expect(JSON.stringify(view)).not.toContain(token.slice(0, 12));
  }
});

it("WINDOW-7：待办楼段的工人站在进行中或第一个未完成的层", () => {
  const a = todoSession("pi:a", 1, [todo("读图纸", "completed"), todo("砌墙", "in_progress"), todo("验收", "pending")]);
  const view = buildSite(todoSite([a]), cfg, 0);
  expect(view.workers[0].location).toEqual({ kind: "band", feature: "修数据层", floor: "2" });
});
