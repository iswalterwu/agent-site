import { describe, expect, it } from "vitest";
import { parseDistributionManifest, parseOpenRequest, parseOpenResult } from "../../src/protocol/launch";

describe("DIST-2、DIST-5：桌面组件清单与启动消息边界", () => {
  const manifest = { product: "agent-site", version: "0.1.0", platform: "win32", arch: "x64", launchProtocol: 1 };
  it("接受完整组件清单，拒绝不匹配、非 SemVer 和未知协议", () => {
    expect(parseDistributionManifest(manifest)).toEqual(manifest);
    for (const bad of [null, [], {}, { ...manifest, product: "other" }, { ...manifest, platform: "linux" },
      { ...manifest, arch: "arm64" }, { ...manifest, launchProtocol: 2 }, { ...manifest, version: "01.2.3" },
      { ...manifest, version: "1.2" }, { ...manifest, version: "1.2.3-01" }]) expect(parseDistributionManifest(bad)).toBeNull();
    expect(parseDistributionManifest({ ...manifest, version: "1.2.3-rc.1+build.01" })?.version).toBe("1.2.3-rc.1+build.01");
  });
  it("打开请求只有动作与协议，不能夹带可执行文件、命令参数或根目录", () => {
    expect(parseOpenRequest({ version: 1, action: "open" })).toEqual({ version: 1, action: "open" });
    for (const bad of [null, {}, { version: 2, action: "open" }, { version: 1, action: "stop" },
      { version: 1, action: "open", executable: "C:/other.exe" }, { version: 1, action: "open", args: [] },
      { version: 1, action: "open", cwd: "C:/repo" }, { version: 1, action: "open", dshHome: "C:/data" }]) expect(parseOpenRequest(bad)).toBeNull();
  });
  it("DIST-6：响应只接受已发送或可识别错误，不伪造运行中状态", () => {
    expect(parseOpenResult({ version: 1, status: "sent" })).toEqual({ version: 1, status: "sent" });
    expect(parseOpenResult({ version: 1, status: "error", code: "missing-component" })).toEqual({ version: 1, status: "error", code: "missing-component" });
    for (const bad of [null, { version: 1, status: "running" }, { version: 2, status: "sent" },
      { version: 1, status: "error", code: "unknown" }]) expect(parseOpenResult(bad)).toBeNull();
  });
});
