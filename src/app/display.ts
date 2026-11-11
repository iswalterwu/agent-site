import type { AppView } from "./api";
import type { AppScale, WorkArea, WindowBounds } from "./window";
import { windowBounds } from "./window";
import type { ThemeName } from "./theme";

export interface DisplayInfo { id: number; workArea: WorkArea; scaleFactor: number }
export interface DisplayView { view: AppView; bounds: WindowBounds }

/**
 * 单台显示器的工作区，并算出贴右缘的窗口位置。
 * Electron 的 display.bounds / workArea 已经是 DIP（4K 150% 的屏报 2560 宽），不要再按 scaleFactor 除一次。
 */
export function displayView(display: DisplayInfo, scale: AppScale, theme: ThemeName): DisplayView {
  const bounds = windowBounds(display.workArea, scale);
  return { view: { scale, workArea: display.workArea, windowHeight: bounds.height, theme }, bounds };
}

/** 附着到右侧屏幕：优先选当前屏右边最近的那块；没有右侧屏时选最右的屏。 */
export function chooseRightDisplay<T extends DisplayInfo>(displays: readonly T[], currentId: number): T {
  const current = displays.find(display => display.id === currentId) ?? displays[0];
  if (current === undefined) throw new Error("no display");
  const toRight = displays.filter(display =>
    display.id !== current.id && display.workArea.x >= current.workArea.x + current.workArea.width);
  if (toRight.length > 0) {
    return toRight.reduce((best, display) => display.workArea.x < best.workArea.x ? display : best);
  }
  return displays.reduce((best, display) => display.workArea.x > best.workArea.x ? display : best, current);
}

/** 默认跟随主屏；用户用托盘选过屏幕后，只有那块屏还在时才留在那里。 */
export function chooseDisplay(
  displays: readonly DisplayInfo[],
  primaryId: number,
  followPrimary: boolean,
  targetId: number | null,
): DisplayInfo {
  const primary = displays.find(display => display.id === primaryId) ?? displays[0];
  if (primary === undefined) throw new Error("no display");
  if (followPrimary) return primary;
  return displays.find(display => display.id === targetId) ?? primary;
}
