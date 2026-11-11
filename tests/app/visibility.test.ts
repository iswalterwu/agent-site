import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "../../src/app/fixture";
import { STALE_WORKER_MS, visibleSnapshot } from "../../src/app/visibility";
import { withSite } from "../harness/site";

const HOUR = 3_600_000;

describe("楼体只显示最近有动静的会话", () => {
  it("超过六小时的等待 / 空闲会话不画；在干和最近的会话保留", () => {
    const snap = fixtureSnapshot(0);
    const workers = snap.sites[0].workers.map(worker => {
      if (worker.key === "pi:s1") return { ...worker, status: "waiting" as const, statusSince: -7 * HOUR };
      if (worker.key === "claude:s5") return { ...worker, status: "idle" as const, statusSince: -7 * HOUR };
      if (worker.key === "pi:s2") return { ...worker, status: "working" as const, statusSince: -7 * HOUR };
      return { ...worker, status: "waiting" as const, statusSince: -60 * 60_000 };
    });
    const visible = visibleSnapshot(withSite({ ...snap, at: 0 }, { workers }), 0);
    const shown = visible.sites[0].workers;
    expect(shown.some(worker => worker.key === "pi:s1")).toBe(false);
    expect(shown.some(worker => worker.key === "claude:s5")).toBe(false);
    expect(shown.some(worker => worker.key === "pi:s2")).toBe(true);
    expect(shown.some(worker => worker.key === "claude:s3")).toBe(true);
    expect(STALE_WORKER_MS).toBe(6 * HOUR);
  });

  it("隐藏的等待项也从等你清单里拿掉", () => {
    const snap = fixtureSnapshot(0);
    const replaced = snap.sites[0].workers.map(worker => worker.key === "pi:s1"
      ? { ...worker, status: "waiting" as const, statusSince: -7 * HOUR }
      : worker);
    const visible = visibleSnapshot(withSite({ ...snap, at: 0 }, { workers: replaced }), 0);
    expect(visible.sites[0].designer.waiting.some(item => item.key === "pi:s1")).toBe(false);
  });
});

describe("可见快照的等待清单和彩带", () => {
  it("离开 workers 的旧等待不会从历史里重新出现", () => {
    const snap = fixtureSnapshot(0);
    const withoutS1 = snap.sites[0].workers.filter(worker => worker.key !== "pi:s1");
    const withHistory = withSite({ ...snap, at: 0 }, { workers: withoutS1,
      designer: { waiting: [{ kind: "history" as const, key: "pi:s1", since: -7 * HOUR, text: "旧等待" }] } });
    expect(visibleSnapshot(withHistory, 0).sites[0].designer.waiting).toEqual([]);
  });

  it("隐藏等待后楼段彩带按剩下的人重算", () => {
    const snap = fixtureSnapshot(0);
    const old = withSite({ ...snap, at: 0 }, { workers: snap.sites[0].workers.map(worker => worker.key === "pi:s1"
      ? { ...worker, status: "waiting" as const, statusSince: -7 * HOUR }
      : worker) });
    const visible = visibleSnapshot(old, 0);
    expect(visible.sites[0].bands.find(band => band.feature === "data-layer")!.ribbon).not.toBe("orange");
  });
});

describe("可见快照的引用稳定性", () => {
  it("同一份源和同一组可见项返回同一个对象，定时刷新不重推", () => {
    const snap = fixtureSnapshot(0);
    const old = withSite({ ...snap, at: 0 }, { workers: snap.sites[0].workers.map(worker => worker.key === "pi:s1"
      ? { ...worker, status: "waiting" as const, statusSince: -7 * HOUR }
      : worker) });
    const first = visibleSnapshot(old, 0);
    expect(visibleSnapshot(old, 0)).toBe(first);
  });
});
