import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "../../src/app/fixture";
import { withSite } from "../harness/site";
import { drawBuilding } from "../../src/app/draw";
import { layoutBuilding } from "../../src/app/layout";
import { GARDEN, PLATE, setTheme, STYLE, THEMES } from "../../src/app/theme";
import type { Band, BuildStage, SiteView } from "../../src/core/types";

function textsOf(layout: ReturnType<typeof layoutBuilding>): string[] {
  const texts: string[] = [];
  const ctx = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
      if (prop === "fillText" || prop === "strokeText") return (text: string) => { texts.push(text); };
      return () => {};
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  drawBuilding(ctx, layout);
  return texts;
}

describe("画布文字脱敏", () => {
  it("楼段名先过 redact 再画", () => {
    const snap = fixtureSnapshot(0);
    const bands = snap.sites[0].bands.map((band, index) => index === 0 ? { ...band, feature: "data-layer sk-abcdefgh12345678" } : band);
    const texts = textsOf(layoutBuilding(withSite(snap, { bands }), 360));
    expect(texts.some(text => text.includes("sk-***"))).toBe(true);
    expect(texts.some(text => text.includes("sk-abcdefgh12345678"))).toBe(false);
  });
});

describe("像素画落笔", () => {
  it("所有 fillRect 都落在半逻辑像素上，2× 下仍是整 CSS 像素", () => {
    const rects: number[][] = [];
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
        if (prop === "fillRect") return (...args: number[]) => { rects.push(args); };
        return () => {};
      },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    const snap = fixtureSnapshot(0);
    const bands = snap.sites[0].bands.map((band, index) => index === 0 ? { ...band, tarp: null } : band);
    drawBuilding(ctx, layoutBuilding(withSite(snap, { bands }), 360), true);
    drawBuilding(ctx, layoutBuilding(fixtureSnapshot(0), 240), true);
    expect(rects.length).toBeGreaterThan(100);
    const offGrid = rects.filter(args => args.some(value => !Number.isInteger(value * 2)));
    expect(offGrid).toEqual([]);
  });

  it("WINDOW-30、WINDOW-31：三种造型 × 四个阶段都能画，落笔仍在半像素网格上", () => {
    const rects: number[][] = [];
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
        if (prop === "fillRect") return (...args: number[]) => { rects.push(args); };
        return () => {};
      },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    const snap = fixtureSnapshot(0);
    const bands = snap.sites[0].bands;
    for (const style of ["tower", "factory", "storefront"] as const) {
      for (const stage of ["empty", "foundation", "structure", "done"] as const) {
        drawBuilding(ctx, layoutBuilding(withSite(snap, { bands: bands.map(band => ({ ...band, style, stage })) }), 360), true);
      }
    }
    expect(rects.length).toBeGreaterThan(200);
    expect(rects.filter(args => args.some(value => !Number.isInteger(value * 2)))).toEqual([]);
  });
});

