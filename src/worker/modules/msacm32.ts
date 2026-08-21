/**
 * MSACM32.dll — the Audio Compression Manager.
 *
 * We provide what every Windows 95–XP install ships: the PCM converter (msacm.pcm —
 * bit depth, channel count, sample rate) plus the two ADPCM decoders (msadp32.acm and
 * imaadp32.acm). Those three are stock, so a title with IMA-ADPCM speech is entitled
 * to find them; refusing would not read to the caller as "this machine lacks a codec"
 * but as "there is no sound", and titles take the no-audio branch over it.
 *
 * What we do NOT have is an ADPCM *encoder* or any of the optional codecs (GSM 6.10,
 * MP3, Voxware). Those fail the way Windows fails a missing driver —
 * ACMERR_NOTPOSSIBLE out of acmStreamOpen — with a WARN naming the format tag, so the
 * gap is visible rather than silent.
 *
 * Every documented export exists. Callers reach ACM through LoadLibrary +
 * GetProcAddress and — because on Windows the DLL is always there — routinely skip the
 * NULL check; a name we omit is a call through NULL several frames from any evidence.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { isValidAddress } from "../core/memory/address-guard";
import { encodeAnsi } from "./codepage-utils";

// mmsystem.h
const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALHANDLE = 5;
const MMSYSERR_NOTSUPPORTED = 8;
const MMSYSERR_INVALFLAG = 10;
const MMSYSERR_INVALPARAM = 11;

// msacm.h — ACMERR_BASE is 512
const ACMERR_NOTPOSSIBLE = 512;
const ACMERR_UNPREPARED = 514;
const ACMERR_CANCELED = 515;

const WAVE_FORMAT_PCM = 1;
/** msadp32.acm — Microsoft ADPCM. */
const WAVE_FORMAT_ADPCM = 2;
/** imaadp32.acm — IMA/DVI ADPCM. */
const WAVE_FORMAT_IMA_ADPCM = 0x11;

const ACM_STREAMOPENF_QUERY = 0x00000001;
const ACM_STREAMOPENF_ASYNC = 0x00000002;

const ACM_STREAMSIZEF_SOURCE = 0x00000000;
const ACM_STREAMSIZEF_DESTINATION = 0x00000001;
const ACM_STREAMSIZEF_QUERYMASK = 0x0000000f;

const ACMSTREAMHEADER_STATUSF_DONE = 0x00010000;
const ACMSTREAMHEADER_STATUSF_PREPARED = 0x00020000;

const ACM_FORMATSUGGESTF_WFORMATTAG = 0x00010000;
const ACM_FORMATSUGGESTF_NCHANNELS = 0x00020000;
const ACM_FORMATSUGGESTF_NSAMPLESPERSEC = 0x00040000;
const ACM_FORMATSUGGESTF_WBITSPERSAMPLE = 0x00080000;
const ACM_FORMATSUGGESTF_TYPEMASK = 0x00ff0000;

// ACM_METRIC_* (msacm.h)
const ACM_METRIC_COUNT_DRIVERS = 1;
const ACM_METRIC_COUNT_CODECS = 2;
const ACM_METRIC_COUNT_CONVERTERS = 3;
const ACM_METRIC_COUNT_FILTERS = 4;
const ACM_METRIC_COUNT_DISABLED = 5;
const ACM_METRIC_COUNT_HARDWARE = 6;
const ACM_METRIC_COUNT_LOCAL_DRIVERS = 20;
const ACM_METRIC_COUNT_LOCAL_CODECS = 21;
const ACM_METRIC_COUNT_LOCAL_CONVERTERS = 22;
const ACM_METRIC_COUNT_LOCAL_FILTERS = 23;
const ACM_METRIC_COUNT_LOCAL_DISABLED = 24;
const ACM_METRIC_HARDWARE_WAVE_INPUT = 30;
const ACM_METRIC_HARDWARE_WAVE_OUTPUT = 31;
const ACM_METRIC_MAX_SIZE_FORMAT = 50;
const ACM_METRIC_MAX_SIZE_FILTER = 51;
const ACM_METRIC_DRIVER_SUPPORT = 100;
const ACM_METRIC_DRIVER_PRIORITY = 101;

const ACMDRIVERDETAILS_SUPPORTF_CODEC = 0x00000001;
const ACMDRIVERDETAILS_SUPPORTF_CONVERTER = 0x00000002;
/** One driver object stands for the stock set: the PCM converter plus the two ADPCM
 *  decoders, so it reports both support bits. */
const DRIVER_SUPPORT = ACMDRIVERDETAILS_SUPPORTF_CODEC | ACMDRIVERDETAILS_SUPPORTF_CONVERTER;


/** The one driver we have. Handles are opaque to the guest; these are its identities. */
const PCM_DRIVER_ID = 0xacd10001;
const PCM_DRIVER_HANDLE = 0xacd20001;
const STREAM_HANDLE_BASE = 0xacd30000;

/** ACM version as MSACM 4.03 reports it: 0xMMmmBBBB. */
const ACM_VERSION = 0x04030000;

/** sizeof(ACMSTREAMHEADER) in 32-bit Windows; a shorter cbStruct is a caller error. */
const ACMSTREAMHEADER_SIZE = 84;

const ASH = {
    cbStruct: 0, fdwStatus: 4, dwUser: 8,
    pbSrc: 12, cbSrcLength: 16, cbSrcLengthUsed: 20, dwSrcUser: 24,
    pbDst: 28, cbDstLength: 32, cbDstLengthUsed: 36, dwDstUser: 40,
} as const;

const WFX = {
    wFormatTag: 0, nChannels: 2, nSamplesPerSec: 4,
    nAvgBytesPerSec: 8, nBlockAlign: 12, wBitsPerSample: 14, cbSize: 16,
} as const;
const WAVEFORMATEX_SIZE = 18;

// ACMDRIVERDETAILSA: fixed header then five fixed-width ANSI fields.
const ADD_A = {
    cbStruct: 0, fccType: 4, fccComp: 8, wMid: 12, wPid: 14,
    vdwACM: 16, vdwDriver: 20, fdwSupport: 24, cFormatTags: 28,
    cFilterTags: 32, hicon: 36,
    szShortName: 40, szLongName: 72, szCopyright: 200,
    szLicensing: 280, szFeatures: 408, size: 920,
} as const;
const ADD_CHARS = { shortName: 32, longName: 128, copyright: 80, licensing: 128, features: 512 } as const;

// ACMFORMATTAGDETAILSA
const AFTD = { cbStruct: 0, dwFormatTagIndex: 4, dwFormatTag: 8, cbFormatSize: 12, fdwSupport: 16, cStandardFormats: 20, szFormatTag: 24, size: 72 } as const;
const AFTD_FORMATTAG_CHARS = 48;

// ACMFORMATDETAILSA
const AFD = { cbStruct: 0, dwFormatIndex: 4, dwFormatTag: 8, fdwSupport: 12, pwfx: 16, cbwfx: 20, szFormat: 24, size: 152 } as const;
const AFD_FORMAT_CHARS = 128;

/** 'audc' — the FOURCC every audio compression driver reports. */
const FCC_TYPE_AUDC = 0x61756463;

interface WaveFormat {
    formatTag: number;
    channels: number;
    samplesPerSec: number;
    bitsPerSample: number;
    blockAlign: number;
    /** ADPCM only: decoded samples per channel in one block (WAVEFORMATEX extra data). */
    samplesPerBlock: number;
    /** MS-ADPCM only: the predictor coefficient pairs the encoder used. */
    coefs: Int16Array | null;
}

interface AcmStream {
    src: WaveFormat;
    dst: WaveFormat;
}

// ---------------------------------------------------------------------------
// MS-ADPCM (msadp32.acm)
// ---------------------------------------------------------------------------

/** Step-size adaptation, indexed by the 4-bit code. */
const MS_ADAPT_TABLE = [
    230, 230, 230, 230, 307, 409, 512, 614,
    768, 614, 512, 409, 307, 230, 230, 230,
];
/** The seven standard predictor coefficient pairs; a stream may carry its own. */
const MS_ADAPT_COEF1 = [256, 512, 0, 192, 240, 460, 392];
const MS_ADAPT_COEF2 = [0, -256, 0, 64, 0, -208, -232];
const MS_STANDARD_COEFS = (() => {
    const c = new Int16Array(MS_ADAPT_COEF1.length * 2);
    for (let i = 0; i < MS_ADAPT_COEF1.length; i++) {
        c[i * 2] = MS_ADAPT_COEF1[i]!;
        c[i * 2 + 1] = MS_ADAPT_COEF2[i]!;
    }
    return c;
})();

