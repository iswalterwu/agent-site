// 入口 createSiteBridge 的端到端测试：真实的 pi 会话（faux 模型）装上整个桥接，连到假工地（真实的 WebSocket 服务），
// 从工地一侧发指令、看桥接发来的帧。每个测试最后都关掉会话（发 session_shutdown），并断言整个过程中
// pi 没有收到任何处理函数的错误、工地没有收到解析不过的帧。

import { writeFileSync } from "node:fs";
import path from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { OFFLINE_NOTE } from "../../src/bridge/ask";
import { SHUTDOWN_REASON } from "../../src/bridge/gate";
import { createSiteBridge } from "../../src/bridge/index";
import { ENV_LEVEL, ENV_PARENT } from "../../src/bridge/lineage";
import type { BridgeToSite } from "../../src/protocol/v2";
import { callTool, say, startFauxSession } from "../harness/pi-faux";
import type { ExtensionFactory, FauxSession } from "../harness/pi-faux";
import { startTestSite } from "../harness/site-server";
import type { TestSite, TestSiteOptions } from "../harness/site-server";
import { mkTmpDir, sleep, waitFor } from "../harness/wait";

type Env = Record<string, string | undefined>;
type Frame<T extends BridgeToSite["type"]> = Extract<BridgeToSite, { type: T }>;
type ToolResult = Extract<Message, { role: "toolResult" }>;

const GUIDELINE = "需要用户（设计师）拍板的事项，调用 ask_designer 并给出具体选项，不要只在回复里提问。";
const TODO_GUIDELINE = "计划或进度变化时调用 site_todo，传完整待办列表，不要只在回复里列计划。";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FAST = { retryMs: 100, pingMs: 100, deadMs: 400, welcomeMs: 300 };
const QUESTION = { question: "选哪个？", options: ["选项甲", "选项乙"] };

// 测试中途失败时留下的会话和工地，在 afterEach 里收掉。会话的 shutdown 包成幂等的，测试自己关过也没关系
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); // 盯 setTimeout 的 spy（只记录、照常调用原函数）
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function openSite(opts: TestSiteOptions): Promise<TestSite> {
  const site = await startTestSite(opts);
  cleanups.push(() => site.close());
  return site;
}

async function openSession(cwd: string, extensions: ExtensionFactory[]): Promise<FauxSession> {
  const s = await startFauxSession({ cwd, extensions });
  let closing: Promise<void> | undefined;
  const shutdown = () => (closing ??= s.shutdown());
  cleanups.push(shutdown);
  return { ...s, shutdown };
}

const noGit = async (_cwd: string): Promise<string | null> => null;

/** 测试用的桥接：env 用普通对象（不碰 process.env），时间都缩短，commonDir 默认不查 git */
const bridge = (env: Env, opts: { graceMs?: number; commonDir?: (cwd: string) => Promise<string | null> } = {}) =>
  createSiteBridge({ env, commonDir: opts.commonDir ?? noGit, timings: { ...FAST, graceMs: opts.graceMs ?? 60_000 } });

interface ToolCall { method: "registerTool" | "setActiveTools"; names: string[] }

/** 把交给桥接的 pi 包一层，记下桥接对工具集的每一次改动：注册工具、设置激活的工具 */
function recordToolCalls(factory: ExtensionFactory, calls: ToolCall[]): ExtensionFactory {
  return (pi) => factory(new Proxy(pi, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "registerTool") {
        return (tool: { name: string }) => { calls.push({ method: "registerTool", names: [tool.name] }); return value.call(target, tool); };
      }
      if (prop === "setActiveTools") {
        return (names: string[]) => { calls.push({ method: "setActiveTools", names: [...names] }); return value.call(target, names); };
      }
      return value.bind(target);
    },
  }));
}

/**
 * 一个仓库、写好 bridge.json 的工地（监视或不监视这个仓库），和在仓库里开的装了桥接的会话；
 * pi() 取会话的 ExtensionAPI，toolCalls 是桥接对工具集的改动
 */
async function boot(opts: { watched: boolean; graceMs?: number }) {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [opts.watched ? repo : mkTmpDir()] });
  const env: Env = { AGENT_SITE_HOME: site.dir };
  const toolCalls: ToolCall[] = [];
  let piRef!: ExtensionAPI;
  const s = await openSession(repo, [recordToolCalls(bridge(env, { graceMs: opts.graceMs }), toolCalls), (pi) => { piRef = pi; }]);
  return { repo, site, env, s, pi: () => piRef, toolCalls };
}

const registeredTools = (pi: ExtensionAPI) => pi.getAllTools().map((tool) => tool.name);

/** 改写工地的 bridge.json：同一个工地、同一个口令，只换被监视的仓库 */
function rewriteRepos(site: TestSite, repos: string[]): void {
  writeFileSync(path.join(site.dir, "bridge.json"), JSON.stringify({ protocol: 2, port: site.port, token: site.token, repos, pid: process.pid }));
}

/** site.next 的带类型版本：上次命中之后，下一个 type 相符且满足 pred 的帧 */
function next<T extends BridgeToSite["type"]>(site: TestSite, type: T, pred: (m: Frame<T>) => boolean = () => true): Promise<Frame<T>> {
  return site.next((m) => m.type === type && pred(m as Frame<T>)) as Promise<Frame<T>>;
}

/** 等到桥接握手完成：auth 之后、上线之前桥接什么都不发，第一个 state 是它上线时补发的 */
async function online(site: TestSite): Promise<Frame<"auth">> {
  const auth = await next(site, "auth");
  await next(site, "state");
  return auth;
}

/** 关掉会话（发 session_shutdown），再断言整个过程中 pi 没收到处理函数的错误、工地没收到解析不过的帧 */
async function finish(s: FauxSession, site: TestSite): Promise<void> {
  await s.shutdown();
  expect(s.handlerErrors).toEqual([]);
  expect(site.invalid).toEqual([]);
}

