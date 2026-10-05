/**
 * demo_x87_chain — long x87 dependency chains with no memory between them (roadmap 05).
 *
 * The AOT plan's P5 pass is per-unit cache lifetimes, and the postmortem's "x87 stack-value
 * forwarding" is that pass applied to `fpu_st`. Its ceiling is set by how long a run of x87
 * arithmetic goes without something that has to spill the stack to memory, so this fixture
 * is exactly that run: one load, `chain` register-form operations, one store.
 *
 * `--chain` is the SCALE knob the roadmap asks every fixture for. The model to fit is
 * `ms/iteration = fixed + k x chain`; if forwarding works, k falls, and if it does not, k
 * is unchanged and the pass bought nothing regardless of how the emitted IR reads.
 */

import { mem, reg, EAX, EBP } from "../lib/asm.mjs";

export default {
    name: "x87_chain",
    describe: "long register-form x87 chains between one load and one store (roadmap 05)",
    defaults: { chain: 8 },

    data(dv, ctx) {
        dv.setFloat32(ctx.DATA - ctx.BASE - 8, 1.0000001, true);
        dv.setFloat32(ctx.DATA - ctx.BASE - 12, 0.9999999, true);
    },

    setup(a) { a.movImm(EAX, 0); },

    body(a, ctx) {
        const chain = ctx.params.chain ?? 8;
        a.fldM32(mem({ base: EBP, disp: -8 }));       // st1 after the next load
        a.fldM32(mem({ base: EBP, disp: -12 }));      // st0
        for (let i = 0; i < chain; i++) {
            // Register-form arithmetic only: nothing here forces fpu_st back to memory.
            a.farithSt(i % 2 === 0 ? "mul" : "add", 1);
        }
        a.fistpM32(mem({ base: EBP, disp: -0x20 }));  // the one store, and it pops st0
        a.fstpSt(0);                                  // drop the operand we kept
        a.alu("add", EAX, mem({ base: EBP, disp: -0x20 }));
        a.imulImm(EAX, reg(EAX), 0x01000193);   // mix (see harness note on weak checksums)
    },

    finish(a, ctx) { a.movTo(ctx.checksum, EAX); },
    perIteration(params) {
        const chain = params.chain ?? 8;
        return {
            memoryOps: 4,
            addr: { stackConst: 4 },
            // Two stores: the FISTP, and the FSTP ST(0) that drops the operand kept in
            // st(1). The register form is a store like the memory form is.
            x87: { load: 2, arith: chain, store: 2 },
        };
    },
};
