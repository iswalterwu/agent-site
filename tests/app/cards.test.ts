import { describe, expect, it } from "vitest";
import { backlogList, bandSummary, bandView, diagnosticsProblems, diagnosticsView, featureExists, formatSince, openList, plainText, waitingList, workerCardSite, workerView } from "../../src/app/cards";
import { fixtureSnapshot } from "../../src/app/fixture";
import { activeSite, buildSite } from "../../src/core/site";
import { DEFAULT_THRESHOLDS } from "../../src/core/status";
import type { SessionState, SiteConfig, TodoItem } from "../../src/core/types";
import { visibleSnapshot } from "../../src/app/visibility";
import { withSite } from "../harness/site";

const snapshot = fixtureSnapshot(0);
const now = snapshot.at;
const snap = activeSite(snapshot)!;

describe("卡片数据", () => {
  it("楼段卡：标题、状态、人员、当前切片和验收数字", () => {
    const band = bandView(snap, "data-layer")!;
    expect(band).toMatchObject({ title: "数据层", readable: true, statusLabel: "在建", risk: "中",
      ac: 12, open: 2, slices: { total: 5, done: 2 },
      current: { id: "S3", title: "行情快照", stepsDone: 3, stepsTotal: 5 }, tone: "waiting" });
    expect(band.workers.map(worker => worker.key).sort()).toEqual(["pi:s1", "pi:s2"]);
    expect(bandSummary(band)).toEqual({ status: "在建", people: "2 人 · 工人 / 工头",
      current: "S3 行情快照 3/5", acceptance: "AC 12 · 待定 2", risk: "风险 中" });
  });

  it("图纸读不出时卡片仍然可开，摘要显示篷布文字", () => {
    const broken = structuredClone(snap);
    broken.bands[0].tarp = "图纸读不出";
    broken.bands[0].card = { title: null, risk: null, ac: null, open: null, openItems: null, slices: null,
      current: null, status: null, source: "none", specsDir: "D:/x/specs/data-layer" };
    const band = bandView(broken, "data-layer")!;
    expect(band.readable).toBe(false);
    expect(bandSummary(band)).toMatchObject({ status: "图纸读不出", current: "没有当前切片", acceptance: "—", risk: "—" });
  });

  it("小人卡：角色、位置、状态和只读", () => {
    const worker = workerView(snap, "pi:s1")!;
    expect(worker).toMatchObject({ title: "工头 · data-layer S3", tone: "waiting", statusLabel: "等你",
      readOnly: true, harness: "pi", model: "claude-opus-4-6",
      location: "data-layer S3" });
    expect(worker.statusDetail).toContain("快照写好了");
    expect(worker.trace.length).toBeGreaterThan(0);
    expect(worker.trace.length).toBeLessThanOrEqual(10);
    expect(workerView(snap, "nope")).toBeNull();
    const demo = workerView(snap, "pi:s1", true)!;
    expect(demo.actions).toEqual([]);
    expect(demo.todos).toBeNull();
    expect(demo.testFailure).toBeNull();
    expect(demo.statusDetail).toBeNull();
    expect(demo.trace).toEqual([]);
    const controlled = structuredClone(snap);
    const w = controlled.workers.find(item => item.key === "pi:s1")!;
    w.readOnly = false;
    w.control = { online: true, paused: true, holding: { tool: "bash", sinceMs: 1 }, idle: false };
    expect(workerView(controlled, "pi:s1")!.control).toMatchObject({ online: true, paused: true, holding: { tool: "bash" } });
    expect(workerView(controlled, "pi:s1", true)!.control).toBeNull();
  });

  it("等你清单分成现在和历史", () => {
    const list = waitingList(snapshot);
    expect(list.recent.map(item => item.key)).toEqual(["pi:s1"]);
    expect(list.history).toEqual([]);
  });
  it("WINDOW-20：等你清单列全部工地，每行带工地名，各自按等待开始时间从早到晚", () => {
    const two = structuredClone(snapshot);
    const other = structuredClone(snap);
    other.key = "other";
    other.name = "另一个工地";
    other.workers = other.workers.map(item => ({ ...item, key: `x-${item.key}` }));
    const mine = two.sites[0].designer.waiting[0] as { since: number };
    // 故意乱序：晚等的那条排在数组前面，清单必须自己按开始时间排
    other.designer = { waiting: [
      { kind: "turn_end", key: "x-pi:late", since: mine.since + 100, text: "刚来等" },
      { kind: "turn_end", key: "x-pi:early", since: mine.since - 100, text: "先等了" },
      { kind: "history", key: "x-pi:s2", since: 50, text: "很久以前" },
    ] };
    two.sites.push(other);
    const list = waitingList(two);
    expect(list.recent.map(item => [item.site, item.text])).toEqual([
      ["另一个工地", "先等了"], [snap.name, list.recent[1].text], ["另一个工地", "刚来等"]]);
    expect(list.history.map(item => [item.site, item.text])).toEqual([["另一个工地", "很久以前"]]);
  });
  it("WINDOW-21：别的小人卡跟着它自己的工地，当前工地和别的工地的更新都不影响它", () => {
    const two = structuredClone(snapshot);
    const other = structuredClone(snap);
    other.key = "other";
    other.name = "另一个工地";
    other.workers = other.workers.map(item => ({ ...item, key: `x-${item.key}` }));
    other.designer = { waiting: [] };
    two.sites.push(other);
    const target = { key: "x-pi:s1", site: "other" };
    // 当前工地还是原来的那个，但卡片找得到别的工地的小人
    expect(activeSite(two)!.key).toBe(snap.key);
    expect(workerCardSite(two, target)?.key).toBe("other");
    expect(workerView(workerCardSite(two, target)!, target.key)).not.toBeNull();
    // 当前工地变了、别的小人离场：这张卡不受影响
    const moved = structuredClone(two);
    moved.sites[0]!.workers = [];
    moved.active = "other";
    expect(workerCardSite(moved, target)?.key).toBe("other");
    // 它自己的工地里这个小人离场、或者工地没了：卡片该关
    const gone = structuredClone(two);
    gone.sites[1]!.workers = gone.sites[1]!.workers.filter(item => item.key !== target.key);
    expect(workerCardSite(gone, target)).toBeNull();
    const dropped = structuredClone(two);
    dropped.sites = dropped.sites.filter(item => item.key !== "other");
    expect(workerCardSite(dropped, target)).toBeNull();
  });
  it("WINDOW-19：超过 6 小时的等待只留在快照里，不进灯和清单（可见投影之后）", () => {
    const stale = structuredClone(snapshot);
    const item = stale.sites[0].designer.waiting[0] as { since: number };
    item.since = now - 7 * 3_600_000;
    const staleWorker = stale.sites[0].workers.find(worker => worker.status === "waiting")!;
    staleWorker.statusSince = now - 7 * 3_600_000;
    const visible = visibleSnapshot(stale, now);
    expect(waitingList(visible).recent).toEqual([]);
    expect(visible.sites[0].workers.some(worker => worker.key === staleWorker.key)).toBe(false);
    // 快照本身还留着它（诊断和清单之外的地方能看到）
    expect(stale.sites[0].workers).toContain(staleWorker);
  });

  it("卡片显示前脱敏 specsDir、标题、nativeId 和等你文本", () => {
    const secret = "sk-abcdefgh12345678";
    const leaky = structuredClone(snap);
    leaky.bands[0].card.specsDir = `D:/x/${secret}`;
    leaky.bands[0].card.title = `数据层 ${secret}`;
    const band = bandView(leaky, "data-layer")!;
    expect(band.specsDir).not.toContain(secret);
    expect(band.title).not.toContain(secret);

    const workerSnap = structuredClone(snap);
    workerSnap.workers.find(worker => worker.key === "pi:s1")!.nativeId = secret;
    expect(workerView(workerSnap, "pi:s1")!.nativeId).not.toContain(secret);

    const waitingSnap = structuredClone(snapshot);
    waitingSnap.sites[0].designer.waiting[0] = { ...waitingSnap.sites[0].designer.waiting[0], key: secret, text: secret };
    const list = waitingList(waitingSnap);
    expect(list.recent[0].key).not.toContain(secret);
    expect(list.recent[0].text).not.toContain(secret);
  });

  it("诊断卡：来源、坏行和解析问题都脱敏", () => {
    const report = structuredClone(snapshot);
    const secret = "sk-abcdefgh12345678";
    report.sources.pi.lastError = secret;
    report.diagnostics.push(secret);
    const view = diagnosticsView(report, activeSite(report)!);
    expect(view.sources.map(source => source.harness)).toEqual(["pi", "claude", "dsh"]);
    expect(view.repo).toBe(report.sites[0].path);
    expect(view.notes).not.toContain(secret);
    expect(view.sources[0].lastError).not.toContain(secret);
    const problems = diagnosticsProblems(view);
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).not.toContain(secret);
  });

  it("时长用中文短句", () => {
    expect(formatSince(0, -30_000)).toBe("刚刚");
    expect(formatSince(0, -5 * 60_000)).toBe("5 分钟前");
    expect(formatSince(0, -90 * 60_000)).toBe("1 小时前");
    expect(formatSince(0, -50 * 3_600_000)).toBe("2 天前");
  });
});

