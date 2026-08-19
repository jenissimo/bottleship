#!/usr/bin/env bun

/**
 * Bottleship Chrome Trace Analyzer
 *
 * Analyzes Chrome DevTools performance traces from the emulator worker.
 * Correctly merges ProfileChunk events, computes self/total time,
 * classifies frames by category (wasm/js/idle/native), and annotates
 * known v86 WASM functions.
 *
 * Usage:
 *   bun tools/analyze-trace.ts <file>           # basic analysis
 *   bun tools/analyze-trace.ts <file> --top 50  # more functions
 *   bun tools/analyze-trace.ts <file> --thread worker  # worker only
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
// ONE definition of the frame-time statistic, shared with the live worker profiler.
import { frameTailFromSamples, type FrameTail } from "../src/worker/core/frame-time-distribution";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface RawNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

interface CpuProfile {
  nodes?: RawNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
}

interface TraceEvent {
  ph: string;
  name: string;
  pid: number;
  tid: number;
  ts: number;
  args?: {
    name?: string;
    data?: {
      cpuProfile?: CpuProfile;
      timeDeltas?: number[];
      lines?: number[];
    };
  };
}

interface MergedProfile {
  nodes: Map<number, RawNode>;
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  startTs: number; // trace timestamp of first sample
}

interface NodeStats {
  node: RawNode;
  selfUs: number;
  totalUs: number;
}

type Category = "wasm" | "js" | "idle" | "native";

interface ThreadAnalysis {
  key: string;
  name: string;
  totalUs: number;
  sampleCount: number;
  nodes: NodeStats[];
  nodeStats: Map<number, { selfUs: number; totalUs: number }>;
  parentMap: Map<number, number>;
  byCategory: Record<Category, number>;
  timelineUs: TimelineBucket[];
  profile: MergedProfile;
}

interface TimelineBucket {
  startUs: number;
  endUs: number;
  byCategory: Record<Category, number>;
  hotFunction: string;
}

interface RenderFrameInterval {
  startTsUs: number;
  endTsUs: number;
  frameMs: number;
}

/** The SHARED statistic (src/worker/core/frame-time-distribution.ts) — a discriminated union,
 *  so a window with nothing measured in it cannot present percentile fields at all. */
type RenderFrameStats = FrameTail;

interface RenderFrameAnalysis {
  markCount: number;
  intervals: RenderFrameInterval[];
  stats: RenderFrameStats;
  budgetMs?: number;
  /** Set when --range narrowed these intervals, so the header can say so. */
  scopedTo?: string;
}

const TIMELINE_BUCKET_US = 2_000_000;

// ─── V86 WASM Annotations ────────────────────────────────────────────────────

const V86_ANNOTATIONS: Array<[string, string]> = [
  ["jit_find_cache_entry_in_page", "JIT: indirect jump lookup (RET/vtable)"],
  ["jit_find_cache_entry", "JIT: cache lookup"],
  ["io_port_write32", "OUT instruction → thunk trigger"],
  ["io_port_write16", "OUT16 instruction"],
  ["io_port_write8", "OUT8 instruction"],
  ["io_port_read32", "IN instruction"],
  ["interpreter", "Interpreter fallback (non-JIT page)"],
  ["safe_read32s", "Guest memory read (TLB miss path)"],
  ["safe_write32", "Guest memory write (TLB miss path)"],
  ["safe_read_write32", "RMW memory op"],
  ["tlb_set_entry", "TLB entry fill"],
  ["do_task_switch", "x86 task switch"],
  ["hypercall", "WASM hypercall dispatch"],
  ["fpu_", "FPU instruction"],
  ["sse_", "SSE instruction"],
  ["run_prefix", "Instruction prefix decode"],
];

// Optional JIT-block mapping: wasm_fn_idx → guest-addr annotation string.
// Populated from --map <file.json>, where the file is the JSON-serialised
// output of worker-side dumpHotJitBlocks() (an array of { wasm_fn, phys_addr,
// module } rows). Used to annotate `wasm-function[N]` with its guest address.
let JIT_BLOCK_MAP: Map<number, string> | null = null;
// Exact-EIP ranking carried in the same bottleship.hotblocks mark (set by
// extractEmbeddedHotBlocks). Pinpoints the hot instruction within a JIT-block page.
let EMBEDDED_TOP_EIPS: any[] | null = null;

interface JitBlockMapBuildStats {
  skipped: number;
  sampleRow: any | null;
}

function findJitBlockRows(raw: any): any[] | null {
  // Accept multiple shapes:
  //   A) array of rows (direct output of dumpHotJitBlocks())
  //   B) { rows: [...] } / { hot_blocks: [...] } / { data: [...] } wrappers
  //   C) any object whose first array-typed field is the rows
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["rows", "hot_blocks", "hotBlocks", "data", "entries", "result"]) {
      if (Array.isArray((raw as any)[key])) return (raw as any)[key];
    }
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) return v as any[];
    }
  }
  return null;
}

function buildJitBlockMapFromRows(rows: any[], stats?: JitBlockMapBuildStats): Map<number, string> {
  const m = new Map<number, string>();
  let skipped = 0;
  let sampleRow: any = null;

  for (const row of rows) {
    if (!sampleRow) sampleRow = row;
    if (!row || typeof row !== "object") { skipped++; continue; }
    // idx: accept wasm_fn="wasm-function[N]" or wasm_fn_idx=N or idx=N
    let idx = NaN;
    if (typeof row.wasm_fn === "string") {
      const match = row.wasm_fn.match(/^wasm-function\[(\d+)\]$/);
      if (match) idx = parseInt(match[1]!, 10);
    }
    if (!Number.isFinite(idx)) {
      const rawIdx = row.wasm_fn_idx ?? row.idx;
      if (typeof rawIdx === "number") {
        idx = rawIdx;
      } else if (typeof rawIdx === "string" && /^\d+$/.test(rawIdx)) {
        idx = parseInt(rawIdx, 10);
      }
    }
    if (!Number.isFinite(idx)) { skipped++; continue; }

    const parts: string[] = [];
    // phys_addr: string "0x..." or number
    const addr = row.phys_addr ?? row.addr ?? row.guest_addr;
    if (typeof addr === "string" && addr.length > 0) parts.push(addr);
    else if (typeof addr === "number") parts.push("0x" + (addr >>> 0).toString(16).padStart(8, "0"));
    if (row.module) parts.push(String(row.module));
    if (parts.length) m.set(idx, parts.join(" "));
    else skipped++;
  }

  if (stats) {
    stats.skipped = skipped;
    stats.sampleRow = sampleRow;
  }
  return m;
}

function summarizeTraceArgs(args: any): string {
  try {
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return String(args).slice(0, 200);
  }
}

function extractEmbeddedHotBlocks(events: any[]): any[] | null {
  let best: any[] | null = null;

  for (const ev of events) {
    if ((ev as any)?.name !== "bottleship.hotblocks") continue;

    const args = (ev as any).args || {};
    let parsed: any = args?.data?.detail ?? args?.data ?? args?.detail;
    for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        break;
      }
    }

    const rows = parsed?.rows;
    if (Array.isArray(rows)) {
      if (!best || rows.length > best.length) {
        best = rows;
        EMBEDDED_TOP_EIPS = Array.isArray(parsed?.topEips) ? parsed.topEips : null;
      }
    } else {
      console.warn(`[analyze-trace] bottleship.hotblocks mark did not contain rows; args=${summarizeTraceArgs(args)}`);
    }
  }

  return best;
}

/** The harness window's UserTiming marks (`frameReport({reset:true})` … `frameReport()`). */
function extractPerfWindow(events: TraceEvent[]): { beginTsUs: number | null; endTsUs: number | null } | null {
  let beginTsUs: number | null = null;
  let endTsUs: number | null = null;
  for (const ev of events) {
    const name = (ev as any)?.name;
    if (name !== "bottleship.perfwindow.begin" && name !== "bottleship.perfwindow.end") continue;
    const ts = (ev as any).ts;
    if (!Number.isFinite(ts)) continue;
    if (name.endsWith("begin")) beginTsUs = beginTsUs === null ? ts : Math.min(beginTsUs, ts);
    else endTsUs = endTsUs === null ? ts : Math.max(endTsUs, ts);
  }
  return beginTsUs === null && endTsUs === null ? null : { beginTsUs, endTsUs };
}

function loadJitBlockMap(path: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));

  const rows = findJitBlockRows(raw);
  if (!rows) {
    console.warn(`[analyze-trace] --map: could not find rows array in ${path}. Expected array or { rows: [...] }.`);
    return;
  }

  const stats: JitBlockMapBuildStats = { skipped: 0, sampleRow: null };
  const m = buildJitBlockMapFromRows(rows, stats);
  JIT_BLOCK_MAP = m;
  if (m.size === 0 && stats.sampleRow) {
    console.warn(`[analyze-trace] --map: 0 entries parsed. First row was: ${JSON.stringify(stats.sampleRow)}`);
    console.warn(`  Expected at least one of: wasm_fn="wasm-function[N]", wasm_fn_idx=N, or idx=N.`);
    console.warn(`  Plus phys_addr / addr / guest_addr (hex string or number).`);
  } else {
    console.log(`[analyze-trace] loaded JIT block map: ${m.size} entries from ${path} (${stats.skipped} rows skipped)`);
  }
}

function traceStem(path: string): string {
  let name = basename(path);
  if (name.endsWith(".gz")) name = name.slice(0, -3);
  if (name.endsWith(".json")) name = name.slice(0, -5);
  return name;
}

