import { expect, it } from "vitest";
import { MESSAGES, resolveLocale, t, type MessageKey, type MessageValue } from "../../src/core/i18n";

it("WINDOW-32：跟随系统与手动语言选择", () => {
  expect([resolveLocale("system", "zh-CN"), resolveLocale("system", "zh-TW"), resolveLocale("system", "en-US"), resolveLocale("system", "fr-FR")])
    .toEqual(["zh-CN", "zh-CN", "en", "en"]);
  expect(resolveLocale("en", "zh-CN")).toBe("en");
  expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
});

it("WINDOW-33：词条有英文，参数占位符一致；不重新翻译原始参数", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, raw] of Object.entries(MESSAGES)) {
    const entry: MessageValue = raw;
    const zh = typeof entry === "string" ? key : entry.zh;
    const en = typeof entry === "string" ? entry : entry.en;
    expect(en.trim(), key).not.toBe("");
    expect(en, key).not.toMatch(/[\u3400-\u9fff]/);
    expect(placeholders(en), key).toEqual(placeholders(zh));
    if (typeof entry !== "string" && entry.enOne !== undefined) {
      expect(entry.enOne, key).not.toMatch(/[\u3400-\u9fff]/);
      expect(placeholders(entry.enOne), key).toEqual(placeholders(zh));
    }
    const params = Object.fromEntries(placeholders(zh).map(name => [name, "中文原文"]));
    if (Object.keys(params).length) expect(t("en", key as MessageKey, params), key).toContain("中文原文");
  }
});

it("WINDOW-33：英文计数使用单复数，中文计数保留原格式", () => {
  expect(t("en", "{count} 人 · {roles}", { count: 1, roles: "Foreman" })).toBe("1 worker · Foreman");
  expect(t("en", "{count} 人 · {roles}", { count: 2, roles: "Workers" })).toBe("2 workers · Workers");
  expect(t("zh-CN", "{count} 人 · {roles}", { count: 1, roles: "工头" })).toBe("1 人 · 工头");
});
