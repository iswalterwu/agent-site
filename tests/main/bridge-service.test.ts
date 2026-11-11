import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SiteLink } from "../../src/bridge/link";
import { runAsk, SKIPPED_NOTE } from "../../src/bridge/ask";
import { fakeUi, never, resolveAfter } from "../bridge/ask-fakes";
import { BridgeService } from "../../src/main/bridge-service";
import { bridgeProof, newNonce, proofMatches, siteProof } from "../../src/protocol/auth";
import { PROTOCOL_VERSION } from "../../src/protocol/v2";
import type { SessionInfo, SiteToBridge } from "../../src/protocol/v2";
import { mkTmpDir, waitFor } from "../harness/wait";

const TOKEN = "a".repeat(64);

interface Open {
  service: BridgeService;
  link: SiteLink;
  file: string;
  port: number;
  received: SiteToBridge[];
  session: SessionInfo;
  failNextAck: (error: string) => void;
  setAutoAck: (on: boolean) => void;
}

const opened: Open[] = [];
afterEach(() => {
  for (const item of opened.splice(0).reverse()) { item.link.stop("test done"); item.service.stop(); }
});

async function open(commandTimeoutMs = 5000, extra: Partial<ConstructorParameters<typeof BridgeService>[0]> = {}): Promise<Open> {
  const file = path.join(mkTmpDir(), "bridge.json");
  const service = new BridgeService({ file, repos: ["D:/r"], token: TOKEN, commandTimeoutMs: 1000, pingMs: 1000, deadMs: 3000, ...extra });
  const { port } = await service.start();
  const received: SiteToBridge[] = [];
  let ackError: string | null = null;
  let autoAck = true;
  const session: SessionInfo = { id: "s1", cwd: "D:/r", level: 1, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" };
  const link = new SiteLink({
    file, session: () => session,
    onCommand: (msg) => {
      received.push(msg);
      if (!autoAck) return;
      const cmdId = (msg as Extract<SiteToBridge, { cmdId: string }>).cmdId;
      link.send({ type: "ack", cmdId, ok: ackError === null, ...(ackError === null ? {} : { error: ackError }) });
      ackError = null;
    },
    timings: { retryMs: 50, pingMs: 100, deadMs: 1000, welcomeMs: 1000 },
  });
  link.start();
  // 等的是链路自己在线：App 一侧标成 online 比链路收到 welcome 早一帧，这一帧里发的帧会被丢掉
  await waitFor(() => service.sessions().some(item => item.online) && link.isOnline());
  const item = { service, link, file, port, received, session,
    failNextAck: (error: string) => { ackError = error; },
    setAutoAck: (on: boolean) => { autoAck = on; } };
  opened.push(item);
  return item;
}

/**
 * 最小的桥接客户端：hello → 验工地的 challenge → auth → 等 welcome。只用来单独测 App 一侧；
 * 真实的 SiteLink 与 BridgeService 的联测在 tests/bridge/bridge.e2e.test.ts。
 * protocol 传 1 之类可以模拟旧桥接，secret 传错可以模拟不知道口令的对端。
 */
async function handshake(port: number, session: SessionInfo, protocol = PROTOCOL_VERSION, secret = TOKEN): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const bridgeNonce = newNonce();
  ws.send(JSON.stringify({ type: "hello", protocol, nonce: bridgeNonce }));
  if (protocol !== PROTOCOL_VERSION) return ws; // 旧协议：App 应当直接关掉，不握手
  const challenge = await new Promise<{ nonce: string; proof: string }>((resolve, reject) => {
    ws.once("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type !== "challenge") return reject(new Error(`expected challenge, got ${msg.type}`));
      resolve(msg as unknown as { nonce: string; proof: string });
    });
    ws.once("close", () => reject(new Error("closed before challenge")));
  });
  const nonces = { bridgeNonce, siteNonce: challenge.nonce };
  if (!proofMatches(siteProof(secret, nonces), challenge.proof)) throw new Error("challenge 里的证明不对");
  ws.send(JSON.stringify({ type: "auth", proof: bridgeProof(secret, nonces), session }));
  await new Promise<void>((resolve, reject) => { ws.once("message", () => resolve()); ws.once("close", () => reject(new Error("closed before welcome"))); });
  return ws;
}

