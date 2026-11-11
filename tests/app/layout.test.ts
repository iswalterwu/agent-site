import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "../../src/app/fixture";
import { hitTest, layoutBuilding, bubbleLines, withoutBubbles } from "../../src/app/layout";
import { bandSummary, bandView } from "../../src/app/cards";
import { TYPE } from "../../src/app/theme";
import { activeSite } from "../../src/core/site";
import type { Band, SiteSnapshot, SiteView } from "../../src/core/types";

const HEIGHT = 520;
const SNAP = fixtureSnapshot(0);
const site = activeSite(SNAP)!;
/** 把一次修改作用到唯一那个工地上，返回新快照 */
const edit = (fn: (s: SiteView) => void): SiteSnapshot => {
  const next = structuredClone(site);
  fn(next);
  return { ...SNAP, sites: [next], active: next.key };
};
const snap = SNAP;
const layout = layoutBuilding(snap, HEIGHT);
const floorHeight = (HEIGHT - 28 - 8 - 32) / 12;

/** 一个只有矮楼的工地：一层混凝土、卡片里没有数字 */
const miniSnapshot = (): SiteSnapshot => {
  const workers = site.workers.slice(0, 2).map(worker => ({ ...worker, location: { kind: "band" as const, feature: "example", floor: "S1" } }));
  const mini: SiteView = { key: "D:/work/example", path: "D:/work/example", name: "example", kind: "dir", mini: true,
    open: [], backlog: [], bands: [{ feature: "example", placement: "band", materials: [{ material: "concrete", share: 100 }], configured: true,
      style: "tower", stage: "done",
      plan: { floors: [{ id: "S1", kind: "built" }], firstUnfinished: null }, tarp: null, scaffold: [], ribbon: "grey", mini: true,
      card: { title: null, risk: null, ac: null, open: null, openItems: null, slices: null, current: null, status: null, source: "none", specsDir: "D:/work/example" } }],
    office: [], workers, designer: { waiting: [] } };
  return { ...SNAP, sites: [mini], active: mini.key };
};

describe("SITE-4：没有意图卡的矮楼", () => {
  it("矮楼只有一层，高度是可用高度的四分之一，坐在楼体底部", () => {
    const layout = layoutBuilding(miniSnapshot(), HEIGHT);
    const usable = HEIGHT - 28 - 8 - 32;
    expect(layout.bands).toHaveLength(1);
    // 矮楼最多四分之一，但现在层高固定，一层就是一层高
    expect(layout.bands[0].height).toBeCloseTo(Math.min(usable / 10, usable * 0.25));
    expect(layout.bands[0].y + layout.bands[0].height).toBeCloseTo(484);
    expect(layout.bands[0].floors).toHaveLength(1);
    expect(layout.bands[0].floors[0]).toMatchObject({ id: "S1", kind: "built", height: layout.bands[0].height });
    // 矮楼不画脚手架、不画篷布、没有穹顶
    expect([layout.bands[0].scaffold, layout.bands[0].tarp, layout.crown]).toEqual([[], null, null]);
  });

  it("矮楼里的工人站在这层楼里，不站到外面地上", () => {
    const layout = layoutBuilding(miniSnapshot(), HEIGHT);
    const floor = layout.bands[0];
    expect(layout.workers).toHaveLength(2);
    for (const worker of layout.workers) {
      expect(worker.y + worker.height).toBeLessThanOrEqual(floor.y + floor.height + 0.5);
      expect(worker.y).toBeGreaterThanOrEqual(floor.y - 0.5);
    }
  });

  it("矮楼也能点开楼段卡：摘要说没有意图卡", () => {
    const view = bandView(miniSnapshot().sites[0]!, "example")!;
    expect(view.mini).toBe(true);
    expect(bandSummary(view)).toMatchObject({ status: "没有意图卡", current: "没有当前切片", acceptance: "—", risk: "—" });
  });
});