function findJitBlockMapSidecar(tracePath: string): string | null {
  const dir = dirname(tracePath);
  const stem = traceStem(tracePath);
  const candidates = [
    join(dir, `${stem}.hot-blocks.json`),
    join(dir, `${stem}.blocks.json`),
    join(dir, `${stem}-hot-blocks.json`),
    join(dir, "hot-blocks.json"),
    join(dir, "blocks.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  try {
    const hotBlockFiles = readdirSync(dir)
      .filter(name => /^hot-blocks.*\.json$/i.test(name))
      .map(name => join(dir, name))
      .filter(path => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    if (hotBlockFiles.length > 0) {
      if (hotBlockFiles.length > 1) {
        console.warn(`[analyze-trace] multiple hot-block sidecars found; using newest: ${hotBlockFiles[0]}`);
      }
      return hotBlockFiles[0]!;
    }
  } catch {
    // Sidecar discovery is best-effort; analysis can proceed without a map.
  }

  return null;
}

function annotateWasm(name: string | undefined): string {
  if (!name) return "";
  for (const [pattern, label] of V86_ANNOTATIONS) {
    if (name.includes(pattern)) return label;
  }
  // Generic wasm-function[N] → JIT block, optionally enriched from mapping file.
  const m = name.match(/^wasm-function\[(\d+)\]$/);
  if (m) {
    const idx = parseInt(m[1]!, 10);
    const mapped = JIT_BLOCK_MAP?.get(idx);
    return mapped
      ? `JIT block (v86 compiled code) → ${mapped}`
      : "JIT block (v86 compiled code)";
  }
  return "";
}

// ─── Frame Classification ────────────────────────────────────────────────────

function classifyFrame(frame: CallFrame): Category {
  const url = frame.url ?? "";
  const name = frame.functionName ?? "";
  if (url.includes("wasm")) return "wasm";
  if (!name && !url) return "native";
  if (name === "(idle)" || name === "(root)" || name === "(program)") return "idle";
  return "js";
}

// ─── Trace Reading ────────────────────────────────────────────────────────────

function readTrace(path: string): { events: TraceEvent[]; rawSize: number; gzipSize: number } {
  const raw = readFileSync(path);
  const gzipSize = raw.length;

  let data: Buffer;
  // Check gzip magic bytes
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    data = gunzipSync(raw);
  } else {
    data = raw;
  }

  const rawSize = data.length;
  const json = JSON.parse(data.toString("utf8")) as
    | { traceEvents: TraceEvent[] }
    | TraceEvent[];

  const events = Array.isArray(json) ? json : json.traceEvents;
  return { events, rawSize, gzipSize };
}

// ─── Thread Name Extraction ───────────────────────────────────────────────────

/**
 * Frame-interval statistics — computed by the SHARED distribution (`frameTailFromSamples`),
 * the same code the live worker profiler runs. The old local implementation hardcoded
 * "> 33.33ms" as the definition of a slow frame (i.e. 30fps as the only budget) and indexed
 * percentiles one rank high, so at n=100 its p99 was literally the max. Both were dialects of
 * a statistic that now has one definition: the budget is the caller's or is derived from the
 * observed cadence, percentiles are bucket upper bounds, and a rank with no observation behind
 * it is withheld instead of interpolated.
 */
function computeRenderFrameStats(intervals: RenderFrameInterval[], budgetMs?: number): RenderFrameStats {
  return frameTailFromSamples(intervals.map(i => i.frameMs), { budgetMs, maxBuckets: 24 });
}

function extractRenderFrameAnalysis(events: TraceEvent[], budgetMs?: number): RenderFrameAnalysis | null {
  const marks = events
    .filter(ev => (ev as any)?.name === "bottleship.flip" && Number.isFinite((ev as any).ts))
    .map(ev => (ev as any).ts as number)
    .sort((a, b) => a - b);

  if (marks.length < 2) return null;

  const intervals: RenderFrameInterval[] = [];
  for (let i = 1; i < marks.length; i++) {
    const startTsUs = marks[i - 1]!;
    const endTsUs = marks[i]!;
    const deltaUs = endTsUs - startTsUs;
    if (!(deltaUs > 0) || !Number.isFinite(deltaUs)) continue;
    intervals.push({
      startTsUs,
      endTsUs,
      frameMs: deltaUs / 1000,
    });
  }

  if (intervals.length === 0) return null;
  const stats = computeRenderFrameStats(intervals, budgetMs);
  return {
    markCount: marks.length,
    intervals,
    stats,
    // Budget actually used: explicit, or the one the distribution derived from this window.
    budgetMs: budgetMs ?? (stats.ok && stats.budget ? stats.budget.ms : undefined),
  };
}

function renderStatsForBucket(
  renderFrames: RenderFrameAnalysis | null,
  workerProfile: MergedProfile,
  bucket: TimelineBucket
): RenderFrameStats {
  if (!renderFrames || !Number.isFinite(workerProfile.startTs)) return computeRenderFrameStats([]);

  const startTsUs = workerProfile.startTs + bucket.startUs;
  const endTsUs = workerProfile.startTs + bucket.endUs;
  const intervals = renderFrames.intervals.filter(interval =>
    interval.endTsUs >= startTsUs && interval.endTsUs < endTsUs
  );
  // The whole-window budget, so per-bucket columns are comparable to each other and to the
  // summary — a per-bucket derived budget would silently move the goal every 2 seconds.
  return computeRenderFrameStats(intervals, renderFrames.budgetMs);
}

/**
 * Category + leaf-function attribution for an arbitrary absolute time range — the same walk
 * buildTimeline does, but for a window the caller chooses (one worst frame, or a perfwindow).
 * `coveragePct` is the instrument's own limit: Chrome samples at ~1ms, so a short frame is
 * attributed from few samples and says so rather than implying precision.
 */
function attributeRange(profile: MergedProfile, startTsUs: number, endTsUs: number, topFns: number) {
  const byCategory: Record<Category, number> = { wasm: 0, js: 0, idle: 0, native: 0 };
  const fns = new Map<string, number>();
  let cumulativeUs = 0;
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0;
    cumulativeUs += dt;
    const abs = profile.startTs + cumulativeUs;
    if (abs < startTsUs || abs >= endTsUs) continue;
    const node = profile.nodes.get(profile.samples[i]!);
    if (!node) continue;
    byCategory[classifyFrame(node.callFrame)] += dt;
    const label = frameLabel(node.callFrame, false);
    fns.set(label, (fns.get(label) ?? 0) + dt);
    totalUs += dt;
  }
  const top = Array.from(fns.entries()).sort((a, b) => b[1] - a[1]).slice(0, topFns);
  const spanUs = Math.max(1, endTsUs - startTsUs);
  // Clamped: a sample's whole delta is charged to the window it lands in, so the raw ratio can
  // exceed 1 at the edges. It is a confidence hint, not an accounting identity.
  return { totalUs, byCategory, top, coveragePct: Math.min(100, (totalUs / spanUs) * 100) };
}

function extractThreadNames(events: TraceEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const ev of events) {
    if (ev.ph === "M" && ev.name === "thread_name" && ev.args?.name) {
      names.set(`${ev.pid}:${ev.tid}`, ev.args.name);
    }
  }
  return names;
}

// ─── Profile Chunk Merge ──────────────────────────────────────────────────────

/**
 * Chrome Profiling Format Notes:
 *
 * - ph="P" name="Profile" event: marks start of a profiling session.
 *   Has an `id` field (e.g. "0x1"), and is sent on the NAMED thread's tid.
 *   The args.data.cpuProfile is typically empty here.
 *
 * - ph="P" name="ProfileChunk" events: carry the actual CPU samples.
 *   Share the same `pid` and `id` as the Profile event, but have a
 *   DIFFERENT tid (V8 profiler thread). Must be keyed by (pid, id).
 *
 * Strategy: first pass builds (pid, id) → named_tid from Profile events.
 * Second pass accumulates ProfileChunk data keyed by (pid, id), then
 * re-maps to the named tid for display.
 */
function mergeProfileChunks(events: TraceEvent[]): Map<string, MergedProfile> {
  // (pid:id) → named tid (from Profile events)
  const profileTidMap = new Map<string, number>();
  for (const ev of events) {
    if (ev.ph === "P" && ev.name === "Profile" && (ev as any).id) {
      const key = `${ev.pid}:${(ev as any).id}`;
      profileTidMap.set(key, ev.tid);
    }
  }

  // Accumulate ProfileChunk data keyed by (pid:id)
  const byId = new Map<string, MergedProfile>();

  const getOrCreate = (key: string): MergedProfile => {
    let p = byId.get(key);
    if (!p) {
      p = { nodes: new Map(), samples: [], timeDeltas: [], startTime: 0, startTs: Infinity };
      byId.set(key, p);
    }
    return p;
  };

  for (const ev of events) {
    if (ev.ph !== "P") continue;
    if (ev.name !== "Profile" && ev.name !== "ProfileChunk") continue;

    const evAny = ev as any;
    // Use (pid:id) if available, else (pid:tid) as fallback
    const key = evAny.id ? `${ev.pid}:${evAny.id}` : `${ev.pid}:${ev.tid}`;
    const profile = getOrCreate(key);
    const cpuProfile = ev.args?.data?.cpuProfile;
    if (!cpuProfile) continue;

    // Accumulate nodes
    if (cpuProfile.nodes) {
      for (const node of cpuProfile.nodes) {
        profile.nodes.set(node.id, node);
      }
    }

    // Accumulate samples + timeDeltas
    const samples = cpuProfile.samples ?? [];
    // timeDeltas can be on cpuProfile directly or on args.data
    const timeDeltas = cpuProfile.timeDeltas ?? (ev.args?.data as any)?.timeDeltas ?? [];

    for (let i = 0; i < samples.length; i++) {
      profile.samples.push(samples[i]!);
      profile.timeDeltas.push(timeDeltas[i] ?? 0);
    }

    if (cpuProfile.startTime && !profile.startTime) {
      profile.startTime = cpuProfile.startTime;
    }

    if (ev.ts < profile.startTs) {
      profile.startTs = ev.ts;
    }
  }

  // Remap keys: replace (pid:id) with the named (pid:tid) from Profile events
  const result = new Map<string, MergedProfile>();
  for (const [idKey, profile] of byId) {
    const namedTid = profileTidMap.get(idKey);
    if (namedTid !== undefined) {
      // Extract pid from key "pid:id"
      const pid = idKey.split(":")[0]!;
      result.set(`${pid}:${namedTid}`, profile);
    } else {
      // No named thread found — keep as-is (fallback)
      result.set(idKey, profile);
    }
  }

  return result;
}

// ─── Parent Map ───────────────────────────────────────────────────────────────

