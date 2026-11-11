import { expect, it } from "vitest";
import { deriveActions } from "../../src/core/actions";
import { applyEvents, newSession } from "../../src/core/session";
import { DEFAULT_THRESHOLDS, sessionStatus } from "../../src/core/status";
import type { SessionMeta, SiteEvent } from "../../src/core/types";
import { min } from "../fixtures/logs";

const m = (level: number): SessionMeta => ({ key: "pi:s", harness: "pi", nativeId: "s", file: "f", cwd: "D:/r", startedAt: min(0), level });
const status = (level: number, evs: SiteEvent[], now: number) => {
  const s = applyEvents(newSession(m(level)), evs);
  return sessionStatus(s, deriveActions(s).at(-1) ?? null, now, DEFAULT_THRESHOLDS);
};
const ended: SiteEvent[] = [{ kind: "prompt", ts: min(0), text: "做吧", from: "user" },
  { kind: "text", ts: min(5), text: "已完成。要我继续吗？" }, { kind: "turn_end", ts: min(5) }];

it("一级会话回合结束：可能在等你，气泡是最后一句，详情是全文", () => {
  expect(status(1, ended, min(8))).toEqual({ status: "waiting", since: min(5), text: "可能：要我继续吗？",
    detail: "已完成。要我继续吗？", onSite: true });
});
it("之后又有用户消息就不算等；二级会话回合结束不算等（P3）", () => {
  expect(status(1, [...ended, { kind: "prompt", ts: min(6), text: "继续", from: "user" }], min(7)).status).toBe("working");
  expect(status(2, ended, min(8)).status).toBe("working");
  expect(status(2, ended, min(16)).status).toBe("idle");
});
it("提问工具还没有结果：等你，不限层级（P4）", () => {
  const ask: SiteEvent = { kind: "tool_call", ts: min(3), id: "q", call: { tool: "AskUserQuestion", op: "ask", paths: [], title: "用方案 A 吗？" } };
  expect(status(2, [ask], min(40))).toMatchObject({ status: "waiting", since: min(3), text: "可能：用方案 A 吗？" });
});
it("最后一个调用没有结果：30 分钟后算中途断掉，之前只是空闲或在干", () => {
  const hang: SiteEvent = { kind: "tool_call", ts: min(0), id: "b", call: { tool: "bash", op: "shell", paths: [], command: "npm install" } };
  expect(status(1, [hang], min(31))).toMatchObject({ status: "stalled", since: min(0), text: "停在：npm install" });
  expect(status(1, [hang], min(29)).status).toBe("idle");
  expect(status(1, [hang], min(9)).status).toBe("working");
});
it("超过上工地时限就不在工地上", () => {
  expect(status(2, ended, min(5) + 25 * 3_600_000).onSite).toBe(false);
});

// ---- 以下是 brief 之外补的用例 ----

const HOUR = 3_600_000;
const hang: SiteEvent = { kind: "tool_call", ts: min(0), id: "b", call: { tool: "bash", op: "shell", paths: [], command: "npm install" } };

