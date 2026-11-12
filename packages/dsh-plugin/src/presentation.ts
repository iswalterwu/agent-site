import tokens from "./panel.tokens.json";
import type { OpenState } from "./open-controller";

export function panelActions(configured: boolean): { primary: "open" | "download"; secondary: "download" | "path" } {
  return configured ? { primary: "open", secondary: "download" } : { primary: "download", secondary: "path" };
}

export function panelStatus(status: OpenState, form: { configured: boolean; dirty: boolean }): "missing" | "ready" | "dirty" | "pending" | "sent" | "error" | "unconfirmed" {
  if (form.dirty) return "dirty";
  if (!form.configured) return "missing";
  if (status.kind === "error") return status.code === "timeout" || status.code === "disconnected" ? "unconfirmed" : "error";
  return status.kind === "idle" ? "ready" : status.kind;
}

/** 三层 JSON 别名保持为 CSS 变量，组件不重复写品牌颜色或尺度。 */
export function panelTokenCss(): string {
  return Object.entries(tokens).flatMap(([layer, values]) => Object.entries(values).map(([key, value]) => {
    const name = `--as-${layer}-${key.replaceAll(".", "-")}`;
    const reference = /^\{([^}]+)\}$/.exec(value);
    return `${name}:${reference ? `var(--as-${reference[1].replaceAll(".", "-")})` : value};`;
  })).join("");
}
