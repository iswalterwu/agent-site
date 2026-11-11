/** 托盘和窗内菜单共用的开关；默认不打扰、不透明、开贴边隐藏 */
export interface AppModes {
  autoHide: boolean;
  translucent: boolean;
  waitingDot: boolean;
  demo: boolean;
  dnd: boolean;
  pauseAnimation: boolean;
}

export type ModeAction = "auto-hide" | "translucent" | "waiting-dot" | "demo" | "dnd" | "pause-animation";

export const DEFAULT_MODES: AppModes = {
  autoHide: true, translucent: false, waitingDot: true, demo: false, dnd: false, pauseAnimation: false,
};

export function isModeAction(action: string): action is ModeAction {
  return action === "auto-hide" || action === "translucent" || action === "waiting-dot"
    || action === "demo" || action === "dnd" || action === "pause-animation";
}

export function toggleMode(modes: AppModes, action: ModeAction): AppModes {
  switch (action) {
    case "auto-hide": return { ...modes, autoHide: !modes.autoHide };
    case "translucent": return { ...modes, translucent: !modes.translucent };
    case "waiting-dot": return { ...modes, waitingDot: !modes.waitingDot };
    case "demo": return { ...modes, demo: !modes.demo };
    case "dnd": return { ...modes, dnd: !modes.dnd };
    case "pause-animation": return { ...modes, pauseAnimation: !modes.pauseAnimation };
  }
}

export function modeEnabled(modes: AppModes, action: ModeAction): boolean {
  switch (action) {
    case "auto-hide": return modes.autoHide;
    case "translucent": return modes.translucent;
    case "waiting-dot": return modes.waitingDot;
    case "demo": return modes.demo;
    case "dnd": return modes.dnd;
    case "pause-animation": return modes.pauseAnimation;
  }
}

/** 勿扰和“等待橙点”都关着才亮橙点 */
export function showWaitingDot(modes: AppModes, waiting: boolean): boolean {
  return waiting && modes.waitingDot && !modes.dnd;
}

/** 勿扰也停闪烁；暂停动画只停闪烁 */
export function animationsPaused(modes: AppModes): boolean {
  return modes.pauseAnimation || modes.dnd;
}

/** 半透明只在指针离开整窗时生效；不改变穿透 */
export function windowOpacity(modes: AppModes, hovered: boolean): number {
  return modes.translucent && !hovered ? 0.42 : 1;
}
