import { describe, expect, it } from "vitest";
import { attribute, inferRole, modelFamily, parseDispatch } from "../../src/core/attribution";
import { applyEvents, newSession } from "../../src/core/session";
import type { SiteEvent, ToolCall, ToolOp } from "../../src/core/types";

const FEATS = ["agent-dock", "settings", "desktop-shell", "data-layer"];
type CallSpec = Partial<ToolCall> & { tool: string; op: ToolOp };
const sess = (o: { prompt?: string; calls?: Array<[string, CallSpec]>; branch?: string; cwd?: string } = {}) => applyEvents(
  newSession({ key: "pi:x", harness: "pi", nativeId: "x", file: "f", cwd: o.cwd ?? "C:/test/repo", startedAt: 0, level: 1, branch: o.branch }),
  [...(o.prompt ? [{ kind: "prompt", ts: 0, text: o.prompt, from: "user" } as SiteEvent] : []),
    ...(o.calls ?? []).map(([id, c], i): SiteEvent => ({ kind: "tool_call", ts: i + 1, id, call: { paths: [], ...c } }))]);
const call = (op: ToolOp, paths: string[], command?: string): CallSpec => ({ tool: op, op, paths, command });

describe("attribution", () => {
  it("解析派工抬头，保留阶段和轮次，不映射楼层", () => {
    expect(parseDispatch("\uFEFF\n  \n# agent-dock Plan R1：写计划\n- 你是协调者", FEATS)).toEqual({ feature: "agent-dock", stage: "Plan", round: 1, line: "# agent-dock Plan R1：写计划" });
    const stages = ["Spec", "Clarify", "Plan", "Checklist", "Tasks", "Analyze", "Implement", "Converge", "Review", "Handoff"];
    expect(stages.map(stage => parseDispatch(`# settings ${stage}：x`, FEATS)?.stage)).toEqual(stages);
    expect(parseDispatch("# unknown-feat Plan R1：x", FEATS)).toBeNull();
    expect(parseDispatch("帮我看看 # agent-dock Plan", FEATS)).toBeNull();
    expect(parseDispatch("intro\n# settings Plan", FEATS)).toBeNull();
    expect(parseDispatch("# settings Planner", FEATS)).toBeNull();
  });
  it("钉住优先于派工抬头，未知钉住忽略；钉住的切片原样带出", () => {
    const s = sess({ prompt: "# agent-dock Review R2：审", branch: "feat/settings-x" });
    expect(attribute(s, FEATS, { feature: "data-layer", floor: "S2" })).toEqual({ rule: "pinned", feature: "data-layer", floor: "S2", detail: "手动钉住" });
    expect(attribute(s, FEATS, { feature: "settings" })).toMatchObject({ rule: "pinned", floor: null });
    expect(attribute(s, FEATS)).toEqual({ rule: "dispatch", feature: "agent-dock", floor: null, detail: "派工抬头：# agent-dock Review R2：审" });
    expect(attribute(s, FEATS, { feature: "gone-feature" }).rule).toBe("dispatch");
  });
  it("写入 3 分、读取 1 分，取得分最高的 feature；楼层不由文件决定", () => {
    const s = sess({ calls: [["a", call("read", ["specs/agent-dock/plan.md"])], ["b", call("read", ["specs/agent-dock/spec.md"])], ["c", call("edit", ["specs/settings/review.md"])], ["d", call("read", ["specs/settings/tasks.md"])]] });
    expect(attribute(s, FEATS)).toEqual({ rule: "specs", feature: "settings", floor: null, detail: "specs 文件：settings 写 1 次、读 1 次" });
  });
  it("规范化 Windows 与 shell 路径，同一调用去重", () => {
    expect(attribute(sess({ calls: [["a", call("edit", ["C:\\repo\\specs\\agent-dock\\plan.md", "specs/agent-dock/spec.md"], "cat specs/agent-dock/tasks.md")]] }), FEATS)).toMatchObject({ rule: "specs", feature: "agent-dock", floor: null, detail: "specs 文件：agent-dock 写 1 次、读 0 次" });
    expect(attribute(sess({ calls: [["a", call("shell", [], "cat specs/data-layer/tasks.md")]] }), FEATS)).toMatchObject({ feature: "data-layer", floor: null });
    expect(attribute(sess({ calls: [["a", call("read", ["specs/settings/unknown.txt"])], ["b", call("read", ["specs/data-layer/foo.txt"])]] }), FEATS)).toMatchObject({ feature: "data-layer", floor: null });
    expect(attribute(sess({ calls: [["a", call("read", ["not-specs/settings/spec.md", "specs/unknown/spec.md"])]] }), FEATS).rule).toBe("none");
  });
  it("文件类型不影响楼层：spec / plan / tasks / checklist / review 都是 null", () => {
    for (const file of ["spec.md", "plan.md", "tasks.md", "checklist.md", "review.md", "other.txt"])
      expect(attribute(sess({ calls: [["a", call("edit", [`specs/settings/${file}`])]] }), FEATS)).toMatchObject({ feature: "settings", floor: null });
  });
  it("后面改代码并跑测试也不改楼层", () => {
    const a: [string, CallSpec] = ["a", call("read", ["specs/settings/tasks.md"])];
    const b: [string, CallSpec] = ["b", call("edit", ["backend/settings/api.py"])];
    const c: [string, CallSpec] = ["c", call("shell", [], "python -m pytest backend/tests -q")];
    expect(attribute(sess({ calls: [a, b, c] }), FEATS)).toEqual({ rule: "specs", feature: "settings", floor: null, detail: "specs 文件：settings 写 0 次、读 1 次" });
  });
  it("权重：一次写高于两次读，低于四次读", () => {
    const write: [string, CallSpec] = ["w", call("edit", ["specs/settings/plan.md"])];
    const reads = Array.from({ length: 4 }, (_, i): [string, CallSpec] => [`r${i}`, call("read", ["specs/data-layer/spec.md"])]);
    expect(attribute(sess({ calls: [write, ...reads.slice(0, 2)] }), FEATS)).toMatchObject({ feature: "settings", floor: null });
    expect(attribute(sess({ calls: [write, ...reads] }), FEATS)).toMatchObject({ feature: "data-layer", floor: null });
  });
  it("最近的写入和读取只影响得分，不影响楼层", () => {
    expect(attribute(sess({ calls: [["a", call("write", ["specs/settings/spec.md"])], ["b", call("edit", ["specs/settings/review.md"])], ["c", call("read", ["specs/settings/tasks.md"])]] }), FEATS)).toMatchObject({ feature: "settings", floor: null });
  });
  it("最长 feature 名与证据优先级", () => {
    expect(attribute(sess({ branch: "review/DESKTOP-SHELL-r3" }), FEATS)).toMatchObject({ rule: "branch", feature: "desktop-shell", floor: null, detail: "分支 review/DESKTOP-SHELL-r3" });
    expect(attribute(sess({ cwd: "C:/T/example-data-layer-tree" }), FEATS)).toMatchObject({ rule: "branch", feature: "data-layer", detail: "目录 example-data-layer-tree" });
    expect(attribute(sess({ branch: "feat/foo", cwd: "C:/foo-bar" }), ["foo", "foo-bar"])).toMatchObject({ feature: "foo-bar", detail: "目录 foo-bar" });
    expect(attribute(sess({ branch: "settings", calls: [["a", call("read", ["specs/data-layer/spec.md"])]] }), FEATS)).toMatchObject({ rule: "specs" });
  });
  it("治理类严格过半", () => {
    const mix = (gov: number, other: number) => sess({ calls: [...Array.from({ length: gov }, (_, i): [string, CallSpec] => [`g${i}`, call("read", ["docs/plan.md"])]), ...Array.from({ length: other }, (_, i): [string, CallSpec] => [`o${i}`, call("read", ["src/x.ts"])])] });
    expect(attribute(mix(11, 9), FEATS)).toEqual({ rule: "governance", detail: "治理类：最近 20 次工具调用里 11 次涉及治理文件" });
    expect(attribute(mix(10, 10), FEATS)).toEqual({ rule: "none", detail: "没有归属证据" });
    expect(attribute(sess(), FEATS).rule).toBe("none");
    expect(attribute(sess({ calls: [["a", call("shell", [], "cat workflow\\state.json")]] }), FEATS).rule).toBe("governance");
  });
});

