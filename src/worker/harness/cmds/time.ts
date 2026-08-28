/**
 * Time + determinism harness verbs.
 *
 * - time(action,ms): freeze/advance/realtime via TimeService (the virtual-time
 *   lever for reproducible audio-gated intros + timer-paced loops).
 * - tickFrames(n): wait until n more presents have occurred (presentSerial), the
 *   basis for "exactly N frames after the click". NOTE: this awaits N presents at
 *   the emulator's own rate; true per-frame parking (gating the v86 loop + the
 *   AudioWorklet to virtual time) is a deeper, invasive change left
 *   for the bit-exact record/replay stage.
 * - waitUntil(predicate): evaluate a predicate over guest memory/CPU IN the
 *   worker on a poll loop — for spin-loop games that emit no event.
 * - sleep(ms): bounded wall-clock delay (honors cancel).
 */

import type { HarnessService } from "../service";
import type { HarnessCtx } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, cpu, guestMem, proc } from "../serialize";
import { TimeService } from "../../runtime/time";
import { harnessBus } from "../event-bus";
import { cancelCapture as frameCaptureCancel, startCapture as frameCaptureStart } from "../../modules/ddraw/frame-capture";

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    });
}

/** Build the predicate evaluation context (guest memory + CPU read helpers). */
function buildPredicate(marker: unknown): () => boolean {
    if (typeof marker === "function") return marker as () => boolean;
    const src = (marker && typeof marker === "object" && typeof (marker as any).__fn === "string") ? (marker as any).__fn as string : null;
    if (!src) throw new HarnessError("waitUntil expects a predicate function", HarnessErrorCode.BAD_ARGS);
    const view = (): DataView | null => {
        const m = guestMem();
        return m ? new DataView(m.buffer, m.byteOffset, m.byteLength) : null;
    };
    const read32 = (a: number) => (view()?.getUint32(a >>> 0, true) ?? 0) >>> 0;
    const read16 = (a: number) => view()?.getUint16(a >>> 0, true) ?? 0;
    const read8 = (a: number) => view()?.getUint8(a >>> 0) ?? 0;
    const readF32 = (a: number) => view()?.getFloat32(a >>> 0, true) ?? 0;
    const eip = () => (cpu()?.instruction_pointer?.[0] ?? 0) >>> 0;
    const reg = (i: number) => (cpu()?.reg32?.[i] ?? 0) >>> 0;
    const factory = new Function(
        "read32", "read16", "read8", "readF32", "readU32", "eip", "reg", "Mem",
        `"use strict"; return (${src});`,
    );
    const Mem = { read32, read16, read8, readF32 };
    return factory(read32, read16, read8, readF32, read32, eip, reg, Mem) as () => boolean;
}

