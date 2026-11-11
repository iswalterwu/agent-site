import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { callTool, say, startFauxSession } from "./pi-faux";
import type { ExtensionFactory } from "./pi-faux";
import { mkTmpDir, removeTmpDirs } from "./wait";

/** 把会话生命周期事件记进 seen 的内联扩展 */
function recordLifecycle(seen: string[]): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", (e) => {
      seen.push(`session_start:${e.reason}`);
    });
    pi.on("session_shutdown", (e) => {
      seen.push(`session_shutdown:${e.reason}`);
    });
  };
}

it("在进程内用 faux 模型跑通一次工具调用", async () => {
  const s = await startFauxSession({ cwd: mkTmpDir() });
  s.setResponses([callTool("probe", { n: 1 }), say("done")]);
  await s.session.prompt("go");
  expect(s.probeStarted).toEqual([1]);
  expect(s.probeCalls).toEqual([1]);
  expect(s.session.getLastAssistantText()).toBe("done");
  s.dispose();
});

it("startFauxSession 返回时，内联扩展的 session_start 已触发一次", async () => {
  const seen: string[] = [];
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [recordLifecycle(seen)] });
  expect(seen).toEqual(["session_start:startup"]);
  s.dispose();
});

it("shutdown() 让扩展的 session_shutdown 处理函数运行（reason quit），并释放会话", async () => {
  const seen: string[] = [];
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [recordLifecycle(seen)] });
  await s.shutdown();
  expect(seen).toEqual(["session_start:startup", "session_shutdown:quit"]);
  expect(fs.existsSync(s.agentDir)).toBe(false);
});

it("dispose() 只释放会话并删掉临时 agentDir，不发 session_shutdown", async () => {
  const seen: string[] = [];
  const s = await startFauxSession({ cwd: mkTmpDir(), extensions: [recordLifecycle(seen)] });
  expect(fs.existsSync(s.agentDir)).toBe(true);
  s.dispose();
  expect(fs.existsSync(s.agentDir)).toBe(false);
  expect(seen).toEqual(["session_start:startup"]);
});

it("内联扩展的工厂函数抛错时，startFauxSession 失败并列出出错的扩展，正常的扩展不会收到 session_start", async () => {
  const seen: string[] = [];
  const boom: ExtensionFactory = () => {
    throw new Error("boom in factory");
  };
  // 不用 rejects.toThrow：万一它 resolve 了，vitest 会去打印整个会话对象，触发 pi 的 theme 代理抛错，真正的失败原因就看不见了
  const outcome = await startFauxSession({ cwd: mkTmpDir(), extensions: [recordLifecycle(seen), boom] }).then(
    (s) => {
      s.dispose();
      return "resolved";
    },
    (e: Error) => e.message,
  );
  expect(outcome).toMatch(/<inline:\d+>: boom in factory/);
  expect(seen).toEqual([]);
});

it("扩展处理函数运行时出错：pi 报告的错误记进 handlerErrors，会话照常跑完", async () => {
  const s = await startFauxSession({
    cwd: mkTmpDir(),
    extensions: [
      (pi) => {
        pi.on("agent_start", () => {
          throw new Error("boom in agent_start");
        });
      },
    ],
  });
  expect(s.handlerErrors).toEqual([]);
  s.setResponses([say("done")]);
  await s.session.prompt("go");
  expect(s.handlerErrors).toMatchObject([{ event: "agent_start", error: "boom in agent_start" }]);
  expect(s.session.getLastAssistantText()).toBe("done");
  s.dispose();
});

it("removeTmpDirs 只删 mkTmpDir 建过的目录", () => {
  const mine = mkTmpDir();
  fs.writeFileSync(path.join(mine, "file.txt"), "x");
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "not-from-mktmpdir-"));
  try {
    removeTmpDirs();
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  } finally {
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});
