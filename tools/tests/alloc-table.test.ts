import { describe, expect, it } from "bun:test";
import { AllocTable } from "../../src/worker/core/memory/alloc-table";

describe("AllocTable matches the two Maps it replaces", () => {
    it("agrees with Map<addr,size> + Map<addr,bucket> over a random workload", () => {
        const t = new AllocTable<string>(4);
        const sizes = new Map<number, number>();
        const buckets = new Map<number, string>();
        let seed = 12345;
        const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
        const kinds = ["HEAP", "HEAP_HIGH", "SURFACE", "ROM"];
        // A small address space forces collisions, deletes in probe chains and regrowth.
        const addr = () => 0x10000 + rnd(512) * 16;
        for (let step = 0; step < 200_000; step++) {
            const a = addr();
            switch (rnd(7)) {
                case 0: case 1: { const s = rnd(1 << 20); t.setSize(a, s); sizes.set(a, s); break; }
                case 2: { const k = kinds[rnd(kinds.length)]; t.setBucket(a, k); buckets.set(a, k); break; }
                case 3: case 4: t.deleteSize(a); sizes.delete(a); break;
                case 5: t.deleteBucket(a); buckets.delete(a); break;
                case 6: if (rnd(2000) === 0) { t.clear(); sizes.clear(); buckets.clear(); } break;
            }
            const q = addr();
            expect(t.has(q)).toBe(sizes.has(q));
            expect(t.getSize(q)).toBe(sizes.get(q));
            expect(t.getBucket(q)).toBe(buckets.get(q));
            expect(t.size).toBe(sizes.size);
        }
    });
});

describe("AllocTable insertion order", () => {
    it("iterates sizes in the order a Map would: first set wins, delete + re-add moves to the end", () => {
        const t = new AllocTable<string>(2);
        const m = new Map<number, number>();
        const ops: Array<[string, number, number?]> = [
            ["s", 0x100, 1], ["s", 0x200, 2], ["s", 0x300, 3], ["s", 0x100, 9], ["d", 0x200],
            ["s", 0x400, 4], ["s", 0x200, 5], ["s", 0x500, 6], ["d", 0x100], ["s", 0x100, 7],
        ];
        for (const [op, a, v] of ops) {
            if (op === "s") { t.setSize(a, v!); m.set(a, v!); } else { t.deleteSize(a); m.delete(a); }
        }
        expect(t.entriesByInsertion().map((e) => [e.addr, e.size])).toEqual([...m.entries()]);
    });
});
