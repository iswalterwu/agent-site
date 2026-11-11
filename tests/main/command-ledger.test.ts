import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { appendCommand } from "../../src/main/command-ledger";
import { mkTmpDir } from "../harness/wait";

it("指令台账追加 JSONL，正文和错误先脱敏", () => {
  const file = path.join(mkTmpDir(), "app", "commands.jsonl");
  const secret = "sk-abcdefgh12345678";
  appendCommand(file, { at: "2026-01-01T00:00:00.000Z", session: "pi:s1", type: "suggest",
    text: `看这个 ${secret}`, mode: "followUp", ok: false, error: `拒绝 ${secret}` });
  appendCommand(file, { at: "2026-01-01T00:00:01.000Z", session: "pi:s1", type: "pause", ok: true });
  const lines = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ session: "pi:s1", type: "suggest", mode: "followUp", ok: false });
  expect(lines[1]).toMatchObject({ type: "pause", ok: true });
  expect(JSON.stringify(lines)).not.toContain("abcdefgh12345678");
});