describe("楼层号配色（WINDOW-26）", () => {
  /** 记录每次 fillRect 用的 fillStyle；用来确认底板和文字是配对的两个令牌 */
  type Painted = { style: string; text: string; x: number; y: number };
  const paint = (): { fills: { style: string; rect: number[] }[]; texts: Painted[] } => {
    const fills: { style: string; rect: number[] }[] = [];
    const texts: Painted[] = [];
    let style = "";
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
        if (prop === "fillRect") return (...rect: number[]) => { fills.push({ style, rect }); };
        if (prop === "fillText") return (text: string, x: number, y: number) => { texts.push({ style, text, x, y }); };
        return () => {};
      },
      set: (_target, prop, value) => { if (prop === "fillStyle") style = String(value); return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawBuilding(ctx, layoutBuilding(fixtureSnapshot(0), 360), true);
    return { fills, texts };
  };
  it("白昼配色下楼层号仍是深底浅字，不跟着正文变暗", () => {
    setTheme("day");
    try {
      const layout = layoutBuilding(fixtureSnapshot(0), 360);
      const { fills, texts } = paint();
      // 每一层的编号都落在它自己那一层里，颜色取底板专用色；编号一栏的底色出在同一块地方
      const floors = layout.bands.flatMap(band => band.floors);
      const inGutter = (floor: { x: number; y: number; height: number }) => (p: { x: number; y: number }): boolean =>
        p.x >= Math.round(floor.x) && p.x < Math.round(floor.x) + 16
        && p.y > Math.round(floor.y) && p.y <= Math.round(floor.y + floor.height);
      const numbers = floors.flatMap(floor => texts
        .filter(inGutter(floor))
        .filter(t => /^[A-Za-z]*\d+$/.test(t.text) && t.text.length <= 4));
      expect(numbers.length).toBeGreaterThan(0);
      // 每层都有一笔用底板专用色的编号；正文的暗色（白昼 text / muted）一次都没落到编号上
      for (const floor of floors) {
        expect(numbers.some(t => t.style === PLATE.text && inGutter(floor)(t))).toBe(true);
      }
      expect(numbers.some(t => t.style === THEMES.day.text || t.style === THEMES.day.muted)).toBe(false);
      expect(fills.some(f => f.style === PLATE.solid && f.rect[2] === 16)).toBe(true);
    } finally {
      setTheme("night");
    }
  });
});

describe("未建楼层的骨架", () => {
  it("连续未建楼层画一圈虚线，线条落在整数像素上", () => {
    const rects: number[][] = [];
    const styles = new Set<string>();
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
        if (prop === "fillRect") return (...args: number[]) => { rects.push(args); };
        return () => {};
      },
      set: (_target, prop, value) => { if (prop === "fillStyle") styles.add(String(value)); return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawBuilding(ctx, layoutBuilding(fixtureSnapshot(0), 360));
    expect(styles.has("rgba(163, 178, 194, .42)")).toBe(true);
    expect(rects.filter(args => args.some(value => !Number.isInteger(value)))).toEqual([]);
  });
});

describe("材料与楼层归属", () => {
  const litPanes = (snap: ReturnType<typeof fixtureSnapshot>): number[][] => {
    const layout = layoutBuilding(snap, 360);
    const panes: number[][] = [];
    let style = "";
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
        if (prop === "fillRect") return (...args: number[]) => {
          if (style === "rgba(196, 232, 255, .55)") panes.push(args);
        };
        return () => {};
      },
      set: (_target, prop, value) => { if (prop === "fillStyle") style = String(value); return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawBuilding(ctx, layout);
    return panes;
  };
  const inside = (panes: number[][], floor: { y: number; height: number }): number =>
    panes.filter(([, y]) => y >= Math.round(floor.y) && y < Math.round(floor.y + floor.height)).length;

  it("有人站着的楼层才多点亮窗，下面的楼层不多亮", () => {
    const quiet = withSite(fixtureSnapshot(0), { workers: [] });
    const base = fixtureSnapshot(0);
    const occupied = withSite(base, { workers: [{ ...base.sites[0].workers[0], status: "working" as const,
      location: { kind: "band" as const, feature: "data-layer", floor: "S2" } }] });
    const floorAbove = layoutBuilding(occupied, 360).bands[0].floors[2];
    const floorHere = layoutBuilding(occupied, 360).bands[0].floors[1];
    const withWorker = litPanes(occupied);
    const baseline = litPanes(quiet);
    expect(inside(withWorker, floorAbove)).toBe(inside(baseline, floorAbove));
    expect(inside(withWorker, floorHere)).toBeGreaterThan(inside(baseline, floorHere));
  });
});

