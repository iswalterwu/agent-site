import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultSettings, loadSettings, writeSettings } from "../../src/main/settings";
import { draftOf, fromDraft, parseDraft, engineSettingsChanged } from "../../src/app/settings-form";
import { BridgeService } from "../../src/main/bridge-service";
import type { Locale } from "../../src/core/i18n";
import { SiteEngine } from "../../src/main/engine";
import { appendJsonl, piAssistant, piHeader, piResult, piUser, writeJsonl } from "../fixtures/logs";
import { piFile } from "../fixtures/world";
import { makeRepo } from "../fixtures/repo";
import { ZstdTail } from "../../src/main/readers/zstd";
import { planNotices } from "../../src/app/notify";
import { fixtureSnapshot } from "../../src/app/fixture";
import { mkTmpDir } from "../harness/wait";

it("WINDOW-32：旧设置缺少 language 时跟随系统，读取不迁移文件", () => {
  const dir = mkTmpDir();
  const file = path.join(dir, "settings.json");
  const original = JSON.stringify({ theme: "day" });
  fs.writeFileSync(file, original);
  expect(loadSettings(dir, "en-US").settings.language).toBe("system");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

it("WINDOW-32：语言选择可保存，JSON 不存解析后的系统语言或本机信息", () => {
  const dir = mkTmpDir();
  const settings = { ...defaultSettings(), language: "en" as const };
  writeSettings(dir, settings);
  expect(loadSettings(dir, "zh-CN").settings).toEqual(settings);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  expect(data.language).toBe("en");
  expect(data).not.toHaveProperty("locale");
});

it("WINDOW-32：非法语言使用默认配置，以解析出的语言说明", () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ language: "fr", theme: "day" }));
  const result = loadSettings(dir, "en-GB");
  expect(result.settings).toEqual(defaultSettings());
  expect(result.diagnostics.join(" ")).toContain("language");
  expect(result.diagnostics.join(" ")).not.toMatch(/[\u3400-\u9fff]/);
});

it("WINDOW-27、WINDOW-32：表单带语言，非法值不能越过入口，英文校验不改输入", () => {
  const draft = draftOf({ ...defaultSettings(), language: "en" });
  expect(draft.language).toBe("en");
  expect(parseDraft({ ...draft, language: "fr" })).toBeNull();
  const invalid = { ...draft, idleMinutes: 0 };
  const before = structuredClone(invalid);
  const parsed = fromDraft(invalid, "en");
  expect("errors" in parsed).toBe(true);
  if ("errors" in parsed) expect(parsed.errors.join(" ")).not.toMatch(/[\u3400-\u9fff]/);
  expect(invalid).toEqual(before);
});

it("WINDOW-32：只改语言和外观不重启引擎，保留会话缓存", () => {
  const before = defaultSettings();
  expect(engineSettingsChanged(before, { ...before, language: "en", theme: "day", autostart: true })).toBe(false);
  expect(engineSettingsChanged(before, { ...before, thresholds: { ...before.thresholds, idleMinutes: 2 } })).toBe(true);
});

it("WINDOW-33：App 侧桥接反馈随生效语言切换，不改线上的消息", async () => {
  let locale: Locale = "en";
  const service = new BridgeService({ file: path.join(mkTmpDir(), "bridge.json"), repos: [], locale: () => locale });
  expect(service.answer("missing", "原始答案")).toEqual({ accepted: false, reason: "This decision has ended", messageKey: "这个决策已经结束" });
  expect(await service.command("missing", { type: "pause" })).toEqual({ ok: false, error: "Session is not online", messageKey: "会话不在线" });
  locale = "zh-CN";
  expect(service.answer("missing", null)).toEqual({ accepted: false, reason: "这个决策已经结束", messageKey: "这个决策已经结束" });
  service.stop();
});

it("WINDOW-32：语言切换保留日志中段缓存的待办，不把工地变回矮楼", async () => {
  const repo = makeRepo({ git: true });
  const roots = { pi: mkTmpDir(), claude: mkTmpDir(), dsh: mkTmpDir() };
  const file = piFile(roots.pi, "language");
  const todos = [{ text: "Read the plan", status: "completed" }, { text: "Build search", status: "in_progress" }];
  const result = piResult("todo", "site_todo", { t: 3 });
  (result.message as Record<string, unknown>).details = { todos };
  writeJsonl(file, [piHeader(repo, { id: "language", t: 0 }), piUser("Build notes", 1),
    piAssistant([{ type: "text", text: "x".repeat(80_000) }], { t: 2 }), result]);
  const engine = new SiteEngine({ roots, settings: { ...defaultSettings(), locale: "zh-CN" }, watch: false, minIntervalMs: 0, now: () => 10 });
  try {
    await engine.refresh();
    appendJsonl(file, [piAssistant([{ type: "text", text: "x".repeat(700_000) },
      { type: "toolCall", id: "read", name: "read", arguments: { path: "src/notes.ts" } }], { t: 4 })]);
    await engine.refresh();
    const before = engine.snapshot().sites[0];
    expect(before.workers[0].todos).toEqual(todos);
    expect(before.workers[0].actions.at(-1)?.text).toBe("看 notes.ts");
    await engine.setLocale("en");
    const after = engine.snapshot().sites[0];
    expect(after.key).toBe(before.key);
    expect(after.workers[0].todos).toEqual(todos);
    expect(after.bands[0].card.slices).toEqual({ total: 2, done: 1 });
    expect(after.workers[0].actions.at(-1)?.text).toBe("Read notes.ts");
  } finally { engine.stop(); }
});

it("WINDOW-32、WINDOW-33：有效保存清理已解决的启动设置诊断，语言切换不修改调用方设置", async () => {
  const settings = defaultSettings();
  const engine = new SiteEngine({ roots: { pi: mkTmpDir(), claude: mkTmpDir(), dsh: mkTmpDir() },
    settings, diagnostics: ["settings.json 读不出，已用默认配置"], watch: false, minIntervalMs: 0 });
  try {
    await engine.refresh();
    await engine.setLocale("en", []);
    expect(engine.snapshot().diagnostics).toEqual([]);
    expect(settings).not.toHaveProperty("locale");
  } finally { engine.stop(); }
});

it("WINDOW-33：读取器自身的诊断按当前语言拼接，换语言不重建读取偏移", async () => {
  const file = path.join(mkTmpDir(), "bad.zstd");
  fs.writeFileSync(file, Buffer.alloc(8));
  let locale: Locale = "en";
  const tail = new ZstdTail(file, () => locale);
  await expect(tail.read()).rejects.toThrow("Invalid zstd frame header");
  locale = "zh-CN";
  await expect(tail.read()).rejects.toThrow("不是 zstd 帧头");
});

it("WINDOW-33：英文通知只翻译程序文字，原始问题不翻译，演示模式仍隐藏正文", () => {
  const snapshot = fixtureSnapshot(0);
  const input = { snapshot, asks: [{ askId: "en", sessionKey: "pi:s1", sessionId: "s1", question: "原始中文问题？",
    options: [], allowOther: true, at: 0 }], seen: new Map(), focused: false, demo: false, dnd: false, now: 0, locale: "en" as const };
  const normal = planNotices(input).notices[0];
  expect(normal.title).not.toMatch(/[\u3400-\u9fff]/);
  expect(normal.body).toBe("原始中文问题？");
  expect(planNotices({ ...input, demo: true }).notices[0].body).toBe("Decision content is hidden in demo mode");
});
