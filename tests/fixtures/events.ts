// 统一事件的测试构造器：会话归约（session）和动作判定（actions）的测试共用

import type { SessionMeta, SiteEvent, ToolCall, ToolOp } from "../../src/core/types";
import { min } from "./logs";

export const meta: SessionMeta = { key: "pi:s1", harness: "pi", nativeId: "s1", file: "f.jsonl", cwd: "D:/r", startedAt: min(0), level: 1 };

export const call = (id: string, c: Partial<ToolCall> & { tool: string; op: ToolOp }, t: number): SiteEvent =>
  ({ kind: "tool_call", ts: t, id, call: { paths: [], ...c } });

export const result = (id: string, ok: boolean, t: number, failed?: number): SiteEvent =>
  ({ kind: "tool_result", ts: t, id, ok, ...(failed === undefined ? {} : { failed }) });
