// 桥接协议 v2：桥接（pi 扩展）与工地（桌面应用）之间，每帧一条 JSON。
// 握手是四帧：hello → challenge → auth → welcome，口令不上线，两端各自用 HMAC 证明（见 auth.ts）。
// 两个解析器都是手写的逐字段校验：输入不合法就返回 null，绝不抛出；结果只含协议定义的字段。

import { ifDefined, isBool, isNum, isObj, isStr, isStrArray, oneOf, optional, parseJsonObject } from "./guards";
import type { Obj } from "./guards";

export const PROTOCOL_VERSION = 2;
export const LIMITS = { text: 200, command: 120 } as const;

export type EventKind = "user_prompt" | "assistant_text" | "thinking" | "tool_start" | "tool_end"
  | "model_change" | "compaction" | "turn_end" | "agent_idle" | "error";

export interface SessionInfo { id: string; file?: string; cwd: string; model?: string; provider?: string;
  parentId?: string; level: number; startedAt: string; mode: string }

export type BridgeToSite =
  | { type: "hello"; protocol: 2; nonce: string }
  | { type: "auth"; proof: string; session: SessionInfo }
  | { type: "event"; sessionId: string; seq: number; ts: string; kind: EventKind; summary: string; detail?: Record<string, unknown> }
  | { type: "state"; sessionId: string; paused: boolean; holding?: { tool: string; sinceMs: number }; idle: boolean }
  | { type: "ask"; sessionId: string; askId: string; question: string; options: string[]; allowOther: boolean; context?: string }
  | { type: "ask_resolved"; askId: string; by: "site" | "terminal" | "offline" | "cancelled" }
  | { type: "ack"; cmdId: string; ok: boolean; error?: string }
  | { type: "bye"; sessionId: string; reason: string }
  | { type: "ping" } | { type: "pong" };

export type SiteToBridge =
  | { type: "challenge"; nonce: string; proof: string }
  | { type: "welcome"; protocol: 2 }
  | { type: "pause"; cmdId: string } | { type: "resume"; cmdId: string } | { type: "abort"; cmdId: string }
  | { type: "suggest"; cmdId: string; text: string; mode: "steer" | "followUp" }
  | { type: "answer"; askId: string; value?: string; cancelled?: boolean; auto?: boolean }
  | { type: "ping" } | { type: "pong" };

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** 截到 max-1 个 UTF-16 码元再加省略号；截断处若会留下半个代理对，就连高代理项一起去掉，结果长度不超过 max */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = isHighSurrogate(text.charCodeAt(max - 2)) ? max - 2 : max - 1;
  return `${text.slice(0, end)}…`;
}

/** 解析工地发来的一帧；不合法返回 null */
export function parseSiteToBridge(raw: string): SiteToBridge | null {
  const msg = parseJsonObject(raw);
  if (msg === null) return null;
  switch (msg.type) {
    case "challenge": return parseChallenge(msg);
    case "welcome": return parseWelcome(msg);
    case "pause": return parseCommand(msg, "pause");
    case "resume": return parseCommand(msg, "resume");
    case "abort": return parseCommand(msg, "abort");
    case "suggest": return parseSuggest(msg);
    case "answer": return parseAnswer(msg);
    case "ping": return { type: "ping" };
    case "pong": return { type: "pong" };
    default: return null;
  }
}

/** 解析桥接发来的一帧；不合法返回 null */
export function parseBridgeToSite(raw: string): BridgeToSite | null {
  const msg = parseJsonObject(raw);
  if (msg === null) return null;
  switch (msg.type) {
    case "hello": return parseHello(msg);
    case "auth": return parseAuth(msg);
    case "event": return parseEvent(msg);
    case "state": return parseState(msg);
    case "ask": return parseAsk(msg);
    case "ask_resolved": return parseAskResolved(msg);
    case "ack": return parseAck(msg);
    case "bye": return parseBye(msg);
    case "ping": return { type: "ping" };
    case "pong": return { type: "pong" };
    default: return null;
  }
}

const isOptStr = optional(isStr);
const isOptBool = optional(isBool);
const isOptObj = optional(isObj);

const EVENT_KINDS: readonly EventKind[] = ["user_prompt", "assistant_text", "thinking", "tool_start", "tool_end",
  "model_change", "compaction", "turn_end", "agent_idle", "error"];
const isEventKind = oneOf(EVENT_KINDS);
const isResolvedBy = oneOf(["site", "terminal", "offline", "cancelled"] as const);
const isSuggestMode = oneOf(["steer", "followUp"] as const);

function parseWelcome(m: Obj): SiteToBridge | null {
  return m.protocol === PROTOCOL_VERSION ? { type: "welcome", protocol: PROTOCOL_VERSION } : null;
}

