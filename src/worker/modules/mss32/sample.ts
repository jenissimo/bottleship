import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { isValidAddress } from "../../core/memory/address-guard";
import { MSSContext, SMP_DONE, SMP_FREE, SMP_PLAYING, SMP_PLAYINGBUTRELEASED, SMP_STOPPED } from "./context";
import { MSSSample } from "./types";
import {
    ensureDriverHandle, getBytesPerSecond, getMemory, makeView,
    setSampleStatus, updateSampleMemory, refreshSampleLenDone,
    readFilenameArg, isEncodedFormat, MSS_SAMPLE_STRUCT_SIZE,
    computeSampleVolumes, getPlaybackLengthBytes, writeSamplePosition,
} from "./helpers";
import {
    AILSOUNDINFO_SIZE, DIG_F_16BITS_MASK, DIG_F_ADPCM_MASK, DIG_F_STEREO_MASK,
    convertToFloat, decodeAudioFile, readAilSoundInfo,
} from "./audio-decode";
import { playSample, updateSamplePlayback, stopRingBuffer, resumeRingBuffer, seekRingBuffer, applySample3D } from "./playback-engine";
import { System } from "../../core/system";
import { i32ToFloat } from "../../../audio/audio-ring-buffer";
import { ensureListener3D, writeListener3D } from "./spatial";

