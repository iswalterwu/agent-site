// 卡片里的模型轨迹：把会话事件压成最多 10 条可读记录，每条带类型。
// 只留提示、回复、思考、工具调用 / 结果、模型、压缩和报错；回合结束没有可读内容，不占位置。
// 文字一律先脱敏再截断（E1），和气泡共用一条红线。

import { truncate } from "../protocol/v2";
import { redact } from "./redact";
import type { SiteEvent, TraceEntry, ToolCall } from "./types";

export const TRACE_MAX = 10;
export const TRACE_TEXT_MAX = 160;

export function traceOf(events: readonly SiteEvent[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  for (const event of events) {
    const entry = traceEntry(event);
    if (entry !== null) entries.push(entry);
  }
  return entries.slice(-TRACE_MAX);
}

function traceEntry(event: SiteEvent): TraceEntry | null {
  switch (event.kind) {
    case "prompt": return entry(event.ts, "prompt", event.text);
    case "text": return entry(event.ts, "text", event.text);
    case "thinking": return entry(event.ts, "thinking", event.text);
    case "tool_call": return entry(event.ts, "tool_call", callText(event.call));
    case "tool_result": {
      const failed = event.failed ?? 0;
      return entry(event.ts, "tool_result", failed > 0 ? `失败 ${failed}` : event.ok ? "成功" : "失败");
    }
    case "model": return event.explicit ? entry(event.ts, "model", event.model) : null;
    case "compaction": return entry(event.ts, "compaction", "压缩上下文");
    case "api_error": return entry(event.ts, "api_error", event.message);
    default: return null;
  }
}

function entry(at: number, kind: TraceEntry["kind"], text: string): TraceEntry {
  return { at, kind, text: truncate(redact(text.replace(/\s+/g, " ").trim()), TRACE_TEXT_MAX) };
}

/** 工具调用显示工具名和第一个可读目标；命令、路径和标题都先脱敏再截断 */
function callText(call: ToolCall): string {
  const target = call.command ?? call.paths[0] ?? call.title ?? "";
  return target === "" ? call.tool : `${call.tool} · ${target}`;
}
