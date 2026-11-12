import { ribbonColor } from "../core/building";
import { redact } from "../core/redact";
import type { ActionView, Ribbon, SiteSnapshot, SiteView, TodoItem, TraceEntry, WaitItem, Worker, WorkerControl } from "../core/types";
import { ui } from "./i18n";
import { RIBBON_TONE, workerTone } from "./footer";
import type { Tone } from "./theme";

export interface BandCardView {
  feature: string;
  title: string;
  ribbon: Ribbon;
  tone: Tone;
  readable: boolean;
  tarp: string | null;
  statusLabel: string;
  risk: string | null;
  ac: number | null;
  open: number | null;
  slices: { total: number; done: number } | null;
  current: { id: string; title: string; stepsDone: number; stepsTotal: number } | null;
  workers: Worker[];
  specsDir: string;
  /** 楼段数据的来源：意图卡、会话待办，或矮楼 */
  source: "card" | "todos" | "none";
  /** 没有意图卡的工地：卡片里没有数字，摘要直接说没有意图卡 */
  mini: boolean;
}

export interface DiagnosticsView {
  at: number;
  repo: string;
  sources: Array<{ harness: string; root: string; present: boolean; sessions: number; badLines: number;
    unknownRecords: number; lastError: string | null }>;
  notes: string[];
}

export interface WorkerCardView {
  key: string;
  /** 这个小人所在的工地：灯和等你清单跨工地之后，卡片要能自己说明是哪个工地 */
  site: string;
  title: string;
  tone: Tone;
  statusLabel: string;
  statusSince: number;
  statusDetail: string | null;
  trace: TraceEntry[];
  control: WorkerControl | null;
  readOnly: boolean;
  harness: string;
  model: string | null;
  nativeId: string;
  location: string;
  actions: ActionView[];
  todos: TodoItem[] | null;
  testFailure: { at: number; text: string } | null;
}

const ROLE = { foreman: "工头", worker: "工人", inspector: "监理" } as const;
const STATUS = { waiting: "等你", stalled: "停工", idle: "空闲", working: "在干" } as const;
const FEATURE_STATUS = { "in-progress": "在建", done: "已交付" } as const;
const HARNESS: Record<Worker["harness"], string> = { pi: "pi", claude: "Claude Code", dsh: "DSH" };

/** 楼段或办公室 feature 还在快照里；卡片存续检查两处都看 */
export function featureExists(site: SiteView, feature: string): boolean {
  return site.bands.some(band => band.feature === feature)
    || site.office.some(office => office.feature === feature);
}

export function bandView(site: SiteView, feature: string): BandCardView | null {
  const band = site.bands.find(item => item.feature === feature);
  const office = site.office.find(item => item.feature === feature);
  if (band === undefined && office === undefined) return null;
  const card = band?.card ?? office!.card;
  const workers = site.workers.filter(worker =>
    worker.location.kind === "band" ? worker.location.feature === feature
      : worker.location.kind === "office" ? worker.location.feature === feature : false);
  const ribbon = band?.ribbon ?? ribbonColor(card.status, workers);
  return {
    feature: redact(feature), title: redact(card.title ?? feature), ribbon, tone: RIBBON_TONE[ribbon],
    readable: card.title !== null, tarp: band?.tarp === null || band?.tarp === undefined ? null : ui(band.tarp),
    statusLabel: card.status === null ? ui("未知") : ui(FEATURE_STATUS[card.status]),
    risk: card.risk === null ? null : ui(card.risk), ac: card.ac, open: card.open, slices: card.slices,
    current: card.current === null ? null : { ...card.current, id: redact(card.current.id), title: redact(card.current.title) },
    workers, specsDir: redact(card.specsDir), source: card.source, mini: band?.mini ?? false,
  };
}

/** 悬停摘要里的四行：状态、人员、当前切片 / 步骤、AC / 待定 / 风险 */
export function bandSummary(view: BandCardView): { status: string; people: string; current: string; acceptance: string; risk: string } {
  const todo = view.source === "todos";
  const status = todo ? ui("来自会话待办 · {status}", { status: view.statusLabel })
    : view.mini ? ui("没有意图卡") : view.readable ? view.statusLabel : view.tarp ?? ui("图纸读不出");
  const people = view.workers.length === 0 ? ui("没人") : ui("{count} 人 · {roles}", {
    count: view.workers.length, roles: [...new Set(view.workers.map(worker => ui(ROLE[worker.role])))].join(" / "),
  });
  const current = todo ? view.current === null ? ui("没有进行中的待办") : view.current.title
    : view.current === null ? ui("没有当前切片")
      : `${view.current.id} ${view.current.title} ${view.current.stepsDone}/${view.current.stepsTotal}`;
  const acceptance = todo ? view.slices === null ? "—" : ui("待办 {done}/{total}", view.slices)
    : view.readable ? ui("AC {ac} · 待定 {open}", { ac: view.ac ?? "—", open: view.open ?? "—" }) : "—";
  const risk = todo ? "" : view.readable ? ui("风险 {risk}", { risk: view.risk ?? "—" }) : "—";
  return { status, people, current, acceptance, risk };
}

