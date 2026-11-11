import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, FauxResponseStep, JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkTmpDir } from "./wait";

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export interface FauxSession {
  session: AgentSession;
  setResponses(steps: FauxResponseStep[]): void;
  /** probe 工具开始执行时记录参数 n */
  probeStarted: number[];
  /** probe 工具执行完成时记录参数 n */
  probeCalls: number[];
  /**
   * pi 报告的扩展处理函数运行时错误（bindExtensions 的 onError，每条是 pi 的 ExtensionError）。
   * 要断言"处理函数没有出错"就断言它为空；注意 pi 对 tool_call 处理函数抛错不上报，而是直接拦下这次工具调用，
   * 那种情况要看工具有没有执行
   */
  handlerErrors: unknown[];
  /** 本会话的临时 agentDir；dispose() / shutdown() 时删除 */
  agentDir: string;
  /** 只释放会话并删除临时 agentDir，不发 session_shutdown */
  dispose(): void;
  /** 与真实 pi 退出一致：先发 session_shutdown（reason "quit"），再 dispose() */
  shutdown(): Promise<void>;
}

/**
 * 在进程内起一个真实的 pi AgentSession：模型是 pi-ai 自带的 faux provider（按脚本回复，不联网），
 * 工具只有一个 probe，agentDir 是全新的临时目录。
 *
 * 生命周期与真实 pi 一致（pi 1.4.0 的 SDK 不会自动做这两件事，所以这里补上）：
 * 返回前已 `bindExtensions`（带 onError，错误记进 `handlerErrors`），扩展的 `session_start` 已触发；
 * 退出用 `shutdown()`，它像真实 pi 的运行时宿主那样先发 `session_shutdown` 再释放会话。
 */
export async function startFauxSession(opts: {
  cwd: string;
  extensions?: ExtensionFactory[];
  /** probe 执行耗时，默认 0；等待期间收到 signal 中止则抛出 */
  probeDelayMs?: number;
}): Promise<FauxSession> {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const agentDir = mkTmpDir();
  const probeStarted: number[] = [];
  const probeCalls: number[] = [];
  const handlerErrors: unknown[] = [];

  const registerProbe: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "probe",
      label: "Probe",
      description: "Test probe tool that records its argument.",
      parameters: Type.Object({ n: Type.Number() }),
      async execute(_toolCallId, params, signal) {
        probeStarted.push(params.n);
        const delayMs = opts.probeDelayMs ?? 0;
        if (delayMs > 0) await delay(delayMs, undefined, { signal });
        probeCalls.push(params.n);
        return { content: [{ type: "text", text: `ok ${params.n}` }], details: {} };
      },
    });
  };

  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    // 默认还会加载 ~/.agents/skills 里的技能、读 cwd 各级祖先目录里的 AGENTS.md / CLAUDE.md（都不受 agentDir 约束），测试里不要。
    // 关掉后 pi 仍会枚举这些目录（只查存在性和目录项），但不读内容、不加载
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), registerProbe, ...(opts.extensions ?? [])],
  });
  await loader.reload();

  // 凭证和模型清单都放内存。默认的文件版会在 agentDir 里异步读写 auth.json / models-store.json，
  // dispose() 删掉目录之后它们还会把目录重建出来；modelsPath 必须是 null，undefined 会回落到真实的 ~/.pi/agent/models.json
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });

  const { session, extensionsResult } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    model: faux.getModel(),
    noTools: "builtin",
  });

  const dispose = () => {
    session.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  };

  // 内联扩展的工厂函数抛错、工具/命令重名等加载失败，pi 只记进 extensionsResult.errors、不会抛出。
  // 不拦住的话，被测扩展没装上，测试只会无缘无故超时或空转通过。要在 bindExtensions 之前拦，免得残缺的扩展集收到 session_start
  if (extensionsResult.errors.length > 0) {
    dispose();
    throw new Error(`扩展加载失败：\n${extensionsResult.errors.map((e) => `${e.path}: ${e.error}`).join("\n")}`);
  }
  await session.bindExtensions({
    onError: (e) => {
      handlerErrors.push(e);
    },
  });

  return {
    session,
    setResponses: (steps) => faux.setResponses(steps),
    probeStarted,
    probeCalls,
    handlerErrors,
    agentDir,
    dispose,
    async shutdown() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      dispose();
    },
  };
}

/** 一条只含单个工具调用的助手回复（stopReason "toolUse"）；args 只传 JSON 字面量 */
export function callTool(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args as JsonObject), { stopReason: "toolUse" });
}

/** 一条纯文本的助手回复（stopReason "stop"） */
export function say(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}
