import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { installControl } from "../../src/bridge/control";
import type { Control } from "../../src/bridge/control";
import { SUGGEST_PREFIX } from "../../src/bridge/gate";
import type { PauseGate } from "../../src/bridge/gate";
import { callTool, say, startFauxSession } from "../harness/pi-faux";
import { mkTmpDir, sleep, waitFor } from "../harness/wait";

let control!: Control;
/** 真实桥接只在会话属于被监视的仓库时才 activate；这里每个会话都是"被监视"的 */
const activateWith = (make: (pi: ExtensionAPI) => Control) => (pi: ExtensionAPI) => {
  const made = make(pi);
  pi.on("session_start", (_event: unknown, ctx: Parameters<Control["activate"]>[0]) => made.activate(ctx));
};
const ext = activateWith((pi) => (control = installControl(pi)));

it("暂停挂起下一次工具调用，继续后执行", async () => {
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext] });
  s.setResponses([callTool("probe", { n: 1 }), callTool("probe", { n: 2 }), say("done")]);
  control.pause();
  const run = s.session.prompt("go");
  await waitFor(() => control.gate.holding?.tool === "probe");
  expect(s.probeStarted).toEqual([]);
  control.resume();
  await run;
  expect(s.probeCalls).toEqual([1, 2]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("正在执行的工具照常做完，挂起的是下一次", async () => {
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext], probeDelayMs: 300 });
  s.setResponses([callTool("probe", { n: 1 }), callTool("probe", { n: 2 }), say("done")]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  control.pause();
  await waitFor(() => control.gate.holding !== undefined);
  expect(s.probeCalls).toEqual([1]);
  control.resume(); await run;
  expect(s.probeCalls).toEqual([1, 2]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("挂起中给建议：调用被拦下，模型下一次看到建议原文", async () => {
  let seen = false;
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext] });
  s.setResponses([callTool("probe", { n: 1 }),
    (ctx) => { seen = JSON.stringify(ctx.messages).includes(SUGGEST_PREFIX + "改走方案 B"); return say("ack"); }]);
  control.pause();
  const run = s.session.prompt("go");
  await waitFor(() => control.gate.holding !== undefined);
  expect(control.suggest("改走方案 B", "steer")).toBe("blocked-held");
  await run;
  expect(s.probeCalls).toEqual([]);
  expect(seen).toBe(true);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("闸门内部出错时放行，不拦工具", async () => {
  const reported: unknown[] = [];
  const broken = { check() { throw new Error("boom"); } } as unknown as PauseGate;
  const s = await startFauxSession({ cwd: mkTmpDir(),
    extensions: [activateWith((pi) => installControl(pi, { gate: broken, onError: (e) => reported.push(e) }))] });
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  expect(s.probeCalls).toEqual([1]);          // 工具照常执行
  expect(s.handlerErrors).toEqual([]);        // 异常是被 safe 兜住的，而不是漏给 pi 再被它上报
  expect(reported).toEqual([new Error("boom")]); // 兜住的错误交给了 onError
  s.dispose();
});

// 以下是补充的测试：pi 一侧中断时（无论有没有挂起的调用）要解除暂停、ctx 过期后公开方法不抛出、onInject 的调用时机与容错。
it("挂起期间会话被 pi 一侧中断（比如在终端按 Esc）：挂起的调用兑现，会话回到空闲，闸门解除暂停", async () => {
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext] });
  s.setResponses([callTool("probe", { n: 1 }), say("never")]);
  control.pause();
  const run = s.session.prompt("go");
  await waitFor(() => control.gate.holding !== undefined);
  const aborted = s.session.abort();
  await expect(Promise.race([run.then(() => "settled", () => "settled"), sleep(2000).then(() => "hung")])).resolves.toBe("settled");
  await aborted;
  expect(s.session.isStreaming).toBe(false);
  expect(s.probeStarted).toEqual([]);
  expect(control.gate.paused).toBe(false);
  expect(control.gate.holding).toBeUndefined();
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("没有挂起任何调用时，pi 一侧的中断也解除暂停：下一次提问的第一个工具调用不会卡住", async () => {
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext], probeDelayMs: 5000 });
  s.setResponses([callTool("probe", { n: 1 }), say("never")]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  control.pause();                                  // probe 正在执行，没有挂起任何调用
  expect(control.gate.holding).toBeUndefined();
  await s.session.abort();
  await run.catch(() => undefined);

  s.setResponses([callTool("probe", { n: 2 }), say("done")]); // 顺带替换掉上一轮没用上的 "never"
  const next = s.session.prompt("again");
  await waitFor(() => s.probeStarted.length === 2 || control.gate.holding !== undefined, 2000);
  expect(control.gate.holding).toBeUndefined();     // 没有任何 resume，第一个工具调用也没被挂起
  expect(s.probeStarted).toEqual([1, 2]);
  expect(control.gate.paused).toBe(false);
  await s.session.abort();                          // probe 要跑 5 秒，不等它
  await next.catch(() => undefined);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("会话已释放（ctx 过期）后，公开方法不抛出，错误交给 onError", async () => {
  const reported: unknown[] = [];
  let c!: Control;
  const s = await startFauxSession({ cwd: mkTmpDir(),
    extensions: [activateWith((pi) => (c = installControl(pi, { onError: (e) => reported.push(e) })))] });
  s.dispose();
  expect(c.suggest("x", "steer")).toBe("failed"); // 没能交给 pi：返回 failed，而不是抛出
  expect(() => c.abort()).not.toThrow();
  expect(reported).toHaveLength(2);
});
it("onInject 自己出错不耽误建议送达，错误交给 onError", async () => {
  const reported: unknown[] = [];
  let c!: Control;
  const s = await startFauxSession({ cwd: mkTmpDir(),
    extensions: [activateWith((pi) => (c = installControl(pi, { onInject: () => { throw new Error("tracker failed"); }, onError: (e) => reported.push(e) })))] });
  s.setResponses([say("first"), say("second")]);
  await s.session.prompt("go");
  expect(c.suggest("再看一眼", "steer")).toBe("started-turn");
  await waitFor(() => s.session.getLastAssistantText() === "second");
  expect(reported).toEqual([new Error("tracker failed")]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("onInject：经 sendUserMessage 送出建议前调用；被挂起的调用带走的建议不算注入", async () => {
  const injected: string[] = [];
  let c!: Control;
  const s = await startFauxSession({ cwd: mkTmpDir(),
    extensions: [activateWith((pi) => (c = installControl(pi, { onInject: (t) => injected.push(t) })))] });
  s.setResponses([callTool("probe", { n: 1 }), say("first"), say("second")]);
  c.pause();
  const run = s.session.prompt("go");
  await waitFor(() => c.gate.holding !== undefined);
  expect(c.suggest("先改方案", "steer")).toBe("blocked-held");
  await run;
  expect(injected).toEqual([]);
  expect(c.suggest("再看一眼", "steer")).toBe("started-turn");
  expect(injected).toEqual(["再看一眼"]);
  await waitFor(() => s.session.getLastAssistantText() === "second");
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
