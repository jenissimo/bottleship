/**
 * demo_heap_walk — a pointer chase over scattered pages (roadmap 03).
 *
 * `stack_mix` is TLB-friendly by construction: every access lands in one of a handful of
 * pages. A permission bitmap is supposed to win precisely where the current TLB does not,
 * so the counter-fixture walks a linked list whose next-pointers are spread across the
 * whole arena with a fixed seed — deterministic, but with no locality for a per-page cache
 * to exploit.
 *
 * This is the arm that says whether a change is a win or a redistribution: item 03 must not
 * regress here, and a "win" that only appears on stack_mix is a win on locality, not on the
 * lookup.
 */

import { mem, reg, EAX, ECX, EDX, EBX } from "../lib/asm.mjs";

const NODE_STRIDE = 4096 + 64;    // one node per page, offset so they are not all aliased

export default {
    name: "heap_walk",
    describe: "pointer chase across scattered pages, fixed seed (roadmap 03)",
    defaults: { nodes: 48 },

    data(dv, ctx) {
        const nodes = ctx.params.nodes ?? 48;
        if ((nodes - 1) * NODE_STRIDE + 8 > ctx.ARENA_BYTES) throw new Error(`heap_walk: ${nodes} nodes overflow the arena`);
        // A fixed-seed permutation, so the chase order is scattered but reproducible.
        const order = [...Array(nodes).keys()];
        let s = 0x12345678;
        for (let i = nodes - 1; i > 0; i--) {
            s = (Math.imul(s, 1103515245) + 12345) >>> 0;
            const j = s % (i + 1);
            [order[i], order[j]] = [order[j], order[i]];
        }
        const addrOf = (k) => ctx.ARENA + k * NODE_STRIDE;
        for (let i = 0; i < nodes; i++) {
            const here = addrOf(order[i]);
            const next = addrOf(order[(i + 1) % nodes]);
            dv.setUint32(here - ctx.BASE, next, true);            // [0] = next
            dv.setUint32(here - ctx.BASE + 4, (0x9e3779b9 * (i + 1)) >>> 0, true);  // [4] = payload
        }
        // Where the walk starts.
        dv.setUint32(ctx.DATA - ctx.BASE + 0x100, addrOf(order[0]), true);
    },

    setup(a, ctx) {
        a.mov(EBX, ctx.at(ctx.DATA + 0x100));   // cursor
        a.movImm(EAX, 0);
    },

    body(a) {
        a.alu("add", EAX, mem({ base: EBX, disp: 4 }));   // payload
        a.mov(EBX, mem({ base: EBX }));                   // next — the dependent load
        a.imulImm(EAX, reg(EAX), 0x01000193);   // mix (see harness note on weak checksums)
    },

    finish(a, ctx) { a.movTo(ctx.checksum, EAX); },

    perIteration() {
        return { memoryOps: 2, addr: { baseConst: 2 } };
    },
};
