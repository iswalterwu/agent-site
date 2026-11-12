import path from "node:path";
import fs from "node:fs";
import { mkTmpDir } from "../harness/wait";
import { describe, expect, it } from "vitest";
import { readInstanceLaunch, resolveDshLaunch, sameDshRoot, sessionRoots } from "../../src/main/roots";
import { launchArgs } from "../../src/protocol/launch";

const home = path.resolve("D:/fixture/home");
const custom = path.resolve("D:/fixture/DSH data");
const other = path.resolve("D:/fixture/other");

describe("DIST-7：启动会话根只在入口解析", () => {
  it("显式参数、环境、默认依次取值；空白环境不落到cwd", () => {
    expect(resolveDshLaunch([], {}, home)).toEqual({ ok: true, launch: { dshHome: path.join(home, ".dsh"), explicit: false } });
    expect(resolveDshLaunch([], { DSH_HOME: "  " }, home)).toEqual(resolveDshLaunch([], {}, home));
    expect(resolveDshLaunch([], { DSH_HOME: custom }, home)).toEqual({ ok: true, launch: { dshHome: custom, explicit: true } });
    expect(resolveDshLaunch(["--dsh-home", other], { DSH_HOME: custom }, home)).toEqual({ ok: true, launch: { dshHome: other, explicit: true } });
    expect(resolveDshLaunch([`--dsh-home=${custom}`], {}, home)).toEqual({ ok: true, launch: { dshHome: custom, explicit: true } });
  });
  it("展开当前用户波浪号，不改变pi和Claude根；不要求目录已经存在", () => {
    expect(resolveDshLaunch(["--dsh-home", "~/isolated"], {}, home)).toEqual({ ok: true, launch: { dshHome: path.join(home, "isolated"), explicit: true } });
    expect(sessionRoots(home, custom)).toEqual({ pi: path.join(home, ".pi", "agent", "sessions"), claude: path.join(home, ".claude", "projects"), dsh: path.join(custom, "sessions") });
  });
  it("缺值、重复、未知协议和坏路径被拒绝，不退回其他根", () => {
    for (const args of [["--dsh-home"], ["--dsh-home="], ["--dsh-home", "relative"], ["--dsh-home", "~another/path"],
      ["--dsh-home", `${custom}\0bad`], ["--dsh-home", custom, `--dsh-home=${other}`],
      ["--agent-site-launch=2", "--dsh-home", custom], ["--agent-site-launch=1"],
      ["--agent-site-launch=1", "--agent-site-launch=1", "--dsh-home", custom]]) {
      expect(resolveDshLaunch(args, { DSH_HOME: other }, home).ok, JSON.stringify(args)).toBe(false);
    }
    expect(resolveDshLaunch([], { DSH_HOME: "relative" }, home).ok).toBe(false);
    const file = path.join(mkTmpDir(), "not-a-directory");
    fs.writeFileSync(file, "fixture");
    expect(resolveDshLaunch(["--dsh-home", file], {}, home).ok).toBe(false);
    if (process.platform === "win32") expect(resolveDshLaunch(["--dsh-home", "D:/fixture/invalid<root>"], {}, home).ok).toBe(false);
  });
  it.skipIf(process.platform !== "win32")("DIST-7：Windows控制字符不是尚不存在的合法目录", () => {
    for (let code = 0; code < 32; code++) {
      const invalid = path.join(custom, `bad${String.fromCharCode(code)}root`);
      expect(resolveDshLaunch(["--dsh-home", invalid], {}, home).ok, `control ${code}`).toBe(false);
      expect(resolveDshLaunch([], { DSH_HOME: invalid }, home).ok, `env control ${code}`).toBe(false);
    }
  });
  it("协议参数可回读，Electron自身参数不冒充应用启动参数", () => {
    expect(resolveDshLaunch(launchArgs(custom), {}, home)).toEqual({ ok: true, launch: { dshHome: custom, explicit: true } });
    expect(resolveDshLaunch(["--user-data-dir=fixture", "--no-sandbox", ...launchArgs(custom)], {}, home).ok).toBe(true);
  });
});

describe("DIST-8：第二实例请求与根判等", () => {
  it("只读取本产品协议的确定类型请求", () => {
    expect(readInstanceLaunch({ launchProtocol: 1, dshHome: custom, explicit: true })).toEqual({ dshHome: custom, explicit: true });
    for (const bad of [null, {}, { launchProtocol: 2, dshHome: custom, explicit: true },
      { launchProtocol: 1, dshHome: "relative", explicit: true }, { launchProtocol: 1, dshHome: custom, explicit: "yes" }]) expect(readInstanceLaunch(bad)).toBeNull();
  });
  it("Windows根按大小写和斜杠规范化，同根不依赖写盘", () => {
    expect(sameDshRoot("C:/DSH/home", "c:\\dsh\\home\\", "win32")).toBe(true);
    expect(sameDshRoot(custom, other)).toBe(false);
    expect(sameDshRoot("/tmp/Case", "/tmp/case", "linux")).toBe(false);
  });
});
