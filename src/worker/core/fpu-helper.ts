/**
 * FPU Helper for v86 x87 FPU stack manipulation
 *
 * Bypasses cpu.fpu_stack_empty / fpu_stack_ptr JS properties entirely.
 * Reads/writes directly to WASM linear memory at known offsets from
 * vendor/v86/src/rust/cpu/global_pointers.rs.
 *
 * This avoids the bug where v86's JS layer replaces the Uint8Array
 * property with a plain number, causing writes to shadow a JS property
 * instead of WASM memory.
 */

// Known WASM memory offsets (from global_pointers.rs)
const FPU_STACK_EMPTY_OFFSET = 816;   // u8
const FPU_STACK_PTR_OFFSET = 1032;    // u8
const FPU_SIMD_DIRTY_OFFSET = 632;    // u8
const FPU_RELAXED_TAG = 0x7FFE;
const FPU_ST_OFFSET = 1152;           // 8 × F80 (mantissa: u64 + sign_exponent: u16, padded to 16 bytes)

// F80 struct size in WASM: mantissa(8) + sign_exponent(2) + padding(6) = 16 bytes
const F80_SIZE = 16;

// Reusable buffer for double ↔ u32 pair conversion (avoids allocation)
const _cvtBuf = new ArrayBuffer(8);
const _cvtF64 = new Float64Array(_cvtBuf);
const _cvtU32 = new Uint32Array(_cvtBuf);

/**
 * Get CPU from v86 instance
 */
function getCPU(v86: any): any {
    return v86?.cpu ?? v86?.v86?.cpu ?? null;
}

/** v86 lib.js `view()` wraps WASM memory in a Proxy — not instanceof Uint8Array. */
function isV86MemoryByteView(v: unknown): v is { [index: number]: number; length: number } {
    if (v == null || typeof v !== "object") return false;
    const len = (v as { length?: unknown }).length;
    return typeof len === "number" && len > 0;
}

function getExportedFpuSimdDirty(cpu: any): { [index: number]: number; length: number } | null {
    const exported = cpu?.fpu_simd_dirty;
    return isV86MemoryByteView(exported) ? exported : null;
}

function getFpuSimdDirtyView(v86: any): { [index: number]: number; length: number } | null {
    const cpu = getCPU(v86);
    const exported = getExportedFpuSimdDirty(cpu);
    if (exported) return exported;
    // JS-side mark/clear only when post-rebuild export is absent (pre-rebuild wasm).
    const wasmMem = cpu?.wasm_memory;
    if (!wasmMem?.buffer || wasmMem.buffer.byteLength <= FPU_SIMD_DIRTY_OFFSET) return null;
    return new Uint8Array(wasmMem.buffer, FPU_SIMD_DIRTY_OFFSET, 1);
}

/** True only when v86 cpu.js wired cpu.fpu_simd_dirty (post-rebuild). No raw-offset probe —
 *  old wasm padding @632 is always 0 and would false-enable skip-save. */
export function hasFpuSimdDirtyFlag(v86: any): boolean {
    return getExportedFpuSimdDirty(getCPU(v86)) !== null;
}

export function isFpuSimdDirty(v86: any): boolean {
    const flag = getFpuSimdDirtyView(v86);
    return flag !== null && flag[0] !== 0;
}

export function markFpuSimdDirty(v86: any): void {
    const flag = getFpuSimdDirtyView(v86);
    if (flag) flag[0] = 1;
}

export function clearFpuSimdDirty(v86: any): void {
    const flag = getFpuSimdDirtyView(v86);
    if (flag) flag[0] = 0;
}

/**
 * Get a DataView over WASM linear memory.
 * Creates a fresh DataView each time since the underlying ArrayBuffer can detach.
 */
function getWasmView(v86: any): DataView | null {
    const cpu = getCPU(v86);
    const wasmMem = cpu?.wasm_memory;
    if (!wasmMem?.buffer || wasmMem.buffer.byteLength === 0) return null;
    return new DataView(wasmMem.buffer);
}

function readFpuByte(dv: DataView, offset: number): number {
    return dv.getUint8(offset);
}

function writeFpuByte(dv: DataView, offset: number, value: number): void {
    dv.setUint8(offset, value & 0xFF);
}