// ---------------------------------------------------------------------------
// IMA/DVI ADPCM (imaadp32.acm)
// ---------------------------------------------------------------------------

const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253,
    279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166,
    1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428,
    4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289,
    16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

const clampS16 = (v: number): number => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

/** Samples per channel in one block, as each codec's block layout defines it. */
function adpcmSamplesPerBlock(f: WaveFormat): number {
    if (f.samplesPerBlock > 0) return f.samplesPerBlock;
    if (f.formatTag === WAVE_FORMAT_ADPCM) {
        // 7 header bytes per channel, then two samples per byte, plus the two the
        // header itself carries.
        return Math.floor(((f.blockAlign - 7 * f.channels) * 2) / f.channels) + 2;
    }
    // IMA: 4 header bytes per channel, then two samples per byte, plus the header's one.
    return Math.floor(((f.blockAlign - 4 * f.channels) * 2) / f.channels) + 1;
}

/**
 * Decode ONE MS-ADPCM block into `out` (interleaved, one Int16 per sample).
 * Returns the samples-per-channel written, or 0 if the block is malformed —
 * a short or corrupt block must not be reported as decoded silence.
 */
function decodeMsAdpcmBlock(
    src: Uint8Array, at: number, blockSize: number, channels: number,
    coefs: Int16Array, samplesPerBlock: number, out: Int16Array, outAt: number,
): number {
    if (blockSize < 7 * channels) return 0;
    const nCoefs = coefs.length >> 1;
    const predictor: number[] = [], delta: number[] = [], samp1: number[] = [], samp2: number[] = [];
    let p = at;
    for (let c = 0; c < channels; c++) {
        const idx = src[p++]!;
        if (idx >= nCoefs) return 0;
        predictor.push(idx);
    }
    const rd16 = (): number => {
        const v = src[p]! | (src[p + 1]! << 8);
        p += 2;
        return v >= 0x8000 ? v - 0x10000 : v;
    };
    for (let c = 0; c < channels; c++) delta.push(rd16());
    for (let c = 0; c < channels; c++) samp1.push(rd16());
    for (let c = 0; c < channels; c++) samp2.push(rd16());

    // The block header carries the first two samples, oldest first.
    let written = 0;
    for (let c = 0; c < channels; c++) out[outAt + c] = samp2[c]!;
    for (let c = 0; c < channels; c++) out[outAt + channels + c] = samp1[c]!;
    written = 2;
    let o = outAt + 2 * channels;

    const end = at + blockSize;
    let nibbleHigh = true;
    while (written < samplesPerBlock && p < end) {
        for (let c = 0; c < channels; c++) {
            if (p >= end) return written;
            const byte = src[p]!;
            let code = nibbleHigh ? (byte >> 4) : (byte & 0x0f);
            if (!nibbleHigh) p++;
            nibbleHigh = !nibbleHigh;
            const signed = code >= 8 ? code - 16 : code;
            const ci = predictor[c]!;
            // C integer division truncates toward zero; Math.floor would bias every
            // negative predictor by one LSB and add a faint buzz to the decode.
            let value = Math.trunc((samp1[c]! * coefs[ci * 2]! + samp2[c]! * coefs[ci * 2 + 1]!) / 256)
                + signed * delta[c]!;
            value = clampS16(value);
            samp2[c] = samp1[c]!;
            samp1[c] = value;
            const d = Math.trunc((MS_ADAPT_TABLE[code]! * delta[c]!) / 256);
            delta[c] = d < 16 ? 16 : d;
            out[o + c] = value;
        }
        o += channels;
        written++;
    }
    return written;
}

/** Decode ONE IMA-ADPCM block; same contract as decodeMsAdpcmBlock. */
function decodeImaAdpcmBlock(
    src: Uint8Array, at: number, blockSize: number, channels: number,
    samplesPerBlock: number, out: Int16Array, outAt: number,
): number {
    if (blockSize < 4 * channels) return 0;
    const predictor: number[] = [], index: number[] = [];
    let p = at;
    for (let c = 0; c < channels; c++) {
        const raw = src[p]! | (src[p + 1]! << 8);
        predictor.push(raw >= 0x8000 ? raw - 0x10000 : raw);
        const idx = src[p + 2]!;
        if (idx > 88) return 0;
        index.push(idx);
        p += 4; // the fourth byte is reserved
    }
    for (let c = 0; c < channels; c++) out[outAt + c] = predictor[c]!;
    let written = 1;
    let o = outAt + channels;

    const decode = (c: number, code: number): number => {
        const step = IMA_STEP_TABLE[index[c]!]!;
        let diff = step >> 3;
        if (code & 1) diff += step >> 2;
        if (code & 2) diff += step >> 1;
        if (code & 4) diff += step;
        predictor[c] = clampS16(predictor[c]! + ((code & 8) ? -diff : diff));
        let ni = index[c]! + IMA_INDEX_TABLE[code]!;
        index[c] = ni < 0 ? 0 : ni > 88 ? 88 : ni;
        return predictor[c]!;
    };

    // Data is grouped in 4-byte (8-sample) runs per channel, channels round-robin.
    const end = at + blockSize;
    const group = new Array<number>(channels);
    while (written < samplesPerBlock && p + 4 * channels <= end) {
        for (let c = 0; c < channels; c++) group[c] = p + c * 4;
        p += 4 * channels;
        for (let n = 0; n < 8 && written < samplesPerBlock; n++) {
            for (let c = 0; c < channels; c++) {
                const byte = src[group[c]! + (n >> 1)]!;
                const code = (n & 1) ? (byte >> 4) : (byte & 0x0f);
                out[o + c] = decode(c, code);
            }
            o += channels;
            written++;
        }
    }
    return written;
}

/**
 * The standard PCM formats the converter advertises, in the order msacm.pcm lists them:
 * rate-major, then 8-bit mono, 8-bit stereo, 16-bit mono, 16-bit stereo.
 */
const STANDARD_RATES = [11025, 22050, 44100] as const;
const STANDARD_VARIANTS: Array<{ channels: number; bits: number }> = [
    { channels: 1, bits: 8 }, { channels: 2, bits: 8 },
    { channels: 1, bits: 16 }, { channels: 2, bits: 16 },
];
const STANDARD_FORMAT_COUNT = STANDARD_RATES.length * STANDARD_VARIANTS.length;

/** The ADPCM standard formats each decoder advertises: the same rates, mono and stereo,
 *  with the block size msadp32/imaadp32 use at that rate. */
const ADPCM_RATE_BLOCKS: Array<{ rate: number; blockPerChannel: number }> = [
    { rate: 11025, blockPerChannel: 256 },
    { rate: 22050, blockPerChannel: 512 },
    { rate: 44100, blockPerChannel: 1024 },
];
const ADPCM_FORMAT_COUNT = ADPCM_RATE_BLOCKS.length * 2;

/** The three drivers a stock Windows install has behind msacm32, in ACM's own order. */
interface FormatTagInfo {
    tag: number;
    /** szFormatTag, as the driver's own details report it. */
    name: string;
    /** cbFormatSize — sizeof(WAVEFORMATEX) plus this tag's extra bytes. */
    formatSize: number;
    standardFormats: number;
}
const FORMAT_TAGS: FormatTagInfo[] = [
    { tag: WAVE_FORMAT_PCM, name: "PCM", formatSize: WAVEFORMATEX_SIZE, standardFormats: STANDARD_FORMAT_COUNT },
    // MS-ADPCM extra data: wSamplesPerBlock + wNumCoef + 7 coefficient pairs.
    { tag: WAVE_FORMAT_ADPCM, name: "Microsoft ADPCM", formatSize: WAVEFORMATEX_SIZE + 2 + 2 + 7 * 4, standardFormats: ADPCM_FORMAT_COUNT },
    // IMA-ADPCM extra data: wSamplesPerBlock.
    { tag: WAVE_FORMAT_IMA_ADPCM, name: "IMA ADPCM", formatSize: WAVEFORMATEX_SIZE + 2, standardFormats: ADPCM_FORMAT_COUNT },
];
const MAX_FORMAT_SIZE = Math.max(...FORMAT_TAGS.map(t => t.formatSize));

function frameBytes(f: WaveFormat): number {
    return Math.max(1, (f.bitsPerSample >> 3) * f.channels);
}

export class Msacm32 implements IModule {
    name = "msacm32";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private streams = new Map<number, AcmStream>();
    private nextStreamHandle = STREAM_HANDLE_BASE;

