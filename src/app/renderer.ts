import { createApp, h, onBeforeUnmount, onMounted, ref, type VNode } from "vue";
import { activeSite } from "../core/site";
import type { SiteSnapshot, TraceEntry } from "../core/types";
import type { AppAsk, AppRect, AppView, MenuAction } from "./api";
import type { SettingsDraft } from "./settings-form";
import { draftPayload } from "./draft-payload";
import { backlogList, bandSummary, bandView, diagnosticsProblems, diagnosticsView, featureExists, formatSince, openList, waitingList, workerCardSite, workerView, type BandCardView, type OpenRow, type WorkerCardView } from "./cards";
import { canAutoCollapse, ribbonSegments, segmentAt, shouldScheduleCollapse, summaryBox, RIBBON_WIDTH, SUMMARY_LOCK_MS } from "./collapse";
import { TONE_LABEL } from "./footer";
import { animationsPaused, DEFAULT_MODES, type AppModes } from "./modes";
import { appMenu, menuDispatch, siteMenuOf, submenuShift, type MenuEntry, type MenuGroupId, type SiteMenu } from "./menu";
import { drawBuilding, drawExitingWorker, drawRibbon } from "./draw";
import { hitTest, layoutBuilding, withoutBubbles, type BuildingLayout, type LayoutHit, type LayoutWorker } from "./layout";
import { canvasGeometry } from "./scale";
import { setTheme, themeName, TOPBAR_HEIGHT } from "./theme";
import type { ThemeName } from "./theme";
import { departedWorkers, exitAlpha, exitProgress, exitX, WALK_OUT_MS } from "./transitions";
import { CARD_WIDTH } from "./window";
import { redact } from "../core/redact";
import { clearSent, emptyDrafts, modeFor, setMode, setText, textFor, type SuggestionDrafts } from "./suggestions";

type CardSelection = { kind: "band"; feature: string } | { kind: "worker"; key: string; site: string } | { kind: "waiting" }
  | { kind: "diagnostics" } | { kind: "settings" } | { kind: "ask"; askId: string };
interface Hover { feature: string; y: number; height: number }

const SUMMARY_WIDTH = 204;
const SUMMARY_HEIGHT = 204;
const TRACE_LABEL: Record<TraceEntry["kind"], string> = {
  prompt: "提示", text: "回复", thinking: "思考", tool_call: "工具", tool_result: "结果",
  model: "模型", compaction: "压缩", api_error: "报错",
};
const COLLAPSE_MS = 3000;

