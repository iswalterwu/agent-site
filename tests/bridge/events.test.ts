import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { installEventForwarding, summarizeToolArgs } from "../../src/bridge/events";
import type { EventSink } from "../../src/bridge/events";
import { LIMITS, truncate } from "../../src/protocol/v2";
import type { EventKind } from "../../src/protocol/v2";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Got { kind: EventKind; summary: string; detail?: Record<string, unknown> }

/**
 * 只替换 pi 这一层边界：记下扩展注册的事件处理函数，供测试直接触发并观察返回值。
 * 摘要转换、截断、safe 都是真实实现；真实 pi 里的事件形状见 events.e2e.test.ts。
 */
function install(opts: { sink?: EventSink; isBridgeInjected?: (text: string) => boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => { if (handlers.get(name) === handler) handlers.delete(name); }; // 和 pi 一样：退订只摘掉自己这一个
    },
  } as unknown as ExtensionAPI;
  const got: Got[] = [];
  const sink: EventSink = opts.sink ?? {
    emit(kind, summary, detail) {
      got.push(detail === undefined ? { kind, summary } : { kind, summary, detail });
    },
  };
  const remove = installEventForwarding(pi, sink, { isBridgeInjected: opts.isBridgeInjected ?? (() => false) });
  const fire = (type: string, event: object = {}) => {
    const handler = handlers.get(type);
    if (handler === undefined) throw new Error(`没有订阅 ${type}`); // 免得"没订阅"被误当成"返回了 undefined"
    return handler({ type, ...event }, {});
  };
  /** 像 pi 那样分发事件：订阅了才会调到处理函数，没人订阅就什么都不发生 */
  const emit = (type: string, event: object = {}) => handlers.get(type)?.({ type, ...event }, {});
  return { got, handlers, fire, emit, remove };
}

const userMessage = (content: unknown) => ({ message: { role: "user", content, timestamp: 0 } });
const assistantMessage = (content: unknown[], extra: object = {}) => ({ message: { role: "assistant", content, stopReason: "stop", ...extra } });

it("工具参数摘要", () => {
  expect(summarizeToolArgs("bash", { command: "npm test -- " + "x".repeat(300) }).length).toBeLessThanOrEqual(LIMITS.command + 6);
  expect(summarizeToolArgs("bash", { command: "pytest -q" })).toBe("bash: pytest -q");
  expect(summarizeToolArgs("edit", { path: "src/a.ts", oldText: "...", newText: "..." })).toBe("edit src/a.ts");
  expect(summarizeToolArgs("probe", { n: 1 })).toBe("probe");
});

// 以下是补充的测试：摘要的边界、事件映射的细节、截断、处理函数永不抛出且返回 undefined。
it("命令恰好 LIMITS.command 个字符原样保留，多一个字就截断并以省略号结尾", () => {
  const exact = "c".repeat(LIMITS.command);
  expect(summarizeToolArgs("bash", { command: exact })).toBe(`bash: ${exact}`);
  const over = summarizeToolArgs("bash", { command: `${exact}c` });
  expect(over).toBe(`bash: ${truncate(`${exact}c`, LIMITS.command)}`);
  expect(over).toHaveLength("bash: ".length + LIMITS.command);
  expect(over.endsWith("…")).toBe(true);
});
it("带 command 的工具摘要是 工具: 命令（powershell 同理）；带 path 的只取路径，不带文件内容", () => {
  expect(summarizeToolArgs("powershell", { command: "Get-ChildItem" })).toBe("powershell: Get-ChildItem");
  expect(summarizeToolArgs("write", { path: "docs/a.md", content: "SECRET BODY" })).toBe("write docs/a.md");
  expect(summarizeToolArgs("read", { path: "src/a.ts", offset: 10, limit: 5 })).toBe("read src/a.ts");
  expect(summarizeToolArgs("grep", { pattern: "TODO", path: "src" })).toBe("grep src");
  expect(summarizeToolArgs("grep", { pattern: "TODO" })).toBe("grep");
  expect(summarizeToolArgs("ls", {})).toBe("ls");
  expect(summarizeToolArgs("run", { command: "make", path: "build" })).toBe("run: make"); // 两者都有时命令更能说明在做什么
});
it("参数不是对象、或 command / path 不是字符串时，摘要只有工具名", () => {
  for (const args of [undefined, null, "bash", 42, [], { command: 1 }, { path: {} }]) {
    expect(summarizeToolArgs("bash", args), JSON.stringify(args)).toBe("bash");
  }
});

