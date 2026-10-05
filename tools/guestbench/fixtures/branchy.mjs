/**
 * demo_branchy — a hot core inside a large tree of rare branches (roadmap 06).
 *
 * Tier 2 forms a region by BFS over reachability, so a function whose hot core is
 * surrounded by error handlers and rare entity types pulls all of them into one wasm
 * function. The claim in item 06 is that the cold tail costs the hot core register
 * allocation. This fixture is the shape that makes the difference visible: the hot path is
 * a handful of instructions, the cold arms are large and taken once every `coldEvery`
 * iterations, and both a BFS region and a profile-guided one are correct — only their size
 * differs.
 *
 * The cold arms are REACHED, not dead: a region former that drops them would change the
 * checksum, so the fixture cannot be satisfied by simply not compiling them.
 */

import { mem, reg, EAX, ECX, EDX, EBX, EBP } from "../lib/asm.mjs";

export default {
    name: "branchy",
    describe: "small hot loop wrapped in a large cold branch tree (roadmap 06)",
    // `coldEvery` and `coldArms` must both be powers of two: each is used as a mask.
    defaults: { coldArms: 16, coldEvery: 256 },

    setup(a) {
        a.movImm(EAX, 0);
        a.movImm(ECX, 0);
    },

    body(a, ctx) {
        const arms = ctx.params.coldArms ?? 16;
        const every = ctx.params.coldEvery ?? 256;

        // Hot core: three register ops and a test. This is what a profile-guided region
        // should contain and a BFS region should be dominated by.
        a.inc(reg(ECX));
        a.alu("add", EAX, reg(ECX));
        a.imulImm(EAX, reg(EAX), 0x01000193);   // mix (see harness note on weak checksums)

        // The gate into the cold tree: taken once every `every` iterations. `every` must be
        // a power of two — the mask IS the frequency.
        a.mov(EDX, reg(ECX));
        a.aluImm("and", reg(EDX), every - 1);
        a.aluImm("cmp", reg(EDX), 0);
        a.jcc("ne", "hot_done");

        // WHICH arm: a higher slice of the same counter, so successive cold entries walk
        // the whole tree. Selecting on the gate's own residue (which is 0 by construction
        // once the gate is taken) would enter arm 0 every time and make `coldArms` a
        // parameter that changes the image but not the run — the shape of defect a
        // fixture-vs-declaration check exists to catch.
        a.mov(EDX, reg(ECX));
        a.shr(reg(EDX), Math.log2(every));
        a.aluImm("and", reg(EDX), arms - 1);

        for (let i = 0; i < arms; i++) {
            a.aluImm("cmp", reg(EDX), i);
            a.jcc("ne", `arm_${i}_skip`);
            // Each arm is deliberately bulky: this is the mass a BFS region absorbs.
            for (let k = 0; k < 12; k++) {
                a.aluImm("add", reg(EAX), 0x01010101 * (i + 1) >>> 0);
                a.imulImm(EAX, reg(EAX), 0x01000193);   // mix (see harness note on weak checksums)
            }
            a.jmp("hot_done");
            a.label(`arm_${i}_skip`);
        }
        a.label("hot_done");
    },

    finish(a, ctx) { a.movTo(ctx.checksum, EAX); },
    perIteration() { return { memoryOps: 0, addr: {} }; },
};
