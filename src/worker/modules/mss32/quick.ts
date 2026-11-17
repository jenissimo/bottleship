import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { MemoryGuard } from "../../core/memory/mem-guard";
import type { MSSContext, MSSQuickAudio } from "./context";
import { createSampleExports } from "./sample";
import { decodeAudioFile, parseWav } from "./audio-decode";
import { isEncodedFormat } from "./helpers";
import { probeAudioAt } from "@bottleship/formats/audio";
import { releaseRingBuffer, updateEmulatorState } from "./playback-engine";

// Miles 6.0d quick status is NOT the HSAMPLE SMP_* bit mask. Its loader writes
// 2, play writes 3, and the native EOS callback writes 1 (quick_status(NULL)=1).
export const QSTAT_DONE = 1;
export const QSTAT_LOADED = 2;
export const QSTAT_PLAYING = 3;

function imageAt(mem: Uint8Array, at: number, length: number): Uint8Array | null {
    return at !== 0 && length > 0 && MemoryGuard.isValidRange(mem, at, length)
        ? mem.subarray(at, at + length) : null;
}

function supportedImage(image: Uint8Array): boolean {
    // The cheap header-only sniff accepts MPEG-looking PCM/garbage too; a
    // complete quick image must have a valid encoded-audio probe before routing.
    const info = probeAudioAt(image, 0, image.byteLength);
    if (info?.format === "mp3" || info?.format === "ogg") return info.sampleRate > 0 && info.channels > 0;
    const wav = parseWav(image);
    if (!wav || wav.channels < 1 || wav.channels > 2 || wav.sampleRate <= 0 || wav.data.byteLength === 0) return false;
    // Admit layouts the shared decoder actually implements, rather than let its
    // unknown-layout fallback manufacture silence for e.g. IEEE float64 WAV.
    if (wav.formatTag === 1 || wav.formatTag === 3) {
        const bits = wav.bitsPerSample;
        return (wav.formatTag === 1 ? [8, 16, 24, 32].includes(bits) : bits === 32)
            && wav.blockAlign >= wav.channels * (bits / 8) && wav.data.byteLength >= wav.blockAlign;
    }
    if (wav.formatTag === 2 || wav.formatTag === 17) {
        const header = (wav.formatTag === 2 ? 7 : 4) * wav.channels;
        return wav.bitsPerSample === 4 && wav.blockAlign >= header && wav.data.byteLength >= header;
    }
    return false;
}

function releaseVoice(ctx: MSSContext, audio: MSSQuickAudio, mem: Uint8Array): void {
    const sample = ctx.samples.get(audio.sampleHandle);
    if (sample && sample.id === audio.sampleId) {
        // Use the ordinary owner to stop encoded audio and release the guest slot.
        createSampleExports(ctx)["_AIL_release_sample_handle@4"]!(null as never, mem, [sample.handle]);
    }
    if (audio.sampleId) releaseRingBuffer(audio.sampleId);
    audio.sampleHandle = 0;
    audio.sampleId = 0;
}

/** Also called before driver shutdown and module reset, while sample slots exist. */
export function unloadQuickAudio(ctx: MSSContext, handle: number, mem: Uint8Array): void {
    const audio = ctx.quickAudio.get(handle);
    if (!audio) return;
    releaseVoice(ctx, audio, mem);
    ctx.quickAudio.delete(handle);
    ctx.process.memory.free(handle);
    // load_mem borrows the caller's image. It must never free that allocation.
}

export function clearQuickAudio(ctx: MSSContext): void {
    if (!ctx.quickAudio?.size) return;
    const mem = ctx.process.getCurrentMemory();
    for (const handle of ctx.quickAudio.keys()) unloadQuickAudio(ctx, handle, mem);
}

/** Release naturally completed voices even if the caller never polls quick_status. */
export function serviceQuickAudio(ctx: MSSContext): void {
    if (!ctx.quickAudio?.size) return;
    const mem = ctx.process.getCurrentMemory();
    for (const audio of ctx.quickAudio.values()) {
        if (audio.status !== QSTAT_PLAYING) continue;
        const sample = ctx.samples.get(audio.sampleHandle);
        if (!sample || sample.id !== audio.sampleId || !sample.isPlaying) {
            releaseVoice(ctx, audio, mem);
            audio.status = QSTAT_DONE;
        }
    }
}

