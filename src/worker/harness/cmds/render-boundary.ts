/**
 * renderBoundaryMark / renderBoundary / renderBoundaryAudit — censuses A and C of the
 * render-worker plan's §8.0 gate (docs/performance/render-worker-plan-2026-09-11.md).
 *
 * Two questions the gate turns on, neither of which any existing counter answers:
 *
 *   A. How often does a GPU round trip PARK the guest, per presented frame? §6 makes
 *      "fences no more frequent than today" a perf invariant, and an invariant with no
 *      pre-measurement is unfalsifiable.
 *   C. How many dirty bytes cross to the GPU per frame? §5 would add a staging copy of
 *      exactly those bytes, and §10 refuses to build the project if that copy costs more
 *      than half the §1 ceiling.
 *
 * Both are per-FRAME questions. A session total hides the shape — one 8 MB frame and a
 * hundred 80 KB ones total the same and price completely differently — so the ledger is a
 * ring indexed by present boundary and this verb reports a distribution.
 *
 * The failure modes it must be able to announce (a plausible 0 is the failure this project
 * keeps rediscovering):
 *   - nothing was counted, because no present boundary closed;
 *   - the window spans a counter reset, so every count in it is a fragment;
 *   - the present serial moved by more (or less) than the boundaries we saw;
 *   - a fence path exists that NOBODY counts (glide, opengl) — reported by name, so a Glide
 *     title cannot read as "zero fences";
 *   - the classified byte ledger disagrees with what WebGPU's queue actually received.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import {
    RENDER_FENCE_KINDS, STAGED_BYTE_KINDS,
    readRenderBoundaryLedger, resetRenderBoundaryCensus, setRenderBoundaryQueueAudit,
    type RenderBoundaryLedger,
} from "../../modules/d3d9/d3d9-perf";
// The bare d3d9-perf snapshot answers a permanent 0 for the executor-owned backend counters
// (drawCalls among them); only this reader folds the live per-device ones in.
import { getD3D9PerfSnapshotWithDevices } from "../../modules/d3d9/shared-state";
import { readbackCounters } from "../../modules/ddraw/surface-sync";

/**
 * Fence paths that exist in the code and that NOTHING counts. Shipped in the report so a
 * zero can be read correctly: "0 because it never happened" vs "0 because nobody counts it".
 * Closing these needs edits in files this stage does not own (see the stage report).
 */
const UNINSTRUMENTED_FENCES = [
    {
        kind: "glideMirrorPump",
        site: "backends/webgpu/glide/glide-backend-executor.ts (mapAsync, fire-and-forget)",
        note: "grLfbLock reads a frame-stale CPU mirror and never parks the guest, so it is not the "
            + "same quantity as a D3D9 fence and must not be summed with one.",
    },
    {
        kind: "openglReadPixels",
        site: "backends/webgpu/opengl/opengl-backend-executor.ts readPixels",
        note: "a real guest-blocking fence, uncounted. A GL title reads as 0 fences here.",
    },
] as const;

/** Where every counted fence is incremented, so a reader can audit the census itself. */
const INSTRUMENTED_FENCES: Record<string, string> = {
    presentPermit: "backends/webgpu/d3d9/d3d9-device.ts present() — rAF permit, NOT a GPU fence",
    textureReadback: "backends/webgpu/d3d9/d3d9-device.ts downloadGpuTextureIntoData (GetRenderTargetData, texture→texture)",
    backbufferReadback: "backends/webgpu/d3d9/d3d9-backend-executor.ts readPresentedRgba (backbuffer; also the harness shot()/dumpSurface route)",
    rtRgbaReadback: "backends/webgpu/d3d9/d3d9-device.ts readRenderTargetRgba (StretchRect RT→offscreen-plain, harness textures)",
    queryBatch: "modules/d3d9/query-manager.ts completeBatch — one per RESOLVE BATCH, not per GetData",
};

