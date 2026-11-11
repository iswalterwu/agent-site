import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "../../src/app/fixture";
import { applyBridgeControl } from "../../src/app/bridge-overlay";
import { withSite } from "../harness/site";
import type { BridgeSessionView } from "../../src/main/bridge-service";

const session = (patch: Partial<BridgeSessionView> = {}): BridgeSessionView => ({
  key: "pi:s1", sessionId: "s1", online: true, paused: false, holding: null, idle: false, controllable: true,
  info: { id: "s1", cwd: "D:/r", level: 1, startedAt: "2026-01-01T00:00:00.000Z", mode: "tui" }, ...patch,
});

describe("桥接在线投影", () => {
  it("在线 pi 一级 / 二级改成可控制，带暂停 / 挂起状态", () => {
    const snap = fixtureSnapshot(0);
    const visible = applyBridgeControl(snap, [session({ paused: true, holding: { tool: "bash", sinceMs: 3 } })]);
    expect(visible.sites[0].workers.find(item => item.key === "pi:s1")).toMatchObject({
      readOnly: false, control: { online: true, paused: true, holding: { tool: "bash", sinceMs: 3 } },
    });
    expect(snap.sites[0].workers.find(item => item.key === "pi:s1")!.readOnly).toBe(true);
  });

  it("桥接键和日志键对不上时，用会话文件认出同一个会话", () => {
    const snap = fixtureSnapshot(0);
    const worker = snap.sites[0].workers.find(item => item.key === "pi:s1")!;
    // 键不同（前缀、大小写、文件头 id 的差异都可能），但桥接报的会话文件与日志的是同一个
    const mismatched = session({ key: "pi:not-the-log-key", sessionId: "not-the-log-key",
      info: { ...session().info, id: "not-the-log-key", file: worker.file } });
    const visible = applyBridgeControl(snap, [mismatched]);
    expect(visible.sites[0].workers.find(item => item.key === "pi:s1")).toMatchObject({ readOnly: false,
      control: { online: true, paused: false } });
  });

  it("会话文件对上了，但会话不可控制（三级）时仍保持只读", () => {
    const snap = fixtureSnapshot(0);
    const worker = snap.sites[0].workers.find(item => item.key === "pi:s1")!;
    const level3 = session({ key: "pi:s1", controllable: false, info: { ...session().info, level: 3, file: worker.file } });
    expect(applyBridgeControl(snap, [level3]).sites[0].workers.find(item => item.key === "pi:s1")!.readOnly).toBe(true);
  });

  it("三级、离线和非 pi 会话保持只读", () => {
    const snap = fixtureSnapshot(0);
    const level3 = applyBridgeControl(snap, [session({ controllable: false, info: { ...session().info, level: 3 } })]);
    expect(level3.sites[0].workers.find(item => item.key === "pi:s1")!.readOnly).toBe(true);
    const offline = applyBridgeControl(snap, [session({ online: false })]);
    expect(offline.sites[0].workers.find(item => item.key === "pi:s1")!.readOnly).toBe(true);
    const claude = applyBridgeControl(snap, [session({ key: "claude:s3", sessionId: "s3" })]);
    expect(claude.sites[0].workers.find(item => item.key === "claude:s3")!.readOnly).toBe(true);
  });

  it("断开后不再保留 control", () => {
    const snap = fixtureSnapshot(0);
    const visible = applyBridgeControl(snap, [session()]);
    expect(visible.sites[0].workers.find(item => item.key === "pi:s1")!.readOnly).toBe(false);
    const dropped = applyBridgeControl(snap, []);
    expect(dropped.sites[0].workers.find(item => item.key === "pi:s1")!.readOnly).toBe(true);
    expect(dropped.sites[0].workers.find(item => item.key === "pi:s1")!.control).toBeUndefined();
  });
});
