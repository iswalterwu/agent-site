import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { expect, it } from "vitest";
import { DSH_IGNORED, readDshHeader, unifyDsh } from "../../src/core/unify/dsh";
import { appendZstd, dshAssistant, dshCall, dshHeader, dshResult, dshTurnEnd, dshUser, min } from "../fixtures/logs";
import type { Rec } from "../fixtures/logs";
import { mkTmpDir } from "../harness/wait";

it("头行：一级会话深度 0；子 agent 带父会话", () => {
  expect(readDshHeader(dshHeader("D:/work/example", { id: "d-1", t: min(0) }))).toEqual({ id: "d-1", cwd: "D:/work/example", startedAt: min(0), depth: 0 });
  expect(readDshHeader(dshHeader("D:/r", { id: "d-2", depth: 1, parent: "d-1" }))).toMatchObject({ depth: 1, parentId: "d-1" });
});
it("用户消息只认 user 与 agent-message 两种来源", () => {
  expect(unifyDsh(dshUser("# settings Implement：T-3", { t: min(1) })))
    .toEqual([{ kind: "prompt", ts: min(1), text: "# settings Implement：T-3", from: "user" }]);
  expect(unifyDsh(dshUser("子 agent 的结果", { kind: "agent-message" }))?.[0]).toMatchObject({ from: "agent" });
  expect(unifyDsh(dshUser("<skills>", { kind: "skill-catalog" }))).toEqual([]);
});
it("助手消息：reasoning 是思考；tool-call 块不重复报", () => {
  expect(unifyDsh(dshAssistant([{ type: "reasoning", text: "想" }, { type: "text", text: "做" },
    { type: "tool-call", id: "k1", name: "read", arguments: "{}" }], { t: min(2) }))).toEqual([
    { kind: "model", ts: min(2), model: "deepseek-flash", explicit: false },
    { kind: "thinking", ts: min(2), text: "想" }, { kind: "text", ts: min(2), text: "做" }]);
});
it("tool/call 的参数是 JSON 字符串", () => {
  expect(unifyDsh(dshCall("k2", "edit", { file_path: "backend/x.py", old_string: "a", new_string: "b\nc" }, { t: min(3) })))
    .toEqual([{ kind: "tool_call", ts: min(3), id: "k2", call: { tool: "edit", op: "edit", paths: ["backend/x.py"], added: 2, removed: 1 } }]);
  expect(unifyDsh(dshCall("k3", "pwsh", { command: "python -m pytest -q", description: "跑测试" }))?.[0])
    .toMatchObject({ call: { op: "shell", command: "python -m pytest -q" } });
});
it("tool/result 的成败、turn/end、忽略的类型与陌生的类型", () => {
  expect(unifyDsh(dshResult("k3", { isError: true, text: "1 failed", t: min(4) }))).toEqual([{ kind: "tool_result", ts: min(4), id: "k3", ok: false, failed: 1 }]);
  expect(unifyDsh(dshResult("k4", { errorName: "FsError" }))?.[0]).toMatchObject({ ok: false });
  expect(unifyDsh(dshTurnEnd({ t: min(5) }))).toEqual([{ kind: "turn_end", ts: min(5) }]);
  expect(unifyDsh({ type: "job/registered", seq: 9, time: min(5), data: {} })).toEqual([]);
  expect(unifyDsh({ type: "brand/new", seq: 10, time: min(5), data: {} })).toBeNull();
});

// ---- 头行的入口校验 ----

it("头行：delegationDepth 缺席或为 null 按 0；不是 ≥ 0 的整数就读不出", () => {
  const h = dshHeader("D:/r", { id: "d-3", t: min(0) });
  const { delegationDepth: _, ...noDepth } = h;
  const want = { id: "d-3", cwd: "D:/r", startedAt: min(0), depth: 0 };
  expect(readDshHeader(noDepth)).toStrictEqual(want);
  expect(readDshHeader({ ...h, delegationDepth: null })).toStrictEqual(want);
  for (const depth of [-1, 1.5, "1", Infinity, Number.NaN]) expect(readDshHeader({ ...h, delegationDepth: depth }), String(depth)).toBeNull();
  expect(readDshHeader({ ...h, delegationDepth: 2 })).toStrictEqual({ ...want, depth: 2 });
});
it("头行：parentSession 不是非空字符串时不带 parentId", () => {
  const h = dshHeader("D:/r", { id: "d-4", depth: 1, parent: "d-1", t: min(0) });
  expect(readDshHeader({ ...h, parentSession: "" })).toStrictEqual({ id: "d-4", cwd: "D:/r", startedAt: min(0), depth: 1 });
  expect(readDshHeader({ ...h, parentSession: 7 })).not.toHaveProperty("parentId");
  expect(readDshHeader(h)).toStrictEqual({ id: "d-4", cwd: "D:/r", startedAt: min(0), depth: 1, parentId: "d-1" });
});
it("头行：不是 session 行、缺 id 或 cwd（含空串）、createdAt 不是有限的毫秒数，都读不出", () => {
  const h = dshHeader("D:/r", { id: "d-5", t: min(0) });
  const bad: unknown[] = [{ ...h, type: "turn/end" }, { ...h, id: 1 }, { ...h, id: "" }, { ...h, cwd: undefined }, { ...h, cwd: "" },
    { ...h, createdAt: new Date(min(0)).toISOString() }, { ...h, createdAt: Infinity }, { ...h, createdAt: undefined },
    dshTurnEnd(), null, "session", []];
  for (const rec of bad) expect(readDshHeader(rec)).toBeNull();
});

