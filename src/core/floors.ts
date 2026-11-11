// 楼层推断：一个切片一层楼，当前切片按步骤逐块砌。只看解析好的意图卡，不读文件。

import type { FeatureStatus, FloorView, FloorPlan, IntentCard, Slice } from "./types";

/** 当前切片：优先取标了（当前）且没 ✓ 的；没有标记就取第一个没 ✓ 的 */
export function activeSlice(card: IntentCard): Slice | null {
  return card.slices.find((s) => s.current && !s.done) ?? card.slices.find((s) => !s.done) ?? null;
}

/** 全部切片都 ✓ 且至少有一片才算 done */
export function cardStatus(card: IntentCard): FeatureStatus {
  return card.slices.length > 0 && card.slices.every((s) => s.done) ? "done" : "in-progress";
}

export function inferFloors(card: IntentCard): FloorPlan {
  const active = activeSlice(card);
  const floors = card.slices.map((slice): FloorView => {
    if (slice.done) return { id: slice.id, kind: "built" };
    if (slice === active && slice.steps.length > 0) {
      return { id: slice.id, kind: "progress", cells: slice.steps.length, doneCells: slice.steps.filter((s) => s.done).length };
    }
    return { id: slice.id, kind: "planned" };
  });
  return { floors, firstUnfinished: floors.find((f) => f.kind !== "built")?.id ?? null };
}
