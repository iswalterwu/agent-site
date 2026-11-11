import { describe, expect, it } from "vitest";
import { animationsPaused, DEFAULT_MODES, isModeAction, modeEnabled, showWaitingDot, toggleMode, windowOpacity } from "../../src/app/modes";

describe("托盘开关", () => {
  it("默认开贴边隐藏和等待橙点，半透明 / 演示 / 勿扰 / 暂停动画关", () => {
    expect(DEFAULT_MODES).toEqual({ autoHide: true, translucent: false, waitingDot: true,
      demo: false, dnd: false, pauseAnimation: false });
    expect(modeEnabled(DEFAULT_MODES, "auto-hide")).toBe(true);
    expect(modeEnabled(DEFAULT_MODES, "translucent")).toBe(false);
  });

  it("切换只改一个开关，不原地改旧对象", () => {
    const next = toggleMode(DEFAULT_MODES, "translucent");
    expect(next.translucent).toBe(true);
    expect(DEFAULT_MODES.translucent).toBe(false);
    expect(toggleMode(next, "dnd")).toEqual({ ...next, dnd: true });
    expect(isModeAction("auto-hide")).toBe(true);
    expect(isModeAction("diagnostics")).toBe(false);
  });

  it("勿扰或等待橙点关闭时不亮橙点", () => {
    expect(showWaitingDot(DEFAULT_MODES, true)).toBe(true);
    expect(showWaitingDot(DEFAULT_MODES, false)).toBe(false);
    expect(showWaitingDot({ ...DEFAULT_MODES, waitingDot: false }, true)).toBe(false);
    expect(showWaitingDot({ ...DEFAULT_MODES, dnd: true }, true)).toBe(false);
  });

  it("勿扰和暂停动画都停闪烁；半透明只在指针在外时生效", () => {
    expect(animationsPaused(DEFAULT_MODES)).toBe(false);
    expect(animationsPaused({ ...DEFAULT_MODES, pauseAnimation: true })).toBe(true);
    expect(animationsPaused({ ...DEFAULT_MODES, dnd: true })).toBe(true);
    expect(windowOpacity({ ...DEFAULT_MODES, translucent: true }, false)).toBe(0.42);
    expect(windowOpacity({ ...DEFAULT_MODES, translucent: true }, true)).toBe(1);
    expect(windowOpacity(DEFAULT_MODES, false)).toBe(1);
  });
});
