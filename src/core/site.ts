// 工地：一个 git 仓库（worktree 归一）或一个普通运行目录；快照里每个工地一份 SiteView。
import { deriveActions } from "./actions";
import { attribute, inferRole, modelFamily } from "./attribution";
import { bandCard, orderFeatures, resolveStyle, ribbonColor, stageOf } from "./building";
import { inferFloors } from "./floors";
import { t, type Locale } from "./i18n";
import { redact } from "./redact";
import { brief } from "./text";
import { traceOf } from "./trace";
import { HISTORY_AFTER_MS, sessionStatus, waitingSource } from "./status";
import type { Band, BandCard, BuildingStyle, FloorId, FloorView, Location, SessionState, SiteConfig, SiteEvent, SiteInput, SiteSnapshot, SiteView, WaitItem, Worker } from "./types";

/** 当前工地；快照里指定的那个不在了就退回第一个，一个都没有时是 null */
export function activeSite(snapshot: SiteSnapshot): SiteView | null {
  return snapshot.sites.find(site => site.key === snapshot.active) ?? snapshot.sites[0] ?? null;
}

/** 意图卡没有可用楼层时，小人站的占位层；篷布楼段不画脚手架 */
const TARP_FLOOR: FloorId = "S1";

/** 没有意图卡的工地画的那层矮楼：混凝土、不盖篷布，卡片里没有任何数字；它已经是竣工的楼 */
function miniBand(site: SiteInput, style: BuildingStyle): Band {
  const card: BandCard = { title: null, risk: null, ac: null, open: null, openItems: null, slices: null, current: null, status: null,
    source: "none", specsDir: site.path };
  return { feature: site.name, placement: "band", materials: [{ material: "concrete", share: 100 }], configured: true,
    style, stage: "done",
    plan: { floors: [{ id: TARP_FLOOR, kind: "built" }], firstUnfinished: null }, tarp: null, scaffold: [], ribbon: "grey", card, mini: true };
}

/** 没有意图卡时：一段一会话、一层一待办；最多 6 段、每段 12 层 */
const TODO_BAND_LIMIT = 6;
const TODO_FLOOR_LIMIT = 12;

/** 会话在楼里叫什么：首条提示的首行，没有就用 harness · 短 ID */
function sessionLabel(session: SessionState): string {
  const first = (session.firstPrompt ?? "").split(String.fromCharCode(10))[0].trim();
  const safe = redact(first);
  const base = safe === "" ? `${session.meta.harness} · ${session.meta.nativeId.slice(0, 6)}` : safe.slice(0, 16);
  return redact(base);
}

function todoBand(session: SessionState, feature: string, style: BuildingStyle): Band {
  // 计数和阶段用完整列表；楼层只画前 12 条（SITE-7）
  const all = (session.todos ?? []).map(item => ({ ...item, text: redact(item.text) }));
  const done = all.filter(item => item.status === "completed").length;
  const total = all.length;
  const shown = all.slice(0, TODO_FLOOR_LIMIT);
  const active = all.findIndex(item => item.status === "in_progress");
  const floors: FloorView[] = shown.map((item, index) => {
    const id = `${index + 1}`;
    if (item.status === "completed") return { id, kind: "built" };
    if (index === active) return { id, kind: "progress", cells: 0, doneCells: 0 };
    return { id, kind: "planned" };
  });
  const card: BandCard = {
    title: feature, risk: null, ac: null, open: null, openItems: null,
    slices: { total, done },
    current: active < 0 ? null : { id: `${active + 1}`, title: all[active].text, stepsDone: 0, stepsTotal: 0 },
    status: total > 0 && done === total ? "done" : "in-progress",
    source: "todos", specsDir: session.meta.cwd,
  };
  return { feature, placement: "band", materials: [{ material: "concrete", share: 100 }], configured: false,
    style, stage: stageOf(total, done),
    plan: { floors, firstUnfinished: floors.find(floor => floor.kind !== "built")?.id ?? null },
    tarp: null, scaffold: [], ribbon: "grey", card, mini: false };
}

/** 没有意图卡的工地：一级会话里带非空待办的各占一段；子 agent 跟父会话站同一段 */
function todoBands(site: SiteInput, style: BuildingStyle): { bands: Band[]; byKey: Map<string, Band> } {
  const sessions = site.sessions
    .filter(session => session.meta.level === 1 && (session.todos?.length ?? 0) > 0)
    .sort((a, b) => a.meta.startedAt - b.meta.startedAt || (a.meta.key < b.meta.key ? -1 : a.meta.key > b.meta.key ? 1 : 0))
    .slice(0, TODO_BAND_LIMIT);
  const used = new Set<string>();
  const bands: Band[] = [];
  const byKey = new Map<string, Band>();
  for (const session of sessions) {
    const base = sessionLabel(session);
    let label = base;
    if (used.has(label)) label = `${base} · ${session.meta.nativeId.slice(0, 4)}`;
    for (let n = 2; used.has(label); n++) label = `${base} · ${n}`;
    used.add(label);
    const band = todoBand(session, label, style);
    bands.push(band);
    byKey.set(session.meta.key, band);
  }
  return { bands, byKey };
}