export function workerView(site: SiteView, key: string, demo = false): WorkerCardView | null {
  const worker = site.workers.find(item => item.key === key);
  if (worker === undefined) return null;
  // 矮楼只有一层，楼层号是布局占位，不显示给用户
  const location = redact(site.mini ? site.name : locationLabel(worker));
  return {
    key: worker.key,
    site: redact(site.name),
    title: redact(`${ui(ROLE[worker.role])} · ${location}`),
    tone: workerTone(worker),
    statusLabel: ui(STATUS[worker.status]),
    statusSince: worker.statusSince,
    statusDetail: demo || worker.statusDetail === null ? null : displayText(worker.statusDetail),
    trace: demo ? [] : worker.trace.map(entry => ({ ...entry, text: displayText(entry.text) })),
    control: demo ? null : worker.control ?? null,
    readOnly: worker.readOnly,
    harness: HARNESS[worker.harness],
    model: worker.model === null ? null : redact(worker.model),
    nativeId: shortId(worker.nativeId),
    location,
    actions: demo ? [] : worker.actions.slice(-4).map(action => ({ ...action, text: displayText(action.text) })),
    todos: demo || worker.todos === null ? null : worker.todos.map(todo => ({ ...todo, text: displayText(todo.text) })),
    testFailure: demo || worker.lastTestFailure === null ? null
      : { ...worker.lastTestFailure, text: displayText(worker.lastTestFailure.text) },
  };
}

export type WaitRow = WaitItem & { site: string };

/**
 * 等你清单：全部工地的等待项合在一起，先「现在」后「历史」，各自按等待开始时间从早到晚（等得久的在前）。
 * 每行带工地名：混排之后光有会话键看不出是哪个工地。
 */
/**
 * 小人卡对应的工地：卡片自己带工地（灯是全部工地混排的，点别的工地的灯时当前工地并不切换）。
 * 工地不在了或这个小人已经离场，返回 null —— 调用方该把卡关掉。别的工地怎么样都不影响它。
 */
export function workerCardSite(snapshot: SiteSnapshot, selection: { key: string; site: string }): SiteView | null {
  const site = snapshot.sites.find(item => item.key === selection.site) ?? null;
  if (site === null) return null;
  return site.workers.some(worker => worker.key === selection.key) ? site : null;
}

/** 意图卡里的待定条目：不是会话，所以单独一栏，带工地与楼段名 */
export interface OpenRow { site: string; feature: string; text: string }

/** 工地自己待办清单里的条目（specs/backlog.md），带工地名 */
export function backlogList(snapshot: SiteSnapshot): Array<{ site: string; text: string }> {
  return snapshot.sites.flatMap(site => site.backlog.map(text => ({ site: site.name, text: displayText(text) })));
}

export function openList(snapshot: SiteSnapshot): OpenRow[] {
  return snapshot.sites.flatMap(site => site.open.map(item =>
    ({ site: site.name, feature: item.feature, text: displayText(item.text) })));
}

export function waitingList(snapshot: SiteSnapshot): { recent: WaitRow[]; history: WaitRow[] } {
  const rows = snapshot.sites.flatMap(site => site.designer.waiting.map(item => ({
    kind: item.kind, key: shortId(item.key), since: item.since, text: displayText(item.text), site: site.name,
  })));
  const bySince = (a: WaitRow, b: WaitRow): number => a.since - b.since;
  return {
    recent: rows.filter(row => row.kind === "turn_end").sort(bySince),
    history: rows.filter(row => row.kind === "history").sort(bySince),
  };
}

export function diagnosticsView(snapshot: SiteSnapshot, site: SiteView | null): DiagnosticsView {
  return {
    at: snapshot.at,
    // 一个工地都没有时也照样能看来源和解析问题
    repo: site === null ? "" : redact(site.path),
    sources: Object.entries(snapshot.sources).map(([harness, source]) => ({
      harness, root: redact(source.root), present: source.present, sessions: source.sessions,
      badLines: source.badLines, unknownRecords: source.unknownRecords,
      lastError: source.lastError === null ? null : redact(source.lastError),
    })),
    notes: snapshot.diagnostics.map(redact),
  };
}

/** 诊断问题 = 来源的 lastError + 快照 diagnostics，已经脱敏 */
export function diagnosticsProblems(view: DiagnosticsView): string[] {
  return [
    ...view.sources.filter(source => source.lastError !== null && source.lastError !== "")
      .map(source => ui("{harness}：{error}", { harness: source.harness, error: source.lastError! })),
    ...view.notes,
  ];
}

/** 卡片里不放 Markdown 标记；保留标识符里的下划线，只去成对的强调和反引号 */
export function plainText(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/([。！？.!?：:]\s*)[-*+]\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 先脱敏再清 Markdown，最后再脱敏一次，防止去掉反引号后把 Bearer / 密钥重新拼出来 */
const displayText = (value: string): string => redact(plainText(redact(value)));

/** 会话 key 只留能区分的头尾；指纹类长串不要整条塞进卡片 */
export function shortId(value: string): string {
  const safe = redact(value);
  return safe.length <= 12 ? safe : `${safe.slice(0, 8)}…${safe.slice(-4)}`;
}

export function formatSince(now: number, since: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return ui("刚刚");
  if (minutes < 60) return ui("{minutes} 分钟前", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ui("{hours} 小时前", { hours });
  return ui("{days} 天前", { days: Math.floor(hours / 24) });
}

function locationLabel(worker: Worker): string {
  const location = worker.location;
  if (location.kind === "band") return `${location.feature} ${location.floor}`;
  if (location.kind === "office") return location.feature === undefined ? ui("办公室") : ui("办公室 {feature}", { feature: location.feature });
  return ui("工地门口");
}