// ---- 记录的入口校验 ----

const IGNORED = ["session/title", "turn/start", "step/start", "step/end", "system/message", "request/header", "request/context",
  "permission/preset", "sandbox/mode", "approval/policy", "session-log-deepseek/delivery-accepted", "job/registered", "job/settled",
  "agent/inbox/spliced", "todo/write", "subagent/descriptor", "workspace/changes", "session/end-seed", "web/deepseek-search-llm-request"];
it("DSH_IGNORED 正好是认得但不用的那些类型，都给 []；session 头行也给 []", () => {
  expect([...DSH_IGNORED].sort()).toEqual([...IGNORED].sort());
  for (const type of IGNORED) expect(unifyDsh({ type, seq: 1, time: min(6), data: {} }), type).toEqual([]);
  // 认得但不用的类型，不论 time 是什么都给 []
  expect(unifyDsh({ type: "turn/start", seq: 2, data: {} })).toEqual([]);
  expect(unifyDsh(dshHeader("D:/r"))).toEqual([]);
});
it("时间不是有限毫秒数的已知记录给 []", () => {
  expect(unifyDsh({ ...dshTurnEnd(), time: new Date(min(6)).toISOString() })).toEqual([]);
  expect(unifyDsh({ ...dshUser("x"), time: Number.NaN })).toEqual([]);
  expect(unifyDsh({ ...dshCall("k", "read", {}), time: Infinity })).toEqual([]);
  const { time: _, ...noTime } = dshTurnEnd();
  expect(unifyDsh(noTime)).toEqual([]);
});
it("不是对象、type 不是字符串算认不出；坏的 data 当作没有；任何输入都不抛出", () => {
  const t = min(7);
  const odd: unknown[] = [null, 1, "turn/end", [], {}, { type: 3, time: t },
    { type: "user/message", time: t }, { type: "user/message", time: t, data: { content: [{ type: "text", text: "x" }], source: "user" } },
    { type: "assistant/message", time: t, data: { message: null } },
    { type: "assistant/message", time: t, data: { message: { content: "块", source: { model: 7 } } } },
    { type: "tool/call", time: t, data: { callId: 1, name: "read", arguments: "{}" } },
    { type: "tool/call", time: t, data: { callId: "c", arguments: "{}" } },
    { type: "tool/result", time: t, data: null }, { type: "tool/result", time: t, data: { message: { toolCallId: null } } },
    { type: "turn/end", time: t, data: null }];
  for (const rec of odd) expect(() => unifyDsh(rec)).not.toThrow();
  expect(odd.map((rec) => unifyDsh(rec))).toEqual([null, null, null, null, null, null, [], [], [], [], [], [], [], [],
    [{ kind: "turn_end", ts: t }]]);
});

// ---- 用户消息与助手消息的其余情况 ----

it("用户消息：文本块用 \\n 连接；空文字、没有来源、其余几种来源都不报", () => {
  const rec = dshUser("x", { t: min(8) });
  const content = [{ type: "text", text: "第一段" }, { type: "image", data: "…" }, { type: "text", text: "第二段" }];
  expect(unifyDsh({ ...rec, data: { content, source: { kind: "user" } } }))
    .toEqual([{ kind: "prompt", ts: min(8), text: "第一段\n第二段", from: "user" }]);
  expect(unifyDsh(dshUser(""))).toEqual([]);
  expect(unifyDsh({ ...rec, data: { content } })).toEqual([]);
  for (const kind of ["agent-instructions", "runtime-context", "time-context", "tool-jobs"]) expect(unifyDsh(dshUser("x", { kind })), kind).toEqual([]);
});
it("助手消息：模型不是非空字符串就不报模型；空的 reasoning / text 不报；坏块和别家的块跳过", () => {
  const rec = dshAssistant([{ type: "reasoning", text: "" }, { type: "text", text: "" }, { type: "text", text: "有字" }], { t: min(9) });
  expect(unifyDsh(rec)).toEqual([{ kind: "model", ts: min(9), model: "deepseek-flash", explicit: false },
    { kind: "text", ts: min(9), text: "有字" }]);
  const blocks = [null, 1, { type: "thinking", thinking: "别家的写法" }, { type: "reasoning", text: 5 }, { type: "text", text: "做" }];
  expect(unifyDsh({ ...rec, data: { message: { content: blocks, source: { model: "" } } } })).toEqual([{ kind: "text", ts: min(9), text: "做" }]);
  expect(unifyDsh({ ...rec, data: { message: { content: blocks } } })).toEqual([{ kind: "text", ts: min(9), text: "做" }]);
  expect(unifyDsh(dshAssistant([], { model: "deepseek-pro", t: min(9) }))).toEqual([{ kind: "model", ts: min(9), model: "deepseek-pro", explicit: false }]);
});