describe("role and model", () => {
  it("prioritizes dispatch over model over level", () => {
    expect(inferRole("# x Review\n- 你是审核员 A：claude-fable-5-1", "gpt-6-astra", 2)).toEqual({ role: "inspector", reason: "dispatch" });
    expect(inferRole("- 你是实施者：…", undefined, 1)).toEqual({ role: "worker", reason: "dispatch" });
    expect(inferRole("- 你是协调者", undefined, 2)).toEqual({ role: "foreman", reason: "dispatch" });
    expect(inferRole(undefined, "claude-fable-5-1", 1)).toEqual({ role: "inspector", reason: "model" });
    expect([inferRole(undefined, "gpt-6-astra", 1).role, inferRole(undefined, "deepseek-flash", 1).role]).toEqual(["worker", "worker"]);
    expect(inferRole(undefined, "claude-opus-5-5", 2).role).toBe("foreman");
    expect(inferRole(undefined, "claude-sonnet-5-5", 2)).toEqual({ role: "worker", reason: "level" });
    expect(inferRole(undefined, undefined, 1)).toEqual({ role: "foreman", reason: "level" });
  });
  it("classifies model family case-insensitively", () => {
    expect(["Claude-opus-5-5", "gpt-6.1-sol", "deepseek-flash", undefined].map(modelFamily)).toEqual(["claude", "gpt", "deepseek", "other"]);
  });
});
