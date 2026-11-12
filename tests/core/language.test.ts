import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveActions } from "../../src/core/actions";
import type { Locale } from "../../src/core/i18n";
import { applyEvents, newSession } from "../../src/core/session";
import { buildSnapshot } from "../../src/core/snapshot";
import { DEFAULT_THRESHOLDS, sessionStatus } from "../../src/core/status";
import { traceOf } from "../../src/core/trace";
import type { SiteConfig, SiteEvent, SiteInput, SourceStatus } from "../../src/core/types";
import { SiteEngine } from "../../src/main/engine";
import { defaultSettings } from "../../src/main/settings";
import { call, meta, result } from "../fixtures/events";
import { min, piAssistant, piHeader, piUser, writeJsonl } from "../fixtures/logs";
import { piFile } from "../fixtures/world";
import { mkTmpDir } from "../harness/wait";

const state = (events: SiteEvent[], level = 1) => applyEvents(newSession({ ...meta, level }), events);
const config: SiteConfig = { style: "tower", features: [], pins: {}, thresholds: DEFAULT_THRESHOLDS };
const source = (root: string): SourceStatus => ({ root, present: true, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null });
const sources = { pi: source("P"), claude: source("C"), dsh: source("D") };

const engines: SiteEngine[] = [];
afterEach(() => { engines.forEach(engine => engine.stop()); engines.length = 0; });
function fixtureEngine(locale?: Locale) {
  const roots = { pi: mkTmpDir(), claude: mkTmpDir(), dsh: mkTmpDir() };
  const settings = { ...defaultSettings(), locale };
  const engine = new SiteEngine({ settings, roots, now: () => min(30), watch: false, minIntervalMs: 0,
    gitBranch: async () => null,
    siteKey: async cwd => ({ key: cwd, path: cwd, kind: "dir" }),
  });
  engines.push(engine);
  return { engine, roots, settings };
}

describe("WINDOW-33：核心动作本地化", () => {
  it("英文只改变说明，分类、测试配对、返工与原有中文默认值不变", () => {
    const events: SiteEvent[] = [
      call("r", { tool: "read", op: "read", paths: ["src/api.ts"] }, min(0)),
      call("g", { tool: "grep", op: "search" }, min(1)),
      call("w", { tool: "write", op: "write", paths: ["notes.md"] }, min(2)),
      call("e", { tool: "edit", op: "edit", paths: ["api.ts"], added: 2, removed: 1 }, min(3)),
      call("d", { tool: "edit", op: "edit", paths: ["old.ts"], added: 1, removed: 3 }, min(4)),
      call("p", { tool: "todo", op: "todo" }, min(5)),
      call("tasks", { tool: "edit", op: "edit", paths: ["specs/x/tasks.md"] }, min(6)),
      call("s", { tool: "Agent", op: "spawn" }, min(7)),
      call("c", { tool: "bash", op: "shell", command: "git commit -F msg.txt" }, min(8)),
      call("rm", { tool: "bash", op: "shell", command: "rm -f old.ts" }, min(9)),
      call("sh", { tool: "bash", op: "shell", command: "cd /work && git status" }, min(10)),
      { kind: "model", ts: min(11), model: "model-a", explicit: false },
      { kind: "model", ts: min(12), model: "model-b", explicit: true },
      { kind: "compaction", ts: min(13) },
      { kind: "api_error", ts: min(14), message: "外部错误", rateLimited: true },
      { kind: "api_error", ts: min(15), message: "外部错误", rateLimited: false },
      call("t", { tool: "bash", op: "shell", command: "npx vitest run" }, min(16)),
      result("t", true, min(17), 3),
      call("fix", { tool: "edit", op: "edit", paths: ["api.ts"], added: 2, removed: 1 }, min(18)),
    ];
    const session = state(events);
    const zh = deriveActions(session);
    const en = deriveActions(session, "en");
    expect(en.map(action => action.text)).toEqual([
      "Read api.ts", "Read grep", "Edit notes.md", "Edit api.ts +2 −1", "Delete old.ts", "Update todos", "Edit tasks.md",
      "Delegate", "Commit", "Delete old.ts", "Read git status", "Switch to model-b", "Compact context",
      "Rate limited, waiting", "API error", "vitest ✗ 3", "Fix api.ts",
    ]);
    expect(en.map(({ text: _text, ...action }) => action)).toEqual(zh.map(({ text: _text, ...action }) => action));
    expect(zh).toEqual(deriveActions(session, "zh-CN"));
    expect(en.at(-1)).toMatchObject({ kind: "rework", outcome: "pending", at: min(18) });
  });

  it("原文恰好等于程序词条或包含占位符时，仍不翻译原文", () => {
    const session = state([
      call("r", { tool: "read", op: "read", paths: ["D:/项目/压缩上下文.ts"] }, min(1)),
      call("p", { tool: "todo", op: "todo", todos: [{ text: "更新待办", status: "in_progress" }] }, min(2)),
      call("s", { tool: "Agent", op: "spawn", title: "派工" }, min(3)),
      call("q", { tool: "ask", op: "ask", title: "可能：回合结束" }, min(4)),
      call("c", { tool: "bash", op: "shell", command: 'git commit -m "提交"' }, min(5)),
      call("sh", { tool: "bash", op: "shell", command: 'printf "失败 {text}"' }, min(6)),
      { kind: "thinking", ts: min(7), text: "压缩上下文" },
      { kind: "text", ts: min(8), text: "最近：{actions}" },
      { kind: "model", ts: min(9), model: "初始模型", explicit: false },
      { kind: "model", ts: min(10), model: "限流，等待中", explicit: true },
      call("other", { tool: "成功", op: "other" }, min(11)),
    ]);
    expect(deriveActions(session, "en").map(action => action.text)).toEqual([
      "Read 压缩上下文.ts", "更新待办", "派工", "可能：回合结束", "提交", 'printf "失败 {text}"',
      "压缩上下文", "最近：{actions}", "Switch to 限流，等待中", "成功",
    ]);
  });

  it("英文前缀也先脱敏再截断，不泄露落在截断处的密钥", () => {
    const session = state([call("r", { tool: "read", op: "read", paths: [`${"a".repeat(28)} sk-proj-AbC123xyz456DEF789.ts`] }, min(1))]);
    const action = deriveActions(session, "en")[0];
    expect(action.text).toBe(`Read ${"a".repeat(28)} sk-**…`);
    expect(action.text).toHaveLength(40);
  });
});