it("只订阅需要的事件：用户提示取自 message_end，不订阅 input", () => {
  const { handlers } = install();
  expect([...handlers.keys()].sort()).toEqual(
    ["agent_settled", "message_end", "model_select", "session_compact", "tool_execution_end", "tool_execution_start", "turn_end"],
  );
});
it("返回的函数退订这里订阅的每一个事件：之后什么都不再上报", () => {
  const { got, handlers, emit, remove } = install();
  remove();
  expect([...handlers.keys()]).toEqual([]);
  emit("message_end", userMessage("hi"));
  emit("turn_end");
  emit("agent_settled", { aborted: false });
  expect(got).toEqual([]);
});

it("用户消息 → user_prompt：来源按 isBridgeInjected 判断，用的是完整原文而不是截断后的摘要，每条只问一次", () => {
  const injected = "请先补测试。".repeat(60); // 远超 LIMITS.text
  const asked: string[] = [];
  const { got, fire } = install({ isBridgeInjected: (text) => { asked.push(text); return text === injected; } });
  fire("message_end", userMessage([{ type: "text", text: "你好" }]));
  fire("message_end", userMessage([{ type: "text", text: injected }]));
  expect(asked).toEqual(["你好", injected]); // 工地一侧"命中即删除"，问两次就会漏判
  expect(got).toEqual([
    { kind: "user_prompt", summary: "你好", detail: { source: "user" } },
    { kind: "user_prompt", summary: truncate(injected, LIMITS.text), detail: { source: "bridge" } },
  ]);
});
it("用户消息的文本：纯字符串内容、多个文本块用换行连接、图片块不进摘要", () => {
  const { got, fire } = install();
  fire("message_end", userMessage("纯字符串"));
  fire("message_end", userMessage([
    { type: "text", text: "第一段" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "text", text: "第二段" },
  ]));
  expect(got.map((g) => g.summary)).toEqual(["纯字符串", "第一段\n第二段"]);
});

it("助手消息：思考块和文本块按出现顺序各报一条，工具调用块不报", () => {
  const { got, fire } = install();
  fire("message_end", assistantMessage([
    { type: "thinking", thinking: "先看看测试" },
    { type: "text", text: "我来改" },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    { type: "text", text: "改完了" },
  ]));
  expect(got).toEqual([
    { kind: "thinking", summary: "先看看测试" },
    { kind: "assistant_text", summary: "我来改" },
    { kind: "assistant_text", summary: "改完了" },
  ]);
});
it("空白的文本块和思考块（包括被隐去的思考）不报；没有内容块的消息什么都不报", () => {
  const { got, fire } = install();
  fire("message_end", assistantMessage([
    { type: "text", text: "" },
    { type: "text", text: " \n" },
    { type: "thinking", thinking: "", redacted: true },
    { type: "thinking", thinking: "  " },
  ]));
  fire("message_end", assistantMessage([]));
  expect(got).toEqual([]);
});
it("stopReason 为 error：先报内容块，最后报 error，摘要是错误信息", () => {
  const { got, fire } = install();
  fire("message_end", assistantMessage([{ type: "text", text: "写到一半" }], { stopReason: "error", errorMessage: "invalid request: nope" }));
  expect(got).toEqual([
    { kind: "assistant_text", summary: "写到一半" },
    { kind: "error", summary: "invalid request: nope", detail: { category: "api_error" } },
  ]);
});
it("error 的类别：错误信息含 429 或 rate limit（不分大小写，中间的分隔符可有可无）是 rate_limit，其余是 api_error，没有错误信息也是 api_error", () => {
  const cases: Array<[string | undefined, string]> = [
    ["429 Too Many Requests", "rate_limit"],
    ["Rate limit exceeded", "rate_limit"],
    ["hit the rate-limit", "rate_limit"],
    ["RATE_LIMIT_ERROR", "rate_limit"],
    ["ratelimit", "rate_limit"],
    ["HTTP 500 Internal Server Error", "api_error"],
    ["invalid api key", "api_error"],
    [undefined, "api_error"],
  ];
  for (const [errorMessage, category] of cases) {
    const { got, fire } = install();
    fire("message_end", assistantMessage([], { stopReason: "error", errorMessage }));
    expect(got, String(errorMessage)).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "error", detail: { category } });
    expect(got[0].summary.length, String(errorMessage)).toBeGreaterThan(0); // 没有错误信息时也要有可读的摘要
  }
});
it("stopReason 不是 error 就不报 error，哪怕带着 errorMessage（被中断时 pi 会带上）", () => {
  const { got, fire } = install();
  fire("message_end", assistantMessage([{ type: "text", text: "写到一半" }], { stopReason: "aborted", errorMessage: "Request was aborted" }));
  expect(got.map((g) => g.kind)).toEqual(["assistant_text"]);
});
it("其他角色的消息（工具结果、系统消息、自定义消息）不上报", () => {
  const { got, fire } = install();
  for (const role of ["toolResult", "system", "custom", "bashExecution"]) {
    fire("message_end", { message: { role, content: [{ type: "text", text: "x" }] } });
  }
  expect(got).toEqual([]);
});