it("气泡整句过 bubble（E5）：最后一句很长时，连同前缀截成 40 字，以 … 结尾", () => {
  const long = "长".repeat(60);
  const v = status(1, [{ kind: "text", ts: min(1), text: long }, { kind: "turn_end", ts: min(1) }], min(2));
  expect(v.text).toBe(`可能：${"长".repeat(36)}…`);
  expect(v.text).toHaveLength(40);
  expect(v.detail).toBe(long);
});
it("停在：前缀加上很长的动作文字，也截成 40 字（E5）", () => {
  const command = "npm install lodash express react vue typescript eslint prettier";
  const v = status(1, [{ kind: "tool_call", ts: min(0), id: "b", call: { tool: "bash", op: "shell", paths: [], command } }], min(31));
  expect(v).toMatchObject({ status: "stalled", text: `停在：${command.slice(0, 36)}…` });
  expect(v.text).toHaveLength(40);
});
it("没有任何动作时，空闲和在干的气泡都是空串（E5）", () => {
  const promptOnly: SiteEvent[] = [{ kind: "prompt", ts: min(0), text: "做吧", from: "user" }];
  expect(status(1, promptOnly, min(12))).toEqual({ status: "idle", since: min(0), text: "", detail: null, onSite: true });
  expect(status(1, promptOnly, min(2))).toEqual({ status: "working", since: min(0), text: "", detail: null, onSite: true });
  expect(status(1, [], min(12))).toEqual({ status: "idle", since: min(0), text: "", detail: null, onSite: true });
});
it("详情先脱敏再截到 200 字（E1）：截断处落在密钥中间也遮得住", () => {
  const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5";
  const text = `${"甲".repeat(190)}${token}${"乙".repeat(50)}`;
  const v = status(1, [{ kind: "text", ts: min(1), text }, { kind: "turn_end", ts: min(1) }], min(2));
  expect(v.detail).toBe(`${"甲".repeat(190)}ghp_***${"乙".repeat(2)}…`);
  expect(v.detail).toHaveLength(200);
  expect(v.detail).not.toContain("A1b2C");
});
it("提问的标题也先脱敏再截断：气泡 ≤ 40 字，详情 ≤ 200 字", () => {
  const title = `用这个密钥 sk-abcdefghijklmnop 吗？${"丙".repeat(250)}`;
  const ask: SiteEvent = { kind: "tool_call", ts: min(3), id: "q", call: { tool: "AskUserQuestion", op: "ask", paths: [], title } };
  const v = status(1, [ask], min(4));
  expect(v.text).toBe(`可能：${`用这个密钥 sk-*** 吗？${"丙".repeat(250)}`.slice(0, 36)}…`);
  expect(v.detail).toBe(`${`用这个密钥 sk-*** 吗？${"丙".repeat(250)}`.slice(0, 199)}…`);
});
it("提问没有标题：气泡用工具名，详情为 null", () => {
  const ask: SiteEvent = { kind: "tool_call", ts: min(3), id: "q", call: { tool: "AskUserQuestion", op: "ask", paths: [] } };
  expect(status(2, [ask], min(4))).toEqual({ status: "waiting", since: min(3), text: "可能：AskUserQuestion", detail: null, onSite: true });
});
it("一级会话回合结束但没有 text 事件：可能：回合结束，详情为 null（P3）", () => {
  const evs: SiteEvent[] = [{ kind: "prompt", ts: min(0), text: "做吧", from: "user" }, { kind: "turn_end", ts: min(2) }];
  expect(status(1, evs, min(3))).toEqual({ status: "waiting", since: min(2), text: "可能：回合结束", detail: null, onSite: true });
});
it("等你只取最新 prompt 到 turn_end 之间的文字，不借用旧轮或结束后的文字（E22）", () => {
  const prompt: SiteEvent = { kind: "prompt", ts: min(6), text: "再做一步", from: "user" };
  const end: SiteEvent = { kind: "turn_end", ts: min(8) };
  expect(status(1, [...ended, prompt, end], min(10))).toEqual({
    status: "waiting", since: min(8), text: "可能：回合结束", detail: null, onSite: true,
  });
  expect(status(1, [...ended, prompt, { kind: "text", ts: min(7), text: "新的问题？" }, end,
    { kind: "text", ts: min(9), text: "结束后的文字。" }], min(10))).toEqual({
    status: "waiting", since: min(8), text: "可能：新的问题？", detail: "新的问题？", onSite: true,
  });
});
it("最新文字只有标点或空白时不回退到更早的句子，改用回合结束（E22）", () => {
  for (const text of ["！？；!?", " \t\n "]) {
    expect(status(1, [ended[0], ended[1], { kind: "text", ts: min(6), text },
      { kind: "turn_end", ts: min(7) }], min(8))).toEqual({
      status: "waiting", since: min(7), text: "可能：回合结束", detail: null, onSite: true,
    });
  }
});
it("提问标题为空串或只有空白时用工具名，详情为 null（E22）", () => {
  for (const title of ["", " \t\n "]) {
    const ask: SiteEvent = { kind: "tool_call", ts: min(3), id: "q", call: { tool: "AskUserQuestion", op: "ask", paths: [], title } };
    expect(status(2, [ask], min(40))).toEqual({
      status: "waiting", since: min(3), text: "可能：AskUserQuestion", detail: null, onSite: true,
    });
  }
});
it("同一回复的几个 turn_end 同时间戳：照样等你，since 是那个时间", () => {
  expect(status(1, [...ended, { kind: "turn_end", ts: min(5) }], min(8))).toMatchObject({ status: "waiting", since: min(5) });
});
it("回合结束之后又有工具调用就不算等", () => {
  expect(status(1, [...ended, { kind: "tool_call", ts: min(6), id: "r", call: { tool: "read", op: "read", paths: ["a.ts"] } }], min(7)).status)
    .toBe("working");
});
it("一级会话最后一次调用是已有结果的提问：不再等你", () => {
  const evs: SiteEvent[] = [{ kind: "prompt", ts: min(0), text: "做吧", from: "user" },
    { kind: "tool_call", ts: min(1), id: "q", call: { tool: "AskUserQuestion", op: "ask", paths: [], title: "用方案 A 吗？" } },
    { kind: "tool_result", ts: min(2), id: "q", ok: true }];
  expect(status(1, evs, min(3))).toEqual({ status: "working", since: min(2), text: "用方案 A 吗？", detail: null, onSite: true });
  expect(status(1, evs, min(40)).status).toBe("idle");
});
it("阈值的边界：恰好 30 分钟算中途断掉，恰好 10 分钟算空闲，恰好 24 小时不在工地上", () => {
  expect(status(1, [hang], min(30)).status).toBe("stalled");
  expect(status(1, [hang], min(30) - 1).status).toBe("idle");
  expect(status(1, [hang], min(10)).status).toBe("idle");
  expect(status(1, [hang], min(10) - 1).status).toBe("working");
  expect(status(2, ended, min(15)).status).toBe("idle");
  expect(status(2, ended, min(15) - 1).status).toBe("working");
  expect(status(2, ended, min(5) + 24 * HOUR).onSite).toBe(false);
  expect(status(2, ended, min(5) + 24 * HOUR - 1).onSite).toBe(true);
});
it("在不在工地上独立计算：一级会话等你超过 24 小时，仍是等你，只是不在工地上", () => {
  expect(status(1, ended, min(5) + 25 * HOUR)).toMatchObject({ status: "waiting", since: min(5), onSite: false });
});
it("阈值按传入的值算", () => {
  const s = applyEvents(newSession(m(1)), [hang]);
  const t = { idleMinutes: 1, stalledMinutes: 2, onsiteHours: 1 };
  expect(sessionStatus(s, null, min(1), t).status).toBe("idle");
  expect(sessionStatus(s, null, min(2), t)).toMatchObject({ status: "stalled", text: "停在：" });
  expect(sessionStatus(s, null, min(60), t).onSite).toBe(false);
});
