import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { MSSContext, SMP_PLAYING } from "./context";
import { defaultStreamBufferSize, setSampleStatus, refreshSampleLenDone, getMemory } from "./helpers";
import { decodeRawSampleData } from "./sample";
import { convertToFloat } from "./audio-decode";
import { playSample, appendDecodedChunk } from "./playback-engine";

const MAX_STREAM_BUFFER_BYTES = 2 * 1024 * 1024; // 2MB cap for streaming audio

export function createSampleBufferExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_load_sample_buffer@16
    exports["_AIL_load_sample_buffer@16"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const bufferNum = args[1];
        const dataPtr = args[2];
        const dataLen = args[3];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_load_sample_buffer@16 called: sample=0x${sample.toString(16)}, buf=${bufferNum}, len=${dataLen}`);

        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj || !dataPtr || dataLen <= 0) {
            return 1;
        }

        if (!sampleObj.streamBuffers) sampleObj.streamBuffers = [];
        const bufArr = sampleObj.streamBuffers;
        const existing = bufArr[bufferNum];
        const ptrCopy = dataPtr >>> 0;
        const sizeCopy = dataLen >>> 0;
        bufArr[bufferNum] = existing
            ? { ...existing, ptr: ptrCopy, size: sizeCopy, inUse: true }
            : { ptr: ptrCopy, size: sizeCopy, inUse: true };

        if (!sampleObj.fileData) {
            sampleObj.fileData = mem.slice(dataPtr, dataPtr + dataLen);
        } else {
            const prev = sampleObj.fileData;
            const newTotal = prev.length + dataLen;
            if (newTotal <= MAX_STREAM_BUFFER_BYTES) {
                const grown = new Uint8Array(newTotal);
                grown.set(prev, 0);
                grown.set(mem.slice(dataPtr, dataPtr + dataLen), prev.length);
                sampleObj.fileData = grown;
            } else {
                // Sliding window: keep recent data up to cap
                const newChunk = mem.slice(dataPtr, dataPtr + dataLen);
                const keepFromPrev = Math.max(0, MAX_STREAM_BUFFER_BYTES - dataLen);
                const trimmed = new Uint8Array(keepFromPrev + dataLen);
                if (keepFromPrev > 0) {
                    trimmed.set(prev.subarray(prev.length - keepFromPrev), 0);
                }
                trimmed.set(newChunk, keepFromPrev);
                sampleObj.fileData = trimmed;
            }
        }
        sampleObj.fileDataAllocated = false;
        sampleObj.fileDataAddress = sampleObj.fileDataAddress ?? dataPtr;
        sampleObj.totalBytes = (sampleObj.totalBytes ?? 0) + dataLen;

        const channels = sampleObj.channels || 1;
        const bits = sampleObj.bitsPerSample || 16;
        const blockAlign = sampleObj.blockAlign || Math.max(1, (bits >> 3) * channels);
        const chunk = convertToFloat(mem.slice(dataPtr, dataPtr + dataLen), channels, bits, sampleObj.formatTag || 1, blockAlign);

        if (!sampleObj.isPlaying) {
            sampleObj.decodedData = chunk;
            sampleObj.startTime = performance.now();
            sampleObj.pendingStart = false;
            playSample(ctx, sampleObj);
        } else if (chunk.length > 0) {
            appendDecodedChunk(ctx, sampleObj, chunk);
        }

        bufArr[bufferNum].inUse = false;
        setSampleStatus(ctx, sampleObj, SMP_PLAYING);
        return 1;
    };

    // _AIL_minimum_sample_buffer_size@12
    exports["_AIL_minimum_sample_buffer_size@12"] = (ctxThunk, mem, args) => {
        const dig = args[0];
        const format = args[1];
        const flags = args[2];
        const base = 44100 * 2 * 2 / 20;
        const aligned = (Math.max(4096, Math.ceil(base)) + 511) & ~511;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_minimum_sample_buffer_size@12 called dig=0x${dig.toString(16)} fmt=0x${format.toString(16)} flags=0x${flags.toString(16)} -> ${aligned}`);
        return aligned;
    };

    // _AIL_set_sample_type@12
    exports["_AIL_set_sample_type@12"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const format = args[1] >>> 0;
        const flags = args[2] >>> 0;
        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj) return 0;
        sampleObj.sampleTypeFormat = format;
        sampleObj.sampleTypeFlags = flags;

        const stereo = (format & 0x2) !== 0;
        const sixteen = (format & 0x1) !== 0;
        sampleObj.channels = stereo ? 2 : 1;
        sampleObj.bitsPerSample = sixteen ? 16 : 8;
        sampleObj.blockAlign = sampleObj.channels * (sampleObj.bitsPerSample >> 3);
        sampleObj.formatTag = 1;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        MemoryGuard.writeUint32(mem, view, sample + 0x2C, sampleObj.formatTag, "MSS32:set_sample_type:format");
        MemoryGuard.writeUint32(mem, view, sample + 0x30, flags, "MSS32:set_sample_type:flags");
        MemoryGuard.writeUint32(mem, view, sample + 0x34, sampleObj.sampleRate >>> 0, "MSS32:set_sample_type:rate");
        MemoryGuard.writeUint32(mem, view, sample + 0x38, sampleObj.volume >>> 0, "MSS32:set_sample_type:vol");
        if (sampleObj.fileFormat === "raw" && sampleObj.fileData) {
            // Re-interpret the image the voice points at, as it is in guest memory now.
            const address = sampleObj.fileDataAddress ?? 0;
            const length = sampleObj.fileData.length;
            const guest = getMemory(ctx);
            if (address && MemoryGuard.isValidRange(guest, address, length)) {
                decodeRawSampleData(sampleObj, guest, address, length);
            } else {
                decodeRawSampleData(sampleObj);
            }
            refreshSampleLenDone(ctx, sampleObj);
        }
        return 0;
    };

    // _AIL_sample_buffer_ready@4
    exports["_AIL_sample_buffer_ready@4"] = (ctxThunk, mem, args) => {
        const sampleObj = ctx.samples.get(args[0]);
        if (!sampleObj?.streamBuffers) return 1;
        const ready = sampleObj.streamBuffers.some(b => !b.inUse);
        return ready ? 1 : 0;
    };

    // _AIL_sample_buffer_info@20
    exports["_AIL_sample_buffer_info@20"] = (ctxThunk, mem, args) => {
        const sample = args[0];
        const bufIndex = args[1] | 0;
        const startPtrOut = args[2];
        const lenPtrOut = args[3];
        const statusPtrOut = args[4];
        const sampleObj = ctx.samples.get(sample);
        if (!sampleObj) return 0;
        if (!sampleObj.streamBuffers) sampleObj.streamBuffers = [];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        const buf = sampleObj.streamBuffers[bufIndex] ?? { ptr: 0, size: defaultStreamBufferSize(sampleObj), inUse: false };
        sampleObj.streamBuffers[bufIndex] = buf;

        if (startPtrOut) view.setUint32(startPtrOut, buf.ptr, true);
        if (lenPtrOut) view.setUint32(lenPtrOut, buf.size, true);
        if (statusPtrOut) view.setUint32(statusPtrOut, buf.inUse ? 1 : 0, true);

        return 1;
    };

    return exports;
}
