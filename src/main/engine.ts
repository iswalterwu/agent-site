import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isUnder, normalizePath } from "../bridge/scope";
import { buildSnapshot } from "../core/snapshot";
import { baseName } from "../core/text";
import { applyEvents, newSession } from "../core/session";
import type { FeatureInput, Harness, SessionMeta, SessionState, SiteEvent, SiteInput, SiteSnapshot, SourceStatus } from "../core/types";
import { readPiHeader, unifyPi } from "../core/unify/pi";
import { claudeRecordInfo, readClaudeAgentMeta, unifyClaude } from "../core/unify/claude";
import { readDshHeader, unifyDsh } from "../core/unify/dsh";
import { discover, type Found, type Roots } from "./discover";
import { JsonlTail } from "./readers/jsonl";
import { ZstdTail } from "./readers/zstd";
import { gitBranch, siteKeyOf, type SiteKey } from "./repo";
import type { Settings } from "./settings";
import { featuresStamp, readFeatures } from "./intent-card";
import { readBacklog } from "./backlog";

export interface EngineOptions {
  settings: Settings; roots: Roots; diagnostics?: string[];
  now?: () => number; pollMs?: number; minIntervalMs?: number; watch?: boolean;
  /** 取 git 分支；测试可换掉，省得每个用例都真跑 git */
  gitBranch?: (cwd: string) => Promise<string | null>;
  /** 认工地键（git 仓库根或运行目录）；测试可换掉，省得每个用例都真跑 git */
  siteKey?: (cwd: string) => Promise<SiteKey>;
}
interface Tracker {
  harness: Harness; tail: JsonlTail | ZstdTail; state: "new" | "belongs" | "ignored";
  size?: number; mtimeMs?: number; session?: SessionState; badLines: number; unknownRecords: number;
  /** 归属的工地键：规范化后的 git 仓库根或运行目录（判等用） */
  site?: string;
  /** 工地路径原样（显示、读 specs 用） */
  sitePath?: string;
  siteKind?: "git" | "dir";
  /** 配置里额外固定过的工地用它给的名字，其余用目录名 */
  siteName?: string;
  /** 进不了工地时的说明（比如会话没有工作目录），写进快照诊断 */
  note?: string;
}
/** 工地里最近一次事件的时间；没有会话的工地按 0 算 */
const newest = (site: SiteInput): number => site.sessions.reduce((at, session) => Math.max(at, session.lastEventAt), 0);

/** 按名字排；同名工地按 key 排，好让 #2、#3 的编号稳定 */
const byName = (a: SiteInput, b: SiteInput): number =>
  a.name === b.name ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.name < b.name ? -1 : 1;

/** 按普通目录处理的结果只信这么久：那次可能是 git 超时，或者目录后来才 git init */
const NEGATIVE_TTL_MS = 5 * 60_000;

/** 键缓存和分支缓存只是省几次 git，这么久没用过就清掉；App 一开几周，缓存不能只增不删 */
const CACHE_KEEP_MS = 60 * 60_000;