    initialize(process: Process): void {
        this.process = process;
        this.registerVersionAndMetrics();
        this.registerDriverApi();
        this.registerFormatApi();
        this.registerFilterApi();
        this.registerStreamApi();
    }

    reset(): void {
        this.streams.clear();
        this.nextStreamHandle = STREAM_HANDLE_BASE;
    }

    // ==================== helpers ====================

    private view(mem: Uint8Array): DataView {
        return new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    }

    private readWaveFormat(mem: Uint8Array, ptr: number): WaveFormat | null {
        if (!ptr || !isValidAddress(mem, ptr, WAVEFORMATEX_SIZE, "r")) return null;
        const v = this.view(mem);
        const bits = v.getUint16(ptr + WFX.wBitsPerSample, true);
        const channels = v.getUint16(ptr + WFX.nChannels, true);
        const formatTag = v.getUint16(ptr + WFX.wFormatTag, true);
        const f: WaveFormat = {
            formatTag,
            channels,
            samplesPerSec: v.getUint32(ptr + WFX.nSamplesPerSec, true),
            bitsPerSample: bits,
            blockAlign: v.getUint16(ptr + WFX.nBlockAlign, true) || Math.max(1, (bits >> 3) * channels),
            samplesPerBlock: 0,
            coefs: null,
        };
        // The ADPCM tags carry their block geometry in the WAVEFORMATEX extra bytes, and
        // MS-ADPCM its own coefficient table. Deriving them instead of reading them would
        // decode a stream that used a non-standard encoder into noise.
        if (formatTag === WAVE_FORMAT_ADPCM || formatTag === WAVE_FORMAT_IMA_ADPCM) {
            const cbSize = v.getUint16(ptr + WFX.cbSize, true);
            if (cbSize >= 2 && isValidAddress(mem, ptr + WAVEFORMATEX_SIZE, 2, "r")) {
                f.samplesPerBlock = v.getUint16(ptr + WAVEFORMATEX_SIZE, true);
            }
            if (formatTag === WAVE_FORMAT_ADPCM) {
                const nCoef = cbSize >= 4 && isValidAddress(mem, ptr + WAVEFORMATEX_SIZE + 2, 2, "r")
                    ? v.getUint16(ptr + WAVEFORMATEX_SIZE + 2, true) : 0;
                const bytes = nCoef * 4;
                if (nCoef > 0 && nCoef <= 64 && cbSize >= 4 + bytes
                    && isValidAddress(mem, ptr + WAVEFORMATEX_SIZE + 4, bytes, "r")) {
                    const coefs = new Int16Array(nCoef * 2);
                    for (let i = 0; i < nCoef * 2; i++) {
                        coefs[i] = v.getInt16(ptr + WAVEFORMATEX_SIZE + 4 + i * 2, true);
                    }
                    f.coefs = coefs;
                } else {
                    f.coefs = MS_STANDARD_COEFS;
                }
            }
        }
        return f;
    }

    private writePcmFormat(mem: Uint8Array, ptr: number, f: WaveFormat): void {
        const v = this.view(mem);
        const blockAlign = frameBytes(f);
        v.setUint16(ptr + WFX.wFormatTag, WAVE_FORMAT_PCM, true);
        v.setUint16(ptr + WFX.nChannels, f.channels, true);
        v.setUint32(ptr + WFX.nSamplesPerSec, f.samplesPerSec, true);
        v.setUint32(ptr + WFX.nAvgBytesPerSec, f.samplesPerSec * blockAlign, true);
        v.setUint16(ptr + WFX.nBlockAlign, blockAlign, true);
        v.setUint16(ptr + WFX.wBitsPerSample, f.bitsPerSample, true);
        // PCM is the one tag for which cbSize is not part of the struct; msacm.pcm still
        // zeroes it when the caller's buffer is large enough to hold it.
        v.setUint16(ptr + WFX.cbSize, 0, true);
    }

    /** One of a codec's advertised standard formats: rate × channels, at that rate's
     *  block size. samplesPerBlock follows from the block layout, never guessed. */
    private standardAdpcmFormatAt(tag: number, index: number): WaveFormat {
        const entry = ADPCM_RATE_BLOCKS[Math.floor(index / 2)]!;
        const channels = (index % 2) + 1;
        const f: WaveFormat = {
            formatTag: tag,
            channels,
            samplesPerSec: entry.rate,
            bitsPerSample: 4,
            blockAlign: entry.blockPerChannel * channels,
            samplesPerBlock: 0,
            coefs: tag === WAVE_FORMAT_ADPCM ? MS_STANDARD_COEFS : null,
        };
        f.samplesPerBlock = adpcmSamplesPerBlock(f);
        return f;
    }

    /** WAVEFORMATEX + the tag's extra bytes, exactly as the codec's own driver writes
     *  them — a caller feeds this straight back into acmStreamOpen. */
    private writeAdpcmFormat(mem: Uint8Array, ptr: number, f: WaveFormat): void {
        const v = this.view(mem);
        const samplesPerBlock = f.samplesPerBlock || adpcmSamplesPerBlock(f);
        const isMs = f.formatTag === WAVE_FORMAT_ADPCM;
        const coefs = f.coefs ?? MS_STANDARD_COEFS;
        const nCoef = coefs.length >> 1;
        const cbSize = isMs ? 2 + 2 + nCoef * 4 : 2;
        v.setUint16(ptr + WFX.wFormatTag, f.formatTag, true);
        v.setUint16(ptr + WFX.nChannels, f.channels, true);
        v.setUint32(ptr + WFX.nSamplesPerSec, f.samplesPerSec, true);
        // One block holds samplesPerBlock frames, so the byte rate follows from both.
        v.setUint32(ptr + WFX.nAvgBytesPerSec,
            Math.round((f.samplesPerSec * f.blockAlign) / samplesPerBlock), true);
        v.setUint16(ptr + WFX.nBlockAlign, f.blockAlign, true);
        v.setUint16(ptr + WFX.wBitsPerSample, 4, true);
        v.setUint16(ptr + WFX.cbSize, cbSize, true);
        v.setUint16(ptr + WAVEFORMATEX_SIZE, samplesPerBlock, true);
        if (isMs) {
            v.setUint16(ptr + WAVEFORMATEX_SIZE + 2, nCoef, true);
            for (let i = 0; i < nCoef * 2; i++) {
                v.setInt16(ptr + WAVEFORMATEX_SIZE + 4 + i * 2, coefs[i]!, true);
            }
        }
    }

    private writeFixedAnsi(mem: Uint8Array, ptr: number, chars: number, text: string): void {
        const bytes = encodeAnsi(text);
        const n = Math.min(bytes.length, chars - 1);
        for (let i = 0; i < n; i++) mem[ptr + i] = bytes[i]!;
        for (let i = n; i < chars; i++) mem[ptr + i] = 0;
    }

    /** PCM the converter can produce or consume. */
    private isSupportedFormat(f: WaveFormat): boolean {
        return f.formatTag === WAVE_FORMAT_PCM
            && (f.bitsPerSample === 8 || f.bitsPerSample === 16)
            && (f.channels === 1 || f.channels === 2)
            && f.samplesPerSec > 0;
    }

    /** ADPCM we can DECODE. Encoding is a different driver half we do not have. */
    private isDecodableAdpcm(f: WaveFormat): boolean {
        if (f.formatTag !== WAVE_FORMAT_ADPCM && f.formatTag !== WAVE_FORMAT_IMA_ADPCM) return false;
        if (f.channels !== 1 && f.channels !== 2) return false;
        if (f.samplesPerSec <= 0 || f.bitsPerSample !== 4) return false;
        const header = f.formatTag === WAVE_FORMAT_ADPCM ? 7 : 4;
        return f.blockAlign > header * f.channels && adpcmSamplesPerBlock(f) > 0;
    }

    private standardFormatAt(index: number): WaveFormat {
        const rate = STANDARD_RATES[Math.floor(index / STANDARD_VARIANTS.length)]!;
        const variant = STANDARD_VARIANTS[index % STANDARD_VARIANTS.length]!;
        return {
            formatTag: WAVE_FORMAT_PCM,
            channels: variant.channels,
            samplesPerSec: rate,
            bitsPerSample: variant.bits,
            blockAlign: (variant.bits >> 3) * variant.channels,
            samplesPerBlock: 0,
            coefs: null,
        };
    }

    /** Source frames that produce `dstFrames` destination frames, and the reverse. */
    private srcFramesForDst(s: AcmStream, dstFrames: number): number {
        return Math.ceil((dstFrames * s.src.samplesPerSec) / s.dst.samplesPerSec);
    }

