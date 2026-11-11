import { getEventListeners } from "node:events";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AskRequest } from "../../src/bridge/ask";
import { DEFAULT_TIMINGS, SiteLink, bridgeFilePath, isProcessAlive, readBridgeFile } from "../../src/bridge/link";
import type { SiteLinkOptions } from "../../src/bridge/link";
import type { BridgeToSite, SessionInfo, SiteToBridge } from "../../src/protocol/v2";
import { startTestSite } from "../harness/site-server";
import type { TestSite, TestSiteOptions } from "../harness/site-server";
import { mkTmpDir, sleep, waitFor } from "../harness/wait";

const fast = { retryMs: 100, pingMs: 100, deadMs: 400, welcomeMs: 300 };
const info = (): SessionInfo => ({ id: "s1", cwd: "D:/r", level: 1, startedAt: "2026-11-03T00:00:00Z", mode: "tui" });
const req = (askId: string): AskRequest => ({ askId, question: "选？", options: ["A"], allowOther: true });
const noSignal = (): AbortSignal => new AbortController().signal;

// 每个测试里起的假工地和链路都登记在这里，测试结束（含断言失败）时统一收尾：不在进程里留下监听端口和重连循环
const sites: TestSite[] = [];
const links: SiteLink[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); // 个别测试会 spy 全局的 setTimeout / clearTimeout，断言失败时也要还原
  for (const link of links.splice(0)) link.stop("cleanup");
  await Promise.all(sites.splice(0).map((site) => site.close()));
});

async function startSite(opts: Partial<TestSiteOptions> = {}): Promise<TestSite> {
  const site = await startTestSite({ repos: ["D:/r"], ...opts });
  sites.push(site);
  return site;
}
function makeLink(file: string, extra: Partial<SiteLinkOptions> = {}): SiteLink {
  const link = new SiteLink({ file, session: info, onCommand: () => {}, timings: fast, ...extra });
  links.push(link);
  return link;
}
const fileOf = (site: TestSite): string => join(site.dir, "bridge.json");

/** 让链路发一帧 ack 并等工地收到：同一条连接上帧是有序的，所以它之前发出的帧此刻都已到达 */
let barrierCount = 0;
async function barrier(link: SiteLink, site: TestSite): Promise<void> {
  const cmdId = `barrier-${++barrierCount}`;
  link.send({ type: "ack", cmdId, ok: true });
  await site.next((m) => m.type === "ack" && m.cmdId === cmdId);
}
const eventFrame = (summary: string, detail?: Record<string, unknown>, seq = 1): BridgeToSite => ({
  type: "event", sessionId: "s1", seq, ts: "2026-11-03T00:00:00Z", kind: "turn_end", summary, ...(detail === undefined ? {} : { detail }),
});
const eventSeqs = (site: TestSite): number[] => site.received.flatMap((m) => (m.type === "event" ? [m.seq] : []));

// 积压测试：卡住的工地不回 pong，所以 deadMs 要比整个测试长，链路才不会中途把它当成掉线（掉线会清空队列）
const patient = { ...fast, deadMs: 10_000 };
const FLOOD = 4000; // 每条约 2KB，共约 8MB：远超连接和操作系统缓冲能吞下的量
const PAD = "x".repeat(2000);
/** 卡住工地，再不停地发 event：开头的写进了连接，连接积压很快超过 1MB，其余的只能排队。中间让出事件循环，写完成的回调和重试定时器才有机会跑 */
async function floodWhileFrozen(site: TestSite, link: SiteLink): Promise<void> {
  site.freeze();
  for (let seq = 1; seq <= FLOOD; seq++) {
    link.send(eventFrame(`e${seq}`, { pad: PAD }, seq));
    if (seq % 200 === 0) await sleep(5);
  }
}

// ---------------------------------------------------------------- 发现：bridge.json

it("bridgeFilePath：AGENT_SITE_HOME 优先，其次 APPDATA，最后是用户目录下的 AppData/Roaming", () => {
  expect(bridgeFilePath({ AGENT_SITE_HOME: "D:/x", APPDATA: "C:/a" })).toBe(join("D:/x", "bridge.json"));
  expect(bridgeFilePath({ APPDATA: "C:/a" })).toBe(join("C:/a", "agent-site", "bridge.json"));
  expect(bridgeFilePath({})).toBe(join(homedir(), "AppData", "Roaming", "agent-site", "bridge.json"));
});

