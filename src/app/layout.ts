import type { BuildStage, BuildingStyle, Material, MaterialShare, Ribbon, Role, SiteSnapshot, Worker } from "../core/types";
import { activeSite } from "../core/site";
import { BAND_WIDTH, BAND_X, BUBBLE_WIDTH, FLOOR_GUTTER, FOOTER_HEIGHT, GROUND_HEIGHT, LOGICAL_WIDTH, TOP_PAD } from "./constants";
import { layoutFooter, workerTone, type FooterLayout } from "./footer";
import type { Tone } from "./theme";

export interface Rect { x: number; y: number; width: number; height: number }
export interface LayoutMaterial { material: Material; x: number; width: number }
export interface LayoutCell extends Rect { done: boolean }
export interface LayoutFloor extends Rect {
  id: string;
  kind: "built" | "planned" | "progress";
  materials: LayoutMaterial[];
  cells: LayoutCell[];
}
export interface LayoutBand extends Rect {
  feature: string;
  placement: "band" | "crown";
  style: BuildingStyle;
  stage: BuildStage;
  ribbon: Ribbon;
  materials: LayoutMaterial[];
  floors: LayoutFloor[];
  scaffold: Rect[];
  tarp: string | null;
}
export interface LayoutCrown extends Rect {
  feature: string;
  material: Material;
  style: BuildingStyle;
  stage: BuildStage;
  mastX: number;
  mastY: number;
  mastHeight: number;
}
export interface LayoutOffice extends Rect { label: string; style: BuildingStyle; stage: BuildStage }
export interface LayoutWorker extends Rect { key: string; role: Role; tone: Tone; readOnly: boolean; spot: string | null }
export interface LayoutBubble extends Rect {
  key: string;
  tone: Tone;
  lines: string[];
  anchorX: number;
  anchorY: number;
}
export type LayoutHit =
  | { kind: "band"; feature: string }
  | { kind: "office" }
  | { kind: "designer" }
  | { kind: "worker"; key: string; site: string | null }
  | { kind: "bubble"; key: string; site: string | null }
  | { kind: "light"; key: string; site: string };

export interface BuildingLayout {
  width: number;
  height: number;
  floorHeight: number;
  bands: LayoutBand[];
  crown: LayoutCrown | null;
  ground: Rect;
  office: LayoutOffice | null;
  designer: Rect;
  workers: LayoutWorker[];
  bubbles: LayoutBubble[];
  footer: FooterLayout;
  /** 当前画的是哪个工地：小人、气泡的命中都归它；灯自己带工地 */
  siteKey: string | null;
  hitRects: Rect[];
}

/** 演示模式不画气泡，也不让它们占命中矩形 */
export function withoutBubbles(layout: BuildingLayout): BuildingLayout {
  const hidden = new Set<Rect>(layout.bubbles);
  return { ...layout, bubbles: [], hitRects: layout.hitRects.filter(rect => !hidden.has(rect)) };
}

/** 气泡只常显等你 / 出错 / 停工；其余状态点小人看卡片 */
const ALWAYS_VISIBLE: ReadonlySet<Tone> = new Set(["waiting", "error", "stalled"]);
const BUBBLE_LINE_HEIGHT = 7;
const BUBBLE_PADDING = 5;
const BUBBLE_CHARS = 12;
/** 小人只在楼层号栏右侧活动 */
const WORK_X = BAND_X + FLOOR_GUTTER + 2;
const WORK_WIDTH = BAND_WIDTH - FLOOR_GUTTER - 4;
/** 没有意图卡的工地，楼体最多占可用高度的这么多 */
const MINI_MAX_SHARE = 0.25;
/** 层高的参照层数：十层铺满可用高度 */
const FLOOR_REFERENCE = 10;

