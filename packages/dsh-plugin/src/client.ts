import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import { Button, SettingsForm, SettingsFormModel, SettingsValueField, settingsTextField } from "@deepseek-ai/dsh-client-ui-primitives";
import { LAUNCH_PROTOCOL } from "../../../src/protocol/launch";
import { OpenController } from "./open-controller";
import { COPY, panelFeedback } from "./messages";
import { panelActions, panelStatus, panelTokenCss } from "./presentation";
import styles from "./panel.css";
import scene1x from "../assets/scene-1x.png";
import scene2x from "../assets/scene-2x.png";

export const inject = ["slots", "connection", "configForms", "locale"];
const DOWNLOAD = "https://github.com/iswalterwu/agent-site/releases";
interface Preferences { executablePath: string }
interface PanelProps { form: ConfigForm<Preferences>; locale: LocaleRuntime; open: OpenController; local: boolean }

export function apply(ctx: Context): void {
  // 同一编译项目含 Host 与 Client；浏览器注入的 connection 使用公开 Client 形态。
  const connection = ctx.get("connection") as unknown as ConnectionHandle;
  const open = new OpenController(async signal => {
    if (!connection.isLoopback) return { version: LAUNCH_PROTOCOL, status: "error", code: "unsupported" };
    const response = await fetch(new URL("api/agent-site/open", document.baseURI), { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: LAUNCH_PROTOCOL, action: "open" }), signal });
    if (response.status === 401 || response.status === 403) return { version: LAUNCH_PROTOCOL, status: "error", code: "unauthorized" };
    return response.json();
  });
  ctx.effect(() => () => open.dispose());
  ctx.effect(() => {
    const element = document.createElement("style");
    element.dataset.agentSiteStyles = "";
    element.textContent = `[data-agent-site-panel]{${panelTokenCss()}}${styles}`;
    document.head.append(element);
    return () => element.remove();
  }, "agent-site: scoped presentation");
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config", key: "dsh-agent-site",
    inject: () => ({ form: ctx.configForms.get<Preferences>("agent-site"), locale: ctx.locale, open, local: connection.isLoopback }),
  }, Panel));
}

function Panel({ form, locale, open, local }: PanelProps) {
  const language = useSyncExternalStore(callback => locale.subscribe(callback), () => locale.getSnapshot()).active;
  const lang = language.startsWith("zh") ? "zh" : "en";
  const copy = COPY[lang];
  const model = useMemo(() => new SettingsFormModel(form, [settingsTextField("executablePath")]), [form]);
  const store = useMemo(() => model.bind(() => ({ shell: model.shell(), field: model.field("executablePath"), configured: Boolean(form.getSnapshot().value?.executablePath) })), [model, form]);
  const state = useSyncExternalStore(callback => store.subscribe(callback), () => store.getSnapshot());
  const status = useSyncExternalStore(open.subscribe, open.getSnapshot);
  const actions = useMemo(() => model.actions(), [model]);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => () => model.dispose(), [model]);
  const disabled = !state.shell.available || !state.shell.writable || state.shell.saving;
  const feedback = panelFeedback(lang, status, { local, dirty: state.shell.dirty, configured: state.configured });
  const action = panelActions(state.configured);
  const badge = panelStatus(status, { dirty: state.shell.dirty, configured: state.configured });
  const labels = { missing: copy.statusMissing, ready: copy.statusReady, dirty: copy.statusDirty, pending: copy.statusPending,
    sent: copy.statusSent, error: copy.statusError, unconfirmed: copy.statusUnconfirmed };
  const download = (className: string) => h("a", { className, href: DOWNLOAD, target: "_blank", rel: "noopener noreferrer", "data-agent-site-action": "download" }, copy.download);
  return h("section", { "aria-label": "Agent Site", "data-agent-site-panel": "" },
    h("div", { className: "as-hero" },
      h("div", null, h("div", { className: "as-eyebrow" }, "AGENTS AT WORK"),
        h("h2", { className: "as-headline" }, copy.headline1, h("br"), copy.headline2),
        h("p", { className: "as-lead" }, copy.lead), h("p", { className: "as-sources" }, "pi / Claude Code / DSH")),
      h("figure", { className: "as-figure" }, imageFailed
        ? h("div", { className: "as-image-fallback", role: "img", "aria-label": copy.imageAlt }, copy.imageError)
        : h("img", { className: "as-scene", src: scene2x, srcSet: `${scene1x} 420w, ${scene2x} 840w`,
          sizes: "(max-width: 640px) calc(100vw - 64px), 420px", width: 420, height: 268, fetchPriority: "high", loading: "eager",
          alt: copy.imageAlt, onError: () => setImageFailed(true) }),
        h("figcaption", { className: "as-caption" }, copy.caption))),
    h("div", { className: "as-setup" },
      h("div", { className: "as-setup-head" }, h("h3", { className: "as-setup-title" }, copy.setup),
        h("span", { className: "as-badge", "data-state": badge }, labels[badge])),
      h("div", { className: "as-native-form" }, h(SettingsForm, {
        labels: { unavailable: copy.unavailable, readOnly: copy.readOnly, saveFailed: copy.saveFailed, save: copy.save, saving: copy.saving },
        state: state.shell, onSave: actions.save, onDiscard: actions.discard,
        children: h(SettingsValueField, { id: "agent-site-executable", label: copy.path, hint: copy.hint, text: state.field.text,
          overridden: state.field.overridden, invalid: state.field.invalid, overriddenLabel: copy.overridden, resetLabel: copy.reset,
          invalidLabel: copy.invalid, disabled, onEdit: value => actions.edit("executablePath", value), onReset: () => actions.resetField("executablePath") }),
      })),
      h("div", { className: "as-actions" }, action.primary === "download" ? download("as-primary")
        : h(Button, { className: "as-primary", variant: "primary", disabled: !local || disabled || state.shell.dirty || status.kind === "pending",
          ...{ "data-agent-site-action": "open" }, onClick: () => void open.open() }, status.kind === "pending" ? copy.pending : copy.open),
        action.secondary === "download" ? download("as-secondary") : h(Button, { className: "as-secondary", variant: "outline",
          onClick: () => document.getElementById("agent-site-executable")?.focus(), ...{ "data-agent-site-action": "path" } }, copy.focusPath)),
      h("p", { className: "as-feedback", role: "status", "aria-live": "polite" }, feedback),
      h("div", { className: "as-compat" }, h("span", null, "Windows 11 x64"), h("span", null, copy.localShort), h("span", null, copy.dshReadOnly))));
}
