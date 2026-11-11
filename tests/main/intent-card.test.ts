import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { parseIntentCard, readFeatures } from "../../src/main/intent-card";
import { readBacklog } from "../../src/main/backlog";
import { mkTmpDir } from "../harness/wait";
import { card, makeRepo } from "../fixtures/repo";

it("解析完整意图卡：标题、风险档、验收例子数、待定数、切片与步骤", () => {
  const raw = card({ name: "agent-dock", risk: "中", ac: ["A1：a", "A2：b"], open: ["问题 —— 默认：x"],
    slices: ["- S1：第一刀 ✓", "  - [x] 做完了", "- S2：进行中（当前）", "  - [x] 第一步", "  - [ ] 第二步", "- S3：还没拆"] });
  expect(parseIntentCard(raw)).toEqual({ title: "一句话", risk: "中", ac: 2, open: 1, openItems: ["问题 —— 默认：x"], slices: [
    { id: "S1", title: "第一刀", done: true, current: false, steps: [{ text: "做完了", done: true }] },
    { id: "S2", title: "进行中", done: false, current: true, steps: [{ text: "第一步", done: true }, { text: "第二步", done: false }] },
    { id: "S3", title: "还没拆", done: false, current: false, steps: [] },
  ] });
});

it("剥掉 BOM，接受 CRLF、半角括号和大小写 x", () => {
  const raw = "\uFEFF# f：说明\r\n## 切片\r\n- S1：一(当前)\r\n  - [X] 甲\r\n- S2：二 ✓\r\n  - [x] 乙";
  expect(parseIntentCard(raw)).toEqual({ title: "说明", risk: null, ac: 0, open: 0, openItems: [], slices: [
    { id: "S1", title: "一", done: false, current: true, steps: [{ text: "甲", done: true }] },
    { id: "S2", title: "二", done: true, current: false, steps: [{ text: "乙", done: true }] },
  ] });
});

it("标题取第一个冒号后的说明；没有冒号或冒号后为空时用整行", () => {
  expect(parseIntentCard("# feature：一句话\n## 切片")?.title).toBe("一句话");
  expect(parseIntentCard("# feature\n## 切片")?.title).toBe("feature");
  expect(parseIntentCard("# feature：\n## 切片")?.title).toBe("feature");
});

it("只有行尾 ✓ 算完成；当前标记里的 ✓ 不改变状态，也不留在标题里", () => {
  const raw = ["# f：x", "## 切片", "- S1：第一刀 ✓", "- S2：第二刀（当前；类型检查 ✓，待审核）", "  - [ ] 步骤"].join("\n");
  const got = parseIntentCard(raw);
  expect(got?.slices).toEqual([
    { id: "S1", title: "第一刀", done: true, current: false, steps: [] },
    { id: "S2", title: "第二刀", done: false, current: true, steps: [{ text: "步骤", done: false }] },
  ]);
});

it("缺 ## 切片、缺 H1、切片 id 重复都算读不出", () => {
  expect(parseIntentCard("# f：x\n## 目标\n\n说明")).toBeNull();
  expect(parseIntentCard("## 切片\n- S1：一")).toBeNull();
  expect(parseIntentCard("# f：x\n## 切片\n- S1：一\n- S1：二")).toBeNull();
});

it("切片一节为空是合法的未拆切片；没有切片行的复选框不属于任何切片", () => {
  expect(parseIntentCard("# f：x\n## 切片\n")).toEqual({ title: "x", risk: null, ac: 0, open: 0, openItems: [], slices: [] });
  expect(parseIntentCard("# f：x\n## 切片\n- [x] 无主\n- S1：一")?.slices).toEqual([
    { id: "S1", title: "一", done: false, current: false, steps: [] }]);
  expect(parseIntentCard("# f：x\n## 切片\n- S1 没冒号")?.slices).toEqual([]);
});

it("验收例子和待定只数本节顶格的条目；风险档只认本节", () => {
  const raw = ["# f：x", "## 验收例子", "- A1：a", "- A10:b", "- AC-001-1：c", "- settings / AC-002-1：不数", "  - A2：不数", "- B1：不数", "## 风险", "风险档：高", "- 风险档：中", "## 切片", "- S1：一", "## 待定", "- 一", "- 二", "  - 三"].join("\n");
  expect(parseIntentCard(raw)).toMatchObject({ ac: 3, open: 2, risk: "中" });
});