const goodFile = { protocol: 2, port: 51234, token: "ab".repeat(32), repos: ["D:/work/example"], pid: 4321 };
const without = (key: string) => Object.fromEntries(Object.entries(goodFile).filter(([k]) => k !== key));
function bridgeJson(content: unknown): string {
  const file = join(mkTmpDir(), "bridge.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

it("readBridgeFile：合法文件原样读出（多余字段忽略）", () => {
  expect(readBridgeFile(bridgeJson(goodFile))).toEqual(goodFile);
  expect(readBridgeFile(bridgeJson({ ...goodFile, extra: "x", repos: [] }))).toEqual({ ...goodFile, repos: [] });
});
it("readBridgeFile：文件开头有 BOM 也照读", () => {
  expect(readBridgeFile(bridgeJson(`﻿${JSON.stringify(goodFile)}`))).toEqual(goodFile);
});
it("readBridgeFile：文件不存在、是目录，都返回 null 而不抛出", () => {
  const dir = mkTmpDir();
  expect(readBridgeFile(join(dir, "missing.json"))).toBeNull();
  expect(readBridgeFile(dir)).toBeNull();
});
const invalidFiles: [string, unknown][] = [
  ["空文件", ""],
  ["不是 JSON", "{oops"],
  ["JSON 但不是对象（null）", null],
  ["JSON 但不是对象（数组）", [goodFile]],
  ["protocol 不是 2", { ...goodFile, protocol: 1 }],
  ["protocol 是字符串", { ...goodFile, protocol: "2" }],
  ["缺 protocol", without("protocol")],
  ["缺 port", without("port")],
  ["缺 token", without("token")],
  ["缺 repos", without("repos")],
  ["缺 pid", without("pid")],
  ["port 不是数字", { ...goodFile, port: "51234" }],
  ["port 为 0", { ...goodFile, port: 0 }],
  ["port 超过 65535", { ...goodFile, port: 65536 }],
  ["port 不是整数", { ...goodFile, port: 80.5 }],
  ["token 为空", { ...goodFile, token: "" }],
  ["token 不是字符串", { ...goodFile, token: 5 }],
  ["repos 不是数组", { ...goodFile, repos: "D:/r" }],
  ["repos 里有非字符串", { ...goodFile, repos: ["D:/r", 5] }],
  ["pid 不是整数", { ...goodFile, pid: "4321" }],
  // R27：路径比较会把空串解析成进程的当前目录，等于在无关会话里激活桥接，所以 repos 的每一项都必须是非空的绝对路径
  ["repos 里有空串", { ...goodFile, repos: ["D:/r", ""] }],
  ["repos 里有空白", { ...goodFile, repos: [" "] }],
  ["repos 里有相对路径", { ...goodFile, repos: ["example"] }],
  ["repos 里有 .", { ...goodFile, repos: ["."] }],
];
it.each(invalidFiles)("readBridgeFile：%s → null", (_name, content) => {
  expect(readBridgeFile(bridgeJson(content))).toBeNull();
});

// ---------------------------------------------------------------- 连接与握手

it("读 bridge.json、双向证明、收到 welcome 后在线：口令不上线，会话信息在验过之后才发", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start();
  const hello = await site.next((m) => m.type === "hello");
  expect(hello).toEqual({ type: "hello", protocol: 2, nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  // 线上的 hello 只有这三个键：口令和会话信息都不能出现在这里（解析后的帧已经按协议丢掉多余字段，只能看原始帧）
  expect(Object.keys(JSON.parse(site.raw[0] as string)).sort()).toEqual(["nonce", "protocol", "type"]);
  const auth = await site.next((m) => m.type === "auth");
  expect(auth).toEqual({ type: "auth", proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), session: info() });
  // 口令本身一个字都不能在线路上出现（含 auth 帧）
  expect(site.raw.some((text) => text.includes(site.token))).toBe(false);
  await waitFor(() => link.isOnline());
});
it("工地晚启动：文件出现后连上", async () => {
  const dir = mkTmpDir();
  const link = makeLink(join(dir, "bridge.json"));
  link.start(); await sleep(250);
  const site = await startSite({ dir });
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
});
it("bridge.json 损坏或版本不对：保持离线、不抛错；修好后连上", async () => {
  const dir = mkTmpDir(); writeFileSync(join(dir, "bridge.json"), "{oops");
  const link = makeLink(join(dir, "bridge.json"));
  link.start(); await sleep(250);
  expect(link.isOnline()).toBe(false);
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ protocol: 2, port: 1, token: "t", repos: [], pid: 1 }));
  await sleep(250);
  expect(link.isOnline()).toBe(false);
  await startSite({ dir });
  await waitFor(() => link.isOnline());
});
it("文件指向一个真实在听的工地，但协议版本不对、或 repos 里有空串：一次连接都不发起", async () => {
  const site = await startSite({ writeFile: false });
  const file = fileOf(site);
  const link = makeLink(file);
  for (const bad of [{ protocol: 1, repos: ["D:/r"] }, { protocol: 2, repos: [""] }]) {
    writeFileSync(file, JSON.stringify({ port: site.port, token: site.token, pid: process.pid, ...bad }));
    link.start(); await sleep(350);
    expect(link.isOnline()).toBe(false);
    expect(site.received).toEqual([]);
    expect(site.connections()).toBe(0);
    link.stop("again");
  }
});
it("工地重启换了端口和口令：掉线一次后重新连上", async () => {
  const dir = mkTmpDir(); let offline = 0;
  const a = await startSite({ dir });
  const link = makeLink(join(dir, "bridge.json"), { onOffline: () => offline++ });
  link.start(); await waitFor(() => link.isOnline());
  await a.close();
  const b = await startSite({ dir });
  await b.next((m) => m.type === "hello");
  expect(b.token).not.toBe(a.token);
  expect(offline).toBe(1);
  await waitFor(() => link.isOnline());
});
it("工地走了一阵：失败的重连尝试不再通知 onOffline；回来后又连上", async () => {
  const dir = mkTmpDir(); let offline = 0, online = 0;
  const a = await startSite({ dir });
  const link = makeLink(join(dir, "bridge.json"), { onOnline: () => online++, onOffline: () => offline++ });
  link.start(); await waitFor(() => link.isOnline());
  await a.close();
  await waitFor(() => offline === 1);
  await sleep(fast.retryMs * 5); // 这期间重连了好几次，都连不上（文件指向已关闭的端口）
  expect(offline).toBe(1);
  expect(link.isOnline()).toBe(false);
  await startSite({ dir });
  await waitFor(() => link.isOnline());
  expect(online).toBe(2);
  expect(offline).toBe(1);
});
it("工地不认这个口令：验不过就不回 welcome，桥接保持离线并按间隔重试", async () => {
  const site = await startSite({ writeFile: false });
  writeFileSync(fileOf(site), JSON.stringify({ protocol: 2, port: site.port, token: "wrong", repos: ["D:/r"], pid: process.pid }));
  const link = makeLink(fileOf(site));
  link.start();
  await site.next((m) => m.type === "hello");
  await site.next((m) => m.type === "hello"); // 被断开后按 retryMs 又来一次
  expect(link.isOnline()).toBe(false);
});
it("端口被不知道口令的进程占住：桥接不发会话信息、也拿不到口令，握手到此为止", async () => {
  // expectToken 不对的假工地 = 占住端口、但手里没有口令的进程：它会发 challenge，却算不出对得上的 proof
  const site = await startSite({ expectToken: "not-the-secret" });
  const link = makeLink(fileOf(site));
  link.start();
  await site.next((m) => m.type === "hello");
  // 桥接回不回 auth，取决于它先收到 challenge —— 工地的 proof 不合法，桥接验不过就该当场断开
  await waitFor(() => !link.isOnline() && site.connections() === 0);
  expect(site.received.filter((m) => m.type === "auth")).toEqual([]);
  expect(link.isOnline()).toBe(false);
});
it("challenge 里的证明对不上：桥接当场断开重连，绝不把会话信息发出去", async () => {
  const site = await startSite({ autoWelcome: false });
  const link = makeLink(fileOf(site));
  link.start();
  await site.next((m) => m.type === "hello");
  // 真工地不会发这种帧：形状合法，但 proof 不是用这个 nonce 和口令算出来的
  site.sendRaw(JSON.stringify({ type: "challenge", nonce: "Z".repeat(43), proof: "Y".repeat(43) }));
  await site.next((m) => m.type === "hello"); // 断开后按 retryMs 重来
  expect(link.isOnline()).toBe(false);
});
it("握手期收到二进制帧：和别的坏帧一样按握手失败处理（当场断开重来，不是等握手超时）", async () => {
  const site = await startSite({ autoChallenge: false });
  // 握手时限拉长到断言窗口之外：这条连接回不来只可能是"坏帧当失败"，不可能是握手超时
  const link = makeLink(fileOf(site), { timings: { ...fast, welcomeMs: 30_000 } });
  link.start();
  await site.next((m) => m.type === "hello");
  site.sendRaw(Buffer.from(JSON.stringify({ type: "challenge", nonce: "Z".repeat(43), proof: "Y".repeat(43) })));
  const started = performance.now();
  await site.next((m) => m.type === "hello", 3000); // 断开后按 retryMs（100ms）重来
  expect(performance.now() - started).toBeLessThan(3000);
  expect(link.isOnline()).toBe(false);
  expect(site.received.filter((m) => m.type === "auth")).toEqual([]);
});
it("握手结束后再收到 challenge（旧连接的证明重放）：不退回握手、不再发 auth，连接保持在线", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start();
  await waitFor(() => link.isOnline());
  const replay = site.challenges[0];
  if (replay === undefined) throw new Error("假工地没有发出过 challenge");
  site.sendRaw(JSON.stringify({ type: "challenge", nonce: replay.nonce, proof: replay.proof }));
  await sleep(200);
  expect(link.isOnline()).toBe(true);
  expect(site.received.filter((m) => m.type === "auth")).toHaveLength(1);
});
it("isProcessAlive：本进程活着，捡来的 pid 不算", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(999_999)).toBe(false);
});
it("bridge.json 里的 pid 不是活进程：一次连接都不发起", async () => {
  const site = await startSite({ writeFile: false });
  const file = fileOf(site);
  writeFileSync(file, JSON.stringify({ protocol: 2, port: site.port, token: site.token, repos: ["D:/r"], pid: 999_999 }));
  const link = makeLink(file);
  link.start();
  await sleep(600);
  expect(link.isOnline()).toBe(false);
  expect(site.accepted()).toBe(0);
});
it("start 重复调用只有一条连接", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); link.start();
  await waitFor(() => link.isOnline());
  link.start();
  await sleep(150);
  expect(site.received.filter((m) => m.type === "hello")).toHaveLength(1);
  expect(site.connections()).toBe(1);
});
it("工地的证明还没验过就发 welcome：不理，不置在线、不发会话信息", async () => {
  // 端口被别的进程占住：它不知道口令，算不出 challenge 的 proof，但可以直接发一帧 welcome 试试
  const site = await startSite({ autoChallenge: false });
  const link = makeLink(fileOf(site));
  link.start();
  await site.next((m) => m.type === "hello");
  site.sendRaw(JSON.stringify({ type: "welcome", protocol: 2 }));
  await sleep(150);
  expect(link.isOnline()).toBe(false);
  expect(site.received.filter((m) => m.type === "auth")).toEqual([]);
});
it("握手没走完就收到指令：当握手失败，断开重连；指令一条都不转交", async () => {
  const site = await startSite({ autoWelcome: false }); const cmds: SiteToBridge[] = [];
  const link = makeLink(fileOf(site), { onCommand: (m) => cmds.push(m) });
  link.start();
  await site.next((m) => m.type === "hello");
  site.send({ type: "pause", cmdId: "early" }); // hello 阶段只认 challenge
  await site.next((m) => m.type === "hello"); // 当场断开，按 retryMs 重来
  expect(link.isOnline()).toBe(false);
  expect(cmds).toEqual([]);
});
it("握手走完（welcome 之后）才转交指令", async () => {
  const site = await startSite(); const cmds: SiteToBridge[] = [];
  const link = makeLink(fileOf(site), { onCommand: (m) => cmds.push(m) });
  link.start();
  await waitFor(() => link.isOnline());
  site.send({ type: "pause", cmdId: "late" });
  await waitFor(() => cmds.length === 1);
  expect(cmds).toEqual([{ type: "pause", cmdId: "late" }]);
});
it("welcome 迟迟不来、或协议版本不对（解析不过，等于没收到）：超时后关掉这条连接，按间隔重连", async () => {
  const site = await startSite({ autoWelcome: false });
  const link = makeLink(fileOf(site));
  link.start();
  await site.next((m) => m.type === "hello");
  site.sendRaw(JSON.stringify({ type: "welcome", protocol: 1 })); // 版本不对：解析不过，等于没收到
  await site.next((m) => m.type === "hello"); // welcomeMs 之后关闭，再过 retryMs 重来
  expect(link.isOnline()).toBe(false);
  expect(site.connections()).toBe(1); // 前一条已经被关掉，不是越连越多
});

