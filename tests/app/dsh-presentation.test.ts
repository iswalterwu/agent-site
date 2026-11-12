import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { panelActions, panelTokenCss, panelStatus } from "../../packages/dsh-plugin/src/presentation";
import tokens from "../../packages/dsh-plugin/src/panel.tokens.json";

it("DIST-4：主次操作只由已保存路径决定，未保存输入或清空不能触发打开", () => {
  expect(panelActions(false)).toEqual({ primary: "download", secondary: "path" });
  expect(panelActions(true)).toEqual({ primary: "open", secondary: "download" });
  expect(panelStatus({ kind: "idle" }, { configured: false, dirty: true })).toBe("dirty");
  expect(panelStatus({ kind: "sent" }, { configured: true, dirty: true })).toBe("dirty");
  expect(panelStatus({ kind: "sent" }, { configured: false, dirty: false })).toBe("missing");
  expect(panelStatus({ kind: "error", code: "timeout" }, { configured: true, dirty: false })).toBe("unconfirmed");
});

it("DIST-11：三层令牌生成仅供插件使用的变量，不输出外部选择器", () => {
  const css = panelTokenCss();
  expect(css).toContain("--as-primitive-brand:#E8BD76;");
  expect(css).toContain("--as-component-highlight:var(--as-semantic-accent);");
  expect(css).toContain("--as-component-font-body:var(--as-semantic-fontBody);");
  expect(css).not.toContain("{");
  expect(css).not.toContain("!important");
});

it("DIST-11：像素招牌文字与控件边界满足对比度，不靠透明度降低可读性", () => {
  const palette = tokens.primitive;
  const luminance = (color: string): number => {
    const rgb = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const contrast = (first: string, second: string): number => {
    const [dark, light] = [luminance(first), luminance(second)].sort((a, b) => a - b);
    return (light + .05) / (dark + .05);
  };
  for (const surface of [palette["surface.base"], palette["surface.raised"]]) {
    expect(contrast(palette["text.primary"], surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["text.secondary"], surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.stroke, surface)).toBeGreaterThanOrEqual(3);
  }
  expect(contrast(palette.onBrand, palette.brand)).toBeGreaterThanOrEqual(4.5);
});

it("DIST-11、DIST-12：像素图标与图片尺寸、体积及元数据符合分发约束", () => {
  const root = path.resolve(__dirname, "../../packages/dsh-plugin/assets");
  for (const [file, width, height, max] of [["logo-48.png", 48, 48, 10000], ["logo-96.png", 96, 96, 10000],
    ["logo-192.png", 192, 192, 10000], ["scene-1x.png", 420, 268, 120000], ["scene-2x.png", 840, 536, 120000]] as const) {
    const png = fs.readFileSync(path.join(root, file));
    expect(png.length).toBeLessThanOrEqual(max);
    expect(png.readUInt32BE(16)).toBe(width);
    expect(png.readUInt32BE(20)).toBe(height);
    const chunks: string[] = [];
    for (let at = 8; at < png.length;) { const size = png.readUInt32BE(at); chunks.push(png.toString("ascii", at + 4, at + 8)); at += size + 12; }
    expect(chunks.some(kind => ["tEXt", "zTXt", "iTXt", "eXIf"].includes(kind))).toBe(false);
  }
});
