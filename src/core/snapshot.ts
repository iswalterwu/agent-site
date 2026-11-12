import { t } from "./i18n";
import { redact } from "./redact";
import { buildSite } from "./site";
import type { SnapshotInput, SiteSnapshot } from "./types";

/** 全部工地 + 当前工地；diagnostics 里带上需要补配置的 feature */
export function buildSnapshot(input: SnapshotInput): SiteSnapshot {
  const sites = input.sites.map(site => buildSite(site, input.config, input.now));
  const missing = input.sites.flatMap(site => site.mini ? []
    : site.features.filter(f => !input.config.features.some(c => c.name === f.name))
      .map(f => t(input.config.locale ?? "zh-CN", "feature {feature} 不在 settings.json 的 features 里，先按未归类画在最上面", { feature: f.name })));
  const active = input.active !== null && input.sites.some(s => s.key === input.active) ? input.active : (input.sites[0]?.key ?? null);
  return { at: input.now, sites, active,
    sources: { pi: safeSource(input.sources.pi), claude: safeSource(input.sources.claude), dsh: safeSource(input.sources.dsh) },
    diagnostics: [...input.diagnostics, ...missing].map(redact) };
}

function safeSource(source: SnapshotInput["sources"]["pi"]): SnapshotInput["sources"]["pi"] {
  return { ...source, lastError: source.lastError === null ? null : redact(source.lastError) };
}
