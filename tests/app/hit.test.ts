import { expect, it } from "vitest";
import { hitWindow, windowContains } from "../../src/app/hit";

const bounds = { x: 1486, y: 104, width: 220, height: 720 };
const rects = [
  { x: 0, y: 0, width: 220, height: 32 },
  { x: 0, y: 680, width: 220, height: 40 },
  { x: 16, y: 48, width: 188, height: 600 },
];

it("光标是窗口所在屏幕的 DIP 坐标，直接和 CSS 矩形比较", () => {
  // 1680-1486=194, 200-104=96，落在楼体
  expect(hitWindow({ x: 1680, y: 200 }, bounds, rects)).toBe(true);
  // 顶栏和右下角齿轮所在的底栏
  expect(hitWindow({ x: 1680, y: 110 }, bounds, rects)).toBe(true);
  expect(hitWindow({ x: 1680, y: 700 }, bounds, rects)).toBe(true);
  // 左侧透明边、顶部外面、窗口下面
  expect(hitWindow({ x: 1490, y: 200 }, bounds, rects)).toBe(false);
  expect(hitWindow({ x: 1680, y: 100 }, bounds, rects)).toBe(false);
  expect(hitWindow({ x: 1680, y: 830 }, bounds, rects)).toBe(false);
});

it("窗口最高 600 时，底栏命中按实际高度算", () => {
  const short = { x: 0, y: 0, width: 220, height: 600 };
  const footer = [{ x: 0, y: 560, width: 220, height: 40 }];
  expect(hitWindow({ x: 196, y: 580 }, short, footer)).toBe(true);
  expect(hitWindow({ x: 196, y: 680 }, short, footer)).toBe(false);
});

it("整窗悬停看窗口矩形，不看命中矩形", () => {
  const area = { x: 100, y: 50, width: 220, height: 720 };
  expect(windowContains({ x: 150, y: 100 }, area)).toBe(true);
  expect(windowContains({ x: 100, y: 50 }, area)).toBe(true);
  expect(windowContains({ x: 319, y: 769 }, area)).toBe(true);
  expect(windowContains({ x: 320, y: 400 }, area)).toBe(false);
  expect(windowContains({ x: 200, y: 770 }, area)).toBe(false);
});
