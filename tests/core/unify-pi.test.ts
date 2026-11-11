import { expect, it } from "vitest";
import { countLines, failedCount, textOf, toTodos } from "../../src/core/unify/common";
import { readPiHeader, unifyPi } from "../../src/core/unify/pi";
import { min, piAssistant, piHeader, piModelChange, piResult, piUser } from "../fixtures/logs";

const CWD = "D:/work/example";
it("头行给出会话 ID、工作目录和开始时间", () => {
  expect(readPiHeader(piHeader(CWD, { id: "s-1", t: min(0) }))).toEqual({ id: "s-1", cwd: CWD, startedAt: min(0) });
  expect(readPiHeader(piUser("hi"))).toBeNull();
});
it("用户消息：文本块和字符串两种写法", () => {
  expect(unifyPi(piUser("# agent-dock Plan R1：写计划", min(1))))
    .toEqual([{ kind: "prompt", ts: min(1), text: "# agent-dock Plan R1：写计划", from: "user" }]);
  const asString = { ...piUser("x", min(1)), message: { role: "user", content: "纯文本", timestamp: min(1) } };
  expect(unifyPi(asString)).toEqual([{ kind: "prompt", ts: min(1), text: "纯文本", from: "user" }]);
});
it("助手消息：先报模型，再按块报；还要调工具时不算回合结束", () => {
  const rec = piAssistant([{ type: "thinking", thinking: "先看看" }, { type: "text", text: "改一下" },
    { type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/a.ts",
      edits: [{ oldText: "a", newText: "a\nb" }, { oldText: "c\nd", newText: "e" }] } }], { model: "deepseek-flash", t: min(2) });
  expect(unifyPi(rec)).toEqual([
    { kind: "model", ts: min(2), model: "deepseek-flash", explicit: false },
    { kind: "thinking", ts: min(2), text: "先看看" },
    { kind: "text", ts: min(2), text: "改一下" },
    { kind: "tool_call", ts: min(2), id: "c1", call: { tool: "edit", op: "edit", paths: ["src/a.ts"], added: 3, removed: 3 } }]);
});
it("edits 是 JSON 字符串时照样数行；write 只有新增", () => {
  const edits = JSON.stringify([{ oldText: "x", newText: "y\nz" }]);
  expect(unifyPi(piAssistant([{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "b.ts", edits } }]))?.[1])
    .toMatchObject({ call: { op: "edit", added: 2, removed: 1 } });
  expect(unifyPi(piAssistant([{ type: "toolCall", id: "c3", name: "write", arguments: { path: "n.ts", content: "1\n2\n3\n" } }]))?.[1])
    .toMatchObject({ call: { tool: "write", op: "write", paths: ["n.ts"], added: 3, removed: 0 } });
});
it("bash 是 shell，read / grep 是读和搜索", () => {
  const ev = unifyPi(piAssistant([{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "npx vitest run" } },
    { type: "toolCall", id: "c5", name: "read", arguments: { path: "specs/x/plan.md" } },
    { type: "toolCall", id: "c6", name: "grep", arguments: { pattern: "foo", path: "src" } }]));
  expect(ev?.slice(1).map((e) => e.kind === "tool_call" && [e.call.op, e.call.command ?? e.call.paths[0]]))
    .toEqual([["shell", "npx vitest run"], ["read", "specs/x/plan.md"], ["search", "src"]]);
});
it("stop / error 结束回合；error 带 API 报错与限流判断", () => {
  expect(unifyPi(piAssistant([{ type: "text", text: "好了" }], { t: min(3) }))?.at(-1)).toEqual({ kind: "turn_end", ts: min(3) });
  expect(unifyPi(piAssistant([], { stop: "error", error: "429 Too Many Requests", t: min(4) }))?.slice(-2)).toEqual([
    { kind: "api_error", ts: min(4), message: "429 Too Many Requests", rateLimited: true }, { kind: "turn_end", ts: min(4) }]);
});
it("工具结果：isError 决定成败，文本里的“N failed”记为失败数", () => {
  expect(unifyPi(piResult("c4", "bash", { error: true, text: "3 failed, 10 passed", t: min(5) })))
    .toEqual([{ kind: "tool_result", ts: min(5), id: "c4", ok: false, failed: 3 }]);
  expect(unifyPi(piResult("c5", "read", { t: min(5) }))).toEqual([{ kind: "tool_result", ts: min(5), id: "c5", ok: true }]);
});
it("模型切换、压缩、认得但不用的条目、陌生条目", () => {
  const ts = new Date(min(7)).toISOString();
  expect(unifyPi(piModelChange("gpt-6-astra", "openai", min(6)))).toEqual([{ kind: "model", ts: min(6), model: "gpt-6-astra", explicit: true }]);
  expect(unifyPi({ type: "compaction", id: "k", parentId: "p", timestamp: ts, summary: "…", firstKeptEntryId: "k", tokensBefore: 1 }))
    .toEqual([{ kind: "compaction", ts: min(7) }]);
  expect(unifyPi({ type: "label", id: "l", parentId: "p", timestamp: ts, targetId: "x", label: "y" })).toEqual([]);
  expect(unifyPi({ type: "mystery", id: "m" })).toBeNull();
  expect(unifyPi("not an object")).toBeNull();
});

