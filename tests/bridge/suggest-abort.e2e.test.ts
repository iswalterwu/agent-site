import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { installControl } from "../../src/bridge/control";
import type { Control } from "../../src/bridge/control";
import { callTool, say, startFauxSession } from "../harness/pi-faux";
import { mkTmpDir, sleep, waitFor } from "../harness/wait";

let control!: Control;
// 真实桥接只在会话属于被监视的仓库时才 activate；这里每个会话都是"被监视"的
const ext = (pi: ExtensionAPI) => {
  control = installControl(pi);
  pi.on("session_start", (_event: unknown, ctx: Parameters<Control["activate"]>[0]) => control.activate(ctx));
};

/** 2 秒内没落定就返回 "hung"：回归时快速失败，而不是干等到测试超时 */
const settling = (pending: Promise<unknown>) =>
  Promise.race([pending.then(() => "settled", () => "settled"), sleep(2000).then(() => "hung")]);

const LONG = "插话：先跑全量测试。\n第二行带\"引号\"。" + "很长的说明".repeat(60); // > 200 字

it("运行中插话：下一次请求模型之前送达，原文不截断", async () => {
  let seen = "";
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext], probeDelayMs: 300 });
  s.setResponses([callTool("probe", { n: 1 }), (ctx) => { seen = JSON.stringify(ctx.messages); return say("done"); }]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  expect(control.suggest(LONG, "steer")).toBe("steered");
  await run;
  expect(seen).toContain(JSON.stringify(LONG).slice(1, -1));
  expect(s.probeCalls).toEqual([1]); // 正在执行的工具照常做完，插话不打断它
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("做完再说：本轮结束后作为新一轮送达", async () => {
  const turns: string[] = [];
  let seenEarly: boolean | undefined;
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext], probeDelayMs: 200 });
  s.setResponses([callTool("probe", { n: 1 }),
    (ctx) => { seenEarly = JSON.stringify(ctx.messages).includes("然后补文档"); return say("first done"); },
    (ctx) => { turns.push(JSON.stringify(ctx.messages)); return say("second done"); }]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  expect(control.suggest("然后补文档", "followUp")).toBe("followed-up");
  await run; await s.session.waitForIdle();
  expect(seenEarly).toBe(false);                 // 本轮还没做完时，模型看不到它
  expect(turns).toHaveLength(1);
  expect(turns[0]).toContain("然后补文档");
  expect(s.session.getLastAssistantText()).toBe("second done");
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("暂停了但还没挂起时给建议：强制插话送达，并解除暂停", async () => {
  let seen = false;
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext], probeDelayMs: 300 });
  s.setResponses([callTool("probe", { n: 1 }), (ctx) => { seen = JSON.stringify(ctx.messages).includes("换个思路"); return say("done"); }]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  control.pause();                        // 正在执行 probe，没有挂起任何调用
  expect(control.suggest("换个思路", "followUp")).toBe("steered");
  expect(control.gate.paused).toBe(false);
  await run;
  expect(seen).toBe(true);
  expect(s.probeCalls).toEqual([1]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("空闲时给建议：开始新一轮", async () => {
  let seen = "";
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext] });
  s.setResponses([say("first"), (ctx) => { seen = JSON.stringify(ctx.messages); return say("second"); }]);
  await s.session.prompt("go");
  expect(control.suggest("再看一眼", "steer")).toBe("started-turn");
  await waitFor(() => s.session.getLastAssistantText() === "second");
  await s.session.waitForIdle();
  expect(seen).toContain("再看一眼");
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});

it("挂起中立即中断：调用被拦下，会话回到空闲，不悬空", async () => {
  let asked = false;                      // 中断之后不该再请求模型
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext] });
  s.setResponses([callTool("probe", { n: 1 }), () => { asked = true; return say("never"); }]);
  control.pause();
  const run = s.session.prompt("go");
  await waitFor(() => control.gate.holding !== undefined);
  control.abort();
  await expect(settling(run)).resolves.toBe("settled");
  expect(s.probeCalls).toEqual([]);
  expect(s.probeStarted).toEqual([]);
  expect(control.gate.paused).toBe(false);
  expect(control.gate.holding).toBeUndefined();
  expect(s.session.isIdle).toBe(true);
  expect(asked).toBe(false);              // 这一轮被中断了，而不是只拦下一个调用就让模型接着往下答
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
it("长工具执行中立即中断：1 秒内回到空闲", async () => {
  let asked = false;
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext], probeDelayMs: 5000 });
  s.setResponses([callTool("probe", { n: 1 }), () => { asked = true; return say("never"); }]);
  const run = s.session.prompt("go");
  await waitFor(() => s.probeStarted.length === 1);
  const t0 = Date.now(); control.abort();
  await run.catch(() => undefined);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(s.probeCalls).toEqual([]);
  expect(s.session.isIdle).toBe(true);
  expect(asked).toBe(false);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});

// R22：会话空闲时没有运行信号可监听，解除暂停只能靠 Control.abort 自己调用 gate.abort()
it("空闲时已暂停，立即中断：解除暂停，下一次提问的第一个工具调用不会卡住", async () => {
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext] });
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  control.pause();                        // 会话空闲：没有运行中的轮次，也没有挂起的调用
  expect(control.gate.paused).toBe(true);
  control.abort();
  expect(control.gate.paused).toBe(false);
  await expect(settling(s.session.prompt("go"))).resolves.toBe("settled");
  expect(s.probeCalls).toEqual([1]);
  expect(s.session.getLastAssistantText()).toBe("done");
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});

// R21：两次运行之间（比如重试等待期间）按 Esc，没有运行信号可监听，只能靠 agent_settled 报告的 aborted
it("重试等待期间被中断（比如按 Esc）：没有挂起任何调用，暂停也被解除", async () => {
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [ext] });
  s.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" })]);
  const run = s.session.prompt("go");
  await waitFor(() => s.session.isRetrying);      // 可重试的错误：pi 先等一会儿再重试
  expect(s.session.agent.signal).toBeUndefined(); // 此时没有任何一轮在运行，ctx.signal 没有可监听的东西
  control.pause();
  expect(control.gate.holding).toBeUndefined();
  await s.session.abort();
  await expect(settling(run)).resolves.toBe("settled");
  expect(control.gate.paused).toBe(false);

  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await expect(settling(s.session.prompt("again"))).resolves.toBe("settled"); // 没有 resume，第一个工具调用也不会卡住
  expect(s.probeCalls).toEqual([1]);
  expect(s.handlerErrors).toEqual([]);
  s.dispose();
});
