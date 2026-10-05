/**
 * Pin the ffmpeg ABI from the shipped DLLs themselves, not from a header we happen to hold.
 *
 * Four independent, refusable measurements:
 *   - `avcodec_version()`'s whole body is `mov eax, imm32; ret` — the library version.
 *   - the DLL's own `avcodec_options` AVOption table stores `offsetof(AVCodecContext, field)`
 *     in every 48-byte row, so a dozen field offsets are readable with no header at all.
 *   - `av_frame_alloc`'s `push imm32` before its allocator call is `sizeof(AVFrame)`.
 *   - avutil's MAKE_ACCESSORS bodies (`av_frame_get_*`) are `mov r32,[arg+offsetof(field)]`,
 *     which measures the AVFrame tail — including `best_effort_timestamp`, a field we WRITE.
 *     A change anywhere in the head shifts that tail, so matching it plus `sizeof(AVFrame)`
 *     is what stands behind the head offsets we cannot read out of an accessor.
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
    /** The avutil image the AVFrame layout was measured against — a drop may ship several. */
    avutilName: string;
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

export interface AbiAnchorMismatch {
    name: string;
    expect: number;
    /** null = the option row is absent from this build's table. */
    got: number | null;
}

/**
 * Why the last measurement refused a build. A refusal is normal operation (the guest decoder
 * keeps running), so it never throws and the log line is the only other trace of it — which a
 * dropped log ring erases. Keep it in state so the harness can still answer "why not?".
 */
export interface AbiRefusal {
    version: string;
    reason: 'avoption-anchor' | 'avframe-accessor' | 'frame-sizeof' | 'no-options-table'
        | 'no-avutil' | 'unmeasurable-version' | 'major';
    mismatches?: AbiAnchorMismatch[];
    /** Anchors this build's table does not carry, accepted because present anchors bracket them. */
    absentButBracketed?: string[];
    anchorsChecked?: number;
    optionsSeen?: number;
    detail?: string;
}

function describeMismatches(list: AbiAnchorMismatch[]): string {
    return list.map((m) => `${m.name} got=${m.got === null ? 'absent' : `0x${m.got.toString(16)}`} want=0x${m.expect.toString(16)}`).join(', ');
}

let lastRefusal: AbiRefusal | null = null;

