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