describe("楼体布局", () => {
  it("楼段自下而上、楼段高按切片数分配，穹顶在最上", () => {
    expect(layout.floorHeight).toBeCloseTo(floorHeight);
    expect(layout.bands.map(b => [b.feature, b.height])).toEqual([
      ["data-layer", 5 * floorHeight], ["agent-dock", 4 * floorHeight], ["desktop-shell", 3 * floorHeight]]);
    expect(layout.bands[0].y + layout.bands[0].height).toBeCloseTo(484);
    expect(layout.bands[2].y).toBeCloseTo(32);
    expect(layout.crown).toMatchObject({ x: 27, width: 56, height: 13, feature: "desktop-shell", material: "metal" });
    expect(layout.crown?.y).toBeCloseTo(19);
    expect(layout.crown?.mastY).toBeCloseTo(13);
    expect(layout.ground).toEqual({ x: 0, y: 484, width: 110, height: 8 });
    expect(layout.office).toEqual(expect.objectContaining({ x: 2, y: 476, label: "办公室" }));
    expect(layout.designer).toEqual({ x: 22, y: 472, width: 8, height: 12 });
  });

  it("当前切片按步骤成格；脚手架跟着首个未完成层", () => {
    const data = layout.bands[0];
    expect(data.floors.map(f => [f.id, f.kind])).toEqual([
      ["S1", "built"], ["S2", "built"], ["S3", "progress"], ["S4", "planned"], ["S5", "planned"]]);
    const current = data.floors[2];
    expect(current.cells).toHaveLength(5);
    expect(current.cells.filter(c => c.done)).toHaveLength(3);
    expect(data.scaffold).toHaveLength(1);
    expect(data.scaffold[0].y).toBeCloseTo(current.y);
    expect(data.scaffold[0].height).toBeCloseTo(floorHeight);
  });

  it("材质按份额从左到右分；当前格子用主材质", () => {
    const data = layout.bands[0];
    // 楼层号那一栏占最左 16 px（自己铺底色），材质从它右边开始分，不会被盖住
    expect(data.floors[0].materials).toEqual([{ material: "brick", x: 24, width: 78 }]);
    expect(data.floors[2].cells.filter(c => c.done).every(c => c.done)).toBe(true);
    const mixed = edit(s => { s.bands[0].materials = [{ material: "brick", share: 60 }, { material: "metal", share: 40 }]; });
    const mixedLayout = layoutBuilding(mixed, HEIGHT);
    const mixedMaterials = mixedLayout.bands[0].floors[0].materials;
    expect(mixedMaterials.map(m => [m.material, m.x])).toEqual([["brick", 24], ["metal", 70.8]]);
    expect(mixedMaterials[0].width).toBeCloseTo(46.8);
    expect(mixedMaterials[1].width).toBeCloseTo(31.2);
  });
  it("WINDOW-26：很少的一份材质也完整落在编号一栏右边，不会被底板盖掉", () => {
    const mixed = edit(s => { s.bands[0].materials = [{ material: "brick", share: 10 }, { material: "glass", share: 90 }]; });
    const band = layoutBuilding(mixed, HEIGHT).bands[0];
    const first = band.floors[0].materials[0]!;
    expect(first.x).toBe(24);          // 编号一栏 8..24
    expect(first.width).toBeCloseTo(7.8);
    expect(band.floors[0].materials[1]!.x).toBeCloseTo(31.8);
  });

  it("WINDOW-6：不足十层时层高固定，加减楼层只让楼往上长或缩", () => {
    const oneBand = (count: number): SiteSnapshot => edit(s => {
      s.bands = [s.bands[0]!];
      s.bands[0]!.plan = { firstUnfinished: "S1", floors: Array.from({ length: count }, (_, i) => ({ id: `S${i + 1}`, kind: "planned" as const })) };
    });
    const three = layoutBuilding(oneBand(3), HEIGHT);
    const five = layoutBuilding(oneBand(5), HEIGHT);
    const usable = HEIGHT - 28 - 8 - 32;
    expect(three.floorHeight).toBeCloseTo(usable / 10);
    expect(five.floorHeight).toBeCloseTo(usable / 10);
    expect(three.bands[0].height).toBeCloseTo(3 * three.floorHeight);
    expect(five.bands[0].height).toBeCloseTo(5 * five.floorHeight);
    expect(three.bands[0].y).toBeCloseTo(484 - 3 * three.floorHeight);
    expect(five.bands[0].y).toBeCloseTo(484 - 5 * five.floorHeight);
  });

  it("WINDOW-4：楼体第一层固定画成实体，脚手架从第二层起", () => {
    const next = layoutBuilding(edit(s => {
      s.bands = [s.bands[0]!];
      s.bands[0]!.plan = { firstUnfinished: "S1", floors: [
        { id: "S1", kind: "progress", cells: 2, doneCells: 1 },
        { id: "S2", kind: "progress", cells: 3, doneCells: 1 },
      ] };
      s.bands[0]!.scaffold = ["S1", "S2"];
    }), HEIGHT);
    const band = next.bands[0];
    expect(band.floors.map(floor => [floor.id, floor.kind, floor.cells.length])).toEqual([
      ["S1", "built", 0], ["S2", "progress", 3]]);
    expect(band.scaffold).toEqual([expect.objectContaining({ y: band.floors[1].y, height: band.floors[1].height })]);
  });

  it("增加切片后所有楼层一起变薄，窗口高度不变", () => {
    const next = layoutBuilding(edit(s => {
      const extra = structuredClone(s.bands[0]) as Band;
      extra.feature = "settings";
      extra.plan = { firstUnfinished: "S1", floors: Array.from({ length: 5 }, (_, i) => ({ id: `S${i + 1}`, kind: "planned" as const })) };
      const crown = s.bands.findIndex(b => b.placement === "crown");
      s.bands.splice(crown, 0, extra);
    }), HEIGHT);
    expect(next.floorHeight).toBeCloseTo((HEIGHT - 68) / 17);
    expect(next.floorHeight).toBeLessThan(layout.floorHeight);
    expect(next.bands[0].height).toBeLessThan(layout.bands[0].height);
    expect(next.bands[0].y + next.bands[0].height).toBeCloseTo(484);
    expect(next.bands.at(-1)?.y).toBeCloseTo(32);
  });

  it("步骤很多时格子挤在一起也不会变成负数宽度，仍在楼段里", () => {
    const cellsOf = (count: number, doneCells: number) => {
      // 第一层固定实体；把要测的步骤格放到第二层
      const crowded = edit(s => { s.bands[0].plan = { firstUnfinished: "S3", floors: [
        { id: "S1", kind: "built" }, { id: "S3", kind: "progress", cells: count, doneCells }] }; });
      return layoutBuilding(crowded, HEIGHT).bands[0].floors[1].cells;
    };
    // 7 个不能整除；120、121 个多到放不下 1 px 间隔
    for (const [count, done] of [[7, 3], [120, 40], [121, 121]]) {
      const cells = cellsOf(count, done);
      expect(cells).toHaveLength(count);
      expect(cells.filter(cell => cell.done)).toHaveLength(done);
      for (const cell of cells) expect(cell.width).toBeGreaterThan(0);
      for (let i = 1; i < cells.length; i++) {
        expect(cells[i].x).toBeGreaterThanOrEqual(cells[i - 1].x + cells[i - 1].width - 1e-9);
      }
      const last = cells.at(-1)!;
      expect(last.x + last.width).toBeCloseTo(8 + 15 + 1 + 77, 6);
    }
    expect(cellsOf(7, 3)[0].width).toBeCloseTo((77 - 6) / 7, 6);
  });

  it("篷布、空楼和空办公室都不崩", () => {
    const tarp = edit(s => { s.bands[0].plan = null; s.bands[0].tarp = "图纸读不出"; s.bands[0].scaffold = []; });
    expect(layoutBuilding(tarp, HEIGHT).bands[0]).toMatchObject({ tarp: "图纸读不出", floors: [], scaffold: [] });

    const empty = edit(s => { s.bands = []; s.office = []; });
    const emptyLayout = layoutBuilding(empty, HEIGHT);
    expect(emptyLayout.bands).toEqual([]);
    expect(emptyLayout.crown).toBeNull();
    expect(emptyLayout.office).toBeNull();
    expect(emptyLayout.ground.y).toBe(484);
  });

  it("SITE-2：一个工地都没有时画空工地：地面、设计师、底栏都在，没有楼体和工人", () => {
    const layout = layoutBuilding({ ...SNAP, sites: [], active: null }, HEIGHT);
    expect([layout.bands, layout.workers, layout.bubbles, layout.crown, layout.office]).toEqual([[], [], [], null, null]);
    expect(layout.ground.y).toBe(484);
    expect(layout.designer).toEqual({ x: 22, y: 472, width: 8, height: 12 });
    expect(layout.footer.lights.length).toBeGreaterThanOrEqual(0);
    expect(hitTest(layout, 50, 200)).toBeNull();
  });

  it("命中顺序：办公室、设计师、穹顶优先于楼段；空白处不命中", () => {
    const data = layout.bands[0];
    expect(hitTest(layout, 50, data.y + 10)).toEqual({ kind: "band", feature: "data-layer" });
    expect(hitTest(layout, 5, 476)).toEqual({ kind: "office" });
    expect(hitTest(layout, 24, 472)).toEqual({ kind: "designer" });
    expect(hitTest(layout, 55, 25)).toEqual({ kind: "band", feature: "desktop-shell" });
    expect(hitTest(layout, 1, 100)).toBeNull();
    expect(hitTest(layout, 110, 100)).toBeNull();
  });
});