// ---------------------------------------------------------------- 心跳与掉线

it("桥接每 pingMs 发一次 ping；收到工地的 ping 回 pong", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  await site.next((m) => m.type === "ping");
  await site.next((m) => m.type === "ping");
  site.send({ type: "ping" });
  await site.next((m) => m.type === "pong");
});
it("工地一直回 pong：连接撑过好几个 deadMs 也不掉线", async () => {
  // pong 每 pingMs（100ms）来一次；deadMs 放宽到 1.2 秒，机器忙得事件循环卡上一秒也不会误判掉线。不刷新的话 deadMs 一到就掉线
  const timings = { ...fast, deadMs: 1200 };
  const site = await startSite(); let offline = 0;
  const link = makeLink(fileOf(site), { onOffline: () => offline++, timings });
  link.start(); await waitFor(() => link.isOnline());
  await sleep(timings.deadMs * 2.5);
  expect(link.isOnline()).toBe(true);
  expect(offline).toBe(0);
  expect(site.received.filter((m) => m.type === "hello")).toHaveLength(1);
});
it("重连几次之后，ping 仍是每 pingMs 一次：旧连接的心跳定时器没有留下", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start();
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
  for (let round = 0; round < 3; round++) {
    site.drop();
    await site.next((m) => m.type === "hello");
    await waitFor(() => link.isOnline());
  }
  const pings = () => site.received.filter((m) => m.type === "ping").length;
  const before = pings(); const startedAt = Date.now();
  await sleep(1000);
  const sent = pings() - before; const elapsed = Date.now() - startedAt;
  expect(sent).toBeGreaterThanOrEqual(3); // 心跳还在走
  expect(sent).toBeLessThanOrEqual(elapsed / fast.pingMs + 2); // 每个旧连接多留一个定时器的话，这里会是两三倍
});
it("工地卡住时 stop：到点硬关，不等对端的关闭帧（否则 print / json 模式的 pi 退不出去）", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  site.freeze(); // 工地不再读、也不再回
  const sockets = () => process.getActiveResourcesInfo().filter(name => name === "TCPSocketWrap").length;
  const before = sockets();
  link.stop("done");
  await sleep(1400); // close 的 1 秒兜底之后
  expect(link.isOnline()).toBe(false);
  expect(sockets()).toBeLessThan(before); // 客户端那条 TCP 连接确实没了
  site.thaw();
});
it("工地卡住（连着，但不读也不回）：按掉线处理并重连；卡住的旧连接事后才关完，也不连累新连接", async () => {
  const site = await startSite(); let offline = 0;
  const link = makeLink(fileOf(site), { onOffline: () => offline++ });
  link.start();
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
  site.freeze();
  await site.next((m) => m.type === "hello"); // deadMs 之后桥接放弃卡住的连接，新连接不受冻结影响
  await waitFor(() => link.isOnline());
  expect(offline).toBe(1);
  site.thaw(); // 旧连接此刻才处理积压的字节、回关闭帧，桥接那一侧的旧连接这才触发 close
  await sleep(fast.deadMs);
  expect(link.isOnline()).toBe(true);
  expect(offline).toBe(1);
  expect(site.received.filter((m) => m.type === "hello")).toHaveLength(2);
});
it("工地沉默超过 deadMs：算掉线（通知一次），随后重连", async () => {
  const site = await startSite({ autoPong: false });
  const onlineAtOffline: boolean[] = []; let online = 0;
  const link = makeLink(fileOf(site), { onOnline: () => online++, onOffline: () => onlineAtOffline.push(link.isOnline()) });
  link.start(); await waitFor(() => link.isOnline());
  await waitFor(() => onlineAtOffline.length === 1);
  expect(onlineAtOffline).toEqual([false]);
  await site.next((m) => m.type === "hello");
  await site.next((m) => m.type === "hello");
  await waitFor(() => online >= 2);
});

