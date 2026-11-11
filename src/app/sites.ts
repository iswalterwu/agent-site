// 工地的选择：默认跟"最近有事件"的那个（引擎算好的 active），钉住时以钉的为准。
import type { SiteSnapshot } from "../core/types";

export interface PinnedSite { pinned: string | null; snapshot: SiteSnapshot }

/**
 * 把钉住的工地套到快照上。钉住只是覆盖 active，工地自己消失时回到自动跟随。
 * 返回清空后的 pinned：调用方据此决定下次还用不用钉。
 */
export function applyPin(snapshot: SiteSnapshot, pinned: string | null): PinnedSite {
  if (pinned === null) return { pinned: null, snapshot };
  if (!snapshot.sites.some(site => site.key === pinned)) return { pinned: null, snapshot };
  return { pinned, snapshot: snapshot.active === pinned ? snapshot : { ...snapshot, active: pinned } };
}