describe("BridgeService", () => {
  it("启动写 bridge.json，握手后在线，坏口令断开", async () => {
    const { service, file } = await open();
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw).toMatchObject({ protocol: 2, token: TOKEN, pid: process.pid, repos: ["D:/r"] });
    expect(raw.port).toBeGreaterThan(0);
    expect(service.sessions()).toMatchObject([{ key: "pi:s1", online: true, controllable: true }]);

    const bad = new WebSocket(`ws://127.0.0.1:${raw.port}/bridge`);
    await new Promise<void>((resolve, reject) => { bad.once("open", () => resolve()); bad.once("error", reject); });
    // 旧协议的 hello（协议 1）：不握手，直接关掉，不进在线表
    bad.send(JSON.stringify({ type: "hello", protocol: 1, nonce: newNonce(), session: { ...service.sessions()[0]!.info, id: "bad" } }));
    await new Promise<void>(resolve => { bad.once("close", () => resolve()); });
    expect(service.sessions().map(item => item.key)).toEqual(["pi:s1"]);
  });

  it("暂停 / 继续走真实 WebSocket 并等 ack，state 更新在线状态", async () => {
    const { service, link, received } = await open();
    const pause = service.command("pi:s1", { type: "pause" });
    const paused = await pause;
    expect(paused).toEqual({ ok: true });
    expect(received.map(msg => msg.type)).toContain("pause");

    link.send({ type: "state", sessionId: "s1", paused: true, holding: { tool: "bash", sinceMs: 12 }, idle: false });
    await waitFor(() => service.sessions()[0]!.paused);
    expect(service.sessions()[0]).toMatchObject({ paused: true, holding: { tool: "bash", sinceMs: 12 } });

    link.send({ type: "state", sessionId: "s1", paused: false, idle: false });
    await waitFor(() => service.sessions()[0]!.paused === false);
    expect(await service.command("pi:s1", { type: "resume" })).toEqual({ ok: true });
    expect(received.map(msg => msg.type)).toContain("resume");
    expect(await service.command("pi:s1", { type: "suggest", text: "先补测试", mode: "steer" })).toEqual({ ok: true });
    expect(received.find(msg => msg.type === "suggest")).toMatchObject({ text: "先补测试", mode: "steer" });
    expect(await service.command("pi:s1", { type: "suggest", text: "做完再看", mode: "followUp" })).toEqual({ ok: true });
    expect(received.findLast(msg => msg.type === "suggest")).toMatchObject({ text: "做完再看", mode: "followUp" });
    expect(await service.command("pi:s1", { type: "abort" })).toEqual({ ok: true });
    expect(received.map(msg => msg.type)).toContain("abort");
  });

  it("SITE-4：setSites 只在工地集合变了才重写 bridge.json，并把移出范围的在线连接关掉", async () => {
    const { service, file } = await open(5000, { inScope: async (cwd, repos) => repos.includes(cwd) });
    const written = () => JSON.parse(readFileSync(file, "utf8")).repos;
    const before = readFileSync(file, "utf8");
    await service.setSites(["D:/r"]);
    expect(readFileSync(file, "utf8")).toBe(before); // 集合没变：不重写，不打断心跳
    await service.setSites(["D:/r", "D:/other", "D:/r"]);
    expect(written()).toEqual(["D:/other", "D:/r"]); // 去重后按路径排序
    await service.setSites(["D:/other"]);
    await waitFor(() => service.sessions().every(item => !item.online));
    expect(written()).toEqual(["D:/other"]);
    await service.setSites(["D:/other", "D:/r"]);
    await waitFor(() => service.sessions().some(item => item.online)); // 再进范围：桥接自己重连上来
    expect(written()).toEqual(["D:/other", "D:/r"]);
  });

  it("三级会话只读，不能通过 IPC 发指令", async () => {
    const { service, port } = await open();
    const ws = await handshake(port, { ...service.sessions()[0]!.info, id: "s3", level: 3 });
    try {
      await waitFor(() => service.sessions().some(item => item.key === "pi:s3"));
      expect(service.sessions().find(item => item.key === "pi:s3")!.controllable).toBe(false);
      expect(await service.command("pi:s3", { type: "pause" })).toEqual({ ok: false, error: "只读会话不能控制" });
    } finally { ws.close(); }
  });

  it("同一个 sessionId 重连时关掉旧连接，而不是留下不可控制的旧连接", async () => {
    const { service, port } = await open();
    const ws = await handshake(port, { ...service.sessions()[0]!.info, id: "s1" });
    try {
      await waitFor(() => service.sessions().length === 1);
      expect(service.sessions()[0]!.sessionId).toBe("s1");
    } finally { ws.close(); }
  });

  it("ack 的错误和 holding.tool 在进入 App 前脱敏", async () => {
    const { service, link, failNextAck } = await open();
    const secret = "sk-abcdefgh12345678";
    link.send({ type: "state", sessionId: "s1", paused: true, holding: { tool: secret, sinceMs: 1 }, idle: false });
    await waitFor(() => service.sessions()[0]!.paused);
    expect(service.sessions()[0]!.holding!.tool).not.toContain("abcdefgh12345678");
    failNextAck(secret);
    const result = await service.command("pi:s1", { type: "pause" });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("abcdefgh12345678");
  });

  it("没有 ack 时超时失败，断连时立即结束等待", async () => {
    const { service, link, setAutoAck } = await open(200);
    setAutoAck(false);
    const started = Date.now();
    const timedOut = await service.command("pi:s1", { type: "pause" });
    expect(timedOut).toEqual({ ok: false, error: "桥接没有回执，稍后再试" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);

    setAutoAck(false);
    const pending = service.command("pi:s1", { type: "abort" });
    link.stop("test");
    await expect(pending).resolves.toEqual({ ok: false, error: "连接已断开" });
  });

  it("坏协议不欢迎：协议 1 的 hello、或 auth 的证明不对，都直接断开", async () => {
    const { service, port } = await open();
    const old = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    await new Promise<void>((resolve, reject) => { old.once("open", () => resolve()); old.once("error", reject); });
    old.send(JSON.stringify({ type: "hello", protocol: 1, nonce: newNonce(),
      session: { id: "proto", cwd: "D:/r", level: 1, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" } }));
    await new Promise<void>(resolve => { old.once("close", () => resolve()); });

    // 形状都对、证明是瞎写的：不 welcome，也不进在线表
    const forged = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    await new Promise<void>((resolve, reject) => { forged.once("open", () => resolve()); forged.once("error", reject); });
    const bridgeNonce = newNonce();
    forged.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, nonce: bridgeNonce }));
    await new Promise<void>((resolve, reject) => { forged.once("message", () => resolve()); forged.once("error", reject); });
    forged.send(JSON.stringify({ type: "auth", proof: "Y".repeat(43),
      session: { id: "forged", cwd: "D:/r", level: 1, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" } }));
    await new Promise<void>(resolve => { forged.once("close", () => resolve()); });
    expect(service.sessions().map(item => item.key)).toEqual(["pi:s1"]);
  });
  it("没通过握手就发指令或事件：帧被丢掉，连接不会被当成在线", async () => {
    const { service, port } = await open();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, nonce: newNonce() }));
    await new Promise<void>((resolve, reject) => { ws.once("message", () => resolve()); ws.once("error", reject); }); // challenge
    ws.send(JSON.stringify({ type: "state", sessionId: "s1", paused: true, idle: false }));
    ws.send(JSON.stringify({ type: "ask", sessionId: "s1", askId: "a1", question: "?", options: [], allowOther: false }));
    await new Promise<void>(resolve => { ws.once("close", () => resolve()); }); // 握手期只认 auth，其他帧一律断开
    expect(service.sessions().map(item => item.key)).toEqual(["pi:s1"]);
    expect(service.asks()).toEqual([]);
    await ws.close();
  });

  it("一级会话的 ask 留在服务里，回答写回，ask_resolved 才移除", async () => {
    const { service, link } = await open();
    const controller = new AbortController();
    const pending = link.ask({ askId: "ask-1", question: "选哪个？", options: ["甲", "乙"], allowOther: true, context: "上下文" }, controller.signal);
    await waitFor(() => service.asks().length === 1);
    expect(service.asks()[0]).toMatchObject({ askId: "ask-1", sessionKey: "pi:s1", sessionId: "s1",
      question: "选哪个？", options: ["甲", "乙"], allowOther: true, context: "上下文" });
    expect(service.answer("ask-1", "甲")).toEqual({ accepted: true });
    await expect(pending).resolves.toEqual({ kind: "answer", text: "甲" });
    expect(service.asks()).toHaveLength(1);
    link.resolved("ask-1", "site");
    await waitFor(() => service.asks().length === 0);
    expect(service.answer("ask-1", "乙")).toEqual({ accepted: false, reason: "这个决策已经结束" });
  });

  it("设计师点取消：走完整条链路，模型拿到跳过说明，App 收到 by: cancelled 并移除决策", async () => {
    const { service, link } = await open();
    const ui = fakeUi({ select: never() });
    const outcome = runAsk({ askId: "ask-cancel", question: "还答吗？", options: ["答"], allowOther: false }, { site: link, ui });
    await waitFor(() => service.asks().length === 1);
    expect(service.answer("ask-cancel", null)).toEqual({ accepted: true });
    await expect(outcome).resolves.toEqual({ answer: null, note: SKIPPED_NOTE });
    await waitFor(() => service.asks().length === 0); // 桥接自己发的 ask_resolved(by: cancelled) 就把它移除了
    // 取消测试自己也验一遍"没人再手工调 resolved"：这里没有手动调用

    const terminal = link.ask({ askId: "ask-terminal", question: "终端先答？", options: ["A"], allowOther: false }, new AbortController().signal);
    await waitFor(() => service.asks().length === 1);
    link.resolved("ask-terminal", "terminal");
    await waitFor(() => service.asks().length === 0);
    await expect(terminal).resolves.toEqual({ kind: "none" });
    expect(service.answer("ask-terminal", "A")).toEqual({ accepted: false, reason: "这个决策已经结束" });
  });

  it("三级会话的 ask 立即取消（带 auto），不进入决策卡；模型不会被说成'设计师跳过'", async () => {
    const { service, port, file } = await open();
    const session: SessionInfo = { ...service.sessions()[0]!.info, id: "s3", level: 3 };
    // 用真实的链路 + runAsk 走这一趟：三级会话在 App 侧没有回答者，终端那边还可以答
    const link = new SiteLink({
      file, session: () => session,
      onCommand: () => {},
      timings: { retryMs: 50, pingMs: 100, deadMs: 1000, welcomeMs: 1000 },
    });
    link.start();
    const ui = fakeUi({ select: resolveAfter("A", 50) });
    try {
      await waitFor(() => service.sessions().some(item => item.sessionId === "s3" && item.online));
      const outcome = await runAsk({ askId: "ask-3", question: "选？", options: ["A"], allowOther: false }, { site: link, ui });
      // App 自动拒绝不算设计师跳过：终端那边还能正常答
      expect(outcome).toEqual({ answer: "A", source: "terminal" });
      expect(service.asks()).toHaveLength(0);
    } finally { link.stop("done"); }
  });

  it("同一 askId 不重复入卡，断线会清掉它的决策", async () => {
    const { service, link } = await open();
    const ask = { type: "ask" as const, sessionId: "s1", askId: "ask-dup", question: "选？", options: ["A"], allowOther: false };
    link.send(ask);
    link.send(ask);
    await waitFor(() => service.asks().length === 1);
    link.stop("test");
    await waitFor(() => service.asks().length === 0);
  });

  it("两个会话可以同时在线", async () => {
    const { service, file } = await open();
    const info: SessionInfo = { id: "s2", cwd: "D:/r", level: 2, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" };
    const link2 = new SiteLink({
      file, session: () => info,
      onCommand: msg => link2.send({ type: "ack", cmdId: (msg as Extract<SiteToBridge, { cmdId: string }>).cmdId, ok: true }),
      timings: { retryMs: 50, pingMs: 100, deadMs: 1000, welcomeMs: 1000 },
    });
    link2.start();
    try {
      await waitFor(() => service.sessions().length === 2);
      expect(service.sessions().map(item => item.key).sort()).toEqual(["pi:s1", "pi:s2"]);
    } finally { link2.stop("test done"); }
  });

  it("握手完成但之后不响应心跳：在线表里出现，再按 dead 收尾", async () => {
    const file = path.join(mkTmpDir(), "bridge.json");
    const service = new BridgeService({ file, repos: [], token: TOKEN, pingMs: 20, deadMs: 100, handshakeTimeoutMs: 500 });
    const { port } = await service.start();
    try {
      const session: SessionInfo = { id: "dead", cwd: "D:/r", level: 1, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" };
      const ws = await handshake(port, session); // 真的走完四帧：先确认它上线了
      expect(service.sessions().map((item) => item.key)).toEqual(["pi:dead"]);
      await new Promise<void>(resolve => { ws.once("close", () => resolve()); }); // 回 pong 才是"响应心跳"，这里什么都不做
      await waitFor(() => service.sessions().length === 0);
    } finally { service.stop(); }
  });
  it("握手只发 hello、不发 auth：握手超时后关掉连接，不进在线表", async () => {
    const file = path.join(mkTmpDir(), "bridge.json");
    const service = new BridgeService({ file, repos: [], token: TOKEN, handshakeTimeoutMs: 200 });
    const { port } = await service.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, nonce: newNonce() }));
      await new Promise<void>(resolve => { ws.once("message", () => resolve()); }); // challenge，之后故意不回 auth
      await new Promise<void>(resolve => { ws.once("close", () => resolve()); });
      expect(service.sessions()).toEqual([]);
    } finally { service.stop(); }
  });
  it("连接已经收尾之后迟到的一帧 auth：不再把会话登记成在线", async () => {
    const file = path.join(mkTmpDir(), "bridge.json");
    const service = new BridgeService({ file, repos: [], token: TOKEN, handshakeTimeoutMs: 5000 });
    const { port } = await service.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      const bridgeNonce = newNonce();
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, nonce: bridgeNonce }));
      const challenge = await new Promise<{ nonce: string }>(resolve => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString()) as { nonce: string }));
      });
      const session: SessionInfo = { id: "late", cwd: "D:/r", level: 1, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" };
      const proof = bridgeProof(TOKEN, { bridgeNonce, siteNonce: challenge.nonce });
      service.stop(); // App 在这一帧到达之前就退出了
      ws.send(JSON.stringify({ type: "auth", proof, session }));
      await new Promise<void>(resolve => { ws.once("close", () => resolve()); });
      expect(service.sessions()).toEqual([]);
    } finally { service.stop(); }
  });
  it("坏 proof 之后紧跟一帧正确的 auth：连接已经关闭，不再登记", async () => {
    const file = path.join(mkTmpDir(), "bridge.json");
    const service = new BridgeService({ file, repos: [], token: TOKEN });
    const { port } = await service.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      const bridgeNonce = newNonce();
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, nonce: bridgeNonce }));
      const challenge = await new Promise<{ nonce: string }>(resolve => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString()) as { nonce: string }));
      });
      const session: SessionInfo = { id: "after-bad", cwd: "D:/r", level: 1, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" };
      const nonces = { bridgeNonce, siteNonce: challenge.nonce };
      ws.send(JSON.stringify({ type: "auth", proof: "Y".repeat(43), session }));
      ws.send(JSON.stringify({ type: "auth", proof: bridgeProof(TOKEN, nonces), session }));
      await new Promise<void>(resolve => { ws.once("close", () => resolve()); });
      expect(service.sessions()).toEqual([]);
    } finally { service.stop(); }
  });

  it("断开后会话离线，命令失败；stop 删除自己的 bridge.json", async () => {
    const { service, link, file } = await open();
    link.stop("x".repeat(500));
    await waitFor(() => service.sessions().length === 0);
    expect(await service.command("pi:s1", { type: "pause" })).toEqual({ ok: false, error: "会话不在线" });
    service.stop();
    expect(existsSync(file)).toBe(false);
  });
});
