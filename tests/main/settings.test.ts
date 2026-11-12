import { writeFileSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "../harness/wait";
import { DEFAULT_FEATURES, appDataDir, defaultSettings, loadSettings, writeSettings } from "../../src/main/settings";
import { windowBounds } from "../../src/app/window";

const write = (dir: string, value: unknown) => writeFileSync(path.join(dir, "settings.json"), JSON.stringify(value));

describe("settings", () => {
  it("uses the bridge data directory", () => {
    expect(appDataDir({ AGENT_SITE_HOME: "D:/x", APPDATA: "C:/A" })).toBe(path.normalize("D:/x"));
    expect(appDataDir({ APPDATA: "C:/A" })).toBe(path.join("C:/A", "agent-site"));
  });

  it("SITE-5：默认不含任何工地和功能名，缺文件也照常给出完整默认值", () => {
    const { settings, diagnostics } = loadSettings(mkTmpDir());
    expect(diagnostics).toEqual([]);
    expect([settings.repos, settings.features]).toEqual([[], []]);
    expect(DEFAULT_FEATURES).toEqual([]);
    expect(JSON.stringify(defaultSettings())).not.toMatch(/D:\/work|example|data-layer|desktop-shell/i);
    expect([settings.thresholds, settings.pins])
      .toEqual([{ idleMinutes: 10, stalledMinutes: 30, onsiteHours: 24 }, {}]);
  });

  it("defaults 是深拷贝，改一份不影响下一份", () => {
    const settings = defaultSettings();
    settings.thresholds.idleMinutes = 1;
    settings.features.push({ name: "x", placement: "band", materials: [{ material: "brick", share: 100 }] });
    expect(defaultSettings().thresholds.idleMinutes).toBe(10);
    expect(defaultSettings().features).toEqual([]);
  });

  it("merges partial top-level settings and canonicalizes supplied existing repos", () => {
    const dir = mkTmpDir(), repo = mkTmpDir();
    write(dir, { repos: [{ path: repo, name: "T" }], thresholds: { idleMinutes: 5, stalledMinutes: 30, onsiteHours: 24 }, ignored: true });
    const { settings, diagnostics } = loadSettings(dir);
    expect(diagnostics).toEqual([]);
    expect(settings.repos).toEqual([{ path: realpathSync.native(repo), name: "T" }]);
    expect(settings.thresholds.idleMinutes).toBe(5);
    expect(settings.features).toHaveLength(DEFAULT_FEATURES.length);
  });

  it("windows 记事本存出来的 BOM 不影响解析", () => {
    const dir = mkTmpDir(), repo = mkTmpDir();
    writeFileSync(path.join(dir, "settings.json"), `﻿${JSON.stringify({ repos: [{ path: repo, name: "T" }] })}`);
    const { settings, diagnostics } = loadSettings(dir);
    expect(diagnostics).toEqual([]);
    expect(settings.repos).toEqual([{ path: realpathSync.native(repo), name: "T" }]);
  });

  it("删掉的 extraPathRules 被忽略并给一条诊断，其他键照常生效", () => {
    const dir = mkTmpDir();
    write(dir, { extraPathRules: [{ pattern: "x-*", repo: mkTmpDir() }], theme: "day" });
    const { settings, diagnostics } = loadSettings(dir);
    expect(diagnostics).toEqual(["settings.json 里的 extraPathRules 已不再使用：工地按会话的工作目录自动认定"]);
    expect(settings.theme).toBe("day");
  });

  it("WINDOW-1、WINDOW-2：窗口固定 520，旧配置里的 scale 不再影响任何东西", () => {
    const dir = mkTmpDir();
    write(dir, { scale: 3, theme: "day" });
    const { settings, diagnostics } = loadSettings(dir);
    expect(diagnostics).toEqual([]);
    expect(settings).not.toHaveProperty("scale");
    expect(windowBounds({ x: 0, y: 0, width: 1920, height: 1040 }, 2).width).toBe(520);
  });

  it("reports malformed files", () => {
    const dir = mkTmpDir();
    writeFileSync(path.join(dir, "settings.json"), "{oops");
    expect(loadSettings(dir).diagnostics).toEqual(["settings.json 读不出，已用默认配置"]);
  });

  it.each([
    ["repos", [{ path: "relative", name: "X" }]],
    ["thresholds", { idleMinutes: 5, stalledMinutes: 30 }],
    ["thresholds", { idleMinutes: 0, stalledMinutes: 30, onsiteHours: 24 }],
    ["thresholds", { idleMinutes: 1e999, stalledMinutes: 30, onsiteHours: 24 }],
    ["features", [{ name: "x", placement: "roof", materials: [] }]],
    ["features", [{ name: "x", placement: "band", materials: [] }]],
    ["features", [{ name: "x", placement: "band", materials: [{ material: "wood", share: 100 }] }]],
    ["features", [{ name: "x", placement: "band", materials: [{ material: "brick", share: 99 }] }]],
    ["features", [{ name: "x", placement: "office", materials: [{ material: "brick", share: 0 }] }]],
    ["pins", { x: { feature: "x", floor: "" } }],
        ["autostart", "yes"],
    ["autostart", 1],
  ])("rejects invalid %s and resets the whole configuration", (key, value) => {
    const dir = mkTmpDir();
    write(dir, { [key]: value, thresholds: key === "thresholds" ? value : { idleMinutes: 5, stalledMinutes: 30, onsiteHours: 24 } });
    expect(loadSettings(dir)).toEqual({ settings: defaultSettings(), diagnostics: [`settings.json 的 ${key} 无效，已用默认配置`] });
  });

  it("WINDOW-30：顶层 style 缺省是 tower；三个值之一；写错时整套回默认并在诊断里说明", () => {
  expect(loadSettings(mkTmpDir()).settings.style).toBe("tower");
  for (const style of ["factory", "storefront"] as const) {
    const dir = mkTmpDir();
    write(dir, { style });
    expect(loadSettings(dir)).toEqual({ settings: { ...defaultSettings(), style }, diagnostics: [] });
  }
  for (const bad of ["shop", "", 1, null]) {
    const dir = mkTmpDir();
    write(dir, { style: bad });
    expect(loadSettings(dir)).toEqual({ settings: defaultSettings(), diagnostics: ["settings.json 的 style 无效，已用默认配置"] });
  }
});

it("WINDOW-30：features[].style 覆盖顶层；写错按 features 无效处理", () => {
  const features = [{ name: "x", placement: "band", materials: [{ material: "brick", share: 100 }], style: "factory" }];
  const dir = mkTmpDir();
  write(dir, { style: "storefront", features });
  const ok = loadSettings(dir);
  expect([ok.settings.style, ok.settings.features, ok.diagnostics]).toEqual(["storefront", features, []]);
  const bad = mkTmpDir();
  write(bad, { features: [{ ...features[0], style: "shop" }] });
  expect(loadSettings(bad)).toEqual({ settings: defaultSettings(), diagnostics: ["settings.json 的 features 无效，已用默认配置"] });
});

it("WINDOW-30：写回 settings.json 时顶层和 features[].style 都不丢", () => {
  const dir = mkTmpDir();
  const settings = { ...defaultSettings(), style: "factory" as const,
    features: [{ name: "x", placement: "band" as const, materials: [{ material: "brick" as const, share: 100 }], style: "storefront" as const }] };
  writeSettings(dir, settings);
  expect(loadSettings(dir)).toEqual({ settings, diagnostics: [] });
});

it("WINDOW-24：autostart 缺省是关；写成 true 就是开", () => {
    const off = mkTmpDir();
    expect(loadSettings(off).settings.autostart).toBe(false);
    const on = mkTmpDir();
    write(on, { autostart: true });
    const { settings, diagnostics } = loadSettings(on);
    expect([settings.autostart, diagnostics]).toEqual([true, []]);
  });

  it("WINDOW-26：theme 缺省是夜色，白昼要显式写；不是这两个名字就整套回默认", () => {
    const kind = mkTmpDir();
    expect(loadSettings(kind).settings.theme).toBe("night");
    const day = mkTmpDir();
    write(day, { theme: "day" });
    expect(loadSettings(day).settings).toMatchObject({ theme: "day" });
    expect(loadSettings(day).diagnostics).toEqual([]);
    for (const bad of ["dark", "", 1, null]) {
      const dir = mkTmpDir();
      write(dir, { theme: bad });
      expect(loadSettings(dir)).toEqual({
        settings: defaultSettings(), diagnostics: ["settings.json 的 theme 无效，已用默认配置"],
      });
    }
  });

  it("SITE-5：repos 和 features 都可以写成空数组，等于全靠自动发现", () => {
    const dir = mkTmpDir();
    write(dir, { repos: [], features: [] });
    const { settings, diagnostics } = loadSettings(dir);
    expect(diagnostics).toEqual([]);
    expect([settings.repos, settings.features]).toEqual([[], []]);
  });

  it("accepts valid office, material and pins", () => {
    const dir = mkTmpDir(), repo = mkTmpDir();
    const features = [{ name: "x", placement: "office", materials: [] }, { name: "y", placement: "band", materials: [{ material: "concrete", share: 100 }] }];
    const pins = { a: { feature: "x", floor: "S2" }, b: { feature: "y" } };
    write(dir, { features, pins, repos: [{ path: repo, name: "T" }] });
    const result = loadSettings(dir);
    expect(result.diagnostics).toEqual([]);
    expect([result.settings.features, result.settings.pins, result.settings.repos]).toEqual([features, pins, [{ path: realpathSync.native(repo), name: "T" }]]);
  });
});

describe("WINDOW-27：从设置面板写回", () => {
  it("写出来的文件能被读回去，键顺序固定、结尾有换行", () => {
    const dir = mkTmpDir();
    const settings = { ...defaultSettings(), theme: "day" as const, autostart: true,
      thresholds: { idleMinutes: 5, stalledMinutes: 40, onsiteHours: 12 } };
    writeSettings(dir, settings);
    const text = readFileSync(path.join(dir, "settings.json"), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["repos", "thresholds", "features", "style", "pins", "autostart", "theme", "language"]);
    expect(loadSettings(dir)).toEqual({ settings, diagnostics: [] });
  });
});

describe("WINDOW-27：面板与读文件用同一套阈值规则", () => {
  it("面板会接受的阈值，写进文件后下次一定读得回来", () => {
    for (const thresholds of [
      { idleMinutes: 0.5, stalledMinutes: 30, onsiteHours: 24 },
      { idleMinutes: 10, stalledMinutes: 10001, onsiteHours: 24 },
    ]) {
      const dir = mkTmpDir();
      writeSettings(dir, { ...defaultSettings(), thresholds });
      expect(loadSettings(dir).settings.thresholds).toEqual(thresholds);
    }
  });
  it("停工不大于空闲时读写都不接受，读文件时整套回默认并说明是哪一条", () => {
    const dir = mkTmpDir();
    writeSettings(dir, { ...defaultSettings(), thresholds: { idleMinutes: 30, stalledMinutes: 20, onsiteHours: 24 } });
    expect(loadSettings(dir)).toEqual({
      settings: defaultSettings(), diagnostics: ["settings.json 的 thresholds 无效，已用默认配置"],
    });
  });
});
