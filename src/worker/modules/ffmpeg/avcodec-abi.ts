/**
 * Pin the ffmpeg ABI from the shipped DLLs themselves, not from a header we happen to hold.
 *
 * Three independent, refusable measurements:
 *   - `avcodec_version()`'s whole body is `mov eax, imm32; ret` — the library version.
 *   - the DLL's own `avcodec_options` AVOption table stores `offsetof(AVCodecContext, field)`
 *     in every 48-byte row, so a dozen field offsets are readable with no header at all.
 *   - `av_frame_alloc`'s `push imm32` before its allocator call is `sizeof(AVFrame)`.
 *
 * A build whose measurements disagree with the layout we know is REFUSED. There is no
 * VS_VERSIONINFO on these DLLs (the Bink precedent does not apply), and publishing a 1080p
 * frame through wrong offsets does not fail visibly — it overwrites whatever the guest keeps
 * there instead.
 */

import { Logger, LogCategory } from '../../core/logger';
import type { LoadedPEModule } from '../../core/module-registry';
import { resolveExportBodyRva } from '../../core/hle-lib/lib-patcher';

export interface AvcodecAbi {
    /** Lavc version as measured, e.g. "56.1.100". */
    version: string;
    versionMajor: number;
    /** AVCodecContext */
    ctxCodecType: number;
    ctxCodec: number;
    ctxWidth: number;
    ctxHeight: number;
    ctxPixFmt: number;
    ctxRefcountedFrames: number;
    /** AVFrame */
    frameSizeof: number;
    frameData: number;
    frameLinesize: number;
    frameWidth: number;
    frameHeight: number;
    frameFormat: number;
    framePts: number;
    frameBestEffort: number;
    frameBuf: number;
    /** AVPacket */
    pktPts: number;
    pktData: number;
    pktSize: number;
    pktFlags: number;
    /** AVCodec (the decoder descriptor `avctx->codec` points at) */
    codecName: number;
    codecType: number;
}

/** AV_PIX_FMT_YUV420P — what the fast, swscale-free consumer path wants. */
export const AV_PIX_FMT_YUV420P = 0;
/** AVMEDIA_TYPE_VIDEO. */
export const AVMEDIA_TYPE_VIDEO = 0;
/** AV_PKT_FLAG_KEY. */
export const AV_PKT_FLAG_KEY = 1;
/** AV_NOPTS_VALUE — INT64_MIN. */
export const AV_NOPTS_LO = 0;
export const AV_NOPTS_HI = 0x80000000;

/**
 * FFmpeg 2.4 / Lavc 56 (32-bit, MSVC). The deprecated-lavc block is present in this family,
 * so a layout taken from a modern frame.h is wrong by ~112 bytes from `sample_aspect_ratio`
 * onward — including `pts`. Every offset here is either measured below or bracketed by two
 * offsets that are.
 */
const LAVC56: Omit<AvcodecAbi, 'version' | 'versionMajor'> = {
    ctxCodecType: 0x08,
    ctxCodec: 0x0c,
    ctxWidth: 0x78,
    ctxHeight: 0x7c,
    ctxPixFmt: 0x8c,
    ctxRefcountedFrames: 0x1e8,
    frameSizeof: 0x1e0,
    frameData: 0x00,
    frameLinesize: 0x20,
    frameWidth: 0x44,
    frameHeight: 0x48,
    frameFormat: 0x50,
    framePts: 0x88,
    frameBestEffort: 0x1b0,
    frameBuf: 0x168,
    pktPts: 0x08,
    pktData: 0x18,
    pktSize: 0x1c,
    pktFlags: 0x24,
    codecName: 0x00,
    codecType: 0x08,
};

/**
 * AVOption rows we require to match before trusting the rest of the AVCodecContext layout.
 * `g` and `me_method` bracket `pix_fmt`; `delay` and `g` bracket `width`/`height` — those two
 * are not options in any build, so the bracket plus the version match is as far as static
 * measurement reaches. The runtime dimension cross-check in the decoder closes the gap.
 */
