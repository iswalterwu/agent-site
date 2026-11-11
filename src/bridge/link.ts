// 桥接到工地（桌面应用）的连接。发现：读 bridge.json 得到端口和口令；握手：hello（随机数）→ 工地发 challenge（随机数 + 证明）
// → 本端验过工地知道口令才发 auth（证明 + 会话信息）→ 工地回 welcome；之后双方心跳。口令不上线。
// 连不上、握手超时、对方沉默或连接断开，都只是静默地按间隔重试，每次重试都重新读文件（工地重启后端口和口令都会变）。
// 同时实现 ask_designer 在工地一侧的接口（SiteAsker）：提问在断线后保留，重连握手完成后重发同一个 ask 帧，
// 直到有答案、signal 中止，或调用方宣布放弃（failPendingAsks，Task 10 在断线 60 秒宽限到点时调用）。
// 上报的 event 先进有上限的队列再成批写出，工地处理不过来时丢最旧的，不会阻塞 agent。
// 只连 127.0.0.1，不写任何文件，也不在控制台输出；所有回调、事件监听和定时器里的代码都用 safe 包住，绝不抛出，也不拖住 pi 进程。

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { bridgeProof, newNonce, proofMatches, siteProof } from "../protocol/auth";
import type { Nonces } from "../protocol/auth";
import { isInt, stripBom } from "../protocol/guards";
import { PROTOCOL_VERSION, parseSiteToBridge } from "../protocol/v2";
import type { BridgeToSite, SessionInfo, SiteToBridge } from "../protocol/v2";
import type { AskRequest, SiteAskResult, SiteAsker } from "./ask";
import { safe } from "./safe";

export interface BridgeFile { protocol: number; port: number; token: string; repos: string[]; pid: number }

/** bridge.json 的位置：AGENT_SITE_HOME 目录，否则 %APPDATA%\agent-site（取不到 APPDATA 就用用户目录下的 AppData\Roaming） */
export function bridgeFilePath(env: Record<string, string | undefined>): string {
  const appData = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(env.AGENT_SITE_HOME ?? path.join(appData, "agent-site"), "bridge.json");
}

/**
 * 读并校验 bridge.json。不存在、读不了、不是 JSON、缺字段或类型不对、protocol ≠ 2，
 * 以及 repos 里有任何一项不是非空的绝对路径，都返回 null。从不抛出。
 * （repos 里的空串会被路径比较解析成进程的当前目录，等于在无关的会话里激活桥接，所以在这里就挡掉。）
 */
export function readBridgeFile(file: string): BridgeFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { protocol, port, token, repos, pid } = raw as Record<string, unknown>;
  if (protocol !== PROTOCOL_VERSION || !isInt(port) || port < 1 || port > 65535 || typeof token !== "string" || token === "" ||
      !Array.isArray(repos) || !repos.every(isAbsolutePath) || !isInt(pid)) {
    return null;
  }
  return { protocol, port, token, repos, pid };
}

const isAbsolutePath = (v: unknown): v is string => typeof v === "string" && path.isAbsolute(v);

/** 写 bridge.json 的进程还在不在。Windows 上对别的用户的进程会抛 EPERM：那也算活着 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LinkTimings {
  retryMs: number;   // 没连上（或掉线）后，隔多久重试
  pingMs: number;    // 己方发 ping 的间隔
  deadMs: number;    // 这么久没收到对方任何一帧，就当断线
  welcomeMs: number; // 从发起连接起，这么久还没握手成功，就放弃这一次
}
export const DEFAULT_TIMINGS: LinkTimings = { retryMs: 10000, pingMs: 10000, deadMs: 30000, welcomeMs: 5000 };

export interface SiteLinkOptions {
  file: string;
  /** 本会话的信息；握手、发 ask、发 bye 时现取 */
  session: () => SessionInfo;
  /** welcome 之后收到的 pause / resume / abort / suggest（answer、ping、pong 由链路自己处理，不在此列） */
  onCommand: (msg: SiteToBridge) => void;
  onOnline?: () => void;
  /** 每次掉线只调用一次；握手没成功的失败尝试、主动 stop() 都不算 */
  onOffline?: () => void;
  timings?: Partial<LinkTimings>;
}

// 上报 event 是异步、成批、有上限的（见 docs/architecture.md「桥接扩展 site-bridge」）：event 先进一个队列，连接的积压（ws.bufferedAmount）不超过
// MAX_BUFFERED 时成批写出，超过就留在队列里等；队列满了挤掉最旧的 —— 工地处理不过来时丢的是最旧的摘要，永远不阻塞 agent
const MAX_BUFFERED = 1_000_000;
/**
 * close() 之后给对端多久回关闭帧，超过就硬关（terminate）。Node 自带的 WebSocket 对卡死的对端根本没法硬关：
 * App 停在断点上时，print / json 模式的 pi 做完一轮也退不出去，要等 App 恢复。用 ws 就是为这个 terminate。
 */
