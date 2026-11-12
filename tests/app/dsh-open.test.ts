import { afterEach, expect, it, vi } from "vitest";
import { OpenController } from "../../packages/dsh-plugin/src/open-controller";

afterEach(() => vi.useRealTimers());

it("DIST-6：一次只发一个打开请求，已发送不等于运行中", async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const controller = new OpenController(call);
  const opened = controller.open();
  expect(controller.getSnapshot()).toEqual({ kind: "pending" });
  await controller.open();
  expect(call).toHaveBeenCalledTimes(1);
  finish({ version: 1, status: "sent" });
  await opened;
  expect(controller.getSnapshot()).toEqual({ kind: "sent" });
  controller.dispose();
});

it("DIST-6：8秒超时停止等待，不重发；旧响应不能覆盖新的请求", async () => {
  vi.useFakeTimers();
  const finish: Array<(value: unknown) => void> = [];
  const call = vi.fn(() => new Promise(resolve => { finish.push(resolve); }));
  const controller = new OpenController(call);
  const first = controller.open();
  vi.advanceTimersByTime(8000);
  expect(controller.getSnapshot()).toEqual({ kind: "error", code: "timeout" });
  expect(call).toHaveBeenCalledTimes(1);
  const second = controller.open();
  finish[0]({ version: 1, status: "sent" });
  await first;
  expect(controller.getSnapshot()).toEqual({ kind: "pending" });
  finish[1]({ version: 1, status: "error", code: "missing-component" });
  await second;
  expect(controller.getSnapshot()).toEqual({ kind: "error", code: "missing-component" });
  controller.dispose();
});

it("DIST-6、DIST-9：断连、坏响应与卸下不产生自动重试或迟到状态", async () => {
  const controller = new OpenController(async () => { throw new Error("raw transport error"); });
  await controller.open();
  expect(controller.getSnapshot()).toEqual({ kind: "error", code: "disconnected" });
  controller.dispose();
  const invalid = new OpenController(async () => ({ version: 99, status: "running" }));
  await invalid.open();
  expect(invalid.getSnapshot()).toEqual({ kind: "error", code: "incompatible" });
  invalid.dispose();
  let finish!: (value: unknown) => void;
  const late = new OpenController(() => new Promise(resolve => { finish = resolve; }));
  const pending = late.open();
  late.dispose();
  finish({ version: 1, status: "sent" });
  await pending;
  expect(late.getSnapshot()).toEqual({ kind: "pending" });
});
