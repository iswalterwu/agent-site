import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { applyAutostart, loginItem } from "../../src/app/autostart";

it("WINDOW-24：打包后的 App 只注册自己；开发时把 electron 和入口文件一起写进登录项", () => {
  expect(loginItem(true, { packaged: true, execPath: "C:/apps/agent-site.exe", mainFile: "C:/apps/app.asar/main.cjs" }))
    .toEqual({ openAtLogin: true });
  expect(loginItem(true, { packaged: false, execPath: "C:/node/electron.exe", mainFile: "D:/repo/dist/app/main.cjs" }))
    .toEqual({ openAtLogin: true, path: "C:/node/electron.exe", args: ["D:/repo/dist/app/main.cjs"] });
  expect(loginItem(false, { packaged: false, execPath: "C:/node/electron.exe", mainFile: "D:/repo/dist/app/main.cjs" }))
    .toEqual({ openAtLogin: false, path: "C:/node/electron.exe", args: ["D:/repo/dist/app/main.cjs"] });
});
it("DIST-8：显式DSH根随打包与源码启动参数登记，撤销使用同一组参数", () => {
  const dshHome = "D:/fixture/DSH data";
  const flags = ["--agent-site-launch=1", "--dsh-home", `"${dshHome}"`];
  expect(loginItem(true, { packaged: true, execPath: "C:/apps/AgentSite.exe", mainFile: "C:/apps/main.cjs", dshHome }))
    .toEqual({ openAtLogin: true, args: flags });
  expect(loginItem(false, { packaged: false, execPath: "C:/apps/electron.exe", mainFile: "D:/fixture/main.cjs", dshHome }))
    .toEqual({ openAtLogin: false, path: "C:/apps/electron.exe", args: ["D:/fixture/main.cjs", ...flags] });
});

it.runIf(process.platform === "win32")("DIST-8、WINDOW-24：登录项由真实 Windows 参数解析器往返含空格/中文/末尾斜线路径，不写注册表", () => {
  const decode = (args: string[]) => JSON.parse(execFileSync("python", ["-c", [
    "import ctypes,json,sys", "count=ctypes.c_int()", "parse=ctypes.windll.shell32.CommandLineToArgvW",
    "parse.argtypes=[ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_int)]", "parse.restype=ctypes.POINTER(ctypes.c_wchar_p)",
    "values=parse(sys.argv[1],ctypes.byref(count))", "print(json.dumps([values[i] for i in range(count.value)]))",
    "ctypes.windll.kernel32.LocalFree.argtypes=[ctypes.c_void_p]", "ctypes.windll.kernel32.LocalFree(values)",
  ].join(";"), ['"C:\\App Files\\AgentSite.exe"', ...args].join(" ")], { encoding: "utf8" })) as string[];
  for (const dshHome of ["D:\\DSH data", "D:\\工地 data\\", "\\\\synthetic-host\\共享 data\\"]) {
    const opts = { packaged: true, execPath: "C:/App Files/AgentSite.exe", mainFile: "D:\\Source files\\main.cjs", dshHome };
    const packaged = loginItem(true, opts);
    expect(decode(packaged.args!).slice(1)).toEqual(["--agent-site-launch=1", "--dsh-home", dshHome]);
    const development = loginItem(false, { ...opts, packaged: false });
    expect(decode(development.args!).slice(1)).toEqual([opts.mainFile, "--agent-site-launch=1", "--dsh-home", dshHome]);
    expect(loginItem(false, opts).args).toEqual(packaged.args);
  }
});
it("WINDOW-24：写完读回来核对——真生效才算 ok；被政策静默拦掉算 not-applied；抛错算 error，都不抛出", () => {
  const settings = { openAtLogin: true };
  // 生效
  expect(applyAutostart({ desired: true, settings, set: () => {}, get: () => ({ openAtLogin: true }) })).toBe("ok");
  // 没抛错但没生效（注册表被策略锁住时 Electron 的行为）
  expect(applyAutostart({ desired: true, settings, set: () => {}, get: () => ({ openAtLogin: false }) })).toBe("not-applied");
  // 调用本身抛错：接住，交给调用方提示
  expect(applyAutostart({ desired: true, settings, set: () => { throw new Error("boom"); }, get: () => ({ openAtLogin: true }) })).toBe("error");
  // 撤销时也是比期望值，而不是"有没有抛错"
  expect(applyAutostart({ desired: false, settings: { openAtLogin: false }, set: () => {}, get: () => ({ openAtLogin: false }) })).toBe("ok");
});
