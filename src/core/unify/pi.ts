// pi 1.4.0（session v3）会话日志：一条记录 → 统一事件。这里是 pi 记录的入口，形状只在这里校验一次：
// 产出的事件字段类型都已确定，类型不对的字段当作没有，任何输入都不抛出。规则见计划 Task 3 的两张表。

import { isNonEmpty, isObj, isStr, oneOf } from "../../protocol/guards";
import type { Obj } from "../../protocol/guards";
import type { SiteEvent, TodoItem, ToolCall } from "../types";
import { apiError, countLines, editLines, pathsOf, proseEvents, strField, textArg, textOf, timeOf, todosField, toolResult } from "./common";

export interface PiHeader { id: string; cwd: string; startedAt: number }

/** 认得的条目类型；除 message、model_change、compaction 外都没东西可报 */
const isPiEntryType = oneOf(["session", "message", "model_change", "compaction", "thinking_level_change", "context_edit",
  "session_info", "usage", "custom", "custom_message", "label", "branch_summary"]);

/** 头行（type session）给出会话 ID、工作目录和开始时间；不是头行或字段不全给 null */
export function readPiHeader(rec: unknown): PiHeader | null {
  if (!isObj(rec) || rec.type !== "session" || !isStr(rec.id) || !isStr(rec.cwd)) return null;
  const startedAt = timeOf(rec.timestamp);
  return startedAt === null ? null : { id: rec.id, cwd: rec.cwd, startedAt };
}

/** null = 不是对象或陌生的条目类型（计入"认不出的记录"）；[] = 认得、没东西可报（含时间读不出的条目） */
export function unifyPi(rec: unknown): SiteEvent[] | null {
  if (!isObj(rec) || !isPiEntryType(rec.type)) return null;
  const ts = timeOf(rec.timestamp);
  if (ts === null) return [];
  switch (rec.type) {
    case "message": return isObj(rec.message) ? messageEvents(rec.message, ts) : [];
    case "model_change": return isNonEmpty(rec.modelId) ? [{ kind: "model", ts, model: rec.modelId, explicit: true }] : [];
    case "compaction": return [{ kind: "compaction", ts }];
    default: return [];
  }
}

// ---- message：按 role 分 ----

function messageEvents(msg: Obj, ts: number): SiteEvent[] {
  switch (msg.role) {
    case "user": return userEvents(msg, ts);
    case "assistant": return assistantEvents(msg, ts);
    case "toolResult": return toolResultEvents(msg, ts);
    default: return [];
  }
}

function userEvents(msg: Obj, ts: number): SiteEvent[] {
  const text = textOf(msg.content);
  return text === "" ? [] : [{ kind: "prompt", ts, text, from: "user" }];
}

/** 先报模型，再按块的顺序报；error 追加 API 报错；还要调工具（toolUse）之外都算回合结束 */
function assistantEvents(msg: Obj, ts: number): SiteEvent[] {
  const events: SiteEvent[] = [];
  if (isNonEmpty(msg.model)) events.push({ kind: "model", ts, model: msg.model, explicit: false });
  if (Array.isArray(msg.content)) for (const block of msg.content) events.push(...blockEvents(block, ts));
  if (msg.stopReason === "error") events.push(apiError(msg.errorMessage, ts));
  // 长度截断时如果已经发出了工具调用，agent 还会接着跑，这回合没结束
  const truncatedWithCall = msg.stopReason === "length" && hasToolCall(msg.content);
  if (msg.stopReason !== "toolUse" && !truncatedWithCall) events.push({ kind: "turn_end", ts });
  return events;
}

function hasToolCall(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => isObj(block) && block.type === "toolCall");
}

/** 空的 thinking / text 不报；toolCall 要有字符串的 id 和 name，arguments 不是对象按空对象 */
function blockEvents(block: unknown, ts: number): SiteEvent[] {
  if (!isObj(block)) return [];
  switch (block.type) {
    case "thinking": case "text": return proseEvents(block, ts);
    case "toolCall":
      if (!isStr(block.id) || !isStr(block.name)) return [];
      return [{ kind: "tool_call", ts, id: block.id, call: toolCall(block.name, isObj(block.arguments) ? block.arguments : {}) }];
    default: return [];
  }
}

// site_todo 的待办只从结果的 details 取：pi 可能以参数不合法挡下调用，而 toolCall 原文照样进日志；
// 调用参数只用来给动作分类（session.ts 对 site_todo 的调用参数不写 todos，见 CONTROL-12）。
function toolResultEvents(msg: Obj, ts: number): SiteEvent[] {
  if (!isStr(msg.toolCallId)) return [];
  const event = toolResult(msg.toolCallId, msg.isError, msg.content, ts);
  const details = isObj(msg.details) ? msg.details : undefined;
  const todos = details === undefined ? undefined : piTodos(details.todos);
  return [todos === undefined ? event : { ...event, todos } as SiteEvent];
}

/** pi 的待办结果：列表在 details.todos，状态是 done 布尔（也认 status） */
function piTodos(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(isObj).map((item) => ({
    text: isStr(item.text) ? item.text : isStr(item.content) ? item.content : "",
    status: item.done === true || item.status === "completed" ? "completed"
      : item.status === "in_progress" || item.status === "in-progress" ? "in_progress" : "pending",
  }));
}

// ---- 工具 → ToolCall ----

function toolCall(tool: string, args: Obj): ToolCall {
  const paths = pathsOf(args.path);
  switch (tool) {
    case "read": return { tool, op: "read", paths };
    case "grep": case "find": case "ls": return { tool, op: "search", paths };
    case "edit": return { tool, op: "edit", paths, ...editLines(editList(args), "newText", "oldText") };
    case "write": return { tool, op: "write", paths, added: countLines(textArg(args.content)), removed: 0 };
    case "bash": case "powershell": return { tool, op: "shell", paths: [], ...strField("command", args.command) };
    case "todo": case "todos": case "todo_write": case "update_plan": case "update_todos": case "site_todo":
      return { tool, op: "todo", paths: [], ...todosField(todoList(args)) };
    default: return { tool, op: "other", paths: [] };
  }
}

/** 待办工具的列表字段：todos / items / plan 三种常见写法 */
function todoList(args: Obj): unknown {
  return Array.isArray(args.todos) ? args.todos : Array.isArray(args.items) ? args.items : Array.isArray(args.plan) ? args.plan : undefined;
}

/**
 * 照 pi 1.4.0 的 prepareEditArguments 归一（E10）：edits 是 JSON 字符串时先解析（失败按空数组）；数组原样；
 * 单个 {oldText, newText} 当作一条；顶层还有旧式的 oldText / newText 一对时，追加在后面
 */
function editList(args: Obj): unknown[] {
  const raw = isStr(args.edits) ? parseJson(args.edits) : args.edits;
  const edits = Array.isArray(raw) ? raw : isEditPair(raw) ? [raw] : [];
  return isEditPair(args) ? [...edits, { oldText: args.oldText, newText: args.newText }] : edits;
}

const isEditPair = (v: unknown): v is { oldText: string; newText: string } => isObj(v) && isStr(v.oldText) && isStr(v.newText);

/** 坏 JSON 给 undefined，不抛出 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
