import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, Tray, type Display, type NativeImage, type Rectangle } from "electron";
import os from "node:os";
import path from "node:path";
import { appDataDir, loadSettings, writeSettings, type Settings } from "../main/settings";
import { LOGICAL_WIDTH } from "./constants";
import type { AppAsk, AppBootstrap, AppHit, AppRect, AppView, AskResult, ControlAction, ControlResult, MenuAction, SaveSettingsResult } from "./api";
import { draftOf, fromDraft, mergeSettings, parseDraft, engineSettingsChanged, type SettingsDraft } from "./settings-form";
import { resolveLocale, localizedError, type MessageKey } from "../core/i18n";
import { setUiLocale, ui, uiLocale } from "./i18n";
import { chooseDisplay, chooseRightDisplay, displayView } from "./display";
import { SiteEngine } from "../main/engine";
import { visibleSnapshot } from "./visibility";
import { applyBridgeControl } from "./bridge-overlay";
import { BridgeService, type BridgeCommand } from "../main/bridge-service";
import { appendCommand } from "../main/command-ledger";
import type { SiteSnapshot } from "../core/types";
import { hitWindow, windowContains } from "./hit";
import { appMenu, menuDispatch, siteMenuOf, siteMenuSignature, trayTemplate, type MenuEntry, type SiteMenu } from "./menu";
import { planAlerts, planNotices, type SeenAsk } from "./notify";
import { applyPin } from "./sites";
import { currentSiteKey, pauseIntent, SHORTCUTS, siteSessions } from "./shortcuts";
import { applyAutostart, loginItem } from "./autostart";
import { DEFAULT_MODES, isModeAction, showWaitingDot, toggleMode, windowOpacity, type AppModes, type ModeAction } from "./modes";
import type { AppScale } from "./window";
import type { ThemeName } from "./theme";
import { CARD_WIDTH, snapBounds, windowBounds } from "./window";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let interactive = false;
let windowHovered = false;
let cardOpen = false;
let menuOpen = false;
let moveTimer: NodeJS.Timeout | null = null;
let ignoreMoveUntil = 0;
let hitRects: AppRect[] = [];
let shown = false;
const scale: AppScale = 2;
let followPrimary = true;
let modes: AppModes = { ...DEFAULT_MODES };
let waiting = false;
let baseImage: NativeImage | null = null;
let waitingImage: NativeImage | null = null;
let targetId: number | null = null;
let view: AppView = { scale: 2, workArea: { x: 0, y: 0, width: 0, height: 1 }, windowHeight: 1, theme: "night", locale: "zh-CN" };
/** 配色：菜单里切，默认来自 settings.json 的 theme */
let theme: ThemeName = "night";
let activeEngine: SiteEngine | null = null;
/** 当前生效的设置；面板保存后它就是新的那份 */
let currentSettings: Settings | null = null;
let stopSnapshots: (() => void) | null = null;
let latestSource: SiteSnapshot | null = null;
let visibleCurrent: SiteSnapshot | null = null;
let visibleTimer: NodeJS.Timeout | null = null;
let bridgeService: BridgeService | null = null;
/** 见过的决策：同一条只响一次，从列表里消失一小时后才忘掉（断线重发、休眠后重连都不再响） */
let seenAsks = new Map<string, SeenAsk>();
/** 正在提醒的状态组合（`<会话键>:<种类>`）：只在进入状态那一轮弹一次，解除后重新武装 */
let activeAlerts = new Set<string>();
/** 上一轮在线且暂停着的会话：用来认出"暂停中掉线" */
let pausedSessions = new Set<string>();
const iconPath = path.join(__dirname, "icon.png");
const waitingIconPath = path.join(__dirname, "icon-waiting.png");

app.setAppUserModelId("agent-site");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => { showWindow(); });
  app.on("window-all-closed", () => { app.quit(); });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopSnapshots?.();
    stopSnapshots = null;
    bridgeService?.stop();
    bridgeService = null;
    activeEngine?.stop();
    activeEngine = null;
    if (visibleTimer !== null) clearInterval(visibleTimer);
    visibleTimer = null;
  });
  app.whenReady().then(startApp).catch((error: unknown) => {
    console.error("[agent-site] failed to start:", error);
    app.quit();
  });
}

