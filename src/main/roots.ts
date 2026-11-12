import path from "node:path";
import { statSync } from "node:fs";
import { isBool, isObj, isStr } from "../protocol/guards";
import { LAUNCH_PROTOCOL } from "../protocol/launch";
import type { Roots } from "./discover";
import { t, type Locale, type MessageKey } from "../core/i18n";

export interface DshLaunch { dshHome: string; explicit: boolean }
export type RootProblem = "missing-value" | "duplicate-option" | "unsupported-protocol" | "invalid-path";
export type RootResult = { ok: true; launch: DshLaunch } | { ok: false; problem: RootProblem };

/** 入口只解析本应用的开关，保留 Electron/Node 自身参数；只读校验，不创建目录。 */
export function resolveDshLaunch(argv: readonly string[], env: Record<string, string | undefined>, home: string): RootResult {
  const flags = readFlags(argv);
  if (!flags.ok) return flags;
  const fromEnv = env.DSH_HOME?.trim() === "" ? undefined : env.DSH_HOME;
  const raw = flags.dshHome ?? fromEnv;
  const dshHome = normalizeRoot(raw ?? path.join(home, ".dsh"), home);
  if (dshHome === null) return { ok: false, problem: "invalid-path" };
  return { ok: true, launch: { dshHome, explicit: raw !== undefined } };
}

export function sessionRoots(home: string, dshHome: string): Roots {
  return { pi: path.join(home, ".pi", "agent", "sessions"), claude: path.join(home, ".claude", "projects"), dsh: path.join(dshHome, "sessions") };
}

const ROOT_MESSAGES: Record<RootProblem, MessageKey> = {
  "missing-value": "启动参数缺少有效值", "duplicate-option": "启动参数不能重复",
  "unsupported-protocol": "不支持这个启动协议，请使用兼容的桌面组件", "invalid-path": "DSH 数据目录必须是有效的绝对路径",
};
export function rootProblemText(problem: RootProblem, locale: Locale): string {
  return t(locale, ROOT_MESSAGES[problem]);
}

/** 第二实例的 additionalData 是本地入口，收敛成与首启一致的根描述。 */
export function readInstanceLaunch(value: unknown): DshLaunch | null {
  if (!isObj(value) || value.launchProtocol !== LAUNCH_PROTOCOL || !isStr(value.dshHome) || !isBool(value.explicit)
    || !path.isAbsolute(value.dshHome) || value.dshHome.includes("\0")) return null;
  return { dshHome: path.normalize(value.dshHome), explicit: value.explicit };
}

export function sameDshRoot(first: string, second: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string): string => paths.normalize(value).replace(/[\\/]+$/, "");
  const a = normalize(first), b = normalize(second);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizeRoot(raw: string, home: string): string | null {
  const value = raw === "~" ? home : /^~[\\/]/.test(raw) ? path.join(home, raw.slice(2)) : raw;
  if (value.trim() === "" || value.includes("\0") || !path.isAbsolute(value)) return null;
  if (process.platform === "win32" && (/[\x00-\x1f]/.test(value) || /[<>:"|?*]/.test(value.slice(path.parse(value).root.length)))) return null;
  const normalized = path.normalize(value);
  try { if (!statSync(normalized).isDirectory()) return null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
  return normalized;
}

type FlagsResult = { ok: true; dshHome?: string } | { ok: false; problem: RootProblem };
function readFlags(argv: readonly string[]): FlagsResult {
  let dshHome: string | undefined;
  let protocol: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split("=", 1)[0];
    if (name !== "--dsh-home" && name !== "--agent-site-launch") continue;
    const duplicate = name === "--dsh-home" ? dshHome !== undefined : protocol !== undefined;
    if (duplicate) return { ok: false, problem: "duplicate-option" };
    const equals = arg.indexOf("=");
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined || value.trim() === "" || value.startsWith("--")) return { ok: false, problem: "missing-value" };
    if (name === "--dsh-home") dshHome = value;
    else protocol = value;
  }
  if (protocol !== undefined && protocol !== String(LAUNCH_PROTOCOL)) return { ok: false, problem: "unsupported-protocol" };
  if (protocol !== undefined && dshHome === undefined) return { ok: false, problem: "missing-value" };
  return { ok: true, ...(dshHome === undefined ? {} : { dshHome }) };
}
