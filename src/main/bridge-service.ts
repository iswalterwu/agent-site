// App 侧的桥接服务：只监听 127.0.0.1 的随机端口，实现协议 v2 的 hello→challenge→auth→welcome 握手、心跳和指令回执。
// 握手是双向挑战应答：口令不上线，没通过验证的连接不进在线表、收不到事件、也不能被下指令。
// 桥接扩展仍是客户端；服务不依赖 Electron，方便用真实 WebSocket 客户端测试。
// 不日志、不写仓库、不联网；bridge.json 只在 App 运行期间存在，退出时删除自己的文件。

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { redact } from "../core/redact";
import { t, localizedError, type Locale, type MessageKey } from "../core/i18n";
import { normalizePath, resolveWatchedRepo } from "../bridge/scope";
import { bridgeProof, newNonce, proofMatches, siteProof } from "../protocol/auth";
import type { Nonces } from "../protocol/auth";
import { PROTOCOL_VERSION, parseBridgeToSite } from "../protocol/v2";
import type { BridgeToSite, SessionInfo, SiteToBridge } from "../protocol/v2";

export interface BridgeSessionView {
  key: string;
  sessionId: string;
  info: SessionInfo;
  online: boolean;
  paused: boolean;
  holding: { tool: string; sinceMs: number } | null;
  idle: boolean;
  controllable: boolean;
}

export type BridgeCommand = { type: "pause" | "resume" | "abort" } | { type: "suggest"; text: string; mode: "steer" | "followUp" };
export interface BridgeCommandResult { ok: boolean; error?: string; messageKey?: MessageKey }
export interface BridgeAsk {
  askId: string;
  sessionKey: string;
  sessionId: string;
  question: string;
  options: string[];
  allowOther: boolean;
  context?: string;
  at: number;
}
export interface BridgeAskResult { accepted: boolean; reason?: string; messageKey?: MessageKey }

export interface BridgeServiceOptions {
  file: string;
  repos: string[];
  /** 判断一个工作目录是否在给定工地里；测试可以换掉，省得真跑 git */
  inScope?: (cwd: string, repos: readonly string[]) => Promise<boolean>;
  port?: number;
  token?: string;
  commandTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  deadMs?: number;
  pingMs?: number;
  onChange?: () => void;
  /** 只格式化 App 侧反馈，不改变桥接协议或远端原始错误。 */
  locale?: () => Locale;
}

interface PendingCommand { resolve: (result: BridgeCommandResult) => void; timer: NodeJS.Timeout }
interface Connection {
  ws: WebSocket;
  view: BridgeSessionView;
  /** 收到 hello 之后、验证 proof 之前的两个随机数（pending 已经是指令回执，不复用这个名字） */
  authPending: Nonces | null;
  handshake: NodeJS.Timeout | null;
  ping: NodeJS.Timeout | null;
  dead: NodeJS.Timeout | null;
  pending: Map<string, PendingCommand>;
}

export class BridgeService {
  private readonly opts: Required<Omit<BridgeServiceOptions, "port" | "token" | "onChange">> & Pick<BridgeServiceOptions, "onChange">;
  private server: WebSocketServer | null = null;
  private port = 0;
  private token = "";
  private starting = false;
  private stopped = false;
  private readonly states = new Map<WebSocket, Connection>();
  /** 工地集合的版本号：判范围是异步的，回来时集合可能已经又变了 */
  private scopeVersion = 0;
  private readonly connections = new Map<string, Connection>();
  private readonly asksById = new Map<string, BridgeAsk>();

  constructor(opts: BridgeServiceOptions) {
    this.opts = {
      ...opts,
      inScope: opts.inScope ?? (async (cwd, repos) => (await resolveWatchedRepo(cwd, [...repos])) !== null),
      commandTimeoutMs: opts.commandTimeoutMs ?? 5000,
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 5000,
      deadMs: opts.deadMs ?? 30000,
      pingMs: opts.pingMs ?? 10000,
      locale: opts.locale ?? (() => "zh-CN"),
    };
    this.token = opts.token ?? randomBytes(32).toString("hex");
    this.port = opts.port ?? 0;
  }

