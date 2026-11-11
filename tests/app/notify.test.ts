import { expect, it } from "vitest";
import type { SiteSnapshot, SiteView, Worker } from "../../src/core/types";
import { planNotices, SEEN_TTL_MS } from "../../src/app/notify";
import type { NotifyInput } from "../../src/app/notify";
import type { BridgeAsk } from "../../src/main/bridge-service";

const worker = (key: string): Worker => ({
  key, harness: "pi", nativeId: key, level: 1, parentKey: null, readOnly: false,
  role: "worker", roleReason: "model", model: null, modelFamily: "other",
  location: { kind: "band", feature: "data", floor: "1" }, attribution: { feature: "data", rule: "specs", floor: "1", detail: "" },
  status: "waiting", statusSince: 0, bubble: "", statusDetail: null, trace: [], actions: [], todos: null,
  lastTestFailure: null, startedAt: 0, lastEventAt: 0, lastUserAt: null, file: `${key}.jsonl`, cwd: "D:/r",
});
const site = (name: string, keys: string[]): SiteView => ({
  key: name, path: `D:/${name}`, name, kind: "git", mini: false, bands: [], open: [], backlog: [], office: [], designer: { waiting: [] },
  workers: keys.map(worker),
});
const snapshot = (sites: SiteView[]): SiteSnapshot => ({ at: 0, sites, active: sites[0]?.key ?? null,
  sources: { pi: { root: "", present: true, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null },
    claude: { root: "", present: false, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null },
    dsh: { root: "", present: false, sessions: 0, badLines: 0, unknownRecords: 0, lastError: null } },
  diagnostics: [] });
const ask = (askId: string, sessionKey: string, question = "用哪个方案？"): BridgeAsk =>
  ({ askId, sessionKey, sessionId: sessionKey, question, options: ["A", "B"], allowOther: true, at: 0 });

const plan = (input: Partial<NotifyInput> & Pick<NotifyInput, "asks">) => planNotices({
  snapshot: snapshot([site("购物车", ["pi:a"])]), seen: new Map(), focused: false, demo: false, dnd: false, now: 0, ...input,
});