function isRelaxedFpu(v86: any): boolean {
    const cpu = getCPU(v86);
    const getRelaxed = cpu?.wm?.exports?.get_relaxed_fpu;
    return typeof getRelaxed === 'function' && (getRelaxed() >>> 0) !== 0;
}

/**
 * Read a double from FPU stack position i (0 = ST(0), 1 = ST(1), etc.)
 * Uses the Rust-exported fpu_get_sti_f64 which reads directly from WASM memory.
 */
export function fpuGetST(v86: any, i: number): number {
    const cpu = getCPU(v86);
    if (!cpu || typeof cpu.fpu_get_sti_f64 !== 'function') {
        throw new Error('FPU not available in v86 CPU');
    }
    return cpu.fpu_get_sti_f64(i);
}

/**
 * Write a double to FPU stack position ST(0) by converting to x87 80-bit format.
 * Writes directly to WASM memory at the F80 struct for the current stack top.
 */
export function fpuSetST0(v86: any, value: number): void {
    const dv = getWasmView(v86);
    if (!dv) throw new Error('FPU: cannot get WASM memory view');
    markFpuSimdDirty(v86);

    const stackPtr = readFpuByte(dv, FPU_STACK_PTR_OFFSET) & 7;
    const base = FPU_ST_OFFSET + stackPtr * F80_SIZE;

    if (isRelaxedFpu(v86)) {
        _cvtF64[0] = value;
        dv.setUint32(base, _cvtU32[0], true);
        dv.setUint32(base + 4, _cvtU32[1], true);
        dv.setUint16(base + 8, FPU_RELAXED_TAG, true);
        dv.setUint16(base + 10, 0, true);
        dv.setUint32(base + 12, 0, true);
        return;
    }

    // Convert double to F80 mantissa (u64) + sign_exponent (u16)
    const { mantLo, mantHi, signExp } = doubleToF80(value);

    // Write mantissa as two u32 (little-endian)
    dv.setUint32(base, mantLo, true);
    dv.setUint32(base + 4, mantHi, true);
    // Write sign+exponent as u16
    dv.setUint16(base + 8, signExp, true);
    // Padding bytes (10-15) don't matter but zero them for safety
    dv.setUint16(base + 10, 0, true);
    dv.setUint32(base + 12, 0, true);
}

/**
 * Pop value from FPU stack (marks current top as empty, increments stack pointer).
 * Writes directly to WASM memory.
 */
export function fpuPop(v86: any): void {
    const dv = getWasmView(v86);
    if (!dv) return;
    markFpuSimdDirty(v86);

    const oldTop = readFpuByte(dv, FPU_STACK_PTR_OFFSET) & 7;
    // Mark old top as empty
    const emptyMask = readFpuByte(dv, FPU_STACK_EMPTY_OFFSET);
    writeFpuByte(dv, FPU_STACK_EMPTY_OFFSET, emptyMask | (1 << oldTop));
    // Advance stack pointer (pop = increment mod 8)
    writeFpuByte(dv, FPU_STACK_PTR_OFFSET, (oldTop + 1) & 7);
}

/**
 * Push value to FPU stack (decrements stack pointer, marks slot as full, writes value).
 * Writes directly to WASM memory.
 */
export function fpuPush(v86: any, value: number): void {
    const dv = getWasmView(v86);
    if (!dv) return;
    markFpuSimdDirty(v86);

    // Decrement stack pointer (push grows downward)
    const prevTop = readFpuByte(dv, FPU_STACK_PTR_OFFSET) & 7;
    const newTop = (prevTop - 1) & 7;
    writeFpuByte(dv, FPU_STACK_PTR_OFFSET, newTop);

    // Mark new top as full
    const emptyMask = readFpuByte(dv, FPU_STACK_EMPTY_OFFSET);
    writeFpuByte(dv, FPU_STACK_EMPTY_OFFSET, emptyMask & ~(1 << newTop));

    // Write value to new top
    fpuSetST0(v86, value);
}

