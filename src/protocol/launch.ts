import { isObj, isStr, oneOf } from "./guards";

/** App 启动协议独立于 pi 的桥接协议。 */
export const LAUNCH_PROTOCOL = 1;
export const DISTRIBUTION_PRODUCT = "agent-site";
export const DISTRIBUTION_MANIFEST = "agent-site.json";
export const DSH_VERSIONS = ["0.2.1-rc.3", "0.2.2-rc.1"] as const;
export const OPEN_TIMEOUT_MS = 8000;

export function launchArgs(dshHome: string): string[] {
  return [`--agent-site-launch=${LAUNCH_PROTOCOL}`, "--dsh-home", dshHome];
}

export interface DistributionManifest {
  product: typeof DISTRIBUTION_PRODUCT;
  version: string;
  platform: "win32";
  arch: "x64";
  launchProtocol: typeof LAUNCH_PROTOCOL;
}
export interface OpenRequest { version: typeof LAUNCH_PROTOCOL; action: "open" }
export const OPEN_ERRORS = ["not-configured", "missing-component", "invalid-component", "incompatible", "unsupported", "unauthorized", "invalid-request", "spawn-failed", "timeout", "disconnected"] as const;
export type OpenError = typeof OPEN_ERRORS[number];
export type OpenResult = { version: typeof LAUNCH_PROTOCOL; status: "sent" }
  | { version: typeof LAUNCH_PROTOCOL; status: "error"; code: OpenError };

export function parseDistributionManifest(value: unknown): DistributionManifest | null {
  if (!isObj(value) || value.product !== DISTRIBUTION_PRODUCT || !isStr(value.version) || !isSemVer(value.version)
    || value.platform !== "win32" || value.arch !== "x64" || value.launchProtocol !== LAUNCH_PROTOCOL) return null;
  return { product: DISTRIBUTION_PRODUCT, version: value.version, platform: "win32", arch: "x64", launchProtocol: LAUNCH_PROTOCOL };
}

export function parseOpenRequest(value: unknown): OpenRequest | null {
  if (!isObj(value) || value.version !== LAUNCH_PROTOCOL || value.action !== "open"
    || Object.keys(value).some(key => key !== "version" && key !== "action")) return null;
  return { version: LAUNCH_PROTOCOL, action: "open" };
}

export function parseOpenResult(value: unknown): OpenResult | null {
  if (!isObj(value) || value.version !== LAUNCH_PROTOCOL) return null;
  if (value.status === "sent") return { version: LAUNCH_PROTOCOL, status: "sent" };
  if (value.status === "error" && oneOf(OPEN_ERRORS)(value.code)) return { version: LAUNCH_PROTOCOL, status: "error", code: value.code };
  return null;
}

function isSemVer(value: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return match !== null && (match[4] === undefined || match[4].split(".").every(part => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")));
}
