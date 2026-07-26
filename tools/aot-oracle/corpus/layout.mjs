// aot-oracle — shared guest memory layout + deterministic data image.
//
// ONE source of truth for every arm:
//   reference / unit  — the image is loaded as a multiboot blob into v86 guest RAM.
//   raw               — the same bytes are copied into a foreign module's linear memory at
//                       the SAME guest addresses, so both sides run over an identical image.
//
// Physical == virtual: the guest builds a 4KB-page identity map of 0..8MB, mirroring
// BottleShip's PageTableManager (identity-mapped, ASLR-free).
//
// Everything lives above 1MB (FASTMEM_LOW_MEM_END) so v86 compiles the same fastmem read
// fast path as production (jit.rs gen_fastmem_read_split, range 1).
//
// Promoted verbatim from tools/probes/aot-spike/layout.mjs, plus STATE (below), which is
// what turns "registers are byte-identical" into a checkable assertion for any candidate:
// the architectural register file is spilled to guest memory at the capture point, exactly
// as the module contract (`plan/aot-module-contract.md`, RFC §4.2) requires a unit to flush
// it at every exit.

export const MEM_SIZE = 16 * 1024 * 1024;

export const CODE_BASE = 0x00100000;   // multiboot load address (page 0x100)
export const ENTRY_OFF = 0x20;         // after the 32-byte multiboot header
export const K1_ADDR   = 0x00101000;   // kernel 1 wrapper + body (own page)
export const K2_ADDR   = 0x00102000;   // kernel 2 wrapper + body (own page)
export const K3_ADDR   = 0x00103000;   // kernel 3 (integer core) — own page
export const K4_ADDR   = 0x00104000;   // kernel 4 (nested loops + RMW) — own page
export const PD_ADDR   = 0x00108000;
export const PT0_ADDR  = 0x00109000;   // identity 0..4MB
export const PT1_ADDR  = 0x0010A000;   // identity 4..8MB
export const STACK_TOP = 0x0010C000;   // stack grows down into 0x10B000

export const DATA      = 0x0010C000;
export const CTXA      = DATA + 0x0000;
export const CTXB      = DATA + 0x0020;
export const ROOT      = DATA + 0x0040;   // needs +0x8c
export const PTRB      = DATA + 0x0140;
export const OBJ0      = DATA + 0x0160;
export const OBJ1      = DATA + 0x01A0;
export const OBJTAB    = DATA + 0x01E0;
export const FRAME1    = DATA + 0x0200;   // ebp for K1 (uses -8 .. +0x10)
export const FRAME2    = DATA + 0x0240;   // ebp for K2 (uses -0x10 .. +0x14)
export const MTX       = DATA + 0x0280;   // 16 f32
export const STATE     = DATA + 0x0300;   // architectural register file, spilled by the guest
export const SRC1      = DATA + 0x1000;   // 0x400 bytes
export const DST1      = DATA + 0x2000;   // COUNT * 4
export const SRC2      = DATA + 0x3000;   // VCOUNT * 16
export const DST2      = DATA + 0x4000;   // VCOUNT * 16
export const FRAME3    = DATA + 0x0500;   // ebp for K4 (uses -0x14 .. +0x14)
export const DST3      = DATA + 0x4800;   // K3: COUNT * 4
export const DST4      = DATA + 0x4900;   // K4: OUTER * MID * INNER * 4
export const IMAGE_END = DATA + 0x5000;

// K4 trip counts. Small on purpose: the case exists to exercise a CFG with three back edges
// and five read-modify-write operands, not to be a long-running benchmark.
export const K4_OUTER = 2;
export const K4_MID   = 3;
export const K4_INNER = 8;
export const K4_ROW_DWORDS = 8;                    // edx; edi = edx * 4 = dst row stride
export const K4_SRC_ADVANCE = K4_MID * K4_INNER * 4;  // eax; added to [ebp+0xc] per outer pass

/**
 * STATE layout. Offsets are the comparison contract: a byte that differs inside this region
 * is reported by name, so a diff says "ebx" and not "guest 0x10c30c".
 * Register order is v86's reg32 order (cpu.js:214) so the host-side snapshot and the
 * guest-side spill are the same vector.
 */
export const STATE_FIELDS = [
    ["eax", 0x00, 4], ["ecx", 0x04, 4], ["edx", 0x08, 4], ["ebx", 0x0c, 4],
    ["esp", 0x10, 4], ["ebp", 0x14, 4], ["esi", 0x18, 4], ["edi", 0x1c, 4],
    ["eflags", 0x20, 4],
];
export const STATE_LEN = 0x24;

// Inner iterations per kernel call. Overridable from the environment so the FIXED per-call
// cost (module entry/exit + the driver loop) can be separated from the per-iteration cost by
// running two element counts and taking a slope — every arm reads these same constants, so
// the comparison stays apples-to-apples.
export const COUNT  = Number(process.env.AOT_ORACLE_COUNT || 64);   // K1 elements per call
export const VCOUNT = Number(process.env.AOT_ORACLE_VCOUNT || 64);  // K2 vertices per call

