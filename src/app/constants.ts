import { SPACE } from "./theme";

// 渲染层的固定逻辑尺寸：窗口宽 110，按整数倍放大；外边距取 8 的档位。
export const LOGICAL_WIDTH = 110;
export const TOP_PAD = SPACE.xl;
export const FOOTER_HEIGHT = 28;
export const GROUND_HEIGHT = SPACE.xs;
export const BAND_X = SPACE.xs;
export const BAND_WIDTH = LOGICAL_WIDTH - BAND_X * 2;
/** 楼层号一栏，同时是整栋楼的竖向分隔 */
export const FLOOR_GUTTER = 15;
/** 气泡 76 逻辑 px 宽，最多两行；两行放不下时省略 */
export const BUBBLE_WIDTH = 76;
