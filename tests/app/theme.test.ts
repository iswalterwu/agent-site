import { expect, it } from "vitest";
import { COLOR, PLATE, setTheme, THEMES, themeName, TONE, TYPE } from "../../src/app/theme";

it("WINDOW-26：两套配色都有同一组键，只换外壳、材质和信号色不变", () => {
  expect(Object.keys(THEMES.night).sort()).toEqual(Object.keys(THEMES.day).sort());
  expect(THEMES.day.surface).not.toBe(THEMES.night.surface);
  expect(THEMES.day.text).not.toBe(THEMES.night.text);
  // 材质、帽子、皮肤在两种底色上都要读得清，不跟着换
  for (const key of ["brick", "glass", "metal", "concrete", "hatForeman", "skin", "vest"] as const) {
    expect(THEMES.day[key]).toBe(THEMES.night[key]);
  }
});
it("WINDOW-26：setTheme 之后 COLOR 立刻读到新的一套，默认是夜色", () => {
  setTheme("day");
  expect(themeName()).toBe("day");
  expect(COLOR.text).toBe(THEMES.day.text);
  expect(COLOR.surface).toBe(THEMES.day.surface);
  setTheme("night");
  expect(themeName()).toBe("night");
  expect(COLOR.text).toBe(THEMES.night.text);
});
it("WINDOW-26：状态色在两套配色里是同一组", () => {
  setTheme("day");
  expect(TONE.waiting).toBe("#f7ac4d");
  setTheme("night");
});

it("WINDOW-26：深色底板上的文字两套配色都用浅色——白昼不再拿暗字压在深底板上", () => {
  const luminance = (hex: string): number => {
    const v = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  };
  const contrast = (a: string, b: string): number => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
    return (x + 0.05) / (y + 0.05);
  };
  const opaque = (color: string): string => (color.startsWith("rgba") ? overWhite(color) : color);
  // 底板是半透明的，最亮的情形是叠在白色楼体上——三种底板都要看得清
  const overWhite = (rgba: string): string => {
    const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
    const mix = (c: number) => Math.round(c * a + 255 * (1 - a)).toString(16).padStart(2, "0");
    return `#${mix(r)}${mix(g)}${mix(b)}`;
  };
  for (const plate of [PLATE.solid, PLATE.soft, PLATE.weak]) {
    expect(contrast(PLATE.text, overWhite(plate))).toBeGreaterThan(4.5);
  }
  // 正文在两种底色上都要够：白昼的暗字压在亮底板上、夜色的亮字压在暗底板上
  expect(contrast(THEMES.day.text, opaque(THEMES.day.surface))).toBeGreaterThan(7);
  expect(contrast(THEMES.night.text, opaque(THEMES.night.surface))).toBeGreaterThan(7);
  expect(contrast(THEMES.day.muted, opaque(THEMES.day.surface))).toBeGreaterThan(4.5);
  expect(contrast(THEMES.night.muted, opaque(THEMES.night.surface))).toBeGreaterThan(4.5);
});

it("WINDOW-9：2× 下楼段名和楼层号不低于字号下限", () => {
  expect(TYPE.label * 2).toBeGreaterThanOrEqual(12);
  expect(TYPE.caption * 2).toBeGreaterThanOrEqual(10);
});
