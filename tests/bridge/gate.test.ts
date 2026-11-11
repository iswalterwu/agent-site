import { expect, it } from "vitest";
import { ABORT_REASON, PauseGate, SUGGEST_PREFIX } from "../../src/bridge/gate";

it("未暂停时同步放行", () => {
  const g = new PauseGate();
  const d = g.check("probe");
  expect(d).toEqual({ kind: "allow" });
  expect(d instanceof Promise).toBe(false);
});
it("暂停后挂起，继续后放行同一轮的全部调用", async () => {
  const g = new PauseGate({ now: () => 1000 });
  g.pause();
  const a = g.check("read"), b = g.check("bash");
  expect(g.holding).toEqual({ tool: "read", sinceMs: 1000 });
  g.resume();
  expect(await a).toEqual({ kind: "allow" });
  expect(await b).toEqual({ kind: "allow" });
  expect(g.paused).toBe(false);
});
it("挂起中给建议：全部拦下，理由带建议原文", async () => {
  const g = new PauseGate(); g.pause();
  const a = g.check("edit"), b = g.check("bash");
  expect(g.suggest("先补测试")).toBe(true);
  const reason = SUGGEST_PREFIX + "先补测试";
  expect(await a).toEqual({ kind: "block", reason });
  expect(await b).toEqual({ kind: "block", reason });
  expect(g.paused).toBe(false);
});
it("暂停但没挂起时给建议：返回 false 并解除暂停", () => {
  const g = new PauseGate(); g.pause();
  expect(g.suggest("x")).toBe(false);
  expect(g.paused).toBe(false);
});
it("中断与断线放行", async () => {
  const g = new PauseGate(); g.pause();
  const a = g.check("edit"); g.abort();
  expect(await a).toEqual({ kind: "block", reason: ABORT_REASON });
  g.pause(); const b = g.check("edit"); g.releaseAll();
  expect(await b).toEqual({ kind: "allow" });
});
it("中断可以带别的理由：挂起的调用全部以这个理由拦下，并解除暂停", async () => {
  const g = new PauseGate(); g.pause();
  const a = g.check("edit"), b = g.check("bash");
  g.abort("会话收尾了");
  expect(await a).toEqual({ kind: "block", reason: "会话收尾了" });
  expect(await b).toEqual({ kind: "block", reason: "会话收尾了" });
  expect(g.paused).toBe(false);
  expect(g.holding).toBeUndefined();
});
it("状态变化会通知", () => {
  const g = new PauseGate(); let n = 0; g.onChange(() => n++);
  g.pause(); void g.check("x"); g.resume();
  expect(n).toBeGreaterThanOrEqual(3);
});

// 以下是补充的测试，钉住 brief 没写明、但 controller 澄清要求的行为。
it("holding 是最早被挂起的那次，sinceMs 取它挂起时的时间", () => {
  let t = 1000;
  const g = new PauseGate({ now: () => t });
  g.pause();
  void g.check("read");
  t = 2000;
  void g.check("bash");
  expect(g.holding).toEqual({ tool: "read", sinceMs: 1000 });
  g.releaseAll();
});
it("监听器抛错不影响闸门，其余监听器照常收到通知", async () => {
  const g = new PauseGate();
  let n = 0;
  g.onChange(() => { throw new Error("listener failed"); });
  g.onChange(() => n++);
  g.pause();
  const a = g.check("edit");
  expect(g.holding?.tool).toBe("edit");
  g.resume();
  expect(await a).toEqual({ kind: "allow" });
  expect(n).toBe(3);
});
it("取消订阅后不再收到通知", () => {
  const g = new PauseGate();
  let n = 0;
  const off = g.onChange(() => n++);
  g.pause();
  expect(n).toBe(1);
  off();
  g.resume();
  expect(n).toBe(1);
});
it("同一个函数订阅两次，各自取消互不影响", () => {
  const g = new PauseGate();
  let n = 0;
  const listener = () => n++;
  const offFirst = g.onChange(listener);
  g.onChange(listener);
  offFirst();
  g.pause();
  expect(n).toBe(1);
});
it("没有变化时不通知", () => {
  const g = new PauseGate();
  let n = 0;
  g.onChange(() => n++);
  g.resume(); g.abort(); g.releaseAll();
  expect(g.suggest("x")).toBe(false);
  expect(n).toBe(0);
  g.pause(); g.pause();
  expect(n).toBe(1);
});
it("settle 之后：未暂停、没有挂起，下一轮从干净状态开始", async () => {
  for (const settle of [(g: PauseGate) => g.resume(), (g: PauseGate) => g.suggest("x"),
                        (g: PauseGate) => g.abort(), (g: PauseGate) => g.releaseAll()]) {
    const g = new PauseGate(); g.pause();
    const held = g.check("edit"); settle(g); await held;
    expect(g.paused).toBe(false);
    expect(g.holding).toBeUndefined();
    g.pause();
    expect(g.suggest("y")).toBe(false);
  }
});
