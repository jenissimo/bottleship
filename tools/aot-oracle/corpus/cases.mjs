// aot-oracle — the case registry.
//
// A CASE is one piece of guest work the oracle can run through every arm. Adding a case is
// adding an entry here: byte-exact guest code, the wrapper prologue that seeds its input
// registers, how many inner iterations one call performs, which guest regions must come out
// byte-identical, and (optionally) named fault injections used as negative controls.
//
// The seed corpus is the spike's two byte-exact NFSU kernels (corpus/kernels.mjs), kept for
// the reason they were chosen: k1 is the tightest self-contained loop on NFSU's hottest page
// (0x5d3), k2 is the x87 class. `node verify-corpus.mjs` re-extracts both from the retail
// binary and fails on drift.

import * as L from "./layout.mjs";
import { KERNELS } from "./kernels.mjs";

/**
 * @typedef {object} Case
 * @property {string} id
 * @property {Uint8Array} body byte-exact guest code
 * @property {number} codeAddr guest address of the first wrapper (own page)
 * @property {number} insPerIter guest instructions retired per inner iteration
 * @property {number} insStatic instructions in the extracted byte range
 * @property {number} iters inner iterations per call
 * @property {{off:number, prologue:Array}[]} calls one wrapper per call site in an outer iteration
 * @property {{name:string, addr:number, len:number}[]} regions compared byte-for-byte
 * @property {Record<string, (dv:DataView, origin:number)=>string>} faults negative controls
 * @property {{fn:string, args:(outer:number, mode:number)=>number[]}} raw foreign-module entry
 * @property {object} provenance
 */

/** Flip the source word that feeds the LAST inner iteration of the LAST call. */
function flipWord(addr) {
    return (dv, origin) => {
        const o = addr - origin;
        const cur = dv.getUint32(o, true);
        const next = cur === 0 ? 0xDEADBEEF : 0;
        dv.setUint32(o, next, true);
        return `0x${addr.toString(16)}: 0x${cur.toString(16)} -> 0x${next.toString(16)}`;
    };
}

const STATE_REGION = { name: "STATE", addr: L.STATE, len: L.STATE_LEN, fields: L.STATE_FIELDS };

