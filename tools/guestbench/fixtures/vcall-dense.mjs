/**
 * demo_vcall_dense — virtual calls through an array of mixed object types (roadmap 07).
 *
 * Item 07 lists "virtual calls (`call [eax+N]`) whose target is not in the region" as one
 * of the candidate classes for the dispatch tax, with a call-site inline cache as its
 * lever. That class is only distinguishable from the others if a fixture produces it and
 * little else: here every iteration makes exactly one indirect call whose target rotates
 * between three implementations, so `moduleExitIndirect` dominates the exits and any
 * inline-cache hit rate is measured against a known target-set size.
 *
 * The callees live past the halt and return a value the checksum depends on, so a
 * mispredicting cache shows up as a wrong checksum rather than as a suspiciously good
 * number.
 */

import { mem, reg, EAX, ECX, EDX, EBX, ESI } from "../lib/asm.mjs";

const OBJECTS = 96;          // objects cycled through; a power-of-two-friendly wrap below
const OBJ_STRIDE = 16;       // [0] = vtable pointer, [4] = payload

export default {
    name: "vcall_dense",
    describe: "one indirect call per iteration over three implementations (roadmap 07)",
    defaults: {},

    data(dv, ctx) {
        for (let i = 0; i < OBJECTS; i++) {
            dv.setUint32(ctx.ARENA - ctx.BASE + i * OBJ_STRIDE + 4, (0x9e3779b9 * (i + 1)) >>> 0, true);
        }
    },

    /** Vtable contents can only be written once the callee labels are resolved. */
    postLink(dv, ctx, labels) {
        const impls = [0, 1, 2].map((t) => labels.get(`impl${t}`));
        for (let t = 0; t < 3; t++) dv.setUint32(ctx.DATA - ctx.BASE + 0x200 + t * 4, impls[t], true);
        for (let i = 0; i < OBJECTS; i++) {
            dv.setUint32(ctx.ARENA - ctx.BASE + i * OBJ_STRIDE, ctx.DATA + 0x200 + (i % 3) * 4, true);
        }
    },

    setup(a, ctx) {
        a.movImm(EBX, ctx.ARENA);        // object cursor
        a.movImm(ESI, 0);                // object index
        a.movImm(EAX, 0);                // checksum accumulator
    },

    body(a, ctx) {
        a.mov(ECX, mem({ base: EBX }));            // vtable pointer
        a.mov(EDX, mem({ base: ECX }));            // slot 0
        a.callIndirect(reg(EDX));                  // the virtual call
        a.alu("add", EAX, reg(ECX));               // fold the callee's result in
        a.imulImm(EAX, reg(EAX), 0x01000193);   // mix (see harness note on weak checksums)
        a.aluImm("add", reg(EBX), OBJ_STRIDE);
        a.inc(reg(ESI));
        a.mov(EDX, reg(ESI));
        a.aluImm("and", reg(EDX), 31);
        a.aluImm("cmp", reg(EDX), 0);
        a.jcc("ne", "no_wrap");
        // Wrapping every 32 objects keeps the whole working set in a few pages while still
        // cycling all three implementations (32 is not a multiple of 3).
        a.movImm(EBX, ctx.ARENA);
        a.movImm(ESI, 0);
        a.label("no_wrap");
    },

    /** Three implementations, each folding the object's payload differently into ECX. */
    tail(a) {
        for (let t = 0; t < 3; t++) {
            a.label(`impl${t}`);
            a.mov(ECX, mem({ base: EBX, disp: 4 }));   // the object's payload
            a.aluImm("add", reg(ECX), (0x01010101 * (t + 1)) >>> 0);
            a.ror(reg(ECX), t + 1);
            a.ret();
        }
    },

    finish(a, ctx) { a.movTo(ctx.checksum, EAX); },
    perIteration() { return { memoryOps: 3, addr: { baseConst: 3 } }; },
};
