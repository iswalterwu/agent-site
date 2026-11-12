import { describe, expect, it } from "vitest";
import { chooseDisplay, chooseRightDisplay, displayView } from "../../src/app/display";

// workArea 是 Electron 给的 DIP：1080p 全屏和 4K 150% 各一块，第二块贴在右边。
const laptop = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const external = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1392 }, scaleFactor: 1.5 };

describe("显示器与窗口", () => {
  it("主屏 1920×1040 时窗口贴右缘并垂直居中", () => {
    const { view, bounds } = displayView(laptop, 2, "night");
    expect(view).toEqual({ scale: 2, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, windowHeight: 720, theme: "night", locale: "zh-CN" });
    expect(bounds).toEqual({ x: 1400, y: 160, width: 520, height: 720 });
  });

  it("4K 150% 的屏工作区是 2560×1392 DIP，窗口仍贴右缘", () => {
    const { view, bounds } = displayView(external, 2, "night");
    expect(view.workArea).toEqual({ x: 1920, y: 0, width: 2560, height: 1392 });
    expect(view.windowHeight).toBe(720);
    expect(bounds).toEqual({ x: 1920 + 2560 - 520, y: 336, width: 520, height: 720 });
    expect(bounds.x + bounds.width).toBe(1920 + 2560);
  });

  it("混缩放时副屏用自己的 DIP 工作区，不再按缩放换算", () => {
    const right = { id: 11, workArea: { x: 2560, y: 0, width: 3840, height: 2160 }, scaleFactor: 1 };
    const { bounds } = displayView(right, 2, "night");
    expect(bounds.x + bounds.width).toBe(2560 + 3840);
    expect(bounds.height).toBe(720);
  });

  it("工作区不足 720 时窗口用满高度", () => {
    const short = { id: 3, workArea: { x: 0, y: 0, width: 1920, height: 600 }, scaleFactor: 1 };
    const { view, bounds } = displayView(short, 2, "night");
    expect(view.windowHeight).toBe(600);
    expect(bounds).toEqual({ x: 1400, y: 0, width: 520, height: 600 });
  });

  it("附着到右侧屏幕优先选当前屏右边最近的那块，没有就留最右屏", () => {
    expect(chooseRightDisplay([laptop, external], laptop.id).id).toBe(external.id);
    expect(chooseRightDisplay([laptop, external], external.id).id).toBe(external.id);
    expect(chooseRightDisplay([laptop], laptop.id).id).toBe(laptop.id);
  });

  it("默认跟随主屏；选定屏还在时留在选定屏；选定屏被拔掉时回主屏", () => {
    expect(chooseDisplay([laptop, external], 1, true, 2)).toBe(laptop);
    expect(chooseDisplay([laptop, external], 1, false, 2)).toBe(external);
    expect(chooseDisplay([laptop], 1, false, 2)).toBe(laptop);
  });
});