export function registerTimeCommands(svc: HarnessService): void {
    svc.register("time", (args) => {
        const action = String(args[0] ?? "");
        const ms = Number(args[1] ?? 0);
        const ts = TimeService.getInstance();
        switch (action) {
            case "freeze":
                ts.setMode("manual", ts.nowMs(), ts.nowUnixMs());
                break;
            case "advance":
                if (ts.getMode() !== "manual") ts.setMode("manual", ts.nowMs(), ts.nowUnixMs());
                ts.advanceByMs(ms);
                break;
            case "realtime":
                ts.setMode("realtime");
                break;
            default:
                throw new HarnessError(`time action must be freeze|advance|realtime (got '${action}')`, HarnessErrorCode.BAD_ARGS);
        }
        return { mode: ts.getMode(), nowMs: ts.nowMs(), nowUnixMs: ts.nowUnixMs() };
    });

    /** guestTime({sampleMs}) — what the GUEST's clock does relative to wall clock.
     *
     *  GetTickCount/timeGetTime/QPC all read TimeService's virtual clock, which only
     *  advances while the guest executes instructions plus the explicit credits
     *  (heavy-thunk deficit, capped per §3.5; idle pump; video decode). A frame spent
     *  inside one long thunk therefore generates almost no game time, and a title whose
     *  logic is dt-driven runs in slow motion while audio and input run on wall clock.
     *  `rate` is Δvirtual/Δwall over the sample: 1.0 = tracking, <1 = guest time is
     *  losing, >1 = running fast. `behindMs` is the accumulated lead of wall over
     *  virtual, which never recovers (the clock has no drift correction by design). */
    svc.register("guestTime", async (args, ctx: HarnessCtx) => {
        const sampleMs = Math.max(1, Number((args[0] as { sampleMs?: number } | undefined)?.sampleMs ?? 1000));
        const ts = TimeService.getInstance();
        const v0 = ts.nowMs(), w0 = performance.now();
        await delay(sampleMs, ctx.signal);
        const v1 = ts.nowMs(), w1 = performance.now();
        const dv = v1 - v0, dw = w1 - w0;
        return {
            virtualTimeActive: ts.isVirtualTimeActive(),
            sampleMs: +dw.toFixed(1),
            virtualDeltaMs: +dv.toFixed(1),
            rate: +(dv / dw).toFixed(3),
            behindMs: +(w1 - v1).toFixed(1),
        };
    });

    /** watchFrames(on?) — enable/disable the per-present frameRendered event
     *  (off by default to keep the present path zero-cost). */
    svc.register("watchFrames", (args) => {
        harnessBus.frameEvents = args[0] === undefined ? true : !!args[0];
        return { frameEvents: harnessBus.frameEvents };
    });

    svc.register("sleep", async (args, ctx: HarnessCtx) => {
        const ms = Math.max(0, Number(args[0] ?? 0));
        await delay(ms, ctx.signal);
        return { sleptMs: ms };
    });

    svc.register("tickFrames", async (args, ctx: HarnessCtx) => {
        const n = Math.max(1, Number(args[0] ?? 1) | 0);
        const opts = (args[1] ?? {}) as { park?: boolean };
        const render: any = sys().services?.render;
        if (!render?.getPresentSerial) throw new HarnessError("render service unavailable", HarnessErrorCode.NO_PROCESS);
        const v86: any = proc()?.v86;
        // If a previous park stopped the loop, resume so presents can advance.
        // Route through the canonical resume so the module-level isPaused clears
        // (else the 1ms scheduler won't restart v86).
        if (opts.park && v86?.is_running && !v86.is_running()) (globalThis as any).__harnessResume?.();
        const start = render.getPresentSerial() >>> 0;
        const target = start + n;
        const t0 = performance.now();
        const pollMs = 4;
        while ((render.getPresentSerial() >>> 0) < target) {
            if (ctx.signal.aborted) throw ctx.signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED);
            await delay(pollMs, ctx.signal);
        }
        let parked = false;
        if (opts.park) {
            // Frame-accurate freeze AFTER N presents. Routes through the canonical
            // pause (sets module-level isPaused) — a bare v86.stop() is undone by
            // the 1ms scheduler within ~1ms. NOTE: the AudioWorklet runs on the real
            // audio clock — while parked it underruns (no new guest audio); fine for
            // inspect-and-step. Also NOTE: under the opt-in phase-blend present mode,
            // presentSerial is rAF-driven, so park won't freeze the serial — use the
            // default present mode for frame-accurate stepping.
            const fn = (globalThis as any).__harnessPause;
            if (fn) { fn(); parked = true; } else { try { await v86?.stop?.(); parked = true; } catch { /* */ } }
        }
        return { frames: n, startSerial: start, endSerial: render.getPresentSerial() >>> 0, ms: performance.now() - t0, presenter: render.getLastPresenterKind?.() ?? null, parked };
    });

    /** stepFrames(n=1, {capture?, backend?, timeoutMs?}) — advance EXACTLY n presents from a
     *  parked guest and park again, inside ONE rpc.
     *
     *  `tickFrames(n,{park:true})` already resumes-waits-parks, but a paused inspection
     *  session also wants the frame's per-draw capture, and arming that from a second CLI
     *  round-trip lets the guest run free in between — the frame you inspect is then not the
     *  frame you stepped. `capture:true` arms the CaptureBus BEFORE the resume; the capture
     *  discards the in-progress frame and records the next, so it may consume one present
     *  beyond `n` (reported as `endSerial`, never hidden).
     *
     *  Reports the present serial on both sides and the paused state afterwards: a step that
     *  did not step (present serial unchanged, or the guest left running) reads as such
     *  instead of as success. */
    svc.register("stepFrames", async (args, ctx: HarnessCtx) => {
        const n = Math.max(1, Number(args[0] ?? 1) | 0);
        const opts = (args[1] ?? {}) as { capture?: boolean; backend?: string; timeoutMs?: number };
        const render: any = sys().services?.render;
        if (!render?.getPresentSerial) throw new HarnessError("render service unavailable", HarnessErrorCode.NO_PROCESS);
        const v86: any = proc()?.v86;
        const wasRunning = !!v86?.is_running?.();
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const t0 = performance.now();

        // Arm the capture while the guest is still parked, so no frame can slip past it.
        let capPromise: Promise<unknown> | null = null;
        if (opts.capture) capPromise = frameCaptureStart(opts.backend);

        const start = render.getPresentSerial() >>> 0;
        if (!wasRunning) (globalThis as any).__harnessResume?.();

        let timedOut = false;
        const target = start + n;
        while ((render.getPresentSerial() >>> 0) < target) {
            if (ctx.signal.aborted) throw ctx.signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED);
            if (performance.now() - t0 > timeoutMs) { timedOut = true; break; }
            await delay(4, ctx.signal);
        }

        let capture: unknown = null;
        let captureError: string | null = null;
        if (capPromise) {
            try {
                capture = await Promise.race([
                    capPromise,
                    (async () => {
                        while (performance.now() - t0 <= timeoutMs) await delay(4, ctx.signal);
                        throw new HarnessError(`capture did not complete within ${timeoutMs}ms`, HarnessErrorCode.TIMEOUT);
                    })(),
                ]);
            } catch (e) {
                captureError = (e as Error).message;
                frameCaptureCancel(e instanceof Error ? e : new Error(String(e)));
            }
        }

        const fn = (globalThis as any).__harnessPause;
        if (fn) fn(); else { try { await v86?.stop?.(); } catch { /* park is best-effort without the hook */ } }
        const endSerial = render.getPresentSerial() >>> 0;
        return {
            requested: n,
            startSerial: start,
            endSerial,
            advanced: (endSerial - start) >>> 0,
            wasRunning,
            paused: !!sys().isPaused,
            timedOut,
            ms: performance.now() - t0,
            presenter: render.getLastPresenterKind?.() ?? null,
            capture,
            captureError,
        };
    });

    svc.register("waitUntil", async (args, ctx: HarnessCtx) => {
        const pred = buildPredicate(args[0]);
        const opts = (args[1] ?? {}) as { timeoutMs?: number; pollMs?: number };
        const pollMs = Math.max(1, opts.pollMs ?? 16);
        const deadline = performance.now() + (opts.timeoutMs ?? 30_000);
        let polls = 0;
        const t0 = performance.now();
        for (;;) {
            polls++;
            let val = false;
            try { val = !!pred(); } catch (e) { throw new HarnessError(`waitUntil predicate threw: ${(e as Error).message}`, HarnessErrorCode.BAD_ARGS); }
            if (val) return { satisfied: true, polls, ms: performance.now() - t0 };
            if (performance.now() > deadline) return { satisfied: false, polls, ms: performance.now() - t0, timedOut: true };
            if (ctx.signal.aborted) throw ctx.signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED);
            await delay(pollMs, ctx.signal);
        }
    });
}
