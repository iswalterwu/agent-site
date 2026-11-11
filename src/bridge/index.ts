// site-bridge 扩展的入口：把暂停与控制（control）、ask_designer（ask）、事件上报（events）、作用域判断（scope）、
// 层级传递（lineage）和到工地的连接（link）装成一个 pi 扩展。它装在全局，所有 pi 会话都会加载：
// 会话开始时找 bridge.json、判断工作目录是否属于被监视的仓库，属于才激活 —— 给子进程导出层级、订阅事件上报、注册 ask_designer、
// 连上工地；不属于就什么都不做，连事件都不订阅、ask_designer 都不注册（见 docs/architecture.md「桥接扩展 site-bridge」）。所有处理函数和定时器里的代码都用 safe 包住，绝不抛进 pi；
// 除断线宽限定时器外，定时器都 unref，不拖住 pi 进程。宽限定时器故意不 unref：print / json 模式里工地断线之后，
// 只有它能让进程等到宽限结束、放行挂起的调用；连上和会话结束时都会清掉它，正常退出不受影响（见 offline）。不写任何文件。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BridgeToSite, EventKind, SessionInfo, SiteToBridge } from "../protocol/v2";
import { registerAskDesigner } from "./ask";
import { installControl } from "./control";
import type { Control } from "./control";
import { installEventForwarding } from "./events";
import { SHUTDOWN_REASON } from "./gate";
import { ENV_LEVEL, ENV_PARENT, exportLineage, readLineage } from "./lineage";
import { DEFAULT_TIMINGS, SiteLink, bridgeFilePath, later, readBridgeFile } from "./link";
import type { LinkTimings } from "./link";
import { safe } from "./safe";
import { resolveWatchedRepo } from "./scope";
import { TODO_TOOL, registerTodo } from "./todo";

type Env = Record<string, string | undefined>;

/** 关掉整个桥接的环境变量：产品运行时或测试不想被接上时设 AGENT_SITE_BRIDGE=off */
export const ENV_SWITCH = "AGENT_SITE_BRIDGE";

/** 开关是不是关着。只认 off（不分大小写、忽略首尾空白）；其它取值都当没设，免得 "0"、"false" 这些拼法各说各话 */
export function bridgeDisabled(env: Env): boolean {
  return (env[ENV_SWITCH] ?? "").trim().toLowerCase() === "off";
}

export interface BridgeDeps {
  /** 默认 process.env（测试传普通对象，避免改全局） */
  env?: Env;
  /** 连接的各项时间，外加断线宽限 graceMs（默认 60000） */
  timings?: Partial<LinkTimings> & { graceMs?: number };
  /** 查 git 公共目录（判断 worktree 用）；默认真的去问 git */
  commonDir?: (cwd: string) => Promise<string | null>;
}

const DEFAULT_GRACE_MS = 60_000;
const ASK_TOOL = "ask_designer";

type Command = Extract<SiteToBridge, { cmdId: string }>; // pause / resume / abort / suggest
type Ack = Extract<BridgeToSite, { type: "ack" }>;

/** 一个扩展实例（一个 pi 运行时）里各会话共用的部件和配置 */
interface Shared {
  pi: ExtensionAPI;
  control: Control;
  env: Env;
  timings: Partial<LinkTimings>;
  retryMs: number;
  graceMs: number;
  commonDir: ((cwd: string) => Promise<string | null>) | undefined;
  /** 执行工地的一条指令，返回给工地的回执 */
  execute: (cmd: Command) => Ack;
  /** 让模型看得到（被监视的会话）或看不到 ask_designer */
  showAsk: (wanted: boolean) => void;
  /** 让模型看得到（被监视的一级会话）或看不到 site_todo */
  showTodo: (wanted: boolean) => void;
}

