import { Logger, LogCategory, LogLevel } from "../../core/logger";
import { Marshaler } from "../../core/memory/marshaler";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { System } from "../../core/system";
import { TimerKind } from "../../core/scheduler/types";
import { TimeService } from "../../runtime/time";
import { BufferSource } from "@bottleship/formats/unpack/source";
import { probeAudio, sniffAudioContainer } from "@bottleship/formats/audio";
import { MSSContext, SMP_DONE, SMP_FREE, SMP_PLAYING } from "./context";
import { MSSSample, MSSStream } from "./types";

// ==================== Memory helpers ====================

export function getMemory(ctx: MSSContext): Uint8Array {
    return ctx.process.getCurrentMemory();
}

export function makeView(mem: Uint8Array): DataView {
    return new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
}

export function readStackArg(mem: Uint8Array, esp: number, index: number): number | null {
    const addr = esp + 4 + index * 4;
    if (!MemoryGuard.isValidRange(mem, addr, 4)) {
        return null;
    }
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return view.getUint32(addr, true);
}

export function readCStringIfLikely(mem: Uint8Array, address: number, maxLen = 260): string | null {
    if (!address || !MemoryGuard.isValidRange(mem, address, 1)) return null;
    const max = Math.min(maxLen, mem.length - address);
    let str = '';
    for (let i = 0; i < max; i++) {
        const code = mem[address + i];
        if (code === 0) break;
        if (code < 0x20 || code > 0x7e) {
            return null;
        }
        str += String.fromCharCode(code);
    }
    return str.length > 0 ? str : null;
}

export function readFilenameArg(mem: Uint8Array, address: number): string | null {
    const direct = readCStringIfLikely(mem, address);
    if (direct) return direct;
    if (!MemoryGuard.isValidRange(mem, address, 4)) return null;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const indirectPtr = view.getUint32(address, true);
    return readCStringIfLikely(mem, indirectPtr);
}

// ==================== Driver helpers ====================

/**
 * DIGDRIVER struct layout — verified via Ghidra decompilation of MSS32.DLL.
 * Real struct is 0x254 (596) bytes; we allocate 1024 for safety margin.
 *
 * HLE strategy (two-pass init):
 *   Pass 1: Zero entire struct (safe default — function pointer null-checks work).
 *   Pass 2: Overwrite every KNOWN field with its correct value.
 *           Integer/count/flag/handle fields get their real values (often 0).
 *           Suspected string pointer ranges get dummyBuffer (zero-filled →
 *           strlen returns 0, safe as empty string).
 *
 * Games null-check COM interface fields at 0xA0/0xA8 before vtable calls.
 */
/** Size of one MSS SAMPLE struct — verified from Ghidra: loop stride = 0x284 */
export const MSS_SAMPLE_STRUCT_SIZE = 0x284;

