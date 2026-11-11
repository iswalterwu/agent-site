import { LOGICAL_WIDTH } from "./constants";
import { WINDOW_MAX_HEIGHT } from "./theme";

export interface WorkArea { x: number; y: number; width: number; height: number }
export interface WindowBounds { x: number; y: number; width: number; height: number }
export type AppScale = 2;
/** 卡片位一直预留在窗口左边：卡片开关不改窗口尺寸，透明窗口改尺寸会闪一帧 */
export const CARD_WIDTH = 300;

/** 贴工作区右缘；宽度 = 楼体宽度 + 卡片位，高度不超过 720 CSS px，剩余空间上下均分。 */
export function windowBounds(workArea: WorkArea, scale: AppScale): WindowBounds {
  const width = LOGICAL_WIDTH * scale + CARD_WIDTH;
  const height = Math.min(workArea.height, WINDOW_MAX_HEIGHT);
  const y = workArea.y + (workArea.height - height) / 2;
  return { x: Math.floor(workArea.x + workArea.width - width), y: Math.floor(y), width,
    height: Math.floor(height) };
}

/**
 * 拖动结束时的吸附：右缘在阈值内或已经越过就贴到工作区右缘，离得远返回 null。
 * workArea 取窗口多数所在的屏；宽高按 App 的目标值回正，不回读系统给的 bounds
 * （那里可能已经被撑大）；x 取整数 DIP，和 windowBounds 一致，小数位置会让系统再撑大 1 px。
 */
export function snapBounds(bounds: WindowBounds, workArea: WorkArea, width: number, threshold = 24): WindowBounds | null {
  const right = workArea.x + workArea.width;
  if (bounds.x + bounds.width < right - threshold) return null;
  return { x: Math.floor(right - width), y: bounds.y, width, height: bounds.height };
}

/** 渲染层的逻辑高度：窗口高度 / 放大倍数 */
export function logicalHeight(workArea: WorkArea, scale: AppScale): number {
  return Math.min(workArea.height, WINDOW_MAX_HEIGHT) / scale;
}
