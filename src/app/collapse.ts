import type { Ribbon, SiteSnapshot } from "../core/types";
import type { BuildingLayout, Rect } from "./layout";

/** 收起彩带只有 8 逻辑 px，贴在窗口右缘 */
export const RIBBON_WIDTH = 8;

/** 摘要悬停多久后锁定；与右下角环的动画时长共用 */
export const SUMMARY_LOCK_MS = 5000;

export interface RibbonSegment extends Rect {
  feature: string;
  ribbon: Ribbon;
}

/** 彩带段和楼段同序、同高；每段顶部留 0.5 px 缝 */
export function ribbonSegments(layout: BuildingLayout): RibbonSegment[] {
  return layout.bands.map(band => ({
    feature: band.feature, ribbon: band.ribbon,
    x: layout.width - RIBBON_WIDTH, y: band.y, width: RIBBON_WIDTH, height: Math.max(1, band.height - 0.5),
  }));
}

export function segmentAt(segments: readonly RibbonSegment[], y: number): RibbonSegment | null {
  return segments.find(segment => y >= segment.y && y < segment.y + segment.height) ?? null;
}

/** 卡片开着时不自动收起；有人在等也照收，彩带会闪橙色提示 */
export function canAutoCollapse(snapshot: SiteSnapshot | null, cardOpen: boolean): boolean {
  return snapshot !== null && !cardOpen;
}

/** 指针在外面、已展开、且没有等待 / 卡片时才重新计时；还没进过整窗时不收 */
export function shouldScheduleCollapse(pointerInside: boolean, collapsed: boolean,
  snapshot: SiteSnapshot | null, cardOpen: boolean, autoHide: boolean, entered = true): boolean {
  return entered && autoHide && !pointerInside && !collapsed && canAutoCollapse(snapshot, cardOpen);
}

/** 摘要卡贴在彩带左边，3× 按卡片倍率放大；垂直跟着彩带段并夹在窗口内 */
export function summaryBox(segment: { y: number; height: number }, scale: number, cssWidth: number,
  cssHeight: number, width: number, height: number): Rect {
  const center = (segment.y + segment.height / 2) * scale;
  const y = Math.max(8, Math.min(center - height / 2, cssHeight - height - 8));
  return { x: cssWidth - RIBBON_WIDTH * scale - width, y, width, height };
}