    private dstFramesForSrc(s: AcmStream, srcFrames: number): number {
        return Math.floor((srcFrames * s.dst.samplesPerSec) / s.src.samplesPerSec);
    }

    /** True when the source side is a compressed block stream rather than PCM frames. */
    private isBlockSource(s: AcmStream): boolean {
        return s.src.formatTag !== WAVE_FORMAT_PCM;
    }

    /** Source bytes → source FRAMES (samples per channel), for either source kind. */
    private srcFramesInBytes(s: AcmStream, bytes: number): number {
        if (!this.isBlockSource(s)) return Math.floor(bytes / frameBytes(s.src));
        return Math.floor(bytes / s.src.blockAlign) * adpcmSamplesPerBlock(s.src);
    }

    /** Source FRAMES → the source bytes that hold them (whole blocks, rounded up). */
    private srcBytesForFrames(s: AcmStream, frames: number): number {
        if (!this.isBlockSource(s)) return frames * frameBytes(s.src);
        const perBlock = adpcmSamplesPerBlock(s.src);
        return Math.ceil(frames / perBlock) * s.src.blockAlign;
    }

    // ==================== version / metrics ====================

    private registerVersionAndMetrics(): void {
        this.exports["acmGetVersion"] = () => ACM_VERSION;

        // MMRESULT acmMetrics(HACMOBJ hao, UINT uMetric, LPVOID pMetric)
        this.exports["acmMetrics"] = (ctx, mem, args) => {
            const hao = args[0] >>> 0;
            const uMetric = args[1] >>> 0;
            const pMetric = args[2] >>> 0;

            // The counts and sizes are global (hao NULL); the per-driver metrics need one.
            const perDriver = uMetric === ACM_METRIC_DRIVER_SUPPORT || uMetric === ACM_METRIC_DRIVER_PRIORITY;
            if (perDriver && hao !== PCM_DRIVER_ID && hao !== PCM_DRIVER_HANDLE) return MMSYSERR_INVALHANDLE;
            if (!perDriver && hao !== 0) return MMSYSERR_INVALHANDLE;
            if (!pMetric || !isValidAddress(mem, pMetric, 4, "rw")) return MMSYSERR_INVALPARAM;

            const values: Record<number, number> = {
                [ACM_METRIC_COUNT_DRIVERS]: 1,
                // One driver object, and it is both: the PCM converter and the ADPCM
                // codecs are enumerated as its format tags, not as separate drivers.
                [ACM_METRIC_COUNT_CODECS]: 1,
                [ACM_METRIC_COUNT_CONVERTERS]: 1,
                [ACM_METRIC_COUNT_FILTERS]: 0,
                [ACM_METRIC_COUNT_DISABLED]: 0,
                [ACM_METRIC_COUNT_HARDWARE]: 0,
                [ACM_METRIC_COUNT_LOCAL_DRIVERS]: 1,
                [ACM_METRIC_COUNT_LOCAL_CODECS]: 1,
                [ACM_METRIC_COUNT_LOCAL_CONVERTERS]: 1,
                [ACM_METRIC_COUNT_LOCAL_FILTERS]: 0,
                [ACM_METRIC_COUNT_LOCAL_DISABLED]: 0,
                [ACM_METRIC_HARDWARE_WAVE_INPUT]: 0,
                [ACM_METRIC_HARDWARE_WAVE_OUTPUT]: 0,
                [ACM_METRIC_MAX_SIZE_FORMAT]: MAX_FORMAT_SIZE,
                [ACM_METRIC_MAX_SIZE_FILTER]: 0,
                [ACM_METRIC_DRIVER_SUPPORT]: DRIVER_SUPPORT,
                [ACM_METRIC_DRIVER_PRIORITY]: 1,
            };

            const value = values[uMetric];
            if (value === undefined) {
                Logger.warn(LogCategory.SYSTEM, `msacm32:acmMetrics unknown metric ${uMetric} -> MMSYSERR_NOTSUPPORTED`);
                return MMSYSERR_NOTSUPPORTED;
            }
            this.view(mem).setUint32(pMetric, value, true);
            return MMSYSERR_NOERROR;
        };
    }

    // ==================== drivers ====================

    private registerDriverApi(): void {
        // MMRESULT acmDriverOpen(LPHACMDRIVER phad, HACMDRIVERID hadid, DWORD fdwOpen)
        this.exports["acmDriverOpen"] = (ctx, mem, args) => {
            const phad = args[0] >>> 0;
            const hadid = args[1] >>> 0;
            if (args[2] >>> 0) return MMSYSERR_INVALFLAG;
            if (hadid !== PCM_DRIVER_ID) return MMSYSERR_INVALHANDLE;
            if (!phad || !isValidAddress(mem, phad, 4, "rw")) return MMSYSERR_INVALPARAM;
            this.view(mem).setUint32(phad, PCM_DRIVER_HANDLE, true);
            return MMSYSERR_NOERROR;
        };

        this.exports["acmDriverClose"] = (ctx, mem, args) => {
            if (args[1] >>> 0) return MMSYSERR_INVALFLAG;
            return (args[0] >>> 0) === PCM_DRIVER_HANDLE ? MMSYSERR_NOERROR : MMSYSERR_INVALHANDLE;
        };

        // MMRESULT acmDriverID(HACMOBJ hao, LPHACMDRIVERID phadid, DWORD fdwDriverID)
        this.exports["acmDriverID"] = (ctx, mem, args) => {
            const hao = args[0] >>> 0;
            const phadid = args[1] >>> 0;
            if (args[2] >>> 0) return MMSYSERR_INVALFLAG;
            if (hao !== PCM_DRIVER_HANDLE && hao !== PCM_DRIVER_ID && !this.streams.has(hao)) {
                return MMSYSERR_INVALHANDLE;
            }
            if (!phadid || !isValidAddress(mem, phadid, 4, "rw")) return MMSYSERR_INVALPARAM;
            this.view(mem).setUint32(phadid, PCM_DRIVER_ID, true);
            return MMSYSERR_NOERROR;
        };

        const driverDetails = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const hadid = args[0] >>> 0;
            const padd = args[1] >>> 0;
            if (args[2] >>> 0) return MMSYSERR_INVALFLAG;
            if (hadid !== PCM_DRIVER_ID && hadid !== PCM_DRIVER_HANDLE) return MMSYSERR_INVALHANDLE;
            if (!padd || !isValidAddress(mem, padd, 4, "rw")) return MMSYSERR_INVALPARAM;

            const v = this.view(mem);
            const cbStruct = v.getUint32(padd + ADD_A.cbStruct, true);
            if (cbStruct < ADD_A.hicon + 4) return MMSYSERR_INVALPARAM;
            if (!isValidAddress(mem, padd, Math.min(cbStruct, ADD_A.size), "rw")) return MMSYSERR_INVALPARAM;

            v.setUint32(padd + ADD_A.fccType, FCC_TYPE_AUDC, true);
            v.setUint32(padd + ADD_A.fccComp, 0, true);
            v.setUint16(padd + ADD_A.wMid, 1, true);   // MM_MICROSOFT
            v.setUint16(padd + ADD_A.wPid, 0, true);
            v.setUint32(padd + ADD_A.vdwACM, ACM_VERSION, true);
            v.setUint32(padd + ADD_A.vdwDriver, ACM_VERSION, true);
            v.setUint32(padd + ADD_A.fdwSupport, DRIVER_SUPPORT, true);
            v.setUint32(padd + ADD_A.cFormatTags, FORMAT_TAGS.length, true);
            v.setUint32(padd + ADD_A.cFilterTags, 0, true);
            v.setUint32(padd + ADD_A.hicon, 0, true);

            // The wide struct has the same layout with UTF-16 fields, so the text offsets
            // double past szShortName. Only fill what the caller's cbStruct covers.
            const strings: Array<[number, number, string]> = [
                [ADD_A.szShortName, ADD_CHARS.shortName, "Audio Codecs"],
                [ADD_A.szLongName, ADD_CHARS.longName, "Microsoft PCM Converter and ADPCM Codecs"],
                [ADD_A.szCopyright, ADD_CHARS.copyright, ""],
                [ADD_A.szLicensing, ADD_CHARS.licensing, ""],
                [ADD_A.szFeatures, ADD_CHARS.features, ""],
            ];
            let offset = ADD_A.szShortName;
            for (const [, chars, text] of strings) {
                const bytes = wide ? chars * 2 : chars;
                if (offset + bytes > cbStruct) break;
                if (wide) {
                    for (let i = 0; i < chars; i++) {
                        v.setUint16(padd + offset + i * 2, i < text.length ? text.charCodeAt(i) : 0, true);
                    }
                } else {
                    this.writeFixedAnsi(mem, padd + offset, chars, text);
                }
                offset += bytes;
            }
            return MMSYSERR_NOERROR;
        };
        this.exports["acmDriverDetailsA"] = driverDetails(false);
        this.exports["acmDriverDetailsW"] = driverDetails(true);

