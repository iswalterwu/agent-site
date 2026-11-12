import { t, type Locale, type MessageKey } from "../core/i18n";

/** 主进程和渲染进程各自持有展示语言；核心计算仍显式接收 locale。 */
let current: Locale = "zh-CN";
export const uiLocale = (): Locale => current;
export function setUiLocale(locale: Locale): void { current = locale; }
export const ui = (key: MessageKey, values?: Record<string, string | number>): string => t(current, key, values);
