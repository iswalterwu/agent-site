// 三种会话日志转换共用的小件：读时间、数行、取失败数、取文字、取待办，几家写法相同的事件（思考 / 文字块、工具结果、API 报错），
// 可选的字符串字段（记录、头行和工具调用都用），以及工具表里几家取法相同的字段（路径、增删行数、待办列表、第一个问题）。
// 只认输入里真有的值，不推算，任何输入都不抛出。

import { ifDefined, isNonEmpty, isObj, isStr, oneOf } from "../../protocol/guards";
import type { Obj } from "../../protocol/guards";
import type { SiteEvent, TodoItem } from "../types";

/** API 报错里有 429 或 rate limit 就算限流 */
export const RATE_LIMIT_RE = /429|rate.?limit/i;

/** 记录的 timestamp 是 ISO 字符串；读不出给 null */
export function timeOf(v: unknown): number | null {
  const ts = isStr(v) ? Date.parse(v) : NaN;
  return Number.isNaN(ts) ? null : ts;
}

/** 字符串参数；不是字符串当作没有，按 "" 数行 */
export const textArg = (v: unknown): string => (isStr(v) ? v : "");

/** 文字的行数："" 是 0；去掉一个结尾换行后按 \n 切分计数 */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/** 测试输出里的"N failed"；没有就是 undefined。(?<!\d) 让数字串只从开头试一次，长数字串也是线性时间（E11） */
export function failedCount(text: string): number | undefined {
  const m = /(?<!\d)(\d+)\s+failed\b/i.exec(text);
  return m === null ? undefined : Number(m[1]);
}

/** 消息内容的文字：字符串原样；块数组只取 text 块，用 \n 连接；其他形状给 "" */
export function textOf(content: unknown): string {
  if (isStr(content)) return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((b) => (isObj(b) && b.type === "text" && isStr(b.text) ? [b.text] : [])).join("\n");
}

const isTodoStatus = oneOf<TodoItem["status"]>(["pending", "in_progress", "completed"]);

/** 待办列表：不是数组给 []，不是对象的项跳过；文字取 content（没有就取 text，都没有给 ""）；status 不是三种之一按 pending */
export function toTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((t) => ({
    text: isStr(t.content) ? t.content : isStr(t.text) ? t.text : isStr(t.step) ? t.step : "",
    status: isTodoStatus(t.status) ? t.status : "pending",
  }));
}

/** 助手消息里的 thinking{thinking} / text{text} 块：非空才报；空的或别的块给 [] */
export function proseEvents(block: Obj, ts: number): SiteEvent[] {
  if (block.type === "thinking" && isNonEmpty(block.thinking)) return [{ kind: "thinking", ts, text: block.thinking }];
  if (block.type === "text" && isNonEmpty(block.text)) return [{ kind: "text", ts, text: block.text }];
  return [];
}

/** 工具结果：成败只看 isError === true；文字里的"N failed"记为失败数 */
export function toolResult(id: string, isError: unknown, content: unknown, ts: number): SiteEvent {
  return { kind: "tool_result", ts, id, ok: isError !== true, ...ifDefined("failed", failedCount(textOf(content))) };
}

/** API 报错：文字不是字符串按 ""；有 429 或 rate limit 算限流 */
export function apiError(message: unknown, ts: number): SiteEvent {
  const text = textArg(message);
  return { kind: "api_error", ts, message: text, rateLimited: RATE_LIMIT_RE.test(text) };
}

// ---- 可选的字符串字段：展开进结果对象（记录信息、头行、ToolCall），没有值的字段真的缺席 ----

/** 字符串值才带这个字段，否则字段缺席 */
export const strField = <K extends string>(key: K, v: unknown): Partial<Record<K, string>> => ifDefined(key, isStr(v) ? v : undefined);

/** 非空字符串才带这个字段；空串和类型不对的值都当作没有 */
export const nonEmptyField = <K extends string>(key: K, v: unknown): Partial<Record<K, string>> =>
  ifDefined(key, isNonEmpty(v) ? v : undefined);

// ---- 工具表里几家取法相同的字段：展开进 ToolCall，没有值的字段真的缺席 ----

/** 第一个非空字符串的路径放进列表（例如 file_path ?? notebook_path）；都不是给 [] */
export function pathsOf(...candidates: unknown[]): string[] {
  const path = candidates.find(isNonEmpty);
  return path === undefined ? [] : [path];
}

/** 改动的增删行数：Σ 新文字 / Σ 旧文字的行数，两个键名由各家给（newText / new_string）；不是对象的项跳过 */
export function editLines(list: unknown[], newKey: string, oldKey: string): { added: number; removed: number } {
  const edits = list.filter(isObj);
  return {
    added: edits.reduce((n, e) => n + countLines(textArg(e[newKey])), 0),
    removed: edits.reduce((n, e) => n + countLines(textArg(e[oldKey])), 0),
  };
}

/** 输入里真有列表才带 todos（E2），空数组也是列表；不是数组时字段缺席，免得清空会话的待办 */
export const todosField = (list: unknown): { todos?: TodoItem[] } => ifDefined("todos", Array.isArray(list) ? toTodos(list) : undefined);

/** 提问工具的第一个问题（questions[0].question）；取不到给 undefined */
export function firstQuestion(questions: unknown): unknown {
  return Array.isArray(questions) && isObj(questions[0]) ? questions[0].question : undefined;
}
