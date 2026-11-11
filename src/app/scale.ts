export interface CanvasGeometry {
  cssWidth: number;
  cssHeight: number;
  bitmapWidth: number;
  bitmapHeight: number;
  drawScaleX: number;
  drawScaleY: number;
}

/**
 * 画布按设备像素建位图，CSS 尺寸固定是逻辑尺寸 × 2。
 * 这样 150% 的屏幕上 110×h 的图会落到 330×… 的真实像素，不被浏览器再平滑一次。
 */
export function canvasGeometry(
  logicalWidth: number,
  logicalHeight: number,
  scale: number,
  devicePixelRatio: number,
): CanvasGeometry {
  const cssWidth = logicalWidth * scale;
  const cssHeight = logicalHeight * scale;
  const bitmapWidth = Math.max(1, Math.round(cssWidth * devicePixelRatio));
  const bitmapHeight = Math.max(1, Math.round(cssHeight * devicePixelRatio));
  return {
    cssWidth, cssHeight, bitmapWidth, bitmapHeight,
    drawScaleX: bitmapWidth / logicalWidth,
    drawScaleY: bitmapHeight / logicalHeight,
  };
}
