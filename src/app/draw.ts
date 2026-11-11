import { redact } from "../core/redact";
import type { BuildingStyle, Material, Role } from "../core/types";
import { ribbonSegments } from "./collapse";
import { FLOOR_GUTTER, FOOTER_HEIGHT } from "./constants";
import type { BuildingLayout, LayoutBand, LayoutBubble, LayoutCell, LayoutCrown, LayoutFloor, LayoutMaterial, LayoutOffice, LayoutWorker, Rect } from "./layout";
import { RIBBON_TONE } from "./footer";
import { COLOR, FONT_SANS, GARDEN, PLATE, STYLE, TONE, TYPE } from "./theme";

/**
 * 画法约定：结构线用整数逻辑像素，细部可以落 0.5 逻辑 px（2× 下 1 CSS px）；
 * 主光从左上打，亮边在上/左，暗边在下/右；材质低彩度，信号色只留给状态。
 */

const R = Math.round;
type Box = { x: number; y: number; w: number; h: number };
const box = (rect: Rect): Box => {
  const x = R(rect.x), y = R(rect.y);
  return { x, y, w: R(rect.x + rect.width) - x, h: R(rect.y + rect.height) - y };
};

const COLORS: Record<Material, { base: string; dark: string; light: string }> = {
  brick: { base: COLOR.brick, dark: COLOR.brickDark, light: COLOR.brickLight },
  glass: { base: COLOR.glass, dark: COLOR.glassDark, light: COLOR.glassLight },
  metal: { base: COLOR.metal, dark: COLOR.metalDark, light: COLOR.metalLight },
  concrete: { base: COLOR.concrete, dark: COLOR.concreteDark, light: COLOR.concreteLight },
};

const HAT: Record<Role, string> = {
  foreman: COLOR.hatForeman, worker: COLOR.hatWorker, inspector: COLOR.hatInspector,
};

/** 画到 110 × 逻辑高度的 Canvas；CSS 再按整数倍最近邻放大 */
export function drawBuilding(ctx: CanvasRenderingContext2D, layout: BuildingLayout, blinkOn = true): void {
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.imageSmoothingEnabled = false;
  ctx.lineWidth = 1;
  drawFooterSurface(ctx, layout);
  drawGround(ctx, layout.ground);
  const lit = litFloors(layout);
  // 塔吊是工地级设备：全楼只有一台，立在最高的主体阶段楼段上
  const craneBand = layout.bands.findLast(band => band.placement === "band" && band.stage === "structure");
  for (const band of layout.bands) drawBand(ctx, band, lit, band === craneBand);
  drawCornice(ctx, layout);
  if (layout.crown !== null) drawCrown(ctx, layout.crown);
  if (layout.office !== null) drawOffice(ctx, layout.office);
  drawDesigner(ctx, layout.designer);
  drawWorkers(ctx, layout.workers);
  drawBubbles(ctx, layout.bubbles);
  drawFooterContent(ctx, layout, blinkOn);
}

/** 收起态只画右侧 8 px 彩带；等待段随 blink 变暗 */
export function drawRibbon(ctx: CanvasRenderingContext2D, layout: BuildingLayout, blinkOn = true): void {
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.imageSmoothingEnabled = false;
  for (const segment of ribbonSegments(layout)) {
    const alpha = segment.ribbon === "orange" && !blinkOn ? 0.55 : 1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TONE[RIBBON_TONE[segment.ribbon]];
    ctx.fillRect(segment.x, R(segment.y), segment.width, Math.max(1, R(segment.height) - 1));
    ctx.fillStyle = "rgba(255, 255, 255, .18)";
    ctx.fillRect(segment.x, R(segment.y), 1, Math.max(1, R(segment.height) - 1));
    ctx.fillStyle = "rgba(5, 10, 15, .28)";
    ctx.fillRect(segment.x + segment.width - 1, R(segment.y), 1, Math.max(1, R(segment.height) - 1));
    ctx.globalAlpha = 1;
  }
}

/** 檐口与基座：楼顶压一条亮檐，落地加一条座，收住整栋楼的剪影 */
function drawCornice(ctx: CanvasRenderingContext2D, layout: BuildingLayout): void {
  const top = layout.bands.at(-1);
  const bottom = layout.bands[0];
  if (top === undefined || bottom === undefined) return;
  const cap = box(top);
  fill(ctx, cap.x, cap.y, cap.w, 2, "rgba(5, 10, 15, .30)");
  fill(ctx, cap.x, cap.y, cap.w, 1, "rgba(222, 226, 229, .30)");
  const base = box(bottom);
  fill(ctx, base.x - 1, base.y + base.h - 1, base.w + 2, 2, "rgba(5, 10, 15, .34)");
  fill(ctx, base.x - 1, base.y + base.h - 1, base.w + 2, 1, "rgba(222, 226, 229, .22)");
}

/** 站着小人的楼层：窗亮起来、楼板下沿留一道暖光 */
function litFloors(layout: BuildingLayout): Set<string> {
  return new Set(layout.workers.flatMap(worker => worker.spot === null ? [] : [worker.spot]));
}

