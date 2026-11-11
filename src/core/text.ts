// 气泡文字：动作和状态的短文字都从这里出。先脱敏再截断（E1），截断处落在密钥中间也遮得住。

import { truncate } from "../protocol/v2";
import { redact } from "./redact";

export const BUBBLE_MAX = 40;
/** 状态详情最多保留的句子数和字数；比气泡长，但一眼能看完 */
export const BRIEF_SENTENCES = 5;
export const BRIEF_MAX = 420;

/** 句子：到句末标点或换行为止，句末标点留在句子里；不按 "." 切，免得切开文件名 */
const SENTENCE_RE = /[^。！？；!?\n]+[。！？；!?]?/g;

/** 连续空白压成一个空格、去首尾空白，脱敏后截到 BUBBLE_MAX */
export function bubble(text: string): string {
  return truncate(redact(text.replace(/\s+/g, " ").trim()), BUBBLE_MAX);
}

/** 第一句，经 bubble；没有句子给 "" */
export const firstSentence = (text: string): string => bubble(sentences(text)[0] ?? "");

/** 最后一句，经 bubble；没有句子给 "" */
export const lastSentence = (text: string): string => bubble(sentences(text).at(-1) ?? "");

/** 详情文字：压缩空白、取最后几句、脱敏后截到 BRIEF_MAX；没有句末标点就整段留一句 */
export function brief(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  // 中文句号本来就能切；英文句号只有后面接空白 + 大写 / 引号 / 括号时才当句尾，避免切开 api.ts、v1.2 这类文件名
  const segmented = clean.replace(/([.!?])\s+(?=[A-Z"'“'（(])/g, "$1\n");
  const joined = sentences(segmented).slice(-BRIEF_SENTENCES).join(" ").replace(/([。！？；，、])\s+/g, "$1");
  return truncate(redact(joined === "" ? clean : joined), BRIEF_MAX);
}

/** 正反斜杠都算分隔符，取最后一段；结尾的分隔符不算一段（build/ → build） */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter((seg) => seg !== "").at(-1) ?? "";
}

/** 不含字母和数字的片段（空白、"……"、"```" 这类只有标点的段落）不算句子 */
function sentences(text: string): string[] {
  return (text.match(SENTENCE_RE) ?? []).filter((s) => /[\p{L}\p{N}]/u.test(s));
}
