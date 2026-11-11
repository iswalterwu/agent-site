// 测试用的会话日志样例：记录照计划"真实日志格式"一节的字段手写，文字都是编的，不含任何真实对话内容。
// 按来源分节，pi 在前；Claude Code、DSH 的构造函数各自追加在后面。只在测试里用。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ifDefined } from "../../src/protocol/guards";

export type Rec = Record<string, unknown>;

/** 样例的时间原点 */
export const T0 = Date.parse("2026-11-04T08:00:00.000Z");
/** T0 之后 n 分钟（毫秒时间戳） */
export const min = (n: number): number => T0 + n * 60_000;

/** 写 JSONL 文件（自动建目录）：每条一行，以 \n 结尾 */
export function writeJsonl(file: string, recs: Rec[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(recs));
}

/** 往 JSONL 文件末尾追加记录（自动建目录），格式同 writeJsonl */
export function appendJsonl(file: string, recs: Rec[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, jsonl(recs));
}

const jsonl = (recs: Rec[]): string => recs.map((rec) => `${JSON.stringify(rec)}\n`).join("");
const iso = (t: number): string => new Date(t).toISOString();

// ---- pi 1.4.0（session v3） ----

/** 条目 ID：pi 写 8 位十六进制，这里按序编号 */
let piSeq = 0;
const piEntryId = (): string => (++piSeq).toString(16).padStart(8, "0");

/** 头行（文件第 1 行） */
export function piHeader(cwd: string, o: { id?: string; t?: number } = {}): Rec {
  return { type: "session", version: 3, id: o.id ?? "pi-session", timestamp: iso(o.t ?? T0), cwd };
}

/** message 条目：条目的 timestamp 是 ISO 字符串，消息自己的 timestamp 是毫秒数 */
function piMessage(message: Rec, t: number): Rec {
  return { type: "message", id: piEntryId(), parentId: null, timestamp: iso(t), message: { ...message, timestamp: t } };
}

/** 用户消息：content = [{type:"text",text}] */
export function piUser(text: string, t = T0): Rec {
  return piMessage({ role: "user", content: [{ type: "text", text }] }, t);
}

export type PiBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/** 助手消息：stop 默认有 toolCall 时 toolUse，否则 stop；model 默认 claude-opus-5-5 */
export function piAssistant(blocks: PiBlock[], o: { stop?: "stop" | "toolUse" | "error" | "aborted" | "length";
  model?: string; error?: string; t?: number } = {}): Rec {
  const stop = o.stop ?? (blocks.some((b) => b.type === "toolCall") ? "toolUse" : "stop");
  return piMessage({ role: "assistant", content: blocks, provider: "anthropic", model: o.model ?? "claude-opus-5-5",
    stopReason: stop, ...ifDefined("errorMessage", o.error) }, o.t ?? T0);
}

/** 工具结果：content = [{type:"text",text}]，text 默认 "ok" */
export function piResult(id: string, tool: string, o: { error?: boolean; text?: string; t?: number } = {}): Rec {
  return piMessage({ role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: o.text ?? "ok" }],
    isError: o.error ?? false }, o.t ?? T0);
}

/** 模型切换条目 */
export function piModelChange(modelId: string, provider = "anthropic", t = T0): Rec {
  return { type: "model_change", id: piEntryId(), parentId: null, timestamp: iso(t), provider, modelId };
}

// ---- Claude Code 2.1.309 ----

export type CcBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
/** 公共字段：sid → sessionId；t → timestamp（默认 T0）；branch → gitBranch（有才放）；子 agent 的记录带 agentId */
export interface CcCommon { sid: string; cwd: string; t?: number; branch?: string; agentId?: string }

/** 记录 uuid：真实是随机 UUID，这里按序编号成 UUID 的样子 */
let ccSeq = 0;
const ccUuid = (): string => `00000000-0000-4000-8000-${(++ccSeq).toString(16).padStart(12, "0")}`;

function ccRecord(type: string, o: CcCommon, body: Rec): Rec {
  return { type, ...body, cwd: o.cwd, sessionId: o.sid, ...ifDefined("gitBranch", o.branch), ...ifDefined("agentId", o.agentId),
    timestamp: iso(o.t ?? T0), uuid: ccUuid() };
}

/**
 * 用户记录：给了 results 时 content 是 tool_result 块数组（text 默认 "ok"，is_error 默认 false），
 * 否则 content 是手打的字符串 text（默认 ""）；origin 给了才放 {kind}，meta 给了才放 isMeta
 */