const CLOSE_GRACE_MS = 1000;
const MAX_QUEUED_EVENTS = 500;
const FLUSH_RETRY_MS = 50; // WebSocket 没有 drain 事件，队列里还有剩的就隔这么久再试一次

type AskResolved = Extract<BridgeToSite, { type: "ask_resolved" }>;
type EventFrame = Extract<BridgeToSite, { type: "event" }>;
interface PendingAsk { req: AskRequest; finish: (result: SiteAskResult) => void }

/** 定时器里的代码绝不抛出；unref：重试和心跳不该让 pi 进程在该退出的时候退不掉 */
export const later = (fn: () => void, ms: number): NodeJS.Timeout => setTimeout(safe(fn, undefined), ms).unref();
const every = (fn: () => void, ms: number): NodeJS.Timeout => setInterval(safe(fn, undefined), ms).unref();

export class SiteLink implements SiteAsker {
  private readonly opts: SiteLinkOptions;
  private readonly timings: LinkTimings;
  private running = false;
  private online = false; // 收到 welcome 之后为 true，连接一断就变回 false
  /** 当前这一条连接（握手中或已握手）；没有就是 null。旧连接迟到的事件靠它识别并忽略 */
  private socket: WebSocket | null = null;
  /** 这次连接握手里的一段：口令和本端随机数。welcome 之后清掉 */
  private auth: { secret: string; bridgeNonce: string } | null = null;
  /** 握手进行到哪一步：hello 已发、auth 已发；online 之后不再看这个字段 */
  private phase: "hello" | "auth" = "hello";
  private retryTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private deadTimer: NodeJS.Timeout | undefined;
  /** 等着写出的 event（至多 MAX_QUEUED_EVENTS 条，最旧的在前）。只在线时排队，掉线或 stop 就清空；flushTimer 是队列还有剩时的重试定时器 */
  private readonly events: EventFrame[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  /** 还在等答案的提问。断线不撤销它们；答案、signal 中止、failPendingAsks、stop 才会兑现 */
  private readonly pending = new Map<string, PendingAsk>();
  /** 离线时记下、重连握手后补发的 ask_resolved */
  private unsent: AskResolved[] = [];
  private readonly runCommand: (msg: SiteToBridge) => void;
  private readonly announceOnline: () => void;
  private readonly announceOffline: () => void;

  constructor(opts: SiteLinkOptions) {
    this.opts = opts;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.runCommand = safe((msg: SiteToBridge) => opts.onCommand(msg), undefined);
    this.announceOnline = safe(() => opts.onOnline?.(), undefined);
    this.announceOffline = safe(() => opts.onOffline?.(), undefined);
  }

  /** 读 bridge.json 并连接；读不到或连不上就按 retryMs 重试，每次重试都重新读文件。重复调用无效 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  /** 在线时先发 bye，再关连接、清掉所有定时器和排队没写出的 event；未答的提问以 null 兑现。不触发 onOffline */
  stop(reason: string): void {
    if (!this.running) return;
    this.running = false;
    try {
      if (this.online) this.write({ type: "bye", sessionId: this.opts.session().id, reason });
    } catch {
      // session() 出错：告别帧发不出去也要往下收尾
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.disconnect();
    this.failPendingAsks();
    this.unsent = [];
  }

  isOnline(): boolean {
    return this.online;
  }

  /**
   * 离线时丢弃（不排队、不补发）。在线时：event 进队列并立刻尝试写出（队列满了先挤掉最旧的一条）；
   * 其他消息不排队，直接写（所以积压时它们可能排在还没写出的 event 前面）
   */
  send(msg: BridgeToSite): void {
    if (!this.online) return;
    if (msg.type !== "event") {
      this.write(msg);
      return;
    }
    if (this.events.length >= MAX_QUEUED_EVENTS) this.events.shift();
    this.events.push(msg);
    this.flushEvents();
  }

  /**
   * 把提问发给工地并等答案。断线不会让它落空：重连握手后重发同一帧。结果是三种之一：答了、设计师明确跳过、
   * 这一边没有答案（空答案、signal 中止、failPendingAsks、stop）。signal 中止时只兑现"没有答案"，
   * 不自己发 ask_resolved —— 调用方（runAsk）随后会调 resolved()。
   */
  ask(req: AskRequest, signal: AbortSignal): Promise<SiteAskResult> {
    if (!this.running || signal.aborted) return Promise.resolve({ kind: "none" });
    this.settleAsk(req.askId, { kind: "none" }); // 同一个 askId 再问一次：前一个已经没人等了，先兑现掉，免得它的监听器和 Promise 悬着
    return new Promise((resolve) => {
      const onAbort = safe(() => this.settleAsk(req.askId, { kind: "none" }), undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(req.askId, {
        req,
        finish: (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      });
      if (this.online) this.sendAsk(req);
    });
  }

  /** 告诉工地这个提问已经有结论了。离线时先记下，重连收到 welcome 后补发 */
  resolved(askId: string, by: AskResolved["by"]): void {
    if (!this.running) return;
    this.settleAsk(askId, { kind: "none" }); // 调用方没中止 signal 就直接宣布结论：这个提问也不该再重发给工地
    const frame: AskResolved = { type: "ask_resolved", askId, by };
    if (!this.online || !this.write(frame)) this.unsent.push(frame);
  }

  /** 放弃所有还在等的提问：以"没有答案"兑现，不再重发。断线宽限到点时由 Task 10 调用 */
  failPendingAsks(): void {
    for (const askId of [...this.pending.keys()]) this.settleAsk(askId, { kind: "none" });
  }

  private settleAsk(askId: string, result: SiteAskResult): void {
    const entry = this.pending.get(askId);
    if (entry === undefined) return; // 不认识（已兑现、已撤销）：忽略
    this.pending.delete(askId);
    entry.finish(result);
  }

  private readonly sendAsk = safe((req: AskRequest): void => {
    const { askId, question, options, allowOther, context } = req;
    // 可选字段缺席就不发这个键：协议解析器不接受 null
    this.write({ type: "ask", sessionId: this.opts.session().id, askId, question, options, allowOther, ...(context === undefined ? {} : { context }) });
  }, undefined); // 发不出去也不要紧：提问还在 pending 里，下次握手完成会重发

  /** 把排队的 event 按顺序成批写出，直到连接的积压超过 MAX_BUFFERED；还有剩的，FLUSH_RETRY_MS 后再试（同一时刻只有一个重试定时器） */
  private flushEvents(): void {
    const ws = this.socket;
    while (ws !== null && this.events.length > 0 && ws.bufferedAmount <= MAX_BUFFERED && this.write(this.events[0] as EventFrame)) this.events.shift();
    if (this.events.length === 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    } else if (this.flushTimer === undefined) {
      this.flushTimer = later(() => {
        this.flushTimer = undefined;
        this.flushEvents();
      }, FLUSH_RETRY_MS);
    }
  }

  /** 读文件、发起一次连接；读不到、连不上都只是安排下一次重试 */
  private connect(): void {
    const info = readBridgeFile(this.opts.file);
    if (info === null) return this.scheduleRetry();
    // 写文件的 App 已经没了：这个端口可能已经被别的进程占住，连过去只会白白把随机数交出去
    if (!isProcessAlive(info.pid)) return this.scheduleRetry();
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${info.port}/bridge`);
    } catch {
      return this.scheduleRetry();
    }
    this.socket = ws;
    // 握手时限从发起连接算起：TCP 连接、WebSocket 升级、收到 welcome，一共不能超过 welcomeMs
    this.handshakeTimer = later(() => this.lost(ws), this.timings.welcomeMs);
    // 我们自己关掉的连接，close / error 事件可能很久以后才到（对端卡住时要等它回关闭帧），那时早已换成新连接，所以 lost 要认旧连接；
    // open / message 不会在已经关闭中的连接上触发（WebSocket 标准要求，Node 的实现照做），用不着认
    ws.on("open", safe(() => {
      if (this.socket !== ws) return;
      const bridgeNonce = newNonce();
      this.auth = { secret: info.token, bridgeNonce };
      this.phase = "hello";
      this.write({ type: "hello", protocol: PROTOCOL_VERSION, nonce: bridgeNonce });
    }, undefined));
    // 二进制帧不进解析、当成坏帧（协议每帧一条文本 JSON）：握手期按失败处理，在线时丢弃
    ws.on("message", safe((data: unknown, isBinary: boolean) => this.receive(ws, isBinary ? null : String(data)), undefined));
    ws.on("close", safe(() => this.lost(ws), undefined));
    ws.on("error", safe(() => this.lost(ws), undefined)); // 之后通常还有 close，第二次调用会被当作旧连接忽略
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = later(() => this.connect(), this.timings.retryMs);
  }

  private receive(ws: WebSocket, data: unknown): void {
    if (this.socket !== ws) return; // 旧连接迟到的一帧：忽略，不能拿它影响现在这条连接（尤其不能让它把当前连接判死）
    if (this.online) this.deadTimer?.refresh(); // 收到的任何一帧（哪怕是坏帧）都说明对方还活着
    const msg = typeof data === "string" ? parseSiteToBridge(data) : null; // 只认文本帧
    if (!this.online) {
      // 握手期按阶段只认一帧：hello 之后是 challenge，auth 之后是 welcome。坏帧、错序帧都当握手失败
      if (msg === null) return this.lost(ws);
      if (this.phase === "hello" && msg.type === "challenge") this.answerChallenge(msg);
      else if (this.phase === "auth" && msg.type === "welcome") this.goOnline();
      else this.lost(ws);
      return;
    }
    if (msg === null) return; // 已经在线：坏帧直接丢弃
    switch (msg.type) {
      case "ping": this.write({ type: "pong" }); break;
      case "answer": this.settleAsk(msg.askId, answerResult(msg, this.opts.session().level)); break;
      case "pong": case "welcome": case "challenge": break; // 握手已经结束：迟到的 challenge 不当作指令
      default: this.runCommand(msg); // pause / resume / abort / suggest
    }
  }

  /**
   * 工地发来的 challenge：先验它知道口令。验不过就当这条连接不存在（断开、按间隔重试），会话信息一个字都不发；
   * 验过了才回 auth，带着本端算的证明和会话信息
   */
  private answerChallenge(msg: Extract<SiteToBridge, { type: "challenge" }>): void {
    const auth = this.auth;
    const ws = this.socket;
    if (auth === null || ws === null) return;
    const nonces: Nonces = { bridgeNonce: auth.bridgeNonce, siteNonce: msg.nonce };
    if (!proofMatches(siteProof(auth.secret, nonces), msg.proof)) return this.lost(ws);
    this.phase = "auth";
    this.write({ type: "auth", proof: bridgeProof(auth.secret, nonces), session: this.opts.session() });
  }

  /** 握手成功：起心跳，补报离线期间攒下的东西，再通知上层 */
  private goOnline(): void {
    const ws = this.socket;
    if (ws === null) return;
    clearTimeout(this.handshakeTimer);
    this.auth = null;
    this.online = true;
    this.pingTimer = every(() => { this.write({ type: "ping" }); }, this.timings.pingMs);
    this.deadTimer = later(() => this.lost(ws), this.timings.deadMs);
    // 先补发离线时记下的 ask_resolved，再重发仍在等答案的提问；写不出去的留着，下次握手再来
    while (this.unsent.length > 0 && this.write(this.unsent[0] as AskResolved)) this.unsent.shift();
    for (const { req } of this.pending.values()) this.sendAsk(req);
    this.announceOnline();
  }

  /** 这条连接没了（对方关闭、出错、握手超时、对方沉默）：收尾它，掉线只通知一次，安排重连。旧连接迟到的事件直接忽略 */
  private lost(ws: WebSocket): void {
    if (this.socket !== ws) return;
    const wasOnline = this.online;
    this.disconnect();
    if (wasOnline) this.announceOffline();
    if (this.running) this.scheduleRetry();
  }

  /** 清掉这条连接的定时器和排队的 event，再关闭它，状态回到离线 */
  private disconnect(): void {
    clearTimeout(this.handshakeTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.deadTimer);
    clearTimeout(this.flushTimer);
    this.handshakeTimer = this.pingTimer = this.deadTimer = this.flushTimer = undefined;
    this.events.length = 0;
    this.auth = null;
    this.phase = "hello";
    this.online = false;
    const ws = this.socket;
    this.socket = null;
    try {
      ws?.close();
    } catch {
      // 已经关了或根本没连上，都不用管
    }
    // 对端卡死时不回关闭帧，close() 就永远挂着、进程也退不出去：到点直接掐线
    if (ws !== null) later(() => { try { ws.terminate(); } catch { /* 已经关了 */ } }, CLOSE_GRACE_MS);
  }

  /** 写一帧；连接不是开着的、或写出错，返回 false（这一帧没发出去） */
  private write(frame: BridgeToSite): boolean {
    const ws = this.socket;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 工地发来的 answer：带非空 value 就是答案；`cancelled` 是 App 主动取消——设计师点过的是明确跳过（skip），
 * App 自己取消的（`auto`）仍旧算这一边没有答案。
 * 三级及以下的会话在 App 里没有回答者，任何取消都是"没给人看过"，所以不看 `auto` 也算没有答案：
 * 旧版 App 不会带 `auto`，只凭它会把这些会话误判成设计师跳过。
 * 两个都没有（解析层不该放过，这里再兜一层）也没有答案
 */
const answerResult = (msg: Extract<SiteToBridge, { type: "answer" }>, level: number): SiteAskResult =>
  msg.cancelled === true ? (msg.auto === true || level > 2 ? { kind: "none" } : { kind: "skip" })
    : msg.value === undefined || msg.value === "" ? { kind: "none" }
      : { kind: "answer", text: msg.value };