export function createSampleExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_allocate_sample_handle@4
    // Real MSS32: scans the sample array at driver[0x34] for a slot with status==SMP_FREE,
    // marks it in-use, returns pointer into the array.  We do the same.
    exports["_AIL_allocate_sample_handle@4"] = (ctxThunk, mem, args) => {
        let dig = args[0] || ctx.digitalDriverHandle;
        if (!dig) {
            dig = ensureDriverHandle(ctx, mem);
        }

        if (!ctx.driverSampleArray) {
            Logger.error(LogCategory.SYSTEM, 'MSS32: _AIL_allocate_sample_handle@4: no sample array!');
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const stride = MSS_SAMPLE_STRUCT_SIZE;  // 0x284

        // Find a free slot (status == SMP_FREE at [+0x08]).
        let handle = 0;
        for (let i = 0; i < ctx.driverMaxSamples; i++) {
            const slotBase = ctx.driverSampleArray + i * stride;
            const status = view.getUint32(slotBase + 0x08, true);
            if (status === SMP_FREE) {
                handle = slotBase;
                break;
            }
        }
        if (!handle) {
            Logger.warn(LogCategory.SYSTEM, 'MSS32: _AIL_allocate_sample_handle@4: all slots in use');
            return 0;
        }

        const sampleId = ctx.nextSampleId++;

        // Full initialization matching real MSS32 FUN_2100f1b0
        initSampleStruct(view, handle, dig);

        const sample: MSSSample = {
            id: sampleId,
            handle: handle,
            fileData: null,
            decodedData: null,
            sampleRate: 22050,
            channels: 1,
            bitsPerSample: 16,
            formatTag: 1,
            blockAlign: 2,
            volume: 127,
            pan: 64,
            playbackRate: 1.0,
            playbackRateHz: 22050,
            loopCount: 1,
            isPlaying: false,
            isStopped: false,
            position: 0,
            pendingStart: false,
            fileDataAllocated: false,
        };

        ctx.samples.set(handle, sample);
        ctx.samplesById.set(sample.id, sample);
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_allocate_sample_handle@4 -> 0x${handle.toString(16)} (driver=0x${dig.toString(16)}, slot in array)`);
        return handle;
    };

    // _AIL_release_sample_handle@4
    // Real MSS32: resets the slot status to SMP_FREE so it can be reused.
    // Real MSS32 FUN_21011500: end_sample + set +0x08=SMP_FREE + clear processor
    exports["_AIL_release_sample_handle@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const sample = ctx.samples.get(handle);
        if (sample) {
            // Stop playback
            if (sample.isPlaying || sample.isStopped) {
                if (!stopRingBuffer(sample.id)) {
                    self.postMessage({ type: "audio_stop", payload: { id: sample.id } });
                }
            }
            ctx.samplesById.delete(sample.id);

            // Mark slot as free — real MSS32 just sets SMP_FREE, doesn't full-zero
            // +0x00 is type tag, NOT status — don't touch it
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(handle + 0x08, SMP_FREE, true);   // real MSS32 free marker
            view.setInt32(handle + 0x110, -1, true);
        }
        ctx.samples.delete(handle);
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_release_sample_handle@4: 0x${handle.toString(16)}`);
        return 0;
    };

    // _AIL_init_sample@4
    exports["_AIL_init_sample@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_init_sample@4: handle=0x${handle.toString(16)}`);
        const sampleObj = ctx.samples.get(handle);
        if (!sampleObj) {
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_init_sample@4: 0x${handle.toString(16)} (not found)`);
            return 1;
        }

        // Stop current playback if active
        if (sampleObj.isPlaying || sampleObj.isStopped) {
            if (!stopRingBuffer(sampleObj.id)) {
                self.postMessage({ type: "audio_stop", payload: { id: sampleObj.id } });
            }
        }

        // Reset runtime state to defaults
        sampleObj.volume = 127;
        sampleObj.pan = 64;
        sampleObj.playbackRate = 1.0;
        sampleObj.playbackRateHz = 22050;
        sampleObj.loopCount = 1;
        sampleObj.isPlaying = false;
        sampleObj.isStopped = false;
        sampleObj.pendingStart = false;
        sampleObj.position = 0;
        sampleObj.startTime = undefined;
        sampleObj.lastAudioPositionTime = undefined;
        sampleObj.lastAudioPositionBytes = undefined;
        sampleObj.lastRingCursorBytes = undefined;
        sampleObj.lastRingCursorTime = undefined;

        // Full guest struct reinitialization (matching real MSS32)
        const dig = ctx.digitalDriverHandle;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        initSampleStruct(view, handle, dig);

        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_init_sample@4: 0x${handle.toString(16)} (reset)`);
        return 1;
    };

    // _AIL_start_sample@4
    exports["_AIL_start_sample@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_start_sample@4: handle=0x${handle.toString(16)}`);

        const sampleObj = ctx.samples.get(handle);
        if (!sampleObj) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_sample@4: Invalid sample`);
            return 0;
        }

        if (sampleObj.isStopped) {
            if (!resumeRingBuffer(sampleObj.id)) {
                self.postMessage({ type: "audio_resume", payload: { id: sampleObj.id } });
            }
            sampleObj.isStopped = false;
            sampleObj.isPlaying = true;
            sampleObj.pendingStart = false;
            const bytesPerSec = getBytesPerSecond(sampleObj) * (sampleObj.playbackRate || 1.0);
            if (bytesPerSec > 0) {
                sampleObj.startTime = performance.now() - (sampleObj.position / bytesPerSec) * 1000.0;
            } else {
                sampleObj.startTime = performance.now();
            }
            setSampleStatus(ctx, sampleObj, SMP_PLAYING);
            return 1;
        }

        sampleObj.startTime = performance.now();

        if (sampleObj.fileData && !sampleObj.decodedData && !isEncodedFormat(sampleObj.fileFormat)) {
            decodeAudioFile(ctx, sampleObj);
            if (!sampleObj.decodedData && !isEncodedFormat(sampleObj.fileFormat)) {
                Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_sample@4: file data present but unsupported, marking DONE`);
                sampleObj.pendingStart = false;
                sampleObj.isPlaying = false;
                sampleObj.isStopped = false;
                sampleObj.startTime = undefined;
                setSampleStatus(ctx, sampleObj, SMP_DONE);
                return 0;
            }
        }

        if (sampleObj.fileData && isEncodedFormat(sampleObj.fileFormat)) {
            playSample(ctx, sampleObj);
            return sampleObj.isPlaying ? 1 : 0;
        }

        if (sampleObj.decodedData && sampleObj.decodedData.length > 0) {
            playSample(ctx, sampleObj);
            return sampleObj.isPlaying ? 1 : 0;
        }

        if (sampleObj.fileData) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_sample@4: file data present but no playable data, marking DONE`);
            sampleObj.pendingStart = false;
            sampleObj.isPlaying = false;
            sampleObj.isStopped = false;
            sampleObj.startTime = undefined;
            setSampleStatus(ctx, sampleObj, SMP_DONE);
            return 0;
        }

        Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_sample@4: No data yet, deferring start`);
        sampleObj.pendingStart = true;
        sampleObj.isStopped = false;
        return 1;
    };

    // _AIL_stop_sample@4
    exports["_AIL_stop_sample@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_stop_sample@4 called: sample=0x${handle.toString(16)}`);

        const sampleObj = ctx.samples.get(handle);
        if (sampleObj?.isPlaying) {
            if (!stopRingBuffer(sampleObj.id)) {
                self.postMessage({ type: "audio_pause", payload: { id: sampleObj.id } });
            }
            sampleObj.isPlaying = false;
            sampleObj.pendingStart = false;
            sampleObj.isStopped = true;
            setSampleStatus(ctx, sampleObj, SMP_STOPPED);
            return 0;
        }

        if (sampleObj?.pendingStart) {
            sampleObj.isPlaying = false;
            sampleObj.pendingStart = false;
            sampleObj.isStopped = false;
            setSampleStatus(ctx, sampleObj, SMP_DONE);
        }
        return 0;
    };

    // _AIL_resume_sample@4
    exports["_AIL_resume_sample@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_resume_sample@4: handle=0x${handle.toString(16)}`);
        const sampleObj = ctx.samples.get(handle);
        if (sampleObj?.isStopped) {
            if (!resumeRingBuffer(sampleObj.id)) {
                self.postMessage({ type: "audio_resume", payload: { id: sampleObj.id } });
            }
            sampleObj.isStopped = false;
            sampleObj.isPlaying = true;
            sampleObj.pendingStart = false;
            const bytesPerSec = getBytesPerSecond(sampleObj) * (sampleObj.playbackRate || 1.0);
            if (bytesPerSec > 0) {
                sampleObj.startTime = performance.now() - (sampleObj.position / bytesPerSec) * 1000.0;
            } else {
                sampleObj.startTime = performance.now();
            }
            setSampleStatus(ctx, sampleObj, SMP_PLAYING);
            return 1;
        }
        return exports["_AIL_start_sample@4"]!(ctxThunk, mem, [handle]);
    };

    // _AIL_end_sample@4
    exports["_AIL_end_sample@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_end_sample@4: handle=0x${handle.toString(16)}`);

        const sampleObj = ctx.samples.get(handle);
        if (sampleObj) {
            if (sampleObj.isPlaying || sampleObj.isStopped) {
                if (!stopRingBuffer(sampleObj.id)) {
                    self.postMessage({ type: "audio_stop", payload: { id: sampleObj.id } });
                }
            }
            sampleObj.isPlaying = false;
            sampleObj.isStopped = false;
            sampleObj.position = 0;
            sampleObj.pendingStart = false;
            setSampleStatus(ctx, sampleObj, SMP_DONE);
        }
        return 0;
    };

    // _AIL_sample_status@4
    exports["_AIL_sample_status@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        const sampleObj = ctx.samples.get(handle);
        if (!sampleObj) {
            // A released (or never-allocated) slot is still a real HSAMPLE in the driver's
            // sample array, and its status word lives at +0x08 — release_sample_handle stamps
            // SMP_FREE there. 0 is NOT a Miles status, and answering it strands the documented
            // teardown loop `end_sample; release_sample_handle; while (status != SMP_FREE);`
            // (ZenGin's zCSndSys_MSS does exactly this) in an unbreakable spin.
            const slotStatus = isValidAddress(mem, handle + 0x08, 4)
                ? makeView(mem).getUint32(handle + 0x08, true)
                : 0;
            const status = (slotStatus === SMP_FREE || slotStatus === SMP_DONE
                || slotStatus === SMP_PLAYING || slotStatus === SMP_STOPPED)
                ? slotStatus
                : SMP_FREE;
            Logger.log(LogCategory.SYSTEM,
                `MSS32: _AIL_sample_status@4: handle=0x${handle.toString(16)} → ${status} (slot, no JS sample)`);
            return status;
        }
        const status = sampleObj.isStopped ? SMP_STOPPED : (sampleObj.isPlaying || sampleObj.pendingStart) ? SMP_PLAYING : SMP_DONE;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_sample_status@4: handle=0x${handle.toString(16)} → ${status} (${status === SMP_DONE ? 'DONE' : status === SMP_PLAYING ? 'PLAYING' : 'STOPPED'})`);
        return status;
    };

    // _AIL_set_sample_volume@8
    exports["_AIL_set_sample_volume@8"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_sample_volume@8: handle=0x${args[0].toString(16)} vol=${args[1]}`);
        const sampleObj = ctx.samples.get(args[0]);
        if (sampleObj) {
            sampleObj.volume = Math.max(0, Math.min(127, args[1]));
            const m = getMemory(ctx);
            const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
            // Dual-write: legacy +0x38, real MSS32 +0x5C
            MemoryGuard.writeUint32(m, view, sampleObj.handle + 0x38, sampleObj.volume >>> 0, "MSS32:set_volume:legacy");
            MemoryGuard.writeUint32(m, view, sampleObj.handle + 0x5C, sampleObj.volume >>> 0, "MSS32:set_volume:real");
            computeSampleVolumes(view, sampleObj.handle, ctx.digitalDriverHandle);
            if (sampleObj.isPlaying) updateSamplePlayback(ctx, sampleObj);
        }
        return 0;
    };

    // _AIL_set_sample_pan@8
    exports["_AIL_set_sample_pan@8"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_sample_pan@8: handle=0x${args[0].toString(16)} pan=${args[1]}`);
        const s = ctx.samples.get(args[0]);
        if (!s) return 0;
        s.pan = Math.max(0, Math.min(127, args[1] | 0));
        const m = getMemory(ctx);
        const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
        // Dual-write: legacy +0x3C, real MSS32 +0x60
        MemoryGuard.writeUint32(m, view, s.handle + 0x3C, s.pan >>> 0, "MSS32:set_pan:legacy");
        MemoryGuard.writeUint32(m, view, s.handle + 0x60, s.pan >>> 0, "MSS32:set_pan:real");
        computeSampleVolumes(view, s.handle, ctx.digitalDriverHandle);
        if (s.isPlaying) updateSamplePlayback(ctx, s);
        return 0;
    };

    // _AIL_set_sample_playback_rate@8
    exports["_AIL_set_sample_playback_rate@8"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_sample_playback_rate@8: handle=0x${args[0].toString(16)} rate=${args[1]}`);
        const s = ctx.samples.get(args[0]);
        if (!s) return 0;
        const base = Math.max(1, s.sampleRate | 0);
        const hz = Math.max(1, args[1] | 0);
        s.playbackRateHz = hz;
        s.playbackRate = hz / base;
        const m = getMemory(ctx);
        const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
        // Dual-write: legacy +0x34, real MSS32 +0x58
        MemoryGuard.writeUint32(m, view, s.handle + 0x34, hz >>> 0, "MSS32:set_rate:legacy");
        MemoryGuard.writeUint32(m, view, s.handle + 0x58, hz >>> 0, "MSS32:set_rate:real");
        if (s.isPlaying) updateSamplePlayback(ctx, s);
        return 0;
    };

    // _AIL_set_sample_loop_count@8
    exports["_AIL_set_sample_loop_count@8"] = (ctxThunk, mem, args) => {
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_sample_loop_count@8: handle=0x${args[0].toString(16)} count=${args[1]}`);
        const sampleObj = ctx.samples.get(args[0]);
        if (sampleObj) {
            sampleObj.loopCount = args[1];
            const m = getMemory(ctx);
            const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
            // Dual-write: legacy +0x20, real MSS32 +0x28
            MemoryGuard.writeUint32(m, view, sampleObj.handle + 0x20, args[1] >>> 0, "MSS32:set_loop:legacy");
            MemoryGuard.writeUint32(m, view, sampleObj.handle + 0x28, args[1] >>> 0, "MSS32:set_loop:real");
            if (sampleObj.isPlaying) updateSamplePlayback(ctx, sampleObj);
        }
        return 0;
    };

    // _AIL_set_sample_file@12
    exports["_AIL_set_sample_file@12"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const filePtr = args[1];
        const block = args[2];

        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_sample_file@12: sample=0x${sample.toString(16)}, filePtr=0x${filePtr.toString(16)}, block=${block}`);

        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_set_sample_file@12: Invalid sample handle`);
            return 0;
        }
        sampleObj.isStopped = false;
        // Real Miles AIL_set_sample_file auto-inits the sample, resetting loop
        // state to the one-shot default (loop_count=1). Games rely on this: Re-Volt
        // (GOG) reuses a fixed pool of 3D voices, doing set_file -> start_sample per
        // sound and only calling AIL_set_sample_loop_count(0) AFTER set_file for
        // genuinely looping sounds. Without this reset a stale loop_count from a
        // prior use of the voice persists, so every reused voice loops forever and
        // the pool saturates — i.e. every one-shot SFX loops. (mss.h SAMPLE.loop_count
        // doc: "1=one-shot, 0=indefinite".)
        resetSampleLoopState(sampleObj);

        if (filePtr) {
            const memSize = mem.byteLength;
            let detectedSize = 0;
            const MAX_SANE_BLOCK = 50 * 1024 * 1024;
            if (block > 0 && block < MAX_SANE_BLOCK) {
                detectedSize = Math.min(block, memSize - filePtr);
            } else if (filePtr + 8 <= memSize && mem[filePtr] === 0x52 && mem[filePtr + 1] === 0x49) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const riffSize = view.getUint32(filePtr + 4, true);
                const MAX_REASONABLE_WAV = 50 * 1024 * 1024;
                if (riffSize > 0 && riffSize < MAX_REASONABLE_WAV) {
                    detectedSize = Math.min(riffSize + 8, memSize - filePtr);
                } else {
                    Logger.warn(LogCategory.SYSTEM, `MSS32: RIFF size ${riffSize} looks suspicious, using 1MB cap`);
                    detectedSize = Math.min(1024 * 1024, memSize - filePtr);
                }
            } else {
                detectedSize = Math.min(1024 * 1024, memSize - filePtr);
            }

            if (detectedSize <= 0) {
                Logger.warn(LogCategory.SYSTEM, `MSS32: Invalid file size detected`);
                return 0;
            }

            sampleObj.fileData = mem.slice(filePtr, filePtr + detectedSize);
            sampleObj.fileDataAllocated = false;
            sampleObj.fileDataAddress = filePtr;
            updateSampleMemory(ctx, sampleObj, filePtr, detectedSize);
            decodeAudioFile(ctx, sampleObj);
        }
        return 1;
    };

    // _AIL_set_named_sample_file@20
    exports["_AIL_set_named_sample_file@20"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const fileSuffixPtr = args[1]; // MSS32 file_suffix: format hint (".mp3", "frontend.mp3", etc.)
        const fileNamePtr = args[2];   // file_image: pointer to audio data in guest memory
        const fileOffsetRaw = args[3] | 0;
        const fileSizeRaw = args[4] | 0;
        const fileOffset = Math.max(0, fileOffsetRaw);
        const fileSize = fileSizeRaw < 0 ? 0 : fileSizeRaw;

        const fileSuffix = fileSuffixPtr ? readFilenameArg(mem, fileSuffixPtr) : null;
        const fileName = readFilenameArg(mem, fileNamePtr);
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_named_sample_file@20 called: sample=0x${sample.toString(16)}, suffix="${fileSuffix ?? ''}", fileImagePtr=0x${fileNamePtr.toString(16)}, offset=${fileOffset}, size=${fileSize}`);

        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_set_named_sample_file@20: Invalid sample handle`);
            return 0;
        }
        // Auto-init the sample like real Miles (see _AIL_set_sample_file@12).
        resetSampleLoopState(sampleObj);

        if (fileName) {
            Logger.verbose(LogCategory.SYSTEM, `MSS32: Loading sample file: "${fileName}"`);
            loadSampleFile(ctx, sampleObj, fileName, fileOffset, fileSize, fileSuffix ?? undefined).catch(e => {
                Logger.error(LogCategory.SYSTEM, `MSS32: Error loading file ${fileName}: ${e}`);
            });
        } else {
            const bufferSize = fileSize > 0 ? fileSize : (fileOffset > 0 ? fileOffset : 0);
            if (bufferSize > 0 && MemoryGuard.isValidRange(mem, fileNamePtr, bufferSize)) {
                Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_set_named_sample_file@20: Loading memory image (size=${bufferSize}, format hint="${fileSuffix ?? 'none'}")`);
                sampleObj.fileData = mem.slice(fileNamePtr, fileNamePtr + bufferSize);
                sampleObj.fileDataAllocated = false;
                sampleObj.fileDataAddress = fileNamePtr;
                updateSampleMemory(ctx, sampleObj, fileNamePtr, bufferSize);
                decodeAudioFile(ctx, sampleObj, fileSuffix ?? undefined);
            } else {
                Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_set_named_sample_file@20: Invalid file image pointer 0x${fileNamePtr.toString(16)}`);
            }
        }
        return 1;
    };

    // S32 AIL_set_sample_info(HSAMPLE S, AILSOUNDINFO const *info)
    //
    // The memory-image twin of AIL_set_sample_file: rather than a file to parse, the app
    // hands Miles a buffer it has already described — format, data pointer, length, rate,
    // bits, channels, block size. A title that loads one bank into memory once and plays
    // slices out of it never calls set_sample_file at all, so a missing set_sample_info
    // leaves the voice allocated, "configured" into nothing, and silent while every status
    // the guest can read says PLAYING.
    //
    // `format` is the DIG_F_* bitmask AIL_WAV_info emits (this module's own convention,
    // and what _AIL_decompress_ADPCM@12 already reads); WAVE_FORMAT_IMA_ADPCM (17) is
    // accepted too since it cannot collide with a DIG_F value (0..7). DIG_F says only
    // "ADPCM or not" — which ADPCM flavour comes from the AIL_WAV_info that described
    // this same buffer, exactly as decompress_ADPCM resolves it.
    const setSampleInfo: ThunkImplementation = (ctxThunk, mem, args) => {
        const handle = args[0];
        const infoPtr = args[1];

        const sampleObj = ctx.samples.get(handle);
        if (!sampleObj) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: AIL_set_sample_info: invalid sample handle 0x${handle.toString(16)}`);
            return 0;
        }
        if (!infoPtr || !isValidAddress(mem, infoPtr, AILSOUNDINFO_SIZE, "r")) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: AIL_set_sample_info: unreadable AILSOUNDINFO at 0x${infoPtr.toString(16)}`);
            return 0;
        }
        const info = readAilSoundInfo(mem, infoPtr);
        if (!info) return 0;

        if (!info.dataPtr || info.dataLen <= 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: AIL_set_sample_info: empty sound image (ptr=0x${info.dataPtr.toString(16)} len=${info.dataLen})`);
            return 0;
        }
        // Whole extent up front, against the region map — the app owns this buffer and it
        // is the only thing standing between a bogus data_len and a read off a live region.
        if (!isValidAddress(mem, info.dataPtr, info.dataLen, "r")) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: AIL_set_sample_info: sound image out of bounds ptr=0x${info.dataPtr.toString(16)} len=${info.dataLen}`);
            return 0;
        }

        const isAdpcm = (info.format & DIG_F_ADPCM_MASK) !== 0 || info.format === 17;
        const channels = info.channels > 0 ? info.channels : ((info.format & DIG_F_STEREO_MASK) ? 2 : 1);
        const bits = info.bits > 0 ? info.bits : (isAdpcm ? 4 : ((info.format & DIG_F_16BITS_MASK) ? 16 : 8));
        const formatTag = isAdpcm
            ? (ctx.wavFormatByDataPtr.get(info.dataPtr) ?? 17)
            : (bits === 32 ? 3 : 1);
        // block_size describes an ADPCM block and is meaningless for PCM, where the frame
        // size is fixed by channels x bits. Apps leave it uninitialized on the PCM path —
        // GTA III's carries a leftover stack address — so reading it there turns a good
        // sample into a fraction of itself or into nothing at all.
        const blockAlign = isAdpcm && info.blockSize > 0
            ? info.blockSize
            : channels * Math.max(1, bits >> 3);

        // Real Miles auto-inits the sample here, same as set_sample_file — loop state goes
        // back to the one-shot default, or a reused voice inherits the last sound's looping.
        resetSampleLoopState(sampleObj);
        sampleObj.isStopped = false;

        sampleObj.fileData = mem.slice(info.dataPtr, info.dataPtr + info.dataLen);
        sampleObj.fileDataAllocated = false;
        sampleObj.fileDataAddress = info.dataPtr;
        sampleObj.fileFormat = "wav";
        sampleObj.sampleRate = info.rate > 0 ? info.rate : 22050;
        sampleObj.channels = channels;
        sampleObj.bitsPerSample = bits;
        sampleObj.formatTag = formatTag;
        sampleObj.blockAlign = blockAlign;
        sampleObj.encodedDurationMs = undefined;
        sampleObj.decodedData = convertToFloat(sampleObj.fileData, channels, bits, formatTag, blockAlign);
        // len/done are SOURCE bytes — what the app seeks in — not decoded floats.
        sampleObj.pcmBytes = info.dataLen;

        updateSampleMemory(ctx, sampleObj, info.dataPtr, info.dataLen);
        refreshSampleLenDone(ctx, sampleObj);

        Logger.log(
            LogCategory.SYSTEM,
            `MSS32: AIL_set_sample_info: sample=0x${handle.toString(16)} fmt=${info.format}${isAdpcm ? `(adpcm tag=${formatTag})` : ""} ` +
            `${channels}ch ${sampleObj.sampleRate}Hz ${bits}bit data=0x${info.dataPtr.toString(16)} len=${info.dataLen} -> ${sampleObj.decodedData.length} floats`
        );

        if (sampleObj.decodedData.length === 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: AIL_set_sample_info: decoded 0 samples from ${info.dataLen} bytes (fmt=${info.format} ${bits}bit block=${blockAlign})`);
            return 0;
        }
        if (sampleObj.pendingStart) {
            playSample(ctx, sampleObj);
        }
        return 1;
    };
    exports["_AIL_set_sample_info@8"] = setSampleInfo;
    exports["AIL_set_sample_info"] = setSampleInfo;

    // _AIL_set_sample_address@8
    exports["_AIL_set_sample_address@8"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const address = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_sample_address@8 called: sample=0x${sample.toString(16)}, address=0x${address.toString(16)}`);

        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj || !address) return 0;

        sampleObj.fileDataAddress = address;
        const prevLen = sampleObj.pcmBytes ?? (sampleObj.fileData?.length ?? 0);
        sampleObj.fileData = null;
        sampleObj.decodedData = null;
        sampleObj.fileDataAllocated = false;

        const memRef = getMemory(ctx);
        if (!MemoryGuard.isValidRange(memRef, address, 12)) return 1;

        const size = prevLen;
        const safeSize = size > 0 ? size : Math.min(memRef.length - address, 10 * 1024 * 1024);
        sampleObj.fileData = memRef.slice(address, address + safeSize);
        decodeAudioFile(ctx, sampleObj);

        const lenForGuest = sampleObj.pcmBytes ?? safeSize;
        updateSampleMemory(ctx, sampleObj, address, lenForGuest);
        if (sampleObj.pcmBytes !== undefined) {
            refreshSampleLenDone(ctx, sampleObj);
        }
        return 1;
    };

    /**
     * _AIL_set_sample_address@12 — (HSAMPLE, start, len). The @8 variant has no length
     * and has to guess one from the voice's previous contents; here the app states it,
     * so the sound image is exactly what it points at. Separate export, not a spelling:
     * serving one with the other either invents a length or drops the app's.
     */
    exports["_AIL_set_sample_address@12"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const address = args[1] >>> 0;
        const len = args[2] >>> 0;
        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj || !address || !len) return 0;

        const memRef = getMemory(ctx);
        if (!MemoryGuard.isValidRange(memRef, address, len)) {
            Logger.warn(LogCategory.SYSTEM,
                `MSS32: _AIL_set_sample_address@12: sound image out of bounds ptr=0x${address.toString(16)} len=${len}`);
            return 0;
        }

        sampleObj.fileDataAddress = address;
        sampleObj.fileDataAllocated = false;
        sampleObj.decodedData = null;
        sampleObj.fileData = memRef.slice(address, address + len);
        decodeAudioFile(ctx, sampleObj);

        updateSampleMemory(ctx, sampleObj, address, sampleObj.pcmBytes ?? len);
        if (sampleObj.pcmBytes !== undefined) {
            refreshSampleLenDone(ctx, sampleObj);
        }
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: _AIL_set_sample_address@12: sample=0x${sample.toString(16)} ptr=0x${address.toString(16)} len=${len}`);
        return 1;
    };

    // _AIL_sample_volume@4
    exports["_AIL_sample_volume@4"] = (ctxThunk, mem, args) => {
        const sample = ctx.samples.get(args[0]);
        const vol = sample ? sample.volume : 0;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_sample_volume@4: handle=0x${args[0].toString(16)} → ${vol}`);
        return vol;
    };

    // _AIL_sample_pan@4
    exports["_AIL_sample_pan@4"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        return s ? (s.pan >>> 0) : 64;
    };

    // _AIL_sample_playback_rate@4
    exports["_AIL_sample_playback_rate@4"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        if (!s) return 22050;
        return (s.playbackRateHz ?? s.sampleRate) >>> 0;
    };

    // _AIL_sample_loop_count@4
    exports["_AIL_sample_loop_count@4"] = (ctxThunk, mem, args) => {
        const sample = ctx.samples.get(args[0]);
        return sample ? sample.loopCount : 1;
    };

    // _AIL_sample_position@4
    exports["_AIL_sample_position@4"] = (ctxThunk, mem, args) => {
        const sample = ctx.samples.get(args[0]);
        return sample ? sample.position : 0;
    };

    // S32 AIL_sample_granularity(HSAMPLE S) — the quantum AIL_sample_position and
    // AIL_set_sample_position work in. Real mss32 maps the sample's DIG_F_* format to its
    // frame size (mono8=1, mono16/stereo8=2, stereo16=4), returns the ADPCM block size for
    // an ADPCM sample, and 1 when an ASI decoder owns the data. A WAV's blockAlign is
    // exactly the first two of those; host-decoded MP3/OGG is our ASI-equivalent.
    const sampleGranularity = (s: MSSSample): number => {
        if (isEncodedFormat(s.fileFormat)) return 1;
        return Math.max(1, s.blockAlign
            || Math.max(1, s.channels) * Math.max(1, s.bitsPerSample >> 3));
    };

    exports["_AIL_sample_granularity@4"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        // Callers divide by this; real mss32 only ever answers 0 for a NULL handle.
        if (!args[0]) return 0;
        return s ? sampleGranularity(s) : 1;
    };

    // void AIL_set_sample_position(HSAMPLE S, S32 offset) — offset in bytes into the sample
    // data. Real mss32 rounds to the nearest multiple of AIL_sample_granularity before
    // storing, so a mid-frame seek cannot desync the mixer's frame stride.
    exports["_AIL_set_sample_position@8"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        if (!s) return 0;
        const gran = sampleGranularity(s);
        const total = getPlaybackLengthBytes(s);
        let pos = Math.max(0, args[1] | 0);
        pos = Math.floor((pos + (gran >> 1)) / gran) * gran;
        if (total > 0) pos = Math.min(pos, total);

        s.position = pos;
        writeSamplePosition(ctx, s, pos);
        // The heartbeat derives position from startTime, so re-anchor it or the next tick
        // reverts the seek.
        const bytesPerSec = getBytesPerSecond(s) * (s.playbackRate || 1.0);
        if (bytesPerSec > 0) s.startTime = performance.now() - (pos / bytesPerSec) * 1000.0;
        s.lastAudioPositionTime = undefined;
        s.lastAudioPositionBytes = undefined;
        s.lastRingCursorBytes = undefined;
        s.lastRingCursorTime = undefined;

        if (!seekRingBuffer(s, pos) && s.isPlaying) {
            // Host-decoded voices (MP3/OGG via audio_play_encoded) expose no seek; the
            // reported position moves, the audible one does not.
            Logger.warn(LogCategory.SYSTEM,
                `MSS32: _AIL_set_sample_position@8: id=${s.id} seek to ${pos} not applied (no ring buffer)`);
        }
        Logger.log(LogCategory.SYSTEM,
            `MSS32: _AIL_set_sample_position@8: handle=0x${args[0].toString(16)} → ${pos} (gran=${gran})`);
        return 0;
    };

    // void AIL_set_sample_ms_position(HSAMPLE S, S32 milliseconds) — real mss32 converts
    // with the sample's bytes-per-second and hands the byte offset to
    // AIL_set_sample_position, which is where the granularity rounding happens.
    exports["_AIL_set_sample_ms_position@8"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        if (!s) return 0;
        const ms = args[1] | 0;
        const bytes = Math.max(0, Math.round(getBytesPerSecond(s) * ms / 1000));
        return exports["_AIL_set_sample_position@8"]!(ctxThunk, mem, [args[0], bytes]);
    };

    // S32 AIL_active_sample_count(HDIGDRIVER dig) — real mss32 walks the driver's sample
    // array and counts slots whose status is SMP_PLAYING or SMP_PLAYINGBUTRELEASED, so a
    // voice the game released while still audible keeps counting. Same array, same rule.
    exports["_AIL_active_sample_count@4"] = (ctxThunk, mem, args) => {
        let count = 0;
        if (ctx.driverSampleArray) {
            const view = makeView(mem);
            for (let i = 0; i < ctx.driverMaxSamples; i++) {
                const slot = ctx.driverSampleArray + i * MSS_SAMPLE_STRUCT_SIZE;
                if (!isValidAddress(mem, slot + 0x08, 4)) break;
                const status = view.getUint32(slot + 0x08, true);
                if (status === SMP_PLAYING || status === SMP_PLAYINGBUTRELEASED) count++;
            }
        } else {
            for (const s of ctx.samples.values()) {
                if (s.isPlaying || s.pendingStart) count++;
            }
        }
        return count;
    };

    // _AIL_register_EOS_callback@8(sample, EOS) -> previous callback.
    // The callback lives in the GUEST's sample struct at +0x4C, which is where
    // invokeEOSCallback reads it from — an app may set it either way, so the API
    // has to write the same slot rather than keep a private copy.
    exports["_AIL_register_EOS_callback@8"] = (ctxThunk, mem, args) => {
        const sample = args[0] >>> 0;
        const callback = args[1] >>> 0;
        if (!MemoryGuard.isValidRange(mem, sample + 0x4C, 4)) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const previous = view.getUint32(sample + 0x4C, true);
        view.setUint32(sample + 0x4C, callback, true);
        return previous === 0xFFFFFFFF ? 0 : previous;
    };

    // _AIL_set_sample_user_data@12
    exports["_AIL_set_sample_user_data@12"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const index = args[1] | 0;
        const value = args[2] >>> 0;
        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj) return 0;
        if (!sampleObj.userData) sampleObj.userData = [];
        sampleObj.userData[index] = value;

        const offset = 0x40 + index * 4;
        if (MemoryGuard.isValidRange(mem, sample + offset, 4)) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(sample + offset, value, true);
        }
        return 0;
    };

    // ==================== Miles 3D positional sample API ====================
    // 3D samples reuse the 2D sample lifecycle (alloc / file / start / stop / status /
    // volume / rate / loop) and add spatial state pushed into the ring buffer's
    // CTRL_3D_* fields, mixed by the audio worklet against the global listener SAB
    // (see spatial.ts + bottleship-audio-worklet.ts). `obj` handles passed to the
    // position/velocity/orientation calls may be EITHER a 3D sample OR the listener.

    const isListener = (h: number): boolean => ctx.listener3D !== null && h === ctx.listener3D.handle;

    // _AIL_allocate_3D_sample_handle@4(provider) → 3D sample handle (NULL on failure)
    exports["_AIL_allocate_3D_sample_handle@4"] = (ctxThunk, mem, args) => {
        const handle = exports["_AIL_allocate_sample_handle@4"]!(ctxThunk, mem, [ctx.digitalDriverHandle]) as number;
        const sampleObj = handle ? ctx.samples.get(handle) : undefined;
        if (sampleObj) {
            sampleObj.is3D = true;
            sampleObj.pos3D = { x: 0, y: 0, z: 0 };
            sampleObj.vel3D = { x: 0, y: 0, z: 0 };
            sampleObj.minDist3D = 1;
            sampleObj.maxDist3D = 1e9;
            sampleObj.mode3D = 0;
        }
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_allocate_3D_sample_handle@4 prov=0x${args[0].toString(16)} → 0x${handle.toString(16)}`);
        return handle;
    };

    exports["_AIL_release_3D_sample_handle@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_release_sample_handle@4"]!(ctxThunk, mem, args);

    // _AIL_set_3D_sample_file@8(S3D, file_image) — WAV in guest memory, parses RIFF size itself
    exports["_AIL_set_3D_sample_file@8"] = (ctxThunk, mem, args) =>
        exports["_AIL_set_sample_file@12"]!(ctxThunk, mem, [args[0], args[1], 0]);

    // H3DSAMPLE is a sample handle from the same pool, and the AILSOUNDINFO contract is
    // identical — the 3D variant only differs in which pool allocate_* drew the voice from.
    exports["_AIL_set_3D_sample_info@8"] = setSampleInfo;
    exports["AIL_set_3D_sample_info"] = setSampleInfo;

    exports["_AIL_start_3D_sample@4"] = (ctxThunk, mem, args) => {
        const r = exports["_AIL_start_sample@4"]!(ctxThunk, mem, args);
        const s = ctx.samples.get(args[0]);
        if (s) applySample3D(s);
        return r;
    };

    exports["_AIL_stop_3D_sample@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_stop_sample@4"]!(ctxThunk, mem, args);

    exports["_AIL_resume_3D_sample@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_resume_sample@4"]!(ctxThunk, mem, args);

    exports["_AIL_end_3D_sample@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_end_sample@4"]!(ctxThunk, mem, args);

    exports["_AIL_3D_sample_status@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_sample_status@4"]!(ctxThunk, mem, args);

    exports["_AIL_set_3D_sample_volume@8"] = (ctxThunk, mem, args) =>
        exports["_AIL_set_sample_volume@8"]!(ctxThunk, mem, args);

    exports["_AIL_3D_sample_volume@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_sample_volume@4"]!(ctxThunk, mem, args);

    exports["_AIL_set_3D_sample_playback_rate@8"] = (ctxThunk, mem, args) =>
        exports["_AIL_set_sample_playback_rate@8"]!(ctxThunk, mem, args);

    exports["_AIL_3D_sample_playback_rate@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_sample_playback_rate@4"]!(ctxThunk, mem, args);

    exports["_AIL_set_3D_sample_loop_count@8"] = (ctxThunk, mem, args) =>
        exports["_AIL_set_sample_loop_count@8"]!(ctxThunk, mem, args);

    exports["_AIL_3D_sample_loop_count@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_sample_loop_count@4"]!(ctxThunk, mem, args);

    // U32 AIL_3D_sample_length(H3DSAMPLE S) / AIL_(set_)3D_sample_offset — byte length and
    // play cursor of the 3D voice's data. In real mss32 these dispatch straight into the
    // provider (.m3d) that owns the voice; ours are the same voices as the 2D pool, so they
    // answer from the same data.
    exports["_AIL_3D_sample_length@4"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        return s ? getPlaybackLengthBytes(s) >>> 0 : 0;
    };

    exports["_AIL_3D_sample_offset@4"] = (ctxThunk, mem, args) =>
        exports["_AIL_sample_position@4"]!(ctxThunk, mem, args);

    exports["_AIL_set_3D_sample_offset@8"] = (ctxThunk, mem, args) =>
        exports["_AIL_set_sample_position@8"]!(ctxThunk, mem, args);

    // Reverb/occlusion strength — no DSP for it yet; accept and ignore.
    exports["_AIL_set_3D_sample_effects_level@8"] = () => 0;

    // _AIL_set_3D_position@16(obj, X, Y, Z) — floats passed by value (raw bits in args)
    exports["_AIL_set_3D_position@16"] = (ctxThunk, mem, args) => {
        const x = i32ToFloat(args[1]), y = i32ToFloat(args[2]), z = i32ToFloat(args[3]);
        if (isListener(args[0])) {
            const ls = ctx.listener3D!;
            ls.posX = x; ls.posY = y; ls.posZ = z;
            writeListener3D(ctx);
        } else {
            const s = ctx.samples.get(args[0]);
            if (s) { s.pos3D = { x, y, z }; applySample3D(s); }
        }
        return 0;
    };

    // _AIL_set_3D_velocity_vector@16(obj, X, Y, Z) — velocity components (units/sec)
    exports["_AIL_set_3D_velocity_vector@16"] = (ctxThunk, mem, args) => {
        const x = i32ToFloat(args[1]), y = i32ToFloat(args[2]), z = i32ToFloat(args[3]);
        if (isListener(args[0])) {
            const ls = ctx.listener3D!;
            ls.velX = x; ls.velY = y; ls.velZ = z;
            writeListener3D(ctx);
        } else {
            const s = ctx.samples.get(args[0]);
            if (s) { s.vel3D = { x, y, z }; applySample3D(s); }
        }
        return 0;
    };

    // _AIL_set_3D_velocity@20(obj, dX, dY, dZ, magnitude) — direction × speed
    exports["_AIL_set_3D_velocity@20"] = (ctxThunk, mem, args) => {
        let x = i32ToFloat(args[1]), y = i32ToFloat(args[2]), z = i32ToFloat(args[3]);
        const mag = i32ToFloat(args[4]);
        const len = Math.hypot(x, y, z);
        if (len > 1e-7) { const s = mag / len; x *= s; y *= s; z *= s; }
        if (isListener(args[0])) {
            const ls = ctx.listener3D!;
            ls.velX = x; ls.velY = y; ls.velZ = z;
            writeListener3D(ctx);
        } else {
            const s = ctx.samples.get(args[0]);
            if (s) { s.vel3D = { x, y, z }; applySample3D(s); }
        }
        return 0;
    };

    // _AIL_set_3D_orientation@28(obj, X_face, Y_face, Z_face, X_up, Y_up, Z_up)
    exports["_AIL_set_3D_orientation@28"] = (ctxThunk, mem, args) => {
        const fx = i32ToFloat(args[1]), fy = i32ToFloat(args[2]), fz = i32ToFloat(args[3]);
        const ux = i32ToFloat(args[4]), uy = i32ToFloat(args[5]), uz = i32ToFloat(args[6]);
        if (isListener(args[0])) {
            const ls = ctx.listener3D!;
            ls.frontX = fx; ls.frontY = fy; ls.frontZ = fz;
            ls.topX = ux; ls.topY = uy; ls.topZ = uz;
            writeListener3D(ctx);
        } else {
            const s = ctx.samples.get(args[0]);
            if (s) {
                const c = s.cone3D ?? { inner: 360, outer: 360, oriX: 0, oriY: 0, oriZ: 1, outVolCb: 0 };
                c.oriX = fx; c.oriY = fy; c.oriZ = fz;
                s.cone3D = c;
                applySample3D(s);
            }
        }
        return 0;
    };

    // _AIL_set_3D_sample_distances@12(S3D, max_dist, min_dist) — floats
    exports["_AIL_set_3D_sample_distances@12"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        if (s) {
            s.maxDist3D = i32ToFloat(args[1]);
            s.minDist3D = i32ToFloat(args[2]);
            applySample3D(s);
        }
        return 0;
    };

    // ---- 3D getters -------------------------------------------------------
    // Out-parameter twins of the setters above; each writes back exactly what the
    // matching setter stored. An engine that keeps no copy of its own spatial state
    // reads these back per frame, and a handler that leaves the pointers untouched
    // hands it whatever was on the stack — garbage distances and pans.

    /** Write up to three F32 out-parameters, skipping the NULL ones MSS allows. */
    const writeF32Outs = (mem: Uint8Array, ptrs: number[], values: number[]): void => {
        const view = makeView(mem);
        for (let i = 0; i < ptrs.length; i++) {
            const p = ptrs[i] >>> 0;
            if (!p || !MemoryGuard.isValidRange(mem, p, 4)) continue;
            view.setFloat32(p, values[i], true);
        }
    };

    /** Spatial state of a 3D object — a sample, or the listener. */
    const spatialOf = (obj: number): {
        pos: [number, number, number]; vel: [number, number, number];
        front: [number, number, number]; top: [number, number, number];
        maxDist: number; minDist: number;
    } | null => {
        if (isListener(obj)) {
            const ls = ctx.listener3D!;
            return {
                pos: [ls.posX, ls.posY, ls.posZ],
                vel: [ls.velX, ls.velY, ls.velZ],
                front: [ls.frontX, ls.frontY, ls.frontZ],
                top: [ls.topX, ls.topY, ls.topZ],
                maxDist: 0, minDist: 0,
            };
        }
        const s = ctx.samples.get(obj);
        if (!s) return null;
        const p = s.pos3D ?? { x: 0, y: 0, z: 0 };
        const v = s.vel3D ?? { x: 0, y: 0, z: 0 };
        const c = s.cone3D;
        return {
            pos: [p.x, p.y, p.z],
            vel: [v.x, v.y, v.z],
            // A sample's "face" vector is its sound cone's orientation; it has no up vector.
            front: [c?.oriX ?? 0, c?.oriY ?? 0, c?.oriZ ?? 1],
            top: [0, 1, 0],
            maxDist: s.maxDist3D ?? 0,
            minDist: s.minDist3D ?? 0,
        };
    };

    // _AIL_3D_position@16(obj, F32* X, F32* Y, F32* Z)
    exports["_AIL_3D_position@16"] = (ctxThunk, mem, args) => {
        const sp = spatialOf(args[0]);
        writeF32Outs(mem, [args[1], args[2], args[3]], sp ? sp.pos : [0, 0, 0]);
        return 0;
    };

    // _AIL_3D_velocity@16(obj, F32* dX, F32* dY, F32* dZ)
    exports["_AIL_3D_velocity@16"] = (ctxThunk, mem, args) => {
        const sp = spatialOf(args[0]);
        writeF32Outs(mem, [args[1], args[2], args[3]], sp ? sp.vel : [0, 0, 0]);
        return 0;
    };

    // _AIL_3D_orientation@28(obj, F32* X_face, Y_face, Z_face, X_up, Y_up, Z_up)
    exports["_AIL_3D_orientation@28"] = (ctxThunk, mem, args) => {
        const sp = spatialOf(args[0]);
        const f = sp ? sp.front : [0, 0, 1];
        const u = sp ? sp.top : [0, 1, 0];
        writeF32Outs(mem, [args[1], args[2], args[3], args[4], args[5], args[6]],
            [f[0], f[1], f[2], u[0], u[1], u[2]]);
        return 0;
    };

    // _AIL_3D_sample_distances@12(S3D, F32* max_dist, F32* min_dist)
    exports["_AIL_3D_sample_distances@12"] = (ctxThunk, mem, args) => {
        const sp = spatialOf(args[0]);
        writeF32Outs(mem, [args[1], args[2]], sp ? [sp.maxDist, sp.minDist] : [0, 0]);
        return 0;
    };

    // _AIL_set_3D_sample_cone@16(S3D, inner_angle, outer_angle, outer_volume_0_127)
    exports["_AIL_set_3D_sample_cone@16"] = (ctxThunk, mem, args) => {
        const s = ctx.samples.get(args[0]);
        if (s) {
            const inner = Math.round(i32ToFloat(args[1]));
            const outer = Math.round(i32ToFloat(args[2]));
            const outVol127 = Math.max(0, Math.min(127, args[3] | 0));
            const outVolCb = outVol127 <= 0 ? -10000 : Math.round(2000 * Math.log10(outVol127 / 127));
            const c = s.cone3D ?? { inner: 360, outer: 360, oriX: 0, oriY: 0, oriZ: 1, outVolCb: 0 };
            c.inner = inner; c.outer = outer; c.outVolCb = outVolCb;
            s.cone3D = c;
            applySample3D(s);
        }
        return 0;
    };

    return exports;
}

