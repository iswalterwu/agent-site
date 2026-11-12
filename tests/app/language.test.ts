import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, type App as VueApp } from "vue";
import type { AgentSiteApi, AppAsk, AppBootstrap, AppView } from "../../src/app/api";
import { backlogList, bandSummary, bandView, diagnosticsProblems, diagnosticsView, formatSince, openList, waitingList, workerView } from "../../src/app/cards";
import { fixtureSnapshot } from "../../src/app/fixture";
import { layoutFooter } from "../../src/app/footer";
import { setUiLocale, ui, uiLocale } from "../../src/app/i18n";
import { appMenu, menuDispatch, siteLabel, trayTemplate } from "../../src/app/menu";
import { DEFAULT_MODES, type AppModes } from "../../src/app/modes";
import { drawBuilding } from "../../src/app/draw";
import { layoutBuilding, bubbleLinesByWidth } from "../../src/app/layout";
import { BridgeService } from "../../src/main/bridge-service";
import { mkTmpDir } from "../harness/wait";
import path from "node:path";
import { TYPE } from "../../src/app/theme";
import type { SettingsDraft } from "../../src/app/settings-form";
import type { SiteSnapshot } from "../../src/core/types";

type HostNode = {
  type: string; text: string; children: HostNode[]; parent: HostNode | null;
  props: Record<string, unknown>; style: Record<string, string>;
  listeners: Map<string, (event: unknown) => void>;
  addEventListener(name: string, callback: (event: unknown) => void): void;
  removeEventListener(name: string): void;
  getContext(): CanvasRenderingContext2D | null;
};

// 仅替换 DOM 宿主：setup、响应式更新、VNode diff 和事件都跑真实 Vue 与 renderer.ts。
const host = vi.hoisted(() => {
  const state = { app: null as VueApp | null, context: null as CanvasRenderingContext2D | null };
  const node = (type: string, text = ""): HostNode => ({
    type, text, children: [], parent: null, props: {}, style: {}, listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
    getContext() { return state.context; },
  });
  return { state, node, root: node("root") };
});

