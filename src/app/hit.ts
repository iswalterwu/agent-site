import type { AppRect } from "./api";

interface Point { x: number; y: number }
interface Bounds extends Point { width: number; height: number }

/** 光标和窗口边界都取屏幕坐标（DIP），直接和渲染层上报的 CSS 命中矩形比较。 */
export function windowContains(point: Point, bounds: Bounds): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

export function hitWindow(point: Point, bounds: Bounds, rects: readonly AppRect[]): boolean {
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  return rects.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}
