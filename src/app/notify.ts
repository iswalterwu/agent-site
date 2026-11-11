import { redact } from "../core/redact";
import type { SiteSnapshot } from "../core/types";
import type { BridgeAsk, BridgeSessionView } from "../main/bridge-service";

/** 一条桌面通知：同一个 askId 只响一次 */
export interface AskNotice { askId: string; title: string; body: string }

/** 正文里放问题的前一段就够；完整问题在窗口里看 */
const BODY_LIMIT = 120;
/** 一条提问记这么久：桥接断线会暂时清空提问列表，宽限期内重连会重发同一个 askId，不能因此再弹一次 */
export const SEEN_TTL_MS = 60 * 60_000;
/** 演示模式（录屏、共享屏幕）不给正文：普通文本里的客户名、报价，脱敏规则认不出来 */
const DEMO_BODY = "演示模式已隐藏决策内容";

/** 见过的一条提问：lastSeen 是最近一次还在列表里的时间；absentSince 是它第一次从列表里消失的时间 */
export interface SeenAsk { lastSeen: number; absentSince?: number }

export interface NotifyInput {
  snapshot: SiteSnapshot;
  asks: readonly BridgeAsk[];
  seen: ReadonlyMap<string, SeenAsk>;
  /** 窗口有焦点（或者还没建好）：不弹，但照样登记"见过了" */
  focused: boolean;
  demo: boolean;
  dnd: boolean;
  now: number;
}

/**
 * 纯函数：算出这一轮该弹哪些，以及下一轮的"见过"记录。
 * 见过就是见过——只要这条提问还在列表里就不再弹；从列表里消失之后才开始算一小时，
 * 满了一小时才忘掉。所以断线清空、宽限期内重连重发同一个 askId 不会再弹一次；
 * 机器休眠很久之后先看到断线、马上又重连，也不会因为"隔了很久"就重弹。
 */
export function planNotices(input: NotifyInput): { notices: AskNotice[]; seen: Map<string, SeenAsk> } {
  const now = input.now;
  const present = new Set(input.asks.map(ask => ask.askId));
  const seen = new Map<string, SeenAsk>();
  for (const [askId, record] of input.seen) {
    if (present.has(askId)) { seen.set(askId, { lastSeen: now }); continue; } // 还在：续命、清掉缺席时间
    const absentSince = record.absentSince ?? now; // 这一轮刚消失：从现在起算
    if (now - absentSince < SEEN_TTL_MS) seen.set(askId, { lastSeen: record.lastSeen, absentSince });
  }
  const siteOf = new Map<string, string>();
  for (const site of input.snapshot.sites) for (const worker of site.workers) siteOf.set(worker.key, site.name);
  const notices: AskNotice[] = [];
  for (const ask of input.asks) {
    const known = seen.has(ask.askId);
    seen.set(ask.askId, { lastSeen: now });
    if (known || input.focused || input.dnd) continue;
    notices.push({
      askId: ask.askId,
      title: `等你回答 · ${siteOf.get(ask.sessionKey) ?? "工地"}`,
      body: input.demo ? DEMO_BODY : clip(redact(ask.question)),
    });
  }
  return { notices, seen };
}

/** 按码点截断：按 UTF-16 下标切会把 emoji 之类的代理对劈成半个 */
const clip = (text: string): string => {
  const points = [...text];
  return points.length <= BODY_LIMIT ? text : `${points.slice(0, BODY_LIMIT - 1).join("")}…`;
};

/** 除决策以外的状态提醒：等你、中途断掉、断线时还暂停着 */
export type AlertKind = "waiting" | "stalled" | "offline-paused";

export interface Alert { key: string; title: string; body: string }

export interface AlertInput {
  snapshot: SiteSnapshot;
  asks: readonly BridgeAsk[];
  sessions: readonly BridgeSessionView[];
  /** 上一轮在线且暂停着的会话：这一轮不在线了就说明它掉线了（断线的会话直接从 `sessions()` 消失） */
  paused: ReadonlySet<string>;
  /** 上一轮已经在提醒的组合（`<会话键>:<种类>`）；从这里消失就重新武装 */
  active: ReadonlySet<string>;
  focused: boolean;
  demo: boolean;
  dnd: boolean;
}

const ALERT_TITLE: Record<AlertKind, string> = { waiting: "等你", stalled: "停住了", "offline-paused": "断线" };

const ALERT_BODY: Record<AlertKind, string> = {
  waiting: "在等你",
  stalled: "中途断掉了",
  "offline-paused": "暂停中的会话掉线了",
};

/**
 * 纯函数：算出这一轮该弹哪些状态提醒，以及下一轮的"已经在提醒"集合。
 * 只在**进入**这个状态的那一轮提醒一次：状态一直挂着不会重复弹，解除之后再进入才重新提醒。
 * 有悬着决策的会话不算"等你"——那条提问自己会弹通知。
 */
export function planAlerts(input: AlertInput): { alerts: Alert[]; active: Set<string>; paused: Set<string> } {
  const live = new Set<string>();
  const alerts: Alert[] = [];
  const asked = new Set(input.asks.map(ask => ask.sessionKey));
  const siteOf = new Map<string, string>();
  for (const site of input.snapshot.sites) for (const worker of site.workers) siteOf.set(worker.key, site.name);
  const add = (sessionKey: string, kind: AlertKind, bubble = ALERT_BODY[kind]): void => {
    const key = `${sessionKey}:${kind}`;
    live.add(key);
    if (input.active.has(key) || input.focused || input.dnd) return;
    alerts.push({ key, title: `${ALERT_TITLE[kind]} · ${siteOf.get(sessionKey) ?? "工地"}`, body: input.demo ? DEMO_BODY : clip(redact(bubble)) });
  };
  for (const site of input.snapshot.sites) {
    for (const worker of site.workers) {
      if (worker.status === "waiting") {
        // 有悬着决策的会话不算"等你"（那条提问自己会弹），但要记下"这一轮它已经在等"，
        // 否则决策结束、asks 一空就会补弹一条
        if (asked.has(worker.key)) live.add(`${worker.key}:waiting`);
        else add(worker.key, "waiting", worker.bubble);
      } else if (worker.status === "stalled") add(worker.key, "stalled");
    }
  }
  // 断线的会话会从 sessions() 里整条消失，所以拿上一轮"在线且暂停"的名单对比：不在线了就提醒
  const onlineNow = new Set(input.sessions.filter(session => session.online).map(session => session.key));
  for (const key of input.paused) if (!onlineNow.has(key)) add(key, "offline-paused");
  const paused = new Set(input.sessions.filter(session => session.online && session.paused).map(session => session.key));
  return { alerts, active: live, paused };
}
