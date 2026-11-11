import { expect, it } from "vitest";
import { claudeRecordInfo, readClaudeAgentMeta, unifyClaude } from "../../src/core/unify/claude";
import type { SiteEvent } from "../../src/core/types";
import { ccAssistant, ccSystem, ccUser, min } from "../fixtures/logs";
import type { CcBlock } from "../fixtures/logs";

const S = { sid: "cc-1", cwd: "D:/work/example" };
it("任何记录都能取到 cwd、分支和时间", () => {
  expect(claudeRecordInfo(ccUser({ ...S, text: "hi", branch: "workbench", t: min(1) }))).toEqual({ cwd: S.cwd, branch: "workbench", ts: min(1) });
  expect(claudeRecordInfo({ type: "queue-operation", sessionId: "cc-1" })).toStrictEqual({});
});
it("子 agent 的 meta.json", () => {
  expect(readClaudeAgentMeta('{"agentType":"general-purpose","description":"写测试","spawnDepth":1}')).toEqual({ spawnDepth: 1, description: "写测试" });
  expect(readClaudeAgentMeta("{oops")).toBeNull();
  expect(readClaudeAgentMeta('{"description":"x"}')).toBeNull();
});
it("手打的消息是用户提示；协调者派来的算 agent；isMeta 不算", () => {
  expect(unifyClaude(ccUser({ ...S, text: "看看进度", t: min(1) }))).toEqual([{ kind: "prompt", ts: min(1), text: "看看进度", from: "user" }]);
  expect(unifyClaude(ccUser({ ...S, text: "# x Review R2", origin: "coordinator" }))?.[0]).toMatchObject({ from: "agent" });
  expect(unifyClaude(ccUser({ ...S, text: "<system-reminder>", meta: true }))).toEqual([]);
});
it("工具结果：is_error 与失败数", () => {
  expect(unifyClaude(ccUser({ ...S, results: [{ id: "t1", error: true, text: "FAILED x\n2 failed, 5 passed" }], t: min(2) })))
    .toEqual([{ kind: "tool_result", ts: min(2), id: "t1", ok: false, failed: 2 }]);
});
it("助手：模型、思考、工具调用；end_turn 结束回合", () => {
  expect(unifyClaude(ccAssistant({ ...S, t: min(3), blocks: [{ type: "thinking", thinking: "想一下" },
    { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "D:\\r\\a.ts", old_string: "a\nb", new_string: "a\nb\nc\nd\ne" } }] }))).toEqual([
    { kind: "model", ts: min(3), model: "claude-opus-5-5", explicit: false },
    { kind: "thinking", ts: min(3), text: "想一下" },
    { kind: "tool_call", ts: min(3), id: "t2", call: { tool: "Edit", op: "edit", paths: ["D:\\r\\a.ts"], added: 5, removed: 2 } }]);
  expect(unifyClaude(ccAssistant({ ...S, t: min(4), blocks: [{ type: "text", text: "完成了。" }] }))?.slice(1))
    .toEqual([{ kind: "text", ts: min(4), text: "完成了。" }, { kind: "turn_end", ts: min(4) }]);
});
it("派子 agent、向用户提问、待办", () => {
  const ev = unifyClaude(ccAssistant({ ...S, blocks: [
    { type: "tool_use", id: "a", name: "Agent", input: { description: "审核 plan", prompt: "…", subagent_type: "general-purpose" } },
    { type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: "用方案 A 吗？", header: "方案", options: [] }] } },
    { type: "tool_use", id: "d", name: "TodoWrite", input: { todos: [{ content: "写测试", status: "in_progress", activeForm: "写测试中" }] } }] }));
  expect(ev?.slice(1).map((e) => e.kind === "tool_call" && e.call)).toEqual([
    { tool: "Agent", op: "spawn", paths: [], title: "审核 plan" },
    { tool: "AskUserQuestion", op: "ask", paths: [], title: "用方案 A 吗？" },
    { tool: "TodoWrite", op: "todo", paths: [], todos: [{ text: "写测试", status: "in_progress" }] }]);
});
it("system：压缩与 API 报错；元数据记录忽略", () => {
  expect(unifyClaude(ccSystem({ ...S, subtype: "compact_boundary", t: min(5) }))).toEqual([{ kind: "compaction", ts: min(5) }]);
  expect(unifyClaude(ccSystem({ ...S, subtype: "api_error", message: "Rate limited (429)", t: min(6) })))
    .toEqual([{ kind: "api_error", ts: min(6), message: "Rate limited (429)", rateLimited: true }]);
  expect(unifyClaude(ccSystem({ ...S, subtype: "stop_hook_summary" }))).toEqual([]);
  expect(unifyClaude({ type: "attachment", sessionId: "cc-1" })).toEqual([]);
  expect(unifyClaude({ sessionId: "cc-1" })).toBeNull();
});