/** 纯布局：不碰 DOM，供渲染和测试共用 */
export function layoutBuilding(snapshot: SiteSnapshot, height: number, stableX?: ReadonlyMap<string, number>): BuildingLayout {
  const bottom = height - FOOTER_HEIGHT - GROUND_HEIGHT;
  const usable = bottom - TOP_PAD;
  const site = activeSite(snapshot);
  if (site === null) return emptyLayout(height);
  const counts = site.bands.map(band => Math.max(1, band.plan?.floors.length ?? 1));
  const total = counts.reduce((sum, n) => sum + n, 0);
  // 层高固定成"十层刚好铺满"的高度：楼层增减时楼往上长，不重算每层高度（否则整栋楼跟着快照呼吸）；
  // 真超过十层才按比例收，保证不挤出窗口
  const floorHeight = total > 0 ? Math.min(usable / FLOOR_REFERENCE, usable / total) : 0;
  const bands: LayoutBand[] = [];
  let cursor = bottom;

  site.bands.forEach((band, index) => {
    const count = counts[index];
    // 矮楼不跟真楼体抢高度：最多占可用高度的四分之一，也不超过普通楼层高
    const bandHeight = band.mini ? Math.min(floorHeight, usable * MINI_MAX_SHARE) : count * floorHeight;
    const unit = bandHeight / count;
    const y = cursor - bandHeight;
    cursor = y;
    // 材质从楼层号那一栏右边开始分：编号一栏有自己的底色，压在材质上会吃掉最左边那段
    const materials = materialRects(band.materials, BAND_X + FLOOR_GUTTER + 1, BAND_WIDTH - FLOOR_GUTTER - 1);
    const floors: LayoutFloor[] = (band.plan?.floors ?? []).map((floor, floorIndex) => {
      const floorY = y + bandHeight - (floorIndex + 1) * unit;
      // 楼体的第一层固定画成实体：它是地基，不跟着切片进度变空；脚手架也从第二层起搭
      const kind = index === 0 && floorIndex === 0 ? "built" : floor.kind;
      const cells = kind === "progress" && floor.kind === "progress" ? cellRects(floor.cells, floor.doneCells, floorY, unit) : [];
      return { id: floor.id, kind, x: BAND_X, y: floorY, width: BAND_WIDTH, height: unit,
        materials, cells };
    });
    const scaffold = floors.filter((floor, floorIndex) => band.scaffold.includes(floor.id) && !(index === 0 && floorIndex === 0))
      .map(floor => ({ x: BAND_X, y: floor.y, width: BAND_WIDTH, height: floor.height }));
    bands.push({ feature: band.feature, placement: band.placement, style: band.style, stage: band.stage,
      ribbon: band.ribbon, x: BAND_X, y, width: BAND_WIDTH,
      height: bandHeight, materials, floors, scaffold, tarp: band.tarp });
  });

  const crownBand = site.bands.find(band => band.placement === "crown");
  const crownWidth = 56;
  const crown = crownBand === undefined ? null : {
    x: BAND_X + (BAND_WIDTH - crownWidth) / 2, y: cursor - 13, width: crownWidth, height: 13,
    feature: crownBand.feature,
    material: crownBand.materials[0]?.material ?? "metal",
    style: crownBand.style, stage: crownBand.stage,
    mastX: BAND_X + BAND_WIDTH / 2, mastY: cursor - 19, mastHeight: 6,
  };
  const ground = { x: 0, y: bottom, width: LOGICAL_WIDTH, height: GROUND_HEIGHT };
  const officeEntry = site.office[0];
  const office = officeEntry === undefined ? null : {
    x: 2, y: bottom - 8, width: 12, height: 8, label: "办公室", style: officeEntry.style, stage: officeEntry.stage,
  };
  const designer = { x: 22, y: bottom - 12, width: 8, height: 12 };
  const placed = placeWorkers(site.workers, bands, bottom, stableX);
  const workers = placed.map(item => item.worker);
  const bubbles = placeBubbles(placed, bands, bottom);
  // 灯跨工地混排：别的工地有人在等你，底栏也能看见
  const footer = layoutFooter(snapshot.sites.flatMap(item => item.workers.map(worker => ({ worker, site: item.key }))), height);
  const hitRects = [...bands.map(band => ({ x: band.x, y: band.y, width: band.width, height: band.height })),
    ...(crown === null ? [] : [crown]), ...(office === null ? [] : [office]), designer,
    ...workers, ...bubbles, ...footer.lights];
  return { width: LOGICAL_WIDTH, height, floorHeight, bands, crown, ground, office, designer, workers, bubbles, footer, siteKey: site.key, hitRects };
}

/** 没有任何工地时的空布局：只有地面、设计师和底栏 */
function emptyLayout(height: number): BuildingLayout {
  const bottom = height - FOOTER_HEIGHT - GROUND_HEIGHT;
  const ground = { x: 0, y: bottom, width: LOGICAL_WIDTH, height: GROUND_HEIGHT };
  const designer = { x: 22, y: bottom - 12, width: 8, height: 12 };
  return { width: LOGICAL_WIDTH, height, floorHeight: 0, bands: [], crown: null, ground, office: null, designer,
    workers: [], bubbles: [], footer: layoutFooter([], height), siteKey: null, hitRects: [designer] };
}

interface PlacedWorker {
  worker: LayoutWorker;
  text: string;
  /** 气泡底边的上限：工人在楼层里时是所在层顶（跳过其上已是当前切片的层） */
  bubbleBottom: number;
}

