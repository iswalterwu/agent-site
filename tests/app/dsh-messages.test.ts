import { expect, it } from "vitest";
import { COPY, ERRORS, panelFeedback } from "../../packages/dsh-plugin/src/messages";
import { OPEN_ERRORS } from "../../src/protocol/launch";

it("DIST-4、DIST-6：插件中英词条完整，英文反馈没有程序中文", () => {
  expect(Object.keys(COPY.zh).sort()).toEqual(Object.keys(COPY.en).sort());
  for (const locale of ["en", "zh"] as const) expect(Object.keys(ERRORS[locale]).sort()).toEqual([...OPEN_ERRORS].sort());
  for (const text of [...Object.values(COPY.en), ...Object.values(ERRORS.en)]) {
    expect(text).not.toMatch(/\p{Script=Han}/u);
    expect(text.trim()).not.toBe("");
  }
});

it("DIST-4：未保存修改和已清空路径不被旧打开状态遮住，错误随当前语言格式化", () => {
  const base = { configured: true, dirty: false, local: true };
  expect(panelFeedback("en", { kind: "sent" }, { ...base, dirty: true })).toBe(COPY.en.dirty);
  expect(panelFeedback("en", { kind: "sent" }, { ...base, configured: false })).toBe(COPY.en.missing);
  expect(panelFeedback("en", { kind: "pending" }, base)).toBe(COPY.en.pending);
  expect(panelFeedback("en", { kind: "error", code: "missing-component" }, base)).toBe(ERRORS.en["missing-component"]);
  expect(panelFeedback("zh", { kind: "error", code: "missing-component" }, base)).toBe(ERRORS.zh["missing-component"]);
  expect(panelFeedback("en", { kind: "sent" }, { ...base, local: false })).toBe(ERRORS.en.unsupported);
});
