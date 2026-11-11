import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { BAD_ARGS, OFFLINE_NOTE, OTHER_LABEL, SKIPPED_NOTE, runAsk } from "../../src/bridge/ask";
import type { AskRequest } from "../../src/bridge/ask";
import { sleep } from "../harness/wait";
import { fakeSite, fakeUi, never, resolveAfter } from "./ask-fakes";
import type { UiStep } from "./ask-fakes";

const req: AskRequest = { askId: "a1", question: "选哪个？", options: ["A", "B"], allowOther: true };

/** 用户在对话框里按了 Esc：立刻以 undefined 兑现 */
const dismissed: UiStep = async () => undefined;
const abortListeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;

it("工地先答：用工地的答案，终端对话框被取消", async () => {
  const ui = fakeUi({ select: never() }); const site = fakeSite({ answer: "B", afterMs: 10 });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "B", source: "site" });
  expect(ui.lastSignal?.aborted).toBe(true);
  expect(site.resolvedCalls).toEqual([["a1", "site"]]);
});
it("终端先答：用终端的答案，并通知工地关闭弹框", async () => {
  const ui = fakeUi({ select: resolveAfter("A", 10) }); const site = fakeSite({ answer: "B", afterMs: 500 });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "A", source: "terminal" });
  expect(site.lastSignal?.aborted).toBe(true);
  expect(site.resolvedCalls).toEqual([["a1", "terminal"]]);
});
it("在终端选其他…再输入", async () => {
  const ui = fakeUi({ select: resolveAfter(OTHER_LABEL, 5), input: resolveAfter("都不要", 5) });
  expect(await runAsk(req, { site: null, ui })).toEqual({ answer: "都不要", source: "terminal" });
});
it("工地和终端都不在：立即返回离线说明", async () => {
  expect(await runAsk(req, { site: null, ui: null })).toEqual({ answer: null, note: OFFLINE_NOTE });
});
it("工地中途离线、终端还在：继续等终端", async () => {
  const site = fakeSite({ afterMs: 10 }); const ui = fakeUi({ select: resolveAfter("B", 50) });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "B", source: "terminal" });
  expect(site.resolvedCalls).toEqual([["a1", "terminal"]]); // 工地掉线了也要补一句，重连后由它转给应用
});
it("没有选项又不允许其他输入：报参数错误", async () => {
  await expect(runAsk({ ...req, options: [], allowOther: false }, { site: null, ui: null })).rejects.toThrow(BAD_ARGS);
});
it("设计师在 App 里跳过：模型拿到跳过说明，终端对话框一起关，工地收到 cancelled", async () => {
  const site = fakeSite({ skip: true, afterMs: 10 }); const ui = fakeUi({ select: never() });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: null, note: SKIPPED_NOTE });
  expect(SKIPPED_NOTE).toBe("设计师跳过了这个问题，请按最佳判断继续，并在回复里说明你的假设");
  expect(ui.lastSignal?.aborted).toBe(true); // 终端那边不用再问了
  expect(site.resolvedCalls).toEqual([["a1", "cancelled"]]);
});
it("工地跳过优先于终端还没来的答案：终端先答就按终端", async () => {
  const site = fakeSite({ skip: true, afterMs: 100 }); const ui = fakeUi({ select: resolveAfter("A", 5) });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "A", source: "terminal" });
  expect(site.resolvedCalls).toEqual([["a1", "terminal"]]);
});
it("工具被中止：两边都取消，工地收到 cancelled", async () => {
  const ac = new AbortController(); const site = fakeSite({ answer: "B", afterMs: 500 }); const ui = fakeUi({ select: never() });
  const p = runAsk(req, { site, ui, signal: ac.signal }); ac.abort();
  await expect(p).rejects.toThrow();
  expect(site.resolvedCalls).toEqual([["a1", "cancelled"]]);
  expect(site.lastSignal?.aborted).toBe(true);
  expect(ui.lastSignal?.aborted).toBe(true);
});

