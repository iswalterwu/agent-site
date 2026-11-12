import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-settings";
import { LAUNCH_PROTOCOL, parseOpenRequest } from "../../../src/protocol/launch";
import { openDesktop } from "./launcher";

export const name = "agent-site";
export const inject = ["connection"];
export const Config = z.object({ executablePath: z.string().default("").volatile() });

/** 注册在宿主现有认证 Connection 上；不创建服务器，不申请模型或工具能力。 */
export function apply(ctx: Context, config: ReturnType<typeof Config>): void {
  ctx.inject(["settings"], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  ctx.connection.fetch.register({ path: "/api/agent-site/open", methods: ["POST"], requestBody: "buffered",
    // 共享 Connection 先做认证与 owner 准入，再把请求交给本方法。
    fetch: async request => {
      let payload: unknown;
      try { payload = await request.json(); } catch { payload = null; }
      if (parseOpenRequest(payload) === null) return Response.json({ version: LAUNCH_PROTOCOL, status: "error", code: "invalid-request" }, { status: 400 });
      if (request.signal.aborted) return Response.json({ version: LAUNCH_PROTOCOL, status: "error", code: "disconnected" });
      const value = await openDesktop({ executablePath: config.executablePath.get(), dshHome: resolveDshHome(),
        platform: process.platform, arch: process.arch, env: process.env });
      return Response.json(value);
    },
  });
}
