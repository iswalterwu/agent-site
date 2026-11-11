// CONTROL-10：site_todo 的参数是普通 JSON Schema，由 pi 校验；CONTROL-12：参数、结果 details 和清空行为。
import type { Message } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { TODO_GUIDELINE, registerTodo } from "../../src/bridge/todo";
import { callTool, say, startFauxSession } from "../harness/pi-faux";
import { mkTmpDir } from "../harness/wait";

type ToolResult = Extract<Message, { role: "toolResult" }>;
const resultsOf = (messages: Message[]) =>
  messages.filter((m): m is ToolResult => m.role === "toolResult" && m.toolName === "site_todo");
const textOf = (result: ToolResult) => result.content.map(c => (c.type === "text" ? c.text : "")).join("");

const boot = () => startFauxSession({ cwd: mkTmpDir(), extensions: [(pi) => registerTodo(pi)] });

it("site_todo 把完整列表写进 details.todos，模型看到条数和完成数", async () => {
  const s = await boot();
  let seen: ToolResult[] = [];
  const todos = [
    { text: "读图纸", status: "completed" },
    { text: "砌墙", status: "in_progress" },
    { text: "验收", status: "pending" },
  ];
  s.setResponses([callTool("site_todo", { todos }),
    (ctx) => { seen = resultsOf(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(seen).toHaveLength(1);
  expect(seen[0].isError).toBe(false);
  expect(textOf(seen[0])).toBe("记录 3 条待办，完成 1 条。");
  expect(seen[0].details).toEqual({ todos });
  expect(s.session.systemPrompt).toContain(TODO_GUIDELINE);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});

it("site_todo 传空列表表示清空", async () => {
  const s = await boot();
  let seen: ToolResult[] = [];
  s.setResponses([callTool("site_todo", { todos: [] }),
    (ctx) => { seen = resultsOf(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(seen).toHaveLength(1);
  expect(textOf(seen[0])).toBe("待办已清空。");
  expect(seen[0].details).toEqual({ todos: [] });
  s.dispose();
});

it("site_todo 的参数不合法时被 pi 挡在工具外，不写待办", async () => {
  const s = await boot();
  let seen: ToolResult[] = [];
  s.setResponses([callTool("site_todo", { todos: [{ text: "写代码", status: "doing" }] }),
    (ctx) => { seen = resultsOf(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(seen).toHaveLength(1);
  expect(seen[0].isError).toBe(true);
  expect((seen[0].details as { todos?: unknown } | undefined)?.todos).toBeUndefined();
  s.dispose();
});
