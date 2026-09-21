/**
 * CreateThread stack sizing.
 *
 * `dwStackSize` is the initial COMMIT; the RESERVE comes from the image's
 * SizeOfStackReserve unless the caller passes STACK_SIZE_PARAM_IS_A_RESERVATION.
 * Reading it as the reserve gives a thread an order of magnitude less stack than it has
 * on Windows, and the overflow lands in whatever the allocator placed underneath.
 */
import { describe, expect, test } from "bun:test";
import {
    threadStackReserve, STACK_SIZE_PARAM_IS_A_RESERVATION, CREATE_SUSPENDED,
    STACK_ALLOCATION_GRANULARITY,
} from "../../src/worker/core/scheduler/types";

const MB = 1024 * 1024;
const DEFAULT = 1 * MB;

describe("threadStackReserve", () => {
    test("a small dwStackSize does NOT shrink the stack below the image reserve", () => {
        expect(threadStackReserve(128 * 1024, 0, 1 * MB, DEFAULT)).toBe(1 * MB);
        expect(threadStackReserve(16 * 1024, 0, 1 * MB, DEFAULT)).toBe(1 * MB);
    });

    test("a dwStackSize LARGER than the reserve still wins — the commit cannot exceed it", () => {
        expect(threadStackReserve(4 * MB, 0, 1 * MB, DEFAULT)).toBe(4 * MB);
    });

    test("STACK_SIZE_PARAM_IS_A_RESERVATION makes dwStackSize the reserve verbatim", () => {
        expect(threadStackReserve(128 * 1024, STACK_SIZE_PARAM_IS_A_RESERVATION, 1 * MB, DEFAULT))
            .toBe(128 * 1024);
        // Combined with other creation flags, the reservation bit still decides.
        expect(threadStackReserve(64 * 1024, STACK_SIZE_PARAM_IS_A_RESERVATION | CREATE_SUSPENDED, 8 * MB, DEFAULT))
            .toBe(64 * 1024);
    });

    test("dwStackSize 0 means 'the image's reserve', with or without the flag", () => {
        expect(threadStackReserve(0, 0, 2 * MB, DEFAULT)).toBe(2 * MB);
        expect(threadStackReserve(0, STACK_SIZE_PARAM_IS_A_RESERVATION, 2 * MB, DEFAULT)).toBe(2 * MB);
    });

    test("no image reserve yet (pre-load threads) falls back to the default, never to 0", () => {
        expect(threadStackReserve(0, 0, 0, DEFAULT)).toBe(DEFAULT);
        expect(threadStackReserve(32 * 1024, 0, 0, DEFAULT)).toBe(DEFAULT);
    });

    test("a sub-granularity image reserve rounds UP, it does not become the stack size", () => {
        // A header may name less than a page; shipped images really do (8 KB is a value
        // in the wild). Windows rounds a reservation up to the allocation granularity,
        // so 64 KB is the floor a thread can be given — not the literal header value.
        expect(threadStackReserve(0, 0, 8 * 1024, DEFAULT)).toBe(STACK_ALLOCATION_GRANULARITY);
        expect(threadStackReserve(0, 0, 1, DEFAULT)).toBe(STACK_ALLOCATION_GRANULARITY);
    });

    test("an explicit reservation is rounded up the same way", () => {
        expect(threadStackReserve(8 * 1024, STACK_SIZE_PARAM_IS_A_RESERVATION, 1 * MB, DEFAULT))
            .toBe(STACK_ALLOCATION_GRANULARITY);
        expect(threadStackReserve(100 * 1024, STACK_SIZE_PARAM_IS_A_RESERVATION, 1 * MB, DEFAULT))
            .toBe(128 * 1024);
    });

    test("every result is granularity-aligned, so a stack never starts mid-block", () => {
        for (const image of [0, 1, 8 * 1024, 64 * 1024, 1 * MB, 8 * MB]) {
            for (const asked of [0, 1, 4096, 100 * 1024, 4 * MB]) {
                for (const flags of [0, STACK_SIZE_PARAM_IS_A_RESERVATION]) {
                    const got = threadStackReserve(asked, flags, image, DEFAULT);
                    expect(got % STACK_ALLOCATION_GRANULARITY).toBe(0);
                    expect(got).toBeGreaterThanOrEqual(STACK_ALLOCATION_GRANULARITY);
                }
            }
        }
    });
});
