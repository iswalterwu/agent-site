import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { installEventForwarding } from "../../src/bridge/events";
import { LIMITS } from "../../src/protocol/v2";
import type { EventKind } from "../../src/protocol/v2";
import { callTool, say, startFauxSession } from "../harness/pi-faux";
import type { ExtensionFactory } from "../harness/pi-faux";
import { mkTmpDir, waitFor } from "../harness/wait";

type Got = Array<[EventKind, string, unknown]>;

/** 装了事件上报的会话；isBridgeInjected 只认 "来自工地"；pi() 供测试像 Control 那样调 pi.sendUserMessage */
async function boot(opts: { more?: ExtensionFactory[]; probeDelayMs?: number } = {}) {
  const got: Got = [];
  const sink = { emit: (k: EventKind, s: string, d?: unknown) => got.push([k, s, d]) };
  let piRef!: ExtensionAPI;
  const s = await startFauxSession({
    cwd: mkTmpDir(),
    probeDelayMs: opts.probeDelayMs,
    extensions: [(pi) => { piRef = pi; installEventForwarding(pi, sink, { isBridgeInjected: (t) => t === "来自工地" }); }, ...(opts.more ?? [])],
  });
  return { got, s, pi: () => piRef };
}

it("一次工具调用产生的事件按顺序上报", async () => {
  const got: Array<[EventKind, string, unknown]> = [];
  const sink = { emit: (k: EventKind, s: string, d?: unknown) => got.push([k, s, d]) };
  const s = await startFauxSession({ cwd: mkTmpDir(),
    extensions: [(pi) => { installEventForwarding(pi, sink, { isBridgeInjected: (t) => t === "来自工地" }); }] });
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  const kinds = got.map((g) => g[0]);
  expect(kinds).toEqual(expect.arrayContaining(["user_prompt", "tool_start", "tool_end", "assistant_text", "turn_end", "agent_idle"]));
  expect(kinds.indexOf("tool_start")).toBeLessThan(kinds.indexOf("tool_end"));
  expect(got.find((g) => g[0] === "user_prompt")?.[2]).toEqual({ source: "user" });
  expect(got.find((g) => g[0] === "tool_end")?.[2]).toMatchObject({ tool: "probe", ok: true });
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});

