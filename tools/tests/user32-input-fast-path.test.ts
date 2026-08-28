/**
 * The polled key readers answer identically on both tiers.
 *
 * GetKeyState / GetAsyncKeyState / GetKeyboardState are the largest counts in the
 * slow-path thunk census, so each has a fast path. A fast path that disagrees with its
 * thunk is a silent behaviour change, so every case below runs both tiers over the SAME
 * seeded input state and compares — including the guest-observability bookkeeping
 * (guestPolledKeys / guestInputFlags) that other code reads back.
 *
 * The consuming reads (GetAsyncKeyState's pressed-since edge) are re-seeded per tier;
 * comparing them without that would only prove that the second read consumed nothing.
 */

import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    GUEST_INPUT_FLAG,
    GUEST_POLLED_KEYS_BASE,
    INPUT_BUFFER_SIZE,
    INPUT_INDEX,
} from "../../src/input/sab-layout";
import { createInputExports, registerFastPathInputFunctions } from "../../src/worker/modules/user32/input";

const VK_A = 0x41;
const VK_CAPITAL = 0x14;

const MEM_SIZE = 0x20000;
const ESP = 0x1000;
const BUF = 0x2000;

const mem = new Uint8Array(MEM_SIZE);
const mem32 = new Uint32Array(mem.buffer);
const view = new DataView(mem.buffer);
const cpu = { reg32: new Uint32Array(8) };
Mem.bind(() => mem);

const exports = createInputExports();

const fastPaths = new Map<string, { impl: Function; trivial?: boolean }>();
registerFastPathInputFunctions({
    registerFastPath: (_dll: string, fn: string, impl: Function, opts?: { trivial?: boolean }) => {
        fastPaths.set(fn, { impl, trivial: opts?.trivial });
    },
});

function callSlow(name: string, args: number[]): number {
    return exports[name]({} as any, mem, args) as number;
}

function callFast(name: string, args: number[]): number | null {
    cpu.reg32[4] = ESP;
    for (let i = 0; i < args.length; i++) view.setUint32(ESP + 4 + 4 * i, args[i] >>> 0, true);
    return fastPaths.get(name)!.impl(cpu, mem, mem32, view) as number | null;
}

/** Fresh SAB + a cleared manager, then the case's own key events. */
function seed(mutate: () => void): void {
    const im = System.getInstance().inputManager;
    im.setInputBuffer(new SharedArrayBuffer(INPUT_BUFFER_SIZE));
    im.reset();
    mutate();
}

/** The guest-observability slots the readers OR into, for a per-tier comparison. */
function bookkeeping(): { flags: number; polled: number[] } {
    const v = (System.getInstance().inputManager as any).inputView as Int32Array;
    return {
        flags: v[INPUT_INDEX.guestInputFlags],
        polled: Array.from(v.subarray(GUEST_POLLED_KEYS_BASE, GUEST_POLLED_KEYS_BASE + 8)),
    };
}

const cases: Array<{ name: string; vk: number; setup: () => void }> = [
    { name: "key up", vk: VK_A, setup: () => { } },
    {
        name: "key down",
        vk: VK_A,
        setup: () => { System.getInstance().inputManager.injectKey(VK_A, true); },
    },
    {
        name: "toggled key",
        vk: VK_CAPITAL,
        setup: () => { System.getInstance().inputManager.injectKeyTap(VK_CAPITAL); },
    },
    {
        name: "released key (pressed-since edge only)",
        vk: VK_A,
        setup: () => { System.getInstance().inputManager.injectKeyTap(VK_A); },
    },
    { name: "invalid VK (above 0xff)", vk: 0x1ff, setup: () => { } },
    { name: "invalid VK (negative)", vk: -1, setup: () => { } },
];

