import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { buildPcmWavImage } from "@bottleship/formats/audio";
import { MSSContext } from "./context";
import {
    DIG_F_ADPCM_MASK,
    ailBitsForWav,
    countWavSampleFrames,
    decodeAdpcmToS16,
    inspectWavImage,
    readAilSoundInfo,
    wavFormatToDigF,
    writeAilSoundInfo,
} from "./audio-decode";

export function createWavInfoExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const ailWavInfo: ThunkImplementation = (ctxThunk, mem, args) => {
        const wavPtr = args[0];
        const infoPtr = args[1];
        if (!wavPtr || !infoPtr) {
            Logger.warn(LogCategory.SYSTEM, "MSS32: _AIL_WAV_info@8: NULL pointer");
            return 0;
        }

        const wav = inspectWavImage(mem, wavPtr);
        if (!wav) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_WAV_info@8: failed to parse WAV at 0x${wavPtr.toString(16)}`);
            return 0;
        }

        const digFormat = wavFormatToDigF(wav.formatTag, wav.channels, wav.bitsPerSample);
        const blockSize = wav.blockAlign || (wav.channels * Math.max(1, wav.bitsPerSample >> 3));
        const samples = countWavSampleFrames(wav);

        writeAilSoundInfo(mem, infoPtr, {
            format: digFormat,
            dataPtr: wav.dataGuestPtr,
            dataLen: wav.dataChunkSize,
            rate: wav.sampleRate,
            bits: ailBitsForWav(wav.formatTag, wav.bitsPerSample),
            channels: wav.channels,
            samples,
            blockSize,
            initialPtr: wav.dataGuestPtr,
        });

        if (wav.formatTag === 17 || wav.formatTag === 2) {
            ctx.wavFormatByDataPtr.set(wav.dataGuestPtr, wav.formatTag);
        }

        Logger.log(
            LogCategory.SYSTEM,
            `MSS32: _AIL_WAV_info@8: wav=0x${wavPtr.toString(16)} fmt=${digFormat} tag=${wav.formatTag} ` +
            `${wav.channels}ch ${wav.sampleRate}Hz data=0x${wav.dataGuestPtr.toString(16)} len=${wav.dataChunkSize} samples=${samples}`
        );
        return 1;
    };

    exports["_AIL_WAV_info@8"] = ailWavInfo;
    exports["AIL_WAV_info"] = ailWavInfo;

    exports["_AIL_decompress_ADPCM@12"] = (ctxThunk, mem, args) => {
        const infoPtr = args[0];
        const outDataPtrPtr = args[1];
        const outSizePtr = args[2];

        const info = readAilSoundInfo(mem, infoPtr);
        if (!info || !outDataPtrPtr || !outSizePtr) {
            Logger.warn(LogCategory.SYSTEM, "MSS32: _AIL_decompress_ADPCM@12: invalid arguments");
            return 0;
        }
        if ((info.format & DIG_F_ADPCM_MASK) === 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_decompress_ADPCM@12: not ADPCM format=${info.format}`);
            return 0;
        }
        if (!info.dataPtr || info.dataLen === 0) {
            Logger.warn(LogCategory.SYSTEM, "MSS32: _AIL_decompress_ADPCM@12: empty source buffer");
            return 0;
        }
        if (!MemoryGuard.isValidRange(mem, info.dataPtr, info.dataLen)) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_decompress_ADPCM@12: source out of bounds ptr=0x${info.dataPtr.toString(16)} len=${info.dataLen}`);
            return 0;
        }
        if (!MemoryGuard.isValidRange(mem, outDataPtrPtr, 4) || !MemoryGuard.isValidRange(mem, outSizePtr, 4)) {
            Logger.warn(LogCategory.SYSTEM, "MSS32: _AIL_decompress_ADPCM@12: invalid output pointers");
            return 0;
        }

        const formatTag = ctx.wavFormatByDataPtr.get(info.dataPtr) ?? 17;
        const channels = Math.max(1, info.channels);
        const blockAlign = info.blockSize || (channels * 4);
        const compressed = mem.subarray(info.dataPtr, info.dataPtr + info.dataLen);

        let pcm: Int16Array;
        try {
            pcm = decodeAdpcmToS16(compressed, formatTag, channels, blockAlign);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_decompress_ADPCM@12: decode failed: ${e}`);
            return 0;
        }
        if (pcm.length === 0) {
            Logger.warn(LogCategory.SYSTEM, "MSS32: _AIL_decompress_ADPCM@12: decoder produced 0 samples");
            return 0;
        }

        // The output is a complete PCM .WAV FILE IMAGE, not the bare samples: every caller
        // feeds it straight back into AIL_WAV_info / AIL_set_sample_file, both of which parse
        // a RIFF header. Handing back raw PCM makes those two answer "not a RIFF/WAVE file",
        // the voice never gets data, and a caller that waits for the sample to reach SMP_DONE
        // waits forever (ZenGin's dialogue output does exactly that).
        const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const image = buildPcmWavImage(pcmBytes, channels, info.rate || 22050);

        const outBytes = image.byteLength;
        const allocPtr = ctx.process.memory.alloc(outBytes);
        if (!allocPtr) {
            Logger.error(LogCategory.SYSTEM, `MSS32: _AIL_decompress_ADPCM@12: failed to allocate ${outBytes} bytes`);
            return 0;
        }
        ctx.memAllocatedByMss.add(allocPtr);

        if (!MemoryGuard.writeBytes(mem, allocPtr, image, "MSS32:_AIL_decompress_ADPCM@12")) {
            ctx.process.memory.free(allocPtr);
            ctx.memAllocatedByMss.delete(allocPtr);
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(outDataPtrPtr, allocPtr >>> 0, true);
        view.setUint32(outSizePtr, outBytes >>> 0, true);

        Logger.log(
            LogCategory.SYSTEM,
            `MSS32: _AIL_decompress_ADPCM@12: ${info.dataLen} bytes ADPCM (tag=${formatTag}) -> ` +
            `${pcmBytes.byteLength} bytes PCM in a ${outBytes}-byte WAV image at 0x${allocPtr.toString(16)}`
        );
        return 1;
    };
    exports["AIL_decompress_ADPCM"] = exports["_AIL_decompress_ADPCM@12"];

    return exports;
}