// ==================== Private helpers ====================

/**
 * Reset a sample's loop state to the one-shot default (loop_count=1), mirroring how
 * real Miles AIL_set_sample_file auto-inits the sample for the new file. Called from
 * the set-file handlers so a stale loop_count left on a reused voice (e.g. a prior
 * looping sound, or a value set once at pool init) can't silently turn a one-shot
 * into an infinite loop. Genuinely looping sounds re-assert their count by calling
 * AIL_set_sample_loop_count AFTER set_file, exactly as on real Miles.
 */
function resetSampleLoopState(sample: MSSSample): void {
    sample.loopCount = 1;
}

/**
 * Full SAMPLE struct initialization matching real MSS32 FUN_2100f1b0 / FUN_2100e370.
 * Used by both allocate_sample_handle and init_sample.
 *
 * IMPORTANT: +0x00 is the RIB type tag pointer, NOT status.
 * Status lives only at +0x08. The type tag is preserved (not overwritten here)
 * because it was already written by initSampleArray or allocate_sample_handle.
 */
function initSampleStruct(view: DataView, handle: number, driverHandle: number): void {
    // Zero data fields +0x0C..+0x24
    for (let j = 0x0C; j <= 0x24; j += 4) {
        view.setUint32(handle + j, 0, true);
    }

    // Driver back-pointer
    view.setUint32(handle + 0x04, driverHandle, true);

    // Real MSS32 offsets
    view.setUint32(handle + 0x08, SMP_DONE, true);       // status = SMP_DONE
    view.setUint32(handle + 0x28, 1, true);               // loopCount = 1
    view.setInt32(handle + 0x3C, -2, true);                // sentinel 0xFFFFFFFE
    view.setUint32(handle + 0x40, 1, true);               // userData[0]
    view.setUint32(handle + 0x44, 1, true);               // userData[1]
    view.setUint32(handle + 0x48, 0, true);               // userData[2]
    view.setInt32(handle + 0x4C, -1, true);                // EOS callback = none
    view.setUint32(handle + 0x58, 22050, true);           // playbackRate = 22050 Hz
    view.setUint32(handle + 0x5C, 127, true);             // volume = max
    view.setUint32(handle + 0x60, 64, true);              // pan = center
    view.setUint32(handle + 0xBC, 0x100, true);
    view.setInt32(handle + 0x110, -1, true);

    // Constants
    view.setUint32(handle + 0x274, 0, true);
    view.setUint32(handle + 0x278, 0x3CF5C28F, true);
    view.setUint32(handle + 0x27C, 0x3FBF1AA0, true);

    // Legacy dual-write offsets (for our internal readers)
    // Note: +0x00 is NOT written here — it's the type tag, preserved from init
    view.setUint32(handle + 0x20, 1, true);               // legacy loopCount
    view.setUint32(handle + 0x34, 22050, true);           // legacy playbackRate
    view.setUint32(handle + 0x38, 127, true);             // legacy volume
    view.setUint32(handle + 0x3C, 64, true);              // legacy pan (overwrites sentinel)

    // Compute volL/volR/eff×16
    if (driverHandle) {
        computeSampleVolumes(view, handle, driverHandle);
    }

    // Zero processor chains (+0x13C, stride 0x68, ×3)
    for (let p = 0; p < 3; p++) {
        const chainBase = handle + 0x13C + p * 0x68;
        for (let k = 0; k < 0x68; k += 4) {
            view.setUint32(chainBase + k, 0, true);
        }
    }
}

