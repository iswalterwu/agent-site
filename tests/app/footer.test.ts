import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "../../src/app/fixture";
import { layoutFooter, workerTone } from "../../src/app/footer";
import { LOGICAL_WIDTH } from "../../src/app/constants";
import type { FooterEntry } from "../../src/app/footer";
import type { Worker } from "../../src/core/types";

const base = fixtureSnapshot(0).sites[0].workers[0];
const worker = (key: string, patch: Partial<Worker> = {}): Worker => ({ ...structuredClone(base), key, ...patch });
/** 底栏灯是按全部工地混排的：单工地测试统一挂在 main 这个工地下 */
const entries = (workers: Worker[], site = "main"): FooterEntry[] => workers.map(item => ({ worker: item, site }));

describe("底栏图例与灯", () => {
  it("A8：图例固定 5 色、只有一行，标签顺序和优先级一致", () => {
    const footer = layoutFooter([], 520);
    expect(footer.legend.map(item => [item.label, item.tone])).toEqual([
      ["等你", "waiting"], ["出错", "error"], ["停工", "stalled"], ["在干", "working"], ["空闲", "idle"]]);
    expect(footer.legend.every(item => item.y === footer.legend[0].y)).toBe(true);
    const last = footer.legend.at(-1);
    expect(last!.x + last!.width).toBeLessThan(LOGICAL_WIDTH - 8);
  });

  it("A8：灯按等你 > 出错 > 停工 > 在干 > 空闲排序，只读保留", () => {
    const workers = [
      worker("idle", { status: "idle" }),
      worker("working", { status: "working" }),
      worker("stalled", { status: "stalled" }),
      worker("error", { status: "working", lastTestFailure: { at: 0, text: "vitest ✗ 1" } }),
      worker("waiting", { status: "waiting", readOnly: false }),
    ];
    const footer = layoutFooter(entries(workers), 520);
    expect(footer.lights.map(light => light.key)).toEqual(["waiting", "error", "stalled", "working", "idle"]);
    expect(footer.lights[0].readOnly).toBe(false);
    expect(footer.lights[1].readOnly).toBe(true);
  });

  it("A8：一排最多 6 个灯，多出来的写 +N，不越出底栏右界；每盏 2× 下至少 24×24 CSS", () => {
    const many = Array.from({ length: 8 }, (_, i) => worker(`s${i}`, { status: "working" }));
    const footer = layoutFooter(entries(many), 520);
    expect(footer.lights).toHaveLength(6);
    expect(footer.more).toEqual({ text: "+2", x: 81, y: footer.top + 15 });
    for (const light of footer.lights) {
      expect(light.x + light.width).toBeLessThanOrEqual(88);
      expect([light.width, light.height]).toEqual([12, 12]);
    }
    // 灯不叠在一起，也都在底栏 28 逻辑 px 里
    for (let i = 1; i < footer.lights.length; i++) {
      expect(footer.lights[i].x).toBeGreaterThanOrEqual(footer.lights[i - 1].x + footer.lights[i - 1].width);
    }
    expect(footer.lights[0].y + footer.lights[0].height).toBeLessThanOrEqual(footer.top + 28);
  });

  it("WINDOW-8：灯按全部工地混排，每盏记得自己属于哪个工地", () => {
    const a = worker("a1", { status: "working", statusSince: 10 });
    const b = worker("b1", { status: "waiting", statusSince: 20 });
    const footer = layoutFooter([...entries([a], "site-a"), ...entries([b], "site-b")], 520);
    // 等你排在在干前面，跟工地在哪个顺序无关
    expect(footer.lights.map(light => [light.key, light.site])).toEqual([["b1", "site-b"], ["a1", "site-a"]]);
  });
  it("A8：等你优先于出错；出错优先于停工；没有对应状态时归空闲", () => {
    expect(workerTone(worker("a", { status: "waiting", lastTestFailure: { at: 0, text: "x" } }))).toBe("waiting");
    expect(workerTone(worker("b", { status: "stalled", lastTestFailure: { at: 0, text: "x" } }))).toBe("error");
    expect(workerTone(worker("c", { status: "working", actions: [{ kind: "api_error", at: 0, text: "API 报错" }] }))).toBe("error");
    expect(workerTone(worker("d", { status: "stalled" }))).toBe("stalled");
    expect(workerTone(worker("e", { status: "idle" }))).toBe("idle");
  });
});
