import type { OpenError } from "../../../src/protocol/launch";
import type { OpenState } from "./open-controller";

const en = {
  headline1: "Your agents.", headline2: "One little site.",
  lead: "See who is working, who has stopped, and who needs you—without checking every terminal.",
  caption: "Real renderer · Fictional sessions · Simulated bridge", imageAlt: "Fictional coding sessions shown as building progress and an agent awaiting a decision",
  imageError: "The example image is unavailable. Setup and opening still work.", setup: "Bring the site to your desktop",
  focusPath: "Already downloaded? Set the path", localShort: "Runs locally", dshReadOnly: "DSH is read-only",
  statusMissing: "First-time setup", statusReady: "Configured", statusDirty: "Unsaved changes", statusPending: "Sending…", statusSent: "Request sent", statusError: "Action failed", statusUnconfirmed: "Not confirmed",
  path: "Desktop executable", hint: "Download and fully extract the Windows x64 desktop ZIP, then select AgentSite.exe.",
  open: "Open Agent Site", download: "Download desktop component", ready: "Desktop component configured", missing: "Set up the desktop component first",
  pending: "Sending open request…", sent: "Open request sent. This does not confirm that the window is ready.", dirty: "Save the desktop path before opening.",
  local: "For DSH running on this Windows computer. A remote host cannot open a window on your browser's computer.",
  save: "Save", saving: "Saving…", saveFailed: "Could not save. Your edits are unchanged.", unavailable: "Plugin settings are unavailable.", readOnly: "This profile is read-only.",
  reset: "Reset", overridden: "Configured", invalid: "Choose a valid desktop executable path.",
};
const zh: typeof en = {
  headline1: "你的小队，", headline2: "今天也开工。",
  lead: "谁在推进，谁停住了，谁在等你——不用挨个翻终端。",
  caption: "真实渲染器 · 虚构会话 · 模拟桥接展示", imageAlt: "虚构编码会话中的楼层进展与等待决策画面",
  imageError: "示例图片暂时无法显示，配置与打开功能仍可使用。", setup: "把工地放到桌面",
  focusPath: "我已下载，填写路径", localShort: "本机运行", dshReadOnly: "DSH 只读监控",
  statusMissing: "首次使用", statusReady: "已配置", statusDirty: "尚未保存", statusPending: "正在发送…", statusSent: "请求已发送", statusError: "操作失败", statusUnconfirmed: "尚未确认",
  path: "桌面程序路径", hint: "下载并完整解压 Windows x64 桌面 ZIP，再选择 AgentSite.exe。",
  open: "打开工地", download: "下载桌面组件", ready: "桌面组件已配置", missing: "请先配置桌面组件",
  pending: "正在发送打开请求…", sent: "打开请求已发送，尚不代表窗口已经就绪。", dirty: "请先保存桌面程序路径，再打开工地。",
  local: "适用于运行 DSH 的这台 Windows 电脑；远程宿主不能在浏览器所在的电脑上打开窗口。",
  save: "保存", saving: "保存中…", saveFailed: "保存失败，已保留你的修改。", unavailable: "插件设置当前不可用。", readOnly: "当前 profile 为只读。",
  reset: "重置", overridden: "已配置", invalid: "请选择有效的桌面程序路径。",
};
export const COPY = { en, zh };

/** 表单状态先于上一次打开结果，保留错误码到取词时才选择当前语言。 */
export function panelFeedback(lang: "en" | "zh", status: OpenState, form: { configured: boolean; dirty: boolean; local: boolean }): string {
  if (!form.local) return ERRORS[lang].unsupported;
  if (form.dirty) return COPY[lang].dirty;
  if (!form.configured) return COPY[lang].missing;
  if (status.kind === "error") return ERRORS[lang][status.code];
  return status.kind === "pending" ? COPY[lang].pending : status.kind === "sent" ? COPY[lang].sent : COPY[lang].ready;
}
export const ERRORS: Record<"en" | "zh", Record<OpenError, string>> = {
  en: {
    "not-configured": "Set up the desktop component first.", "missing-component": "The component is missing. Extract the full desktop ZIP and select AgentSite.exe again.",
    "invalid-component": "This is not a complete desktop component. Select AgentSite.exe from the extracted ZIP.", "incompatible": "The component or launch protocol is incompatible. Download a compatible desktop component.",
    unsupported: "Opening the desktop window requires local Windows x64.", unauthorized: "Only the host owner can open Agent Site.", "invalid-request": "Invalid open request. Reload the plugin and try again.",
    "spawn-failed": "Windows could not start the component. Check that it is available and allowed to run.", timeout: "No confirmation within 8 seconds. The result is unknown; no retry was sent.",
    disconnected: "The host connection was lost. The result is unknown; no retry was sent.",
  },
  zh: {
    "not-configured": "请先配置桌面组件。", "missing-component": "桌面组件不存在，请完整解压 ZIP 后重新选择 AgentSite.exe。",
    "invalid-component": "这不是完整的桌面组件，请选择解压目录中的 AgentSite.exe。", "incompatible": "桌面组件或启动协议不兼容，请下载兼容的桌面组件。",
    unsupported: "打开桌面窗口需要本机 Windows x64。", unauthorized: "只有宿主所有者可以打开工地。", "invalid-request": "打开请求无效，请重新加载插件后再试。",
    "spawn-failed": "Windows 未能启动组件，请确认文件可用并允许其运行。", timeout: "8 秒内未确认，结果尚不确定，没有自动重试。",
    disconnected: "与宿主断开，结果尚不确定，没有自动重试。",
  },
};