it("WINDOW-22：窗口没有焦点时，新的决策提问各弹一条，标题带工地名，正文是问题", () => {
  expect(plan({ asks: [ask("q1", "pi:a")] }).notices)
    .toEqual([{ askId: "q1", title: "等你回答 · 购物车", body: "用哪个方案？" }]);
});
it("WINDOW-22：窗口有焦点就不弹，但这几条照样记成\"见过\"——失焦之后不会补弹旧问题", () => {
  const first = plan({ asks: [ask("q1", "pi:a")], focused: true });
  expect(first.notices).toEqual([]);
  expect([...first.seen.keys()]).toEqual(["q1"]);
  // 失焦后的一次普通快照：问题还在，但已经见过，不再弹
  expect(plan({ asks: [ask("q1", "pi:a")], seen: first.seen, now: 1000 }).notices).toEqual([]);
});
it("WINDOW-22：同一条只弹一次；断线清空后重发、久坐、休眠很久再重连，都不再弹", () => {
  // 每轮把上一轮输出的记录传下去，模拟真实调度
  const first = plan({ asks: [ask("q1", "pi:a")] });
  expect(first.notices).toHaveLength(1);
  const still = plan({ asks: [ask("q1", "pi:a")], seen: first.seen, now: 5000 });
  expect(still.notices).toEqual([]);
  const gone = plan({ asks: [], seen: still.seen, now: 6000 }); // 断线：列表空了，缺席从这一刻起算
  expect(gone.notices).toEqual([]);
  expect([...gone.seen.keys()]).toEqual(["q1"]); // 记录还在，等着它可能重发
  const back = plan({ asks: [ask("q1", "pi:a")], seen: gone.seen, now: 7000 }); // 重连重发
  expect(back.notices).toEqual([]);
  // 一条长时间没消失的提问不会因为"满一小时"被判成新来的：记录每轮续命
  const long = plan({ asks: [ask("q1", "pi:a")], seen: back.seen, now: SEEN_TTL_MS * 2 });
  expect(long.notices).toEqual([]);
  // 机器休眠了两个小时：醒来先看到断线、一秒后重连。缺席只算一秒，不能重弹
  const asleep = plan({ asks: [], seen: long.seen, now: SEEN_TTL_MS * 4 });
  const awake = plan({ asks: [ask("q1", "pi:a")], seen: asleep.seen, now: SEEN_TTL_MS * 4 + 1000 });
  expect(awake.notices).toEqual([]);
  // 真的消失满一小时之后才重新出现（比如换了会话却复用了 askId）：值得再提醒
  const expired = plan({ asks: [], seen: asleep.seen, now: SEEN_TTL_MS * 5 + 1 });
  expect([...expired.seen.keys()]).toEqual([]);
  expect(plan({ asks: [ask("q1", "pi:a")], seen: expired.seen, now: SEEN_TTL_MS * 5 + 2 }).notices).toHaveLength(1);
});
it("WINDOW-22：断线 → 重连 → 再断线：缺席从最后一次消失算，满一小时才忘；多个 askId 各算各的", () => {
  let state = plan({ asks: [ask("q1", "pi:a"), ask("q2", "pi:b")], now: 0 });
  expect(state.notices.map(n => n.askId)).toEqual(["q1", "q2"]);
  state = plan({ asks: [ask("q1", "pi:a")], seen: state.seen, now: 1000 }); // q2 消失，q1 还在
  expect(state.notices).toEqual([]);
  state = plan({ asks: [ask("q1", "pi:a"), ask("q2", "pi:b")], seen: state.seen, now: 2000 }); // q2 回来了
  expect(state.notices).toEqual([]); // 见过就是见过
  state = plan({ asks: [], seen: state.seen, now: 3000 }); // 再断线：两条都从这一刻起算
  expect(state.notices).toEqual([]);
  state = plan({ asks: [], seen: state.seen, now: 3000 + SEEN_TTL_MS - 1 });
  expect([...state.seen.keys()].sort()).toEqual(["q1", "q2"]); // 还差一秒
  state = plan({ asks: [], seen: state.seen, now: 3000 + SEEN_TTL_MS });
  expect([...state.seen.keys()]).toEqual([]); // 恰好满一小时：忘掉
  // 输入不被修改：planNotices 每次都返回新 Map
  const before = new Map(state.seen);
  plan({ asks: [ask("q3", "pi:a")], seen: before, now: 9000 });
  expect([...before.keys()]).toEqual([]);
});
it("WINDOW-22：有焦点时登记、之后一直有焦点、跨过很久再失焦：旧问题仍然不补弹", () => {
  let state = plan({ asks: [ask("q1", "pi:a")], focused: true, now: 0 });
  expect(state.notices).toEqual([]);
  state = plan({ asks: [ask("q1", "pi:a")], seen: state.seen, focused: true, now: SEEN_TTL_MS * 3 });
  expect(state.notices).toEqual([]);
  state = plan({ asks: [ask("q1", "pi:a")], seen: state.seen, focused: true, now: SEEN_TTL_MS * 3 + 1000 });
  expect(state.notices).toEqual([]);
  const unfocused = plan({ asks: [ask("q1", "pi:a")], seen: state.seen, focused: false, now: SEEN_TTL_MS * 3 + 2000 });
  expect(unfocused.notices).toEqual([]);
});
it("WINDOW-22：小人不在当前工地时用\"工地\"当名字；勿扰不弹；演示模式不给正文", () => {
  expect(plan({ asks: [ask("q9", "pi:gone")] }).notices)
    .toEqual([{ askId: "q9", title: "等你回答 · 工地", body: "用哪个方案？" }]);
  expect(plan({ asks: [ask("q1", "pi:a")], dnd: true }).notices).toEqual([]);
  expect(plan({ asks: [ask("q1", "pi:a")], demo: true }).notices)
    .toEqual([{ askId: "q1", title: "等你回答 · 购物车", body: "演示模式已隐藏决策内容" }]);
});
it("WINDOW-22：正文脱敏、按码点截断（emoji 不会被劈开），记录只留还活着的提问", () => {
  // emoji 正好落在截断边界上：按 UTF-16 下标切会把它劈成半个
  const long = `带走的令牌 Bearer sk-live-123456 ${"啊".repeat(118)}😀后后`;
  const [notice] = plan({ asks: [ask("q1", "pi:a", long)] }).notices;
  expect(notice?.body).not.toContain("sk-live-123456");
  expect([...(notice?.body ?? "")].length).toBeLessThanOrEqual(120);
  // 没有落单的代理项：按 UTF-16 下标切会把 emoji 劈成半个
  const lone = [...(notice?.body ?? "")].some(ch => { const code = ch.codePointAt(0) ?? 0; return code >= 0xd800 && code <= 0xdfff; });
  expect(lone).toBe(false);
  // 决策结束（ask_resolved）之后，记录从"消失那一刻"起再留一小时（防断线重发），过期就忘掉
  const first = plan({ asks: [ask("q1", "pi:a")] });
  const resolved = plan({ asks: [], seen: first.seen, now: 1000 });
  expect([...resolved.seen.keys()]).toEqual(["q1"]);
  expect([...plan({ asks: [], seen: resolved.seen, now: 1000 + SEEN_TTL_MS - 1 }).seen.keys()]).toEqual(["q1"]);
  expect([...plan({ asks: [], seen: resolved.seen, now: 1000 + SEEN_TTL_MS }).seen.keys()]).toEqual([]);
});

