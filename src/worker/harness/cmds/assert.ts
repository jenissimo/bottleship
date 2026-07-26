/**
 * Assertion verbs — turn a *driver* into a self-judging *test harness*.
 * Each throws a HarnessError on failure, which the DSL surfaces as a chain abort
 * + auto fault snapshot (facade.__runSteps). (expectSurfaceNonBlack lives in
 * textures.ts next to the readback it uses.)
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, serializeThreads } from "../serialize";
import { findDlgControl, describeDlgControl } from "../dlg";
import { wmTraceEntries, formatWmTraceEntry, type WmTraceEntry } from "./wm-trace";

/** One expectMessages pattern: NAME[@x,y] [vk=<n>] [repeat]. */
interface MsgPattern {
    src: string;
    name: string;
    x?: number;
    y?: number;
    vk?: number;
    repeat?: boolean;
}

function parseMsgPattern(src: string): MsgPattern {
    const [head, ...rest] = src.trim().split(/\s+/);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:@(-?\d+),(-?\d+))?$/.exec(head ?? "");
    if (!m) throw new HarnessError(`expectMessages: bad pattern '${src}'`, HarnessErrorCode.BAD_ARGS);
    const p: MsgPattern = { src, name: m[1] };
    if (m[2] !== undefined) { p.x = Number(m[2]); p.y = Number(m[3]); }
    for (const tok of rest) {
        if (tok === "repeat") { p.repeat = true; continue; }
        const kv = /^vk=(0x[0-9a-fA-F]+|\d+)$/.exec(tok);
        if (!kv) throw new HarnessError(`expectMessages: bad qualifier '${tok}' in '${src}'`, HarnessErrorCode.BAD_ARGS);
        p.vk = Number(kv[1]);
        continue;
    }
    return p;
}

function matchesMsg(p: MsgPattern, e: WmTraceEntry): boolean {
    if (p.name !== e.name) return false;
    if (p.x !== undefined && (e.x !== p.x || e.y !== p.y)) return false;
    if (p.vk !== undefined && (e.wParam & 0xff) !== (p.vk & 0xff)) return false;
    // lParam bit 30 = previous key state (set on an auto-repeat WM_KEYDOWN).
    if (p.repeat !== undefined && (((e.lParam >>> 30) & 1) === 1) !== p.repeat) return false;
    return true;
}

export function registerAssertCommands(svc: HarnessService): void {
    /** expectDialog(title) — a window whose title contains `title` must exist. */
    svc.register("expectDialog", (args) => {
        const title = String(args[0] ?? "");
        const found = findDlgControl(title);
        if (!found) throw new HarnessError(`expectDialog: no window/control matching '${title}'`, HarnessErrorCode.NOT_FOUND);
        return { ok: true, ...describeDlgControl(found.hwnd, found.win) };
    });

    /** expectThread({state?, eip?}) — at least one thread must match. */
    svc.register("expectThread", (args) => {
        const opts = (args[0] ?? {}) as { state?: string; eip?: number };
        const snap = serializeThreads() as any;
        const threads: any[] = snap?.threads ?? [];
        const match = threads.find((t) =>
            (opts.state === undefined || String(t.stateName).toUpperCase() === String(opts.state).toUpperCase()) &&
            (opts.eip === undefined || (t.eip >>> 0) === (opts.eip >>> 0)),
        );
        if (!match) throw new HarnessError(`expectThread: no thread matching ${JSON.stringify(opts)}`, HarnessErrorCode.NOT_FOUND);
        return { ok: true, thread: match };
    });

    /** expectFileExists(path) — the VFS must have a file/dir at `path`.
     *  NOTE: getFileSize returns 0 (not -1) for a missing file, so we probe
     *  existence with a read-only openSync (null = not found) — distinguishing a
     *  genuine 0-byte file from an absent one (the 0-byte-save bug class). */
    svc.register("expectFileExists", (args) => {
        const path = String(args[0] ?? "");
        const fsx: any = sys().fileSystem as any;
        if (!fsx) throw new HarnessError("no filesystem", HarnessErrorCode.NO_PROCESS);
        const isDir = fsx.directoryExists(path);
        const handle = isDir ? null : fsx.openSync(path, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
        if (!handle && !isDir) throw new HarnessError(`expectFileExists: '${path}' not found`, HarnessErrorCode.NOT_FOUND);
        return { ok: true, path, size: handle ? fsx.getFileSize(path) : null, isDir, source: handle?.source ?? null };
    });

    /** expectMessages(patterns[]) — the wmTrace ring must contain the patterns as an
     *  ordered SUBSEQUENCE (gaps allowed; a real click is interleaved with
     *  WM_SETCURSOR/paint traffic, so adjacency would be untestable). */
    svc.register("expectMessages", (args) => {
        const raw = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
        const patterns = raw.map((p) => parseMsgPattern(String(p)));
        if (patterns.length === 0) throw new HarnessError("expectMessages: no patterns", HarnessErrorCode.BAD_ARGS);

        const entries = wmTraceEntries();
        let pi = 0;
        const matchedAt: number[] = [];
        for (let ei = 0; ei < entries.length && pi < patterns.length; ei++) {
            if (matchesMsg(patterns[pi], entries[ei])) { matchedAt.push(ei); pi++; }
        }
        if (pi < patterns.length) {
            // A bare "assertion failed" is useless here — the ring IS the evidence.
            const tail = entries.slice(-40).map(formatWmTraceEntry);
            throw new HarnessError(
                `expectMessages: matched ${pi}/${patterns.length}, stuck on '${patterns[pi].src}'` +
                ` (${entries.length} traced${entries.length === 0 ? " — did you call wmTrace('start')?" : ""})\n` +
                `ring tail:\n  ${tail.join("\n  ")}`,
                HarnessErrorCode.NOT_FOUND,
            );
        }
        return { ok: true, matched: patterns.map((p, i) => ({ pattern: p.src, at: matchedAt[i] })), traced: entries.length };
    });
}
