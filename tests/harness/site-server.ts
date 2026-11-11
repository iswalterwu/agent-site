// 测试用的假工地：一个真实的 WebSocket 服务（ws），只听 127.0.0.1 的随机端口，按桥接协议 v2 握手（challenge → 验 auth → welcome）、
// 回 pong，并记下收到的每一帧。被测的一侧（SiteLink）用真实实现，这里只替换桌面应用。

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { bridgeProof, newNonce, proofMatches, siteProof } from "../../src/protocol/auth";
import type { Nonces } from "../../src/protocol/auth";
import { PROTOCOL_VERSION, parseBridgeToSite } from "../../src/protocol/v2";
import type { BridgeToSite, SiteToBridge } from "../../src/protocol/v2";
import { mkTmpDir, sleep } from "./wait";

export interface TestSiteOptions {
  repos: string[];
  /** 作为 AGENT_SITE_HOME；不给就新建一个临时目录（测试文件结束时自动删除） */
  dir?: string;
  /** 默认 true：在 dir 里写好 bridge.json（端口、口令、repos、本进程的 pid） */
  writeFile?: boolean;
  /** 默认 true：收到 hello 就发 challenge；关掉模拟一个不发 challenge 的对端（占住端口、手里没口令的进程） */
  autoChallenge?: boolean;
  /** 默认 true：验过桥接的证明就回 welcome；关掉可以手动控制握手 */
  autoWelcome?: boolean;
  /** 假工地自己认的口令；不给就用写进 bridge.json 的那个。用来模拟"端口被不知道口令的进程占住" */
  expectToken?: string;
  /** 默认 true：收到 ping 就回 pong；关掉可以模拟一个连着、但一声不吭的工地 */
  autoPong?: boolean;
}

export interface TestSite {
  /** 作为 AGENT_SITE_HOME，里面有 bridge.json（writeFile 不为 false 时） */
  dir: string;
  port: number;
  token: string;
  /** 收到的所有桥接帧，所有连接合在一起，按到达顺序；口令不对的 hello 也在里面 */
  received: BridgeToSite[];
  /** 收到过的原始帧（解析之前的样子）：检查"口令有没有在线路上出现"只能看这个，解析后的帧已经按协议把多余字段丢掉了 */
  raw: string[];
  /** 假工地发出去过的 challenge（随机数和它算的 proof）：用来重放旧连接的证明 */
  challenges: { nonce: string; proof: string }[];
  /** 通不过协议解析的原始帧。桥接发出的每一帧都该能通过解析，所以测试可以断言它是空的 */
  invalid: string[];
  /** 从上一次 next 命中的位置之后，找第一个满足 pred 的帧；还没到就等，超时抛错。中间跳过的帧仍留在 received 里。请顺序调用，不要并发 */
  next(pred: (m: BridgeToSite) => boolean, timeoutMs?: number): Promise<BridgeToSite>;
  /** 发给当前连接的桥接（最近连上来的那条）；没有可用的连接就抛错，免得消息悄悄丢掉 */
  send(msg: SiteToBridge): void;
  /** 发原始帧：坏帧、二进制帧 */
  sendRaw(data: string | Buffer): void;
  /** 掐断所有连接但继续监听（模拟工地崩溃，桥接会按 retryMs 重连回来） */
  drop(): void;
  /** 卡住当前这条连接的服务端一侧：TCP 还连着，但不再读也不再回（模拟卡死的工地）。新连接不受影响；thaw 之前对端发来的字节都堆着 */
  freeze(): void;
  /** 解冻 freeze 卡住的连接，开始处理积压的字节（包括桥接早已发出的关闭帧，此时才会回） */
  thaw(): void;
  /** 现在连着的连接数 */
  connections(): number;
  /** 一共接受过的连接数，已经断开的也算 */
  accepted(): number;
  /** 掐断连接并停止监听；可重复调用。bridge.json 留在原处（真实的工地退出时会删，这里让"文件指向已关闭的端口"也能被测到） */
  close(): Promise<void>;
}

