import type { Ribbon, Worker } from "../core/types";
import { FOOTER_HEIGHT } from "./constants";
import { TYPE, type Tone } from "./theme";
import { t, type Locale } from "../core/i18n";

/** 底栏起点和右界：右下角齿轮常占 32 CSS px，底栏内容停在它左边 */
const START_X = 8;
const MAX_X = 88;
const LEGEND_DOT = 3;
const LEGEND_GAP = 1;
const LEGEND_ITEM_GAP = 2;
const LIGHT_WIDTH = 12;
const LIGHT_HEIGHT = 12;
/** 一排最多 6 盏：再配上 12 逻辑 px 的格子，2× 下正好 24×24 CSS 的点击目标 */
const MAX_LIGHTS = 6;

export const TONE_LABEL = {
  waiting: "等你",
  error: "出错",
  stalled: "停工",
  working: "在干",
  idle: "空闲",
} as const;

const LEGEND_LABEL = {
  waiting: "legend.waiting", error: "legend.error", stalled: "legend.stalled",
  working: "legend.working", idle: "legend.idle",
} as const;
/** 5.5 逻辑 px 原字号下的英文短标签占位；第一行到 x=89，避开右下角齿轮。 */
const EN_TEXT_WIDTH: Record<Tone, number> = { waiting: 12, error: 13, stalled: 12, working: 14, idle: 10 };

const TONE_ORDER: readonly Tone[] = ["waiting", "error", "stalled", "working", "idle"];

/** 收起彩带的颜色和状态色同一套 */
export const RIBBON_TONE: Record<Ribbon, Tone> = {
  orange: "waiting", red: "error", yellow: "stalled", green: "working", grey: "idle",
};

export interface LegendItem {
  tone: Tone;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 底栏灯的一格：工人本身 + 它属于哪个工地（灯现在是全部工地混排的） */
export interface FooterEntry {
  worker: Worker;
  site: string;
}

export interface Light {
  key: string;
  site: string;
  tone: Tone;
  readOnly: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FooterLayout {
  top: number;
  legend: LegendItem[];
  lights: Light[];
  more: { text: string; x: number; y: number } | null;
}

/** 灯和气泡共用的颜色判定；例外的“出错”按测试失败或 API 报错算，优先于停工 */
export function workerTone(worker: Worker): Tone {
  if (worker.status === "waiting") return "waiting";
  if (worker.lastTestFailure !== null || worker.actions.at(-1)?.kind === "api_error") return "error";
  if (worker.status === "stalled") return "stalled";
  if (worker.status === "working") return "working";
  return "idle";
}

/** 底栏两行：图例一行（五色 + 文字），灯一行（最多 6 个，多出来的写 +N）。灯跨工地混排，每盏带着自己的工地 */
export function layoutFooter(entries: readonly FooterEntry[], height: number, locale: Locale = "zh-CN"): FooterLayout {
  const top = height - FOOTER_HEIGHT;
  const legend: LegendItem[] = [];
  const english = locale === "en";
  let x = english ? 4 : START_X;
  for (const tone of TONE_ORDER) {
    const label = t(locale, LEGEND_LABEL[tone]);
    const width = LEGEND_DOT + LEGEND_GAP + (english ? EN_TEXT_WIDTH[tone] : label.length * TYPE.caption);
    legend.push({ tone, label, x, y: top + 4, width, height: 10 });
    x += width + (english ? 1 : LEGEND_ITEM_GAP);
  }
  const sorted = [...entries].sort((a, b) =>
    TONE_ORDER.indexOf(workerTone(a.worker)) - TONE_ORDER.indexOf(workerTone(b.worker))
    || a.worker.statusSince - b.worker.statusSince
    || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0)
    || (a.worker.key < b.worker.key ? -1 : a.worker.key > b.worker.key ? 1 : 0));
  const lights: Light[] = [];
  let lightX = START_X;
  for (const { worker, site } of sorted.slice(0, MAX_LIGHTS)) {
    if (lightX + LIGHT_WIDTH > MAX_X) break;
    lights.push({ key: worker.key, site, tone: workerTone(worker), readOnly: worker.readOnly,
      x: lightX, y: top + 15, width: LIGHT_WIDTH, height: LIGHT_HEIGHT });
    lightX += LIGHT_WIDTH;
  }
  const hidden = sorted.length - lights.length;
  const more = hidden <= 0 ? null : { text: `+${hidden}`, x: lightX + 1, y: top + 15 };
  return { top, legend, lights, more };
}