/** @type {Record<string, Case>} */
export const CASES = {
    // K1 — per-element attribute fill, page 0x5d3 (156.6M block-exec / 15 s in the M0 trace).
    // Two calls per outer iteration exercise both sides of the branch diamond (obj0.flag==0
    // and obj1.flag!=0), which is why the spike used two contexts.
    k1: {
        id: "k1",
        body: KERNELS.k1.bytes,
        codeAddr: L.K1_ADDR,
        insPerIter: KERNELS.k1.insPerIter,
        insStatic: KERNELS.k1.insStatic,
        iters: L.COUNT,
        calls: [
            {
                off: 0,
                prologue: [
                    ["mov", "ecx", L.CTXA], ["mov", "esi", L.ROOT], ["mov", "ebp", L.FRAME1],
                    ["movEbp8", 8, 0], ["xor", "eax"],
                ],
            },
            {
                off: 0x80,
                prologue: [
                    ["mov", "ecx", L.CTXB], ["mov", "esi", L.ROOT], ["mov", "ebp", L.FRAME1],
                    ["movEbp8", 8, 0], ["xor", "eax"],
                ],
            },
        ],
        regions: [
            { name: "DST1", addr: L.DST1, len: L.COUNT * 4 },
            { name: "FRAME1", addr: L.FRAME1 - 8, len: 0x20 },
            STATE_REGION,
        ],
        faults: {
            // Feeds the last iteration of the ctxB call: changes DST1's last element AND the
            // architectural ebx at the capture point (setne bl of that very word).
            "src-last": flipWord(L.SRC1 + L.CTXB_BASEOFF + L.OFF_B + (L.COUNT - 1) * 4),
        },
        raw: {
            fn: "run_k1",
            args: (outer, mode) => [outer, mode, L.CTXA, L.CTXB, L.ROOT, L.FRAME1],
        },
        provenance: { va: KERNELS.k1.va, sha256: KERNELS.k1.sha256, from: "NFSU Speed.exe" },
    },

    // K2 — 4x4 vertex transform: 48 x87 ops, 43 memory operands, one basic block.
    k2: {
        id: "k2",
        body: KERNELS.k2.bytes,
        codeAddr: L.K2_ADDR,
        insPerIter: KERNELS.k2.insPerIter,
        insStatic: KERNELS.k2.insStatic,
        iters: L.VCOUNT,
        calls: [
            {
                off: 0,
                prologue: [
                    ["mov", "ecx", L.SRC2], ["mov", "edx", L.MTX], ["mov", "ebx", L.DST2],
                    ["mov", "ebp", L.FRAME2], ["mov", "eax", L.VCOUNT],
                ],
            },
        ],
        regions: [
            { name: "DST2", addr: L.DST2, len: L.VCOUNT * 16 },
            { name: "STAGE2", addr: L.FRAME2 - 0x10, len: 0x10 },
            STATE_REGION,
        ],
        faults: {
            // x-component of the last vertex: changes DST2's last 16 bytes. K2's exit
            // registers are data-independent, so this is the memory-only control.
            "src-last": flipWord(L.SRC2 + (L.VCOUNT - 1) * 16),
        },
        raw: {
            fn: "run_k2",
            args: (outer, mode) => [outer, mode, L.SRC2, L.MTX, L.DST2, L.FRAME2, L.VCOUNT],
        },
        provenance: { va: KERNELS.k2.va, sha256: KERNELS.k2.sha256, from: "NFSU Speed.exe" },
    },

    // K3 — the INTEGER core, page 0x5d4: one basic block, one memory read, one memory write,
    // a setcc, a register-counted self-loop. This is the case the "integer-core" compiler
    // slice must compile end-to-end with no hole, because a hole costs the whole page.
    k3: {
        id: "k3",
        body: KERNELS.k3.bytes,
        codeAddr: L.K3_ADDR,
        insPerIter: KERNELS.k3.insPerIter,
        insStatic: KERNELS.k3.insStatic,
        iters: L.COUNT,
        calls: [
            {
                off: 0,
                // ecx = destination cursor, edi = (source - destination), eax = element count.
                prologue: [
                    ["mov", "ecx", L.DST3], ["mov", "edi", (L.SRC1 - L.DST3) >>> 0],
                    ["mov", "eax", L.COUNT],
                ],
            },
        ],
        regions: [
            { name: "DST3", addr: L.DST3, len: L.COUNT * 4 },
            STATE_REGION,
        ],
        faults: {
            // The source word feeding the LAST iteration: changes DST3's last element AND the
            // architectural edx at the capture point (setne dl of that very word).
            "src-last": flipWord(L.SRC1 + (L.COUNT - 1) * 4),
        },
        raw: { fn: "run_k3", args: (outer, mode) => [outer, mode, L.DST3, (L.SRC1 - L.DST3) >>> 0, L.COUNT] },
        provenance: { va: KERNELS.k3.va, sha256: KERNELS.k3.sha256, from: "NFSU Speed.exe" },
    },

    // K4 — nested loops + read-modify-write, page 0x5cb. Seven basic blocks, two branch
    // diamonds, three back edges, five RMW memory operands. Exists to make the CFG and the
    // two-phase RMW shape (contract N40 / D3) part of the differential, not a claim.
    k4: {
        id: "k4",
        body: KERNELS.k4.bytes,
        codeAddr: L.K4_ADDR,
        insPerIter: KERNELS.k4.insPerIter,
        insStatic: KERNELS.k4.insStatic,
        iters: 1,
        calls: [
            {
                off: 0,
                prologue: [
                    ["mov", "ebp", L.FRAME3],
                    ["mov", "edx", L.K4_ROW_DWORDS],
                    ["mov", "eax", L.K4_SRC_ADVANCE],
                    ["movEbp8", 0x08, L.K4_INNER],      // inner trip count
                    ["movEbp8", 0x0c, L.DST4],          // destination base
                    ["movEbp8", 0x10, L.SRC1],          // source base
                    ["movEbp8", 0xfc, L.K4_MID],        // [ebp-4]     mid trip count
                    ["movEbp8", 0xec, L.K4_OUTER],      // [ebp-0x14]  outer trip count
                ],
            },
        ],
        regions: [
            { name: "DST4", addr: L.DST4, len: L.K4_OUTER * L.K4_MID * L.K4_INNER * 4 },
            { name: "FRAME3", addr: L.FRAME3 - 0x14, len: 0x28 },
            STATE_REGION,
        ],
        faults: {
            // Feeds the very first inner-loop read; changes DST4's first element.
            "src-first": flipWord(L.SRC1),
        },
        raw: { fn: "run_k4", args: (outer, mode) => [outer, mode, L.FRAME3] },
        provenance: { va: KERNELS.k4.va, sha256: KERNELS.k4.sha256, from: "NFSU Speed.exe" },
    },
};

export function getCase(id) {
    const c = CASES[id];
    if (!c) throw new Error(`unknown case "${id}" (have: ${Object.keys(CASES).join(", ")})`);
    return c;
}
