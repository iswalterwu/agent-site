import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { BAD_ARGS, OFFLINE_NOTE, OTHER_LABEL, registerAskDesigner } from "../../src/bridge/ask";
import type { AskRequest, AskUi, SiteAsker } from "../../src/bridge/ask";
import { callTool, say, startFauxSession } from "../harness/pi-faux";
import { mkTmpDir, sleep, waitFor } from "../harness/wait";
import { fakeSite, fakeUi, never, resolveAfter } from "./ask-fakes";

type ToolResult = Extract<Message, { role: "toolResult" }>;

/** 模型下一次请求时，对话里 ask_designer 的全部工具结果 */
const askResults = (messages: Message[]) =>
  messages.filter((m): m is ToolResult => m.role === "toolResult" && m.toolName === "ask_designer");
const textOf = (result: ToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** 装了 ask_designer 的会话；askId 固定，方便断言 */
const boot = (site: SiteAsker | null) =>
  startFauxSession({ cwd: mkTmpDir(), extensions: [(pi) => registerAskDesigner(pi, { site: () => site, newId: () => "ask-1" })] });

/** 真实的 tui 模式要起整个终端界面，这里把会话的运行模式和对话框换成假的，扩展看到的 ctx.mode / ctx.ui 与 tui 下一致 */
const asTui = (ui: AskUi) => ({ mode: "tui" as const, uiContext: ui as unknown as ExtensionUIContext });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUESTION = { question: "选哪个？", options: ["方案 A", "方案 B"] };

it("模型调用 ask_designer，工地的回答作为工具结果回到模型", async () => {
  let seen: ToolResult[] = [];
  const site = fakeSite({ answer: "方案 B", afterMs: 10, online: true });
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [(pi) => registerAskDesigner(pi, { site: () => site })] });
  s.setResponses([callTool("ask_designer", QUESTION),
    (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(seen).toHaveLength(1);
  expect(seen[0].isError).toBe(false);
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: "方案 B", source: "site" });
  expect(seen[0].details).toEqual({ answer: "方案 B", source: "site" });
  // 默认 askId 是 UUID；allowOther 没给就是 true
  expect(site.asked).toEqual([{ askId: expect.stringMatching(UUID), ...QUESTION, allowOther: true }]);
  expect(site.resolvedCalls).toEqual([[site.asked[0].askId, "site"]]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("allowOther 默认 true，没给 options 就是空列表，背景原样转给工地", async () => {
  let seen: ToolResult[] = [];
  const site = fakeSite({ answer: "先做 spike", afterMs: 5 });
  const s = await boot(site);
  s.setResponses([callTool("ask_designer", { question: "要不要先做 spike？", context: "时间紧" }),
    (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(site.asked).toEqual([{ askId: "ask-1", question: "要不要先做 spike？", options: [], allowOther: true, context: "时间紧" }]);
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: "先做 spike", source: "site" });
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("没有工地对象（仓库不在监视范围）：非交互会话立即得到离线说明", async () => {
  let seen: ToolResult[] = [];
  const s = await boot(null);
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(seen[0].isError).toBe(false);
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: null, note: OFFLINE_NOTE });
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("工地对象在但不在线：不提问，也不会收到 resolved，立即得到离线说明", async () => {
  let seen: ToolResult[] = [];
  const site = fakeSite({ answer: "方案 B", afterMs: 10, online: false });
  const s = await boot(site);
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: null, note: OFFLINE_NOTE });
  expect(site.asked).toEqual([]);
  expect(site.resolvedCalls).toEqual([]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("没有选项又不允许其他输入：工具调用失败并带上参数错误说明，不会去问工地", async () => {
  let seen: ToolResult[] = [];
  const site = fakeSite({ answer: "B", afterMs: 10 });
  const s = await boot(site);
  s.setResponses([callTool("ask_designer", { question: "选哪个？", options: [], allowOther: false }),
    (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(seen).toHaveLength(1);
  expect(seen[0].isError).toBe(true);
  expect(textOf(seen[0])).toContain(BAD_ARGS);
  expect(site.asked).toEqual([]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("参数不合 schema：问题为空、选项超过 6 个、背景超过 200 字都在执行前被拒，恰好 6 个选项和 200 字可以通过", async () => {
  let seen: ToolResult[] = [];
  const site = fakeSite({ answer: "1", afterMs: 5 });
  const s = await boot(site);
  const six = ["1", "2", "3", "4", "5", "6"];
  s.setResponses([
    callTool("ask_designer", { question: "", options: ["A"] }),
    callTool("ask_designer", { question: "选哪个？", options: [...six, "7"] }),
    callTool("ask_designer", { question: "选哪个？", options: ["A"], context: "长".repeat(201) }),
    callTool("ask_designer", { question: "选哪个？", options: six, context: "长".repeat(200) }),
    (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(seen.map((r) => r.isError)).toEqual([true, true, true, false]);
  expect(site.asked).toHaveLength(1); // 只有最后一个合法的调用到了工地
  expect(site.asked[0]).toMatchObject({ options: six, context: "长".repeat(200) });
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("默认启用、只给模型用，用法写进系统提示", async () => {
  const s = await boot(null);
  expect(s.session.getActiveToolNames()).toContain("ask_designer");
  expect(s.session.getToolDefinition("ask_designer")).toMatchObject({ label: "问设计师", exposure: "model-only", executionMode: "sequential" });
  expect(s.session.systemPrompt).toContain("需要用户（设计师）拍板的事项，调用 ask_designer 并给出具体选项，不要只在回复里提问。");
  s.dispose();
});
it("与同一条回复里的其他工具调用顺序执行：问题答完之前别的工具不会开始", async () => {
  const answered: string[] = [];
  const base = fakeSite({ answer: "方案 B", afterMs: 150 });
  const site = { ...base, async ask(req: AskRequest, signal: AbortSignal) { const answer = await base.ask(req, signal); answered.push("answered"); return answer; } };
  const s = await boot(site);
  s.setResponses([
    fauxAssistantMessage([fauxToolCall("ask_designer", QUESTION), fauxToolCall("probe", { n: 1 })], { stopReason: "toolUse" }),
    say("done")]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  expect(answered).toEqual(["answered"]); // probe 开始时问题已经答完；并行的话它几毫秒内就会开始，那时还没答
  await run;
  expect(s.probeCalls).toEqual([1]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});

// 以下是终端一侧：tui 模式下 ctx.ui 是真的对话框，这里换成假的，其余（工具注册、参数校验、ctx 的包装）都是真实的 pi。
it("tui 模式、工地不在：终端对话框的回答作为工具结果回到模型", async () => {
  let seen: ToolResult[] = [];
  const ui = fakeUi({ select: resolveAfter("方案 A", 5) });
  const s = await boot(null);
  await s.session.bindExtensions(asTui(ui));
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: "方案 A", source: "terminal" });
  expect(ui.selects).toEqual([{ title: "选哪个？", options: ["方案 A", "方案 B", OTHER_LABEL] }]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("tui 模式、选其他…再输入：输入的内容作为回答", async () => {
  let seen: ToolResult[] = [];
  const ui = fakeUi({ select: resolveAfter(OTHER_LABEL, 5), input: resolveAfter("都不要，先做 spike", 5) });
  const s = await boot(null);
  await s.session.bindExtensions(asTui(ui));
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: "都不要，先做 spike", source: "terminal" });
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("tui 模式、工地先答：终端对话框被取消", async () => {
  let seen: ToolResult[] = [];
  const ui = fakeUi({ select: never() }); const site = fakeSite({ answer: "方案 B", afterMs: 20 });
  const s = await boot(site);
  await s.session.bindExtensions(asTui(ui));
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: "方案 B", source: "site" });
  expect(ui.lastSignal?.aborted).toBe(true);
  expect(site.resolvedCalls).toEqual([["ask-1", "site"]]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("tui 模式、终端先答：工地的提问被取消，并被告知终端已答", async () => {
  let seen: ToolResult[] = [];
  const ui = fakeUi({ select: resolveAfter("方案 A", 20) }); const site = fakeSite({ answer: "方案 B", afterMs: 2000 });
  const s = await boot(site);
  await s.session.bindExtensions(asTui(ui));
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: "方案 A", source: "terminal" });
  expect(site.lastSignal?.aborted).toBe(true);
  expect(site.resolvedCalls).toEqual([["ask-1", "terminal"]]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("不是 tui 模式（比如 rpc）即使有 ui 也不弹终端对话框：直接得到离线说明", async () => {
  let seen: ToolResult[] = [];
  const ui = fakeUi({ select: resolveAfter("方案 A", 5) });
  const s = await boot(null);
  await s.session.bindExtensions({ mode: "rpc", uiContext: ui as unknown as ExtensionUIContext });
  s.setResponses([callTool("ask_designer", QUESTION), (ctx) => { seen = askResults(ctx.messages); return say("ok"); }]);
  await s.session.prompt("go");
  expect(JSON.parse(textOf(seen[0]))).toEqual({ answer: null, note: OFFLINE_NOTE });
  expect(ui.selects).toEqual([]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("会话被中止（比如在终端按 Esc）：两边都取消，工地收到 cancelled，会话回到空闲", async () => {
  const ui = fakeUi({ select: never() }); const site = fakeSite({ answer: "方案 B", afterMs: 60_000 });
  const s = await boot(site);
  await s.session.bindExtensions(asTui(ui));
  s.setResponses([callTool("ask_designer", QUESTION), say("never")]);
  const run = s.session.prompt("go");
  await waitFor(() => site.asked.length === 1 && ui.selects.length === 1);
  await s.session.abort();
  // 2 秒内没落定就算卡住：回归时快速失败，而不是干等到测试超时
  await expect(Promise.race([run.then(() => "settled", () => "settled"), sleep(2000).then(() => "hung")])).resolves.toBe("settled");
  expect(site.resolvedCalls).toEqual([["ask-1", "cancelled"]]);
  expect(site.lastSignal?.aborted).toBe(true);
  expect(ui.lastSignal?.aborted).toBe(true);
  expect(s.session.isStreaming).toBe(false);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