export function reinitDriverFields(
    ctx: MSSContext,
    driverHandle: number,
    dummyBuffer: number,
    waveFormat: number,
    noopTable: number,
    gameFormatPtr: number,   // game-supplied WAVEFORMATEX pointer (0 = use ours)
    mem: Uint8Array,
    deviceId: number = 0
): void {
    const rate = ctx.driverOutputRate;
    const channels = 2;
    const bitsPerSample = 16;
    const view = makeView(mem);

    const DRIVER_STRUCT_SIZE = 1024;
    const maxSamples = ctx.driverMaxSamples;

    // ════════════════════════════════════════════════════════════════════
    // PASS 1: Zero entire struct (safe default for function pointer null-checks).
    // Real MSS32 does: for (iVar16 = 0x95; ...) *puVar21 = 0
    // Must NOT fill with dummyBuffer here — non-zero values in
    // processor chain function pointer slots pass null-checks → game tries
    // to CALL them → crash (HoMM3 #PF at EIP=0x0 via _AIL_serve).
    // ════════════════════════════════════════════════════════════════════
    for (let i = 0; i < DRIVER_STRUCT_SIZE; i += 4) {
        view.setUint32(driverHandle + i, 0, true);
    }

    // ════════════════════════════════════════════════════════════════════
    // PASS 2: Overwrite every known field with correct value.
    // Organized by byte offset. Each comment shows puVar6[N] index,
    // field name from Ghidra, and whether it's INTEGER/POINTER/HANDLE.
    // ════════════════════════════════════════════════════════════════════

    // If the game supplied a WAVEFORMATEX, read format from it.
    let gameChannels = channels;
    let gameRate = rate;
    let gameBits = bitsPerSample;
    if (gameFormatPtr && MemoryGuard.isValidRange(mem, gameFormatPtr, 16)) {
        gameChannels = view.getUint16(gameFormatPtr + 2, true) || channels;
        gameRate = view.getUint32(gameFormatPtr + 4, true) || rate;
        gameBits = view.getUint16(gameFormatPtr + 14, true) || bitsPerSample;
    }
    const gameBytesPerSample = gameBits >> 3;
    const gameBlockAlign = gameChannels * gameBytesPerSample;
    const gameAvgBytesPerSec = gameRate * gameBlockAlign;
    const fmtType = (gameBytesPerSample === 1 ? 0 : 1) + (gameChannels >= 2 ? 2 : 0);
    const buildBufSamples = Math.floor(gameRate * gameChannels * 50 / 1000);
    const buildBufFrames = Math.floor(buildBufSamples / gameChannels);

    // ── 0x00–0x0C: Header ──
    // [0x00] puVar6[0x00] RIB type tag pointer → "DIG\0" (POINTER)
    if (ctx.driverTypeTag) {
        view.setUint32(driverHandle + 0x00, ctx.driverTypeTag, true);
    }
    // [0x04] puVar6[0x01] Timer handle (HANDLE) — -1 = no timer
    view.setInt32(driverHandle + 0x04, -1, true);
    // [0x08] puVar6[0x02] Unknown (INTEGER) — cleared
    view.setUint32(driverHandle + 0x08, 0, true);
    // [0x0C] puVar6[0x03] Active sample count (INTEGER) — 0 at init
    view.setUint32(driverHandle + 0x0C, 0, true);

    // ── 0x10–0x2C: Audio format ──
    // [0x10] puVar6[0x04] Master volume 0–127 (INTEGER)
    view.setUint32(driverHandle + 0x10, 127, true);
    // [0x14] puVar6[0x05] nSamplesPerSec (INTEGER)
    view.setUint32(driverHandle + 0x14, gameRate, true);
    // [0x18] puVar6[0x06] Format type: 0=mono8 1=mono16 2=stereo8 3=stereo16 (INTEGER)
    view.setUint32(driverHandle + 0x18, fmtType, true);
    // [0x1C] puVar6[0x07] 16-bit flag (INTEGER)
    view.setUint32(driverHandle + 0x1C, gameBytesPerSample >= 2 ? 1 : 0, true);
    // [0x20] puVar6[0x08] nChannels (INTEGER)
    view.setUint32(driverHandle + 0x20, gameChannels, true);
    // [0x24] puVar6[0x09] Bytes per sample (INTEGER)
    view.setUint32(driverHandle + 0x24, gameBytesPerSample, true);
    // [0x28] puVar6[0x0A] Build buf samples (INTEGER)
    view.setUint32(driverHandle + 0x28, buildBufSamples, true);
    // [0x2C] puVar6[0x0B] Build buf frames (INTEGER)
    view.setUint32(driverHandle + 0x2C, buildBufFrames, true);

    // ── 0x30–0x40: Mixer state ──
    // [0x30] puVar6[0x0C] Cleared to 0 in real MSS32 (INTEGER)
    view.setUint32(driverHandle + 0x30, 0, true);
    // [0x34] puVar6[0x0D] Sample array pointer (POINTER)
    if (ctx.driverSampleArray) {
        view.setUint32(driverHandle + 0x34, ctx.driverSampleArray, true);
        initSampleArray(ctx, driverHandle, mem);
    }
    // [0x38] puVar6[0x0E] Max sample slots (INTEGER)
    view.setUint32(driverHandle + 0x38, maxSamples, true);
    // [0x3C] puVar6[0x0F] Build buf size in bytes (INTEGER)
    view.setUint32(driverHandle + 0x3C, buildBufSamples << 2, true);
    // [0x40] puVar6[0x10] Build buffer (POINTER)
    if (ctx.driverBuildBuffer) {
        view.setUint32(driverHandle + 0x40, ctx.driverBuildBuffer, true);
    }

    // ── 0x44–0x60: Unknown fields — use noopTable so double-deref reads noopStub (safe CALL).
    // dummyBuffer here causes HoMM3 crash: game reads field as object pointer,
    // dereferences [dummyBuffer+offset] → 0, CALL 0 → #PF at EIP=0x0.
    // noopTable has every slot = noopStub address, so indirect calls return 0 safely.
    for (let off = 0x44; off <= 0x60; off += 4) {
        view.setUint32(driverHandle + off, noopTable, true);
    }

    // ── 0x64–0x88: WaveOut state ──
    // [0x64] puVar6[0x19] Total buf size bytes (INTEGER)
    view.setUint32(driverHandle + 0x64, buildBufSamples * gameBytesPerSample, true);
    // [0x68] puVar6[0x1A] HWAVEOUT handle (HANDLE) — non-zero = device open
    view.setUint32(driverHandle + 0x68, 0xDEAD0001, true);
    // [0x6C] puVar6[0x1B] Reset flag (INTEGER)
    view.setUint32(driverHandle + 0x6C, 1, true);
    // [0x70] puVar6[0x1C] Cleared to 0 in real MSS32 (INTEGER)
    view.setUint32(driverHandle + 0x70, 0, true);
    // [0x74] puVar6[0x1D] WAVEHDR chain head (POINTER — waveOut only, 0 = no buffers)
    view.setUint32(driverHandle + 0x74, 0, true);
    // [0x78] Wave buffer count (INTEGER — dummyBuffer here causes infinite loop)
    view.setUint32(driverHandle + 0x78, 0, true);
    // [0x7C] puVar6[0x1F] Wave buffer pointer array (POINTER — 0 = no array)
    view.setUint32(driverHandle + 0x7C, 0, true);
    // [0x80] puVar6[0x20] Current write index (INTEGER)
    view.setUint32(driverHandle + 0x80, 0, true);
    // [0x84] puVar6[0x21] Current play index (INTEGER)
    view.setUint32(driverHandle + 0x84, 0, true);
    // [0x88] puVar6[0x22] Device ID (INTEGER)
    view.setUint32(driverHandle + 0x88, deviceId, true);

    // ── 0x8C–0x9A: Embedded WAVEFORMATEX (STRUCT — 16 bytes) ──
    view.setUint16(driverHandle + 0x8C, 1, true);                   // wFormatTag = PCM
    view.setUint16(driverHandle + 0x8E, gameChannels, true);        // nChannels
    view.setUint32(driverHandle + 0x90, gameRate, true);             // nSamplesPerSec
    view.setUint32(driverHandle + 0x94, gameAvgBytesPerSec, true);  // nAvgBytesPerSec
    view.setUint16(driverHandle + 0x98, gameBlockAlign, true);      // nBlockAlign
    view.setUint16(driverHandle + 0x9A, gameBits, true);            // wBitsPerSample

    // ── 0x9C–0xC8: DirectSound / driver chain ──
    // [0x9C] puVar6[0x27] DS device GUID (POINTER — 0 for waveOut)
    view.setUint32(driverHandle + 0x9C, 0, true);
    // [0xA0] puVar6[0x28] IDirectSound* (COM — MUST be NULL for waveOut)
    view.setUint32(driverHandle + 0xA0, 0, true);
    // [0xA4] puVar6[0x29] DS emulation flag (INTEGER)
    view.setUint32(driverHandle + 0xA4, 0, true);
    // [0xA8] puVar6[0x2A] IDirectSoundBuffer* (COM — MUST be NULL for waveOut)
    view.setUint32(driverHandle + 0xA8, 0, true);
    // [0xAC] puVar6[0x2B] HWND (HANDLE — 0 = no window)
    view.setUint32(driverHandle + 0xAC, 0, true);
    // [0xB0] puVar6[0x2C] Aux buf 1: provider ptrs (POINTER)
    if (ctx.driverAuxBuffer1) {
        view.setUint32(driverHandle + 0xB0, ctx.driverAuxBuffer1, true);
    }
    // [0xB4] puVar6[0x2D] Aux buf 2: sample back-ptrs (POINTER)
    if (ctx.driverAuxBuffer2) {
        view.setUint32(driverHandle + 0xB4, ctx.driverAuxBuffer2, true);
    }
    // [0xB8] puVar6[0x2E] Aux buf 3: filter types (POINTER)
    if (ctx.driverAuxBuffer3) {
        view.setUint32(driverHandle + 0xB8, ctx.driverAuxBuffer3, true);
    }
    // [0xBC] puVar6[0x2F] Max samples dup (INTEGER — same as [0x38])
    view.setUint32(driverHandle + 0xBC, maxSamples, true);
    // [0xC0] puVar6[0x30] DS mode flag (INTEGER — 0 = waveOut)
    view.setUint32(driverHandle + 0xC0, 0, true);
    // [0xC4] puVar6[0x31] SetTimer handle (HANDLE — 0 = no timer)
    view.setUint32(driverHandle + 0xC4, 0, true);
    // [0xC8] puVar6[0x32] Prev driver link (POINTER — 0 = tail)
    view.setUint32(driverHandle + 0xC8, 0, true);

    // ── 0xCC–0xEC: Unknown fields — use noopTable (same rationale as 0x44–0x60).
    for (let off = 0xCC; off <= 0xEC; off += 4) {
        view.setUint32(driverHandle + off, noopTable, true);
    }

    // ── 0xF0–0xFC: Flags and decode buffer ──
    // [0xF0] puVar6[0x3C] Format flag (INTEGER) — 1=default, 0=game-supplied
    view.setUint32(driverHandle + 0xF0, gameFormatPtr ? 0 : 1, true);
    // [0xF4] puVar6[0x3D] MMX available (INTEGER)
    view.setUint32(driverHandle + 0xF4, 1, true);
    // [0xF8] puVar6[0x3E] Decode buffer (POINTER)
    if (ctx.driverDecodeBuffer) {
        view.setUint32(driverHandle + 0xF8, ctx.driverDecodeBuffer, true);
    }
    // [0xFC] puVar6[0x3F] Decode buf size (INTEGER)
    view.setUint32(driverHandle + 0xFC, 4096, true);

    // ════════════════════════════════════════════════════════════════════
    // PASS 3: Processor chain region (0x110–0x247).
    // Real MSS32 fills these via _RIB_enumerate_providers +
    // _AIL_set_digital_driver_processor. Each chain is 0x68 bytes (26 DWORDs),
    // 3 chains starting at byte 0x110.
    //
    // Chain layout (each 0x68 bytes):
    //   [+0x00] HPROVIDER handle — games null-check this; 0 = no provider = disabled
    //   [+0x04..+0x64] Mix of function pointers and string pointers
    //
    // Strategy: first DWORD = 0 (null provider, pass null-checks).
    // Function pointer slots = noopStub (XOR EAX,EAX; RET — safe to call).
    // String pointer slots = dummyBuffer (zero-filled → empty string for strlen/strncpy).
    // We use noopStub for all non-first slots since it's safe for both
    // function calls (returns 0) and string reads (reads 0x31,0xC0,0xC3 = short garbage
    // but no crash). Known string positions get dummyBuffer explicitly.
    // ════════════════════════════════════════════════════════════════════
    const noopStub = ctx.driverNoopStub;
    const CHAIN_SIZE = 0x68;  // 26 DWORDs per chain
    const CHAIN_COUNT = 3;
    const CHAIN_START = 0x110;

    for (let c = 0; c < CHAIN_COUNT; c++) {
        const chainBase = driverHandle + CHAIN_START + c * CHAIN_SIZE;
        // [+0x00] HPROVIDER = 0 (null → games skip this chain)
        view.setUint32(chainBase, 0, true);
        // Fill remaining slots with 0 (safe for function pointer null-checks).
        // Do NOT use dummyBuffer here — dummyBuffer is a non-zero address
        // pointing to zeros. Games that read chain slots as function pointers will
        // pass the null-check, then do CALL [dummyBuffer+offset] → gets 0 → CALL 0
        // → #PF at EIP=0 (HoMM3 crash via _AIL_serve).
        for (let off = 4; off < CHAIN_SIZE; off += 4) {
            view.setUint32(chainBase + off, 0, true);
        }
        // Overwrite known function pointer positions with noopStub
        // (safe to CALL — returns 0 via XOR EAX,EAX; RET)
        if (noopStub) {
            // Positions 1,2,3,4 are typically mixer function pointers in MSS32
            for (const fpOff of [0x04, 0x08, 0x0C, 0x10]) {
                view.setUint32(chainBase + fpOff, noopStub, true);
            }
        }
    }

    // 0x248–0x254: Reverb state — leave as zero (disabled)
}

