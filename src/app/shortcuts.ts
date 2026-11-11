import type { BridgeSessionView } from "../main/bridge-service";
import type { SiteSnapshot } from "../core/types";

/**
 * 全局快捷键。用 `CommandOrControl` 让 mac 上是 ⌘、其余平台是 Ctrl；
 * Alt 是为了不和编辑器、终端的常用组合撞上。
 */
export const SHORTCUTS = {
  /** 显示 / 收起窗口 */
  toggleWindow: "CommandOrControl+Alt+S",
  /** 暂停 / 继续当前工地上所有能控制的会话 */
  pauseSite: "CommandOrControl+Alt+P",
} as const;

/** 当前工地的键：钉住的优先，否则跟快照里"最近有事件"的那栋楼 */
export function currentSiteKey(snapshot: SiteSnapshot, pinned: string | null): string | null {
  if (pinned !== null && snapshot.sites.some(site => site.key === pinned)) return pinned;
  return snapshot.active;
}

/** 这个工地上能控制（桥接在线、一级或二级）的会话 */
export function siteSessions(snapshot: SiteSnapshot, sessions: readonly BridgeSessionView[], siteKey: string | null): BridgeSessionView[] {
  if (siteKey === null) return [];
  const site = snapshot.sites.find(item => item.key === siteKey);
  if (site === undefined) return [];
  const keys = new Set(site.workers.map(worker => worker.key));
  return sessions.filter(session => keys.has(session.key) && session.controllable);
}

/** 快捷键该做什么：有人在暂停就继续，否则全部暂停；这个工地没有能控制的会话时什么都不做 */
export function pauseIntent(sessions: readonly BridgeSessionView[]): "pause" | "resume" | "none" {
  if (sessions.length === 0) return "none";
  return sessions.some(session => session.paused) ? "resume" : "pause";
}
