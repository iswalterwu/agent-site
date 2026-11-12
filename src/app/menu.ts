import type { MenuItemConstructorOptions } from "electron";
import type { SiteSnapshot } from "../core/types";
import type { MenuAction } from "./api";
import type { AppModes } from "./modes";
import type { ThemeName } from "./theme";
import { ui } from "./i18n";

export type MenuGroupId = "display" | "position" | "sites" | "theme" | "behavior";

export interface MenuEntry {
  action: MenuAction;
  label: string;
  /** 打勾的项；齿轮菜单画成「✓ 」，托盘菜单画成勾选框 */
  check?: boolean;
  /** 一组里只能选一个（缩放），托盘菜单画成单选 */
  radio?: boolean;
  /** 工地那一项对应的工地键：点它等于钉住这个工地 */
  site?: string;
}

/** 菜单里列出来的工地；pinned 非空时勾的是它，否则勾"自动跟随"。waiting 是这个工地上在等你回话的会话数 */
export interface SiteMenu { sites: Array<{ key: string; name: string; waiting: number }>; pinned: string | null }

/** 每个工地上在等你回话的会话数；调用方传进来的应当是可见投影（过期的等待不该继续报数） */
export function siteMenuOf(snapshot: SiteSnapshot, pinned: string | null): SiteMenu | null {
  return { sites: snapshot.sites.map(site => ({
    key: site.key, name: site.name, waiting: site.workers.filter(worker => worker.status === "waiting").length,
  })), pinned };
}

/** 托盘菜单要不要重建：工地、名字、人数、钉住状态有一项变了就重建；同一个字符串说明不用动 */
export function siteMenuSignature(menu: SiteMenu | null): string {
  if (menu === null) return "";
  return `${String(menu.pinned)}\u0000${menu.sites.map(site => `${site.key}\u0000${site.name}\u0000${site.waiting}`).join("\u0001")}`;
}

/** 工地项的文字：有人在等你时把数字带上，没人等就用原名 */
export const siteLabel = (site: { name: string; waiting: number }): string =>
  site.waiting === 0 ? site.name : ui("{name} · 等你 {count}", { name: site.name, count: site.waiting });

export interface MenuGroup { id: MenuGroupId; label: string; entries: MenuEntry[] }

export interface AppMenu {
  groups: MenuGroup[];
  /** 诊断和退出：不进二级菜单，单列在分隔线下面 */
  singles: MenuEntry[];
}

/** 齿轮菜单和托盘菜单共用这一份：显示 / 位置 / 缩放 / 行为四组，加两个单列项；工地多于一个时中间多一组 */
export function appMenu(modes: AppModes, visible: boolean, siteMenu: SiteMenu | null = null, theme: ThemeName = "night"): AppMenu {
  const sites: MenuGroup[] = siteMenu === null || siteMenu.sites.length < 2 ? [] : [{
    id: "sites", label: ui("menu.sites"), entries: [
      { action: "follow-site", label: ui("自动跟随"), check: siteMenu.pinned === null },
      ...siteMenu.sites.map(site => ({ action: "pin-site" as const, label: siteLabel(site), site: site.key,
        check: siteMenu.pinned === site.key })),
    ],
  }];
  return {
    groups: [
      { id: "display", label: ui("menu.display"), entries: [
        { action: "toggle", label: ui(visible ? "隐藏" : "显示") },
      ] },
      { id: "position", label: ui("位置"), entries: [
        { action: "attach-right", label: ui("附着到右侧屏幕") },
        { action: "primary", label: ui("贴到主屏") },
        { action: "cursor", label: ui("贴到鼠标所在屏幕") },
      ] },
      ...sites,
      { id: "theme", label: ui("主题"), entries: [
        { action: "theme-night", label: ui("夜色"), check: theme === "night", radio: true },
        { action: "theme-day", label: ui("白昼"), check: theme === "day", radio: true },
      ] },
      { id: "behavior", label: ui("行为"), entries: [
        { action: "auto-hide", label: ui("贴边隐藏"), check: modes.autoHide },
        { action: "translucent", label: ui("半透明"), check: modes.translucent },
        { action: "waiting-dot", label: ui("等待橙点"), check: modes.waitingDot },
        { action: "demo", label: ui("演示模式"), check: modes.demo },
        { action: "dnd", label: ui("勿扰"), check: modes.dnd },
        { action: "pause-animation", label: ui("暂停动画"), check: modes.pauseAnimation },
      ] },
    ],
    singles: [
      { action: "settings", label: ui("设置…") },
      { action: "diagnostics", label: ui("诊断") },
      { action: "quit", label: ui("退出") },
    ],
  };
}

/** 点下去做什么：普通项走菜单动作，工地项直接钉住（"自动跟随"就是取消钉住） */
export function menuDispatch(entry: MenuEntry): { action: MenuAction } | { pin: string | null } {
  if (entry.action === "follow-site") return { pin: null };
  return entry.site === undefined ? { action: entry.action } : { pin: entry.site };
}

/** 托盘菜单是原生菜单：四组变二级菜单，打勾的变勾选框，缩放变单选，诊断和退出单列 */
export function trayTemplate(menu: AppMenu, run: (entry: MenuEntry) => void): MenuItemConstructorOptions[] {
  const item = (entry: MenuEntry): MenuItemConstructorOptions => {
    if (entry.radio === true) {
      return { label: entry.label, type: "radio", checked: entry.check === true, click: () => run(entry) };
    }
    if (entry.check !== undefined) {
      return { label: entry.label, type: "checkbox", checked: entry.check, click: () => run(entry) };
    }
    return { label: entry.label, click: () => run(entry) };
  };
  return [
    ...menu.groups.map(group => ({ label: group.label, submenu: group.entries.map(item) })),
    { type: "separator" },
    ...menu.singles.map(item),
  ];
}

/**
 * 二级菜单默认贴着所属组。会顶出窗口时返回要上下挪的像素：
 * 先贴住底边，再保证不越过顶边；实在放不下就从上边开始（外面再滚动）。
 */
export function submenuShift(rect: { top: number; bottom: number }, viewHeight: number, margin = 8): number {
  let shift = 0;
  if (rect.bottom > viewHeight - margin) shift = viewHeight - margin - rect.bottom;
  if (rect.top + shift < margin) shift = margin - rect.top;
  return shift;
}