// ---------------------------------------------------------------- stop

it("stop：在线时先发 bye 再关连接，之后不重连，也不算掉线", async () => {
  const site = await startSite(); let offline = 0;
  const link = makeLink(fileOf(site), { onOffline: () => offline++ });
  link.start(); await waitFor(() => link.isOnline());
  link.stop("会话结束");
  expect(link.isOnline()).toBe(false);
  expect(await site.next((m) => m.type === "bye")).toEqual({ type: "bye", sessionId: "s1", reason: "会话结束" });
  await waitFor(() => site.connections() === 0);
  await sleep(fast.deadMs); // 比 retryMs、deadMs 都长：没有重连
  expect(site.received.filter((m) => m.type === "hello")).toHaveLength(1);
  expect(site.connections()).toBe(0);
  expect(offline).toBe(0);
});
it("stop 掐掉待发的重试：工地之后出现也不会被连上", async () => {
  const dir = mkTmpDir();
  const link = makeLink(join(dir, "bridge.json"));
  link.start(); link.stop("test");
  const site = await startSite({ dir });
  await sleep(fast.retryMs * 3);
  expect(site.received).toEqual([]);
  expect(site.connections()).toBe(0);
});
it("stop 在握手途中也干净：连接关掉、不再重连、没发 bye", async () => {
  const site = await startSite({ autoWelcome: false });
  const link = makeLink(fileOf(site));
  link.start();
  await site.next((m) => m.type === "hello");
  link.stop("test");
  await waitFor(() => site.connections() === 0);
  await sleep(fast.welcomeMs + fast.retryMs * 2);
  expect(site.received.filter((m) => m.type === "hello")).toHaveLength(1);
  expect(site.received.some((m) => m.type === "bye")).toBe(false);
  expect(site.connections()).toBe(0);
});
it("stop 之后：未答的提问以 null 兑现，新的提问立刻是 null，resolved 什么也不发", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  const pending = link.ask(req("a1"), noSignal());
  await site.next((m) => m.type === "ask");
  link.stop("test");
  expect(await pending).toEqual({ kind: "none" });
  expect(await link.ask(req("a2"), noSignal())).toEqual({ kind: "none" });
  expect(() => link.resolved("a1", "offline")).not.toThrow();
  link.start(); // 重新启动后，停止前记下的东西不会冒出来
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
  await barrier(link, site);
  expect(site.received.some((m) => m.type === "ask_resolved")).toBe(false);
  expect(site.received.filter((m) => m.type === "ask")).toHaveLength(1);
});