/** 一个工地的楼段、工人和等你清单；来源和诊断在快照层 */
export function buildSite(site: SiteInput, config: SiteConfig, now: number): SiteView {
  const ordered = orderFeatures(site.features, config.features);
  const todo = site.features.length === 0 ? todoBands(site, config.style) : { bands: [] as Band[], byKey: new Map<string, Band>() };
  const mini = site.features.length === 0 && todo.bands.length === 0;
  const bands: Band[] = todo.bands.length > 0 ? todo.bands
    : mini ? [miniBand(site, config.style)] : ordered.bands.map(({ input: f, config: c, configured }) => {
    const card = bandCard(f);
    return {
      feature: f.name, placement: c.placement === "crown" ? "crown" : "band", materials: c.materials.map(m => ({ ...m })), configured,
      // 造型跟着 feature 走；阶段只看切片比例，篷布段（没有切片）就是围挡，不在这里猜
      style: resolveStyle(c.style, config.style),
      stage: card.slices === null ? "empty" : stageOf(card.slices.total, card.slices.done),
      plan: f.card !== undefined && f.card.slices.length > 0 ? inferFloors(f.card) : null,
      tarp: f.card === undefined ? "图纸读不出" : f.card.slices.length === 0 ? "图纸未拆切片" : null,
      scaffold: [], ribbon: "grey", card, mini: false,
    };
  });
  // 矮楼没有办公室：它只是一层混凝土，不该再画一座附楼
  const officeConfig = new Map(config.features.map(item => [item.name, item]));
  const office = site.features.length === 0 ? [] : ordered.office.map(f => {
    const card = bandCard(f);
    return { feature: f.name, card,
      style: resolveStyle(officeConfig.get(f.name)?.style, config.style),
      stage: card.slices === null ? "empty" as const : stageOf(card.slices.total, card.slices.done) };
  });
  // 待定跟意图卡走，跟楼层怎么画无关：矮楼、篷布、办公室的都要收进来
  // 待定跟意图卡走，跟楼层怎么画无关（矮楼、篷布、办公室都算）；同一个 feature 配了两处时只收一次
  const seen = new Set<string>();
  const open = [...ordered.bands.map(item => item.input), ...ordered.office].flatMap(input => {
    if (seen.has(input.name)) return [];
    seen.add(input.name);
    const feature = redact(input.card?.title ?? input.name);
    return (input.card?.openItems ?? []).map(text => ({ feature, text: redact(text) }));
  });
  const parentOf = new Map(site.sessions.map(session => [session.meta.key, session.meta.parentKey]));
  const todoBandOf = (session: SessionState): Band | undefined => {
    let key: string | undefined = session.meta.key;
    for (let i = 0; key !== undefined && i < 8; i++) {
      const band = todo.byKey.get(key);
      if (band !== undefined) return band;
      key = parentOf.get(key);
    }
    return undefined;
  };
  const all = site.sessions.map(s => makeWorker(s, site, config, now, bands, office, mini, todoBandOf(s)));
  const workers = all.filter(x => x.onSite).map(x => x.worker).sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const band of bands) {
    const here = workers.filter(w => w.location.kind === "band" && w.location.feature === band.feature);
    // 矮楼不搭脚手架：它不是"盖到一半"，只是没有意图卡
    if (!band.mini && band.tarp === null && band.plan !== null) {
      band.scaffold = band.plan.floors.filter(f => here.some(w => w.location.kind === "band" && w.location.floor === f.id)).map(f => f.id);
      if (here.length === 0 && band.card.status === "in-progress" && band.plan.firstUnfinished) band.scaffold = [band.plan.firstUnfinished];
    }
    band.ribbon = ribbonColor(band.card.status, here);
  }
  const waiting = all.filter(x => x.worker.status === "waiting").sort((a, b) => a.worker.statusSince - b.worker.statusSince);
  const recent: WaitItem[] = waiting.filter(x => x.onSite && x.worker.statusSince >= now - HISTORY_AFTER_MS)
    .map(({ worker: w }) => ({ kind: "turn_end", key: w.key, since: w.statusSince, text: w.bubble }));
  const history: WaitItem[] = waiting.filter(x => x.worker.statusSince < now - HISTORY_AFTER_MS)
    .map(({ worker: w }) => ({ kind: "history", key: w.key, since: w.statusSince, text: w.bubble }));
  return { key: site.key, path: site.path, name: redact(site.name), kind: site.kind, mini, bands, office, open,
    backlog: site.backlog.map(redact), workers,
    designer: { waiting: [...recent, ...history] } };
}