/**
 * Compute and write volL, volR, effectiveVol×16 fields into a SAMPLE struct.
 * Mirrors real MSS32 FUN_2100f2d0 (volume recalculation).
 *
 * Reads:  vol from +0x5C, pan from +0x60, masterVol from driver+0x10
 * Writes: +0x64 (volL), +0x68 (volR), +0x280 (effectiveVol × 16)
 */
export function computeSampleVolumes(view: DataView, sampleBase: number, driverHandle: number): void {
    const vol = Math.max(0, Math.min(127, view.getInt32(sampleBase + 0x5C, true)));
    const pan = Math.max(0, Math.min(127, view.getInt32(sampleBase + 0x60, true)));
    const masterVol = Math.max(0, Math.min(127, view.getInt32(driverHandle + 0x10, true)));

    const effectiveVol = Math.floor((masterVol * vol) / 127);
    // Pan: 0=full left, 64=center, 127=full right
    // volL = (127-pan) * eff * 2 / 127, volR = pan * eff * 2 / 127
    let volL = Math.floor(((127 - pan) * effectiveVol * 2) / 127);
    let volR = Math.floor((pan * effectiveVol * 2) / 127);
    // Clamp to 0x7FF (2047) — MSS32 internal 11-bit volume
    volL = Math.min(volL, 0x7FF);
    volR = Math.min(volR, 0x7FF);
    const eff16 = Math.min(effectiveVol * 16, 0x7FF);

    view.setInt32(sampleBase + 0x64, volL, true);
    view.setInt32(sampleBase + 0x68, volR, true);
    view.setInt32(sampleBase + 0x280, eff16, true);
}