function fill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number,
  color: string, align: CanvasTextAlign = "left", weight = 400): void {
  if (value === "") return;
  ctx.font = `${weight} ${size}px ${FONT_SANS}`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function drawFooterSurface(ctx: CanvasRenderingContext2D, layout: BuildingLayout): void {
  const y = layout.height - FOOTER_HEIGHT;
  fill(ctx, 0, y, layout.width, FOOTER_HEIGHT, COLOR.surface);
  fill(ctx, 0, y, layout.width, 1, COLOR.border);
}

function drawGround(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const b = box(rect);
  fill(ctx, b.x, b.y, b.w, b.h, COLOR.ground);
  fill(ctx, b.x, b.y, b.w, 1, COLOR.groundEdge);
  // 砂石：固定间隔的 1px 亮点，不随机，重画不闪
  for (let x = 6; x < b.w - 4; x += 11) fill(ctx, x, b.y + 4 + ((x % 33) / 11 | 0), 1, 1, "rgba(222, 226, 229, .10)");
  // 楼体落地处的接触阴影
  fill(ctx, 0, b.y + 1, b.w, 2, "rgba(5, 10, 15, .30)");
}

function drawBand(ctx: CanvasRenderingContext2D, band: LayoutBand, lit: ReadonlySet<string>, crane: boolean): void {
  const b = box(band);
  fill(ctx, b.x, b.y, b.w, b.h, COLOR.tower);
  if (band.tarp !== null) drawTarp(ctx, band);
  else {
    for (const floor of band.floors) drawFloor(ctx, floor, band, lit.has(`${band.feature}\u0000${floor.id}`));
    drawPlannedOutline(ctx, band);
    for (const scaffold of band.scaffold) drawScaffold(ctx, scaffold);
  }
  // 段与段之间的楼板：上亮下暗，让整栋楼有分层
  fill(ctx, b.x, b.y, b.w, 1, COLOR.highlight);
  fill(ctx, b.x, b.y + b.h - 1, b.w, 1, COLOR.shadow);
  fill(ctx, b.x, b.y, 1, b.h, "rgba(255, 255, 255, .06)");
  fill(ctx, b.x + b.w - 1, b.y, 1, b.h, "rgba(5, 10, 15, .26)");
  frame(ctx, b, COLOR.towerEdge);
  drawBandTrim(ctx, band, crane);
  drawNameplate(ctx, band);
}

/** 造型件和阶段件：都落在楼段矩形内；篷布段和 crown 不画 */
function drawBandTrim(ctx: CanvasRenderingContext2D, band: LayoutBand, crane: boolean): void {
  if (band.placement !== "band" || band.tarp !== null) return;
  const b = box(band);
  if (b.h < 8) return;
  if (band.stage === "empty") { drawHoarding(ctx, b); return; }
  if (band.stage === "foundation") { drawFoundation(ctx, b); return; }
  if (band.stage === "structure") { drawRebar(ctx, b); if (crane) drawCrane(ctx, b); }
  else drawRoof(ctx, b, band.style);
  if (band.style === "factory" && (band.stage === "structure" || band.stage === "done")) drawFactoryGantry(ctx, band);
}

/** 围挡：还没开工的段在底部围一圈木板，和已经盖起来的段一眼分开 */
function drawHoarding(ctx: CanvasRenderingContext2D, b: Box): void {
  const height = Math.min(6, Math.max(2, Math.floor(b.h / 3)));
  const y = b.y + b.h - height;
  fill(ctx, b.x, y, b.w, height, COLOR.hoarding);
  fill(ctx, b.x, y, b.w, 1, "rgba(255, 255, 255, .18)");
  for (let x = b.x + 3; x + 1 < b.x + b.w; x += 7) fill(ctx, x, y, 1, height, COLOR.scaffold);
}

/** 地基：基坑加露出的钢筋，还没到楼体的样子 */
function drawFoundation(ctx: CanvasRenderingContext2D, b: Box): void {
  const height = Math.min(6, Math.max(3, Math.floor(b.h / 4)));
  const y = b.y + b.h - height;
  fill(ctx, b.x + 1, y, b.w - 2, height, "rgba(5, 10, 15, .55)");
  fill(ctx, b.x + 1, y, b.w - 2, 1, "rgba(203, 213, 225, .16)");
  for (let x = b.x + 6; x + 1 < b.x + b.w - 2; x += 9) fill(ctx, x, y - 3, 1, 3, COLOR.rebar);
}

/** 主体：顶部还没封口，露出钢筋；右缘立一台塔吊 */
function drawRebar(ctx: CanvasRenderingContext2D, b: Box): void {
  const left = b.x + FLOOR_GUTTER + 3;
  const right = b.x + b.w - 4;
  for (let x = left; x + 1 < right; x += 6) fill(ctx, x, b.y + 2, 1, 3, COLOR.rebar);
  fill(ctx, left, b.y + 5, right - left, 1, "rgba(5, 10, 15, .22)");
}

function drawCrane(ctx: CanvasRenderingContext2D, b: Box): void {
  const mast = b.x + b.w - 5;
  const armY = b.y + 1;
  const armLeft = Math.max(b.x + FLOOR_GUTTER + 2, mast - 22);
  fill(ctx, mast, armY, 1, b.h - 2, COLOR.crane);
  for (let y = armY + 3; y < b.y + b.h - 2; y += 4) fill(ctx, mast - 1, y, 3, 1, "rgba(199, 161, 92, .55)");
  fill(ctx, armLeft, armY, mast - armLeft + 1, 1, COLOR.crane);
  fill(ctx, armLeft, armY + 1, 1, 3, COLOR.crane);
  fill(ctx, armLeft - 1, armY + 4, 3, 1, COLOR.crane);
}

/** 厂房的外挂检修梯：按整段高度画，楼层增减时落脚板跟着重排 */
function drawFactoryGantry(ctx: CanvasRenderingContext2D, band: LayoutBand): void {
  const b = box(band);
  if (b.h < 16) return;
  const x = b.x + b.w - 9;
  fill(ctx, x, b.y + 1, 0.5, b.h - 2, "rgba(199, 161, 92, .55)");
  fill(ctx, x + 4, b.y + 1, 0.5, b.h - 2, "rgba(199, 161, 92, .55)");
  for (let y = b.y + 2; y + 1 < b.y + b.h - 2; y += 3) fill(ctx, x, y, 4.5, 0.5, "rgba(199, 161, 92, .40)");
  for (const floor of band.floors) {
    fill(ctx, x - 0.5, R(floor.y + floor.height) - 1, 5.5, 0.5, "rgba(199, 161, 92, .55)");
  }
}

/** 竣工的屋顶：塔楼平檐口，厂房锯齿，临街店人字坡 */
function drawRoof(ctx: CanvasRenderingContext2D, b: Box, style: BuildingStyle): void {
  if (style === "factory") {
    // 锈红钨齿屋顶 + 一根烟囱
    for (let x = b.x; x < b.x + b.w; x += 8) {
      fill(ctx, x, b.y, 1, 4, STYLE.factory.rust);
      for (let i = 1; i < 8 && x + i < b.x + b.w; i++) fill(ctx, x + i, b.y + Math.min(3, i), 1, 1, STYLE.factory.rust);
    }
    if (b.h < 14) return;
    const chimney = b.x + b.w - 15;
    fill(ctx, chimney, b.y, 5, 11, STYLE.factory.wall);
    fill(ctx, chimney, b.y, 5, 1, STYLE.factory.mortar);
    fill(ctx, chimney, b.y + 2, 1, 9, "rgba(5, 10, 15, .18)");
    fill(ctx, chimney - 5, b.y + 2, 5, 2, STYLE.factory.smoke);
    fill(ctx, chimney - 8, b.y + 4, 4, 2, "rgba(222, 226, 229, .14)");
    // 另一侧一座小水塔
    fill(ctx, b.x + 8, b.y + 2, 6, 5, STYLE.factory.mortar);
    fill(ctx, b.x + 8, b.y + 2, 6, 1, "rgba(5, 10, 15, .30)");
    fill(ctx, b.x + 9, b.y + 7, 1, 3, STYLE.factory.rust);
    fill(ctx, b.x + 12, b.y + 7, 1, 3, STYLE.factory.rust);
    return;
  }
  if (style === "storefront") {
    // 瓦檐：一排瓦加下沿的瓦头
    const height = 4;
    const center = b.x + b.w / 2;
    for (let row = 0; row < height; row++) {
      const half = Math.round(((row + 1) / height) * (b.w / 2));
      const left = Math.round(center - half);
      const right = Math.round(center + half);
      fill(ctx, left, b.y + row, right - left, 1, STYLE.storefront.tile);
      fill(ctx, left, b.y + row, 1, 1, "rgba(232, 220, 200, .55)");
      fill(ctx, right - 1, b.y + row, 1, 1, "rgba(232, 220, 200, .55)");
    }
    for (let x = b.x + 2; x + 2 < b.x + b.w - 2; x += 6) fill(ctx, x, b.y + height, 2, 1, STYLE.storefront.tile);
    fill(ctx, b.x + 10, b.y, 4, 1, GARDEN.leaf);
    fill(ctx, b.x + 11, b.y, 1, 1, GARDEN.bloom);
    fill(ctx, b.x + b.w - 16, b.y, 4, 1, GARDEN.leaf);
    fill(ctx, b.x + b.w - 15, b.y, 1, 1, GARDEN.bloom);
    return;
  }
  // 塔楼：带灯带的女儿墙
  fill(ctx, b.x, b.y, b.w, 2, COLOR.tower);
  fill(ctx, b.x, b.y, b.w, 1, STYLE.tower.neon);
  fill(ctx, b.x + 8, b.y + 2, 3, 1, STYLE.tower.slab);
  fill(ctx, b.x + b.w - 11, b.y + 2, 3, 1, STYLE.tower.slab);
  fill(ctx, b.x + 14, b.y + 1, 4, 1, GARDEN.leaf);
  fill(ctx, b.x + 15, b.y, 1, 1, GARDEN.bloom);
  fill(ctx, b.x + b.w - 20, b.y + 1, 4, 1, GARDEN.leaf);
}

/** 造型件：塔楼的灯带、厂房的壁柱、临街店的雨棚和灯笼；built 层才画 */
function drawStyleFront(ctx: CanvasRenderingContext2D, b: Box, floor: LayoutFloor, band: LayoutBand, style: BuildingStyle, occupied: boolean): void {
  const index = band.floors.indexOf(floor);
  // crown 楼段只跟造型画颜色和窗型：穹顶就在它上面，不再叠退台、阳台和门
  const decorated = band.placement === "band";
  const ground = decorated && band.floors[0] === floor;
  if (style === "tower") {
    drawTowerFloor(ctx, b, index);
    drawTowerWindows(ctx, b, occupied, index);
    if (decorated && index >= 2 && index % 3 === 2) drawTowerTerrace(ctx, b, index % 2 === 0 ? "left" : "right");
    // 顶部三层逐级退台：右缘往里收，露出栏杆、花箱和露台
    const fromTop = band.floors.length - 1 - index;
    if (decorated && fromTop >= 0 && fromTop <= 2) drawTowerSetback(ctx, b, fromTop === 0 ? 13 : fromTop === 1 ? 8 : 4);
  } else if (style === "factory") drawFactoryFloor(ctx, b, occupied, index, ground, decorated);
  else drawStorefrontFloor(ctx, b, occupied, index, ground, decorated);
  // 底层：门和雨棚等楼段起到主体以后才装
  if (!decorated || band.stage === "empty" || band.stage === "foundation" || !ground) return;
  if (style === "tower") drawTowerLobby(ctx, b);
  else if (style === "factory") drawShutter(ctx, b);
  else drawAwning(ctx, b);
}

/** 塔楼：冷色玻璃的一层薄纱 + 楼板灯带 + 右缘竖灯；灯带的疏密按层变 */
function drawTowerFloor(ctx: CanvasRenderingContext2D, b: Box, index: number): void {
  const left = b.x + FLOOR_GUTTER + 1;
  const width = b.w - FLOOR_GUTTER - 2;
  fill(ctx, left, b.y, width, b.h, STYLE.tower.steel);
  fill(ctx, left, b.y + b.h - 2, width, 1, STYLE.tower.slab);
  const step = index % 2 === 0 ? 14 : 11;
  for (let x = left + 4; x + 2 < left + width - 2; x += step) fill(ctx, x, b.y + b.h - 3, 2, 1, STYLE.tower.neon);
  fill(ctx, b.x + b.w - 4, b.y + 2, 1, b.h - 4, STYLE.tower.slab);
  for (let y = b.y + 3; y + 2 < b.y + b.h - 3; y += 6) fill(ctx, b.x + b.w - 4, y, 1, 2, STYLE.tower.neon);
}

/** 塔楼窗格：每层错开半格，奇数层多一横排，读起来像不同的办公室 */
function drawTowerWindows(ctx: CanvasRenderingContext2D, b: Box, occupied: boolean, index: number): void {
  const left = b.x + FLOOR_GUTTER + 3;
  const right = b.x + b.w - 5;
  const top = b.y + 3;
  const bottom = b.y + b.h - 5;
  if (right - left < 12 || bottom - top < 4) return;
  const offset = (index * 2) % 5;
  const gap = index % 3 === 1 ? 5 : 6;
  for (let y = top; y + 3 <= bottom; y += gap) {
    for (let x = left + offset; x + 4 <= right; x += 7) {
      fill(ctx, x, y, 4, 3, "rgba(8, 20, 32, .55)");
      fill(ctx, x, y + 3, 4, 1, "rgba(99, 216, 242, .18)");
      if (occupied) fill(ctx, x + 1, y + 1, 2, 1, "rgba(196, 232, 255, .55)");
    }
  }
}

/** 塔楼的空中花园：一侧退进一条露台，栏杆、花箱和垂下来的藤 */
function drawTowerTerrace(ctx: CanvasRenderingContext2D, b: Box, side: "left" | "right"): void {
  const width = 12;
  const x = side === "left" ? b.x + FLOOR_GUTTER + 2 : b.x + b.w - width - 3;
  fill(ctx, x, b.y, width, b.h, "rgba(16, 26, 22, .92)");
  for (let px = x + 1; px < x + width - 1; px += 3) fill(ctx, px, b.y + 2, 1, b.h - 5, "rgba(203, 213, 225, .32)");
  fill(ctx, x, b.y + 2, width, 1, "rgba(203, 213, 225, .42)");
  fill(ctx, x + 1, b.y + b.h - 6, 4, 2, GARDEN.leaf);
  fill(ctx, x + 2, b.y + b.h - 7, 2, 1, GARDEN.bloom);
  fill(ctx, x + 6, b.y + b.h - 5, 3, 1, GARDEN.soil);
  fill(ctx, x + 4, b.y + 4, 1, 3, "rgba(111, 143, 90, .70)");
}

/** 塔楼退台：上层的右缘往里收，退出来的地方是露台和栏杆 */
function drawTowerSetback(ctx: CanvasRenderingContext2D, b: Box, inset: number): void {
  if (inset < 2 || b.w < 40) return;
  const x = b.x + b.w - inset;
  fill(ctx, x, b.y, inset, b.h, COLOR.tower);
  fill(ctx, x + 0.5, b.y + 1, 0.5, b.h - 2, "rgba(203, 213, 225, .35)");
  fill(ctx, x, b.y + b.h - 3, inset - 1, 0.5, "rgba(203, 213, 225, .30)");
  fill(ctx, x + 1, b.y + b.h - 5, 2, 1, GARDEN.leaf);
  fill(ctx, x + 1.5, b.y + b.h - 6, 1, 1, GARDEN.bloom);
}

/** 塔楼底层：玻璃门厅，门楣一条青灯，旁边一盆绿植 */
function drawTowerLobby(ctx: CanvasRenderingContext2D, b: Box): void {
  const width = Math.min(18, b.w - FLOOR_GUTTER - 12);
  const height = b.h - 6;
  if (width < 10 || height < 8) return;
  const x = b.x + b.w - width - 6, y = b.y + 3;
  fill(ctx, x, y, width, height, "rgba(5, 10, 15, .55)");
  fill(ctx, x, y, width, 1, STYLE.tower.neon);
  fill(ctx, x, y, 1, height, "rgba(99, 216, 242, .45)");
  fill(ctx, x + 3, y + 3, 3, 2, "rgba(99, 216, 242, .28)");
  fill(ctx, x - 5, b.y + b.h - 5, 3, 2, GARDEN.leaf);
  fill(ctx, x - 4, b.y + b.h - 7, 1, 2, GARDEN.wood);
}

/** 厂房：锈红壁柱、灰浆缝和通长横窗；窗带高低和管道左右按层换 */
function drawFactoryFloor(ctx: CanvasRenderingContext2D, b: Box, occupied: boolean, index: number, ground: boolean, decorated: boolean): void {
  const left = b.x + FLOOR_GUTTER + 1;
  const width = b.w - FLOOR_GUTTER - 2;
  fill(ctx, left, b.y, 3, b.h, STYLE.factory.wall);
  fill(ctx, left + width - 3, b.y, 3, b.h, STYLE.factory.wall);
  fill(ctx, left, b.y + 2, width, 1, STYLE.factory.mortar);
  fill(ctx, left, b.y + b.h - 2, width, 1, "rgba(224, 211, 180, .10)");
  if (b.h < 12) return;
  const y = b.y + Math.min(Math.max(4, b.h - 7), 4 + (index % 3) * 2);
  fill(ctx, left + 4, y, width - 8, 3, "rgba(5, 10, 15, .58)");
  for (let x = left + 8; x + 1 < left + width - 4; x += 9) fill(ctx, x, y, 1, 3, STYLE.factory.mortar);
  if (occupied) fill(ctx, left + 5, y + 1, width - 10, 1, STYLE.factory.lamp);
  const pipeX = index % 2 === 0 ? left + 1 : left + width - 2;
  fill(ctx, pipeX, b.y + 2, 1, b.h - 4, "rgba(181, 116, 72, .55)");
  fill(ctx, pipeX === left + 1 ? pipeX : pipeX - 2, b.y + b.h - 7, 3, 1, "rgba(181, 116, 72, .70)");
  fill(ctx, left + 1, b.y + b.h - 5, 2, 2, STYLE.factory.lamp);
  fill(ctx, left + width - 3, b.y + b.h - 5, 2, 2, STYLE.factory.lamp);
  if (!decorated) return;
  for (let px = left + 10; px < left + width - 10; px += 16) fill(ctx, px, b.y + 4, 1, 1, "rgba(224, 211, 180, .35)");
  if (ground) {
    // 底层院子：草地、一棵树和一堆木箱
    fill(ctx, left + 2, b.y + b.h - 6, Math.max(8, width - 28), 6, GARDEN.grass);
    fill(ctx, left + 5, b.y + b.h - 10, 1, 5, GARDEN.wood);
    fill(ctx, left + 3, b.y + b.h - 13, 5, 4, GARDEN.leaf);
    fill(ctx, left + width - 11, b.y + b.h - 8, 5, 5, GARDEN.wood);
    fill(ctx, left + width - 11, b.y + b.h - 8, 5, 1, "rgba(224, 211, 180, .25)");
  }
}

/** 临街店：每层是一间不同的店——咖啡、花店、书店或灯笼铺 */
function drawStorefrontFloor(ctx: CanvasRenderingContext2D, b: Box, occupied: boolean, index: number, ground: boolean, decorated: boolean): void {
  const left = b.x + FLOOR_GUTTER + 1;
  const width = b.w - FLOOR_GUTTER - 2;
  fill(ctx, left, b.y, width, b.h, STYLE.storefront.wall);
  fill(ctx, left, b.y, width, 1, STYLE.storefront.wood);
  fill(ctx, left, b.y + b.h - 2, width, 1, "rgba(138, 97, 66, .55)");
  // 每层一道外挑的檐口：层与层之间不是一条直线，像一排高低错落的小铺
  if (decorated) {
    const eave = index % 2 === 0 ? 0 : 2;
    fill(ctx, left + eave, b.y + 1, width - eave, 1.5, STYLE.storefront.tile);
    fill(ctx, left + eave, b.y + 2.5, width - eave, 0.5, "rgba(5, 10, 15, .35)");
  }
  const shop = index % STYLE.storefront.shops.length;
  const offset = shop % 2 === 0 ? 0 : 5;
  const height = Math.min(12, b.h - 12);
  if (height >= 5) {
    const y = b.y + b.h - height - 3;
    for (let x = left + 3 + offset; x + 10 <= left + width - 2; x += 18) {
      fill(ctx, x, y, 10, height, "rgba(5, 10, 15, .55)");
      fill(ctx, x, y, 10, 1, "rgba(255, 217, 160, .45)");
      fill(ctx, x, y, 1, height, "rgba(138, 97, 66, .60)");
      fill(ctx, x, y + height - 1, 10, 1, "rgba(138, 97, 66, .55)");
      if (occupied) fill(ctx, x + 1, y + 1, 8, height - 2, "rgba(255, 217, 160, .18)");
    }
  }
  if (!decorated) return;
  const awning = STYLE.storefront.shops[shop];
  drawStripedAwning(ctx, left + 2, b.y + 2, Math.min(26, width - 4), awning);
  // 隔层一道外挑阳台：木栏板、花箱和晾着的布
  if (index % 2 === 1 && b.h >= 18) {
    const by = b.y + b.h - 5;
    fill(ctx, left + 2, by, width - 4, 1.5, "rgba(138, 97, 66, .75)");
    fill(ctx, left + 2, by - 2, width - 4, 0.5, "rgba(203, 213, 225, .28)");
    for (let px = left + 4; px < left + width - 4; px += 5) fill(ctx, px, by - 2, 0.5, 3.5, "rgba(138, 97, 66, .55)");
    fill(ctx, left + width - 12, by - 3, 3, 1, GARDEN.leaf);
    fill(ctx, left + width - 11, by - 4, 1, 1, GARDEN.bloom);
  }
  if (shop === 0) {
    // 咖啡店：一张小圆桌和两把椅子
    fill(ctx, left + width - 12, b.y + b.h - 6, 3, 1, GARDEN.wood);
    fill(ctx, left + width - 11, b.y + b.h - 8, 1, 2, GARDEN.wood);
    fill(ctx, left + width - 15, b.y + b.h - 7, 1, 3, "rgba(138, 97, 66, .70)");
    fill(ctx, left + width - 8, b.y + b.h - 7, 1, 3, "rgba(138, 97, 66, .70)");
  } else if (shop === 1) {
    // 花店：窗下一排花箱
    fill(ctx, left + width - 15, b.y + b.h - 6, 9, 2, GARDEN.leaf);
    fill(ctx, left + width - 13, b.y + b.h - 7, 1, 1, GARDEN.bloom);
    fill(ctx, left + width - 10, b.y + b.h - 7, 1, 1, "#e0c060");
    fill(ctx, left + width - 8, b.y + b.h - 7, 1, 1, GARDEN.bloom);
  } else if (shop === 2) {
    // 书店：一排书架线
    for (let px = left + 5; px < left + width - 6; px += 3) fill(ctx, px, b.y + b.h - 6, 1, 3, "rgba(138, 97, 66, .55)");
  } else {
    // 灯笼铺：两只灯笼
    fill(ctx, left + width - 9, b.y + 5, 2, 3, STYLE.storefront.lantern);
    fill(ctx, left + width - 14, b.y + 8, 2, 3, STYLE.storefront.lantern);
  }
  // 每层的小门，位置随店铺和楼层挪
  if (b.h >= 14) {
    const doorX = left + 4 + ((index * 9 + shop * 3) % Math.max(1, width - 22));
    fill(ctx, doorX, b.y + b.h - 9, 4, 7, "rgba(5, 10, 15, .55)");
    fill(ctx, doorX, b.y + b.h - 9, 4, 1, STYLE.storefront.wood);
    fill(ctx, doorX, b.y + b.h - 9, 1, 7, "rgba(138, 97, 66, .55)");
  }
  if (ground) {
    // 门口的盆栽
    fill(ctx, left + 2, b.y + b.h - 5, 3, 2, GARDEN.leaf);
    fill(ctx, left + 3, b.y + b.h - 8, 1, 3, GARDEN.wood);
  }
}

/** 厂房卷帘门：门板带凹槽，装在楼段底层右侧 */
function drawShutter(ctx: CanvasRenderingContext2D, b: Box): void {
  const width = Math.min(20, b.w - FLOOR_GUTTER - 12);
  const height = b.h - 6;
  if (width < 8 || height < 8) return;
  const x = b.x + b.w - width - 6;
  const y = b.y + 3;
  fill(ctx, x, y, width, height, COLOR.shutter);
  fill(ctx, x, y, width, 1, STYLE.factory.mortar);
  for (let row = y + 2; row < y + height - 1; row += 2) fill(ctx, x + 1, row, width - 2, 1, "rgba(5, 10, 15, .35)");
  fill(ctx, x, y, 1, height, "rgba(255, 255, 255, .10)");
  fill(ctx, x, y + height - 1, width, 1, "rgba(5, 10, 15, .45)");
}

/** 条纹布雨棚：底色和布条，下沿一根根布头 */
function drawStripedAwning(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, color: string): void {
  if (width < 8) return;
  fill(ctx, x, y, width, 3, color);
  for (let stripe = 0; stripe + 2 <= width; stripe += 6) fill(ctx, x + stripe, y, 2, 3, STYLE.storefront.awningLight);
  for (let stripe = 0; stripe < width; stripe += 6) fill(ctx, x + stripe, y + 3, 2, 1, color);
  fill(ctx, x, y, width, 1, "rgba(255, 255, 255, .20)");
}

/** 临街店底层：一道大一点的雨棚，门里透出暖光 */
function drawAwning(ctx: CanvasRenderingContext2D, b: Box): void {
  const width = Math.min(28, b.w - FLOOR_GUTTER - 12);
  if (width < 10 || b.h < 12) return;
  const x = b.x + b.w - width - 6;
  const y = b.y + b.h - 10;
  drawStripedAwning(ctx, x, y, width, STYLE.storefront.awning);
  fill(ctx, x + 5, y + 5, 7, 3, "rgba(255, 217, 160, .20)");
}

/** 1px 外框：用四条填充而不是 stroke，边角不出半像素 */
function frame(ctx: CanvasRenderingContext2D, b: Box, color: string): void {
  fill(ctx, b.x, b.y, b.w, 1, color);
  fill(ctx, b.x, b.y + b.h - 1, b.w, 1, color);
  fill(ctx, b.x, b.y, 1, b.h, color);
  fill(ctx, b.x + b.w - 1, b.y, 1, b.h, color);
}

function drawFloor(ctx: CanvasRenderingContext2D, floor: LayoutFloor, band: LayoutBand, occupied: boolean): void {
  const b = box(floor);
  const style: BuildingStyle = band.style;
  if (floor.kind === "built") {
    for (const material of floor.materials) paintMaterial(ctx, b, material, occupied);
    // 业态色盖在材质纹理上：整段读成这一业的颜色，砖缝 / 幕墙纹理还透得出来
    fill(ctx, b.x + FLOOR_GUTTER + 1, b.y, b.w - FLOOR_GUTTER - 2, b.h, STYLE[style].wash);
    drawStyleFront(ctx, b, floor, band, style, occupied);
    drawFloorRail(ctx, floor, band);
    return;
  }
  if (floor.kind === "planned") {
    fill(ctx, b.x, b.y, b.w, b.h, "rgba(110, 140, 170, .10)");
    fill(ctx, b.x + FLOOR_GUTTER + 1, b.y, b.w - FLOOR_GUTTER - 2, b.h, STYLE[style].planned);
    for (let x = b.x + 20; x < b.x + b.w - 4; x += 12) fill(ctx, x, b.y + 1, 1, b.h - 1, "rgba(203, 213, 225, .11)");
    for (let i = 0; i < b.w + b.h; i += 8) {
      const x = b.x + i, y = b.y + b.h - 1 - i;
      for (let step = 0; step < 3; step++) {
        const px = x - step * 2, py = y - step * 2;
        if (px > b.x + 18 && px < b.x + b.w - 2 && py > b.y && py < b.y + b.h - 2) fill(ctx, px, py, 1, 1, "rgba(203, 213, 225, .10)");
      }
    }
    fill(ctx, b.x, b.y + b.h - 1, b.w, 1, "rgba(203, 213, 225, .14)");
    drawFloorRail(ctx, floor, band);
    return;
  }
  fill(ctx, b.x, b.y, b.w, b.h, "rgba(30, 37, 44, .92)");
  fill(ctx, b.x + FLOOR_GUTTER + 1, b.y, b.w - FLOOR_GUTTER - 2, b.h, STYLE[style].planned);
  fill(ctx, b.x + FLOOR_GUTTER + 1, b.y + b.h - 2, b.w - FLOOR_GUTTER - 2, 1, "rgba(247, 172, 77, .18)");
  for (const cell of floor.cells) drawCell(ctx, cell, band.materials[0]?.material ?? "concrete");
  drawFloorRail(ctx, floor, band);
  fill(ctx, b.x, b.y, b.w, 1, COLOR.highlight);
  fill(ctx, b.x, b.y + b.h - 1, b.w, 1, COLOR.shadow);
}

/** 楼层号一栏：竖向分隔 + 编号，用同一套标注贯穿整栋楼 */
function drawFloorRail(ctx: CanvasRenderingContext2D, floor: LayoutFloor, band: LayoutBand): void {
  const b = box(floor);
  // 编号一栏自己带深色底：楼层可以是砖、玻璃或混凝土，白昼配色下暗字压在这些材质上都读不出
  fill(ctx, b.x, b.y, FLOOR_GUTTER + 1, b.h, PLATE.solid);
  fill(ctx, b.x + FLOOR_GUTTER, b.y, 1, b.h, "rgba(5, 10, 15, .22)");
  fill(ctx, b.x + FLOOR_GUTTER + 1, b.y, 1, 1, COLOR.highlight);
  const id = redact(floor.id);
  ctx.font = `400 ${TYPE.caption}px ${FONT_SANS}`;
  const cut = fitText(ctx, id, FLOOR_GUTTER - 4);
  const width = Math.min(FLOOR_GUTTER - 2, R(ctx.measureText(cut).width));
  const x = b.x + R((FLOOR_GUTTER - width) / 2);
  const y = R(b.y + b.h / 2) + 2;
  text(ctx, cut, x + 1, y + 1, TYPE.caption, "rgba(5, 10, 15, .72)", "left");
  text(ctx, cut, x, y, TYPE.caption, PLATE.text, "left");
}

/** 一段连续未建楼层画一圈虚线：读成没盖完的骨架，而不是一排黑盒子 */
function drawPlannedOutline(ctx: CanvasRenderingContext2D, band: LayoutBand): void {
  let runStart = -1;
  for (let index = 0; index <= band.floors.length; index++) {
    const planned = index < band.floors.length && band.floors[index].kind === "planned";
    if (planned && runStart < 0) runStart = index;
    if (planned || runStart < 0) continue;
    const first = box(band.floors[runStart]);
    const last = box(band.floors[index - 1]);
    const top = Math.min(first.y, last.y);
    const bottom = Math.max(first.y + first.h, last.y + last.h);
    dashedFrame(ctx, { x: first.x + 2, y: top + 2, w: first.w - 4, h: bottom - top - 4 }, "rgba(163, 178, 194, .42)");
    runStart = -1;
  }
}

function paintMaterial(ctx: CanvasRenderingContext2D, b: Box, rect: LayoutMaterial, occupied: boolean): void {
  const m = COLORS[rect.material];
  const left = R(rect.x), right = R(rect.x + rect.width);
  const area = { x: Math.max(b.x, left), y: b.y, w: Math.min(b.x + b.w, right) - Math.max(b.x, left), h: b.h };
  if (area.w <= 0) return;
  fill(ctx, area.x, area.y, area.w, area.h, m.base);
  if (rect.material === "brick") paintBrick(ctx, area, m);
  else if (rect.material === "glass") paintGlass(ctx, area, m, occupied);
  else paintPanels(ctx, area, m, rect.material);
  fill(ctx, area.x, area.y, area.w, 1, "rgba(255, 255, 255, .12)");
  fill(ctx, area.x, area.y + area.h - 1, area.w, 1, "rgba(5, 10, 15, .34)");
}

function paintBrick(ctx: CanvasRenderingContext2D, b: Box, m: (typeof COLORS)[Material]): void {
  for (let y = b.y + 3; y < b.y + b.h - 1; y += 3) fill(ctx, b.x, y, b.w, 1, m.dark);
  for (let y = b.y + 1, row = 0; y < b.y + b.h - 1; y += 3, row++) {
    for (let x = b.x + (row % 2 === 0 ? 4 : 8); x < b.x + b.w - 1; x += 8) fill(ctx, x, y, 1, 2, m.dark);
  }
  for (let i = 0; i < b.w * b.h; i += 97) {
    const x = b.x + 2 + (i % Math.max(1, b.w - 4));
    const y = b.y + 2 + ((i * 7) % Math.max(1, b.h - 4));
    fill(ctx, x, y, 2, 1, m.light);
  }
}

function paintGlass(ctx: CanvasRenderingContext2D, b: Box, m: (typeof COLORS)[Material], occupied: boolean): void {
  fill(ctx, b.x, b.y, b.w, 2, m.dark);
  for (let x = b.x + 4; x < b.x + b.w - 1; x += 6) fill(ctx, x, b.y, 1, b.h, m.dark);
  fill(ctx, b.x, b.y + 2, b.w, 1, m.light);
  fill(ctx, b.x, b.y + 2, Math.max(2, R(b.w * 0.3)), b.h - 3, "rgba(255, 255, 255, .07)");
  const mid = b.y + Math.max(4, Math.floor(b.h / 2));
  fill(ctx, b.x, mid, b.w, 1, "rgba(5, 10, 15, .18)");
  for (let x = b.x + 4, pane = 0; x < b.x + b.w - 1; x += 6, pane++) {
    if (occupied ? pane % 2 === 0 : hash(pane, R(b.y)) % 9 === 0) fill(ctx, x + 1, mid + 1, 4, 2, "rgba(247, 172, 77, .35)");
  }
}

function paintPanels(ctx: CanvasRenderingContext2D, b: Box, m: (typeof COLORS)[Material], material: Material): void {
  if (material === "metal") {
    for (let y = b.y + 3; y < b.y + b.h - 1; y += 4) {
      fill(ctx, b.x, y, b.w, 1, m.dark);
      fill(ctx, b.x, y + 1, b.w, 1, "rgba(255, 255, 255, .06)");
    }
    for (let y = b.y + 3; y < b.y + b.h - 1; y += 8) {
      fill(ctx, b.x + 2, y - 1, 1, 1, m.light);
      fill(ctx, b.x + b.w - 3, y - 1, 1, 1, m.light);
    }
  } else {
    for (let y = b.y + 5; y < b.y + b.h - 1; y += 6) fill(ctx, b.x, y, b.w, 1, "rgba(5, 10, 15, .16)");
    for (let i = 0; i < b.w * b.h; i += 53) {
      const x = b.x + 2 + (i % Math.max(1, b.w - 4));
      const y = b.y + 2 + ((i * 5) % Math.max(1, b.h - 4));
      fill(ctx, x, y, 1, 1, "rgba(255, 255, 255, .07)");
    }
  }
}

const hash = (a: number, b: number): number => (a * 7349 + b * 911 + 17) % 1009;

function drawCell(ctx: CanvasRenderingContext2D, cell: LayoutCell, material: Material): void {
  const b = box(cell);
  const m = COLORS[material];
  if (!cell.done) {
    fill(ctx, b.x, b.y, b.w, b.h, "rgba(5, 10, 15, .34)");
    dashedFrame(ctx, b, "rgba(148, 163, 180, .55)");
    return;
  }
  fill(ctx, b.x, b.y, b.w, b.h, m.base);
  fill(ctx, b.x, b.y, b.w, 1, m.light);
  fill(ctx, b.x, b.y + b.h - 1, b.w, 1, "rgba(5, 10, 15, .38)");
  fill(ctx, b.x + b.w - 1, b.y, 1, b.h, "rgba(5, 10, 15, .28)");
  if (b.w >= 10 && b.h >= 10) text(ctx, "✓", b.x + b.w - 2, b.y + b.h - 3, TYPE.caption, "rgba(255, 255, 255, .72)", "right", 600);
}

function drawScaffold(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const b = box(rect);
  const left = b.x - 2, right = b.x + b.w + 1;
  fill(ctx, left, b.y - 1, 1, b.h + 2, COLOR.scaffold);
  fill(ctx, right, b.y - 1, 1, b.h + 2, COLOR.scaffold);
  fill(ctx, left, b.y, right - left + 1, 1, COLOR.scaffold);
  fill(ctx, left, b.y + b.h - 1, right - left + 1, 1, COLOR.scaffold);
  for (let i = 0; i < b.h; i += 2) {
    const x = left + R((i / Math.max(1, b.h)) * (right - left));
    fill(ctx, x, b.y + i, 2, 1, "rgba(184, 161, 126, .65)");
  }
}

function drawTarp(ctx: CanvasRenderingContext2D, band: LayoutBand): void {
  const b = box(band);
  fill(ctx, b.x, b.y, b.w, b.h, "#3b4653");
  for (let offset = -b.h; offset < b.w; offset += 8) {
    for (let row = 0; row < b.h; row++) {
      const x = b.x + offset + row;
      if (x < b.x || x + 2 > b.x + b.w) continue;
      fill(ctx, x, b.y + row, 2, 1, "rgba(203, 213, 225, .08)");
    }
  }
  frame(ctx, b, COLOR.border);
  const label = redact(band.tarp ?? "");
  const height = R(TYPE.label) + 6;
  const y = b.y + R(b.h / 2) - R(height / 2);
  fill(ctx, b.x + 4, y, b.w - 8, height, PLATE.soft);
  text(ctx, label, b.x + b.w / 2, y + height - 4, TYPE.label, PLATE.text, "center", 600);
}

function drawNameplate(ctx: CanvasRenderingContext2D, band: LayoutBand): void {
  const b = box(band);
  const label = redact(band.feature);
  ctx.font = `600 ${TYPE.label}px ${FONT_SANS}`;
  const raw = ctx.measureText(label).width;
  const shown = raw <= b.w - 6 ? label : fitText(ctx, label, b.w - 6);
  const width = R(Math.min(b.w - 6, ctx.measureText(shown).width + 10));
  const height = Math.min(9, Math.max(4, b.h - 2));
  const x = b.x + 1;
  const y = b.y + 1;
  fill(ctx, x, y, width, height, PLATE.weak);
  fill(ctx, x, y, 2, height, "rgba(247, 172, 77, .72)");
  text(ctx, shown, x + 6, y + height - 3, TYPE.label, PLATE.text, "left", 600);
}

function drawCrown(ctx: CanvasRenderingContext2D, crown: LayoutCrown): void {
  const b = box(crown);
  if (crown.stage === "empty") drawCrownPlot(ctx, b);
  else if (crown.stage === "foundation") drawCrownFoundation(ctx, b);
  else if (crown.stage === "structure") drawCrownFrame(ctx, b);
  else if (crown.style === "factory") drawCrownFactory(ctx, b, crown.material);
  else if (crown.style === "storefront") drawCrownStorefront(ctx, b, crown.material);
  else drawCrownDome(ctx, b, crown.material);
  // 桅杆和旗是楼顶的标志，什么阶段都立着
  const mastX = R(crown.mastX), mastY = R(crown.mastY);
  fill(ctx, mastX, mastY, 1, crown.mastHeight + 2, COLOR.metalLight);
  fill(ctx, mastX + 1, mastY, 5, 2, COLOR.flag);
  fill(ctx, mastX + 5, mastY, 1, 1, "rgba(5, 10, 15, .25)");
}

/** 围挡：屋顶上还没开工的基座，围一圈木板 */
function drawCrownPlot(ctx: CanvasRenderingContext2D, b: Box): void {
  const width = 28, height = 7;
  const x = b.x + R((b.w - width) / 2), y = b.y + b.h - height;
  dashedFrame(ctx, { x, y, w: width, h: height }, "rgba(203, 213, 225, .30)");
  for (let px = x + 2; px + 1 < x + width; px += 5) fill(ctx, px, y + height - 2, 1, 2, COLOR.hoarding);
}

/** 地基：基座坑加露出的钢筋 */
function drawCrownFoundation(ctx: CanvasRenderingContext2D, b: Box): void {
  const width = 28, height = 5;
  const x = b.x + R((b.w - width) / 2), y = b.y + b.h - height;
  fill(ctx, x, y, width, height, "rgba(5, 10, 15, .55)");
  fill(ctx, x, y, width, 1, "rgba(203, 213, 225, .16)");
  for (let px = x + 3; px + 1 < x + width; px += 6) fill(ctx, px, y - 3, 1, 3, COLOR.rebar);
}

/** 主体：还没封口的钢架 */
function drawCrownFrame(ctx: CanvasRenderingContext2D, b: Box): void {
  const width = 28, height = 10;
  const x = b.x + R((b.w - width) / 2), y = b.y + b.h - height;
  for (const px of [x, x + R(width / 2), x + width - 1]) fill(ctx, px, y, 1, height, COLOR.scaffold);
  fill(ctx, x, y, width, 1, COLOR.scaffold);
  fill(ctx, x, y + R(height / 2), width, 1, "rgba(184, 161, 126, .55)");
}

/** 塔楼穹顶：半圆罩子加两道亮窗 */
function drawCrownDome(ctx: CanvasRenderingContext2D, b: Box, material: Material): void {
  const cx = b.x + b.w / 2;
  for (let row = 0; row < b.h; row++) {
    const t = row / Math.max(1, b.h - 1);
    const half = R((b.w / 2) * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2)));
    const color = row < 2 ? STYLE.tower.neon : STYLE.tower.dome;
    fill(ctx, cx - half, b.y + row, half * 2, 1, color);
  }
  for (let i = 1; i <= 3; i++) {
    const x = b.x + R((b.w * i) / 4);
    fill(ctx, x, b.y + 2, 1, b.h - 3, "rgba(5, 10, 15, .22)");
  }
  fill(ctx, b.x + 2, b.y + 1, 1, b.h - 3, "rgba(255, 255, 255, .24)");
  fill(ctx, cx - 6, b.y + b.h - 4, 3, 3, "rgba(5, 10, 15, .45)");
  fill(ctx, cx + 3, b.y + b.h - 4, 3, 3, "rgba(5, 10, 15, .45)");
  fill(ctx, cx - 6, b.y + b.h - 3, 3, 2, "rgba(247, 172, 77, .50)");
  fill(ctx, cx + 3, b.y + b.h - 3, 3, 2, "rgba(247, 172, 77, .35)");
  fill(ctx, b.x + b.w - 3, b.y + 2, 1, b.h - 2, "rgba(5, 10, 15, .30)");
  fill(ctx, b.x + 8, b.y + b.h - 2, b.w - 16, 1, STYLE.tower.slab);
  fill(ctx, b.x - 1, b.y + b.h - 1, b.w + 2, 1, "rgba(5, 10, 15, .45)");
}

