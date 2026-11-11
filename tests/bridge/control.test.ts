import { getEventListeners } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { installControl } from "../../src/bridge/control";
import { ABORT_REASON, SUGGEST_PREFIX } from "../../src/bridge/gate";
import type { PauseGate } from "../../src/bridge/gate";
import { sleep } from "../harness/wait";

type Handler = (event: unknown, ctx: unknown) => unknown;

/**
 * 只替换 pi 这一层边界：记下扩展注册的事件处理函数，供测试直接触发并观察返回值（同步还是 Promise），
 * 并让 sendUserMessage 可以按需抛错。Control 和 PauseGate 都是真实实现（需要时可换成自己的闸门）；
 * 真实 pi 里的行为见 control.e2e.test.ts。
 */
function install(opts: { sendUserMessage?: () => void; onError?: (e: unknown) => void; gate?: PauseGate } = {}) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => {};
    },
    sendUserMessage: opts.sendUserMessage ?? (() => {}),
  } as unknown as ExtensionAPI;
  const control = installControl(pi, { gate: opts.gate, onError: opts.onError });
  // 真实调用方只在会话属于被监视的仓库时才装这些处理函数；空闲判断由测试里的 agentStart 覆盖
  control.activate({ isIdle: () => true } as unknown as ExtensionContext);
  const fire = (name: string, event: object, c: Partial<ExtensionContext>) => handlers.get(name)?.({ type: name, ...event }, c);
  return {
    control,
    /** 摘掉之后再触发，什么都不会发生 */
    deactivate: () => control.deactivate(),
    subscribed: () => [...handlers.keys()].sort(),
    toolCall: (ctx: Partial<ExtensionContext>) => fire("tool_call", { toolName: "probe", toolCallId: "t1", input: {} }, ctx),
    agentStart: (ctx: Partial<ExtensionContext>) => fire("agent_start", {}, ctx),
    agentSettled: (aborted: boolean) => fire("agent_settled", { aborted }, {}),
  };
}

/** 500ms 内没兑现就返回 "hung"：靠中断才能兑现的测试在回归时快速失败，不干等到测试超时 */
const within = (settling: unknown) => Promise.race([settling, sleep(500).then(() => "hung")]);

