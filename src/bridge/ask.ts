// ask_designer：agent 需要设计师拍板时调用的工具。同一个问题同时发到工地（SiteAsker）和 pi 自己的终端对话框，
// 先给出非空答案的一边算数，另一边通过 AbortSignal 取消；设计师在 App 里点取消 = 明确跳过，两边一起收尾，
// 模型拿到"跳过了"的说明；两边都没有答案（离线、宽限到点）时回退为离线说明，agent 不会卡住。
// runAsk 只管这场竞争，不依赖 pi；registerAskDesigner 把它接成 pi 的工具。

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { safe } from "./safe";

export interface AskRequest { askId: string; question: string; options: string[]; allowOther: boolean; context?: string }

/**
 * 工地一侧的结果：答了 / 设计师明确跳过（App 上点了"取消这个提问"）/ 这一边没有答案（掉线、宽限到点、外部中止）
 */
export type SiteAskResult = { kind: "answer"; text: string } | { kind: "skip" } | { kind: "none" };

/** 工地一侧；Task 9 的 SiteLink 实现它 */
export interface SiteAsker {
  isOnline(): boolean;
  ask(req: AskRequest, signal: AbortSignal): Promise<SiteAskResult>;
  resolved(askId: string, by: "site" | "terminal" | "offline" | "cancelled"): void;
}

/** 终端一侧：ctx.ui 的子集 */
export interface AskUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export type AskOutcome = { answer: string; source: "site" | "terminal" } | { answer: null; note: string };

export const OFFLINE_NOTE = "设计师离线，请在对话里提问";
export const SKIPPED_NOTE = "设计师跳过了这个问题，请按最佳判断继续，并在回复里说明你的假设";
export const OTHER_LABEL = "其他…";
export const BAD_ARGS = "ask_designer 需要至少一个选项，或允许其他输入";

type Side = "site" | "terminal";
type ResolvedBy = Parameters<SiteAsker["resolved"]>[1];
/** 一边的结局：答了（answer 非空）、明确跳过（只有工地会这样）、还是没有答案 */
interface Reply { side: Side; answer: string | null; skip: boolean }

/**
 * 同时问工地和终端（有哪边问哪边）：先给出非空答案的一边胜出，取消另一边，并把结果告诉工地；
 * 工地说"跳过"（App 上点了取消）→ 取消终端、告诉工地 cancelled，模型拿到跳过说明；
 * 两边都结束而没有答案 → 离线说明；外部 signal 中止 → 取消两边、告诉工地 cancelled，并抛出中止原因。
 * 任何一边出错都只当它没有答案，不会拖垮另一边，也不会留下未处理的拒绝。
 */
export async function runAsk(req: AskRequest, deps: { site: SiteAsker | null; ui: AskUi | null; signal?: AbortSignal }): Promise<AskOutcome> {
  if (req.options.length === 0 && !req.allowOther) throw new Error(BAD_ARGS);
  const { site, ui, signal } = deps;
  signal?.throwIfAborted(); // 已经中止的 signal 不会再触发 abort 事件，不拦住的话下面会永远等下去

  // 还在等的各方；每一方有自己的 AbortController，输了或被中止时只取消还没结束的
  const waiting = new Map<Side, { reply: Promise<Reply>; cancel: () => void }>();
  const open = (side: Side, run: (signal: AbortSignal) => Promise<Reply["answer"] | SiteAskResult | undefined>) => {
    const ac = new AbortController();
    waiting.set(side, { reply: replyOf(() => run(ac.signal)).then((reply) => ({ side, ...reply })), cancel: () => ac.abort() });
  };
  if (site !== null) open("site", (s) => site.ask(req, s));
  if (ui !== null) open("terminal", (s) => askTerminal(req, ui, s));

  const tellSite = safe((by: ResolvedBy) => site?.resolved(req.askId, by), undefined); // 通知出错不能丢掉已经拿到的答案
  const cancelWaiting = () => { for (const { cancel } of waiting.values()) cancel(); };
  const watch = watchAbort(signal);
  try {
    while (waiting.size > 0) {
      const next = await Promise.race([...Array.from(waiting.values(), (w) => w.reply), watch.aborted]);
      if (next === "aborted") {
        cancelWaiting();
        tellSite("cancelled");
        throw signal?.reason;
      }
      waiting.delete(next.side);
      if (next.skip) {
        // 设计师在 App 里主动跳过：终端对话框一起关，模型按"没有答案但要自己拿主意"继续
        cancelWaiting();
        tellSite("cancelled");
        return { answer: null, note: SKIPPED_NOTE };
      }
      if (next.answer !== null) {
        cancelWaiting();
        tellSite(next.side);
        return { answer: next.answer, source: next.side };
      }
    }
    tellSite("offline");
    return { answer: null, note: OFFLINE_NOTE };
  } finally {
    watch.stop();
  }
}

