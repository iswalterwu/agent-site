import { ribbonColor } from "../core/building";
import type { SiteSnapshot, SiteView, Worker } from "../core/types";

/** 楼体只画最近六小时有动静的等待 / 空闲会话；更早的留在快照和诊断里，不占楼体和灯 */
export const STALE_WORKER_MS = 6 * 3_600_000;

function stale(worker: Worker, now: number): boolean {
  return (worker.status === "waiting" || worker.status === "idle")
    && now - worker.statusSince > STALE_WORKER_MS;
}

/** 一个工地里去掉过期的等待 / 空闲会话；没东西可去时原样返回，保持快照的引用不变 */
function visibleSite(site: SiteView, now: number): SiteView {
  const workers = site.workers.filter(worker => !stale(worker, now));
  const keys = new Set(workers.map(worker => worker.key));
  const waiting = site.designer.waiting.filter(item => keys.has(item.key));
  if (workers.length === site.workers.length && waiting.length === site.designer.waiting.length) return site;
  const byFeature = new Map<string, Worker[]>();
  for (const worker of workers) {
    if (worker.location.kind !== "band") continue;
    const list = byFeature.get(worker.location.feature) ?? [];
    list.push(worker);
    byFeature.set(worker.location.feature, list);
  }
  return {
    ...site,
    workers,
    bands: site.bands.map(band => ({ ...band,
      ribbon: ribbonColor(band.card.status, byFeature.get(band.feature) ?? []) })),
    designer: { waiting },
  };
}

/** 上一次的结果：同一份源、同一组可见项时复用同一个对象，渲染层就不会重推 */
let lastSource: SiteSnapshot | null = null;
let lastVisible: SiteSnapshot | null = null;

export function visibleSnapshot(snapshot: SiteSnapshot, now = snapshot.at): SiteSnapshot {
  const sites = snapshot.sites.map(site => visibleSite(site, now));
  if (sites.every((site, index) => site === snapshot.sites[index])) {
    lastSource = snapshot;
    lastVisible = snapshot;
    return snapshot;
  }
  const next = { ...snapshot, sites };
  if (snapshot === lastSource && lastVisible !== null && sameVisible(lastVisible, next)) return lastVisible;
  lastSource = snapshot;
  lastVisible = next;
  return next;
}

/** 可见项按引用比较：worker 和等待项都是同一批对象时不必重推 */
function sameVisible(a: SiteSnapshot, b: SiteSnapshot): boolean {
  return a.sites.length === b.sites.length && a.sites.every((site, index) => {
    const other = b.sites[index]!;
    return sameItems(site.workers, other.workers) && sameItems(site.designer.waiting, other.designer.waiting);
  });
}

const sameItems = <T,>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);