// ---- 裁定 E2、E14 ----

/** 一次工具调用转出的 ToolCall */
function callOf(name: string, input: Record<string, unknown>): unknown {
  const ev = unifyClaude(ccAssistant({ ...S, blocks: [{ type: "tool_use", id: "x", name, input }] }))?.[1];
  return ev?.kind === "tool_call" ? ev.call : ev;
}
it("update_plan 没带列表时只记待办动作，不带 todos（E2）", () => {
  expect(callOf("mcp__ccd_turn__update_plan", { advance: true })).toStrictEqual({ tool: "mcp__ccd_turn__update_plan", op: "todo", paths: [] });
  expect(callOf("mcp__ccd_turn__update_plan", { done: [2], start: 4 })).toStrictEqual({ tool: "mcp__ccd_turn__update_plan", op: "todo", paths: [] });
});
it("update_plan 带 items 时取成待办（E2）", () => {
  expect(callOf("mcp__ccd_turn__update_plan", { items: [{ content: "读代码", status: "completed" }, { content: "写测试", status: "in_progress" }] }))
    .toEqual({ tool: "mcp__ccd_turn__update_plan", op: "todo", paths: [],
      todos: [{ text: "读代码", status: "completed" }, { text: "写测试", status: "in_progress" }] });
});
it("TodoWrite 的 todos 不是数组时不带 todos（E2）", () => {
  expect(callOf("TodoWrite", {})).toStrictEqual({ tool: "TodoWrite", op: "todo", paths: [] });
  expect(callOf("TodoWrite", { todos: "写测试" })).toStrictEqual({ tool: "TodoWrite", op: "todo", paths: [] });
});
it("模型是 <synthetic> 时不报模型，块照报（E14）", () => {
  expect(unifyClaude(ccAssistant({ ...S, t: min(7), model: "<synthetic>", blocks: [{ type: "text", text: "API Error: 500" }] })))
    .toEqual([{ kind: "text", ts: min(7), text: "API Error: 500" }, { kind: "turn_end", ts: min(7) }]);
});

// ---- 工具表其余各行 ----