describe("feature 存续", () => {
  it("楼段和办公室都算还在，其他 feature 才算消失", () => {
    expect(featureExists(snap, "agent-dock")).toBe(true);
    expect(featureExists(snap, "dev-harness")).toBe(true);
    expect(featureExists(snap, "removed-feature")).toBe(false);
  });
});

describe("小人卡精简", () => {
  it("会话 ID 只留头尾，最近动作最多四条", () => {
    const copy = structuredClone(snap);
    const worker = copy.workers.find(item => item.key === "pi:s1")!;
    worker.nativeId = "01a1ac53-51dc-74bd-9a60-eedc018e3528";
    worker.actions = Array.from({ length: 8 }, (_, i) => ({ kind: "read" as const, at: i, text: `动作 ${i}` }));
    const view = workerView(copy, "pi:s1")!;
    expect(view.nativeId).toBe("01a1ac53…3528");
    expect(view.nativeId.length).toBeLessThanOrEqual(13);
    expect(view.actions).toHaveLength(4);
  });

  it("卡片文字去掉 Markdown 强调、反引号和链接标记", () => {
    expect(plainText("**C（先离线）** 和 `doc_guard`，见 [设计](docs/x.md)")).toBe("C（先离线） 和 doc_guard，见 设计");
    expect(plainText("*需要确认* __待验收__ snake_case")).toBe("需要确认 待验收 snake_case");
    expect(plainText("发版。- 点头后提交")).toBe("发版。点头后提交");
    const copy = structuredClone(snap);
    copy.workers.find(item => item.key === "pi:s1")!.actions = [
      { kind: "read", at: 0, text: "**授权** `code`" },
      { kind: "read", at: 1, text: "`Bearer` abc.def.ghi" },
    ];
    const actions = workerView(copy, "pi:s1")!.actions;
    expect(actions[0].text).toBe("授权 code");
    expect(actions[1].text).not.toContain("Bearer abc.def.ghi");
  });
});

