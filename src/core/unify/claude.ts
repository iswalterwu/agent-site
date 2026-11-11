// Claude Code 2.1.309 会话日志：一条记录 → 统一事件。这里是 Claude Code 记录的入口，形状只在这里校验一次：
// 产出的事件字段类型都已确定，类型不对的字段当作没有，任何输入都不抛出。规则见计划 Task 4 的记录规则和工具表。

import { ifDefined, isInt, isNonEmpty, isObj, isStr, parseJsonObject } from "../../protocol/guards";
import type { Obj } from "../../protocol/guards";
import type { SiteEvent, ToolCall } from "../types";
import { apiError, countLines, editLines, firstQuestion, nonEmptyField, pathsOf, proseEvents, strField, textArg, textOf, timeOf,
  todosField, toolResult } from "./common";

export interface ClaudeRecordInfo { cwd?: string; branch?: string; ts?: number }

/** 合成的助手消息（报错提示等）带的模型名；不是真模型，不报（E14） */
const SYNTHETIC_MODEL = "<synthetic>";

/** 任何类型的记录都可以：取 cwd、gitBranch 和 timestamp；没有、空串或类型不对的字段在结果里缺席 */
export function claudeRecordInfo(rec: unknown): ClaudeRecordInfo {
  if (!isObj(rec)) return {};
  return { ...nonEmptyField("cwd", rec.cwd), ...nonEmptyField("branch", rec.gitBranch),
    ...ifDefined("ts", timeOf(rec.timestamp) ?? undefined) };
}

/** 子 agent 旁边的 agent-<id>.meta.json；坏 JSON、顶层不是对象或 spawnDepth 不是 ≥ 1 的整数给 null */
export function readClaudeAgentMeta(raw: string): { spawnDepth: number; description?: string } | null {
  const meta = parseJsonObject(raw);
  if (meta === null || !isInt(meta.spawnDepth) || meta.spawnDepth < 1) return null;
  return { spawnDepth: meta.spawnDepth, ...strField("description", meta.description) };
}

/**
 * null = 不是对象或没有 type（计入"认不出的记录"）；
 * [] = 认得、没东西可报：user / assistant / system 以外的元数据记录（不计数，P12），以及时间读不出的记录
 */
export function unifyClaude(rec: unknown): SiteEvent[] | null {
  if (!isObj(rec) || !isStr(rec.type)) return null;
  const ts = timeOf(rec.timestamp);
  if (ts === null) return [];
  switch (rec.type) {
    case "user": return userEvents(rec, ts);
    case "assistant": return isObj(rec.message) ? assistantEvents(rec.message, ts) : [];
    case "system": return systemEvents(rec, ts);
    default: return [];
  }
}

// ---- 三种记录 ----

/** isMeta / isCompactSummary 不是用户消息；有 tool_result 块时报工具结果，否则报提示 */
function userEvents(rec: Obj, ts: number): SiteEvent[] {
  if (rec.isMeta === true || rec.isCompactSummary === true || !isObj(rec.message)) return [];
  const content = rec.message.content;
  const results = Array.isArray(content) ? content.filter(isToolResultBlock) : [];
  return results.length > 0 ? results.flatMap((b) => resultEvents(b, ts)) : promptEvents(textOf(content), rec.origin, ts);
}

const isToolResultBlock = (b: unknown): b is Obj => isObj(b) && b.type === "tool_result";

/** tool_use_id 不是字符串的块没法对上调用，不报 */
function resultEvents(block: Obj, ts: number): SiteEvent[] {
  return isStr(block.tool_use_id) ? [toolResult(block.tool_use_id, block.is_error, block.content, ts)] : [];
}

/** 空文字不报；origin.kind 没有（或类型不对）或为 human 时是用户手打，其余（coordinator、task-notification 等）算 agent */
function promptEvents(text: string, origin: unknown, ts: number): SiteEvent[] {
  if (text === "") return [];
  const kind = isObj(origin) ? origin.kind : undefined;
  return [{ kind: "prompt", ts, text, from: isStr(kind) && kind !== "human" ? "agent" : "user" }];
}

/** 先报模型（<synthetic> 不报），再按块的顺序报；stop_reason 是 tool_use 以外的字符串时回合结束 */
function assistantEvents(msg: Obj, ts: number): SiteEvent[] {
  const events: SiteEvent[] = [];
  if (isNonEmpty(msg.model) && msg.model !== SYNTHETIC_MODEL) events.push({ kind: "model", ts, model: msg.model, explicit: false });
  if (Array.isArray(msg.content)) for (const block of msg.content) events.push(...blockEvents(block, ts));
  if (isStr(msg.stop_reason) && msg.stop_reason !== "tool_use") events.push({ kind: "turn_end", ts });
  return events;
}

/** tool_use 要有字符串的 id 和 name，input 不是对象按空对象 */
function blockEvents(block: unknown, ts: number): SiteEvent[] {
  if (!isObj(block)) return [];
  switch (block.type) {
    case "thinking": case "text": return proseEvents(block, ts);
    case "tool_use":
      if (!isStr(block.id) || !isStr(block.name)) return [];
      return [{ kind: "tool_call", ts, id: block.id, call: toolCall(block.name, isObj(block.input) ? block.input : {}) }];
    default: return [];
  }
}

/** api_error 的文字先取 error.message，再取 content，都不是字符串给 "" */
function systemEvents(rec: Obj, ts: number): SiteEvent[] {
  switch (rec.subtype) {
    case "compact_boundary": return [{ kind: "compaction", ts }];
    case "api_error":
      return [apiError(isObj(rec.error) && isStr(rec.error.message) ? rec.error.message : rec.content, ts)];
    default: return [];
  }
}

// ---- 工具 → ToolCall ----

function toolCall(tool: string, input: Obj): ToolCall {
  switch (tool) {
    case "Read": case "NotebookRead": return { tool, op: "read", paths: pathsOf(input.file_path, input.notebook_path) };
    case "Grep": case "Glob": case "LS": return { tool, op: "search", paths: pathsOf(input.path) };
    case "Edit": return { tool, op: "edit", paths: pathsOf(input.file_path), ...editLines([input], "new_string", "old_string") };
    case "MultiEdit": return { tool, op: "edit", paths: pathsOf(input.file_path),
      ...editLines(Array.isArray(input.edits) ? input.edits : [], "new_string", "old_string") };
    case "Write": return { tool, op: "write", paths: pathsOf(input.file_path), added: countLines(textArg(input.content)), removed: 0 };
    case "Bash": case "PowerShell": return { tool, op: "shell", paths: [], ...strField("command", input.command) };
    case "TodoWrite": return { tool, op: "todo", paths: [], ...todosField(input.todos) };
    case "Agent": case "Task": return { tool, op: "spawn", paths: [], ...strField("title", input.description) };
    case "AskUserQuestion": return { tool, op: "ask", paths: [], ...strField("title", firstQuestion(input.questions)) };
    default: return tool.endsWith("__update_plan")
      ? { tool, op: "todo", paths: [], ...todosField(input.items) }   // 常见的 {advance} / {done, start} 没带列表，就不带 todos（E2）
      : { tool, op: "other", paths: [] };
  }
}