async function startApp(): Promise<void> {
  const { settings, diagnostics } = loadSettings(appDataDir(process.env), app.getLocale());
  currentSettings = settings;
  setUiLocale(resolveLocale(settings.language, app.getLocale()));
  theme = settings.theme;
  for (const message of diagnostics) console.warn(`[agent-site] ${message}`);
  const home = os.homedir();
  const engine = new SiteEngine({
    settings: { ...settings, locale: uiLocale() }, diagnostics,
    roots: {
      pi: path.join(home, ".pi", "agent", "sessions"),
      claude: path.join(home, ".claude", "projects"),
      dsh: path.join(home, ".dsh", "sessions"),
    },
  });
  const bridge = new BridgeService({
    file: path.join(appDataDir(process.env), "bridge.json"),
    repos: [],
    locale: uiLocale,
    onChange: () => {
      if (latestSource !== null) publishSnapshot(latestSource);
      publishAsks();
    },
  });
  bridgeService = bridge;
  await bridge.start().catch((error: unknown) => {
    console.error("[agent-site] bridge service failed to start:", error);
    bridge.stop();
    bridgeService = null;
  });
  activeEngine = engine;
  stopSnapshots = engine.onSnapshot(snapshot => publishSnapshot(snapshot));
  await engine.start().catch((error: unknown) => {
    console.error("[agent-site] engine failed to start:", error);
  });
  createWindow(settings, engine);
  registerShortcuts();
  // 开机自启：settings.json 说开就注册，说关就撤掉。失败（或者被策略静默拦掉）只提示一句，不影响 App 启动
  const wanted = loginItem(settings.autostart, {
    packaged: app.isPackaged, execPath: process.execPath, mainFile: path.join(__dirname, "main.cjs"),
  });
  const loginStatus = applyAutostart({
    desired: settings.autostart, settings: wanted,
    set: (item) => { app.setLoginItemSettings(item); },
    get: (item) => app.getLoginItemSettings(item),
  });
  if (loginStatus !== "ok") {
    console.warn(`[agent-site] ${ui("开机自启{action}没有生效（{status}）：可能是系统策略或权限限制，其它功能不受影响", { action: ui(settings.autostart ? "注册" : "撤销"), status: loginStatus })}`);
  }
  visibleTimer = setInterval(() => {
    if (latestSource !== null) publishSnapshot(latestSource);
  }, 60_000);
}

/** 可见投影：旧等待 / 空闲过期时，即使引擎没有新快照也要重新推给窗口和托盘 */
function publishSnapshot(snapshot: SiteSnapshot): void {
  latestSource = snapshot;
  void bridgeService?.setSites(snapshot.sites.map(site => site.path));
  // 钉住的工地消失时 applyPin 把 pin 清掉，从这里起就回到自动跟随；窗内菜单的勾选要跟着变
  const pinned = applyPin(snapshot, pinnedSite);
  if (pinned.pinned !== pinnedSite) {
    pinnedSite = pinned.pinned;
    win?.webContents.send("app:pinned", pinnedSite);
  }
  const controlled = applyBridgeControl(pinned.snapshot, bridgeService?.sessions() ?? []);
  const visible = visibleSnapshot(controlled, Date.now());
  notifyAsks(visible);
  if (visible !== visibleCurrent) {
    visibleCurrent = visible;
    if (win !== null && !win.isDestroyed()) win.webContents.send("app:snapshot", visible);
    publishAsks();
    const nextWaiting = visible.sites.some(site => site.workers.some(worker => worker.status === "waiting"));
    if (nextWaiting !== waiting) { waiting = nextWaiting; updateTrayIcon(); }
  }
  const menuSites = siteMenuSignature(siteMenu());
  // 托盘菜单跟着可见投影走：工地增减、钉住状态、每个工地的等待数（含定时过期）都要能反映出来
  if (menuSites !== traySites) { traySites = menuSites; rebuildTray(); }
}