describe("小人、气泡与底栏命中", () => {
  const tight = layoutBuilding(fixtureSnapshot(0), 360);
  const data = tight.bands.find(band => band.feature === "data-layer")!;
  const s3 = data.floors.find(floor => floor.id === "S3")!;
  const s4 = data.floors.find(floor => floor.id === "S4")!;
  const s1Worker = tight.workers.find(worker => worker.key === "pi:s1")!;
  const s1Bubble = tight.bubbles.find(bubble => bubble.key === "pi:s1")!;

  it("A7：气泡在工人上一层的楼内，最多两行，不盖当前切片的格子", () => {
    expect(s1Bubble.width).toBe(76);
    expect(s1Bubble.lines.length).toBeLessThanOrEqual(2);
    expect(s1Bubble.y).toBeGreaterThanOrEqual(s4.y);
    expect(s1Bubble.y + s1Bubble.height).toBeLessThanOrEqual(s4.y + s4.height);
    expect(s1Bubble.y + s1Bubble.height).toBeCloseTo(s3.y - 2);
    expect(s1Bubble.anchorY).toBeCloseTo(s1Worker.y);
  });

  it("A7：只常显等你 / 出错 / 停工，其余状态没有气泡", () => {
    expect(new Set(tight.bubbles.map(bubble => bubble.key))).toEqual(new Set(["pi:s1", "claude:s3", "dsh:s4"]));
    expect(tight.bubbles.find(bubble => bubble.key === "pi:s1")?.tone).toBe("waiting");
    expect(tight.bubbles.find(bubble => bubble.key === "claude:s3")?.tone).toBe("error");
    expect(tight.bubbles.find(bubble => bubble.key === "dsh:s4")?.tone).toBe("stalled");
  });

  it("A7：气泡互不重叠，也不越出窗口", () => {
    const footerTop = tight.height - 28;
    for (const [index, bubble] of tight.bubbles.entries()) {
      expect(bubble.y).toBeGreaterThanOrEqual(32);
      expect(bubble.y + bubble.height).toBeLessThanOrEqual(footerTop);
      for (const other of tight.bubbles.slice(index + 1)) expect(overlap(bubble, other)).toBe(false);
    }
  });

  it("A7：3×（逻辑高 240）下气泡不盖任何当前切片的楼层", () => {
    const small = layoutBuilding(fixtureSnapshot(0), 240);
    const progress = small.bands.flatMap(band => band.floors).filter(floor => floor.kind === "progress");
    expect(progress.length).toBeGreaterThan(0);
    for (const bubble of small.bubbles) for (const floor of progress) expect(overlap(bubble, floor)).toBe(false);
  });

  it("A7：同层两个等你气泡在 3× 下错开，不盖当前切片", () => {
    const crowded = layoutBuilding(edit(s => {
      for (const worker of s.workers) {
        if (worker.key !== "pi:s1" && worker.key !== "pi:s2") continue;
        worker.status = "waiting";
        worker.location = { kind: "band", feature: "data-layer", floor: "S1" };
      }
    }), 240);
    const pair = crowded.bubbles.filter(bubble => bubble.key === "pi:s1" || bubble.key === "pi:s2");
    expect(pair).toHaveLength(2);
    expect(overlap(pair[0], pair[1])).toBe(false);
    const progress = crowded.bands.flatMap(band => band.floors).filter(floor => floor.kind === "progress");
    for (const bubble of pair) for (const floor of progress) expect(overlap(bubble, floor)).toBe(false);
  });

  it("A7：顶层两个等你气泡在 3× 下也错开", () => {
    const top = layoutBuilding(edit(s => {
      for (const worker of s.workers) {
        if (worker.key !== "pi:s1" && worker.key !== "pi:s2") continue;
        worker.status = "waiting";
        worker.location = { kind: "band", feature: "desktop-shell", floor: "S3" };
      }
    }), 240);
    const pair = top.bubbles.filter(bubble => bubble.key === "pi:s1" || bubble.key === "pi:s2");
    expect(pair).toHaveLength(2);
    expect(overlap(pair[0], pair[1])).toBe(false);
    const progress = top.bands.flatMap(band => band.floors).filter(floor => floor.kind === "progress");
    for (const bubble of pair) for (const floor of progress) expect(overlap(bubble, floor)).toBe(false);
  });

  it("A9：2× 下楼段名、楼层号、气泡和图例不小于下限", () => {
    expect(TYPE.label * 2).toBeGreaterThanOrEqual(12);
    expect(TYPE.caption * 2).toBeGreaterThanOrEqual(10);
    expect(tight.footer.legend.every(item => item.height >= TYPE.caption)).toBe(true);
  });

  it("WINDOW-8：灯按全部工地混排，楼体仍只画当前工地", () => {
    const other: SiteView = { ...structuredClone(site), key: "D:/work/other", path: "D:/work/other", name: "other",
      workers: site.workers.slice(0, 2).map(worker => ({ ...worker, key: `x-${worker.key}`, status: "waiting" as const })) };
    const two: SiteSnapshot = { ...SNAP, sites: [site, other], active: site.key };
    const drawn = layoutBuilding(two, HEIGHT);
    // 楼体上的小人只有当前工地的
    expect(drawn.workers.map(worker => worker.key)).not.toContain("x-pi:s1");
    expect(drawn.footer.lights.some(light => light.site === "D:/work/other")).toBe(true);
    expect(drawn.footer.lights.some(light => light.site === site.key)).toBe(true);
    // 别的工地的等待灯排在前面：等你优先
    expect(drawn.footer.lights[0].site).toBe("D:/work/other");
    expect(drawn.footer.lights[0].tone).toBe("waiting");
  });
  it("A3：气泡、小人、灯都能命中，空白和底栏图例不命中", () => {
    expect(hitTest(tight, s1Bubble.x + 1, s1Bubble.y + 1)).toEqual({ kind: "bubble", key: "pi:s1", site: tight.siteKey });
    expect(hitTest(tight, s1Worker.x + 1, s1Worker.y + 3)).toEqual({ kind: "worker", key: "pi:s1", site: tight.siteKey });
    const light = tight.footer.lights[0];
    expect(hitTest(tight, light.x + light.width / 2, light.y + light.height / 2))
      .toEqual({ kind: "light", key: light.key, site: light.site });
    expect(hitTest(tight, 1, 100)).toBeNull();
  });

  it("A3：小人压在设计师上时命中小人", () => {
    const copy = structuredClone(tight);
    const key = copy.workers[0].key;
    copy.workers[0] = { ...copy.workers[0], x: copy.designer.x, y: copy.designer.y,
      width: copy.designer.width, height: copy.designer.height };
    expect(hitTest(copy, copy.designer.x + 1, copy.designer.y + 1)).toEqual({ kind: "worker", key, site: copy.siteKey });
  });

  it("演示模式去掉气泡和它们的命中矩形", () => {
    const hidden = withoutBubbles(tight);
    expect(hidden.bubbles).toEqual([]);
    expect(hidden.hitRects.length).toBeLessThan(tight.hitRects.length);
    for (const bubble of tight.bubbles) expect(hidden.hitRects).not.toContain(bubble);
    expect(hidden.bands).toBe(tight.bands);
  });

  it("气泡折行：两行放不下时用省略号，空文字不气泡", () => {
    expect(bubbleLines("")).toEqual([]);
    const lines = bubbleLines("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十");
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(Array.from(lines[1]).length).toBeLessThanOrEqual(12);
  });
});