describe("WINDOW-33：状态前缀本地化", () => {
  const status = (events: SiteEvent[], now = min(4), level = 1, locale: Locale = "en") => {
    const session = state(events, level);
    return sessionStatus(session, deriveActions(session, locale).at(-1) ?? null, now, DEFAULT_THRESHOLDS, locale);
  };

  it("提问和回合结束只翻译等待前缀，问题、详情和时间原样保留", () => {
    const question = "压缩上下文 {text}，继续吗？";
    const ask = call("q", { tool: "AskUserQuestion", op: "ask", title: question }, min(3));
    expect(status([ask], min(40), 2)).toEqual({ status: "waiting", since: min(3), text: `Possibly: ${question}`, detail: question, onSite: true });
    expect(status([{ kind: "text", ts: min(2), text: "提交好了。继续吗？" }, { kind: "turn_end", ts: min(3) }]))
      .toEqual({ status: "waiting", since: min(3), text: "Possibly: 继续吗？", detail: "提交好了。继续吗？", onSite: true });
    expect(status([{ kind: "text", ts: min(2), text: "回合结束" }, { kind: "turn_end", ts: min(3) }]).text).toBe("Possibly: 回合结束");
  });

  it("无问题原文时使用英文程序兜底，且不改变层级和阈值判定", () => {
    for (const title of [undefined, "", " \t\n "]) {
      expect(status([call("q", { tool: "AskUserQuestion", op: "ask", title }, min(3))], min(40), 2))
        .toEqual({ status: "waiting", since: min(3), text: "Possibly: AskUserQuestion", detail: null, onSite: true });
    }
    const ended: SiteEvent[] = [{ kind: "turn_end", ts: min(3) }];
    expect(status(ended)).toEqual({ status: "waiting", since: min(3), text: "Possibly: Turn ended", detail: null, onSite: true });
    expect(status(ended, min(4), 2).status).toBe("working");
    expect(status([{ kind: "text", ts: min(2), text: "！？" }, ...ended]).text).toBe("Possibly: Turn ended");
    const hang = [call("b", { tool: "bash", op: "shell", command: 'echo "压缩上下文"' }, min(0))];
    expect(status(hang, min(30))).toEqual({ status: "stalled", since: min(0), text: 'Stalled at: echo "压缩上下文"', detail: null, onSite: true });
    expect(status(hang, min(30) - 1).status).toBe("idle");
    expect(status(hang, min(10) - 1).status).toBe("working");
    expect(status(hang, min(24 * 60)).onSite).toBe(false);
  });

  it("拼好英文前缀后仍最多 40 字，详情仍先脱敏再截到 200 字", () => {
    const text = `${"甲".repeat(190)}ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5${"乙".repeat(50)}`;
    const events: SiteEvent[] = [{ kind: "text", ts: min(2), text }, { kind: "turn_end", ts: min(3) }];
    expect(status(events)).toMatchObject({ text: `Possibly: ${"甲".repeat(29)}…`, detail: `${"甲".repeat(190)}ghp_***${"乙".repeat(2)}…` });
    const session = state(events);
    expect(sessionStatus(session, null, min(4), DEFAULT_THRESHOLDS)).toEqual(status(events, min(4), 1, "zh-CN"));
    const command = "npm install lodash express react vue typescript eslint";
    expect(status([call("b", { tool: "bash", op: "shell", command }, min(0))], min(30)).text)
      .toBe(`Stalled at: ${command.slice(0, 27)}…`);
  });
});

