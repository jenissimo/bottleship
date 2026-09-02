/**
 * demo_stack_mix — memory-op mix with a controllable stack share
 * (docs/performance/sota-roadmap/02, 03).
 *
 * Item 02 claims a win proportional to the share of accesses that are ESP/EBP-based with a
 * constant displacement; item 03 claims one on the remainder. A single workload cannot
 * distinguish "the guard is cheaper than the TLB lookup" from "this workload happens to be
 * stack-heavy", so the mix is a PARAMETER: `--mix 20|50|80` is the percentage of the
 * loop's memory operands that are stack-relative, the rest split between base+const and
 * base+index.
 *
 * The reading that matters is the SHAPE, not any single arm: a stack-fastmem win must grow
 * monotonically with the mix. If it does not, the guard costs more than the lookups it
 * removes, and that conclusion is available before any of it ships.
 *
 * Every arm does the same NUMBER of memory operands — only their addressing form changes —
 * so the checksums differ between mixes but the work does not.
 */

import { mem, reg, EAX, ECX, EDX, EBX, EBP, ESI } from "../lib/asm.mjs";

const OPS_PER_ITERATION = 10;

export default {
    name: "stack_mix",
    describe: "memory-operand mix with a tunable stack-relative share (roadmap 02/03)",
    defaults: { mix: 50 },

    data(dv, ctx) {
        // A deterministic pattern in both regions, so a wrong address reads a wrong value
        // and the checksum moves rather than the run silently reading zeros.
        for (let i = 0; i < 0x400; i += 4) dv.setUint32(ctx.DATA - ctx.BASE - 0x400 + i, 0x9e3779b9 * (i + 1) >>> 0, true);
        for (let i = 0; i < 0x4000; i += 4) dv.setUint32(ctx.ARENA - ctx.BASE + i, (0x85ebca6b * (i + 7)) >>> 0, true);
    },

    setup(a, ctx) {
        a.movImm(EDX, ctx.ARENA);        // base for the non-stack accesses
        a.movImm(ESI, 3);                // a fixed index, so base+index is a real SIB form
        a.movImm(EAX, 0);                // checksum accumulator
    },

    body(a, ctx) {
        const mix = ctx.params.mix ?? 50;
        const stackOps = Math.round((OPS_PER_ITERATION * mix) / 100);
        const rest = OPS_PER_ITERATION - stackOps;
        const indexOps = rest >> 1;
        const baseOps = rest - indexOps;

        // Stack-relative: [ebp-K] and [esp+K], constant displacement, no index. This is
        // exactly the class a per-unit guard can cover.
        for (let i = 0; i < stackOps; i++) {
            if (i % 2 === 0) a.alu("add", EAX, mem({ base: EBP, disp: -0x08 - 4 * (i % 24) }));
            else a.alu("xor", EAX, mem({ base: 4 /* ESP */, disp: 4 * (i % 8) }));
        }
        // Base + constant: a heap pointer with a field offset.
        for (let i = 0; i < baseOps; i++) a.alu("add", EAX, mem({ base: EDX, disp: 0x40 * (i % 16) }));
        // Base + index*scale: the array walk a guard cannot bound statically.
        for (let i = 0; i < indexOps; i++) a.alu("xor", EAX, mem({ base: EDX, index: ESI, scale: 4, disp: 0x100 * (i % 8) }));

        a.imulImm(EAX, reg(EAX), 0x01000193);   // FNV-style mix: a rotate has short cycles
    },

    finish(a, ctx) { a.movTo(ctx.checksum, EAX); },

    /** What one iteration is, by construction — the census must reproduce this. */
    perIteration(params) {
        const mix = params.mix ?? 50;
        const stackOps = Math.round((OPS_PER_ITERATION * mix) / 100);
        const rest = OPS_PER_ITERATION - stackOps;
        const indexOps = rest >> 1;
        return {
            memoryOps: OPS_PER_ITERATION,
            addr: { stackConst: stackOps, baseConst: rest - indexOps, baseIndex: indexOps },
        };
    },
};