// ---- 工具表 ----

/** 一次 tool/call 转出的 ToolCall */
function callOf(name: string, args: Record<string, unknown>): unknown {
  const ev = unifyDsh(dshCall("x", name, args))?.[0];
  return ev?.kind === "tool_call" ? ev.call : ev;
}
it("工具表各行", () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["read", { file_path: "specs/x/plan.md", offset: 10 }, { tool: "read", op: "read", paths: ["specs/x/plan.md"] }],
    ["read_image", { file_path: "design/a.png" }, { tool: "read_image", op: "read", paths: ["design/a.png"] }],
    ["grep", { pattern: "foo", path: "src" }, { tool: "grep", op: "search", paths: ["src"] }],
    ["glob", { pattern: "**/*.ts" }, { tool: "glob", op: "search", paths: [] }],
    ["edit", { file_path: "a.ts", old_string: "a\nb\nc", new_string: "" }, { tool: "edit", op: "edit", paths: ["a.ts"], added: 0, removed: 3 }],
    ["write", { file_path: "n.ts", content: "1\n2\n3\n" }, { tool: "write", op: "write", paths: ["n.ts"], added: 3, removed: 0 }],
    ["bash", { command: "git status" }, { tool: "bash", op: "shell", paths: [], command: "git status" }],
    ["pwsh", { command: "Get-ChildItem src" }, { tool: "pwsh", op: "shell", paths: [], command: "Get-ChildItem src" }],
    ["todo_write", { todos: [{ content: "写测试", status: "in_progress" }, { content: "提交", status: "pending" }] },
      { tool: "todo_write", op: "todo", paths: [], todos: [{ text: "写测试", status: "in_progress" }, { text: "提交", status: "pending" }] }],
    ["subagent", { description: "审核 plan", prompt: "…" }, { tool: "subagent", op: "spawn", paths: [], title: "审核 plan" }],
    ["subagent_fork", { description: "分头查" }, { tool: "subagent_fork", op: "spawn", paths: [], title: "分头查" }],
    ["spawn_teammate", { description: "写文档" }, { tool: "spawn_teammate", op: "spawn", paths: [], title: "写文档" }],
    ["ask_user_question", { questions: [{ question: "用方案 A 吗？", options: [] }] },
      { tool: "ask_user_question", op: "ask", paths: [], title: "用方案 A 吗？" }],
    ["web_search", { query: "x" }, { tool: "web_search", op: "other", paths: [] }],
  ];
  for (const [name, args, want] of cases) expect(callOf(name, args), name).toStrictEqual(want);
});
it("todo_write：todos 是数组才带，空数组也带；不是数组不带（E2）", () => {
  expect(callOf("todo_write", { todos: [] })).toStrictEqual({ tool: "todo_write", op: "todo", paths: [], todos: [] });
  expect(callOf("todo_write", {})).toStrictEqual({ tool: "todo_write", op: "todo", paths: [] });
  expect(callOf("todo_write", { todos: "写测试" })).toStrictEqual({ tool: "todo_write", op: "todo", paths: [] });
});
it("参数：坏 JSON、顶层不是对象、不是字符串，都按空对象", () => {
  const base = dshCall("y", "edit", {});
  for (const args of ["{坏的", "[1]", "null", "", { file_path: "a.ts" }, undefined]) {
    const ev = unifyDsh({ ...base, data: { callId: "y", name: "edit", arguments: args } })?.[0];
    expect(ev?.kind === "tool_call" && ev.call, String(args)).toStrictEqual({ tool: "edit", op: "edit", paths: [], added: 0, removed: 0 });
  }
});
it("工具参数类型不对当作没有；任何参数都不抛出", () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["read", { file_path: 42 }, { tool: "read", op: "read", paths: [] }],
    ["read", { file_path: "" }, { tool: "read", op: "read", paths: [] }],
    ["grep", { path: ["src"] }, { tool: "grep", op: "search", paths: [] }],
    ["edit", { file_path: null, old_string: 1, new_string: { x: 1 } }, { tool: "edit", op: "edit", paths: [], added: 0, removed: 0 }],
    ["write", { file_path: "n.ts" }, { tool: "write", op: "write", paths: ["n.ts"], added: 0, removed: 0 }],
    ["pwsh", { command: ["ls"] }, { tool: "pwsh", op: "shell", paths: [] }],
    ["subagent", { description: 3 }, { tool: "subagent", op: "spawn", paths: [] }],
    ["ask_user_question", { questions: [] }, { tool: "ask_user_question", op: "ask", paths: [] }],
    ["ask_user_question", { questions: [{ question: 5 }] }, { tool: "ask_user_question", op: "ask", paths: [] }],
  ];
  for (const [name, args, want] of cases) expect(callOf(name, args), name).toStrictEqual(want);
});