const App = {
  setup() {
    const canvas = ref<HTMLCanvasElement | null>(null);
    const menuOpen = ref(false);
    /** 当前展开的二级菜单；指针停在组上 120 ms 也会展开 */
    const openGroup = ref<MenuGroupId | null>(null);
    let groupTimer: number | null = null;
    const card = ref<CardSelection | null>(null);
    /** 设置面板：面板里的草稿、错误和"已保存"提示 */
    const draft = ref<SettingsDraft | null>(null);
    const errors = ref<string[]>([]);
    const saved = ref(false);
    const collapsed = ref(false);
    const hover = ref<Hover | null>(null);
    const summaryLocked = ref(false);
    const modes = ref<AppModes>({ ...DEFAULT_MODES });
    const snapshotRev = ref(0);
    /** 钉住的工地键；null 表示跟着最近有事件的工地走 */
    const pinned = ref<string | null>(null);
    let snapshot: SiteSnapshot | null = null;
    let view: AppView | null = null;
    /** 配色是响应式的：托盘里换了主题，窗内菜单的勾选要跟着变（`view` 不是响应式的） */
    const theme = ref<ThemeName>("night");
    let layout: BuildingLayout | null = null;
    let cleanup: (() => void) | null = null;
    let summaryRect: AppRect | null = null;
    let blinkOn = true;
    let blinkTimer: number | null = null;
    let collapseTimer: number | null = null;
    let summaryLockTimer: number | null = null;
    let windowHovered = false;
    /** 指针还没进过整窗时，不自动收起：刚打开就缩成彩带会被当成闪退 */
    let everHovered = false;
    let lastWorkers: LayoutWorker[] = [];
    let stableX = new Map<string, number>();
    let exits: Array<{ worker: LayoutWorker; started: number }> = [];
    let exitFrame: number | null = null;
    const controlBusy = ref<string | null>(null);
    const controlError = ref<{ key: string; text: string } | null>(null);
    const drafts = ref<SuggestionDrafts>(emptyDrafts());
    const asks = ref<AppAsk[]>([]);
    const askBusy = ref<string | null>(null);
    const askError = ref<{ askId: string; text: string } | null>(null);
    const askAccepted = ref<Record<string, boolean>>({});
    /** 在卡片上点了"取消这个提问"的：桥接会把它当明确跳过，模型按自己的判断继续 */
    const askCancelled = ref<Record<string, boolean>>({});
    const askDrafts = ref<Record<string, string>>({});
    let knownAsks = new Set<string>();

    /** 窗口左边一直留着卡片位，画布永远在卡片位右边 */
    const offsetX = (): number => CARD_WIDTH;

    const sendControl = async (key: string, action: "pause" | "resume" | "abort"): Promise<void> => {
      if (controlBusy.value !== null) return;
      controlBusy.value = key;
      controlError.value = null;
      try {
        const result = await window.agentSite.control(key, action);
        if (!result.ok) controlError.value = { key, text: result.error ?? "控制失败" };
      } catch {
        controlError.value = { key, text: "控制失败" };
      } finally {
        if (controlBusy.value === key) controlBusy.value = null;
      }
    };

    const sendAbort = (key: string): void => {
      if (controlBusy.value !== null) return;
      if (!window.confirm("立即中断这个会话？正在运行的一步会被中止。")) return;
      void sendControl(key, "abort");
    };

    const sendSuggest = async (key: string): Promise<void> => {
      const text = textFor(drafts.value, key).trim();
      if (text === "" || controlBusy.value !== null) return;
      const mode = modeFor(drafts.value, key);
      controlBusy.value = key;
      controlError.value = null;
      try {
        const result = await window.agentSite.suggest(key, text, mode);
        if (result.ok) drafts.value = clearSent(drafts.value, key, text);
        else controlError.value = { key, text: result.error ?? "建议发送失败" };
      } catch {
        controlError.value = { key, text: "建议发送失败" };
      } finally {
        if (controlBusy.value === key) controlBusy.value = null;
      }
    };
    const answerAsk = async (askId: string, value: string | null): Promise<void> => {
      if (askBusy.value !== null) return;
      askBusy.value = askId;
      askError.value = null;
      try {
        const result = await window.agentSite.answerAsk(askId, value);
        if (result.accepted) {
          askAccepted.value = { ...askAccepted.value, [askId]: true };
          if (value === null) askCancelled.value = { ...askCancelled.value, [askId]: true };
        }
        else askError.value = { askId, text: result.reason ?? "回答失败" };
      } catch {
        askError.value = { askId, text: "回答失败" };
      } finally {
        if (askBusy.value === askId) askBusy.value = null;
      }
    };

    const summaryPlacement = (): AppRect | null => {
      if (hover.value === null || view === null || layout === null) return null;
      const box = summaryBox(hover.value, view.scale, layout.width * view.scale, view.windowHeight,
        SUMMARY_WIDTH, SUMMARY_HEIGHT);
      return { ...box, x: box.x + offsetX() };
    };

    const syncBlink = (on: boolean): void => {
      if (on && blinkTimer === null) {
        blinkTimer = window.setInterval(() => { blinkOn = !blinkOn; draw(); }, 800);
      } else if (!on && blinkTimer !== null) {
        window.clearInterval(blinkTimer);
        blinkTimer = null;
        blinkOn = true;
      }
    };

    /** 切配色：Canvas 的调色板和 CSS 变量一起换，菜单、按钮这些 DOM 也跟着变 */
    const applyTheme = (next: ThemeName): void => {
      theme.value = next;
      if (next === themeName()) return;
      setTheme(next);
      document.documentElement.dataset.theme = next;
    };

    const draw = (): void => {
      const element = canvas.value;
      if (element === null || snapshot === null || view === null) return;
      const built = layoutBuilding(snapshot, view.windowHeight / view.scale, stableX);
      stableX = new Map(built.workers.map(worker => [worker.key, worker.x]));
      const next = modes.value.demo ? withoutBubbles(built) : built;
      layout = next;
      const geometry = canvasGeometry(next.width, next.height, view.scale, window.devicePixelRatio);
      if (element.width !== geometry.bitmapWidth) element.width = geometry.bitmapWidth;
      if (element.height !== geometry.bitmapHeight) element.height = geometry.bitmapHeight;
      // 写同样的值也会让浏览器重算样式和布局，画布会重上一帧；只在真的变了才写
      if (element.style.width !== `${geometry.cssWidth}px`) element.style.width = `${geometry.cssWidth}px`;
      if (element.style.height !== `${geometry.cssHeight}px`) element.style.height = `${geometry.cssHeight}px`;
      const context = element.getContext("2d");
      if (context === null) return;
      context.setTransform(geometry.drawScaleX, 0, 0, geometry.drawScaleY, 0, 0);
      syncExits(next);
      if (collapsed.value) drawRibbon(context, next, blinkOn);
      else {
        drawBuilding(context, next, blinkOn);
        for (const exit of exits) {
          const progress = exitProgress(exit.started, performance.now());
          drawExitingWorker(context, exit.worker, exitX(exit.worker, next.width, progress), exitAlpha(progress));
        }
      }
      summaryRect = summaryPlacement();
      window.agentSite.setRects(hitRects(next, geometry.cssWidth, geometry.cssHeight, menuOpen.value,
        offsetX(), card.value !== null, collapsed.value, summaryRect));
      syncBlink(!animationsPaused(modes.value) && (collapsed.value
        ? next.bands.some(band => band.ribbon === "orange")
        : next.footer.lights.some(light => light.tone === "waiting")));
    };

    const cancelCollapse = (): void => {
      if (collapseTimer !== null) window.clearTimeout(collapseTimer);
      collapseTimer = null;
    };

    const clearSummaryLock = (): void => {
      if (summaryLockTimer !== null) window.clearTimeout(summaryLockTimer);
      summaryLockTimer = null;
      summaryLocked.value = false;
    };

    const armSummaryLock = (): void => {
      clearSummaryLock();
      summaryLockTimer = window.setTimeout(() => {
        summaryLockTimer = null;
        summaryLocked.value = true;
        draw();
      }, SUMMARY_LOCK_MS);
    };

    const syncExits = (next: BuildingLayout): void => {
      const gone = departedWorkers(lastWorkers, next.workers);
      if (gone.length > 0) {
        const now = performance.now();
        for (const worker of gone) {
          if (!exits.some(exit => exit.worker.key === worker.key)) exits.push({ worker, started: now });
        }
      }
      const live = new Set(next.workers.map(worker => worker.key));
      exits = exits.filter(exit => !live.has(exit.worker.key));
      lastWorkers = next.workers;
      if (exits.length > 0 && exitFrame === null) exitFrame = requestAnimationFrame(animateExits);
    };

    const animateExits = (): void => {
      exitFrame = null;
      const now = performance.now();
      exits = exits.filter(exit => now - exit.started < WALK_OUT_MS);
      draw();
      if (exits.length > 0 && exitFrame === null) exitFrame = requestAnimationFrame(animateExits);
    };

    const clearGroupTimer = (): void => {
      if (groupTimer !== null) window.clearTimeout(groupTimer);
      groupTimer = null;
    };

    const closeMenu = (): void => {
      clearGroupTimer();
      openGroup.value = null;
      if (!menuOpen.value) return;
      menuOpen.value = false;
      // 菜单展开到左边卡片位上；开着菜单时主进程把整窗都算「在窗内」
      window.agentSite.setMenuOpen(false);
    };

    const closeGroup = (): void => {
      clearGroupTimer();
      openGroup.value = null;
    };

    const collapse = (force: boolean): void => {
      if (!force && !canAutoCollapse(snapshot, card.value !== null)) return;
      cancelCollapse();
      closeMenu();
      hover.value = null;
      clearSummaryLock();
      collapsed.value = true;
      draw();
    };

    const scheduleCollapse = (): void => {
      cancelCollapse();
      if (!shouldScheduleCollapse(windowHovered, collapsed.value, snapshot, card.value !== null, modes.value.autoHide, everHovered)) return;
      collapseTimer = window.setTimeout(() => { collapseTimer = null; collapse(false); }, COLLAPSE_MS);
    };

    /** 快照更新不能把已经跑着的 3 秒收起计时重新拨回；只有条件变化后才重新起表 */
    const ensureCollapse = (): void => {
      if (collapseTimer === null) scheduleCollapse();
    };

    const expand = (): void => {
      cancelCollapse();
      hover.value = null;
      clearSummaryLock();
      collapsed.value = false;
      draw();
    };

    const setCard = (next: CardSelection | null): void => {
      const wasOpen = card.value !== null;
      const isOpen = next !== null;
      card.value = next;
      closeMenu();
      if (wasOpen !== isOpen) window.agentSite.setCardOpen(isOpen);
      if (isOpen) cancelCollapse();
      else if (!windowHovered) scheduleCollapse();
      draw();
    };

    const showAsk = (askId: string): void => {
      if (collapsed.value) expand();
      setCard({ kind: "ask", askId });
    };

    const applyAsks = (next: AppAsk[]): void => {
      const fresh = next.find(ask => !knownAsks.has(ask.askId));
      knownAsks = new Set([...knownAsks, ...next.map(ask => ask.askId)]);
      asks.value = next;
      const accepted = { ...askAccepted.value };
      const cancelled = { ...askCancelled.value };
      for (const askId of Object.keys(accepted)) {
        if (!next.some(ask => ask.askId === askId)) delete accepted[askId];
      }
      for (const askId of Object.keys(cancelled)) {
        if (!next.some(ask => ask.askId === askId)) delete cancelled[askId];
      }
      askAccepted.value = accepted;
      askCancelled.value = cancelled;
      const current = card.value;
      if (current?.kind === "ask" && !next.some(ask => ask.askId === current.askId)) {
        const first = next[0];
        if (first === undefined || modes.value.demo) setCard(null);
        else showAsk(first.askId);
      } else if (fresh !== undefined && current?.kind !== "ask" && !modes.value.demo) {
        showAsk(fresh.askId);
      }
    };

    /** 同一个楼段 / 小人再点一次就关掉卡片 */
    const sameCard = (a: CardSelection, b: CardSelection): boolean => {
      if (a.kind === "band" && b.kind === "band") return a.feature === b.feature;
      if (a.kind === "worker" && b.kind === "worker") return a.key === b.key && a.site === b.site;
      return a.kind === b.kind;
    };

    const openHit = (hit: LayoutHit): void => {
      let next: CardSelection | null = null;
      if (hit.kind === "band") next = { kind: "band", feature: hit.feature };
      else if (hit.kind === "worker" || hit.kind === "bubble") {
        if (hit.site !== null) next = { kind: "worker", key: hit.key, site: hit.site };
      } else if (hit.kind === "light") {
        // 灯是全部工地混排的：点别的工地的灯只开那个小人的卡，当前工地不切换
        next = { kind: "worker", key: hit.key, site: hit.site };
      } else if (hit.kind === "designer") next = { kind: "waiting" };
      else if (hit.kind === "office") {
        const feature = snapshot === null ? undefined : activeSite(snapshot)?.office[0]?.feature;
        if (feature !== undefined) next = { kind: "band", feature };
      }
      if (next === null) return;
      if (card.value !== null && sameCard(card.value, next)) setCard(null);
      else setCard(next);
    };

    const hitAt = (event: MouseEvent): LayoutHit | null =>
      layout === null || view === null
        ? null
        : hitTest(layout, (event.clientX - offsetX()) / view.scale, event.clientY / view.scale);

    const installClick = (): void => {
      if (cleanup !== null) return;
      const element = canvas.value;
      if (element === null) return;
      const overUi = (event: MouseEvent): boolean => {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        return target instanceof Element && target.closest("[data-agent-ui]") !== null;
      };
      const onClick = (event: MouseEvent): void => {
        if (overUi(event)) return;
        if (collapsed.value) {
          const segment = collapsedSegment(event);
          if (segment !== null) expand();
          return;
        }
        const hit = hitAt(event);
        if (hit !== null) openHit(hit);
      };
      element.addEventListener("click", onClick);
      cleanup = () => { element.removeEventListener("click", onClick); };
    };

    const collapsedSegment = (event: MouseEvent) => {
      if (layout === null || view === null) return null;
      const x = (event.clientX - offsetX()) / view.scale;
      const y = event.clientY / view.scale;
      return x >= layout.width - RIBBON_WIDTH ? segmentAt(ribbonSegments(layout), y) : null;
    };

    const onMouseMove = (event: MouseEvent): void => {
      if (!collapsed.value || card.value !== null || layout === null || view === null) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-agent-summary]") !== null) return;
      const x = (event.clientX - offsetX()) / view.scale;
      const segment = x >= layout.width - RIBBON_WIDTH ? segmentAt(ribbonSegments(layout), event.clientY / view.scale) : null;
      if (segment !== null) {
        if (hover.value?.feature === segment.feature) return;
        // 锁定后不跟着鼠标换段，摘要留在原处
        if (summaryLocked.value) return;
        hover.value = { feature: segment.feature, y: segment.y, height: segment.height };
        armSummaryLock();
        draw();
        return;
      }
      if (hover.value !== null && !summaryLocked.value) {
        clearSummaryLock();
        hover.value = null;
        draw();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (menuOpen.value) {
        // Esc 逐级关：先收二级菜单，再关整张菜单
        if (openGroup.value !== null) closeGroup();
        else closeMenu();
        draw();
        return;
      }
      if (card.value !== null) { setCard(null); return; }
      if (hover.value !== null && collapsed.value) {
        clearSummaryLock();
        hover.value = null;
        draw();
        return;
      }
      if (!collapsed.value) collapse(true);
    };

    const choose = (entry: MenuEntry): void => {
      closeMenu();
      draw();
      const what = menuDispatch(entry);
      if ("pin" in what) window.agentSite.pinSite(what.pin);
      else window.agentSite.menuAction(what.action);
    };

    onMounted(async () => {
      window.agentSite.onView((next) => { view = next; applyTheme(next.theme); draw(); });
      window.agentSite.onPinned((next) => { pinned.value = next; if (!collapsed.value) draw(); });
      window.agentSite.onModes((next) => {
        modes.value = next;
        if (!next.autoHide) cancelCollapse();
        else if (!windowHovered) scheduleCollapse();
        draw();
      });
      window.agentSite.onDiagnostics(() => {
        collapsed.value = false;
        setCard({ kind: "diagnostics" });
      });
      window.agentSite.onSettings((payload) => {
        collapsed.value = false;
        draft.value = payload?.draft ?? null;
        errors.value = [];
        saved.value = false;
        setCard({ kind: "settings" });
      });
      window.agentSite.onPointer((inside) => {
        if (inside || hover.value === null || summaryLocked.value) return;
        clearSummaryLock();
        hover.value = null;
        draw();
      });
      window.agentSite.onHover((inside) => {
        windowHovered = inside;
        if (inside) { everHovered = true; cancelCollapse(); return; }
        // 卡片是悬停状的：指针离开整窗就关，不等计时
        if (card.value !== null) setCard(null);
        if (hover.value !== null && !summaryLocked.value) {
          clearSummaryLock();
          hover.value = null;
        }
        scheduleCollapse();
        draw();
      });
      window.agentSite.onSnap(() => {
        if (!modes.value.autoHide) return;
        if (card.value !== null) setCard(null);
        collapse(true);
      });
      window.agentSite.onAsks(applyAsks);
      window.agentSite.onSnapshot((next) => {
        snapshot = next;
        snapshotRev.value += 1;
        const nextSite = activeSite(next);
        if (hover.value !== null && (nextSite === null || !featureExists(nextSite, hover.value.feature))) {
          clearSummaryLock();
          hover.value = null;
        }
        const current = card.value;
        // 小人卡跟着它自己的工地：别的工地的更新不影响它，只有那个工地里这个小人离场才关
        if (current?.kind === "worker" && workerCardSite(next, current) === null) {
          setCard(null);
        } else if (current?.kind === "band" && (nextSite === null || !featureExists(nextSite, current.feature))) {
          setCard(null);
        } else {
          draw();
        }
        if (card.value === null && !windowHovered) ensureCollapse();
      });
      window.addEventListener("resize", draw);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("keydown", onKeyDown);
      try {
        const boot = await window.agentSite.bootstrap();
        if (snapshot === null || boot.snapshot.at >= snapshot.at) snapshot = boot.snapshot;
        snapshotRev.value += 1;
        modes.value = boot.modes;
        pinned.value = boot.pinned;
        windowHovered = boot.hovered;
        everHovered = boot.hovered;
        view = { scale: boot.scale, workArea: boot.workArea, windowHeight: boot.windowHeight, theme: boot.theme };
        applyTheme(boot.theme);
        applyAsks(boot.asks);
        draw();
        installClick();
      } catch (error) {
        console.error("renderer failed", error);
      }
    });

    onBeforeUnmount(() => {
      window.removeEventListener("resize", draw);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      cleanup?.();
      if (blinkTimer !== null) window.clearInterval(blinkTimer);
      if (exitFrame !== null) cancelAnimationFrame(exitFrame);
      cancelCollapse();
      clearSummaryLock();
      closeMenu();
    });

    const toggleMenu = (): void => {
      if (menuOpen.value) { closeMenu(); draw(); return; }
      menuOpen.value = true;
      window.agentSite.setMenuOpen(true);
      draw();
    };

    const toggleGroup = (id: MenuGroupId): void => {
      if (groupTimer !== null) window.clearTimeout(groupTimer);
      groupTimer = null;
      openGroup.value = openGroup.value === id ? null : id;
      requestAnimationFrame(fitSubmenu);
      draw();
    };

    const hoverGroup = (id: MenuGroupId): void => {
      if (openGroup.value === id) return;
      // 换组要重新计 120 ms，不能沿用上一组还没到点的计时器
      clearGroupTimer();
      groupTimer = window.setTimeout(() => {
        groupTimer = null;
        openGroup.value = id;
        requestAnimationFrame(fitSubmenu);
        draw();
      }, MENU_HOVER_MS);
    };

    /** 指针离开整张菜单：只收二级菜单，菜单本身留着 */
    const leaveMenu = (): void => {
      if (groupTimer !== null) clearGroupTimer();
      if (openGroup.value === null) return;
      openGroup.value = null;
      draw();
    };

    const submenuEl = ref<HTMLElement | null>(null);

    /** 二级菜单默认贴着所属组；会顶出窗口时上下挪回来 */
    function fitSubmenu(): void {
      const element = submenuEl.value;
      if (element === null) return;
      element.style.transform = "";
      const shift = submenuShift(element.getBoundingClientRect(), window.innerHeight);
      element.style.transform = shift === 0 ? "" : `translateY(${shift}px)`;
    }
    const MENU_HOVER_MS = 120;
    return () => [
      h("canvas", { ref: canvas }),
      card.value === null ? null : renderCard(),
      collapsed.value && hover.value !== null && summaryRect !== null ? renderSummary() : null,
      !collapsed.value && modes.value.demo ? h("div", { class: "demo-tag", "data-agent-ui": "demo",
        style: { left: `${offsetX() + 8}px` } }, "演示") : null,
      collapsed.value ? null : h("div", {
        class: "drag", "data-agent-ui": "drag", title: "拖动窗口",
        style: { left: `${offsetX()}px`, right: "0" },
      }, [h("span", { class: "grip" })]),
      collapsed.value ? null : h("button", {
        class: "gear icon-button", type: "button", "data-agent-ui": "menu", "aria-label": "打开工地菜单",
        title: "工地菜单", onClick: toggleMenu,
      }, [icon("gear")]),
      !collapsed.value && menuOpen.value ? renderMenu() : null,
    ];

    /** 菜单里的工地：只有一个工地时不给这一组；人数按可见快照算（主进程推过来的已经是可见投影） */
    function sitesMenu(): SiteMenu | null {
      snapshotRev.value; // 菜单开着时快照更新（比如等你的会话增减）也要跟着重画
      return snapshot === null ? null : siteMenuOf(snapshot, pinned.value);
    }

    function renderMenu(): VNode {
      // 齿轮在窗口里，窗口这时一定是显示着的，所以「显示」组里写的是隐藏
      const menu = appMenu(modes.value, true, sitesMenu(), theme.value);
      return h("div", { class: "menu", role: "menu", "data-agent-ui": "menu", onMouseleave: leaveMenu }, [
        ...menu.groups.map((group, index) => h("div", {
          class: "menu-group", key: group.id,
          onMouseenter: () => hoverGroup(group.id),
          onMouseleave: clearGroupTimer,
        }, [
          h("button", {
            class: openGroup.value === group.id ? "menu-item open" : "menu-item", type: "button",
            role: "menuitem", "aria-haspopup": "menu", "aria-expanded": openGroup.value === group.id ? "true" : "false",
            onClick: () => toggleGroup(group.id),
          }, [h("span", null, group.label), icon("arrow")]),
          openGroup.value === group.id
            ? h("div", {
              // 最后一组靠近窗口底边，二级菜单先按往上顶排；还不够高时 fitSubmenu 再挪
              class: index === menu.groups.length - 1 ? "submenu up" : "submenu",
              role: "menu", "data-agent-ui": "menu", ref: submenuEl,
            }, group.entries.map(menuButton))
            : null,
        ])),
        h("div", { class: "menu-sep", role: "separator" }),
        ...menu.singles.map(entry => h("div", { class: "menu-group", key: entry.action }, menuButton(entry))),
      ]);
    }

    function menuButton(entry: MenuEntry): VNode {
      const role = entry.radio === true ? "menuitemradio" : entry.check === undefined ? "menuitem" : "menuitemcheckbox";
      return h("button", {
        class: "menu-item", type: "button", role,
        "aria-checked": entry.check === undefined ? undefined : entry.check ? "true" : "false",
        onClick: () => choose(entry),
      }, `${entry.check === true ? "✓ " : ""}${entry.label}`);
    }

    function renderCard(): VNode | null {
      if (card.value === null || snapshot === null) return null;
      snapshotRev.value;
      if (card.value.kind === "worker") {
        const selection = card.value;
        const site = workerCardSite(snapshot, selection);
        const worker = site === null ? null : workerView(site, selection.key, modes.value.demo);
        return worker === null ? null : workerCard(worker);
      }
      if (card.value.kind === "waiting") return waitingCard();
      if (card.value.kind === "diagnostics") return diagnosticsCard();
      if (card.value.kind === "settings") return settingsCard();
      if (card.value.kind === "ask") {
        const askId = card.value.askId;
        const ask = asks.value.find(item => item.askId === askId);
        return ask === undefined ? null : askCard(ask);
      }
      const site = activeSite(snapshot);
      const band = site === null ? null : bandView(site, card.value.feature);
      return band === null ? null : bandCard(band);
    }

    function renderSummary(): VNode | null {
      if (snapshot === null || hover.value === null || summaryRect === null || view === null) return null;
      snapshotRev.value;
      const site = activeSite(snapshot);
      const band = site === null ? null : bandView(site, hover.value.feature);
      if (band === null) return null;
      const summary = bandSummary(band);
      const closeSummary = (event: Event): void => {
        event.stopPropagation();
        clearSummaryLock();
        hover.value = null;
        draw();
      };
      return h("div", {
        key: hover.value.feature,
        class: summaryLocked.value ? "summary locked" : "summary",
        "data-agent-ui": "summary", "data-agent-summary": "1",
        style: { right: `${RIBBON_WIDTH * view.scale}px`, top: `${summaryRect.y}px`,
          width: `${summaryRect.width}px`, height: `${summaryRect.height}px` },
        onClick: expand,
      }, [
        h("div", { class: "summary-head" }, [
          h("h2", { title: band.title }, band.title),
          h("button", { class: "summary-close icon-button", type: "button", "aria-label": "关闭摘要",
            title: "关闭", onClick: closeSummary }, [icon("close")]),
        ]),
        summaryRow("状态", summary.status),
        summaryRow("人员", summary.people),
        summaryRow("当前", summary.current),
        summaryRow("验收", summary.acceptance),
        ...(summary.risk === "" ? [] : [summaryRow("风险", summary.risk)]),
        h("div", { class: "cta" }, [
          h("span", null, summaryLocked.value ? "已锁定 · 点击展开" : "点击展开"),
          h("svg", { class: "lock-ring", viewBox: "0 0 16 16", "aria-hidden": "true" }, [
            h("title", null, "悬停 5 秒锁定"),
            h("circle", { class: "ring-track", cx: "8", cy: "8", r: "6" }),
            h("circle", { class: "ring-fill", cx: "8", cy: "8", r: "6", pathLength: "100",
              style: { animationDuration: `${SUMMARY_LOCK_MS}ms` } }),
          ]),
        ]),
      ]);
    }

    function bandCard(band: BandCardView): VNode {
      const summary = bandSummary(band);
      return h("div", { class: "card", "data-agent-ui": "card" }, [
        cardHead(band.title, () => setCard(null)),
        h("div", { class: "lead" }, `${band.feature} · ${summary.status}`),
        cardSection("概况", band.source === "todos" ? [
          kv("彩带", TONE_LABEL[band.tone]),
          kv("人员", summary.people),
          kv("待办", band.slices === null ? "—" : `${band.slices.done}/${band.slices.total}`),
          kv("来源", "会话待办"),
        ] : [
          kv("彩带", TONE_LABEL[band.tone]),
          kv("人员", summary.people),
          kv("切片", band.slices === null ? "—" : `${band.slices.done}/${band.slices.total}`),
          kv("风险", band.risk ?? "—"),
          kv("AC", band.ac === null ? "—" : String(band.ac)),
          kv("待定", band.open === null ? "—" : String(band.open)),
        ]),
        cardSection(band.source === "todos" ? "当前待办" : "当前切片", [
          band.current === null
            ? h("div", { class: "muted" }, band.tarp ?? (band.source === "todos" ? "没有进行中的待办" : "没有当前切片"))
            : h("div", { class: "one-line",
              title: band.source === "todos" ? band.current.title
                : `${band.current.id} ${band.current.title} · ${band.current.stepsDone}/${band.current.stepsTotal}` },
            band.source === "todos" ? band.current.title
              : `${band.current.id} ${band.current.title} · ${band.current.stepsDone}/${band.current.stepsTotal}`),
        ]),
        cardSection("人员", band.workers.length === 0
          ? [h("div", { class: "muted" }, "没人")]
          : band.workers.map(worker => h("div", { class: "card-row" }, [
            h("span", null, `${worker.role === "foreman" ? "工头" : worker.role === "inspector" ? "监理" : "工人"} · ${statusOf(worker.status)}`),
            worker.readOnly ? h("span", { class: "tag" }, "只读") : null,
          ]))),
        cardSection(band.source === "todos" ? "会话" : "图纸", [h("div", { class: "muted path", title: band.specsDir }, band.specsDir)]),
      ]);
    }

    function workerCard(worker: WorkerCardView): VNode {
      if (snapshot === null) return h("div");
      const now = snapshot.at;
      const status = worker.control?.paused === true ? "已暂停" : worker.statusLabel;
      const pendingAsk = asks.value.find(ask => ask.sessionKey === worker.key);
      return h("div", { class: "card", "data-agent-ui": "card" }, [
        cardHead(worker.title, () => setCard(null)),
        h("div", { class: "lead" }, [
          `${worker.site} · ${status} · ${formatSince(now, worker.statusSince)}`,
          worker.readOnly ? h("span", { class: "tag", title: "App 还没接桥接控制，当前只能看" }, "只读")
            : worker.control === null ? null : h("span", { class: "tag" }, "在线"),
        ]),
        worker.statusDetail === null ? null : cardSection("现在", [
          h("div", { class: "status-detail" }, worker.statusDetail),
        ]),
        modes.value.demo || pendingAsk === undefined ? null : cardSection("决策", [
          h("div", { class: "status-detail" }, redact(pendingAsk.question)),
          h("div", { class: "muted" }, pendingAsk.allowOther ? "等你回答 · 也可以自己写" : "等你回答"),
          h("button", { class: "control-button", onClick: () => setCard({ kind: "ask", askId: pendingAsk.askId }) }, "打开决策卡"),
        ]),
        worker.control === null ? null : cardSection("控制", [
          h("div", { class: "muted" }, worker.control.paused
            ? `已暂停${worker.control.holding === null ? "" : ` · 拦在 ${worker.control.holding.tool}`}`
            : "桥接在线，可以暂停或给建议"),
          h("div", { class: "control-row" }, [
            h("button", { class: "control-button", disabled: controlBusy.value !== null,
              onClick: () => void sendControl(worker.key, worker.control!.paused ? "resume" : "pause") },
              controlBusy.value === worker.key ? "处理中…" : worker.control.paused ? "继续" : "暂停"),
            h("button", { class: "control-button danger", disabled: controlBusy.value !== null,
              onClick: () => sendAbort(worker.key) }, "中断"),
          ]),
          h("div", { class: "suggest-form" }, [
            h("textarea", { class: "suggest-input", rows: 3, placeholder: "给这个会话一条建议…",
              value: textFor(drafts.value, worker.key), disabled: controlBusy.value !== null,
              onInput: (event: Event) => { drafts.value = setText(drafts.value, worker.key, (event.target as HTMLTextAreaElement).value); } }),
            h("div", { class: "suggest-actions" }, [
              h("select", { class: "suggest-mode", value: modeFor(drafts.value, worker.key), disabled: controlBusy.value !== null,
                onChange: (event: Event) => {
                  drafts.value = setMode(drafts.value, worker.key,
                    (event.target as HTMLSelectElement).value === "followUp" ? "followUp" : "steer");
                } }, [
                h("option", { value: "steer" }, "插话"),
                h("option", { value: "followUp" }, "做完再说"),
              ]),
              h("button", { class: "control-button", disabled: controlBusy.value !== null || textFor(drafts.value, worker.key).trim() === "",
                onClick: () => void sendSuggest(worker.key) },
                controlBusy.value === worker.key ? "发送中…" : "发送建议"),
            ]),
          ]),
        ]),
        controlError.value?.key === worker.key ? h("div", { class: "control-error" }, controlError.value.text) : null,
        cardSection("会话", [
          kv("来源", worker.harness),
          kv("模型", worker.model ?? "—"),
          kv("会话", worker.nativeId),
          kv("位置", worker.location),
          worker.readOnly ? h("div", { class: "muted" }, "只读：App 还没接桥接控制，当前只能看。") : null,
        ]),
        modes.value.demo ? null : cardSection("最近动作", worker.actions.length === 0
          ? [h("div", { class: "muted" }, "还没有动作")]
          : worker.actions.map(action => h("div", { class: "card-row" }, [
            h("span", { class: "row-main", title: action.text }, action.text),
            h("span", { class: "row-meta" }, formatSince(now, action.at)),
          ]))),
        modes.value.demo ? null : cardSection("Trace", worker.trace.length === 0
          ? [h("div", { class: "muted" }, "没有可显示的轨迹")]
          : worker.trace.map(entry => h("div", { class: "card-row" }, [
            h("span", { class: "trace-kind" }, TRACE_LABEL[entry.kind]),
            h("span", { class: "row-main", title: entry.text }, entry.text),
            h("span", { class: "row-meta" }, formatSince(now, entry.at)),
          ]))),
        modes.value.demo || worker.todos === null ? null : cardSection("待办", worker.todos.map(todo => h("div", { class: "card-row" }, [
          h("span", { class: "row-main" }, `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : "○"} ${todo.text}`),
        ]))),
        modes.value.demo || worker.testFailure === null ? null : cardSection("问题", [
          h("div", null, worker.testFailure.text),
          h("div", { class: "muted" }, formatSince(now, worker.testFailure.at)),
        ]),
      ]);
    }

    function askCard(ask: AppAsk): VNode {
      // 决策可能来自别的工地的会话（灯是全部工地混排的），标题要能找到它，退化成"在线会话"就丢信息了
      const site = snapshot === null ? null
        : snapshot.sites.find(item => item.workers.some(candidate => candidate.key === ask.sessionKey)) ?? null;
      const worker = site === null ? null : workerView(site, ask.sessionKey, modes.value.demo);
      const accepted = askAccepted.value[ask.askId] === true;
      const cancelled = askCancelled.value[ask.askId] === true;
      const busy = askBusy.value !== null;
      const draft = askDrafts.value[ask.askId] ?? "";
      const question = redact(ask.question);
      const context = ask.context === undefined ? null : redact(ask.context);
      if (modes.value.demo) {
        return h("div", { class: "card", "data-agent-ui": "card" }, [
          cardHead("决策", () => setCard(null)),
          h("div", { class: "lead" }, "演示模式已隐藏决策内容"),
          h("div", { class: "muted" }, "退出演示模式后可回答；提问仍留在 App 里。"),
        ]);
      }
      return h("div", { class: "card", "data-agent-ui": "card" }, [
        cardHead(`决策 · ${worker === null ? "在线会话" : worker.title}`, () => setCard(null)),
        h("div", { class: "lead" }, [
          "等你回答 · 桥接在线",
          h("span", { class: "tag" }, "决策"),
        ]),
        cardSection("问题", [
          h("div", { class: "status-detail" }, question),
          context === null ? null : h("div", { class: "muted ask-context" }, context),
        ]),
        h("div", { class: "ask-options" }, ask.options.map((option, index) => h("button", {
          class: "control-button ask-option", disabled: busy || accepted,
          onClick: () => void answerAsk(ask.askId, option),
        }, option === "" ? `选项 ${index + 1}` : redact(option)))),
        ask.allowOther ? h("div", { class: "suggest-form" }, [
          h("textarea", { class: "suggest-input", rows: 3, placeholder: "选项都不合适，自己写一个答案…",
            value: draft, disabled: busy || accepted,
            onInput: (event: Event) => {
              askDrafts.value = { ...askDrafts.value, [ask.askId]: (event.target as HTMLTextAreaElement).value };
            } }),
          h("div", { class: "suggest-actions" }, [
            h("button", { class: "control-button", disabled: busy || accepted || draft.trim() === "",
              onClick: () => void answerAsk(ask.askId, draft.trim()) }, "用这句话回答"),
          ]),
        ]) : null,
        h("div", { class: "control-row" }, [
          h("button", { class: "control-button danger", disabled: busy || accepted,
            onClick: () => void answerAsk(ask.askId, null) }, "取消这个提问"),
        ]),
        cancelled ? h("div", { class: "muted" }, "已取消：agent 会按自己的判断继续，终端那边的对话框也一起关掉。")
          : accepted ? h("div", { class: "muted" }, "已交给桥接，等终端或桥接收尾…") : null,
        askError.value?.askId === ask.askId ? h("div", { class: "control-error" }, askError.value.text) : null,
      ]);
    }

    function waitingCard(): VNode {
      if (snapshot === null) return h("div");
      const now = snapshot.at;
      const list = waitingList(snapshot); // 全部工地：混排之后每行带工地名
      const rows = (items: typeof list.recent): VNode[] => items.length === 0
        ? [h("div", { class: "muted" }, "没有")]
        : modes.value.demo
          ? [h("div", { class: "muted" }, `${items.length} 个会话（演示模式已隐藏文字）`)]
          : items.map(item => h("div", { class: "card-row" }, [
            h("span", { class: "row-site", title: item.site }, item.site),
            h("span", { class: "row-main", title: item.text }, item.text),
            h("span", { class: "row-meta", title: item.key }, formatSince(now, item.since)),
          ]));
      // 意图卡里的待定：不是会话，单独一栏
      const open = openList(snapshot);
      const backlog = backlogList(snapshot);
      const openRows = open.length === 0
        ? [h("div", { class: "muted" }, "没有")]
        : modes.value.demo
          ? [h("div", { class: "muted" }, `${open.length} 条待定（演示模式已隐藏文字）`)]
          : open.map((item: OpenRow) => h("div", { class: "card-row" }, [
            h("span", { class: "row-site", title: item.site }, item.site),
            h("span", { class: "row-main", title: item.text }, `${item.feature} · ${item.text}`),
          ]));
      return h("div", { class: "card", "data-agent-ui": "card" }, [
        cardHead("等你清单", () => setCard(null)),
        h("div", { class: "lead" }, "全部工地里等你回话的会话，等得久的在前"),
        cardSection("现在", rows(list.recent)),
        cardSection("历史", rows(list.history)),
        cardSection("意图卡里的待定", openRows),
        cardSection("工地的待做", backlog.length === 0
          ? [h("div", { class: "muted" }, "没有")]
          : modes.value.demo
            ? [h("div", { class: "muted" }, `${backlog.length} 条待做（演示模式已隐藏文字）`)]
            : backlog.map(item => h("div", { class: "card-row" }, [
              h("span", { class: "row-site", title: item.site }, item.site),
              h("span", { class: "row-main", title: item.text }, item.text),
            ]))),
      ]);
    }

    /** 设置面板：改 settings.json 里那几个能改的键。存下去先由主进程校验，错了原样退回 */
    function settingsCard(): VNode {
      const current = draft.value;
      if (current === null) return h("div", { class: "card", "data-agent-ui": "card" }, [
        cardHead("设置", () => setCard(null)), h("div", { class: "muted" }, "设置还没读出来"),
      ]);
      const field = (label: string, control: VNode): VNode =>
        h("label", { class: "field" }, [h("span", { class: "field-label" }, label), control]);
      const number = (key: "idleMinutes" | "stalledMinutes" | "onsiteHours", label: string): VNode =>
        field(label, h("input", {
          class: "text-input", type: "number", min: "1", value: String(current[key]),
          onInput: (event: Event) => {
            const next = Number((event.target as HTMLInputElement).value);
            draft.value = { ...current, [key]: Number.isFinite(next) ? next : current[key] };
          },
        }));
      const choice = (key: "theme", value: "night" | "day", label: string): VNode =>
        h("button", {
          class: current.theme === value ? "chip on" : "chip", type: "button",
          "aria-pressed": current.theme === value ? "true" : "false",
          onClick: () => { draft.value = { ...current, theme: value }; },
        }, label);
      const styleChoice = (value: "tower" | "factory" | "storefront", label: string): VNode =>
        h("button", {
          class: current.style === value ? "chip on" : "chip", type: "button",
          "aria-pressed": current.style === value ? "true" : "false",
          onClick: () => { draft.value = { ...current, style: value }; },
        }, label);
      return h("div", { class: "card", "data-agent-ui": "card" }, [
        cardHead("设置", () => setCard(null)),
        h("div", { class: "lead" }, "改完点保存，写进 settings.json 并当场生效"),
        cardSection("外观", [
          h("div", { class: "chips" }, [choice("theme", "night", "夜色"), choice("theme", "day", "白昼")]),
        ]),
        cardSection("楼体", [field("默认造型", h("div", { class: "chips" }, [
          styleChoice("tower", "塔楼"), styleChoice("factory", "厂房"), styleChoice("storefront", "临街店"),
        ]))]),
        cardSection("启动", [field("开机自启", h("input", {
          type: "checkbox", checked: current.autostart,
          onChange: (event: Event) => { draft.value = { ...current, autostart: (event.target as HTMLInputElement).checked }; },
        }))]),
        cardSection("阈值（分钟 / 小时）", [
          number("idleMinutes", "空闲"), number("stalledMinutes", "停工"), number("onsiteHours", "在工地"),
        ]),
        // 配置界面显示的是用户自己 settings.json 的原文：不脱敏（见 AGENTS.md），脱敏就没法编辑
        cardSection('额外固定的工地（一行一个 `路径`，改名字写 `路径 = "名字"`）', [h("textarea", {
          class: "suggest-input", rows: "4", value: current.repos,
          onInput: (event: Event) => { draft.value = { ...current, repos: (event.target as HTMLTextAreaElement).value }; },
        })]),
        ...(errors.value.length === 0 ? [] : [h("div", { class: "card-error" }, errors.value.join("；"))]),
        h("div", { class: "card-actions" }, [
          h("button", {
            class: "control-button", type: "button",
            onClick: () => {
              void window.agentSite.saveSettings(draftPayload(current)).then(result => {
                errors.value = result.ok ? [] : result.errors.map(redact);
                saved.value = result.ok;
                if (!result.ok) return;
                window.setTimeout(() => { saved.value = false; }, 1500);
              }).catch((error: unknown) => {
                errors.value = [`保存失败：${error instanceof Error ? error.message : String(error)}`];
                saved.value = false;
              });
            },
          }, saved.value ? "已保存" : "保存"),
        ]),
      ]);
    }

    function diagnosticsCard(): VNode {
      if (snapshot === null) return h("div");
      const data = diagnosticsView(snapshot, activeSite(snapshot));
      const problems = diagnosticsProblems(data);
      return h("div", { class: "card", "data-agent-ui": "card" }, [
        cardHead("诊断", () => setCard(null)),
        h("div", { class: "lead" }, "来源、坏行和最近的解析问题"),
        ...(data.repo === "" ? [] : [h("div", { class: "muted path", title: data.repo }, data.repo)]),
        cardSection("来源", data.sources.flatMap(source => [
          h("div", { class: "card-row" }, [
            h("span", { class: "row-main" }, `${source.harness} · ${source.present ? "在" : "不在"} · ${source.sessions} 个会话`),
            h("span", { class: "row-meta" }, `坏行 ${source.badLines} · 未知 ${source.unknownRecords}`),
          ]),
          h("div", { class: "muted path", title: source.root }, source.root),
        ])),
        cardSection("解析问题", problems.length === 0
          ? [h("div", { class: "muted" }, "没有")]
          : problems.map(note => h("div", { class: "card-row" }, [h("span", null, note)]))),
      ]);
    }

    function cardHead(title: string, close: () => void): VNode {
      return h("div", { class: "card-head" }, [
        h("h2", { title }, title),
        h("button", { class: "card-close icon-button", type: "button", "data-agent-ui": "card",
          "aria-label": "关闭卡片", title: "关闭", onClick: close }, [icon("close")]),
      ]);
    }

    function cardSection(title: string, children: Array<VNode | null>): VNode {
      return h("div", { class: "card-section" }, [h("h3", null, title), ...children]);
    }

    function summaryRow(key: string, value: string): VNode {
      return h("div", { class: "row" }, [h("span", { class: "k" }, key), h("span", null, value)]);
    }
  },
};

