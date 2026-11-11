import { expect, it } from "vitest";
import { activeSlice, cardStatus, inferFloors } from "../../src/core/floors";
import type { IntentCard, Slice } from "../../src/core/types";

const step = (done: boolean, text = "步") => ({ text, done });
const slice = (id: string, o: Partial<Slice> = {}): Slice => ({ id, title: `切片 ${id}`, done: false, current: false, steps: [], ...o });
const card = (slices: Slice[]): IntentCard => ({ title: "T", risk: null, ac: 0, open: 0, openItems: [], slices });

it("一个切片一层：✓ 实体，当前按步骤砌，后续虚线", () => {
  const plan = inferFloors(card([
    slice("S1", { done: true }),
    slice("S2", { current: true, steps: [step(true), step(false), step(false)] }),
    slice("S3"),
  ]));
  expect(plan.floors).toEqual([
    { id: "S1", kind: "built" },
    { id: "S2", kind: "progress", cells: 3, doneCells: 1 },
    { id: "S3", kind: "planned" },
  ]);
  expect(plan.firstUnfinished).toBe("S2");
});

it("没有标（当前）时把第一个未 ✓ 的切片当当前切片", () => {
  const plan = inferFloors(card([slice("S1", { done: true }), slice("S2", { steps: [step(true), step(true)] }), slice("S3")]));
  expect(plan.floors[1]).toEqual({ id: "S2", kind: "progress", cells: 2, doneCells: 2 });
  expect(plan.firstUnfinished).toBe("S2");
});

it("（当前）标在已 ✓ 的切片上不算当前，继续找第一个未完成", () => {
  const plan = inferFloors(card([slice("S1", { done: true, current: true }), slice("S2"), slice("S3")]));
  expect(plan.floors[1]).toEqual({ id: "S2", kind: "planned" });
  expect(activeSlice(card([slice("S1", { done: true, current: true }), slice("S2")]))?.id).toBe("S2");
});

it("当前切片没写步骤：画虚线，不是实体", () => {
  const plan = inferFloors(card([slice("S1", { current: true })]));
  expect(plan.floors[0]).toEqual({ id: "S1", kind: "planned" });
  expect(plan.firstUnfinished).toBe("S1");
});

it("全部 ✓：都画实体，第一个未完成层为 null，状态 done", () => {
  const c = card([slice("S1", { done: true }), slice("S2", { done: true })]);
  expect(inferFloors(c).floors).toEqual([{ id: "S1", kind: "built" }, { id: "S2", kind: "built" }]);
  expect(inferFloors(c).firstUnfinished).toBeNull();
  expect(cardStatus(c)).toBe("done");
});

it("切片为空：没有楼层；至少一片未完成就是 in-progress", () => {
  expect(inferFloors(card([]))).toEqual({ floors: [], firstUnfinished: null });
  expect(cardStatus(card([]))).toBe("in-progress");
  expect(cardStatus(card([slice("S1")]))).toBe("in-progress");
});

it("楼层 id 和顺序原样取自切片，允许超过 120 格", () => {
  const steps = Array.from({ length: 130 }, (_, i) => step(i < 129));
  const plan = inferFloors(card([slice("S7", { steps })]));
  expect(plan.floors[0]).toEqual({ id: "S7", kind: "progress", cells: 130, doneCells: 129 });
});

it("六层 id 原样保留、顺序不变；doneCells 就是打了勾的步骤数，不会超过格数", () => {
  const ids = ["S1", "S2", "S3", "S4", "S5", "S7"];
  const plan = inferFloors(card(ids.map((id, i) => slice(id, i === 3
    ? { current: true, steps: [step(true), step(true), step(false)] }
    : { done: i < 3 }))));
  expect(plan.floors.map(f => f.id)).toEqual(ids);
  expect(plan.floors.map(f => f.kind)).toEqual(["built", "built", "built", "progress", "planned", "planned"]);
  expect(plan.firstUnfinished).toBe("S4");
  expect(plan.floors[3]).toEqual({ id: "S4", kind: "progress", cells: 3, doneCells: 2 });
});
