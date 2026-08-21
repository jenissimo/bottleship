/**
 * audio — audio-pump rate instrumentation over the harness RPC.
 *
 * The NFSU-class perf question "is the guest's DSound streaming pump waking up
 * faithfully (~few times/frame) or storming (hundreds/s)?" needs RATES, not the
 * raw monotonic counters that dsound.dbgAudioCalls / winmm.dbgTimerStats already
 * keep. audioPump({ms}) snapshots both plus the scheduler's round-trip/FPU-switch
 * counters, waits a wall-clock window, snapshots again and returns deltas/sec —
 * one POJO that answers "wakeups/s, locks/s, bytes-per-lock, timer fires/s,
 * context switches/s" without grepping the log firehose.
 */

import type { HarnessService } from "../service";
import { sys, getModule, symbolize } from "../serialize";
import { getHostAudioStats, resetHostAudioStats } from "../../worker-handlers/audio-bridge";

interface PumpSnapshot {
    tMs: number;
    dsound: Record<string, number> | null;
    timer: Record<string, number> | null;
    sched: { realSwitch: number; selfReschedule: number; ticks: number; urgentTicks: number } | null;
    fpu: { saves: number; savesSkippedClean: number; restores: number } | null;
    threadCpuMs: Record<number, number> | null;
}

function snapshot(): PumpSnapshot {
    const ds: any = getModule("dsound");
    const mm: any = getModule("winmm");
    const sched: any = sys().scheduler as any;
    const rt = sched?.roundTripStats;
    const fp = sched?.fpuSwitchStats;
    return {
        tMs: performance.now(),
        dsound: ds?.dbgAudioCalls ? { ...ds.dbgAudioCalls } : null,
        timer: mm?.dbgTimerStats ? { ...mm.dbgTimerStats } : null,
        sched: rt ? { realSwitch: rt.realSwitch, selfReschedule: rt.selfReschedule, ticks: rt.ticks, urgentTicks: rt.urgentTicks } : null,
        fpu: fp ? { saves: fp.saves, savesSkippedClean: fp.savesSkippedClean, restores: fp.restores } : null,
        threadCpuMs: sched?.getThreadCpuMs?.() ?? null,
    };
}

/** Per-second deltas between two counter records (keys present in both). */
function ratesPerSec(a: Record<string, number> | null, b: Record<string, number> | null, dtSec: number): Record<string, number> | null {
    if (!a || !b || dtSec <= 0) return null;
    const out: Record<string, number> = {};
    for (const k of Object.keys(b)) {
        const va = a[k], vb = b[k];
        if (typeof va !== "number" || typeof vb !== "number") continue;
        const d = vb - va;
        if (d !== 0) out[k] = Math.round((d / dtSec) * 10) / 10;
    }
    return out;
}