function parseCommand(m: Obj, type: "pause" | "resume" | "abort"): SiteToBridge | null {
  const { cmdId } = m;
  return isStr(cmdId) ? { type, cmdId } : null;
}

function parseSuggest(m: Obj): SiteToBridge | null {
  const { cmdId, text, mode } = m;
  if (!isStr(cmdId) || !isStr(text) || !isSuggestMode(mode)) return null;
  return { type: "suggest", cmdId, text, mode };
}

function parseAnswer(m: Obj): SiteToBridge | null {
  const { askId, value, cancelled, auto } = m;
  if (!isStr(askId) || !isOptStr(value) || !isOptBool(cancelled) || !isOptBool(auto)) return null;
  // 答案要么带 value，要么是 cancelled: true；auto 只跟着自动取消走（App 没把问题给人看过）
  if (value === undefined && cancelled !== true) return null;
  return { type: "answer", askId, ...ifDefined("value", value), ...ifDefined("cancelled", cancelled), ...ifDefined("auto", auto) };
}

/** 32 字节的随机数或 HMAC 结果，base64url：43 个字符 */
const isNonce = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);

function parseHello(m: Obj): BridgeToSite | null {
  const { protocol, nonce } = m;
  if (protocol !== PROTOCOL_VERSION || !isNonce(nonce)) return null;
  return { type: "hello", protocol: PROTOCOL_VERSION, nonce };
}

function parseAuth(m: Obj): BridgeToSite | null {
  const { proof, session } = m;
  const info = parseSession(session);
  if (!isNonce(proof) || info === null) return null;
  return { type: "auth", proof, session: info };
}

function parseChallenge(m: Obj): SiteToBridge | null {
  const { nonce, proof } = m;
  if (!isNonce(nonce) || !isNonce(proof)) return null;
  return { type: "challenge", nonce, proof };
}

function parseSession(v: unknown): SessionInfo | null {
  if (!isObj(v)) return null;
  const { id, file, cwd, model, provider, parentId, level, startedAt, mode } = v;
  if (!isStr(id) || !isOptStr(file) || !isStr(cwd) || !isOptStr(model) || !isOptStr(provider) ||
      !isOptStr(parentId) || !isNum(level) || !isStr(startedAt) || !isStr(mode)) {
    return null;
  }
  return {
    id, cwd, level, startedAt, mode,
    ...ifDefined("file", file), ...ifDefined("model", model),
    ...ifDefined("provider", provider), ...ifDefined("parentId", parentId),
  };
}

function parseEvent(m: Obj): BridgeToSite | null {
  const { sessionId, seq, ts, kind, summary, detail } = m;
  if (!isStr(sessionId) || !isNum(seq) || !isStr(ts) || !isEventKind(kind) || !isStr(summary) || !isOptObj(detail)) {
    return null;
  }
  return { type: "event", sessionId, seq, ts, kind, summary, ...ifDefined("detail", detail) };
}

function parseState(m: Obj): BridgeToSite | null {
  const { sessionId, paused, holding, idle } = m;
  const parsedHolding = holding === undefined ? undefined : parseHolding(holding);
  if (!isStr(sessionId) || !isBool(paused) || !isBool(idle) || parsedHolding === null) return null;
  return { type: "state", sessionId, paused, idle, ...ifDefined("holding", parsedHolding) };
}

function parseHolding(v: unknown): { tool: string; sinceMs: number } | null {
  if (!isObj(v)) return null;
  const { tool, sinceMs } = v;
  if (!isStr(tool) || !isNum(sinceMs)) return null;
  return { tool, sinceMs };
}

function parseAsk(m: Obj): BridgeToSite | null {
  const { sessionId, askId, question, options, allowOther, context } = m;
  if (!isStr(sessionId) || !isStr(askId) || !isStr(question) || !isStrArray(options) || !isBool(allowOther) ||
      !isOptStr(context)) {
    return null;
  }
  return { type: "ask", sessionId, askId, question, options, allowOther, ...ifDefined("context", context) };
}

function parseAskResolved(m: Obj): BridgeToSite | null {
  const { askId, by } = m;
  if (!isStr(askId) || !isResolvedBy(by)) return null;
  return { type: "ask_resolved", askId, by };
}

function parseAck(m: Obj): BridgeToSite | null {
  const { cmdId, ok, error } = m;
  if (!isStr(cmdId) || !isBool(ok) || !isOptStr(error)) return null;
  return { type: "ack", cmdId, ok, ...ifDefined("error", error) };
}

function parseBye(m: Obj): BridgeToSite | null {
  const { sessionId, reason } = m;
  if (!isStr(sessionId) || !isStr(reason)) return null;
  return { type: "bye", sessionId, reason };
}