/**
 * Initialize every SAMPLE slot in the driver's sample array to the default
 * state that real MSS32 FUN_2100f1b0 creates.
 * Full field layout verified via Ghidra decompilation.
 */
function initSampleArray(ctx: MSSContext, driverHandle: number, mem: Uint8Array): void {
    const view = makeView(mem);
    const arr = ctx.driverSampleArray;
    const max = ctx.driverMaxSamples;
    const stride = MSS_SAMPLE_STRUCT_SIZE;

    // Read driver format type for default pan: mono → 0, stereo → 0x40
    const driverFmtType = view.getUint32(driverHandle + 0x18, true);
    const defaultPan = (driverFmtType >= 2) ? 0x40 : 0; // stereo=2,3

    for (let i = 0; i < max; i++) {
        const base = arr + i * stride;
        // Zero-fill the slot. IMPORTANT: do NOT use dummyBuffer here — games
        // double-deref unknown fields as ptr→funcptr→CALL. dummyBuffer (non-zero)
        // passes the null-check but points to zeros → CALL 0 → #PF at EIP=0.
        // The DRIVER struct uses dummyBuffer (for strlen safety), but SAMPLE
        // structs must stay zero-filled so function pointer null-checks work.
        for (let j = 0; j < stride; j += 4) {
            view.setUint32(base + j, 0, true);
        }

        // Verified fields from FUN_2100f1b0:
        view.setUint32(base + 0x04, driverHandle, true);   // driver back-pointer
        view.setUint32(base + 0x08, SMP_FREE, true);        // status = free (SMP_FREE)
        view.setUint32(base + 0x28, 1, true);               // loopCount default = 1
        view.setInt32(base + 0x3C, -2, true);                // sentinel 0xFFFFFFFE
        view.setUint32(base + 0x40, 1, true);               // userData[0] = 1
        view.setUint32(base + 0x44, 1, true);               // userData[1] = 1
        view.setUint32(base + 0x48, 0, true);               // userData[2] = 0
        view.setInt32(base + 0x4C, -1, true);                // EOS callback sentinel = -1 (0xFFFFFFFF)
        view.setUint32(base + 0x58, 0x2B11, true);          // playbackRate = 11025 Hz
        view.setUint32(base + 0x5C, 127, true);             // volume = max
        view.setUint32(base + 0x60, defaultPan, true);      // pan: mono=0, stereo=0x40
        view.setUint32(base + 0xBC, 0x100, true);           // from decompilation
        view.setInt32(base + 0x110, -1, true);               // sentinel

        // Constants from decompilation
        view.setUint32(base + 0x274, 0, true);
        view.setUint32(base + 0x278, 0x3CF5C28F, true);     // float constant
        view.setUint32(base + 0x27C, 0x3FBF1AA0, true);     // float constant

        // RIB type tag at sample+0x00 (real MSS32: DAT_21040d84)
        // Games/MSS functions read this as a string pointer for handle validation.
        // Must NOT be overwritten with status — status lives only at +0x08.
        if (ctx.sampleTypeTag) {
            view.setUint32(base + 0x00, ctx.sampleTypeTag, true);
        }

        // Dual-write legacy offsets for our internal readers
        view.setUint32(base + 0x20, 1, true);               // legacy loopCount
        view.setUint32(base + 0x34, 0x2B11, true);          // legacy playbackRate
        view.setUint32(base + 0x38, 127, true);             // legacy volume
        view.setUint32(base + 0x3C, defaultPan, true);      // legacy pan (overlaps sentinel — OK, both write same slot)

        // Compute volL/volR/eff×16
        computeSampleVolumes(view, base, driverHandle);

        // Zero processor chains (+0x13C, stride 0x68, ×3)
        for (let p = 0; p < 3; p++) {
            const chainBase = base + 0x13C + p * 0x68;
            for (let k = 0; k < 0x68; k += 4) {
                view.setUint32(chainBase + k, 0, true);
            }
        }
    }
}