// 以下是补充的测试：完整顺序与摘要、桥接注入的来源、思考与出错、重试与中断后的空闲、模型切换与压缩、被拦下的工具、不改动对话。
it("完整的事件序列、摘要与 detail", async () => {
  const { got, s } = await boot();
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  // 工具事件的 toolCallId 就是模型那条工具调用的 id
  const callIds = s.session.messages.flatMap((m) => (m.role === "assistant" ? m.content : [])).flatMap((c) => (c.type === "toolCall" ? [c.id] : []));
  expect(callIds).toHaveLength(1);
  expect(got).toEqual([
    ["user_prompt", "go", { source: "user" }],
    ["tool_start", "probe", { tool: "probe", toolCallId: callIds[0] }],
    ["tool_end", "probe 完成", { tool: "probe", toolCallId: callIds[0], ok: true, durationMs: expect.any(Number) }],
    ["turn_end", "回合结束", undefined],
    ["assistant_text", "done", undefined],
    ["turn_end", "回合结束", undefined],
    ["agent_idle", "空闲", undefined],
  ]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("桥接自己经 sendUserMessage 送出的建议，上报为 source: bridge；用户自己的提示仍是 user", async () => {
  const { got, s, pi } = await boot();
  s.setResponses([say("got it"), say("again")]);
  pi().sendUserMessage("来自工地"); // 和 Control 一样不等它：run 在后台跑完
  await waitFor(() => got.some((g) => g[0] === "agent_idle"));
  await s.session.waitForIdle(); // agent_idle 是在 pi 的收尾事件里报的，pi 收尾完才能再提交下一条
  await s.session.prompt("来自用户");
  expect(got.filter((g) => g[0] === "user_prompt")).toEqual([
    ["user_prompt", "来自工地", { source: "bridge" }],
    ["user_prompt", "来自用户", { source: "user" }],
  ]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("运行中以 steer 送出的建议：等 pi 把它取走时才上报，来源仍是 bridge", async () => {
  const { got, s, pi } = await boot({ probeDelayMs: 300 });
  s.setResponses([callTool("probe", { n: 1 }), say("改完了")]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  pi().sendUserMessage("来自工地", { deliverAs: "steer" });
  await waitFor(() => s.session.getSteeringMessages().length === 1);
  // 工具还在跑，建议只是排进了队列，还不算进了对话
  expect(got.filter((g) => g[0] === "user_prompt")).toEqual([["user_prompt", "go", { source: "user" }]]);
  await run;
  const kinds = got.map((g) => g[0]);
  expect(got.filter((g) => g[0] === "user_prompt")).toEqual([
    ["user_prompt", "go", { source: "user" }],
    ["user_prompt", "来自工地", { source: "bridge" }],
  ]);
  expect(kinds.lastIndexOf("user_prompt")).toBeGreaterThan(kinds.indexOf("tool_end"));
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("助手回复里的思考块和文本块按顺序上报；摘要截到 LIMITS.text", async () => {
  const { got, s } = await boot();
  const long = "长".repeat(LIMITS.text + 100);
  s.setResponses([fauxAssistantMessage([fauxThinking("先想想"), fauxText(long)])]);
  await s.session.prompt("go");
  const said = got.filter((g) => g[0] === "thinking" || g[0] === "assistant_text");
  expect(said.map((g) => g[0])).toEqual(["thinking", "assistant_text"]);
  expect(said[0][1]).toBe("先想想");
  expect(said[1][1]).toHaveLength(LIMITS.text);
  expect(said[1][1].endsWith("…")).toBe(true);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("模型出错的回复：先报已有的文本，再报 error（api_error），随后照常 turn_end / agent_idle", async () => {
  const { got, s } = await boot();
  s.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "invalid request: nope" })]);
  await s.session.prompt("go");
  expect(got.map((g) => g[0])).toEqual(["user_prompt", "assistant_text", "error", "turn_end", "agent_idle"]);
  expect(got.find((g) => g[0] === "error")).toEqual(["error", "invalid request: nope", { category: "api_error" }]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("pi 因可重试的错误自动重试：每个 agent_end 都不算空闲，整个过程只在彻底收尾时报一次 agent_idle，排在最后一个 turn_end 之后", async () => {
  let agentEnds = 0;
  const countAgentEnds: ExtensionFactory = (pi) => { pi.on("agent_end", () => { agentEnds++; }); };
  const { got, s } = await boot({ more: [countAgentEnds] });
  s.session.settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } }); // 默认退避 2 秒，测试里不等
  s.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
    say("recovered"),
  ]);
  await s.session.prompt("go");
  expect(agentEnds).toBe(2); // 失败的那次运行结束一次，重试的运行再结束一次，但整个过程只收尾一次
  expect(got).toEqual([
    ["user_prompt", "go", { source: "user" }],
    ["error", "503 service unavailable", { category: "api_error" }],
    ["turn_end", "回合结束", undefined],
    ["assistant_text", "recovered", undefined],
    ["turn_end", "回合结束", undefined],
    ["agent_idle", "空闲", undefined],
  ]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("被中断的运行同样彻底收尾，也报 agent_idle（只报一次，排在最后）", async () => {
  const { got, s } = await boot({ probeDelayMs: 300 });
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  await s.session.abort();
  await run.catch(() => undefined);
  expect(got.filter((g) => g[0] === "agent_idle")).toEqual([["agent_idle", "空闲", undefined]]);
  expect(got.at(-1)?.[0]).toBe("agent_idle");
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("切换模型上报 model_change（provider/id）；选中同一个模型 pi 不发事件", async () => {
  const { got, s } = await boot();
  const current = s.session.model;
  if (current === undefined) throw new Error("会话应当有模型");
  await s.session.setModel(current);
  expect(got).toEqual([]);
  await s.session.setModel({ ...current, id: "faux-2" });
  expect(got).toEqual([["model_change", "faux/faux-2", undefined]]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("压缩上下文上报 compaction", async () => {
  const { got, s } = await boot();
  const big = "x".repeat(100_000); // 会话要足够大，pi 才有东西可压
  for (let i = 0; i < 3; i++) {
    s.setResponses([say(`ok ${i}`)]);
    await s.session.prompt(`round ${i} ${big}`);
  }
  expect(got.some((g) => g[0] === "compaction")).toBe(false);
  s.setResponses([say("对话摘要")]);
  await s.session.compact();
  expect(got.filter((g) => g[0] === "compaction")).toEqual([["compaction", "压缩上下文", undefined]]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("被别的扩展拦下的工具调用：tool_end 报 ok: false，没有执行就没有耗时", async () => {
  const blockProbe: ExtensionFactory = (pi) => { pi.on("tool_call", () => ({ block: true, reason: "不许动" })); };
  const { got, s } = await boot({ more: [blockProbe] });
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  expect(s.probeCalls).toEqual([]);
  const end = got.find((g) => g[0] === "tool_end");
  expect(end).toEqual(["tool_end", "probe 失败", { tool: "probe", toolCallId: expect.any(String), ok: false }]);
  expect(Object.keys(end?.[2] as object)).toEqual(["tool", "toolCallId", "ok"]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("只观察不改动：对话里的消息原样保留，会话照常收尾", async () => {
  const { got, s } = await boot();
  s.setResponses([callTool("probe", { n: 7 }), say("done")]);
  await s.session.prompt("go");
  const texts = s.session.messages.flatMap((m) =>
    m.role === "user" || m.role === "assistant" ? [`${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`] : []);
  expect(texts).toHaveLength(3);
  expect(texts[0]).toBe(`user:${JSON.stringify([{ type: "text", text: "go" }])}`);
  expect(texts[2]).toContain('"text":"done"');
  expect(s.probeCalls).toEqual([7]);
  expect(got.at(-1)?.[0]).toBe("agent_idle");
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
