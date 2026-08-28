import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { Marshaler } from "../../core/memory/marshaler";
import { Mem } from "../../core/memory/mem-accessor";
import { isValidAddress } from "../../core/memory/address-guard";
import { MSSContext, SMP_DONE, SMP_PLAYING, SMP_STOPPED } from "./context";
import { MSSStream } from "./types";
import { System } from "../../core/system";
import {
    getBytesPerSecond, getPlaybackLengthBytes,
    setStreamStatus, writeStreamPosition, writeStreamVolume, writeStreamPan,
    writeStreamPlaybackRate, refreshStreamLenDone, isEncodedFormat,
} from "./helpers";
import {
    playStream, updateStreamPlayback, stopRingBuffer, resumeRingBuffer,
    incrementalStreamPosition, releaseStreamRing,
} from "./playback-engine";
import { decodeStreamFile } from "./audio-decode";
import { GuestCallChain, hasAppFileCallbacks, readWholeFileViaApp, runGuestCallChain } from "./app-file-io";
import {
    closeStreamSource, closeVfsStreamSource, openStreamSource, openVfsStreamSource,
    seekIncrementalStream, serveIncrementalStreams, sniffVfsStream, startIncrementalStream,
} from "./stream-engine";

/** The NUL-terminated bytes at `ptr`, copied out of guest memory (host-side, so it
 *  survives the yields the caller makes). Bounded — a missing terminator is a bad
 *  pointer, not a reason to walk the address space. */
function readGuestCString(ctx: MSSContext, ptr: number, maxBytes = 512): Uint8Array {
    const mem = ctx.process.getCurrentMemory();
    const start = ptr >>> 0;
    let end = start;
    const limit = Math.min(mem.length, start + maxBytes);
    while (end < limit && mem[end] !== 0) end++;
    return mem.slice(start, end);
}