// ─── Full x87 state snapshot (context switches) ────────────────────────────
//
// The guest threads share ONE v86 FPU. Without saving/restoring the x87 state
// across thread switches, a thread preempted MID-COMPUTATION (operands live on
// the FPU stack) resumes with whatever the other threads left there — garbage
// flows into dot products / transforms → UE1 BSP visibility flips → the random
// one-frame surface flicker (HP hunt 2026-06-11), occasional NaN vertices, etc.
//
// Snapshot layout (134 bytes):
//   [0..128)   fpu_st: 8 × F80 (16 bytes each) from WASM offset 1152
//   [128]      fpu_stack_ptr   (u8  @ 1032)
//   [129]      fpu_stack_empty (u8  @ 816)
//   [130..132) fpu_control_word(u16 @ 1036)
//   [132..134) fpu_status_word (u16 @ 1040)

const FPU_CONTROL_WORD_OFFSET = 1036;
const FPU_STATUS_WORD_OFFSET = 1040;
export const FPU_SNAPSHOT_BYTES = 134;

export function createDefaultFpuSnapshot(): Uint8Array {
    const out = new Uint8Array(FPU_SNAPSHOT_BYTES);
    out[128] = 0;      // fpu_stack_ptr
    out[129] = 0xFF;   // fpu_stack_empty
    out[130] = 0x7F;   // fpu_control_word = 0x037F
    out[131] = 0x03;
    out[132] = 0;
    out[133] = 0;
    return out;
}

/** Copy the full x87 state out of WASM memory. Pass a reusable target buffer
 *  (length ≥ FPU_SNAPSHOT_BYTES) to avoid per-switch allocation, or omit it. */
export function fpuSnapshot(v86: any, target?: Uint8Array): Uint8Array | null {
    const cpu = getCPU(v86);
    const wasmMem = cpu?.wasm_memory;
    if (!wasmMem?.buffer || wasmMem.buffer.byteLength === 0) return null;
    const src = new Uint8Array(wasmMem.buffer);
    const out = target && target.length >= FPU_SNAPSHOT_BYTES ? target : new Uint8Array(FPU_SNAPSHOT_BYTES);
    out.set(src.subarray(FPU_ST_OFFSET, FPU_ST_OFFSET + 128), 0);
    out[128] = src[FPU_STACK_PTR_OFFSET];
    out[129] = src[FPU_STACK_EMPTY_OFFSET];
    out[130] = src[FPU_CONTROL_WORD_OFFSET];
    out[131] = src[FPU_CONTROL_WORD_OFFSET + 1];
    out[132] = src[FPU_STATUS_WORD_OFFSET];
    out[133] = src[FPU_STATUS_WORD_OFFSET + 1];
    return out;
}

/** Write a previously captured x87 snapshot back into WASM memory. */
export function fpuRestore(v86: any, snap: Uint8Array): boolean {
    const cpu = getCPU(v86);
    const wasmMem = cpu?.wasm_memory;
    if (!wasmMem?.buffer || wasmMem.buffer.byteLength === 0 || snap.length < FPU_SNAPSHOT_BYTES) return false;
    const dst = new Uint8Array(wasmMem.buffer);
    dst.set(snap.subarray(0, 128), FPU_ST_OFFSET);
    dst[FPU_STACK_PTR_OFFSET] = snap[128];
    dst[FPU_STACK_EMPTY_OFFSET] = snap[129];
    dst[FPU_CONTROL_WORD_OFFSET] = snap[130];
    dst[FPU_CONTROL_WORD_OFFSET + 1] = snap[131];
    dst[FPU_STATUS_WORD_OFFSET] = snap[132];
    dst[FPU_STATUS_WORD_OFFSET + 1] = snap[133];
    return true;
}

// ─── Relaxed-FPU mode change: re-encode SAVED x87 state ────────────────────
//
// The 16 bytes of an F80 slot mean different numbers depending on a single
// global flag: under relaxed FPU, `sign_exponent == RELAXED_TAG` (0x7FFE) means
// `mantissa` holds raw f64 bits; under strict FPU the same bytes are a true
// 80-bit value (0x7FFE is a legal exponent field — 2^16383, e.g. LDBL_MAX).
// Toggling the mode canonicalizes only the LIVE register file (wasm
// set_relaxed_fpu), but every parked thread's x87 state lives in a saved
// snapshot over the SHARED register file, so those must be re-encoded too or
// each parked thread resumes reading old-mode bytes under new-mode tag rules.
// Semantics mirror F80::of_f64_strict / to_f64_strict and the 0x7FFE alias
// handling in fpu_load_m80 (vendor/v86/src/rust) — do not re-derive rounding.

