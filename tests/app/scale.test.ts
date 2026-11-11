import { describe, expect, it } from "vitest";
import { canvasGeometry } from "../../src/app/scale";

describe("画布设备像素", () => {
  it("2× / 150% 时 CSS 220×928，位图 330×1392，绘制倍率 3", () => {
    expect(canvasGeometry(110, 464, 2, 1.5)).toEqual({
      cssWidth: 220, cssHeight: 928, bitmapWidth: 330, bitmapHeight: 1392,
      drawScaleX: 3, drawScaleY: 3,
    });
  });


  it("100% 时位图等于整数倍 CSS 尺寸", () => {
    expect(canvasGeometry(110, 464, 2, 1)).toMatchObject({ bitmapWidth: 220, bitmapHeight: 928, drawScaleX: 2 });
  });
});