/**
 * 一边的结果：非空字符串才是答案；工地传来的"跳过"照实记下；
 * 空串、undefined、null（中途离线、用户按了 Esc）或出错都算没有答案。从不 reject
 */
async function replyOf(run: () => Promise<string | null | undefined | SiteAskResult>): Promise<Omit<Reply, "side">> {
  try {
    const result = await run();
    if (typeof result === "object" && result !== null) {
      if (result.kind === "skip") return { answer: null, skip: true };
      return { answer: result.kind === "answer" && result.text !== "" ? result.text : null, skip: false };
    }
    return { answer: result ? result : null, skip: false };
  } catch {
    return { answer: null, skip: false };
  }
}

/** 终端流程：有选项先选（允许其他输入时末尾追加"其他…"），选了"其他…"或根本没有选项再输入 */
async function askTerminal(req: AskRequest, ui: AskUi, signal: AbortSignal): Promise<string | undefined> {
  const title = req.context ? `${req.question}\n${req.context}` : req.question;
  if (req.options.length > 0) {
    const picked = await ui.select(title, req.allowOther ? [...req.options, OTHER_LABEL] : req.options, { signal });
    if (!req.allowOther || picked !== OTHER_LABEL) return picked;
  }
  return ui.input(title, undefined, { signal });
}

/** 外部 signal 中止时兑现的 Promise，供 Promise.race 使用；用完调 stop() 摘掉监听器 */
function watchAbort(signal: AbortSignal | undefined): { aborted: Promise<"aborted">; stop(): void } {
  if (signal === undefined) return { aborted: new Promise<"aborted">(() => {}), stop() {} };
  let onAbort = () => {};
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { aborted, stop: () => signal.removeEventListener("abort", onAbort) };
}

/** ask_designer 收到的参数（pi 按下面的 JSON Schema 校验并补齐默认值） */
interface AskArgs { question: string; options?: string[]; allowOther?: boolean; context?: string }

/**
 * 参数用一份手写的 JSON Schema，不在运行时 import 宿主提供的 typebox：桥接装在全局，宿主哪天不再提供那个模块，
 * 所有 pi 会话都起不来。pi 的工具参数校验本来就收普通 JSON Schema（见 @earendil-works/pi-ai 的 validateToolArguments）。
 */
const AskParams = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 1, description: "要问设计师的问题：一句话说清楚要他决定什么" },
    options: {
      type: "array", items: { type: "string" }, maxItems: 6,
      description: "候选答案，最多 6 个；不给就只能由设计师自己输入",
    },
    allowOther: { type: "boolean", description: "是否允许设计师在选项之外自己输入答案，默认 true；没有选项时必须允许" },
    context: { type: "string", maxLength: 200, description: "背景说明，最多 200 字" },
  },
  required: ["question"],
} as unknown as TSchema;

export function registerAskDesigner(pi: ExtensionAPI, deps: { site: () => SiteAsker | null; newId?: () => string }): void {
  const newId = deps.newId ?? randomUUID;
  pi.registerTool({
    name: "ask_designer",
    label: "问设计师",
    description:
      "向设计师提问并等待对方的回答。需要他拍板的事项（方案取舍、范围、风险）用这个工具，并给出具体选项。"
      + "问题会同时出现在他的桌面应用和你所在的终端里，谁先答算谁。"
      + `返回 {"answer": 他的回答, "source": "site" 或 "terminal"}；设计师跳过时返回 {"answer": null, "note": …}，请按最佳判断继续并在回复里说明假设；`
      + `设计师离线时同样返回 {"answer": null, "note": …}，这时请在对话里直接提问。`,
    promptGuidelines: ["需要用户（设计师）拍板的事项，调用 ask_designer 并给出具体选项，不要只在回复里提问。"],
    parameters: AskParams,
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_toolCallId, value, signal, _onUpdate, ctx) {
      // 参数已经由 pi 按 schema 校验过，这里只是把类型写清楚
      const params = value as AskArgs;
      const asker = deps.site();
      const outcome = await runAsk(
        { askId: newId(), question: params.question, options: params.options ?? [], allowOther: params.allowOther ?? true, context: params.context },
        { site: asker?.isOnline() ? asker : null, ui: ctx.mode === "tui" ? ctx.ui : null, signal },
      );
      return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: outcome };
    },
  });
}
