import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseJsonObject } from "../../../src/protocol/guards";
import { DISTRIBUTION_MANIFEST, launchArgs, LAUNCH_PROTOCOL, parseDistributionManifest, type OpenError, type OpenResult } from "../../../src/protocol/launch";

export interface DesktopTarget {
  executablePath: string;
  dshHome: string;
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
}
export type StartDesktop = (file: string, args: string[], env: Record<string, string | undefined>) => Promise<void>;

/** 组件校验发生在启动边界；已接收的请求只使用宿主已保存的路径和解析后的根。 */
export async function openDesktop(target: DesktopTarget, start: StartDesktop = startDetached): Promise<OpenResult> {
  if (target.platform !== "win32" || target.arch !== "x64") return failure("unsupported");
  const problem = await componentProblem(target.executablePath);
  if (problem !== null) return failure(problem);
  const env = Object.fromEntries(Object.entries(target.env).filter(([key]) => !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(key.toUpperCase())));
  try {
    await start(target.executablePath, launchArgs(target.dshHome), env);
    return { version: LAUNCH_PROTOCOL, status: "sent" };
  } catch {
    return failure("spawn-failed");
  }
}

async function componentProblem(executable: string): Promise<OpenError | null> {
  if (executable.trim() === "") return "not-configured";
  if (!path.isAbsolute(executable) || !/\.exe$/i.test(executable) || executable.includes("\0")) return "invalid-component";
  try {
    if (!(await stat(executable)).isFile()) return "invalid-component";
    const raw = parseJsonObject(await readFile(path.join(path.dirname(executable), DISTRIBUTION_MANIFEST), "utf8"));
    return parseDistributionManifest(raw) === null ? "incompatible" : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing-component" : "invalid-component";
  }
}

function failure(code: OpenError): OpenResult {
  return { version: LAUNCH_PROTOCOL, status: "error", code };
}

function startDetached(file: string, args: string[], env: Record<string, string | undefined>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