const AVOPTION_ANCHORS: Record<string, number> = {
    b: 0x48,
    flags: 0x58,
    extradata_size: 0x64,
    time_base: 0x68,
    delay: 0x74,
    g: 0x88,
    me_method: 0x90,
    ar: 0x19c,
    ac: 0x1a0,
    refcounted_frames: 0x1e8,
    lowres: 0x320,
    threads: 0x328,
};

/** AVOption row stride, and the type value above which a row is a named CONST, not a field. */
const AVOPTION_ROW = 48;
const AV_OPT_TYPE_CONST = 128;

interface Section { start: number; end: number }

function readableSections(module: LoadedPEModule, memLen: number): Section[] {
    const out: Section[] = [];
    for (const s of module.sections ?? []) {
        const start = module.baseAddress + s.virtualAddress;
        const end = Math.min(start + Math.max(s.virtualSize, s.rawSize), memLen);
        if (end > start) out.push({ start, end });
    }
    if (!out.length) out.push({ start: module.baseAddress, end: Math.min(module.baseAddress + module.size, memLen) });
    return out;
}

function resolveBody(module: LoadedPEModule, name: string, mem: Uint8Array): number {
    for (const [k, v] of module.exports) {
        if (k !== name) continue;
        return module.baseAddress + resolveExportBodyRva(module, v - module.baseAddress);
    }
    void mem;
    return 0;
}

/** `avcodec_version` is `b8 imm32 c3` in every build — the imm IS LIBAVCODEC_VERSION_INT. */
function measureVersion(module: LoadedPEModule, mem: Uint8Array): { major: number; text: string } | null {
    const body = resolveBody(module, 'avcodec_version', mem);
    if (!body || body + 6 > mem.length) return null;
    if (mem[body] !== 0xb8 || mem[body + 5] !== 0xc3) return null;
    const v = mem[body + 1]! | (mem[body + 2]! << 8) | (mem[body + 3]! << 16) | (mem[body + 4]! << 24);
    return { major: (v >>> 16) & 0xff, text: `${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}` };
}

/** `av_frame_alloc` pushes sizeof(AVFrame) before calling av_mallocz. */
function measureFrameSizeof(avutil: LoadedPEModule, mem: Uint8Array): number {
    const body = resolveBody(avutil, 'av_frame_alloc', mem);
    if (!body) return 0;
    // Scan the first few bytes for `push imm32` (0x68) — the register save before it varies.
    for (let i = 0; i < 8 && body + i + 5 <= mem.length; i++) {
        if (mem[body + i] !== 0x68) continue;
        return mem[body + i + 1]! | (mem[body + i + 2]! << 8) | (mem[body + i + 3]! << 16) | (mem[body + i + 4]! << 24);
    }
    return 0;
}

function findBytes(mem: Uint8Array, needle: Uint8Array, sections: Section[]): number {
    for (const s of sections) {
        outer: for (let a = s.start; a + needle.length <= s.end; a++) {
            for (let i = 0; i < needle.length; i++) if (mem[a + i] !== needle[i]) continue outer;
            return a;
        }
    }
    return 0;
}

function cStringAt(mem: Uint8Array, addr: number, max = 48): string | null {
    if (addr <= 0 || addr + 2 > mem.length) return null;
    let s = '';
    for (let i = 0; i < max; i++) {
        const c = mem[addr + i]!;
        if (c === 0) return s.length ? s : null;
        if (c < 0x20 || c > 0x7e) return null;
        s += String.fromCharCode(c);
    }
    return null;
}

/**
 * Walk the `avcodec_options` table via a known option name: find the name string, find the
 * 4-byte pointer to it (= an `AVOption.name` field), then walk 48-byte rows both ways.
 * Returns field name -> offsetof for the non-CONST rows.
 */
