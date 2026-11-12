import { expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import * as plugin from "../../packages/dsh-plugin/src/host";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface PrincipalMap { fixtureGuest: { readonly kind: "fixture-guest" } }
}

it("DIST-3、DIST-5、DIST-9：实际Connection执行owner准入，禁用时撤销已有API路由", async () => {
  const ctx = new Context();
  let connection!: HostConnectionService;
  const provider = ctx.plugin({ name: "connection-fixture", apply(child: Context) {
    // 测试在已准入的载体边界提供 Peer；不模拟授权逻辑，也不访问浏览器凭证文件。
    connection = new HostConnectionService(child, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
  } });
  await provider;
  const installed = ctx.plugin(plugin, {});
  try {
    await installed;
    const api = connection.createSharedFetchHandler("/api");
    const owner = connection.createPeer({ principal: { kind: "owner" } });
    const guest = connection.createPeer({ principal: { kind: "fixture-guest" } });
    const request = (body: unknown) => new Request("http://localhost/api/agent-site/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const denied = await api.fetch(request({ version: 1, action: "open" }), guest);
    expect(denied.status).toBe(403);
    const malformed = await api.fetch(request({ version: 1, action: "open", executable: "other.exe" }), owner);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ status: "error", code: "invalid-request" });
    const noComponent = await api.fetch(request({ version: 1, action: "open" }), owner);
    expect(noComponent.status).toBe(200);
    expect(await noComponent.json()).toMatchObject({ status: "error", code: process.platform === "win32" && process.arch === "x64" ? "not-configured" : "unsupported" });
    await installed.dispose();
    expect((await api.fetch(request({ version: 1, action: "open" }), owner)).status).toBe(404);
    await owner.dispose();
    await guest.dispose();
  } finally {
    await installed.dispose();
    await provider.dispose();
  }
});