function buildParentMap(nodes: Map<number, RawNode>): Map<number, number> {
  const parentMap = new Map<number, number>();
  for (const node of nodes.values()) {
    if (node.children) {
      for (const childId of node.children) {
        parentMap.set(childId, node.id);
      }
    }
  }
  return parentMap;
}

// ─── Stats Computation ────────────────────────────────────────────────────────

function computeStats(
  profile: MergedProfile
): Map<number, { selfUs: number; totalUs: number }> {
  const stats = new Map<number, { selfUs: number; totalUs: number }>();

  const getOrCreate = (id: number) => {
    let s = stats.get(id);
    if (!s) {
      s = { selfUs: 0, totalUs: 0 };
      stats.set(id, s);
    }
    return s;
  };

  const parentMap = buildParentMap(profile.nodes);

  for (let i = 0; i < profile.samples.length; i++) {
    const leafId = profile.samples[i]!;
    const dt = profile.timeDeltas[i] ?? 0;

    // Self-time goes to the leaf node
    getOrCreate(leafId).selfUs += dt;

    // Total-time propagates up the ancestor chain
    let current: number | undefined = leafId;
    const visited = new Set<number>();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      getOrCreate(current).totalUs += dt;
      current = parentMap.get(current);
    }
  }

  return stats;
}

// ─── Thread Analysis ──────────────────────────────────────────────────────────

/**
 * Slice a profile to a time range [startUs, endUs] in profile-local cumulative time.
 * Rebuilds samples/timeDeltas; node table is kept intact (nodes outside range are
 * harmless — they just won't accumulate stats).
 */
function sliceProfileByRange(
  profile: MergedProfile,
  startUs: number,
  endUs: number
): MergedProfile {
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  let cumulativeUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0;
    const sampleStart = cumulativeUs;
    const sampleEnd = cumulativeUs + dt;
    cumulativeUs = sampleEnd;

    if (sampleEnd <= startUs) continue;
    if (sampleStart >= endUs) break;

    // Partial overlap: keep sample, clip dt to intersection
    const clippedStart = Math.max(sampleStart, startUs);
    const clippedEnd = Math.min(sampleEnd, endUs);
    samples.push(profile.samples[i]!);
    timeDeltas.push(Math.max(0, clippedEnd - clippedStart));
  }
  return {
    nodes: profile.nodes,
    samples,
    timeDeltas,
    startTime: profile.startTime,
    // Cumulative time in the sliced profile restarts at the range's start, so startTs must
    // advance with it — every consumer reconstructs absolute trace time as
    // `startTs + cumulative` (timeline buckets, per-frame attribution). Without this the
    // sliced report attributes samples to the wrong wall-clock instant.
    startTs: profile.startTs + startUs,
  };
}

function analyzeThread(
  key: string,
  name: string,
  profile: MergedProfile
): ThreadAnalysis {
  const statsMap = computeStats(profile);
  const parentMap = buildParentMap(profile.nodes);

  // Build NodeStats array (exclude root/idle nodes with no self-time)
  const nodeStatsList: NodeStats[] = [];
  for (const [id, s] of statsMap) {
    const node = profile.nodes.get(id);
    if (!node) continue;
    if (s.selfUs === 0 && s.totalUs === 0) continue;
    nodeStatsList.push({ node, ...s });
  }

  // Sort by self-time descending
  nodeStatsList.sort((a, b) => b.selfUs - a.selfUs);

  // Total time for this thread = sum of all timeDeltas
  const totalUs = profile.timeDeltas.reduce((sum, dt) => sum + dt, 0);

  // Category breakdown (by self-time of leaf samples)
  const byCategory: Record<Category, number> = { wasm: 0, js: 0, idle: 0, native: 0 };
  for (let i = 0; i < profile.samples.length; i++) {
    const leafId = profile.samples[i]!;
    const node = profile.nodes.get(leafId);
    if (!node) continue;
    const cat = classifyFrame(node.callFrame);
    byCategory[cat] += profile.timeDeltas[i] ?? 0;
  }

  // Timeline buckets (2s = 2,000,000 µs)
  const timelineUs = buildTimeline(profile, TIMELINE_BUCKET_US);

  return {
    key,
    name,
    totalUs,
    sampleCount: profile.samples.length,
    nodes: nodeStatsList,
    nodeStats: statsMap,
    parentMap,
    byCategory,
    timelineUs,
    profile,
  };
}

// ─── Caller Chains ────────────────────────────────────────────────────────────

/**
 * Walk up the parent chain from a leaf node, returning readable frame labels.
 * Skips synthetic nodes like (root)/(program)/(idle).
 */
function callerChain(
  nodeId: number,
  profile: MergedProfile,
  parentMap: Map<number, number>,
  maxDepth: number
): string[] {
  const chain: string[] = [];
  let current: number | undefined = parentMap.get(nodeId);
  const visited = new Set<number>([nodeId]);
  while (current !== undefined && !visited.has(current) && chain.length < maxDepth) {
    visited.add(current);
    const node = profile.nodes.get(current);
    if (node) {
      const name = node.callFrame.functionName;
      if (name && name !== "(root)" && name !== "(program)" && name !== "(idle)" && name !== "(garbage collector)") {
        chain.push(name);
      }
    }
    current = parentMap.get(current);
  }
  return chain;
}

/**
 * Aggregate total time by immediate caller, keyed by THIS specific node id.
 * Walking parentMap once from the node — no sample iteration needed. We use
 * the per-node totalUs stats, splitting by direct children-of-caller time
 * via a reverse pass: for every sample whose leaf is nodeId, attribute dt
 * to its immediate meaningful ancestor.
 *
 * Using nodeId (not functionName) matters — names like "wasm-function[10]"
 * repeat across different JIT blocks / URLs as distinct nodes.
 */
function aggregateCallersForLeaf(
  leafNode: RawNode,
  analysis: ThreadAnalysis
): Map<string, number> {
  const byCaller = new Map<string, number>();
  const targetId = leafNode.id;

  for (let i = 0; i < analysis.profile.samples.length; i++) {
    if (analysis.profile.samples[i] !== targetId) continue;
    const dt = analysis.profile.timeDeltas[i] ?? 0;

    // Find immediate meaningful caller (skip synthetic)
    let parent: number | undefined = analysis.parentMap.get(targetId);
    let caller = "(entry / no stack)";
    const visited = new Set<number>([targetId]);
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      const pn = analysis.profile.nodes.get(parent);
      const pname = pn?.callFrame.functionName;
      if (pname && pname !== "(root)" && pname !== "(program)" && pname !== "(idle)" && pname !== "(garbage collector)") {
        caller = pname;
        break;
      }
      parent = analysis.parentMap.get(parent);
    }
    byCaller.set(caller, (byCaller.get(caller) ?? 0) + dt);
  }
  return byCaller;
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

function buildTimeline(profile: MergedProfile, bucketUs: number): TimelineBucket[] {
  const buckets = new Map<number, { byCategory: Record<Category, number>; hotFunctions: Map<string, number> }>();

  let cumulativeUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0;
    cumulativeUs += dt;
    const bucketIdx = Math.floor(cumulativeUs / bucketUs);

    let bucket = buckets.get(bucketIdx);
    if (!bucket) {
      bucket = { byCategory: { wasm: 0, js: 0, idle: 0, native: 0 }, hotFunctions: new Map() };
      buckets.set(bucketIdx, bucket);
    }

    const leafId = profile.samples[i]!;
    const node = profile.nodes.get(leafId);
    if (!node) continue;

    const cat = classifyFrame(node.callFrame);
    bucket.byCategory[cat] += dt;

    const fname = frameLabel(node.callFrame, false);
    bucket.hotFunctions.set(fname, (bucket.hotFunctions.get(fname) ?? 0) + dt);
  }

  const result: TimelineBucket[] = [];
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const idx of sortedKeys) {
    const bucket = buckets.get(idx)!;
    let hotFunction = "";
    let maxTime = 0;
    for (const [fn, t] of bucket.hotFunctions) {
      if (t > maxTime) {
        maxTime = t;
        hotFunction = fn;
      }
    }
    result.push({
      startUs: idx * bucketUs,
      endUs: (idx + 1) * bucketUs,
      byCategory: bucket.byCategory,
      hotFunction,
    });
  }
  return result;
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function frameLabel(frame: CallFrame, includeLocation: boolean): string {
  const name = frame.functionName || "(anonymous)";
  if (!includeLocation) return name;
  const url = frame.url ?? "";
  if (url) {
    const file = basename(url.split("?")[0]!);
    if (frame.lineNumber >= 0) {
      return `${name}  ${file}:${frame.lineNumber}`;
    }
    return `${name}  ${file}`;
  }
  return name;
}