it("readFeatures：只看 specs/ 下带 spec.md 的目录，按名字排；坏卡片带 unreadable", async () => {
  const repo = makeRepo({ cards: { "b-feat": card({ name: "b" }), "a-feat": card({ name: "a" }) },
    files: { "no-card": ["reviewer.md"], bad: ["spec.md"] } });
  writeFileSync(path.join(repo, "specs", "backlog.md"), "# 待做池\n");
  mkdirSync(path.join(repo, "specs", "dir-card", "spec.md"), { recursive: true });
  const outside = path.join(repo, "outside.md");
  writeFileSync(outside, card());
  mkdirSync(path.join(repo, "specs", "linked"), { recursive: true });
  symlinkSync(outside, path.join(repo, "specs", "linked", "spec.md"), "file");
  const got = await readFeatures(repo);
  expect(got.map(f => f.name)).toEqual(["a-feat", "b-feat", "bad"]);
  expect(got[0].specsDir).toBe(path.join(repo, "specs", "a-feat"));
  expect(got[0].card?.title).toBe("一句话");
  expect(got[2]).toEqual({ name: "bad", specsDir: path.join(repo, "specs", "bad"), error: "unreadable" });
});

it("旧的 workflow/state 与意图卡并存时只读意图卡", async () => {
  const repo = makeRepo({ cards: { "a-feat": card({ name: "a" }) } });
  mkdirSync(path.join(repo, "workflow", "state"), { recursive: true });
  writeFileSync(path.join(repo, "workflow", "state", "a-feat.json"), JSON.stringify({ schema: 1, status: "done" }));
  writeFileSync(path.join(repo, "workflow", "state", "old-only.json"), JSON.stringify({ schema: 1 }));
  const got = await readFeatures(repo);
  expect(got.map(f => [f.name, f.card === undefined ? f.error : f.card.title])).toEqual([["a-feat", "一句话"]]);
});

it("没有 specs 目录：返回空列表", async () => {
  expect(await readFeatures(mkTmpDir())).toEqual([]);
});

it("WINDOW-28：待定最多收 20 条，数量仍按原来的口径算", () => {
  const items = Array.from({ length: 21 }, (_, index) => `第 ${index + 1} 条`);
  const raw = card({ open: items, slices: ["- S1：一"] });
  const parsed = parseIntentCard(raw);
  expect(parsed?.open).toBe(21);
  expect(parsed?.openItems).toHaveLength(20);
  expect(parsed?.openItems.at(-1)).toBe("第 20 条");
});

it("WINDOW-29：待做池读 specs/backlog.md 的列表项，坏文件和没有文件都当空", async () => {
  const dir = mkTmpDir();
  mkdirSync(path.join(dir, "specs"), { recursive: true });
  writeFileSync(path.join(dir, "specs", "backlog.md"), "# 待办\n\n只记还没做的。\n\n- 第一条\n- 第二条 `code`\n\n不以列表开头的行\n");
  expect(await readBacklog(dir)).toEqual(["第一条", "第二条 `code`"]);
  const empty = mkTmpDir();
  expect(await readBacklog(empty)).toEqual([]);
  writeFileSync(path.join(empty, "specs"), "");
  expect(await readBacklog(empty)).toEqual([]);
});

it("WINDOW-29：BOM、CRLF、21 条上限", async () => {
  const dir = mkTmpDir();
  mkdirSync(path.join(dir, "specs"), { recursive: true });
  writeFileSync(path.join(dir, "specs", "backlog.md"), "\uFEFF- 第一条\r\n- 第二条\r\n");
  expect(await readBacklog(dir)).toEqual(["第一条", "第二条"]);
  const many = Array.from({ length: 21 }, (_, index) => `- 第 ${index + 1} 条`).join("\n");
  writeFileSync(path.join(dir, "specs", "backlog.md"), many);
  const items = await readBacklog(dir);
  expect(items).toHaveLength(20);
  expect(items.at(-1)).toBe("第 20 条");
});
