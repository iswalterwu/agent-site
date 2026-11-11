import { expect, it } from "vitest";
import { currentSiteKey, pauseIntent, SHORTCUTS, siteSessions } from "../../src/app/shortcuts";
import type { BridgeSessionView } from "../../src/main/bridge-service";
import type { SiteSnapshot, SiteView, Worker } from "../../src/core/types";

const worker = (key: string): Worker => ({
  key, harness: "pi", nativeId: key, level: 1, parentKey: null, readOnly: false,
  role: "worker", roleReason: "model", model: null, modelFamily: "other",
  location: { kind: "band", feature: "data", floor: "1" }, attribution: { feature: "data", rule: "specs", floor: "1", detail: "" },
  status: "working", statusSince: 0, bubble: "", statusDetail: null, trace: [], actions: [], todos: null,
  lastTestFailure: null, startedAt: 0, lastEventAt: 0, lastUserAt: null, file: `${key}.jsonl`, cwd: "D:/r",
});
const site = (key: string, keys: string[]): SiteView => ({
  key, path: `D:/${key}`, name: key, kind: "git", mini: false, bands: [], open: [], backlog: [], office: [], designer: { waiting: [] },
  workers: keys.map(worker),
});
const snapshot = (sites: SiteView[], active: string | null): SiteSnapshot => ({ at: 0, sites, active,
  sources: { pi: { root: "", present: true, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null },
    claude: { root: "", present: false, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null },
    dsh: { root: "", present: false, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null } },
  diagnostics: [] });
const session = (key: string, paused = false, controllable = true): BridgeSessionView => ({
  key, sessionId: key, info: { id: key, cwd: "D:/r", level: 1, startedAt: "2026-11-04T08:00:00.000Z", mode: "print" },
  online: true, paused, holding: null, idle: true, controllable,
});

it("WINDOW-23：当前工地默认跟快照的当前工地；钉住的工地在快照里就听钉住的，消失了才回退", () => {
  const snap = snapshot([site("a", []), site("b", [])], "a");
  expect(currentSiteKey(snap, null)).toBe("a");
  expect(currentSiteKey(snap, "b")).toBe("b");
  expect(currentSiteKey(snap, "gone")).toBe("a");
});
it("WINDOW-23：挑会话要用未过滤的快照——可见投影藏掉的旧会话只要桥接在线、能控制，也要算进来", () => {
  // 可见投影只留最近 6 小时有动静的会话；这里的小人 lastEventAt 是 8 小时前，但桥接还连着、还暂停着
  const snap = snapshot([site("a", ["pi:old", "pi:new"])], "a");
  snap.sites[0]!.workers[0] = { ...snap.sites[0]!.workers[0]!, lastEventAt: 0 };
  const sessions = [session("pi:old", true), session("pi:new")];
  expect(siteSessions(snap, sessions, "a").map(s => s.key)).toEqual(["pi:old", "pi:new"]);
  // 有一个还暂停着：快捷键该做的是全部继续，而不是把新的那个也暂停
  expect(pauseIntent(siteSessions(snap, sessions, "a"))).toBe("resume");
});
it("WINDOW-23：只挑这个工地上的、能控制的会话；别的工地和三级会话都不算", () => {
  const snap = snapshot([site("a", ["pi:1", "pi:2"]), site("b", ["pi:3"])], "a");
  const sessions = [session("pi:1"), session("pi:2", false, false), session("pi:3"), session("pi:9")];
  expect(siteSessions(snap, sessions, "a").map(s => s.key)).toEqual(["pi:1"]);
  expect(siteSessions(snap, sessions, "b").map(s => s.key)).toEqual(["pi:3"]);
  expect(siteSessions(snap, sessions, null)).toEqual([]);
  expect(siteSessions(snap, sessions, "gone")).toEqual([]);
});
it("WINDOW-23：有人暂停就全部继续，否则全部暂停；没有能控制的会话时什么都不做", () => {
  expect(pauseIntent([])).toBe("none");
  expect(pauseIntent([session("pi:1"), session("pi:2")])).toBe("pause");
  expect(pauseIntent([session("pi:1"), session("pi:2", true)])).toBe("resume");
  expect(pauseIntent([session("pi:1", true)])).toBe("resume");
});
it("WINDOW-23：两个键位就是 Ctrl/⌘+Alt+S 和 Ctrl/⌘+Alt+P", () => {
  expect(SHORTCUTS).toEqual({ toggleWindow: "CommandOrControl+Alt+S", pauseSite: "CommandOrControl+Alt+P" });
});
