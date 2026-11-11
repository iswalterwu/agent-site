/**
 * 视觉令牌：原始值 → 语义 → 组件；Canvas 与 CSS 只引语义层。
 * 色值由 OKLCH 生成：中性色固定 H=250、L 步长 0.03–0.07、C ≤ 0.02；
 * 信号色只留琥珀 / 红 / 绿三族，材质用 C ≤ 0.06 的低彩度。
 * 已验：正文对比 ≥ 4.5:1，控件与信号 ≥ 3:1（对 surface）。
 */

/** 间距只取 4 的倍数；8 为主，4 补缝。 */
export const SPACE = {
  xs: 8,
  xl: 32,
} as const;

/** 画布字号（逻辑 px）；2× 下 caption 11 / label 15 CSS px。 */
export const TYPE = {
  caption: 5.5,
  label: 7.5,
} as const;

const NIGHT = {
  /** 底栏、气泡、卡片底：半透明深板岩，压在任意桌面上都能读 */
  surface: "rgba(19, 25, 31, .94)",
  /** 楼体底色：未建层和空段也留在剪影里 */
  tower: "#1e252c",
  towerEdge: "rgba(203, 213, 225, .20)",
  border: "rgba(203, 213, 225, .14)",
  text: "#dee2e5",
  muted: "#94999e",
  shadow: "rgba(5, 10, 15, .42)",
  highlight: "rgba(255, 255, 255, .10)",
  ground: "#2a231c",
  groundEdge: "rgba(222, 226, 229, .16)",
  brick: "#855f50",
  brickDark: "#6b4a3e",
  brickLight: "#9a7260",
  glass: "#496879",
  glassDark: "#3a5565",
  glassLight: "#5d8093",
  metal: "#7b8187",
  metalDark: "#62686e",
  metalLight: "#949aa0",
  concrete: "#494e52",
  concreteDark: "#3b4044",
  concreteLight: "#585d61",
  scaffold: "#b8a17e",
  /** 围挡：还没开工的楼段在底部围一圈木板；和材质一样两套配色都适用 */
  hoarding: "#4b4339",
  /** 厂房卷帘门、临街店雨棚、塔吊和钢筋：跟材质一样两套配色都适用 */
  shutter: "#3c444b",
  rebar: "#a06a4c",
  crane: "#c7a15c",
  flag: "#f7ac4d",
  office: "#655447",
  officeRoof: "#7c6750",
  hatForeman: "#c2604f",
  hatWorker: "#e0a63f",
  hatInspector: "#d8dde2",
  skin: "#e2c3a2",
  vest: "#3d4650",
  pants: "#2b333c",
  boot: "#151b21",
  paper: "#c3ccd4",
  hair: "#2b333c",
  jacket: "#46525e",
} as const;

export type ThemeName = "night" | "day";
export type Palette = { [K in keyof typeof NIGHT]: string };

/**
 * 白昼配色：只换"外壳"（面板、楼体剪影、文字、地面），材质、帽子、皮肤和信号色不动——
 * 楼体的砖、玻璃、混凝土在两种底色上都读得清，换掉反而要重新验一遍对比度。
 */
const DAY: Palette = {
  ...NIGHT,
  surface: "rgba(244, 246, 249, .95)",
  tower: "#d8dee5",
  towerEdge: "rgba(30, 41, 51, .22)",
  border: "rgba(30, 41, 51, .14)",
  text: "#1b232b",
  muted: "#57606a",
  shadow: "rgba(20, 30, 40, .16)",
  highlight: "rgba(255, 255, 255, .60)",
  ground: "#cfc4b2",
  groundEdge: "rgba(30, 41, 51, .22)",
};

export const THEMES: Record<ThemeName, Palette> = { night: NIGHT, day: DAY };

/**
 * 气泡、招牌、篷布底这些压在楼体上的深色底板，两套配色里都用深色底 + 浅字：
 * 白色底板压在亮楼体上既读不出层次，又要为每套配色重算一遍对比度。
 */
export const PLATE = {
  solid: "rgba(9, 14, 20, .94)",
  soft: "rgba(5, 10, 15, .72)",
  weak: "rgba(5, 10, 15, .70)",
  text: "#dee2e5",
} as const;

let current: Palette = THEMES.night;

/** 切到某套配色（只管 Canvas；CSS 变量由渲染层按同一名字切换） */
export function setTheme(name: ThemeName): void { current = THEMES[name]; }

/** 当前配色的名字 */
export function themeName(): ThemeName { return current === THEMES.day ? "day" : "night"; }

/** 画的时候按当前配色取值：`COLOR.x` 每次都读最新的一套 */
export const COLOR: Palette = new Proxy({} as Palette, {
  get: (_target, key) => current[key as keyof Palette],
  has: (_target, key) => key in current,
  ownKeys: () => Reflect.ownKeys(current),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

/**
 * 三种业态的颜色：材质说“这层是什么”，业态说“这里在做什么生意”。
 * 跟信号色分开——等你 / 出错 / 在干仍然只在灯、彩带和气泡上；夜景白昼共用这套。
 */
export const STYLE = {
  tower: { wash: "rgba(36, 62, 92, .55)", planned: "rgba(36, 62, 92, .34)", steel: "rgba(70, 120, 170, .14)", dome: "#2c4a66", slab: "rgba(99, 216, 242, .30)", neon: "#63d8f2" },
  factory: { wash: "rgba(122, 66, 50, .58)", planned: "rgba(122, 66, 50, .34)", wall: "#9c5b4a", mortar: "rgba(224, 211, 180, .22)", rust: "#b57448", lamp: "rgba(246, 217, 160, .60)", smoke: "rgba(222, 226, 229, .22)" },
  storefront: { wash: "rgba(196, 172, 132, .45)", planned: "rgba(196, 172, 132, .30)", wall: "rgba(239, 226, 200, .12)", cream: "#d9c8a6", awning: "#4f9a94", awningLight: "#e8f0e6", wood: "#8a6142", tile: "#bd7057", lantern: "#ffd9a0",
    shops: ["#4f9a94", "#b96b52", "#c9a24f", "#7c8f5a"] },
} as const;

/** 花园和院子用的一组颜色：露台、花箱、树和草地 */
export const GARDEN = { leaf: "#6f8f5a", bloom: "#c96f7a", grass: "#5f7f4f", soil: "#4b3a2c", wood: "#8a6142" } as const;

/** 状态色：图例、灯、气泡和彩带共用；顺序就是优先级顺序。信号色在两套配色里都不变 */
export const TONE = {
  waiting: "#f7ac4d",
  error: "#ef675c",
  stalled: "#f2d76c",
  working: "#7cd591",
  idle: "#81878d",
} as const;

export type Tone = keyof typeof TONE;

export const FONT_SANS = 'system-ui, "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';

/** 顶栏只放拖动条和齿轮；32 CSS px 是桌面最小点击尺寸。 */
export const TOPBAR_HEIGHT = 32;

/** 常驻窗口的最大高度：不超过一屏的 720 CSS px，上下留白后垂直居中。 */
export const WINDOW_MAX_HEIGHT = 720;