const U64_MASK = (1n << 64n) - 1n;

function leadingZeros64(v: bigint): number {
    const hi = Number((v >> 32n) & 0xFFFFFFFFn) >>> 0;
    return hi !== 0 ? Math.clz32(hi) : 32 + Math.clz32(Number(v & 0xFFFFFFFFn) >>> 0);
}

/** True 80-bit value → IEEE-754 double bits. Port of F80::to_f64_strict. */
function f80StrictToF64Bits(mant: bigint, signExp: number): bigint {
    const sign = BigInt(signExp >>> 15);
    const exp = signExp & 0x7FFF;

    if (exp === 0 && mant === 0n) return sign << 63n;

    if (exp === 0x7FFF) {
        if (mant === 0x8000000000000000n) return (sign << 63n) | (0x7FFn << 52n);
        const payload = (mant & 0x3FFFFFFFFFFFFFFFn) >> 11n;
        const quiet = (mant >> 62n) & 1n;
        return (sign << 63n) | (0x7FFn << 52n) | (quiet << 51n) | (payload & 0x7FFFFFFFFFFFFn);
    }

    // F80 denormal / pseudo-denormal: underflows to zero in f64.
    if (exp === 0) return sign << 63n;

    const f64Exp = exp - 16383 + 1023;
    if (f64Exp >= 0x7FF) return (sign << 63n) | (0x7FFn << 52n);
    if (f64Exp <= 0) {
        const shift = 1 - f64Exp;
        if (shift >= 64) return sign << 63n;
        return (sign << 63n) | (mant >> BigInt(11 + shift));
    }
    return (sign << 63n) | (BigInt(f64Exp) << 52n) | ((mant & 0x7FFFFFFFFFFFFFFFn) >> 11n);
}

/** IEEE-754 double bits → true 80-bit value. Port of F80::of_f64_strict. */
function f64BitsToF80Strict(src: bigint): { mant: bigint; signExp: number } {
    const sign = Number((src >> 63n) & 1n);
    const exp = Number((src >> 52n) & 0x7FFn);
    const mant = src & 0xFFFFFFFFFFFFFn;

    if (exp === 0 && mant === 0n) return { mant: 0n, signExp: sign << 15 };

    if (exp === 0x7FF) {
        if (mant === 0n) return { mant: 0x8000000000000000n, signExp: (sign << 15) | 0x7FFF };
        const quiet = (mant >> 51n) & 1n;
        const payload = (mant & 0x7FFFFFFFFFFFFn) << 11n;
        return { mant: 0x8000000000000000n | (quiet << 62n) | payload, signExp: (sign << 15) | 0x7FFF };
    }

    if (exp === 0) {
        // Subnormal: normalize so the leading 1 lands on the explicit J-bit. The bias
        // term is -1023, not 1-1023 — normalizing already consumes the implicit-bit
        // offset, and biasing as if it were still there doubles the value. Matches
        // of_f64_strict in vendor/v86/src/rust/softfloat.rs.
        const shift = leadingZeros64(mant) - 12;
        const normalized = (mant << BigInt(shift + 1)) & U64_MASK;
        const f80Exp = (-1023 + 16383 - shift) & 0xFFFF;
        return { mant: (0x8000000000000000n | ((normalized << 11n) & U64_MASK)) & U64_MASK, signExp: (sign << 15) | f80Exp };
    }

    return { mant: 0x8000000000000000n | (mant << 11n), signExp: (sign << 15) | ((exp - 1023 + 16383) & 0xFFFF) };
}

/**
 * Re-encode a saved x87 snapshot for the relaxed-FPU mode it is about to be
 * restored under, preserving the NUMBER each slot holds (not its bytes).
 * `toRelaxed` is the mode being switched TO. Returns true if any slot was
 * rewritten.
 */
