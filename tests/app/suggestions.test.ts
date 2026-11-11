import { expect, it } from "vitest";
import { clearSent, emptyDrafts, modeFor, setMode, setText, textFor } from "../../src/app/suggestions";

it("建议草稿按会话隔离，清空只清已发出的同一版", () => {
  let drafts = emptyDrafts();
  drafts = setText(drafts, "pi:a", "给 A 的");
  drafts = setText(drafts, "pi:b", "给 B 的");
  expect(textFor(drafts, "pi:a")).toBe("给 A 的");
  expect(textFor(drafts, "pi:b")).toBe("给 B 的");
  drafts = clearSent(drafts, "pi:a", "给 A 的");
  expect(textFor(drafts, "pi:a")).toBe("");
  expect(textFor(drafts, "pi:b")).toBe("给 B 的");

  drafts = setText(drafts, "pi:a", "新输入");
  expect(clearSent(drafts, "pi:a", "旧提交")).toBe(drafts);
  expect(textFor(drafts, "pi:a")).toBe("新输入");
  expect(modeFor(drafts, "pi:a")).toBe("steer");
  drafts = setMode(drafts, "pi:a", "followUp");
  expect(modeFor(drafts, "pi:a")).toBe("followUp");
});