it("没激活时一个处理函数都不挂；deactivate 全部摘掉，再触发也没有反应", () => {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
  const control = installControl(pi);
  expect([...handlers.keys()]).toEqual([]);
  control.activate({} as ExtensionContext);
  expect([...handlers.keys()].sort()).toEqual(["agent_settled", "agent_start", "session_start", "tool_call"]);
  control.pause();
  control.deactivate();
  expect([...handlers.keys()]).toEqual([]);
  expect(control.gate.paused).toBe(true); // 闸门状态不归 activate 管
  control.resume();
});
it("重复 activate 只装一次；deactivate 也把按轮的中断监听清掉，再 activate 能重新响应", () => {
  const handlers = new Map<string, Handler>();
  const subscribes: string[] = []; // 每次 pi.on 都记一笔：重复 activate 会让处理函数注册两遍
  const pi = { on: (name: string, handler: Handler) => { subscribes.push(name); handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
  const control = installControl(pi);
  control.activate({} as ExtensionContext);
  const first = handlers.get("tool_call");
  control.activate({} as ExtensionContext); // 出范围又回来：复用同一批处理函数
  expect(handlers.get("tool_call")).toBe(first);
  expect(subscribes).toEqual(["session_start", "agent_start", "agent_settled", "tool_call"]); // 没有第二遍
  expect([...handlers.keys()].sort()).toEqual(["agent_settled", "agent_start", "session_start", "tool_call"]);

  // 按轮的中断监听挂在 activate 之后的 agent_start 上：deactivate 要一并清掉，否则下一轮的中断会把闸门解开
  const controller = new AbortController();
  control.activate({} as ExtensionContext);
  (handlers.get("agent_start") as Handler)({ type: "agent_start" }, { signal: controller.signal });
  control.pause();
  control.deactivate();
  controller.abort();
  expect(control.gate.paused).toBe(true); // 监听已经摘掉，中断不再解暂停
  control.resume();
  control.activate({} as ExtensionContext);
  expect([...handlers.keys()].sort()).toEqual(["agent_settled", "agent_start", "session_start", "tool_call"]);
  control.deactivate();
  expect([...handlers.keys()]).toEqual([]);
});
it("未暂停时 tool_call 处理函数同步放行：返回 undefined，不是 Promise", () => {
  const { toolCall } = install();
  expect(toolCall({})).toBeUndefined();
});
it("暂停时返回 Promise，继续后兑现为放行", async () => {
  const { control, toolCall } = install();
  control.pause();
  const result = toolCall({});
  expect(result).toBeInstanceOf(Promise);
  control.resume();
  await expect(result).resolves.toBeUndefined();
});
it("暂停时给建议：兑现为 block，理由带建议原文", async () => {
  const { control, toolCall } = install();
  control.pause();
  const result = toolCall({});
  expect(control.suggest("先补测试", "steer")).toBe("blocked-held");
  await expect(result).resolves.toEqual({ block: true, reason: SUGGEST_PREFIX + "先补测试" });
});

it("中断信号触发：挂起的调用兑现为拦下，闸门解除暂停，监听器已移除", async () => {
  const { control, toolCall } = install();
  const ac = new AbortController();
  control.pause();
  const result = toolCall({ signal: ac.signal });
  expect(getEventListeners(ac.signal, "abort")).toHaveLength(1);
  ac.abort();
  expect(await within(result)).toEqual({ block: true, reason: ABORT_REASON });
  expect(control.gate.paused).toBe(false);
  expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
});
it("正常兑现（继续）后移除中断监听器", async () => {
  const { control, toolCall } = install();
  const ac = new AbortController();
  control.pause();
  const result = toolCall({ signal: ac.signal });
  control.resume();
  await expect(result).resolves.toBeUndefined();
  expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
});
it("信号在挂起时已经是中断状态：立刻兑现为拦下，闸门解除暂停", async () => {
  const { control, toolCall } = install();
  const ac = new AbortController();
  ac.abort();
  control.pause();
  expect(await within(toolCall({ signal: ac.signal }))).toEqual({ block: true, reason: ABORT_REASON });
  expect(control.gate.paused).toBe(false);
});
it("没有中断信号（ctx.signal 为 undefined）：照常挂起，继续后放行", async () => {
  const { control, toolCall } = install();
  control.pause();
  const result = toolCall({ signal: undefined });
  expect(control.gate.holding?.tool).toBe("probe");
  control.resume();
  await expect(result).resolves.toBeUndefined();
});
it("共用一个信号的前后两次挂起：先兑现的清理不会拆掉后来者对中断的响应", async () => {
  const { control, toolCall } = install();
  const ac = new AbortController();
  control.pause();
  const first = toolCall({ signal: ac.signal });
  control.resume(); // first 已兑现，但它移除监听器的清理要等到之后的微任务
  control.pause();
  const second = toolCall({ signal: ac.signal });
  await first;
  ac.abort();
  expect(await within(second)).toEqual({ block: true, reason: ABORT_REASON });
});

// R16：建议交给 pi 这一步失败时，不抛出，返回 "failed"，错误交给 onError
it("建议交给 pi 时 sendUserMessage 抛错：返回 failed，错误交给 onError，不抛出（空闲、运行中两条路径）", () => {
  const reported: unknown[] = [];
  const { control, agentStart } = install({
    sendUserMessage() { throw new Error("pi is gone"); },
    onError: (e) => reported.push(e),
  });
  expect(control.suggest("a", "steer")).toBe("failed");        // 还没有 ctx：走空闲路径
  agentStart({ isIdle: () => false });                          // 记下一个"正在运行"的 ctx
  expect(control.suggest("b", "followUp")).toBe("failed");     // 走 deliverAs 路径
  expect(reported).toEqual([new Error("pi is gone"), new Error("pi is gone")]);
});

// R17：这一轮被中断时，即使没有挂起任何调用，也要解除暂停
it("轮次的中断信号触发：没有挂起任何调用时也解除暂停", () => {
  const { control, agentStart } = install();
  const ac = new AbortController();
  agentStart({ signal: ac.signal });
  control.pause();
  expect(control.gate.holding).toBeUndefined();
  ac.abort();
  expect(control.gate.paused).toBe(false);
});
it("开始阶段就已被中断（agent_start 时信号已触发）：立刻解除暂停", () => {
  const { control, agentStart } = install();
  const ac = new AbortController();
  ac.abort();
  control.pause();
  agentStart({ signal: ac.signal });
  expect(control.gate.paused).toBe(false);
});
it("每个 agent_start 换掉上一轮的监听器，不跨轮累积；没有信号时也不抛出", () => {
  const { control, agentStart } = install();
  const first = new AbortController();
  const second = new AbortController();
  agentStart({ signal: first.signal });
  expect(getEventListeners(first.signal, "abort")).toHaveLength(1);
  agentStart({ signal: second.signal });
  expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
  expect(getEventListeners(second.signal, "abort")).toHaveLength(1);
  agentStart({ signal: undefined });
  expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
  // 上一轮的信号之后再触发，不会误解除新一轮的暂停
  control.pause();
  first.abort();
  expect(control.gate.paused).toBe(true);
});
it("agent_start 处理函数不抛出：读 ctx.signal 出错（ctx 已过期）时错误交给 onError", () => {
  const reported: unknown[] = [];
  const { agentStart } = install({ onError: (e) => reported.push(e) });
  const stale = { get signal(): AbortSignal | undefined { throw new Error("ctx is stale"); } };
  expect(() => agentStart(stale)).not.toThrow();
  expect(reported).toEqual([new Error("ctx is stale")]);
});

// R21：两次运行之间被中断（比如重试等待、运行后压缩期间按 Esc）时没有运行信号可监听，只能看 agent_settled 报告的 aborted
it("agent_settled 报告这次运行是被中断收尾的：没有挂起任何调用时也解除暂停", () => {
  const { control, agentSettled } = install();
  control.pause();
  expect(control.gate.holding).toBeUndefined();
  agentSettled(true);
  expect(control.gate.paused).toBe(false);
});
it("agent_settled 报告是正常收尾的：暂停保持", () => {
  const { control, agentSettled } = install();
  control.pause();
  agentSettled(false);
  expect(control.gate.paused).toBe(true);
});
it("agent_settled 处理函数不抛出：闸门出错时错误交给 onError", () => {
  const reported: unknown[] = [];
  const broken = { abort() { throw new Error("gate is broken"); } } as unknown as PauseGate;
  const { agentSettled } = install({ gate: broken, onError: (e) => reported.push(e) });
  expect(() => agentSettled(true)).not.toThrow();
  expect(reported).toEqual([new Error("gate is broken")]);
});