function pct(value: number, total: number): string {
  if (total === 0) return " 0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function fmtUs(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(1)}s`;
  if (us >= 1_000) return `${(us / 1_000).toFixed(1)}ms`;
  return `${us}µs`;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pad(s: string, len: number, right = false): string {
  if (right) return s.padStart(len);
  return s.padEnd(len);
}

function sep(char = "═", len = 68): string {
  return char.repeat(len);
}

// ─── Diagnostics / Warnings ───────────────────────────────────────────────────

interface Warning {
  severity: "high" | "med" | "info";
  title: string;
  detail: string;
}

/**
 * Sum of self-time across all nodes whose functionName matches predicate.
 */
function sumSelfUsMatching(
  analysis: ThreadAnalysis,
  predicate: (name: string) => boolean
): number {
  let sum = 0;
  for (const ns of analysis.nodes) {
    const name = ns.node.callFrame.functionName ?? "";
    if (predicate(name)) sum += ns.selfUs;
  }
  return sum;
}

/**
 * Per-thread pathology detection with thresholds drawn from
 * observed BottleShip pain points. Returns a flat list of warnings.
 */
function diagnoseThread(analysis: ThreadAnalysis): Warning[] {
  const warnings: Warning[] = [];
  const total = analysis.totalUs;
  if (total === 0) return warnings;

  const pctOf = (us: number) => (us / total) * 100;

  // 1. JIT indirect-jump pressure
  const jitCacheUs = sumSelfUsMatching(analysis, n => n.includes("jit_find_cache_entry"));
  const jitCachePct = pctOf(jitCacheUs);
  if (jitCachePct > 5) {
    warnings.push({
      severity: jitCachePct > 12 ? "high" : "med",
      title: `JIT indirect-jump pressure: ${jitCachePct.toFixed(1)}%`,
      detail: "jit_find_cache_entry hot → RET/vtable lookups missing. Likely vtable-heavy COM or polymorphic dispatch.",
    });
  }

  // 2. TLB thrashing
  const tlbUs = sumSelfUsMatching(analysis, n => n.includes("tlb_set_entry") || n === "tlb_set_entry_jit");
  const tlbPct = pctOf(tlbUs);
  if (tlbPct > 2) {
    warnings.push({
      severity: tlbPct > 5 ? "high" : "med",
      title: `TLB thrashing: ${tlbPct.toFixed(1)}%`,
      detail: "tlb_set_entry hot → many page-table walks. Often process startup / DLL load or heavy safe_read/write.",
    });
  }

  // 3. Interpreter fallback (JIT miss). Rust mangling → "_ZN3v86...interpreter..."
  const interpUs = sumSelfUsMatching(analysis, n =>
    n === "interpreter" ||
    n.startsWith("interpret_") ||
    /interpreter.*::run/.test(n) ||
    /interpreter[0-9]+run/.test(n)
  );
  const interpPct = pctOf(interpUs);
  if (interpPct > 1) {
    warnings.push({
      severity: interpPct > 3 ? "high" : "med",
      title: `Interpreter fallback: ${interpPct.toFixed(1)}%`,
      detail: "Non-JIT pages executed. Could be self-modifying code, recently written pages, or JIT cache eviction.",
    });
  }

  // 4. Safe memory (TLB miss path)
  const safeUs = sumSelfUsMatching(analysis, n => n.startsWith("safe_read") || n.startsWith("safe_write") || n.startsWith("safe_read_write"));
  const safePct = pctOf(safeUs);
  if (safePct > 5) {
    warnings.push({
      severity: safePct > 10 ? "high" : "med",
      title: `Safe memory accessors: ${safePct.toFixed(1)}%`,
      detail: "safe_read/write hot → TLB miss path. May indicate fragmented working set or repeated cross-page access.",
    });
  }

  // 5. OUT-trap thunk overhead
  const outTrapUs = sumSelfUsMatching(analysis, n => n.startsWith("io_port_write") || n.startsWith("io_port_read"));
  const outTrapPct = pctOf(outTrapUs);
  if (outTrapPct > 10) {
    warnings.push({
      severity: outTrapPct > 20 ? "high" : "med",
      title: `OUT-trap / thunk overhead: ${outTrapPct.toFixed(1)}%`,
      detail: "io_port_write32 dominant → many WinAPI thunks firing. Candidates: move hot thunks to WASM hypercall tier, or WBUF batching.",
    });
  }

  // 6. Hypercall dispatch overhead
  const hypercallUs = sumSelfUsMatching(analysis, n => n.includes("hypercall"));
  const hypercallPct = pctOf(hypercallUs);
  if (hypercallPct > 5) {
    warnings.push({
      severity: "info",
      title: `Hypercall dispatch: ${hypercallPct.toFixed(1)}%`,
      detail: "WASM hypercalls are hot. Usually good (cheaper than JS thunks) — but verify expected callers in top-N.",
    });
  }

  // 7. FPU-heavy (useful signal even without being a problem)
  const fpuUs = sumSelfUsMatching(analysis, n => n.startsWith("fpu_") || n.startsWith("f32_") || n.startsWith("f64_") || n.startsWith("f80_"));
  const fpuPct = pctOf(fpuUs);
  if (fpuPct > 5) {
    warnings.push({
      severity: "info",
      title: `FPU work: ${fpuPct.toFixed(1)}%`,
      detail: "FPU ops significant. If relaxed-FPU flag is off you're paying conversion cost — check PreemptionManager.initialize.",
    });
  }

  // 8. Task switch / interrupt pressure
  const taskSwitchUs = sumSelfUsMatching(analysis, n => n.includes("do_task_switch") || n.includes("call_interrupt"));
  const taskSwitchPct = pctOf(taskSwitchUs);
  if (taskSwitchPct > 2) {
    warnings.push({
      severity: "med",
      title: `Task switch / interrupts: ${taskSwitchPct.toFixed(1)}%`,
      detail: "x86 task-switch or interrupt path hot. Could be scheduler preempting too often or timer IRQ flood.",
    });
  }

  // 9. JS dispatch vs WASM balance — only on worker thread
  if (classifyThreadRole(analysis.name) === "worker") {
    const wasmPct = pctOf(analysis.byCategory.wasm);
    const jsPct = pctOf(analysis.byCategory.js);
    const idlePct = pctOf(analysis.byCategory.idle);
    const busyPct = 100 - idlePct;

    if (busyPct > 50 && jsPct > wasmPct) {
      warnings.push({
        severity: "high",
        title: `JS dominates worker: js ${jsPct.toFixed(1)}% vs wasm ${wasmPct.toFixed(1)}%`,
        detail: "Worker spends more time in JS than in WASM while busy → JS dispatch is the bottleneck, not guest code. Look at top JS functions (thunk dispatch, marshaling, allocation).",
      });
    } else if (wasmPct > 85) {
      warnings.push({
        severity: "info",
        title: `CPU-bound in guest: wasm ${wasmPct.toFixed(1)}%`,
        detail: "Time is mostly in v86 WASM. JS/thunk overhead is NOT the problem — target v86 JIT / hypercall tier / game-side workload.",
      });
    }

    // Idle but user thinks it's hanging? → blocked on something outside worker
    if (idlePct > 70) {
      warnings.push({
        severity: "med",
        title: `Worker mostly idle: ${idlePct.toFixed(1)}%`,
        detail: "Worker is waiting — check main thread (IPC / OPFS / fetch / decoder) or async thunks not completing.",
      });
    }
  }

  return warnings;
}

function reportWarnings(analyses: ThreadAnalysis[]): string {
  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`WARNINGS / AUTO-DIAGNOSTICS`);
  lines.push(sep("═"));

  let any = false;
  for (const a of analyses) {
    const warns = diagnoseThread(a);
    if (warns.length === 0) continue;
    any = true;
    lines.push(`\n[${classifyThreadRole(a.name)}] ${a.name}:`);
    for (const w of warns) {
      const tag = w.severity === "high" ? "!!" : w.severity === "med" ? "!" : "·";
      lines.push(`  ${tag} ${w.title}`);
      lines.push(`     ${w.detail}`);
    }
  }
  if (!any) {
    lines.push(`  (no threshold-triggering issues detected)`);
  }
  return lines.join("\n");
}

// ─── Report Output ────────────────────────────────────────────────────────────

function fmtFrameMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

/** A percentile that has no observation behind it prints as its reason, never as a number. */
function fmtTail(ms: number | null): string {
  return ms === null ? "n/a" : fmtFrameMs(ms);
}

function reportRenderFrames(renderFrames: RenderFrameAnalysis | null): string | null {
  if (!renderFrames) return null;

  const s = renderFrames.stats;
  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`RENDER FRAME TIMING`);
  lines.push(sep("═"));
  lines.push(`Source: bottleship.flip UserTiming marks (app-level present cadence)`
    + (renderFrames.scopedTo ? `  [scoped to --range ${renderFrames.scopedTo}]` : ""));
  lines.push(`Marks: ${num(renderFrames.markCount)}  Intervals: ${num(s.sampleCount)}`);
  if (!s.ok) {
    lines.push(`No distribution: ${s.status} — ${s.note}`);
    return lines.join("\n");
  }
  lines.push(
    `Avg: ${fmtFrameMs(s.meanMs)} (${(s.meanMs > 0 ? 1000 / s.meanMs : 0).toFixed(1)} FPS)  ` +
    `P50: ${fmtTail(s.p50Ms)}  P95: ${fmtTail(s.p95Ms)}  ` +
    `P99: ${fmtTail(s.p99Ms)}  Max: ${fmtFrameMs(s.maxMs)}`
  );
  lines.push(`  (percentiles are bucket UPPER BOUNDS, same definition as the live harness frameReport)`);
  for (const why of s.unavailable) lines.push(`  ${why}`);
  if (s.budget) {
    const b = s.budget;
    lines.push(
      `Budget ${fmtFrameMs(b.ms)} (${b.source}): over ${num(b.overFrames)} (${b.overPct.toFixed(1)}%)  ` +
      `>2x budget: ${num(b.over2xFrames)}  lost ~${b.excessMsApprox.toFixed(0)}ms  p99/budget: ${b.p99OverBudget ?? "n/a"}`
    );
    if (b.straddleFrames > 0) lines.push(`  ${num(b.straddleFrames)} frames sit in the bucket the budget falls inside (unclassifiable either way)`);
  } else if (s.budgetNote) {
    lines.push(`Budget: ${s.budgetNote}`);
  }
  lines.push(`  --budget-ms <n> to judge against the title's own cadence instead of the derived one.`);
  return lines.join("\n");
}

/**
 * WORST FRAMES with stack attribution — the trace's advantage over the live profiler, which
 * can only name thunks. Slices the worker profile to each worst interval, so a spike is
 * answered with JS/wasm split and leaf functions (GC shows up here as "(garbage collector)";
 * `wasm-function[N]` frames are compiled guest blocks — resolvable to module:rva when the
 * bottleship.hotblocks mark is present).
 */
