// site_todo：被监视仓库的一级 pi 会话用这个工具记录待办。App 不通过桥接协议收待办，
// 只读会话日志里 toolResult 的 details.todos（SITE-7）；这里只负责把模型给的列表整理成结果。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { safe } from "./safe";

export const TODO_TOOL = "site_todo";
export const TODO_LIMIT = 50;
export const TODO_TEXT_MAX = 500;
export const TODO_SNIPPET = "记录或更新这个会话的待办和进度，桌面工地按它画楼层";
export const TODO_GUIDELINE = "计划或进度变化时调用 site_todo，传完整待办列表，不要只在回复里列计划。";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem { text: string; status: TodoStatus }
export interface TodoOutcome {
  content: Array<{ type: "text"; text: string }>;
  details: { todos?: TodoItem[] };
}

interface TodoArgs { todos: TodoItem[] }

/**
 * 参数用普通 JSON Schema，不在运行时 import typebox：桥接装在全局，宿主不提供这个模块时
 * 所有 pi 会话都起不来（CONTROL-10）。
 */
const TodoParams = {
  type: "object",
  properties: {
    todos: {
      type: "array", maxItems: TODO_LIMIT,
      description: "完整待办列表，按执行顺序排列；空数组表示清空",
      items: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: TODO_TEXT_MAX, description: "这条待办要做什么" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "pending 未开始，in_progress 进行中，completed 已完成" },
        },
        required: ["text", "status"],
      },
    },
  },
  required: ["todos"],
} as unknown as TSchema;

/** 给模型的文字和给 App 的 details 都从这里出，测试直接断言这个形状 */
export function todoOutcome(todos: readonly TodoItem[]): TodoOutcome {
  const done = todos.filter(item => item.status === "completed").length;
  const text = todos.length === 0 ? "待办已清空。" : `记录 ${todos.length} 条待办，完成 ${done} 条。`;
  return { content: [{ type: "text", text }], details: { todos: todos.map(item => ({ text: item.text, status: item.status })) } };
}

/** 参数已经由 pi 按 schema 校验过；这里只是把类型写清楚，并保证不抛出 */
export function registerTodo(pi: ExtensionAPI): void {
  const run = safe((value: unknown): TodoOutcome => {
    const params = value as TodoArgs;
    return todoOutcome(params.todos.map(item => ({ text: item.text, status: item.status })));
  }, { content: [{ type: "text", text: "site_todo 没有记录：参数不合法。" }], details: {} });

  pi.registerTool({
    name: TODO_TOOL,
    label: "工地待办",
    description: "记录或更新这个会话的待办列表。桌面工地把待办画成楼层；计划或进度变化时调用，传完整列表，空数组清空。",
    promptSnippet: TODO_SNIPPET,
    promptGuidelines: [TODO_GUIDELINE],
    parameters: TodoParams,
    exposure: "model-only",
    async execute(_toolCallId, value) {
      return await run(value);
    },
  });
}
