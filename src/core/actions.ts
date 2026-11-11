// 动作判定：从旧到新走一遍会话最近的事件，每个事件判成工人的一个动作（看图纸、砌墙、拆除、返工、试压……）。
// 规则见计划 Task 6，重叠处按 P8、P9 的顺序判；E18–E20 定了测试的成败、shell 只看真正执行的部分、返工时间窗何时关。
// 文字一律经 bubble（先脱敏再截断，E1）。

import { ownerIndex } from "./session";
import { baseName, bubble, firstSentence } from "./text";
import type { ActionKind, ActionView, SessionState, SiteEvent, TodoItem, ToolCall } from "./types";

/** 测试失败后这么久之内的修改算返工 */
export const REWORK_WINDOW_MS = 600_000;
/** 测试 / 构建命令（P9）；捕获组是气泡里显示的命中词；结尾的守卫让 vitest.config.ts、jest.config.js 一类文件名不算（E19） */
export const TEST_RE = /\b(pytest|vitest|jest|playwright test|npm (?:run )?test|npm run build|vite build|tsc)\b(?![\w./-])/;

const COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const DEMOLISH_RE = /(?:^|[;&|\n]\s*)(?:rm|rmdir|del|Remove-Item)\b|\bgit\s+(?:-C\s+\S+\s+)?(?:rm|revert)\b/i;
const READ_CMD_RE = /^(?:cat|type|less|more|head|tail|wc|ls|dir|tree|find|grep|rg|sed\s+-n|Get-Content|Get-ChildItem|Select-String|gc|gci|sls)\b|^git\s+(?:-C\s+\S+\s+)?(?:status|log|diff|show|blame|ls-files)\b/i;
/** 主命令前面的切目录：cd <目录> &&、cd <目录>;、Set-Location <目录>;（目录可以带引号） */
const CD_PREFIX_RE = /^(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*&&|(?:cd|Set-Location)\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*;)\s*/i;

/** 提交标题来源：heredoc（<<'EOF' 或 <<EOF 那一行之后的第一行） */
const HEREDOC_RE = /<<(?:'EOF'|EOF)[^\n]*\n([^\n]*)/;
/** 提交标题来源：PowerShell here-string（@' 或 @" 那一行之后的第一行；@ 前面只认行首或空白，所以 shell 的 "$@" 不算） */
const HERE_STRING_RE = /(?:^|[ \t])@['"][ \t]*\r?\n([^\r\n]*)/;
/** 提交标题来源：-m、-am 一类以 m 结尾的合并短开关、--message / --message= 后面带引号的值 */
const MESSAGE_RE = /(?:^|\s)(?:-[A-Za-z]*m\s+|--message(?:=|\s+))(?:"([^"]*)"|'([^']*)')/g;