async function loadSampleFile(ctx: MSSContext, sample: MSSSample, fileName: string, offset: number, size: number, formatHint?: string): Promise<void> {
    const system = System.getInstance();
    // Derive format hint from filename if not provided externally
    const hint = formatHint ?? fileName;

    try {
        const handle = system.fileSystem.openSync(fileName, 0x80000000, 3);
        if (handle) {
            if (size > 0) {
                system.fileSystem.setPosition(handle, offset, 0);
                const syncData = system.fileSystem.readSync(handle, size);
                if (syncData) {
                    sample.fileData = syncData;
                    sample.fileDataAllocated = false;
                    sample.fileDataAddress = undefined;
                    decodeAudioFile(ctx, sample, hint);
                    return;
                }
            } else {
                const fileSize = system.fileSystem.getFileSize(fileName);
                const syncData = system.fileSystem.readSync(handle, fileSize);
                if (syncData) {
                    sample.fileData = syncData;
                    sample.fileDataAllocated = false;
                    sample.fileDataAddress = undefined;
                    decodeAudioFile(ctx, sample, hint);
                    return;
                }
            }
        }

        const asyncHandle = await system.fileSystem.open(fileName, 0x80000000, 3);
        if (!asyncHandle) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: Failed to open file: ${fileName}`);
            return;
        }

        if (size > 0) {
            system.fileSystem.setPosition(asyncHandle, offset, 0);
            sample.fileData = await system.fileSystem.read(asyncHandle, size);
        } else {
            const fileSize = system.fileSystem.getFileSize(fileName);
            sample.fileData = await system.fileSystem.read(asyncHandle, fileSize);
        }

        sample.fileDataAllocated = false;
        sample.fileDataAddress = undefined;

        if (sample.fileData) {
            decodeAudioFile(ctx, sample, hint);
        }
    } catch (e) {
        Logger.error(LogCategory.SYSTEM, `MSS32: Error loading file ${fileName}: ${e}`);
    }
}
