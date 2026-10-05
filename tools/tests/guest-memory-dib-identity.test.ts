/**
 * Unwrapping guest memory must be a SPEED change and nothing else.
 *
 * The gdi32 DIBSection readers index guest memory per pixel, so they take a plain view
 * (toPlainGuestMemory) instead of v86's Proxy. That is only safe if both forms decode
 * byte-identical pixels — a faster blit that reads different bytes is a regression, and
 * pixel paths hide that well. So this drives the REAL readers (not a copy of their loops)
 * over the same bytes twice, once through a v86-style Proxy and once through a plain view,
 * and requires the outputs to match exactly, at every bit depth the readers support.
 *
 * `setGuestMemoryBorrowBypass` is what makes the Proxy arm reachable: it is the same
 * switch the perf A/B uses, so this test also pins that the switch changes nothing but cost.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { setGuestMemoryBorrowBypass } from "../../src/worker/core/memory/guest-memory";
import { resolveDibSectionRectRgba, resolveDib32RawAlphaRgba } from "../../src/worker/modules/gdi32/bitmap-resolve";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";

/** Stand-in for vendor/v86/src/lib.js `view()`: every element access goes through a trap. */
function v86StyleProxy(view: Uint8Array): Uint8Array {
    return new Proxy(view, {
        get(target, prop) {
            const x = Reflect.get(target, prop);
            return typeof x === "function" ? x.bind(target) : x;
        },
        set(target, prop, value) {
            (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
            return true;
        },
    }) as unknown as Uint8Array;
}

const BITS_PTR = 0x1000;
const W = 23;   // deliberately not a multiple of 4 — exercises the stride padding
const H = 9;

/** Guest RAM holding one DIBSection's bits, filled with a non-repeating pattern. */
function makeGuestMem(stride: number): Uint8Array {
    const mem = new Uint8Array(BITS_PTR + stride * H + 64);
    for (let i = BITS_PTR; i < mem.length; i++) {
        // Mix the index so no two bytes in a pixel are equal — a swapped channel shows up.
        mem[i] = (i * 37 + (i >> 5) * 11) & 0xff;
    }
    return mem;
}

function registerDib(bpp: number, stride: number, topDown: boolean, palette?: Uint32Array): number {
    return SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP",
        width: W,
        height: H,
        bitsPtr: BITS_PTR,
        dibStride: stride,
        dibBpp: bpp,
        dibTopDown: topDown,
        dibPalette: palette,
    });
}

/** Run `fn` with borrows bypassed, i.e. reading through the raw Proxy. */
function throughProxy<T>(fn: () => T): T {
    setGuestMemoryBorrowBypass(true);
    try {
        return fn();
    } finally {
        setGuestMemoryBorrowBypass(false);
    }
}

afterEach(() => setGuestMemoryBorrowBypass(false));

describe("DIBSection readers decode identically through the Proxy and a plain view", () => {
    const palette = new Uint32Array(256);
    for (let i = 0; i < 256; i++) palette[i] = (0xff << 24) | (i << 16) | ((255 - i) << 8) | (i * 7) & 0xff;

    const cases: Array<[string, number, number, Uint32Array | undefined]> = [
        ["32bpp", 32, W * 4, undefined],
        ["24bpp", 24, ((W * 3) + 3) & ~3, undefined],
        ["16bpp", 16, ((W * 2) + 3) & ~3, undefined],
        ["8bpp palettised", 8, (W + 3) & ~3, palette],
    ];

    for (const [label, bpp, stride, pal] of cases) {
        for (const topDown of [true, false]) {
            it(`${label}, ${topDown ? "top-down" : "bottom-up"} — full rect`, () => {
                const backing = makeGuestMem(stride);
                const handle = registerDib(bpp, stride, topDown, pal);

                const plain = resolveDibSectionRectRgba(handle, backing, 0, 0, W, H);
                const proxy = throughProxy(() =>
                    resolveDibSectionRectRgba(handle, v86StyleProxy(backing), 0, 0, W, H),
                );

                expect(plain).not.toBeNull();
                expect(proxy).not.toBeNull();
                expect(proxy!.width).toBe(plain!.width);
                expect(proxy!.height).toBe(plain!.height);
                // Byte-for-byte, not "looks the same".
                expect(Array.from(proxy!.data)).toEqual(Array.from(plain!.data));
                // And the decode actually produced varied pixels, so equality is not
                // two identically-empty buffers agreeing.
                expect(new Set(plain!.data).size).toBeGreaterThan(4);
            });
        }
    }

    it("sub-rect reads (the per-blit path) agree byte-for-byte", () => {
        const stride = W * 4;
        const backing = makeGuestMem(stride);
        const handle = registerDib(32, stride, false);

        const plain = resolveDibSectionRectRgba(handle, backing, 3, 2, 11, 5);
        const proxy = throughProxy(() =>
            resolveDibSectionRectRgba(handle, v86StyleProxy(backing), 3, 2, 11, 5),
        );
        expect(Array.from(proxy!.data)).toEqual(Array.from(plain!.data));
        expect(plain!.width).toBe(11);
        expect(plain!.height).toBe(5);
    });

    it("the raw-alpha cursor probe agrees byte-for-byte", () => {
        const stride = W * 4;
        const backing = makeGuestMem(stride);
        const handle = registerDib(32, stride, true);

        const plain = resolveDib32RawAlphaRgba(handle, backing);
        const proxy = throughProxy(() => resolveDib32RawAlphaRgba(handle, v86StyleProxy(backing)));
        expect(plain).not.toBeNull();
        expect(Array.from(proxy!.data)).toEqual(Array.from(plain!.data));
    });

    it("writes made through a plain view are visible to the guest's own Proxy", () => {
        // The write direction of the same contract (GetDIBits / writeBackDib32 store
        // through the unwrapped view): the guest must see those stores.
        const backing = new Uint8Array(32);
        const proxied = v86StyleProxy(backing);
        const plain = new Uint8Array(backing.buffer, backing.byteOffset, backing.length);
        plain[9] = 0xc3;
        expect(proxied[9]).toBe(0xc3);
    });
});
