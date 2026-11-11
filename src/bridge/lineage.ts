// 会话层级的传递：用户在终端直接开的会话是一级；一级会话启动的 pi 子进程通过环境变量继承父会话，成为二级，依此类推。
// 激活桥接的会话把自己的 ID 和层级写进环境变量（exportLineage），它的子进程启动时再读出来（readLineage）。

export const ENV_PARENT = "AGENT_SITE_PARENT_SESSION";
export const ENV_LEVEL = "AGENT_SITE_LEVEL";

type Env = Record<string, string | undefined>;

/** 本会话的父会话和层级：环境变量里没有父会话就是一级；有父会话时层级是父会话的层级加一，层级变量不合法就按二级 */
export function readLineage(env: Env): { parentId?: string; level: number } {
  const parentId = env[ENV_PARENT];
  if (!parentId) return { level: 1 };
  return { parentId, level: (parseLevel(env[ENV_LEVEL]) ?? 1) + 1 };
}

/** 把本会话的 ID 和层级写进环境变量，让之后启动的子进程把本会话当作父会话 */
export function exportLineage(env: Env, sessionId: string, level: number): void {
  env[ENV_PARENT] = sessionId;
  env[ENV_LEVEL] = String(level);
}

/** 层级变量只认 exportLineage 写出的形式：不带前导零、不带符号和空白的正整数十进制，且不超过安全整数；其他一律当作没有 */
function parseLevel(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  const level = Number(raw);
  return Number.isSafeInteger(level) ? level : undefined;
}