/** 一次最多画这么多个工地；多出来的按最近活动丢掉，诊断里说一声 */
const MAX_SITES = 12;
const HARNESSES = ["pi", "claude", "dsh"] as const;
const converters = { pi: unifyPi, claude: unifyClaude, dsh: unifyDsh };
const content = (s: SiteSnapshot): string => JSON.stringify({ ...s, at: 0 });
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** 只负责读取、调度和组装；归属、状态和展示文本交给已有的纯核心。 */
export class SiteEngine {
  private readonly now: () => number;
  private readonly gitBranch: (cwd: string) => Promise<string | null>;
  private readonly siteKey: (cwd: string) => Promise<SiteKey>;
  private readonly featureCache = new Map<string, { stamp: string; features: FeatureInput[]; backlog: string[] }>();
  /** 按 cwd 缓存工地键：否定结果（按普通目录处理）只信 5 分钟，那次可能是 git 超时；usedAt 只在命中时动，用来淘汰 */
  private readonly siteKeys = new Map<string, { at: number; usedAt: number; key: SiteKey }>();
  private readonly trackers = new Map<string, Tracker>();
  private readonly branches = new Map<string, { at: number; usedAt: number; branch: string | null }>();
  private readonly sources: Record<Harness, SourceStatus>;
  private latest: SiteSnapshot;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(s: SiteSnapshot) => void>();
  private pushedContent?: string;
  private pushedAt = 0;
  private pushTimer?: ReturnType<typeof setTimeout>;
  private debounce?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private readonly watchers = new Set<FSWatcher>();
  private stopped = false;
  private generation = 0;
  private starting?: Promise<void>;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? Date.now;
    this.gitBranch = opts.gitBranch ?? gitBranch;
    this.siteKey = opts.siteKey ?? siteKeyOf;
    const source = (h: Harness): SourceStatus => ({ root: opts.roots[h], present: existsSync(opts.roots[h]),
      sessions: 0, badLines: 0, unknownRecords: 0, lastError: null });
    this.sources = { pi: source("pi"), claude: source("claude"), dsh: source("dsh") };
    this.latest = buildSnapshot({ now: this.now(), sites: [], active: null, config: opts.settings,
      sources: this.sources, diagnostics: opts.diagnostics ?? [] });
  }

  refresh(): Promise<void> {
    const next = this.queue.then(() => this.refreshRound());
    // 调用者仍能看到本轮拒绝；内部队列恢复，下一轮照常执行。
    this.queue = next.catch(() => {});
    return next;
  }

  private async refreshRound(): Promise<void> {
    const since = this.now() - this.opts.settings.thresholds.onsiteHours * 3_600_000;
    for (const h of HARNESSES) {
      const source = this.sources[h];
      source.present = existsSync(this.opts.roots[h]);
      source.lastError = null;
      try {
        // discover 的 Promise 覆盖三个根；空路径由其 ENOENT 分支跳过，让错误按来源隔离。
        const roots: Roots = { pi: "", claude: "", dsh: "", [h]: this.opts.roots[h] };
        for (const found of await discover(roots, since)) {
          try { await this.read(found); }
          catch (error) { source.lastError = errorText(error); }
        }
      } catch (error) { source.lastError = errorText(error); }
    }
    this.prune(); // 清掉文件没了的会话状态和过期的缓存，来源统计只看留下来的
    for (const h of HARNESSES) {
      const source = this.sources[h];
      const tracked = [...this.trackers.values()].filter(t => t.harness === h);
      source.sessions = tracked.filter(t => t.state === "belongs").length;
      source.badLines = tracked.reduce((sum, t) => sum + t.badLines, 0);
      source.unknownRecords = tracked.reduce((sum, t) => sum + t.unknownRecords, 0);
    }
    this.latest = await this.snapshotOfSites();
    this.schedulePush();
  }

  private tail(found: Found): JsonlTail | ZstdTail { return found.harness === "dsh" ? new ZstdTail(found.file) : new JsonlTail(found.file); }

  private async read(found: Found): Promise<void> {
    let t = this.trackers.get(found.file);
    if (!t) {
      t = { harness: found.harness, tail: this.tail(found), state: "new", badLines: 0, unknownRecords: 0 };
      this.trackers.set(found.file, t);
    }
    if (t.size === found.size && t.mtimeMs === found.mtimeMs) return;
    // 之前判成无关的会话，文件变了就再确认一次归属：那次判定可能是 git 超时，不能一直不认
    if (t.state === "ignored") t.state = "new";
    // 尚无完整身份时，不能消费前一批；文件变动后必须连头部一起重试。
    if (t.state === "new") t.tail = this.tail(found);
    const batch = await t.tail.read();
    if (batch.reset) {
      t.state = "new"; t.session = undefined; t.badLines = 0; t.unknownRecords = 0;
    }
    let badLines = 0;
    const records = batch.lines.map(line => { try { return JSON.parse(line) as unknown; } catch { badLines++; return undefined; } });
    if (t.state === "new") {
      const meta = await this.metadata(found, records);
      if (meta) {
        const site = await this.siteOf(meta.cwd);
        if (site !== null) {
          t.session = newSession(meta); t.state = "belongs";
          t.site = site.key; t.sitePath = site.path; t.siteKind = site.kind; t.siteName = site.name; t.note = undefined;
        } else {
          t.state = "ignored";
          // 只写短键：诊断会进快照，长 ID 没必要全带出去
          if (meta.cwd.trim() === "") t.note = `会话 ${meta.harness}:${meta.nativeId.slice(0, 8)} 没有工作目录，没上工地`;
        }
      }
    }
    if (t.session) {
      let session = t.session;
      if (found.harness === "claude") {
        const branch = records.map(claudeRecordInfo).findLast(info => info.branch !== undefined)?.branch;
        if (branch !== undefined) session = { ...session, meta: { ...session.meta, branch } };
      } else {
        const branch = await this.branch(session.meta.cwd);
        const { branch: _oldBranch, ...meta } = session.meta;
        session = { ...session, meta: { ...meta, ...(branch === null ? {} : { branch }) } };
      }
      const events: SiteEvent[] = []; let unknownRecords = 0;
      for (const record of records) {
        if (record === undefined) continue;
        const converted = converters[found.harness](record);
        if (converted === null) unknownRecords++;
        else for (const event of converted) events.push(event);
      }
      t.session = applyEvents(session, events);
      t.badLines += badLines; t.unknownRecords += unknownRecords;
    }
    // 读取和处理完成后才提交 fingerprint；占用/关闭失败可原样重试。
    t.size = found.size; t.mtimeMs = found.mtimeMs;
  }

  private async metadata(found: Found, records: unknown[]): Promise<SessionMeta | null> {
    const { harness, file } = found;
    if (harness === "claude") {
      const infos = records.map(claudeRecordInfo), cwd = infos.find(i => i.cwd !== undefined)?.cwd ?? "";
      const startedAt = infos.find(i => i.ts !== undefined)?.ts;
      if (startedAt === undefined) return null;
      const name = path.basename(file, ".jsonl");
      const relative = path.relative(this.opts.roots.claude, file).split(path.sep);
      const child = relative.length === 4 && relative[2] === "subagents";
      const sid = child ? path.basename(path.dirname(path.dirname(file))) : name;
      const nativeId = child ? `${sid}/${name.slice("agent-".length)}` : sid;
      let level = 1;
      if (child) {
        let raw = "";
        try {
          const sidecar = file.replace(/\.jsonl$/, ".meta.json");
          // 与日志发现一样排除静态链接和非普通文件，不沿 metadata 链接读取外部文件。
          if ((await lstat(sidecar)).isFile()) raw = await readFile(sidecar, "utf8");
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        level = (readClaudeAgentMeta(raw)?.spawnDepth ?? 1) + 1;
      }
      return { key: `claude:${nativeId}`, harness, nativeId, file, cwd, startedAt, level,
        ...(child ? { parentKey: `claude:${sid}` } : {}) };
    }
    const dsh = harness === "dsh" ? readDshHeader(records[0]) : null;
    const header = harness === "pi" ? readPiHeader(records[0]) : dsh;
    if (!header) return null;
    // 分支等确认归属于被监视仓库之后再取，别为不相干的会话跑 git
    return { key: `${harness}:${header.id}`, harness, nativeId: header.id, file, cwd: header.cwd, startedAt: header.startedAt,
      level: (dsh?.depth ?? 0) + 1,
      ...(dsh?.parentId ? { parentKey: `dsh:${dsh.parentId}` } : {}) };
  }

  /** 会话属于哪个工地：配置里额外固定的 repos 先看（按路径包含），否则问 git，不是仓库就是运行目录 */
  private async siteOf(cwd: string): Promise<(SiteKey & { name?: string }) | null> {
    if (cwd.trim() === "") return null;
    const extra = this.opts.settings.repos.find(repo => isUnder(cwd, repo.path));
    const pinned = (repo: { path: string; name: string }): SiteKey & { name: string } =>
      ({ key: normalizePath(repo.path), path: path.resolve(repo.path), kind: "git", name: repo.name });
    if (extra !== undefined) return pinned(extra);
    const key = await this.cachedSiteKey(cwd);
    // 认出来的正好是配置里固定的那个仓库（会话可能在它外面的 worktree 里）：沿用配置里的名字和写法
    const same = this.opts.settings.repos.find(repo => normalizePath(repo.path) === key.key);
    return same === undefined ? key : pinned(same);
  }

  /** 认工地键，按 cwd 缓存；按普通目录处理的结果 5 分钟后再问一次：git 超时、目录后来才变成仓库都能翻身 */
  private async cachedSiteKey(cwd: string): Promise<SiteKey> {
    const at = this.now();
    const cached = this.siteKeys.get(cwd);
    if (cached !== undefined && (cached.key.kind === "git" || at - cached.at < NEGATIVE_TTL_MS)) {
      cached.usedAt = at; // 命中才算"用过"，淘汰看的是这个
      return cached.key;
    }
    const key = await this.siteKey(cwd);
    this.siteKeys.set(cwd, { at, usedAt: at, key });
    return key;
  }

  /** 一个工地的 features：specs 下每份 spec.md 的指纹没变就用缓存，勾步骤这类编辑也能马上看到 */
  private async featuresOf(site: string): Promise<{ features: FeatureInput[]; backlog: string[] }> {
    const stamp = await featuresStamp(site);
    const cached = this.featureCache.get(site);
    if (cached !== undefined && cached.stamp === stamp) return cached;
    const entry = { stamp, features: await readFeatures(site), backlog: await readBacklog(site) };
    this.featureCache.set(site, entry);
    return entry;
  }

  /** 把会话按工地分组，每个工地读自己的 specs；没有意图卡的工地画成一层矮楼 */
  private async snapshotOfSites(): Promise<SiteSnapshot> {
    const since = this.now() - this.opts.settings.thresholds.onsiteHours * 3_600_000;
    const bySite = new Map<string, SiteInput>();
    for (const tracker of this.trackers.values()) {
      const session = tracker.session;
      if (session === undefined || tracker.state !== "belongs" || tracker.site === undefined) continue;
      // 窗口期过了又没新事件的会话不再上工地：工地跟着它一起消失，钉住和桥接范围也一起收
      if (session.lastEventAt < since) continue;
      // 还没认成仓库的工地：目录可能后来才 git init，或者当初 git 超时了，按 cwd 缓存的节奏再看一次。
      // 同一个路径从普通目录变成仓库时 key 不变，所以不能只看 key
      if (tracker.siteKind === "dir") {
        const again = await this.siteOf(session.meta.cwd);
        if (again !== null) {
          tracker.site = again.key; tracker.sitePath = again.path; tracker.siteKind = again.kind; tracker.siteName = again.name;
        }
      }
      const key = tracker.site;
      let site = bySite.get(key);
      if (site === undefined) {
        const shown = tracker.sitePath ?? key;
        site = { key, path: shown, name: tracker.siteName ?? baseName(shown), kind: tracker.siteKind ?? "dir",
          mini: false, features: [], backlog: [], sessions: [] };
        bySite.set(key, site);
      }
      site.sessions.push(session);
    }
    // 超出上限时丢最久没动静的工地，留下的按名字排，菜单里顺序稳定
    const byActivity = [...bySite.values()].sort((a, b) => newest(b) - newest(a) || byName(a, b));
    const dropped = byActivity.slice(MAX_SITES).map(site => site.name);
    const kept = byActivity.slice(0, MAX_SITES).sort(byName);
    // 同名工地加序号，菜单里分得清
    const seen = new Map<string, number>();
    for (const site of kept) {
      const n = (seen.get(site.name) ?? 0) + 1;
      seen.set(site.name, n);
      if (n > 1) site.name = `${site.name} #${n}`;
    }
    for (const site of kept) {
      const { features, backlog } = await this.featuresOf(site.path);
      site.features = features;
      site.backlog = backlog;
      // specs 里一张意图卡都没有才可能画矮楼；有意图卡但读不出 / 没拆切片的 feature
      // 仍各占一段篷布楼段。没有意图卡但有会话待办时，楼段由待办生成（SITE-7）
      site.mini = site.features.length === 0;
    }
    const active = this.pickActive(kept);
    const notes = dropped.length === 0 ? [] : [`工地超过 ${MAX_SITES} 个，按最近活动只画前 ${MAX_SITES} 个：${dropped.join("、")} 没画`];
    const missingCwd = [...this.trackers.values()].flatMap(tracker => tracker.note === undefined ? [] : [tracker.note]);
    const todoNotes = kept.flatMap(site => {
      if (site.features.length > 0) return [];
      const withTodos = site.sessions.filter(session => session.meta.level === 1 && (session.todos?.length ?? 0) > 0);
      const notes: string[] = [];
      if (withTodos.length > 6) notes.push(`${site.name} 有 ${withTodos.length} 个带待办的会话，只画前 6 段`);
      const over = withTodos.filter(session => (session.todos?.length ?? 0) > 12).length;
      if (over > 0) notes.push(`${site.name} 有 ${over} 个会话的待办超过 12 条，只画前 12 层`);
      return notes;
    });
    return buildSnapshot({ now: this.now(), sites: kept, active, config: this.opts.settings,
      sources: this.sources, diagnostics: [...(this.opts.diagnostics ?? []), ...notes, ...missingCwd, ...todoNotes] });
  }

  /**
   * 清掉这一轮没用上的缓存：窗口期外的会话、已经从工地列表里消失的 specs、太久没用过的键和分支缓存。
   * 窗口期外的会话本来就画不上工地（见 snapshotOfSites），留着只是白占内存；它的文件再追加时会被当成新会话重读
   */
  private prune(): void {
    // 只删文件已经没了的会话状态：重新发现一个还在的文件时只读头尾两段（见 readers/jsonl.ts），
    // 中间那段的状态（派工归属、待办）恢复不出来，而文件随时可能被追加到大到读不全 —— 宁可留着
    for (const file of this.trackers.keys()) if (!existsSync(file)) this.trackers.delete(file);
    // 用的是上一轮快照里的工地：这一轮还没组装出来，晚一轮再清这些 specs 缓存没有影响
    const keptSites = new Set<string>(this.latest.sites.map(site => site.path));
    for (const site of this.featureCache.keys()) if (!keptSites.has(site)) this.featureCache.delete(site);
    const stale = (entry: { usedAt: number }): boolean => this.now() - entry.usedAt >= CACHE_KEEP_MS;
    for (const [cwd, entry] of this.siteKeys) if (stale(entry)) this.siteKeys.delete(cwd);
    for (const [cwd, entry] of this.branches) if (stale(entry)) this.branches.delete(cwd);
  }

  /** 当前工地：最近有事件的工地；没有事件时取第一个 */
  private pickActive(sites: readonly SiteInput[]): string | null {
    let best: { key: string; at: number } | null = null;
    for (const site of sites) for (const session of site.sessions) {
      if (best === null || session.lastEventAt > best.at) best = { key: site.key, at: session.lastEventAt };
    }
    return best?.key ?? sites[0]?.key ?? null;
  }

  private async branch(cwd: string): Promise<string | null> {
    if (!existsSync(cwd)) return null;
    const cached = this.branches.get(cwd), at = this.now();
    if (cached && at - cached.at < 60_000) { cached.usedAt = at; return cached.branch; }
    const branch = await this.gitBranch(cwd); this.branches.set(cwd, { at, usedAt: at, branch }); return branch;
  }

  snapshot(): SiteSnapshot { return this.latest; }
  onSnapshot(listener: (s: SiteSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  private schedulePush(): void {
    if (this.stopped) return;
    if (content(this.latest) === this.pushedContent) {
      clearTimeout(this.pushTimer); this.pushTimer = undefined; return;
    }
    const remaining = (this.opts.minIntervalMs ?? 250) - (this.now() - this.pushedAt);
    if (this.pushedContent === undefined || remaining <= 0) {
      clearTimeout(this.pushTimer); this.pushTimer = undefined; this.push();
    } else if (this.pushTimer === undefined) {
      this.pushTimer = setTimeout(() => { this.pushTimer = undefined; if (!this.stopped) this.push(); }, remaining);
    }
  }
  private push(): void {
    const next = content(this.latest);
    if (next === this.pushedContent) return;
    this.pushedContent = next; this.pushedAt = this.now();
    for (const listener of this.listeners) listener(this.latest);
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopped = false; const generation = ++this.generation;
    this.starting = this.startRun(generation).catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }
  private async startRun(generation: number): Promise<void> {
    await this.refresh();
    if (this.stopped || generation !== this.generation) return;
    if (this.opts.watch ?? true) {
      const specDirs = this.latest.sites.map(site => path.join(site.path, "specs"));
      for (const dir of [...Object.values(this.opts.roots), ...specDirs]) {
        if (!existsSync(dir)) continue;
        try {
          const watcher = watch(dir, { recursive: true }, () => {
            if (this.stopped || generation !== this.generation) return;
            clearTimeout(this.debounce);
            this.debounce = setTimeout(() => { this.debounce = undefined; this.backgroundRefresh(); }, 100);
          });
          watcher.on("error", () => { watcher.close(); this.watchers.delete(watcher); });
          this.watchers.add(watcher);
        } catch { /* 目录刚消失或平台不支持递归监听时，继续靠轮询。 */ }
      }
    }
    this.poll = setInterval(() => this.backgroundRefresh(), this.opts.pollMs ?? 2000);
  }
  private backgroundRefresh(): void { if (!this.stopped) void this.refresh().catch(() => {}); }
  stop(): void {
    this.stopped = true; this.generation++; this.starting = undefined;
    clearInterval(this.poll); clearTimeout(this.debounce); clearTimeout(this.pushTimer);
    this.poll = undefined; this.debounce = undefined; this.pushTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers.clear();
  }
}
