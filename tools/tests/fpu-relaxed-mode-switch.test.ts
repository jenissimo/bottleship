/**
 * Relaxed-FPU mode switch — saved x87 snapshot re-encoding.
 *
 * The 16 bytes of an F80 slot mean different NUMBERS depending on one global
 * flag: relaxed mode reads `sign_exponent == 0x7FFE` as "mantissa holds raw f64
 * bits", strict mode reads the same bytes as a true 80-bit value (0x7FFE is a
 * legal exponent field — 2^16383, e.g. LDBL_MAX). Every parked guest thread
 * carries a saved snapshot of the SHARED register file, so a live toggle must
 * re-encode those too.
 *
 * Assertions are on the DECODED NUMBER, via decoders written here from the
 * IEEE/x87 definitions rather than reusing the code under test.
 */

import { describe, expect, test } from "bun:test";
import {
    canonicalizeFpuSnapshotForMode,
    createDefaultFpuSnapshot,
    FPU_SNAPSHOT_BYTES,
} from "../../src/worker/core/fpu-helper";
import { PreemptionManager } from "../../src/worker/core/cpu/preemption-manager";

const RELAXED_TAG = 0x7FFE;
const F80_SIZE = 16;
const STACK_EMPTY_BYTE = 129;

// ─── independent bit helpers ───────────────────────────────────────────────

const scratch = new DataView(new ArrayBuffer(8));

function f64ToBits(v: number): bigint {
    scratch.setFloat64(0, v, true);
    return scratch.getBigUint64(0, true);
}

function bitsToF64(bits: bigint): number {
    scratch.setBigUint64(0, bits, true);
    return scratch.getFloat64(0, true);
}

/** True 80-bit slot → number, from the x87 definition (explicit J-bit significand
 *  `mant / 2^63` scaled by `2^(exp - 16383)`). Scaling is split so the very small /
 *  very large exponents don't underflow or overflow an intermediate. */
function decodeTrueF80(mant: bigint, signExp: number): number {
    const neg = (signExp & 0x8000) !== 0;
    const exp = signExp & 0x7FFF;
    if (exp === 0x7FFF) {
        if (mant === 0x8000000000000000n) return neg ? -Infinity : Infinity;
        return NaN;
    }
    if (exp === 0 && mant === 0n) return neg ? -0 : 0;

    let v = Number(mant) / 2 ** 63;
    let e = exp - 16383;
    while (e < -500) { v *= 2 ** -500; e += 500; }
    while (e > 500) { v *= 2 ** 500; e -= 500; }
    v *= 2 ** e;
    return neg ? -v : v;
}

/** Slot → number under relaxed rules (mirrors F80::to_f64). */
function decodeRelaxed(mant: bigint, signExp: number): number {
    return signExp === RELAXED_TAG ? bitsToF64(mant) : decodeTrueF80(mant, signExp);
}

// ─── snapshot construction / inspection ────────────────────────────────────

interface Slot { mant: bigint; signExp: number }

function relaxedSlot(value: number): Slot {
    return { mant: f64ToBits(value), signExp: RELAXED_TAG };
}

function makeSnapshot(slots: Array<Slot | null>): Uint8Array {
    const snap = createDefaultFpuSnapshot();
    const dv = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
    let stackEmpty = 0xFF;
    slots.forEach((s, i) => {
        if (!s) return;
        stackEmpty &= ~(1 << i);
        dv.setBigUint64(i * F80_SIZE, s.mant, true);
        dv.setUint16(i * F80_SIZE + 8, s.signExp, true);
    });
    snap[STACK_EMPTY_BYTE] = stackEmpty;
    return snap;
}

function readSlot(snap: Uint8Array, i: number): Slot {
    const dv = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
    return { mant: dv.getBigUint64(i * F80_SIZE, true), signExp: dv.getUint16(i * F80_SIZE + 8, true) };
}

// The values a parked thread can plausibly hold: ordinary magnitudes, both zeros,
// a subnormal, an infinity and a NaN — one per x87 slot.
const RELAXED_VALUES = [1.5, -0.1, 2.5e300, 5e-324, 0, -0, -Infinity, NaN];

describe("canonicalizeFpuSnapshotForMode — relaxed → strict", () => {
    test("every slot keeps its value once re-encoded as a true 80-bit image", () => {
        const snap = makeSnapshot(RELAXED_VALUES.map(relaxedSlot));

        expect(canonicalizeFpuSnapshotForMode(snap, false)).toBe(true);

        RELAXED_VALUES.forEach((expected, i) => {
            const slot = readSlot(snap, i);
            const decoded = decodeTrueF80(slot.mant, slot.signExp);
            expect(`slot${i}=${decoded}`).toBe(`slot${i}=${expected}`);
            expect(Object.is(decoded, expected)).toBe(true);
        });
    });

    test("empty slots are left alone", () => {
        const slots: Array<Slot | null> = new Array(8).fill(null);
        slots[0] = relaxedSlot(1.5);
        const snap = makeSnapshot(slots);
        const garbage = { mant: 0xDEADBEEFCAFEBABEn, signExp: RELAXED_TAG };
        const dv = new DataView(snap.buffer);
        dv.setBigUint64(3 * F80_SIZE, garbage.mant, true);
        dv.setUint16(3 * F80_SIZE + 8, garbage.signExp, true);

        canonicalizeFpuSnapshotForMode(snap, false);

        expect(readSlot(snap, 3)).toEqual(garbage);
    });

    test("a snapshot with no tagged slot is untouched", () => {
        const snap = makeSnapshot([{ mant: 0xC000000000000000n, signExp: 0x3FFF }]);
        const before = snap.slice();
        expect(canonicalizeFpuSnapshotForMode(snap, false)).toBe(false);
        expect(snap).toEqual(before);
    });
});

