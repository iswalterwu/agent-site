import { describe, expect, it } from "vitest";
import { departedWorkers, exitAlpha, exitProgress, exitX, WALK_OUT_MS } from "../../src/app/transitions";
import type { LayoutWorker } from "../../src/app/layout";

const worker = (key: string, x = 20): LayoutWorker => ({ key, role: "worker", tone: "working", readOnly: true,
  spot: null, x, y: 100, width: 8, height: 12 });

describe("收工走出窗口", () => {
  it("只挑出这次快照里已经不在的人", () => {
    const previous = [worker("a"), worker("b"), worker("c")];
    const current = [worker("b", 30), worker("d")];
    expect(departedWorkers(previous, current).map(item => item.key)).toEqual(["a", "c"]);
  });

  it("从原位走到窗口右缘，最后 30% 淡出", () => {
    expect(exitX(worker("a", 20), 110, 0)).toBe(20);
    expect(exitX(worker("a", 20), 110, 1)).toBe(116);
    expect(exitProgress(1000, 1000 + WALK_OUT_MS / 2)).toBeCloseTo(0.5);
    expect(exitProgress(1000, 1000 + WALK_OUT_MS)).toBe(1);
    expect(exitAlpha(0.5)).toBe(1);
    expect(exitAlpha(0.85)).toBeCloseTo(0.5);
    expect(exitAlpha(1)).toBe(0);
  });
});
