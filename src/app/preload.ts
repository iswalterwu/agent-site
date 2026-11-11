import { contextBridge, ipcRenderer } from "electron";
import type { AgentSiteApi, AppAsk, AppBootstrap, AppHit, AppRect, AppView, AskResult, ControlAction, ControlResult, MenuAction, SaveSettingsResult, SuggestMode } from "./api";
import type { SettingsDraft } from "./settings-form";
import type { AppModes } from "./modes";
import type { SiteSnapshot } from "../core/types";

const api: AgentSiteApi = {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap") as Promise<AppBootstrap>,
  onView: (callback: (view: AppView) => void) => {
    ipcRenderer.on("app:view", (_event, view: AppView) => { callback(view); });
  },
  menuAction: (action: MenuAction) => { ipcRenderer.send("app:menu-action", action); },
  openSettings: () => { void ipcRenderer.invoke("app:open-settings"); },
  saveSettings: (draft: SettingsDraft) => ipcRenderer.invoke("app:save-settings", draft) as Promise<SaveSettingsResult>,
  pinSite: (key: string | null) => { ipcRenderer.send("app:pin-site", key); },
  setCardOpen: (open: boolean) => { ipcRenderer.send("app:card-open", open); },
  setMenuOpen: (open: boolean) => { ipcRenderer.send("app:menu-open", open); },
  onPointer: (callback: (inside: boolean) => void) => {
    ipcRenderer.on("app:pointer", (_event, inside: boolean) => { callback(inside); });
  },
  onHover: (callback: (inside: boolean) => void) => {
    ipcRenderer.on("app:hover", (_event, inside: boolean) => { callback(inside); });
  },
  onSnap: (callback: () => void) => {
    ipcRenderer.on("app:snap", () => { callback(); });
  },
  onSnapshot: (callback: (snapshot: SiteSnapshot) => void) => {
    ipcRenderer.on("app:snapshot", (_event, snapshot: SiteSnapshot) => { callback(snapshot); });
  },
  onAsks: (callback: (asks: AppAsk[]) => void) => {
    ipcRenderer.on("app:asks", (_event, asks: AppAsk[]) => { callback(asks); });
  },
  onModes: (callback: (modes: AppModes) => void) => {
    ipcRenderer.on("app:modes", (_event, modes: AppModes) => { callback(modes); });
  },
  onPinned: (callback) => {
    ipcRenderer.on("app:pinned", (_event, key: string | null) => { callback(key); });
  },
  onDiagnostics: (callback: () => void) => {
    ipcRenderer.on("app:diagnostics", () => { callback(); });
  },
  onSettings: (callback: (payload: { draft: SettingsDraft } | null) => void) => {
    ipcRenderer.on("app:settings", (_event, payload: { draft: SettingsDraft } | null) => { callback(payload); });
  },
  control: (key: string, action: ControlAction) => ipcRenderer.invoke("app:control", { key, action }) as Promise<ControlResult>,
  suggest: (key: string, text: string, mode: SuggestMode) => ipcRenderer.invoke("app:suggest", { key, text, mode }) as Promise<ControlResult>,
  answerAsk: (askId: string, value: string | null) => ipcRenderer.invoke("app:answer", { askId, value }) as Promise<AskResult>,
  setRects: (rects: AppRect[]) => { ipcRenderer.send("app:rects", rects); },
  hit: (info: AppHit) => { ipcRenderer.send("app:hit", info); },
};

contextBridge.exposeInMainWorld("agentSite", api);
