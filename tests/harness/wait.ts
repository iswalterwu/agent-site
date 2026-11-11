import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 每 10ms 轮询一次 pred，超时（默认 10 秒）抛错。10 秒是"回归了"的判定线，不是预期耗时：整包并行跑时负载会把本机几毫秒的往返拉长 */
export async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）：${pred.toString()}`);
    await sleep(10);
  }
}

/** mkTmpDir 建过、还没被 removeTmpDirs 删掉的目录 */
const created = new Set<string>();

/** 建一个临时目录并记下来，测试文件结束时由 removeTmpDirs 统一删除 */
export function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-site-"));
  created.add(dir);
  return dir;
}

/**
 * 删掉本进程里 mkTmpDir 建过的所有目录（setup.ts 在每个测试文件结束后调用）。
 * Windows 上刚退出的子进程还会占着它的工作目录一小会儿（EBUSY），所以带重试
 */
export function removeTmpDirs(): void {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  created.clear();
}