export function createSiteBridge(deps: BridgeDeps = {}): (pi: ExtensionAPI) => void {
  const env = deps.env ?? process.env;
  // 开关在入口就判断：关掉时连控制模块都不装，代价是零。子进程从环境里继承它，不用另外导出
  if (bridgeDisabled(env)) return () => {};
  const { graceMs = DEFAULT_GRACE_MS, ...timings } = deps.timings ?? {};
  const retryMs = timings.retryMs ?? DEFAULT_TIMINGS.retryMs;

  // 工厂绝不能把异常抛进 pi 的加载器：工厂一抛错 pi 就以退出码 1 退出，而桥接装在全局，那样所有会话都起不来（硬性要求 1）。
  // 装到一半出错，桥接就不起作用：会话的入口 session_start 最后才订阅，在它之前装上的部分没有会话时什么都不做
  return safe((pi: ExtensionAPI) => {
    // 控制在这里装一次，各会话共用；会话自己的状态在 session_start 时新建、session_shutdown 时拆掉，事件上报等会话激活时才订阅
    let session: BridgeSession | undefined;
    // Control 的方法从不抛出，出错时把错误交给 onError；执行一条指令期间记下的，就是这条指令失败的原因
    let controlError: unknown;
    const control = installControl(pi, {
      onInject: (text) => session?.noteInjected(text),
      onError: (e) => { controlError = e; },
    });
    control.gate.onChange(() => session?.sendState());

    // ask_designer 等到会话确认属于被监视的仓库才注册，每个扩展实例至多注册一次（pi 注册 model-only 工具时就启用它）：
    // 不属于的会话里根本没有这个工具，换分支（/tree）时 pi 按对话记录重算工具集也带不回来。
    // 只有同一个扩展实例先后遇到属于和不属于的会话（SDK 重新绑定扩展时才会）才需要改工具集；已经是想要的样子就不碰——
    // 停用工具会让 pi 丢掉还没注册上的待启用工具
    let askRegistered = false;
    const showAsk = (wanted: boolean): void => {
      if (!askRegistered) {
        if (!wanted) return;
        registerAskDesigner(pi, { site: () => session?.link ?? null });
        askRegistered = true;
        return;
      }
      const active = pi.getActiveTools();
      if (active.includes(ASK_TOOL) === wanted) return;
      pi.setActiveTools(wanted ? [...active, ASK_TOOL] : active.filter((name) => name !== ASK_TOOL));
    };

    // site_todo 只给一级会话：楼段按一级会话的待办生成（SITE-7），子 agent 的待办不进楼。
    // 和 ask_designer 一样，注册失败不能耽误连工地；注册后按需启用 / 收起，不重复注册。
    let todoRegistered = false;
    const showTodo = (wanted: boolean): void => {
      if (!todoRegistered) {
        if (!wanted) return;
        registerTodo(pi);
        todoRegistered = true;
        return;
      }
      const active = pi.getActiveTools();
      if (active.includes(TODO_TOOL) === wanted) return;
      pi.setActiveTools(wanted ? [...active, TODO_TOOL] : active.filter((name) => name !== TODO_TOOL));
    };

    const execute = (cmd: Command): Ack => {
      controlError = undefined;
      let ok: boolean;
      try {
        ok = runCommand(control, cmd) && controlError === undefined;
      } catch (e) {
        ok = false;
        controlError = e;
      }
      return ok ? { type: "ack", cmdId: cmd.cmdId, ok } : { type: "ack", cmdId: cmd.cmdId, ok, error: reasonOf(controlError) };
    };
    const shared: Shared = { pi, control, env, timings, retryMs, graceMs, commonDir: deps.commonDir, execute, showAsk, showTodo };

    // 闸门属于扩展实例：会话结束时拦下所有挂起的调用并解除暂停，下一个会话从未暂停开始。拦下而不是放行：pi 退出和重载时
    // 先发 session_shutdown 再中断这一轮（重载根本不中断），放行的话，设计师暂停的这一步会在收尾时执行。
    // 先拦（解除暂停的 state 趁还在线发出去），再收掉会话（告别）
    const endSession = () => {
      control.gate.abort(SHUTDOWN_REASON);
      session?.stop();
      session = undefined;
    };
    pi.on("session_shutdown", safe(endSession, undefined));
    pi.on("session_start", safe((_event: unknown, ctx: ExtensionContext) => {
      endSession(); // 没收到 session_shutdown 就又开始的会话（SDK 重新绑定扩展时会这样）：先收掉上一个
      // 新会话还没确认层级和范围，先收起 site_todo；一级会话确认后在 activate() 里再打开
      safe(showTodo, undefined)(false);
      session = new BridgeSession(shared, ctx);
      session.discover();
    }, undefined));
  }, undefined);
}