describe("WINDOW-28：意图卡里的待定进等你清单", () => {
  it("每一条都列出来，带工地与楼段名；文字先脱敏", () => {
    const base = fixtureSnapshot(0);
    const site = base.sites[0]!;
    const snap = withSite(base, {
      open: [{ feature: "数据层", text: "先定鉴权 sk-abcdefgh12345678" }, { feature: "数据层", text: "再定重试" }],
    });
    const open = openList(snap);
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({ site: site.name, feature: "数据层", text: "先定鉴权 sk-***" });
    expect(open[1]!.text).toBe("再定重试");
  });
  it("没有待定时是空的", () => {
    expect(openList(withSite(fixtureSnapshot(0), { open: [] }))).toEqual([]);
  });
  it("矮楼（没有意图卡）也有待定：这一栏不随楼层布局走", () => {
    const snap = withSite(fixtureSnapshot(0), { open: [{ feature: "数据层", text: "先定鉴权" }], mini: true });
    expect(openList(snap).map(row => row.text)).toEqual(["先定鉴权"]);
  });
});

describe("WINDOW-29：工地的待做进等你清单", () => {
  it("一行一条，带工地名，文字先脱敏", () => {
    const base = fixtureSnapshot(0);
    const site = base.sites[0]!;
    const snap = withSite(base, { backlog: ["加亮色主题 sk-abcdefgh12345678", "补导出"] });
    const rows = backlogList(snap);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ site: site.name, text: "加亮色主题 sk-***" });
    expect(rows[1]!.text).toBe("补导出");
  });
  it("没有待做时是空的", () => {
    expect(backlogList(withSite(fixtureSnapshot(0), { backlog: [] }))).toEqual([]);
  });
});

it("SITE-7：待办楼段的卡标出来源、待办数和当前待办", () => {
  const todos: TodoItem[] = [
    { text: "读图纸", status: "completed" }, { text: "砌墙", status: "in_progress" }, { text: "验收", status: "pending" },
  ];
  const session: SessionState = { meta: { key: "pi:a", harness: "pi", nativeId: "a", file: "a.jsonl", cwd: "D:/r/a", startedAt: 0, level: 1 },
    events: [], calls: [], todos, lastEventAt: 0, firstPrompt: "修数据层" };
  const config: SiteConfig = { style: "tower", features: [], pins: {}, thresholds: DEFAULT_THRESHOLDS };
  const site = buildSite({ key: "D:/r", path: "D:/r", name: "R", kind: "git", mini: false, features: [], backlog: [], sessions: [session] }, config, 0);
  const band = bandView(site, "修数据层")!;
  expect([band.source, band.slices, band.current?.title]).toEqual(["todos", { total: 3, done: 1 }, "砌墙"]);
  expect(bandSummary(band)).toMatchObject({ status: "来自会话待办 · 在建", current: "砌墙", acceptance: "待办 1/3", risk: "" });
});