function reportWorstFrames(
  renderFrames: RenderFrameAnalysis | null,
  workerProfile: MergedProfile | null,
  topN: number
): string | null {
  if (!renderFrames || !workerProfile || !Number.isFinite(workerProfile.startTs)) return null;
  const worst = renderFrames.intervals.slice().sort((a, b) => b.frameMs - a.frameMs).slice(0, topN);
  if (worst.length === 0) return null;

  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`WORST FRAMES (by inter-flip interval) — stack attribution per frame`);
  lines.push(sep("═"));
  lines.push(`  ${"at".padStart(8)} ${"ms".padStart(9)} ${"cov".padStart(5)} ${"js".padStart(5)} ${"wasm".padStart(5)} ${"idle".padStart(5)}  hot leaves`);
  for (const iv of worst) {
    const a = attributeRange(workerProfile, iv.startTsUs, iv.endTsUs, 3);
    const rel = (iv.endTsUs - workerProfile.startTs) / 1_000_000;
    const share = (v: number) => (a.totalUs > 0 ? `${((v / a.totalUs) * 100).toFixed(0)}%` : "-");
    const leaves = a.top.map(([fn, us]) => `${fn} ${(us / 1000).toFixed(1)}ms`).join(", ") || "(no samples in window)";
    lines.push(
      `  ${`${rel.toFixed(2)}s`.padStart(8)} ${fmtFrameMs(iv.frameMs).padStart(9)} ` +
      `${`${a.coveragePct.toFixed(0)}%`.padStart(5)} ${share(a.byCategory.js).padStart(5)} ` +
      `${share(a.byCategory.wasm).padStart(5)} ${share(a.byCategory.idle).padStart(5)}  ${leaves}`
    );
  }
  lines.push(`  cov = share of the frame the profiler actually sampled (Chrome samples ~1ms; a short frame is attributed from few samples).`);
  return lines.join("\n");
}

// Primary guest-code attribution: the EIP sampler embedded in the bottleship.hotblocks
// mark counts samples per guest PAGE. This is trustworthy, unlike the idx↔wasm-function[N]
// join (v86 wasm-table indices don't match Chrome's wasm-function[N] numbering, and table
// slots are reused), so we rank hot guest pages directly here.
function reportHotGuestPages(rows: any[] | null): string | null {
  if (!rows || rows.length === 0) return null;

  const hasSamples = rows.some(r => typeof r.samples === "number");
  // Merge by guest page so a page split across reused table slots ranks once.
  const agg = new Map<string, { samples: number; pctNum: number; module: string }>();
  const order: string[] = [];
  for (const r of rows) {
    const addr = String(r.addr ?? r.phys_addr ?? "");
    if (!addr) continue;
    if (!agg.has(addr)) { agg.set(addr, { samples: 0, pctNum: 0, module: r.module ?? "" }); order.push(addr); }
    const e = agg.get(addr)!;
    if (typeof r.samples === "number") e.samples += r.samples;
    const p = typeof r.pct === "string" ? parseFloat(r.pct) : NaN;
    if (Number.isFinite(p)) e.pctNum += p;
    if (!e.module && r.module) e.module = r.module;
  }

  const ranked = order.map(addr => ({ addr, ...agg.get(addr)! }));
  if (hasSamples) ranked.sort((a, b) => b.samples - a.samples);
  // else: keep capture order (the worker already sorted rows by samples desc)

  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`HOT GUEST PAGES (embedded EIP sampler — guest-code attribution)`);
  lines.push(sep("═"));
  lines.push(`Source: bottleship.hotblocks mark · ${num(rows.length)} blocks · ranked by ${hasSamples ? "EIP samples" : "capture order (samples-desc)"}`);
  if (!hasSamples) {
    lines.push(`(per-page magnitudes unavailable — recapture with updated worker for sample counts)`);
  }
  lines.push(` #   ${pad("samples", 8, true)} ${pad("%hot", 6, true)}  ${pad("guest addr", 12)}  module+rva`);
  lines.push(` ${"-".repeat(72)}`);
  for (let i = 0; i < Math.min(25, ranked.length); i++) {
    const r = ranked[i]!;
    const samplesCol = hasSamples ? pad(num(r.samples), 8, true) : pad("-", 8, true);
    const pctCol = (hasSamples && r.pctNum > 0) ? pad(r.pctNum.toFixed(1) + "%", 6, true) : pad("-", 6, true);
    lines.push(` ${pad(String(i + 1), 2, true)}  ${samplesCol} ${pctCol}  ${pad(r.addr, 12)}  ${r.module || "(no module)"}`);
  }
  return lines.join("\n");
}

// Exact-instruction attribution: the bottleship.hotblocks mark also carries a top-EIP
// histogram (unmasked). This pins the hot instruction inside a JIT-block page, which the
// page-level HOT GUEST PAGES table cannot (a 4KB page packs many guest functions).
function reportHotGuestInstructions(eips: any[] | null): string | null {
  if (!eips || eips.length === 0) return null;
  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`HOT GUEST INSTRUCTIONS (exact EIP — pinpoints the hot function within a page)`);
  lines.push(sep("═"));
  lines.push(`Source: bottleship.hotblocks mark · ${num(eips.length)} sampled EIPs (already samples-desc)`);
  // The EIP sampler is a setInterval on the WORKER's event loop reading cpu.instruction_pointer
  // (diagnostics-commands.ts eipSample). A timer can only fire when the worker yields, so these
  // samples are taken at slice boundaries, NOT uniformly across guest execution. That biases them
  // hard toward addresses where the guest happens to be parked — callback entries and the
  // instruction after a thunk. Verified on Satinav: the two "hottest" EIPs at 21%/18% disassemble
  // to a 25-byte field update and a 5-arg MM_WOM_DONE audio-callback entry, neither of which can
  // hold a video decoder's time. Read this table as WHERE THE GUEST YIELDS, not where it burns
  // CPU; for time, use the wasm/JIT-block attribution above, which is Chrome's own CPU profiler.
  lines.push(`  NOTE: sampled at worker yield points, so this ranks WHERE THE GUEST PARKS, not`);
  lines.push(`  where it spends time. A function ENTRY at the top usually means a hot callback`);
  lines.push(`  dispatch, not a hot kernel — confirm by disassembling before optimizing it.`);
  lines.push(` #   ${pad("samples", 8, true)} ${pad("%hot", 6, true)}  ${pad("eip", 12)}  module+rva`);
  lines.push(` ${"-".repeat(72)}`);
  for (let i = 0; i < Math.min(25, eips.length); i++) {
    const e = eips[i]!;
    const s = typeof e.samples === "number" ? num(e.samples) : "-";
    const p = e.pct != null ? String(e.pct) : "-";
    lines.push(` ${pad(String(i + 1), 2, true)}  ${pad(s, 8, true)} ${pad(p, 6, true)}  ${pad(String(e.eip ?? ""), 12)}  ${e.module || "(no module)"}`);
  }
  return lines.join("\n");
}