/** 厂房：平顶设备间加两个通风帽 */
function drawCrownFactory(ctx: CanvasRenderingContext2D, b: Box, material: Material): void {
  const width = 40, height = 8;
  const x = b.x + R((b.w - width) / 2), y = b.y + b.h - height;
  fill(ctx, x, y, width, height, STYLE.factory.wall);
  fill(ctx, x, y, width, 1, STYLE.factory.mortar);
  fill(ctx, x, y + height - 1, width, 1, "rgba(5, 10, 15, .40)");
  for (let row = y + 2; row < y + height - 1; row += 2) fill(ctx, x, row, width, 1, "rgba(5, 10, 15, .18)");
  fill(ctx, x + 6, y - 2, 5, 2, STYLE.factory.mortar);
  fill(ctx, x + width - 11, y - 2, 5, 2, STYLE.factory.mortar);
  fill(ctx, x + R(width / 2) - 2, y + height - 4, 4, 4, "rgba(5, 10, 15, .55)");
  fill(ctx, b.x - 1, b.y + b.h - 1, b.w + 2, 1, "rgba(5, 10, 15, .45)");
}

/** 临街店：坡顶亭子加灯箱招牌 */
function drawCrownStorefront(ctx: CanvasRenderingContext2D, b: Box, material: Material): void {
  const width = 36, body = 6;
  const x = b.x + R((b.w - width) / 2), y = b.y + b.h - body;
  fill(ctx, x, y, width, body, STYLE.storefront.cream);
  fill(ctx, x, y + body - 1, width, 1, "rgba(5, 10, 15, .40)");
  const apex = b.y + 2, height = 5;
  for (let row = 0; row < height; row++) {
    const half = R((width / 2) * ((row + 1) / height));
    const left = x + width / 2 - half, right = x + width / 2 + half;
    fill(ctx, left, apex + row, right - left, 1, STYLE.storefront.tile);
    fill(ctx, left, apex + row, 1, 1, "rgba(232, 220, 200, .55)");
    fill(ctx, right - 1, apex + row, 1, 1, "rgba(232, 220, 200, .55)");
  }
  fill(ctx, x + R(width / 2) - 6, y + 1, 12, 3, STYLE.storefront.lantern);
  fill(ctx, x + R(width / 2) - 6, y + 1, 12, 1, "rgba(255, 255, 255, .30)");
  fill(ctx, b.x - 1, b.y + b.h - 1, b.w + 2, 1, "rgba(5, 10, 15, .45)");
}

