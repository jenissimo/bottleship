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
  parent?: number;
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
  /** Duration of a complete ("X") slice, microseconds. Absent on other phases. */
  dur?: number;
  /** Comma-separated category list Chrome recorded the event under. */
  cat?: string;
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
  /** `pid:tid` of the thread that emitted these marks — frames belong to a thread, not a trace. */
  threadKey?: string;
  threadLabel?: string;
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
  // NOT the JIT's TLB-miss path: the JIT inlines its read (codegen.rs gen_safe_read) and
  // its miss calls safe_read*_slow_jit -> safe_read_slow_jit, which never enters these.
  // A sample here is the interpreter, a jit_instructions helper, or a hypercall reading
  // guest memory. Which one it is needs a counter, not this table.
  ["safe_read32s", "Guest read from a helper (interp / jit-helper / hypercall)"],
  ["safe_write32", "Guest write from a helper (interp / jit-helper / hypercall)"],
  ["safe_read_write32", "Guest RMW from a helper (interp / jit-helper / hypercall)"],
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

/** v86's named JIT block: `g<entry addr, 8 hex>@t<wasm table index>` (jit.rs, emitted when
 *  JIT_FUNCTION_NAMES is on). The ADDRESS is authoritative — table slots get recycled. */
const NAMED_JIT_BLOCK = /^g([0-9a-f]{8})@t(\d+)$/;
/** True for a compiled guest block under EITHER naming — anonymous `wasm-function[N]` from an
 *  artifact built without JIT_FUNCTION_NAMES, or the named form above. Every classifier that
 *  means "this frame is guest code" must go through here: matching one spelling made the other
 *  fall through to "other v86 core", which reads as a plausible number under the wrong label. */
function isJitBlockName(name: string): boolean {
  return /^wasm-function\[\d+\]$/.test(name) || NAMED_JIT_BLOCK.test(name);
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
  // Named block: the guest entry address rides in the name, so it needs no sidecar map.
  const named = name.match(NAMED_JIT_BLOCK);
  if (named) {
    // A sampled sidecar may describe a later occupant of this recycled table
    // slot. Never replace the address embedded in this module's own name.
    return `JIT block (v86 compiled code) @ guest 0x${named[1]}`;
  }
  return "";
}

// ─── Frame Classification ────────────────────────────────────────────────────