it("stop 丢弃离线时记下的 ask_resolved：重新 start 后不会补发", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: { ...fast, retryMs: 300 } });
  link.start(); await waitFor(() => link.isOnline());
  site.drop();
  await waitFor(() => !link.isOnline());
  link.resolved("x", "offline"); // 离线：记下
  link.stop("test");
  link.start();
  await waitFor(() => link.isOnline());
  await barrier(link, site);
  expect(site.received.some((m) => m.type === "ask_resolved")).toBe(false);
});

// ---------------------------------------------------------------- 指令与提问

it("指令转交、坏帧忽略、提问往返", async () => {
  const site = await startSite(); const cmds: SiteToBridge[] = [];
  const link = makeLink(fileOf(site), { onCommand: (m) => cmds.push(m) });
  link.start(); await waitFor(() => link.isOnline());
  // 坏帧：不是 JSON、缺字段、不认识的类型、不是对象、协议不符的 welcome、二进制帧；一律忽略，连接照旧
  for (const raw of ["{oops", '{"type":"pause"}', '{"type":"nope"}', "[]", "null", '{"type":"welcome","protocol":2}']) site.sendRaw(raw);
  site.sendRaw(Buffer.from('{"type":"pause","cmdId":"binary"}'));
  site.send({ type: "pause", cmdId: "c1" });
  site.send({ type: "ping" });
  await site.next((m) => m.type === "pong"); // 它排在上面所有帧之后，回来就说明前面的都处理过了
  expect(cmds).toEqual([{ type: "pause", cmdId: "c1" }]);
  expect(link.isOnline()).toBe(true);
  // 其余三种指令原样转交；answer、ping、pong 和重复的 welcome 不当作指令
  site.send({ type: "resume", cmdId: "c2" });
  site.send({ type: "abort", cmdId: "c3" });
  site.send({ type: "suggest", cmdId: "c4", text: "改用 B", mode: "steer" });
  site.send({ type: "pong" });
  site.send({ type: "welcome", protocol: 2 });
  site.send({ type: "answer", askId: "none", value: "x" });
  site.send({ type: "ping" });
  await site.next((m) => m.type === "pong");
  expect(cmds).toEqual([
    { type: "pause", cmdId: "c1" }, { type: "resume", cmdId: "c2" }, { type: "abort", cmdId: "c3" },
    { type: "suggest", cmdId: "c4", text: "改用 B", mode: "steer" },
  ]);
  // 提问往返
  const p = link.ask({ askId: "a1", question: "选？", options: ["A"], allowOther: true }, noSignal());
  await site.next((m) => m.type === "ask" && m.askId === "a1");
  site.send({ type: "answer", askId: "a1", value: "A" });
  expect(await p).toEqual({ kind: "answer", text: "A" });
  expect(site.invalid).toEqual([]); // 链路发出的每一帧都能通过协议解析
});
it("ask 帧带 sessionId；context 缺席时不发这个字段，有时原样带上", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  void link.ask({ askId: "a1", question: "选？", options: ["A", "B"], allowOther: false }, noSignal());
  void link.ask({ askId: "a2", question: "选？", options: [], allowOther: true, context: "背景" }, noSignal());
  expect(await site.next((m) => m.type === "ask" && m.askId === "a1")).toStrictEqual(
    { type: "ask", sessionId: "s1", askId: "a1", question: "选？", options: ["A", "B"], allowOther: false });
  expect(await site.next((m) => m.type === "ask" && m.askId === "a2")).toStrictEqual(
    { type: "ask", sessionId: "s1", askId: "a2", question: "选？", options: [], allowOther: true, context: "背景" });
  expect(site.invalid).toEqual([]);
});
it("答案：非空 value 是答案；设计师点过的是 skip、App 自动取消的是 none；空串等于没有答案", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  const [empty, cancelled, both, auto, ok] = ["a1", "a2", "a3", "a4", "a5"].map((id) => link.ask(req(id), noSignal()));
  site.send({ type: "answer", askId: "unknown", value: "X" });
  site.send({ type: "answer", askId: "a1", value: "" });
  site.send({ type: "answer", askId: "a2", cancelled: true });
  site.send({ type: "answer", askId: "a3", value: "A", cancelled: true });
  site.send({ type: "answer", askId: "a4", cancelled: true, auto: true }); // 三级会话：设计师根本没看到
  site.send({ type: "answer", askId: "a5", value: "C" });
  site.send({ type: "answer", askId: "a5", value: "D" }); // 已经兑现过
  expect(await empty).toEqual({ kind: "none" });
  expect(await cancelled).toEqual({ kind: "skip" }); // 设计师点了取消：跟"没有答案"分开
  expect(await both).toEqual({ kind: "skip" });
  expect(await auto).toEqual({ kind: "none" }); // App 自己取消的，模型不该以为自己被跳过
  expect(await ok).toEqual({ kind: "answer", text: "C" });
});
it("三级及以下的会话：App 发来的取消一律当'没有答案'，不看 auto（旧版 App 不带 auto）", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { session: () => ({ ...info(), id: "s3", level: 3 }) });
  link.start(); await waitFor(() => link.isOnline());
  const plain = link.ask(req("l3"), noSignal()); // 旧版 App：只有 cancelled，没有 auto
  await site.next((m) => m.type === "ask" && m.askId === "l3");
  site.send({ type: "answer", askId: "l3", cancelled: true });
  // 设计师根本没见过这个问题，模型不该收到"设计师跳过"
  expect(await plain).toEqual({ kind: "none" });
});
it("signal 中止：提问以没有答案兑现并摘掉监听器；链路自己不发 ask_resolved，由调用方随后调 resolved", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  const ac = new AbortController();
  const p = link.ask(req("a1"), ac.signal);
  await site.next((m) => m.type === "ask");
  expect(getEventListeners(ac.signal, "abort")).toHaveLength(1);
  ac.abort();
  expect(await p).toEqual({ kind: "none" });
  expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  await barrier(link, site);
  expect(site.received.some((m) => m.type === "ask_resolved")).toBe(false);
  link.resolved("a1", "cancelled"); // 在线：立刻发
  expect(await site.next((m) => m.type === "ask_resolved")).toEqual({ type: "ask_resolved", askId: "a1", by: "cancelled" });
  // 答案先到：同样摘掉监听器
  const second = new AbortController();
  const answered = link.ask(req("a2"), second.signal);
  await site.next((m) => m.type === "ask" && m.askId === "a2");
  site.send({ type: "answer", askId: "a2", value: "A" });
  expect(await answered).toEqual({ kind: "answer", text: "A" });
  expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
});
it("signal 提问前就已中止：直接 null，也不发 ask 帧", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  const ac = new AbortController(); ac.abort();
  expect(await link.ask(req("a1"), ac.signal)).toEqual({ kind: "none" });
  await barrier(link, site);
  expect(site.received.some((m) => m.type === "ask")).toBe(false);
});
it("resolved 时提问还没兑现（调用方没先中止 signal）：提问以 null 兑现，断线重连后也不再重发", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  const p = link.ask(req("a1"), noSignal());
  await site.next((m) => m.type === "ask");
  link.resolved("a1", "terminal");
  expect(await p).toEqual({ kind: "none" });
  expect(await site.next((m) => m.type === "ask_resolved")).toEqual({ type: "ask_resolved", askId: "a1", by: "terminal" });
  site.drop();
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
  await barrier(link, site);
  expect(site.received.filter((m) => m.type === "ask")).toHaveLength(1);
});
it("同一个 askId 再问一次：前一个以 null 兑现，答案属于后一个", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  const first = new AbortController();
  const p1 = link.ask(req("a1"), first.signal);
  const p2 = link.ask(req("a1"), noSignal());
  expect(await p1).toEqual({ kind: "none" });
  first.abort(); // 前一个的 signal 之后才中止，不能把后一个也带走
  site.send({ type: "answer", askId: "a1", value: "A" });
  expect(await p2).toEqual({ kind: "answer", text: "A" });
});