function drawOffice(ctx: CanvasRenderingContext2D, office: LayoutOffice): void {
  const b = box(office);
  if (office.stage === "empty") drawOfficePlot(ctx, b);
  else if (office.stage === "foundation") drawOfficeFoundation(ctx, b);
  else if (office.stage === "structure") drawOfficeFrame(ctx, b);
  else if (office.style === "factory") drawOfficeFactory(ctx, b);
  else if (office.style === "storefront") drawOfficeStorefront(ctx, b);
  else drawOfficePlain(ctx, b);
  text(ctx, office.label, b.x, b.y + b.h + 6, TYPE.caption, COLOR.muted, "left");
}

/** 围挡：地上还没开工的那块地，围一圈木板 */
function drawOfficePlot(ctx: CanvasRenderingContext2D, b: Box): void {
  dashedFrame(ctx, { x: b.x, y: b.y + 2, w: b.w, h: b.h - 2 }, "rgba(203, 213, 225, .30)");
  for (let px = b.x + 2; px + 1 < b.x + b.w; px += 4) fill(ctx, px, b.y + b.h - 3, 1, 2, COLOR.hoarding);
}

function drawOfficeFoundation(ctx: CanvasRenderingContext2D, b: Box): void {
  fill(ctx, b.x + 1, b.y + b.h - 3, b.w - 2, 3, "rgba(5, 10, 15, .55)");
  for (let px = b.x + 3; px + 1 < b.x + b.w - 1; px += 3) fill(ctx, px, b.y + b.h - 5, 1, 2, COLOR.rebar);
}