// 只看真正执行的部分（E19）：下面三种字面量的内容按顺序换成等长的填充，下标和原命令对齐
/** heredoc 正文：标记行之后、只有结束词的那一行之前（没有结束行就到命令结尾）；结束词不限于 EOF */
const HEREDOC_BODY_RE = /(<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\2[^\n]*)([\s\S]*?)(?=\n[ \t]*\3[ \t]*(?:\r?\n|$)|$)/g;
/** PowerShell here-string 正文：@' / @" 那一行之后、行首的 '@ / "@ 之前；@ 前面只认行首或空白 */
const HERE_STRING_BODY_RE = /((?:^|[ \t])@(['"])[ \t]*(?=\r?\n))([\s\S]*?)(?=\r?\n\2@|$)/g;
/** 引号里的字符串，可以跨行；双引号里认反斜杠转义 */
const QUOTED_RE = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;

/** 注释：# 到行尾；在字面量之后跑，所以引号里的 # 已经换成填充了 */
const COMMENT_RE = /(^|[ \t])#[^\r\n]*/gm;

/** 命令段的分隔：; & && || | 和换行 */
const SEGMENT_END_RE = /[;|&\n]/;
/** 重定向：>x、2>/dev/null、2>&1、>>log；捕获组是符号后紧跟的部分，为空（> 、2>）时目标是下一个词 */
const REDIRECT_RE = /^[0-9*&]*(?:>>?|<)(.*)$/;
/** shell 词：引号里的空格不切；捕获组是去掉引号的值 */
const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;

/** 命令真正跑的测试 / 构建命中词（E19：引号、heredoc、here-string 里的字不算）；不是测试命令给 null。Task 8 判"跑过测试"也用它 */
export function testWord(command: string): string | null {
  return TEST_RE.exec(blankLiterals(command))?.[1] ?? null;
}

/** 提交标题：只看 git … commit 之后的部分，依次试 heredoc、here-string、-m，用第一个取到的；去掉首尾空白，空的给 null */
export function commitTitle(command: string): string | null {
  const commit = COMMIT_RE.exec(blankLiterals(command));
  if (commit === null) return null;
  const rest = command.slice(commit.index + commit[0].length);
  const title = (HEREDOC_RE.exec(rest)?.[1] ?? HERE_STRING_RE.exec(rest)?.[1] ?? messageValue(rest))?.trim();
  return title ? title : null;
}

/** 会话里的全部动作，旧 → 新；先把结果配给调用（与 applyEvents 同一条规则） */
export function deriveActions(s: SessionState): ActionView[] {
  const w: Walk = { pairs: pairResults(s.events) };
  const actions: ActionView[] = [];
  s.events.forEach((ev, i) => {
    const action = actionOf(ev, i, w);
    if (action !== null) actions.push(action);
  });
  return actions;
}

// ---- 走事件 ----

type ToolCallEvent = Extract<SiteEvent, { kind: "tool_call" }>;
type ToolResultEvent = Extract<SiteEvent, { kind: "tool_result" }>;

/** 调用与结果的配对，键都是事件下标：调用 → 它的结果，结果 → 它所属的调用 */
interface Pairs { resultOf: Map<number, ToolResultEvent>; callOf: Map<number, ToolCallEvent> }

/** 走事件时带着的状态：上一个模型（判模型回退），最近一次测试失败的时间（判返工；之后测试通过就清掉） */
interface Walk { readonly pairs: Pairs; model?: string; lastTestFailAt?: number }

/** 一条事件出的动作；提示、回合结束、工具结果和空的思考不出动作 */
function actionOf(ev: SiteEvent, i: number, w: Walk): ActionView | null {
  switch (ev.kind) {
    case "thinking": case "text": return thinkAction(ev.text, ev.ts);
    case "model": return modelAction(ev.model, ev.ts, w);
    case "compaction": return { kind: "compact", at: ev.ts, text: bubble("压缩上下文") };
    case "api_error": return { kind: "api_error", at: ev.ts, text: bubble(ev.rateLimited ? "限流，等待中" : "API 报错") };
    case "tool_call": return callAction(ev, w.pairs.resultOf.get(i), w);
    case "tool_result": noteTestResult(ev, w.pairs.callOf.get(i), w); return null;
    default: return null;
  }
}

/** 每个结果配给同 id、在它之前最新的那次调用（ownerIndex）；同一调用有多个结果时取最后一个 */
function pairResults(events: readonly SiteEvent[]): Pairs {
  const seen: { id: string; index: number; ev: ToolCallEvent }[] = [];
  const pairs: Pairs = { resultOf: new Map(), callOf: new Map() };
  events.forEach((ev, index) => {
    if (ev.kind === "tool_call") seen.push({ id: ev.id, index, ev });
    if (ev.kind !== "tool_result") return;
    const owner = ownerIndex(seen, ev.id);
    if (owner === -1) return;
    pairs.resultOf.set(seen[owner].index, ev);
    pairs.callOf.set(index, seen[owner].ev);
  });
  return pairs;
}

/** 第一句经 bubble 后是空的（只有空白或标点）不出动作 */
function thinkAction(text: string, at: number): ActionView | null {
  const sentence = firstSentence(text);
  return sentence === "" ? null : { kind: "think", at, text: sentence };
}

/** 第一个模型只作基准；之后和上一个模型不同才算换模型 */
function modelAction(model: string, at: number, w: Walk): ActionView | null {
  const prev = w.model;
  w.model = model;
  return prev === undefined || prev === model ? null : { kind: "model", at, text: bubble(`换到 ${model}`) };
}

/** 测试调用的结果：失败记下时间，通过就关掉返工时间窗（E20）；别的调用的结果不管 */
function noteTestResult(ev: ToolResultEvent, call: ToolCallEvent | undefined, w: Walk): void {
  if (call === undefined || !isTestCall(call.call)) return;
  w.lastTestFailAt = testFailed(ev) ? ev.ts : undefined;
}

const isTestCall = (call: ToolCall): boolean => call.op === "shell" && testWord(call.command ?? "") !== null;

/** 测试的结果：退出码 0 但输出里有 N failed（N > 0）也算失败（E18） */
const testFailed = (r: ToolResultEvent): boolean => !r.ok || (r.failed ?? 0) > 0;

/** 工具调用出的动作都带 outcome：没有结果时 pending；测试按 E18 判成败，别的调用只看 ok */
function callAction(ev: ToolCallEvent, result: ToolResultEvent | undefined, w: Walk): ActionView {
  const { kind, text } = classify(ev.call, ev.ts, result, w);
  const failed = result === undefined ? undefined : kind === "test" ? testFailed(result) : !result.ok;
  return { kind, at: ev.ts, text: bubble(text), outcome: failed === undefined ? "pending" : failed ? "fail" : "ok" };
}

// ---- 工具调用归类 ----

interface Classified { kind: ActionKind; text: string }

function classify(call: ToolCall, at: number, result: ToolResultEvent | undefined, w: Walk): Classified {
  switch (call.op) {
    case "todo": return { kind: "plan", text: currentTodo(call.todos ?? []) };
    case "edit": case "write": return editAction(call, at, w);
    case "read": case "search": return { kind: "read", text: `看 ${fileName(call)}` };
    case "shell": return shellAction((call.command ?? "").trim(), call.tool, result);
    case "spawn": return { kind: "spawn", text: call.title ?? "派工" };
    case "ask": return { kind: "other", text: call.title ?? call.tool };
    case "other": return { kind: "other", text: call.tool };
  }
}

/** 第一个 in_progress 项，没有就第一个 pending 项，都没有（或调用没带列表）写"更新待办" */
function currentTodo(todos: readonly TodoItem[]): string {
  const item = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
  return item?.text ?? "更新待办";
}

/** 判定顺序（P8）：改 tasks.md 算计划 → 删除行过多算拆除 → 返工只替换改代码 */
function editAction(call: ToolCall, at: number, w: Walk): Classified {
  const name = fileName(call);
  const { added, removed } = call;
  const hasLines = added !== undefined && removed !== undefined;
  if (name === "tasks.md") return { kind: "plan", text: "改 tasks.md" };
  if (hasLines && removed > added * 2) return { kind: "demolish", text: `删 ${name}` };
  if (inReworkWindow(at, w.lastTestFailAt)) return { kind: "rework", text: `修 ${name}` };
  return { kind: "build", text: hasLines ? `改 ${name} +${added} −${removed}` : `改 ${name}` };
}

/** 调用时间在最近一次测试失败的结果之后（含同一时刻），且不超过返工时间窗 */
const inReworkWindow = (at: number, failAt: number | undefined): boolean =>
  failAt !== undefined && at >= failAt && at - failAt <= REWORK_WINDOW_MS;

/** 第一个路径的文件名；没有路径时用工具名 */
const fileName = (call: ToolCall): string => (call.paths.length > 0 ? baseName(call.paths[0]) : call.tool);

/**
 * 归类顺序（P9）：测试 → 提交 → 拆除 → 读 → 其他。前三条看去掉字面量的整条命令（E19），读看主命令；
 * 气泡文字和提交标题都取自原命令
 */
function shellAction(command: string, tool: string, result: ToolResultEvent | undefined): Classified {
  const word = testWord(command);
  if (word !== null) return { kind: "test", text: testText(word, result) };
  const bare = blankLiterals(command);
  if (COMMIT_RE.test(bare)) return { kind: "commit", text: commitTitle(command) ?? "提交" };
  const verb = DEMOLISH_RE.exec(bare);
  if (verb !== null) return { kind: "demolish", text: `删 ${baseName(demolishTarget(command, bare, verb))}` };
  const main = mainCommand(command);
  if (READ_CMD_RE.test(main)) return { kind: "read", text: `看 ${main}` };
  return { kind: "other", text: main || tool };
}

/** 反复去掉开头的切目录，剩下的是主命令 */
function mainCommand(command: string): string {
  let main = command;
  while (CD_PREFIX_RE.test(main)) main = main.replace(CD_PREFIX_RE, "");
  return main;
}

function testText(word: string, result: ToolResultEvent | undefined): string {
  if (result === undefined) return `${word} …`;
  if (!testFailed(result)) return `${word} ✓`;
  return (result.failed ?? 0) > 0 ? `${word} ✗ ${result.failed}` : `${word} ✗`;
}

/** 引号里的字符串、heredoc 正文、here-string 正文、# 注释换成等长的填充（引号和标记行保留），下标与原命令对齐 */
function blankLiterals(command: string): string {
  return command
    .replace(HEREDOC_BODY_RE, (_m, head: string, _q: string, _word: string, body: string) => head + fill(body))
    .replace(HERE_STRING_BODY_RE, (_m, head: string, _q: string, body: string) => head + fill(body))
    .replace(QUOTED_RE, (m) => m[0] + fill(m.slice(1, -1)) + m[0])
    .replace(COMMENT_RE, (_m, lead: string, offset: number, whole: string) =>
      lead + fill(whole.slice(offset + lead.length, offset + _m.length)));
}

/**
 * 换行以外的字符都换成 _：不是空白，git -C "<目录>" 的 \S+ 照样跨得过去；拼不出测试词，和两边的引号、换行之间也不会多出 \b。
 * 换行保留：heredoc 标记行末尾的命令（如 && npx tsc）不会和正文的填充连成一个词
 */
const fill = (text: string): string => text.replace(/[^\r\n]/g, "_");

/** 删除动词所在那一段（动词之后，到 ; && || | 或换行为止，分隔符按去掉字面量的命令找）里的最后一个参数；没有参数时用动词本身 */
function demolishTarget(command: string, bare: string, verb: RegExpExecArray): string {
  const start = verb.index + verb[0].length;
  const end = SEGMENT_END_RE.exec(bare.slice(start));
  return lastArg(command.slice(start, end === null ? undefined : start + end.index)) || lastWord(verb[0]);
}

/** 匹配到的删除动词（rm、Remove-Item、git 后面的 rm / revert）：匹配文字末尾的那个词，前面的分隔符不要 */
const lastWord = (text: string): string => /[\w-]+$/.exec(text)?.[0] ?? "";

/** PowerShell 里带值的开关：后面那个词是它的值，不是删除目标 */
const FLAG_VALUE_RE = /^-(?:(?:Error|Warning|Information|Progress|Verbose|Debug)?Action|(?:Error|Warning|Information|Out|Pipeline)Variable)$/i;

/** 跳过开关（-x、--x、-Force）、带值开关的值、重定向（只有符号时连同下一个词）和 # 后面的注释；剩下的最后一个，引号去掉 */
function lastArg(segment: string): string {
  const args: string[] = [];
  let skipNext = false;
  for (const [raw, double, single, bareWord] of segment.matchAll(TOKEN_RE)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (raw.startsWith("#")) break;
    const redirect = REDIRECT_RE.exec(raw);
    if (redirect !== null) skipNext = redirect[1] === "";
    else if (raw.startsWith("-")) skipNext = FLAG_VALUE_RE.test(raw);
    else args.push(double ?? single ?? bareWord);
  }
  return args.at(-1) ?? "";
}

/** 第一个不以 $( 开头的 -m / --message 值的第一个非空行 */
function messageValue(rest: string): string | undefined {
  for (const m of rest.matchAll(MESSAGE_RE)) {
    const value = m[1] ?? m[2];
    if (!value.startsWith("$(")) return value.split("\n").find((line) => line.trim() !== "") ?? "";
  }
  return undefined;
}