// R25：提问在断线后保留，重连握手后重发；只有 failPendingAsks（Task 10 的 60 秒宽限到点时调用）才把它们以 null 兑现
it("提问期间工地断线：提问保留，重连后重发同一帧，答案照常兑现", async () => {
  const site = await startSite(); let offline = 0, online = 0;
  const link = makeLink(fileOf(site), { onOnline: () => online++, onOffline: () => offline++ });
  link.start(); await waitFor(() => link.isOnline());
  let settled = false;
  const p = link.ask({ askId: "a2", question: "？", options: ["A"], allowOther: true }, noSignal());
  void p.then(() => { settled = true; });
  const first = await site.next((m) => m.type === "ask" && m.askId === "a2");
  site.drop();
  await waitFor(() => offline === 1);
  expect(settled).toBe(false); // 断线本身不兑现提问
  await site.next((m) => m.type === "hello"); // 工地还在监听，桥接按 retryMs 重连
  const again = await site.next((m) => m.type === "ask" && m.askId === "a2");
  expect(again).toEqual(first);
  expect(settled).toBe(false);
  site.send({ type: "answer", askId: "a2", value: "A" });
  expect(await p).toEqual({ kind: "answer", text: "A" });
  expect(online).toBe(2);
  expect(offline).toBe(1);
});
it("断线后 failPendingAsks：提问以 null 兑现；随后的 resolved 记下，重连后补发，提问不再重发", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: { ...fast, retryMs: 300 } }); // 离线窗口放宽，下面才能稳定地在离线时调用
  link.start(); await waitFor(() => link.isOnline());
  const p = link.ask({ askId: "a2", question: "？", options: ["A"], allowOther: true }, noSignal());
  await site.next((m) => m.type === "ask");
  site.drop();
  await waitFor(() => !link.isOnline());
  link.failPendingAsks();
  expect(await p).toEqual({ kind: "none" });
  link.resolved("a2", "offline"); // 离线时先记下
  await site.next((m) => m.type === "hello");
  await site.next((m) => m.type === "ask_resolved" && m.askId === "a2" && m.by === "offline");
  await barrier(link, site);
  expect(site.received.filter((m) => m.type === "ask")).toHaveLength(1); // 只有断线前发的那一次
  expect(site.received.filter((m) => m.type === "ask_resolved")).toHaveLength(1);
});
it("离线时发起的提问也保留：重连握手后才发出", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: { ...fast, retryMs: 300 } });
  link.start(); await waitFor(() => link.isOnline());
  site.drop();
  await waitFor(() => !link.isOnline());
  const p = link.ask(req("a5"), noSignal());
  expect(site.received.some((m) => m.type === "ask")).toBe(false);
  await site.next((m) => m.type === "hello");
  await site.next((m) => m.type === "ask" && m.askId === "a5");
  site.send({ type: "answer", askId: "a5", value: "A" });
  expect(await p).toEqual({ kind: "answer", text: "A" });
});
it("离线时 resolved 记下，之后按顺序先补发 ask_resolved、再重发仍在等的提问", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: { ...fast, retryMs: 300 } });
  link.start(); await waitFor(() => link.isOnline());
  const done = new AbortController();
  const gone = link.ask(req("old"), done.signal);
  void link.ask(req("live"), noSignal());
  await site.next((m) => m.type === "ask" && m.askId === "live");
  site.drop();
  await waitFor(() => !link.isOnline());
  done.abort(); // 调用方在离线期间结束了 old：先中止 signal，再 resolved
  expect(await gone).toEqual({ kind: "none" });
  link.resolved("old", "terminal");
  link.resolved("old2", "cancelled");
  await site.next((m) => m.type === "hello");
  // next 只往后找：三帧能按这个顺序依次等到，就说明补发顺序是 old → old2 → live
  expect(await site.next((m) => m.type === "ask_resolved" && m.askId === "old")).toMatchObject({ by: "terminal" });
  expect(await site.next((m) => m.type === "ask_resolved" && m.askId === "old2")).toMatchObject({ by: "cancelled" });
  expect(await site.next((m) => m.type === "ask" && m.askId === "live", 1000)).toMatchObject({ sessionId: "s1" });
});

