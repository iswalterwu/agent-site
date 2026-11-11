import { describe, expect, it } from "vitest";
import { appMenu, menuDispatch, siteLabel, siteMenuOf, siteMenuSignature, submenuShift, trayTemplate } from "../../src/app/menu";
import { fixtureSnapshot } from "../../src/app/fixture";
import { visibleSnapshot } from "../../src/app/visibility";
import { DEFAULT_MODES } from "../../src/app/modes";

describe("齿轮菜单和托盘菜单的模型", () => {
  it("四组按显示 / 位置 / 主题 / 行为排，设置、诊断和退出单列", () => {
    const menu = appMenu(DEFAULT_MODES, true);
    expect(menu.groups.map(group => group.label)).toEqual(["显示", "位置", "主题", "行为"]);
    expect(menu.singles.map(entry => entry.action)).toEqual(["settings", "diagnostics", "quit"]);
    for (const group of menu.groups) expect(group.entries.length).toBeGreaterThan(0);
  });

  it("每个动作只出现一次", () => {
    const menu = appMenu(DEFAULT_MODES, false);
    const actions = [...menu.groups.flatMap(group => group.entries), ...menu.singles].map(entry => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toEqual(expect.arrayContaining([
      "toggle", "attach-right", "primary", "cursor",
      "auto-hide", "translucent", "waiting-dot", "demo", "dnd", "pause-animation", "diagnostics", "quit",
    ]));
  });

  it("显示组写当前能做的事，行为和主题组带上勾选状态", () => {
    const menu = appMenu({ ...DEFAULT_MODES, demo: true, dnd: true }, true);
    const entry = (action: string) => [...menu.groups.flatMap(group => group.entries), ...menu.singles]
      .find(item => item.action === action);
    expect(entry("toggle")?.label).toBe("隐藏");
    expect(appMenu(DEFAULT_MODES, false).groups[0].entries[0].label).toBe("显示");
    expect(entry("demo")?.check).toBe(true);
    expect(entry("dnd")?.check).toBe(true);
    expect(entry("auto-hide")?.check).toBe(true);
    expect(entry("translucent")?.check).toBe(false);
    expect(entry("diagnostics")?.check).toBeUndefined();
  });
});

describe("工地列表与托盘签名", () => {
  it("WINDOW-19：人数按传进来的快照算；过期等待在可见投影之后就不再计入", () => {
    const snapshot = fixtureSnapshot(0);
    const now = snapshot.at;
    const stale = structuredClone(snapshot);
    const worker = stale.sites[0].workers.find(item => item.status === "waiting")!;
    worker.statusSince = now - 7 * 3_600_000;
    (stale.sites[0].designer.waiting[0] as { since: number }).since = now - 7 * 3_600_000;
    expect(siteMenuOf(stale, null)!.sites[0]!.waiting).toBe(1); // 快照本身还留着这条等待
    expect(siteMenuOf(visibleSnapshot(stale, now), null)!.sites[0]!.waiting).toBe(0); // 可见投影之后没有了
  });
  it("WINDOW-13：签名覆盖工地、名字、人数和钉住状态，任意一项变了才需要重建托盘菜单", () => {
    const snapshot = fixtureSnapshot(0);
    const menu = siteMenuOf(snapshot, null);
    expect(siteMenuSignature(menu)).toBe(siteMenuSignature(siteMenuOf(snapshot, null)));
    expect(siteMenuSignature(siteMenuOf(snapshot, "D:/a"))).not.toBe(siteMenuSignature(menu));
    const renamed = structuredClone(snapshot);
    renamed.sites[0]!.name = "改过的名字";
    expect(siteMenuSignature(siteMenuOf(renamed, null))).not.toBe(siteMenuSignature(menu));
    const quiet = structuredClone(snapshot);
    for (const site of quiet.sites) site.workers = site.workers.filter(worker => worker.status !== "waiting");
    expect(siteMenuSignature(siteMenuOf(quiet, null))).not.toBe(siteMenuSignature(menu));
    expect(siteMenuSignature(null)).toBe("");
  });
});

describe("工地组", () => {
  const sites = [{ key: "D:/a", name: "a", waiting: 0 }, { key: "D:/b", name: "b", waiting: 0 }];

  it("SITE-3：只有两处以上工地时才有这一组，排在位置和主题之间", () => {
    expect(appMenu(DEFAULT_MODES, true).groups.map(group => group.id)).toEqual(["display", "position", "theme", "behavior"]);
    expect(appMenu(DEFAULT_MODES, true, { sites: [sites[0]!], pinned: null }).groups.map(group => group.id))
      .toEqual(["display", "position", "theme", "behavior"]);
    const menu = appMenu(DEFAULT_MODES, true, { sites, pinned: null });
    expect(menu.groups.map(group => group.id)).toEqual(["display", "position", "sites", "theme", "behavior"]);
    expect(menu.groups[2].label).toBe("工地");
  });

  it("SITE-3：自动跟随时勾自动跟随，钉住时勾那个工地，工地项带工地键", () => {
    const auto = appMenu(DEFAULT_MODES, true, { sites, pinned: null }).groups[2];
    expect(auto.entries.map(entry => [entry.label, entry.action, entry.check, entry.site])).toEqual([
      ["自动跟随", "follow-site", true, undefined],
      ["a", "pin-site", false, "D:/a"],
      ["b", "pin-site", false, "D:/b"],
    ]);
    const pinned = appMenu(DEFAULT_MODES, true, { sites, pinned: "D:/b" }).groups[2];
    expect(pinned.entries.map(entry => [entry.label, entry.check])).toEqual([["自动跟随", false], ["a", false], ["b", true]]);
  });

  it("WINDOW-13：有人在等的工地项后面带人数，没人等就用原名", () => {
    const waiting = [{ key: "D:/a", name: "a", waiting: 0 }, { key: "D:/b", name: "b", waiting: 2 }];
    const menu = appMenu(DEFAULT_MODES, true, { sites: waiting, pinned: null }).groups[2];
    expect(menu.entries.map(entry => entry.label)).toEqual(["自动跟随", "a", "b · 等你 2"]);
    expect(siteLabel({ name: "b", waiting: 1 })).toBe("b · 等你 1");
    expect(siteLabel({ name: "b", waiting: 0 })).toBe("b");
  });
  it("SITE-3：工地项点下去是钉住，自动跟随是取消钉住", () => {
    const menu = appMenu(DEFAULT_MODES, true, { sites, pinned: "D:/a" }).groups[2];
    expect(menu.entries.map(entry => menuDispatch(entry))).toEqual([
      { pin: null }, { pin: "D:/a" }, { pin: "D:/b" }]);
    expect(menuDispatch({ action: "demo", label: "演示模式" })).toEqual({ action: "demo" });
  });

  it("SITE-3：托盘里工地也是二级菜单，点第二个工地钉第二个", () => {
    const fired: Array<{ pin: string | null } | { action: string }> = [];
    const template = trayTemplate(appMenu(DEFAULT_MODES, true, { sites, pinned: null }), entry => fired.push(menuDispatch(entry)));
    const group = template.find(item => item.label === "工地");
    const items = (group?.submenu ?? []) as Array<{ label: string; type?: string; checked?: boolean; click?: () => void }>;
    expect(items.map(item => [item.label, item.type, item.checked]))
      .toEqual([["自动跟随", "checkbox", true], ["a", "checkbox", false], ["b", "checkbox", false]]);
    items[2].click?.();
    expect(fired).toEqual([{ pin: "D:/b" }]);
  });
});

describe("托盘菜单模板", () => {
  it("四组变二级菜单，设置、诊断和退出在分隔线下面", () => {
    const menu = appMenu(DEFAULT_MODES, true);
    const template = trayTemplate(menu, () => {});
    expect(template.map(item => item.type === "separator" ? "---" : item.label))
      .toEqual(["显示", "位置", "主题", "行为", "---", "设置…", "诊断", "退出"]);
    for (const item of template.slice(0, 4)) {
      expect(Array.isArray(item.submenu)).toBe(true);
    }
  });

  it("打勾的变勾选框，主题变单选，点菜单项把动作交回去", () => {
    const fired: string[] = [];
    const template = trayTemplate(appMenu({ ...DEFAULT_MODES, demo: true }, true), entry => fired.push(entry.action as string));
    const submenu = (label: string) => {
      const group = template.find(item => item.label === label);
      return (group?.submenu ?? []) as Array<{ label: string; type?: string; checked?: boolean; click?: () => void }>;
    };
    expect(submenu("行为").map(item => [item.label, item.type, item.checked])).toContainEqual(["演示模式", "checkbox", true]);
    expect(submenu("行为").map(item => [item.label, item.type, item.checked])).toContainEqual(["勿扰", "checkbox", false]);
    expect(submenu("显示")[0].type).toBeUndefined();
    submenu("显示")[0].click?.();
    submenu("行为").find(item => item.label === "演示模式")?.click?.();
    expect(fired).toEqual(["toggle", "demo"]);
  });
});

describe("二级菜单不出窗口", () => {
  it("放得下就不挪", () => {
    expect(submenuShift({ top: 400, bottom: 600 }, 720)).toBe(0);
  });

  it("顶到底边就往上挪，越过顶边就往下挪", () => {
    expect(submenuShift({ top: 600, bottom: 800 }, 720)).toBe(-88);
    expect(submenuShift({ top: -20, bottom: 180 }, 720)).toBe(28);
  });

  it("窗口再矮也至少留出上边距，不把首项顶出去", () => {
    expect(submenuShift({ top: 300, bottom: 520 }, 320)).toBe(-208);
    // 比窗口还高：先保住上边距，剩下靠菜单自己滚动
    expect(submenuShift({ top: 300, bottom: 900 }, 320)).toBe(-292);
    expect(submenuShift({ top: -50, bottom: 170 }, 320)).toBe(58);
  });
});
