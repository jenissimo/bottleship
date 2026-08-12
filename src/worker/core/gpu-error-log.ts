/**
 * One census of everything the GPU refused to do, plus the throws that killed a present
 * path on the way there.
 *
 * WebGPU reports failure through channels that share no plumbing: a synchronous throw from
 * API misuse, an ASYNCHRONOUS validation/OOM/internal error that only reaches
 * onuncapturederror or a popErrorScope, and device loss. None of them stops a frame from
 * "succeeding" as far as our own code can tell, so the symptom is missing geometry, a frozen
 * picture or a black screen — with clean logs. The 50-entry log ring cannot hold the first
 * one long enough for anyone to find it; a counter `report()` carries can.
 */

/** Which channel reported the failure — different causes, different fixes. `callback` is a
 *  throw from a guarded non-GPU callback: counted, but never claimed as GPU refusal. */
export type GpuErrorKind = "uncaptured" | "scope" | "throw" | "deviceLost" | "callback";

const counts: Record<GpuErrorKind, number> = { uncaptured: 0, scope: 0, throw: 0, deviceLost: 0, callback: 0 };
/** site -> count. Free-form keys so a new guarded call site needs no schema edit. */
const bySite: Record<string, number> = {};

const MAX_DISTINCT = 32;
/** First occurrence of each distinct message, with a repeat count: one bad pipeline can
 *  fire per draw forever, and the thousandth copy says nothing the first did not. */
const messages = new Map<string, { kind: GpuErrorKind; site: string; count: number; message: string }>();
/** Set only when a distinct message was actually turned away, never merely because the
 *  table filled — "we are hiding something" must not be reported on a hunch. */
let distinctDropped = false;

export function recordGpuError(kind: GpuErrorKind, site: string, message: string): void {
    counts[kind]++;
    bySite[site] = (bySite[site] ?? 0) + 1;
    const key = `${kind}|${site}|${message}`;
    const seen = messages.get(key);
    if (seen) { seen.count++; return; }
    if (messages.size >= MAX_DISTINCT) { distinctDropped = true; return; }
    messages.set(key, { kind, site, count: 1, message });
}

export interface GpuErrorReport {
    total: number;
    /** Everything the GPU itself refused — `total` minus the guarded-callback throws. */
    gpuTotal: number;
    byKind: Record<GpuErrorKind, number>;
    bySite: Record<string, number>;
    /** Distinct messages, first-seen order, each with how many times it repeated. */
    distinct: Array<{ kind: GpuErrorKind; site: string; count: number; message: string }>;
    /** True once a NEW distinct message was turned away (it is still counted above). */
    distinctTruncated: boolean;
}

export function getGpuErrorReport(): GpuErrorReport {
    const total = counts.uncaptured + counts.scope + counts.throw + counts.deviceLost + counts.callback;
    return {
        total,
        gpuTotal: total - counts.callback,
        byKind: { ...counts },
        bySite: { ...bySite },
        distinct: [...messages.values()],
        distinctTruncated: distinctDropped,
    };
}

/** Scope the census to one run — called on bundle load, so a count answers "this run". */
export function resetGpuErrors(): void {
    counts.uncaptured = 0; counts.scope = 0; counts.throw = 0; counts.deviceLost = 0; counts.callback = 0;
    for (const k in bySite) delete bySite[k];
    messages.clear();
    distinctDropped = false;
}
