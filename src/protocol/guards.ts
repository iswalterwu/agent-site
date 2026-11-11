// 外部数据入口的通用校验小件：协议帧、workflow state、各家会话日志、设置文件的解析器都从这里取，不各自重写（计划裁定 E8）。
// 只放两个以上解析器都要用的通用件；某个解析器专用的派生 guard 留在它自己的文件里。

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === "string";
/** 非空字符串 */
export const isNonEmpty = (v: unknown): v is string => isStr(v) && v !== "";
export const isNum = (v: unknown): v is number => typeof v === "number";
/** 整数（不含 NaN、Infinity） */
export const isInt = (v: unknown): v is number => Number.isInteger(v);
export const isBool = (v: unknown): v is boolean => typeof v === "boolean";
export const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
/** 字段可以缺席（undefined）；出现时必须通过 guard */
export const optional = <T>(guard: (v: unknown) => v is T) => (v: unknown): v is T | undefined => v === undefined || guard(v);
/** 只接受列表中的字符串；列表的元素类型就是窄化后的类型 */
export const oneOf = <T extends string>(allowed: readonly T[]) => (v: unknown): v is T => allowed.some((a) => a === v);

/** 值为 undefined 时返回空对象：展开它，可选字段在结果里就真的缺席，而不是带着 undefined 值 */
export function ifDefined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

/** 解析一段 JSON，顶层必须是对象；坏 JSON 或不是对象都返回 null，绝不抛出 */
/** 去掉开头的 BOM：Windows 记事本存出来的 JSON 会带它，JSON.parse 会直接抛错 */
export function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

export function parseJsonObject(raw: string): Obj | null {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(raw));
  } catch {
    return null;
  }
  return isObj(value) ? value : null;
}