function placeWorkers(workers: readonly Worker[], bands: readonly LayoutBand[], bottom: number,
  stableX?: ReadonlyMap<string, number>): PlacedWorker[] {
  const groups = new Map<string, { band: LayoutBand; floor: LayoutFloor; workers: Worker[] }>();
  const ground: Worker[] = [];
  for (const worker of workers) {
    const location = worker.location;
    if (location.kind === "band") {
      const band = bands.find(item => item.feature === location.feature);
      const index = band?.floors.findIndex(floor => floor.id === location.floor) ?? -1;
      const floor = index < 0 ? undefined : band?.floors[index];
      if (band !== undefined && floor !== undefined) {
        const key = `${band.feature}\u0000${floor.id}`;
        const group = groups.get(key) ?? { band, floor, workers: [] };
        group.workers.push(worker);
        groups.set(key, group);
        continue;
      }
    }
    ground.push(worker);
  }

  const placed: PlacedWorker[] = [];
  for (const { band, floor, workers: here } of groups.values()) {
    const index = band.floors.indexOf(floor);
    let bubbleBottom = floor.y;
    for (let above = index + 1; above < band.floors.length && band.floors[above].kind === "progress"; above++) {
      bubbleBottom = band.floors[above].y;
    }
    const sorted = [...here].sort(byStart);
    const stable = sorted.map(worker => stableX?.get(worker.key));
    // 原有人的位置先占住，新来的人再避让；否则新来的人可能先占掉旧人的 x
    const used: number[] = stable.filter((x): x is number => x !== undefined);
    sorted.forEach((worker, i) => {
      const size = workerSize(worker);
      const step = sorted.length <= 1 ? 0 : Math.min(10, (WORK_WIDTH - size.width) / (sorted.length - 1));
      const normal = sorted.length === 1 ? BAND_X + FLOOR_GUTTER + (BAND_WIDTH - FLOOR_GUTTER) / 2 - size.width / 2 : WORK_X + i * step;
      const right = BAND_X + BAND_WIDTH - size.width;
      const free = (candidate: number): boolean => candidate >= WORK_X && candidate <= right
        && !used.some(other => Math.abs(other - candidate) < size.width);
      let x = stable[i] ?? normal;
      if (stable[i] === undefined) {
        // 新来的人找离习惯位置最近的空位，找不到才留在原位（人比楼段宽时）
        if (!free(x)) {
          let best: number | null = null;
          for (let candidate = WORK_X; candidate <= right; candidate++) {
            if (free(candidate) && (best === null || Math.abs(candidate - normal) < Math.abs(best - normal))) best = candidate;
          }
          if (best !== null) x = best;
        }
        used.push(x);
      }
      placed.push({ worker: { ...decorate(worker), x, y: floor.y + floor.height - size.height - 0.5, ...size },
        text: worker.bubble, bubbleBottom });
    });
  }
  [...ground].sort(byStart).forEach((worker, i) => {
    const size = workerSize(worker);
    const height = size.height;
    const x = Math.min(34 + i * 10, LOGICAL_WIDTH - size.width - 4);
    placed.push({ worker: { ...decorate(worker), x, y: bottom - height, ...size },
      text: worker.bubble, bubbleBottom: bottom - height });
  });
  return placed;
}

const byStart = (a: Worker, b: Worker): number => a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const workerSize = (worker: Worker): { width: number; height: number } =>
  worker.level >= 3 ? { width: 6, height: 8 } : { width: 8, height: 12 };

const decorate = (worker: Worker): Omit<LayoutWorker, "x" | "y" | "width" | "height"> =>
  ({ key: worker.key, role: worker.role, tone: workerTone(worker), readOnly: worker.readOnly,
    spot: worker.location.kind === "band" ? `${worker.location.feature}\u0000${worker.location.floor}` : null });

