import path from "node:path";
import { t, type LanguageSetting, type Locale } from "../core/i18n";
import type { BuildingStyle } from "../core/types";
import { thresholdsProblem, type Settings, type ThemeSetting } from "../main/settings";

/** 窗内设置面板里能改的键；工地的路径是文件原文，配置界面不脱敏（见 AGENTS.md） */
export interface SettingsDraft {
  language: LanguageSetting;
  theme: ThemeSetting;
  /** 楼段的默认造型；`features[].style` 仍改文件 */
  style: BuildingStyle;
  autostart: boolean;
  idleMinutes: number;
  stalledMinutes: number;
  onsiteHours: number;
  /** 一行一个工地：`路径`，要改显示名就写 `路径 = "名字"`（名字按 JSON 字符串写） */
  repos: string;
}

export function draftOf(settings: Settings): SettingsDraft {
  return {
    language: settings.language,
    theme: settings.theme,
    style: settings.style,
    autostart: settings.autostart,
    idleMinutes: settings.thresholds.idleMinutes,
    stalledMinutes: settings.thresholds.stalledMinutes,
    onsiteHours: settings.thresholds.onsiteHours,
    // 路径本身以 ` = "..."` 结尾时，省掉名字会让下次读回来时被切开：这种一律写显式的名字
    repos: settings.repos.map(repo => repo.name === path.basename(repo.path) && parseRepo(repo.path).name === null
      ? repo.path
      : `${repo.path} = ${JSON.stringify(repo.name)}`).join("\n"),
  };
}

export type SettingsPatch = Pick<Settings, "repos" | "thresholds" | "autostart" | "theme" | "style" | "language">;

/** 一行里"路径 = 名字"的写法：只有以 JSON 字符串结尾才算写了名字，路径里出现 ` = ` 也不会切错 */
function parseRepo(line: string): { path: string; name: string | null } {
  if (!line.endsWith('"')) return { path: line, name: null };
  const split = line.lastIndexOf(' = "');
  if (split < 0) return { path: line, name: null };
  try {
    const name: unknown = JSON.parse(line.slice(split + 3));
    const repoPath = line.slice(0, split);
    return typeof name === "string" && repoPath.trim() !== "" ? { path: repoPath, name } : { path: line, name: null };
  } catch {
    return { path: line, name: null };
  }
}

/**
 * 把表单折回设置对象。错在哪一条就说哪一条，别默默存成默认值——
 * 这个面板存在的意义就是让人知道自己改了什么。
 */
export function fromDraft(draft: SettingsDraft, locale: Locale = "zh-CN"): { settings: SettingsPatch } | { errors: string[] } {
  // 阈值用读文件时同一套判断：面板能存的，下次启动一定读得回来（反过来也一样）
  const thresholds = { idleMinutes: draft.idleMinutes, stalledMinutes: draft.stalledMinutes, onsiteHours: draft.onsiteHours };
  const errors: string[] = [
    thresholdsProblem(thresholds, locale),
    draft.theme === "night" || draft.theme === "day" ? null : t(locale, "配色只能是夜色或白昼"),
    draft.style === "tower" || draft.style === "factory" || draft.style === "storefront" ? null : t(locale, "默认造型只能是塔楼、厂房或临街店"),
    draft.language === "system" || draft.language === "zh-CN" || draft.language === "en" ? null : t(locale, "语言只能是跟随系统、简体中文或英文"),
  ].filter((error): error is string => error !== null);
  const repos: { path: string; name: string }[] = [];
  for (const raw of draft.repos.split("\n")) {
    // 只拿空白判断是不是空行：路径末尾的字符（含不间断空格）是数据的一部分，不能去掉
    if (raw.trim() === "") continue;
    const parsed = parseRepo(raw);
    if (!path.isAbsolute(parsed.path)) { errors.push(t(locale, "工地要写绝对路径：{path}", { path: parsed.path })); continue; }
    repos.push({ path: parsed.path, name: parsed.name ?? path.basename(parsed.path) });
  }
  if (errors.length > 0) return { errors };
  return {
    settings: { repos, thresholds, autostart: draft.autostart, theme: draft.theme, style: draft.style, language: draft.language },
  };
}

/** 只改语言、主题或自启不必重读日志，避免丢失已缓存的会话中段。 */
export function engineSettingsChanged(before: Settings, after: Settings): boolean {
  const content = (settings: Settings) => JSON.stringify([settings.repos, settings.thresholds, settings.features, settings.pins, settings.style]);
  return content(before) !== content(after);
}

/** 存进 settings.json 的形状：只写面板管得到的键，其余键原样保留 */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return { ...current, ...patch };
}

/** IPC 边界上校验一遍：面板发来的东西只在这一层当作外部数据 */
export function parseDraft(value: unknown): SettingsDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (v.language !== "system" && v.language !== "zh-CN" && v.language !== "en") return null;
  if (v.theme !== "night" && v.theme !== "day") return null;
  if (v.style !== "tower" && v.style !== "factory" && v.style !== "storefront") return null;
  if (typeof v.autostart !== "boolean") return null;
  if (!finite(v.idleMinutes) || !finite(v.stalledMinutes) || !finite(v.onsiteHours)) return null;
  if (typeof v.repos !== "string") return null;
  return {
    language: v.language, theme: v.theme, style: v.style, autostart: v.autostart,
    idleMinutes: v.idleMinutes, stalledMinutes: v.stalledMinutes, onsiteHours: v.onsiteHours,
    repos: v.repos,
  };
}