const INSTRUMENTED_BYTES: Record<string, string> = {
    vertexIndexCopied: "d3d9-backend-executor.ts frame upload drain — already staged by render-frame queueUpload, so plan §5 adds NO copy for this class",
    vertexIndexDirect: "d3d9-resources.ts writeDirtyRange + d3d9-device.ts UP/rewind/arena writeBuffer — straight out of the CPU shadow; plan §5 would copy these",
    texture: "d3d9-device.ts ensureTexture/ensureDxtTexture/ensureCubeTexture/ensureVolumeTexture writeTexture",
    constants: "d3d9-backend-executor.ts uniform arena, megabatch VS, FFP/solid-fill/depth-clear uniforms",
};

export interface RenderBoundarySnapshot {
    atMs: number;
    ledger: RenderBoundaryLedger;
    guestPresentSerial: number | null;
    presentSerial: number | null;
    /** Draws the D3D9 API accepted and draws the encoder emitted, for the same window. */
    apiDraws: number;
    encodedDraws: number;
    /** DDraw Lock round trips, read-only from the ddraw census (surface-sync owns them). */
    ddrawRoundTrips: number;
    ddrawLockCalls: number;
}

export type RenderBoundaryResult =
    | { ok: false; refuse: string; code: string }
    | { ok: true; report: Record<string, unknown> };

const round = (v: number, d = 2): number => +v.toFixed(d);

const rbIndexOf = (kind: string): number => (RENDER_FENCE_KINDS as readonly string[]).indexOf(kind);

interface RenderLike {
    getPresentSerial?: () => number;
    getGuestPresentSerial?: () => number;
}

export function readRenderBoundarySnapshot(): RenderBoundarySnapshot {
    const render = sys().services?.render as RenderLike | undefined;
    const perf = getD3D9PerfSnapshotWithDevices();
    const api = perf.api;
    return {
        atMs: performance.now(),
        ledger: readRenderBoundaryLedger(),
        guestPresentSerial: render?.getGuestPresentSerial?.() ?? null,
        presentSerial: render?.getPresentSerial?.() ?? null,
        apiDraws: (api.drawPrimitive ?? 0) + (api.drawIndexedPrimitive ?? 0)
            + (api.drawPrimitiveUP ?? 0) + (api.drawIndexedPrimitiveUP ?? 0),
        encodedDraws: perf.backend.drawCalls ?? 0,
        ddrawRoundTrips: readbackCounters.roundTrips,
        ddrawLockCalls: readbackCounters.calls,
    };
}

/** min / median / p95 / max over a per-frame series. Empty in, nulls out — never 0. */
function distribution(values: number[]): Record<string, number | null> {
    if (values.length === 0) {
        return { n: 0, min: null, median: null, p95: null, max: null, mean: null, total: 0 };
    }
    const s = [...values].sort((a, b) => a - b);
    const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
    let total = 0;
    for (const v of values) total += v;
    return {
        n: values.length,
        min: s[0]!,
        median: at(0.5),
        p95: at(0.95),
        max: s[s.length - 1]!,
        mean: round(total / values.length),
        total,
    };
}

/**
 * The whole readout as a pure function of two snapshots, so each refusal has a test that
 * feeds it the condition it is meant to catch.
 */