        // MMRESULT acmDriverEnum(ACMDRIVERENUMCB fnCallback, DWORD_PTR dwInstance, DWORD fdwEnum)
        // ACMDRIVERENUMCB(HACMDRIVERID hadid, DWORD_PTR dwInstance, DWORD fdwSupport) -> BOOL
        this.exports["acmDriverEnum"] = (ctx, mem, args) => {
            const fnCallback = args[0] >>> 0;
            const dwInstance = args[1] >>> 0;
            if (!fnCallback) return MMSYSERR_INVALPARAM;
            return this.enumerateOnce(ctx, 12, fnCallback,
                [PCM_DRIVER_ID, dwInstance, DRIVER_SUPPORT]);
        };

        this.exports["acmDriverMessage"] = (ctx, mem, args) => {
            const had = args[0] >>> 0;
            if (had !== PCM_DRIVER_HANDLE) return MMSYSERR_INVALHANDLE;
            Logger.verbose(LogCategory.SYSTEM, `msacm32:acmDriverMessage(msg=0x${(args[1] >>> 0).toString(16)}) -> MMSYSERR_NOTSUPPORTED`);
            return MMSYSERR_NOTSUPPORTED;
        };

        this.exports["acmDriverPriority"] = (ctx, mem, args) =>
            (args[0] >>> 0) === PCM_DRIVER_ID || (args[0] >>> 0) === 0 ? MMSYSERR_NOERROR : MMSYSERR_INVALHANDLE;

