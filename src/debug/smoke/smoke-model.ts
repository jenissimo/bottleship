/**
 * Manual smoke-run checklist — the pure model behind the dev "Smoke run" tool.
 *
 * A run is one pass over one SOURCE (the library catalog, or one local folder of `.wgb`s)
 * on one build: an ordered item list plus a verdict per item. Runs are kept per source, the
 * previous ones in a short history, so a pass on a new build can be read against the last
 * one ("was OK, now a regression"). Nothing here touches the DOM or storage directly —
 * the store functions take a Storage-shaped object — so all of it is unit-tested
 * (tools/tests/smoke-run-model.test.ts).
 */

export type SmokeStatus = "untested" | "ok" | "regression" | "skip";
export type SmokeFilter = "all" | "unchecked" | "regressions";
/** Item-level comparison with the previous run on the same source. */
export type SmokeDiff = "regressed" | "fixed" | null;

/** How to start an item: a catalog title boots via `?game=<id>` like the library does;
 *  a disk bundle streams its absolute path through the dev `.wgb` routes. */
export type SmokeLaunch =
  | { kind: "catalog"; id: string }
  | { kind: "disk"; path: string };

export interface SmokeItem {
  /** Stable within a source: the catalog id or the absolute bundle path. */
  key: string;
  name: string;
  /** Secondary line (catalog id, bundle size…) — display only. */
  detail?: string;
  launch: SmokeLaunch;
}

export interface SmokeResult {
  status: SmokeStatus;
  note: string;
  at: number;
}

export type SmokeSource =
  | { kind: "library" }
  | { kind: "local"; root: string; dir: string };

export interface SmokeRun {
  version: 1;
  id: string;
  source: SmokeSource;
  /** Human label of the source, as it appears in the report header. */
  sourceLabel: string;
  /** Commit the dev server was started from (`__BUILD_SHA__`), or the date when unknown. */
  build: string;
  appVersion: string;
  startedAt: number;
  items: SmokeItem[];
  results: Record<string, SmokeResult>;
}

export interface SmokeSourceState {
  current: SmokeRun;
  /** Most recent first. */
  history: SmokeRun[];
}

export interface SmokeStore {
  version: 1;
  /** sourceKey of the source last opened in the tool. */
  lastSource?: string;
  runs: Record<string, SmokeSourceState>;
}

export const SMOKE_STORE_KEY = "bs.smoke-run.v1";
export const MAX_HISTORY = 5;

export const STATUS_LABEL: Record<SmokeStatus, string> = {
  untested: "Unchecked",
  ok: "OK",
  regression: "Regression",
  skip: "Skipped",
};

/** Glyphs double the colour coding (colour alone must not carry the verdict). */
export const STATUS_GLYPH: Record<SmokeStatus, string> = {
  untested: "○",
  ok: "✓",
  regression: "✗",
  skip: "–",
};

// ---------------------------------------------------------------------------
// Sources and builds

export function sourceKey(source: SmokeSource): string {
  return source.kind === "library" ? "library" : `local:${source.root}|${source.dir}`;
}

/** `G:\WGB` + `running` → `WGB/running`; the root's last two segments keep two roots'
 *  same-named folders apart without printing a whole absolute path in the header. */
export function localFolderLabel(root: string, dir: string): string {
  const rootLeaf = root.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2).join("/");
  return dir ? `${rootLeaf}/${dir.replace(/\\/g, "/")}` : rootLeaf;
}

export function sourceLabel(source: SmokeSource): string {
  return source.kind === "library" ? "Library catalog" : `Local folder ${localFolderLabel(source.root, source.dir)}`;
}

/** The build a run is pinned to: the commit when the dev server knows it, else the date. */
export function buildId(sha: string | undefined, now: number): string {
  const s = (sha ?? "").trim();
  if (s && s !== "dev" && s !== "unknown") return s;
  return `date-${new Date(now).toISOString().slice(0, 10)}`;
}

export interface LocalEntry {
  path: string;
  name: string;
  root: string;
  dir: string;
  size: number;
}

export interface LocalFolder {
  root: string;
  dir: string;
  label: string;
  count: number;
}

