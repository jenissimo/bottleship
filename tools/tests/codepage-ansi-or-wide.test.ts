/**
 * readAnsiOrWideFromGuest — width inference for the message paths that lost it
 * (EM_REPLACESEL, WM_SETTEXT arrive through both A and W entry points).
 *
 * The invariant under test is not "guesses right most of the time", it is that the guess
 * never DRAWS ON BYTES PAST THE ANSI TERMINATOR. A one-character insert (`"5"`) is the
 * common case for a typed keystroke, and probing past its NUL turns whatever the heap holds
 * next into appended text.
 */

import { describe, expect, test } from "bun:test";
import { readAnsiOrWideFromGuest } from "../../src/worker/modules/codepage-utils";

const AT = 0x100;

/** Guest memory with `bytes` at AT and `fill` everywhere else (the "heap"). */
function mem(bytes: number[], fill = 0xcc): Uint8Array {
    const m = new Uint8Array(0x400).fill(fill);
    m.set(bytes, AT);
    return m;
}

const ansi = (s: string, trailing: number[] = []): number[] =>
    [...[...s].map(c => c.charCodeAt(0)), 0, ...trailing];

const wide = (s: string): number[] => {
    const out: number[] = [];
    for (const c of s) { out.push(c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8); }
    out.push(0, 0);
    return out;
};

describe("readAnsiOrWideFromGuest", () => {
    test("a 1-char ANSI string does not absorb the heap that follows it", () => {
        // The reported shape: "5\0" then heap. Ordinary heap (0xcc / zeros) must not extend it.
        expect(readAnsiOrWideFromGuest(mem(ansi("5")), AT)).toBe("5");
        expect(readAnsiOrWideFromGuest(mem(ansi("A"), 0x00), AT)).toBe("A");
        // Non-text heap bytes are rejected as wide units.
        expect(readAnsiOrWideFromGuest(mem(ansi("5", [0x01, 0x00, 0x00, 0x00])), AT)).toBe("5");
        // A run that never reaches a 16-bit NUL is heap, not a string.
        expect(readAnsiOrWideFromGuest(mem(ansi("5", [0x41, 0x00, 0x42, 0x00]), 0x41), AT)).toBe("5");
    });

    test("the irreducible ambiguity is documented, not papered over", () => {
        // "5\0A\0\0\0" and L"5A" are THE SAME BYTES. No inspection separates them, which is
        // why the hint exists — a caller that knows must say so.
        const bytes = ansi("5", [0x41, 0x00, 0x00, 0x00]);
        expect(readAnsiOrWideFromGuest(mem(bytes), AT)).toBe("5A");
        expect(readAnsiOrWideFromGuest(mem(bytes), AT, "ansi")).toBe("5");
        expect(readAnsiOrWideFromGuest(mem(bytes), AT, "wide")).toBe("5A");
    });

    test("the hint overrides the heuristic in both directions", () => {
        expect(readAnsiOrWideFromGuest(mem(wide("hello")), AT, "ansi")).toBe("h");
        expect(readAnsiOrWideFromGuest(mem(ansi("hello"), 0x00), AT, "wide")).toBe("敨汬o");
    });

    test("multi-character ANSI stays ANSI", () => {
        expect(readAnsiOrWideFromGuest(mem(ansi("hello")), AT)).toBe("hello");
        expect(readAnsiOrWideFromGuest(mem(ansi("Player 1")), AT)).toBe("Player 1");
        // Two non-zero bytes in a row rule out an ASCII-range wide string outright.
        expect(readAnsiOrWideFromGuest(mem(ansi("ab", [0x00, 0x00])), AT)).toBe("ab");
    });

    test("a real wide string is still decoded as wide", () => {
        expect(readAnsiOrWideFromGuest(mem(wide("hello")), AT)).toBe("hello");
        expect(readAnsiOrWideFromGuest(mem(wide("OK")), AT)).toBe("OK");
    });

    test("a 1-char wide string reads the same either way, so ANSI is a correct answer", () => {
        expect(readAnsiOrWideFromGuest(mem(wide("5")), AT)).toBe("5");
    });

    test("empty and null inputs yield an empty string, never heap", () => {
        expect(readAnsiOrWideFromGuest(mem([0]), AT)).toBe("");
        expect(readAnsiOrWideFromGuest(mem([0, 0]), AT)).toBe("");
        expect(readAnsiOrWideFromGuest(mem(ansi("x")), 0)).toBe("");
    });

    test("an unterminated wide-looking run is not believed", () => {
        // 1-char ANSI followed by plausible pairs that never reach a 16-bit NUL inside the
        // window: heap, not a string.
        const run: number[] = [0x35, 0x00];
        for (let i = 0; i < 32; i++) run.push(0x41, 0x00);
        expect(readAnsiOrWideFromGuest(mem(run), AT)).toBe("5");
    });
});