function reportThread(
  analysis: ThreadAnalysis,
  topN: number,
  label: string,
  showTimeline: boolean
): string {
  const lines: string[] = [];
  const total = analysis.totalUs;

  lines.push(`\n${sep("═")}`);
  lines.push(`${label}`);
  lines.push(sep("═"));

  // Category breakdown
  const cats: Category[] = ["idle", "js", "wasm", "native"];
  const catLine = cats
    .map(c => `${c} ${pct(analysis.byCategory[c], total)}`)
    .join("  ");
  lines.push(`Category breakdown:  ${catLine}`);
  lines.push(`  (idle = V8 (idle)/(program)/(root); on a dynarec WASM module this is often JIT-boundary`);
  lines.push(`   sampling noise, NOT reclaimable slack — run with --idle-shape to check)`);
  lines.push(`Total profiled: ${fmtUs(total)}  Samples: ${num(analysis.sampleCount)}  Unique nodes: ${num(analysis.nodes.length)}`);

  // Top N by self-time
  lines.push(`\nTop ${topN} functions by self-time:`);
  lines.push(
    ` #   ${pad("Self%", 6, true)} ${pad("Total%", 7, true)}  ${pad("Cat", 4)}  ${pad("Function", 36)}  Location`
  );
  lines.push(` ${"-".repeat(95)}`);

  const shown = analysis.nodes.slice(0, topN);
  for (let i = 0; i < shown.length; i++) {
    const ns = shown[i]!;
    const cat = classifyFrame(ns.node.callFrame);
    const selfPct = pct(ns.selfUs, total);
    const totalPct = pct(ns.totalUs, total);
    const name = ns.node.callFrame.functionName || "(anonymous)";
    const truncName = name.length > 36 ? name.slice(0, 33) + "..." : name;

    let loc = "";
    const url = ns.node.callFrame.url ?? "";
    if (url) {
      const file = basename(url.split("?")[0]!);
      const ln = ns.node.callFrame.lineNumber;
      loc = ln >= 0 ? `${file}:${ln}` : file;
    }

    lines.push(
      ` ${pad(String(i + 1), 2, true)}  ${pad(selfPct, 6, true)}  ${pad(totalPct, 6, true)}  ${pad(cat, 4)}  ${pad(truncName, 36)}  ${loc}`
    );

    // Caller aggregation for top 10 only (keeps noise down)
    if (i < 10 && cat !== "idle") {
      const callers = aggregateCallersForLeaf(ns.node, analysis);
      if (callers.size > 0) {
        const sorted = Array.from(callers.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        for (const [callerName, callerUs] of sorted) {
          const truncCaller = callerName.length > 48 ? callerName.slice(0, 45) + "..." : callerName;
          lines.push(`       └─ ${pad(pct(callerUs, ns.selfUs), 6, true)} from ${truncCaller}`);
        }
      }
    }
  }

  // Timeline
  if (showTimeline && analysis.timelineUs.length > 0) {
    lines.push(`\nTimeline (2s buckets):`);
    lines.push(`  ${"Start".padEnd(8)} ${"idle".padStart(6)} ${"js".padStart(6)} ${"wasm".padStart(6)} ${"nat".padStart(6)}  Hot function`);
    for (const bucket of analysis.timelineUs) {
      const bucketTotal =
        bucket.byCategory.idle +
        bucket.byCategory.js +
        bucket.byCategory.wasm +
        bucket.byCategory.native;
      if (bucketTotal === 0) continue;
      const start = `${Math.floor(bucket.startUs / 1_000_000)}s`;
      const row = [
        pad(start, 7),
        pad(pct(bucket.byCategory.idle, bucketTotal), 6, true),
        pad(pct(bucket.byCategory.js, bucketTotal), 6, true),
        pad(pct(bucket.byCategory.wasm, bucketTotal), 6, true),
        pad(pct(bucket.byCategory.native, bucketTotal), 6, true),
        `  ${bucket.hotFunction}`,
      ].join(" ");
      lines.push(`  ${row}`);
    }
  }

  return lines.join("\n");
}

function reportWasm(analysis: ThreadAnalysis, topN: number): string {
  const lines: string[] = [];
  const total = analysis.totalUs;
  const wasmUs = analysis.byCategory.wasm;

  lines.push(`\n${sep("═")}`);
  lines.push(`WASM (v86) ANALYSIS`);
  lines.push(sep("═"));

  const wasmNodes = analysis.nodes.filter(
    ns => classifyFrame(ns.node.callFrame) === "wasm"
  );
  const wasmSamples = wasmNodes.reduce((s, n) => s + n.selfUs, 0);

  lines.push(
    `Total WASM: ${pct(wasmUs, total)} of all samples  (${fmtUs(wasmUs)} / ${fmtUs(total)})`
  );
  lines.push(``);
  lines.push(` #  ${pad("Samples", 9, true)}  ${pad("%", 5, true)}  Annotation / Function`);
  lines.push(` ${"-".repeat(80)}`);

  const shown = wasmNodes.slice(0, topN);
  for (let i = 0; i < shown.length; i++) {
    const ns = shown[i]!;
    const name = ns.node.callFrame.functionName || "(anonymous)";
    const annotation = annotateWasm(name);
    const label = annotation ? `[${annotation}] ${name}` : name;
    lines.push(
      ` ${pad(String(i + 1), 2, true)}  ${pad(num(Math.round(ns.selfUs / 1000)), 9, true)}ms  ${pad(pct(ns.selfUs, total), 5, true)}  ${label}`
    );
  }

  if (shown.length === 0) {
    lines.push(`  (no WASM samples found)`);
  }

  return lines.join("\n");
}

// ─── Optimization-Target Roll-up ────────────────────────────────────────────
// Buckets worker self-time by the lever that can actually move it:
//   • GAME CODE          — guest's own x86 (only a better dynarec / static
//                          recompilation / inner-loop hooking touches this)
//   • v86 full-system tax — dispatch (main_loop), fpu/sse primitives, mmu,
//                          interpreter, indirect-jump cache (patchable in v86)
//   • JS HLE + glue       — our TS WinAPI/graphics + v86 JS glue (movable to
//                          the WASM hypercall tiers)

type OptBucket =
  | "GAME CODE (jit blocks)"
  | "dispatch (main_loop)"
  | "indirect-jump (jit cache)"
  | "interpreter (non-JIT)"
  | "fpu primitives"
  | "sse primitives"
  | "mmu / decode / irq"
  | "other v86 core"
  | "JS HLE + glue"
  | "idle";

const OPT_TAX_BUCKETS = new Set<OptBucket>([
  "dispatch (main_loop)",
  "indirect-jump (jit cache)",
  "interpreter (non-JIT)",
  "fpu primitives",
  "sse primitives",
  "mmu / decode / irq",
  "other v86 core",
]);

function optBucket(frame: CallFrame): OptBucket {
  const name = frame.functionName ?? "";
  // Synthetic / idle frames.
  if (name === "(idle)" || name === "(program)" || name === "(root)" || name === "(garbage collector)")
    return "idle";
  // v86 WASM sub-buckets keyed by name (robust even when the JIT-block url
  // lacks a "wasm" substring, which classifyFrame relies on).
  if (name === "main_loop") return "dispatch (main_loop)";
  if (name.includes("jit_find_cache_entry")) return "indirect-jump (jit cache)";
  if (name.includes("interpreter")) return "interpreter (non-JIT)";
  if (/^(fpu_|f80_|f64_|f32_)/.test(name)) return "fpu primitives";
  // v86 names its vector helpers after the OPCODE, never "sse_": instr_660FED (paddsw),
  // instr_0F59 (mulps), instr_F30F10 (movss). The old /^sse_/ matched none of them, so every
  // SSE/MMX helper fell through into "other v86 core" — a cutscene trace where four of them
  // were 14.6% of all samples reported this bucket as 0.1%, which is how a real bottleneck
  // got read as "not SSE". A 66/F2/F3-prefixed 0F helper is always a vector op; for the
  // unprefixed form only the vector opcode ranges count (plain 0F is mostly Jcc/imul/bit ops).
  if (/^sse_/.test(name)) return "sse primitives";
  const vec = /^instr_(66|F2|F3)?0F([0-9A-F]{2})(_reg|_mem)?$/.exec(name);
  if (vec) {
    if (vec[1]) return "sse primitives";
    const op = parseInt(vec[2], 16);
    const isVector = (op >= 0x10 && op <= 0x17) || (op >= 0x28 && op <= 0x2f)
      || (op >= 0x50 && op <= 0x77) || (op >= 0x7e && op <= 0x7f)
      || (op >= 0xc2 && op <= 0xc6) || (op >= 0xd0 && op <= 0xff);
    if (isVector) return "sse primitives";
  }
  if (
    name.includes("tlb_") ||
    name.startsWith("safe_read") ||
    name.startsWith("safe_write") ||
    name.includes("do_task_switch") ||
    name.includes("call_interrupt") ||
    name.includes("modrm_resolve") ||
    name.includes("translate_address")
  )
    return "mmu / decode / irq";
  if (/^wasm-function\[/.test(name)) return "GAME CODE (jit blocks)";
  if (name.startsWith("_ZN3v86")) return "other v86 core";
  // Everything else: lean on classifyFrame for the js / idle / native split.
  const cat = classifyFrame(frame);
  if (cat === "wasm") return "other v86 core";
  if (cat === "idle") return "idle";
  return "JS HLE + glue"; // js or native
}

function reportOptimizationBuckets(analysis: ThreadAnalysis): string {
  const total = analysis.totalUs;
  if (total === 0) return "";

  const buckets = new Map<OptBucket, number>();
  for (const ns of analysis.nodes) {
    const b = optBucket(ns.node.callFrame);
    buckets.set(b, (buckets.get(b) ?? 0) + ns.selfUs);
  }

  const idle = buckets.get("idle") ?? 0;
  const busy = Math.max(1, total - idle);

  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`OPTIMIZATION-TARGET ROLL-UP (${analysis.name})`);
  lines.push(sep("═"));
  lines.push(`Self-time bucketed by the lever that can move it. %busy excludes idle.`);
  lines.push(` ${pad("bucket", 28)} ${pad("self", 8, true)} ${pad("%total", 7, true)} ${pad("%busy", 7, true)}`);
  lines.push(` ${"-".repeat(54)}`);

  const ordered = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
  for (const [b, us] of ordered) {
    const busyCol = b === "idle" ? "" : pct(us, busy);
    lines.push(` ${pad(b, 28)} ${pad(fmtUs(us), 8, true)} ${pad(pct(us, total), 7, true)} ${pad(busyCol, 7, true)}`);
  }

  let tax = 0;
  let game = 0;
  let hle = 0;
  for (const [b, us] of buckets) {
    if (OPT_TAX_BUCKETS.has(b)) tax += us;
    else if (b === "GAME CODE (jit blocks)") game += us;
    else if (b === "JS HLE + glue") hle += us;
  }

  lines.push(``);
  lines.push(`ROLL-UP (of busy time):`);
  lines.push(`  game's own code      ${pad(pct(game, busy), 7, true)}  → better dynarec / static-recomp / inner-loop hooking`);
  // Name the DOMINANT sub-bucket inside the tax, because the generic advice points at the
  // wrong lever when one sub-bucket owns it: a cutscene trace read "relaxed-FPU /
  // block-chaining" while 36% of busy was scalar SSE helpers waiting to become v128 ops.
  // The same set `tax` is summed from, so the hint can never name a bucket outside it.
  const taxTop = [...buckets.entries()]
    .filter(([b]) => OPT_TAX_BUCKETS.has(b))
    .sort((a, b) => b[1] - a[1])[0];
  const taxHint = taxTop && tax > 0 && taxTop[1] / tax >= 0.4
    ? `mostly ${taxTop[0]} (${pct(taxTop[1], busy)} of busy) — target that first`
    : "relaxed-FPU / block-chaining / v86 JIT tuning";
  lines.push(`  v86 full-system tax  ${pad(pct(tax, busy), 7, true)}  → ${taxHint}`);
  lines.push(`  JS HLE + glue        ${pad(pct(hle, busy), 7, true)}  → WASM hypercall tiers`);
  return lines.join("\n");
}

// ─── Main Report ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function classifyThreadRole(name: string): "worker" | "main" | "audio" | "other" {
  const lower = name.toLowerCase();
  if (lower.includes("worker") || lower.includes("dedicated")) return "worker";
  if (lower.includes("crrenderer") || lower === "main") return "main";
  if (lower.includes("audio") || lower.includes("worklet")) return "audio";
  return "other";
}

/**
 * --idle-shape: distinguish REAL idle (reclaimable wait) from V8 sampling noise.
 *
 * The "idle" category lumps V8's synthetic (idle)/(program)/(root) nodes. For a
 * runtime-dynarec WASM module like v86, the sampler frequently can't attribute a
 * sample landing at a JIT-block boundary / indirect-dispatch / JS↔wasm trampoline
 * and emits (idle) — this is EXECUTION, not slack. This mode measures the shape:
 *   - run-length histogram: real blocking wait = few long runs; JIT noise = many 1-5
 *     sample bursts.
 *   - before/after attribution: JIT noise is bracketed by wasm-function[N]/main_loop/
 *     jit_find_cache_*; real GPU/IO wait would be bracketed by writeBuffer/submit/Atomics.
 */
