// DSH 0.2.1-rc.3（session v4）会话日志：一条记录 → 统一事件。这里是 DSH 记录的入口，形状只在这里校验一次：
// 产出的事件字段类型都已确定，类型不对的字段当作没有，任何输入都不抛出。规则见计划 Task 5 的记录规则和工具表。

import { isInt, isNonEmpty, isNum, isObj, isStr, oneOf, parseJsonObject } from "../../protocol/guards";
import type { Obj } from "../../protocol/guards";
import type { SiteEvent, ToolCall } from "../types";
import { countLines, editLines, firstQuestion, nonEmptyField, pathsOf, proseEvents, strField, textArg, textOf, todosField,
  toolResult } from "./common";

/** depth = delegationDepth（缺席按 0）；parentId 只在 parentSession 是非空字符串时出现 */
export interface DshHeader { id: string; cwd: string; startedAt: number; depth: number; parentId?: string }

/** 认得但不用的记录类型：忽略、不计入"认不出的记录"（P12）；取自计划"真实日志格式"一节 */
export const DSH_IGNORED: ReadonlySet<string> = new Set(["session/title", "turn/start", "step/start", "step/end", "system/message",
  "request/header", "request/context", "permission/preset", "sandbox/mode", "approval/policy", "session-log-deepseek/delivery-accepted",
  "job/registered", "job/settled", "agent/inbox/spliced", "todo/write", "subagent/descriptor", "workspace/changes", "session/end-seed",
  "web/deepseek-search-llm-request"]);

/** 用到的类型；session 是头行，没东西可报 */
const isDshType = oneOf(["session", "user/message", "assistant/message", "tool/call", "tool/result", "turn/end"]);

/** user/message 的来源里只有这两种是提示：用户手打、别的 agent 发来（子 agent 的派工）；其余是运行时注入的上下文 */
const PROMPT_FROM: ReadonlyMap<string, "user" | "agent"> = new Map([["user", "user"], ["agent-message", "agent"]]);

/** 头行（type session）：id、cwd 是非空字符串，createdAt 是有限的毫秒数，delegationDepth 是 ≥ 0 的整数；否则给 null */
export function readDshHeader(rec: unknown): DshHeader | null {
  if (!isObj(rec) || rec.type !== "session" || !isNonEmpty(rec.id) || !isNonEmpty(rec.cwd)) return null;
  const startedAt = msOf(rec.createdAt);
  const depth = depthOf(rec.delegationDepth ?? 0);
  if (startedAt === null || depth === null) return null;
  return { id: rec.id, cwd: rec.cwd, startedAt, depth, ...nonEmptyField("parentId", rec.parentSession) };
}

/**
 * null = 不是对象或陌生的类型（计入"认不出的记录"）；
 * [] = 认得、没东西可报：DSH_IGNORED 里的类型、session 头行，以及 time 不是有限毫秒数的记录
 */
export function unifyDsh(rec: unknown): SiteEvent[] | null {
  if (!isObj(rec) || !isStr(rec.type)) return null;
  if (DSH_IGNORED.has(rec.type)) return [];
  if (!isDshType(rec.type)) return null;
  const ts = msOf(rec.time);
  if (ts === null) return [];
  const data = isObj(rec.data) ? rec.data : {};
  switch (rec.type) {
    case "user/message": return userEvents(data, ts);
    case "assistant/message": return isObj(data.message) ? assistantEvents(data.message, ts) : [];
    case "tool/call": return callEvents(data, ts);
    case "tool/result": return resultEvents(data, ts);
    case "turn/end": return [{ kind: "turn_end", ts }];
    default: return [];
  }
}

/** 毫秒时间戳：有限的数字才算，否则给 null */
const msOf = (v: unknown): number | null => (isNum(v) && Number.isFinite(v) ? v : null);

/** 委派层级：≥ 0 的整数才算，否则给 null */
const depthOf = (v: unknown): number | null => (isInt(v) && v >= 0 ? v : null);

// ---- 五种记录 ----

/** 来源是 user / agent-message 且文字非空才报提示 */
function userEvents(data: Obj, ts: number): SiteEvent[] {
  const kind = isObj(data.source) ? data.source.kind : undefined;
  const from = isStr(kind) ? PROMPT_FROM.get(kind) : undefined;
  const text = textOf(data.content);
  return from === undefined || text === "" ? [] : [{ kind: "prompt", ts, text, from }];
}

/** 先报模型（source.model），再按块的顺序报 */
function assistantEvents(msg: Obj, ts: number): SiteEvent[] {
  const model = isObj(msg.source) ? msg.source.model : undefined;
  const events: SiteEvent[] = isNonEmpty(model) ? [{ kind: "model", ts, model, explicit: false }] : [];
  if (Array.isArray(msg.content)) for (const block of msg.content) events.push(...blockEvents(block, ts));
  return events;
}

/** reasoning{text} 是思考，text{text} 是文字，空的不报；tool-call 块不报，以 tool/call 记录为准，免得重复 */
function blockEvents(block: unknown, ts: number): SiteEvent[] {
  if (!isObj(block)) return [];
  switch (block.type) {
    case "reasoning": return isNonEmpty(block.text) ? [{ kind: "thinking", ts, text: block.text }] : [];
    case "text": return proseEvents(block, ts);
    default: return [];
  }
}

/** callId、name 要是字符串；arguments 是 JSON 字符串，解析失败、顶层不是对象或不是字符串都按空对象 */
function callEvents(data: Obj, ts: number): SiteEvent[] {
  if (!isStr(data.callId) || !isStr(data.name)) return [];
  const args = (isStr(data.arguments) ? parseJsonObject(data.arguments) : null) ?? {};
  return [{ kind: "tool_call", ts, id: data.callId, call: toolCall(data.name, args) }];
}

/** 出错 = message.isError 为 true，或 data.error 存在且不是 null（不论类型，E16）；失败数取自内容文字 */
function resultEvents(data: Obj, ts: number): SiteEvent[] {
  const msg = isObj(data.message) ? data.message : {};
  if (!isStr(msg.toolCallId)) return [];
  const hasError = data.error !== undefined && data.error !== null;
  return [toolResult(msg.toolCallId, msg.isError === true || hasError, msg.content, ts)];
}

// ---- 工具 → ToolCall ----

function toolCall(tool: string, args: Obj): ToolCall {
  switch (tool) {
    case "read": case "read_image": return { tool, op: "read", paths: pathsOf(args.file_path) };
    case "grep": case "glob": return { tool, op: "search", paths: pathsOf(args.path) };
    case "edit": return { tool, op: "edit", paths: pathsOf(args.file_path), ...editLines([args], "new_string", "old_string") };
    case "write": return { tool, op: "write", paths: pathsOf(args.file_path), added: countLines(textArg(args.content)), removed: 0 };
    case "pwsh": case "bash": return { tool, op: "shell", paths: [], ...strField("command", args.command) };
    case "todo_write": return { tool, op: "todo", paths: [], ...todosField(args.todos) };
    case "subagent": case "subagent_fork": case "spawn_teammate":
      return { tool, op: "spawn", paths: [], ...strField("title", args.description) };
    case "ask_user_question": return { tool, op: "ask", paths: [], ...strField("title", firstQuestion(args.questions)) };
    default: return { tool, op: "other", paths: [] };
  }
}
