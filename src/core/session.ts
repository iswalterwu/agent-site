// 会话归约：把统一事件逐条并进会话状态。事件和工具调用都只留最近的一段（环形缓冲）；
// 状态是不可变数据，applyEvents 返回新对象，入参的数组和调用对象都不改。

import { ifDefined } from "../protocol/guards";
import { truncate } from "../protocol/v2";
import type { SessionMeta, SessionState, SiteEvent, TodoItem, TrackedCall } from "./types";

export const MAX_EVENTS = 200;
export const MAX_CALLS = 20;
/** 派工抬头和"你是 <角色>"都在提示开头，留前 4000 字够用 */
export const FIRST_PROMPT_MAX = 4000;

/** 事件与调用为空，lastEventAt = 开始时间 */
export function newSession(meta: SessionMeta): SessionState {
  return { meta, events: [], calls: [], lastEventAt: meta.startedAt };
}

/** 并入一批事件；缓冲在整批并完后再裁，结果和逐条并入相同 */
export function applyEvents(s: SessionState, events: readonly SiteEvent[]): SessionState {
  const draft: Draft = { calls: [...s.calls], firstPrompt: s.firstPrompt, model: s.model, todos: s.todos, lastEventAt: s.lastEventAt };
  for (const ev of events) applyEvent(draft, ev);
  return {
    meta: s.meta,
    events: [...s.events, ...events].slice(-MAX_EVENTS),
    calls: draft.calls.slice(-MAX_CALLS),
    lastEventAt: draft.lastEventAt,
    ...ifDefined("firstPrompt", draft.firstPrompt),
    ...ifDefined("model", draft.model),
    ...ifDefined("todos", draft.todos),
  };
}

/** 并入过程中的可变草稿；calls 是新数组，只往里放新对象或入参里原样的调用 */
interface Draft { calls: TrackedCall[]; firstPrompt?: string; model?: string; todos?: readonly TodoItem[]; lastEventAt: number }

/**
 * 一条事件改草稿：工具调用进调用列表；结果挂到同 id 的调用上；只记第一条提示；模型取最新；
 * 待办调用带列表时才换待办（E2：没带列表的 advance 一类调用保留原来的待办，空列表照样清空）
 */
function applyEvent(d: Draft, ev: SiteEvent): void {
  d.lastEventAt = Math.max(d.lastEventAt, ev.ts);
  switch (ev.kind) {
    case "tool_call":
      d.calls.push({ id: ev.id, ts: ev.ts, call: ev.call });
      // site_todo 的参数只用于动作分类；待办以 toolResult 的 details 为准，pi 挡下的调用不能改状态
      if (ev.call.op === "todo" && ev.call.todos !== undefined && ev.call.tool !== "site_todo") d.todos = ev.call.todos;
      return;
    case "tool_result": attachResult(d.calls, ev); if (ev.todos !== undefined) d.todos = ev.todos; return;
    case "prompt": d.firstPrompt ??= truncate(ev.text, FIRST_PROMPT_MAX); return;
    case "model": d.model = ev.model; return;
    default: return;
  }
}

/**
 * 结果归属的唯一规则：同 id、在结果之前最新的那次调用。calls 按先后排列、只含结果之前的调用；找不到给 -1。
 * applyEvents 挂结果和 deriveActions 判成败都按它配对，重复 id 时两边一致
 */
export function ownerIndex(calls: readonly { id: string }[], resultId: string): number {
  return calls.findLastIndex((c) => c.id === resultId);
}

/** 把结果挂到所属调用上（换成新对象）；找不到就不动（结果只留在事件里） */
function attachResult(calls: TrackedCall[], ev: Extract<SiteEvent, { kind: "tool_result" }>): void {
  const i = ownerIndex(calls, ev.id);
  if (i === -1) return;
  calls[i] = { ...calls[i], result: { ts: ev.ts, ok: ev.ok, ...ifDefined("failed", ev.failed) } };
}
