// 把 pi 的会话事件转成摘要事件交给 EventSink：只带截断后的文字、工具名、命令和路径，不带文件内容。
// 这里只观察、不改动：每个处理函数都用 safe 包住，出错一律吞掉，绝不影响 agent；返回值也一律是 undefined，
// 因为 pi 会把 message_end、turn_end 处理函数的返回值当作替换消息 / 边界提议来用。
//
// 用户提示取自 message_end 里角色为 user 的消息，而不是 input 事件：每条真正进入对话的用户消息都有 message_end
// （包括桥接经 sendUserMessage 送出的建议，以及排队后才被取走的插话），而 input 发生在提交的时候，消息可能还在排队；
// input 还是"后一个处理函数拿到前一个的返回值"的链式事件，不订阅更稳妥。
// sessionId / seq / ts 由接收方（Task 10 的 sink）加上，这里不管。

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI, MessageEndEvent, ModelSelectEvent, ToolExecutionEndEvent, ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { LIMITS, truncate } from "../protocol/v2";
import type { EventKind } from "../protocol/v2";
import { safe } from "./safe";

export interface EventSink { emit(kind: EventKind, summary: string, detail?: Record<string, unknown>): void }

type Report = EventSink["emit"];

const RATE_LIMIT = /429|rate.?limit/i;
const UNKNOWN_ERROR = "模型调用出错"; // 出错的回复没带错误信息时的摘要

/**
 * 工具调用的一行摘要：带 command 的是 "工具: 命令"（命令截到 LIMITS.command），带 path 的是 "工具 路径"，其余只有工具名。
 * 只取命令和路径，不取文件内容（write 的 content、edit 的新旧文本都不进摘要）。
 */
export function summarizeToolArgs(tool: string, args: unknown): string {
  const { command, path } = asRecord(args);
  if (typeof command === "string") return `${tool}: ${truncate(command, LIMITS.command)}`;
  if (typeof path === "string") return `${tool} ${path}`;
  return tool;
}

/**
 * 订阅 pi 事件并转成摘要事件：用户消息 → user_prompt；助手消息的文本块 / 思考块 → assistant_text / thinking，
 * stopReason 为 error → error；工具开始 / 结束 → tool_start / tool_end（detail 带 toolCallId，App 靠它给并行的调用配对）；
 * 切换模型 → model_change；压缩 → compaction；回合结束 → turn_end；agent 彻底收尾（agent_settled）→ agent_idle。
 * 所有摘要都经 truncate(…, LIMITS.text)。
 * agent_idle 取自 agent_settled 而不是 agent_end：agent_end 之后重试、压缩、排队的消息还可能再起一次运行，
 * 一次重试就会有两个 agent_end；agent_settled 才表示没有后续运行了（被中断的运行同样会收尾）。
 * 返回退订函数，调用它就拆掉这里订阅的每一个处理函数（用的是 pi.on 返回的退订函数，扩展在运行期间随时可用）。
 */
export function installEventForwarding(pi: ExtensionAPI, sink: EventSink,
  opts: { isBridgeInjected: (text: string) => boolean }): () => void {
  const report: Report = (kind, summary, detail) => sink.emit(kind, truncate(summary, LIMITS.text), detail);

  const unsubscribes = [
    pi.on("message_end", safe((event: MessageEndEvent) => {
      const { message } = event;
      if (message.role === "user") reportUserPrompt(message, report, opts.isBridgeInjected);
      else if (message.role === "assistant") reportAssistantMessage(message, report);
    }, undefined)),

    pi.on("tool_execution_start", safe((event: ToolExecutionStartEvent) => {
      report("tool_start", summarizeToolArgs(event.toolName, event.args), { tool: event.toolName, toolCallId: event.toolCallId });
    }, undefined)),

    pi.on("tool_execution_end", safe((event: ToolExecutionEndEvent) => {
      const { toolName, toolCallId, isError, durationMs } = event;
      // 没真正执行的调用（比如被拦下）没有耗时：键缺席，不编造一个数
      const detail = { tool: toolName, toolCallId, ok: !isError, ...(durationMs === undefined ? {} : { durationMs }) };
      report("tool_end", `${toolName} ${isError ? "失败" : "完成"}`, detail);
    }, undefined)),

    pi.on("model_select", safe((event: ModelSelectEvent) => {
      report("model_change", `${event.model.provider}/${event.model.id}`);
    }, undefined)),

    pi.on("session_compact", safe(() => { report("compaction", "压缩上下文"); }, undefined)),
    pi.on("turn_end", safe(() => { report("turn_end", "回合结束"); }, undefined)),
    pi.on("agent_settled", safe(() => { report("agent_idle", "空闲"); }, undefined)),
  ];
  return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
}

/** 用户消息 → user_prompt；来源按完整原文判断（不是截断后的摘要），每条消息只问 isBridgeInjected 一次 */
function reportUserPrompt(message: UserMessage, report: Report, isBridgeInjected: (text: string) => boolean): void {
  const text = textOf(message.content);
  report("user_prompt", text, { source: isBridgeInjected(text) ? "bridge" : "user" });
}

/** 助手消息：文本块 → assistant_text、思考块 → thinking，按出现顺序各一条（空白的跳过，工具调用块不报）；出错时最后再补一条 error */
function reportAssistantMessage(message: AssistantMessage, report: Report): void {
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim() !== "") report("assistant_text", block.text);
    else if (block.type === "thinking" && block.thinking.trim() !== "") report("thinking", block.thinking);
  }
  if (message.stopReason === "error") {
    const reason = message.errorMessage ?? "";
    report("error", reason || UNKNOWN_ERROR, { category: RATE_LIMIT.test(reason) ? "rate_limit" : "api_error" });
  }
}

/** 用户消息的文本：字符串原样；内容块只取文本块（图片不算），多块用换行连接 */
function textOf(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
