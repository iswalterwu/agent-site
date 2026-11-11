import type { LayoutWorker } from "./layout";

/** 上一次画的人里，这次快照已经没有的，就是收工要走的人 */
export function departedWorkers(previous: readonly LayoutWorker[], current: readonly LayoutWorker[]): LayoutWorker[] {
  const live = new Set(current.map(worker => worker.key));
  return previous.filter(worker => !live.has(worker.key));
}

/** 走出窗口用时；走完从列表里删掉 */
export const WALK_OUT_MS = 900;

export function exitProgress(started: number, now: number): number {
  return Math.max(0, Math.min(1, (now - started) / WALK_OUT_MS));
}

/** 从站的位置走到窗口右缘外面 */
export function exitX(worker: Pick<LayoutWorker, "x">, windowWidth: number, progress: number): number {
  return worker.x + (windowWidth + 6 - worker.x) * progress;
}

/** 走到 70% 开始淡出，到右缘时刚好消失 */
export function exitAlpha(progress: number): number {
  return progress < 0.7 ? 1 : Math.max(0, 1 - (progress - 0.7) / 0.3);
}