function createWindow(settings: Settings, engine: SiteEngine): void {
  const initial = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  targetId = initial.id;
  followPrimary = false;
  view = displayView(initial, scale, theme, uiLocale()).view;

  win = new BrowserWindow({
    ...windowBounds(view.workArea, view.scale),
    title: "agent-site",
    icon: iconPath,
    frame: true,
    titleBarStyle: "hidden",
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    focusable: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => { event.preventDefault(); });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(`[renderer] ${event.message}`);
  });
  win.webContents.on("preload-error", (_event, preload, error) => {
    console.error("[preload]", preload, error);
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("[load]", code, description, url);
  });

  ipcMain.handle("app:bootstrap", (event): AppBootstrap => {
    if (event.sender !== win?.webContents) throw new Error("unexpected sender");
    // 引擎可能已经被设置面板重开过：这里要问当前的，不能用建窗时捕获的那个的旧快照
    // 引擎重开后首轮扫描没完成时 snapshot() 是空的：先用最后一次发布过的快照，别把画面清空、钉住也别丢
    latestSource = latestSource ?? activeEngine?.snapshot() ?? engine.snapshot();
    const pinned = applyPin(latestSource, pinnedSite);
    pinnedSite = pinned.pinned;
    const controlled = applyBridgeControl(pinned.snapshot, bridgeService?.sessions() ?? []);
    visibleCurrent = visibleSnapshot(controlled, Date.now());
    return { ...view, snapshot: visibleCurrent, modes, hovered: windowHovered, asks: bridgeService?.asks() ?? [],
      pinned: pinnedSite };
  });
  ipcMain.handle("app:control", async (event, value: unknown): Promise<ControlResult> => {
    if (event.sender !== win?.webContents) return { ok: false, error: "unexpected sender" };
    const request = parseControl(value);
    if (request === null) return { ok: false, ...localizedError(uiLocale(), "无效的控制") };
    return runControl(request.key, { type: request.action });
  });
  ipcMain.handle("app:suggest", async (event, value: unknown): Promise<ControlResult> => {
    if (event.sender !== win?.webContents) return { ok: false, error: "unexpected sender" };
    const request = parseSuggest(value);
    if (request === null) return { ok: false, ...localizedError(uiLocale(), "建议不能为空，也不能超过 4000 字") };
    return runControl(request.key, { type: "suggest", text: request.text, mode: request.mode });
  });
  ipcMain.handle("app:open-settings", (event) => {
    if (event.sender !== win?.webContents) return;
    win?.webContents.send("app:settings", settingsForPanel());
  });
  ipcMain.handle("app:save-settings", (event, value: unknown): SaveSettingsResult => {
    if (event.sender !== win?.webContents) return { ok: false, errors: [ui("意外的调用方")] };
    return saveSettings(value);
  });
  ipcMain.handle("app:answer", (event, value: unknown): AskResult => {
    if (event.sender !== win?.webContents) return { accepted: false, reason: "unexpected sender" };
    const request = parseAnswer(value);
    if (request === null) return answerFailure("无效的回答");
    if (bridgeService === null) return answerFailure("桥接服务未启动");
    return bridgeService.answer(request.askId, request.value);
  });
  ipcMain.on("app:rects", (event, value: unknown) => {
    if (event.sender !== win?.webContents) return;
    const rects = parseRects(value);
    if (rects !== null) hitRects = rects;
  });
  ipcMain.on("app:hit", (event, value: unknown) => {
    if (event.sender !== win?.webContents) return;
    parseHit(value);
  });
  ipcMain.on("app:menu-action", (event, value: unknown) => {
    if (event.sender !== win?.webContents) return;
    const action = parseMenuAction(value);
    if (action !== null) runMenuAction(action);
  });
  ipcMain.on("app:pin-site", (event, value: unknown) => {
    if (event.sender !== win?.webContents) return;
    if (value === null || typeof value === "string") pinSite(value);
  });
  ipcMain.on("app:menu-open", (event, value: unknown) => {
    if (event.sender !== win?.webContents) return;
    if (typeof value === "boolean") menuOpen = value;
  });
  ipcMain.on("app:card-open", (event, value: unknown) => {
    if (event.sender !== win?.webContents) return;
    if (typeof value === "boolean") setCardOpen(value);
  });
  win.on("show", rebuildTray);
  win.on("hide", rebuildTray);
  win.on("minimize", rebuildTray);
  win.on("restore", rebuildTray);
  watchMoveEnd(win);
  win.on("hide", () => setWindowHovered(false));
  win.on("minimize", () => setWindowHovered(false));
  win.on("closed", () => {
    win = null; interactive = false; windowHovered = false; cardOpen = false; menuOpen = false;
    if (moveTimer !== null) clearTimeout(moveTimer);
    moveTimer = null;
    rebuildTray();
  });
  win.once("ready-to-show", show);
  win.webContents.once("did-finish-load", show);
  screen.on("display-added", onDisplayChange);
  screen.on("display-removed", onDisplayChange);
  screen.on("display-metrics-changed", onDisplayChange);
  createTray();
  applyDisplay();
  setInterval(syncHit, 16);
  void win.loadFile(path.join(__dirname, "index.html"));
}

