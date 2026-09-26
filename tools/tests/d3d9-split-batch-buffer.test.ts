/**
 * Split worker mode ships one queue batch per present (~1.3 MB on NFSU). A fresh buffer per
 * batch pays its page faults on the guest thread, so the render worker hands each batch's
 * buffer back on `retired` and the next ship fills it. The walk reads [0, end) only, so a
 * recycled buffer's stale tail is never seen.
 */

import { describe, expect, test } from "bun:test";
import { fillSplitBatchBuffer } from "../../src/worker/render/d3d9-render-client";

const queue = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

describe("split batch buffer", () => {
    test("no returned buffer: a new one with headroom, holding exactly the queue prefix", () => {
        const counters = { recycledBatches: 0 };
        const q = queue(1000, 1);
        const out = fillSplitBatchBuffer([], q, 600, true, counters);
        expect(out.buffer.byteLength).toBeGreaterThan(600);
        expect([...out.subarray(0, 600)]).toEqual([...q.subarray(0, 600)]);
        expect(counters.recycledBatches).toBe(0);
    });

    test("a returned buffer large enough is reused and overwritten from 0", () => {
        const counters = { recycledBatches: 0 };
        const returned = new Uint8Array(4096).fill(0xcd).buffer;
        const pool = [returned];
        const q = queue(3000, 5);
        const out = fillSplitBatchBuffer(pool, q, 2500, true, counters);
        expect(out.buffer).toBe(returned);
        expect([...out.subarray(0, 2500)]).toEqual([...q.subarray(0, 2500)]);
        expect(pool).toHaveLength(0);
        expect(counters.recycledBatches).toBe(1);
    });

    test("a returned buffer too small is dropped, never written short", () => {
        const counters = { recycledBatches: 0 };
        const small = new ArrayBuffer(100);
        const pool = [small];
        const q = queue(500, 9);
        const out = fillSplitBatchBuffer(pool, q, 400, true, counters);
        expect(out.buffer).not.toBe(small);
        expect([...out.subarray(0, 400)]).toEqual([...q.subarray(0, 400)]);
        expect(pool).toHaveLength(0);
        expect(counters.recycledBatches).toBe(0);
    });

    test("recycling off: an exact copy, and the pool is released", () => {
        const counters = { recycledBatches: 0 };
        const pool = [new ArrayBuffer(4096)];
        const q = queue(300, 3);
        const out = fillSplitBatchBuffer(pool, q, 200, false, counters);
        expect(out.byteLength).toBe(200);
        expect(out.buffer.byteLength).toBe(200);
        expect([...out]).toEqual([...q.subarray(0, 200)]);
        expect(pool).toHaveLength(0);
    });

    test("the worker returns every batch buffer, transferred", () => {
        const src = require("node:fs").readFileSync("src/worker/render/d3d9-render-worker.ts", "utf8") as string;
        expect(src).toMatch(/type: "retired"[\s\S]{0,200}bytes: msg\.bytes,\s*\}, \[msg\.bytes\]\)/);
    });
});
