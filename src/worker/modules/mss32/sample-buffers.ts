import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { MSSContext } from "./context";
import { defaultStreamBufferSize, refreshSampleLenDone, getMemory } from "./helpers";
import { decodeRawSampleData } from "./sample";
import { loadSampleBuffer, updateSampleBufferPlayback } from "./sample-buffer-playback";

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
        if (!sampleObj) return 0;
        return loadSampleBuffer(ctx, sampleObj, mem, bufferNum, dataPtr, dataLen);
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
        if (!sampleObj) return -1;
        updateSampleBufferPlayback(ctx, sampleObj);
        // Native Miles returns the available buffer number, or -1 if both are busy.
        for (let slot = 0; slot < 2; slot++) if (!sampleObj.streamBuffers?.[slot]?.inUse) return slot;
        return -1;
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
        updateSampleBufferPlayback(ctx, sampleObj);
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