// ---- 入口校验与共用小件 ----

it("搜索没给路径就不放；不认识的工具记为 other", () => {
  const ev = unifyPi(piAssistant([{ type: "toolCall", id: "d1", name: "find", arguments: { pattern: "*.ts" } },
    { type: "toolCall", id: "d2", name: "subagent", arguments: { task: "审一下", path: "specs" } }], { t: min(8) }));
  expect(ev?.slice(1)).toEqual([
    { kind: "tool_call", ts: min(8), id: "d1", call: { tool: "find", op: "search", paths: [] } },
    { kind: "tool_call", ts: min(8), id: "d2", call: { tool: "subagent", op: "other", paths: [] } }]);
});
it("类型不对的参数当作没有；坏的 edits 按空数组；任何输入都不抛出", () => {
  const ev = unifyPi(piAssistant([{ type: "toolCall", id: "e1", name: "read", arguments: { path: 42 } },
    { type: "toolCall", id: "e2", name: "bash", arguments: { command: ["ls"] } },
    { type: "toolCall", id: "e3", name: "edit", arguments: { path: "a.ts", edits: "{坏的" } }], { t: min(9) }));
  expect(ev?.slice(1)).toEqual([
    { kind: "tool_call", ts: min(9), id: "e1", call: { tool: "read", op: "read", paths: [] } },
    { kind: "tool_call", ts: min(9), id: "e2", call: { tool: "bash", op: "shell", paths: [] } },
    { kind: "tool_call", ts: min(9), id: "e3", call: { tool: "edit", op: "edit", paths: ["a.ts"], added: 0, removed: 0 } }]);
  const ts = new Date(min(9)).toISOString();
  // 认得的条目但时间读不出：没东西可报
  expect(unifyPi({ ...piUser("x"), timestamp: "昨天" })).toEqual([]);
  // 块不是数组、没有模型、还要调工具：什么都不报
  expect(unifyPi({ type: "message", timestamp: ts, message: { role: "assistant", content: "块", stopReason: "toolUse" } })).toEqual([]);
  const odd: unknown[] = [null, 1, [], {}, { type: "message" }, { type: "message", timestamp: ts, message: "x" },
    { type: "message", timestamp: ts, message: { role: "assistant", content: [null, 1, { type: "toolCall", id: 3 }], model: 7 } },
    { type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: 5, content: null } },
    { type: "model_change", timestamp: ts, modelId: null }];
  for (const rec of odd) expect(() => unifyPi(rec)).not.toThrow();
  expect(odd.map((rec) => unifyPi(rec))).toEqual([null, null, null, null, [], [], [{ kind: "turn_end", ts: min(9) }], [], []]);
});
it("长度截断但已经发出工具调用时不报回合结束，没调工具的截断照报", () => {
  const call = { type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "a.ts" } };
  expect(unifyPi(piAssistant([{ type: "text", text: "先看看" }, call], { stop: "length" }))?.map(e => e.kind))
    .toEqual(["model", "text", "tool_call"]);
  expect(unifyPi(piAssistant([{ type: "text", text: "写不下了" }], { stop: "length" }))?.map(e => e.kind))
    .toEqual(["model", "text", "turn_end"]);
});
/** 一次 edit 调用数出的 [新增, 删除] */
function editCounts(args: Record<string, unknown>): [number | undefined, number | undefined] | null {
  const ev = unifyPi(piAssistant([{ type: "toolCall", id: "f", name: "edit", arguments: { path: "a.ts", ...args } }]))?.[1];
  return ev?.kind === "tool_call" ? [ev.call.added, ev.call.removed] : null;
}
it("edit：edits 是单个对象时当作一条（E10）", () => {
  expect(editCounts({ edits: { oldText: "a", newText: "b\nc" } })).toEqual([2, 1]);
});
it("edit：edits 是 JSON 字符串、里面是单个对象时当作一条（E10）", () => {
  expect(editCounts({ edits: JSON.stringify({ oldText: "a\nb\nc", newText: "d" }) })).toEqual([1, 3]);
});
it("edit：只有旧式的顶层 oldText / newText 时当作一条（E10）", () => {
  expect(editCounts({ oldText: "a\nb", newText: "c\nd\ne" })).toEqual([3, 2]);
});
it("edit：旧式的顶层一对追加在 edits 数组后面（E10）", () => {
  expect(editCounts({ edits: [{ oldText: "a", newText: "b" }], oldText: "c\nd", newText: "e\nf\ng" })).toEqual([4, 3]);
});
it("失败数：很长的数字串也很快，照样解析（E11）", () => {
  const start = performance.now();
  expect(failedCount(`${"1".repeat(100_000)} passed, 3 failed`)).toBe(3);
  expect(performance.now() - start).toBeLessThan(500);
});
it("powershell 同 bash：shell，带命令（E12）", () => {
  expect(unifyPi(piAssistant([{ type: "toolCall", id: "p1", name: "powershell", arguments: { command: "Get-ChildItem src" } }],
    { t: min(10) }))?.[1])
    .toEqual({ kind: "tool_call", ts: min(10), id: "p1", call: { tool: "powershell", op: "shell", paths: [], command: "Get-ChildItem src" } });
});
it("记录表里其余各行", () => {
  const t = min(11);
  const ts = new Date(t).toISOString();
  const M = { kind: "model", ts: t, model: "claude-opus-5-5", explicit: false };
  const END = { kind: "turn_end", ts: t };
  const silent = ["session", "thinking_level_change", "context_edit", "session_info", "usage", "custom", "custom_message",
    "label", "branch_summary"];
  const cases: [string, unknown, unknown][] = [
    ...silent.map((type): [string, unknown, unknown] => [type, unifyPi({ type, id: "x", parentId: null, timestamp: ts }), []]),
    ["role system", unifyPi({ type: "message", id: "y", parentId: null, timestamp: ts,
      message: { role: "system", content: [{ type: "text", text: "规则" }], timestamp: t } }), []],
    ["空的用户文字", unifyPi(piUser("", t)), []],
    ["空的 thinking / text 不报", unifyPi(piAssistant([{ type: "thinking", thinking: "" }, { type: "text", text: "" },
      { type: "text", text: "有字" }], { t })), [M, { kind: "text", ts: t, text: "有字" }, END]],
    ["aborted 结束回合", unifyPi(piAssistant([{ type: "text", text: "停下" }], { stop: "aborted", t })),
      [M, { kind: "text", ts: t, text: "停下" }, END]],
    ["error 没有 errorMessage", unifyPi(piAssistant([], { stop: "error", t })),
      [M, { kind: "api_error", ts: t, message: "", rateLimited: false }, END]],
    ["error 不是限流", unifyPi(piAssistant([], { stop: "error", error: "500 Internal Server Error", t })),
      [M, { kind: "api_error", ts: t, message: "500 Internal Server Error", rateLimited: false }, END]],
    ["ls 是搜索", unifyPi(piAssistant([{ type: "toolCall", id: "l1", name: "ls", arguments: { path: "src" } }], { t })),
      [M, { kind: "tool_call", ts: t, id: "l1", call: { tool: "ls", op: "search", paths: ["src"] } }]],
    ["头行缺 id", readPiHeader({ type: "session", version: 3, timestamp: ts, cwd: CWD }), null],
    ["头行缺 cwd", readPiHeader({ type: "session", version: 3, id: "s-2", timestamp: ts }), null],
  ];
  for (const [name, actual, want] of cases) expect(actual, name).toEqual(want);
});
it("共用小件：数行、失败数、取文字、取待办", () => {
  expect([countLines(""), countLines("a"), countLines("a\n"), countLines("a\nb\n\n")]).toEqual([0, 1, 1, 3]);
  expect([failedCount("Tests 2 FAILED | 5 passed"), failedCount("all passed"), failedCount("4 failedx")]).toEqual([2, undefined, undefined]);
  expect(textOf([{ type: "text", text: "a" }, { type: "image", data: "…" }, "x", null, { type: "text", text: "b" }])).toBe("a\nb");
  expect(textOf(42)).toBe("");
  expect(toTodos([{ content: "写测试", status: "completed" }, { text: "提交", status: "blocked" }, "坏的", { status: "in_progress" }]))
    .toEqual([{ text: "写测试", status: "completed" }, { text: "提交", status: "pending" }, { text: "", status: "in_progress" }]);
  expect(toTodos({ todos: [] })).toEqual([]);
});

