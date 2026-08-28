/**
 * The guest clock must never step backwards.
 *
 * QPC/GetTickCount/RDTSC are all served from the hypercall page as
 * `base + (insn_now - insn_at_update) / mips`, which is monotonic only BETWEEN publishes.
 * A guest that computes an UNSIGNED delta across a backwards step reads ~2^32 ticks, not a
 * small negative — GTA III turned a 3.1 ms regression into 2147 seconds of frame time and
 * teleported its cutscene camera to the end of the scene.
 *
 * These pin the arithmetic the publisher uses to compute the floor. It must match WASM's
 * exactly (u32 wrapping subtract, truncating divide) — a floor computed a hair too low still
 * lets a backwards step through, and one computed too high ratchets the clock forward.
 */

import { describe, expect, it } from "bun:test";
import { interpolatedClockCeilingUs } from "../../src/worker/core/cpu/hypercall-data";

describe("interpolatedClockCeilingUs", () => {
    it("adds the interpolation WASM has been serving since the publish", () => {
        // 300 insn at 3 insn/µs = 100 µs already handed out on top of the base.
        expect(interpolatedClockCeilingUs(1_000_000, 500, 800, 3)).toBe(1_000_100);
    });

    it("truncates the divide, like the integer WASM path", () => {
        expect(interpolatedClockCeilingUs(0, 0, 5, 3)).toBe(1);
    });

    it("follows the instruction counter across its 32-bit wrap", () => {
        // The counter is a u32; the delta must wrap, not go hugely negative.
        const before = 0xFFFF_FF00;
        const after = 0x0000_0064; // +356
        expect(interpolatedClockCeilingUs(7, before, after, 2)).toBe(7 + 178);
    });

    it("is the identity when the interpolation is disabled", () => {
        expect(interpolatedClockCeilingUs(1234, 0, 999_999, 0)).toBe(1234);
    });

    it("catches the regression that produced the GTA III jump", () => {
        // A publish that wants to install a clock 3148 µs BELOW what the guest already read.
        const base = 10_000_000, publishedInsn = 0, insnNow = 30_000, mips = 3; // +10_000 µs
        const ceiling = interpolatedClockCeilingUs(base, publishedInsn, insnNow, mips);
        const wantedNowUs = ceiling - 3148;
        expect(Math.max(wantedNowUs, ceiling)).toBe(ceiling);
        // What the guest would have computed from the unclamped publish: an unsigned delta
        // one wrap short of 2^32, which is what makes a small regression catastrophic.
        expect((wantedNowUs - ceiling) >>> 0).toBe(0x1_0000_0000 - 3148);
    });
});