export function canonicalizeFpuSnapshotForMode(snap: Uint8Array, toRelaxed: boolean): boolean {
    if (snap.length < FPU_SNAPSHOT_BYTES) return false;
    const stackEmpty = snap[129];
    const dv = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
    let changed = false;

    for (let i = 0; i < 8; i++) {
        if (stackEmpty & (1 << i)) continue; // empty slot holds garbage by definition
        const base = i * F80_SIZE;
        if (dv.getUint16(base + 8, true) !== FPU_RELAXED_TAG) continue;
        const mant = dv.getBigUint64(base, true);
        if (toRelaxed) {
            // A genuine 80-bit image whose exponent aliases the tag; relaxed mode would
            // misread it as f64 bits. Re-express as f64 bits — 2^16383 is out of f64
            // range and becomes the infinity every op on it would produce (fpu_load_m80).
            dv.setBigUint64(base, f80StrictToF64Bits(mant, FPU_RELAXED_TAG), true);
        } else {
            const { mant: m, signExp } = f64BitsToF80Strict(mant);
            dv.setBigUint64(base, m, true);
            dv.setUint16(base + 8, signExp, true);
        }
        changed = true;
    }
    return changed;
}

// ─── Full SSE state snapshot (context switches) ────────────────────────────
//
// Exactly the same hazard as the x87 block above, for the SSE register file.
// v86 implements SSE/SSE2 (reg_xmm + MXCSR) and we advertise PF_XMMI*_AVAILABLE
// to guests, so D3DX math, the MSVC CRT and engine SIMD all run SSE. The 8 XMM
// registers (XMM0-7, 32-bit mode) and MXCSR (rounding mode / FZ / DAZ) are a SINGLE shared v86 register
// file across all guest threads — a thread preempted mid-SSE-computation (live
// operands in XMM) or one that set a non-default MXCSR resumes with whatever
// another thread left there → the same non-deterministic float garbage the x87
// fix cured, just via the SSE path. So XMM+MXCSR must travel with the thread
// context wherever the x87 state does.
//
// Snapshot layout (132 bytes):
//   [0..4)     mxcsr   (i32 @ 824)
//   [4..132)   reg_xmm (8 × xmm128 = 128 bytes @ 832)
//
// 32-bit x86 has 8 XMM registers (XMM0-7) = 128 bytes; the next v86 field is
// current_tsc @ 960 (832 + 128). Snapshotting 16 (256 bytes) would overrun into
// current_tsc / reg_pdpte / the FPU control+status words and corrupt them on
// restore — DON'T widen this without checking vendor/v86 global_pointers.rs.

const MXCSR_OFFSET = 824;
const REG_XMM_OFFSET = 832;
const REG_XMM_BYTES = 8 * 16; // 8 XMM registers (XMM0-7, 32-bit mode) × 128 bits
export const SIMD_SNAPSHOT_BYTES = 4 + REG_XMM_BYTES; // 132

export function createDefaultSimdSnapshot(): Uint8Array {
    const out = new Uint8Array(SIMD_SNAPSHOT_BYTES);
    out[0] = 0x80; // MXCSR = 0x00001F80
    out[1] = 0x1F;
    out[2] = 0;
    out[3] = 0;
    return out;
}

/** Copy MXCSR + all 8 XMM registers (XMM0-7) out of WASM memory. Returns null when the
 *  CPU has no WASM memory (e.g. unit-test fakes) — callers treat that as "no SSE
 *  state to carry", identical to fpuSnapshot. */
export function simdSnapshot(v86: any, target?: Uint8Array): Uint8Array | null {
    const cpu = getCPU(v86);
    const wasmMem = cpu?.wasm_memory;
    if (!wasmMem?.buffer || wasmMem.buffer.byteLength === 0) return null;
    const src = new Uint8Array(wasmMem.buffer);
    if (src.length < REG_XMM_OFFSET + REG_XMM_BYTES) return null;
    const out = target && target.length >= SIMD_SNAPSHOT_BYTES ? target : new Uint8Array(SIMD_SNAPSHOT_BYTES);
    out[0] = src[MXCSR_OFFSET];
    out[1] = src[MXCSR_OFFSET + 1];
    out[2] = src[MXCSR_OFFSET + 2];
    out[3] = src[MXCSR_OFFSET + 3];
    out.set(src.subarray(REG_XMM_OFFSET, REG_XMM_OFFSET + REG_XMM_BYTES), 4);
    return out;
}

