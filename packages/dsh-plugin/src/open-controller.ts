import { OPEN_TIMEOUT_MS, parseOpenResult, type OpenError } from "../../../src/protocol/launch";

export type OpenState = { kind: "idle" | "pending" | "sent" } | { kind: "error"; code: OpenError };

/** 打开请求的界面状态，不持有进程，也不把传输成功当作 App 已就绪。 */
export class OpenController {
  private state: OpenState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private stopped = false;
  private active: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly call: (signal: AbortSignal) => Promise<unknown>) {}

  getSnapshot = (): OpenState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async open(): Promise<void> {
    if (this.stopped || this.state.kind === "pending") return;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.active = abort;
    this.update({ kind: "pending" });
    const timer = setTimeout(() => {
      if (this.stopped || this.generation !== generation) return;
      this.generation++;
      this.update({ kind: "error", code: "timeout" });
      abort.abort();
    }, OPEN_TIMEOUT_MS);
    this.timer = timer;
    try {
      const raw = await this.call(abort.signal);
      if (this.stopped || this.generation !== generation) return;
      const result = parseOpenResult(raw);
      this.update(result === null ? { kind: "error", code: "incompatible" }
        : result.status === "sent" ? { kind: "sent" } : { kind: "error", code: result.code });
    } catch {
      if (!this.stopped && this.generation === generation) this.update({ kind: "error", code: "disconnected" });
    } finally {
      clearTimeout(timer);
      if (this.timer === timer) this.timer = null;
      if (this.active === abort) this.active = null;
    }
  }

  dispose(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.active?.abort();
    this.listeners.clear();
  }

  private update(state: OpenState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