/** 气泡从下往上排；优先放在工人上一层，冲突时就近换层或上下错开，且不碰当前切片的楼层 */
function placeBubbles(placed: readonly PlacedWorker[], bands: readonly LayoutBand[], bottom: number): LayoutBubble[] {
  const bubbles: LayoutBubble[] = [];
  const floors = bands.flatMap(band => band.floors);
  const blocked = floors.filter(floor => floor.kind === "progress");
  const ordered = [...placed].sort((a, b) => b.bubbleBottom - a.bubbleBottom);
  for (const item of ordered) {
    if (!ALWAYS_VISIBLE.has(item.worker.tone)) continue;
    const lines = bubbleLines(item.text);
    if (lines.length === 0) continue;
    const width = BUBBLE_WIDTH;
    const height = lines.length * BUBBLE_LINE_HEIGHT + BUBBLE_PADDING;
    const preferredX = clamp(item.worker.x + item.worker.width / 2 - width / 2, BAND_X, BAND_X + BAND_WIDTH - width);
    const preferredY = item.bubbleBottom - height - 2;
    const xs = unique([preferredX, BAND_X, BAND_X + BAND_WIDTH - width]);
    const ys = unique([preferredY, ...floors.map(floor => floor.y + floor.height - height - 1.5),
      ...bubbles.flatMap(bubble => [bubble.y + bubble.height, bubble.y - height])]);
    let best: { x: number; y: number; overlap: number; distance: number } | null = null;
    for (const rawY of ys) {
      const y = Math.max(TOP_PAD, Math.min(rawY, bottom - height));
      for (const x of xs) {
        const candidate = { x, y, width, height };
        if (blocked.some(floor => overlaps(candidate, floor))) continue;
        const overlap = bubbles.reduce((sum, bubble) => sum + overlapArea(bubble, candidate), 0);
        const distance = Math.abs(y - preferredY) + Math.abs(x - preferredX) * 0.2;
        if (best === null || overlap < best.overlap || (overlap === best.overlap && distance < best.distance)) {
          best = { x, y, overlap, distance };
        }
      }
    }
    const chosen = best ?? { x: preferredX, y: clamp(preferredY, TOP_PAD, bottom - height) };
    bubbles.push({ key: item.worker.key, tone: item.worker.tone, lines, x: chosen.x, y: chosen.y, width, height,
      anchorX: item.worker.x + item.worker.width / 2, anchorY: item.worker.y });
  }
  return bubbles;
}

const unique = (values: readonly number[]): number[] => [...new Set(values)];

const overlapArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** 按字符折行，尽量在空格处断开；两行放不下时第二行以省略号收尾 */
export function bubbleLines(text: string, perLine = BUBBLE_CHARS): string[] {
  let rest = Array.from(text.replace(/\s+/g, " ").trim());
  if (rest.length === 0) return [];
  const lines: string[] = [];
  while (rest.length > 0 && lines.length < 2) {
    if (rest.length <= perLine) { lines.push(rest.join("")); return lines; }
    let cut = perLine;
    for (let i = perLine; i > 0; i--) {
      if (rest[i] === " ") { cut = i; break; }
    }
    lines.push(rest.slice(0, cut).join("").trimEnd());
    rest = rest.slice(cut);
    while (rest[0] === " ") rest.shift();
  }
  if (rest.length > 0) lines[1] = `${lines[1].slice(0, perLine - 1).trimEnd()}…`;
  return lines;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** 归一化材质份额；配置缺省或份额为 0 时用混凝土画满整段 */
function materialRects(materials: readonly MaterialShare[], x: number, width: number): LayoutMaterial[] {
  const shares = materials.filter(m => m.share > 0);
  const total = shares.reduce((sum, m) => sum + m.share, 0);
  if (total <= 0) return [{ material: "concrete", x, width }];
  let left = x;
  return shares.map((share, index) => {
    const w = index === shares.length - 1 ? x + width - left : (width * share.share) / total;
    const rect = { material: share.material, x: left, width: w };
    left += w;
    return rect;
  });
}

function cellRects(count: number, doneCells: number, floorY: number, floorHeight: number): LayoutCell[] {
  if (count <= 0) return [];
  const left = BAND_X + FLOOR_GUTTER + 1;
  const span = BAND_WIDTH - FLOOR_GUTTER - 2;
  // 格子多到放不下 1 px 间隔时把间隔压到 0 再平分，宽度不会变成负数（否则整层格子画不出来）
  const gap = count > 1 ? Math.min(1, Math.max(0, (span - count) / (count - 1))) : 0;
  const width = (span - gap * (count - 1)) / count;
  const height = Math.max(4, Math.min(16, floorHeight - 2));
  return Array.from({ length: count }, (_, index) => ({
    x: left + index * (width + gap), y: floorY + 1,
    width, height, done: index < doneCells,
  }));
}

const inside = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;

/** 命中顺序和绘制顺序相反：气泡、小人、设计师、办公室、穹顶、楼段、底栏灯 */
export function hitTest(layout: BuildingLayout, x: number, y: number): LayoutHit | null {
  const bubble = layout.bubbles.find(item => inside(item, x, y));
  if (bubble !== undefined) return { kind: "bubble", key: bubble.key, site: layout.siteKey };
  const worker = layout.workers.find(item => inside(item, x, y));
  if (worker !== undefined) return { kind: "worker", key: worker.key, site: layout.siteKey };
  if (inside(layout.designer, x, y)) return { kind: "designer" };
  if (layout.office !== null && inside(layout.office, x, y)) return { kind: "office" };
  if (layout.crown !== null && inside(layout.crown, x, y)) return { kind: "band", feature: layout.crown.feature };
  const band = layout.bands.find(item => inside(item, x, y));
  if (band !== undefined) return { kind: "band", feature: band.feature };
  const light = layout.footer.lights.find(item => inside(item, x, y));
  return light === undefined ? null : { kind: "light", key: light.key, site: light.site };
}