  async start(): Promise<{ port: number; token: string; file: string }> {
    if (this.server !== null || this.starting) throw new Error("bridge service already started");
    this.starting = true;
    const server = new WebSocketServer({ host: "127.0.0.1", port: this.port, path: "/bridge" });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("bridge service has no port");
      this.port = (address as AddressInfo).port;
      this.stopped = false;
      this.writeFile();
      server.on("connection", socket => this.accept(socket));
      return { port: this.port, token: this.token, file: this.opts.file };
    } catch (error) {
      this.starting = false;
      try { server.close(); } catch { /* 已经关掉 */ }
      this.server = null;
      this.removeFile();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const conn of this.states.values()) this.closeConnection(conn, t(this.opts.locale(), "App 已退出"));
    this.states.clear();
    this.connections.clear();
    this.asksById.clear();
    try { this.server?.close(); } catch { /* 已经关掉 */ }
    this.server = null;
    this.removeFile();
  }

  sessions(): BridgeSessionView[] {
    return [...this.connections.values()].map(conn => ({ ...conn.view, holding: conn.view.holding === null ? null : { ...conn.view.holding } }));
  }

  asks(): BridgeAsk[] {
    return [...this.asksById.values()].map(ask => ({ ...ask, options: [...ask.options] }));
  }

  answer(askId: string, value: string | null): BridgeAskResult {
    const ask = this.asksById.get(askId);
    if (ask === undefined) return this.answerError("这个决策已经结束");
    const conn = this.connections.get(ask.sessionKey);
    if (conn === undefined || conn.ws.readyState !== WebSocket.OPEN) return this.answerError("会话已离线");
    const frame: SiteToBridge = value === null
      ? { type: "answer", askId, cancelled: true }
      : { type: "answer", askId, value };
    if (!this.write(conn.ws, frame)) return this.answerError("连接已断开");
    return { accepted: true };
  }

  command(sessionKey: string, command: BridgeCommand): Promise<BridgeCommandResult> {
    const conn = this.connections.get(sessionKey);
    if (conn === undefined || conn.ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, ...localizedError(this.opts.locale(), "会话不在线") });
    if (!conn.view.controllable) return Promise.resolve({ ok: false, ...localizedError(this.opts.locale(), "只读会话不能控制") });
    const cmdId = randomUUID();
    const frame: SiteToBridge = command.type === "suggest"
      ? { type: "suggest", cmdId, text: command.text, mode: command.mode }
      : { type: command.type, cmdId };
    if (!this.write(conn.ws, frame)) return Promise.resolve({ ok: false, ...localizedError(this.opts.locale(), "连接已断开") });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        conn.pending.delete(cmdId);
        resolve({ ok: false, ...localizedError(this.opts.locale(), "桥接没有回执，稍后再试") });
      }, this.opts.commandTimeoutMs);
      conn.pending.set(cmdId, { resolve, timer });
    });
  }

  private answerError(key: MessageKey): BridgeAskResult {
    const { error, messageKey } = localizedError(this.opts.locale(), key);
    return { accepted: false, reason: error, messageKey };
  }

  private accept(ws: WebSocket): void {
    const handshake = setTimeout(() => {
      try { ws.close(1008, "hello timeout"); } catch {
        try { ws.terminate(); } catch { /* 已经关掉 */ }
      }
      this.drop(conn);
    }, this.opts.handshakeTimeoutMs);
    const conn: Connection = { ws, view: emptyView(), authPending: null, handshake, ping: null, dead: null, pending: new Map() };
    this.states.set(ws, conn);
    ws.on("error", () => { /* 断线由 close 收尾 */ });
    ws.on("message", (data: RawData) => this.receive(conn, data));
    ws.on("close", () => this.drop(conn));
    ws.on("pong", () => this.touch(conn));
  }

  private receive(conn: Connection, data: RawData): void {
    // 已经收尾过的连接（stop、断开、被判坏后关闭）上迟到的帧一律不处理：不能让它在关闭途中重新登记成在线
    if (this.stopped || !this.states.has(conn.ws)) return;
    this.touch(conn);
    const msg = parseBridgeToSite(typeof data === "string" ? data : data.toString());
    if (msg === null) {
      if (!conn.view.online) this.closeConnection(conn, "invalid handshake");
      return;
    }
    if (conn.view.online) this.handleOnline(conn, msg);
    else if (conn.authPending === null) {
      if (msg.type === "hello") this.hello(conn, msg);
      else this.closeConnection(conn, "unexpected frame before hello");
    } else if (msg.type === "auth") this.authenticate(conn, msg);
    else this.closeConnection(conn, "unexpected frame before auth");
  }

  /** 第一帧：只认版本和随机数，回 challenge 证明自己知道口令；此时还不算上线 */
  private hello(conn: Connection, msg: Extract<BridgeToSite, { type: "hello" }>): void {
    conn.authPending = { bridgeNonce: msg.nonce, siteNonce: newNonce() };
    this.write(conn.ws, { type: "challenge", nonce: conn.authPending.siteNonce, proof: siteProof(this.token, conn.authPending) });
  }

  /** 第二帧：验桥接的证明；过了才登记会话、回 welcome、起心跳 */
  private authenticate(conn: Connection, msg: Extract<BridgeToSite, { type: "auth" }>): void {
    const pending = conn.authPending;
    if (pending === null || !proofMatches(bridgeProof(this.token, pending), msg.proof)) {
      return this.closeConnection(conn, "bad proof");
    }
    conn.authPending = null;
    if (!this.states.has(conn.ws)) return; // 验完之前连接已经被关掉：不重新登记
    const existing = this.connections.get(`pi:${msg.session.id}`);
    if (existing !== undefined) this.closeConnection(existing, "replaced");
    const info = msg.session;
    conn.view = {
      key: `pi:${info.id}`, sessionId: info.id, info, online: true,
      paused: false, holding: null, idle: false, controllable: info.level <= 2,
    };
    this.connections.set(conn.view.key, conn);
    if (conn.handshake !== null) clearTimeout(conn.handshake);
    conn.handshake = null;
    conn.ping = setInterval(() => { if (!this.write(conn.ws, { type: "ping" })) this.closeConnection(conn, "ping failed"); }, this.opts.pingMs);
    this.write(conn.ws, { type: "welcome", protocol: PROTOCOL_VERSION });
    this.touch(conn);
    this.changed();
  }

  private handleOnline(conn: Connection, msg: BridgeToSite): void {
    switch (msg.type) {
      case "state":
        if (msg.sessionId !== conn.view.sessionId) return;
        const holding = msg.holding === undefined ? null : { tool: redact(msg.holding.tool), sinceMs: msg.holding.sinceMs };
        conn.view = { ...conn.view, paused: msg.paused, holding, idle: msg.idle };
        this.changed();
        break;
      case "ack": {
        const pending = conn.pending.get(msg.cmdId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        conn.pending.delete(msg.cmdId);
        pending.resolve({ ok: msg.ok, ...(msg.error === undefined ? {} : { error: redact(msg.error) }) });
        break;
      }
      case "ask":
        this.onAsk(conn, msg);
        break;
      case "ask_resolved":
        if (this.asksById.delete(msg.askId)) this.changed();
        break;
      case "bye":
        this.closeConnection(conn, msg.reason);
        break;
      case "ping":
        this.write(conn.ws, { type: "pong" });
        break;
      case "event": case "pong": break;
      default: break;
    }
  }

  private onAsk(conn: Connection, msg: Extract<BridgeToSite, { type: "ask" }>): void {
    if (msg.sessionId !== conn.view.sessionId) return;
    if (!conn.view.controllable) {
      // 三级会话可以连上上报状态，但没有回答者；立即取消，避免挂在 ask_designer。
      // auto: 设计师没见过这个问题，不是他跳过的（跳过会让 agent 按自己的判断继续）
      this.write(conn.ws, { type: "answer", askId: msg.askId, cancelled: true, auto: true });
      return;
    }
    if (this.asksById.has(msg.askId)) return;
    this.asksById.set(msg.askId, {
      askId: msg.askId, sessionKey: conn.view.key, sessionId: conn.view.sessionId,
      question: msg.question, options: [...msg.options], allowOther: msg.allowOther,
      ...(msg.context === undefined ? {} : { context: msg.context }), at: Date.now(),
    });
    this.changed();
  }

  private touch(conn: Connection): void {
    if (!conn.view.online) return;
    if (conn.dead !== null) clearTimeout(conn.dead);
    conn.dead = setTimeout(() => this.closeConnection(conn, "dead"), this.opts.deadMs);
  }

  private drop(conn: Connection): void {
    if (!this.states.has(conn.ws)) return;
    this.states.delete(conn.ws);
    if (conn.handshake !== null) clearTimeout(conn.handshake);
    if (conn.ping !== null) clearInterval(conn.ping);
    if (conn.dead !== null) clearTimeout(conn.dead);
    conn.handshake = conn.ping = conn.dead = null;
    conn.authPending = null;
    if (this.connections.get(conn.view.key) === conn) this.connections.delete(conn.view.key);
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, ...localizedError(this.opts.locale(), "连接已断开") });
    }
    conn.pending.clear();
    let announce = conn.view.online;
    for (const [askId, ask] of this.asksById) {
      if (ask.sessionKey !== conn.view.key) continue;
      this.asksById.delete(askId);
      announce = true;
    }
    if (announce) this.changed();
  }

  private closeConnection(conn: Connection, reason: string): void {
    // 对端可以发任意长的 bye.reason；固定用短原因，避免超过 WebSocket 123 字节的上限。
    void reason;
    try { conn.ws.close(1008, "bridge closed"); } catch {
      try { conn.ws.terminate(); } catch { /* 已经关了 */ }
    }
    this.drop(conn);
  }

  private write(ws: WebSocket, frame: SiteToBridge): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  /**
   * 工地集合变了：去重、排序后重写 bridge.json，并把不在新范围里的在线连接关掉。
   * 集合没变就什么都不做，免得每轮刷新都打断桥接心跳。
   */
  async setSites(paths: readonly string[]): Promise<void> {
    const next = uniquePaths(paths);
    const current = uniquePaths(this.opts.repos);
    if (next.length === current.length && next.every((p, index) => p === current[index])) return;
    this.opts.repos = next;
    const version = ++this.scopeVersion;
    if (this.server !== null && !this.stopped) this.writeFile();
    for (const conn of [...this.states.values()]) {
      if (!conn.view.online) continue;
      if (await this.opts.inScope(conn.view.info.cwd, next)) continue;
      // 判范围的等待期间范围又变了：这一轮的结论已经过期，交给最新那一轮处理
      if (version !== this.scopeVersion || this.stopped) return;
      const latest = uniquePaths(this.opts.repos);
      if (!samePaths(latest, next)) return;
      this.closeConnection(conn, "out of scope");
    }
  }

  private changed(): void {
    try { this.opts.onChange?.(); } catch { /* 观察者出错不影响服务 */ }
  }

  private writeFile(): void {
    const dir = path.dirname(this.opts.file);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.opts.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ protocol: PROTOCOL_VERSION, port: this.port, token: this.token,
      repos: this.opts.repos, pid: process.pid }));
    renameSync(tmp, this.opts.file);
  }

  private removeFile(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.opts.file, "utf8"));
      if (typeof raw === "object" && raw !== null && (raw as { token?: unknown }).token === this.token) rmSync(this.opts.file, { force: true });
    } catch { /* 文件没了或不是我们的 */ }
  }
}

const samePaths = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((p, index) => p === b[index]);

/** 去重（按规范化路径认同一处）后排序；值本身保持调用方给的样子，写进 bridge.json 好看 */
function uniquePaths(paths: readonly string[]): string[] {
  return [...new Map(paths.map((p) => [normalizePath(p), p])).values()].sort((a, b) => normalizePath(a) < normalizePath(b) ? -1 : 1);
}

function emptyView(): BridgeSessionView {
  return { key: "", sessionId: "", info: { id: "", cwd: "", level: 0, startedAt: "", mode: "" }, online: false,
    paused: false, holding: null, idle: false, controllable: false };
}
