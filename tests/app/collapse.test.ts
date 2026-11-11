import { describe, expect, it } from "vitest";
import { withSite } from "../harness/site";
import { canAutoCollapse, ribbonSegments, segmentAt, shouldScheduleCollapse, summaryBox, RIBBON_WIDTH } from "../../src/app/collapse";
import { fixtureSnapshot } from "../../src/app/fixture";
import { layoutBuilding } from "../../src/app/layout";

const snap = fixtureSnapshot(0);
const layout = layoutBuilding(snap, 360);

describe("收起彩带", () => {
  it("贴在右缘，按楼段自下而上分段，颜色来自楼段状态", () => {
    const segments = ribbonSegments(layout);
    expect(segments.map(segment => segment.feature)).toEqual(["data-layer", "agent-dock", "desktop-shell"]);
    expect(segments.map(segment => segment.ribbon)).toEqual(["orange", "red", "yellow"]);
    expect(segments.every(segment => segment.x === layout.width - RIBBON_WIDTH && segment.width === RIBBON_WIDTH)).toBe(true);
    expect(segments[1].y + segments[1].height).toBeLessThanOrEqual(segments[0].y);
    expect(segments.at(-1)!.y).toBeCloseTo(layout.bands.at(-1)!.y);
  });

  it("按 y 找段，空白处不命中", () => {
    const segments = ribbonSegments(layout);
    expect(segmentAt(segments, segments[1].y + 1)).toBe(segments[1]);
    expect(segmentAt(segments, 0)).toBeNull();
  });

  it("卡片开着时不自动收起，有人在等照收", () => {
    const working = withSite(structuredClone(snap), { workers: snap.sites[0].workers.map(worker => ({ ...worker, status: "working" as const })) });
    expect(canAutoCollapse(snap, false)).toBe(true);
    expect(canAutoCollapse(snap, true)).toBe(false);
    expect(canAutoCollapse(working, false)).toBe(true);
    expect(canAutoCollapse(working, true)).toBe(false);
    expect(canAutoCollapse(null, false)).toBe(false);
  });

  it("指针在外、卡片关掉后才恢复自动收起计时", () => {
    const working = withSite(structuredClone(snap), { workers: snap.sites[0].workers.map(worker => ({ ...worker, status: "working" as const })) });
    expect(shouldScheduleCollapse(false, false, working, false, true)).toBe(true);
    expect(shouldScheduleCollapse(true, false, working, false, true)).toBe(false);
    expect(shouldScheduleCollapse(false, false, working, true, true)).toBe(false);
    expect(shouldScheduleCollapse(false, true, working, false, true)).toBe(false);
    expect(shouldScheduleCollapse(false, false, snap, false, true)).toBe(true);
    expect(shouldScheduleCollapse(false, false, working, false, false)).toBe(false);
    // 刚启动、指针还没进过整窗：不自动收起
    expect(shouldScheduleCollapse(false, false, working, false, true, false)).toBe(false);
  });

  it("摘要贴在彩带左边，3× 等比放大并夹在窗口内", () => {
    const segment = ribbonSegments(layout)[0];
    const two = summaryBox(segment, 2, layout.width * 2, 720, 190, 170);
    expect(two.x + two.width).toBe((layout.width - RIBBON_WIDTH) * 2);
    expect(two.width).toBe(190);
    const three = summaryBox(segment, 3, layout.width * 3, 720, 285, 255);
    expect(three.x + three.width).toBe((layout.width - RIBBON_WIDTH) * 3);
    expect(three.width).toBe(285);
    expect(three.y).toBeGreaterThanOrEqual(8);
    expect(three.y + three.height).toBeLessThanOrEqual(712);
  });
});