export async function startTestSite(opts: TestSiteOptions): Promise<TestSite> {
  const dir = opts.dir ?? mkTmpDir();
  const token = randomBytes(32).toString("hex");
  const expectToken = opts.expectToken ?? token;
  /** 每条连接各有一对随机数：先 hello 里的，再 challenge 里的 */
  const noncesBySocket = new Map<WebSocket, Nonces>();
  const autoChallenge = opts.autoChallenge ?? true;
  const autoWelcome = opts.autoWelcome ?? true;
  const autoPong = opts.autoPong ?? true;
  const received: BridgeToSite[] = [];
  const raw: string[] = [];
  const challenges: { nonce: string; proof: string }[] = [];
  const invalid: string[] = [];
  let current: WebSocket | undefined;
  let currentTcp: Socket | undefined;
  const frozen = new Set<Socket>();
  let cursor = 0;
  let accepted = 0;

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/bridge" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  const sendChallenge = (socket: WebSocket, nonces: Nonces): void => {
    const proof = siteProof(expectToken, nonces);
    challenges.push({ nonce: nonces.siteNonce, proof });
    socket.send(JSON.stringify({ type: "challenge", nonce: nonces.siteNonce, proof }));
  };

  server.on("connection", (socket, request) => {
    accepted += 1;
    current = socket;
    currentTcp = request.socket;
    socket.on("error", () => {}); // 桥接突然断开等：不让它变成测试进程的未捕获异常
    socket.on("message", (data) => {
      const text = data.toString();
      raw.push(text);
      const msg = parseBridgeToSite(text);
      if (msg === null) {
        invalid.push(text);
        return;
      }
      received.push(msg);
      if (msg.type === "hello" && autoChallenge) {
        const nonces: Nonces = { bridgeNonce: msg.nonce, siteNonce: newNonce() };
        noncesBySocket.set(socket, nonces);
        sendChallenge(socket, nonces);
      } else if (msg.type === "auth") {
        const nonces = noncesBySocket.get(socket);
        // 认不出口令的假工地（expectToken 不对）在这里断开：真实的工地也是验不过就不发 welcome
        if (nonces === undefined || !proofMatches(bridgeProof(expectToken, nonces), msg.proof)) socket.close(1008, "bad proof");
        else if (autoWelcome) socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION }));
      } else if (msg.type === "ping" && autoPong) {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    });
  });

  if (opts.writeFile ?? true) {
    const content = { protocol: PROTOCOL_VERSION, port, token, repos: opts.repos, pid: process.pid };
    writeFileSync(join(dir, "bridge.json"), JSON.stringify(content));
  }

  const sendRaw = (data: string | Buffer): void => {
    if (current === undefined || current.readyState !== WebSocket.OPEN) throw new Error("test site：没有连着的桥接，消息无处可发");
    current.send(data);
  };
  const drop = (): void => {
    for (const client of server.clients) client.terminate();
    current = undefined;
    currentTcp = undefined;
    frozen.clear();
  };
  let closing: Promise<void> | undefined;

  return {
    dir, port, token, received, raw, challenges, invalid,
    async next(pred, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const at = received.findIndex((m, i) => i >= cursor && pred(m));
        if (at >= 0) {
          cursor = at + 1;
          return received[at] as BridgeToSite;
        }
        if (Date.now() >= deadline) {
          const seen = received.slice(cursor).map((m) => m.type).join(", ");
          throw new Error(`site.next 超时（${timeoutMs}ms）：上次命中之后收到 [${seen}]，解析不过的帧 ${invalid.length} 个`);
        }
        await sleep(5);
      }
    },
    send: (msg) => sendRaw(JSON.stringify(msg)),
    sendRaw,
    drop,
    freeze() {
      if (currentTcp === undefined) throw new Error("test site：没有连着的桥接，没有什么可以卡住");
      currentTcp.pause();
      frozen.add(currentTcp);
    },
    thaw() {
      for (const tcp of frozen) tcp.resume();
      frozen.clear();
    },
    connections: () => server.clients.size,
    accepted: () => accepted,
    close() {
      closing ??= new Promise<void>((resolve) => {
        drop();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