/** 2 秒内没落定就返回 "hung"：回归时快速失败，而不是干等到测试超时 */
const settling = (pending: Promise<unknown>) =>
  Promise.race([pending.then(() => "settled", () => "settled"), sleep(2000).then(() => "hung")]);

/** 模型下一次请求时，对话里某个工具的全部工具结果 */
const toolResults = (messages: Message[], tool: string) =>
  messages.filter((m): m is ToolResult => m.role === "toolResult" && m.toolName === tool);
const textOf = (result: ToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

it("被监视仓库里的会话：hello 只带随机数，会话信息在验过工地之后才发，层级 1", async () => {
  const { repo, site, env, s } = await boot({ watched: true });
  const hello = await next(site, "hello");
  expect(hello).toEqual({ type: "hello", protocol: 2, nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  // 可选字段缺席就不带这个键（内存会话没有会话文件，一级会话没有父会话）
  expect(await next(site, "auth")).toEqual({
    type: "auth", proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    session: { id: s.session.sessionId, cwd: repo, model: "faux-1", provider: "faux", level: 1, startedAt: expect.stringMatching(ISO), mode: "print" },
  });
  // 口令在任何一帧里都不出现；hello 只有这三个键（原始帧，解析后的帧已经丢掉多余字段）
  expect(site.raw.some((text) => text.includes(site.token))).toBe(false);
  expect(Object.keys(JSON.parse(site.raw[0] as string)).sort()).toEqual(["nonce", "protocol", "type"]);
  expect(env).toEqual({ AGENT_SITE_HOME: site.dir, [ENV_PARENT]: s.session.sessionId, [ENV_LEVEL]: "1" });
  // 上线后补发当前状态：还没开始干活，未暂停、空闲
  expect(await next(site, "state")).toEqual({ type: "state", sessionId: s.session.sessionId, paused: false, idle: true });
  await finish(s, site);
});
it("工地发暂停→上报 state→工地发继续→工具执行；指令都有 ack", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site); // 握手走完才发指令：握手期的帧一律按失败处理
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  site.send({ type: "pause", cmdId: "c1" });
  expect(await next(site, "ack", (m) => m.cmdId === "c1")).toEqual({ type: "ack", cmdId: "c1", ok: true });
  const run = s.session.prompt("go");
  const held = await next(site, "state", (m) => m.paused && m.holding?.tool === "probe");
  expect(held).toEqual({ type: "state", sessionId: s.session.sessionId, paused: true, holding: { tool: "probe", sinceMs: expect.any(Number) }, idle: false });
  expect(s.probeStarted).toEqual([]);
  site.send({ type: "resume", cmdId: "c2" });
  await run;
  expect(s.probeCalls).toEqual([1]);
  expect(await next(site, "ack", (m) => m.cmdId === "c2")).toEqual({ type: "ack", cmdId: "c2", ok: true });
  await finish(s, site);
});
it("工地断线（一直连不回来）：暂停在 graceMs 后放行；工地回来后补报已解除暂停", async () => {
  const { repo, site, s } = await boot({ watched: true, graceMs: 1000 });
  await online(site);
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  site.send({ type: "pause", cmdId: "c1" });
  await next(site, "ack");
  const run = s.session.prompt("go");
  await next(site, "state", (m) => m.holding !== undefined);
  // 工地不再监听，桥接每 retryMs 重连都连不上（drop 的话桥接 100ms 就连回来了，宽限期根本走不完）
  await site.close();
  await sleep(150); // 离宽限结束还远：机器再忙、晚醒几百毫秒也还在宽限期内；断线就立刻放行的话，此时早已执行
  expect(s.probeStarted).toEqual([]); // 宽限期内仍然挂着
  await run;
  expect(s.probeCalls).toEqual([1]);
  const back = await openSite({ repos: [repo], dir: site.dir });
  await next(back, "hello");
  expect(await next(back, "state")).toEqual({ type: "state", sessionId: s.session.sessionId, paused: false, idle: true });
  expect(site.invalid).toEqual([]);
  await finish(s, back);
});
it("ask_designer 经工地往返：工地的回答作为工具结果回到模型，工地收到 ask_resolved", async () => {
  let results: ToolResult[] = [];
  const { site, s } = await boot({ watched: true });
  await online(site);
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { results = toolResults(ctx.messages, "ask_designer"); return say("ok"); }]);
  const run = s.session.prompt("go");
  const ask = await next(site, "ask");
  expect(ask).toEqual({ type: "ask", sessionId: s.session.sessionId, askId: expect.any(String), ...QUESTION, allowOther: true });
  site.send({ type: "answer", askId: ask.askId, value: "选项乙" });
  await run;
  expect(results).toHaveLength(1);
  expect(JSON.parse(textOf(results[0]))).toEqual({ answer: "选项乙", source: "site" });
  expect(results[0].details).toEqual({ answer: "选项乙", source: "site" });
  await next(site, "ask_resolved", (m) => m.askId === ask.askId && m.by === "site");
  await finish(s, site);
});
it("模型把 options 写成字符串也能用：pi ≥ 1.5 会按 JSON Schema 宽松转换成数组（桥接支持的最低版本）", async () => {
  let results: ToolResult[] = [];
  const { site, s } = await boot({ watched: true });
  await online(site);
  // 两种宽松写法一起守：字符串转数组、字符串 "0" 转 false
  s.setResponses([callTool("ask_designer", { question: "选？", options: "选项甲", allowOther: "0" }), (ctx) => { results = toolResults(ctx.messages, "ask_designer"); return say("ok"); }]);
  const run = s.session.prompt("go");
  const ask = await next(site, "ask");
  expect(ask).toEqual({ type: "ask", sessionId: s.session.sessionId, askId: expect.any(String), question: "选？", options: ["选项甲"], allowOther: false });
  site.send({ type: "answer", askId: ask.askId, value: "选项甲" });
  await run;
  expect(JSON.parse(textOf(results[0]))).toEqual({ answer: "选项甲", source: "site" });
  await finish(s, site);
});
it("ask_designer 的参数是普通 JSON Schema，pi 照常校验：缺 question 的调用被挡在工具外，不会发出提问", async () => {
  let results: ToolResult[] = [];
  const { site, s } = await boot({ watched: true });
  await online(site);
  s.setResponses([callTool("ask_designer", { options: ["A"] }), (ctx) => { results = toolResults(ctx.messages, "ask_designer"); return say("ok"); }]);
  await s.session.prompt("go");
  expect(results).toHaveLength(1);
  expect(String(results[0]?.isError ?? "")).toBe("true");
  expect(textOf(results[0])).toMatch(/Validation failed/);
  expect(site.received.filter((m) => m.type === "ask")).toEqual([]); // 没进 execute
  await finish(s, site);
});
it("CONTROL-8：AGENT_SITE_BRIDGE=off 时整个桥接不装：不订阅事件、不注册工具、不连工地、不导出层级", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const env: Env = { AGENT_SITE_HOME: site.dir, AGENT_SITE_BRIDGE: "off" };
  const toolCalls: ToolCall[] = [];
  // 把交给桥接的 pi 包一层，记下它对 pi 的全部订阅：控制模块就是把 tool_call / turn_end 这些挂在这里的
  const subscribed: string[] = [];
  const watchSubscriptions: ExtensionFactory = (pi) => bridge(env)(new Proxy(pi, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "on") return (name: string, ...rest: unknown[]) => { subscribed.push(name); return value.call(target, name, ...rest); };
      return value.bind(target);
    },
  }));
  let piRef!: ExtensionAPI;
  const s = await openSession(repo, [recordToolCalls(watchSubscriptions, toolCalls), (pi) => { piRef = pi; }]);
  // 工具照常跑：控制模块都没装，一帧也不会发
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  expect(s.probeCalls).toEqual([1]);
  await sleep(300); // 比 FAST.retryMs 长：要是读了 bridge.json，这时已经连上来了
  expect(subscribed).toEqual([]); // 连 session_start / session_shutdown 都没订阅
  expect(site.received).toEqual([]); // 连 hello 都没有
  expect(site.accepted()).toBe(0);
  expect(registeredTools(piRef)).not.toContain("ask_designer");
  expect(registeredTools(piRef)).not.toContain("site_todo");
  expect(toolCalls).toEqual([]); // 连注册都没发生
  expect(env).toEqual({ AGENT_SITE_HOME: site.dir, AGENT_SITE_BRIDGE: "off" }); // 没给子进程导出层级
  await finish(s, site);
});
it("不属于被监视仓库：不连接，工具照常执行，控制模块的处理函数一个都不挂", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [mkTmpDir()] });
  const env: Env = { AGENT_SITE_HOME: site.dir };
  const subscribed: string[] = [];
  const watchSubscriptions: ExtensionFactory = (pi) => bridge(env)(new Proxy(pi, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "on") return (name: string, ...rest: unknown[]) => { subscribed.push(name); return value.call(target, name, ...rest); };
      return value.bind(target);
    },
  }));
  const toolCalls: ToolCall[] = [];
  const s = await openSession(repo, [recordToolCalls(watchSubscriptions, toolCalls)]);
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  await sleep(500);
  expect(site.received).toEqual([]); // 连 hello 都没有
  expect(site.connections()).toBe(0);
  expect(s.probeCalls).toEqual([1]);
  expect(env).toEqual({ AGENT_SITE_HOME: site.dir }); // 没有激活，就不给子进程导出层级
  // 只剩桥接自己的两条：控制模块（tool_call / agent_start / agent_settled）和事件上报都不在这类会话里
  expect([...new Set(subscribed)].sort()).toEqual(["session_shutdown", "session_start"]);
  await finish(s, site);
});
it("会话关闭：挂起的调用以会话结束为由拦下、不执行也不悬空，补报解除暂停后发 bye", async () => {
  let results: ToolResult[] = [];
  const { site, s } = await boot({ watched: true });
  await online(site);
  s.setResponses([callTool("probe", { n: 1 }), (ctx) => { results = toolResults(ctx.messages, "probe"); return say("done"); }]);
  site.send({ type: "pause", cmdId: "c1" });
  await next(site, "ack");
  const run = s.session.prompt("go");
  await next(site, "state", (m) => m.holding !== undefined);
  // 只发 session_shutdown（shutdown() 的前一半）、先不 dispose：真实的 pi 退出和重载也是先发它，这一轮还在跑（重载根本不中断）。
  // （运行中途 dispose 时，只要有扩展订阅着 turn_end，pi 自己就会报一条 turn_end 边界错误；没有扩展订阅 turn_end，pi 根本不做这一步）
  await s.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await expect(settling(run)).resolves.toBe("settled");
  expect(s.probeStarted).toEqual([]); // 设计师暂停的这一步没有在收尾时执行
  expect(results).toHaveLength(1);
  expect(results[0].isError).toBe(true);
  expect(textOf(results[0])).toContain(SHUTDOWN_REASON);
  const bye = await next(site, "bye");
  expect(bye).toEqual({ type: "bye", sessionId: s.session.sessionId, reason: "shutdown" });
  // 告别之前先补报了解除暂停后的状态
  expect(site.received[site.received.indexOf(bye) - 1]).toEqual({ type: "state", sessionId: s.session.sessionId, paused: false, idle: false });
  await finish(s, site); // 再发一次 session_shutdown 并 dispose：收尾可以重复
});