// 以下是补充的测试：逐字文案、参数先于一切校验、终端对话框的内容、没有答案的各种写法、一边出错、收尾不留动作和监听器。
it("三条逐字文案不被改动（规格要求原文）", () => {
  expect(OFFLINE_NOTE).toBe("设计师离线，请在对话里提问");
  expect(OTHER_LABEL).toBe("其他…");
  expect(BAD_ARGS).toBe("ask_designer 需要至少一个选项，或允许其他输入");
});
it("参数错误在任何一边开始之前就报：工地没收到提问，也没有 resolved", async () => {
  const site = fakeSite({ answer: "B", afterMs: 10 }); const ui = fakeUi();
  await expect(runAsk({ ...req, options: [], allowOther: false }, { site, ui })).rejects.toThrow(BAD_ARGS);
  expect(site.asked).toEqual([]);
  expect(site.resolvedCalls).toEqual([]);
  expect(ui.selects).toEqual([]);
});
it("允许其他输入：选项末尾追加其他…，标题是问题；工地收到原样的提问", async () => {
  const ui = fakeUi({ select: resolveAfter("A", 1) }); const site = fakeSite({ answer: "B", afterMs: 500 });
  await runAsk(req, { site, ui });
  expect(ui.selects).toEqual([{ title: "选哪个？", options: ["A", "B", OTHER_LABEL] }]);
  expect(site.asked).toEqual([req]);
});
it("不允许其他输入：选项原样，不追加其他…", async () => {
  const ui = fakeUi({ select: resolveAfter("B", 1) });
  const outcome = await runAsk({ ...req, allowOther: false }, { site: null, ui });
  expect(outcome).toEqual({ answer: "B", source: "terminal" });
  expect(ui.selects).toEqual([{ title: "选哪个？", options: ["A", "B"] }]);
  expect(ui.inputs).toEqual([]);
});
it("带背景：背景作为终端对话框标题的第二行", async () => {
  const ui = fakeUi({ select: resolveAfter("A", 1) });
  await runAsk({ ...req, context: "两个方案都能过测试" }, { site: null, ui });
  expect(ui.selects[0]?.title).toBe("选哪个？\n两个方案都能过测试");
});
it("没有选项但允许其他输入：不弹选择框，直接弹输入框", async () => {
  const ui = fakeUi({ input: resolveAfter("先做 spike", 1) });
  const outcome = await runAsk({ ...req, options: [] }, { site: null, ui });
  expect(outcome).toEqual({ answer: "先做 spike", source: "terminal" });
  expect(ui.selects).toEqual([]);
  expect(ui.inputs).toEqual([{ title: "选哪个？" }]);
});
it("不允许其他输入时，模型自己的选项恰好叫其他…：当普通选项，不弹输入框", async () => {
  const ui = fakeUi({ select: resolveAfter(OTHER_LABEL, 1) });
  const outcome = await runAsk({ ...req, options: ["A", OTHER_LABEL], allowOther: false }, { site: null, ui });
  expect(outcome).toEqual({ answer: OTHER_LABEL, source: "terminal" });
  expect(ui.inputs).toEqual([]);
});
it("终端对话框被用户取消、工地还在：继续等工地", async () => {
  const ui = fakeUi({ select: dismissed }); const site = fakeSite({ answer: "B", afterMs: 30 });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "B", source: "site" });
  expect(site.resolvedCalls).toEqual([["a1", "site"]]);
  expect(ui.inputs).toEqual([]); // 取消就是取消，不会接着弹输入框
});
it("两边都结束而没有答案：回离线说明，并告诉工地 offline", async () => {
  const ui = fakeUi({ select: dismissed }); const site = fakeSite({ afterMs: 10 });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: null, note: OFFLINE_NOTE });
  expect(site.resolvedCalls).toEqual([["a1", "offline"]]);
});
it("只有终端、用户在选择框里取消：回离线说明", async () => {
  const ui = fakeUi({ select: dismissed });
  expect(await runAsk(req, { site: null, ui })).toEqual({ answer: null, note: OFFLINE_NOTE });
});
it("空字符串不算答案：两边都只给空串，回离线说明", async () => {
  const ui = fakeUi({ select: resolveAfter(OTHER_LABEL, 1), input: resolveAfter("", 1) });
  const site = fakeSite({ answer: "", afterMs: 5 });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: null, note: OFFLINE_NOTE });
  expect(site.resolvedCalls).toEqual([["a1", "offline"]]);
});
it("终端对话框出错当作没有答案：工地照常回答", async () => {
  const ui = fakeUi({ select: () => Promise.reject(new Error("对话框坏了")) }); const site = fakeSite({ answer: "B", afterMs: 20 });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "B", source: "site" });
});
it("工地提问出错当作没有答案：终端照常回答", async () => {
  const ui = fakeUi({ select: resolveAfter("A", 20) });
  const site = { ...fakeSite({ answer: "B", afterMs: 1 }), ask: () => Promise.reject(new Error("连接坏了")) };
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "A", source: "terminal" });
});
it("输掉的一边在被取消时抛错，也不外泄：结果仍是赢家的答案", async () => {
  const rejectsOnCancel: UiStep = (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("取消时出错"))));
  const ui = fakeUi({ select: rejectsOnCancel }); const site = fakeSite({ answer: "B", afterMs: 5 });
  expect(await runAsk(req, { site, ui })).toEqual({ answer: "B", source: "site" });
  await sleep(20); // 给未处理的拒绝留出冒出来的时间：它会让整个测试运行失败
});
it("通知工地时出错不影响结果", async () => {
  const site = { ...fakeSite({ answer: "B", afterMs: 5 }), resolved: () => { throw new Error("连接断了"); } };
  expect(await runAsk(req, { site, ui: null })).toEqual({ answer: "B", source: "site" });
});
it("决出胜负后不再有别的动作：被取消的一边兑现的空结果不会被当成离线", async () => {
  const termWins = fakeSite({ answer: "B", afterMs: 500 });
  await runAsk(req, { site: termWins, ui: fakeUi({ select: resolveAfter("A", 5) }) });
  const siteWins = fakeSite({ answer: "B", afterMs: 5 });
  await runAsk(req, { site: siteWins, ui: fakeUi({ select: never() }) });
  await sleep(30);
  expect(termWins.resolvedCalls).toEqual([["a1", "terminal"]]);
  expect(siteWins.resolvedCalls).toEqual([["a1", "site"]]);
});
it("signal 在调用时已经中止：马上抛出，两边都不启动", async () => {
  const ac = new AbortController(); ac.abort();
  const site = fakeSite({ answer: "B", afterMs: 10 }); const ui = fakeUi();
  await expect(runAsk(req, { site, ui, signal: ac.signal })).rejects.toThrow();
  expect(site.asked).toEqual([]);
  expect(site.resolvedCalls).toEqual([]);
  expect(ui.selects).toEqual([]);
});
it("收尾后外部 signal 上没有残留的监听器：有人答、没人答、被中止三种都一样", async () => {
  const answered = new AbortController();
  const p1 = runAsk(req, { site: fakeSite({ answer: "B", afterMs: 5 }), ui: null, signal: answered.signal });
  expect(abortListeners(answered.signal)).toBe(1);
  await p1;
  expect(abortListeners(answered.signal)).toBe(0);

  const nobody = new AbortController();
  await runAsk(req, { site: null, ui: null, signal: nobody.signal });
  expect(abortListeners(nobody.signal)).toBe(0);

  const aborted = new AbortController();
  const p3 = runAsk(req, { site: fakeSite({ answer: "B", afterMs: 500 }), ui: fakeUi(), signal: aborted.signal });
  aborted.abort();
  await expect(p3).rejects.toThrow();
  expect(abortListeners(aborted.signal)).toBe(0);
});