// ---- tool/result 的其余情况 ----

it("tool/result：成功、失败数；isError 只认 true；data.error 不是 null 就算出错，不论类型（E16）", () => {
  expect(unifyDsh(dshResult("k5", { text: "Tests 2 failed | 9 passed", t: min(10) })))
    .toStrictEqual([{ kind: "tool_result", ts: min(10), id: "k5", ok: true, failed: 2 }]);
  expect(unifyDsh(dshResult("k6", { t: min(10) }))).toStrictEqual([{ kind: "tool_result", ts: min(10), id: "k6", ok: true }]);
  const rec = dshResult("k7", { t: min(10) });
  const data = rec.data as Rec;
  expect(data).not.toHaveProperty("error");
  expect(unifyDsh(rec)?.[0]).toMatchObject({ ok: true });
  expect(unifyDsh({ ...rec, data: { ...data, error: null } })?.[0]).toMatchObject({ ok: true });
  for (const error of ["boom", 1, {}]) expect(unifyDsh({ ...rec, data: { ...data, error } })?.[0], String(error)).toMatchObject({ ok: false });
  expect(unifyDsh({ ...rec, data: { message: { toolCallId: "k7", isError: "true", content: [{ type: "text", text: "3 failed" }] } } }))
    .toStrictEqual([{ kind: "tool_result", ts: min(10), id: "k7", ok: true, failed: 3 }]);
  expect(unifyDsh(dshResult("k8", { isError: true, errorName: "FsError", t: min(10) })))
    .toStrictEqual([{ kind: "tool_result", ts: min(10), id: "k8", ok: false }]);
});

// ---- 样例构造 ----

it("样例构造：头行与记录的形状", () => {
  expect(dshHeader("D:/r", { id: "d-1", t: min(0) }))
    .toStrictEqual({ type: "session", version: 4, id: "d-1", cwd: "D:/r", createdAt: min(0), delegationDepth: 0 });
  expect(dshHeader("D:/r", { depth: 1, parent: "d-1" })).toMatchObject({ delegationDepth: 1, origin: "subagent", parentSession: "d-1" });
  expect(dshCall("k", "read", { file_path: "a" }, { t: min(1) }))
    .toMatchObject({ type: "tool/call", time: min(1), data: { callId: "k", name: "read", arguments: '{"file_path":"a"}' } });
  expect(dshResult("k", { errorName: "FsError" })).toMatchObject({ data: { message: { toolCallId: "k", isError: false },
    error: { name: "FsError", code: "E" } } });
  expect(dshResult("k").data).not.toHaveProperty("error");
  expect(dshUser("x")).toMatchObject({ type: "user/message", data: { content: [{ type: "text", text: "x" }], source: { kind: "user" } } });
  const [a, b] = [dshTurnEnd(), dshTurnEnd()];
  expect(typeof a.seq === "number" && typeof b.seq === "number" && b.seq > a.seq).toBe(true);
});
it("appendZstd：自动建目录；每次追加一个 zstd 帧，接在文件末尾", () => {
  const file = path.join(mkTmpDir(), "sessions", "--D--r--", "session-1", "session.v4.jsonl.zstd");
  const first = [dshHeader("D:/r", { id: "d-9" }), dshUser("开始")];
  const second = [dshTurnEnd()];
  appendZstd(file, first);
  const firstSize = fs.statSync(file).size;
  appendZstd(file, second);
  const bytes = fs.readFileSync(file);
  const text = (buf: Buffer): string => zlib.zstdDecompressSync(buf).toString("utf8");
  expect(text(bytes.subarray(0, firstSize))).toBe(first.map((r) => `${JSON.stringify(r)}\n`).join(""));
  expect(text(bytes.subarray(firstSize))).toBe(`${JSON.stringify(second[0])}\n`);
  // 两段都以 zstd 帧头（魔数 0xFD2FB528，小端）开始
  expect([bytes.readUInt32LE(0), bytes.readUInt32LE(firstSize)]).toEqual([0xfd2fb528, 0xfd2fb528]);
});