describe("像素与测宽", () => {
  it("文字测宽带小数时，招牌仍按整数像素落笔", () => {
    const rects: number[][] = [];
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5.3 });
        if (prop === "fillRect") return (...args: number[]) => { rects.push(args); };
        return () => {};
      },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    drawBuilding(ctx, layoutBuilding(fixtureSnapshot(0), 360));
    expect(rects.length).toBeGreaterThan(100);
    expect(rects.filter(args => args.some(value => !Number.isInteger(value)))).toEqual([]);
  });

  it("穹顶从窄顶收到宽底，不是倒扣的碗", () => {
    const rows: Array<{ y: number; w: number }> = [];
    let style = "";
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
        if (prop === "fillRect") return (x: number, y: number, w: number, h: number) => {
          if (style === STYLE.tower.dome && h === 1 && w > 0) rows.push({ y, w });
        };
        return () => {};
      },
      set: (_target, prop, value) => { if (prop === "fillStyle") style = String(value); return true; },
    }) as unknown as CanvasRenderingContext2D;
    const snap = fixtureSnapshot(0);
    const bands = snap.sites[0].bands.map(band => band.placement === "crown"
      ? { ...band, stage: "done" as const, style: "tower" as const } : band);
    drawBuilding(ctx, layoutBuilding(withSite(snap, { bands }), 360));
    expect(rows.length).toBeGreaterThan(6);
    rows.sort((a, b) => a.y - b.y);
    expect(rows.at(-1)!.w).toBeGreaterThan(rows[0].w);
    for (const [index, row] of rows.entries()) {
      if (index > 0) expect(row.w).toBeGreaterThanOrEqual(rows[index - 1].w);
    }
  });
});

