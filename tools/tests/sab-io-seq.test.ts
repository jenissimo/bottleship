/**
 * Regression for F4: the SAB request/response protocol must have request↔response
 * IDENTITY.
 *
 * Without it, one WAIT_TIMEOUT desyncs the channel permanently: the guest abandons
 * request A, issues B, and consumes A's late answer as B's — the right LENGTH of bytes
 * from the wrong offset, and every later request is shifted by one. `SabIoSource: read
 * timed out` is an observed failure on the primary streaming path, so this is reachable.
 *
 * Both halves are asserted, because either alone is insufficient:
 *   - the I/O worker DROPS a completion for a superseded request (the DATA arena is one
 *     slot, so a late writer would corrupt the bytes the guest is copying out);
 *   - the guest only accepts a response carrying its OWN sequence.
 */
import { describe, expect, test } from "bun:test";
import {
    CTL_WORDS, CTL_STATE, CTL_RESP_LEN, CTL_RESP_SEQ,
    META_OFFSET_BYTES, META_WORDS, META_REQ_SEQ,
    DATA_OFFSET_BYTES, DATA_BYTES, SAB_TOTAL_BYTES,
    ST_REQ, ST_DONE,
    publishResponse,
} from "../../src/worker/runtime/filesystem/sab-io-protocol";

function makeSab() {
    // A plain ArrayBuffer is enough: Atomics work on any integer TypedArray, and no test
    // here parks on Atomics.wait (which would deadlock a single-threaded runner).
    const buf = new ArrayBuffer(DATA_OFFSET_BYTES + 4096);
    return {
        ctl: new Int32Array(buf, 0, CTL_WORDS),
        meta: new Float64Array(buf, META_OFFSET_BYTES, META_WORDS),
        data: new Uint8Array(buf, DATA_OFFSET_BYTES, 4096),
    };
}

/** The guest's acceptance rule, as SabIoSource.request applies it. */
function accepts(ctl: Int32Array, mySeq: number): boolean {
    return Atomics.load(ctl, CTL_RESP_SEQ) === mySeq;
}

describe("F4 — request/response identity", () => {
    test("the layout still fits: the sequence words are inside the reserved space", () => {
        expect(CTL_RESP_SEQ).toBeLessThan(CTL_WORDS);
        expect(META_REQ_SEQ).toBeLessThan(META_WORDS);
        expect(SAB_TOTAL_BYTES).toBe(DATA_OFFSET_BYTES + DATA_BYTES);
    });

    test("a completion for a superseded request is dropped, arena untouched", () => {
        const { ctl, data } = makeSab();

        // Request A is in flight; the guest times out and issues B.
        const seqA = 1;
        const seqB = 2;
        data.fill(0xbb, 0, 8); // pretend B's bytes are already in the slot
        Atomics.store(ctl, CTL_RESP_SEQ, seqB);
        Atomics.store(ctl, CTL_RESP_LEN, 8);

        // A now completes, late. It must not touch the arena.
        const published = publishResponse(ctl, data, seqA, seqB, new Uint8Array(8).fill(0xaa));

        expect(published).toBe(false);
        expect(Array.from(data.subarray(0, 8))).toEqual([0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb]);
        expect(Atomics.load(ctl, CTL_RESP_SEQ)).toBe(seqB);
    });

    test("the guest ignores a response that is not its own, and takes one that is", () => {
        const { ctl, data } = makeSab();
        const seqA = 7;
        const seqB = 8;

        // The guest is now waiting on B...
        Atomics.store(ctl, CTL_STATE, ST_REQ);
        // ...and A's late answer somehow reaches the slot (worker still on A).
        publishResponse(ctl, data, seqA, seqA, new Uint8Array(4).fill(0xaa));
        expect(accepts(ctl, seqB)).toBe(false); // must keep waiting, not consume A

        // B's real answer lands.
        publishResponse(ctl, data, seqB, seqB, new Uint8Array(2).fill(0xcc));
        expect(accepts(ctl, seqB)).toBe(true);
        expect(Atomics.load(ctl, CTL_STATE)).toBe(ST_DONE);
        expect(Atomics.load(ctl, CTL_RESP_LEN)).toBe(2);
        expect(Array.from(data.subarray(0, 2))).toEqual([0xcc, 0xcc]);
    });

    test("an error completion is also tagged, so it cannot be read as another request's error", () => {
        const { ctl, data } = makeSab();
        expect(publishResponse(ctl, data, 3, 4, null)).toBe(false);
        expect(publishResponse(ctl, data, 4, 4, null)).toBe(true);
        expect(Atomics.load(ctl, CTL_RESP_SEQ)).toBe(4);
    });
});
