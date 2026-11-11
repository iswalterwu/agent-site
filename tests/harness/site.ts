// 测试用：按"一个工地"的旧形状造快照，省得每个用例都拼 site 包装。
import { activeSite } from "../../src/core/site";
import { buildSnapshot } from "../../src/core/snapshot";
import type { FeatureInput, Harness, SessionState, SiteConfig, SiteSnapshot, SiteView, SourceStatus } from "../../src/core/types";

export interface SiteFixture {
  now: number;
  repo: { path: string; name: string };
  features: FeatureInput[];
  sessions: SessionState[];
  config: SiteConfig;
  sources: Record<Harness, SourceStatus>;
  diagnostics: string[];
  mini?: boolean;
  backlog?: string[];
}

export const snapshotOf = (o: SiteFixture): SiteSnapshot => buildSnapshot({
  now: o.now,
  sites: [{ key: o.repo.path, path: o.repo.path, name: o.repo.name, kind: "git", mini: o.mini ?? false,
    features: o.features, backlog: o.backlog ?? [], sessions: o.sessions }],
  active: o.repo.path,
  config: o.config,
  sources: o.sources,
  diagnostics: o.diagnostics,
});

/** 样例里只有一个工地，直接取它 */
export const siteOf = (o: SiteFixture): SiteView => {
  const site = activeSite(snapshotOf(o));
  if (site === null) throw new Error("fixture has no site");
  return site;
};

/** 换掉唯一那个工地上的字段（workers、designer、bands 等），别的照旧 */
export const withSite = (snap: SiteSnapshot, patch: Partial<SiteView>): SiteSnapshot => ({
  ...snap,
  sites: snap.sites.map(site => (patch.key === undefined || site.key === patch.key ? { ...site, ...patch } : site)),
});
