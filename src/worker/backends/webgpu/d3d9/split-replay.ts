/**
 * Split D3D9 — the render twin's side of the call stream: decode a recorded call, run it on the
 * twin, and check the twin answered what the front did. Used in-process (the twin next to the
 * front) and by the render worker, which has no dispatcher and no guest memory.
 *
 * Record layout (a WBUF payload entry; the handler's ptr is its first header word):
 *   h0 method index, h1 device slot, h2 reserved, h3 reserved, byte count, then the codec bytes:
 *   [front's comparable answer][argc][args…].
 */

import { SplitDecoder, type SplitRefTable } from "./split-codec";
import type { D3D9Device } from "./d3d9-device";
import { Logger, LogCategory } from "../../../core/logger";

type Fn = (...args: unknown[]) => unknown;

export interface SplitReplayStats {
    replayed: number;
    /** What the twin actually executed, by method: `replayed` alone cannot tell a stream that
     *  delivers every call from one that delivers the same call every time. */
    replayedByMethod: Record<string, number>;
    divergences: Record<string, number>;
    replayErrors: Record<string, number>;
    /** First message per method, for replay errors and divergences. */
    samples: Record<string, string>;
}

export function emptyReplayStats(): SplitReplayStats {
    return { replayed: 0, replayedByMethod: {}, divergences: {}, replayErrors: {}, samples: {} };
}

/** The part of an answer both sides must agree on: HRESULT-shaped fields of result objects,
 *  numbers and booleans as they are. */
export function comparableAnswer(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (ArrayBuffer.isView(v)) return undefined;
    if (typeof (v as Promise<unknown>).then === "function") return undefined;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of ["hr", "handle", "ptr", "pitch"]) if (typeof o[k] === "number") out[k] = o[k];
    return Object.keys(out).length ? out : undefined;
}

export function sameAnswer(a: unknown, b: unknown): boolean {
    if (a === undefined || b === undefined) return true;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
        return a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
    }
    const ka = Object.keys(a as object);
    return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

const noRefs: SplitRefTable = { idOf: () => undefined, twinOf: () => undefined };

export class SplitReplayer {
    /** Method index -> name, as the front numbered them. */
    readonly methodNames: string[] = [];
    readonly twins = new Map<number, D3D9Device>();
    stats: SplitReplayStats = emptyReplayStats();
    /** Async replays (GPU readbacks) not yet settled, and the last answer each method gave. */
    private readonly pending = new Set<Promise<unknown>>();
    readonly lastAsyncAnswer = new Map<string, unknown>();

    /** Resolve once every async replay started so far has settled. */
    async settled(): Promise<void> {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
    }

    replayRecord(m8: Uint8Array, m32: Uint32Array, ptr: number): void {
        const methodIndex = m32[ptr >> 2];
        const name = this.methodNames[methodIndex];
        const twin = this.twins.get(m32[(ptr + 4) >> 2]);
        const len = m32[(ptr + 16) >> 2];
        if (name === undefined || !twin) {
            this.noteError(`#${methodIndex}`, new Error("record names no known method or twin"));
            return;
        }
        let expected: unknown;
        let args: unknown[];
        try {
            const dec = new SplitDecoder(m8, ptr + 20, ptr + 20 + len, noRefs);
            expected = dec.value();
            const argc = dec.value() as number;
            args = new Array(argc);
            for (let i = 0; i < argc; i++) args[i] = dec.value();
        } catch (e) {
            this.noteError(name, e);
            return;
        }
        twin.splitFrontResult = expected;
        let actual: unknown;
        try {
            actual = (twin as unknown as Record<string, Fn>)[name].apply(twin, args);
        } catch (e) {
            this.noteError(name, e);
            return;
        } finally {
            twin.splitFrontResult = undefined;
        }
        this.stats.replayed++;
        this.stats.replayedByMethod[name] = (this.stats.replayedByMethod[name] ?? 0) + 1;
        if (actual !== null && typeof actual === "object" && typeof (actual as Promise<unknown>).then === "function") {
            const settling: Promise<unknown> = (actual as Promise<unknown>).then(
                (answer) => { this.lastAsyncAnswer.set(name, answer); },
                (e) => { this.lastAsyncAnswer.set(name, undefined); this.noteError(name, e); },
            ).finally(() => this.pending.delete(settling));
            this.pending.add(settling);
            return;
        }
        const got = comparableAnswer(actual);
        if (!sameAnswer(expected, got)) {
            this.stats.divergences[name] = (this.stats.divergences[name] ?? 0) + 1;
            if (this.stats.divergences[name] <= 3) {
                const msg = `DIVERGENCE ${name}: front answered ${JSON.stringify(expected)}, twin ${JSON.stringify(got)}`;
                this.stats.samples[`divergence:${name}`] ??= msg;
                Logger.error(LogCategory.D3D9, `[split] ${msg}`);
            }
        }
    }

    private noteError(name: string, e: unknown): void {
        this.stats.replayErrors[name] = (this.stats.replayErrors[name] ?? 0) + 1;
        this.stats.samples[`replay:${name}`] ??= String((e as Error)?.stack ?? e).slice(0, 600);
        if (this.stats.replayErrors[name] <= 3) Logger.error(LogCategory.D3D9, `[split] replay ${name} threw: ${String(e)}`);
    }

    takeStats(reset: boolean): SplitReplayStats {
        const out = JSON.parse(JSON.stringify(this.stats)) as SplitReplayStats;
        if (reset) this.stats = emptyReplayStats();
        return out;
    }
}