/** Ensure we have a valid driver handle, creating one if necessary. */
export function ensureDriverHandle(ctx: MSSContext, mem: Uint8Array): number {
    if (ctx.digitalDriverHandle) {
        return ctx.digitalDriverHandle;
    }

    const DRIVER_STRUCT_SIZE = 1024;
    const NOOP_TABLE_SIZE = 256;
    const maxSamples = ctx.driverMaxSamples;
    const driverHandle = ctx.process.memory.alloc(DRIVER_STRUCT_SIZE);
    const dummyBuffer = ctx.process.memory.alloc(256);
    const waveFormat = ctx.process.memory.alloc(64);
    const noopStub = ctx.process.memory.alloc(16);
    const noopTable = ctx.process.memory.alloc(NOOP_TABLE_SIZE);
    // Real MSS32: _AIL_mem_alloc_lock(maxSamples * 0x284)
    const sampleArray = ctx.process.memory.alloc(maxSamples * MSS_SAMPLE_STRUCT_SIZE);

    // RIB type tag strings — real MSS32 stores these at handle+0x00 for type validation.
    // Games/MSS code may call strlen() on the value at handle+0x00.
    // 32 bytes: "DIG\0" at +0, "SAM\0" at +8
    const typeTagBuf = ctx.process.memory.alloc(32);

    // Build buffer (driver+0x40) and decode buffer (driver+0xF8) — real MSS32 allocates these
    // for mixing. We don't use them but they must be non-NULL for validation.
    const buildBuffer = ctx.process.memory.alloc(4096);
    const decodeBuffer = ctx.process.memory.alloc(4096);

    // Aux buffers (driver+0xB0/B4/B8) — real MSS32 allocates maxSamples×4 each
    const auxBufSize = maxSamples * 4;
    const auxBuffer1 = ctx.process.memory.alloc(auxBufSize);
    const auxBuffer2 = ctx.process.memory.alloc(auxBufSize);
    const auxBuffer3 = ctx.process.memory.alloc(auxBufSize);

    const view = makeView(mem);

    // Write type tag strings into guest memory
    // "DIG\0" at typeTagBuf+0
    mem[typeTagBuf + 0] = 0x44; // 'D'
    mem[typeTagBuf + 1] = 0x49; // 'I'
    mem[typeTagBuf + 2] = 0x47; // 'G'
    mem[typeTagBuf + 3] = 0x00;
    // "SAM\0" at typeTagBuf+8
    mem[typeTagBuf + 8] = 0x53;  // 'S'
    mem[typeTagBuf + 9] = 0x41;  // 'A'
    mem[typeTagBuf + 10] = 0x4D; // 'M'
    mem[typeTagBuf + 11] = 0x00;

    // Zero dummyBuffer — used for misc pointer fields in the driver struct
    // that games might dereference as strings (strlen returns 0 = empty string).
    for (let i = 0; i < 256; i += 4) {
        view.setUint32(dummyBuffer + i, 0, true);
    }

    // Write "XOR EAX,EAX; RET" into noopStub (3 bytes; rest stays 0 = INT3 padding).
    mem[noopStub + 0] = 0x31; // XOR
    mem[noopStub + 1] = 0xC0; // EAX, EAX
    mem[noopStub + 2] = 0xC3; // RET

    // Fill every slot of noopTable with the noopStub address.
    for (let i = 0; i < NOOP_TABLE_SIZE; i += 4) {
        view.setUint32(noopTable + i, noopStub, true);
    }

    // Initialize WAVEFORMATEX structure
    const rate = ctx.driverOutputRate;
    const channels = 2;
    const bytesPerSample = 2; // 16-bit
    view.setUint16(waveFormat + 0, 1, true);       // wFormatTag = WAVE_FORMAT_PCM
    view.setUint16(waveFormat + 2, channels, true); // nChannels
    view.setUint32(waveFormat + 4, rate, true);     // nSamplesPerSec
    view.setUint32(waveFormat + 8, rate * channels * bytesPerSample, true); // nAvgBytesPerSec
    view.setUint16(waveFormat + 12, channels * bytesPerSample, true); // nBlockAlign
    view.setUint16(waveFormat + 14, 16, true);     // wBitsPerSample = 16
    view.setUint16(waveFormat + 16, 0, true);      // cbSize = 0

    ctx.digitalDriverHandle = driverHandle;
    ctx.driverDummyBuffer = dummyBuffer;
    ctx.driverWaveFormat = waveFormat;
    ctx.driverNoopStub = noopStub;
    ctx.driverNoopTable = noopTable;
    ctx.driverSampleArray = sampleArray;
    ctx.driverTypeTag = typeTagBuf;       // "DIG\0" at +0
    ctx.sampleTypeTag = typeTagBuf + 8;   // "SAM\0" at +8
    ctx.driverBuildBuffer = buildBuffer;
    ctx.driverDecodeBuffer = decodeBuffer;
    ctx.driverAuxBuffer1 = auxBuffer1;
    ctx.driverAuxBuffer2 = auxBuffer2;
    ctx.driverAuxBuffer3 = auxBuffer3;

    reinitDriverFields(ctx, driverHandle, dummyBuffer, waveFormat, noopTable, 0, mem, 0);

    // A driver exists again, so the playback heartbeat must be running again.
    startHeartbeat(ctx);

    Logger.log(LogCategory.SYSTEM, `MSS32: ensureDriverHandle created driver at 0x${driverHandle.toString(16)}, noopStub=0x${noopStub.toString(16)}`);
    return driverHandle;
}

/**
 * (Re)arm the 20 ms playback heartbeat: EOS detection, guest-visible position
 * writeback, and the service point for incrementally fed streams.
 *
 * It is a property of "a digital driver is open", NOT of module construction —
 * close_digital_driver / shutdown / waveOutClose all stop it, and a title that
 * reopens its driver (changing an audio setting does exactly that) would otherwise
 * run the rest of the session with no clock at all: positions frozen, samples never
 * reaching DONE, and a streaming ring nobody refills.
 */
export function startHeartbeat(ctx: MSSContext): void {
    if (ctx.updateInterval || !ctx.heartbeatTick) return;
    const scheduler = System.getInstance().scheduler;
    if (!scheduler) {
        Logger.warn(LogCategory.SYSTEM, "MSS32: scheduler unavailable — playback heartbeat not armed");
        return;
    }
    ctx.updateInterval = scheduler.timerWheel.add(
        HEARTBEAT_MS, true, TimerKind.MSS_TIMER, ctx.heartbeatTick,
        TimeService.getInstance().nowMs(),
    );
}

/** Heartbeat period. 50 Hz: fine enough for EOS latency, coarse enough to be free. */
export const HEARTBEAT_MS = 20;

/** Stop the heartbeat timer; call on shutdown/close_driver to avoid writing to stale memory.
 *  updateInterval now holds a scheduler timer-wheel id (not a setInterval handle). */
export function stopHeartbeat(ctx: MSSContext): void {
    if (ctx.updateInterval) {
        System.getInstance().scheduler?.timerWheel.cancel(ctx.updateInterval);
        ctx.updateInterval = null;
    }
}