export function createStreamExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_open_stream@12
    //
    // With the app's file callbacks installed, Miles opens the stream THROUGH THEM
    // (the name is an archive entry, not a file). That is guest code, so the caller
    // is parked on a suspended-thunk chain until the data has landed and the handle
    // can be returned — same shape as a Win32 enumeration, and a cold read inside
    // the app's reader simply parks and resumes like any other guest I/O.
    exports["_AIL_open_stream@12"] = (ctxThunk, mem, args) => {
        const dig = args[0];
        const filenamePtr = args[1];
        const memoryImage = args[2];

        const filenameStr = filenamePtr ? Marshaler.readString(mem, filenamePtr) : null;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_stream@12 called: dig=0x${dig.toString(16)}, filename="${filenameStr ?? '(memory)'}"`);

        const STREAM_STRUCT_SIZE = 512;
        const handle = ctx.process.memory.alloc(STREAM_STRUCT_SIZE);
        const streamDummyBuffer = ctx.process.memory.alloc(256);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < STREAM_STRUCT_SIZE; i += 4) {
            view.setUint32(handle + i, 0, true);
        }

        view.setUint32(handle + 0x00, SMP_DONE, true);
        view.setUint32(handle + 0x04, dig, true);
        view.setUint32(handle + 0x10, streamDummyBuffer, true);
        view.setInt32(handle + 0x34, 22050, true);
        view.setInt32(handle + 0x38, 127, true);
        view.setInt32(handle + 0x3C, 64, true);

        const streamId = ctx.nextStreamId++;
        const stream: MSSStream = {
            id: streamId,
            handle: handle,
            fileData: null,
            decodedData: null,
            filename: filenameStr,
            sampleRate: 22050,
            channels: 2,
            bitsPerSample: 16,
            formatTag: 1,
            blockAlign: 4,
            streamMemory: memoryImage >>> 0,
            volume: 127,
            pan: 64,
            playbackRate: 1.0,
            loopCount: 1,
            streamDummyBuffer: streamDummyBuffer,
            isPlaying: false,
            isPaused: false,
            position: 0,
            pendingStart: false
        };

        ctx.streams.set(handle, stream);
        ctx.streamsById.set(streamId, stream);

        if (filenameStr && hasAppFileCallbacks(ctx)) {
            const chain = (function* (): GuestCallChain {
                // Miles owns a stable copy of the name while it probes and potentially
                // reopens a stream. Some app callbacks use their input buffer as scratch;
                // passing the caller's live pointer through both phases lets the probe
                // silently change the fallback filename.
                // Copied BYTE for byte, not decoded and re-encoded: an archive entry
                // name in a DBCS codepage can carry a sequence the ANSI round trip
                // turns into '?', and the app's own reader would then fail to open a
                // name it wrote itself.
                const nameBytes = readGuestCString(ctx, filenamePtr);
                const nameCopy = ctx.process.memory.alloc(nameBytes.length + 1);
                if (!nameCopy) {
                    discardStream(ctx, stream, "could not allocate the stream filename");
                    return 0;
                }
                const restoreName = (): void => {
                    // Re-derived per call: a plain guest view does not survive a yield (§3.1).
                    const guest = ctx.process.getCurrentMemory();
                    guest.set(nameBytes, nameCopy);
                    guest[nameCopy + nameBytes.length] = 0;
                };
                try {
                    restoreName();
                    // Incremental first: one open handle plus a fixed ring, so the app's
                    // reader is asked for a buffer at a time instead of the whole file.
                    if (yield* openStreamSource(ctx, stream, nameCopy, filenameStr)) {
                        Logger.log(LogCategory.SYSTEM,
                            `MSS32: _AIL_open_stream@12 -> 0x${handle.toString(16)} (streamId=${streamId}, incremental via app callbacks)`);
                        if (stream.pendingStart) startIncrementalStream(ctx, stream);
                        return handle;
                    }
                    restoreName();
                    const data = yield* readWholeFileViaApp(ctx, nameCopy, filenameStr);
                    if (!data) {
                        discardStream(ctx, stream);
                        return 0;
                    }
                    stream.fileData = data;
                    decodeStreamFile(ctx, stream);
                    Logger.log(LogCategory.SYSTEM,
                        `MSS32: _AIL_open_stream@12 -> 0x${handle.toString(16)} (streamId=${streamId}, ${data.length} bytes via app callbacks)`);
                    return handle;
                } finally {
                    ctx.process.memory.free(nameCopy);
                }
            })();
            return runGuestCallChain(ctx, ctxThunk, 12, "mss32:AIL_open_stream", chain);
        }

        if (filenameStr) {
            // Answer the way Miles does: synchronously, and with 0 for a file that is
            // not a stream. The sniff is one resident header read; when it adopts, the
            // stream is already playable before this call returns.
            const sniff = sniffVfsStream(ctx, stream, filenameStr);
            if (sniff === "not-audio") {
                Logger.warn(LogCategory.SYSTEM,
                    `MSS32: _AIL_open_stream@12: "${filenameStr}" is not a stream Miles can play — returning 0`);
                discardStream(ctx, stream, "not a playable stream format");
                return 0;
            }
            if (sniff !== "incremental") {
                loadStreamFile(ctx, stream, sniff === "unknown").catch(err => {
                    Logger.error(LogCategory.SYSTEM, `MSS32: Failed to load stream file "${filenameStr}": ${err}`);
                });
            }
        }

        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_stream@12 -> 0x${handle.toString(16)} (streamId=${streamId})`);
        return handle;
    };

    // _AIL_close_stream@4
    exports["_AIL_close_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_close_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_close_stream@4: Invalid stream handle`);
            return 0;
        }

        if (stream.isPlaying) {
            if (!stopRingBuffer(stream.id)) {
                self.postMessage({ type: "audio_stop", payload: { id: stream.id } });
            }
        }

        const teardown = (): void => {
            releaseStreamRing(stream.id);
            if (stream.streamDummyBuffer) {
                ctx.process.memory.free(stream.streamDummyBuffer);
            }
            ctx.process.memory.free(streamHandle);
            ctx.streamsById.delete(stream.id);
            ctx.streams.delete(streamHandle);
            ctx.streamCallbacks.delete(streamHandle);
            ctx.streamUserData.delete(streamHandle);
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_close_stream@4: Stream closed (id=${stream.id})`);
        };

        // An app-backed source owns one of the app's OWN file handles; closing it is
        // the app's close callback, i.e. guest code, so the caller parks until it ran.
        if (stream.source?.kind === "app") {
            const chain = (function* (): GuestCallChain {
                yield* closeStreamSource(ctx, stream);
                teardown();
                return 0;
            })();
            return runGuestCallChain(ctx, ctxThunk, 4, "mss32:AIL_close_stream", chain);
        }

        closeVfsStreamSource(stream);
        teardown();
        return 0;
    };

    // _AIL_start_stream@4
    exports["_AIL_start_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_start_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_stream@4: Invalid stream handle`);
            return 0;
        }
        startStream(ctx, stream, "_AIL_start_stream@4");
        return 0;
    };

    // _AIL_pause_stream@4
    exports["_AIL_pause_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_pause_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;
        pauseStream(ctx, stream);
        return 0;
    };

    // _AIL_pause_stream@8
    exports["_AIL_pause_stream@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const pause = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_pause_stream@8 called: stream=0x${streamHandle.toString(16)}, pause=${pause}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        if (pause) {
            pauseStream(ctx, stream);
        } else {
            unpauseStream(ctx, stream);
        }
        return 0;
    };

    // _AIL_resume_stream@4
    exports["_AIL_resume_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_resume_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;
        unpauseStream(ctx, stream);
        return 0;
    };

    // _AIL_stream_status@4
    /** A PAUSED stream is SMP_STOPPED, not SMP_PLAYING — same as the sample side
     *  (_AIL_stop_sample stamps SMP_STOPPED). Apps use "pause, then wait for the
     *  stream to stop being SMP_PLAYING" to hand the audio device over; answering
     *  PLAYING makes that wait unsatisfiable and the handover never happens. */
    exports["_AIL_stream_status@4"] = (ctxThunk, mem, args) => {
        const stream = ctx.streams.get(args[0]);
        if (!stream) return SMP_DONE;
        if (stream.isPaused) return SMP_STOPPED;
        // A start deferred for want of data already publishes SMP_PLAYING to the guest's
        // own status word, and the sample path counts pendingStart as playing for the same
        // reason: the track has begun as far as the caller is concerned. Answering DONE
        // here made the API contradict the word beside it and told a title polling right
        // after AIL_start_stream that its track had already finished.
        return (stream.isPlaying || stream.pendingStart) ? SMP_PLAYING : SMP_DONE;
    };

    // _AIL_stream_position@4
    exports["_AIL_stream_position@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        // An incremental stream's position is what the WORKLET has consumed, not what
        // the wall clock says it should have: a stalled mixer must not run the guest's
        // radio clock past audio nobody has heard.
        if (stream.source) {
            stream.position = incrementalStreamPosition(stream);
            return stream.position;
        }

        if (stream.isPlaying && stream.startTime && !stream.isPaused) {
            const elapsed = performance.now() - stream.startTime;
            const bytesPerSec = getBytesPerSecond(stream);
            const effectiveBytesPerSec = bytesPerSec * stream.playbackRate;
            stream.position = Math.floor((elapsed / 1000) * effectiveBytesPerSec);

            const totalLen = stream.pcmBytes ?? stream.fileData?.length ?? 0;
            if (totalLen > 0 && stream.position > totalLen) {
                stream.position = totalLen;
            }
        }
        return stream.position;
    };

    // _AIL_stream_ms_position@4 (alternate: _AIL_stream_position_ms@4)
    const streamMsPosition: ThunkImplementation = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        const bytesPerSec = getBytesPerSecond(stream);
        if (bytesPerSec === 0) return 0;

        const position = exports["_AIL_stream_position@4"]!(ctxThunk, mem, [streamHandle]) as number;
        return Math.floor((position / bytesPerSec) * 1000);
    };
    exports["_AIL_stream_ms_position@4"] = streamMsPosition;
    exports["_AIL_stream_position_ms@4"] = streamMsPosition;
    exports["_AIL_stream_ms_position@12"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const stream = ctx.streams.get(streamHandle);
        const bytesPerSec = stream ? getBytesPerSecond(stream) : 0;
        const position = stream && bytesPerSec > 0
            ? exports["_AIL_stream_position@4"]!(ctxThunk, mem, [streamHandle]) as number
            : 0;
        // getPlaybackLengthBytes, not the raw byte count: an MP3/OGG stream has no
        // pcmBytes until it is decoded, and its encoded size over a DECODED rate reports
        // a fraction of the real duration — a title watching for current >= total then
        // skips the track almost immediately.
        const totalBytes = stream ? getPlaybackLengthBytes(stream) : 0;
        const totalMs = bytesPerSec > 0 ? Math.round(totalBytes * 1000 / bytesPerSec) : 0;
        const currentMs = bytesPerSec > 0 ? Math.round(position * 1000 / bytesPerSec) : 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (args[1] && isValidAddress(mem, args[1], 4, "rw")) view.setUint32(args[1], totalMs >>> 0, true);
        if (args[2] && isValidAddress(mem, args[2], 4, "rw")) view.setUint32(args[2], currentMs >>> 0, true);
        return 0;
    };

    // _AIL_set_stream_position@8
    exports["_AIL_set_stream_position@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const position = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_position@8 called: stream=0x${streamHandle.toString(16)}, pos=${position}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.position = position;
        writeStreamPosition(ctx, stream, position);

        // Incremental: re-anchor the source and drop the ring. Nothing to seek in the
        // host audio element, and the ring's contents are now the wrong second.
        if (stream.source) {
            seekIncrementalStream(stream, position);
            return 0;
        }

        if (stream.isPlaying) {
            const bytesPerSec = getBytesPerSecond(stream);
            const seekTimeMs = bytesPerSec > 0 ? (position / bytesPerSec) * 1000 : 0;
            self.postMessage({
                type: "audio_seek",
                payload: { id: stream.id, timeMs: seekTimeMs }
            });
        }
        return 0;
    };

    // void AIL_set_stream_ms_position(HSTREAM S, S32 milliseconds) — the ms twin of
    // set_stream_position, converted with the stream's own bytes-per-second so the seek
    // and the rounding both happen in exactly one place.
    exports["_AIL_set_stream_ms_position@8"] = (ctxThunk, mem, args) => {
        const stream = ctx.streams.get(args[0]);
        if (!stream) return 0;
        const bytes = Math.max(0, Math.round(getBytesPerSecond(stream) * (args[1] | 0) / 1000));
        return exports["_AIL_set_stream_position@8"]!(ctxThunk, mem, [args[0], bytes]);
    };

    // _AIL_set_stream_volume@8
    exports["_AIL_set_stream_volume@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const volume = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_volume@8 called: stream=0x${streamHandle.toString(16)}, volume=${volume}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.volume = Math.max(0, Math.min(127, volume));
        writeStreamVolume(ctx, stream, stream.volume);
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_stream_volume@4
    exports["_AIL_stream_volume@4"] = (ctxThunk, mem, args) => {
        const stream = ctx.streams.get(args[0]);
        return stream ? stream.volume : 127;
    };

    // _AIL_set_stream_pan@8
    exports["_AIL_set_stream_pan@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const pan = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_pan@8 called: stream=0x${streamHandle.toString(16)}, pan=${pan}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.pan = Math.max(0, Math.min(127, pan));
        writeStreamPan(ctx, stream, stream.pan);
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_set_stream_loop_count@8
    exports["_AIL_set_stream_loop_count@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const loopCount = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_loop_count@8 called: stream=0x${streamHandle.toString(16)}, loopCount=${loopCount}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.loopCount = loopCount;
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_set_stream_playback_rate@8
    exports["_AIL_set_stream_playback_rate@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const rate = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_playback_rate@8 called: stream=0x${streamHandle.toString(16)}, rate=${rate}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        const targetRate = rate >>> 0;
        const baseRate = stream.sampleRate || 22050;
        stream.playbackRate = targetRate / baseRate;
        stream.playbackRateHz = targetRate;
        writeStreamPlaybackRate(ctx, stream, targetRate);
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_stream_playback_rate@4(stream) -> current rate in Hz. The getter pairs
    // with the setter above; an app that reads it back to compute a pitch ratio
    // divides by whatever we answer.
    exports["_AIL_stream_playback_rate@4"] = (ctxThunk, mem, args) => {
        const stream = ctx.streams.get(args[0]);
        if (!stream) return 0;
        return (stream.playbackRateHz ?? stream.sampleRate ?? 0) >>> 0;
    };

    // _AIL_set_stream_user_data@12(stream, index, value) — opaque per-stream slots.
    // Miles hands them back to the app's own callbacks; storing them is the whole
    // contract, and a stream callback that reads a slot we dropped gets a null
    // "this" pointer.
    exports["_AIL_set_stream_user_data@12"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const index = args[1] | 0;
        const value = args[2] >>> 0;
        if (!ctx.streams.has(streamHandle) || index < 0) return 0;
        let slots = ctx.streamUserData.get(streamHandle);
        if (!slots) ctx.streamUserData.set(streamHandle, (slots = []));
        slots[index] = value;
        return 0;
    };

    // _AIL_stream_user_data@8(stream, index) -> value
    exports["_AIL_stream_user_data@8"] = (ctxThunk, mem, args) => {
        const slots = ctx.streamUserData.get(args[0]);
        const index = args[1] | 0;
        return (slots?.[index] ?? 0) >>> 0;
    };

    // _AIL_register_stream_callback@8(stream, callback) -> previous callback.
    // Miles calls it when an incrementally fed stream reaches the end of its source
    // (see stream-engine's rollOver); a whole-file stream never reaches one.
    exports["_AIL_register_stream_callback@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const callback = args[1] >>> 0;
        if (!ctx.streams.has(streamHandle)) return 0;
        const previous = ctx.streamCallbacks.get(streamHandle) ?? 0;
        if (callback) ctx.streamCallbacks.set(streamHandle, callback);
        else ctx.streamCallbacks.delete(streamHandle);
        Logger.log(LogCategory.SYSTEM,
            `MSS32: _AIL_register_stream_callback@8 stream=0x${streamHandle.toString(16)} cb=0x${callback.toString(16)}`);
        return previous;
    };

    // _AIL_stream_info@8
    exports["_AIL_stream_info@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const infoType = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_stream_info@8 called: stream=0x${streamHandle.toString(16)}, infoType=${infoType}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        switch (infoType) {
            case 0: return Math.floor(getBytesPerSecond(stream));
            case 1: return stream.sampleRate;
            case 2: return stream.channels;
            case 3: return stream.bitsPerSample;
            case 4: return stream.formatTag;
            default: return 0;
        }
    };

    // AIL_stream_info(stream, datarate, sndtype, length, memory)
    // MSS 5/6 declares this as `void __stdcall`; all results are optional S32 out
    // parameters. Do not fold it into the unrelated legacy @8 export: that one takes
    // two arguments, so sharing an implementation emits the wrong RET N for one of them.
    const streamInfo5: ThunkImplementation = (ctxThunk, mem, args) => {
        const streamHandle = args[0] >>> 0;
        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        const writeOptionalS32 = (pointer: number, value: number, field: string) => {
            if (pointer === 0) return;
            if (!isValidAddress(mem, pointer, 4, "rw")) {
                Logger.warn(LogCategory.SYSTEM, `MSS32: AIL_stream_info ${field} out-pointer 0x${pointer.toString(16)} is not writable guest memory`);
                return;
            }
            Mem.writeUint32(pointer, value >>> 0);
        };

        // `sndtype` is the DIG_F_* output-format bitfield (the MSS change log
        // calls it the "flags return parameter").  This is deliberately derived
        // from the decoded stream format, rather than exposing the WAV format tag.
        const sndtype = (stream.bitsPerSample >= 16 ? 0x1 : 0) |
            (stream.channels >= 2 ? 0x2 : 0);
        const length = stream.pcmBytes ?? stream.fileData?.length ?? 0;

        writeOptionalS32(args[1] >>> 0, Math.floor(getBytesPerSecond(stream)), "datarate");
        writeOptionalS32(args[2] >>> 0, sndtype, "sndtype");
        writeOptionalS32(args[3] >>> 0, length, "length");
        writeOptionalS32(args[4] >>> 0, stream.streamMemory, "memory");
        Logger.verbose(LogCategory.SYSTEM, `MSS32: AIL_stream_info stream=0x${streamHandle.toString(16)} rate=${getBytesPerSecond(stream)} type=0x${sndtype.toString(16)} length=${length} memory=${stream.streamMemory}`);
        return 0;
    };
    exports["_AIL_stream_info@20"] = streamInfo5;
    // Registered on the exact name too: the stub lookup falls back to a normalized key
    // (leading `_` and `@N` stripped), under which the undecorated import would otherwise
    // resolve to whichever `AIL_stream_info` variant registered last.
    exports["AIL_stream_info"] = streamInfo5;

    // _AIL_service_stream@8 — the app asking Miles to top its stream buffers up. For an
    // incrementally fed stream that is literally the work: read the next slab through
    // the app's own file callbacks, which is guest code, so the caller may park here.
    exports["_AIL_service_stream@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        if (stream.source?.kind === "app") {
            const served = serveIncrementalStreams(ctx, ctxThunk, 8, "mss32:AIL_service_stream");
            if (served) return served;
        }

        if (stream.source) {
            const position = incrementalStreamPosition(stream);
            stream.position = position;
            writeStreamPosition(ctx, stream, position);
            return stream.isPlaying && !stream.isPaused ? 1 : 0;
        }

        if (stream.isPlaying && !stream.isPaused) {
            const position = exports["_AIL_stream_position@4"]!(ctxThunk, mem, [streamHandle]) as number;
            writeStreamPosition(ctx, stream, position);

            const totalLen = stream.pcmBytes ?? stream.fileData?.length ?? 0;
            if (totalLen > 0 && position >= totalLen) {
                if (stream.loopCount === 1) {
                    stream.isPlaying = false;
                    setStreamStatus(ctx, stream, SMP_DONE);
                    return 0;
                }
            }
            return 1;
        }
        return 0;
    };

    return exports;
}

// ==================== Private helpers ====================

/** Begin playback from the current position (AIL_start_stream, and the first
 *  AIL_pause_stream(S,0) on a stream that has never run). */
function startStream(ctx: MSSContext, stream: MSSStream, who: string): void {
    stream.startTime = performance.now();
    stream.isPaused = false;

    if (stream.source) {
        startIncrementalStream(ctx, stream);
        Logger.log(LogCategory.SYSTEM, `MSS32: ${who}: Started incremental stream playback`);
        return;
    }

    if (!stream.decodedData) {
        if (stream.fileData && isEncodedFormat(stream.fileFormat)) {
            playStream(ctx, stream);
            Logger.log(LogCategory.SYSTEM, `MSS32: ${who}: Started ${stream.fileFormat} stream`);
            return;
        }
        Logger.warn(LogCategory.SYSTEM, `MSS32: ${who}: No data yet, deferring start`);
        stream.pendingStart = true;
        setStreamStatus(ctx, stream, SMP_PLAYING);
        return;
    }

    playStream(ctx, stream);
    Logger.log(LogCategory.SYSTEM, `MSS32: ${who}: Started stream playback`);
}

function pauseStream(ctx: MSSContext, stream: MSSStream): void {
    if (!stream.isPlaying || stream.isPaused) return;
    if (!stopRingBuffer(stream.id)) {
        self.postMessage({ type: "audio_pause", payload: { id: stream.id } });
    }
    stream.isPaused = true;
    setStreamStatus(ctx, stream, SMP_STOPPED);
    Logger.log(LogCategory.SYSTEM, `MSS32: Stream paused (id=${stream.id})`);
}

/** AIL_pause_stream(S,0) / AIL_resume_stream. A stream is PAUSED from the moment
 *  it is opened, so un-pausing one that never ran is how Miles starts it — an app
 *  that never calls AIL_start_stream is using the documented path, not a shortcut. */
function unpauseStream(ctx: MSSContext, stream: MSSStream): void {
    if (!stream.isPlaying && !stream.pendingStart) {
        startStream(ctx, stream, "_AIL_pause_stream@8(resume)");
        return;
    }
    if (!stream.isPaused) return;
    if (!resumeRingBuffer(stream.id)) {
        self.postMessage({ type: "audio_resume", payload: { id: stream.id } });
    }
    stream.isPaused = false;
    setStreamStatus(ctx, stream, SMP_PLAYING);
    Logger.log(LogCategory.SYSTEM, `MSS32: Stream resumed (id=${stream.id})`);
}

/** Tear a half-built stream back down: AIL_open_stream answers 0, so the app must
 *  never be able to reach the handle we already allocated. */
function discardStream(ctx: MSSContext, stream: MSSStream, why = "could not be read through the app's file callbacks"): void {
    Logger.error(LogCategory.SYSTEM,
        `MSS32: _AIL_open_stream@12: "${stream.filename}" ${why} — returning failure`);
    if (stream.streamDummyBuffer) ctx.process.memory.free(stream.streamDummyBuffer);
    ctx.process.memory.free(stream.handle);
    ctx.streamsById.delete(stream.id);
    ctx.streams.delete(stream.handle);
    ctx.streamCallbacks.delete(stream.handle);
    ctx.streamUserData.delete(stream.handle);
}

async function loadStreamFile(ctx: MSSContext, stream: MSSStream, tryIncremental = true): Promise<void> {
    if (!stream.filename) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: loadStreamFile: No filename provided`);
        return;
    }

    try {
        const system = System.getInstance();

        // Incremental first — hold the file open and feed a fixed ring. Only reached
        // when the synchronous sniff could not read the header; a format we do not feed
        // a slab at a time falls through to the whole-file read below, which is what
        // the host media element needs anyway.
        if (tryIncremental && await openVfsStreamSource(ctx, stream, stream.filename)) {
            if (stream.pendingStart) startIncrementalStream(ctx, stream);
            return;
        }

        let handle = system.fileSystem.openSync(stream.filename, 0x80000000, 3);
        if (!handle) {
            handle = await system.fileSystem.open(stream.filename, 0x80000000, 3);
            if (!handle) {
                // Diagnostic: show resolved path and search for similar files
                const resolved = system.fileSystem.resolvePath(stream.filename);
                const baseName = stream.filename.split(/[\\/]/).pop()?.toLowerCase() ?? "";
                const dirName = stream.filename.split(/[\\/]/).slice(0, -1).join("/").toLowerCase();
                Logger.error(LogCategory.SYSTEM,
                    `MSS32: Failed to open stream file: "${stream.filename}" (resolved="${resolved}", currentDir="${system.fileSystem.currentDir}")`);
                // List available files in the same directory for debugging
                const dirEntries = system.fileSystem.listDirectory(
                    resolved.substring(0, resolved.lastIndexOf("\\")) || "C:\\"
                );
                if (dirEntries.length > 0) {
                    const names = dirEntries.slice(0, 30).map(e => e.name);
                    Logger.error(LogCategory.SYSTEM,
                        `MSS32: Available files in directory: [${names.join(", ")}] (${dirEntries.length} total)`);
                } else {
                    Logger.error(LogCategory.SYSTEM,
                        `MSS32: Directory appears empty or does not exist`);
                }
                return;
            }
        }

        const fileSize = system.fileSystem.getFileSize(handle.path);
        if (fileSize <= 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: Stream file is empty: "${stream.filename}"`);
            return;
        }

        system.fileSystem.setPosition(handle, 0, 0);

        let fileData = system.fileSystem.readSync(handle, fileSize);
        if (!fileData) {
            fileData = await system.fileSystem.read(handle, fileSize);
        }

        if (!fileData || fileData.length === 0) {
            Logger.error(LogCategory.SYSTEM, `MSS32: Failed to read stream file: "${stream.filename}"`);
            return;
        }

        stream.fileData = fileData;
        decodeStreamFile(ctx, stream);
    } catch (err) {
        Logger.error(LogCategory.SYSTEM, `MSS32: Error loading stream file "${stream.filename ?? '(memory)'}": ${err}`);
    }
}