/** Folders that directly hold bundles, in listing order of first appearance. */
export function localFolders(entries: readonly LocalEntry[]): LocalFolder[] {
  const byKey = new Map<string, LocalFolder>();
  for (const e of entries) {
    const k = `${e.root}|${e.dir}`;
    const f = byKey.get(k);
    if (f) f.count += 1;
    else byKey.set(k, { root: e.root, dir: e.dir, label: localFolderLabel(e.root, e.dir), count: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Default local folder: one whose last segment is `running`, else the first. */
export function defaultLocalFolder(folders: readonly LocalFolder[]): LocalFolder | null {
  return folders.find((f) => /(^|[\\/])running$/i.test(f.dir)) ?? folders[0] ?? null;
}

export function localItems(entries: readonly LocalEntry[], root: string, dir: string): SmokeItem[] {
  return entries
    .filter((e) => e.root === root && e.dir === dir)
    .map((e) => ({
      key: e.path,
      name: e.name.replace(/\.wgb$/i, ""),
      detail: formatSize(e.size),
      launch: { kind: "disk", path: e.path } as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export interface CatalogLike {
  id: string;
  name: string;
  subtitle?: string;
  status?: string;
}

export function catalogItems(games: readonly CatalogLike[]): SmokeItem[] {
  return games.map((g) => ({
    key: g.id,
    name: g.subtitle ? `${g.name} — ${g.subtitle}` : g.name,
    detail: g.status === "setup" ? `${g.id} · needs install files` : g.id,
    launch: { kind: "catalog", id: g.id } as const,
  }));
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Page URL (relative query) that boots an item: `?game=<id>` like the library, or
 *  `?game=dev&load=<bundleUrl>` like the Add-Game flow. `bundleUrl` is the streaming URL
 *  of a disk bundle (diskBundleUrl) and is ignored for catalog items. */
export function launchUrl(item: SmokeItem, bundleUrl: string | null): string {
  if (item.launch.kind === "catalog") return `?game=${encodeURIComponent(item.launch.id)}`;
  return `?game=dev&load=${encodeURIComponent(bundleUrl ?? "")}`;
}

/** Is the page open right now the one the item launches? Keeps the in-game panel from
 *  sticking to an unrelated game opened by hand later in the same tab. */
export function itemMatchesLocation(item: SmokeItem, search: string): boolean {
  const params = new URLSearchParams(search);
  const game = params.get("game");
  if (item.launch.kind === "catalog") return game === item.launch.id;
  if (game !== "dev") return false;
  const load = params.get("load");
  const q = load ? load.indexOf("?") : -1;
  return q >= 0 && new URLSearchParams(load!.slice(q + 1)).get("path") === item.launch.path;
}

// ---------------------------------------------------------------------------
// Run state

export function createRun(opts: {
  source: SmokeSource;
  items: SmokeItem[];
  build: string;
  appVersion: string;
  now: number;
  id?: string;
}): SmokeRun {
  return {
    version: 1,
    id: opts.id ?? `${opts.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    source: opts.source,
    sourceLabel: sourceLabel(opts.source),
    build: opts.build,
    appVersion: opts.appVersion,
    startedAt: opts.now,
    items: opts.items,
    results: {},
  };
}

/** Replace the item list after a rescan. Verdicts are keyed by item and kept even for an
 *  item that disappeared, so a bundle moved out and back keeps its row. Returns the same
 *  object when nothing changed (cheap equality for the store). */
export function syncItems(run: SmokeRun, items: SmokeItem[]): SmokeRun {
  const same = run.items.length === items.length
    && run.items.every((it, i) => it.key === items[i].key && it.name === items[i].name && it.detail === items[i].detail);
  return same ? run : { ...run, items };
}

export function statusOf(run: SmokeRun | null | undefined, key: string): SmokeStatus {
  return run?.results[key]?.status ?? "untested";
}

export function noteOf(run: SmokeRun | null | undefined, key: string): string {
  return run?.results[key]?.note ?? "";
}

export function setStatus(run: SmokeRun, key: string, status: SmokeStatus, now: number): SmokeRun {
  const prev = run.results[key];
  return { ...run, results: { ...run.results, [key]: { status, note: prev?.note ?? "", at: now } } };
}

export function setNote(run: SmokeRun, key: string, note: string, now: number): SmokeRun {
  const prev = run.results[key];
  if ((prev?.note ?? "") === note) return run;
  return { ...run, results: { ...run.results, [key]: { status: prev?.status ?? "untested", note, at: now } } };
}

export interface SmokeCounts {
  total: number;
  ok: number;
  regression: number;
  skip: number;
  untested: number;
  /** Items with a verdict (OK, regression or skipped). */
  done: number;
}

/** Counted over the CURRENT item list — a stale verdict for a removed bundle is not work done. */
export function countRun(run: SmokeRun): SmokeCounts {
  const c: SmokeCounts = { total: run.items.length, ok: 0, regression: 0, skip: 0, untested: 0, done: 0 };
  for (const it of run.items) c[statusOf(run, it.key)] += 1;
  c.done = c.total - c.untested;
  return c;
}

/** The next item still unchecked, walking forward from `afterKey` and wrapping around;
 *  `afterKey` itself is never returned. Null when everything has a verdict. */
export function nextUnchecked(run: SmokeRun, afterKey?: string | null): SmokeItem | null {
  const n = run.items.length;
  if (n === 0) return null;
  const at = afterKey ? run.items.findIndex((it) => it.key === afterKey) : -1;
  for (let step = 1; step <= n; step++) {
    const it = run.items[(at + step + n) % n];
    if (it.key === afterKey) continue;
    if (statusOf(run, it.key) === "untested") return it;
  }
  return null;
}

export function diffStatus(prev: SmokeStatus, cur: SmokeStatus): SmokeDiff {
  if (prev === "ok" && cur === "regression") return "regressed";
  if (prev === "regression" && cur === "ok") return "fixed";
  return null;
}

export function itemDiff(run: SmokeRun, prev: SmokeRun | null | undefined, key: string): SmokeDiff {
  return prev ? diffStatus(statusOf(prev, key), statusOf(run, key)) : null;
}

export interface SmokeComparison {
  regressed: SmokeItem[];
  fixed: SmokeItem[];
}

export function compareRuns(run: SmokeRun, prev: SmokeRun | null | undefined): SmokeComparison {
  const out: SmokeComparison = { regressed: [], fixed: [] };
  if (!prev) return out;
  for (const it of run.items) {
    const d = itemDiff(run, prev, it.key);
    if (d === "regressed") out.regressed.push(it);
    else if (d === "fixed") out.fixed.push(it);
  }
  return out;
}

export function filterItems(run: SmokeRun, filter: SmokeFilter): SmokeItem[] {
  if (filter === "all") return run.items;
  const want: SmokeStatus = filter === "unchecked" ? "untested" : "regression";
  return run.items.filter((it) => statusOf(run, it.key) === want);
}

// ---------------------------------------------------------------------------
// Store (one current run + short history per source)

export function emptyStore(): SmokeStore {
  return { version: 1, runs: {} };
}

export function parseStore(raw: string | null): SmokeStore {
  if (!raw) return emptyStore();
  try {
    const v = JSON.parse(raw) as SmokeStore;
    if (v && v.version === 1 && v.runs && typeof v.runs === "object") return v;
  } catch { /* corrupt — start clean rather than throw in a dev tool */ }
  return emptyStore();
}

export function putCurrent(store: SmokeStore, run: SmokeRun): SmokeStore {
  const k = sourceKey(run.source);
  const prev = store.runs[k];
  return { ...store, lastSource: k, runs: { ...store.runs, [k]: { current: run, history: prev?.history ?? [] } } };
}

/** Start a fresh run on a source. The outgoing run joins the history only if anything
 *  was recorded in it — an abandoned empty run would otherwise push a real one out. */
export function startNewRun(store: SmokeStore, run: SmokeRun): SmokeStore {
  const k = sourceKey(run.source);
  const prev = store.runs[k];
  const keep = prev && Object.keys(prev.current.results).length > 0;
  const history = keep ? [prev.current, ...prev.history].slice(0, MAX_HISTORY) : prev?.history ?? [];
  return { ...store, lastSource: k, runs: { ...store.runs, [k]: { current: run, history } } };
}

export function previousRun(store: SmokeStore, key: string): SmokeRun | null {
  return store.runs[key]?.history[0] ?? null;
}

// ---------------------------------------------------------------------------
// Export

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function mdCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

const MD_STATUS: Record<SmokeStatus, string> = {
  untested: "⬜ Unchecked",
  ok: "✅ OK",
  regression: "❌ Regression",
  skip: "⏭️ Skipped",
};

/** Markdown report for pasting into a chat or an issue. */
export function toMarkdown(run: SmokeRun, prev: SmokeRun | null | undefined, now: number): string {
  const c = countRun(run);
  const cmp = compareRuns(run, prev);
  const lines: string[] = [];
  lines.push(`### Smoke run — ${run.sourceLabel}`);
  lines.push("");
  lines.push(`- Build: \`${run.build}\`${run.appVersion ? ` (v${run.appVersion})` : ""}`);
  lines.push(`- Source: ${run.sourceLabel}`);
  lines.push(`- Started: ${fmtTime(run.startedAt)} · exported: ${fmtTime(now)}`);
  lines.push(`- Checked **${c.done}/${c.total}** — OK ${c.ok} · Regression ${c.regression} · Skipped ${c.skip} · Unchecked ${c.untested}`);
  if (prev) {
    const parts = [`${cmp.regressed.length} new regression(s)`, `${cmp.fixed.length} fixed`];
    lines.push(`- Compared with the run on \`${prev.build}\` (${fmtTime(prev.startedAt)}): ${parts.join(", ")}`);
    if (cmp.regressed.length > 0) lines.push(`- New regressions: ${cmp.regressed.map((it) => mdCell(it.name)).join(", ")}`);
  }
  lines.push("");
  lines.push(prev ? "| # | Game | Status | Previous | Note |" : "| # | Game | Status | Note |");
  lines.push(prev ? "|---|---|---|---|---|" : "|---|---|---|---|");
  run.items.forEach((it, i) => {
    const st = statusOf(run, it.key);
    const d = itemDiff(run, prev, it.key);
    const tag = d === "regressed" ? " **(new)**" : d === "fixed" ? " **(fixed)**" : "";
    const cells = [String(i + 1), mdCell(it.name), MD_STATUS[st] + tag];
    if (prev) cells.push(statusOf(prev, it.key) === "untested" ? "—" : STATUS_LABEL[statusOf(prev, it.key)]);
    cells.push(mdCell(noteOf(run, it.key)));
    lines.push(`| ${cells.join(" | ")} |`);
  });
  return lines.join("\n") + "\n";
}

export interface SmokeJsonExport {
  format: "bottleship-smoke-run";
  version: 1;
  exportedAt: string;
  run: {
    source: SmokeSource;
    sourceLabel: string;
    build: string;
    appVersion: string;
    startedAt: string;
    counts: SmokeCounts;
    items: Array<{ key: string; name: string; status: SmokeStatus; note: string; previous: SmokeStatus | null; diff: SmokeDiff }>;
  };
  previous: { build: string; startedAt: string } | null;
}

export function toJsonExport(run: SmokeRun, prev: SmokeRun | null | undefined, now: number): SmokeJsonExport {
  return {
    format: "bottleship-smoke-run",
    version: 1,
    exportedAt: new Date(now).toISOString(),
    run: {
      source: run.source,
      sourceLabel: run.sourceLabel,
      build: run.build,
      appVersion: run.appVersion,
      startedAt: new Date(run.startedAt).toISOString(),
      counts: countRun(run),
      items: run.items.map((it) => ({
        key: it.key,
        name: it.name,
        status: statusOf(run, it.key),
        note: noteOf(run, it.key),
        previous: prev ? statusOf(prev, it.key) : null,
        diff: itemDiff(run, prev, it.key),
      })),
    },
    previous: prev ? { build: prev.build, startedAt: new Date(prev.startedAt).toISOString() } : null,
  };
}

export function exportFileName(run: SmokeRun, now: number): string {
  const src = run.source.kind === "library" ? "library" : (run.source.dir || "root").replace(/[^\w.-]+/g, "_");
  return `smoke-${src}-${run.build}-${new Date(now).toISOString().slice(0, 10)}.json`;
}