/**
 * 全局快捷键：唤起 / 收起窗口，暂停 / 继续当前工地。
 * 注册失败（被别的程序占了、或者平台不支持）只提示一句，App 照常跑。
 */
function registerShortcuts(): void {
  const bind = (accelerator: string, run: () => void): void => {
    try {
      if (globalShortcut.register(accelerator, () => { void run(); })) return;
      console.warn(`[agent-site] ${ui("快捷键 {key} 注册失败：可能被别的程序占用", { key: accelerator })}`);
    } catch (error) {
      console.warn(`[agent-site] ${ui("快捷键 {key} 注册失败:", { key: accelerator })}`, error);
    }
  };
  bind(SHORTCUTS.toggleWindow, () => { toggleWindow(); });
  bind(SHORTCUTS.pauseSite, () => pauseCurrentSite());
}

/** 暂停 / 继续当前工地：有一个在暂停就全部继续，否则全部暂停 */
async function pauseCurrentSite(): Promise<void> {
  // 用未过滤的快照：可见投影会藏掉 6 小时没动静的等待 / 空闲会话，而它们可能还桥接在线、还暂停着
  const snapshot = latestSource;
  const service = bridgeService;
  if (snapshot === null || service === null) return;
  const sessions = siteSessions(snapshot, service.sessions(), currentSiteKey(snapshot, pinnedSite));
  const intent = pauseIntent(sessions);
  if (intent === "none") return;
  await Promise.all(sessions.map(session => runControl(session.key, { type: intent })));
}

function show(): void {
  if (shown) return;
  shown = true;
  showWindow();
}

function showWindow(): void {
  if (win === null) return;
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true, "floating");
  win.showInactive();
  setBoundsQuiet(windowBounds(view.workArea, view.scale));
  win.moveTop();
  applyOpacity();
  rebuildTray();
}

function toggleWindow(): void {
  if (win === null) return;
  if (win.isMinimized() || !win.isVisible()) { showWindow(); return; }
  win.minimize();
}

function applyDisplay(): void {
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  if (!followPrimary && !all.some(display => display.id === targetId)) followPrimary = true;
  const target = chooseDisplay(all, primary.id, followPrimary, targetId);
  targetId = target.id;
  const next = displayView(target, scale, theme, uiLocale());
  view = next.view;
  if (win !== null) {
    setBoundsQuiet(next.bounds);
    win.webContents.send("app:view", view);
    win.moveTop();
  }
  rebuildTray();
}

function onDisplayChange(): void {
  applyDisplay();
}

/** Windows 拖动结束时才发的窗口消息；拖动中途停顿不发 */
const WM_EXITSIZEMOVE = 0x0232;