// ---------------------------------------------------------------- send 与回调

it("离线时 send 不抛错", () => {
  const link = makeLink(join(mkTmpDir(), "bridge.json"));
  expect(() => link.send({ type: "ping" })).not.toThrow();
  expect(link.isOnline()).toBe(false);
});
it("离线时 send 的消息直接丢弃，重连后不补发", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: { ...fast, retryMs: 300 } });
  link.start(); await waitFor(() => link.isOnline());
  link.send(eventFrame("online"));
  await site.next((m) => m.type === "event");
  site.drop();
  await waitFor(() => !link.isOnline());
  link.send(eventFrame("offline"));
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
  await sleep(150); // 比 50ms 的重试定时器长：离线时的 event 要是被排了队，这时早已补发到新连接上了
  await barrier(link, site);
  expect(site.received.flatMap((m) => (m.type === "event" ? [m.summary] : []))).toEqual(["online"]);
});
// R33（规格 5.2 硬性要求 4：异步、批量、有上限，工地处理不过来时丢最旧的）：event 先进一个 500 条的队列，
// 连接的积压（bufferedAmount）不超过 1MB 时成批写出，超过就留在队列里等；队列满了挤掉最旧的
it("event 积压（工地卡住，连接里堆了超过 1MB）：排队，队列满了丢最旧的；工地恢复后最新的一条一定送到，顺序不乱", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: patient });
  link.start(); await waitFor(() => link.isOnline());
  await floodWhileFrozen(site, link);
  site.thaw();
  await site.next((m) => m.type === "event" && m.seq === FLOOD, 10_000);
  const seqs = eventSeqs(site);
  expect(seqs.at(-1)).toBe(FLOOD); // 最后发的那条送到了
  expect(seqs.every((seq, i) => i === 0 || seq > (seqs[i - 1] ?? 0))).toBe(true); // 顺序没乱，也没有重复
  expect(seqs[0]).toBe(1); // 积压之前就写进连接的那批
  expect(seqs.slice(-500)).toEqual(Array.from({ length: 500 }, (_, i) => FLOOD - 499 + i)); // 队列里留下的是最新的 500 条
  expect(seqs.length).toBeLessThan(FLOOD); // 中间有被丢掉的
  expect(seqs.some((seq, i) => i > 0 && seq - (seqs[i - 1] ?? 0) > 1)).toBe(true); // 缺口在中间：开头那批和最后 500 条之间
  expect(site.invalid).toEqual([]);
});
it("event 积压时，其他消息不排队、直接写出，照样送到，而且排在队列里的 event 前面", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: patient });
  link.start(); await waitFor(() => link.isOnline());
  await floodWhileFrozen(site, link);
  link.send({ type: "state", sessionId: "s1", paused: false, idle: true });
  link.send({ type: "ack", cmdId: "c1", ok: true });
  site.thaw();
  await site.next((m) => m.type === "event" && m.seq === FLOOD, 10_000);
  const indexOf = (pred: (m: BridgeToSite) => boolean) => site.received.findIndex(pred);
  const oldestQueued = indexOf((m) => m.type === "event" && m.seq === FLOOD - 499);
  expect(oldestQueued).toBeGreaterThan(-1);
  expect(indexOf((m) => m.type === "state")).toBeGreaterThan(-1);
  expect(indexOf((m) => m.type === "state")).toBeLessThan(oldestQueued);
  expect(indexOf((m) => m.type === "ack" && m.cmdId === "c1")).toBeGreaterThan(-1);
  expect(indexOf((m) => m.type === "ack" && m.cmdId === "c1")).toBeLessThan(oldestQueued);
});
it("没有积压时 event 立刻写出，不等重试定时器：先发的 event 比后发的 state 先到", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site));
  link.start(); await waitFor(() => link.isOnline());
  link.send(eventFrame("first"));
  link.send({ type: "state", sessionId: "s1", paused: false, idle: true }); // state 直接写；event 要是等了定时器，会落在它后面
  await site.next((m) => m.type === "event");
  await site.next((m) => m.type === "state", 1000); // next 只往后找：能先后等到，就说明 event 在 state 前面
});
it("掉线时清空 event 队列：重连后不会补发旧的 event", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: patient });
  link.start();
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
  await floodWhileFrozen(site, link);
  site.drop(); // 这条连接上没送出去的（连接里的和队列里的）都作废
  await site.next((m) => m.type === "hello");
  await waitFor(() => link.isOnline());
  // ws 关闭连接时，会把冻住的 socket 里已经缓冲的那一小块字节当作最后一批读掉，所以旧连接上的头几十条 event 此刻才进 received；
  // 只数新连接握手之后到的
  const seenOnOldConnection = eventSeqs(site).length;
  await sleep(150); // 比 50ms 的重试定时器长：队列要是没清、定时器没停，旧 event 这时早已补发到新连接上了
  link.send(eventFrame("fresh", undefined, 99_999)); // 每次 send 都会顺带把队列里排着的写出去：队列要是没清，旧 event 会跟在前面一起到
  await site.next((m) => m.type === "event" && m.seq === 99_999);
  expect(eventSeqs(site).slice(seenOnOldConnection)).toEqual([99_999]);
});
it("stop 时队列里还有 event：队列和重试定时器都清掉，不留定时器", async () => {
  const site = await startSite();
  const link = makeLink(fileOf(site), { timings: patient });
  link.start(); await waitFor(() => link.isOnline());
  site.freeze();
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout"); // 只观察：下面这段同步代码里，起定时器的只可能是链路自己
  for (let seq = 1; seq <= 3000; seq++) link.send(eventFrame(`e${seq}`, { pad: PAD }, seq));
  const retryTimers = setTimeoutSpy.mock.calls.flatMap(([, ms], i) => (ms === 50 ? [setTimeoutSpy.mock.results[i]?.value as unknown] : []));
  setTimeoutSpy.mockRestore();
  expect(retryTimers).toHaveLength(1); // 一个重试定时器，不是每条 event 一个
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  link.stop("test");
  expect(clearTimeoutSpy.mock.calls.map(([timer]) => timer)).toContain(retryTimers[0]);
  clearTimeoutSpy.mockRestore();
});
it("回调抛错不影响连接：onOnline、onCommand、onOffline 抛错后链路照常工作、照常重连", async () => {
  const site = await startSite();
  const boom = () => { throw new Error("boom"); };
  const link = makeLink(fileOf(site), { onOnline: boom, onCommand: boom, onOffline: boom });
  link.start(); await waitFor(() => link.isOnline());
  site.send({ type: "pause", cmdId: "c1" });
  site.send({ type: "ping" });
  await site.next((m) => m.type === "pong"); // onCommand 抛错之后，下一帧照常处理
  expect(link.isOnline()).toBe(true);
  site.drop();
  await site.next((m) => m.type === "hello"); // onOffline 抛错之后，重连照常安排
  await waitFor(() => link.isOnline());
});
it("DEFAULT_TIMINGS 是规格里的数", () => {
  expect(DEFAULT_TIMINGS).toEqual({ retryMs: 10000, pingMs: 10000, deadMs: 30000, welcomeMs: 5000 });
});