/** Write a previously captured SSE snapshot back into WASM memory. */
export function simdRestore(v86: any, snap: Uint8Array): boolean {
    const cpu = getCPU(v86);
    const wasmMem = cpu?.wasm_memory;
    if (!wasmMem?.buffer || wasmMem.buffer.byteLength === 0 || snap.length < SIMD_SNAPSHOT_BYTES) return false;
    const dst = new Uint8Array(wasmMem.buffer);
    if (dst.length < REG_XMM_OFFSET + REG_XMM_BYTES) return false;
    dst[MXCSR_OFFSET] = snap[0];
    dst[MXCSR_OFFSET + 1] = snap[1];
    dst[MXCSR_OFFSET + 2] = snap[2];
    dst[MXCSR_OFFSET + 3] = snap[3];
    dst.set(snap.subarray(4, 4 + REG_XMM_BYTES), REG_XMM_OFFSET);
    return true;
}

/**
 * Convert IEEE 754 double (64-bit) to x87 F80 struct fields.
 * Returns mantissa as two u32 halves and sign+exponent as u16.
 */
function doubleToF80(value: number): { mantLo: number; mantHi: number; signExp: number } {
    // Handle special cases
    if (value === 0) {
        // Check for -0
        _cvtF64[0] = value;
        const neg = (_cvtU32[1] >>> 31) !== 0;
        return { mantLo: 0, mantHi: 0, signExp: neg ? 0x8000 : 0 };
    }
    if (Number.isNaN(value)) {
        // QNaN
        return { mantLo: 0x00000000, mantHi: 0xC0000000, signExp: 0x7FFF };
    }
    if (!Number.isFinite(value)) {
        // Infinity
        const sign = value < 0 ? 0x8000 : 0;
        return { mantLo: 0x00000000, mantHi: 0x80000000, signExp: 0x7FFF | sign };
    }

    // Extract IEEE 754 double components via typed array reinterpret
    _cvtF64[0] = value;
    const lo32 = _cvtU32[0];
    const hi32 = _cvtU32[1];

    const sign = (hi32 >>> 31) & 1;
    const exp = (hi32 >>> 20) & 0x7FF;
    const mantHigh20 = hi32 & 0xFFFFF;

    if (exp === 0) {
        // Subnormal: x87 exponent = 16383 - 1023 + 1 = 15361 (but really need to normalize)
        // For simplicity, handle via the Rust F80::of_f64 path. But since we're writing
        // F80 directly, let's do an approximate conversion.
        // Subnormals are extremely rare in game code, so just convert via float arithmetic.
        const abv = Math.abs(value);
        const e = Math.floor(Math.log2(abv));
        const extExp = e + 16383;
        const frac = abv / Math.pow(2, e);
        // frac is in [1, 2), shift to get 64-bit mantissa with explicit integer bit
        const mantissa = frac * 0x8000000000000000; // 2^63
        const mHi = (mantissa / 0x100000000) >>> 0;
        const mLo = mantissa >>> 0;
        return { mantLo: mLo, mantHi: mHi, signExp: (sign << 15) | (extExp & 0x7FFF) };
    }

    // Normal number
    // x87 exponent: rebias from 1023 to 16383
    const extExp = exp - 1023 + 16383;

    // x87 has explicit integer bit (bit 63 of mantissa = 1 for normals)
    // Double mantissa: 52 bits (implicit 1.xxxx)
    // F80 mantissa: 64 bits (explicit 1.xxxx with bit63 = integer bit)
    //
    // Double bits: [mantHigh20 (20 bits)][lo32 (32 bits)] = 52 bits
    // F80 bits: [1][mantHigh20 (20 bits)][lo32 (32 bits)][000...0 (11 bits)] = 64 bits
    //
    // Shift left by 11: places the 52-bit mantissa at bits 63-12, then set bit 63
    const mantLo = (lo32 << 11) >>> 0;
    const mantHi = (0x80000000 | (mantHigh20 << 11) | (lo32 >>> 21)) >>> 0;

    return { mantLo, mantHi, signExp: (sign << 15) | (extExp & 0x7FFF) };
}
