/**
 * demo_flags_dense — arithmetic interleaved with stores (roadmap 04).
 *
 * Item 04's claim is that TurboFan sees ONE alias class for the whole linear memory, so
 * every guest store invalidates the lazy-flag state (`last_op1`, `last_result`, …) it had
 * already loaded. If that costs anything anywhere, it is maximal here: each arithmetic op
 * is followed by a store and then by an instruction that READS the carry, so a reload after
 * every store is a reload per instruction pair.
 *
 * This is the fixture item 04 is decided on. The roadmap is explicit that with no win here
 * there is none on a real game, and the item closes as a recorded negative result rather
 * than as an unfinished idea.
 */

import { mem, reg, EAX, ECX, EBX, EBP } from "../lib/asm.mjs";

export default {
    name: "flags_dense",
    describe: "ALU ops separated by stores, maximising lazy-flag reloads (roadmap 04)",
    defaults: { pairs: 8 },

    setup(a) {
        a.movImm(EAX, 1);
        a.movImm(ECX, 0);
        a.movImm(EBX, 0);
    },

    body(a, ctx) {
        const pairs = ctx.params.pairs ?? 8;
        for (let i = 0; i < pairs; i++) {
            a.alu("add", EAX, reg(ECX));                                   // writes flags
            a.movTo(mem({ base: EBP, disp: -0x40 + 4 * (i % 8) }), EAX);    // the store
            a.aluImm("adc", reg(EBX), 0);                                  // reads the carry
            a.inc(reg(ECX));
        }
        a.imulImm(EAX, reg(EAX), 0x01000193);   // mix (see harness note on weak checksums)
    },

    finish(a, ctx) {
        a.alu("xor", EAX, reg(EBX));
        a.movTo(ctx.checksum, EAX);
    },
    perIteration(params) {
        const pairs = params.pairs ?? 8;
        return { memoryOps: pairs, addr: { stackConst: pairs } };
    },
};
