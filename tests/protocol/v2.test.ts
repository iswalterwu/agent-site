import { expect, it } from "vitest";
import { LIMITS, parseBridgeToSite, parseSiteToBridge, truncate } from "../../src/protocol/v2";

it("解析合法的工地指令", () => {
  expect(parseSiteToBridge('{"type":"suggest","cmdId":"c1","text":"改走方案 B","mode":"steer"}'))
    .toEqual({ type: "suggest", cmdId: "c1", text: "改走方案 B", mode: "steer" });
  expect(parseSiteToBridge('{"type":"answer","askId":"a1","cancelled":true}'))
    .toEqual({ type: "answer", askId: "a1", cancelled: true });
});
it("拒绝不合法的消息", () => {
  for (const raw of ["not json", '{"type":"nuke"}', '{"type":"pause"}', '{"type":"suggest","cmdId":"c","text":1,"mode":"steer"}',
                     '{"type":"suggest","cmdId":"c","text":"x","mode":"later"}'])
    expect(parseSiteToBridge(raw)).toBeNull();
});
const nonce = "A".repeat(43); // 32 字节的 base64url 就是 43 个字符
const session = { id: "s", cwd: "D:/r", level: 1, startedAt: "2026-11-03T00:00:00Z", mode: "tui" };

it("双向解析握手的四帧：hello 只有随机数，auth 带证明和会话", () => {
  const hello = { type: "hello", protocol: 2, nonce };
  const challenge = { type: "challenge", nonce, proof: nonce };
  const auth = { type: "auth", proof: nonce, session };
  expect(parseBridgeToSite(JSON.stringify(hello))).toEqual(hello);
  expect(parseSiteToBridge(JSON.stringify(challenge))).toEqual(challenge);
  expect(parseBridgeToSite(JSON.stringify(auth))).toEqual(auth);
  expect(parseSiteToBridge(JSON.stringify({ type: "welcome", protocol: 2 }))).toEqual({ type: "welcome", protocol: 2 });
});
it("hello 不再接受 v1 的 token 和会话：没有随机数就是坏帧", () => {
  // 旧桥接发来的 hello：有 protocol 1、token 和 session，但没有 nonce
  expect(parseBridgeToSite(JSON.stringify({ type: "hello", protocol: 1, token: "t", session }))).toBeNull();
  expect(parseBridgeToSite(JSON.stringify({ type: "hello", protocol: 2, token: "t", session, nonce }))).toEqual({ type: "hello", protocol: 2, nonce });
  expect(parseBridgeToSite(JSON.stringify({ type: "hello", protocol: 2 }))).toBeNull();
  expect(parseBridgeToSite(JSON.stringify({ type: "hello", protocol: 2, nonce: "short" }))).toBeNull();
});
it("challenge、auth 的 proof 形状不对就返回 null（不是 32 字节的 base64url 就不认）", () => {
  expect(parseSiteToBridge(JSON.stringify({ type: "challenge", nonce, proof: "x" }))).toBeNull();
  expect(parseSiteToBridge(JSON.stringify({ type: "challenge", nonce, proof: 42 }))).toBeNull();
  expect(parseBridgeToSite(JSON.stringify({ type: "auth", proof: nonce }))).toBeNull();
  expect(parseBridgeToSite(JSON.stringify({ type: "auth", proof: nonce, session: { ...session, level: "1" } }))).toBeNull();
});
it("截断中文并以省略号结尾", () => {
  const out = truncate("测".repeat(300), LIMITS.text);
  expect(out.length).toBe(200);
  expect(out.endsWith("…")).toBe(true);
  expect(truncate("短", 200)).toBe("短");
});

// 以下是补充的测试，钉住 brief 没写明、但按 spec 5.3 和"缺字段返回 null"做出的决定。
it("丢弃多余字段，缺席的可选字段不出现在结果里", () => {
  expect(parseSiteToBridge('{"type":"pause","cmdId":"c1","junk":1}')).toStrictEqual({ type: "pause", cmdId: "c1" });
  expect(parseBridgeToSite('{"type":"event","sessionId":"s","seq":1,"ts":"t","kind":"error","summary":"x","junk":1}'))
    .toStrictEqual({ type: "event", sessionId: "s", seq: 1, ts: "t", kind: "error", summary: "x" });
});
it("协议版本不符，或顶层不是对象，都返回 null", () => {
  // 除 protocol 外字段都合法：先确认 protocol 2 能解析，再确认 protocol 1 被拒，null 只能来自协议版本
  const hello = { type: "hello", protocol: 2, nonce };
  expect(parseBridgeToSite(JSON.stringify(hello))).toEqual(hello);
  expect(parseBridgeToSite(JSON.stringify({ ...hello, protocol: 1 }))).toBeNull();
  expect(parseSiteToBridge('{"type":"welcome","protocol":1}')).toBeNull();
  for (const raw of ["null", "42", '"text"', "[]"]) {
    expect(parseSiteToBridge(raw)).toBeNull();
    expect(parseBridgeToSite(raw)).toBeNull();
  }
});
it("枚举值不对，或 answer 既没有 value 也不是取消，都返回 null", () => {
  expect(parseBridgeToSite('{"type":"event","sessionId":"s","seq":1,"ts":"t","kind":"nope","summary":"x"}')).toBeNull();
  expect(parseBridgeToSite('{"type":"ask_resolved","askId":"a1","by":"later"}')).toBeNull();
  expect(parseSiteToBridge('{"type":"answer","askId":"a1"}')).toBeNull();
  expect(parseSiteToBridge('{"type":"answer","askId":"a1","cancelled":false}')).toBeNull();
});
it("解析 event、state、ask，可选字段出现时必须合法", () => {
  const event = { type: "event", sessionId: "s", seq: 3, ts: "2026-11-03T00:00:03Z", kind: "tool_end", summary: "read a.ts", detail: { ok: true, durationMs: 12 } };
  const state = { type: "state", sessionId: "s", paused: true, holding: { tool: "bash", sinceMs: 1500 }, idle: false };
  const ask = { type: "ask", sessionId: "s", askId: "a1", question: "选哪个？", options: ["A", "B"], allowOther: true };
  expect(parseBridgeToSite(JSON.stringify(event))).toEqual(event);
  expect(parseBridgeToSite(JSON.stringify(state))).toEqual(state);
  expect(parseBridgeToSite(JSON.stringify(ask))).toEqual(ask);
  expect(parseBridgeToSite(JSON.stringify({ ...state, holding: { tool: "bash" } }))).toBeNull();
});
it("截断不切开代理对：截断处若是高代理项就连它一起去掉，结果仍以省略号结尾", () => {
  expect(truncate("a😀b", 3)).toBe("a…");
  expect(truncate("a".repeat(199) + "😀", LIMITS.text)).toBe("a".repeat(199) + "…");
  const out = truncate("😀".repeat(150), LIMITS.text);
  expect(out.length).toBe(199);
  expect(out.length).toBeLessThanOrEqual(LIMITS.text);
  expect(out.endsWith("…")).toBe(true);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
});
