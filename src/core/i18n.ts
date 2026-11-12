import { CORE_MESSAGES } from "./locales/core";
import { APP_MESSAGES } from "./locales/interface";
import { MAIN_MESSAGES } from "./locales/service";

export type Locale = "zh-CN" | "en";
export type LanguageSetting = "system" | Locale;

/** 系统语言由入口注入；核心格式化不读取系统、文件或可变的全局语言。 */
export function resolveLocale(language: LanguageSetting, systemLocale: string): Locale {
  return language === "system" ? systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en" : language;
}

export const MESSAGES = { ...CORE_MESSAGES, ...APP_MESSAGES, ...MAIN_MESSAGES } as const;
export type MessageKey = keyof typeof MESSAGES;

/** 本地程序错误带词条标识，UI 换语言时可重新取词；外部错误不附加标识。 */
export function localizedError(locale: Locale, key: MessageKey): { error: string; messageKey: MessageKey } {
  return { error: t(locale, key), messageKey: key };
}
export type MessageValue = string | { readonly zh: string; readonly en: string; readonly enOne?: string };

/** 只接收程序词条键；参数为原始内容，不再扫描或替换其中的文字。 */
export function t(locale: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  const entry: MessageValue = MESSAGES[key];
  const template = typeof entry === "string" ? locale === "en" ? entry : key
    : locale === "en" ? values.count === 1 ? entry.enOne ?? entry.en : entry.en : entry.zh;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name]));
}
