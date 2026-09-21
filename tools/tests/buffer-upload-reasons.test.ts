import { describe, expect, test, beforeEach } from "bun:test";
import {
    alignUploadRange, getBufferUploadCensus, noteBufferUpload, noteGuestBufferWrite,
    noteUploadReason, resetBufferUploadCensus,
} from "../../src/worker/backends/webgpu/buffer-upload";

const d3d9 = () => (getBufferUploadCensus() as any).d3d9;

describe("buffer-upload reason breakdown", () => {
    beforeEach(() => resetBufferUploadCensus());

    test("attributes surplus to the reason that caused it", () => {
        // One buffer locked twice at opposite ends: the span carries the gap between them.
        noteGuestBufferWrite("d3d9", 256);
        noteGuestBufferWrite("d3d9", 256);
        noteBufferUpload("d3d9", 65536, false);
        noteUploadReason("d3d9", 65536, "dirtySpan", 512);

        const rows = d3d9().byReason.rows;
        expect(rows.dirtySpan.count).toBe(1);
        expect(rows.dirtySpan.surplusBytes).toBe(65536 - 512);
        expect(rows.dirtySpan.amplification).toBe(128);
        expect(d3d9().byReason.verdict).toBe("complete");
    });

    test("a reason that never fired has no row, rather than a zero row", () => {
        noteBufferUpload("d3d9", 4096, true);
        noteUploadReason("d3d9", 4096, "wholeRingNew", 0);
        const rows = d3d9().byReason.rows;
        expect(rows.wholeRingNew).toBeDefined();
        // A printed "dirtySpan: 0 / 0 / amplification null" reads as "measured, and it is fine".
        expect(rows.dirtySpan).toBeUndefined();
    });

    test("an upload path with no reason attached is reported, not absorbed", () => {
        noteBufferUpload("d3d9", 1_000_000, false);   // some path reached writeBuffer...
        noteUploadReason("d3d9", 400_000, "dirtySpan", 400_000);  // ...only part of it is modelled
        const br = d3d9().byReason;
        expect(br.accountedPct).toBeCloseTo(40, 1);
        expect(br.verdict).toContain("INCOMPLETE");
        expect(br.verdict).toContain("no reason attached");
    });

    test("coverage wider than the upload cannot manufacture negative surplus", () => {
        // The guest locked a range we then clipped to the buffer: clamping keeps the surplus
        // of this row at zero instead of subtracting from another row's real surplus.
        noteBufferUpload("d3d9", 1024, false);
        noteUploadReason("d3d9", 1024, "dirtySpan", 4096);
        const row = d3d9().byReason.rows.dirtySpan;
        expect(row.surplusBytes).toBe(0);
        expect(row.amplification).toBe(1);
    });

    test("alignUploadRange widens to 4 and never past the buffer", () => {
        expect(alignUploadRange(5, 7, 64)).toEqual({ offset: 4, length: 4 });
        expect(alignUploadRange(0, 100, 64)).toEqual({ offset: 0, length: 64 });
        expect(alignUploadRange(8, 8, 64)).toEqual({ offset: 0, length: 0 });
    });
});
