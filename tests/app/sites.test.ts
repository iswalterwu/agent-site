import { describe, expect, it } from "vitest";
import { applyPin } from "../../src/app/sites";
import { fixtureSnapshot } from "../../src/app/fixture";

const twoSites = () => {
  const first = fixtureSnapshot(0).sites[0]!;
  const second = { ...first, key: "D:/b", path: "D:/b", name: "b" };
  return { ...fixtureSnapshot(0), sites: [first, second], active: "D:/a" };
};

describe("工地选择", () => {
  it("SITE-3：没钉住时用引擎算的当前工地", () => {
    const snap = twoSites();
    const result = applyPin(snap, null);
    expect(result.pinned).toBeNull();
    expect(result.snapshot).toBe(snap);
    expect(result.snapshot.active).toBe("D:/a");
  });

  it("SITE-3：钉住另一个工地时覆盖当前工地，快照其他字段不变", () => {
    const snap = twoSites();
    const result = applyPin(snap, "D:/b");
    expect(result.pinned).toBe("D:/b");
    expect(result.snapshot.active).toBe("D:/b");
    expect(result.snapshot.sites).toBe(snap.sites);
    expect(result.snapshot.at).toBe(snap.at);
  });

  it("SITE-3：钉住的工地消失后回到自动跟随", () => {
    const snap = twoSites();
    const result = applyPin(snap, "D:/gone");
    expect(result.pinned).toBeNull();
    expect(result.snapshot).toBe(snap);
    expect(result.snapshot.active).toBe("D:/a");
  });

  it("钉的就是最近有事的那个时不复制快照", () => {
    const snap = twoSites();
    expect(applyPin(snap, "D:/a").snapshot).toBe(snap);
  });
});