it("pi 的待办工具：todo / update_plan 的列表都进 todos", () => {
  const rec = piAssistant([{ type: "toolCall", id: "t1", name: "todo", arguments: { todos: [
    { content: "读图纸", status: "completed" }, { content: "写代码", status: "in_progress" }, { text: "验收", status: "pending" }] } }]);
  expect(unifyPi(rec)?.find(event => event.kind === "tool_call")).toMatchObject({ call: { tool: "todo", op: "todo",
    todos: [{ text: "读图纸", status: "completed" }, { text: "写代码", status: "in_progress" }, { text: "验收", status: "pending" }] } });
  const plan = piAssistant([{ type: "toolCall", id: "t2", name: "update_plan", arguments: { plan: [{ step: "看图纸", status: "in_progress" }] } }]);
  expect(unifyPi(plan)?.find(event => event.kind === "tool_call")).toMatchObject({ call: { op: "todo", todos: [{ text: "看图纸", status: "in_progress" }] } });
});

it("pi 的待办结果：details.todos 按 done 映射，进入 tool_result", () => {
  const result = piResult("t9", "todo");
  (result.message as Record<string, unknown>).details = { todos: [{ text: "看图纸", done: true }, { text: "写代码", done: false }] };
  expect(unifyPi(result)?.find(event => event.kind === "tool_result")).toMatchObject({
    todos: [{ text: "看图纸", status: "completed" }, { text: "写代码", status: "pending" }],
  });
});

// CONTROL-12：桥接的 site_todo 调用按待办动作归类，结果 details 进 todos
it("site_todo：调用按待办动作归类，结果 details 进 todos", () => {
  const call = piAssistant([{ type: "toolCall", id: "t1", name: "site_todo", arguments: { todos: [{ text: "读图纸", status: "in_progress" }] } }]);
  expect(unifyPi(call)?.find(event => event.kind === "tool_call")).toMatchObject({
    call: { tool: "site_todo", op: "todo", todos: [{ text: "读图纸", status: "in_progress" }] },
  });
  const result = piResult("t1", "site_todo");
  (result.message as Record<string, unknown>).details = { todos: [{ text: "读图纸", status: "completed" }] };
  expect(unifyPi(result)?.find(event => event.kind === "tool_result")).toMatchObject({
    todos: [{ text: "读图纸", status: "completed" }],
  });
});