export function summarizeRenderBoundary(
    before: RenderBoundarySnapshot,
    after: RenderBoundarySnapshot,
): RenderBoundaryResult {
    const windowMs = after.atMs - before.atMs;
    if (windowMs <= 0) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "render-boundary window is empty — renderBoundaryMark() and renderBoundary() ran in the same turn",
        };
    }
    if (after.ledger.epoch !== before.ledger.epoch) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: "the render-boundary counters were reset inside the window (resetD3D9Perf / perfProfile({reset}) "
                + "or renderBoundaryMark({reset:true})), so every count below would be a fragment. Re-mark and report again.",
        };
    }

    const gp = after.guestPresentSerial !== null && before.guestPresentSerial !== null
        ? after.guestPresentSerial - before.guestPresentSerial : null;
    if (gp !== null && gp < 0) {
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: `guestPresentSerial went BACKWARDS (${before.guestPresentSerial} → ${after.guestPresentSerial}): `
                + "RenderService.reset() ran inside the window (a game load). A per-present ratio over a reset serial is meaningless.",
        };
    }

    const framesInWindow = after.ledger.frames - before.ledger.frames;
    // Every count the ledger holds for this window, ring-retained or not.
    const totals: Record<string, number> = {};
    for (const k of [...RENDER_FENCE_KINDS, ...STAGED_BYTE_KINDS]) {
        totals[k] = (after.ledger.totals[k] ?? 0) - (before.ledger.totals[k] ?? 0);
    }
    let fenceTotal = 0;
    for (const k of RENDER_FENCE_KINDS) fenceTotal += totals[k]!;
    let byteTotal = 0;
    for (const k of STAGED_BYTE_KINDS) byteTotal += totals[k]!;

    if (framesInWindow === 0) {
        if (fenceTotal === 0 && byteTotal === 0) {
            return {
                ok: false, code: HarnessErrorCode.BAD_ARGS,
                refuse: "the render-boundary census recorded NOTHING over this window: no present boundary closed and no "
                    + "fence or upload was counted. Either no D3D9 title is running (the census is D3D9-only — see "
                    + "uninstrumented paths) or the window did not contain a frame. tickFrames() between mark and report.",
            };
        }
        return {
            ok: false, code: HarnessErrorCode.BAD_ARGS,
            refuse: `${fenceTotal} fences and ${byteTotal} staged bytes over 0 completed present boundaries: a per-present `
                + "ratio has no denominator here. This is what a title that fences but never presents looks like; "
                + "tickFrames() until a present lands, then report.",
        };
    }

    // Frames the ring could not retain. The totals above still cover them; the DISTRIBUTION
    // does not, and saying so is the difference between a shape and the shape of its tail.
    const firstWanted = before.ledger.frames;
    const retainedBase = after.ledger.frameIndexBase;
    const droppedFromRing = Math.max(0, retainedBase - firstWanted);
    const rows = after.ledger.perFrame.slice(Math.max(0, firstWanted - retainedBase));
    const serials = after.ledger.serials.slice(Math.max(0, firstWanted - retainedBase));
    if (rows.length === 0) {
        return {
            ok: false, code: HarnessErrorCode.INTERNAL,
            refuse: `${framesInWindow} frames closed in the window but the ${after.ledger.ringCapacity}-frame ring retained `
                + "none of them. The window is longer than the ring; shorten it (tickFrames in smaller batches).",
        };
    }

    // A serial that jumps by more than 1 between two boundaries is a present this census
    // never saw (a video-plane present, or a non-D3D9 presenter). Named, not smoothed.
    const serialGaps: Array<{ afterSerial: number; jump: number }> = [];
    for (let i = 1; i < serials.length; i++) {
        const jump = serials[i]! - serials[i - 1]!;
        if (jump !== 1) serialGaps.push({ afterSerial: serials[i - 1]!, jump });
    }
    const boundaryVsSerial = gp === null ? null : gp - framesInWindow;

    const fences: Record<string, unknown> = {};
    RENDER_FENCE_KINDS.forEach((k, i) => {
        fences[k] = {
            total: totals[k],
            perPresent: gp && gp > 0 ? round(totals[k]! / gp, 4) : null,
            perFrame: distribution(rows.map(r => r[i]!)),
            site: INSTRUMENTED_FENCES[k],
        };
    });

    const bytes: Record<string, unknown> = {};
    STAGED_BYTE_KINDS.forEach((k, i) => {
        bytes[k] = {
            total: totals[k],
            perFrame: distribution(rows.map(r => r[RENDER_FENCE_KINDS.length + i]!)),
            site: INSTRUMENTED_BYTES[k],
        };
    });

    // Census C's own cross-check: the classified notes against what WebGPU's queue actually
    // received. Only meaningful while the audit shim is installed, and never reconciled —
    // a mismatch marks the byte section unusable, because the alternative is a smaller,
    // entirely plausible number.
    const auditArmed = before.ledger.audit.installed && after.ledger.audit.installed;
    const queueBytes = after.ledger.audit.queueBytes - before.ledger.audit.queueBytes;
    const ledgerBytes = after.ledger.ledgerBytes - before.ledger.ledgerBytes;
    const uncoveredBytes = auditArmed ? queueBytes - ledgerBytes : null;
    const suppressed = after.ledger.suppressedKind || before.ledger.suppressedKind;
    // The bypass gags a KIND, and a kind is either a fence or a byte class. Routing it only
    // into the byte section would let `__noRenderBoundaryNote = "queryBatch"` deflate census A
    // while every number in the fence section still read clean.
    const suppressedFence = (RENDER_FENCE_KINDS as readonly string[]).includes(suppressed)
        ? suppressed : "";
    const suppressedByte = (STAGED_BYTE_KINDS as readonly string[]).includes(suppressed)
        ? suppressed : "";
    const byteSectionUsable = !suppressedByte && (!auditArmed || uncoveredBytes === 0);

    const allFrameFences = rows.map(r => {
        let n = 0;
        for (let i = 0; i < RENDER_FENCE_KINDS.length; i++) n += r[i]!;
        return n;
    });
    // presentPermit is one per present BY CONSTRUCTION (present() notes it, then closes the
    // boundary), so a "fences per present" headline that includes it can never read below 1
    // and is ~1.0 for every title alive. The GPU round-trip rate — the quantity plan §6 makes
    // an invariant — is the aggregate WITHOUT it.
    const ddrawRoundTrips = after.ddrawRoundTrips - before.ddrawRoundTrips;
    const ddrawLockCalls = after.ddrawLockCalls - before.ddrawLockCalls;
    const ddrawUsable = ddrawRoundTrips >= 0 && ddrawLockCalls >= 0;

    const permitIdx = rbIndexOf("presentPermit");
    let gpuFenceTotal = 0;
    for (const k of RENDER_FENCE_KINDS) if (k !== "presentPermit") gpuFenceTotal += totals[k]!;
    const gpuFrameFences = rows.map(r => {
        let n = 0;
        for (let i = 0; i < RENDER_FENCE_KINDS.length; i++) if (i !== permitIdx) n += r[i]!;
        return n;
    });
    const allFrameBytes = rows.map(r => {
        let n = 0;
        for (let i = RENDER_FENCE_KINDS.length; i < r.length; i++) n += r[i]!;
        return n;
    });

    return {
        ok: true,
        report: {
            windowMs: round(windowMs),
            framesObserved: framesInWindow,
            framesInDistribution: rows.length,
            framesDroppedFromRing: droppedFromRing,
            // Totals still cover every frame; the DISTRIBUTION covers only what the ring held.
            // Saying so is the difference between the shape and the shape of its tail.
            distributionCoversAllFrames: droppedFromRing === 0,
            distributionNote: droppedFromRing === 0
                ? null
                : `the window closed ${framesInWindow} frames and the ${after.ledger.ringCapacity}-frame ring kept `
                  + `the last ${rows.length}: every per-frame distribution below describes that tail, not the window. `
                  + "Totals and per-present ratios are unaffected. Shorten the window to make them agree.",
            guestPresentDelta: gp,
            presentDelta: after.presentSerial !== null && before.presentSerial !== null
                ? after.presentSerial - before.presentSerial : null,
            serialFirst: serials[0] ?? null,
            serialLast: serials[serials.length - 1] ?? null,
            // Non-zero means presents happened that closed no census frame (a video plane, a
            // non-D3D9 presenter). Dividing by guestPresentDelta then understates per-frame
            // work, which is why the difference is printed rather than absorbed.
            presentsWithoutCensusFrame: boundaryVsSerial,
            serialGaps,

            draws: {
                api: after.apiDraws - before.apiDraws,
                encoded: after.encodedDraws - before.encodedDraws,
                perFrame: framesInWindow > 0
                    ? round((after.apiDraws - before.apiDraws) / framesInWindow, 2) : null,
            },

            fences: {
                // A gagged fence kind leaves every number here perfectly plausible, so the
                // section carries its own verdict rather than borrowing the byte section's.
                usable: !suppressedFence,
                suppressedKind: suppressedFence || null,
                totalAllKinds: fenceTotal,
                perPresent: gp && gp > 0 ? round(fenceTotal / gp, 4) : null,
                perFrame: distribution(allFrameFences),
                // Census A's actual question: GPU round trips, presentPermit excluded.
                gpuRoundTrips: {
                    total: gpuFenceTotal,
                    perPresent: gp && gp > 0 ? round(gpuFenceTotal / gp, 4) : null,
                    perFrame: distribution(gpuFrameFences),
                },
                // presentPermit is minted on the same edge that closes a frame, so this is 0
                // in a healthy census and ±1 only when the mark landed between the two. Any
                // other value means the permit and the boundary are not the same edge.
                presentPermitVsFrames: totals["presentPermit"]! - framesInWindow,
                queriesServedByQueryBatchFences:
                    after.ledger.queriesServed - before.ledger.queriesServed,
                byKind: fences,
                note: (suppressedFence
                    ? `__noRenderBoundaryNote gagged the "${suppressedFence}" fence site: this section is `
                      + "deliberately wrong and nothing else in the report would say so. "
                    : "")
                    + "presentPermit is an rAF permit, NOT a GPU fence, and is 1/frame by construction — "
                    + "quote gpuRoundTrips, not totalAllKinds. backbufferReadback is shared with the harness "
                    + "(shot(), dumpSurface): a window that screenshots inflates its own count.",
            },

            // DDraw's own census, read-only. It is per-Lock, not per-present-boundary, and the
            // D3D9 frame ring cannot bin it — so it is reported flat and labelled.
            ddrawLockFences: ddrawUsable
                ? {
                    usable: true,
                    roundTrips: ddrawRoundTrips,
                    lockCalls: ddrawLockCalls,
                    perGuestPresent: gp && gp > 0 ? round(ddrawRoundTrips / gp, 4) : null,
                    source: "modules/ddraw/surface-sync.ts readbackCounters (owned there; read-only here)",
                    note: "not binned per frame — the D3D9 present boundary does not close a DDraw frame.",
                }
                : {
                    usable: false,
                    roundTrips: null,
                    lockCalls: null,
                    perGuestPresent: null,
                    source: "modules/ddraw/surface-sync.ts readbackCounters (owned there; read-only here)",
                    // These counters have no epoch: readbackStats({reset:true}) zeroes them and the
                    // subtraction then answers with whatever accrued AFTER the reset — a smaller,
                    // entirely plausible DDraw lock rate. A negative delta is the only visible case;
                    // refusing on it is what keeps the invisible one from being the default.
                    note: `the DDraw readback counters went BACKWARDS in this window `
                        + `(roundTrips ${before.ddrawRoundTrips} → ${after.ddrawRoundTrips}, `
                        + `calls ${before.ddrawLockCalls} → ${after.ddrawLockCalls}): readbackStats({reset:true}) `
                        + "ran inside it. Order that verb around the window, never inside it, and re-mark.",
                },

            stagedBytes: {
                usable: byteSectionUsable,
                totalAllKinds: byteTotal,
                perFrame: distribution(allFrameBytes),
                byKind: bytes,
                // The plan's §5 cost is the copy of the bytes that are NOT already staged.
                plan5MarginalCopyBytes: totals["vertexIndexDirect"]! + totals["texture"]! + totals["constants"]!,
                plan5MarginalCopyBytesExConstants: totals["vertexIndexDirect"]! + totals["texture"]!,
                plan5AlreadyCopiedBytes: totals["vertexIndexCopied"],
                plan5Note: "render-frame.ts queueUpload already copies every recorder-routed upload, so the "
                    + "§5 staging copy is zero marginal cost for `vertexIndexCopied`. Price §5 against "
                    + "plan5MarginalCopyBytes, not against the total. UPPER/LOWER BOUND, not one number: "
                    + "`constants` is what the EXECUTOR wrote into a uniform buffer it assembled itself, "
                    + "which is not the same quantity as the draw-state bytes that would cross a worker "
                    + "boundary — the §5 price lies between the two fields, and which end depends on a "
                    + "boundary-shape decision stage 8.1 has not made.",
                audit: {
                    armed: auditArmed,
                    queueBytesObserved: auditArmed ? queueBytes : null,
                    ledgerBytes,
                    uncoveredBytes,
                    suppressedKind: suppressed || null,
                    note: !auditArmed
                        ? "renderBoundaryAudit({enable:true}) was not installed for the whole window, so NOTHING "
                          + "cross-checks these bytes: an upload site that reaches the GPU without a note is invisible. "
                          + "Treat the byte totals as a floor."
                        : suppressed
                            ? `__noRenderBoundaryNote suppressed the "${suppressed}" ledger site: this section is deliberately wrong.`
                            : uncoveredBytes === 0
                                ? "every byte WebGPU's queue received was also classified by the ledger"
                                : "MISMATCH: the queue received bytes the classified ledger never saw (or vice versa). "
                                  + "No share in this section is usable. Note: the shim counts writes from EVERY backend "
                                  + "in this worker, so a ddraw/glide/postfx upload inside the window lands here too.",
                },
            },

            // Top level too: a flag naming no known kind gags nothing, and that is worth
            // seeing rather than reading as a clean census with a bypass believed armed.
            suppressedKind: suppressed || null,
            uninstrumented: UNINSTRUMENTED_FENCES.map(u => u.kind),
            uninstrumentedDetail: UNINSTRUMENTED_FENCES,
            instrumentedFenceSites: INSTRUMENTED_FENCES,
            instrumentedByteSites: INSTRUMENTED_BYTES,
            scope: "D3D9 only. A DDraw/Glide/OpenGL title reports its D3D9 fences as 0 because it has none — "
                + "read `uninstrumented` before concluding a title fences rarely.",
        },
    };
}

