import { expect, it } from "vitest";
import { ref } from "vue";
import { defaultSettings } from "../../src/main/settings";
import { draftOf, fromDraft, mergeSettings, parseDraft } from "../../src/app/settings-form";
import { draftPayload } from "../../src/app/draft-payload";

it("WINDOW-27：设置面板打开时带着当前设置，保存后原样折回设置对象", () => {
  const settings = { ...defaultSettings(), theme: "day" as const, style: "storefront" as const, autostart: true,
    thresholds: { idleMinutes: 5, stalledMinutes: 40, onsiteHours: 12 } };
  const draft = draftOf(settings);
  expect(draft).toEqual({ language: "system", theme: "day", style: "storefront", autostart: true,
    idleMinutes: 5, stalledMinutes: 40, onsiteHours: 12, repos: "" });
  const parsed = fromDraft(draft);
  expect("settings" in parsed && parsed.settings).toEqual({
    repos: [], thresholds: settings.thresholds, autostart: true, theme: "day", style: "storefront", language: "system",
  });
});
it("WINDOW-27：表单里的错原样说清楚，不偷偷存成默认值", () => {
  const base = draftOf(defaultSettings());
  const errors = (patch: Partial<typeof base>): string[] => {
    const parsed = fromDraft({ ...base, ...patch });
    return "errors" in parsed ? parsed.errors : [];
  };
  expect(errors({ idleMinutes: 0 })[0]).toBe("空闲分钟要是大于 0 的数字");
  expect(errors({ idleMinutes: 30, stalledMinutes: 20 })).toContain("停工分钟要大于空闲分钟");
  expect(errors({ stalledMinutes: Number.NaN })).toContain("停工分钟要是大于 0 的数字");
  expect(errors({ style: "shop" as never })).toContain("默认造型只能是塔楼、厂房或临街店");
});
it("WINDOW-27、WINDOW-30：合并时只换面板管得到的键，其余（repos、features、style、pins）原样保留", () => {
  const settings = { ...defaultSettings(),
    style: "factory" as const,
    repos: [{ path: "/work/x", name: "x" }],
    features: [{ name: "数据层", placement: "band" as const, materials: [{ material: "brick" as const, share: 100 }], style: "storefront" as const }],
    pins: { 数据层: { feature: "数据层" } } };
  const patch = { repos: [{ path: "/work/x", name: "x" }], thresholds: { idleMinutes: 4, stalledMinutes: 30, onsiteHours: 24 },
    autostart: false, theme: "night" as const, style: "tower" as const, language: "system" as const };
  const merged = mergeSettings(settings, patch);
  expect(merged).toEqual({ ...settings, ...patch });
  expect([merged.style, merged.features]).toEqual(["tower", settings.features]);
});
const NL = String.fromCharCode(10);

it('WINDOW-27：工地列表一行一个，路径或 `路径 = "名字"` 都能原样往返', () => {
  const settings = { ...defaultSettings(), repos: [
    { path: "/work/shop", name: "购物车" },
    { path: "/work/api", name: "api" },
    { path: "/work/a = b", name: "b" },
    { path: "/work/as-is", name: "as-is" },
  ] };
  const draft = draftOf(settings);
  expect(draft.repos.split(NL)).toEqual([
    '/work/shop = "购物车"',
    "/work/api",
    '/work/a = b = "b"',
    "/work/as-is",
  ]);
  const parsed = fromDraft(draft);
  expect("settings" in parsed && parsed.settings.repos).toEqual(settings.repos);
});
it("WINDOW-27：工地写错了逐条说清楚，空行忽略", () => {
  const base = draftOf(defaultSettings());
  const errors = (repos: string): string[] => {
    const parsed = fromDraft({ ...base, repos });
    return "errors" in parsed ? parsed.errors : [];
  };
  expect(errors("relative/repo")).toEqual(["工地要写绝对路径：relative/repo"]);
  expect(errors(["/work/a", "", " relative/b"].join(NL))).toEqual(["工地要写绝对路径： relative/b"]);
  expect(errors("")).toEqual([]);
});
it("WINDOW-27：IPC 边界把不完整的东西挡在外面", () => {
  const good = draftOf(defaultSettings());
  expect(parseDraft(good)).toEqual(good);
  expect(parseDraft(null)).toBeNull();
  expect(parseDraft({ ...good, theme: "dark" })).toBeNull();
  expect(parseDraft({ ...good, style: "shop" })).toBeNull();
  expect(parseDraft({ ...good, style: undefined })).toBeNull();
  expect(parseDraft({ ...good, autostart: "true" })).toBeNull();
  expect(parseDraft({ ...good, idleMinutes: "5" })).toBeNull();
});

it("WINDOW-27：路径末尾的不间断空格、以及以 ` = \"...\"` 结尾的路径，都能原样往返", () => {
  const nbsp = String.fromCharCode(0xa0);
  const settings = { ...defaultSettings(), repos: [
    { path: `/work/tail${nbsp}`, name: `tail${nbsp}` },
    { path: '/work/x = "a"', name: 'x = "a"' },
    { path: '/work/y = "b"', name: "别的名字" },
  ] };
  const parsed = fromDraft(draftOf(settings));
  expect("settings" in parsed && parsed.settings.repos).toEqual(settings.repos);
});
it("WINDOW-27：名字里有引号、反斜杠、换行也原样往返", () => {
  for (const name of ['say "hi"', 'back\slash', 'a = "b"', 'line1' + String.fromCharCode(10) + 'line2', ""]) {
    const settings = { ...defaultSettings(), repos: [{ path: "/work/weird", name: name === "" ? "weird" : name }] };
    const parsed = fromDraft(draftOf(settings));
    expect("settings" in parsed && parsed.settings.repos).toEqual(settings.repos);
  }
});

it("WINDOW-27：面板草稿在 IPC 前取成普通对象，响应式代理不会让结构化克隆失败", () => {
  const reactive = ref(draftOf(defaultSettings()));
  expect(() => structuredClone(reactive.value)).toThrow();
  const payload = draftPayload(reactive.value);
  expect(() => structuredClone(payload)).not.toThrow();
  expect(payload).toEqual(draftOf(defaultSettings()));
});