export function createQuickExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const samples = createSampleExports(ctx);

    exports["_AIL_quick_load_mem@8"] = (ctxThunk, mem, args) => {
        const imageAddress = args[0] >>> 0, imageLength = args[1] >>> 0;
        const image = imageAt(mem, imageAddress, imageLength);
        if (!ctx.digitalDriverHandle || !image || !supportedImage(image)) {
            ctx.lastErrorStr = "Quick audio requires a digital driver and a supported sound image";
            return 0;
        }
        // HAUDIO is opaque. Unlike an HSAMPLE, a loaded HAUDIO does not consume a
        // mixer voice; native quick_play allocates one only when playback begins.
        const handle = ctx.process.memory.alloc(0x48);
        if (!handle) { ctx.lastErrorStr = "Out of memory for quick audio"; return 0; }
        ctx.quickAudio.set(handle, { handle, imageAddress, imageLength,
            sampleHandle: 0, sampleId: 0, status: QSTAT_LOADED, volume: -1, pan: -1 });
        return handle;
    };

    exports["_AIL_quick_play@8"] = (ctxThunk, mem, args) => {
        const audio = ctx.quickAudio.get(args[0] >>> 0);
        if (!audio) return 0;
        releaseVoice(ctx, audio, mem);
        audio.status = QSTAT_DONE;
        const image = imageAt(mem, audio.imageAddress, audio.imageLength);
        if (!ctx.digitalDriverHandle || !image || !supportedImage(image)) {
            ctx.lastErrorStr = "Quick audio image is no longer available";
            return 0;
        }
        const handle = samples["_AIL_allocate_sample_handle@4"]!(ctxThunk, mem, [ctx.digitalDriverHandle]);
        if (typeof handle !== "number" || !handle) return 0;
        const sample = ctx.samples.get(handle)!;
        audio.sampleHandle = handle;
        audio.sampleId = sample.id;
        sample.fileData = image.slice();
        sample.fileDataAddress = audio.imageAddress;
        sample.fileDataAllocated = false;
        decodeAudioFile(ctx, sample);
        if (!(sample.decodedData?.length) && !isEncodedFormat(sample.fileFormat)) {
            releaseVoice(ctx, audio, mem);
            ctx.lastErrorStr = "Unsupported quick audio encoding";
            return 0;
        }
        sample.playbackRateHz = sample.sampleRate;
        sample.loopCount = args[1] >>> 0; // 0 repeats indefinitely; N plays N times.
        if (audio.volume !== -1) samples["_AIL_set_sample_volume@8"]!(ctxThunk, mem, [handle, audio.volume]);
        if (audio.pan !== -1) samples["_AIL_set_sample_pan@8"]!(ctxThunk, mem, [handle, audio.pan]);
        samples["_AIL_start_sample@4"]!(ctxThunk, mem, [handle]);
        if (!sample.isPlaying) {
            releaseVoice(ctx, audio, mem);
            return 0;
        }
        audio.status = QSTAT_PLAYING;
        return 1;
    };

    exports["_AIL_quick_status@4"] = (ctxThunk, mem, args) => {
        const audio = ctx.quickAudio.get(args[0] >>> 0);
        if (!audio) return QSTAT_DONE;
        if (audio.status === QSTAT_PLAYING) updateEmulatorState(ctx);
        return audio.status;
    };

    exports["_AIL_quick_set_volume@12"] = (ctxThunk, mem, args) => {
        const audio = ctx.quickAudio.get(args[0] >>> 0);
        if (!audio) return 0;
        // Native retains both S32 arguments, including -1. That sentinel leaves
        // the CURRENT voice unchanged and lets a LATER play use its fresh default.
        audio.volume = args[1] | 0;
        audio.pan = args[2] | 0;
        const sample = ctx.samples.get(audio.sampleHandle);
        if (sample && sample.id === audio.sampleId) {
            if (audio.volume !== -1) samples["_AIL_set_sample_volume@8"]!(ctxThunk, mem, [sample.handle, audio.volume]);
            if (audio.pan !== -1) samples["_AIL_set_sample_pan@8"]!(ctxThunk, mem, [sample.handle, audio.pan]);
        }
        return 0;
    };

    exports["_AIL_quick_halt@4"] = (ctxThunk, mem, args) => {
        const audio = ctx.quickAudio.get(args[0] >>> 0);
        if (audio) { releaseVoice(ctx, audio, mem); audio.status = QSTAT_DONE; }
        return 0;
    };
    exports["_AIL_quick_unload@4"] = (ctxThunk, mem, args) => {
        unloadQuickAudio(ctx, args[0] >>> 0, mem);
        return 0;
    };
    for (const [name, fn] of Object.entries(exports)) {
        exports[name.replace(/^_/, "").replace(/@\d+$/, "")] = fn;
    }
    return exports;
}
