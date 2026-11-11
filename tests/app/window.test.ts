import { describe, expect, it } from "vitest";
import { logicalHeight, snapBounds, windowBounds } from "../../src/app/window";

describe("窗口几何", () => {
  it("贴右缘，最高 720，剩余空间上下均分；宽度是楼体宽加卡片位，固定 2×", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(windowBounds(area, 2)).toEqual({ x: 1400, y: 160, width: 520, height: 720 });
  });

  it("工作区不足 720 时用满高度；保留工作区偏移", () => {
    const area = { x: 100, y: 50, width: 1600, height: 900 };
    expect(windowBounds(area, 2)).toEqual({ x: 1180, y: 140, width: 520, height: 720 });
    expect(logicalHeight(area, 2)).toBe(360);
    expect(windowBounds({ x: 0, y: 0, width: 800, height: 600 }, 2)).toEqual({ x: 280, y: 0, width: 520, height: 600 });
  });

  it("工作区宽度是小数 DIP 时向下取整贴右缘", () => {
    const area = { x: 0, y: 0, width: 2560 / 1.5, height: 1392 / 1.5 };
    expect(windowBounds(area, 2)).toEqual({ x: 1186, y: 104, width: 520, height: 720 });
  });
});

describe("卡片位", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };

  it("窗口永远留着 300 的卡片位，右缘不动", () => {
    const bounds = windowBounds(area, 2);
    expect(bounds.width).toBe(220 + 300);
    expect(bounds.x + bounds.width).toBe(area.width);
  });
});

describe("WINDOW-10 拖到右缘吸附", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1032 };
  const rightScreen = { x: 1920, y: 0, width: 1920, height: 1032 };
  const at = (x: number, width = 220) => ({ x, y: 156, width, height: 720 });

  it("离右缘 24 px 内吸到右缘", () => {
    expect(snapBounds(at(1682), area, 220)).toEqual({ x: 1700, y: 156, width: 220, height: 720 });
    expect(snapBounds(at(1700), area, 220)).toEqual({ x: 1700, y: 156, width: 220, height: 720 });
    expect(snapBounds(at(1676), area, 220)).toEqual({ x: 1700, y: 156, width: 220, height: 720 });
  });

  it("离右缘超过 24 px 时不吸", () => {
    expect(snapBounds(at(1675), area, 220)).toBeNull();
    expect(snapBounds(at(1600), area, 220)).toBeNull();
  });

  it("越过右缘也吸回，拖到屏外也找回", () => {
    expect(snapBounds(at(1800), area, 220)?.x).toBe(1700);
    expect(snapBounds(at(1920), area, 220)?.x).toBe(1700);
  });

  it("窗口多数移到右侧屏后按那块屏算，不吸回左屏", () => {
    expect(snapBounds(at(1800), area, 220)?.x).toBe(1700);
    expect(snapBounds(at(1820), rightScreen, 220)).toBeNull();
  });

  it("工作区宽度带小数时吸附到整数 DIP", () => {
    const fractional = { x: 0, y: 0, width: 2560 / 1.5, height: 1392 / 1.5 };
    expect(windowBounds(fractional, 2).x).toBe(1186);
    expect(snapBounds(at(1470), fractional, 220)?.x).toBe(1486);
  });

  it("窗口宽 520 时按整窗吸到右缘", () => {
    expect(snapBounds(at(1380, 520), area, 520)?.x).toBe(1400);
    expect(snapBounds(at(1500, 520), area, 520)?.x).toBe(1400);
  });

  it("吸附只动 x，宽高按 App 的目标值回正", () => {
    expect(snapBounds(at(1800, 221), area, 220)).toEqual({ x: 1700, y: 156, width: 220, height: 720 });
    expect(snapBounds(at(1380, 520), area, 520)).toEqual({ x: 1400, y: 156, width: 520, height: 720 });
  });
});