describe("WINDOW-33：模型轨迹本地化", () => {
  it("结果和压缩说明有英文，事件类型、顺序与默认中文保持不变", () => {
    const events: SiteEvent[] = [
      result("a", true, 1), result("b", false, 2), result("c", true, 3, 2), result("d", false, 4, 3),
      { kind: "compaction", ts: 5 }, { kind: "turn_end", ts: 6 },
      { kind: "model", ts: 7, model: "implicit", explicit: false },
    ];
    expect(traceOf(events, "en").map(entry => entry.text)).toEqual(["Success", "Failed", "Failed 2", "Failed 3", "Compact context"]);
    expect(traceOf(events).map(entry => entry.text)).toEqual(["成功", "失败", "失败 2", "失败 3", "压缩上下文"]);
    expect(traceOf(events, "en").map(({ text: _text, ...entry }) => entry)).toEqual(traceOf(events).map(({ text: _text, ...entry }) => entry));
    expect(traceOf(events)).toEqual(traceOf(events, "zh-CN"));
  });

  it("用户对话、工具名/路径/命令、模型名和外部错误不翻译", () => {
    const events: SiteEvent[] = [
      { kind: "prompt", ts: 1, text: "可能：回合结束 {text}", from: "user" },
      { kind: "thinking", ts: 2, text: "压缩上下文" },
      { kind: "text", ts: 3, text: "成功" },
      call("r", { tool: "读取工具", op: "read", paths: ["D:/项目/失败.ts"] }, 4),
      call("b", { tool: "bash", op: "shell", command: 'echo "更新待办"' }, 5),
      { kind: "model", ts: 6, model: "模型原名", explicit: true },
      { kind: "api_error", ts: 7, message: "API 报错 sk-abcdefgh12345678", rateLimited: true },
    ];
    const trace = traceOf(events, "en");
    expect(trace.map(entry => entry.text)).toEqual([
      "可能：回合结束 {text}", "压缩上下文", "成功", "读取工具 · D:/项目/失败.ts", 'bash · echo "更新待办"', "模型原名", "API 报错 sk-***",
    ]);
    expect(trace).toEqual(traceOf(events));
  });

  it("仍只留最后 10 条，并在 160 字截断前脱敏", () => {
    const events: SiteEvent[] = Array.from({ length: 12 }, (_, i) => ({ kind: "text", ts: i, text: `原文 ${i}` }));
    events.push({ kind: "api_error", ts: 12, message: `${"甲".repeat(148)} sk-proj-AbC123xyz456DEF789 ${"乙".repeat(30)}`, rateLimited: false });
    const trace = traceOf(events, "en");
    expect(trace.map(entry => entry.at)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(trace.at(-1)?.text).toBe(`${"甲".repeat(148)} sk-*** ${"乙".repeat(3)}…`);
    expect(trace).toEqual(traceOf(events));
  });
});

describe("WINDOW-32/WINDOW-33：快照按 config.locale 逐层格式化", () => {
  it("英文最近动作、轨迹和等待前缀贯穿快照，原文和已有中文枚举保持原值", () => {
    const working = state([
      call("a", { tool: "read", op: "read", paths: ["a.ts"] }, min(1)),
      call("b", { tool: "read", op: "read", paths: ["b.ts"] }, min(2)),
      { kind: "compaction", ts: min(3) },
    ], 2);
    const waiting = applyEvents(newSession({ ...meta, key: "pi:waiting", nativeId: "waiting" }), [
      { kind: "text", ts: min(3), text: "可能：回合结束 {text}" }, { kind: "turn_end", ts: min(3) },
    ]);
    const site: SiteInput = { key: "site", path: "D:/项目", name: "中文工地", kind: "git", mini: false, backlog: ["提交"],
      features: [
        { name: "中文功能", specsDir: "D:/项目/specs/中文功能", card: { title: "用户标题", risk: "高", ac: 1, open: 1, openItems: ["派工"],
          slices: [{ id: "S1", title: "更新待办", current: true, done: false, steps: [{ text: "压缩上下文", done: false }] }] } },
        { name: "unreadable", specsDir: "D:/项目/specs/unreadable", error: "unreadable" },
        { name: "empty", specsDir: "D:/项目/specs/empty", card: { title: "原文", risk: "低", ac: 0, open: 0, openItems: [], slices: [] } },
      ], sessions: [working, waiting] };
    const input = { now: min(4), sites: [site], active: site.key, config, sources: { ...sources, pi: { ...sources.pi, lastError: "外部错误：失败 sk-abcdefgh12345678" } },
      diagnostics: ["外部诊断：成功 sk-abcdefgh12345678"] };
    const before = structuredClone(input);
    const zh = buildSnapshot(input);
    const en = buildSnapshot({ ...input, config: { ...config, locale: "en" } });
    const [worker, waiter] = en.sites[0].workers;
    expect(worker.statusDetail).toBe("Recent: Read a.ts; Read b.ts; Compact context");
    expect(worker.actions.map(action => action.text)).toEqual(["Read a.ts", "Read b.ts", "Compact context"]);
    expect(worker.trace.at(-1)?.text).toBe("Compact context");
    expect(waiter.bubble).toBe("Possibly: 可能：回合结束 {text}");
    expect(waiter.statusDetail).toBe("可能：回合结束 {text}");
    expect(en.sites[0].designer.waiting[0].text).toBe(waiter.bubble);
    expect(en.sites[0].bands).toEqual(zh.sites[0].bands);
    expect(en.sites[0].bands.map(band => band.tarp)).toEqual(["图纸未拆切片", "图纸读不出", null]);
    expect(en.sites[0].bands.find(band => band.feature === "中文功能")?.card).toMatchObject({ risk: "高", title: "用户标题", current: { title: "更新待办" } });
    expect(en.sites[0]).toMatchObject({ key: "site", name: "中文工地", path: "D:/项目", backlog: ["提交"], open: [{ feature: "用户标题", text: "派工" }] });
    expect(worker).toMatchObject({ key: meta.key, file: meta.file, cwd: meta.cwd, level: 2, role: "worker", status: "working", location: { kind: "gate" } });
    expect(en.sources.pi.lastError).toBe("外部错误：失败 sk-***");
    expect(en.diagnostics).toEqual([
      "外部诊断：成功 sk-***",
      "Feature 中文功能 is not in settings.json features; shown at the top as unclassified",
      "Feature unreadable is not in settings.json features; shown at the top as unclassified",
      "Feature empty is not in settings.json features; shown at the top as unclassified",
    ]);
    expect(zh).toEqual(buildSnapshot({ ...input, config: { ...config, locale: "zh-CN" } }));
    expect(input).toEqual(before);
  });

  it("会话待办仅翻译程序说明，在干概况优先保留回复原文", () => {
    const session = state([
      call("p", { tool: "todo", op: "todo", todos: [{ text: "更新待办", status: "in_progress" }] }, min(1)),
      { kind: "text", ts: min(2), text: "最近：提交" },
    ]);
    const site: SiteInput = { key: "site", path: "D:/项目", name: "中文工地", kind: "dir", mini: true, features: [], backlog: [], sessions: [session] };
    const snapshot = buildSnapshot({ now: min(3), sites: [site], active: site.key, config: { ...config, locale: "en" }, sources, diagnostics: [] });
    expect(snapshot.sites[0].workers[0]).toMatchObject({ attribution: { rule: "none", detail: "Session todos" },
      statusDetail: "最近：提交", todos: [{ text: "更新待办", status: "in_progress" }] });
    expect(snapshot.sites[0].bands[0].card.current?.title).toBe("更新待办");
    expect(snapshot.diagnostics).toEqual([]);
  });
});

describe("WINDOW-33：真实引擎诊断本地化（仅虚构临时日志）", () => {
  it("已有压缩读取器的程序错误也随引擎切换语言，不重置读取状态", async () => {
    const { engine, roots } = fixtureEngine("en");
    const file = path.join(roots.dsh, "project", "broken", "session.v4.jsonl.zstd");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not-a-zstd-frame");
    await engine.refresh();
    expect(engine.snapshot().sources.dsh.lastError).toBe("Invalid zstd frame header");
    await engine.setLocale("zh-CN");
    expect(engine.snapshot().sources.dsh.lastError).toBe("不是 zstd 帧头");
    await engine.setLocale("en");
    expect(engine.snapshot().sources.dsh.lastError).toBe("Invalid zstd frame header");
    expect(engine.snapshot().sources.dsh).toMatchObject({ sessions: 0, badLines: 0, unknownRecords: 0 });
  });

  it("缺 cwd、待办段数和层数上限诊断使用 settings.locale，缓存会话不改原文", async () => {
    const { engine, roots, settings } = fixtureEngine("en");
    const dir = mkTmpDir();
    settings.repos.push({ path: dir, name: "中文工地 {count}" });
    writeJsonl(piFile(roots.pi, "nocwd"), [piHeader("", { id: "nocwd-session", t: min(0) }), piUser("没有工作目录", min(1))]);
    for (let i = 0; i < 7; i++) {
      const todos = Array.from({ length: 13 }, (_, n) => ({ text: `更新待办 ${n}`, status: "pending" }));
      writeJsonl(piFile(roots.pi, `todo-${i}`), [piHeader(dir, { id: `todo-${i}`, t: min(0) }), piUser("提交", min(1)),
        piAssistant([{ type: "toolCall", id: "todo", name: "todo", arguments: { todos } }], { t: min(2) })]);
    }
    await engine.refresh();
    const en = engine.snapshot();
    expect(en.diagnostics).toEqual([
      "Session pi:nocwd-se has no working directory; not shown on a site",
      "中文工地 {count} has 7 sessions with todos; showing only the first 6 bands",
      "中文工地 {count} has 7 sessions with more than 12 todos; showing only the first 12 floors",
    ]);
    expect(en.sites[0].bands).toHaveLength(6);
    expect(en.sites[0].bands.every(band => band.plan?.floors.length === 12)).toBe(true);
    expect(en.sites[0].workers).toHaveLength(7);
    expect(en.sites[0].workers[0].todos?.[0].text).toBe("更新待办 0");
    expect(en.sources.pi).toMatchObject({ sessions: 7, badLines: 0, unknownRecords: 0 });

    const pushed: string[][] = [];
    const unsubscribe = engine.onSnapshot(snapshot => pushed.push(snapshot.diagnostics));
    await engine.setLocale("zh-CN");
    expect(pushed).toHaveLength(1);
    expect(engine.snapshot().diagnostics).toEqual([
      "会话 pi:nocwd-se 没有工作目录，没上工地",
      "中文工地 {count} 有 7 个带待办的会话，只画前 6 段",
      "中文工地 {count} 有 7 个会话的待办超过 12 条，只画前 12 层",
    ]);
    await engine.setLocale("en");
    expect(pushed).toHaveLength(2);
    expect(engine.snapshot()).toEqual(en);
    unsubscribe();
  });

  it("工地上限与排序不变；英文列表分隔符不替换项目名内的中文标点，缺 locale 默认中文", async () => {
    const { engine, roots, settings } = fixtureEngine("en");
    const base = mkTmpDir();
    const dirs = Array.from({ length: 14 }, (_, i) => path.join(base, i === 0 ? "中文、项目" : i === 1 ? "另一个项目" : `site-${i}`));
    dirs.forEach((dir, i) => {
      mkdirSync(dir);
      writeJsonl(piFile(roots.pi, `site-${i}`), [piHeader(dir, { id: `site-${i}`, t: min(0) }), piUser("开工", min(i))]);
    });
    await engine.refresh();
    const en = engine.snapshot();
    expect(en.sites).toHaveLength(12);
    expect(en.sites.map(site => site.path).sort()).toEqual(dirs.slice(2).sort());
    expect(en.active).toBe(dirs[13]);
    expect(en.diagnostics).toEqual(["More than 12 sites; showing the 12 most recently active. Not shown: 另一个项目, 中文、项目"]);
    settings.locale = undefined;
    await engine.refresh();
    expect(engine.snapshot().diagnostics).toEqual(["工地超过 12 个，按最近活动只画前 12 个：另一个项目、中文、项目 没画"]);
    expect(engine.snapshot().sites).toEqual(en.sites);
    expect(engine.snapshot().active).toBe(en.active);
  });
});
