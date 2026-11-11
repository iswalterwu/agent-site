import { expect, it } from "vitest";
import { applyEvents, FIRST_PROMPT_MAX, newSession } from "../../src/core/session";
import type { SiteEvent } from "../../src/core/types";
import { call, meta, result } from "../fixtures/events";
import { min } from "../fixtures/logs";

it("环形缓冲：只留最近 200 条事件、最近 20 次工具调用", () => {
  const texts: SiteEvent[] = Array.from({ length: 250 }, (_, i) => ({ kind: "text", ts: min(i), text: `t${i}` }));
  const calls = Array.from({ length: 25 }, (_, i) => call(`c${i}`, { tool: "read", op: "read", paths: [`f${i}`] }, min(300 + i)));
  const s = applyEvents(newSession(meta), [...texts, ...calls]);
  expect(s.events).toHaveLength(200);
  expect(s.calls.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i + 5}`));
  expect(s.lastEventAt).toBe(min(324));
});
// CONTROL-12：site_todo 的 toolResult details 更新会话待办
it("site_todo 的调用参数不写待办，结果 details 才写", () => {
  const callOnly = applyEvents(newSession(meta), [call("t", { tool: "site_todo", op: "todo",
    todos: [{ text: "被拒", status: "pending" }] }, min(1))]);
  expect(callOnly.todos).toBeUndefined();
  const withResult = applyEvents(newSession(meta), [
    call("t", { tool: "site_todo", op: "todo", todos: [{ text: "被拒", status: "pending" }] }, min(1)),
    { kind: "tool_result", ts: min(2), id: "t", ok: true, todos: [{ text: "读图纸", status: "in_progress" }] },
  ]);
  expect(withResult.todos).toEqual([{ text: "读图纸", status: "in_progress" }]);
});
it("结果挂到对应的调用上；找不到调用的结果不影响调用列表", () => {
  const s = applyEvents(newSession(meta), [call("a", { tool: "read", op: "read" }, min(1)), result("a", false, min(2), 1), result("zz", true, min(3))]);
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0].result).toEqual({ ts: min(2), ok: false, failed: 1 });
});
it("只记第一条提示；模型取最新；待办取最近一次待办调用", () => {
  const s = applyEvents(newSession(meta), [
    { kind: "prompt", ts: min(1), text: "# a Plan", from: "user" }, { kind: "prompt", ts: min(2), text: "再看看", from: "user" },
    { kind: "model", ts: min(3), model: "m1", explicit: false }, { kind: "model", ts: min(4), model: "m2", explicit: false },
    call("d", { tool: "todo_write", op: "todo", todos: [{ text: "x", status: "pending" }] }, min(5))]);
  expect([s.firstPrompt, s.model, s.todos]).toEqual(["# a Plan", "m2", [{ text: "x", status: "pending" }]]);
});

// ---- 以下是 brief 之外补的用例 ----

it("新会话：事件与调用为空，lastEventAt 是开始时间；没有的字段真的缺席", () => {
  expect(newSession(meta)).toStrictEqual({ meta, events: [], calls: [], lastEventAt: min(0) });
  expect(applyEvents(newSession(meta), [{ kind: "turn_end", ts: min(1) }])).toStrictEqual(
    { meta, events: [{ kind: "turn_end", ts: min(1) }], calls: [], lastEventAt: min(1) });
});
it("lastEventAt 只增不减；第一条提示截到 4000 字", () => {
  const s = applyEvents(newSession(meta), [{ kind: "prompt", ts: min(5), text: "派".repeat(5000), from: "agent" },
    { kind: "text", ts: min(3), text: "晚到的旧事件" }]);
  expect(s.lastEventAt).toBe(min(5));
  expect(s.firstPrompt).toHaveLength(FIRST_PROMPT_MAX);
  expect(s.firstPrompt?.endsWith("…")).toBe(true);
  expect(applyEvents(s, [{ kind: "prompt", ts: min(6), text: "后来的提示", from: "user" }]).firstPrompt).toBe(s.firstPrompt);
});
it("待办调用不带列表时保留原来的待办；空列表是真的清空（E2）", () => {
  const listed = applyEvents(newSession(meta), [call("d1", { tool: "TodoWrite", op: "todo", todos: [{ text: "x", status: "in_progress" }] }, min(1))]);
  const advanced = applyEvents(listed, [call("d2", { tool: "mcp__ccd_turn__update_plan", op: "todo" }, min(2))]);
  expect(advanced.todos).toEqual([{ text: "x", status: "in_progress" }]);
  expect(applyEvents(advanced, [call("d3", { tool: "TodoWrite", op: "todo", todos: [] }, min(3))]).todos).toEqual([]);
});
it("applyEvents 返回新对象，不改入参（状态、调用和事件列表都不动）", () => {
  const before = applyEvents(newSession(meta), [call("a", { tool: "read", op: "read", paths: ["x"] }, min(1))]);
  const beforeCopy = structuredClone(before);
  const batch: SiteEvent[] = [result("a", true, min(2)), { kind: "prompt", ts: min(3), text: "hi", from: "user" },
    { kind: "model", ts: min(4), model: "m", explicit: false }, call("d", { tool: "TodoWrite", op: "todo", todos: [] }, min(5))];
  const batchCopy = structuredClone(batch);
  const after = applyEvents(before, batch);
  expect(before).toStrictEqual(beforeCopy);
  expect(batch).toStrictEqual(batchCopy);
  expect(after).not.toBe(before);
  expect(after.calls[0].result).toEqual({ ts: min(2), ok: true });
  expect(before.calls[0].result).toBeUndefined();
});
it("分批喂和一次喂结果相同，包括结果对应的调用已被挤出缓冲的情况", () => {
  const events: SiteEvent[] = [
    ...Array.from({ length: 25 }, (_, i) => call(`c${i}`, { tool: "read", op: "read", paths: [`f${i}`] }, min(i))),
    result("c0", true, min(30)), result("c10", false, min(31), 2)];
  const once = applyEvents(newSession(meta), events);
  const stepwise = events.reduce((s, ev) => applyEvents(s, [ev]), newSession(meta));
  expect(stepwise).toStrictEqual(once);
  expect(once.calls.find((c) => c.id === "c10")?.result).toEqual({ ts: min(31), ok: false, failed: 2 });
  expect(once.calls.some((c) => c.id === "c0")).toBe(false);
});