/** 吸附要等用户真的放下窗口：拖动中每次停顿都会触发 move，拿它当结束会在拖动中途就把窗口吸回并收起 */
function watchMoveEnd(target: BrowserWindow): void {
  if (process.platform !== "win32") {
    target.on("move", onWindowMove);
    return;
  }
  target.hookWindowMessage(WM_EXITSIZEMOVE, () => { finishMove(); });
}

/** 程序自己改窗口位置也会触发 move；别把它当成用户拖到右缘 */
function setBoundsQuiet(bounds: Rectangle): void {
  if (win === null) return;
  if (moveTimer !== null) { clearTimeout(moveTimer); moveTimer = null; }
  ignoreMoveUntil = Date.now() + 300;
  win.setBounds(bounds);
}

/** 非 Windows 的兜底：拖动停下 120 ms 后算结束 */
function onWindowMove(): void {
  if (Date.now() < ignoreMoveUntil) return;
  if (moveTimer !== null) clearTimeout(moveTimer);
  moveTimer = setTimeout(finishMove, 120);
}

/** 拖动停下后按窗口多数所在的屏切换目标屏，并把靠右缘或越界的窗口吸回右缘、通知渲染层收起 */
function finishMove(): void {
  moveTimer = null;
  if (win === null) return;
  let bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  if (display.id !== targetId) {
    targetId = display.id;
    followPrimary = false;
    const next = displayView(display, scale, theme);
    view = next.view;
    win.webContents.send("app:view", view);
    if (bounds.height !== next.bounds.height) {
      const area = next.view.workArea;
      const height = next.bounds.height;
      const y = Math.floor(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)));
      setBoundsQuiet({ x: bounds.x, y, width: next.bounds.width, height });
      bounds = win.getBounds();
    }
  }
  const snapped = snapBounds(bounds, display.workArea, LOGICAL_WIDTH * scale + CARD_WIDTH);
  if (snapped !== null) {
    if (snapped.x !== bounds.x || snapped.width !== bounds.width) setBoundsQuiet(snapped);
    win.webContents.send("app:snap");
  }
  rebuildTray();
}

/** 主进程轮询光标，只让楼体、顶栏和右下角齿轮接鼠标，其余透明区继续穿透。 */
function syncHit(): void {
  if (win === null || !win.isVisible() || win.isMinimized()) return;
  const bounds = win.getContentBounds();
  const point = screen.getCursorScreenPoint();
  // 窗口左边一直留着卡片位；没开卡片时那块不算「在窗内」，否则停在透明区也不收起。
  // 菜单会展开到卡片位上，开着菜单时整窗都算在窗内。
  const hover = cardOpen || menuOpen ? bounds : { ...bounds, x: bounds.x + CARD_WIDTH, width: bounds.width - CARD_WIDTH };
  setWindowHovered(windowContains(point, hover));
  const hit = hitWindow(point, bounds, hitRects);
  if (hit === interactive) return;
  interactive = hit;
  win.setIgnoreMouseEvents(!hit, { forward: true });
  win.webContents.send("app:pointer", hit);
}

/** 指针是否在整窗范围里；半透明和卡片悬停都用它，而不是命中矩形 */
function setWindowHovered(value: boolean): void {
  if (value === windowHovered) return;
  windowHovered = value;
  win?.webContents.send("app:hover", value);
  applyOpacity();
}

/** 半透明只在指针不在整窗范围里时生效；不改穿透 */
function applyOpacity(): void {
  if (win === null) return;
  win.setOpacity(windowOpacity(modes, windowHovered));
}

/** 卡片位一直在窗口里，开卡片只改命中矩形和「在窗内」的范围，不动窗口尺寸。 */
function setCardOpen(open: boolean): void {
  cardOpen = open;
}

function runMenuAction(action: MenuAction): void {
  if (action === "diagnostics") { openDiagnostics(); return; }
  if (action === "settings") { openSettings(); return; }
  if (isModeAction(action)) { setMode(action); return; }
  if (action === "toggle") toggleWindow();
  else if (action === "attach-right") attachRight();
  else if (action === "primary") moveTo(screen.getPrimaryDisplay(), true);
  else if (action === "cursor") moveTo(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), false);
  else if (action === "theme-night") setThemeMode("night");
  else if (action === "theme-day") setThemeMode("day");
  else app.quit();
}

