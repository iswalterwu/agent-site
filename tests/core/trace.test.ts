import { describe, expect, it } from "vitest";
import { traceOf } from "../../src/core/trace";
import type { SiteEvent } from "../../src/core/types";

const events: SiteEvent[] = [
  { kind: "prompt", ts: 1, text: "看这个 sk-abcdefgh12345678", from: "user" },
  { kind: "thinking", ts: 2, text: "先看测试。" },
  { kind: "tool_call", ts: 3, id: "c1", call: { tool: "bash", op: "shell", paths: [], command: "npm test" } },
  { kind: "tool_result", ts: 4, id: "c1", ok: false, failed: 2 },
  { kind: "turn_end", ts: 5 },
  { kind: "model", ts: 6, model: "deepseek", explicit: true },
  { kind: "compaction", ts: 7 },
  { kind: "api_error", ts: 8, message: "限流", rateLimited: true },
  { kind: "text", ts: 9, text: "重试一次。" },
  { kind: "tool_call", ts: 10, id: "c2", call: { tool: "read", op: "read", paths: ["src/a.ts"] } },
  { kind: "tool_result", ts: 11, id: "c2", ok: true },
  { kind: "thinking", ts: 12, text: "收尾。" },
];

describe("卡片轨迹", () => {
  it("最多 10 条，跳过回合结束，按旧到新", () => {
    const trace = traceOf(events);
    expect(trace).toHaveLength(10);
    expect(trace.map(entry => entry.kind)).toEqual([
      "thinking", "tool_call", "tool_result", "model", "compaction", "api_error", "text", "tool_call", "tool_result", "thinking",
    ]);
    expect(trace.map(entry => entry.at)).toEqual([2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("工具调用带工具名和目标，结果带成败", () => {
    const trace = traceOf(events);
    expect(trace.find(entry => entry.kind === "tool_call")!.text).toContain("bash");
    expect(trace.find(entry => entry.kind === "tool_call")!.text).toContain("npm test");
    expect(trace.find(entry => entry.kind === "tool_result")!.text).toBe("失败 2");
    expect(traceOf([{ kind: "tool_result", ts: 1, id: "x", ok: true, failed: 3 }])[0].text).toBe("失败 3");
  });

  it("只把显式换模型记进轨迹，普通模型的每条消息不占位置", () => {
    expect(traceOf([{ kind: "model", ts: 1, model: "deepseek", explicit: false }])).toEqual([]);
  });

  it("轨迹文字脱敏", () => {
    const trace = traceOf(events.slice(0, 1));
    expect(trace[0].text).not.toContain("abcdefgh12345678");
  });
});
