import { describe, expect, it } from "vitest";
import { brief, firstSentence, lastSentence } from "../../src/core/text";

it.each(["……", "...", "```", "。。", "——"])("只有标点的片段不算句子：%s", (text) => {
  expect(lastSentence(text)).toBe("");
  expect(firstSentence(text)).toBe("");
});

it("最后一段只有标点时，取前面最后一个真句子", () => {
  expect(lastSentence("测试都过了。……")).toBe("测试都过了。");
  expect(lastSentence("看下面的输出：\n```")).toBe("看下面的输出：");
});

describe("卡片概况", () => {
  it("最多留最后 5 句，并脱敏", () => {
    expect(brief("一。二。三。四。五。六。")).toBe("二。三。四。五。六。");
    expect(brief("One. Two. Three. Four. Five. Six.")).toBe("Two. Three. Four. Five. Six.");
    expect(brief("api.ts 和 v1.2 都还在。")).toBe("api.ts 和 v1.2 都还在。");
    expect(brief("密钥 sk-abcdefgh12345678 别外传")).not.toContain("abcdefgh12345678");
    expect(brief("甲".repeat(500))).toHaveLength(420);
  });
});