// ---- 状态提醒（WINDOW-25）----
import { planAlerts } from "../../src/app/notify";
import type { AlertInput } from "../../src/app/notify";
import type { BridgeSessionView } from "../../src/main/bridge-service";

const withStatus = (s: SiteView, status: Worker["status"], bubble = ""): SiteView => ({
  ...s, workers: s.workers.map(w => ({ ...w, status, bubble })),
});
const offline = (key: string, paused: boolean): BridgeSessionView => ({
  key, sessionId: key, info: { id: key, cwd: "D:/r", level: 1, startedAt: "2026-11-04T08:00:00Z", mode: "print" },
  online: false, paused, holding: null, idle: true, controllable: false,
});
const alerts = (input: Partial<AlertInput> & Pick<AlertInput, "snapshot">) => planAlerts({
  asks: [], sessions: [], paused: new Set(), active: new Set(), focused: false, demo: false, dnd: false, ...input,
});

it("WINDOW-25：进入\"等你\"那一轮弹一次，一直等着不再弹；解除后再进入才重新弹", () => {
  const waiting = snapshot([withStatus(site("购物车", ["pi:a"]), "waiting", "要提交吗？")]);
  const first = alerts({ snapshot: waiting });
  expect(first.alerts).toEqual([{ key: "pi:a:waiting", title: "等你 · 购物车", body: "要提交吗？" }]);
  // 还在等：不重复
  const again = alerts({ snapshot: waiting, active: first.active });
  expect(again.alerts).toEqual([]);
  expect([...again.active]).toEqual(["pi:a:waiting"]);
  // 不等着了：解除
  const done = alerts({ snapshot: snapshot([withStatus(site("购物车", ["pi:a"]), "working")]), active: again.active });
  expect(done.alerts).toEqual([]);
  expect([...done.active]).toEqual([]);
  // 再进入：重新弹
  expect(alerts({ snapshot: waiting, active: done.active }).alerts).toHaveLength(1);
});
it("WINDOW-25：有悬着决策的会话不算\"等你\"（那条提问自己会弹）；中途断掉和断线时暂停着各有提醒", () => {
  const waiting = snapshot([withStatus(site("购物车", ["pi:a"]), "waiting", "要提交吗？")]);
  expect(alerts({ snapshot: waiting, asks: [ask("q1", "pi:a")] }).alerts).toEqual([]);
  const stalled = snapshot([withStatus(site("购物车", ["pi:a"]), "stalled")]);
  expect(alerts({ snapshot: stalled }).alerts)
    .toEqual([{ key: "pi:a:stalled", title: "停住了 · 购物车", body: "中途断掉了" }]);
  // 暂停中掉线：断线的会话会从 sessions() 整条消失，所以要看上一轮"在线且暂停"的名单
  const working = snapshot([withStatus(site("购物车", ["pi:a"]), "working")]);
  expect(alerts({ snapshot: working, sessions: [offline("pi:a", true)], paused: new Set(["pi:a"]) }).alerts
    .map(a => a.key)).toEqual(["pi:a:offline-paused"]);
  expect(alerts({ snapshot: working, sessions: [offline("pi:a", true)], paused: new Set(["pi:a"]) }).alerts[0])
    .toMatchObject({ title: "断线 · 购物车", body: "暂停中的会话掉线了" });
  // 还连着的暂停会话不算断线；没暂停过的断线也不提醒
  const online = { ...offline("pi:a", true), online: true };
  expect(alerts({ snapshot: working, sessions: [online], paused: new Set(["pi:a"]) }).alerts).toEqual([]);
  expect(alerts({ snapshot: working, sessions: [], paused: new Set() }).alerts).toEqual([]);
});
it("WINDOW-25：断线只提醒一次——掉线那一轮之后名单里就没它了", () => {
  const working = snapshot([withStatus(site("购物车", ["pi:a"]), "working")]);
  const first = alerts({ snapshot: working, sessions: [], paused: new Set(["pi:a"]) });
  expect(first.alerts.map(a => a.key)).toEqual(["pi:a:offline-paused"]);
  expect([...first.paused]).toEqual([]);
  expect(alerts({ snapshot: working, sessions: [], paused: first.paused, active: first.active }).alerts).toEqual([]);
  // 回到在线且暂停着、之后再掉线：再提醒一次
  const back = alerts({ snapshot: working, sessions: [{ ...offline("pi:a", true), online: true }], paused: first.paused, active: first.active });
  expect([...back.paused]).toEqual(["pi:a"]);
  expect(alerts({ snapshot: working, sessions: [], paused: back.paused, active: back.active }).alerts).toHaveLength(1);
});
it("WINDOW-25：决策悬着时不弹\"等你\"，决策结束后也不补弹；真正退出等你状态再进入才弹", () => {
  const waiting = snapshot([withStatus(site("购物车", ["pi:a"]), "waiting", "要提交吗？")]);
  // 第一轮就带着决策：记成"已在等"，不弹
  const withAsk = alerts({ snapshot: waiting, asks: [ask("q1", "pi:a")] });
  expect(withAsk.alerts).toEqual([]);
  expect([...withAsk.active]).toEqual(["pi:a:waiting"]);
  // 决策结束、快照还没变：仍然不补弹
  expect(alerts({ snapshot: waiting, active: withAsk.active }).alerts).toEqual([]);
  // 真的离开等待状态：解除
  const done = alerts({ snapshot: snapshot([withStatus(site("购物车", ["pi:a"]), "working")]), active: withAsk.active });
  expect([...done.active]).toEqual([]);
  expect(alerts({ snapshot: waiting, active: done.active }).alerts).toHaveLength(1);
});
it("WINDOW-25：有焦点、勿扰时不弹但照样记成\"已经在提醒\"；演示模式给占位正文", () => {
  const stalled = snapshot([withStatus(site("购物车", ["pi:a"]), "stalled")]);
  const focused = alerts({ snapshot: stalled, focused: true });
  expect(focused.alerts).toEqual([]);
  expect([...focused.active]).toEqual(["pi:a:stalled"]); // 失焦后不补弹
  expect(alerts({ snapshot: stalled, active: focused.active }).alerts).toEqual([]);
  expect(alerts({ snapshot: stalled, dnd: true }).alerts).toEqual([]);
  expect(alerts({ snapshot: stalled, demo: true }).alerts[0]?.body).toBe("演示模式已隐藏决策内容");
});
