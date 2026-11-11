// 暂停闸门：桌面应用让 agent 暂停时，把它的下一次工具调用挂起，直到继续、给建议、中断或断线放行。
// 纯逻辑，不依赖 pi。未暂停时 check 同步返回放行，不产生 Promise。

export type GateDecision = { kind: "allow" } | { kind: "block"; reason: string };

export const SUGGEST_PREFIX = "设计师暂停了这一步，并建议：";
export const ABORT_REASON = "设计师中断了这一步。";
/** 会话结束或重载时，被挂起的调用以这个理由拦下：设计师暂停的这一步不能在收尾时执行 */
export const SHUTDOWN_REASON = "会话结束或重载，这一步没有执行。";

interface HeldCall { tool: string; since: number; resolve: (decision: GateDecision) => void }
// 每次订阅一个独立对象：同一个函数订阅两次时，各自的取消函数只删自己那一份
interface Subscription { listener: () => void }

export class PauseGate {
  private readonly now: () => number;
  private isPaused = false;
  private held: HeldCall[] = [];
  private readonly subscriptions = new Set<Subscription>();

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** 最早被挂起的那次调用；sinceMs 是它被挂起时 now() 的值 */
  get holding(): { tool: string; sinceMs: number } | undefined {
    const oldest = this.held[0];
    return oldest === undefined ? undefined : { tool: oldest.tool, sinceMs: oldest.since };
  }

  /** 未暂停时同步返回放行；暂停时挂起，直到 resume / suggest / abort / releaseAll 兑现它 */
  check(tool: string): GateDecision | Promise<GateDecision> {
    if (!this.isPaused) return { kind: "allow" };
    return new Promise<GateDecision>((resolve) => {
      this.held.push({ tool, since: this.now(), resolve });
      this.notify();
    });
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.notify();
  }

  resume(): void {
    this.settleAll({ kind: "allow" });
  }

  /** 有挂起：全部拦下并带上建议，返回 true；没有挂起：返回 false。两种情况都解除暂停 */
  suggest(text: string): boolean {
    const hadHeld = this.held.length > 0;
    this.settleAll({ kind: "block", reason: SUGGEST_PREFIX + text });
    return hadHeld;
  }

  /** 全部拦下（默认以中断的理由）并解除暂停 */
  abort(reason: string = ABORT_REASON): void {
    this.settleAll({ kind: "block", reason });
  }

  /** 断线放行 */
  releaseAll(): void {
    this.settleAll({ kind: "allow" });
  }

  /** paused 或 holding 变化时通知；返回取消订阅的函数 */
  onChange(listener: () => void): () => void {
    const subscription: Subscription = { listener };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** 兑现全部挂起的调用，清空挂起并解除暂停；只有状态真的变了才通知 */
  private settleAll(decision: GateDecision): void {
    const wasPaused = this.isPaused;
    const released = this.held;
    this.held = [];
    this.isPaused = false;
    for (const { resolve } of released) resolve(decision);
    if (wasPaused) this.notify();
  }

  private notify(): void {
    for (const { listener } of [...this.subscriptions]) {
      try {
        listener();
      } catch {
        // 监听器出错不能影响闸门：状态已经更新，其余监听器照常收到通知
      }
    }
  }
}
