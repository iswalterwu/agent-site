import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bridgeFilePath } from "../bridge/link";
import { DEFAULT_THRESHOLDS } from "../core/status";
import { resolveLocale, t, type LanguageSetting, type Locale } from "../core/i18n";
import type { FeatureConfig, Pin, SiteConfig, Thresholds } from "../core/types";
import { isNonEmpty, isNum, isObj, isStr, oneOf, parseJsonObject } from "../protocol/guards";

export interface RepoEntry { path: string; name: string }
export type ThemeSetting = "night" | "day";
export interface Settings extends SiteConfig { repos: RepoEntry[]; autostart: boolean; theme: ThemeSetting; language: LanguageSetting }

/** 默认不预设任何工地和功能名：工地从会话里自动发现，顺序和材质按 specs 里实际有的来 */
export const DEFAULT_FEATURES: FeatureConfig[] = [];

export function appDataDir(env: Record<string, string | undefined>): string {
  return path.dirname(bridgeFilePath(env));
}
export function defaultSettings(): Settings {
  return {
    repos: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    features: DEFAULT_FEATURES.map(f => ({ ...f, materials: f.materials.map(m => ({ ...m })) })),
    style: "tower",
    pins: {},
    autostart: false,
    theme: "night",
    language: "system",
  };
}

export function loadSettings(dir: string, systemLocale = "zh-CN"): { settings: Settings; diagnostics: string[] } {
  const defaults = defaultSettings();
  const fallbackLocale = resolveLocale(defaults.language, systemLocale);
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, "settings.json"), "utf8");
  } catch (error) {
    return { settings: defaults, diagnostics: (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [t(fallbackLocale, "settings.json 读不出，已用默认配置")] };
  }
  const input = parseJsonObject(raw);
  if (input === null) return { settings: defaults, diagnostics: [t(fallbackLocale, "settings.json 读不出，已用默认配置")] };
  const validators = { repos: isRepos, thresholds: isThresholds, features: isFeatures, pins: isPins, autostart: isBool, theme: isTheme, style: isStyle, language: isLanguage };
  for (const key of Object.keys(validators) as (keyof typeof validators)[]) {
    if (Object.hasOwn(input, key) && !validators[key](input[key])) {
      return { settings: defaults, diagnostics: [t(fallbackLocale, "settings.json 的 {key} 无效，已用默认配置", { key })] };
    }
  }
  const repos = isRepos(input.repos) ? input.repos.map(repo => ({ ...repo, path: canonicalRepo(repo.path) })) : defaults.repos;
  const settings: Settings = {
    repos,
    thresholds: isThresholds(input.thresholds) ? input.thresholds : defaults.thresholds,
    features: isFeatures(input.features) ? input.features : defaults.features,
    style: isStyle(input.style) ? input.style : defaults.style,
    pins: isPins(input.pins) ? input.pins : defaults.pins,
    autostart: isBool(input.autostart) ? input.autostart : defaults.autostart,
    theme: isTheme(input.theme) ? input.theme : defaults.theme,
    language: isLanguage(input.language) ? input.language : defaults.language,
  };
  const diagnostics = Object.hasOwn(input, "extraPathRules")
    ? [t(resolveLocale(settings.language, systemLocale), "settings.json 里的 extraPathRules 已不再使用：工地按会话的工作目录自动认定")] : [];
  return { settings, diagnostics };
}

/** 写回 settings.json：键顺序固定、缩进两格、结尾换行，和手写的文件长得一样 */
export function writeSettings(dir: string, settings: Settings): void {
  const ordered = {
    repos: settings.repos,
    thresholds: settings.thresholds,
    features: settings.features,
    style: settings.style,
    pins: settings.pins,
    autostart: settings.autostart,
    theme: settings.theme,
    language: settings.language,
  };
  writeFileSync(path.join(dir, "settings.json"), `${JSON.stringify(ordered, null, 2)}
`, "utf8");
}

const absolute = (v: unknown): v is string => isStr(v) && path.isAbsolute(v);
const positive = (v: unknown): v is number => isNum(v) && Number.isFinite(v) && v > 0;
const placement = oneOf(["band", "crown", "office"] as const);
const material = oneOf(["brick", "glass", "metal", "concrete"] as const);
const isStyle = oneOf(["tower", "factory", "storefront"] as const);
const isRepos = (v: unknown): v is RepoEntry[] => Array.isArray(v) && v.every(r => isObj(r) && absolute(r.path) && isStr(r.name));
/** 停工的判据是"静得比空闲更久"，所以两条阈值的大小关系属于配置本身；读写共用这一条，别各判各的 */
export function thresholdsProblem(value: Record<string, unknown>, locale: Locale = "zh-CN"): string | null {
  if (!positive(value.idleMinutes)) return t(locale, "空闲分钟要是大于 0 的数字");
  if (!positive(value.stalledMinutes)) return t(locale, "停工分钟要是大于 0 的数字");
  if (!positive(value.onsiteHours)) return t(locale, "在工地小时要是大于 0 的数字");
  if (value.stalledMinutes <= value.idleMinutes) return t(locale, "停工分钟要大于空闲分钟");
  return null;
}

const isThresholds = (v: unknown): v is Thresholds => isObj(v) && thresholdsProblem(v) === null;
const isFeatures = (v: unknown): v is FeatureConfig[] => Array.isArray(v) && v.every(f => {
  if (!isObj(f) || !isStr(f.name) || !placement(f.placement) || !Array.isArray(f.materials)) return false;
  if (Object.hasOwn(f, "style") && !isStyle(f.style)) return false;
  if (!f.materials.every((m: unknown) => isObj(m) && material(m.material) && positive(m.share))) return false;
  return f.materials.length === 0 ? f.placement === "office" : f.materials.reduce((sum: number, m: { share: number }) => sum + m.share, 0) === 100;
});
const isPins = (v: unknown): v is Record<string, Pin> => isObj(v) && Object.values(v).every(p => isObj(p) && isStr(p.feature) && (!Object.hasOwn(p, "floor") || isNonEmpty(p.floor)));
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isTheme = oneOf(["night", "day"] as const);
const isLanguage = oneOf(["system", "zh-CN", "en"] as const);
function canonicalRepo(repo: string): string {
  try { return realpathSync.native(repo); } catch { return path.resolve(repo); }
}
