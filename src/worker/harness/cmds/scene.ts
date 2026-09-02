/**
 * sceneProbe — what is on screen, as numbers instead of a screenshot somebody has to look at.
 * A measurement taken on the wrong scene has every number present and plausible, and nothing
 * else in a run says so.
 *
 * The verb deliberately does NOT try to answer "is this gameplay". That needs per-game
 * knowledge and a threshold nobody can justify. It answers two questions that need neither:
 *
 *   1. **Is anything moving, and how much work is a frame?** `motion` is the mean absolute
 *      luma difference between two captures a moment apart, on a coarse grid; `draws` is
 *      what the D3D9 backend actually submitted. A static, cheap frame is a menu or a load
 *      screen whatever the game; a moving, expensive one is not.
 *   1b. **A single motion threshold is NOT a scene detector.** An animated profile screen or
 *      a cutscene clears any fixed threshold as easily as gameplay does. Use `motionPerSample`
 *      (a menu TRANSITION is one spike, a race is sustained), and prefer `codeScene` when the
 *      question is really "which part of the game is running".
 *
 *   2. **Are two runs looking at the SAME scene?** `fingerprint` is that coarse grid,
 *      averaged over the window. Comparing two probes with `sceneCompare` needs no absolute
 *      threshold at all — and for an A/B that is the whole question, because two arms in
 *      different scenes cannot be compared no matter how good the numbers look.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";

/** Coarse grid the fingerprint is built on. Small enough to return inline and to be
 *  insensitive to a cursor or a spinning icon; large enough to tell two screens apart. */
const GW = 32, GH = 18;

async function grabLuma(): Promise<Float64Array> {
    const render = sys().services?.render as { captureScreen?: () => Promise<Blob | null> } | undefined;
    if (!render?.captureScreen) {
        throw new HarnessError("no render service to capture from", HarnessErrorCode.UNSUPPORTED);
    }
    const blob = await render.captureScreen();
    if (!blob) throw new HarnessError("captureScreen returned nothing (screen mirror empty)", HarnessErrorCode.UNSUPPORTED);
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(GW, GH);
    const ctx = c.getContext("2d");
    if (!ctx) throw new HarnessError("no 2d context for the scene probe", HarnessErrorCode.INTERNAL);
    // Downscaling in one drawImage is the averaging: a per-cell mean, not a point sample,
    // so a moving cursor cannot dominate and a dithered background cannot alias.
    ctx.drawImage(bmp, 0, 0, GW, GH);
    bmp.close();
    const d = ctx.getImageData(0, 0, GW, GH).data;
    const out = new Float64Array(GW * GH);
    for (let i = 0; i < out.length; i++) {
        out[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
    }
    return out;
}

const meanAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
    return s / a.length;
};

export function registerSceneCommands(svc: HarnessService): void {
    /**
     * sceneProbe({ samples?, gapMs? }) — a fingerprint of the current scene plus how much it
     * is moving and how much a frame costs.
     *
     * Read `motion` and `draws` together: a load screen is static AND cheap, a paused game is
     * static and expensive, an animated menu moves and is cheap. One number alone names none
     * of them.
     */
    svc.register("sceneProbe", async (args) => {
        const opts = (args[0] ?? {}) as { samples?: number; gapMs?: number };
        const samples = Math.max(2, Math.min(opts.samples ?? 4, 16));
        const gapMs = Math.max(50, Math.min(opts.gapMs ?? 350, 5000));

        const active = sys().services?.render?.getActive?.() as
            { backendExecutor?: { getSubmitStats?: (r: boolean) => unknown }; getBackendExecutor?: () => { getSubmitStats?: (r: boolean) => unknown } } | undefined;
        const executor = active?.backendExecutor ?? active?.getBackendExecutor?.();
        const submitBefore = executor?.getSubmitStats ? executor.getSubmitStats(true) : null;

        const frames: Float64Array[] = [];
        for (let i = 0; i < samples; i++) {
            frames.push(await grabLuma());
            if (i < samples - 1) await new Promise((r) => setTimeout(r, gapMs));
        }
        const submitAfter = executor?.getSubmitStats ? executor.getSubmitStats(false) : null;

        // Motion: consecutive differences, so a single flash does not read as constant motion.
        const diffs: number[] = [];
        for (let i = 1; i < frames.length; i++) diffs.push(meanAbsDiff(frames[i - 1]!, frames[i]!));
        const motion = diffs.reduce((a, b) => a + b, 0) / diffs.length;

        // The fingerprint is the AVERAGE frame: a scene that animates in place still has a
        // stable average, so two runs of the same menu match while a different screen does not.
        const avg = new Float64Array(GW * GH);
        for (const f of frames) for (let i = 0; i < avg.length; i++) avg[i] += f[i]! / frames.length;

        let sum = 0;
        for (let i = 0; i < avg.length; i++) sum += avg[i]!;
        const brightness = sum / avg.length;

        return {
            grid: [GW, GH],
            samples, gapMs,
            spanMs: gapMs * (samples - 1),
            motion: +motion.toFixed(3),
            motionPerSample: diffs.map((d) => +d.toFixed(3)),
            brightness: +brightness.toFixed(2),
            // Rounded: the fingerprint is for comparison, and full precision would make two
            // captures of the same static screen differ by encoder noise.
            fingerprint: Array.from(avg, (v) => Math.round(v)),
            submit: { before: submitBefore, after: submitAfter },
            note: "motion is mean |luma delta| per cell between consecutive captures (0-255). "
                + "A static screen sits near 0. Compare two probes with sceneCompare rather than "
                + "against an absolute threshold — 'is this gameplay' is game-specific, 'is this "
                + "the same scene as the other arm' is not.",
        };
    });

    /**
     * sceneCompare(a, b) — are two `sceneProbe` results looking at the same thing?
     *
     * This is the check an A/B needs. Two arms in different scenes produce perfectly good
     * frame percentiles that mean nothing next to each other, and nothing else in a run
     * notices.
     */
    svc.register("sceneCompare", (args) => {
        const a = args[0] as { fingerprint?: number[]; motion?: number } | undefined;
        const b = args[1] as { fingerprint?: number[]; motion?: number } | undefined;
        if (!a?.fingerprint || !b?.fingerprint) {
            throw new HarnessError("sceneCompare needs two sceneProbe results", HarnessErrorCode.BAD_ARGS);
        }
        if (a.fingerprint.length !== b.fingerprint.length) {
            throw new HarnessError("fingerprints have different grids — probes from different builds", HarnessErrorCode.BAD_ARGS);
        }
        const distance = meanAbsDiff(a.fingerprint, b.fingerprint);
        return {
            distance: +distance.toFixed(3),
            motionA: a.motion, motionB: b.motion,
            // The scale is luma units per cell, so the bands below are readable rather than
            // arbitrary: a few units is compression and animation, tens is a different image.
            verdict: distance < 6 ? "same-scene" : distance < 20 ? "similar" : "different-scene",
            note: "distance is mean |luma delta| per cell between the two average frames (0-255). "
                + "'different-scene' means the two runs were NOT looking at the same thing and any "
                + "side-by-side timing between them is void.",
        };
    });
}