// 以下是 rulings 要求补充的测试，以及几条规则（重连取消宽限、事件编号、中断指令、commonDir 的接线与出错）的覆盖。
it("不属于被监视仓库的会话：ask_designer 根本不注册，系统提示里没有它的用法，桥接也从不改工具集", async () => {
  const { site, s, pi, toolCalls } = await boot({ watched: false });
  await sleep(300); // 作用域判断早已做完
  expect(registeredTools(pi())).not.toContain("ask_designer");
  expect(registeredTools(pi())).not.toContain("site_todo");
  expect(pi().getActiveTools()).not.toContain("ask_designer");
  expect(pi().getActiveTools()).not.toContain("site_todo");
  expect(pi().getActiveTools()).toContain("probe"); // 别的工具不受影响
  expect(s.session.systemPrompt).not.toContain(GUIDELINE);
  expect(s.session.systemPrompt).not.toContain(TODO_GUIDELINE);
  expect(toolCalls).toEqual([]); // 既不注册，也不调 setActiveTools（停用工具会让 pi 丢掉还没注册上的待启用工具）
  await finish(s, site);
});
it("被监视仓库的会话：激活时注册 ask_designer 和 site_todo（只注册、不另改工具集），用法写进系统提示", async () => {
  const { site, s, pi, toolCalls } = await boot({ watched: true });
  await next(site, "hello");
  expect(registeredTools(pi())).toContain("ask_designer");
  expect(registeredTools(pi())).toContain("site_todo");
  expect(pi().getActiveTools()).toEqual(expect.arrayContaining(["probe", "ask_designer", "site_todo"]));
  expect(s.session.systemPrompt).toContain(GUIDELINE);
  expect(s.session.systemPrompt).toContain(TODO_GUIDELINE);
  expect(toolCalls).toEqual([{ method: "registerTool", names: ["ask_designer"] }, { method: "registerTool", names: ["site_todo"] }]);
  await finish(s, site);
});
it("不属于被监视仓库的会话里换分支（/tree）：pi 按对话记录重算工具集，ask_designer 也不会冒出来", async () => {
  let declared: string[] = [];
  const { site, s, pi, toolCalls } = await boot({ watched: false });
  s.setResponses([say("一"), say("二"), (ctx) => { declared = getCurrentTools(ctx.messages).map((tool) => tool.name); return say("三"); }]);
  await s.session.prompt("第一句");
  await s.session.prompt("第二句");
  const first = s.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
  if (first === undefined) throw new Error("对话里应当有用户消息");
  expect((await s.session.navigateTree(first.id)).cancelled).toBe(false);
  expect(registeredTools(pi())).not.toContain("ask_designer");
  expect(pi().getActiveTools()).not.toContain("ask_designer");
  expect(s.session.systemPrompt).not.toContain(GUIDELINE);
  await s.session.prompt("第三句");
  expect(declared).toContain("probe"); // 换分支之后的这一次请求，告诉模型的工具里有 probe，没有 ask_designer
  expect(declared).not.toContain("ask_designer");
  expect(toolCalls).toEqual([]);
  await finish(s, site);
});
it("同一进程里先后两个会话共用 env：都是一级、没有父会话；会话关闭后层级变量恢复原状", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const env: Env = { AGENT_SITE_HOME: site.dir };
  const ext = bridge(env); // 同一个扩展工厂，就像 pi 在 /new、/resume 之后重新加载它
  const ids: string[] = [];
  for (let round = 0; round < 2; round++) {
    const s = await openSession(repo, [ext]);
    const auth = await next(site, "auth", (m) => !ids.includes(m.session.id));
    ids.push(auth.session.id);
    expect(auth.session.level).toBe(1);
    expect(auth.session).not.toHaveProperty("parentId");
    expect(env).toEqual({ AGENT_SITE_HOME: site.dir, [ENV_PARENT]: auth.session.id, [ENV_LEVEL]: "1" });
    await finish(s, site);
    expect(env).toEqual({ AGENT_SITE_HOME: site.dir }); // 本来没有的键删掉
  }
  expect(ids[0]).not.toBe(ids[1]);
});
it("从父会话继承的层级：先后两个会话都按继承值算层级，关闭后把继承值原样放回", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const inherited: Env = { AGENT_SITE_HOME: site.dir, [ENV_PARENT]: "parent-1", [ENV_LEVEL]: "1" };
  const env: Env = { ...inherited };
  const ext = bridge(env);
  const ids: string[] = [];
  for (let round = 0; round < 2; round++) {
    const s = await openSession(repo, [ext]);
    const auth = await next(site, "auth", (m) => !ids.includes(m.session.id));
    ids.push(auth.session.id);
    expect(auth.session).toMatchObject({ parentId: "parent-1", level: 2 });
    expect(env).toEqual({ ...inherited, [ENV_PARENT]: auth.session.id, [ENV_LEVEL]: "2" });
    await finish(s, site);
    expect(env).toEqual(inherited);
  }
});
// CONTROL-12：site_todo 只给被监视仓库的一级会话
it("CONTROL-12：二级会话没有 site_todo，桥接注册 ask_designer 但不给待办工具", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const env: Env = { AGENT_SITE_HOME: site.dir, [ENV_PARENT]: "parent-1", [ENV_LEVEL]: "1" };
  let piRef!: ExtensionAPI;
  const s = await openSession(repo, [bridge(env), (pi) => { piRef = pi; }]);
  await online(site);
  expect(piRef.getAllTools().map((tool) => tool.name)).toContain("ask_designer");
  expect(piRef.getAllTools().map((tool) => tool.name)).not.toContain("site_todo");
  expect(piRef.getActiveTools()).not.toContain("site_todo");
  expect(s.session.systemPrompt).not.toContain(TODO_GUIDELINE);
  await finish(s, site);
});
it("工地发来多行、带首尾空白的建议：回 ack，作为来源 bridge 的 user_prompt 上报；之后用户自己打同样的话仍算 user", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site);
  const text = "  先跑全量测试。\n  再改文档。  \n";
  s.setResponses([say("好的"), say("收到")]);
  site.send({ type: "suggest", cmdId: "s1", text, mode: "steer" });
  expect(await next(site, "ack", (m) => m.cmdId === "s1")).toEqual({ type: "ack", cmdId: "s1", ok: true });
  expect(await next(site, "event", (m) => m.kind === "user_prompt")).toMatchObject({ summary: text, detail: { source: "bridge" } });
  await next(site, "event", (m) => m.kind === "agent_idle");
  await s.session.waitForIdle(); // agent_idle 是在 pi 的收尾事件里报的，pi 收尾完才能再提交下一条
  await s.session.prompt(text); // 每条注入的原文只认一次
  expect(await next(site, "event", (m) => m.kind === "user_prompt")).toMatchObject({ summary: text, detail: { source: "user" } });
  await finish(s, site);
});
it("指令没能执行（会话的 ctx 已失效）：回 ack ok:false 并带上原因", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site);
  s.session.extensionRunner.invalidate("会话已经结束"); // pi 在会话被替换或重新加载时就是这样让旧 ctx 失效的
  site.send({ type: "suggest", cmdId: "s1", text: "换个思路", mode: "steer" });
  expect(await next(site, "ack", (m) => m.cmdId === "s1")).toEqual({ type: "ack", cmdId: "s1", ok: false, error: "会话已经结束" });
  site.send({ type: "abort", cmdId: "a1" });
  expect(await next(site, "ack", (m) => m.cmdId === "a1")).toEqual({ type: "ack", cmdId: "a1", ok: false, error: "会话已经结束" });
  await finish(s, site);
});
it("决策等待中工地断线超过 graceMs：提问回退为离线说明，工地回来后收到 ask_resolved offline、不再重发提问", async () => {
  let results: ToolResult[] = [];
  const { repo, site, s } = await boot({ watched: true, graceMs: 1000 });
  await online(site);
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { results = toolResults(ctx.messages, "ask_designer"); return say("ok"); }]);
  const run = s.session.prompt("go");
  const ask = await next(site, "ask");
  await site.close();
  await sleep(150); // 同上：离宽限结束还远，断线就立刻回退的话此时早已有结果
  expect(results).toEqual([]); // 宽限期内提问还在等
  await run;
  expect(results).toHaveLength(1);
  expect(JSON.parse(textOf(results[0]))).toEqual({ answer: null, note: OFFLINE_NOTE });
  const back = await openSite({ repos: [repo], dir: site.dir });
  await next(back, "hello");
  await next(back, "ask_resolved", (m) => m.askId === ask.askId && m.by === "offline");
  await next(back, "state");
  expect(back.received.filter((m) => m.type === "ask")).toEqual([]);
  expect(site.invalid).toEqual([]);
  await finish(s, back);
});
it("bridge.json 起初不在：每 retryMs 找一次，出现后判断作用域、连上工地并注册 ask_designer", async () => {
  const repo = mkTmpDir();
  const home = mkTmpDir();
  const env: Env = { AGENT_SITE_HOME: home };
  let piRef!: ExtensionAPI;
  const s = await openSession(repo, [bridge(env), (pi) => { piRef = pi; }]);
  await sleep(250);
  expect(registeredTools(piRef)).not.toContain("ask_designer"); // 作用域还不知道：先不注册
  expect(env).toEqual({ AGENT_SITE_HOME: home });
  const site = await openSite({ repos: [repo], dir: home });
  const auth = await next(site, "auth");
  expect(auth.session).toMatchObject({ cwd: repo, level: 1 });
  expect(env[ENV_LEVEL]).toBe("1");
  expect(registeredTools(piRef)).toContain("ask_designer");
  expect(piRef.getActiveTools()).toContain("ask_designer");
  expect(s.session.systemPrompt).toContain(GUIDELINE);
  await finish(s, site);
});
it("bridge.json 后来才出现、但会话不属于被监视仓库：之后也一直不连接、不发 hello", async () => {
  const repo = mkTmpDir();
  const home = mkTmpDir();
  const env: Env = { AGENT_SITE_HOME: home };
  let piRef!: ExtensionAPI;
  const s = await openSession(repo, [bridge(env), (pi) => { piRef = pi; }]);
  await sleep(250);
  const site = await openSite({ repos: [mkTmpDir()], dir: home });
  await sleep(600); // 文件早已可读，又过了好几个 retryMs
  expect(site.received).toEqual([]);
  expect(site.connections()).toBe(0);
  expect(registeredTools(piRef)).not.toContain("ask_designer");
  expect(env).toEqual({ AGENT_SITE_HOME: home });
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  expect(s.probeCalls).toEqual([1]);
  await finish(s, site);
});
it("工地短暂断线、在 graceMs 内连回：暂停不放行，重连后补报当前 state", async () => {
  // 重连大约 retryMs（100ms）就完成，宽限给 2 秒，机器再忙也连得回来；宽限过后再等 1 秒才查，宽限定时器要是没取消，放行早已生效
  const graceMs = 2000;
  const { site, s } = await boot({ watched: true, graceMs });
  await online(site);
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  site.send({ type: "pause", cmdId: "c1" });
  await next(site, "ack");
  const run = s.session.prompt("go");
  await next(site, "state", (m) => m.holding !== undefined);
  const droppedAt = Date.now();
  site.drop(); // 掐断连接但继续监听：桥接 retryMs 之后就连回来
  await next(site, "hello");
  expect(await next(site, "state")).toMatchObject({ sessionId: s.session.sessionId, paused: true, holding: { tool: "probe" }, idle: false });
  await sleep(graceMs + 1000 - (Date.now() - droppedAt)); // 从断线算起已过 graceMs 又 1 秒
  expect(s.probeStarted).toEqual([]);
  site.send({ type: "resume", cmdId: "c2" });
  await run;
  expect(s.probeCalls).toEqual([1]);
  await finish(s, site);
});
it("断线宽限的定时器不 unref：print / json 模式里，工地断线之后进程靠它活到宽限结束、放行挂起的调用", async () => {
  const graceMs = 4321; // 和别的定时器都不一样，好从 setTimeout 的调用里认出它
  const { site, s } = await boot({ watched: true, graceMs });
  await online(site);
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  await site.close();
  await waitFor(() => setTimeoutSpy.mock.calls.some((call) => call[1] === graceMs));
  const grace = setTimeoutSpy.mock.results[setTimeoutSpy.mock.calls.findIndex((call) => call[1] === graceMs)].value as NodeJS.Timeout;
  expect(grace.hasRef()).toBe(true);
  expect(clearTimeoutSpy.mock.calls.some(([timer]) => timer === grace)).toBe(false);
  await finish(s, site);
  expect(clearTimeoutSpy.mock.calls.some(([timer]) => timer === grace)).toBe(true); // 会话结束时清掉了它：不会拖住退出
});
it("找 bridge.json 的轮询定时器 unref：不让 pi 进程在该退出的时候退不掉", async () => {
  const retryMs = 137; // 同上，好认
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const s = await openSession(mkTmpDir(), [createSiteBridge({ env: { AGENT_SITE_HOME: mkTmpDir() }, commonDir: noGit, timings: { ...FAST, retryMs } })]);
  await waitFor(() => setTimeoutSpy.mock.calls.filter((call) => call[1] === retryMs).length >= 2); // 已经找过好几次
  const polls = setTimeoutSpy.mock.calls.flatMap((call, i) => (call[1] === retryMs ? [setTimeoutSpy.mock.results[i].value as NodeJS.Timeout] : []));
  expect(polls.map((timer) => timer.hasRef())).toEqual(polls.map(() => false));
  await s.shutdown();
  expect(s.handlerErrors).toEqual([]);
});
it("上报的事件带 sessionId、从 1 起逐条加一的 seq 和 ISO 时间", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site);
  s.setResponses([say("done")]);
  await s.session.prompt("go");
  await next(site, "event", (m) => m.kind === "agent_idle");
  const events = site.received.filter((m): m is Frame<"event"> => m.type === "event");
  expect(events.map((e) => e.kind)).toEqual(["user_prompt", "assistant_text", "turn_end", "agent_idle"]);
  expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  for (const e of events) {
    expect(e.sessionId).toBe(s.session.sessionId);
    expect(e.ts).toMatch(ISO);
  }
  expect(events[0]).toMatchObject({ summary: "go", detail: { source: "user" } });
  await finish(s, site);
});
it("工地发立即中断：挂起的调用被拦下、暂停解除，回 ack，这一轮结束", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site);
  s.setResponses([callTool("probe", { n: 1 }), say("never")]);
  site.send({ type: "pause", cmdId: "c1" });
  await next(site, "ack", (m) => m.cmdId === "c1");
  const run = s.session.prompt("go");
  await next(site, "state", (m) => m.holding !== undefined);
  site.send({ type: "abort", cmdId: "c2" });
  expect(await next(site, "state", (m) => !m.paused)).not.toHaveProperty("holding");
  expect(await next(site, "ack", (m) => m.cmdId === "c2")).toEqual({ type: "ack", cmdId: "c2", ok: true });
  await expect(settling(run)).resolves.toBe("settled");
  expect(s.probeStarted).toEqual([]);
  await finish(s, site);
});
it("同一个扩展实例上又来一次 session_start（SDK 重新绑定扩展时会这样）：先收掉上一个会话，新会话从未暂停开始", async () => {
  const { site, env, s, pi, toolCalls } = await boot({ watched: true });
  await online(site);
  site.send({ type: "pause", cmdId: "c1" });
  await next(site, "ack", (m) => m.cmdId === "c1");
  await s.session.bindExtensions({}); // 再发一次 session_start，中间没有 session_shutdown
  expect(await next(site, "bye")).toEqual({ type: "bye", sessionId: s.session.sessionId, reason: "shutdown" });
  await next(site, "hello");
  expect(await next(site, "state")).toEqual({ type: "state", sessionId: s.session.sessionId, paused: false, idle: true });
  expect(env).toEqual({ AGENT_SITE_HOME: site.dir, [ENV_PARENT]: s.session.sessionId, [ENV_LEVEL]: "1" });
  // 两个会话都属于被监视的仓库：两个工具都只在第一个会话注册一次；site_todo 在新会话开始时先收起、确认一级后再打开
  expect(pi().getActiveTools()).toEqual(expect.arrayContaining(["ask_designer", "site_todo"]));
  expect(toolCalls).toEqual([
    { method: "registerTool", names: ["ask_designer"] },
    { method: "registerTool", names: ["site_todo"] },
    { method: "setActiveTools", names: ["probe", "ask_designer"] },
    { method: "setActiveTools", names: ["probe", "ask_designer", "site_todo"] },
  ]);
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go"); // 上一个会话的暂停没有带过来：工具调用不会被挂起
  expect(s.probeCalls).toEqual([1]);
  await finish(s, site);
});
it("同一个扩展实例先后遇到属于、不属于、又属于、判断出错的会话：两个工具只注册一次，之后按需收起或重新启用", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  let gitFails = false;
  const commonDir = async (): Promise<string | null> => { if (gitFails) throw new Error("git 坏了"); return null; };
  const toolCalls: ToolCall[] = [];
  let piRef!: ExtensionAPI;
  const s = await openSession(repo, [recordToolCalls(bridge({ AGENT_SITE_HOME: site.dir }, { commonDir }), toolCalls), (pi) => { piRef = pi; }]);
  const askActive = () => piRef.getActiveTools().includes("ask_designer");
  const todoActive = () => piRef.getActiveTools().includes("site_todo");
  const rebind = async (repos: string[]) => {
    rewriteRepos(site, repos);
    toolCalls.length = 0;
    await s.session.bindExtensions({}); // 同一个扩展实例上的下一个会话
  };

  await next(site, "hello"); // 属于：注册（pi 注册时就启用它）
  expect(toolCalls).toEqual([{ method: "registerTool", names: ["ask_designer"] }, { method: "registerTool", names: ["site_todo"] }]);
  expect(askActive()).toBe(true);
  expect(todoActive()).toBe(true);

  await rebind([mkTmpDir()]); // 不属于：收起，但不再注册
  await waitFor(() => !askActive());
  expect(todoActive()).toBe(false);
  expect(toolCalls).toEqual([
    { method: "setActiveTools", names: ["probe", "ask_designer"] }, // 新会话先收起 site_todo
    { method: "setActiveTools", names: ["probe"] }, // 不属于：ask_designer 也收起
  ]);
  expect(toolCalls[1].names).toContain("probe");
  expect(registeredTools(piRef)).toContain("ask_designer");
  expect(s.session.systemPrompt).not.toContain(GUIDELINE);
  expect(s.session.systemPrompt).not.toContain(TODO_GUIDELINE);

  await rebind([repo]); // 又属于：重新启用，不再注册
  await next(site, "hello");
  expect(askActive()).toBe(true);
  expect(todoActive()).toBe(true);
  expect(toolCalls).toEqual([
    { method: "setActiveTools", names: expect.arrayContaining(["probe", "ask_designer"]) },
    { method: "setActiveTools", names: expect.arrayContaining(["probe", "ask_designer", "site_todo"]) },
  ]);
  expect(s.session.systemPrompt).toContain(GUIDELINE);
  expect(s.session.systemPrompt).toContain(TODO_GUIDELINE);

  gitFails = true;
  await rebind([mkTmpDir()]); // 作用域判断出错：按不属于处理，同样收起
  await waitFor(() => !askActive());
  expect(todoActive()).toBe(false);
  expect(toolCalls).toEqual([
    { method: "setActiveTools", names: ["probe", "ask_designer"] },
    { method: "setActiveTools", names: ["probe"] },
  ]);
  expect(site.received.filter((m) => m.type === "hello")).toHaveLength(2); // 只有两个属于的会话连过工地
  await finish(s, site);
});
it("SITE-4：会话先开、工地后进范围：不重启会话，重读到新范围后自己握手", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [] });
  const env: Env = { AGENT_SITE_HOME: site.dir };
  const s = await openSession(repo, [bridge(env)]);
  await sleep(300);
  expect(site.connections()).toBe(0);
  // App 后来发现了这个仓库：把工地加进范围，会话按 retryMs 重读 bridge.json 就能连上
  rewriteRepos(site, [repo]);
  await online(site);
  await finish(s, site);
});
it("SITE-4：已在线的会话被移出范围就自己断开、收起工具，之后不再上报事件", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const env: Env = { AGENT_SITE_HOME: site.dir };
  const toolCalls: ToolCall[] = [];
  let piRef!: ExtensionAPI;
  const s = await openSession(repo, [recordToolCalls(bridge(env), toolCalls), (pi) => { piRef = pi; }]);
  await online(site);
  expect(piRef.getActiveTools()).toContain("ask_designer");

  rewriteRepos(site, [mkTmpDir()]);
  await waitFor(() => !piRef.getActiveTools().includes("ask_designer"));

  s.setResponses([say("done")]);
  await s.session.prompt("还在跑吗");
  await sleep(200);
  expect(site.received.filter((m) => m.type === "event")).toEqual([]);
  await finish(s, site);
});
it("被移出范围又回到范围内：控制模块的处理函数重新装回来，暂停照样能挂起工具", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const env: Env = { AGENT_SITE_HOME: site.dir };
  let piRef!: ExtensionAPI;
  // 现在挂着的事件处理函数（订阅时加上，退订函数被调用时去掉）。按订阅编号记：同一个事件名可能有好几个处理函数
  let nextId = 0;
  const live = new Map<number, string>();
  const names = (): string[] => [...live.values()];
  const recordSubscriptions: ExtensionFactory = (pi) => bridge(env)(new Proxy(pi, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "on") return (name: string, ...rest: unknown[]) => {
        const id = (nextId += 1);
        live.set(id, name);
        const unsubscribe = value.call(target, name, ...rest) as () => void;
        return () => { live.delete(id); unsubscribe(); };
      };
      return value.bind(target);
    },
  }));
  const s = await openSession(repo, [recordSubscriptions, (pi) => { piRef = pi; }]);
  await online(site);
  // 控制模块的四条 + 桥接自己那两条 + 激活后订阅的上报事件
  expect(names()).toEqual(expect.arrayContaining(["agent_settled", "agent_start", "tool_call", "session_start", "session_shutdown"]));
  const controlSubs = names().length;

  rewriteRepos(site, [mkTmpDir()]); // 移出范围：控制模块的处理函数摘掉
  await waitFor(() => !names().includes("tool_call"));
  // 控制模块的处理函数摘掉了（agent_start / agent_settled 上还挂着状态上报，那不在这次的范围里；
  // tool_call 只有控制模块订阅，它没了就说明摘干净了）
  expect(names()).not.toContain("tool_call");
  expect(names()).toContain("session_start"); // 桥接自己那两条还在
  rewriteRepos(site, [repo]); // 又回来了：重新激活
  await waitFor(() => names().includes("tool_call"));
  expect(names().length).toBeGreaterThanOrEqual(controlSubs);
  await next(site, "state"); // 重新上线后补报的那一帧

  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  site.send({ type: "pause", cmdId: "c1" });
  await next(site, "ack", (m) => m.cmdId === "c1");
  const run = s.session.prompt("go");
  await next(site, "state", (m) => m.paused && m.holding?.tool === "probe");
  site.send({ type: "resume", cmdId: "c2" });
  await run;
  expect(s.probeCalls).toEqual([1]);
  await finish(s, site);
});
it("会话结束时还没找到 bridge.json：之后不再找，文件出现也不判断作用域、不连接、不改 env", async () => {
  const repo = mkTmpDir();
  const worktree = mkTmpDir();
  const home = mkTmpDir();
  const env: Env = { AGENT_SITE_HOME: home };
  const asked: string[] = [];
  // 会话在被监视仓库的 worktree 里：要是还在找文件，读到之后就会来问 commonDir，并判为属于
  const commonDir = async (cwd: string) => { asked.push(cwd); return path.join(repo, ".git"); };
  const s = await openSession(worktree, [bridge(env, { commonDir })]);
  await sleep(150);
  await s.shutdown();
  const site = await openSite({ repos: [repo], dir: home });
  await sleep(400);
  expect(asked).toEqual([]);
  expect(site.received).toEqual([]);
  expect(site.connections()).toBe(0);
  expect(env).toEqual({ AGENT_SITE_HOME: home });
  await finish(s, site);
});
it("作用域判断还在等 git 时会话就结束了：结果出来是属于，也不再激活", async () => {
  const repo = mkTmpDir();
  const worktree = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const env: Env = { AGENT_SITE_HOME: site.dir };
  let answer: ((dir: string | null) => void) | undefined;
  const commonDir = (_cwd: string) => new Promise<string | null>((resolve) => { answer = resolve; });
  const s = await openSession(worktree, [bridge(env, { commonDir })]);
  await waitFor(() => answer !== undefined); // 判断已经开始，正等着 git
  // 只发 session_shutdown、先不 dispose：ctx 还有效，单看桥接自己会不会再激活（dispose 之后 ctx 失效，激活本来也会失败）
  await s.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  answer?.(path.join(repo, ".git"));
  await sleep(300);
  expect(site.received).toEqual([]);
  expect(site.connections()).toBe(0);
  expect(env).toEqual({ AGENT_SITE_HOME: site.dir });
  await finish(s, site);
});
it("被监视仓库的 git worktree 也算属于：作用域判断用注入的 commonDir", async () => {
  const repo = mkTmpDir();
  const worktree = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const asked: string[] = [];
  const commonDir = async (cwd: string) => { asked.push(cwd); return path.join(repo, ".git"); };
  const s = await openSession(worktree, [bridge({ AGENT_SITE_HOME: site.dir }, { commonDir })]);
  const auth = await next(site, "auth");
  expect(auth.session.cwd).toBe(worktree);
  expect(asked).toEqual([worktree]);
  await finish(s, site);
});
it("作用域判断出错（commonDir 抛出）：按不属于处理，不连接，也不向 pi 抛错", async () => {
  const site = await openSite({ repos: [mkTmpDir()] });
  const commonDir = async (): Promise<string | null> => { throw new Error("git 坏了"); };
  const s = await openSession(mkTmpDir(), [bridge({ AGENT_SITE_HOME: site.dir }, { commonDir })]);
  await sleep(300);
  expect(site.received).toEqual([]);
  expect(site.connections()).toBe(0);
  await finish(s, site);
});