export function registerAudioCommands(svc: HarnessService): void {
    /** audioPump({ms?=2000}) — sample audio-pump + timer + scheduler counter rates
     *  over a wall-clock window. Rates are deltas/sec; zero-delta keys are omitted.
     *  bytesPerLock/lockedBytesPerSec quantify the streaming granularity: a faithful
     *  pump locks a few KB a few times per frame; a storming pump shows locksPerSec
     *  in the hundreds with tiny bytesPerLock. */
    svc.register("audioPump", async (args) => {
        const opts = (args[0] ?? {}) as { ms?: number };
        const windowMs = Math.min(30_000, Math.max(100, opts.ms ?? 2000));
        const before = snapshot();
        await new Promise((r) => setTimeout(r, windowMs));
        const after = snapshot();
        const dtSec = (after.tMs - before.tMs) / 1000;

        const dsoundRates = ratesPerSec(before.dsound, after.dsound, dtSec);
        const timerRates = ratesPerSec(before.timer, after.timer, dtSec);
        const schedRates = ratesPerSec(before.sched as any, after.sched as any, dtSec);
        const fpuRates = ratesPerSec(before.fpu as any, after.fpu as any, dtSec);

        // Streaming granularity: bytes actually written per Unlock in the window.
        const dLocks = (after.dsound?.lock ?? 0) - (before.dsound?.lock ?? 0);
        const dUnlockBytes = (after.dsound?.bytesUnlocked ?? 0) - (before.dsound?.bytesUnlocked ?? 0);
        const ds: any = getModule("dsound");
        const lockTrace = ds?.getAudioDebugState?.()?.lockTrace?.slice(-8) ?? null;

        // Per-thread worker-time share over the window: who actually consumed the CPU.
        // startAddress is symbolized so the audio-service thread is tellable from main.
        let threads: Array<{ id: number; ms: number; pct: number; start: string | null }> | null = null;
        if (before.threadCpuMs && after.threadCpuMs) {
            const sched: any = sys().scheduler as any;
            const list = sched?.getAllThreads?.() ?? sched?.threads ?? null;
            const startOf = (id: number): string | null => {
                const t = Array.isArray(list) ? list.find((x: any) => x?.id === id)
                    : list?.get?.(id) ?? null;
                const sa = t?.startAddress;
                return typeof sa === "number" && sa > 0 ? (symbolize(sa) ?? `0x${(sa >>> 0).toString(16)}`) : null;
            };
            threads = Object.keys(after.threadCpuMs)
                .map((k) => {
                    const id = Number(k);
                    const ms = (after.threadCpuMs![id] ?? 0) - (before.threadCpuMs![id] ?? 0);
                    return { id, ms: Math.round(ms * 10) / 10, pct: Math.round((ms / (dtSec * 1000)) * 1000) / 10, start: startOf(id) };
                })
                .filter((t) => t.ms > 0.5)
                .sort((a, b) => b.ms - a.ms);
        }

        return {
            windowMs: Math.round(dtSec * 1000),
            perSec: {
                dsound: dsoundRates,
                timer: timerRates,
                scheduler: schedRates,
                fpu: fpuRates,
            },
            bytesPerLock: dLocks > 0 ? Math.round(dUnlockBytes / dLocks) : null,
            threads,
            recentLocks: lockTrace,
        };
    });

    /** audioBuffers() — full per-buffer dsound snapshot (id/ptr, isPlaying, isLooping,
     *  bytes, sabState, cursors). The lever for the "stuck looping sample" class: after a
     *  looping-music change, a buffer left isPlaying/sabState=PLAYING with the guest no
     *  longer feeding it is the drone. Pairs with a race→menu repro. */
    svc.register("audioBuffers", async () => {
        const ds: any = getModule("dsound");
        return ds?.getAudioDebugState?.() ?? { error: "no dsound module" };
    });

    /** audioSignal({reset?}) — "is there sound?" answered end-to-end, without ears.
     *
     *  Cursors advancing prove the pump runs; they do NOT prove anything is audible.
     *  Three things have to hold and each is a different bug: the ring must CARRY
     *  signal (ringPeak — PCM amplitude the guest actually wrote), the mixer must
     *  SELECT the buffer (worklet.activeRing — a source whose ctrl block fails the
     *  worklet's format sanity is skipped outright), and the mix must REACH the
     *  output (worklet.peakMilli). Silence with ringPeak>0 and activeRing=0 is a
     *  ctrl-block/format bug; ringPeak=0 is a guest/decode bug; both non-zero with
     *  peakMilli=0 is gain (volume/pan/3D).
     *
     *  ctrl is the raw SAB control block decoded — the format fields the worklet
     *  actually reads, not the worker's private SoundBuffer.format copy. The two
     *  disagreeing IS the failure mode this verb exists to catch.
     *
     *  `host` is the FOURTH place a sound can be: an encoded stream (MP3/OGG) plays on
     *  a host media element the worklet never mixes, so peakMilli stays 0 while the
     *  music is perfectly audible. Rising `positions`/`lastFrames` for an id is the only
     *  worker-side proof that such a stream is really decoding; `error` names a container
     *  the browser refused. */
    svc.register("audioSignal", async (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        const ds: any = getModule("dsound");

        const statsSab = (globalThis as any).__audioStatsSab as SharedArrayBuffer | undefined;
        let worklet: Record<string, number> | null = null;
        if (statsSab) {
            const s = new Int32Array(statsSab, 0, 16);
            worklet = {
                proc: Atomics.load(s, 0), frames: Atomics.load(s, 1),
                activeRing: Atomics.load(s, 2), activeLegacy: Atomics.load(s, 10),
                clip: Atomics.load(s, 3), limited: Atomics.load(s, 4),
                peakMilli: Atomics.load(s, 5),
                disc: Atomics.load(s, 6), maxJumpMilli: Atomics.load(s, 7),
                underrunMid: Atomics.load(s, 8), starvedBlocks: Atomics.load(s, 9),
            };
            if (opts.reset) Atomics.store(s, 15, 1);
        }
        if (opts.reset) {
            resetHostAudioStats();
        }

        const CTRL_BLOCK_BYTES = 128;
        const NAMES: Record<number, string> = {
            0: "playCursor", 1: "writeCursor", 2: "bufferBytes", 3: "channels",
            4: "sampleRate", 5: "bitsPerSample", 6: "blockAlign", 7: "state",
            8: "loopMode", 9: "volumeCb", 10: "pan", 11: "frequency",
            12: "dataLength", 13: "stopRequested", 14: "flags", 15: "reserved",
            24: "d3Mode", 31: "d3Flags",
        };

        const buffers: unknown[] = [];
        const seen = new Set<unknown>();
        for (const obj of (ds?.objects?.values?.() ?? [])) {
            const buf: any = (obj as any)?.buffer;
            if (!buf?.sab || seen.has(buf.id)) continue;
            seen.add(buf.id);
            const ctrlArr = new Int32Array(buf.sab, 0, 32);
            const ctrl: Record<string, number> = {};
            for (const [idx, name] of Object.entries(NAMES)) ctrl[name] = Atomics.load(ctrlArr, Number(idx));

            // Peak |sample| over the ring's PCM, subsampled. Reads the SAB data region
            // exactly as the worklet does, so a silent ring is distinguishable from a
            // ring the mixer merely refuses to play.
            const bits = ctrl.bitsPerSample || buf.format?.bitsPerSample || 16;
            const view = new DataView(buf.sab, CTRL_BLOCK_BYTES);
            const step = Math.max(1, Math.floor(view.byteLength / (4096 * (bits >> 3))) * (bits >> 3));
            let peak = 0;
            for (let o = 0; o + 4 <= view.byteLength; o += step) {
                const s = bits === 8 ? (view.getUint8(o) - 128) / 128
                    : bits === 32 ? view.getFloat32(o, true)
                        : view.getInt16(o, true) / 32768;
                const a = Math.abs(s);
                if (a > peak) peak = a;
            }

            buffers.push({
                id: buf.id, bytes: buf.bytes, isPlaying: !!buf.isPlaying, isLooping: !!buf.isLooping,
                streamed: !!buf.streamed, has3D: !!buf.has3D,
                fmt: buf.format ? {
                    channels: buf.format.channels, sampleRate: buf.format.sampleRate,
                    bitsPerSample: buf.format.bitsPerSample, blockAlign: buf.format.blockAlign,
                } : null,
                ctrl,
                ringPeak: Math.round(peak * 1000) / 1000,
            });
        }

        return { worklet, host: getHostAudioStats(), buffers };
    });

    /** mssStreams() — the Miles stream engine's own state, per HSTREAM.
     *
     *  "Did the radio play?" is not answerable from a screenshot and not answerable
     *  from a decode call count either. It needs three things at once, and this verb
     *  is the only place all three are visible together:
     *
     *    - `ring.playCursor` MOVING between two samples (the worklet consumed audio),
     *    - `ring.ringPeak` > 0 (what it consumed was signal, not a ring of zeros),
     *    - `ring.used` staying above 0 and `worklet.starvedBlocks` flat (it never ran
     *      dry — a stream that loops one buffered second forever has an advancing
     *      cursor and a healthy peak, and only `used` collapsing gives it away).
     *
     *  `source` is the incremental engine: `readOffset` climbing through
     *  [dataStart,dataEnd) proves the file is being consumed a slab at a time rather
     *  than re-read whole. `source:null` means the stream took the whole-file path. */
    svc.register("mssStreams", async () => {
        const mss: any = getModule("mss32");
        const ctx = mss?.ctx ?? mss?.["ctx"];
        if (!ctx) return { error: "no mss32 module" };
        const pe = await import("../../modules/mss32/playback-engine");
        const eng = await import("../../modules/mss32/stream-engine");

        const streams: unknown[] = [];
        for (const s of ctx.streams.values()) {
            const src = s.source ?? null;
            streams.push({
                id: s.id,
                handle: s.handle,
                filename: s.filename,
                format: s.fileFormat,
                sampleRate: s.sampleRate,
                channels: s.channels,
                isPlaying: !!s.isPlaying,
                isPaused: !!s.isPaused,
                loopCount: s.loopCount,
                position: s.position,
                pcmBytes: s.pcmBytes ?? null,
                hasCallback: (ctx.streamCallbacks?.get(s.handle) ?? 0) !== 0,
                wholeFileBytes: s.fileData?.length ?? null,
                source: src ? {
                    fileHandle: src.fileHandle,
                    fileSize: src.fileSize,
                    dataStart: src.dataStart,
                    dataEnd: src.dataEnd,
                    readOffset: src.readOffset,
                    cursor: src.cursor,
                    framesDecoded: src.framesDecoded,
                    totalFrames: src.totalFrames,
                    blockBytes: src.blockBytes,
                    busy: !!src.busy,
                    exhausted: !!src.exhausted,
                    pendingFloats: src.pending ? src.pending.floats.length - src.pending.at : 0,
                } : null,
                ring: pe.describeRing(s.id),
            });
        }
        return { streams, count: streams.length, engine: { ...eng.streamEngineStats } };
    });

    /** mssSamples() — the Miles VOICE pool, per HSAMPLE. The sample-side twin of
     *  mssStreams, and the answer to "the SFX are silent but everything looks fine".
     *
     *  A voice that is allocated, configured and started but carries no audio is
     *  silence with paperwork, and NOTHING upstream reports it: allocate succeeds,
     *  start_sample returns 1, the guest's status reads PLAYING. The three fields
     *  that separate a sounding voice from a silent one are:
     *
     *    - `pcmFrames` > 0 (the voice HAS decoded audio at all; 0 means whatever
     *      configured it — set_sample_file / set_sample_info / an unimplemented
     *      export — never handed us bytes),
     *    - `ring` non-null with `ringPeak` > 0 (the SAB carries signal, not zeros),
     *    - `ring.playCursor` MOVING between two calls (the worklet consumes it).
     *
     *  `configuredEmpty` is the census that matters: voices the guest pointed at a
     *  source buffer that decoded to nothing. That is where a dropped configuration
     *  path actually shows up, because playSample refuses a voice with no data and
     *  clears isPlaying — so the voice never reaches a "playing but silent" state and
     *  `silentStarted` stays 0 through the whole bug. Read `configuredEmpty` first;
     *  `silentStarted` only covers the narrower case of a started voice losing its
     *  data afterwards. Encoded samples (mp3/ogg) legitimately have no PCM and no
     *  ring — they play on a host media element — so they are excluded from both and
     *  counted under `encodedPlaying`. */
    svc.register("mssSamples", async () => {
        const mss: any = getModule("mss32");
        const ctx = mss?.ctx ?? mss?.["ctx"];
        if (!ctx) return { error: "no mss32 module" };
        const pe = await import("../../modules/mss32/playback-engine");

        const samples: unknown[] = [];
        let silentStarted = 0;
        let encodedPlaying = 0;
        let sounding = 0;
        let configuredEmpty = 0;
        for (const s of ctx.samples.values()) {
            const pcmFrames = s.decodedData && s.channels > 0 ? (s.decodedData.length / s.channels) | 0 : 0;
            const ring = pe.describeRing(s.id);
            const encoded = s.fileFormat === "mp3" || s.fileFormat === "ogg";
            const srcBytes = s.fileData?.length ?? 0;
            if (srcBytes > 0 && pcmFrames === 0 && !encoded) configuredEmpty++;
            if (s.isPlaying) {
                if (encoded && !pcmFrames) encodedPlaying++;
                else if (!pcmFrames) silentStarted++;
                else sounding++;
            }
            samples.push({
                id: s.id,
                handle: s.handle,
                is3D: !!s.is3D,
                format: s.fileFormat ?? null,
                sampleRate: s.sampleRate,
                channels: s.channels,
                bits: s.bitsPerSample,
                formatTag: s.formatTag,
                isPlaying: !!s.isPlaying,
                isStopped: !!s.isStopped,
                pendingStart: !!s.pendingStart,
                loopCount: s.loopCount,
                volume: s.volume,
                position: s.position,
                pcmBytes: s.pcmBytes ?? null,
                pcmFrames,
                srcBytes,
                srcAddr: s.fileDataAddress ?? 0,
                ring,
            });
        }
        return {
            samples,
            count: samples.length,
            playing: silentStarted + encodedPlaying + sounding,
            sounding,
            encodedPlaying,
            silentStarted,
            configuredEmpty,
        };
    });
}