vi.mock("vue", async importOriginal => {
  const vue = await importOriginal<typeof import("vue")>();
  const remove = (node: HostNode): void => {
    if (node.parent !== null) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
  };
  const renderer = vue.createRenderer<HostNode, HostNode>({
    createElement: type => host.node(type),
    createText: text => host.node("text", text),
    createComment: text => host.node("comment", text),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    patchProp: (node, key, _old, value) => { node.props[key] = value; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    remove,
    insert: (node, parent, anchor = null) => {
      remove(node);
      const index = anchor === null ? parent.children.length : parent.children.indexOf(anchor);
      parent.children.splice(index, 0, node);
      node.parent = parent;
    },
  });
  return { ...vue, createApp: (...args: Parameters<typeof renderer.createApp>) => {
    const app = renderer.createApp(...args);
    host.state.app = app;
    return { mount: () => app.mount(host.root) };
  } };
});

afterEach(() => {
  host.state.app?.unmount();
  host.state.app = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setUiLocale("zh-CN");
});

function painted(snapshot: SiteSnapshot): Array<{ text: string; font: string }> {
  const entries: Array<{ text: string; font: string }> = [];
  let font = "";
  const ctx = new Proxy({}, {
    get: (_target, key) => {
      if (key === "measureText") return (text: string) => ({ width: text.length * 3 });
      if (key === "fillText") return (text: string) => { entries.push({ text, font }); };
      return () => {};
    },
    set: (_target, key, value) => { if (key === "font") font = String(value); return true; },
  }) as CanvasRenderingContext2D;
  drawBuilding(ctx, layoutBuilding(snapshot, 360, undefined, uiLocale()));
  return entries;
}

describe("WINDOW-32、WINDOW-33：App 本地词条", () => {
  it("默认中文，英文菜单与原生托盘共用词条，工地原名不翻译", () => {
    expect(uiLocale()).toBe("zh-CN");
    expect(ui("设置")).toBe("设置");
    setUiLocale("en");
    const sites = { pinned: "a", sites: [
      { key: "a", name: "图纸读不出", waiting: 2 }, { key: "b", name: "办公室", waiting: 0 },
    ] };
    const menu = appMenu(DEFAULT_MODES, true, sites);
    expect(menu.groups.map(group => group.label)).toEqual(["Display", "Position", "Sites", "Theme", "Behavior"]);
    expect(menu.groups[2].entries.map(entry => entry.label)).toEqual(["Follow active site", "图纸读不出 · Waiting 2", "办公室"]);
    expect(menu.singles.map(entry => entry.label)).toEqual(["Settings…", "Diagnostics", "Quit"]);
    const plain = appMenu(DEFAULT_MODES, false);
    expect(JSON.stringify(plain)).not.toMatch(/\p{Script=Han}/u);
    expect(plain.groups[0].entries[0].label).toBe("Show");
    const run = vi.fn();
    const template = trayTemplate(menu, run);
    expect(template.map(item => item.label)).toEqual([...menu.groups.map(group => group.label), undefined, "Settings…", "Diagnostics", "Quit"]);
    const items = template[2].submenu as Array<{ label: string; click: () => void }>;
    items[1].click();
    expect(menuDispatch(run.mock.calls[0][0])).toEqual({ pin: "a" });
    expect(siteLabel({ name: "等你", waiting: 0 })).toBe("等你");
  });

  it("卡片翻角色、状态、风险、摘要和位置，不翻计划、待办、对话、动作或轨迹原文", () => {
    setUiLocale("en");
    const snapshot = fixtureSnapshot(0);
    const site = snapshot.sites[0];
    site.name = "中文工地";
    const raw = "可能：等你 / 停在：办公室 / 图纸读不出";
    const worker = site.workers.find(item => item.key === "pi:s1")!;
    worker.statusDetail = raw;
    worker.actions = [{ kind: "think", at: 0, text: raw }];
    worker.trace = [{ kind: "thinking", at: 0, text: raw }];
    worker.todos = [{ status: "in_progress", text: raw }];
    worker.lastTestFailure = { at: 0, text: raw };
    const view = workerView(site, worker.key)!;
    expect(view).toMatchObject({ title: "Foreman · data-layer S3", site: "中文工地", statusLabel: "Waiting",
      statusDetail: raw, actions: [{ text: raw }], trace: [{ text: raw }], todos: [{ text: raw }], testFailure: { text: raw } });
    const band = bandView(site, "data-layer")!;
    expect(band).toMatchObject({ title: "数据层", statusLabel: "In progress", risk: "Medium", current: { title: "行情快照" } });
    expect(bandSummary(band)).toEqual({ status: "In progress", people: "2 workers · Worker / Foreman",
      current: "S3 行情快照 3/5", acceptance: "AC 12 · Open 2", risk: "Risk Medium" });
    for (const [risk, label] of [["低", "Low"], ["中", "Medium"], ["高", "High"]] as const) {
      site.bands[0].card.risk = risk;
      expect(bandView(site, "data-layer")!.risk).toBe(label);
    }
    worker.location = { kind: "office", feature: "办公室" };
    expect(workerView(site, worker.key)!.location).toBe("Office 办公室");
    worker.location = { kind: "gate" };
    expect(workerView(site, worker.key)!.location).toBe("Site entrance");
    site.mini = true;
    expect(workerView(site, worker.key)!.location).toBe("中文工地");
  });

  it("篷布和空状态用枚举词条，待定、待做、等待项和外部错误保留原文且照旧脱敏", () => {
    setUiLocale("en");
    const snapshot = fixtureSnapshot(0);
    const site = snapshot.sites[0];
    const raw = "等你，图纸读不出 sk-abcdefgh12345678";
    site.open = [{ feature: "办公室", text: raw }];
    site.backlog = [raw];
    site.designer.waiting = [{ kind: "turn_end", key: "pi:a", since: 0, text: raw }];
    expect(openList(snapshot)[0]).toMatchObject({ feature: "办公室", text: "等你，图纸读不出 sk-***" });
    expect(backlogList(snapshot)[0].text).toBe("等你，图纸读不出 sk-***");
    expect(waitingList(snapshot).recent[0].text).toBe("等你，图纸读不出 sk-***");
    snapshot.sources.pi.lastError = raw;
    expect(diagnosticsProblems(diagnosticsView(snapshot, site))).toContain("pi: 等你，图纸读不出 sk-***");
    const band = site.bands[0];
    band.card = { title: null, risk: null, ac: null, open: null, openItems: null, slices: null,
      current: null, status: null, source: "none", specsDir: "D:/中文/图纸读不出" };
    for (const [tarp, label] of [["图纸读不出", "Blueprint unreadable"], ["图纸未拆切片", "No blueprint slices"]] as const) {
      band.tarp = tarp;
      expect(bandView(site, band.feature)).toMatchObject({ tarp: label, specsDir: "D:/中文/图纸读不出", statusLabel: "Unknown" });
      expect(bandSummary(bandView(site, band.feature)!)).toMatchObject({ status: label, people: "2 workers · Worker / Foreman", current: "No current slice" });
    }
    band.mini = true;
    expect(bandSummary(bandView(site, band.feature)!).status).toBe("No intent card");
    band.card.source = "todos";
    band.card.status = "done";
    band.card.slices = { done: 1, total: 1 };
    expect(bandSummary(bandView(site, band.feature)!)).toMatchObject({ status: "Session todos · Delivered", current: "No todo in progress", acceptance: "Todos 1/1", risk: "" });
  });

  it("相对时间覆盖边界，切回中文后恢复原有短句", () => {
    setUiLocale("en");
    expect([formatSince(0, 1), formatSince(0, -59_999), formatSince(0, -60_000),
      formatSince(0, -3_600_000), formatSince(0, -86_400_000)]).toEqual(["Just now", "Just now", "1 min ago", "1 hr ago", "1 d ago"]);
    setUiLocale("zh-CN");
    expect(formatSince(0, -120_000)).toBe("2 分钟前");
    expect(appMenu(DEFAULT_MODES, true).groups.map(group => group.label)).toEqual(["显示", "位置", "主题", "行为"]);
    expect(layoutFooter([], 360).legend.map(item => item.label)).toEqual(["等你", "出错", "停工", "在干", "空闲"]);
  });
});

it("WINDOW-34：英文气泡利用拉丁字符宽度，短问题不被中文字符预算截断", () => {
  const snapshot = fixtureSnapshot(0);
  const text = "Possibly: Build search or filters next?";
  snapshot.sites[0].workers.find(worker => worker.key === "pi:s1")!.bubble = text;
  const bubble = layoutBuilding(snapshot, 360, undefined, "en", value => value.length * 3).bubbles.find(item => item.key === "pi:s1")!;
  expect(bubble.lines).toHaveLength(2);
  expect(bubble.lines.join(" ")).toBe(text);
});

it("WINDOW-34：宽拉丁字母、假名和省略号按字宽留在气泡内", () => {
  const measure = (value: string) => Array.from(value).length * 5.5;
  for (const text of ["DOCUMENTATION DOCUMENTATION", "このまますすめてもよいですか？", "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW"]) {
    const lines = bubbleLinesByWidth(text, measure);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(66);
  }
});

it("WINDOW-32、WINDOW-34：布局的语言由参数决定，不读取展示层的可变语言", () => {
  const snapshot = fixtureSnapshot(0);
  const before = layoutBuilding(snapshot, 360);
  setUiLocale("en");
  expect(layoutBuilding(snapshot, 360)).toEqual(before);
  expect(layoutFooter([], 360).legend[0].label).toBe("等你");
  expect(layoutBuilding(snapshot, 360, undefined, "en").footer.legend[0].label).toBe("Wait");
});

it("WINDOW-34：五色英文图例同一行且避开齿轮，Canvas 标签不缩字号，用户中文原样保留", () => {
  setUiLocale("en");
  const snapshot = fixtureSnapshot(0);
  const layout = layoutBuilding(snapshot, 360, undefined, uiLocale());
  expect(layout.width * 2).toBe(220);
  expect(layout.footer.legend.map(item => item.label)).toEqual(["Wait", "Error", "Stall", "Work", "Idle"]);
  expect(new Set(layout.footer.legend.map(item => item.y)).size).toBe(1);
  for (let i = 1; i < layout.footer.legend.length; i++) {
    expect(layout.footer.legend[i].x).toBeGreaterThan(layout.footer.legend[i - 1].x + layout.footer.legend[i - 1].width);
  }
  expect(layout.footer.legend.at(-1)!.x + layout.footer.legend.at(-1)!.width).toBeLessThan(90);
  snapshot.sites[0].bands[0].feature = "图纸读不出";
  snapshot.sites[0].bands[1].tarp = "图纸未拆切片";
  const entries = painted(snapshot);
  expect(entries.map(item => item.text)).toEqual(expect.arrayContaining(["Office", "Designer", "图纸读不出", "No blueprint slices", "Wait", "Error", "Stall", "Work", "Idle"]));
  for (const entry of entries.filter(item => ["Wait", "Error", "Stall", "Work", "Idle"].includes(item.text))) {
    expect(entry.font).toContain(`${TYPE.caption}px`);
  }
  snapshot.sites = [];
  expect(painted(snapshot).map(item => item.text)).toEqual(expect.arrayContaining(["No blueprint", "Designer"]));
});

const descendants = (node: HostNode): HostNode[] => [node, ...node.children.flatMap(descendants)];
const content = (node: HostNode): string => node.text + node.children.map(content).join(" ");
const nodes = (): HostNode[] => descendants(host.root);
const button = (label: string): HostNode => nodes().find(node => node.type === "button" && content(node).trim() === label)!;
const fire = (node: HostNode, name: string, value?: string): void => {
  (node.props[name] as (event: unknown) => void)({ target: { value } });
};
const flush = async (): Promise<void> => { for (let i = 0; i < 3; i++) await nextTick(); };

it("WINDOW-32、WINDOW-33：真实 Vue 切语言重画，保留卡片、控制状态、建议和答案；设置只保存后切换", async () => {
  vi.useFakeTimers();
  const snapshot = fixtureSnapshot(0);
  const worker = snapshot.sites[0].workers.find(item => item.key === "pi:s1")!;
  worker.readOnly = false;
  worker.control = { online: true, paused: false, holding: null, idle: false };
  worker.statusDetail = "等你，保留中文对话";
  worker.actions = [{ kind: "read", text: "Read plan.md", at: 0 }];
  worker.trace = [{ kind: "thinking", text: "保留中文思考", at: 0 }];
  const view: AppView = { locale: "en", theme: "night", scale: 2, windowHeight: 720,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const boot: AppBootstrap = { ...view, snapshot, modes: { ...DEFAULT_MODES }, asks: [], hovered: true, pinned: snapshot.active };
  let onView!: (view: AppView) => void;
  let onAsks!: (asks: AppAsk[]) => void;
  let onSettings!: (payload: { draft: SettingsDraft } | null) => void;
  let onDiagnostics!: () => void;
  let onModes!: (modes: AppModes) => void;
  let onSnapshot!: (snapshot: SiteSnapshot) => void;
  const api: AgentSiteApi = {
    bootstrap: vi.fn(async () => boot),
    onView: callback => { onView = callback; }, onAsks: callback => { onAsks = callback; },
    onSettings: callback => { onSettings = callback; }, onDiagnostics: callback => { onDiagnostics = callback; },
    onModes: callback => { onModes = callback; }, onSnapshot: callback => { onSnapshot = callback; },
    onPinned: vi.fn(), onPointer: vi.fn(), onHover: vi.fn(), onSnap: vi.fn(),
    setRects: vi.fn(), setMenuOpen: vi.fn(), setCardOpen: vi.fn(), hit: vi.fn(), menuAction: vi.fn(), openSettings: vi.fn(), pinSite: vi.fn(),
    control: vi.fn(async () => ({ ok: false })), suggest: vi.fn(async () => ({ ok: true })),
    answerAsk: vi.fn(async () => ({ accepted: false })), saveSettings: vi.fn(async () => ({ ok: false, errors: ["Invalid setting"] })),
  };
  const events = new Map<string, (event: unknown) => void>();
  const documentElement = { lang: "zh-CN", dataset: {} };
  const texts: string[] = [];
  host.state.context = new Proxy({}, {
    get: (_target, key) => {
      if (key === "measureText") return (text: string) => ({ width: text.length * 3 });
      if (key === "fillText") return (text: string) => { texts.push(text); };
      return () => {};
    }, set: () => true,
  }) as CanvasRenderingContext2D;
  vi.stubGlobal("document", { documentElement, elementFromPoint: () => null });
  vi.stubGlobal("Element", class {});
  vi.stubGlobal("window", { agentSite: api, devicePixelRatio: 1, innerHeight: 720,
    setTimeout, clearTimeout, setInterval, clearInterval, confirm: vi.fn(() => true),
    addEventListener: (name: string, callback: (event: unknown) => void) => events.set(name, callback),
    removeEventListener: (name: string) => events.delete(name),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await import("../../src/app/renderer");
  await flush();
  expect(uiLocale()).toBe("en");
  expect(documentElement.lang).toBe("en");
  expect(texts).toContain("Wait");
  const canvas = nodes().find(node => node.type === "canvas")!;
  const clickLight = async (): Promise<void> => {
    const light = layoutBuilding(snapshot, 360, undefined, uiLocale()).footer.lights.find(item => item.key === worker.key)!;
    canvas.listeners.get("click")!({ clientX: 300 + (light.x + 6) * 2, clientY: (light.y + 6) * 2 });
    await flush();
  };
  await clickLight();
  expect(content(host.root)).toContain("Foreman");
  expect(content(host.root)).toContain("Control");
  expect(content(host.root)).toContain("Thinking");
  expect(content(host.root)).toContain("等你，保留中文对话");
  fire(nodes().find(node => node.type === "textarea")!, "onInput", "中文建议：图纸读不出");
  fire(nodes().find(node => node.type === "select")!, "onChange", "followUp");
  await flush();
  fire(button("Pause"), "onClick");
  await flush();
  expect(content(host.root)).toContain("Control failed");
  onView({ ...view, locale: "zh-CN" });
  await flush();
  expect(content(host.root)).toContain("控制失败");
  expect(nodes().find(node => node.type === "textarea")!.props.value).toBe("中文建议：图纸读不出");
  expect(nodes().find(node => node.type === "select")!.props.value).toBe("followUp");
  expect(texts).toContain("等你");
  onView(view);
  await flush();
  expect(button("Pause")).toBeDefined();
  expect(api.setCardOpen).toHaveBeenCalledTimes(1);

  // 实际服务返回的程序错误带来源标识，缓存后仍随当前界面语言重新取词。
  const service = new BridgeService({ file: path.join(mkTmpDir(), "bridge.json"), repos: [] });
  const programError = await service.command("missing", { type: "pause" });
  expect(programError.error).toBe("会话不在线");
  vi.mocked(api.control).mockResolvedValueOnce(programError);
  fire(button("Pause"), "onClick");
  await flush();
  expect(content(host.root)).toContain("Session is not online");
  onView({ ...view, locale: "zh-CN" });
  await flush();
  expect(content(host.root)).toContain("会话不在线");
  onView(view);
  await flush();
  expect(content(host.root)).toContain("Session is not online");
  // 同样的文字若来自外部错误，不按内容猜测词条，更不翻译原文。
  vi.mocked(api.control).mockResolvedValueOnce({ ok: false, error: "会话不在线" });
  fire(button("Pause"), "onClick");
  await flush();
  expect(content(host.root)).toContain("会话不在线");
  vi.mocked(api.control).mockResolvedValueOnce({ ok: false });
  fire(button("Pause"), "onClick");
  await flush();
  expect(content(host.root)).toContain("Control failed");
  service.stop();

  const ask: AppAsk = { askId: "ask-a", sessionKey: worker.key, sessionId: "s1", question: "等你，要哪个方案？",
    context: "中文背景 sk-abcdefgh12345678", options: ["图纸读不出", ""], allowOther: true };
  onAsks([ask]);
  await flush();
  expect(content(host.root)).toContain("Decision · Foreman");
  expect(content(host.root)).toContain("等你，要哪个方案？");
  expect(content(host.root)).toContain("中文背景 sk-***");
  expect(button("图纸读不出")).toBeDefined();
  expect(button("Option 2")).toBeDefined();
  fire(nodes().find(node => node.type === "textarea")!, "onInput", "中文答案：办公室");
  await flush();
  onView({ ...view, locale: "zh-CN" });
  await flush();
  expect(nodes().find(node => node.type === "textarea")!.props.value).toBe("中文答案：办公室");
  onView(view);
  await flush();
  fire(button("Send this answer"), "onClick");
  await flush();
  expect(api.answerAsk).toHaveBeenCalledWith("ask-a", "中文答案：办公室");
  expect(content(host.root)).toContain("Could not send answer");
  vi.mocked(api.answerAsk).mockResolvedValueOnce(service.answer("missing", null));
  fire(button("Send this answer"), "onClick");
  await flush();
  expect(content(host.root)).toContain("This decision has ended");
  onView({ ...view, locale: "zh-CN" });
  await flush();
  expect(content(host.root)).toContain("这个决策已经结束");
  onView(view);
  await flush();
  expect(content(host.root)).toContain("This decision has ended");
  onModes({ ...DEFAULT_MODES, demo: true });
  await flush();
  expect(content(host.root)).toContain("Decision content is hidden in demo mode");
  expect(content(host.root)).not.toContain(ask.question);
  onModes({ ...DEFAULT_MODES });
  await flush();
  expect(nodes().find(node => node.type === "textarea")!.props.value).toBe("中文答案：办公室");

  const draft: SettingsDraft = { language: "en", theme: "night", style: "tower", autostart: false,
    idleMinutes: 10, stalledMinutes: 30, onsiteHours: 24, repos: 'D:/中文/图纸读不出 = "工地 sk-abcdefgh12345678"' };
  onSettings({ draft });
  await flush();
  expect(content(host.root)).toContain("Settings");
  expect(content(host.root)).toContain("Default style");
  expect(nodes().find(node => node.type === "textarea")!.props.value).toBe(draft.repos);
  const languageSelect = (): HostNode => nodes().find(node => node.type === "select")!;
  expect(languageSelect().children.map(content)).toEqual(["System", "Chinese", "English"]);
  fire(languageSelect(), "onChange", "zh-CN");
  await flush();
  expect(uiLocale()).toBe("en");
  fire(button("Save"), "onClick");
  await flush();
  expect(uiLocale()).toBe("en");
  expect(content(host.root)).toContain("Invalid setting");
  vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error("中文错误 sk-abcdefgh12345678"));
  fire(button("Save"), "onClick");
  await flush();
  expect(content(host.root)).toContain("Save failed: 中文错误 sk-***");
  onView({ ...view, locale: "zh-CN" });
  await flush();
  expect(content(host.root)).toContain("保存失败：中文错误 sk-***");
  onView(view);
  await flush();
  vi.mocked(api.saveSettings).mockImplementationOnce(async () => { onView({ ...view, locale: "zh-CN" }); return { ok: true }; });
  fire(button("Save"), "onClick");
  await flush();
  expect(api.saveSettings).toHaveBeenLastCalledWith({ ...draft, language: "zh-CN" });
  expect(uiLocale()).toBe("zh-CN");
  expect(documentElement.lang).toBe("zh-CN");
  expect(content(host.root)).toContain("已保存");
  expect(languageSelect().children.map(content)).toEqual(["跟随系统", "简体中文", "English"]);
  fire(nodes().find(node => node.props["aria-label"] === "关闭卡片")!, "onClick");
  await flush();
  await clickLight();
  expect(nodes().find(node => node.type === "textarea")!.props.value).toBe("中文建议：图纸读不出");
  expect(button("暂停")).toBeDefined();
  fire(button("打开决策卡"), "onClick");
  await flush();
  expect(nodes().find(node => node.type === "textarea")!.props.value).toBe("中文答案：办公室");
  onView(view);
  await flush();
  expect(nodes().find(node => node.type === "textarea")!.props.value).toBe("中文答案：办公室");

  onDiagnostics();
  await flush();
  expect(content(host.root)).toContain("Diagnostics");
  expect(content(host.root)).toContain("Bad lines 0 · Unknown 0");
  onSettings(null);
  await flush();
  expect(content(host.root)).toContain("Settings have not loaded yet");
  fire(nodes().find(node => node.props["aria-label"] === "Close card")!, "onClick");
  await flush();
  events.get("keydown")!({ key: "Escape" });
  const band = layoutBuilding(snapshot, 360, undefined, uiLocale()).bands[0];
  events.get("mousemove")!({ clientX: 300 + 108 * 2, clientY: (band.y + band.height / 2) * 2, target: null });
  await flush();
  expect(content(host.root)).toContain("Click to expand");
  expect(content(host.root)).toContain("Acceptance");
  vi.advanceTimersByTime(5000);
  await flush();
  expect(content(host.root)).toContain("Locked · Click to expand");

  // 全英文源数据逐屏检查，防止只断言几个标签而漏掉其他程序中文。
  const english = structuredClone(snapshot);
  const site = english.sites[0];
  site.name = "Example";
  site.bands.forEach(band => {
    band.card.title = "Feature";
    if (band.card.current !== null) band.card.current.title = "Current slice";
  });
  site.office.forEach(office => { office.card.title = "Office feature"; });
  site.workers.forEach(item => {
    item.bubble = "Waiting for an answer";
    item.statusDetail = "Original session text";
    item.trace = [{ kind: "thinking", at: 0, text: "Original thinking" }];
    item.actions = [{ kind: "read", at: 0, text: "Read plan.md" }];
    item.todos = [{ status: "in_progress", text: "Original todo" }];
    item.lastTestFailure = null;
  });
  site.designer.waiting.forEach(item => { item.text = "Waiting for an answer"; });
  site.open = [{ feature: "Feature", text: "Choose a storage format" }];
  site.backlog = ["Add export"];
  onAsks([]);
  onSnapshot(english);
  await flush();
  const noProgramChinese = (): void => {
    expect(content(host.root)).not.toMatch(/\p{Script=Han}/u);
    for (const node of nodes()) {
      for (const name of ["title", "aria-label", "placeholder"]) {
        expect(String(node.props[name] ?? "")).not.toMatch(/\p{Script=Han}/u);
      }
    }
  };
  noProgramChinese();
  fire(nodes().find(node => String(node.props.class).startsWith("summary"))!, "onClick");
  await flush();
  fire(nodes().find(node => node.props["aria-label"] === "Open site menu")!, "onClick");
  await flush();
  fire(button("Position"), "onClick");
  await flush();
  expect(button("Attach to right display")).toBeDefined();
  noProgramChinese();
  fire(nodes().find(node => node.props["aria-label"] === "Open site menu")!, "onClick");
  await flush();
  const controlled = site.workers.find(item => item.key === worker.key)!;
  controlled.control = { online: true, paused: true, holding: { tool: "bash", sinceMs: 0 }, idle: false };
  controlled.lastTestFailure = { at: 0, text: "Test failed" };
  onSnapshot(english);
  await clickLight();
  // 草稿仍然是用户原文；只在这个全英文检查段主动清空它们。
  fire(nodes().find(node => node.type === "textarea")!, "onInput", "");
  await flush();
  expect(content(host.root)).toContain("Paused · Holding bash");
  expect(content(host.root)).toContain("Issues");
  expect(button("Resume")).toBeDefined();
  onView({ ...view, locale: "zh-CN" });
  await flush();
  expect(content(host.root)).toContain("已暂停 · 拦在 bash");
  expect(button("继续")).toBeDefined();
  onView(view);
  await flush();
  expect(button("Resume")).toBeDefined();
  noProgramChinese();
  onAsks([{ ...ask, askId: "english-ask", question: "Which design?", context: "Original context", options: ["A long English option that should wrap normally without reducing the font size", "Another option"] }]);
  await flush();
  expect(button("Cancel this question")).toBeDefined();
  noProgramChinese();
  vi.mocked(api.answerAsk).mockResolvedValueOnce({ accepted: true });
  fire(button("Another option"), "onClick");
  await flush();
  expect(content(host.root)).toContain("Sent. Waiting for confirmation");
  expect(button("Another option").props.disabled).toBe(true);
  onView({ ...view, locale: "zh-CN" });
  await flush();
  expect(content(host.root)).toContain("已交给桥接");
  onView(view);
  await flush();
  expect(button("Another option").props.disabled).toBe(true);
  noProgramChinese();
  onSettings({ draft: { ...draft, repos: "D:/example" } });
  await flush();
  noProgramChinese();
  onDiagnostics();
  await flush();
  noProgramChinese();
  onAsks([]);
  const designer = layoutBuilding(english, 360, undefined, uiLocale()).designer;
  canvas.listeners.get("click")!({ clientX: 300 + (designer.x + 4) * 2, clientY: (designer.y + 4) * 2 });
  await flush();
  expect(content(host.root)).toContain("Waiting list");
  expect(content(host.root)).toContain("Open items in intent cards");
  expect(content(host.root)).toContain("Site backlog");
  noProgramChinese();
  onModes({ ...DEFAULT_MODES, demo: true });
  await flush();
  expect(content(host.root)).toContain("1 open item (text hidden in demo mode)");
  noProgramChinese();
});
