import { launchArgs } from "../protocol/launch";

/** `app.setLoginItemSettings` 的参数；单独成函数，好在没有 Electron 的环境里测 */
export interface LoginItemSettings { openAtLogin: boolean; path?: string; args?: string[] }

/**
 * 开机自启要注册什么。打包后的 App 直接注册自己；
 * 开发时跑的是 `electron dist/app/main.cjs`，得把 electron 和入口文件一起写进去，否则登录时只起来一个空的 Electron。
 * 撤销也是同一套参数：Windows 按 AppUserModelId 找值名，重复调用不会越写越多。
 */
export function loginItem(on: boolean, opts: { packaged: boolean; execPath: string; mainFile: string; dshHome?: string }): LoginItemSettings {
  const args = opts.dshHome === undefined ? [] : launchArgs(opts.dshHome).map(loginArgument);
  if (opts.packaged) return { openAtLogin: on, ...(args.length === 0 ? {} : { args }) };
  return { openAtLogin: on, path: opts.execPath, args: [loginArgument(opts.mainFile), ...args] };
}

/** Windows 登录项拼接参数片段，不提供 spawn 的逐项 argv 引用；闭引号前的反斜线要加倍。 */
function loginArgument(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`;
}

/**
 * 把登录项调到想要的状态，再核对一遍。
 * Windows 上注册表被策略或权限锁住时，Electron 既不抛错也不生效，只看 `catch` 会以为什么都没发生——
 * 所以读回来比一次。返回值给调用方决定怎么提示，这里不抛。
 */
export function applyAutostart(opts: {
  desired: boolean;
  settings: LoginItemSettings;
  set: (settings: LoginItemSettings) => void;
  get: (settings: LoginItemSettings) => { openAtLogin: boolean };
}): "ok" | "not-applied" | "error" {
  try {
    opts.set(opts.settings);
    return opts.get(opts.settings).openAtLogin === opts.desired ? "ok" : "not-applied";
  } catch {
    return "error";
  }
}
