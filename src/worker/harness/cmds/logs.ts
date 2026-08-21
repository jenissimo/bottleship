/**
 * Log streaming/inspection harness verbs. streamLogs mirrors the
 * existing log_stream_enable worker handler (Logger.setStreamCallback ->
 * log_stream_batch -> page -> log-server), but as an RPC that returns {ok}.
 * logs() returns recent in-memory entries as POJOs (category as a name string).
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { Logger, LogCategory, LogLevel } from "../../core/logger";
import { TimeService } from "../../runtime/time";
import { logHub } from "../log-hub";

/** Collapse a log line to a template by erasing volatile tokens (addresses,
 *  numbers) so "WriteFile slow 30" and "WriteFile slow 31" dedup to one row.
 *  This is the firehose→summary lever: 2 MB/s of repetitive spam becomes a
 *  ranked count of distinct message shapes. */
function normalizeTemplate(msg: string): string {
    return msg
        .replace(/0x[0-9a-fA-F]+/g, "0x?")
        .replace(/\b\d+\b/g, "#")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

/** Named virtual-time markers for logsSince (multi-session windowing). */
const logMarks = new Map<string, number>();

function toCategoryEnums(names?: string[]): LogCategory[] | undefined {
    if (!names || !names.length) return undefined;
    return names
        .map((c) => (LogCategory as any)[c.toUpperCase()])
        .filter((v) => v !== undefined) as LogCategory[];
}

const categoryName = (c: LogCategory): string => (LogCategory as any)[c] ?? String(c);

export function registerLogCommands(svc: HarnessService): void {
    svc.register("streamLogs", (args) => {
        const categories = toCategoryEnums(args[0] as string[] | undefined);
        Logger.setStreamCallback((batch) => {
            (self as unknown as Worker).postMessage({
                type: "log_stream_batch",
                entries: batch.map((e) => ({ timestamp: e.timestamp, category: categoryName(e.category), level: e.level, message: e.message })),
            });
        }, categories);
        return { ok: true, categories: (args[0] as string[] | undefined) ?? "ALL" };
    });

    svc.register("stopLogs", () => {
        Logger.setStreamCallback(null);
        return { ok: true };
    });

    /**
     * logRing(size) — resize the in-memory log ring (default 50).
     *
     * The post-mortem workflow is "reproduce, then read the log tail that led to
     * the fault", but 50 entries is a fraction of one boot's SYSTEM chatter, so
     * the interesting lines are gone before `logs()` runs. Widen it BEFORE the
     * repro. Resizing drops the current contents (the ring is reallocated).
     *
     * A page reload resets it, so the boot that FOLLOWS a re-exec cannot be armed this
     * way at all — for that window use the persisted flag, which the host replays before
     * any bundle loads: `dbgFlag('__logRingSize', 100000, {scope:'session'})`.
     */
    svc.register("logRing", (args) => {
        const size = typeof args[0] === "number" ? Math.max(50, Math.min(200000, args[0] as number)) : 50;
        Logger.setBufferSize(size);
        return { size };
    });

    /** logLevel(category, level) — per-category verbosity, or reset with no args.
     *  The ring holds a fixed number of ENTRIES, so a per-frame firehose category
     *  overwrites init-time evidence long before a late crash fires. Lowering that
     *  category keeps it out of the ring (and off the console); streaming and the log
     *  hub still see it, so the durable archive loses nothing.
     *  Level: SILENT|ERROR|WARN|NORMAL|VERBOSE (or a number). */
    svc.register("logLevel", (args) => {
        if (args.length === 0) {
            Logger.resetCategoryLevels();
            return { reset: true };
        }
        const catName = String(args[0] ?? "").toUpperCase();
        const category = (LogCategory as any)[catName];
        if (category === undefined) {
            throw new HarnessError(`logLevel: unknown category '${args[0]}'`, HarnessErrorCode.BAD_ARGS);
        }
        const raw = args[1];
        // A numeric enum has reverse mappings, so LogLevel["0"] is the STRING "SILENT" —
        // accepting it would set a level nothing compares correctly against.
        const level = typeof raw === "number" ? raw : (LogLevel as any)[String(raw ?? "").toUpperCase()];
        if (typeof level !== "number" || !(level in LogLevel)) {
            throw new HarnessError(`logLevel: unknown level '${raw}'`, HarnessErrorCode.BAD_ARGS);
        }
        Logger.setCategoryLevel(category, level);
        return { category: catName, level };
    });

    svc.register("logs", (args) => {
        const count = typeof args[0] === "number" ? (args[0] as number) : 200;
        const filter = typeof args[1] === "string" ? (args[1] as string).toLowerCase() : null;
        let entries = Logger.getRecentEntries(count).map((e) => ({
            timestamp: e.timestamp,
            category: categoryName(e.category),
            level: e.level,
            message: e.message,
        }));
        if (filter) entries = entries.filter((e) => e.message.toLowerCase().includes(filter) || e.category.toLowerCase().includes(filter));
        return entries;
    });

    /**
     * logStats({count?, top?}) — the firehose→summary collapse. Aggregates the
     * recent ring by message TEMPLATE (addresses/numbers erased) so repetitive
     * spam (the same unimplemented stub called 10000×) becomes one ranked row.
     * Surfaces the high-signal classes (errors/warns/unimplemented/unknown-args)
     * a multi-session debugger actually cares about — read this instead of
     * grepping a 2 MB file.
     */
    svc.register("logStats", (args) => {
        const count = typeof args[0] === "number" ? (args[0] as number) : 8000;
        const top = typeof args[1] === "number" ? (args[1] as number) : 30;
        const entries = Logger.getRecentEntries(count);
        const templates = new Map<string, { count: number; category: string; level: string; sample: string }>();
        const levelHist: Record<string, number> = {};
        let unimplemented = 0, unknownArgs = 0;
        for (const e of entries) {
            const t = normalizeTemplate(e.message);
            const cur = templates.get(t) ?? { count: 0, category: categoryName(e.category), level: LogLevel[e.level] ?? String(e.level), sample: e.message };
            cur.count++;
            templates.set(t, cur);
            const lvl = LogLevel[e.level] ?? String(e.level);
            levelHist[lvl] = (levelHist[lvl] ?? 0) + 1;
            const m = e.message.toLowerCase();
            if (m.includes("unimplemented") || m.includes("not implemented") || m.includes("stub")) unimplemented++;
            if (m.includes("unknown arg") || m.includes("arg count") || m.includes("argcount")) unknownArgs++;
        }
        const ranked = [...templates.entries()]
            .map(([template, v]) => ({ template, ...v }))
            .sort((a, b) => b.count - a.count)
            .slice(0, top);
        return { scanned: entries.length, distinct: templates.size, levelHist, unimplemented, unknownArgs, top: ranked };
    });

    /** markLog(label) — drop a virtual-time marker for logsSince windowing. */
    svc.register("markLog", (args) => {
        const label = String(args[0] ?? "mark");
        const ts = TimeService.getInstance().nowMs();
        logMarks.set(label, ts);
        return { label, ts };
    });

    /**
     * logsSince(label, {filter?, count?}) — entries since a markLog (the
     * "what happened between the click and the freeze" lens). Bounded by the
     * ring: if the firehose overflowed it since the mark, older entries are gone.
     */
    svc.register("logsSince", (args) => {
        const label = String(args[0] ?? "mark");
        const ts = logMarks.get(label);
        if (ts === undefined) throw new HarnessError(`no log mark '${label}' (call markLog first)`, HarnessErrorCode.NOT_FOUND);
        const opts = (args[1] ?? {}) as { filter?: string; count?: number };
        const filter = opts.filter?.toLowerCase();
        let entries = Logger.getRecentEntries(opts.count ?? 0)
            .filter((e) => e.timestamp >= ts)
            .map((e) => ({ timestamp: e.timestamp, category: categoryName(e.category), level: e.level, message: e.message }));
        if (filter) entries = entries.filter((e) => e.message.toLowerCase().includes(filter) || e.category.toLowerCase().includes(filter));
        return { since: ts, sinceLabel: label, count: entries.length, entries };
    });

    /**
     * watchLog(pattern, {once?}) — subscribe to a high-signal log pattern. Emits a
     * `logMatch` event the moment a matching line appears (live tap, zero-cost when
     * no watchers) — the inverse of streaming the firehose and grepping. Pair with
     * waitForEvent('logMatch') to block until "the error" / "the unimplemented stub"
     * shows up.
     */
    svc.register("watchLog", (args, ctx) => {
        const pattern = String(args[0] ?? "");
        if (!pattern) throw new HarnessError("watchLog expects a pattern", HarnessErrorCode.BAD_ARGS);
        const opts = (args[1] ?? {}) as { once?: boolean };
        const id = logHub.watch(pattern, { runId: ctx.runId, once: !!opts.once });
        return { armed: true, id, pattern };
    });
    svc.register("unwatchLog", (args) => { logHub.unwatch(Number(args[0]) | 0); return { ok: true }; });
    svc.register("clearLogWatches", () => ({ cleared: logHub.clearWatches() }));
    svc.register("logWatches", () => logHub.listWatches());

    /** logAgg(on?) — start/stop full-session aggregation (opt-in; per-entry template
     *  dedup costs regex). Off by default. */
    svc.register("logAgg", (args) => {
        const on = args[0] === undefined ? true : !!args[0];
        logHub.setAggregating(on);
        return { aggregating: on };
    });
    /** logAggStats(top?) — full-session aggregated counters (since logAgg(true)). */
    svc.register("logAggStats", (args) => logHub.aggStats(typeof args[0] === "number" ? (args[0] as number) : 30));
}