it("工具开始：摘要是参数摘要，detail 带工具名和 toolCallId（App 靠它给并行的调用配对）", () => {
  const { got, fire } = install();
  fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "pytest -q" } });
  fire("tool_execution_start", { toolCallId: "c2", toolName: "edit", args: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] } });
  expect(got).toEqual([
    { kind: "tool_start", summary: "bash: pytest -q", detail: { tool: "bash", toolCallId: "c1" } },
    { kind: "tool_start", summary: "edit src/a.ts", detail: { tool: "edit", toolCallId: "c2" } },
  ]);
});
it("工具结束：detail 是 { tool, toolCallId, ok, durationMs }；没真正执行（耗时缺席）时不编造耗时", () => {
  const { got, fire } = install();
  fire("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: false, durationMs: 12 });
  fire("tool_execution_end", { toolCallId: "c2", toolName: "bash", result: {}, isError: true, durationMs: 340 });
  fire("tool_execution_end", { toolCallId: "c3", toolName: "edit", result: {}, isError: true });
  expect(got).toEqual([
    { kind: "tool_end", summary: "bash 完成", detail: { tool: "bash", toolCallId: "c1", ok: true, durationMs: 12 } },
    { kind: "tool_end", summary: "bash 失败", detail: { tool: "bash", toolCallId: "c2", ok: false, durationMs: 340 } },
    { kind: "tool_end", summary: "edit 失败", detail: { tool: "edit", toolCallId: "c3", ok: false } },
  ]);
  expect(Object.keys(got[2].detail ?? {})).toEqual(["tool", "toolCallId", "ok"]); // 键缺席，而不是带着 undefined 值
});

it("模型切换：摘要是 provider/id", () => {
  const { got, fire } = install();
  fire("model_select", { model: { provider: "anthropic", id: "claude-opus-4-5" }, previousModel: undefined, source: "set" });
  expect(got).toEqual([{ kind: "model_change", summary: "anthropic/claude-opus-4-5" }]);
});
it("压缩上下文、回合结束、agent 彻底收尾（空闲）各报一条，没有 detail", () => {
  const { got, fire } = install();
  fire("session_compact", { fromExtension: false, reason: "threshold", willRetry: false });
  fire("turn_end", { turnIndex: 0 });
  fire("agent_settled", { aborted: false });
  expect(got).toEqual([
    { kind: "compaction", summary: "压缩上下文" },
    { kind: "turn_end", summary: "回合结束" },
    { kind: "agent_idle", summary: "空闲" },
  ]);
});
it("agent_end 只是一次运行结束，后面可能还有重试、压缩或排队的运行：自己不报 agent_idle，收尾（agent_settled）时才报，且只报一次", () => {
  const { got, emit } = install();
  emit("turn_end");
  emit("agent_end", { messages: [] }); // 第一次运行结束，pi 接着要重试
  expect(got.map((g) => g.kind)).toEqual(["turn_end"]);
  emit("turn_end");
  emit("agent_end", { messages: [] }); // 重试的那次运行也结束了
  expect(got.map((g) => g.kind)).toEqual(["turn_end", "turn_end"]);
  emit("agent_settled", { aborted: false });
  expect(got.map((g) => g.kind)).toEqual(["turn_end", "turn_end", "agent_idle"]);
});
it("被中断的运行同样会收尾，agent_settled 带 aborted: true 时也报 agent_idle", () => {
  const { got, fire } = install();
  fire("agent_settled", { aborted: true });
  expect(got).toEqual([{ kind: "agent_idle", summary: "空闲" }]);
});

it("所有摘要都经 truncate(…, LIMITS.text)：超长的提示、思考、文本、错误信息、路径都截到上限并以省略号结尾", () => {
  const long = "字".repeat(500);
  const { got, fire } = install();
  fire("message_end", userMessage([{ type: "text", text: long }]));
  fire("message_end", assistantMessage(
    [{ type: "thinking", thinking: long }, { type: "text", text: long }],
    { stopReason: "error", errorMessage: long },
  ));
  fire("tool_execution_start", { toolName: "read", args: { path: "p/".repeat(200) } });
  expect(got.map((g) => g.kind)).toEqual(["user_prompt", "thinking", "assistant_text", "error", "tool_start"]);
  for (const { summary } of got) {
    expect(summary).toHaveLength(LIMITS.text);
    expect(summary.endsWith("…")).toBe(true);
  }
  expect(got[0].summary).toBe(truncate(long, LIMITS.text));
});
it("命令摘要只按 LIMITS.command 截一次，不会被 LIMITS.text 再截", () => {
  const command = "x".repeat(300);
  const { got, fire } = install();
  fire("tool_execution_start", { toolName: "bash", args: { command } });
  expect(got[0].summary).toBe(summarizeToolArgs("bash", { command }));
  expect(got[0].summary).toHaveLength("bash: ".length + LIMITS.command);
});

it("处理函数一律返回 undefined（pi 会把 message_end、turn_end 的返回值当作替换结果），sink 返回值或抛错都一样", () => {
  const events: Array<[string, object]> = [
    ["message_end", userMessage("hi")],
    ["message_end", assistantMessage([{ type: "text", text: "hi" }], { stopReason: "error", errorMessage: "x" })],
    ["tool_execution_start", { toolName: "bash", args: { command: "ls" } }],
    ["tool_execution_end", { toolName: "bash", isError: false, durationMs: 1 }],
    ["model_select", { model: { provider: "p", id: "m" } }],
    ["session_compact", {}],
    ["turn_end", {}],
    ["agent_settled", { aborted: false }],
  ];
  const sinks: EventSink[] = [
    { emit: () => 42 }, // 像 got.push 那样顺手带回一个值
    { emit: () => { throw new Error("sink 坏了"); } },
  ];
  for (const sink of sinks) {
    const { fire } = install({ sink });
    for (const [type, event] of events) {
      expect(() => fire(type, event), type).not.toThrow();
      expect(fire(type, event), type).toBeUndefined();
    }
  }
});
it("sink 抛错只丢掉这一次，后面的事件照常上报；isBridgeInjected 抛错同样不外溢", () => {
  const got: string[] = [];
  let calls = 0;
  const { fire } = install({
    sink: { emit: (_kind, summary) => { if (calls++ === 0) throw new Error("第一次就坏"); got.push(summary); } },
  });
  expect(fire("turn_end")).toBeUndefined();
  expect(fire("agent_settled", { aborted: false })).toBeUndefined();
  expect(got).toEqual(["空闲"]);

  const broken = install({ isBridgeInjected: () => { throw new Error("判断坏了"); } });
  expect(() => broken.fire("message_end", userMessage("hi"))).not.toThrow();
  expect(broken.got).toEqual([]);
});
it("畸形事件（缺少 message / model）也不抛出、不上报", () => {
  const { got, fire } = install();
  for (const type of ["message_end", "model_select"]) {
    expect(() => fire(type), type).not.toThrow();
    expect(fire(type), type).toBeUndefined();
  }
  expect(got).toEqual([]);
});