export function lastAbiRefusal(): AbiRefusal | null {
    return lastRefusal;
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
const LAVC56: Omit<AvcodecAbi, 'version' | 'versionMajor' | 'avutilName'> = {
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
 * AVOption rows we check before trusting the rest of the AVCodecContext layout.
 * `g` and `me_method` bracket `pix_fmt`; `delay` and `g` bracket `width`/`height` — those two
 * are not options in any build, so the bracket plus the version match is as far as static
 * measurement reaches. The runtime dimension cross-check in the decoder closes the gap.
 *
 * The table's CONTENTS vary across the Lavc 56 family while the struct layout does not, so an
 * anchor may be absent (2.8 dropped the `extradata_size` row 2.4 had). A present anchor must
 * match exactly; an absent one is accepted only when a present, matching anchor sits on each
 * side of its offset — the same bracket argument the fields above rest on.
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

/**
 * `av_frame_get_<field>` -> `offsetof(AVFrame, field)`. Measured identical on avutil 54.7.100
 * (Lavc 56.1.100) and 54.31.100 (Lavc 56.41.100). Same rule as the AVOption anchors: a present
 * accessor must match, an absent one is accepted only when present ones bracket its offset.
 */
const AVFRAME_ACCESSOR_ANCHORS: Record<string, number> = {
    av_frame_get_sample_rate: 0x158,
    av_frame_get_channel_layout: 0x160,
    av_frame_get_color_range: 0x19c,
    av_frame_get_colorspace: 0x1a8,
    av_frame_get_best_effort_timestamp: 0x1b0,
    av_frame_get_pkt_pos: 0x1b8,
    av_frame_get_pkt_duration: 0x1c0,
    av_frame_get_metadata: 0x1c8,
    av_frame_get_decode_error_flags: 0x1cc,
    av_frame_get_channels: 0x1d0,
    av_frame_get_pkt_size: 0x1d4,
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
 * Decode one MAKE_ACCESSORS body: an optional frame-pointer prologue, the argument load, then
 * one or two `mov r32,[arg+disp]`. An int64 accessor loads both halves, so the FIELD is the
 * lower of the two displacements. Anything else returns null and counts as "not an accessor".
 */
function decodeAccessorOffset(mem: Uint8Array, body: number): number | null {
    if (!body || body + 16 > mem.length) return null;
    const at = (i: number) => mem[body + i]!;
    const disp32 = (i: number) => (at(i) | (at(i + 1) << 8) | (at(i + 2) << 16) | (at(i + 3) << 24)) | 0;
    let i = 0;
    if (at(0) === 0x55 && at(1) === 0x8b && at(2) === 0xec) i = 3;      // push ebp; mov ebp,esp
    let base: number;
    if (at(i) === 0x8b && (at(i + 1) & 0xc7) === 0x45 && at(i + 2) === 0x08) {
        base = (at(i + 1) >> 3) & 7;                                    // mov r32,[ebp+8]
        i += 3;
    } else if (at(i) === 0x8b && at(i + 1) === 0x44 && at(i + 2) === 0x24 && at(i + 3) === 0x04) {
        base = 0;                                                       // mov eax,[esp+4]
        i += 4;
    } else return null;

    const reads: number[] = [];
    while (reads.length < 2 && body + i + 6 <= mem.length && at(i) === 0x8b) {
        const modrm = at(i + 1);
        if ((modrm & 7) !== base) break;                                // must deref the argument
        const mod = modrm >> 6;
        if (mod === 1) { reads.push((at(i + 2) << 24) >> 24); i += 3; }
        else if (mod === 2) { reads.push(disp32(i + 2)); i += 6; }
        else if (mod === 0) { reads.push(0); i += 2; }
        else break;
    }
    if (!reads.length) return null;
    return Math.min(...reads);
}

/** Read every AVFrame accessor anchor this avutil actually exports. */
function readFrameAccessorOffsets(avutil: LoadedPEModule, mem: Uint8Array): Map<string, number> {
    const out = new Map<string, number>();
    for (const name of Object.keys(AVFRAME_ACCESSOR_ANCHORS)) {
        const body = resolveBody(avutil, name, mem);
        const off = body ? decodeAccessorOffset(mem, body) : null;
        if (off !== null) out.set(name, off);
    }
    return out;
}

/**
 * Compare a measured anchor set against the pinned one. A present anchor must match exactly;
 * an absent one is accepted only when a present, matching anchor sits on each side of it —
 * the table/export CONTENTS vary across a family whose struct layout does not.
 */
function checkAnchors(
    pinned: Record<string, number>, measured: Map<string, number>,
): { mismatches: AbiAnchorMismatch[]; agreed: number[]; absent: string[] } {
    const mismatches: AbiAnchorMismatch[] = [];
    const agreed: number[] = [];
    const absent: [string, number][] = [];
    for (const [name, expect] of Object.entries(pinned)) {
        const got = measured.get(name);
        if (got === expect) agreed.push(expect);
        else if (got === undefined) absent.push([name, expect]);
        else mismatches.push({ name, expect, got });
    }
    for (const [name, expect] of absent) {
        if (!(agreed.some((o) => o < expect) && agreed.some((o) => o > expect))) {
            mismatches.push({ name, expect, got: null });
        }
    }
    return { mismatches, agreed, absent: absent.map(([n]) => n) };
}

/**
 * Measure and verify the ABI of a loaded avcodec image. Returns null — loudly — when any
 * gate fails, which is the whole point: the caller then leaves the guest's own decoder alone.
 */
export function measureAvcodecAbi(
    avcodec: LoadedPEModule,
    avutils: LoadedPEModule[],
    mem: Uint8Array,
): AvcodecAbi | null {
    lastRefusal = null;
    const version = measureVersion(avcodec, mem);
    if (!version) {
        lastRefusal = { version: 'unknown', reason: 'unmeasurable-version' };
        Logger.warn(LogCategory.SYSTEM, '[ffmpeg-hle] avcodec_version body is not `mov eax,imm32; ret` — ABI unmeasurable, leaving the guest decoder alone');
        return null;
    }
    if (version.major !== 56) {
        lastRefusal = { version: version.text, reason: 'major', detail: `no pinned layout for major ${version.major}` };
        Logger.log(LogCategory.SYSTEM, `[ffmpeg-hle] Lavc ${version.text}: no pinned layout for major ${version.major}, leaving the guest decoder alone`);
        return null;
    }

    const options = readAvOptionOffsets(avcodec, mem);
    if (!options) {
        lastRefusal = { version: version.text, reason: 'no-options-table' };
        Logger.warn(LogCategory.SYSTEM, `[ffmpeg-hle] Lavc ${version.text}: avcodec_options table not found — ABI unverified, leaving the guest decoder alone`);
        return null;
    }
    // Report EVERY anchor that disagrees, not just the first: "this build moved the layout"
    // and "this build dropped one option row" are different verdicts, and a first-mismatch
    // message cannot tell them apart.
    const ctx = checkAnchors(AVOPTION_ANCHORS, options);
    if (ctx.mismatches.length) {
        lastRefusal = {
            version: version.text,
            reason: 'avoption-anchor',
            mismatches: ctx.mismatches,
            absentButBracketed: ctx.absent,
            anchorsChecked: Object.keys(AVOPTION_ANCHORS).length,
            optionsSeen: options.size,
        };
        Logger.warn(LogCategory.SYSTEM,
            `[ffmpeg-hle] Lavc ${version.text}: ${ctx.mismatches.length} of ${Object.keys(AVOPTION_ANCHORS).length} ` +
            `AVOption anchors disagree with the pinned AVCodecContext layout (${options.size} option rows read) — ` +
            `refusing to touch this build: ` + describeMismatches(ctx.mismatches));
        return null;
    }

    // A drop can ship more than one avutil (Deponia carries 54 and 55). Which one this avcodec
    // links against is not in anything we parse, so let the measurement pick: the right avutil
    // is the one whose AVFrame agrees with the layout, and a foreign major cannot agree.
    if (!avutils.length) {
        lastRefusal = { version: version.text, reason: 'no-avutil' };
        Logger.warn(LogCategory.SYSTEM, '[ffmpeg-hle] avutil image not loaded yet — sizeof(AVFrame) unverifiable, leaving the guest decoder alone');
        return null;
    }
    const avutil = avutils.length === 1
        ? avutils[0]!
        : avutils.find((m) => measureFrameSizeof(m, mem) === LAVC56.frameSizeof) ?? avutils[0]!;
    if (avutils.length > 1) {
        Logger.log(LogCategory.SYSTEM,
            `[ffmpeg-hle] ${avutils.length} avutil images loaded (${avutils.map((m) => m.name).join(', ')}) — ` +
            `measuring against ${avutil.name}`);
    }
    const frameSizeof = measureFrameSizeof(avutil, mem);
    if (frameSizeof !== LAVC56.frameSizeof) {
        lastRefusal = {
            version: version.text, reason: 'frame-sizeof',
            detail: `av_frame_alloc allocates 0x${frameSizeof.toString(16)}, pinned 0x${LAVC56.frameSizeof.toString(16)}`,
        };
        Logger.warn(LogCategory.SYSTEM,
            `[ffmpeg-hle] av_frame_alloc allocates 0x${frameSizeof.toString(16)} bytes, pinned sizeof(AVFrame) is ` +
            `0x${LAVC56.frameSizeof.toString(16)} — refusing to touch this build`);
        return null;
    }

    // The AVFrame head holds every field we WRITE, and no accessor reads it. What an accessor
    // does read is the tail — which any change to the head would move.
    const accessors = readFrameAccessorOffsets(avutil, mem);
    const frame = checkAnchors(AVFRAME_ACCESSOR_ANCHORS, accessors);
    if (frame.mismatches.length) {
        lastRefusal = {
            version: version.text,
            reason: 'avframe-accessor',
            mismatches: frame.mismatches,
            absentButBracketed: frame.absent,
            anchorsChecked: Object.keys(AVFRAME_ACCESSOR_ANCHORS).length,
            detail: `${avutil.name} exports ${accessors.size} of the ${Object.keys(AVFRAME_ACCESSOR_ANCHORS).length} accessors we read`,
        };
        Logger.warn(LogCategory.SYSTEM,
            `[ffmpeg-hle] ${avutil.name}: ${frame.mismatches.length} AVFrame accessor anchor(s) disagree with the ` +
            `pinned layout — refusing to touch this build: ` + describeMismatches(frame.mismatches));
        return null;
    }
    // best_effort_timestamp is the one field we write that an accessor measures directly.
    // Without it the whole AVFrame tail could match while that offset was pinned from a guess.
    if (accessors.get('av_frame_get_best_effort_timestamp') !== LAVC56.frameBestEffort) {
        lastRefusal = {
            version: version.text, reason: 'avframe-accessor',
            detail: 'av_frame_get_best_effort_timestamp is not readable as an accessor — the one directly measured field we write',
        };
        Logger.warn(LogCategory.SYSTEM,
            `[ffmpeg-hle] ${avutil.name}: av_frame_get_best_effort_timestamp did not decode as a field accessor — ` +
            `refusing to touch this build`);
        return null;
    }

    Logger.log(LogCategory.SYSTEM,
        `[ffmpeg-hle] Lavc ${version.text} ABI verified: ` +
        `${ctx.agreed.length}/${Object.keys(AVOPTION_ANCHORS).length} AVOption anchors` +
        (ctx.absent.length ? ` (${ctx.absent.join(', ')} absent but bracketed)` : '') +
        `, ${frame.agreed.length}/${Object.keys(AVFRAME_ACCESSOR_ANCHORS).length} AVFrame accessors` +
        (frame.absent.length ? ` (${frame.absent.join(', ')} absent but bracketed)` : '') +
        `, sizeof(AVFrame)=0x${frameSizeof.toString(16)}`);
    return { ...LAVC56, version: version.text, versionMajor: version.major, avutilName: avutil.name };
}