/** Free driver struct and ensureDriverHandle-allocated buffers. */
export function freeDriverResources(ctx: MSSContext): void {
    if (ctx.digitalDriverHandle) {
        ctx.process.memory.free(ctx.digitalDriverHandle);
        ctx.digitalDriverHandle = 0;
    }
    if (ctx.driverDummyBuffer) {
        ctx.process.memory.free(ctx.driverDummyBuffer);
        ctx.driverDummyBuffer = 0;
    }
    if (ctx.driverWaveFormat) {
        ctx.process.memory.free(ctx.driverWaveFormat);
        ctx.driverWaveFormat = 0;
    }
    if (ctx.driverNoopTable) {
        ctx.process.memory.free(ctx.driverNoopTable);
        ctx.driverNoopTable = 0;
    }
    if (ctx.driverNoopStub) {
        ctx.process.memory.free(ctx.driverNoopStub);
        ctx.driverNoopStub = 0;
    }
    if (ctx.driverSampleArray) {
        ctx.process.memory.free(ctx.driverSampleArray);
        ctx.driverSampleArray = 0;
    }
    if (ctx.driverTypeTag) {
        ctx.process.memory.free(ctx.driverTypeTag);
        ctx.driverTypeTag = 0;
        ctx.sampleTypeTag = 0;
    }
    if (ctx.driverBuildBuffer) {
        ctx.process.memory.free(ctx.driverBuildBuffer);
        ctx.driverBuildBuffer = 0;
    }
    if (ctx.driverDecodeBuffer) {
        ctx.process.memory.free(ctx.driverDecodeBuffer);
        ctx.driverDecodeBuffer = 0;
    }
    if (ctx.driverAuxBuffer1) {
        ctx.process.memory.free(ctx.driverAuxBuffer1);
        ctx.driverAuxBuffer1 = 0;
    }
    if (ctx.driverAuxBuffer2) {
        ctx.process.memory.free(ctx.driverAuxBuffer2);
        ctx.driverAuxBuffer2 = 0;
    }
    if (ctx.driverAuxBuffer3) {
        ctx.process.memory.free(ctx.driverAuxBuffer3);
        ctx.driverAuxBuffer3 = 0;
    }
}

// ==================== Sample/Stream memory helpers ====================

export function setSampleStatus(ctx: MSSContext, sample: MSSSample, status: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    // Status lives ONLY at +0x08 (real MSS32 offset).
    // +0x00 is the RIB type tag pointer — must NOT be overwritten with status.
    MemoryGuard.writeUint32(mem, view, sample.handle + 0x08, status, "MSS32:setSampleStatus");
}

export function writeSamplePosition(ctx: MSSContext, sample: MSSSample, position: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    MemoryGuard.writeUint32(mem, view, sample.handle + 0x18, position >>> 0, "MSS32:writeSamplePosition");

    // Check real MSS32 offset (+0x08) for status — games read this directly
    const memStatus = view.getUint32(sample.handle + 0x08, true);
    if (sample.isPlaying && memStatus !== SMP_PLAYING) {
        Logger.verbose(LogCategory.SYSTEM,
            `MSS32: Sample id=${sample.id} status mismatch: expected SMP_PLAYING (${SMP_PLAYING}), got ${memStatus}. Re-writing.`
        );
        setSampleStatus(ctx, sample, SMP_PLAYING);
    }
}

export function updateSampleMemory(ctx: MSSContext, sample: MSSSample, startPtr: number, lengthBytes: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    if (startPtr) {
        MemoryGuard.writeUint32(mem, view, sample.handle + 0x10, startPtr >>> 0, "MSS32:updateSampleMemory:start");
    }
    const lenForGuest = sample.pcmBytes ?? lengthBytes;
    MemoryGuard.writeUint32(mem, view, sample.handle + 0x14, lenForGuest >>> 0, "MSS32:updateSampleMemory:len");
    MemoryGuard.writeUint32(mem, view, sample.handle + 0x1C, lenForGuest >>> 0, "MSS32:updateSampleMemory:done");
    MemoryGuard.writeUint32(mem, view, sample.handle + 0x18, 0, "MSS32:updateSampleMemory:pos");
}

/** Write len/done (0x14, 0x1C) from pcmBytes or fileData length; call after WAV decode. */
export function refreshSampleLenDone(ctx: MSSContext, sample: MSSSample): void {
    const lenForGuest = sample.pcmBytes ?? sample.fileData?.length ?? 0;
    const mem = getMemory(ctx);
    const view = makeView(mem);
    MemoryGuard.writeUint32(mem, view, sample.handle + 0x14, lenForGuest >>> 0, "MSS32:refreshSampleLenDone:len");
    MemoryGuard.writeUint32(mem, view, sample.handle + 0x1C, lenForGuest >>> 0, "MSS32:refreshSampleLenDone:done");
}

export function setStreamStatus(ctx: MSSContext, stream: MSSStream, status: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    if (MemoryGuard.isValidRange(mem, stream.handle, 4)) {
        view.setUint32(stream.handle + 0x00, status, true);
    }
}

export function writeStreamPosition(ctx: MSSContext, stream: MSSStream, position: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    if (MemoryGuard.isValidRange(mem, stream.handle + 0x18, 4)) {
        view.setUint32(stream.handle + 0x18, position, true);
    }
}

export function writeStreamVolume(ctx: MSSContext, stream: MSSStream, volume: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    if (MemoryGuard.isValidRange(mem, stream.handle + 0x38, 4)) {
        view.setInt32(stream.handle + 0x38, volume, true);
    }
}

export function writeStreamPan(ctx: MSSContext, stream: MSSStream, pan: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    if (MemoryGuard.isValidRange(mem, stream.handle + 0x3C, 4)) {
        view.setInt32(stream.handle + 0x3C, pan, true);
    }
}

export function writeStreamPlaybackRate(ctx: MSSContext, stream: MSSStream, rate: number): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    if (MemoryGuard.isValidRange(mem, stream.handle + 0x34, 4)) {
        view.setInt32(stream.handle + 0x34, rate, true);
    }
}

export function refreshStreamLenDone(ctx: MSSContext, stream: MSSStream): void {
    const mem = getMemory(ctx);
    const view = makeView(mem);
    const totalLen = stream.pcmBytes ?? stream.fileData?.length ?? 0;
    if (MemoryGuard.isValidRange(mem, stream.handle + 0x14, 12)) {
        view.setUint32(stream.handle + 0x14, totalLen, true);
        view.setUint32(stream.handle + 0x1C, totalLen, true);
    }
}

// ==================== Audio utility ====================

/** Get bytes per second for audio playback (supports both samples and streams) */
export function getBytesPerSecond(item: MSSSample | MSSStream): number {
    if (item.sampleRate > 0 && item.channels > 0 && item.bitsPerSample > 0) {
        const bytesPerSample = Math.max(1, item.bitsPerSample >> 3);
        return item.sampleRate * item.channels * bytesPerSample;
    }
    return 44100 * 2 * 2;
}