/**
 * 切配色：菜单里改的是这一次运行的；`settings.json` 的 theme 决定下次启动从哪套开始。
 * 只把新配色发给渲染层并重建菜单——不走 `applyDisplay()`，否则会把拖到别处的窗口吸回右缘、还顺带抢焦点。
 */
function setThemeMode(next: ThemeName): void {
  if (next === theme) return;
  theme = next;
  view = { ...view, theme };
  win?.webContents.send("app:view", view);
  rebuildTray();
}

function moveTo(display: Pick<Display, "id">, follow: boolean): void {
  followPrimary = follow;
  targetId = display.id;
  applyDisplay();
  showWindow();
}

function attachRight(): void {
  if (win === null) return;
  const current = screen.getDisplayMatching(win.getBounds());
  const target = chooseRightDisplay(screen.getAllDisplays(), current.id);
  moveTo(target, false);
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn("[agent-site] tray icon missing");
    return;
  }
  baseImage = image;
  const dotImage = nativeImage.createFromPath(waitingIconPath);
  waitingImage = dotImage.isEmpty() ? null : dotImage;
  tray = new Tray(image);
  tray.on("click", toggleWindow);
  updateTrayIcon();
  rebuildTray();
}

function updateTrayIcon(): void {
  if (tray === null || baseImage === null) return;
  const dot = showWaitingDot(modes, waiting) && waitingImage !== null;
  tray.setImage(dot ? waitingImage! : baseImage);
  tray.setToolTip(dot ? ui("agent-site · 有人等你") : "agent-site");
}

function setMode(action: ModeAction): void {
  modes = toggleMode(modes, action);
  applyOpacity();
  updateTrayIcon();
  rebuildTray();
  win?.webContents.send("app:modes", modes);
}

function openDiagnostics(): void {
  showWindow();
  win?.webContents.send("app:diagnostics");
}

function openSettings(): void {
  // 窗口已经显示时不再 showWindow()：它会把拖到别处的窗口吸回右缘，指针落到窗外、卡片立刻被收起
  if (win === null || !win.isVisible() || win.isMinimized()) showWindow();
  win?.webContents.send("app:settings", settingsForPanel());
}

/** 面板要的那几个键：阈值、自启、配色、造型 */
function settingsForPanel(): { draft: SettingsDraft } | null {
  return currentSettings === null ? null : { draft: draftOf(currentSettings) };
}

/**
 * 保存设置：先把表单折回设置对象，有错就把错退回面板（不写文件、不改运行状态）；
 * 没错就写 settings.json、重新读一遍，再把能当场生效的（配色、自启）应用上；
 * 阈值影响引擎的状态判断，所以引擎停掉重开。
 */
function saveSettings(value: unknown): SaveSettingsResult {
  const draft = parseDraft(value);
  if (draft === null) return { ok: false, errors: [ui("设置的内容不完整")] };
  if (currentSettings === null) return { ok: false, errors: [ui("设置还没读出来，等一下再存")] };
  const parsed = fromDraft(draft, uiLocale());
  if ("errors" in parsed) return { ok: false, errors: parsed.errors };
  const next = mergeSettings(currentSettings, parsed.settings);
  try {
    writeSettings(appDataDir(process.env), next);
  } catch (error) {
    return { ok: false, errors: [ui("写不进 settings.json：{error}", { error: (error as Error).message })] };
  }
  const previous = currentSettings;
  currentSettings = next;
  applySavedSettings(next, previous);
  return { ok: true };
}

