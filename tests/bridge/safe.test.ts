import { expect, it } from "vitest";
import { safe } from "../../src/bridge/safe";

it("同步异常变成 fallback，正常值保持同步", () => {
  const f = safe((x: number) => { if (x < 0) throw new Error("boom"); return x; }, -1);
  expect(f(-5)).toBe(-1);
  expect(f(3)).toBe(3);
});
it("异步 reject 变成 fallback 并回报错误", async () => {
  const errors: unknown[] = [];
  const f = safe(async () => { throw new Error("late"); }, "fb", (e) => errors.push(e));
  expect(await f()).toBe("fb");
  expect(errors).toHaveLength(1);
});

// 以下是补充的测试：同步值不被包成 Promise、错误回报的细节、回报回调自己出错。
it("正常的同步返回值不会被包成 Promise", () => {
  const f = safe((x: number) => x + 1, 0);
  expect(f(1)).toBe(2);
  expect(f(1) instanceof Promise).toBe(false);
});
it("同步异常也回报给 onError；参数原样传给被包的函数", () => {
  const errors: unknown[] = [];
  const f = safe((n: number, tag: string) => { if (tag === "bad") throw new Error(`bad ${n}`); return n; }, -1, (e) => errors.push(e));
  expect(f(7, "ok")).toBe(7);
  expect(errors).toEqual([]);
  expect(f(7, "bad")).toBe(-1);
  expect(errors).toEqual([new Error("bad 7")]);
});
it("异步成功时原样返回结果，不回报错误", async () => {
  const errors: unknown[] = [];
  const f = safe(async (x: number) => x * 2, 0, (e) => errors.push(e));
  expect(await f(4)).toBe(8);
  expect(errors).toEqual([]);
});
it("没有 onError 时同步、异步的异常都安静地回落", async () => {
  expect(safe(() => { throw new Error("x"); }, "fb")()).toBe("fb");
  expect(await safe(async () => { throw new Error("x"); }, "fb")()).toBe("fb");
});
it("onError 自己抛错也不会抛出（同步、异步都是）", async () => {
  const onError = () => { throw new Error("reporter failed"); };
  expect(safe(() => { throw new Error("x"); }, "fb", onError)()).toBe("fb");
  expect(await safe(async () => { throw new Error("x"); }, "fb", onError)()).toBe("fb");
});
