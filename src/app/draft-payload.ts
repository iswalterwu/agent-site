import type { SettingsDraft } from "./settings-form";

/**
 * IPC 只接受结构化克隆的普通对象：面板草稿在 Vue 里是响应式代理，直接 invoke
 * 会抛 "An object could not be cloned."，保存看起来毫无反应。
 */
export function draftPayload(current: SettingsDraft): SettingsDraft {
  return {
    theme: current.theme,
    style: current.style,
    autostart: current.autostart,
    idleMinutes: current.idleMinutes,
    stalledMinutes: current.stalledMinutes,
    onsiteHours: current.onsiteHours,
    repos: current.repos,
  };
}