/** 图标统一从 24 网格起画：四周留 2、线宽 2、颜色吃 currentColor */
function icon(name: "gear" | "close" | "arrow"): VNode {
  const paths = name === "close"
    ? ["M6 6 L18 18", "M18 6 L6 18"]
    : name === "arrow" ? ["M9 6 L15 12 L9 18"]
    : ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
      "M19.4 15a1.7 1.7 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.82-.33 1.7 1.7 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .33-1.82 1.7 1.7 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.82.33H9a1.7 1.7 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.82V9a1.7 1.7 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"];
  return h("svg", { class: name, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
    "stroke-linecap": "square", "stroke-linejoin": "miter", "aria-hidden": "true" },
  paths.map(d => h("path", { d })));
}

function kv(key: string, value: string): VNode {
  return h("div", { class: "kv" }, [h("span", { class: "k" }, key), h("span", { class: "v" }, value)]);
}

function statusOf(status: "waiting" | "stalled" | "idle" | "working"): string {
  return status === "waiting" ? "等你" : status === "stalled" ? "停工" : status === "idle" ? "空闲" : "在干";
}

function hitRects(layout: BuildingLayout, cssWidth: number, cssHeight: number, menuOpen: boolean,
  offset: number, cardOpen: boolean, collapsed: boolean, summary: AppRect | null): AppRect[] {
  if (menuOpen) return [{ x: 0, y: 0, width: cssWidth + offset, height: cssHeight }];
  const scale = cssWidth / layout.width;
  if (collapsed) {
    const rects = ribbonSegments(layout).map(segment => ({
      x: segment.x * scale + offset, y: segment.y * scale, width: segment.width * scale, height: segment.height * scale,
    }));
    if (summary !== null) rects.push(summary);
    return rects;
  }
  const rects: AppRect[] = [
    { x: offset, y: 0, width: cssWidth, height: TOPBAR_HEIGHT },
    { x: offset, y: cssHeight - (TOPBAR_HEIGHT + 8), width: cssWidth, height: TOPBAR_HEIGHT + 8 },
  ];
  if (cardOpen) rects.push({ x: 0, y: 0, width: offset, height: cssHeight });
  for (const rect of layout.hitRects) {
    rects.push({ x: rect.x * scale + offset, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
  }
  return rects;
}

createApp(App).mount("#app");