/** 钉住的切片存在就用它；否则第一个未完成层；都完成时站最上面一层 */
function floorFor(pinned: FloorId | null, band: Band | undefined): FloorId {
  const floors = band?.plan?.floors ?? [];
  if (pinned !== null && floors.some(f => f.id === pinned)) return pinned;
  return band?.plan?.firstUnfinished ?? floors[floors.length - 1]?.id ?? TARP_FLOOR;
}

function makeWorker(s: SessionState, site: SiteInput, config: SiteConfig, now: number, bands: Band[], office: SiteView["office"], mini: boolean, todoBand?: Band): { worker: Worker; onSite: boolean } {
  const locale = config.locale ?? "zh-CN";
  const a = attribute(s, site.features.map(f => f.name), config.pins[s.meta.key]);
  const actions = deriveActions(s, locale).map(action => ({ ...action, text: redact(action.text) }));
  const status = sessionStatus(s, actions.at(-1) ?? null, now, config.thresholds, locale);
  const detail = detailOf(s, status, locale);
  const band = "feature" in a ? bands.find(b => b.feature === a.feature) : undefined;
  let location: Location;
  if (todoBand !== undefined) location = { kind: "band", feature: todoBand.feature, floor: floorFor(null, todoBand) };
  else if (mini) location = { kind: "band", feature: site.name, floor: TARP_FLOOR };
  else if ("feature" in a) location = office.some(o => o.feature === a.feature) ? { kind: "office", feature: a.feature }
    : { kind: "band", feature: a.feature, floor: floorFor(a.floor, band) };
  else location = a.rule === "governance" ? { kind: "office" } : { kind: "gate" };
  const role = inferRole(s.firstPrompt, s.model, s.meta.level);
  const lastTest = actions.findLast(x => x.kind === "test");
  const worker: Worker = { key: s.meta.key, harness: s.meta.harness, nativeId: s.meta.nativeId, level: s.meta.level, parentKey: s.meta.parentKey ?? null,
    readOnly: true, role: role.role, roleReason: role.reason, model: s.model === undefined ? null : redact(s.model), modelFamily: modelFamily(s.model), location,
    attribution: todoBand !== undefined ? { rule: "none", detail: t(locale, "会话待办") } : { ...a, detail: redact(a.detail) }, status: status.status, statusSince: status.since, bubble: redact(status.text),
    statusDetail: detail, trace: traceOf(s.events, locale), actions: actions.slice(-20),
    todos: s.todos ? s.todos.map(t => ({ ...t, text: redact(t.text) })) : null,
    lastTestFailure: lastTest?.outcome === "fail" ? { at: lastTest.at, text: redact(lastTest.text) } : null,
    startedAt: s.meta.startedAt, lastEventAt: s.lastEventAt,
    lastUserAt: s.meta.level === 1 ? s.events.findLast(e => e.kind === "prompt" && e.from === "user")?.ts ?? null : null,
    file: s.meta.file, cwd: s.meta.cwd };
  return { worker, onSite: status.onSite };
}

/** 等你用问题原文；在干优先用最后一段回复 / 思考，再退到最近动作；统一压到 4–5 句 */
function detailOf(s: SessionState, status: ReturnType<typeof sessionStatus>, locale: Locale): string | null {
  if (status.status === "waiting") {
    const source = waitingSource(s) ?? status.detail;
    return source === null ? null : brief(source);
  }
  const promptIndex = s.events.findLastIndex(ev => ev.kind === "prompt" && ev.from === "user");
  const current = promptIndex === -1 ? s.events : s.events.slice(promptIndex + 1);
  if (status.status === "working") {
    const prose = current.findLast((ev): ev is Extract<SiteEvent, { kind: "text" | "thinking" }> =>
      (ev.kind === "text" || ev.kind === "thinking") && ev.text.trim() !== "");
    if (prose !== undefined) return brief(prose.text);
  }
  const recent = deriveActions({ ...s, events: current }, locale).slice(-3).map(action => action.text).filter(text => text !== "");
  return recent.length === 0 ? null : brief(t(locale, "最近：{actions}", { actions: recent.join(t(locale, "core.actionSeparator")) }));
}