export const PORT = 0x310;  // marker port (unclaimed in v86's io map)

// K1 addressing, derived from the real instruction stream (see kernels.mjs):
//   srcAddr(i) = obj[+0x28] + ctx[+0xc] + i*4 + edi   (edi = root[+0x2c] or [root[+0xc]][+8])
//   dstAddr(i) = frame[+0x10] + i*4
export const CTXA_BASEOFF = 0x10;
export const CTXB_BASEOFF = 0x20;
export const OFF_A        = 0x40;   // root[+0x2c]      (obj0.flag == 0)
export const OFF_B        = 0x80;   // [root[+0xc]][+8] (obj1.flag != 0)

/** Deterministic LCG so every arm sees byte-identical inputs. */
function lcg(seed) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
}

/**
 * Write the data section of the image (guest-physical addressed).
 * @param {DataView} dv view whose byte 0 corresponds to guest address `origin`
 * @param {number} origin guest address of dv byte 0
 */
export function writeDataImage(dv, origin) {
    const w32 = (addr, v) => dv.setUint32(addr - origin, v >>> 0, true);
    const wf32 = (addr, v) => dv.setFloat32(addr - origin, v, true);

    // ── K1 object graph ────────────────────────────────────────────────────
    w32(CTXA + 4, 0);                 // objIndex
    w32(CTXA + 0xc, CTXA_BASEOFF);
    w32(CTXB + 4, 1);
    w32(CTXB + 0xc, CTXB_BASEOFF);

    w32(ROOT + 0x8c, OBJTAB);
    w32(ROOT + 0x2c, OFF_A);
    w32(ROOT + 0xc, PTRB);
    w32(PTRB + 8, OFF_B);

    w32(OBJTAB + 0, OBJ0);
    w32(OBJTAB + 4, OBJ1);
    w32(OBJ0 + 0x28, SRC1);
    w32(OBJ0 + 0x38, 0);              // flag == 0  → edi = root[+0x2c]
    w32(OBJ1 + 0x28, SRC1);
    w32(OBJ1 + 0x38, 1);              // flag != 0  → edi = [root[+0xc]][+8]

    w32(FRAME1 + 0xc, COUNT);         // loop bound
    w32(FRAME1 + 0x10, DST1);         // destination base
    w32(FRAME1 + 8, 0);               // induction variable (wrapper re-zeroes it)
    w32(FRAME1 - 8, 0);               // fild scratch slot

    // Source words: ~1/3 zero so `setne` alternates and the stored float varies.
    const rnd = lcg(0xC0FFEE);
    for (let off = 0; off < 0x400; off += 4) {
        const r = rnd();
        w32(SRC1 + off, (r % 3 === 0) ? 0 : r);
    }
    for (let i = 0; i < COUNT; i++) w32(DST1 + i * 4, 0);

    // ── K2 vertex transform ────────────────────────────────────────────────
    // Column-major-ish 4x4; values chosen to keep results in a normal range.
    const m = [
        0.8660254, -0.5000000, 0.0000000, 0.0000000,
        0.5000000, 0.8660254, 0.0000000, 0.0000000,
        0.0000000, 0.0000000, 1.0000000, 0.0000000,
        12.500000, -3.250000, 7.7500000, 1.0000000,
    ];
    for (let i = 0; i < 16; i++) wf32(MTX + i * 4, m[i]);

    w32(FRAME2 + 0xc, 16);            // dst stride
    w32(FRAME2 + 0x14, 16);           // src stride
    for (let i = 0; i < 4; i++) w32(FRAME2 - 0x10 + i * 4, 0);   // staging

    const r2 = lcg(0x1234567);
    for (let v = 0; v < VCOUNT; v++) {
        for (let c = 0; c < 4; c++) {
            const t = (r2() >>> 8) / 0x1000000;          // [0,1)
            wf32(SRC2 + v * 16 + c * 4, c === 3 ? 1.0 : (t * 20 - 10));
        }
    }
    for (let i = 0; i < VCOUNT * 4; i++) w32(DST2 + i * 4, 0);

    // ── K3 / K4 destinations ───────────────────────────────────────────────
    // Both read SRC1 (already filled above), so no new source data is needed — which also
    // keeps the k1 image byte-identical to what it was before these cases existed.
    for (let i = 0; i < COUNT; i++) w32(DST3 + i * 4, 0);
    for (let i = 0; i < K4_OUTER * K4_MID * K4_INNER; i++) w32(DST4 + i * 4, 0);
    for (let off = -0x14; off <= 0x14; off += 4) w32(FRAME3 + off, 0);

    // STATE starts zeroed: a candidate that never flushes its register file diverges on
    // STATE+0 rather than passing quietly.
    for (let off = 0; off < STATE_LEN; off += 4) w32(STATE + off, 0);
}