        // Installing a driver means running its DRIVERPROC — there is no such driver to run.
        const driverAdd: ThunkImplementation = (ctx, mem, args) => {
            const phadid = args[0] >>> 0;
            if (phadid && isValidAddress(mem, phadid, 4, "rw")) this.view(mem).setUint32(phadid, 0, true);
            Logger.warn(LogCategory.SYSTEM, "msacm32:acmDriverAdd -> MMSYSERR_NOTSUPPORTED (no driver installation)");
            return MMSYSERR_NOTSUPPORTED;
        };
        this.exports["acmDriverAddA"] = driverAdd;
        this.exports["acmDriverAddW"] = driverAdd;
        this.exports["acmDriverRemove"] = () => MMSYSERR_NOTSUPPORTED;
    }

    // ==================== formats ====================

    private registerFormatApi(): void {
        const formatTagDetails = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const paftd = args[1] >>> 0;
            if (!paftd || !isValidAddress(mem, paftd, AFTD.szFormatTag, "rw")) return MMSYSERR_INVALPARAM;
            const v = this.view(mem);
            // fdwDetails selects what the caller filled in: by index (0), or by tag /
            // by format (non-zero), where dwFormatTag names the tag it wants.
            const requestedTag = v.getUint32(paftd + AFTD.dwFormatTag, true);
            const index = v.getUint32(paftd + AFTD.dwFormatTagIndex, true);
            const byTag = (args[2] >>> 0) !== 0;
            const info = byTag
                ? (requestedTag === 0 ? FORMAT_TAGS[0] : FORMAT_TAGS.find(t => t.tag === requestedTag))
                : FORMAT_TAGS[index];
            if (!info) return ACMERR_NOTPOSSIBLE;

            v.setUint32(paftd + AFTD.dwFormatTagIndex, FORMAT_TAGS.indexOf(info), true);
            v.setUint32(paftd + AFTD.dwFormatTag, info.tag, true);
            v.setUint32(paftd + AFTD.cbFormatSize, info.formatSize, true);
            v.setUint32(paftd + AFTD.fdwSupport, DRIVER_SUPPORT, true);
            v.setUint32(paftd + AFTD.cStandardFormats, info.standardFormats, true);
            const nameBytes = wide ? AFTD_FORMATTAG_CHARS * 2 : AFTD_FORMATTAG_CHARS;
            if (isValidAddress(mem, paftd + AFTD.szFormatTag, nameBytes, "rw")) {
                if (wide) {
                    for (let i = 0; i < AFTD_FORMATTAG_CHARS; i++) {
                        v.setUint16(paftd + AFTD.szFormatTag + i * 2, i < info.name.length ? info.name.charCodeAt(i) : 0, true);
                    }
                } else {
                    this.writeFixedAnsi(mem, paftd + AFTD.szFormatTag, AFTD_FORMATTAG_CHARS, info.name);
                }
            }
            return MMSYSERR_NOERROR;
        };
        this.exports["acmFormatTagDetailsA"] = formatTagDetails(false);
        this.exports["acmFormatTagDetailsW"] = formatTagDetails(true);

        const formatDetails = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const pafd = args[1] >>> 0;
            if (!pafd || !isValidAddress(mem, pafd, AFD.szFormat, "rw")) return MMSYSERR_INVALPARAM;
            const v = this.view(mem);
            const index = v.getUint32(pafd + AFD.dwFormatIndex, true);
            const tag = v.getUint32(pafd + AFD.dwFormatTag, true) || WAVE_FORMAT_PCM;
            const info = FORMAT_TAGS.find(t => t.tag === tag);
            if (!info) return ACMERR_NOTPOSSIBLE;
            if (index >= info.standardFormats) return MMSYSERR_INVALPARAM;

            const pwfx = v.getUint32(pafd + AFD.pwfx, true);
            const cbwfx = v.getUint32(pafd + AFD.cbwfx, true);
            // A caller whose buffer cannot hold this tag's WAVEFORMATEX gets an error, not
            // a truncated format it would then hand to acmStreamOpen.
            const required = tag === WAVE_FORMAT_PCM ? WAVEFORMATEX_SIZE - 2 : info.formatSize;
            if (!pwfx || cbwfx < required || !isValidAddress(mem, pwfx, Math.min(cbwfx, info.formatSize), "rw")) {
                return MMSYSERR_INVALPARAM;
            }
            const format = tag === WAVE_FORMAT_PCM
                ? this.standardFormatAt(index)
                : this.standardAdpcmFormatAt(tag, index);
            if (tag === WAVE_FORMAT_PCM) this.writePcmFormat(mem, pwfx, format);
            else this.writeAdpcmFormat(mem, pwfx, format);

            v.setUint32(pafd + AFD.dwFormatTag, tag, true);
            v.setUint32(pafd + AFD.fdwSupport, DRIVER_SUPPORT, true);
            const depth = tag === WAVE_FORMAT_PCM ? `${format.bitsPerSample} Bit` : "4 Bit";
            const label = `${format.samplesPerSec} Hz, ${depth}, ${format.channels === 1 ? "Mono" : "Stereo"}`;
            const labelBytes = wide ? AFD_FORMAT_CHARS * 2 : AFD_FORMAT_CHARS;
            if (isValidAddress(mem, pafd + AFD.szFormat, labelBytes, "rw")) {
                if (wide) {
                    for (let i = 0; i < AFD_FORMAT_CHARS; i++) {
                        v.setUint16(pafd + AFD.szFormat + i * 2, i < label.length ? label.charCodeAt(i) : 0, true);
                    }
                } else {
                    this.writeFixedAnsi(mem, pafd + AFD.szFormat, AFD_FORMAT_CHARS, label);
                }
            }
            return MMSYSERR_NOERROR;
        };
        this.exports["acmFormatDetailsA"] = formatDetails(false);
        this.exports["acmFormatDetailsW"] = formatDetails(true);

        // ACMFORMATTAGENUMCB(HACMDRIVERID, LPACMFORMATTAGDETAILS, DWORD_PTR, DWORD) -> BOOL.
        // Every tag is enumerated, one callback each: a caller that walks this list to
        // decide whether it may open an ADPCM stream must SEE the ADPCM tags, or it will
        // never ask for the decode acmStreamOpen would have performed.
        const formatTagEnum = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const paftd = args[1] >>> 0;
            const fnCallback = args[2] >>> 0;
            const dwInstance = args[3] >>> 0;
            if (!fnCallback || !paftd) return MMSYSERR_INVALPARAM;
            const details = this.exports[wide ? "acmFormatTagDetailsW" : "acmFormatTagDetailsA"]!;
            return this.enumerateEach(ctx, 20, fnCallback, FORMAT_TAGS.length, (i) => {
                const curMem = System.getInstance().process!.getCurrentMemory();
                new DataView(curMem.buffer, curMem.byteOffset, curMem.byteLength)
                    .setUint32(paftd + AFTD.dwFormatTagIndex, i, true);
                if (details(ctx, curMem, [0, paftd, 0]) !== MMSYSERR_NOERROR) return null;
                return [PCM_DRIVER_ID, paftd, dwInstance, DRIVER_SUPPORT];
            });
        };
        this.exports["acmFormatTagEnumA"] = formatTagEnum(false);
        this.exports["acmFormatTagEnumW"] = formatTagEnum(true);

        // Every standard format of the tag the caller asked about (dwFormatTag 0 = PCM),
        // one callback per entry.
        const formatEnum = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const pafd = args[1] >>> 0;
            const fnCallback = args[2] >>> 0;
            const dwInstance = args[3] >>> 0;
            if (!fnCallback || !pafd) return MMSYSERR_INVALPARAM;
            const v = this.view(mem);
            const tag = v.getUint32(pafd + AFD.dwFormatTag, true) || WAVE_FORMAT_PCM;
            const info = FORMAT_TAGS.find(t => t.tag === tag);
            if (!info) return ACMERR_NOTPOSSIBLE;
            const details = this.exports[wide ? "acmFormatDetailsW" : "acmFormatDetailsA"]!;
            return this.enumerateEach(ctx, 20, fnCallback, info.standardFormats, (i) => {
                const curMem = System.getInstance().process!.getCurrentMemory();
                const cv = new DataView(curMem.buffer, curMem.byteOffset, curMem.byteLength);
                cv.setUint32(pafd + AFD.dwFormatIndex, i, true);
                cv.setUint32(pafd + AFD.dwFormatTag, tag, true);
                if (details(ctx, curMem, [0, pafd, 0]) !== MMSYSERR_NOERROR) return null;
                return [PCM_DRIVER_ID, pafd, dwInstance, DRIVER_SUPPORT];
            });
        };
        this.exports["acmFormatEnumA"] = formatEnum(false);
        this.exports["acmFormatEnumW"] = formatEnum(true);

        // MMRESULT acmFormatSuggest(HACMDRIVER had, LPWAVEFORMATEX pwfxSrc,
        //                           LPWAVEFORMATEX pwfxDst, DWORD cbwfxDst, DWORD fdwSuggest)
        this.exports["acmFormatSuggest"] = (ctx, mem, args) => {
            const pwfxSrc = args[1] >>> 0;
            const pwfxDst = args[2] >>> 0;
            const cbwfxDst = args[3] >>> 0;
            const fdwSuggest = args[4] >>> 0;

            const src = this.readWaveFormat(mem, pwfxSrc);
            if (!src) return MMSYSERR_INVALPARAM;
            if (cbwfxDst < WAVEFORMATEX_SIZE - 2 || !pwfxDst
                || !isValidAddress(mem, pwfxDst, Math.min(cbwfxDst, WAVEFORMATEX_SIZE), "rw")) {
                return MMSYSERR_INVALPARAM;
            }
            if ((fdwSuggest & ~ACM_FORMATSUGGESTF_TYPEMASK) !== 0) return MMSYSERR_INVALFLAG;

            const v = this.view(mem);
            // Each SUGGESTF flag means "this destination field is fixed, honour it";
            // everything else we are free to choose, and PCM at the source's shape is
            // what the PCM converter suggests.
            if ((fdwSuggest & ACM_FORMATSUGGESTF_WFORMATTAG) !== 0
                && v.getUint16(pwfxDst + WFX.wFormatTag, true) !== WAVE_FORMAT_PCM) {
                return ACMERR_NOTPOSSIBLE;
            }
            const dst: WaveFormat = {
                formatTag: WAVE_FORMAT_PCM,
                channels: (fdwSuggest & ACM_FORMATSUGGESTF_NCHANNELS) !== 0
                    ? v.getUint16(pwfxDst + WFX.nChannels, true) : src.channels,
                samplesPerSec: (fdwSuggest & ACM_FORMATSUGGESTF_NSAMPLESPERSEC) !== 0
                    ? v.getUint32(pwfxDst + WFX.nSamplesPerSec, true) : src.samplesPerSec,
                bitsPerSample: (fdwSuggest & ACM_FORMATSUGGESTF_WBITSPERSAMPLE) !== 0
                    ? v.getUint16(pwfxDst + WFX.wBitsPerSample, true) : (src.bitsPerSample === 8 ? 8 : 16),
                blockAlign: 0,
                samplesPerBlock: 0,
                coefs: null,
            };
            if (!this.isSupportedFormat(dst)) return ACMERR_NOTPOSSIBLE;
            this.writePcmFormat(mem, pwfxDst, dst);
            return MMSYSERR_NOERROR;
        };

        // acmFormatChoose opens the system format-picker dialog. We have no such dialog,
        // and inventing a selection would hand the caller a format the user never chose.
        const formatChoose: ThunkImplementation = () => {
            Logger.warn(LogCategory.SYSTEM, "msacm32:acmFormatChoose -> ACMERR_CANCELED (no format-picker dialog)");
            return ACMERR_CANCELED;
        };
        this.exports["acmFormatChooseA"] = formatChoose;
        this.exports["acmFormatChooseW"] = formatChoose;
    }

    // ==================== filters ====================

    /**
     * Filters are a separate driver class (volume, echo). A stock install has none, and
     * "none installed" is a state Windows itself reports — so these answer honestly
     * rather than pretending a filter driver exists.
     */
    private registerFilterApi(): void {
        const notPossible: ThunkImplementation = () => ACMERR_NOTPOSSIBLE;
        this.exports["acmFilterTagDetailsA"] = notPossible;
        this.exports["acmFilterTagDetailsW"] = notPossible;
        this.exports["acmFilterDetailsA"] = notPossible;
        this.exports["acmFilterDetailsW"] = notPossible;

        // An enumeration over an empty set is a success that calls back zero times.
        const enumNone: ThunkImplementation = (ctx, mem, args) =>
            (args[2] >>> 0) === 0 ? MMSYSERR_INVALPARAM : MMSYSERR_NOERROR;
        this.exports["acmFilterTagEnumA"] = enumNone;
        this.exports["acmFilterTagEnumW"] = enumNone;
        this.exports["acmFilterEnumA"] = enumNone;
        this.exports["acmFilterEnumW"] = enumNone;

        const filterChoose: ThunkImplementation = () => {
            Logger.warn(LogCategory.SYSTEM, "msacm32:acmFilterChoose -> ACMERR_CANCELED (no filter-picker dialog)");
            return ACMERR_CANCELED;
        };
        this.exports["acmFilterChooseA"] = filterChoose;
        this.exports["acmFilterChooseW"] = filterChoose;
    }

    // ==================== streams ====================

    private registerStreamApi(): void {
        // MMRESULT acmStreamOpen(LPHACMSTREAM phas, HACMDRIVER had,
        //     LPWAVEFORMATEX pwfxSrc, LPWAVEFORMATEX pwfxDst, LPWAVEFILTER pwfltr,
        //     DWORD_PTR dwCallback, DWORD_PTR dwInstance, DWORD fdwOpen)
        this.exports["acmStreamOpen"] = (ctx, mem, args) => {
            const phas = args[0] >>> 0;
            const pwfltr = args[4] >>> 0;
            const fdwOpen = args[7] >>> 0;
            const query = (fdwOpen & ACM_STREAMOPENF_QUERY) !== 0;

            const src = this.readWaveFormat(mem, args[2] >>> 0);
            const dst = this.readWaveFormat(mem, args[3] >>> 0);
            if (!src || !dst) return MMSYSERR_INVALPARAM;
            if (!query && (!phas || !isValidAddress(mem, phas, 4, "rw"))) return MMSYSERR_INVALPARAM;
            if ((fdwOpen & ACM_STREAMOPENF_ASYNC) !== 0) {
                // Async conversion posts completions to a window/callback; nothing in the
                // guest can observe a conversion we never scheduled, so refuse it outright.
                Logger.warn(LogCategory.SYSTEM, "msacm32:acmStreamOpen ASYNC requested -> MMSYSERR_NOTSUPPORTED");
                return MMSYSERR_NOTSUPPORTED;
            }
            if (pwfltr) {
                Logger.warn(LogCategory.SYSTEM, "msacm32:acmStreamOpen with a filter -> ACMERR_NOTPOSSIBLE (no filter drivers)");
                return ACMERR_NOTPOSSIBLE;
            }

            // PCM→PCM is the converter; ADPCM→PCM is a decode. Anything else (an ADPCM
            // *encode*, an ADPCM→ADPCM transcode, or a codec we do not ship) is refused
            // the way Windows refuses a driver it cannot find.
            const decodes = this.isDecodableAdpcm(src) && this.isSupportedFormat(dst);
            const converts = this.isSupportedFormat(src) && this.isSupportedFormat(dst);
            if (!decodes && !converts) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `msacm32:acmStreamOpen ${src.formatTag}/${src.bitsPerSample}bit/${src.channels}ch/${src.samplesPerSec}Hz ` +
                    `-> ${dst.formatTag}/${dst.bitsPerSample}bit/${dst.channels}ch/${dst.samplesPerSec}Hz: ` +
                    `ACMERR_NOTPOSSIBLE (installed: PCM converter, MS-ADPCM and IMA-ADPCM decode)`
                );
                if (!query && phas) this.view(mem).setUint32(phas, 0, true);
                return ACMERR_NOTPOSSIBLE;
            }

            if (query) return MMSYSERR_NOERROR;

            const handle = this.nextStreamHandle++;
            this.streams.set(handle, { src, dst });
            this.view(mem).setUint32(phas, handle, true);
            Logger.verbose(
                LogCategory.SYSTEM,
                `msacm32:acmStreamOpen -> 0x${handle.toString(16)} ` +
                `(${src.bitsPerSample}bit/${src.channels}ch/${src.samplesPerSec}Hz -> ` +
                `${dst.bitsPerSample}bit/${dst.channels}ch/${dst.samplesPerSec}Hz)`
            );
            return MMSYSERR_NOERROR;
        };

        this.exports["acmStreamClose"] = (ctx, mem, args) => {
            if (args[1] >>> 0) return MMSYSERR_INVALFLAG;
            return this.streams.delete(args[0] >>> 0) ? MMSYSERR_NOERROR : MMSYSERR_INVALHANDLE;
        };

        this.exports["acmStreamReset"] = (ctx, mem, args) => {
            if (args[1] >>> 0) return MMSYSERR_INVALFLAG;
            // Conversion is stateless here — there is no queue or resampler phase to drop.
            return this.streams.has(args[0] >>> 0) ? MMSYSERR_NOERROR : MMSYSERR_INVALHANDLE;
        };

        this.exports["acmStreamMessage"] = (ctx, mem, args) =>
            this.streams.has(args[0] >>> 0) ? MMSYSERR_NOTSUPPORTED : MMSYSERR_INVALHANDLE;

        // MMRESULT acmStreamSize(HACMSTREAM has, DWORD cbInput, LPDWORD pdwOutputBytes, DWORD fdwSize)
        this.exports["acmStreamSize"] = (ctx, mem, args) => {
            const stream = this.streams.get(args[0] >>> 0);
            const cbInput = args[1] >>> 0;
            const pdwOutputBytes = args[2] >>> 0;
            const fdwSize = args[3] >>> 0;
            if (!stream) return MMSYSERR_INVALHANDLE;
            if (!pdwOutputBytes || !isValidAddress(mem, pdwOutputBytes, 4, "rw")) return MMSYSERR_INVALPARAM;
            if ((fdwSize & ~ACM_STREAMSIZEF_QUERYMASK) !== 0) return MMSYSERR_INVALFLAG;

            const direction = fdwSize & ACM_STREAMSIZEF_QUERYMASK;
            let out: number;
            if (direction === ACM_STREAMSIZEF_SOURCE) {
                out = this.dstFramesForSrc(stream, this.srcFramesInBytes(stream, cbInput)) * frameBytes(stream.dst);
            } else if (direction === ACM_STREAMSIZEF_DESTINATION) {
                out = this.srcBytesForFrames(
                    stream, this.srcFramesForDst(stream, Math.floor(cbInput / frameBytes(stream.dst))));
            } else {
                return MMSYSERR_INVALFLAG;
            }
            // Windows fails a query whose answer is zero rather than reporting a size no
            // caller can act on; a zero-length buffer is a caller bug, not a conversion.
            if (out === 0) return ACMERR_NOTPOSSIBLE;
            this.view(mem).setUint32(pdwOutputBytes, out, true);
            return MMSYSERR_NOERROR;
        };

        const prepare = (prepareIt: boolean): ThunkImplementation => (ctx, mem, args) => {
            const has = args[0] >>> 0;
            const pash = args[1] >>> 0;
            if (args[2] >>> 0) return MMSYSERR_INVALFLAG;
            if (!this.streams.has(has)) return MMSYSERR_INVALHANDLE;
            if (!pash || !isValidAddress(mem, pash, ACMSTREAMHEADER_SIZE, "rw")) return MMSYSERR_INVALPARAM;
            const v = this.view(mem);
            if (v.getUint32(pash + ASH.cbStruct, true) < ACMSTREAMHEADER_SIZE) return MMSYSERR_INVALPARAM;

            const status = v.getUint32(pash + ASH.fdwStatus, true);
            if (prepareIt) {
                v.setUint32(pash + ASH.fdwStatus, status | ACMSTREAMHEADER_STATUSF_PREPARED, true);
                v.setUint32(pash + ASH.cbSrcLengthUsed, 0, true);
                v.setUint32(pash + ASH.cbDstLengthUsed, 0, true);
            } else {
                if ((status & ACMSTREAMHEADER_STATUSF_PREPARED) === 0) return ACMERR_UNPREPARED;
                v.setUint32(pash + ASH.fdwStatus, status & ~ACMSTREAMHEADER_STATUSF_PREPARED, true);
            }
            return MMSYSERR_NOERROR;
        };
        this.exports["acmStreamPrepareHeader"] = prepare(true);
        this.exports["acmStreamUnprepareHeader"] = prepare(false);

        // MMRESULT acmStreamConvert(HACMSTREAM has, LPACMSTREAMHEADER pash, DWORD fdwConvert)
        this.exports["acmStreamConvert"] = (ctx, mem, args) => {
            const stream = this.streams.get(args[0] >>> 0);
            const pash = args[1] >>> 0;
            if (!stream) return MMSYSERR_INVALHANDLE;
            if (!pash || !isValidAddress(mem, pash, ACMSTREAMHEADER_SIZE, "rw")) return MMSYSERR_INVALPARAM;

            const v = this.view(mem);
            if (v.getUint32(pash + ASH.cbStruct, true) < ACMSTREAMHEADER_SIZE) return MMSYSERR_INVALPARAM;
            const status = v.getUint32(pash + ASH.fdwStatus, true);
            if ((status & ACMSTREAMHEADER_STATUSF_PREPARED) === 0) return ACMERR_UNPREPARED;

            const pbSrc = v.getUint32(pash + ASH.pbSrc, true);
            const cbSrcLength = v.getUint32(pash + ASH.cbSrcLength, true);
            const pbDst = v.getUint32(pash + ASH.pbDst, true);
            const cbDstLength = v.getUint32(pash + ASH.cbDstLength, true);
            if (!isValidAddress(mem, pbSrc, cbSrcLength, "r") || !isValidAddress(mem, pbDst, cbDstLength, "rw")) {
                return MMSYSERR_INVALPARAM;
            }

            const dstFrameBytes = frameBytes(stream.dst);
            const srcFramesAvailable = this.srcFramesInBytes(stream, cbSrcLength);
            const dstFramesRoom = Math.floor(cbDstLength / dstFrameBytes);
            const dstFrames = Math.min(this.dstFramesForSrc(stream, srcFramesAvailable), dstFramesRoom);

            const done = this.isBlockSource(stream)
                ? this.convertFromBlocks(mem, stream, pbSrc, cbSrcLength, pbDst, dstFrames)
                : this.convertPcm(mem, stream, pbSrc, srcFramesAvailable, pbDst, dstFrames);

            v.setUint32(pash + ASH.cbSrcLengthUsed, this.srcBytesForFrames(stream, done.srcFrames), true);
            v.setUint32(pash + ASH.cbDstLengthUsed, done.dstFrames * dstFrameBytes, true);
            v.setUint32(pash + ASH.fdwStatus, status | ACMSTREAMHEADER_STATUSF_DONE, true);
            return MMSYSERR_NOERROR;
        };
    }

    /**
     * The PCM converter proper: point-sampled rate conversion with channel and depth
     * mapping. Returns the source frames consumed (what cbSrcLengthUsed is derived from —
     * the caller advances its own buffer by it and a wrong value silently drops audio)
     * and the destination frames actually written.
     */
    private convertPcm(
        mem: Uint8Array, stream: AcmStream,
        srcPtr: number, srcFramesAvailable: number,
        dstPtr: number, dstFrames: number
    ): { srcFrames: number; dstFrames: number } {
        const { src } = stream;
        const v = this.view(mem);
        const srcStride = frameBytes(src);
        const src16 = src.bitsPerSample === 16;

        // 8-bit PCM is unsigned with 0x80 silence, 16-bit is signed — the conversion is a
        // bias shift, not just a scale, and getting it wrong is a DC offset, not silence.
        const readSample = (frame: number, channel: number): number => {
            const at = srcPtr + frame * srcStride + channel * (src16 ? 2 : 1);
            return src16 ? v.getInt16(at, true) : (mem[at]! - 128) << 8;
        };
        return this.writeConverted(mem, stream, readSample, srcFramesAvailable, dstPtr, dstFrames);
    }

    /** Decoded-PCM scratch, reused across conversions (grown, never reallocated per call). */
    private pcmScratch = new Int16Array(0);

    /**
     * ADPCM source: decode the blocks the requested output needs, then run the very same
     * rate/channel/depth conversion over the decoded samples. cbSrcLengthUsed is always a
     * whole number of blocks, because a block is the smallest thing that can be decoded.
     */
    private convertFromBlocks(
        mem: Uint8Array, stream: AcmStream,
        srcPtr: number, cbSrcLength: number,
        dstPtr: number, dstFrames: number
    ): { srcFrames: number; dstFrames: number } {
        const { src } = stream;
        const perBlock = adpcmSamplesPerBlock(src);
        const blocksAvailable = Math.floor(cbSrcLength / src.blockAlign);
        if (perBlock <= 0 || blocksAvailable <= 0 || dstFrames <= 0) {
            return { srcFrames: 0, dstFrames: 0 };
        }
        const framesNeeded = this.srcFramesForDst(stream, dstFrames);
        const blocks = Math.min(blocksAvailable, Math.max(1, Math.ceil(framesNeeded / perBlock)));

        const need = blocks * perBlock * src.channels;
        if (this.pcmScratch.length < need) this.pcmScratch = new Int16Array(need);
        const pcm = this.pcmScratch;

        let frames = 0;
        for (let b = 0; b < blocks; b++) {
            const at = srcPtr + b * src.blockAlign;
            const written = src.formatTag === WAVE_FORMAT_ADPCM
                ? decodeMsAdpcmBlock(mem, at, src.blockAlign, src.channels,
                    src.coefs ?? MS_STANDARD_COEFS, perBlock, pcm, frames * src.channels)
                : decodeImaAdpcmBlock(mem, at, src.blockAlign, src.channels,
                    perBlock, pcm, frames * src.channels);
            if (written === 0) {
                // A block we cannot decode ends the conversion here: reporting it as
                // consumed would hand the caller silence it has no way to notice.
                Logger.warn(LogCategory.SYSTEM,
                    `msacm32:acmStreamConvert malformed ADPCM block ${b} (tag=0x${src.formatTag.toString(16)})`);
                break;
            }
            frames += written;
        }
        if (frames === 0) return { srcFrames: 0, dstFrames: 0 };

        const readSample = (frame: number, channel: number): number =>
            pcm[frame * src.channels + channel]!;
        const room = Math.min(dstFrames, this.dstFramesForSrc(stream, frames));
        const done = this.writeConverted(mem, stream, readSample, frames, dstPtr, room);
        // Whole blocks were consumed even if the tail of the last one was not needed.
        return { srcFrames: frames, dstFrames: done.dstFrames };
    }

    /** Rate/channel/depth mapping from an abstract source into the guest's PCM buffer. */
    private writeConverted(
        mem: Uint8Array, stream: AcmStream,
        readSample: (frame: number, channel: number) => number,
        srcFramesAvailable: number,
        dstPtr: number, dstFrames: number
    ): { srcFrames: number; dstFrames: number } {
        const { src, dst } = stream;
        const v = this.view(mem);
        const dstStride = frameBytes(dst);
        const dst16 = dst.bitsPerSample === 16;
        const writeSample = (frame: number, channel: number, value: number): void => {
            const at = dstPtr + frame * dstStride + channel * (dst16 ? 2 : 1);
            if (dst16) v.setInt16(at, Math.max(-32768, Math.min(32767, value)), true);
            else mem[at] = Math.max(0, Math.min(255, (value >> 8) + 128));
        };

        let maxSrcFrame = -1;
        let written = 0;
        for (let i = 0; i < dstFrames; i++) {
            const srcFrame = Math.min(
                srcFramesAvailable - 1,
                Math.floor((i * src.samplesPerSec) / dst.samplesPerSec)
            );
            if (srcFrame < 0) break;
            if (srcFrame > maxSrcFrame) maxSrcFrame = srcFrame;

            if (src.channels === dst.channels) {
                for (let c = 0; c < dst.channels; c++) writeSample(i, c, readSample(srcFrame, c));
            } else if (src.channels === 1) {
                const mono = readSample(srcFrame, 0);
                for (let c = 0; c < dst.channels; c++) writeSample(i, c, mono);
            } else {
                writeSample(i, 0, (readSample(srcFrame, 0) + readSample(srcFrame, 1)) >> 1);
            }
            written++;
        }
        return { srcFrames: maxSrcFrame + 1, dstFrames: written };
    }

    /**
     * Call a guest enumeration callback once and return through it. The callback's BOOL
     * result only decides whether to continue, and with one item there is nothing to
     * continue to — so the enumeration is complete either way.
     */
    private enumerateOnce(ctx: unknown, stackCleanup: number, fnCallback: number, callbackArgs: number[]): ThunkResult {
        const system = System.getInstance();
        const callbackManager = system.process?.dispatcher.callbackManager;
        if (!callbackManager || system.isExiting) return { value: MMSYSERR_NOERROR, stackCleanup };

        callbackManager.saveSuspendedThunkContext(ctx as never, stackCleanup);
        const { callbackId } = callbackManager.invokeCallback(
            // ACM's enumeration callbacks are CALLBACK (stdcall): the callee cleans its
            // own arguments, so the caller has nothing to clean.
            fnCallback, callbackArgs, 0, () => MMSYSERR_NOERROR
        );
        return { value: MMSYSERR_NOERROR, suspendedForCallback: true, callbackId, stackCleanup };
    }

    /**
     * Call a guest enumeration callback once per item, chaining each invocation from the
     * previous one's return (the callback returns FALSE to stop). `prepare` fills the
     * caller's struct for item i and returns the callback arguments, or null to stop.
     */
    private enumerateEach(
        ctx: unknown, stackCleanup: number, fnCallback: number, count: number,
        prepare: (index: number) => number[] | null,
    ): ThunkResult {
        const system = System.getInstance();
        const callbackManager = system.process?.dispatcher.callbackManager;
        if (!callbackManager || system.isExiting || count <= 0) {
            return { value: MMSYSERR_NOERROR, stackCleanup };
        }

        const frameId = callbackManager.saveSuspendedThunkContext(ctx as never, stackCleanup, "acmEnum");
        if (!frameId) return { value: MMSYSERR_NOERROR, stackCleanup };

        let index = 0;
        let firstCallbackId: number | null = null;
        const step = (): void => {
            if (index >= count) return;
            const callbackArgs = prepare(index++);
            if (!callbackArgs) return;
            const { callbackId } = callbackManager.invokeCallback(
                fnCallback, callbackArgs, 0,
                (callbackReturnValue) => {
                    // BOOL: FALSE stops the enumeration, and so does running out.
                    if (callbackReturnValue === 0 || index >= count) return MMSYSERR_NOERROR;
                    return null; // continue — enumerationState drives the next one
                },
                false, "acmEnum", frameId,
            );
            if (firstCallbackId === null) firstCallbackId = callbackId;
            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = { continueEnumeration: step, finishEnumeration: () => {} };
                if (callbackId !== firstCallbackId) {
                    const first = callbackManager.getPendingCallback(firstCallbackId);
                    if (first?.thunkContext) invocation.thunkContext = first.thunkContext;
                }
            }
        };

        // If nothing dispatched, the saved frame has pinned this thread and no callback
        // will ever release it — hand the frame back and answer synchronously instead.
        try {
            step();
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `msacm32: enumeration callback dispatch failed: ${(e as Error)?.message ?? e}`);
        }
        if (firstCallbackId === null) {
            callbackManager.abandonSuspendedFrame(frameId);
            return { value: MMSYSERR_NOERROR, stackCleanup };
        }
        return { value: MMSYSERR_NOERROR, suspendedForCallback: true, callbackId: firstCallbackId, stackCleanup };
    }
}