export function ccUser(o: CcCommon & { text?: string; results?: Array<{ id: string; error?: boolean; text?: string }>;
  origin?: "human" | "coordinator" | "task-notification"; meta?: boolean }): Rec {
  const content = o.results === undefined ? (o.text ?? "")
    : o.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text ?? "ok", is_error: r.error ?? false }));
  return ccRecord("user", o, { message: { role: "user", content }, ...ifDefined("isMeta", o.meta),
    ...ifDefined("origin", o.origin === undefined ? undefined : { kind: o.origin }) });
}

/** 助手记录：stop 默认有 tool_use 时 tool_use，否则 end_turn；model 默认 claude-opus-5-5 */
export function ccAssistant(o: CcCommon & { blocks: CcBlock[]; stop?: "end_turn" | "tool_use"; model?: string }): Rec {
  const stop = o.stop ?? (o.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  return ccRecord("assistant", o, { message: { role: "assistant", model: o.model ?? "claude-opus-5-5", content: o.blocks,
    stop_reason: stop } });
}

/** system 记录：message 给了才放 error: {message}（api_error 的写法） */
export function ccSystem(o: CcCommon & { subtype: "compact_boundary" | "api_error" | "stop_hook_summary"; message?: string }): Rec {
  return ccRecord("system", o, { subtype: o.subtype,
    ...ifDefined("error", o.message === undefined ? undefined : { message: o.message }) });
}

// ---- DSH 0.2.1-rc.3（session v4） ----

/** 记录的 seq：DSH 按文件内顺序编号，这里全局按序编号 */
let dshSeq = 0;

/** 头行以外的记录：{type, seq, time(毫秒), data} */
function dshRecord(type: string, data: Rec, t: number): Rec {
  return { type, seq: ++dshSeq, time: t, data };
}

/** 头行（文件第 1 行）：depth 默认 0；depth > 0 时带 origin: "subagent"；parent 给了才放 parentSession */
export function dshHeader(cwd: string, o: { id?: string; depth?: number; parent?: string; t?: number } = {}): Rec {
  const depth = o.depth ?? 0;
  return { type: "session", version: 4, id: o.id ?? "dsh-session", cwd, createdAt: o.t ?? T0, delegationDepth: depth,
    ...ifDefined("origin", depth > 0 ? "subagent" : undefined), ...ifDefined("parentSession", o.parent) };
}

/** 用户消息：content = [{type:"text",text}]；来源 kind 默认 "user" */
export function dshUser(text: string, o: { kind?: string; t?: number } = {}): Rec {
  return dshRecord("user/message", { content: [{ type: "text", text }], source: { kind: o.kind ?? "user" } }, o.t ?? T0);
}

export type DshBlock = { type: "text" | "reasoning"; text: string } | { type: "tool-call"; id: string; name: string; arguments: string };

/** 助手消息：模型在 message.source.model，默认 deepseek-flash */
export function dshAssistant(blocks: DshBlock[], o: { model?: string; t?: number } = {}): Rec {
  return dshRecord("assistant/message", { message: { content: blocks, source: { model: o.model ?? "deepseek-flash" } } }, o.t ?? T0);
}

/** 工具调用：arguments 存成 JSON 字符串 */
export function dshCall(callId: string, name: string, args: Record<string, unknown>, o: { t?: number } = {}): Rec {
  return dshRecord("tool/call", { callId, name, arguments: JSON.stringify(args) }, o.t ?? T0);
}

/**
 * 工具结果：content = [{type:"text",text}]，text 默认 "ok"，isError 默认 false；
 * errorName 给了才加 data.error = {name, code: "E"}
 */
export function dshResult(callId: string, o: { isError?: boolean; errorName?: string; text?: string; t?: number } = {}): Rec {
  return dshRecord("tool/result", { message: { toolCallId: callId, isError: o.isError ?? false,
    content: [{ type: "text", text: o.text ?? "ok" }] },
    ...ifDefined("error", o.errorName === undefined ? undefined : { name: o.errorName, code: "E" }) }, o.t ?? T0);
}

/** 回合结束 */
export function dshTurnEnd(o: { t?: number } = {}): Rec {
  return dshRecord("turn/end", {}, o.t ?? T0);
}

/** 把这些记录压成一个 zstd 帧，追加到文件末尾（自动建目录）；DSH 每追加一次就写一帧，所以文件是多个帧首尾相接 */
export function appendZstd(file: string, recs: Rec[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(jsonl(recs))));
}