const overlap = (a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("快照里有人离开时的站位", () => {
  it("A17：同层还在的人保持原来的 x，不再重新居中", () => {
    const full = layoutBuilding(snap, HEIGHT);
    const s1 = full.workers.find(worker => worker.key === "pi:s1")!;
    const s2 = full.workers.find(worker => worker.key === "pi:s2")!;
    expect(s1.y).toBeCloseTo(s2.y);
    const stable = new Map(full.workers.map(worker => [worker.key, worker.x]));
    const next = edit(s => { s.workers = s.workers.filter(worker => worker.key !== "pi:s2"); });
    const after = layoutBuilding(next, HEIGHT, stable).workers.find(worker => worker.key === "pi:s1")!;
    expect(after.x).toBeCloseTo(s1.x);
  });
});

describe("新来的人避让原有站位", () => {
  it("A17：更早开始的新会话不会和原有同层小人占同一个 x", () => {
    const full = layoutBuilding(snap, HEIGHT);
    const pair = full.workers.filter(worker => worker.key === "pi:s1" || worker.key === "pi:s2")
      .sort((a, b) => a.x - b.x);
    const survivor = pair[0];
    const leaving = pair[1];
    const reduced = edit(s => { s.workers = s.workers.filter(worker => worker.key !== leaving.key); });
    const stable = new Map(full.workers.map(worker => [worker.key, worker.x]));
    const after = layoutBuilding(reduced, HEIGHT, stable).workers.find(worker => worker.key === survivor.key)!;
    const source = site.workers.find(worker => worker.key === leaving.key)!;
    const survivorSource = site.workers.find(worker => worker.key === survivor.key)!;
    const newcomer = { ...source, key: "pi:new", startedAt: survivorSource.startedAt - 1000 };
    const added = layoutBuilding(edit(s => { s.workers = s.workers.filter(worker => worker.key !== leaving.key).concat(newcomer); }), HEIGHT, stable);
    const sameFloor = added.workers.filter(worker => Math.abs(worker.y - after.y) < 0.01);
    const xs = sameFloor.map(worker => worker.x).sort((a, b) => a - b);
    expect(xs.every((x, i) => i === 0 || x - xs[i - 1] >= 5)).toBe(true);
    expect(sameFloor.find(worker => worker.key === survivor.key)!.x).toBeCloseTo(survivor.x);
  });
});

describe("WINDOW-17：同层摆放", () => {
  it("八个主 agent 站在同一层时不重叠、不出楼", () => {
    const crowded = layoutBuilding(edit(s => {
      s.workers = s.workers.slice(0, 8).map(worker => ({ ...worker,
        location: { kind: "band" as const, feature: "data-layer", floor: "S3" } }));
    }), 360);
    expect(crowded.workers).toHaveLength(8);
    for (const [index, worker] of crowded.workers.entries()) {
      expect(worker.x).toBeGreaterThanOrEqual(8);
      expect(worker.x + worker.width).toBeLessThanOrEqual(102);
      for (const other of crowded.workers.slice(index + 1)) {
        expect(worker.x + worker.width).toBeLessThanOrEqual(other.x);
      }
    }
  });
});

describe("WINDOW-17：避让", () => {
  it("保留已站位置、依次加入八个人，仍不重叠也不出楼", () => {
    const crew = site.workers.slice(0, 8).map(worker => ({ ...worker,
      location: { kind: "band" as const, feature: "data-layer", floor: "S3" } }));
    let stable: Map<string, number> | undefined;
    for (let count = 1; count <= 8; count++) {
      const layout = layoutBuilding(edit(s => { s.workers = crew.slice(0, count); }), 360, stable);
      const sorted = [...layout.workers].sort((a, b) => a.x - b.x);
      expect(sorted).toHaveLength(count);
      for (const [index, worker] of sorted.entries()) {
        expect(worker.x).toBeGreaterThanOrEqual(8);
        expect(worker.x + worker.width).toBeLessThanOrEqual(102);
        if (index > 0) expect(sorted[index - 1].x + sorted[index - 1].width).toBeLessThanOrEqual(worker.x);
      }
      stable = new Map(sorted.map(worker => [worker.key, worker.x]));
    }
  });
});

describe("WINDOW-30、WINDOW-31：布局把楼段造型和阶段带给绘制", () => {
  it("布局里的楼段带着快照的 style 和 stage", () => {
    const next = edit(s => { s.bands[0] = { ...s.bands[0], style: "factory", stage: "foundation" }; });
    const band = layoutBuilding(next, HEIGHT).bands[0];
    expect([band.style, band.stage]).toEqual(["factory", "foundation"]);
  });
});

describe("WINDOW-30、WINDOW-31：穹顶和办公室也带造型和阶段", () => {
  it("布局把 crown 和办公室的 style / stage 带下去", () => {
    const next = edit(s => {
      s.bands = s.bands.map(band => band.placement === "crown"
        ? { ...band, style: "storefront" as const, stage: "done" as const } : band);
      s.office = s.office.map(office => ({ ...office, style: "factory" as const, stage: "structure" as const }));
    });
    const built = layoutBuilding(next, HEIGHT);
    expect([built.crown?.style, built.crown?.stage]).toEqual(["storefront", "done"]);
    expect([built.office?.style, built.office?.stage]).toEqual(["factory", "structure"]);
  });
});