/** After MP3/OGG sniff, derive pcmBytes from duration and write guest len/done (+0x14/+0x1C). */
export function applyEncodedPcmLength(ctx: MSSContext, item: MSSSample | MSSStream): void {
    if (item.pcmBytes === undefined || item.pcmBytes <= 0) {
        if (item.encodedDurationMs !== undefined && item.encodedDurationMs > 0) {
            const bps = getBytesPerSecond(item);
            item.pcmBytes = Math.max(1, Math.floor(bps * item.encodedDurationMs / 1000));
        }
    }
    if ("filename" in item) {
        refreshStreamLenDone(ctx, item);
    } else {
        refreshSampleLenDone(ctx, item);
    }
}

/** Virtual decoded length in bytes, including host-decoded MP3/OGG duration estimates. */
export function getPlaybackLengthBytes(item: MSSSample | MSSStream): number {
    if (item.pcmBytes !== undefined && item.pcmBytes > 0) {
        return item.pcmBytes;
    }
    if (item.encodedDurationMs !== undefined && item.encodedDurationMs > 0) {
        return Math.max(1, Math.floor(getBytesPerSecond(item) * item.encodedDurationMs / 1000));
    }
    return item.fileData?.length ?? 0;
}

/** Mark a naturally completed sample as DONE; release_sample_handle is the only free transition. */
export function finishSamplePlayback(ctx: MSSContext, sample: MSSSample, position?: number): void {
    const finalPosition = Math.max(0, position ?? getPlaybackLengthBytes(sample));
    sample.isPlaying = false;
    sample.isStopped = false;
    sample.pendingStart = false;
    sample.startTime = undefined;
    sample.lastAudioPositionTime = undefined;
    sample.lastAudioPositionBytes = undefined;
    sample.lastRingCursorBytes = undefined;
    sample.lastRingCursorTime = undefined;
    sample.position = finalPosition;
    writeSamplePosition(ctx, sample, finalPosition);
    setSampleStatus(ctx, sample, SMP_DONE);
}

/** Default streaming buffer size (~1/20s stereo16 @ 44.1k) */
export function defaultStreamBufferSize(sample: MSSSample): number {
    const rate = sample.sampleRate || 44100;
    const ch = sample.channels || 2;
    const bps = sample.bitsPerSample || 16;
    const bytesPerSec = rate * ch * Math.max(1, bps >> 3);
    const base = Math.max(4096, Math.floor(bytesPerSec / 20));
    return (base + 511) & ~511;
}

/**
 * Container sniffs over a HEADER SLICE, not the whole file — stream-engine hands
 * these its first probe read, so they must answer from the magic bytes alone.
 */
export function isMp3(data: Uint8Array): boolean {
    return sniffAudioContainer(new BufferSource(data)) === "mp3";
}

export function isOgg(data: Uint8Array): boolean {
    return sniffAudioContainer(new BufferSource(data)) === "ogg";
}

export interface EncodedAudioInfo {
    sampleRate?: number;
    channels?: number;
    durationMs?: number;
}

/**
 * Metadata for encoded audio that is decoded outside the worker. The rate MUST come
 * from the source, never from the output device: everything Miles reports in bytes
 * (position, length, SMP_DONE) is scaled by it, so substituting the device rate
 * makes a game's own playback clock run fast by exactly that ratio.
 */
export function inspectEncodedAudio(data: Uint8Array, format?: "mp3" | "ogg"): EncodedAudioInfo {
    const probe = probeAudio(new BufferSource(data));
    if (!probe || (format && probe.format !== format)) return {};
    return {
        sampleRate: probe.sampleRate || undefined,
        channels: probe.channels || undefined,
        durationMs: probe.durationMs || undefined,
    };
}

// AILFILETYPE_* — Miles Sound System file sniffing (see tools/reference/mss32/mss.h).
// Deliberately NOT the shared probe: AIL_file_type classifies MIDI/XMIDI/DLS/VOC/BinkA
// too, and must name a WAV variant from the format tag alone, for an image the decode
// paths cannot take.
export const AILFILETYPE_UNKNOWN = 0;
export const AILFILETYPE_PCM_WAV = 1;
export const AILFILETYPE_ADPCM_WAV = 2;
export const AILFILETYPE_OTHER_WAV = 3;
export const AILFILETYPE_VOC = 4;
export const AILFILETYPE_MIDI = 5;
export const AILFILETYPE_XMIDI = 6;
export const AILFILETYPE_XMIDI_DLS = 7;
export const AILFILETYPE_XMIDI_MLS = 8;
export const AILFILETYPE_DLS = 9;
export const AILFILETYPE_MLS = 10;
export const AILFILETYPE_MPEG_L1_AUDIO = 11;
export const AILFILETYPE_MPEG_L2_AUDIO = 12;
export const AILFILETYPE_MPEG_L3_AUDIO = 13;
export const AILFILETYPE_OTHER_ASI_WAV = 14;
export const AILFILETYPE_XBOX_ADPCM_WAV = 15;
export const AILFILETYPE_OGG_VORBIS = 16;
export const AILFILETYPE_BINKA = 24;