function classifyFrame(frame: CallFrame): Category {
  const url = frame.url ?? "";
  const name = frame.functionName ?? "";
  // A SOURCE file whose name merely contains "wasm" is not wasm. `d3d9-wasm-arena.ts` is
  // TypeScript that writes into a wasm arena, and calling it wasm moved its whole cost out
  // of the JS bucket and into the emulator's — the roll-up then blamed v86 for our own
  // recorder. Only a real wasm module (no source extension, or an actual .wasm url) counts.
  const isSourceFile = /\.(ts|tsx|js|mjs|cjs|jsx)(\?|$)/.test(url);
  if (!isSourceFile && url.includes("wasm")) return "wasm";
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

/**
 * A single `bottleship.flip` UserTiming mark. `serial` is the app's present serial when the
 * mark carries one (`args.data.serial` / `presentSerial` / `guestPresentSerial`); a trace whose
 * marks carry no serial can still be timed, it just cannot be ledger-checked.
 */
interface FlipMark {
  tsUs: number;
  serial: number | null;
}

/** One thread's flip marks. Threads are never merged: two threads presenting into one sorted
 *  interval list halves every interval and doubles the FPS, and nothing downstream notices. */
interface FlipSeries {
  key: string;
  pid: number;
  tid: number;
  label: string;
  marks: FlipMark[];
  analysis: RenderFrameAnalysis | null;
}

/**
 * Presents counted from the ledger mark, as a SPAN over the trace window.
 *
 * The fields the mark carries are monotonic SERIALS, and a serial is not a count: a window
 * that opens at present 5000 and holds nine frames carries serial 5008, which against nine
 * flip marks reads as 4999 missing frames on a perfectly healthy trace. Only last - first + 1
 * is a count of this window, so a single sample yields `null` and is reported as uncheckable
 * rather than compared.
 */
interface PresentLedger {
  guestSpan: number | null;
  presentsSpan: number | null;
  guestSamples: number;
  presentSamples: number;
  source: string;
}

interface FlipLedgerRow {
  key: string;
  label: string;
  markCount: number;
  /** maxSerial - minSerial + 1: how many presents the app numbered across this series' span. */
  serialSpan: number | null;
  /** serialSpan - markCount: presents that happened without a mark reaching this series. */
  missing: number | null;
}

interface FlipLedger {
  rows: FlipLedgerRow[];
  guest: PresentLedger | null;
  presenterKey: string | null;
  /** Non-empty => the report must refuse to quote a single frame count. */
  divergences: string[];
  /** What the ledger could NOT check, named — so an agreement line never covers for it. */
  notes: string[];
  /** Named reason when no ledger source exists, so silence is never mistaken for agreement. */
  unavailable: string | null;
}

const FLIP_MARK = "bottleship.flip";
/** Guest-side present count. Emitted next to the flip mark by whichever thread drives present;
 *  the flip mark itself only says "a frame reached the screen on THIS thread". */
const PRESENT_LEDGER_MARK = "bottleship.present.ledger";

function markSerial(ev: TraceEvent): number | null {
  const d = ev.args?.data as Record<string, unknown> | undefined;
  if (!d) return null;
  for (const k of ["serial", "presentSerial", "guestSerial", "guestPresentSerial"]) {
    const v = d[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Flip marks grouped by the thread that emitted them — same `pid:tid` key space as
 *  extractThreadNames and the remapped profile chunks, so the three join without re-parsing. */
function extractFlipSeries(events: TraceEvent[], threadNames: Map<string, string>): FlipSeries[] {
  const byThread = new Map<string, FlipSeries>();
  for (const ev of events) {
    if (ev.name !== FLIP_MARK || !Number.isFinite(ev.ts)) continue;
    const key = `${ev.pid}:${ev.tid}`;
    let s = byThread.get(key);
    if (!s) {
      s = { key, pid: ev.pid, tid: ev.tid, label: threadNames.get(key) ?? `Thread ${key}`, marks: [], analysis: null };
      byThread.set(key, s);
    }
    s.marks.push({ tsUs: ev.ts, serial: markSerial(ev) });
  }
  const list = [...byThread.values()];
  for (const s of list) s.marks.sort((a, b) => a.tsUs - b.tsUs);
  // Most marks first: that series is the one that actually put frames on the screen.
  list.sort((a, b) => b.marks.length - a.marks.length || a.key.localeCompare(b.key));
  return list;
}

const LEDGER_GUEST_KEYS = ["guestPresentSerial", "guestSerial", "guestPresents"] as const;
const LEDGER_PRESENT_KEYS = ["presentSerial", "serial", "presents"] as const;

export function extractPresentLedger(events: TraceEvent[]): PresentLedger | null {
  let seen = false;
  const g = { min: Infinity, max: -Infinity, n: 0 };
  const p = { min: Infinity, max: -Infinity, n: 0 };
  const note = (acc: typeof g, v: number) => { acc.min = Math.min(acc.min, v); acc.max = Math.max(acc.max, v); acc.n++; };
  for (const ev of events) {
    if (ev.name !== PRESENT_LEDGER_MARK) continue;
    const d = ev.args?.data as Record<string, unknown> | undefined;
    if (!d) continue;
    seen = true;
    const pick = (keys: readonly string[]) => {
      for (const k of keys) {
        const v = d[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return null;
    };
    const gv = pick(LEDGER_GUEST_KEYS);
    const pv = pick(LEDGER_PRESENT_KEYS);
    if (gv !== null) note(g, gv);
    if (pv !== null) note(p, pv);
  }
  // Two samples are the minimum that makes a window count; see PresentLedger.
  const span = (acc: typeof g) => (acc.n >= 2 ? acc.max - acc.min + 1 : null);
  return seen
    ? { guestSpan: span(g), presentsSpan: span(p), guestSamples: g.n, presentSamples: p.n, source: PRESENT_LEDGER_MARK }
    : null;
}

function analysisFromMarks(
  marks: FlipMark[],
  budgetMs: number | undefined,
  meta: { key: string; label: string; scopedTo?: string }
): RenderFrameAnalysis | null {
  if (marks.length < 2) return null;
  const intervals: RenderFrameInterval[] = [];
  for (let i = 1; i < marks.length; i++) {
    const startTsUs = marks[i - 1]!.tsUs;
    const endTsUs = marks[i]!.tsUs;
    const deltaUs = endTsUs - startTsUs;
    if (!(deltaUs > 0) || !Number.isFinite(deltaUs)) continue;
    intervals.push({ startTsUs, endTsUs, frameMs: deltaUs / 1000 });
  }
  if (intervals.length === 0) return null;
  const stats = computeRenderFrameStats(intervals, budgetMs);
  return {
    markCount: marks.length,
    intervals,
    stats,
    // Budget actually used: explicit, or the one the distribution derived from this window.
    budgetMs: budgetMs ?? (stats.ok && stats.budget ? stats.budget.ms : undefined),
    threadKey: meta.key,
    threadLabel: meta.label,
    scopedTo: meta.scopedTo,
  };
}

/**
 * One timescale for every thread: the budget is derived ONCE from the presenting series and
 * then imposed on the others. A per-series derived budget would give each thread its own
 * definition of "over budget" and make the columns silently incomparable.
 */
export function buildFlipSeries(
  events: TraceEvent[],
  threadNames: Map<string, string>,
  budgetMs?: number
): FlipSeries[] {
  const series = extractFlipSeries(events, threadNames);
  if (series.length === 0) return series;
  const presenter = series[0]!;
  presenter.analysis = analysisFromMarks(presenter.marks, budgetMs, presenter);
  const shared = budgetMs ?? presenter.analysis?.budgetMs;
  for (const s of series.slice(1)) s.analysis = analysisFromMarks(s.marks, shared, s);
  return series;
}

/**
 * The ledger: frames that reached the screen versus presents the app says it made. A
 * best-effort single number here is the exact failure this instrument exists to prevent — a
 * render thread that drops every second present still produces a perfectly plausible p50.
 */
export function computeFlipLedger(series: FlipSeries[], guest: PresentLedger | null): FlipLedger {
  const tidOf = (key: string) => key.split(":")[1] ?? "?";
  const rows: FlipLedgerRow[] = series.map(s => {
    const serials = s.marks.map(m => m.serial).filter((v): v is number => v !== null);
    // Reduced, not spread: a long trace carries tens of thousands of marks and the argument
    // limit would turn a healthy series into a RangeError.
    let lo = Infinity, hi = -Infinity;
    for (const v of serials) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const serialSpan = serials.length >= 2 ? hi - lo + 1 : null;
    return {
      key: s.key,
      label: s.label,
      markCount: s.marks.length,
      serialSpan,
      missing: serialSpan === null ? null : serialSpan - s.marks.length,
    };
  });

  const divergences: string[] = [];
  for (const r of rows) {
    if (r.missing !== null && r.missing !== 0) {
      divergences.push(
        `${r.label} (tid ${tidOf(r.key)}): ${r.markCount} flip marks but present serials span ${r.serialSpan}` +
        ` — ${r.missing > 0 ? `${r.missing} present(s) never reached this thread` : `${-r.missing} more marks than serials (duplicated marks)`}`
      );
    }
  }

  const presenter = rows[0] ?? null;
  const notes: string[] = [];
  // The guest's own count is the independent oracle. `presentSerial` is the render side's own
  // counter, so falling back to it is a self-comparison and is labelled as one rather than
  // passed off as the guest's.
  const guestCount = guest?.guestSpan ?? guest?.presentsSpan ?? null;
  const countKind = guest?.guestSpan !== null && guest?.guestSpan !== undefined
    ? "guest-side present count"
    : "RENDER-side present count (not the guest's — no guest serial in the ledger mark, so this compares the presenting thread against itself)";
  if (guest && guestCount === null) {
    const samples = Math.max(guest.guestSamples, guest.presentSamples);
    notes.push(samples === 0
      ? `${guest.source} carries no present count under any name this tool reads`
        + ` (${[...LEDGER_GUEST_KEYS, ...LEDGER_PRESENT_KEYS].join(", ")}) — the guest side was NOT checked.`
      : `${guest.source} has a single sample: one absolute serial cannot say how many presents this`
        + ` window covers, so the guest side was NOT checked. Emit the mark per present.`);
  }
  if (presenter && guestCount !== null && guestCount !== presenter.markCount) {
    divergences.push(
      `${countKind} ${guestCount} (${guest!.source}) != ${presenter.markCount} flip marks on the presenting thread` +
      ` ${presenter.label} (tid ${tidOf(presenter.key)}) — ${Math.abs(guestCount - presenter.markCount)} frame(s) unaccounted for`
    );
  }
  if (rows.length > 1) {
    const counts = rows.map(r => r.markCount);
    if (Math.max(...counts) !== Math.min(...counts)) {
      divergences.push(
        `flip marks are split across ${rows.length} threads with unequal counts (` +
        `${rows.map(r => `tid ${tidOf(r.key)}: ${r.markCount}`).join(", ")}) — no single FPS number describes this trace`
      );
    }
  }

  // Nothing comparable on either side is UNAVAILABLE, never agreement — a ledger mark whose
  // field names drifted away from the ones read above yields no number at all, and an "OK"
  // printed over that is a false assurance about a check that never ran.
  const unavailable = guestCount === null && rows.every(r => r.serialSpan === null)
    ? (guest === null
        ? `no guest-side present count in this trace: neither a ${PRESENT_LEDGER_MARK} mark nor a serial on the ${FLIP_MARK} marks.`
        : `${notes[0] ?? `${guest.source} yielded no usable count`} No ${FLIP_MARK} mark carries a serial either.`)
      + ` Frame counts below are what REACHED a thread, and cannot be checked against what the app presented.`
    : null;

  return { rows, guest, presenterKey: presenter?.key ?? null, divergences, notes, unavailable };
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

export function extractThreadNames(events: TraceEvent[]): Map<string, string> {
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
export function mergeProfileChunks(events: TraceEvent[]): Map<string, MergedProfile> {
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
    if (ev.name === "Profile") {
      // Sample deltas start at Profile.startTime, not at the later chunk delivery.
      const start = (ev.args?.data as { startTime?: number } | undefined)?.startTime ?? ev.ts;
      if (!profile.startTime) profile.startTime = start;
      profile.startTs = Math.min(profile.startTs, start);
    }
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

export function buildParentMap(nodes: Map<number, RawNode>): Map<number, number> {
  const parentMap = new Map<number, number>();
  const add = (child: number, parent: number): void => {
    const previous = parentMap.get(child);
    if (previous !== undefined && previous !== parent) {
      throw new Error(`Conflicting profile parents for node ${child}: ${previous} and ${parent}`);
    }
    parentMap.set(child, parent);
  };
  for (const node of nodes.values()) {
    // Trace ProfileChunk uses parent; standalone CDP profiles use children.
    if (node.parent !== undefined) add(node.id, node.parent);
    if (node.children) {
      for (const childId of node.children) {
        add(childId, node.id);
      }
    }
  }
  return parentMap;
}

// ─── Stats Computation ────────────────────────────────────────────────────────

export function computeStats(
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

export function analyzeThread(
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

// ─── v86 view() Proxy rollup (--proxy) ────────────────────────────────────────
//
// v86 hands guest RAM and the CPU state block out as `view()` Proxies
// (vendor/v86/src/lib.js), so every element access is a trap: a `get`/`set` frame plus the
// `resolve` closure. In a profile those land under their own names, in v86's own file, with
// the CALLER — the thing that would have to change — one or more frames up.
//
// This folds every such frame into its nearest non-v86 ancestor and reports the share.
// That share is the independent oracle for a Proxy-removal A/B: it is measured from stack
// frames, not from FPS, so it cannot move because the two arms happened to be looking at
// different scenes (§3.4 — an A/B needs a counter the picture cannot fake).

/** A frame that IS the Proxy machinery, not a caller of it. */
function isProxyFrame(frame: CallFrame): boolean {
  const url = frame.url ?? "";
  if (!/libv86|\/v86|v86\.mjs|lib\.js/.test(url)) return false;
  const fn = frame.functionName ?? "";
  return fn === "get" || fn === "set" || fn === "resolve" || fn === "get buffer"
    || fn === "" || fn.startsWith("get ") || fn.startsWith("set ");
}

/** Any frame inside v86's own JS — an ancestor here is still not OUR caller. */
function isV86JsFrame(frame: CallFrame): boolean {
  return /libv86|\/v86|v86\.mjs/.test(frame.url ?? "");
}

interface ProxyRollupRow { owner: string; us: number; samples: number }

function reportProxyRollup(a: ThreadAnalysis): string {
  const byOwner = new Map<string, ProxyRollupRow>();
  let proxyUs = 0;
  let proxySamples = 0;

  for (let i = 0; i < a.profile.samples.length; i++) {
    const leafId = a.profile.samples[i]!;
    const dt = a.profile.timeDeltas[i] ?? 0;
    if (dt <= 0) continue;
    const leaf = a.profile.nodes.get(leafId);
    if (!leaf || !isProxyFrame(leaf.callFrame)) continue;

    proxyUs += dt;
    proxySamples++;

    // Nearest ancestor that is neither Proxy machinery nor any other v86-internal frame:
    // attributing to `resolve`'s parent `get` would name the trap twice and the caller never.
    let owner = "(entry / no stack)";
    let cur: number | undefined = a.parentMap.get(leafId);
    const seen = new Set<number>([leafId]);
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const n = a.profile.nodes.get(cur);
      const name = n?.callFrame.functionName;
      if (n && name && name !== "(root)" && name !== "(program)" && name !== "(idle)"
          && name !== "(garbage collector)" && !isV86JsFrame(n.callFrame)) {
        owner = frameLabel(n.callFrame, false);
        break;
      }
      cur = a.parentMap.get(cur);
    }
    const row = byOwner.get(owner) ?? { owner, us: 0, samples: 0 };
    row.us += dt;
    row.samples++;
    byOwner.set(owner, row);
  }

  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`v86 view() PROXY TRAPS — ${a.name}`);
  lines.push(sep("═"));
  if (proxySamples === 0) {
    // A zero here is only meaningful if the sampler could have seen one at all.
    lines.push(`  0 samples landed in a v86 view() Proxy frame.`);
    lines.push(`  Either the hot paths no longer index one, or this trace has no worker JS samples`);
    lines.push(`  at all (${a.sampleCount} samples, ${fmtUs(a.totalUs)} total) — check the thread report above`);
    lines.push(`  before reading this as "the Proxy cost is gone".`);
    return lines.join("\n");
  }
  // Two denominators, because one of them is misleading on its own: this thread is mostly
  // JIT-executed guest code, so a share of the WHOLE thread makes any JS cost look like
  // rounding. The share of the JS bucket is what a JS-side change can actually move.
  const jsUs = a.byCategory.js;
  lines.push(`  ${fmtUs(proxyUs)} in Proxy machinery over ${num(proxySamples)} samples:`);
  lines.push(`    ${pct(proxyUs, a.totalUs)} of the whole thread (mostly JIT-executed guest code), and`);
  lines.push(`    ${jsUs > 0 ? pct(proxyUs, jsUs) : "n/a"} of its JS bucket (${fmtUs(jsUs)}) — the share a JS-side change can move.`);
  lines.push(`  Attributed to the nearest caller OUTSIDE v86's own JS — that is the code that would change.`);
  // A sampling profiler sees a trap only when a sample lands INSIDE it. A get trap is a few
  // dozen nanoseconds, so most of them are never on top of the stack when the sampler fires
  // and are charged to the caller instead. Treat every number here as a LOWER BOUND.
  lines.push(`  LOWER BOUND: a sampler only catches a trap it lands inside; short traps are charged to the caller.`);
  lines.push("");
  lines.push(`  ${pad("caller", 54, true)} ${pad("time", 10)} ${pad("share", 8)}`);
  lines.push(`  ${"─".repeat(54)} ${"─".repeat(10)} ${"─".repeat(8)}`);
  const rows = [...byOwner.values()].sort((x, y) => y.us - x.us).slice(0, 20);
  for (const r of rows) {
    lines.push(`  ${pad(r.owner.slice(0, 54), 54, true)} ${pad(fmtUs(r.us), 10)} ${pad(pct(r.us, proxyUs), 8)}`);
  }
  return lines.join("\n");
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
      title: `Guest access helpers: ${safePct.toFixed(1)}%`,
      detail: "safe_read/write hot. NOT the JIT fast path (inlined) and NOT its miss path (safe_read*_slow_jit) — this is the interpreter, a jit_instructions helper, or a hypercall reading guest memory. Attribute it before optimising it.",
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

/**
 * What the GPU PROCESS did, and — the part that matters more — whether the trace can say.
 *
 * A frame budget that blames "the GPU" needs two different things and they are not
 * interchangeable:
 *   - Wall-time coverage in the GPU process (union of instrumented thread intervals).
 *     Scopes can contain waits or descheduling, so this does not measure scheduled CPU time.
 *   - Hardware timings — what the device actually spent. Those live in `gpu` /
 *     `disabled-by-default-gpu.dawn`, and a trace recorded without them is SILENT about the
 *     hardware, not evidence that the hardware is idle. Category presence alone is also
 *     insufficient: hardware timings require decoding the recorded work and clock domains.
 *
 * Conflating the two is how a plan gets sized off the wrong number, so this section reports
 * them apart and prints an explicit UNAVAILABLE rather than an empty table when the categories
 * were not recorded (tools/cdp-core.ts records them since 2026-09-02; older artifacts do not).
 */
export function reportGpuProcess(events: TraceEvent[], threadNames: Map<string, string>, frames: number, scopedTo?: string): string {
  const GPU_THREADS = /^(CrGpuMain|VizCompositorThread|CompositorTileWorker|DrmThread|GpuWatchdog)/;
  const byThread = new Map<string, { name: string; busyUs: number; slices: number; intervals: Array<[number, number]> }>();
  let gpuCatEvents = 0;
  let dawnCatEvents = 0;
  let spanLoUs = Infinity, spanHiUs = -Infinity;

  for (const ev of events) {
    const cat = ev.cat ?? "";
    if (cat.includes("disabled-by-default-gpu.dawn")) dawnCatEvents++;
    else if (/\bgpu\b/.test(cat)) gpuCatEvents++;
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    const key = `${ev.pid}:${ev.tid}`;
    const name = threadNames.get(key);
    if (!name || !GPU_THREADS.test(name)) continue;
    const e = byThread.get(key) ?? { name, busyUs: 0, slices: 0, intervals: [] };
    if (ev.dur > 0) e.intervals.push([ev.ts, ev.ts + ev.dur]);
    e.slices++;
    byThread.set(key, e);
    if (ev.ts < spanLoUs) spanLoUs = ev.ts;
    if (ev.ts + ev.dur > spanHiUs) spanHiUs = ev.ts + ev.dur;
  }

  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push("GPU PROCESS" + (scopedTo ? `  [scoped to --range ${scopedTo}]` : ""));
  lines.push(sep("═"));

  if (byThread.size === 0) {
    lines.push("No GPU-process slices in this trace.");
    lines.push("  A trace with no `toplevel` events from CrGpuMain cannot say anything about the");
    lines.push("  GPU process at all — not even that it was idle. Re-record with tools/cdp-core.ts.");
    return lines.join("\n");
  }

  const spanMs = spanHiUs > spanLoUs ? (spanHiUs - spanLoUs) / 1000 : 0;
  for (const thread of byThread.values()) {
    // Task and Dawn scopes overlap on the same thread; their sum double-counts work.
    thread.intervals.sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    for (const [start, stop] of thread.intervals) {
      thread.busyUs += Math.max(0, stop - Math.max(start, end));
      end = Math.max(end, stop);
    }
  }
  lines.push(` ${pad("thread", 26)} ${pad("covered ms", 10, true)} ${pad("slices", 8, true)} ${pad("ms/frame", 10, true)}`);
  lines.push(` ${"-".repeat(58)}`);
  const ordered = [...byThread.values()].sort((a, b) => b.busyUs - a.busyUs);
  for (const t of ordered) {
    const perFrame = frames > 0 ? (t.busyUs / 1000 / frames).toFixed(2) : "n/a";
    lines.push(` ${pad(t.name, 26)} ${pad((t.busyUs / 1000).toFixed(1), 10, true)} ${pad(String(t.slices), 8, true)} ${pad(perFrame, 10, true)}`);
  }
  if (spanMs > 0) lines.push(` window ${spanMs.toFixed(0)} ms${frames > 0 ? `, ${frames} frame(s) counted` : ""}`);
  lines.push("");
  lines.push(" Union of instrumented wall-time intervals per GPU-process thread; nested scopes counted once.");
  lines.push(" Includes waits/descheduling inside scopes. This is neither scheduled CPU time nor GPU hardware time.");

  lines.push("");
  if (dawnCatEvents === 0) {
    lines.push(" GPU HARDWARE TIMINGS: UNAVAILABLE — no `disabled-by-default-gpu.dawn` events.");
    lines.push("   The trace was recorded without that category, so the hardware side is not absent,");
    lines.push("   it is UNOBSERVED. Do not conclude anything about the device from the rows above.");
    if (gpuCatEvents > 0) lines.push(`   (${gpuCatEvents} plain \`gpu\` event(s) present, which is not enough on their own.)`);
  } else {
    lines.push(` Dawn/WebGPU work items recorded: ${dawnCatEvents} (category present).`);
    lines.push(" GPU HARDWARE TIMINGS: NOT DECODED — Dawn category presence alone does not measure GPU execution.");
  }
  return lines.join("\n");
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

/**
 * RENDER FRAME TIMING — one block per thread that emitted flip marks, all on ONE budget.
 *
 * Frames belong to the thread that presented them. A render worker and the guest worker both
 * appear as "DedicatedWorker thread" and both classify as role "worker", so the only honest
 * label is the tid plus what the trace observed; the presenting thread is simply the one whose
 * marks are most numerous, and it is named as such rather than assumed.
 */
export function reportRenderFrames(series: FlipSeries[]): string | null {
  const withMarks = series.filter(s => s.marks.length > 0);
  if (withMarks.length === 0) return null;

  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`RENDER FRAME TIMING`);
  lines.push(sep("═"));
  const scopedTo = withMarks.find(s => s.analysis?.scopedTo)?.analysis?.scopedTo;
  lines.push(`Source: ${FLIP_MARK} UserTiming marks (app-level present cadence)`
    + (scopedTo ? `  [scoped to --range ${scopedTo}]` : ""));
  const presenter = withMarks[0]!;
  const tied = withMarks.filter(s => s.marks.length === presenter.marks.length).length;
  if (withMarks.length > 1) {
    lines.push(`${withMarks.length} threads emitted flip marks. They are NEVER merged: one sorted interval list`);
    lines.push(`over two threads halves every interval and doubles the FPS. Presenting thread (most marks):`);
    lines.push(`  ${presenter.label} (tid ${presenter.tid}) — ${num(presenter.marks.length)} marks.`);
    // A trace carries no role discriminator: both workers are "DedicatedWorker thread" and both
    // classify as role "worker". On a tie the pick is tid order and says so rather than implying
    // the tool knows which thread owned the screen.
    if (tied > 1) {
      lines.push(`  NOTE: ${tied} threads tie on mark count — "PRESENTED" is tid order here, not an observation.`);
    }
  }

  for (const s of withMarks) {
    const a = s.analysis;
    lines.push(``);
    lines.push(`[${s.key === presenter.key ? "PRESENTED" : "also flipping"}] ${s.label} (tid ${s.tid})`);
    if (!a) {
      lines.push(`  Marks: ${num(s.marks.length)} — too few for an interval distribution (need >= 2).`);
      continue;
    }
    const st = a.stats;
    lines.push(`  Marks: ${num(a.markCount)}  Intervals: ${num(st.sampleCount)}`);
    if (!st.ok) {
      lines.push(`  No distribution: ${st.status} — ${st.note}`);
      continue;
    }
    lines.push(
      `  Avg: ${fmtFrameMs(st.meanMs)} (${(st.meanMs > 0 ? 1000 / st.meanMs : 0).toFixed(1)} FPS)  ` +
      `P50: ${fmtTail(st.p50Ms)}  P95: ${fmtTail(st.p95Ms)}  ` +
      `P99: ${fmtTail(st.p99Ms)}  Max: ${fmtFrameMs(st.maxMs)}`
    );
    for (const why of st.unavailable) lines.push(`    ${why}`);
    if (st.budget) {
      const b = st.budget;
      lines.push(
        `  Budget ${fmtFrameMs(b.ms)} (${b.source}): over ${num(b.overFrames)} (${b.overPct.toFixed(1)}%)  ` +
        `>2x budget: ${num(b.over2xFrames)}  lost ~${b.excessMsApprox.toFixed(0)}ms  p99/budget: ${b.p99OverBudget ?? "n/a"}`
      );
      if (b.straddleFrames > 0) lines.push(`    ${num(b.straddleFrames)} frames sit in the bucket the budget falls inside (unclassifiable either way)`);
    } else if (st.budgetNote) {
      lines.push(`  Budget: ${st.budgetNote}`);
    }
  }
  lines.push(`  (percentiles are bucket UPPER BOUNDS, same definition as the live harness frameReport)`);
  if (withMarks.length > 1) {
    lines.push(`  (every block above is judged against the presenting thread's budget, so the two are on one scale)`);
  }
  lines.push(`  --budget-ms <n> to judge against the title's own cadence instead of the derived one.`);
  return lines.join("\n");
}

/**
 * FRAME LEDGER — what reached the screen against what the app says it presented.
 *
 * The check that makes the frame numbers above quotable: percentiles over a series that is
 * missing half its presents look entirely healthy. A divergence is printed LOUD and the single
 * FPS number is explicitly refused; an absent ledger source prints its own named reason.
 */
export function reportFlipLedger(ledger: FlipLedger): string {
  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`FRAME LEDGER CROSS-CHECK (presented vs guest-side present count)`);
  lines.push(sep("═"));
  lines.push(` ${pad("thread", 40)} ${pad("marks", 8, true)} ${pad("serials", 9, true)} ${pad("missing", 8, true)}`);
  for (const r of ledger.rows) {
    lines.push(` ${pad(`${r.label} (tid ${r.key.split(":")[1]})`, 40)} ${pad(num(r.markCount), 8, true)} ` +
      `${pad(r.serialSpan === null ? "n/a" : num(r.serialSpan), 9, true)} ${pad(r.missing === null ? "n/a" : num(r.missing), 8, true)}`);
  }
  if (ledger.guest) {
    lines.push(`Guest-side ledger (${ledger.guest.source}): presents in window=${ledger.guest.presentsSpan ?? "n/a"}` +
      `  guest presents in window=${ledger.guest.guestSpan ?? "n/a"}` +
      `  (spans over ${ledger.guest.guestSamples || ledger.guest.presentSamples} sample(s); a span, not a serial)`);
  }
  // Notes come BEFORE the verdict: what was not checked has to be read together with it.
  for (const n of ledger.notes) lines.push(`NOT CHECKED: ${n}`);
  if (ledger.unavailable) {
    lines.push(`LEDGER UNAVAILABLE: ${ledger.unavailable}`);
    return lines.join("\n");
  }
  if (ledger.divergences.length === 0) {
    const checked = ledger.rows.some(r => r.serialSpan !== null) ? "per-thread serial spans" : "";
    const guestChecked = ledger.guest && (ledger.guest.guestSpan !== null || ledger.guest.presentsSpan !== null)
      ? "the ledger mark's present count" : "";
    lines.push(`LEDGER OK: ${[checked, guestChecked].filter(Boolean).join(" and ")} agree with the flip marks.`);
    return lines.join("\n");
  }
  lines.push(``);
  lines.push(`!!! LEDGER DIVERGENCE — frame counts below do NOT describe the same work !!!`);
  for (const d of ledger.divergences) lines.push(`  !!! ${d}`);
  lines.push(`  REFUSED: a single FPS / p50 for this trace. Frames that never reached the presenting`);
  lines.push(`  thread are invisible to an inter-mark distribution, which stays plausible while halving.`);
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

/**
 * TAIL COMPOSITION — which bucket actually CAUSES the tail, as opposed to merely being
 * present in it. A bucket that is 9% of every frame is 9% of a slow frame too, so it shows
 * up as a "hot leaf in the worst frames" while explaining none of the excess. The only
 * statistic that discriminates is EXCESS ms/frame: bucket ms/frame in the tail band minus
 * bucket ms/frame in the median band. Those must sum to the frame-length excess, which is
 * printed so the attribution can be checked against it rather than trusted.
 *
 * Bands are taken from the frame-length distribution itself (median = p45..p55, tail =
 * >= p90 and under 2x budget) so the two populations a stalled title shows — a persistent
 * tail and rare catastrophic frames — are never averaged together; frames past 2x budget
 * are counted and excluded, never silently folded in.
 */
function reportTailComposition(
  renderFrames: RenderFrameAnalysis | null,
  workerProfile: MergedProfile | null
): string | null {
  if (!renderFrames || !workerProfile || !Number.isFinite(workerProfile.startTs)) return null;
  const ivs = renderFrames.intervals;
  if (ivs.length === 0) return null;

  const sorted = ivs.slice().sort((a, b) => a.frameMs - b.frameMs);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!.frameMs;
  const budget = renderFrames.budgetMs ?? at(0.5);
  const outlierCut = budget * 2;

  const median = ivs.filter(i => i.frameMs >= at(0.45) && i.frameMs <= at(0.55));
  const tail = ivs.filter(i => i.frameMs >= at(0.90) && i.frameMs < outlierCut);
  const outliers = ivs.filter(i => i.frameMs >= outlierCut);

  const lines: string[] = [];
  lines.push(`\n${sep("═")}`);
  lines.push(`TAIL COMPOSITION — per-bucket EXCESS ms/frame (tail band vs median band)`);
  lines.push(sep("═"));

  if (ivs.length < 40 || median.length < 5 || tail.length < 5) {
    lines.push(`REFUSED: ${ivs.length} frames in window — median band ${median.length}, tail band ${tail.length}.`);
    lines.push(`Under 40 frames overall or 5 in either band, a per-bucket mean is noise, not a measurement.`);
    lines.push(`Record a longer window (or widen --range).`);
    return lines.join("\n");
  }

  // One pass over samples, charging each to whichever band's frame window contains it.
  const acc = (band: RenderFrameInterval[]) => {
    const wins = band.slice().sort((a, b) => a.startTsUs - b.startTsUs);
    const buckets = new Map<OptBucket, number>();
    let sampledUs = 0;
    let spanUs = 0;
    for (const w of wins) spanUs += w.endTsUs - w.startTsUs;
    let cumulativeUs = 0;
    let wi = 0;
    for (let i = 0; i < workerProfile.samples.length; i++) {
      const dt = workerProfile.timeDeltas[i] ?? 0;
      cumulativeUs += dt;
      const abs = workerProfile.startTs + cumulativeUs;
      while (wi < wins.length && wins[wi]!.endTsUs <= abs) wi++;
      if (wi >= wins.length) break;
      if (abs < wins[wi]!.startTsUs) continue;
      const node = workerProfile.nodes.get(workerProfile.samples[i]!);
      if (!node) continue;
      const b = optBucket(node.callFrame);
      buckets.set(b, (buckets.get(b) ?? 0) + dt);
      sampledUs += dt;
    }
    return { buckets, sampledUs, spanUs, n: band.length };
  };

  const M = acc(median);
  const T = acc(tail);
  const cov = (a: typeof M) => (a.spanUs > 0 ? (a.sampledUs / a.spanUs) * 100 : 0);
  const covM = cov(M), covT = cov(T);

  const mMs = M.spanUs / 1000 / M.n;
  const tMs = T.spanUs / 1000 / T.n;
  lines.push(`median band  p45..p55  ${String(M.n).padStart(4)} frames  ${mMs.toFixed(2)} ms/frame  sample coverage ${covM.toFixed(0)}%`);
  lines.push(`tail band     >=p90    ${String(T.n).padStart(4)} frames  ${tMs.toFixed(2)} ms/frame  sample coverage ${covT.toFixed(0)}%`);
  if (outliers.length > 0) {
    lines.push(`excluded: ${outliers.length} frame(s) past 2x budget (${outliers.map(o => o.frameMs.toFixed(0) + "ms").join(", ")}) — a separate population, not this tail`);
  }
  if (covM < 80 || covT < 80) {
    lines.push(`! coverage under 80% in a band — the excess below is attributed from a partial sample and`);
    lines.push(`  cannot account for the whole frame-length difference. Treat signs only, not magnitudes.`);
  }
  lines.push(``);
  lines.push(`Frame-length excess to explain: ${(tMs - mMs).toFixed(2)} ms/frame`);
  lines.push(` ${pad("bucket", 28)} ${pad("median", 10, true)} ${pad("tail", 10, true)} ${pad("excess", 10, true)} ${pad("%excess", 8, true)}`);
  lines.push(` ${"-".repeat(70)}`);

  const names = new Set<OptBucket>([...M.buckets.keys(), ...T.buckets.keys()]);
  const rows = [...names].map(b => {
    const m = (M.buckets.get(b) ?? 0) / 1000 / M.n;
    const t = (T.buckets.get(b) ?? 0) / 1000 / T.n;
    return { b, m, t, d: t - m };
  }).sort((a, b) => b.d - a.d);

  const totalExcess = tMs - mMs;
  for (const r of rows) {
    const share = totalExcess > 0 ? `${((r.d / totalExcess) * 100).toFixed(0)}%` : "-";
    lines.push(
      ` ${pad(r.b, 28)} ${pad(r.m.toFixed(2), 10, true)} ${pad(r.t.toFixed(2), 10, true)} ` +
      `${pad((r.d >= 0 ? "+" : "") + r.d.toFixed(2), 10, true)} ${pad(share, 8, true)}`
    );
  }
  const sumD = rows.reduce((s, r) => s + r.d, 0);
  lines.push(` ${"-".repeat(70)}`);
  lines.push(` ${pad("sum of excess", 28)} ${pad("", 10, true)} ${pad("", 10, true)} ${pad((sumD >= 0 ? "+" : "") + sumD.toFixed(2), 10, true)}`);
  lines.push(`  (sum should track the frame-length excess above; a large gap means sampling missed the difference)`);
  lines.push(`  A bucket present in the tail at its ORDINARY share has excess ~0 — it is a passenger, not a cause.`);
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
  | "OUT trap (our HLE boundary)"
  | "our HLE (wasm hypercalls)"
  | "dispatch (main_loop)"
  | "indirect-jump (jit cache)"
  | "interpreter (non-JIT)"
  | "fpu primitives"
  | "sse primitives"
  | "mmu / decode / irq"
  | "other v86 core"
  | "JS HLE + glue"
  | "idle";

/** Ours, wherever it runs. Separated from the v86 tax because the LEVER is different: our
 *  code is removable by us, the emulator's tax is not. Lumping the two told a reader of the
 *  NFSU race to "target v86 core first" when ~80% of that bucket was our own hypercalls,
 *  our own OUT trap and our own arena recorder. */
const OPT_OURS_BUCKETS = new Set<OptBucket>([
  "OUT trap (our HLE boundary)",
  "our HLE (wasm hypercalls)",
  "JS HLE + glue",
]);

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
  // OUR OWN WinAPI boundary, not the emulator's cost. Every guest call into an HLE module
  // leaves the JIT through `OUT dx,eax`; measured on NFSU that is ~30k traps per frame and
  // 4.9% of busy. Bucketed apart because the lever is ours (a guest-side stub removes the
  // crossing entirely) and because leaving it under "v86 core" told the reader to optimise
  // the emulator for a cost the emulator does not impose.
  if (name === "instr32_EF" || name === "instr16_EF"
    || name.includes("io_port_write") || name.includes("io_port_read")
    || name.includes("test_privileges_for_io")) {
    return "OUT trap (our HLE boundary)";
  }
  // OUR HLE running inside the engine: the hypercall tiers (CLAUDE.md 3.7) and the EAGL
  // token layer. These are v86-hosted but they are our code and our lever.
  if (name.includes("hypercall")) return "our HLE (wasm hypercalls)";

  // Rust name mangling: v0 (`_RNvNt…`) length-prefixes each path segment, so a helper reads
  // as `…12safe_write32`, and the `startsWith` these tests used matched NONE of them. On the
  // NFSU race that silently moved every guest read/write helper into "other v86 core".
  if (
    name.includes("tlb_") ||
    name.includes("safe_read") ||
    name.includes("safe_write") ||
    name.includes("write32_no_mmap") ||
    name.includes("read32s") ||
    name.includes("do_task_switch") ||
    name.includes("call_interrupt") ||
    name.includes("modrm_resolve") ||
    name.includes("translate_address")
  )
    return "mmu / decode / irq";
  // A compiled guest block under BOTH namings: the anonymous `wasm-function[N]` of an
  // artifact built without JIT_FUNCTION_NAMES, and the named `g<entry addr>@t<table idx>`
  // v86 emits with it (jit.rs). Matching only the former silently reclassified every
  // guest block as "other v86 core" — the roll-up then blamed the emulator core for the
  // game's own scene traversal and pointed the reader at the opposite of the answer.
  if (isJitBlockName(name)) return "GAME CODE (jit blocks)";
  // Both manglings: v0 (`_RNvNt…`, current rustc) and the legacy v86 `_ZN3v86…`. Matching
  // only the legacy one left every current Rust frame to fall through to classifyFrame.
  if (name.startsWith("_ZN3v86") || name.startsWith("_RNv")) return "other v86 core";
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
  let ours = 0;
  for (const [b, us] of buckets) {
    if (OPT_OURS_BUCKETS.has(b)) ours += us;
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
  // The headline the other three rows do not give: how much of the frame is OURS at all —
  // JS glue plus the wasm hypercalls plus the OUT trap. On a heavily-thunked title this is
  // the majority of busy time, and it is the only part we can REMOVE rather than merely make
  // faster. Reading the three rows above without it once produced "target v86 core first"
  // on a frame where our own code was 56%.
  lines.push(`  ── OURS in total      ${pad(pct(ours, busy), 7, true)}  → removable by us (JS glue + hypercalls + OUT trap),`
    + ` unlike the game's own code`);
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
/** The three dispatcher regions a JS self-sample can sit in, in the order they are reported. */
const DISPATCHER_REGIONS = [
  "under drainWriteBuffer",
  "under the boundary, outside the drain",
  "outside the boundary",
] as const;
type DispatcherRegion = typeof DISPATCHER_REGIONS[number];

interface DeferrableCensus {
  totalUs: number;
  /** Self-time the profiler attributed to the idle family — the gap between the two denominators. */
  idleUs: number;
  busyUs: number;
  bucketUs: number;
  /** The ceiling: JS self-time under the ring drain or the D3D9 executor's frame walk. */
  offGuestUs: number;
  /**
   * The ceiling split by WHICH SIDE of the render-worker boundary the work would land on.
   * `offGuestUs` answers "is this work the guest is already done waiting for"; these two
   * answer "would moving the executor take it away", which is the question a placement plan
   * is actually costed against. They differ by an order of magnitude — the drain region IS
   * the recorder, and a recorder stays on the guest thread. Reporting only the union is how
   * render-worker-plan-2026-09-11 came to quote a ceiling 3-5x its own scope.
   */
  movesUs: number;
  keepsUs: number;
  byRegion: Map<DispatcherRegion, number>;
  drainLeaves: Map<string, number>;
  outsideLeaves: Map<string, number>;
}

/**
 * The modules a render worker would own (render-worker-plan-2026-09-11 SS4). Everything else
 * in the deferrable region is recorder/shadow state, which stays with the guest thread.
 */
const RENDER_WORKER_SIDE = [
  /d3d9-backend-executor/, /webgpu-backend/, /post-fx-chain/, /presenter/,
  /frame-interpolator/, /gpu-device-lifecycle/,
];

function jsOwnerFileOf(f: CallFrame): string {
  const url = f.url ?? "";
  if (!url) return "(no url)";
  const parts = url.split('/');
  const base = parts[parts.length - 1]!.split(String.fromCharCode(92)).pop() ?? url;
  return base.split("?")[0] || base;
}

/**
 * The DEFERRABLE census — work that runs on the guest thread and owes the guest no
 * synchronous answer (the Tier-0 ring drain plus the D3D9 executor's frame walk, which runs
 * after the guest has already been told S_OK). It is the CEILING for moving the D3D9 half to
 * its own worker: perfect overlap, no fence priced.
 *
 * Pure, and separate from the printing, because the number it produces is quoted in planning
 * documents in BOTH denominators — a figure whose denominator is ambiguous is the failure this
 * file exists to prevent, and a figure nothing can assert on is untestable.
 */
export function computeDeferrable(analysis: ThreadAnalysis): DeferrableCensus {
  const totalUs = analysis.totalUs;
  const idleUs = analysis.nodes
    .filter(ns => optBucket(ns.node.callFrame) === "idle")
    .reduce((a, ns) => a + ns.selfUs, 0);
  const busyUs = Math.max(1, totalUs - idleUs);

  // The bucket under study, by the same classifier the roll-up uses — so the two cannot drift.
  const isJsBucket = (n: RawNode) => optBucket(n.callFrame) === "JS HLE + glue";
  let bucketUs = 0;
  for (const ns of analysis.nodes) if (isJsBucket(ns.node)) bucketUs += ns.selfUs;

  // Walked per SAMPLE, not per node: the same function can appear under different
  // ancestors, and only the sample knows which stack it was on.
  const nameOf = (id: number) => analysis.profile.nodes.get(id)?.callFrame?.functionName ?? "";
  const byRegion = new Map<DispatcherRegion, number>();
  const outsideLeaves = new Map<string, number>();
  const drainLeaves = new Map<string, number>();
  let offGuestUs = 0, movesUs = 0, keepsUs = 0;
  for (let i = 0; i < analysis.profile.samples.length; i++) {
    const leafId = analysis.profile.samples[i]!;
    const leaf = analysis.profile.nodes.get(leafId);
    if (!leaf || !isJsBucket(leaf)) continue;
    const dt = analysis.profile.timeDeltas[i] ?? 0;
    if (dt <= 0) continue;
    // Walk to the root looking for the two markers. The drain is nested inside the
    // boundary, so it is checked first and wins.
    let cur: number | undefined = leafId;
    const seen = new Set<number>();
    let inDrain = false, inBoundary = false, inMoves = false;
    // Walked to the ROOT, never broken early: the executor can sit under the drain, and a
    // walk that stops at the first marker cannot tell the two sides of the boundary apart.
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const nm = nameOf(cur);
      const file = jsOwnerFileOf(analysis.profile.nodes.get(cur)!.callFrame);
      if (RENDER_WORKER_SIDE.some(re => re.test(file))) inMoves = true;
      if (nm === "drainWriteBuffer") inDrain = true;
      if (nm === "handlePortWrite" || nm === "_handlePortWriteSlow") inBoundary = true;
      cur = analysis.parentMap.get(cur);
    }
    const region: DispatcherRegion = inDrain ? DISPATCHER_REGIONS[0] : inBoundary ? DISPATCHER_REGIONS[1] : DISPATCHER_REGIONS[2];
    byRegion.set(region, (byRegion.get(region) ?? 0) + dt);
    if (inDrain || inMoves) offGuestUs += dt;
    if (inMoves) movesUs += dt; else if (inDrain) keepsUs += dt;
    const lf = `${leaf.callFrame.functionName || "(anonymous)"} @ ${jsOwnerFileOf(leaf.callFrame)}`;
    if (region === DISPATCHER_REGIONS[2]) outsideLeaves.set(lf, (outsideLeaves.get(lf) ?? 0) + dt);
    if (region === DISPATCHER_REGIONS[0]) drainLeaves.set(lf, (drainLeaves.get(lf) ?? 0) + dt);
  }

  return { totalUs, idleUs, busyUs, bucketUs, offGuestUs, movesUs, keepsUs, byRegion, drainLeaves, outsideLeaves };
}

/**
 * --js-owners: split the "JS HLE + glue" bucket into owners.
 *
 * Two independent cuts of the same self-time, because they answer different questions and a
 * disagreement between them is informative:
 *
 *  (A) BY FILE — every JS self sample belongs to exactly one source file, so this sums to the
 *      bucket with no inclusive-time double counting. This is the owner list.
 *  (B) BY DISPATCHER REGION — for each JS self sample, whether it sits under drainWriteBuffer
 *      (the Tier-0 ring drain, which runs BEFORE the thunk timer is started), under
 *      handlePortWrite but outside the drain, or outside the boundary entirely. This is the
 *      timed-versus-untimed split that `perfStats` structurally cannot see, so it is what
 *      reconciles the frame profiler's `thunk` category against this bucket.
 *
 * The unattributed remainder is printed with its own top leaves rather than left as a
 * residual: a bucket that cannot name its tail is the thing this file exists to prevent.
 */
function reportJsOwners(analysis: ThreadAnalysis): void {
  const total = analysis.totalUs;
  if (total === 0) {
    console.log(`JS OWNERS: no sampled time on ${analysis.name} — nothing to split.`);
    return;
  }
  const census = computeDeferrable(analysis);
  const { idleUs, busyUs: busy, bucketUs } = census;
  const isJsBucket = (n: RawNode) => optBucket(n.callFrame) === "JS HLE + glue";
  if (bucketUs === 0) {
    console.log(`JS OWNERS: the "JS HLE + glue" bucket is empty on ${analysis.name} — no owners to name.`);
    return;
  }
  const fileOf = jsOwnerFileOf;

  // ── (A) by file, and within a file by function ──────────────────────────────
  const byFile = new Map<string, number>();
  const byFileFn = new Map<string, Map<string, number>>();
  for (const ns of analysis.nodes) {
    if (!isJsBucket(ns.node) || ns.selfUs <= 0) continue;
    const file = fileOf(ns.node.callFrame);
    byFile.set(file, (byFile.get(file) ?? 0) + ns.selfUs);
    let fns = byFileFn.get(file);
    if (!fns) { fns = new Map(); byFileFn.set(file, fns); }
    const fn = ns.node.callFrame.functionName || "(anonymous)";
    fns.set(fn, (fns.get(fn) ?? 0) + ns.selfUs);
  }

  console.log(sep());
  console.log(`JS OWNERS — the "JS HLE + glue" bucket split by who owns the code`);
  console.log(sep());
  console.log(`Thread: ${analysis.name}   bucket ${fmtUs(bucketUs)} = ${pct(bucketUs, total)} of thread, ${pct(bucketUs, busy)} of busy`);
  console.log(``);
  console.log(`(A) BY FILE — self time, so these sum to the bucket (no inclusive double counting)`);
  console.log(` ${pad("file", 34)} ${pad("self", 9, true)} ${pad("%thread", 8, true)} ${pad("%busy", 7, true)} ${pad("%bucket", 8, true)}`);
  const files = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  let shown = 0;
  for (const [file, us] of files.slice(0, 14)) {
    shown += us;
    console.log(` ${pad(file, 34)} ${pad(fmtUs(us), 9, true)} ${pad(pct(us, total), 8, true)} ${pad(pct(us, busy), 7, true)} ${pad(pct(us, bucketUs), 8, true)}`);
  }
  if (files.length > 14) {
    const rest = bucketUs - shown;
    console.log(` ${pad(`(${files.length - 14} more files)`, 34)} ${pad(fmtUs(rest), 9, true)} ${pad(pct(rest, total), 8, true)} ${pad(pct(rest, busy), 7, true)} ${pad(pct(rest, bucketUs), 8, true)}`);
  }
  console.log(``);
  console.log(`    top functions inside the three largest files:`);
  for (const [file] of files.slice(0, 3)) {
    const fns = [...(byFileFn.get(file) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`    ${file}: ${fns.map(([n, u]) => `${n} ${pct(u, total)}`).join("  |  ")}`);
  }

  // ── (B) by dispatcher region ────────────────────────────────────────────────
  // Regions, the DEFERRABLE ceiling and the leaf tallies all come from computeDeferrable, so
  // the printed number and the asserted number are the same number.
  const REGIONS = DISPATCHER_REGIONS;
  const { byRegion, outsideLeaves, drainLeaves, offGuestUs } = census;

  console.log(``);
  console.log(`(B) BY DISPATCHER REGION — where in the boundary the work sits.`);
  console.log(`    The Tier-0 ring drain runs BEFORE the thunk timer is armed, so everything`);
  console.log(`    under it is invisible to the frame profiler's 'thunk' category by construction.`);
  console.log(` ${pad("region", 42)} ${pad("self", 9, true)} ${pad("%thread", 8, true)} ${pad("%bucket", 8, true)}`);
  for (const r of REGIONS) {
    const us = byRegion.get(r) ?? 0;
    console.log(` ${pad(r, 42)} ${pad(fmtUs(us), 9, true)} ${pad(pct(us, total), 8, true)} ${pad(pct(us, bucketUs), 8, true)}`);
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${pct(v, total)}`).join("\n      ");
  console.log(``);
  console.log(`    DEFERRABLE — runs on the guest thread, owes the guest no synchronous answer`);
  console.log(`    (the ring drain + the executor's frame walk, assuming perfect overlap and no fence)`);
  // BOTH denominators, always, on one line: "% of thread" includes idle and "% of busy" does
  // not, so a figure quoted without saying which one is unusable — and the gap between them is
  // exactly the idle share, printed here so it needs no second run to recover.
  console.log(`      ${fmtUs(offGuestUs)}  ${pct(offGuestUs, total)} of thread (incl. idle)  ` +
    `${pct(offGuestUs, busy)} of busy  ${pct(offGuestUs, bucketUs)} of the JS bucket`);
  // Deferrable is not the same question as movable, and the two answers differ by 3-5x. A
  // placement plan is costed against MOVES alone; quoting the union overstates its own scope.
  const { movesUs, keepsUs } = census;
  console.log(`      of which, split by side of a render-worker boundary:`);
  console.log(`        MOVES ${fmtUs(movesUs)}  ${pct(movesUs, total)} of thread  ${pct(movesUs, busy)} of busy` +
    `   — executor, backend, postfx, presenter`);
  console.log(`        KEEPS ${fmtUs(keepsUs)}  ${pct(keepsUs, total)} of thread  ${pct(keepsUs, busy)} of busy` +
    `   — recorder + shadow state, stays with the guest`);
  console.log(`      MOVES is the ceiling for a placement change; the union above is not.`);
  console.log(`      idle on this thread: ${fmtUs(idleUs)} = ${pct(idleUs, total)} of thread ` +
    `(the whole difference between the two denominators above)`);
  console.log(``);
  console.log(`    leaves OUTSIDE the boundary (the part no thunk timer could ever reach):`);
  console.log(`      ${top(outsideLeaves) || "(none)"}`);
  console.log(``);
  console.log(`    leaves under the drain:`);
  console.log(`      ${top(drainLeaves) || "(none)"}`);

  // ── What would moving the boundary into Rust actually remove? ────────────────────────────
  //
  // "61% of our JS runs under drainWriteBuffer" is true and says nothing about where that time
  // goes: the ring carries DRAWS as well as setters, so the whole per-draw D3D9 path is under it
  // too. The architectural question — relocate the boundary, or remove redundant work — turns on
  // splitting the region into the RING MACHINERY (dispatch, decode, shadow slots: cost that a
  // Rust-resident ingest deletes) and everything it dispatches TO (payload, which still has to
  // run somewhere, in some language).
  //
  // The machinery list is spelled out and PRINTED rather than inferred, because a classifier
  // nobody can audit is how a plausible number gets attributed to the wrong cause. Everything
  // not on the list is payload by default — the conservative direction for the claim being made,
  // since it makes the relocatable share SMALLER.
  const RING_MACHINERY = new Set([
    "drainWriteBuffer", "handlePortWrite", "_handlePortWriteSlow", "writeShadowSlot",
    "tryResetWbufHead", "write32", "io_port_write32", "readShadowSlot", "wbufDecode",
  ]);
  let machineryUs = 0, payloadUs = 0;
  const machineryLeaves = new Map<string, number>();
  for (const [lf, us] of drainLeaves) {
    const fn = lf.split(" @ ")[0] ?? "";
    if (RING_MACHINERY.has(fn)) { machineryUs += us; machineryLeaves.set(lf, us); }
    else payloadUs += us;
  }
  const drainUs = byRegion.get(REGIONS[0]) ?? 0;
  console.log(``);
  console.log(`    THE DRAIN REGION SPLIT — ring machinery vs what it dispatches to`);
  console.log(`    machinery names counted: ${[...RING_MACHINERY].join(", ")}`);
  console.log(` ${pad("", 42)} ${pad("self", 9, true)} ${pad("%thread", 8, true)} ${pad("%drain", 8, true)}`);
  console.log(` ${pad("ring machinery (relocatable)", 42)} ${pad(fmtUs(machineryUs), 9, true)} ${pad(pct(machineryUs, total), 8, true)} ${pad(pct(machineryUs, drainUs), 8, true)}`);
  console.log(` ${pad("payload it dispatches to", 42)} ${pad(fmtUs(payloadUs), 9, true)} ${pad(pct(payloadUs, total), 8, true)} ${pad(pct(payloadUs, drainUs), 8, true)}`);
  if (machineryLeaves.size) {
    console.log(`    machinery leaves actually seen:`);
    for (const [lf, us] of [...machineryLeaves.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${lf} ${pct(us, total)}`);
    }
  }
  // The full payload list to a coverage floor, so the reader can classify it themselves rather
  // than trust the four names that fit in a summary.
  const payloadSorted = [...drainLeaves.entries()].filter(([lf]) => !RING_MACHINERY.has(lf.split(" @ ")[0] ?? ""))
    .sort((a, b) => b[1] - a[1]);
  let acc = 0;
  console.log(`    payload leaves (to 90% of payload):`);
  for (const [lf, us] of payloadSorted) {
    if (acc >= payloadUs * 0.9) { break; }
    acc += us;
    console.log(`      ${pad(lf, 56)} ${pad(pct(us, total), 8, true)} ${pad(pct(us, drainUs), 8, true)}`);
  }
  console.log(`      (${payloadSorted.length} payload leaves in total)`);
}

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

  // Run-length histogram, counted BOTH ways. The count answers "how many attribution
  // failures were there", the time answers "how much of the idle bucket is this" — and a
  // verdict on the first is a verdict about a population that can hold a minority of the
  // time. Only the second shares a denominator with every ceiling normalised to busy.
  type Bkt = "1" | "2-5" | "6-15" | "16-40" | "41+";
  const BKTS: Bkt[] = ["1", "2-5", "6-15", "16-40", "41+"];
  const bktOf = (len: number): Bkt =>
    len === 1 ? "1" : len <= 5 ? "2-5" : len <= 15 ? "6-15" : len <= 40 ? "16-40" : "41+";
  const runsBy: Record<Bkt, number> = { "1": 0, "2-5": 0, "6-15": 0, "16-40": 0, "41+": 0 };
  const usBy: Record<Bkt, number> = { "1": 0, "2-5": 0, "6-15": 0, "16-40": 0, "41+": 0 };
  // Before/after attribution kept separately for short (<=5 samples) and long (>=6) runs:
  // the thousands of short attribution failures otherwise bury the few hundred runs that
  // carry the time, which is the question being asked.
  const beforeShort = new Map<string, number>();
  const afterShort = new Map<string, number>();
  const beforeLong = new Map<string, number>();
  const afterLong = new Map<string, number>();
  const longRunUs: number[] = [];
  let runs = 0, idleSamples = 0, idleUs = 0, i = 0;
  while (i < names.length) {
    if (isIdle(names[i]!)) {
      let j = i;
      let runUs = 0;
      while (j < names.length && isIdle(names[j]!)) { runUs += profile.timeDeltas[j] ?? 0; j++; }
      const len = j - i;
      const b = bktOf(len);
      runs++; idleSamples += len; idleUs += runUs;
      runsBy[b]++; usBy[b] += runUs;
      const bn = i > 0 ? names[i - 1]! : "<start>";
      const an = j < names.length ? names[j]! : "<end>";
      if (len >= 6) {
        beforeLong.set(bn, (beforeLong.get(bn) ?? 0) + 1);
        afterLong.set(an, (afterLong.get(an) ?? 0) + 1);
        longRunUs.push(runUs);
      } else {
        beforeShort.set(bn, (beforeShort.get(bn) ?? 0) + 1);
        afterShort.set(an, (afterShort.get(an) ?? 0) + 1);
      }
      i = j;
    } else i++;
  }
  const avgIntervalUs = profile.timeDeltas.length ? total / profile.timeDeltas.length : 0;
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => v + "x " + k).join("  |  ");

  const gpuIoRe = /writeBuffer|submit|Present|Flip|Blt|readback|Atomics|__wait|WaitFor/i;
  const gpuIoRuns = [...beforeShort.entries(), ...beforeLong.entries()]
    .filter(([k]) => gpuIoRe.test(k)).reduce((a, [, v]) => a + v, 0);
  const gpuIoLongRuns = [...beforeLong.entries()].filter(([k]) => gpuIoRe.test(k)).reduce((a, [, v]) => a + v, 0);

  const longUs = usBy["6-15"] + usBy["16-40"] + usBy["41+"];
  const longRuns = runsBy["6-15"] + runsBy["16-40"] + runsBy["41+"];
  const tinyRunFrac = runs ? (runsBy["1"] + runsBy["2-5"]) / runs : 0;
  const tinyTimeFrac = idleUs ? (usBy["1"] + usBy["2-5"]) / idleUs : 0;
  const longTimeFrac = idleUs ? longUs / idleUs : 0;

  console.log(sep());
  console.log(`IDLE-SHAPE — is the "idle" bucket real wait or WASM/JIT sampling noise?`);
  console.log(sep());
  console.log(`Thread: ${label}`);
  console.log(`idle-family self-time: ${[...fam.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${pct(v, total)}`).join("  ")}`);
  console.log(`avg sample interval: ${Math.round(avgIntervalUs)}us   idle runs: ${num(runs)}  (${num(idleSamples)} samples, ${fmtUs(idleUs)} = ${pct(idleUs, total)} of thread)`);
  console.log(``);
  console.log(`Run-length distribution — BY COUNT and BY TIME (the two disagree; time is the one`);
  console.log(`that shares a denominator with every ceiling normalised to busy):`);
  console.log(` ${pad("run len", 10)} ${pad("runs", 8, true)} ${pad("%runs", 7, true)} ${pad("time", 9, true)} ${pad("%idle", 7, true)} ${pad("%thread", 8, true)} ${pad("avg run", 9, true)}`);
  for (const b of BKTS) {
    if (runsBy[b] === 0) continue;
    const avgRunMs = runsBy[b] ? usBy[b] / runsBy[b] / 1000 : 0;
    console.log(
      ` ${pad(b, 10)} ${pad(num(runsBy[b]), 8, true)} ${pad(pct(runsBy[b], runs), 7, true)} ` +
      `${pad(fmtUs(usBy[b]), 9, true)} ${pad(pct(usBy[b], idleUs), 7, true)} ${pad(pct(usBy[b], total), 8, true)} ` +
      `${pad(avgRunMs.toFixed(2) + "ms", 9, true)}`
    );
  }
  if (longRunUs.length) {
    const s = [...longRunUs].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    console.log(` long runs (>=6 samples): p50 ${(q(0.5) / 1000).toFixed(2)}ms  p90 ${(q(0.9) / 1000).toFixed(2)}ms  max ${(s[s.length - 1]! / 1000).toFixed(2)}ms`);
  }
  console.log(``);
  console.log(`  SHORT runs (1-5 samples, ${pct(usBy["1"] + usBy["2-5"], idleUs)} of idle time):`);
  console.log(`    BEFORE: ${top(beforeShort)}`);
  console.log(`    AFTER : ${top(afterShort)}`);
  console.log(`  LONG runs (>=6 samples, ${pct(longUs, idleUs)} of idle time) — these carry the wait, if any:`);
  console.log(`    BEFORE: ${top(beforeLong) || "(none)"}`);
  console.log(`    AFTER : ${top(afterLong) || "(none)"}`);
  console.log(``);
  // The verdict is taken on TIME. A population of short attribution failures can be 90% of
  // runs while holding a minority of the bucket, and calling the bucket "noise" on that
  // basis writes off wait that every ceiling is normalised against.
  const minorWait = gpuIoRuns > 0
    ? ` (${gpuIoRuns} run${gpuIoRuns === 1 ? "" : "s"} bracketed by GPU/IO/Atomics, ${gpuIoLongRuns} of them long)`
    : "";
  console.log(`By COUNT: ${(tinyRunFrac * 100).toFixed(0)}% of runs are 1-5 samples.`);
  console.log(`By TIME : ${(tinyTimeFrac * 100).toFixed(0)}% of idle time is in those runs; ` +
    `${(longTimeFrac * 100).toFixed(0)}% (${fmtUs(longUs)}, ${pct(longUs, total)} of the thread) is in runs of 6+.`);
  if (longTimeFrac < 0.15) {
    console.log(`VERDICT: idle is dominated BY TIME by 1-5-sample runs bracketed by WASM/JIT frames`);
    console.log(`  -> V8 sampling NOISE around v86's dynarec, NOT reclaimable slack.${minorWait}`);
    console.log(`  Do not plan async-present/readback to "reclaim" this number.`);
  } else {
    console.log(`VERDICT: ${(longTimeFrac * 100).toFixed(0)}% of idle TIME sits in runs of 6+ samples ` +
      `(avg ${(longUs / Math.max(1, longRuns) / 1000).toFixed(2)}ms, up to ${(longRunUs.reduce((m, v) => (v > m ? v : m), 0) / 1000).toFixed(1)}ms).`);
    console.log(`  A JIT-boundary attribution failure is 1-2 samples; runs this long are NOT that shape.`);
    console.log(`  -> Treat this fraction as POSSIBLY REAL WAIT until an in-worker timestamp bracket`);
    console.log(`     around submit/readback/Atomics says otherwise. Read the LONG-run BEFORE/AFTER`);
    console.log(`     attribution above: it names what the thread was doing on either side.${minorWait}`);
    console.log(`  Every ceiling normalised to "busy" moves by this much if it is wait.`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage:");
    console.log("  bun tools/analyze-trace.ts <file>                    # basic analysis");
    console.log("  bun tools/analyze-trace.ts <file> --top 50           # more functions");
    console.log("  bun tools/analyze-trace.ts <file> --thread worker    # worker only");
    console.log("  bun tools/analyze-trace.ts <file> --js-owners       # split the JS bucket by owning file + dispatcher region");
    console.log("  bun tools/analyze-trace.ts <file> --proxy            # fold v86 view() Proxy traps into their callers");
    console.log("  bun tools/analyze-trace.ts <file> --range 0-7s       # slice profile to time window");
    console.log("  bun tools/analyze-trace.ts <file> --budget-ms 33.34  # judge frames against the title's cadence");
    console.log("  bun tools/analyze-trace.ts <file> --map blocks.json  # annotate wasm-function[N] with guest addr");
    console.log("  bun tools/analyze-trace.ts <file> --no-auto-map      # skip hot-block sidecar discovery");
    console.log("");
    console.log("--proxy reports the share of worker time spent in v86's view() Proxy get/set/resolve, attributed to");
    console.log("the nearest caller outside v86's own JS. That share is measured from stack frames, not FPS, so it is");
    console.log("the scene-independent oracle for a Proxy-removal A/B.");
    console.log("--range accepts: A-Bs (seconds) or Ams-Bms (milliseconds). Times are relative to profile start.");
    console.log("--map expects JSON produced by worker-side dumpHotJitBlocks() (array of {wasm_fn, phys_addr, module}).");
    console.log("Traces with embedded bottleship.hotblocks marks are annotated automatically without --map.");
    console.log("Traces with bottleship.flip marks report FPS, inter-frame p50/p95/p99 (same shared definition as the");
    console.log("harness frameReport verb), frames over budget, and a WORST FRAMES table with per-frame stack attribution.");
    console.log("Flip marks are reported PER EMITTING THREAD on one budget — never merged into a single series — and");
    console.log("cross-checked against the guest-side present count (a bottleship.present.ledger mark, or a serial on");
    console.log("the flip marks): a thread that misses presents diverges loudly instead of printing a plausible p50.");
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

  // Frames belong to the thread that emitted the mark; the series are built once, per thread,
  // on the presenting thread's budget, and everything downstream reads them from here.
  const flipSeries = buildFlipSeries(events, threadNames, budgetMs);
  let presenterSeries: FlipSeries | null = flipSeries[0] ?? null;
  let renderFrames = presenterSeries?.analysis ?? null;

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
  //
  // The window base is the PRESENTING thread's profile clock, not whichever profile the Map
  // happened to hold first: with more than one worker those clocks are different starts, and a
  // window taken against an unrelated one is a plausible number for the wrong interval.
  // One window clock for the whole report: --range, the harness join seam (which PRINTS a
  // --range to paste back) and the timeline buckets must agree, or the seam recommends a window
  // the slicer then reads against a different start.
  const windowClock = (() => {
    const presenterProfile = presenterSeries ? profiles.get(presenterSeries.key) : undefined;
    if (presenterProfile && Number.isFinite(presenterProfile.startTs)) {
      return { base: presenterProfile.startTs, source: `presenting thread ${presenterSeries!.label} (tid ${presenterSeries!.tid})` };
    }
    const starts = Array.from(profiles.values()).map(pr => pr.startTs).filter(t => Number.isFinite(t));
    return starts.length > 0
      ? { base: Math.min(...starts), source: "earliest profile start (the presenting thread has no profile in this trace)" }
      : { base: undefined as number | undefined, source: "no profile in this trace" };
  })();

  if (range && flipSeries.length > 0) {
    const baseSource = windowClock.source;
    const base = windowClock.base;
    if (base !== undefined) {
      const lo = base + range.startUs;
      const hi = base + range.endUs;
      console.log(`[analyze-trace] --range window taken against ${baseSource}`);
      for (const s of flipSeries) {
        // The real count of marks INSIDE the window: intervals+1 is a fabricated count that
        // silently invents a mark whenever the window clips the series.
        s.marks = s.marks.filter(m => m.tsUs >= lo && m.tsUs < hi);
      }
      flipSeries.sort((a, b) => b.marks.length - a.marks.length || a.key.localeCompare(b.key));
      presenterSeries = flipSeries[0] ?? null;
      const scopedBudget = budgetMs ?? renderFrames?.budgetMs;
      for (const s of flipSeries) {
        s.analysis = analysisFromMarks(s.marks, scopedBudget, { key: s.key, label: s.label, scopedTo: range.raw });
      }
      renderFrames = presenterSeries?.analysis ?? null;
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

  const jsOwners = args.includes("--js-owners");
  const proxyRollup = args.includes("--proxy");
  for (const a of workerThreads) {
    if (!shouldShow(a)) continue;
    console.log(reportThread(a, topN, `WORKER THREAD (${a.name})`, true));
    console.log(reportWasm(a, topN));
    console.log(reportOptimizationBuckets(a));
    if (jsOwners) reportJsOwners(a);
    if (proxyRollup) console.log(reportProxyRollup(a));
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

  const renderFrameReport = reportRenderFrames(flipSeries);
  if (renderFrameReport) {
    console.log(renderFrameReport);
  }
  if (flipSeries.length > 0) {
    console.log(reportFlipLedger(computeFlipLedger(flipSeries, extractPresentLedger(events))));
  }

  // Stack attribution belongs to the thread that PRESENTED the frame. Taking it from
  // "the busiest worker" attributes a render worker's frame to the guest worker's stacks and
  // says nothing about it; when that thread has no profile the reason is printed instead.
  const presenterProfileForAttribution = presenterSeries ? (profiles.get(presenterSeries.key) ?? null) : null;
  if (presenterSeries && !presenterProfileForAttribution) {
    console.log(`
[analyze-trace] WORST FRAMES / TAIL COMPOSITION unavailable: the presenting thread `
      + `${presenterSeries.label} (tid ${presenterSeries.tid}) emitted flip marks but has no CPU profile in this trace. `
      + `Attributing its frames to another thread's stacks would be a plausible answer to a different question.`);
  }
  const worstFrameReport = reportWorstFrames(renderFrames, presenterProfileForAttribution, 10);
  if (worstFrameReport) {
    console.log(worstFrameReport);
  }

  const tailCompReport = reportTailComposition(renderFrames, presenterProfileForAttribution);
  if (tailCompReport) {
    console.log(tailCompReport);
  }

  // The join seam: a live `frameReport({reset:true})` publishes its window as UserTiming
  // marks, so a trace taken across it can be sliced to exactly that window.
  if (perfWindow) {
    const base = windowClock.base;
    const rel = (ts: number) => (Number.isFinite(base) ? `${((ts - (base as number)) / 1_000_000).toFixed(2)}s` : `${(ts / 1000).toFixed(0)}ms(abs)`);
    console.log(`\n${sep("═")}`);
    console.log(`HARNESS PERF WINDOW (join seam)`);
    console.log(sep("═"));
    console.log(`  clock: ${windowClock.source} — the same base --range slices against.`);
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

  // ── GPU process (its own section: CPU-in-GPU-process and hardware are different claims) ──
  // Frames come from the app's own flip marks so "ms/frame" here means the same thing it means
  // everywhere else in this report; 0 when the trace has none, and the section says "n/a"
  // rather than dividing by a guess.
  //
  // --range must scope this section too, the same way it scopes the frame tail above: the GPU
  // process is a separate Chrome process with its own timeline, but its event `ts` shares the
  // trace's absolute clock, so the same base+range window applies. Unscoped here would silently
  // report a whole-trace GPU average next to range-scoped CPU numbers in the same output.
  let gpuEvents = events;
  if (range) {
    // Same base as the frame window above, for the same reason.
    const presenterProfile = presenterSeries ? profiles.get(presenterSeries.key) : undefined;
    const starts = Array.from(profiles.values()).map(pr => pr.startTs).filter(t => Number.isFinite(t));
    const base = presenterProfile && Number.isFinite(presenterProfile.startTs)
      ? presenterProfile.startTs
      : (starts.length > 0 ? Math.min(...starts) : undefined);
    if (base !== undefined) {
      const lo = base + range.startUs;
      const hi = base + range.endUs;
      gpuEvents = events.filter((ev) => ev.ts + (ev.dur ?? 0) >= lo && ev.ts < hi);
    }
  }
  // Frames for "GPU ms/frame" are the PRESENTING thread's marks only: counting every thread's
  // marks halves the figure the moment a second thread presents, with nothing to show for it.
  const framesForGpu = presenterSeries
    ? gpuEvents.filter(ev => ev.name === FLIP_MARK && `${ev.pid}:${ev.tid}` === presenterSeries!.key).length
    : 0;
  console.log(reportGpuProcess(gpuEvents, threadNames, framesForGpu, range?.raw));

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