export default createSiteBridge();

/** 一个会话里桥接的全部状态。会话开始时建、结束时 stop，之后作废 */
class BridgeSession {
  /** 激活（确认属于被监视的仓库）之后才有 */
  link: SiteLink | null = null;
  private readonly shared: Shared;
  private readonly ctx: ExtensionContext;
  private readonly cwd: string;
  private readonly file: string;
  private readonly lineage: { parentId?: string; level: number };
  private stopped = false;
  private pollTimer: NodeJS.Timeout | undefined;
  /** 激活后定期复核范围：工地集合变小的时候要把自己断掉 */
  private scopeTimer: NodeJS.Timeout | undefined;
  /** 上次判范围用的 repos 拼串：没变、且上次判成了"在范围内"，就只等待，不重复跑 git */
  private lastScope: string | null = null;
  /** 上次判范围的结果；否定结果不能拿来跳过下一次，因为那次可能是 git 超时 */
  private lastInScope = false;
  private graceTimer: NodeJS.Timeout | undefined;
  private sessionId = "";
  private startedAt = "";
  private seq = 0;
  /** 导出层级之前子进程环境变量的原值（undefined = 本来没有这个键），会话结束时放回 */
  private inherited: Env | undefined;
  /** 激活时订阅的事件（见 watchAgent），会话结束时调用它退订 */
  private unwatch: (() => void) | undefined;
  /** 桥接交给 pi 的建议原文及次数：pi 把它作为用户消息记进对话时，凭原文认出来源，认一次划掉一次 */
  private readonly injected = new Map<string, number>();

  constructor(shared: Shared, ctx: ExtensionContext) {
    this.shared = shared;
    this.ctx = ctx;
    this.cwd = ctx.cwd;
    this.file = bridgeFilePath(shared.env);
    this.lineage = readLineage(shared.env);
  }

  /**
   * 找 bridge.json：读到了就判断作用域；不存在或无效、判成不在范围里，都隔 retryMs 再看一遍。
   * 工地集合会变（App 先启动、会话后开始；或者反过来），所以出范围不是一次定终身。
   */
  discover(): void {
    if (this.stopped) return;
    const file = readBridgeFile(this.file);
    if (file === null) {
      this.pollTimer = later(() => this.discover(), this.shared.retryMs);
      return;
    }
    const scope = file.repos.join("\n");
    if (scope === this.lastScope && this.lastInScope) {
      this.pollTimer = later(() => this.discover(), this.shared.retryMs);
      return;
    }
    this.lastScope = scope;
    void this.checkScope(file.repos);
  }

  /** 激活之前的事件一律丢弃；之后每条编号（从 1 起）交给连接。离线时连接会丢掉，所以编号有空缺就说明中间丢过 */
  emit(kind: EventKind, summary: string, detail?: Record<string, unknown>): void {
    if (this.link === null) return;
    this.seq += 1;
    this.link.send({ type: "event", sessionId: this.sessionId, seq: this.seq, ts: new Date().toISOString(), kind, summary,
      ...(detail === undefined ? {} : { detail }) });
  }