let mark: RenderBoundarySnapshot | null = null;

export function registerRenderBoundaryCommands(svc: HarnessService): void {
    /** renderBoundaryMark({reset?}) — window baseline. `reset` zeroes the ledger first, which
     *  makes the window start at frame 0 and keeps the ring from being the limiting factor. */
    svc.register("renderBoundaryMark", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        if (opts.reset) resetRenderBoundaryCensus();
        mark = readRenderBoundarySnapshot();
        return {
            marked: true,
            atMs: round(mark.atMs),
            epoch: mark.ledger.epoch,
            frames: mark.ledger.frames,
            guestPresentSerial: mark.guestPresentSerial,
            auditInstalled: mark.ledger.audit.installed,
            warning: mark.ledger.audit.installed
                ? null
                : "the queue-byte audit is OFF, so the byte census has nothing cross-checking it. "
                  + "renderBoundaryAudit({enable:true}) before the window if you intend to quote byte totals.",
        };
    });

    /** renderBoundary() — censuses A and C over the window since renderBoundaryMark(). */
    svc.register("renderBoundary", () => {
        if (!mark) {
            throw new HarnessError("renderBoundary with no renderBoundaryMark", HarnessErrorCode.BAD_ARGS);
        }
        const out = summarizeRenderBoundary(mark, readRenderBoundarySnapshot());
        if (!out.ok) throw new HarnessError(out.refuse, out.code);
        return out.report;
    });

    /**
     * renderBoundaryAudit({enable}) — arm the GPUQueue byte shim that cross-checks census C.
     * Default OFF and identity-cost while off. It patches GPUQueue.prototype, so it sees every
     * backend's writes, not only D3D9 — and it must never be left armed across a timing arm
     * (PERF EVIDENCE RULE).
     */
    svc.register("renderBoundaryAudit", (args) => {
        const on = (args[0] as { enable?: boolean } | undefined)?.enable ?? true;
        const installed = setRenderBoundaryQueueAudit(on);
        if (on && !installed) {
            throw new HarnessError(
                "no GPUQueue in this realm — the byte audit cannot be installed, so census C has no cross-check here",
                HarnessErrorCode.UNSUPPORTED);
        }
        return {
            armed: on,
            installed,
            warning: on
                ? "the shim counts writeBuffer/writeTexture bytes from EVERY backend in this worker. Disarm before "
                  + "any timing arm."
                : null,
        };
    });
}
