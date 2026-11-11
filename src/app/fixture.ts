import { buildSnapshot } from "../core/snapshot";
import { DEFAULT_THRESHOLDS } from "../core/status";
import type { FeatureInput, Harness, IntentCard, SessionState, SiteConfig, SiteEvent, SiteSnapshot, Slice, SliceStep, ToolCall, TrackedCall } from "../core/types";

const step = (text: string, done: boolean): SliceStep => ({ text, done });
const slice = (id: string, title: string, o: Partial<Slice> = {}): Slice =>
  ({ id, title, done: false, current: false, steps: [], ...o });
const card = (title: string, slices: Slice[], o: Partial<IntentCard> = {}): IntentCard =>
  ({ title, risk: "中", ac: 0, open: 0, openItems: [], slices, ...o });
const feature = (name: string, cardValue: IntentCard): FeatureInput =>
  ({ name, specsDir: `D:/work/example/specs/${name}`, card: cardValue });

const FEATURES: FeatureInput[] = [
  feature("data-layer", card("数据层", [
    slice("S1", "快照", { done: true }), slice("S2", "读取", { done: true }),
    slice("S3", "行情快照", { current: true, steps: [step("解析", true), step("归并", true), step("去重", true), step("补齐", false), step("回放", false)] }),
    slice("S4", "实时推送"), slice("S5", "落盘"),
  ], { ac: 12, open: 2 })),
  feature("agent-dock", card("让 agent 在数据面板中工作", [
    slice("S1", "停靠", { done: true }),
    slice("S2", "停靠与卡片", { current: true, steps: [step("布局", true), step("选中", false), step("收起", false)] }),
    slice("S3", "多会话"), slice("S4", "清理"),
  ], { ac: 78, open: 3 })),
  feature("desktop-shell", card("安装即用的桌面外壳", [
    slice("S1", "日志、诊断与安全", { current: true, steps: [step("日志", false), step("诊断", false)] }),
    slice("S2", "托盘"), slice("S3", "更新"),
  ], { risk: "高", ac: 38, open: 3 })),
  feature("dev-harness", card("开发工具", [
    slice("S1", "预算表", { done: true }),
  ], { risk: "低", ac: 4, open: 0 })),
];

const CONFIG: SiteConfig = {
  thresholds: { ...DEFAULT_THRESHOLDS },
  style: "tower",
  pins: {
    "pi:s1": { feature: "data-layer", floor: "S3" },
    "pi:s2": { feature: "data-layer", floor: "S3" },
    "claude:s3": { feature: "agent-dock", floor: "S2" },
    "dsh:s4": { feature: "desktop-shell", floor: "S1" },
    "claude:s5": { feature: "agent-dock", floor: "S2" },
  },
  features: [
    { name: "data-layer", placement: "band", materials: [{ material: "brick", share: 100 }] },
    { name: "agent-dock", placement: "band", materials: [{ material: "glass", share: 100 }] },
    { name: "desktop-shell", placement: "crown", materials: [{ material: "metal", share: 100 }] },
    { name: "dev-harness", placement: "office", materials: [] },
  ],
};

const source = (root: string) => ({ root, present: true, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null });

const SITE = { key: "D:/work/example", path: "D:/work/example", name: "example", kind: "git" as const };

/** 界面示例快照；S4 换成真实引擎输出。六个会话覆盖等你 / 出错 / 停工 / 在干 / 空闲和办公室，另加五个空闲触发 +N */
export function fixtureSnapshot(now = 0): SiteSnapshot {
  return buildSnapshot({ now, sites: [{ ...SITE, mini: false, features: FEATURES, backlog: [], sessions: fixtureSessions(now) }],
    active: SITE.key, config: CONFIG,
    sources: { pi: source("pi"), claude: source("claude"), dsh: source("dsh") }, diagnostics: [] });
}

const prompt = (ts: number, text: string): SiteEvent => ({ kind: "prompt", ts, text, from: "user" });
const said = (ts: number, text: string): SiteEvent => ({ kind: "text", ts, text });
const turnEnd = (ts: number): SiteEvent => ({ kind: "turn_end", ts });
const called = (ts: number, id: string, call: ToolCall): SiteEvent => ({ kind: "tool_call", ts, id, call });
const settled = (ts: number, id: string, ok: boolean, failed?: number): SiteEvent =>
  ({ kind: "tool_result", ts, id, ok, ...(failed === undefined ? {} : { failed }) });

const session = (key: string, harness: Harness, level: number, model: string, firstPrompt: string,
  events: SiteEvent[], calls: TrackedCall[], startedAt: number, lastEventAt: number): SessionState =>
  ({ meta: { key, harness, nativeId: key.split(":")[1], file: `fixture/${key.replace(":", "-")}.jsonl`,
    cwd: "D:/work/example", startedAt, level }, events, calls, firstPrompt, model, lastEventAt });

