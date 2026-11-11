import type { SiteSnapshot } from "../core/types";
import type { AppModes, ModeAction } from "./modes";
import type { ThemeName } from "./theme";
import type { SettingsDraft } from "./settings-form";
import type { AppScale } from "./window";

export interface AppWorkArea { x: number; y: number; width: number; height: number }
export interface AppView { scale: AppScale; workArea: AppWorkArea; windowHeight: number; theme: ThemeName }
export interface AppRect { x: number; y: number; width: number; height: number }
export interface AppAsk {
  askId: string;
  sessionKey: string;
  sessionId: string;
  question: string;
  options: string[];
  allowOther: boolean;
  context?: string;
}
export interface AskResult { accepted: boolean; reason?: string }
export type SaveSettingsResult = { ok: true } | { ok: false; errors: string[] };

export interface AppBootstrap extends AppView { snapshot: SiteSnapshot; modes: AppModes; hovered: boolean; asks: AppAsk[];
  /** 钉住的工地键；null 表示跟着最近有事件的工地走 */
  pinned: string | null }
export type AppHit = { kind: "band"; feature: string } | { kind: "office" } | { kind: "designer" }
  | { kind: "worker" | "bubble" | "light"; key: string };
export type MenuAction = "toggle" | "attach-right" | "primary" | "cursor" | "theme-night" | "theme-day" | "settings" | "quit"
  | ModeAction | "diagnostics" | "follow-site" | "pin-site";
export type ControlAction = "pause" | "resume" | "abort";
export type SuggestMode = "steer" | "followUp";
export interface ControlResult { ok: boolean; error?: string }

export interface AgentSiteApi {
  bootstrap(): Promise<AppBootstrap>;
  onView(callback: (view: AppView) => void): void;
  menuAction(action: MenuAction): void;
  openSettings(): void;
  saveSettings(draft: SettingsDraft): Promise<SaveSettingsResult>;
  /** 钉住某个工地；null 表示改回自动跟随 */
  pinSite(key: string | null): void;
  setCardOpen(open: boolean): void;
  setMenuOpen(open: boolean): void;
  onPointer(callback: (inside: boolean) => void): void;
  onHover(callback: (inside: boolean) => void): void;
  onSnap(callback: () => void): void;
  onSnapshot(callback: (snapshot: SiteSnapshot) => void): void;
  onAsks(callback: (asks: AppAsk[]) => void): void;
  onModes(callback: (modes: AppModes) => void): void;
  onPinned(callback: (key: string | null) => void): void;
  onDiagnostics(callback: () => void): void;
  onSettings(callback: (payload: { draft: SettingsDraft } | null) => void): void;
  control(key: string, action: ControlAction): Promise<ControlResult>;
  suggest(key: string, text: string, mode: SuggestMode): Promise<ControlResult>;
  answerAsk(askId: string, value: string | null): Promise<AskResult>;
  setRects(rects: AppRect[]): void;
  hit(info: AppHit): void;
}

declare global {
  interface Window { agentSite: AgentSiteApi }
}
