// 状态判定：从会话状态和最后一个动作判出工人的状态（等你 / 中途断掉 / 空闲 / 在干）。
// 规则见计划 Task 7，按顺序取第一条命中的；P3 定了回合结束只判一级会话，P4 定了提问不限层级。
// 气泡先拼好整句再过 bubble（E5），所以带前缀也不超过 BUBBLE_MAX；等你的详情先脱敏再截断（E1）。

import { LIMITS, truncate } from "../protocol/v2";
import { redact } from "./redact";
import { bubble, lastSentence } from "./text";
import type { ActionView, SessionState, SiteEvent, Thresholds, TrackedCall, WorkerStatus } from "./types";

export const DEFAULT_THRESHOLDS: Thresholds = { idleMinutes: 10, stalledMinutes: 30, onsiteHours: 24 };
/** "等你"超过这么久转入历史分组；固定 24 小时，不随上工地时限变 */
export const HISTORY_AFTER_MS = 86_400_000;

/** text 是气泡（≤ BUBBLE_MAX）；detail 是详情卡"等你时附上问题原文"用的全文（截到 LIMITS.text），只有 waiting 才有 */
export interface StatusView { status: WorkerStatus; since: number; text: string; detail: string | null; onSite: boolean }

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * quiet = now − 最后事件时间。在不在工地上独立计算；状态依次试：提问没有结果 → 一级会话回合结束 → 最后一次调用
 * 没有结果且静了 stalledMinutes → 静了 idleMinutes → 在干。后三种 since 都是最后事件时间，气泡用最后一个动作的文字
 */
export function sessionStatus(s: SessionState, lastAction: ActionView | null, now: number, t: Thresholds): StatusView {
  const quiet = now - s.lastEventAt;
  const lastCall = s.calls.at(-1);
  const action = lastAction?.text ?? "";
  const verdict = askWaiting(lastCall)
    ?? (s.meta.level === 1 ? turnEndWaiting(s.events) : null)
    ?? (lastCall !== undefined && lastCall.result === undefined && quiet >= t.stalledMinutes * MINUTE_MS
      ? quietVerdict("stalled", s.lastEventAt, `停在：${action}`) : null)
    ?? quietVerdict(quiet >= t.idleMinutes * MINUTE_MS ? "idle" : "working", s.lastEventAt, action);
  return { ...verdict, text: bubble(verdict.text), onSite: quiet < t.onsiteHours * HOUR_MS };
}

/** 判出的状态；text 是拼好的整句，还没过 bubble */
type Verdict = Omit<StatusView, "onSite">;
type TextEvent = Extract<SiteEvent, { kind: "text" }>;

/** 中途断掉、空闲、在干：since 是最后事件时间，没有详情 */
const quietVerdict = (status: WorkerStatus, since: number, text: string): Verdict => ({ status, since, text, detail: null });

/** 等你时回答问题的原文；状态详情截断到 200 字之前用它，保留问题结尾 */
export function waitingSource(s: SessionState): string | null {
  const call = s.calls.at(-1);
  if (call?.call.op === "ask" && call.result === undefined) return call.call.title ?? null;
  const markerIndex = s.events.findLastIndex((ev) => ev.kind === "prompt" || ev.kind === "tool_call" || ev.kind === "turn_end");
  const marker = s.events[markerIndex];
  if (marker?.kind !== "turn_end") return null;
  const promptIndex = s.events.findLastIndex((ev) => ev.kind === "prompt");
  return s.events.slice(promptIndex + 1, markerIndex).findLast((ev): ev is TextEvent => ev.kind === "text")?.text ?? null;
}

/** 详情：先脱敏再截到 LIMITS.text（E1），截断处落在密钥中间也遮得住 */
const detailOf = (text: string): string => truncate(redact(text), LIMITS.text);

/** P4：最后一次调用是提问、还没有结果 → 等你；since 是调用时间，详情是问题。标题缺失或空白时用工具名，详情为 null */
function askWaiting(call: TrackedCall | undefined): Verdict | null {
  if (call?.call.op !== "ask" || call.result !== undefined) return null;
  const { title, tool } = call.call;
  const hasTitle = title !== undefined && title.trim() !== "";
  return { status: "waiting", since: call.ts, text: `可能：${hasTitle ? title : tool}`, detail: hasTitle ? detailOf(title) : null };
}

/**
 * P3：从后往前第一个 prompt / tool_call / turn_end 是 turn_end → 等你，since 是那个 turn_end 的时间。
 * 只取最新 prompt 之后、该 turn_end 之前的最后一个 text；没有文字或末句为空时写"回合结束"，详情为 null（E22）。
 * 同一回复的几个 turn_end 同时间戳，取哪个都一样，不去重
 */
function turnEndWaiting(events: readonly SiteEvent[]): Verdict | null {
  const markerIndex = events.findLastIndex((ev) => ev.kind === "prompt" || ev.kind === "tool_call" || ev.kind === "turn_end");
  const marker = events[markerIndex];
  if (marker?.kind !== "turn_end") return null;
  const promptIndex = events.findLastIndex((ev) => ev.kind === "prompt");
  const said = events.slice(promptIndex + 1, markerIndex).findLast((ev): ev is TextEvent => ev.kind === "text");
  const sentence = said === undefined ? "" : lastSentence(said.text);
  return said === undefined || sentence === ""
    ? { status: "waiting", since: marker.ts, text: "可能：回合结束", detail: null }
    : { status: "waiting", since: marker.ts, text: `可能：${sentence}`, detail: detailOf(said.text) };
}