function drawOfficeFrame(ctx: CanvasRenderingContext2D, b: Box): void {
  for (const px of [b.x + 1, b.x + R(b.w / 2), b.x + b.w - 2]) fill(ctx, px, b.y + 2, 1, b.h - 2, COLOR.scaffold);
  fill(ctx, b.x + 1, b.y + 2, b.w - 2, 1, COLOR.scaffold);
  fill(ctx, b.x + 1, b.y + b.h - 2, b.w - 2, 1, "rgba(5, 10, 15, .35)");
}

/** 塔楼：现有的工地办公室 */
function drawOfficePlain(ctx: CanvasRenderingContext2D, b: Box): void {
  fill(ctx, b.x, b.y, b.w, 1, "rgba(5, 10, 15, .35)");
  fill(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, COLOR.office);
  fill(ctx, b.x, b.y - 1, b.w, 2, COLOR.officeRoof);
  fill(ctx, b.x, b.y - 1, b.w, 1, "rgba(255, 255, 255, .14)");
  fill(ctx, b.x + 2, b.y + 3, 3, 3, "rgba(247, 172, 77, .55)");
  fill(ctx, b.x + 2, b.y + 3, 1, 1, "rgba(255, 214, 160, .6)");
  fill(ctx, b.x + b.w - 5, b.y + 3, 3, 5, "rgba(5, 10, 15, .55)");
  fill(ctx, b.x + 1, b.y + b.h - 1, b.w - 2, 1, "rgba(5, 10, 15, .40)");
}