/** 存完之后当场生效的那部分；引擎重开拿到新的阈值 */
function applySavedSettings(next: Settings, previous: Settings): void {
  const locale = resolveLocale(next.language, app.getLocale());
  if (locale !== uiLocale()) {
    setUiLocale(locale);
    view = { ...view, locale };
    win?.webContents.send("app:view", view);
    updateTrayIcon();
    rebuildTray();
  }
  if (theme !== next.theme) setThemeMode(next.theme);
  const item = loginItem(next.autostart, {
    packaged: app.isPackaged, execPath: process.execPath, mainFile: path.join(__dirname, "main.cjs"),
  });
  const loginStatus = applyAutostart({
    desired: next.autostart, settings: item,
    set: (value) => { app.setLoginItemSettings(value); },
    get: (value) => app.getLoginItemSettings(value),
  });
  if (loginStatus !== "ok") console.warn(`[agent-site] ${ui("开机自启设置没有生效（{status}）", { status: loginStatus })}`);
  if (engineSettingsChanged(previous, next)) void restartEngine(next);
  else void activeEngine?.setLocale(locale, []).catch((error: unknown) => console.error("[agent-site] language refresh failed:", error));
}

/** 引擎按新设置重开：旧的不再读日志，新的把现有会话重扫一遍 */
async function restartEngine(next: Settings): Promise<void> {
  stopSnapshots?.();
  stopSnapshots = null;
  activeEngine?.stop();
  activeEngine = null;
  const engine = new SiteEngine({
    settings: { ...next, locale: uiLocale() }, diagnostics: [],
    roots: {
      pi: path.join(os.homedir(), ".pi", "agent", "sessions"),
      claude: path.join(os.homedir(), ".claude", "projects"),
      dsh: path.join(os.homedir(), ".dsh", "sessions"),
    },
  });
  activeEngine = engine;
  stopSnapshots = engine.onSnapshot(snapshot => publishSnapshot(snapshot));
  await engine.start().catch((error: unknown) => {
    console.error("[agent-site] engine restart failed:", error);
  });
}

/** 钉住的工地（内存）；null 表示跟着最近有事件的工地走 */
let pinnedSite: string | null = null;
/** 托盘菜单里那份工地列表 + 钉住的工地：变了才重建菜单 */
let traySites = "";

/** 菜单里的工地列表：只有一个工地时不给这一组，免得为了没得选的东西多点一次 */
function siteMenu(): SiteMenu | null {
  // 用可见投影：过期的等待会话不该继续在菜单里报数
  const source = visibleCurrent ?? latestSource;
  return source === null ? null : siteMenuOf(source, pinnedSite);
}

/** 点菜单：普通项交给 runMenuAction，工地项钉住或改回自动跟随 */
function chooseMenu(entry: MenuEntry): void {
  const what = menuDispatch(entry);
  if ("pin" in what) pinSite(what.pin);
  else runMenuAction(what.action);
}

function pinSite(key: string | null): void {
  pinnedSite = key;
  win?.webContents.send("app:pinned", pinnedSite);
  if (latestSource !== null) publishSnapshot(latestSource);
  rebuildTray();
}

/** 托盘菜单和齿轮菜单同一个模型：四组二级菜单，诊断和退出单列 */
function buildMenu(): Menu {
  const visible = win !== null && !win.isMinimized() && win.isVisible();
  return Menu.buildFromTemplate(trayTemplate(appMenu(modes, visible, siteMenu(), theme), chooseMenu));
}

function rebuildTray(): void {
  if (tray === null) return;
  tray.setContextMenu(buildMenu());
}

function parseRects(value: unknown): AppRect[] | null {
  if (!Array.isArray(value)) return null;
  const rects: AppRect[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { x, y, width, height } = item as Record<string, unknown>;
    if (![x, y, width, height].every(n => typeof n === "number" && Number.isFinite(n))) return null;
    if ((width as number) <= 0 || (height as number) <= 0) return null;
    rects.push({ x: x as number, y: y as number, width: width as number, height: height as number });
  }
  return rects;
}

function parseControl(value: unknown): { key: string; action: ControlAction } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { key, action } = value as Record<string, unknown>;
  return typeof key === "string" && key !== "" && (action === "pause" || action === "resume" || action === "abort")
    ? { key, action } : null;
}

function answerFailure(key: MessageKey): AskResult {
  const { error, messageKey } = localizedError(uiLocale(), key);
  return { accepted: false, reason: error, messageKey };
}