it("工具表：读、搜索、改、写、命令、派工、其他", () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["Read", { file_path: "specs/x/plan.md", offset: 10 }, { tool: "Read", op: "read", paths: ["specs/x/plan.md"] }],
    ["NotebookRead", { notebook_path: "n.ipynb" }, { tool: "NotebookRead", op: "read", paths: ["n.ipynb"] }],
    ["Grep", { pattern: "foo", path: "src" }, { tool: "Grep", op: "search", paths: ["src"] }],
    ["Glob", { pattern: "**/*.ts" }, { tool: "Glob", op: "search", paths: [] }],
    ["LS", { path: "docs" }, { tool: "LS", op: "search", paths: ["docs"] }],
    ["MultiEdit", { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b\nc" }, { old_string: "d\ne\nf", new_string: "g" }] },
      { tool: "MultiEdit", op: "edit", paths: ["a.ts"], added: 3, removed: 4 }],
    ["Write", { file_path: "n.ts", content: "1\n2\n3\n" }, { tool: "Write", op: "write", paths: ["n.ts"], added: 3, removed: 0 }],
    ["Bash", { command: "npx vitest run", description: "跑测试" }, { tool: "Bash", op: "shell", paths: [], command: "npx vitest run" }],
    ["PowerShell", { command: "Get-ChildItem src" }, { tool: "PowerShell", op: "shell", paths: [], command: "Get-ChildItem src" }],
    ["Task", { description: "审一下", prompt: "…" }, { tool: "Task", op: "spawn", paths: [], title: "审一下" }],
    ["WebFetch", { url: "https://example.com", prompt: "…" }, { tool: "WebFetch", op: "other", paths: [] }],
    ["mcp__x__update_planner", { items: [] }, { tool: "mcp__x__update_planner", op: "other", paths: [] }],
  ];
  for (const [name, input, want] of cases) expect(callOf(name, input), name).toStrictEqual(want);
});
it("工具参数类型不对当作没有；任何参数都不抛出", () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["Read", { file_path: 42, notebook_path: "n.ipynb" }, { tool: "Read", op: "read", paths: ["n.ipynb"] }],
    ["Read", { file_path: "" }, { tool: "Read", op: "read", paths: [] }],
    ["Grep", { path: ["src"] }, { tool: "Grep", op: "search", paths: [] }],
    ["Edit", { file_path: null, old_string: 1, new_string: { x: 1 } }, { tool: "Edit", op: "edit", paths: [], added: 0, removed: 0 }],
    ["MultiEdit", { file_path: "a.ts", edits: "坏的" }, { tool: "MultiEdit", op: "edit", paths: ["a.ts"], added: 0, removed: 0 }],
    ["MultiEdit", { file_path: "a.ts", edits: [null, 1, { new_string: "x" }] },
      { tool: "MultiEdit", op: "edit", paths: ["a.ts"], added: 1, removed: 0 }],
    ["Write", { file_path: "n.ts" }, { tool: "Write", op: "write", paths: ["n.ts"], added: 0, removed: 0 }],
    ["Bash", { command: ["ls"] }, { tool: "Bash", op: "shell", paths: [] }],
    ["Agent", { description: 3 }, { tool: "Agent", op: "spawn", paths: [] }],
    ["AskUserQuestion", { questions: [] }, { tool: "AskUserQuestion", op: "ask", paths: [] }],
    ["AskUserQuestion", { questions: [{ question: 5 }] }, { tool: "AskUserQuestion", op: "ask", paths: [] }],
    ["AskUserQuestion", { questions: "用 A 吗" }, { tool: "AskUserQuestion", op: "ask", paths: [] }],
  ];
  for (const [name, input, want] of cases) expect(callOf(name, input), name).toStrictEqual(want);
});

// ---- 记录表其余各行 ----

