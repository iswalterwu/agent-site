// 工地引擎的核心类型：只放类型和常量，不放逻辑。后面的任务往这里追加。

import type { Locale } from "./i18n";

// ---- feature 与楼层 ----

/** 楼层 = 意图卡里的一个切片，自下而上按卡片顺序 */
export type FloorId = string;
export type FeatureStatus = "in-progress" | "done";
export type Risk = "低" | "中" | "高";

/** 意图卡里一条切片步骤；done = 卡在 [x] */
export interface SliceStep { text: string; done: boolean }
/** 意图卡的一个切片；done = 行尾 ✓，current = 标了（当前） */
export interface Slice { id: string; title: string; done: boolean; current: boolean; steps: SliceStep[] }
/** specs/<feature>/spec.md 解析后的形状；slices 为空表示还没拆切片 */
export interface IntentCard {
  title: string; risk: Risk | null; ac: number; open: number;
  /** 待定一节的条目原文（已截断，展示前还要脱敏） */
  openItems: string[];
  slices: Slice[]
}

/** 一个 feature 的输入：意图卡读得出就带 card，否则带 error（unreadable = 图纸读不出） */
export type FeatureInput = { name: string; specsDir: string; card: IntentCard }
  | { name: string; specsDir: string; card?: never; error: "unreadable" };

/** 篷布文字；null = 没有篷布 */
export type TarpText = "图纸读不出" | "图纸未拆切片";
/** built = 实体（已建）；planned = 虚线（未建） */
export type FloorKind = "built" | "planned";
export type FloorView = { id: FloorId; kind: FloorKind }
  | { id: FloorId; kind: "progress"; cells: number; doneCells: number };
export interface FloorPlan { floors: FloorView[]; firstUnfinished: FloorId | null }

// ---- 统一事件：三种会话日志转换后的共同形状 ----

/** 会话日志的来源 */
export type Harness = "pi" | "claude" | "dsh";
/** 工具调用归到的动作类别 */
export type ToolOp = "read" | "search" | "edit" | "write" | "shell" | "todo" | "spawn" | "ask" | "other";
export interface TodoItem { text: string; status: "pending" | "in_progress" | "completed" }
/** paths 只放字符串；可选字段只在日志里真有对应值时出现 */
export interface ToolCall { tool: string; op: ToolOp; paths: string[]; command?: string;
  added?: number; removed?: number; title?: string; todos?: TodoItem[] }
/** ts 是毫秒时间戳 */
export type SiteEvent =
  | { kind: "prompt"; ts: number; text: string; from: "user" | "agent" }
  | { kind: "text"; ts: number; text: string }
  | { kind: "thinking"; ts: number; text: string }
  | { kind: "tool_call"; ts: number; id: string; call: ToolCall }
  | { kind: "tool_result"; ts: number; id: string; ok: boolean; failed?: number; todos?: TodoItem[] }
  | { kind: "model"; ts: number; model: string; explicit: boolean }   // explicit = 来自切换记录
  | { kind: "compaction"; ts: number }
  | { kind: "turn_end"; ts: number }
  | { kind: "api_error"; ts: number; message: string; rateLimited: boolean };

// ---- 会话：归约后的状态与工人动作 ----

/** 一个会话的身份；level 1 是一级会话，子 agent 逐级加一 */
export interface SessionMeta { key: string; harness: Harness; nativeId: string; file: string; cwd: string;
  startedAt: number; level: number; parentKey?: string; branch?: string }
/** 一次工具调用，有结果时把结果挂上 */
export interface TrackedCall { id: string; ts: number; call: ToolCall; result?: { ts: number; ok: boolean; failed?: number } }
/** 会话归约后的状态：事件和调用都只留最近的一段（环形缓冲），不可变 */
export interface SessionState { meta: SessionMeta; events: readonly SiteEvent[]; calls: readonly TrackedCall[];
  firstPrompt?: string; model?: string; todos?: readonly TodoItem[]; lastEventAt: number }
/** 卡片里给设计师看的模型轨迹；只放能读懂的事件 */
export type TraceKind = "prompt" | "text" | "thinking" | "tool_call" | "tool_result" | "model" | "compaction" | "api_error";
export interface TraceEntry { at: number; kind: TraceKind; text: string }
/** 工人动作：看图纸、砌墙、拆除、返工、试压、想、排计划、提交、派工、换模型、压缩、API 报错、其他 */
export type ActionKind = "read" | "build" | "demolish" | "rework" | "test" | "think" | "plan" | "commit" | "spawn"
  | "model" | "compact" | "api_error" | "other";
/** 一个动作；text 是气泡文字；工具调用出的动作带 outcome（没有结果时 pending） */
export interface ActionView { kind: ActionKind; at: number; text: string; outcome?: "ok" | "fail" | "pending" }

// ---- 状态 ----

