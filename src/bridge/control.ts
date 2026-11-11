// 把暂停闸门接到 pi 的 tool_call 上，并提供桌面应用发来的四种控制：暂停、继续、建议、中断。
// pi 对抛错的 tool_call 处理函数的做法是拦下这次工具调用，所以这里的处理函数和公开方法一律不抛出。

import type { AgentSettledEvent, ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { PauseGate } from "./gate";
import type { GateDecision } from "./gate";
import { safe } from "./safe";

/**
 * suggest 的结果。"steered" / "followed-up" / "started-turn" 只表示建议已交给 pi，不保证已送达：
 * pi 事后才拒收的（比如正在压缩上下文）不会改变返回值，只会走 pi 的错误通道。
 * "failed" 表示连交给 pi 这一步都失败了（比如会话已关闭、ctx 过期），错误已交给 onError。
 */
export type SuggestResult = "blocked-held" | "steered" | "followed-up" | "started-turn" | "failed";

export interface Control {
  readonly gate: PauseGate;
  /** 会话属于被监视的仓库时装上这些处理函数（重复调用只有第一次生效）；不属于的会话里桥接不该让每次工具调用都过一道 */
  activate(ctx: ExtensionContext): void;
  /** 摘掉它们：会话结束、或会话被移出被监视的范围 */
  deactivate(): void;
  pause(): void;
  resume(): void;
  abort(): void;
  suggest(text: string, mode: "steer" | "followUp"): SuggestResult;
}

/** 闸门的决定 → pi 的 tool_call 返回值：放行返回 undefined，拦下返回 { block, reason } */
function toResult(decision: GateDecision): ToolCallEventResult | undefined {
  return decision.kind === "allow" ? undefined : { block: true, reason: decision.reason };
}

export function installControl(pi: ExtensionAPI, opts?: {
  gate?: PauseGate;
  onInject?: (text: string) => void; // 每次经 sendUserMessage 送出建议前调用（供事件上报区分来源）
  onError?: (e: unknown) => void;
}): Control {
  const gate = opts?.gate ?? new PauseGate();
  const onError = opts?.onError;
  const markInjected = safe((text: string) => opts?.onInject?.(text), undefined, onError); // 上报出错不能耽误建议送达

  // 信号触发时执行 action（信号已经触发过则立刻执行）；返回取消监听的函数。
  // 每次订阅用各自的监听器：EventTarget 会给同一个函数去重，共用的话，先取消的会连带拆掉后来者的。
  // 监听器里抛出的异常会变成进程级的未捕获异常，所以也要兜住
  const whenAborted = (signal: AbortSignal, action: () => void): (() => void) => {
    const onAbort = safe(action, undefined, onError);
    if (signal.aborted) {
      onAbort();
      return () => {};
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  };

  // 应用的指令不在 pi 的事件回调里到达，要靠记下的 ctx 才能问空闲与否、下令中断
  let ctx: ExtensionContext | undefined;
  // 每次 activate 装上、deactivate 摘掉：pi.on 返回的就是退订函数
  let subscriptions: (() => void)[] = [];

  // 这一轮被中断时（比如用户在 pi 终端按 Esc），即使没有挂起任何调用也要解除暂停，
  // 否则下一次提问的第一个工具调用就会卡住。每轮开始时换掉上一轮的监听，不跨轮累积
  let stopWatchingRun: (() => void) | undefined;
  const onAgentStart = safe((_event: unknown, c: ExtensionContext) => {
    ctx = c;
    stopWatchingRun?.();
    const signal = c.signal;
    stopWatchingRun = signal === undefined ? undefined : whenAborted(signal, () => gate.abort());
  }, undefined, onError);

  // 两次运行之间被中断（比如重试等待、运行后压缩期间按 Esc）时没有运行信号可监听，上面的订阅赶不上；
  // pi 在收尾时用 agent_settled 报告这次是不是被中断收尾的，据此同样解除暂停，免得下一次提问的第一个工具调用卡住
  const onAgentSettled = safe((event: AgentSettledEvent) => {
    if (event.aborted) gate.abort();
  }, undefined, onError);

  // pi 不会因为中断而放弃一个还没返回的 tool_call 处理函数，所以被挂起的调用除了等闸门兑现，
  // 也要自己盯着这一轮的信号，中断时一并兑现，否则会话会一直等在这里。
  // 上面按轮订阅已经覆盖了正常情况，这里是兜底（比如这一轮的 agent_start 没被这个扩展实例赶上）
  const releaseOnAbort = (held: Promise<GateDecision>, signal: AbortSignal | undefined): Promise<GateDecision> => {
    if (signal === undefined) return held;
    const stopWatching = whenAborted(signal, () => gate.abort());
    return held.finally(stopWatching);
  };

  // 不能写成 async：未暂停时必须同步返回，只有被挂起的调用才返回 Promise
  const onToolCall = safe((event: ToolCallEvent, c: ExtensionContext) => {
    ctx = c;
    const decision = gate.check(event.toolName);
    return decision instanceof Promise ? releaseOnAbort(decision, c.signal).then(toResult) : toResult(decision);
  }, undefined, onError);

  const suggest = safe((text: string, mode: "steer" | "followUp"): SuggestResult => {
    const wasPaused = gate.paused;
    if (gate.suggest(text)) return "blocked-held";
    const idle = ctx === undefined || ctx.isIdle();
    markInjected(text);
    if (idle) {
      pi.sendUserMessage(text);
      return "started-turn";
    }
    // 暂停了但还没挂起任何调用：应用想马上插话，不等本轮结束
    const deliverAs = wasPaused ? "steer" : mode;
    pi.sendUserMessage(text, { deliverAs });
    return deliverAs === "steer" ? "steered" : "followed-up";
  }, "failed", onError) as Control["suggest"]; // safe 对同步函数返回的仍是同步值，只是声明类型为兼顾 Promise 写得宽

  return {
    gate,
    activate: safe((context: ExtensionContext) => {
      ctx = context;
      if (subscriptions.length > 0) return; // 出范围又回来：处理函数还挂着，只换 ctx
      subscriptions = [
        pi.on("session_start", (_event, c) => { ctx = c; }),
        pi.on("agent_start", onAgentStart),
        pi.on("agent_settled", onAgentSettled),
        pi.on("tool_call", onToolCall),
      ];
    }, undefined, onError),
    deactivate: safe(() => {
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions = [];
      stopWatchingRun?.();
      stopWatchingRun = undefined;
      ctx = undefined;
    }, undefined, onError),
    pause: safe(() => gate.pause(), undefined, onError),
    resume: safe(() => gate.resume(), undefined, onError),
    abort: safe(() => { gate.abort(); ctx?.abort(); }, undefined, onError),
    suggest,
  };
}