/** 厂房：集装箱板房，侧面一块卷帘门 */
function drawOfficeFactory(ctx: CanvasRenderingContext2D, b: Box): void {
  fill(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, STYLE.factory.wall);
  fill(ctx, b.x, b.y - 1, b.w, 2, STYLE.factory.mortar);
  fill(ctx, b.x, b.y - 1, b.w, 1, "rgba(255, 255, 255, .14)");
  for (let row = b.y + 3; row < b.y + b.h - 1; row += 2) fill(ctx, b.x + 1, row, b.w - 2, 1, "rgba(5, 10, 15, .20)");
  fill(ctx, b.x + b.w - 5, b.y + 2, 4, b.h - 3, COLOR.shutter);
  fill(ctx, b.x + b.w - 5, b.y + 2, 1, b.h - 3, "rgba(255, 255, 255, .12)");
  fill(ctx, b.x + 1, b.y + b.h - 1, b.w - 2, 1, "rgba(5, 10, 15, .40)");
}

/** 临街店：一道雨棚加一扇橱窗 */
function drawOfficeStorefront(ctx: CanvasRenderingContext2D, b: Box): void {
  fill(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, STYLE.storefront.cream);
  fill(ctx, b.x, b.y - 1, b.w, 2, STYLE.storefront.tile);
  fill(ctx, b.x, b.y - 1, b.w, 1, "rgba(232, 220, 200, .45)");
  fill(ctx, b.x + 1, b.y + 3, 5, 2, STYLE.storefront.awning);
  fill(ctx, b.x + 1, b.y + 3, 2, 2, STYLE.storefront.awningLight);
  fill(ctx, b.x + 4, b.y + 3, 1, 1, STYLE.storefront.awning);
  fill(ctx, b.x + 6, b.y + 4, 5, 3, "rgba(5, 10, 15, .55)");
  fill(ctx, b.x + 6, b.y + 4, 5, 1, "rgba(255, 217, 160, .45)");
  fill(ctx, b.x + 1, b.y + b.h - 1, b.w - 2, 1, "rgba(5, 10, 15, .40)");
}