/** 状态阈值（spec 5.6）：空闲、中途断掉按分钟，上工地时限按小时 */
export interface Thresholds { idleMinutes: number; stalledMinutes: number; onsiteHours: number }
/** 等你 / 中途断掉 / 空闲 / 在干（等你决策、已暂停在计划 4 加） */
export type WorkerStatus = "waiting" | "stalled" | "idle" | "working";

// ---- 归属与角色 ----

export interface Pin { feature: string; floor?: FloorId }
export type Role = "foreman" | "worker" | "inspector";
export type ModelFamily = "claude" | "gpt" | "deepseek" | "other";
export type Attribution =
  | { rule: "pinned" | "dispatch" | "specs" | "branch"; feature: string; floor: FloorId | null; detail: string }
  | { rule: "governance" | "none"; detail: string };

// ---- 楼体与快照 ----
export type Material = "brick" | "glass" | "metal" | "concrete";
export interface MaterialShare { material: Material; share: number }
/** 楼段造型：配置里选一种，整段一套画法 */
export type BuildingStyle = "tower" | "factory" | "storefront";
/** 施工阶段：按该段切片的完成比例算，整段一套过程态 */
export type BuildStage = "empty" | "foundation" | "structure" | "done";
export interface FeatureConfig { name: string; placement: "band" | "crown" | "office"; materials: MaterialShare[]; style?: BuildingStyle }
export interface SiteConfig { style: BuildingStyle; features: FeatureConfig[]; pins: Record<string, Pin>; thresholds: Thresholds; locale?: Locale }
export type Ribbon = "orange" | "red" | "yellow" | "green" | "grey";
export type Location = { kind: "band"; feature: string; floor: FloorId } | { kind: "office"; feature?: string } | { kind: "gate" };
/** 楼段卡：意图卡读不出时，除 specsDir 外全是 null */
export interface BandCard {
  title: string | null; risk: Risk | null; ac: number | null; open: number | null;
  /** 待定条目；没有意图卡时是 null */
  openItems: string[] | null;
  slices: { total: number; done: number } | null;
  current: { id: string; title: string; stepsDone: number; stepsTotal: number } | null;
  status: FeatureStatus | null; source: "card" | "todos" | "none"; specsDir: string }
export interface Band { feature: string; placement: "band" | "crown"; materials: MaterialShare[]; configured: boolean;
  style: BuildingStyle; stage: BuildStage;
  plan: FloorPlan | null; tarp: TarpText | null; scaffold: FloorId[]; ribbon: Ribbon; card: BandCard;
  /** 没有意图卡的工地画的那一层矮楼：不画篷布，工人站在这层 */
  mini: boolean }
/** 桥接在线状态；只由 App 的桥接投影填，核心快照不填 */
export interface WorkerControl { online: true; paused: boolean; holding: { tool: string; sinceMs: number } | null; idle: boolean }
export interface Worker { key: string; harness: Harness; nativeId: string; level: number; parentKey: string | null; readOnly: boolean;
  role: Role; roleReason: "dispatch" | "model" | "level"; model: string | null; modelFamily: ModelFamily;
  location: Location; attribution: Attribution; status: WorkerStatus; statusSince: number; bubble: string; statusDetail: string | null;
  trace: TraceEntry[]; actions: ActionView[]; todos: TodoItem[] | null; lastTestFailure: { at: number; text: string } | null;
  startedAt: number; lastEventAt: number; lastUserAt: number | null; file: string; cwd: string; control?: WorkerControl }
export type WaitItem = { kind: "turn_end"; key: string; since: number; text: string }
  | { kind: "history"; key: string; since: number; text: string };
export interface SourceStatus { root: string; present: boolean; sessions: number; badLines: number; unknownRecords: number; lastError: string | null }
/** 工地类型：git 仓库（worktree 归一到同一个）或普通运行目录 */
export type SiteKind = "git" | "dir";
/** 一个工地的全部展示数据；快照里每个工地一份 */
export interface SiteView { key: string; path: string; name: string; kind: SiteKind; mini: boolean; bands: Band[];
  /** 各 feature 意图卡里的待定（矮楼也有）：不随楼层布局丢，等你清单直接用 */
  open: Array<{ feature: string; text: string }>;
  /** 工地自己的待办清单（specs/backlog.md），已经脱敏 */
  backlog: string[];
  office: Array<{ feature: string; card: BandCard; style: BuildingStyle; stage: BuildStage }>; workers: Worker[]; designer: { waiting: WaitItem[] } }
/** 一个工地的原始输入：它的意图卡和会话 */
export interface SiteInput { key: string; path: string; name: string; kind: SiteKind; mini: boolean;
  features: FeatureInput[]; backlog: string[]; sessions: SessionState[] }
export interface SiteSnapshot { at: number; sites: SiteView[]; active: string | null;
  sources: Record<Harness, SourceStatus>; diagnostics: string[] }
export interface SnapshotInput { now: number; sites: SiteInput[]; active: string | null;
  config: SiteConfig; sources: Record<Harness, SourceStatus>; diagnostics: string[] }
