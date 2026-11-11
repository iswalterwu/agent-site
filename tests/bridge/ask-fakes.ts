// ask 测试用的假工地和假终端对话框。只在 SiteAsker / AskUi 这两个边界上替换真实实现，回答的时机和内容由测试脚本化。
// 每个"迟早会答"的 Promise 收到 signal 中止时以 undefined / null 兑现，并清掉自己的计时器和监听器，不在测试进程里留尾巴。

import type { AskRequest, AskUi, SiteAsker, SiteAskResult } from "../../src/bridge/ask";

/** signal 中止（含调用时已经中止）→ 以 fallback 兑现；timed 到点 → 以 value 兑现。先到的生效，同时摘掉另一个 */
function settleBy<T, F>(signal: AbortSignal | undefined, fallback: F, timed?: { value: T; ms: number }): Promise<T | F> {
  return new Promise<T | F>((resolve) => {
    if (signal?.aborted) return resolve(fallback);
    const finish = (result: T | F) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(fallback);
    const timer = timed === undefined ? undefined : setTimeout(() => finish(timed.value), timed.ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 终端对话框的一种行为：收到对话框的 signal，返回用户的选择 / 输入（undefined = 取消） */
export type UiStep = (signal: AbortSignal | undefined) => Promise<string | undefined>;

/** 一直不答，直到被 signal 取消 */
export const never = (): UiStep => (signal) => settleBy(signal, undefined);

/** ms 毫秒后答 value；在那之前被取消则以 undefined 兑现 */
export const resolveAfter = (value: string, ms: number): UiStep => (signal) => settleBy(signal, undefined, { value, ms });

export interface FakeUi extends AskUi {
  /** 最近一次弹出的对话框（select 或 input）收到的 signal */
  lastSignal?: AbortSignal;
  selects: { title: string; options: string[] }[];
  inputs: { title: string }[];
}

/** 没给的那一步默认 never()：用户一直没动 */
export function fakeUi(steps: { select?: UiStep; input?: UiStep } = {}): FakeUi {
  const ui: FakeUi = {
    selects: [],
    inputs: [],
    select(title, options, opts) {
      ui.selects.push({ title, options });
      ui.lastSignal = opts?.signal;
      return (steps.select ?? never())(opts?.signal);
    },
    input(title, _placeholder, opts) {
      ui.inputs.push({ title });
      ui.lastSignal = opts?.signal;
      return (steps.input ?? never())(opts?.signal);
    },
  };
  return ui;
}

export interface FakeSite extends SiteAsker {
  /** 收到的提问 */
  asked: AskRequest[];
  /** 最近一次提问收到的 signal */
  lastSignal?: AbortSignal;
  resolvedCalls: [askId: string, by: Parameters<SiteAsker["resolved"]>[1]][];
}

/**
 * afterMs 毫秒后兑现：给 answer 就是答了，给 skip 就是设计师点了取消（明确跳过），都不给就是这一边没有答案（中途离线）。
 * 在那之前被取消则以"没有答案"兑现
 */
export function fakeSite(opts: { answer?: string; skip?: boolean; afterMs: number; online?: boolean }): FakeSite {
  const value: SiteAskResult = opts.skip === true ? { kind: "skip" }
    : opts.answer === undefined ? { kind: "none" }
      : { kind: "answer", text: opts.answer };
  const none: SiteAskResult = { kind: "none" };
  const site: FakeSite = {
    asked: [],
    resolvedCalls: [],
    isOnline: () => opts.online ?? true,
    ask(req, signal) {
      site.asked.push(req);
      site.lastSignal = signal;
      return settleBy(signal, none, { value, ms: opts.afterMs });
    },
    resolved(askId, by) {
      site.resolvedCalls.push([askId, by]);
    },
  };
  return site;
}