/** 设计师：深色外套 + 琥珀围巾 + 蓝图卷，不戴安全帽 */
function drawDesigner(ctx: CanvasRenderingContext2D, designer: Rect): void {
  const b = box(designer);
  sprite(ctx, b, [
    [1, 0, 6, 2, COLOR.hair],
    [2, 2, 4, 2, COLOR.skin],
    [1, 4, 6, 4, COLOR.jacket],
    [1, 4, 6, 1, COLOR.flag],
    [0, 5, 1, 2, COLOR.jacket],
    [7, 5, 1, 2, COLOR.skin],
    [1, 8, 2, 3, COLOR.pants],
    [5, 8, 2, 3, COLOR.pants],
    [1, 11, 2, 1, COLOR.boot],
    [5, 11, 2, 1, COLOR.boot],
    [6, 6, 3, 1, COLOR.paper],
    [8, 5, 1, 1, COLOR.paper],
  ]);
}

/** 小人：帽色分角色，只读来源脚边一个空心圈；状态用姿体和小标记表达 */
function drawWorker(ctx: CanvasRenderingContext2D, worker: LayoutWorker): void {
  const b = box(worker);
  const small = b.w < 8;
  const hat = HAT[worker.role];
  const rects: Array<[number, number, number, number, string]> = small ? [
    [1, 1, 3, 1, hat], [0, 2, 5, 1, hat],
    [1, 3, 3, 1, COLOR.skin],
    [1, 4, 3, 2, COLOR.vest],
    [1, 4, 3, 1, hat],
    [1, 6, 1, 1, COLOR.pants], [3, 6, 1, 1, COLOR.pants],
  ] : [
    [3, 0, 3, 1, hat], [1, 1, 7, 1, hat],
    [2, 2, 4, 2, COLOR.skin],
    [1, 4, 7, 4, COLOR.vest],
    [1, 4, 7, 1, hat],
    [0, 5, 1, 2, COLOR.skin], [8, 5, 1, 2, COLOR.skin],
    [2, 8, 2, 2, COLOR.pants], [5, 8, 2, 2, COLOR.pants],
    [2, 10, 2, 1, COLOR.boot], [5, 10, 2, 1, COLOR.boot],
  ];
  if (worker.tone === "waiting" && !small) rects.push([8, 2, 1, 3, COLOR.skin]);
  sprite(ctx, b, rects);
  if (worker.role === "inspector" && !small) {
    fill(ctx, b.x + 7, b.y + 5, 2, 2, COLOR.paper);
    fill(ctx, b.x + 7, b.y + 6, 2, 1, "rgba(5, 10, 15, .45)");
  }
  if (worker.role === "foreman" && !small) fill(ctx, b.x + 7, b.y + 3, 1, 2, COLOR.metalLight);
  if (worker.role === "worker" && !small) {
    fill(ctx, b.x + 7, b.y + 6, 2, 1, COLOR.metalLight);
    fill(ctx, b.x + 8, b.y + 7, 1, 1, COLOR.brickDark);
  }
  if (worker.tone === "stalled" || worker.tone === "error") {
    fill(ctx, b.x + 3, b.y - 3, 1, 2, TONE[worker.tone]);
    fill(ctx, b.x + 5, b.y - 3, 1, 2, TONE[worker.tone]);
  }
  if (worker.readOnly) {
    ctx.strokeStyle = COLOR.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(b.x + b.w - 3, b.y + b.h - 3, 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** 先铺一层深色剪影当描边，再上颜色：小人压在砖墙或玻璃上也读得清 */
function sprite(ctx: CanvasRenderingContext2D, b: Box, rects: ReadonlyArray<readonly [number, number, number, number, string]>): void {
  for (const [x, y, w, h] of rects) fill(ctx, b.x + x - 1, b.y + y - 1, w + 2, h + 2, "rgba(5, 10, 15, .62)");
  for (const [x, y, w, h, color] of rects) fill(ctx, b.x + x, b.y + y, w, h, color);
}

function drawWorkers(ctx: CanvasRenderingContext2D, workers: readonly LayoutWorker[]): void {
  for (const worker of workers) drawWorker(ctx, worker);
}

/** 收工的小人从原位走到窗口右缘，最后 30% 淡出 */
export function drawExitingWorker(ctx: CanvasRenderingContext2D, worker: LayoutWorker, x: number, alpha: number): void {
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  drawWorker(ctx, { ...worker, x });
  ctx.globalAlpha = 1;
}

/** 气泡：深色底板 + 状态色 1px 边框和左侧色条，折线引到小人头顶 */
function drawBubbles(ctx: CanvasRenderingContext2D, bubbles: readonly LayoutBubble[]): void {
  for (const bubble of bubbles) {
    const b = box(bubble);
    const sx = Math.max(b.x + 4, Math.min(R(bubble.anchorX), b.x + b.w - 4));
    const ax = [R(bubble.anchorX), R(bubble.anchorX)];
    const mid = R(b.y + b.h + 2);
    fill(ctx, sx, b.y + b.h, 1, Math.max(0, Math.min(mid, bubble.anchorY) - (b.y + b.h)), withAlpha(TONE[bubble.tone], .45));
    fill(ctx, Math.min(sx, ax[0]), mid, Math.abs(ax[0] - sx) + 1, 1, withAlpha(TONE[bubble.tone], .45));
    fill(ctx, ax[0], mid, 1, Math.max(0, R(bubble.anchorY) - mid), withAlpha(TONE[bubble.tone], .45));
    fill(ctx, ax[0] - 1, R(bubble.anchorY) - 1, 2, 2, TONE[bubble.tone]);
  }
  for (const bubble of bubbles) {
    const b = box(bubble);
    fill(ctx, b.x, b.y, b.w, b.h, PLATE.solid);
    fill(ctx, b.x, b.y, 2, b.h, TONE[bubble.tone]);
    frame(ctx, b, withAlpha(TONE[bubble.tone], .55));
    bubble.lines.forEach((line, index) =>
      text(ctx, line, b.x + 5, b.y + 4 + index * 7 + 4, TYPE.caption, PLATE.text));
  }
}

/** 底栏内容：第一行五色图例，第二行每个会话一个灯（只读空心，等你闪烁），多出来的写 +N */
function drawFooterContent(ctx: CanvasRenderingContext2D, layout: BuildingLayout, blinkOn: boolean): void {
  const { footer } = layout;
  for (const item of footer.legend) {
    fill(ctx, item.x, item.y + 3, 3, 3, TONE[item.tone]);
    fill(ctx, item.x, item.y + 3, 3, 1, "rgba(255, 255, 255, .28)");
    text(ctx, item.label, item.x + 4, item.y + 8, TYPE.caption, COLOR.muted);
  }
  for (const light of footer.lights) {
    const x = light.x + light.width / 2, y = light.y + light.height / 2;
    ctx.globalAlpha = light.tone === "waiting" && !blinkOn ? 0.55 : 1;
    if (light.readOnly) {
      ctx.strokeStyle = TONE[light.tone];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = TONE[light.tone];
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, .35)";
      ctx.beginPath();
      ctx.arc(x - 0.8, y - 1, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (footer.more !== null) text(ctx, footer.more.text, footer.more.x, footer.more.y + 8, TYPE.caption, COLOR.muted);
}

function dashedFrame(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, color: string): void {
  if (b.w <= 2 || b.h <= 2) return;
  for (let x = b.x + 1; x < b.x + b.w - 1; x += 4) {
    fill(ctx, x, b.y, Math.min(2, b.x + b.w - 1 - x), 1, color);
    fill(ctx, x, b.y + b.h - 1, Math.min(2, b.x + b.w - 1 - x), 1, color);
  }
  for (let y = b.y + 1; y < b.y + b.h - 1; y += 4) {
    fill(ctx, b.x, y, 1, Math.min(2, b.y + b.h - 1 - y), color);
    fill(ctx, b.x + b.w - 1, y, 1, Math.min(2, b.y + b.h - 1 - y), color);
  }
}

function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith("#")) return color;
  const value = parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function fitText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}
