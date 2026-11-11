// 指令台账：App 发出的每条控制都追加一行 JSON，含时间、会话、类型、建议正文 / 模式、回执和错误。
// 只写 App 数据目录；正文和错误先脱敏，避免把用户贴进来的凭证原样留在台账里。
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redact } from "../core/redact";

export type LedgerCommand = "pause" | "resume" | "abort" | "suggest";
export interface CommandRecord {
  at: string;
  session: string;
  type: LedgerCommand;
  text?: string;
  mode?: "steer" | "followUp";
  ok: boolean;
  error?: string;
}

export function appendCommand(file: string, record: CommandRecord): void {
  const safe: CommandRecord = {
    ...record,
    ...(record.text === undefined ? {} : { text: redact(record.text) }),
    ...(record.error === undefined ? {} : { error: redact(record.error) }),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(safe)}\n`, "utf8");
}