it("user：text 块连起来；isCompactSummary 不算；空文字不报；task-notification 算 agent", () => {
  const blocks = { ...ccUser({ ...S, t: min(8) }), message: { role: "user", content: [{ type: "text", text: "第一段" },
    { type: "image", source: {} }, { type: "text", text: "第二段" }] } };
  expect(unifyClaude(blocks)).toEqual([{ kind: "prompt", ts: min(8), text: "第一段\n第二段", from: "user" }]);
  expect(unifyClaude({ ...ccUser({ ...S, text: "摘要" }), isCompactSummary: true })).toEqual([]);
  expect(unifyClaude(ccUser({ ...S, text: "" }))).toEqual([]);
  expect(unifyClaude(ccUser({ ...S, text: "后台任务完成", origin: "task-notification" }))?.[0]).toMatchObject({ from: "agent" });
  expect(unifyClaude(ccUser({ ...S, text: "直接打字", origin: "human" }))?.[0]).toMatchObject({ from: "user" });
  expect(unifyClaude({ ...ccUser({ ...S, text: "x" }), origin: { kind: 7 } })?.[0]).toMatchObject({ from: "user" });
});
it("user：每个 tool_result 块各出一个结果；同条里的文字不算提示", () => {
  const rec = ccUser({ ...S, t: min(9), results: [{ id: "r1" }, { id: "r2", text: "Tests 1 failed | 9 passed" }] });
  const content = (rec.message as { content: unknown[] }).content;
  const withText = { ...rec, message: { role: "user", content: [...content, { type: "text", text: "附言" },
    { type: "tool_result", tool_use_id: 9, content: "坏 id" },
    { type: "tool_result", tool_use_id: "r3", content: [{ type: "text", text: "3 failed" }], is_error: "true" }] } };
  expect(unifyClaude(withText)).toEqual([
    { kind: "tool_result", ts: min(9), id: "r1", ok: true },
    { kind: "tool_result", ts: min(9), id: "r2", ok: true, failed: 1 },
    { kind: "tool_result", ts: min(9), id: "r3", ok: true, failed: 3 }]);
});
it("assistant：stop_reason 是 tool_use 以外的字符串才结束回合；空块、坏块不报", () => {
  const base = ccAssistant({ ...S, t: min(10), blocks: [] });
  const msg = (content: unknown, stop: unknown, model: unknown = "claude-opus-5-5") =>
    unifyClaude({ ...base, message: { role: "assistant", model, content, stop_reason: stop } });
  const M: SiteEvent = { kind: "model", ts: min(10), model: "claude-opus-5-5", explicit: false };
  const END: SiteEvent = { kind: "turn_end", ts: min(10) };
  expect(msg([{ type: "text", text: "写到一半" }], null)).toEqual([M, { kind: "text", ts: min(10), text: "写到一半" }]);
  expect(msg([], "max_tokens")).toEqual([M, END]);
  expect(msg([], "stop_sequence", "")).toEqual([END]);
  expect(msg([{ type: "thinking", thinking: "" }, { type: "text", text: "" }, null, 1, { type: "tool_use", id: 3, name: "Read" },
    { type: "tool_use", id: "u1", name: "Read", input: "坏的" }, { type: "redacted_thinking", data: "…" }], "tool_use"))
    .toEqual([M, { kind: "tool_call", ts: min(10), id: "u1", call: { tool: "Read", op: "read", paths: [] } }]);
  expect(msg("块", "tool_use", 7)).toEqual([]);
});
it("system：api_error 的文字先取 error.message，再取 content；都没有给空", () => {
  const sys = ccSystem({ ...S, subtype: "api_error", t: min(11) });
  expect(unifyClaude({ ...sys, content: "Overloaded" })).toEqual([{ kind: "api_error", ts: min(11), message: "Overloaded", rateLimited: false }]);
  expect(unifyClaude({ ...sys, error: { message: 529 }, content: "rate_limit_error" }))
    .toEqual([{ kind: "api_error", ts: min(11), message: "rate_limit_error", rateLimited: true }]);
  expect(unifyClaude(sys)).toEqual([{ kind: "api_error", ts: min(11), message: "", rateLimited: false }]);
  expect(unifyClaude({ ...sys, subtype: "informational" })).toEqual([]);
});
it("时间读不出的已知记录不报；type 不是字符串算认不出；任何输入都不抛出", () => {
  expect(unifyClaude({ ...ccUser({ ...S, text: "x" }), timestamp: "昨天" })).toEqual([]);
  expect(unifyClaude({ ...ccSystem({ ...S, subtype: "compact_boundary" }), timestamp: undefined })).toEqual([]);
  const ts = new Date(min(12)).toISOString();
  const odd: unknown[] = [null, 1, "user", [], {}, { type: 3 }, { type: "user", timestamp: ts }, { type: "user", timestamp: ts, message: "x" },
    { type: "assistant", timestamp: ts, message: null }, { type: "system", timestamp: ts, error: null },
    { type: "user", timestamp: ts, message: { content: [null, { type: "tool_result" }] } }];
  for (const rec of odd) expect(() => unifyClaude(rec)).not.toThrow();
  expect(odd.map((rec) => unifyClaude(rec))).toEqual([null, null, null, null, null, null, [], [], [], [], []]);
});
it("记录信息：类型不对的字段当作没有；子 agent 记录同样能取", () => {
  expect(claudeRecordInfo({ type: "assistant", cwd: 1, gitBranch: null, timestamp: "昨天" })).toStrictEqual({});
  expect(claudeRecordInfo(ccAssistant({ ...S, agentId: "a1", t: min(13), blocks: [] }))).toStrictEqual({ cwd: S.cwd, ts: min(13) });
  expect(claudeRecordInfo("坏的")).toStrictEqual({});
});
it("meta.json：description 不是字符串就不带；spawnDepth 不是数字、顶层不是对象给 null", () => {
  expect(readClaudeAgentMeta('{"spawnDepth":2,"description":7}')).toStrictEqual({ spawnDepth: 2 });
  expect(readClaudeAgentMeta('{"spawnDepth":"1","description":"x"}')).toBeNull();
  expect(readClaudeAgentMeta("[1]")).toBeNull();
});
/** 样例构造：块的类型照 CcBlock，确认样例本身合乎计划写的真实格式 */
it("样例构造：公共字段与默认值", () => {
  const blocks: CcBlock[] = [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }];
  const a = ccAssistant({ ...S, agentId: "a9", branch: "workbench", t: min(14), blocks });
  expect(a).toMatchObject({ type: "assistant", cwd: S.cwd, sessionId: "cc-1", agentId: "a9", gitBranch: "workbench",
    timestamp: new Date(min(14)).toISOString(), message: { model: "claude-opus-5-5", stop_reason: "tool_use", content: blocks } });
  expect(typeof a.uuid).toBe("string");
  expect(ccUser({ ...S, text: "x" })).not.toHaveProperty("gitBranch");
  expect(ccSystem({ ...S, subtype: "api_error", message: "m" })).toMatchObject({ type: "system", subtype: "api_error", error: { message: "m" } });
});