function readFourCC(data: Uint8Array, offset: number): string {
    if (offset + 4 > data.length) return "";
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function containsFourCC(data: Uint8Array, tag: string): boolean {
    const b0 = tag.charCodeAt(0);
    const b1 = tag.charCodeAt(1);
    const b2 = tag.charCodeAt(2);
    const b3 = tag.charCodeAt(3);
    for (let i = 0; i + 4 <= data.length; i++) {
        if (data[i] === b0 && data[i + 1] === b1 && data[i + 2] === b2 && data[i + 3] === b3) {
            return true;
        }
    }
    return false;
}

function detectWavFileType(data: Uint8Array): number {
    if (readFourCC(data, 0) !== "RIFF") return AILFILETYPE_UNKNOWN;
    const riffType = readFourCC(data, 8);
    if (riffType === "DLS ") return AILFILETYPE_DLS;
    if (riffType === "MLS ") return AILFILETYPE_MLS;
    if (riffType !== "WAVE") return AILFILETYPE_UNKNOWN;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let formatTag = 0;
    let offset = 12;
    while (offset + 8 <= data.length) {
        const chunkId = readFourCC(data, offset);
        const chunkSize = view.getUint32(offset + 4, true);
        const chunkData = offset + 8;
        if (chunkId === "fmt " && chunkSize >= 2 && chunkData + 2 <= data.length) {
            formatTag = view.getUint16(chunkData, true);
            break;
        }
        const padded = chunkSize + (chunkSize & 1);
        offset = chunkData + padded;
    }

    if (!formatTag) return AILFILETYPE_OTHER_WAV;
    if (formatTag === 1) return AILFILETYPE_PCM_WAV;
    if (formatTag === 2 || formatTag === 17) return AILFILETYPE_ADPCM_WAV;
    if (formatTag === 0x0169) return AILFILETYPE_XBOX_ADPCM_WAV;
    // WMA / Miles ASI-in-WAV codecs
    if (formatTag === 0x0160 || formatTag === 0x0161 || formatTag === 0x0162 || formatTag === 0x0163) {
        return AILFILETYPE_OTHER_ASI_WAV;
    }
    if (formatTag >= 0x0100) return AILFILETYPE_OTHER_ASI_WAV;
    return AILFILETYPE_OTHER_WAV;
}

function detectFormIffType(data: Uint8Array): number {
    if (readFourCC(data, 0) !== "FORM") return AILFILETYPE_UNKNOWN;
    const formType = readFourCC(data, 8);
    if (formType === "DLS ") return AILFILETYPE_DLS;
    if (formType === "MLS ") return AILFILETYPE_MLS;
    if (formType === "XDIR" || formType === "XMID" || (formType === "CAT " && readFourCC(data, 12) === "XMID")) {
        if (containsFourCC(data, "DLS ")) return AILFILETYPE_XMIDI_DLS;
        if (containsFourCC(data, "MLS ")) return AILFILETYPE_XMIDI_MLS;
        return AILFILETYPE_XMIDI;
    }
    return AILFILETYPE_UNKNOWN;
}

function detectVocType(data: Uint8Array): boolean {
    const marker = "Creative Voice File";
    const start = data[0] === 0x1a ? 1 : 0;
    if (data.length < start + marker.length) return false;
    for (let i = 0; i < marker.length; i++) {
        if (data[start + i] !== marker.charCodeAt(i)) return false;
    }
    return true;
}

function skipId3v2(data: Uint8Array): number {
    if (data.length < 10) return 0;
    if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0;
    const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    return Math.min(data.length, 10 + size);
}

function detectMpegAudioType(data: Uint8Array): number {
    let offset = skipId3v2(data);
    while (offset + 4 <= data.length) {
        if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) {
            offset++;
            continue;
        }
        const b1 = data[offset + 1];
        const b2 = data[offset + 2];
        const version = (b1 >> 3) & 0x03;
        const layer = (b1 >> 1) & 0x03;
        const bitrateIdx = (b2 >> 4) & 0x0f;
        const sampleIdx = (b2 >> 2) & 0x03;
        if (version === 1 || layer === 0 || bitrateIdx === 0 || bitrateIdx === 0x0f || sampleIdx === 3) {
            offset++;
            continue;
        }
        // layer: 1=L3, 2=L2, 3=L1
        if (layer === 1) return AILFILETYPE_MPEG_L3_AUDIO;
        if (layer === 2) return AILFILETYPE_MPEG_L2_AUDIO;
        if (layer === 3) return AILFILETYPE_MPEG_L1_AUDIO;
        break;
    }
    return AILFILETYPE_UNKNOWN;
}

/**
 * Identify a Miles audio blob from its header bytes.
 * Mirrors MSS32 AIL_file_type(data, size).
 */
export function detectAilFileType(data: Uint8Array): number {
    if (!data || data.length < 4) return AILFILETYPE_UNKNOWN;

    const riffType = detectWavFileType(data);
    if (riffType !== AILFILETYPE_UNKNOWN) return riffType;

    const formType = detectFormIffType(data);
    if (formType !== AILFILETYPE_UNKNOWN) return formType;

    if (readFourCC(data, 0) === "MThd") return AILFILETYPE_MIDI;
    if (detectVocType(data)) return AILFILETYPE_VOC;
    if (isOgg(data)) return AILFILETYPE_OGG_VORBIS;

    const mpegType = detectMpegAudioType(data);
    if (mpegType !== AILFILETYPE_UNKNOWN) return mpegType;

    // Bink Audio standalone header ("2BDA")
    if (readFourCC(data, 0) === "2BDA") return AILFILETYPE_BINKA;

    return AILFILETYPE_UNKNOWN;
}

/** Guest-memory wrapper for AIL_file_type. */
export function detectAilFileTypeFromMemory(mem: Uint8Array, dataPtr: number, size: number): number {
    if (!dataPtr || size <= 0) return AILFILETYPE_UNKNOWN;
    const scanLen = Math.min(size >>> 0, mem.length - dataPtr);
    if (scanLen < 4 || !MemoryGuard.isValidRange(mem, dataPtr, scanLen)) {
        return AILFILETYPE_UNKNOWN;
    }
    return detectAilFileType(mem.subarray(dataPtr, dataPtr + scanLen));
}

/** Returns true for formats that must be decoded on the main thread (MP3, OGG, etc.) */
export function isEncodedFormat(format: string | undefined): boolean {
    return format === "mp3" || format === "ogg";
}

/** Get the MIME type for an encoded audio format */
export function encodedMimeType(format: string | undefined): string {
    if (format === "ogg") return "audio/ogg";
    return "audio/mpeg";
}

// ==================== VFS handle helpers ====================

export function registerMilesFileHandle(ctx: MSSContext, vfsHandle: import("../../runtime/filesystem/vfs").VfsFileHandle): number {
    const handle = ctx.nextFileHandleId;
    ctx.nextFileHandleId += 4;
    ctx.fileHandles.set(handle, vfsHandle);
    Logger.verbose(LogCategory.SYSTEM, `MSS32: Registered Miles file handle 0x${handle.toString(16)} for path "${vfsHandle.path}"`);
    return handle;
}

export function resolveVfsHandle(ctx: MSSContext, fileHandle: number): import("../../runtime/filesystem/vfs").VfsFileHandle | null {
    const local = ctx.fileHandles.get(fileHandle);
    if (local) return local;
    const systemHandle = System.getInstance().resourceProvider.getFileHandle(fileHandle);
    return systemHandle?.vfsHandle ?? null;
}