function parseAnswer(value: unknown): { askId: string; value: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { askId, value: answer } = value as Record<string, unknown>;
  if (typeof askId !== "string" || askId === "") return null;
  if (answer === null) return { askId, value: null };
  return typeof answer === "string" ? { askId, value: answer } : null;
}

function parseSuggest(value: unknown): { key: string; text: string; mode: "steer" | "followUp" } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { key, text, mode } = value as Record<string, unknown>;
  const trimmed = typeof text === "string" ? text.trim() : "";
  return typeof key === "string" && key !== "" && trimmed !== "" && trimmed.length <= 4000
    && (mode === "steer" || mode === "followUp") ? { key, text: trimmed, mode } : null;
}

function publishAsks(): void {
  if (win === null || win.isDestroyed()) return;
  win.webContents.send("app:asks", bridgeService?.asks() ?? []);
}

/**
 * 决策提问到达时弹一条系统通知：窗口有焦点（或还没建好）时只登记、不弹——卡片就在他眼前，
 * 启动时快照里的旧提问也不算"刚来"。惦记过的 askId 记一小时：桥接断线会清空提问列表，
 * 宽限期内重连会重发同一个 askId，不能再弹一次。勿扰不弹；演示模式给占位正文。
 */
function notifyAsks(visible: SiteSnapshot): void {
  const asks = bridgeService?.asks() ?? [];
  const suppressed = win === null || win.isDestroyed() || win.isFocused();
  const { notices, seen } = planNotices({
    snapshot: visible, asks, seen: seenAsks, focused: suppressed,
    demo: modes.demo, dnd: modes.dnd, now: Date.now(), locale: uiLocale(),
  });
  seenAsks = seen;
  // 等你 / 停住 / 断线时还暂停着：只在进入状态那一轮弹一次
  const alerts = planAlerts({
    snapshot: visible, asks, sessions: bridgeService?.sessions() ?? [], paused: pausedSessions, active: activeAlerts,
    focused: suppressed, demo: modes.demo, dnd: modes.dnd, locale: uiLocale(),
  });
  activeAlerts = alerts.active;
  pausedSessions = alerts.paused;
  if (!Notification.isSupported()) return; // 没有通知服务：卡片照旧在窗口里
  for (const item of [...notices, ...alerts.alerts]) {
    const notify = new Notification({ title: item.title, body: item.body });
    notify.on("click", () => {
      showWindow();
      // showWindow 用 showInactive，不抢焦点；点通知的人就是要看这条，这里补一次聚焦
      if (win !== null && !win.isDestroyed()) win.focus();
    });
    notify.show();
  }
}

async function runControl(key: string, command: BridgeCommand): Promise<ControlResult> {
  const result = bridgeService === null
    ? { ok: false, ...localizedError(uiLocale(), "桥接服务未启动") }
    : await bridgeService.command(key, command);
  try {
    appendCommand(path.join(appDataDir(process.env), "commands.jsonl"), {
      at: new Date().toISOString(), session: key, type: command.type, ok: result.ok,
      ...(command.type === "suggest" ? { text: command.text, mode: command.mode } : {}),
      ...(result.error === undefined ? {} : { error: result.error }),
    });
  } catch (error) {
    console.error("[agent-site] command ledger failed:", error);
  }
  return result;
}

function parseMenuAction(value: unknown): MenuAction | null {
  const actions: MenuAction[] = ["toggle", "attach-right", "primary", "cursor", "theme-night", "theme-day", "settings", "quit",
    "auto-hide", "translucent", "waiting-dot", "demo", "dnd", "pause-animation", "diagnostics"];
  return actions.find(action => action === value) ?? null;
}

function parseHit(value: unknown): AppHit | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "office" || kind === "designer") return { kind };
  if (kind === "worker" || kind === "bubble" || kind === "light") {
    const key = (value as { key?: unknown }).key;
    return typeof key === "string" ? { kind, key } : null;
  }
  if (kind === "band" && typeof (value as { feature?: unknown }).feature === "string") return { kind, feature: (value as { feature: string }).feature };
  return null;
}
