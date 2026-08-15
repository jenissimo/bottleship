/**
 * MSACM32.dll — the Audio Compression Manager.
 *
 * What a real install always has behind this DLL is the system PCM converter
 * (msacm.pcm): it converts between PCM formats — bit depth, channel count, sample
 * rate — and nothing else. Codec drivers (ADPCM, GSM, MP3) are separate drivers, and
 * a machine without one gets ACMERR_NOTPOSSIBLE out of acmStreamOpen. That is exactly
 * what we are: the converter is real, a codec request fails the way Windows fails it,
 * and the WARN names the format tag so the gap is visible rather than silent.
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
}

interface AcmStream {
    src: WaveFormat;
    dst: WaveFormat;
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
        return {
            formatTag: v.getUint16(ptr + WFX.wFormatTag, true),
            channels,
            samplesPerSec: v.getUint32(ptr + WFX.nSamplesPerSec, true),
            bitsPerSample: bits,
            blockAlign: v.getUint16(ptr + WFX.nBlockAlign, true) || Math.max(1, (bits >> 3) * channels),
        };
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

    private writeFixedAnsi(mem: Uint8Array, ptr: number, chars: number, text: string): void {
        const bytes = encodeAnsi(text);
        const n = Math.min(bytes.length, chars - 1);
        for (let i = 0; i < n; i++) mem[ptr + i] = bytes[i]!;
        for (let i = n; i < chars; i++) mem[ptr + i] = 0;
    }

    /** PCM is the only tag we convert; anything else is a codec we do not have. */
    private isSupportedFormat(f: WaveFormat): boolean {
        return f.formatTag === WAVE_FORMAT_PCM
            && (f.bitsPerSample === 8 || f.bitsPerSample === 16)
            && (f.channels === 1 || f.channels === 2)
            && f.samplesPerSec > 0;
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
        };
    }

    /** Source frames that produce `dstFrames` destination frames, and the reverse. */
    private srcFramesForDst(s: AcmStream, dstFrames: number): number {
        return Math.ceil((dstFrames * s.src.samplesPerSec) / s.dst.samplesPerSec);
    }

    private dstFramesForSrc(s: AcmStream, srcFrames: number): number {
        return Math.floor((srcFrames * s.dst.samplesPerSec) / s.src.samplesPerSec);
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
                [ACM_METRIC_COUNT_CODECS]: 0,
                [ACM_METRIC_COUNT_CONVERTERS]: 1,
                [ACM_METRIC_COUNT_FILTERS]: 0,
                [ACM_METRIC_COUNT_DISABLED]: 0,
                [ACM_METRIC_COUNT_HARDWARE]: 0,
                [ACM_METRIC_COUNT_LOCAL_DRIVERS]: 1,
                [ACM_METRIC_COUNT_LOCAL_CODECS]: 0,
                [ACM_METRIC_COUNT_LOCAL_CONVERTERS]: 1,
                [ACM_METRIC_COUNT_LOCAL_FILTERS]: 0,
                [ACM_METRIC_COUNT_LOCAL_DISABLED]: 0,
                [ACM_METRIC_HARDWARE_WAVE_INPUT]: 0,
                [ACM_METRIC_HARDWARE_WAVE_OUTPUT]: 0,
                [ACM_METRIC_MAX_SIZE_FORMAT]: WAVEFORMATEX_SIZE,
                [ACM_METRIC_MAX_SIZE_FILTER]: 0,
                [ACM_METRIC_DRIVER_SUPPORT]: ACMDRIVERDETAILS_SUPPORTF_CONVERTER,
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
            v.setUint32(padd + ADD_A.fdwSupport, ACMDRIVERDETAILS_SUPPORTF_CONVERTER, true);
            v.setUint32(padd + ADD_A.cFormatTags, 1, true);
            v.setUint32(padd + ADD_A.cFilterTags, 0, true);
            v.setUint32(padd + ADD_A.hicon, 0, true);

            // The wide struct has the same layout with UTF-16 fields, so the text offsets
            // double past szShortName. Only fill what the caller's cbStruct covers.
            const strings: Array<[number, number, string]> = [
                [ADD_A.szShortName, ADD_CHARS.shortName, "PCM Converter"],
                [ADD_A.szLongName, ADD_CHARS.longName, "Microsoft PCM Converter"],
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
                [PCM_DRIVER_ID, dwInstance, ACMDRIVERDETAILS_SUPPORTF_CONVERTER]);
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
            // fdwDetails selects what the caller filled in: by index (0), by tag, or by
            // format. All three land on the one tag we have, so only reject a foreign tag.
            const requestedTag = v.getUint32(paftd + AFTD.dwFormatTag, true);
            const byTag = (args[2] >>> 0) !== 0;
            if (byTag && requestedTag !== WAVE_FORMAT_PCM && requestedTag !== 0) return ACMERR_NOTPOSSIBLE;

            v.setUint32(paftd + AFTD.dwFormatTagIndex, 0, true);
            v.setUint32(paftd + AFTD.dwFormatTag, WAVE_FORMAT_PCM, true);
            v.setUint32(paftd + AFTD.cbFormatSize, WAVEFORMATEX_SIZE, true);
            v.setUint32(paftd + AFTD.fdwSupport, ACMDRIVERDETAILS_SUPPORTF_CONVERTER, true);
            v.setUint32(paftd + AFTD.cStandardFormats, STANDARD_FORMAT_COUNT, true);
            const nameBytes = wide ? AFTD_FORMATTAG_CHARS * 2 : AFTD_FORMATTAG_CHARS;
            if (isValidAddress(mem, paftd + AFTD.szFormatTag, nameBytes, "rw")) {
                if (wide) {
                    const text = "PCM";
                    for (let i = 0; i < AFTD_FORMATTAG_CHARS; i++) {
                        v.setUint16(paftd + AFTD.szFormatTag + i * 2, i < text.length ? text.charCodeAt(i) : 0, true);
                    }
                } else {
                    this.writeFixedAnsi(mem, paftd + AFTD.szFormatTag, AFTD_FORMATTAG_CHARS, "PCM");
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
            const tag = v.getUint32(pafd + AFD.dwFormatTag, true);
            if (tag !== 0 && tag !== WAVE_FORMAT_PCM) return ACMERR_NOTPOSSIBLE;
            if (index >= STANDARD_FORMAT_COUNT) return MMSYSERR_INVALPARAM;

            const pwfx = v.getUint32(pafd + AFD.pwfx, true);
            const cbwfx = v.getUint32(pafd + AFD.cbwfx, true);
            if (!pwfx || cbwfx < WAVEFORMATEX_SIZE - 2 || !isValidAddress(mem, pwfx, Math.min(cbwfx, WAVEFORMATEX_SIZE), "rw")) {
                return MMSYSERR_INVALPARAM;
            }
            const format = this.standardFormatAt(index);
            this.writePcmFormat(mem, pwfx, format);

            v.setUint32(pafd + AFD.dwFormatTag, WAVE_FORMAT_PCM, true);
            v.setUint32(pafd + AFD.fdwSupport, ACMDRIVERDETAILS_SUPPORTF_CONVERTER, true);
            const label = `${format.samplesPerSec} Hz, ${format.bitsPerSample} Bit, ${format.channels === 1 ? "Mono" : "Stereo"}`;
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

        // ACMFORMATTAGENUMCB(HACMDRIVERID, LPACMFORMATTAGDETAILS, DWORD_PTR, DWORD) -> BOOL
        const formatTagEnum = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const paftd = args[1] >>> 0;
            const fnCallback = args[2] >>> 0;
            const dwInstance = args[3] >>> 0;
            if (!fnCallback || !paftd) return MMSYSERR_INVALPARAM;
            const filled = (this.exports[wide ? "acmFormatTagDetailsW" : "acmFormatTagDetailsA"]!)(ctx, mem, [0, paftd, 0]);
            if (filled !== MMSYSERR_NOERROR) return filled as number;
            return this.enumerateOnce(ctx, 20, fnCallback,
                [PCM_DRIVER_ID, paftd, dwInstance, ACMDRIVERDETAILS_SUPPORTF_CONVERTER]);
        };
        this.exports["acmFormatTagEnumA"] = formatTagEnum(false);
        this.exports["acmFormatTagEnumW"] = formatTagEnum(true);

        // Enumerating every standard format needs a callback per entry; the chained form
        // exists in ddraw and is the shape to grow into if a title ever walks the list.
        const formatEnum = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
            const pafd = args[1] >>> 0;
            const fnCallback = args[2] >>> 0;
            const dwInstance = args[3] >>> 0;
            if (!fnCallback || !pafd) return MMSYSERR_INVALPARAM;
            const v = this.view(mem);
            v.setUint32(pafd + AFD.dwFormatIndex, 0, true);
            const filled = (this.exports[wide ? "acmFormatDetailsW" : "acmFormatDetailsA"]!)(ctx, mem, [0, pafd, 0]);
            if (filled !== MMSYSERR_NOERROR) return filled as number;
            return this.enumerateOnce(ctx, 20, fnCallback,
                [PCM_DRIVER_ID, pafd, dwInstance, ACMDRIVERDETAILS_SUPPORTF_CONVERTER]);
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

            if (!this.isSupportedFormat(src) || !this.isSupportedFormat(dst)) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `msacm32:acmStreamOpen ${src.formatTag}/${src.bitsPerSample}bit/${src.channels}ch/${src.samplesPerSec}Hz ` +
                    `-> ${dst.formatTag}/${dst.bitsPerSample}bit/${dst.channels}ch/${dst.samplesPerSec}Hz: ` +
                    `ACMERR_NOTPOSSIBLE (only the PCM converter is installed)`
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
                out = this.dstFramesForSrc(stream, Math.floor(cbInput / frameBytes(stream.src))) * frameBytes(stream.dst);
            } else if (direction === ACM_STREAMSIZEF_DESTINATION) {
                out = this.srcFramesForDst(stream, Math.floor(cbInput / frameBytes(stream.dst))) * frameBytes(stream.src);
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

            const srcFrameBytes = frameBytes(stream.src);
            const dstFrameBytes = frameBytes(stream.dst);
            const srcFramesAvailable = Math.floor(cbSrcLength / srcFrameBytes);
            const dstFramesRoom = Math.floor(cbDstLength / dstFrameBytes);
            const dstFrames = Math.min(this.dstFramesForSrc(stream, srcFramesAvailable), dstFramesRoom);

            const srcFramesUsed = this.convertPcm(mem, stream, pbSrc, srcFramesAvailable, pbDst, dstFrames);

            v.setUint32(pash + ASH.cbSrcLengthUsed, srcFramesUsed * srcFrameBytes, true);
            v.setUint32(pash + ASH.cbDstLengthUsed, dstFrames * dstFrameBytes, true);
            v.setUint32(pash + ASH.fdwStatus, status | ACMSTREAMHEADER_STATUSF_DONE, true);
            return MMSYSERR_NOERROR;
        };
    }

    /**
     * The PCM converter proper: point-sampled rate conversion with channel and depth
     * mapping. Returns the source frames consumed, which is what cbSrcLengthUsed means —
     * the caller advances its own buffer by it and a wrong value silently drops audio.
     */
    private convertPcm(
        mem: Uint8Array, stream: AcmStream,
        srcPtr: number, srcFramesAvailable: number,
        dstPtr: number, dstFrames: number
    ): number {
        const { src, dst } = stream;
        const v = this.view(mem);
        const srcStride = frameBytes(src);
        const dstStride = frameBytes(dst);
        const src16 = src.bitsPerSample === 16;
        const dst16 = dst.bitsPerSample === 16;

        // 8-bit PCM is unsigned with 0x80 silence, 16-bit is signed — the conversion is a
        // bias shift, not just a scale, and getting it wrong is a DC offset, not silence.
        const readSample = (frame: number, channel: number): number => {
            const at = srcPtr + frame * srcStride + channel * (src16 ? 2 : 1);
            return src16 ? v.getInt16(at, true) : (mem[at]! - 128) << 8;
        };
        const writeSample = (frame: number, channel: number, value: number): void => {
            const at = dstPtr + frame * dstStride + channel * (dst16 ? 2 : 1);
            if (dst16) v.setInt16(at, Math.max(-32768, Math.min(32767, value)), true);
            else mem[at] = Math.max(0, Math.min(255, (value >> 8) + 128));
        };

        let maxSrcFrame = -1;
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
        }
        return maxSrcFrame + 1;
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
            fnCallback, callbackArgs, callbackArgs.length * 4, () => MMSYSERR_NOERROR
        );
        return { value: MMSYSERR_NOERROR, suspendedForCallback: true, callbackId, stackCleanup };
    }
}