function fixtureSessions(now: number): SessionState[] {
  const minute = 60_000;
  const edit = { tool: "Edit", op: "edit" as const, paths: ["src/core/snapshot.ts"], added: 12, removed: 3 };
  const test = { tool: "Bash", op: "shell" as const, paths: [], command: "npx vitest run" };
  const stalledEdit = { tool: "Edit", op: "edit" as const, paths: ["src/app/main.ts"], added: 8, removed: 2 };
  const read = { tool: "Read", op: "read" as const, paths: ["specs/agent-dock/spec.md"] };
  const docs1 = { tool: "Read", op: "read" as const, paths: ["docs/AGENTS.md"] };
  const docs2 = { tool: "Read", op: "read" as const, paths: ["docs/design.md"] };
  return [
    session("pi:s1", "pi", 1, "claude-opus-4-6", "# data-layer Implement R1：写快照\n- 你是协调者",
      [prompt(now - 8 * minute, "# data-layer Implement R1：写快照\n- 你是协调者"),
        said(now - minute / 2, "快照写好了，要提交吗？错误处理还没补。"), turnEnd(now - minute / 2)],
      [], now - 40 * minute, now - minute / 2),
    session("pi:s2", "pi", 2, "gpt-5.1-astra", "# data-layer Implement R1：改快照\n- 你是实施",
      [prompt(now - 60 * minute, "# data-layer Implement R1：改快照\n- 你是实施"),
        called(now - 4_000, "e1", edit), settled(now - 3_900, "e1", true)],
      [{ id: "e1", ts: now - 4_000, call: edit, result: { ts: now - 3_900, ok: true } }],
      now - 90 * minute, now - 3_900),
    session("claude:s3", "claude", 2, "claude-fable-5", "# agent-dock Implement R1：补选中\n- 你是实施",
      [prompt(now - 50 * minute, "# agent-dock Implement R1：补选中\n- 你是实施"),
        called(now - 20_000, "t1", test), settled(now - 19_000, "t1", false, 3)],
      [{ id: "t1", ts: now - 20_000, call: test, result: { ts: now - 19_000, ok: false, failed: 3 } }],
      now - 80 * minute, now - 19_000),
    session("dsh:s4", "dsh", 1, "gpt-5.1-codex", "# desktop-shell Implement R1：托盘\n- 你是协调者",
      [prompt(now - 3 * 60 * minute, "# desktop-shell Implement R1：托盘\n- 你是协调者"),
        called(now - 31 * minute, "e2", stalledEdit)],
      [{ id: "e2", ts: now - 31 * minute, call: stalledEdit }],
      now - 4 * 60 * minute, now - 31 * minute),
    session("claude:s5", "claude", 2, "claude-fable-5", "# agent-dock Check R1：看选中\n- 你是审核",
      [prompt(now - 40 * minute, "# agent-dock Check R1：看选中\n- 你是审核"),
        called(now - 11 * minute, "r1", read), settled(now - 11 * minute + 1_000, "r1", true)],
      [{ id: "r1", ts: now - 11 * minute, call: read, result: { ts: now - 11 * minute + 1_000, ok: true } }],
      now - 45 * minute, now - 11 * minute),
    session("pi:s6", "pi", 1, "deepseek-flash", "整理一下文档。",
      [prompt(now - 30 * minute, "整理一下文档。"),
        called(now - 2 * minute, "d1", docs1), settled(now - 2 * minute + 1_000, "d1", true),
        called(now - 100_000, "d2", docs2), settled(now - 99_000, "d2", true)],
      [{ id: "d1", ts: now - 2 * minute, call: docs1, result: { ts: now - 2 * minute + 1_000, ok: true } },
        { id: "d2", ts: now - 100_000, call: docs2, result: { ts: now - 99_000, ok: true } }],
      now - 35 * minute, now - 99_000),
    ...Array.from({ length: 5 }, (_, i): SessionState => {
      const key = `pi:s${7 + i}`;
      const op = { tool: "Bash", op: "shell" as const, paths: [], command: "git status" };
      return session(key, "pi", 1, "gpt-5.1", "看一眼。",
        [prompt(now - 20 * minute, "看一眼。"), called(now - 12 * minute, `g${i}`, op),
          settled(now - 12 * minute + 1_000, `g${i}`, true)],
        [{ id: `g${i}`, ts: now - 12 * minute, call: op, result: { ts: now - 12 * minute + 1_000, ok: true } }],
        now - 25 * minute, now - 12 * minute);
    }),
  ];
}