// 以下是最终修复轮补充的测试：事件上报只在激活期间订阅（R46），state 跟着 agent 走。

/** 只有事件上报才订阅的事件（agent_start / agent_settled 控制部分也订阅，不在此列）；测试会话里别的扩展都不订阅它们 */
const FORWARDED = ["message_end", "tool_execution_start", "tool_execution_end", "model_select", "session_compact", "turn_end"];
const forwarded = (s: FauxSession) => FORWARDED.filter((type) => s.session.extensionRunner.hasHandlers(type));

it("不属于被监视仓库的会话不订阅 turn_end 等上报事件：pi 只在有扩展订阅 turn_end 时才做每回合的边界工作", async () => {
  const { site, s } = await boot({ watched: false });
  await sleep(300); // 作用域判断早已做完
  expect(forwarded(s)).toEqual([]);
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  expect(forwarded(s)).toEqual([]);
  await finish(s, site);
});
it("被监视仓库的会话：激活时订阅上报事件，会话结束时全部退订", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site);
  expect(forwarded(s)).toEqual(FORWARDED);
  await s.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); // 只发 session_shutdown、先不 dispose，好看订阅还在不在
  expect(forwarded(s)).toEqual([]);
  await finish(s, site);
});
it("同一个扩展实例上，属于的会话之后是不属于的会话：前一个会话的上报订阅已经退掉，新会话也不订阅", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site);
  rewriteRepos(site, [mkTmpDir()]);
  await s.session.bindExtensions({}); // 同一个扩展实例上的下一个会话，中间没有 session_shutdown
  await next(site, "bye");
  await sleep(300); // 新会话的作用域判断早已做完
  expect(forwarded(s)).toEqual([]);
  expect(site.received.filter((m) => m.type === "hello")).toHaveLength(1); // 新会话确实没有激活
  await finish(s, site);
});
it("state 跟着 agent 走：开始运行时补报不空闲，彻底收尾时补报空闲", async () => {
  const { site, s } = await boot({ watched: true });
  await online(site);
  s.setResponses([say("done")]);
  await s.session.prompt("go");
  expect(await next(site, "state")).toEqual({ type: "state", sessionId: s.session.sessionId, paused: false, idle: false });
  expect(await next(site, "state")).toEqual({ type: "state", sessionId: s.session.sessionId, paused: false, idle: true });
  await finish(s, site);
});