function printIdleShape(profile: MergedProfile, label: string): void {
  const nameOf = (id: number) => profile.nodes.get(id)?.callFrame?.functionName ?? "?";
  const isIdle = (nm: string) => nm === "(idle)" || nm === "(program)" || nm === "(root)";
  const names = profile.samples.map(nameOf);
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0);

  // node-name tally within the idle family
  const fam = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    if (isIdle(names[i]!)) fam.set(names[i]!, (fam.get(names[i]!) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }

  // run-length histogram + before/after attribution of idle runs
  const buckets = { "1": 0, "2-5": 0, "6-15": 0, "16-40": 0, "41+": 0 };
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  let runs = 0, idleSamples = 0, i = 0;
  while (i < names.length) {
    if (isIdle(names[i]!)) {
      let j = i;
      while (j < names.length && isIdle(names[j]!)) j++;
      const len = j - i;
      runs++; idleSamples += len;
      if (len === 1) buckets["1"]++; else if (len <= 5) buckets["2-5"]++;
      else if (len <= 15) buckets["6-15"]++; else if (len <= 40) buckets["16-40"]++; else buckets["41+"]++;
      const b = i > 0 ? names[i - 1]! : "<start>";
      const a = j < names.length ? names[j]! : "<end>";
      before.set(b, (before.get(b) ?? 0) + 1);
      after.set(a, (after.get(a) ?? 0) + 1);
      i = j;
    } else i++;
  }
  const avgIntervalUs = profile.timeDeltas.length ? total / profile.timeDeltas.length : 0;
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${v}× ${k}`).join("  |  ");

  const longRuns = buckets["16-40"] + buckets["41+"];
  const gpuIoRe = /writeBuffer|submit|Present|Flip|Blt|readback|Atomics|__wait|WaitFor/i;
  const gpuIoRuns = [...before.entries()].filter(([k]) => gpuIoRe.test(k)).reduce((a, [, v]) => a + v, 0);

  console.log(sep());
  console.log(`IDLE-SHAPE — is the "idle" bucket real wait or WASM/JIT sampling noise?`);
  console.log(sep());
  console.log(`Thread: ${label}`);
  console.log(`idle-family self-time: ${[...fam.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${pct(v, total)}`).join("  ")}`);
  console.log(`avg sample interval: ${Math.round(avgIntervalUs)}µs   idle runs: ${num(runs)}  (${num(idleSamples)} samples)`);
  console.log(`run-length histogram: ${JSON.stringify(buckets)}`);
  console.log(`  BEFORE idle: ${top(before)}`);
  console.log(`  AFTER  idle: ${top(after)}`);
  console.log(``);
  // Verdict on the DOMINANT signal (run fractions), noting minority real-wait separately.
  const tinyFrac = runs ? (buckets["1"] + buckets["2-5"]) / runs : 0;
  const longFrac = runs ? longRuns / runs : 0;
  const minorWait = gpuIoRuns > 0 ? ` (${gpuIoRuns} run${gpuIoRuns === 1 ? "" : "s"} bracketed by GPU/IO/Atomics — minor real wait)` : "";
  if (tinyFrac > 0.9 && longFrac < 0.05) {
    console.log(`VERDICT: ${(tinyFrac * 100).toFixed(0)}% of idle runs are 1-5 samples, bracketed by WASM/JIT frames`);
    console.log(`  → dominated by V8 sampling NOISE around v86's dynarec, NOT reclaimable slack.${minorWait}`);
    console.log(`  Do not plan async-present/readback to "reclaim" this number.`);
  } else if (longFrac > 0.2 || gpuIoRuns > runs * 0.1) {
    console.log(`VERDICT: substantial long idle runs${gpuIoRuns ? " bracketed by GPU/IO/Atomics frames" : ""}`);
    console.log(`  → REAL blocking wait likely present; confirm with an in-worker timestamp bracket around submit/wait.`);
  } else {
    console.log(`VERDICT: mixed — mostly JIT noise but ${(longFrac * 100).toFixed(0)}% longer runs${minorWait};`);
    console.log(`  inspect before/after attribution above before treating idle as reclaimable.`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage:");
    console.log("  bun tools/analyze-trace.ts <file>                    # basic analysis");
    console.log("  bun tools/analyze-trace.ts <file> --top 50           # more functions");
    console.log("  bun tools/analyze-trace.ts <file> --thread worker    # worker only");
    console.log("  bun tools/analyze-trace.ts <file> --range 0-7s       # slice profile to time window");
    console.log("  bun tools/analyze-trace.ts <file> --budget-ms 33.34  # judge frames against the title's cadence");
    console.log("  bun tools/analyze-trace.ts <file> --map blocks.json  # annotate wasm-function[N] with guest addr");
    console.log("  bun tools/analyze-trace.ts <file> --no-auto-map      # skip hot-block sidecar discovery");
    console.log("");
    console.log("--range accepts: A-Bs (seconds) or Ams-Bms (milliseconds). Times are relative to profile start.");
    console.log("--map expects JSON produced by worker-side dumpHotJitBlocks() (array of {wasm_fn, phys_addr, module}).");
    console.log("Traces with embedded bottleship.hotblocks marks are annotated automatically without --map.");
    console.log("Traces with bottleship.flip marks report FPS, inter-frame p50/p95/p99 (same shared definition as the");
    console.log("harness frameReport verb), frames over budget, and a WORST FRAMES table with per-frame stack attribution.");
    console.log("--budget-ms sets the frame budget; without it the budget is DERIVED from the observed cadence.");
    console.log("Without --map or embedded hot-blocks, the analyzer auto-discovers hot-block sidecars next to the trace.");
    process.exit(0);
  }

  const filePath = args[0]!;
  const topN = (() => {
    const i = args.indexOf("--top");
    return i >= 0 ? parseInt(args[i + 1] ?? "25", 10) : 25;
  })();
  /** Frame budget in ms — the title's own cadence. Omitted: derived from the observed
   *  cadence (never a hardcoded 30fps, which is what the old slow30Count assumed). */
  const budgetMs = (() => {
    const i = args.indexOf("--budget-ms");
    if (i < 0) return undefined;
    const v = parseFloat(args[i + 1] ?? "");
    if (!(v > 0)) {
      console.error(`Invalid --budget-ms "${args[i + 1]}". Example: --budget-ms 33.34 (30fps)`);
      process.exit(1);
    }
    return v;
  })();
  const mapIdx = args.indexOf("--map");
  const autoMapEnabled = !args.includes("--no-auto-map");
  if (mapIdx >= 0 && args[mapIdx + 1]) {
    try {
      loadJitBlockMap(args[mapIdx + 1]!);
    } catch (e) {
      console.warn(`[analyze-trace] --map load failed: ${e}`);
    }
  }
  const threadFilter = (() => {
    const i = args.indexOf("--thread");
    return i >= 0 ? (args[i + 1] ?? "").toLowerCase() : null;
  })();
  const range = (() => {
    const i = args.indexOf("--range");
    if (i < 0) return null;
    const raw = (args[i + 1] ?? "").trim();
    const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s)?-(\d+(?:\.\d+)?)(ms|s)?$/);
    if (!m) {
      console.error(`Invalid --range "${raw}". Examples: 0-7s, 1500ms-5000ms, 10-15s`);
      process.exit(1);
    }
    const unit = (u: string | undefined) => (u === "ms" ? 1000 : 1_000_000);
    const startUs = parseFloat(m[1]!) * unit(m[2] ?? m[4]);
    const endUs = parseFloat(m[3]!) * unit(m[4] ?? m[2]);
    if (endUs <= startUs) {
      console.error(`Invalid --range: end <= start`);
      process.exit(1);
    }
    return { startUs, endUs, raw };
  })();

  // Read trace
  console.log(`Reading ${filePath} ...`);
  const { events, rawSize, gzipSize } = readTrace(filePath);
  let renderFrames = extractRenderFrameAnalysis(events, budgetMs);
  const perfWindow = extractPerfWindow(events);

  // Embedded hot-blocks (Level-3): always extract for the HOT GUEST PAGES report,
  // and additionally build the annotation map if no explicit --map was given.
  const embeddedHotBlocks = extractEmbeddedHotBlocks(events);
  if (!JIT_BLOCK_MAP && embeddedHotBlocks) {
    JIT_BLOCK_MAP = buildJitBlockMapFromRows(embeddedHotBlocks);
    console.log(`[analyze-trace] using embedded hot-blocks from trace: ${JIT_BLOCK_MAP.size} entries (no --map needed)`);
  }

  if (!JIT_BLOCK_MAP && autoMapEnabled) {
    const sidecar = findJitBlockMapSidecar(filePath);
    if (sidecar) {
      try {
        console.log(`[analyze-trace] auto-discovered JIT block map: ${sidecar}`);
        loadJitBlockMap(sidecar);
      } catch (e) {
        console.warn(`[analyze-trace] auto map load failed: ${e}`);
      }
    }
  }

  const threadNames = extractThreadNames(events);
  const profiles = mergeProfileChunks(events);

  // --idle-shape: focused diagnostic — is the "idle" bucket real wait or JIT sampling noise?
  if (args.includes("--idle-shape")) {
    const wantThread = (() => {
      const i = args.indexOf("--thread");
      return i >= 0 ? (args[i + 1] ?? "worker").toLowerCase() : "worker";
    })();
    let chosen: { profile: MergedProfile; name: string } | null = null;
    for (const [key, profile] of profiles) {
      const name = threadNames.get(key) ?? `Thread ${key}`;
      const role = classifyThreadRole(name);
      if (role === wantThread || name.toLowerCase().includes(wantThread)) {
        if (!chosen || profile.samples.length > chosen.profile.samples.length) chosen = { profile, name };
      }
    }
    if (!chosen) {
      // fall back to the largest profile
      for (const [key, profile] of profiles) {
        const name = threadNames.get(key) ?? `Thread ${key}`;
        if (!chosen || profile.samples.length > chosen.profile.samples.length) chosen = { profile, name };
      }
    }
    if (chosen) printIdleShape(chosen.profile, chosen.name);
    else console.log("[idle-shape] no profiles found in trace");
    return;
  }

  // Compute total duration from first/last trace ts
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const ev of events) {
    if (ev.ts) {
      if (ev.ts < minTs) minTs = ev.ts;
      if (ev.ts > maxTs) maxTs = ev.ts;
    }
  }
  const durationMs = (maxTs - minTs) / 1000;

  // Analyze all threads (optionally sliced by --range)
  const analyses: ThreadAnalysis[] = [];
  for (const [key, profile] of profiles) {
    const name = threadNames.get(key) ?? `Thread ${key}`;
    const sliced = range ? sliceProfileByRange(profile, range.startUs, range.endUs) : profile;
    analyses.push(analyzeThread(key, name, sliced));
  }

  // --range must scope the FRAME statistics too. A sliced report whose frame tail silently
  // covered the whole trace is the exact failure mode this instrument exists to avoid.
  if (range && renderFrames) {
    const base = Array.from(profiles.values()).find((p) => Number.isFinite(p.startTs))?.startTs;
    if (Number.isFinite(base)) {
      const lo = (base as number) + range.startUs;
      const hi = (base as number) + range.endUs;
      const intervals = renderFrames.intervals.filter((iv) => iv.endTsUs >= lo && iv.endTsUs < hi);
      renderFrames = {
        markCount: intervals.length > 0 ? intervals.length + 1 : 0,
        intervals,
        stats: computeRenderFrameStats(intervals, budgetMs),
        budgetMs: renderFrames.budgetMs,
        scopedTo: range.raw,
      };
    }
  }

  // Sort by total samples descending
  analyses.sort((a, b) => b.totalUs - a.totalUs);

  const totalSamples = analyses.reduce(
    (s, a) => s + a.nodes.reduce((ns, n) => ns + Math.ceil(n.selfUs > 0 ? 1 : 0), 0),
    0
  );

  // Identify thread roles
  const workerThreads = analyses.filter(
    a => classifyThreadRole(a.name) === "worker"
  );
  const mainThreads = analyses.filter(
    a => classifyThreadRole(a.name) === "main"
  );
  const audioThreads = analyses.filter(
    a => classifyThreadRole(a.name) === "audio"
  );
  const otherThreads = analyses.filter(
    a => classifyThreadRole(a.name) === "other"
  );

  // ── Header ──
  const lines: string[] = [];
  lines.push(sep());
  lines.push(`BOTTLESHIP TRACE ANALYZER`);
  lines.push(sep());

  const isGzip = rawSize !== gzipSize;
  const fileDesc = isGzip
    ? `${formatBytes(gzipSize)} gzip → ${formatBytes(rawSize)}`
    : formatBytes(rawSize);
  lines.push(`File:     ${basename(filePath)} (${fileDesc})`);
  lines.push(`Duration: ${num(Math.round(durationMs))} ms   Events: ${num(events.length)}   Threads with profiles: ${profiles.size}`);
  if (range) {
    lines.push(`Range:    ${range.raw}  (${fmtUs(range.startUs)} → ${fmtUs(range.endUs)} of profile-local cumulative time)`);
  }

  // ── Thread List ──
  lines.push(`\nTHREADS`);
  const roleSymbol = (role: string) =>
    ({ worker: "[W]", main: "[M]", audio: "[A]", other: "[ ]" })[role] ?? "[ ]";

  for (const a of analyses) {
    const role = classifyThreadRole(a.name);
    const sym = roleSymbol(role);
    const sampleCount = a.nodes.reduce((s, n) => s + (n.selfUs > 0 ? 1 : 0), 0);
    lines.push(
      `  ${sym} ${pad(a.name, 44)} ${pad(num(sampleCount), 8, true)} nodes  ${fmtUs(a.totalUs)}`
    );
  }

  console.log(lines.join("\n"));

  // ── Per-Thread Analysis ──
  const shouldShow = (a: ThreadAnalysis) => {
    if (!threadFilter) return true;
    return classifyThreadRole(a.name) === threadFilter || a.name.toLowerCase().includes(threadFilter);
  };

  for (const a of workerThreads) {
    if (!shouldShow(a)) continue;
    console.log(reportThread(a, topN, `WORKER THREAD (${a.name})`, true));
    console.log(reportWasm(a, topN));
    console.log(reportOptimizationBuckets(a));
  }

  for (const a of mainThreads) {
    if (!shouldShow(a)) continue;
    if (threadFilter && threadFilter !== "main") continue;
    console.log(reportThread(a, topN, `MAIN THREAD (${a.name})`, false));
  }

  for (const a of audioThreads) {
    if (!shouldShow(a)) continue;
    if (threadFilter && threadFilter !== "audio") continue;
    console.log(reportThread(a, topN, `AUDIO WORKLET (${a.name})`, false));
  }

  const renderFrameReport = reportRenderFrames(renderFrames);
  if (renderFrameReport) {
    console.log(renderFrameReport);
  }

  const worstFrameReport = reportWorstFrames(renderFrames, workerThreads[0]?.profile ?? null, 10);
  if (worstFrameReport) {
    console.log(worstFrameReport);
  }

  // The join seam: a live `frameReport({reset:true})` publishes its window as UserTiming
  // marks, so a trace taken across it can be sliced to exactly that window.
  if (perfWindow) {
    const base = workerThreads[0]?.profile?.startTs;
    const rel = (ts: number) => (Number.isFinite(base) ? `${((ts - (base as number)) / 1_000_000).toFixed(2)}s` : `${(ts / 1000).toFixed(0)}ms(abs)`);
    console.log(`\n${sep("═")}`);
    console.log(`HARNESS PERF WINDOW (join seam)`);
    console.log(sep("═"));
    console.log(`  begin: ${perfWindow.beginTsUs !== null ? rel(perfWindow.beginTsUs) : "(no begin mark)"}`
      + `  end: ${perfWindow.endTsUs !== null ? rel(perfWindow.endTsUs) : "(no end mark)"}`);
    if (perfWindow.beginTsUs !== null && perfWindow.endTsUs !== null && Number.isFinite(base)) {
      const a = ((perfWindow.beginTsUs - (base as number)) / 1000).toFixed(0);
      const b = ((perfWindow.endTsUs - (base as number)) / 1000).toFixed(0);
      console.log(`  slice this trace to exactly the harness window:  --range ${a}ms-${b}ms`);
    }
  }

  // NAMED CONDITION, not a scrolled-past warning: without the hotblocks mark (or a sidecar)
  // every wasm frame stays an opaque wasm-function[N] and guest attribution is unavailable.
  if (!embeddedHotBlocks && !JIT_BLOCK_MAP) {
    console.log(`\n${sep("═")}`);
    console.log(`GUEST ATTRIBUTION: UNAVAILABLE (no bottleship.hotblocks mark in this trace)`);
    console.log(sep("═"));
    console.log(`  wasm-function[N] frames cannot be resolved to module:rva — v86's table indices do NOT match`);
    console.log(`  Chrome's numbering, so the mapping is established by SAMPLING, never computed.`);
    console.log(`  Fix: capture with \`bun tools/harness.ts trace <sec>\` (it arms the mark automatically), or call`);
    console.log(`  \`bun tools/harness.ts hotBlocksMark\` while your own Tracing.start window is open.`);
    console.log(`  Count-weighted alternative that needs no trace: \`bun tools/harness.ts guestBlocks '{"arm":true}'\`.`);
  }

  const hotPagesReport = reportHotGuestPages(embeddedHotBlocks);
  if (hotPagesReport) {
    console.log(hotPagesReport);
  }

  const hotEipsReport = reportHotGuestInstructions(EMBEDDED_TOP_EIPS);
  if (hotEipsReport) {
    console.log(hotEipsReport);
  }

  if (!threadFilter) {
    // Show timeline across all buckets for worker thread (if any)
    if (workerThreads.length > 0) {
      const worker = workerThreads[0]!;
      if (worker.timelineUs.length > 0) {
        const tlines: string[] = [];
        tlines.push(`\n${sep("═")}`);
        tlines.push(`TIMELINE (2s buckets) — ${worker.name}`);
        tlines.push(sep("═"));
        if (renderFrames) {
          tlines.push(
            `  ${"Time".padEnd(8)} ${"idle".padStart(6)} ${"js".padStart(6)} ${"wasm".padStart(6)} ${"nat".padStart(6)} ` +
            `${"FPS".padStart(6)} ${"avg".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"fr".padStart(4)} ${"over".padStart(5)}  Hot function`
          );
          tlines.push(
            `  (p95 needs >=20 and p99 >=100 frames in the bucket; "-" means the rank had no observation, not that it was fast. ` +
            `over = frames past the ${renderFrames.budgetMs ? `${renderFrames.budgetMs.toFixed(2)}ms` : "derived"} budget)`
          );
        } else {
          tlines.push(
            `  ${"Time".padEnd(8)} ${"idle".padStart(6)} ${"js".padStart(6)} ${"wasm".padStart(6)} ${"nat".padStart(6)}  Hot function`
          );
        }
        for (const bucket of worker.timelineUs) {
          const bucketTotal =
            bucket.byCategory.idle +
            bucket.byCategory.js +
            bucket.byCategory.wasm +
            bucket.byCategory.native;
          if (bucketTotal === 0) continue;
          const start = `${Math.floor(bucket.startUs / 1_000_000)}s`;
          const rowParts = [
            pad(start, 7),
            pad(pct(bucket.byCategory.idle, bucketTotal), 6, true),
            pad(pct(bucket.byCategory.js, bucketTotal), 6, true),
            pad(pct(bucket.byCategory.wasm, bucketTotal), 6, true),
            pad(pct(bucket.byCategory.native, bucketTotal), 6, true),
          ];
          if (renderFrames) {
            const fs = renderStatsForBucket(renderFrames, worker.profile, bucket);
            rowParts.push(
              pad(fs.ok ? (1000 / fs.meanMs).toFixed(1) : "-", 6, true),
              pad(fs.ok ? fmtFrameMs(fs.meanMs) : "-", 8, true),
              pad(fs.ok && fs.p95Ms !== null ? fmtFrameMs(fs.p95Ms) : "-", 8, true),
              pad(fs.ok && fs.p99Ms !== null ? fmtFrameMs(fs.p99Ms) : "-", 8, true),
              pad(fs.ok ? String(fs.sampleCount) : "-", 4, true),
              pad(fs.ok && fs.budget ? String(fs.budget.overFrames) : "-", 5, true),
            );
          }
          const row = [
            ...rowParts,
            `  ${bucket.hotFunction}`,
          ].join(" ");
          tlines.push(`  ${row}`);
        }
        console.log(tlines.join("\n"));
      }
    }
  }

  // ── Warnings (always show — runs on all threads regardless of filter) ──
  console.log(reportWarnings(analyses));

  console.log(`\n${sep()}`);
  console.log("Done.");
}

if (import.meta.main) {
  main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
  });
}
