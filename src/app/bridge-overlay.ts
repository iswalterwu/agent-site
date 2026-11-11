// 把桥接在线状态叠到只读快照上：App 核心只算日志，这里只做投影。
// 只有握手的 session.level 属于一级 / 二级的 pi 会话才放开控制；三级 / 其他来源保持只读。
import { normalizePath } from "../bridge/scope";
import type { BridgeSessionView } from "../main/bridge-service";
import type { SiteSnapshot, Worker, WorkerControl } from "../core/types";

export function applyBridgeControl(snapshot: SiteSnapshot, sessions: readonly BridgeSessionView[]): SiteSnapshot {
  if (sessions.length === 0) return snapshot;
  // 会话键是桥接握手时给的；日志里的 key 来自文件头。两者应当相同，但文件名、大小写或前缀
  // 对不上时不能把在线的 pi 会话误判成只读：同一个会话文件是更硬的证据。
  const online = new Map<string, BridgeSessionView>();
  const byFile = new Map<string, BridgeSessionView>();
  for (const session of sessions) {
    if (!session.online) continue;
    online.set(session.key, session);
    if (session.info.file !== undefined) byFile.set(normalizePath(session.info.file), session);
  }
  let changed = false;
  const sites = snapshot.sites.map(site => {
    const workers = site.workers.map(worker => {
      const session = online.get(worker.key) ?? byFile.get(normalizePath(worker.file));
      if (worker.harness !== "pi" || session === undefined || !session.controllable) return worker;
      changed = true;
      const control: WorkerControl = { online: true, paused: session.paused, holding: session.holding, idle: session.idle };
      return { ...worker, readOnly: false, control };
    });
    return { ...site, workers };
  });
  return changed ? { ...snapshot, sites } : snapshot;
}
