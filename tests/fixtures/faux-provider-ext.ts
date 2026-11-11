// 冒烟测试用的 pi 扩展：注册一个按脚本回复的 faux 模型（不联网、不要凭证），pi 命令行用 `--model faux/faux-1` 选它。
// 环境变量 FAUX_HOLD_UNTIL 指向一个文件时，回复要等这个文件出现才给：print 模式下 prompt 一启动就开跑，
// 测试要先等桥接连上工地，才不会错过这一轮的事件。最多等 HOLD_LIMIT_MS 就照常回复：跑测试的进程被杀掉、
// 再没人写这个文件时，print 模式的 pi 也不会一直等下去。

import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOLD_LIMIT_MS = 60_000;

export default function (pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const holdUntil = process.env.FAUX_HOLD_UNTIL;
  faux.setResponses([
    async () => {
      const deadline = Date.now() + HOLD_LIMIT_MS;
      while (holdUntil !== undefined && !existsSync(holdUntil) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      return fauxAssistantMessage("hello from faux");
    },
  ]);
  pi.registerProvider(faux.provider);
}