/** 把交给桥接的 pi 包一层，让其中一个方法一调用就抛错 */
function breakMethod(factory: ExtensionFactory, method: "on" | "registerTool"): ExtensionFactory {
  return (pi) => factory(new Proxy(pi, {
    get(target, prop) {
      if (prop === method) return () => { throw new Error(`${method} 坏了`); };
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }));
}

it("pi.on 抛错：桥接的工厂不把异常抛进 pi 的加载器（工厂抛错 pi 就退出），桥接不起作用，会话照常工作", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const s = await openSession(repo, [breakMethod(bridge({ AGENT_SITE_HOME: site.dir }), "on")]); // 扩展加载失败的话这里就报错
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  expect(s.probeCalls).toEqual([1]);
  await sleep(300); // 桥接要是还在工作，早已连上工地
  expect(site.received).toEqual([]);
  expect(site.connections()).toBe(0);
  await finish(s, site);
});
it("注册 ask_designer 失败（registerTool 抛错）：照样连上工地，暂停照样挂起工具调用", async () => {
  const repo = mkTmpDir();
  const site = await openSite({ repos: [repo] });
  const s = await openSession(repo, [breakMethod(bridge({ AGENT_SITE_HOME: site.dir }), "registerTool")]);
  await online(site);
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  site.send({ type: "pause", cmdId: "c1" });
  await next(site, "ack", (m) => m.cmdId === "c1");
  const run = s.session.prompt("go");
  await next(site, "state", (m) => m.holding !== undefined);
  expect(s.probeStarted).toEqual([]);
  site.send({ type: "resume", cmdId: "c2" });
  await run;
  expect(s.probeCalls).toEqual([1]);
  await finish(s, site);
});
