import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mkTmpDir } from "../harness/wait";
import { openDesktop } from "../../packages/dsh-plugin/src/launcher";

const manifest = { product: "agent-site", version: "0.1.0", platform: "win32", arch: "x64", launchProtocol: 1 };
async function component() {
  const dir = path.join(mkTmpDir(), "组件 with spaces");
  await fs.mkdir(dir);
  const executablePath = path.join(dir, "AgentSite.exe");
  await fs.writeFile(executablePath, "fixture executable, never run");
  await fs.writeFile(path.join(dir, "agent-site.json"), JSON.stringify(manifest));
  return { dir, executablePath };
}

describe("DIST-2、DIST-5、DIST-9：插件只启动明确配置的兼容组件", () => {
  it("验证组件后用参数数组启动，清掉宿主启动注入，不跟踪或终止App", async () => {
    const { executablePath } = await component();
    const dshHome = path.resolve("D:/fixture/DSH 根");
    const start = vi.fn(async () => {});
    const result = await openDesktop({ executablePath, dshHome, platform: "win32", arch: "x64", env: {
      PATH: "fixture-path", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--import=host-loader", node_options: "--require=other",
    } }, start);
    expect(result).toEqual({ version: 1, status: "sent" });
    expect(start).toHaveBeenCalledWith(executablePath, ["--agent-site-launch=1", "--dsh-home", dshHome], { PATH: "fixture-path" });
  });
  it("缺配置、相对路径、缺文件、目录或缺清单均不启动", async () => {
    const start = vi.fn(async () => {});
    const base = { dshHome: path.resolve("D:/fixture/data"), platform: "win32", arch: "x64", env: {} };
    for (const executablePath of ["", "relative.exe", path.join(mkTmpDir(), "missing.exe"), mkTmpDir()]) {
      expect((await openDesktop({ ...base, executablePath }, start)).status).toBe("error");
    }
    const { dir, executablePath } = await component();
    await fs.unlink(path.join(dir, "agent-site.json"));
    expect(await openDesktop({ ...base, executablePath }, start)).toEqual({ version: 1, status: "error", code: "missing-component" });
    expect(start).not.toHaveBeenCalled();
  });
  it("清单无效或不兼容不启动；拒绝平台，捕获系统启动错误", async () => {
    const { dir, executablePath } = await component();
    const base = { executablePath, dshHome: path.resolve("D:/fixture/data"), platform: "win32", arch: "x64", env: {} };
    const start = vi.fn(async () => {});
    await fs.writeFile(path.join(dir, "agent-site.json"), JSON.stringify({ ...manifest, launchProtocol: 2 }));
    expect(await openDesktop(base, start)).toEqual({ version: 1, status: "error", code: "incompatible" });
    await fs.writeFile(path.join(dir, "agent-site.json"), "bad json");
    expect((await openDesktop(base, start)).status).toBe("error");
    expect(start).not.toHaveBeenCalled();
    await fs.writeFile(path.join(dir, "agent-site.json"), JSON.stringify(manifest));
    expect(await openDesktop({ ...base, platform: "linux" }, start)).toEqual({ version: 1, status: "error", code: "unsupported" });
    expect(await openDesktop({ ...base, arch: "arm64" }, start)).toEqual({ version: 1, status: "error", code: "unsupported" });
    expect(await openDesktop(base, async () => { throw new Error("secret or private system path"); })).toEqual({ version: 1, status: "error", code: "spawn-failed" });
  });
});
