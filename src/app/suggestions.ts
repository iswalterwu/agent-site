// 建议草稿按会话 key 隔离；清空时只清刚发出的那一版，避免旧回执吃掉后来输入。
export type SuggestionMode = "steer" | "followUp";
export interface SuggestionDrafts {
  text: Record<string, string>;
  mode: Record<string, SuggestionMode>;
}

export const emptyDrafts = (): SuggestionDrafts => ({ text: {}, mode: {} });
export const textFor = (drafts: SuggestionDrafts, key: string): string => drafts.text[key] ?? "";
export const modeFor = (drafts: SuggestionDrafts, key: string): SuggestionMode => drafts.mode[key] ?? "steer";

export function setText(drafts: SuggestionDrafts, key: string, text: string): SuggestionDrafts {
  return { ...drafts, text: { ...drafts.text, [key]: text } };
}

export function setMode(drafts: SuggestionDrafts, key: string, mode: SuggestionMode): SuggestionDrafts {
  return { ...drafts, mode: { ...drafts.mode, [key]: mode } };
}

/** 只清掉和 submitted 完全相同的草稿；用户已经改了内容就保留 */
export function clearSent(drafts: SuggestionDrafts, key: string, submitted: string): SuggestionDrafts {
  if (textFor(drafts, key).trim() !== submitted) return drafts;
  const text = { ...drafts.text };
  delete text[key];
  return { ...drafts, text };
}