describe("canonicalizeFpuSnapshotForMode — strict → relaxed", () => {
    // The subtle direction: a genuine 80-bit value whose exponent field happens to be
    // 0x7FFE would be read as raw f64 bits by relaxed mode. LDBL_MAX is exactly this.
    test("a true-f80 value aliasing the tag becomes the infinity it is out of range for", () => {
        const LDBL_MAX: Slot = { mant: 0xFFFFFFFFFFFFFFFFn, signExp: RELAXED_TAG };
        const TWO_POW_16383: Slot = { mant: 0x8000000000000000n, signExp: RELAXED_TAG };
        const snap = makeSnapshot([LDBL_MAX, TWO_POW_16383]);

        // Both are +2^16383-scale, i.e. what relaxed mode must now represent.
        expect(decodeTrueF80(LDBL_MAX.mant, LDBL_MAX.signExp)).toBe(Infinity);

        expect(canonicalizeFpuSnapshotForMode(snap, true)).toBe(true);

        for (const i of [0, 1]) {
            const slot = readSlot(snap, i);
            expect(slot.signExp).toBe(RELAXED_TAG);
            expect(decodeRelaxed(slot.mant, slot.signExp)).toBe(Infinity);
        }
    });

    test("only 0x7FFE aliases — 0xFFFE (negative LDBL_MAX) is not touched", () => {
        const negLdblMax: Slot = { mant: 0xFFFFFFFFFFFFFFFFn, signExp: 0xFFFE };
        const snap = makeSnapshot([negLdblMax]);
        expect(canonicalizeFpuSnapshotForMode(snap, true)).toBe(false);
        expect(readSlot(snap, 0)).toEqual(negLdblMax);
    });

    test("re-applying the same direction is a no-op (aliased snapshots are safe)", () => {
        const snap = makeSnapshot([{ mant: 0xFFFFFFFFFFFFFFFFn, signExp: RELAXED_TAG }]);
        canonicalizeFpuSnapshotForMode(snap, true);
        const once = snap.slice();
        canonicalizeFpuSnapshotForMode(snap, true);
        expect(snap).toEqual(once);
    });
});

describe("canonicalizeFpuSnapshotForMode — toggle sequences", () => {
    test("relaxed → strict → relaxed preserves every value", () => {
        const snap = makeSnapshot(RELAXED_VALUES.map(relaxedSlot));

        canonicalizeFpuSnapshotForMode(snap, false);
        canonicalizeFpuSnapshotForMode(snap, true);

        RELAXED_VALUES.forEach((expected, i) => {
            const slot = readSlot(snap, i);
            expect(Object.is(decodeRelaxed(slot.mant, slot.signExp), expected)).toBe(true);
        });
    });
});

describe("PreemptionManager.setRelaxedFpu — parked snapshots", () => {
    function fakeManager(startRelaxed: boolean) {
        let relaxed = startRelaxed;
        let cacheClears = 0;
        const pm = new PreemptionManager();
        (pm as any).wasmExports = {
            get_relaxed_fpu: () => (relaxed ? 1 : 0),
            set_relaxed_fpu: (v: number) => { relaxed = v !== 0; },
            jit_clear_cache_js: () => { cacheClears++; },
        };
        return { pm, clears: () => cacheClears };
    }

    test("a live toggle re-encodes parked snapshots, aliased buffers exactly once", () => {
        const { pm, clears } = fakeManager(true);
        const parked = makeSnapshot([relaxedSlot(1.5), relaxedSlot(-64.25)]);
        // context.fpu and lastFpuState aliasing the same buffer (the clean dirty-bit
        // save path does exactly this) must not convert twice.
        pm.setSavedFpuStateProvider((visit) => { visit(parked); visit(parked); });

        pm.setRelaxedFpu(false);

        expect(readSlot(parked, 0).signExp).not.toBe(RELAXED_TAG);
        expect(decodeTrueF80(readSlot(parked, 0).mant, readSlot(parked, 0).signExp)).toBe(1.5);
        expect(decodeTrueF80(readSlot(parked, 1).mant, readSlot(parked, 1).signExp)).toBe(-64.25);
        expect(clears()).toBe(1);
    });

    test("setting the mode already in effect does not touch snapshots", () => {
        const { pm } = fakeManager(true);
        const parked = makeSnapshot([relaxedSlot(1.5)]);
        const before = parked.slice();
        pm.setSavedFpuStateProvider((visit) => visit(parked));

        pm.setRelaxedFpu(true);

        expect(parked).toEqual(before);
    });

    test("snapshot layout constant is what the walker assumes", () => {
        expect(FPU_SNAPSHOT_BYTES).toBe(134);
        expect(createDefaultFpuSnapshot()[STACK_EMPTY_BYTE]).toBe(0xFF);
    });
});
