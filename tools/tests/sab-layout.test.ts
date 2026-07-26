// The input SAB slot map is a wire format shared by the host and the worker.
// These assertions are the guard rails a future slot addition has to clear.

import { describe, expect, test } from "bun:test";
import {
    GUEST_POLLED_KEYS_BASE,
    GUEST_POLLED_KEYS_COUNT,
    INPUT_BUFFER_SIZE,
    INPUT_INDEX,
    KEY_BITFIELD_BASE,
    KEY_BITFIELD_COUNT,
    beginInputWrite,
    endInputWrite,
} from "../../src/input/sab-layout";

const SLOTS = INPUT_BUFFER_SIZE / 4;

describe("input SAB layout", () => {
    test("every named slot is distinct", () => {
        const ids = Object.values(INPUT_INDEX);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test("every slot fits the buffer", () => {
        for (const [name, id] of Object.entries(INPUT_INDEX)) {
            expect(`${name}:${id >= 0 && id < SLOTS}`).toBe(`${name}:true`);
        }
    });

    test("the key bitfield does not collide with the named slots after it", () => {
        const bitfield = new Set<number>();
        for (let i = 0; i < KEY_BITFIELD_COUNT; i++) bitfield.add(KEY_BITFIELD_BASE + i);
        for (const [name, id] of Object.entries(INPUT_INDEX)) {
            expect(`${name}:${bitfield.has(id)}`).toBe(`${name}:false`);
        }
        expect(KEY_BITFIELD_BASE + KEY_BITFIELD_COUNT).toBeLessThanOrEqual(INPUT_INDEX.guestGamepadSeq);
    });

    test("the guest polled-key bitfield sits between guestGamepadSeq and guestInputSeq", () => {
        expect(GUEST_POLLED_KEYS_BASE).toBeGreaterThan(INPUT_INDEX.guestGamepadSeq);
        expect(GUEST_POLLED_KEYS_BASE + GUEST_POLLED_KEYS_COUNT).toBeLessThanOrEqual(INPUT_INDEX.guestInputSeq);
    });

    test("the bitfields together cover all 256 virtual keys", () => {
        expect(KEY_BITFIELD_COUNT * 32).toBe(256);
        expect(GUEST_POLLED_KEYS_COUNT * 32).toBe(256);
    });
});

describe("seqlock", () => {
    test("a bracket leaves seq even and advances it by exactly 2", () => {
        const view = new Int32Array(SLOTS);
        beginInputWrite(view);
        expect(view[INPUT_INDEX.seq] & 1).toBe(1); // odd: writer in progress
        endInputWrite(view);
        expect(view[INPUT_INDEX.seq]).toBe(2);
        expect(view[INPUT_INDEX.seq] & 1).toBe(0);
    });

    test("a reader that samples mid-bracket sees an odd seq", () => {
        const view = new Int32Array(SLOTS);
        beginInputWrite(view);
        view[INPUT_INDEX.mouseX] = 42;
        const midBracket = Atomics.load(view, INPUT_INDEX.seq);
        endInputWrite(view);
        expect(midBracket & 1).toBe(1);
    });
});