function readAvOptionOffsets(module: LoadedPEModule, mem: Uint8Array): Map<string, number> | null {
    const sections = readableSections(module, mem.length);
    const needle = new TextEncoder().encode('refcounted_frames\0');
    const strAddr = findBytes(mem, needle, sections);
    if (!strAddr) return null;

    const u32 = (a: number) => mem[a]! | (mem[a + 1]! << 8) | (mem[a + 2]! << 16) | (mem[a + 3]! << 24);
    for (const s of sections) {
        for (let a = s.start & ~3; a + AVOPTION_ROW <= s.end; a += 4) {
            if ((u32(a) >>> 0) !== strAddr) continue;
            const type = u32(a + 0x0c);
            const off = u32(a + 8);
            if (type !== 1 || off <= 0 || off > 0x4000) continue;  // refcounted_frames is an INT field
            let start = a;
            while (start - AVOPTION_ROW >= s.start && cStringAt(mem, u32(start - AVOPTION_ROW) >>> 0)) {
                start -= AVOPTION_ROW;
            }
            const out = new Map<string, number>();
            for (let r = start; r + AVOPTION_ROW <= s.end; r += AVOPTION_ROW) {
                const nm = cStringAt(mem, u32(r) >>> 0);
                if (nm === null) break;
                // A CONST row's `offset` is the enum value, not an offsetof — never a field.
                if (u32(r + 0x0c) >= AV_OPT_TYPE_CONST) continue;
                if (!out.has(nm)) out.set(nm, u32(r + 8));
            }
            return out.size ? out : null;
        }
    }
    return null;
}

/**
 * Measure and verify the ABI of a loaded avcodec image. Returns null — loudly — when any
 * gate fails, which is the whole point: the caller then leaves the guest's own decoder alone.
 */
export function measureAvcodecAbi(
    avcodec: LoadedPEModule,
    avutil: LoadedPEModule | undefined,
    mem: Uint8Array,
): AvcodecAbi | null {
    const version = measureVersion(avcodec, mem);
    if (!version) {
        Logger.warn(LogCategory.SYSTEM, '[ffmpeg-hle] avcodec_version body is not `mov eax,imm32; ret` — ABI unmeasurable, leaving the guest decoder alone');
        return null;
    }
    if (version.major !== 56) {
        Logger.log(LogCategory.SYSTEM, `[ffmpeg-hle] Lavc ${version.text}: no pinned layout for major ${version.major}, leaving the guest decoder alone`);
        return null;
    }

    const options = readAvOptionOffsets(avcodec, mem);
    if (!options) {
        Logger.warn(LogCategory.SYSTEM, `[ffmpeg-hle] Lavc ${version.text}: avcodec_options table not found — ABI unverified, leaving the guest decoder alone`);
        return null;
    }
    for (const [name, expect] of Object.entries(AVOPTION_ANCHORS)) {
        const got = options.get(name);
        if (got !== expect) {
            Logger.warn(LogCategory.SYSTEM,
                `[ffmpeg-hle] Lavc ${version.text}: AVOption "${name}" offsetof=0x${(got ?? -1).toString(16)} ` +
                `but the pinned layout says 0x${expect.toString(16)} — refusing to touch this build`);
            return null;
        }
    }

    if (!avutil) {
        Logger.warn(LogCategory.SYSTEM, '[ffmpeg-hle] avutil image not loaded yet — sizeof(AVFrame) unverifiable, leaving the guest decoder alone');
        return null;
    }
    const frameSizeof = measureFrameSizeof(avutil, mem);
    if (frameSizeof !== LAVC56.frameSizeof) {
        Logger.warn(LogCategory.SYSTEM,
            `[ffmpeg-hle] av_frame_alloc allocates 0x${frameSizeof.toString(16)} bytes, pinned sizeof(AVFrame) is ` +
            `0x${LAVC56.frameSizeof.toString(16)} — refusing to touch this build`);
        return null;
    }

    Logger.log(LogCategory.SYSTEM,
        `[ffmpeg-hle] Lavc ${version.text} ABI verified: ${Object.keys(AVOPTION_ANCHORS).length} AVOption anchors, ` +
        `sizeof(AVFrame)=0x${frameSizeof.toString(16)}`);
    return { ...LAVC56, version: version.text, versionMajor: version.major };
}