describe("user32 polled key readers: fast path == thunk", () => {
    for (const c of cases) {
        test(`GetKeyState — ${c.name}`, () => {
            seed(c.setup);
            const slow = callSlow("GetKeyState", [c.vk]);
            const slowBooks = bookkeeping();

            seed(c.setup);
            const fast = callFast("GetKeyState", [c.vk]);
            expect(fast).toBe(slow);
            expect(bookkeeping()).toEqual(slowBooks);
        });

        test(`GetAsyncKeyState — ${c.name}`, () => {
            seed(c.setup);
            const slow = callSlow("GetAsyncKeyState", [c.vk]);
            const slowBooks = bookkeeping();

            seed(c.setup);
            const fast = callFast("GetAsyncKeyState", [c.vk]);
            expect(fast).toBe(slow);
            expect(bookkeeping()).toEqual(slowBooks);
        });

        test(`GetKeyboardState — ${c.name}`, () => {
            seed(c.setup);
            mem.fill(0, BUF, BUF + 256);
            const slow = callSlow("GetKeyboardState", [BUF]);
            const slowBytes = Array.from(mem.subarray(BUF, BUF + 256));
            const slowBooks = bookkeeping();

            seed(c.setup);
            mem.fill(0, BUF, BUF + 256);
            const fast = callFast("GetKeyboardState", [BUF]);
            expect(fast).toBe(slow);
            expect(Array.from(mem.subarray(BUF, BUF + 256))).toEqual(slowBytes);
            expect(bookkeeping()).toEqual(slowBooks);
        });
    }

    test("a held key reads down on both tiers, and lights its guestPolledKeys bit", () => {
        seed(() => { System.getInstance().inputManager.injectKey(VK_A, true); });
        expect(callSlow("GetKeyState", [VK_A]) & 0x8000).toBe(0x8000);
        expect(bookkeeping().polled[VK_A >> 5] & (1 << (VK_A & 31))).not.toBe(0);

        seed(() => { System.getInstance().inputManager.injectKey(VK_A, true); });
        expect(callFast("GetKeyState", [VK_A])! & 0x8000).toBe(0x8000);
        expect(bookkeeping().polled[VK_A >> 5] & (1 << (VK_A & 31))).not.toBe(0);
    });

    test("GetKeyboardState writes 256 bytes, returns TRUE, and flags the bulk read", () => {
        seed(() => { System.getInstance().inputManager.injectKey(VK_A, true); });
        mem.fill(0xcc, BUF, BUF + 257);
        expect(callFast("GetKeyboardState", [BUF])).toBe(1);
        expect(mem[BUF + VK_A]).toBe(0x80);
        expect(mem[BUF + 256]).toBe(0xcc); // nothing written past the 256-byte table
        expect(bookkeeping().flags & GUEST_INPUT_FLAG.bulkKeyboard).toBe(GUEST_INPUT_FLAG.bulkKeyboard);
    });

    test("GetKeyboardState(NULL) answers FALSE on both tiers, with no bookkeeping", () => {
        seed(() => { });
        expect(callSlow("GetKeyboardState", [0])).toBe(0);
        const slowBooks = bookkeeping();
        seed(() => { });
        expect(callFast("GetKeyboardState", [0])).toBe(0);
        expect(bookkeeping()).toEqual(slowBooks);
    });

    test("GetKeyboardState declines a buffer whose 256-byte extent runs off guest RAM", () => {
        seed(() => { });
        const before = bookkeeping();
        // Last byte in range, so a bounds test on the POINTER alone would let it through.
        expect(callFast("GetKeyboardState", [MEM_SIZE - 1])).toBe(null);
        // Declining must precede every side effect: the slow path re-does the whole call.
        expect(bookkeeping()).toEqual(before);
    });

    test("all three readers decline rather than read a stack pointer off the end of RAM", () => {
        seed(() => { });
        cpu.reg32[4] = MEM_SIZE - 4;
        for (const name of ["GetKeyState", "GetAsyncKeyState", "GetKeyboardState"]) {
            expect(fastPaths.get(name)!.impl(cpu, mem, mem32, view)).toBe(null);
        }
    });

    test("every polled reader is registered, and registered as trivial", () => {
        for (const name of ["GetKeyState", "GetAsyncKeyState", "GetKeyboardState"]) {
            expect(fastPaths.get(name)?.trivial).toBe(true);
        }
    });
});