  /** 暂停与挂起的现状；离线时连接会丢掉，所以每次连上都要补发 */
  sendState(): void {
    const { gate } = this.shared.control;
    const holding = gate.holding;
    this.link?.send({ type: "state", sessionId: this.sessionId, paused: gate.paused, ...(holding === undefined ? {} : { holding }),
      idle: this.idle() });
  }

  noteInjected(text: string): void {
    this.injected.set(text, (this.injected.get(text) ?? 0) + 1);
  }

  private takeInjected(text: string): boolean {
    const count = this.injected.get(text);
    if (count === undefined) return false;
    if (count > 1) this.injected.set(text, count - 1);
    else this.injected.delete(text);
    return true;
  }

  /** 会话结束：停止找文件和宽限计时，退订激活时订阅的事件，把子进程环境变量放回原样，在线时向工地告别（SiteLink 发 bye） */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.scopeTimer);
    this.scopeTimer = undefined;
    clearTimeout(this.graceTimer);
    this.unwatch?.();
    this.unwatch = undefined;
    this.shared.control.deactivate();
    if (this.inherited !== undefined) restoreEnv(this.shared.env, this.inherited);
    this.link?.stop("shutdown");
    this.link = null;
  }

  /**
   * 属于被监视的仓库才激活；不属于（或判断出错）就到此为止：本会话什么都不做，也不再找文件
   * （同一个扩展实例的上一个会话启用过 ask_designer 的话，把它收起来）。
   * 判断要等 git（最多几秒），等的时候会话可能已经结束：那就不能再激活，否则连接没人关、pi 进程退不掉，层级也会被写回 env
   */
  private readonly checkScope = safe(async (repos: string[]): Promise<void> => {
    const repo = await safe(resolveWatchedRepo, null)(this.cwd, repos, this.shared.commonDir);
    if (this.stopped) return;
    this.lastInScope = repo !== null;
    if (repo === null) {
      this.shared.showAsk(false);
      this.shared.showTodo(false);
      this.pollTimer = later(() => this.discover(), this.shared.retryMs);
      return;
    }
    this.activate();
  }, undefined);

  /** 已经连上的会话定期复核：工地集合变小、自己被移出范围时断开，并回到找文件的状态 */
  private readonly recheckScope = safe(async (): Promise<void> => {
    if (this.stopped || this.link === null) return;
    const file = readBridgeFile(this.file);
    const repo = file === null ? null : await safe(resolveWatchedRepo, null)(this.cwd, file.repos, this.shared.commonDir);
    if (this.stopped || repo !== null) return;
    this.deactivate("out of scope");
    this.lastScope = null;
    this.discover();
  }, undefined);

  /**
   * 断开并回到未激活状态：主动断开不会走 SiteLink 的 onOffline，这里自己跑一遍宽限流程，
   * 否则暂停中的工具调用会一直挂到会话结束；订阅和 env 只在第一次激活时建立，所以这里不退订
   */
  private deactivate(reason: string): void {
    this.link?.stop(reason);
    this.link = null;
    this.offline();
    this.shared.control.deactivate();
    this.shared.showAsk(false);
    this.shared.showTodo(false);
  }

  /** 激活：给子进程导出层级、订阅事件、让模型看到 ask_designer、连上工地（SiteLink 每次连接都重新读 bridge.json） */
  private activate(): void {
    const { env, timings, execute, showAsk } = this.shared;
    this.sessionId = this.ctx.sessionManager.getSessionId();
    this.startedAt = new Date().toISOString();
    // 出范围再进来会再调一次 activate：env 原值只存第一次，订阅也只订一次，否则事件会重复上报、原值也被覆盖
    if (this.unwatch === undefined) {
      this.inherited = { [ENV_PARENT]: env[ENV_PARENT], [ENV_LEVEL]: env[ENV_LEVEL] };
      exportLineage(env, this.sessionId, this.lineage.level);
      this.unwatch = this.watchAgent();
    }
    this.shared.control.activate(this.ctx); // 控制模块的处理函数只在激活期间挂着
    safe(showAsk, undefined)(true); // 注册 ask_designer 失败也不能耽误连工地：暂停、建议和上报都不靠它
    safe(this.shared.showTodo, undefined)(this.lineage.level === 1); // 待办工具只给一级会话
    this.link = new SiteLink({
      file: this.file,
      session: () => this.info(),
      onCommand: (msg) => { if ("cmdId" in msg) this.link?.send(execute(msg)); },
      onOnline: () => this.online(),
      onOffline: () => this.offline(),
      timings,
    });
    this.link.start();
    if (this.scopeTimer === undefined) {
      this.scopeTimer = setInterval(() => void this.recheckScope(), this.shared.retryMs);
      // 不让这个定时器单独撑住进程：pi 收尾时不该被它拖住
      this.scopeTimer.unref?.();
    }
  }

  /**
   * 激活后才订阅的事件：上报摘要事件；agent 开始运行、彻底收尾时补发 state，idle 才跟得上 agent（不然一直是上线时那一帧的值）。
   * 不属于被监视仓库的会话一个都不订阅：pi 只在有扩展订阅 turn_end 时才做每回合的边界工作，这些会话不该为桥接付出（见 docs/architecture.md「桥接扩展 site-bridge」）。
   * 返回退订函数，stop 时调用
   */
  private watchAgent(): () => void {
    const { pi } = this.shared;
    const sendState = safe(() => this.sendState(), undefined);
    const unsubscribes = [
      installEventForwarding(pi, this, { isBridgeInjected: (text) => this.takeInjected(text) }),
      pi.on("agent_start", sendState),
      pi.on("agent_settled", sendState),
    ];
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  }

  /** 连上（含重连）：取消断线宽限，补发当前状态 */
  private online(): void {
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.sendState();
  }

  /**
   * 掉线：graceMs 内没连回来，就放行所有暂停、让还在等的提问回退（ask_resolved 由 SiteLink 记下，重连后补报）。
   * 这个定时器不 unref：print / json 模式（二级 agent 就这样跑）里没有别的东西让进程活着，工地断线之后，
   * 能让进程等到宽限结束、放行挂起的调用的只有它。连上（online）和会话结束（stop）都会清掉它，正常退出不会被它拖住
   */
  private offline(): void {
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(safe(() => {
      this.shared.control.gate.releaseAll();
      this.link?.failPendingAsks();
    }, undefined), this.shared.graceMs);
  }

  /**
   * 本会话的信息，握手、发提问、告别时由 SiteLink 现取。可选字段缺席就不带这个键（协议解析器不接受 null）。
   * ctx 失效时会抛出：SiteLink 调用它的地方都兜住了，握手发不出去就不算连上 —— 运行时已经没了，本就不该再以它的名义连工地
   */
  private info(): SessionInfo {
    const { ctx } = this;
    const file = ctx.sessionManager.getSessionFile();
    const model = ctx.model;
    const { parentId, level } = this.lineage;
    return {
      id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, level, startedAt: this.startedAt, mode: ctx.mode,
      ...(file === undefined ? {} : { file }),
      ...(model === undefined ? {} : { model: model.id, provider: model.provider }),
      ...(parentId === undefined ? {} : { parentId }),
    };
  }

  /** ctx 失效时按不空闲报 */
  private idle(): boolean {
    try {
      return this.ctx.isIdle();
    } catch {
      return false;
    }
  }
}

/** 交给 Control 执行；只有 suggest 有结果可看："failed" 表示连交给 pi 这一步都没成 */
function runCommand(control: Control, cmd: Command): boolean {
  switch (cmd.type) {
    case "pause": control.pause(); return true;
    case "resume": control.resume(); return true;
    case "abort": control.abort(); return true;
    case "suggest": return control.suggest(cmd.text, cmd.mode) !== "failed";
  }
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : e === undefined ? "指令执行失败" : String(e));

/** 把记下的原值放回 env：原来没有的键删掉 */
function restoreEnv(env: Env, saved: Env): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}