// ---- Task 4 评审补充（裁定 E15）：两处取值的先后、空列表、字段真的缺席、子 agent 层级与空的 cwd ----

it("api_error 的 error.message 与 content 都是字符串时取 error.message", () => {
  const sys = ccSystem({ ...S, subtype: "api_error", message: "Overloaded", t: min(15) });
  expect(unifyClaude({ ...sys, content: "rate_limit_error" }))
    .toEqual([{ kind: "api_error", ts: min(15), message: "Overloaded", rateLimited: false }]);
});
it("Read 同时有 file_path 和 notebook_path 时取 file_path", () => {
  expect(callOf("Read", { file_path: "a.ts", notebook_path: "n.ipynb" })).toStrictEqual({ tool: "Read", op: "read", paths: ["a.ts"] });
});
it("空列表也是列表：TodoWrite 与 update_plan 带 todos: []（E2）", () => {
  expect(callOf("TodoWrite", { todos: [] })).toStrictEqual({ tool: "TodoWrite", op: "todo", paths: [], todos: [] });
  expect(callOf("mcp__ccd_turn__update_plan", { items: [] }))
    .toStrictEqual({ tool: "mcp__ccd_turn__update_plan", op: "todo", paths: [], todos: [] });
});
it("meta.json：spawnDepth 必须是 ≥ 1 的整数，否则给 null", () => {
  for (const depth of ["0", "-1", "1.5", "1e400"]) expect(readClaudeAgentMeta(`{"spawnDepth":${depth}}`), depth).toBeNull();
  expect(readClaudeAgentMeta('{"spawnDepth":1}')).toStrictEqual({ spawnDepth: 1 });
});
it("记录信息：空的 cwd、gitBranch 当作没有", () => {
  expect(claudeRecordInfo({ ...ccUser({ ...S, text: "x", t: min(16) }), cwd: "", gitBranch: "" })).toStrictEqual({ ts: min(16) });
  expect(claudeRecordInfo({ ...ccUser({ ...S, text: "x", branch: "workbench", t: min(16) }), cwd: "" }))
    .toStrictEqual({ branch: "workbench", ts: min(16) });
});
