import { redact } from "./redact";
import { activeSlice, cardStatus } from "./floors";
import type { BandCard, BuildingStyle, BuildStage, FeatureConfig, FeatureInput, FeatureStatus, Ribbon, Worker } from "./types";

export function orderFeatures(features: readonly FeatureInput[], config: readonly FeatureConfig[]):
  { bands: Array<{ input: FeatureInput; config: FeatureConfig; configured: boolean }>; office: FeatureInput[] } {
  const byName = new Map(features.map(f => [f.name, f]));
  const names = new Set(config.map(c => c.name));
  const configured = (placement: FeatureConfig["placement"]) => config.filter(c => c.placement === placement)
    .flatMap(c => { const input = byName.get(c.name); return input ? [{ input, config: c, configured: true }] : []; });
  const unconfigured = features.filter(f => !names.has(f.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(input => ({ input, config: { name: input.name, placement: "band" as const, materials: [{ material: "concrete" as const, share: 100 }] }, configured: false }));
  return { bands: [...configured("band"), ...unconfigured, ...configured("crown")], office: configured("office").map(x => x.input) };
}

/** 造型：feature 写了自己的就用它，否则跟工地的默认造型 */
export function resolveStyle(feature: BuildingStyle | undefined, site: BuildingStyle): BuildingStyle {
  return feature ?? site;
}

/** 阶段只看切片的 done / total；没有切片的段由调用方给 empty，矮楼给 done */
export function stageOf(total: number, done: number): BuildStage {
  if (total <= 0 || done <= 0) return "empty";
  if (done >= total) return "done";
  return done / total < 0.5 ? "foundation" : "structure";
}

export function ribbonColor(status: FeatureStatus | null, workers: readonly Worker[]): Ribbon {
  if (workers.some(w => w.status === "waiting")) return "orange";
  if (workers.some(w => w.lastTestFailure !== null || w.actions.at(-1)?.kind === "api_error")) return "red";
  if (workers.some(w => w.status === "stalled")) return "yellow";
  if (workers.some(w => w.status === "working")) return "green";
  return "grey";
}

const safe = (s: string): string => redact(s);

/** 楼段卡：意图卡读不出时，除 specsDir 外全是 null */
export function bandCard(input: FeatureInput): BandCard {
  if (input.card === undefined) {
    return { title: null, risk: null, ac: null, open: null, openItems: null, slices: null, current: null, status: null,
      source: "card", specsDir: input.specsDir };
  }
  const card = input.card;
  const active = activeSlice(card);
  return {
    title: safe(card.title), risk: card.risk, ac: card.ac, open: card.open,
    openItems: card.openItems.map(safe),
    slices: { total: card.slices.length, done: card.slices.filter(s => s.done).length },
    current: active === null ? null : { id: active.id, title: safe(active.title),
      stepsDone: active.steps.filter(s => s.done).length, stepsTotal: active.steps.length },
    status: cardStatus(card), source: "card", specsDir: input.specsDir,
  };
}