describe("WINDOW-30、WINDOW-31：造型与阶段件", () => {
  /** 记录每次 fillRect 的 fillStyle 和位置；用来比对两套落笔是否完全一样 */
  const recorder = () => {
    const fills: string[] = [];
    let style = "";
    const ctx = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
        if (prop === "fillRect") return (...rect: number[]) => { fills.push(`${style}:${rect.join(",")}`); };
        return () => {};
      },
      set: (_target, prop, value) => { if (prop === "fillStyle") style = String(value); return true; },
    }) as unknown as CanvasRenderingContext2D;
    return { fills, ctx };
  };
  const wholeDraw = (patch: (band: Band) => Band): string[] => {
    const { fills, ctx } = recorder();
    const snap = fixtureSnapshot(0);
    drawBuilding(ctx, layoutBuilding(withSite(snap, { bands: snap.sites[0].bands.map(patch) }), 360), true);
    return fills;
  };
  const oneBand = (stage: BuildStage, patch: Partial<Band> = {}): string[] => {
    const { fills, ctx } = recorder();
    const snap = fixtureSnapshot(0);
    const bands = [{ ...snap.sites[0].bands[0], feature: "probe", tarp: null, style: "tower" as const, stage, ...patch }];
    drawBuilding(ctx, layoutBuilding(withSite(snap, { bands, workers: [], office: [] }), 360), false);
    return fills;
  };

  it("WINDOW-30、WINDOW-31：穹顶也跟造型和阶段变，但不立塔吊", () => {
    setTheme("night");
    const { crane, hoarding, rebar } = THEMES.night;
    const fills = (style: "tower" | "factory" | "storefront", stage: BuildStage): string[] =>
      wholeDraw(band => ({ ...band, placement: "crown", stage, style }));
    const factory = fills("factory", "done");
    expect(factory).not.toEqual(fills("tower", "done"));
    expect(factory.some(fill => fill.startsWith(`${crane}:`))).toBe(false);
    expect(fills("tower", "empty").some(fill => fill.startsWith(`${hoarding}:`))).toBe(true);
    expect(fills("tower", "foundation").some(fill => fill.startsWith(`${rebar}:`))).toBe(true);
  });

  it("WINDOW-30、WINDOW-31：办公室也跟造型和阶段变，但不立塔吊", () => {
    setTheme("night");
    const { crane, hoarding, rebar } = THEMES.night;
    const one = (patch: Partial<SiteView["office"][number]>): string[] => {
      const { fills, ctx } = recorder();
      const snap = fixtureSnapshot(0);
      const office = [{ ...snap.sites[0].office[0], ...patch }];
      drawBuilding(ctx, layoutBuilding(withSite(snap, { office }), 360), false);
      return fills;
    };
    const factory = one({ style: "factory", stage: "done" });
    expect(factory).not.toEqual(one({ style: "tower", stage: "done" }));
    expect(factory.some(fill => fill.startsWith(`${crane}:`))).toBe(false);
    expect(one({ stage: "empty" }).some(fill => fill.startsWith(`${hoarding}:`))).toBe(true);
    expect(one({ stage: "foundation" }).some(fill => fill.startsWith(`${rebar}:`))).toBe(true);
  });

  it("WINDOW-30、WINDOW-31：crown 楼段也跟造型画楼层，但不叠屋顶和阶段件", () => {
    setTheme("night");
    // 只比 crown 楼段自己的矩形：穹顶在它上方，不在比较范围里
    const inBand = (fill: string, band: { x: number; y: number; width: number; height: number }): boolean => {
      const [x, y, w, h] = fill.slice(fill.indexOf(":") + 1).split(",").map(Number);
      return x >= Math.round(band.x) && y >= Math.round(band.y)
        && x + w <= Math.round(band.x + band.width) && y + h <= Math.round(band.y + band.height);
    };
    // 拿有 built 楼层的段当 crown 段：crown 楼段的楼层只走 built 分支时才会碰到造型窗
    const scenario = (style: "tower" | "factory" | "storefront", stage: BuildStage): string[] => {
      const { fills, ctx } = recorder();
      const snap = fixtureSnapshot(0);
      const bands = snap.sites[0].bands.map(band => band.feature === "data-layer"
        ? { ...band, placement: "crown" as const, tarp: null, style, stage } : band);
      const layout = layoutBuilding(withSite(snap, { bands }), 360);
      drawBuilding(ctx, layout, false);
      const crownBand = layout.bands.find(band => band.feature === "data-layer")!;
      return fills.filter(fill => inBand(fill, crownBand));
    };
    const towerDone = scenario("tower", "done");
    expect(towerDone.length).toBeGreaterThan(0);
    expect(scenario("factory", "done")).not.toEqual(towerDone);
    expect(scenario("storefront", "done")).not.toEqual(towerDone);
    const { crane, rebar, hoarding } = THEMES.night;
    expect(scenario("factory", "structure").some(fill => fill.startsWith(`${rebar}:`) || fill.startsWith(`${crane}:`))).toBe(false);
    expect(scenario("factory", "empty").some(fill => fill.startsWith(`${hoarding}:`))).toBe(false);
  });

  it("WINDOW-4：细节不越出自己的楼段矩形（层高很矮时烟囱、水塔和窗带也不越界）", () => {
    setTheme("night");
    const { fills, ctx } = recorder();
    const snap = fixtureSnapshot(0);
    const base = snap.sites[0].bands[0];
    const floors = Array.from({ length: 30 }, (_, i) => ({ id: `S${i + 1}`, kind: "built" as const }));
    const short = { ...base, feature: "short", tarp: null, style: "factory" as const, stage: "done" as const, scaffold: [],
      plan: { floors: [{ id: "S1", kind: "built" as const }], firstUnfinished: null } };
    const tall = { ...base, feature: "tall", tarp: null, style: "tower" as const, stage: "done" as const, scaffold: [],
      plan: { floors, firstUnfinished: null } };
    const layout = layoutBuilding(withSite(snap, { bands: [short, tall], workers: [], office: [] }), 360);
    drawBuilding(ctx, layout, false);
    const rect = layout.bands[0];
    expect(rect.height).toBeLessThan(12);
    const inside = fills.filter(fill => {
      const [, y] = fill.slice(fill.indexOf(":") + 1).split(",").map(Number);
      return y >= rect.y && y < rect.y + rect.height;
    });
    expect(inside.length).toBeGreaterThan(0);
    // 楼体基座（.34）和设计师轮廓（.62）本来就压在段底，不算造型件越界
    const bad = inside.filter(fill => !fill.startsWith("rgba(5, 10, 15, .34):") && !fill.startsWith("rgba(5, 10, 15, .62):")
      && (() => {
        const [, y, , h] = fill.slice(fill.indexOf(":") + 1).split(",").map(Number);
        return y + h > rect.y + rect.height + 0.01;
      })());
    expect(bad).toEqual([]);
  });

  it("WINDOW-30：crown 楼段只画颜色和窗型，不叠退台、阳台和院子", () => {
    setTheme("night");
    const { fills, ctx } = recorder();
    const snap = fixtureSnapshot(0);
    const bands = snap.sites[0].bands.map(band => band.feature === "data-layer"
      ? { ...band, placement: "crown" as const, tarp: null, style: "tower" as const, stage: "done" as const } : band);
    const layout = layoutBuilding(withSite(snap, { bands }), 360);
    drawBuilding(ctx, layout, false);
    const crownBand = layout.bands.find(band => band.feature === "data-layer")!;
    const inBand = fills.filter(fill => {
      const [, y] = fill.slice(fill.indexOf(":") + 1).split(",").map(Number);
      return y >= crownBand.y && y < crownBand.y + crownBand.height;
    });
    expect(inBand.some(fill => fill.startsWith(`${GARDEN.leaf}:`) || fill.startsWith(`${GARDEN.bloom}:`))).toBe(false);
  });

  it("WINDOW-31：全楼只有一台塔吊，立在最高的主体段上", () => {
    setTheme("night");
    const crane = THEMES.night.crane;
    const { fills, ctx } = recorder();
    const snap = fixtureSnapshot(0);
    const bands = snap.sites[0].bands.map(band => band.placement === "crown" ? band : { ...band, stage: "structure" as const });
    const layout = layoutBuilding(withSite(snap, { bands }), 360);
    drawBuilding(ctx, layout, false);
    const top = layout.bands.findLast(band => band.placement === "band" && band.stage === "structure")!;
    const craneFills = fills.filter(fill => fill.startsWith(`${crane}:`))
      .map(fill => fill.slice(crane.length + 1).split(",").map(Number));
    expect(craneFills.length).toBeGreaterThan(0);
    for (const [, y] of craneFills) {
      expect(y).toBeGreaterThanOrEqual(Math.round(top.y));
      expect(y).toBeLessThanOrEqual(Math.round(top.y + top.height));
    }
  });

  it("围挡、钢筋、塔吊各只在对应阶段出现；篷布段和 crown 不画", () => {
    setTheme("night");
    const { hoarding, rebar, crane } = THEMES.night;
    const has = (stage: BuildStage, color: string, patch: Partial<Band> = {}): boolean =>
      oneBand(stage, patch).some(fill => fill.startsWith(`${color}:`));
    expect([has("empty", hoarding), has("empty", crane)]).toEqual([true, false]);
    expect([has("foundation", rebar), has("foundation", crane)]).toEqual([true, false]);
    expect([has("structure", rebar), has("structure", crane)]).toEqual([true, true]);
    expect([has("done", hoarding), has("done", rebar), has("done", crane)]).toEqual([false, false, false]);
    expect(has("structure", crane, { tarp: "图纸读不出" })).toBe(false);
    expect(has("structure", crane, { placement: "crown" })).toBe(false);
  });

  it("顶层不是 tower 时，围挡 / 地基阶段也照样有造型窗；门和雨棚等主体以后", () => {
    setTheme("night");
    const windowFill = "rgba(5, 10, 15, .58)";
    const has = (color: string, stage: BuildStage): boolean =>
      oneBand(stage, { style: "factory" }).some(fill => fill.startsWith(`${color}:`));
    const stages = ["empty", "foundation", "structure", "done"] as const;
    expect(stages.map(stage => has(windowFill, stage))).toEqual([true, true, true, true]);
    expect(stages.map(stage => has(THEMES.night.shutter, stage))).toEqual([false, false, true, true]);
  });
});
