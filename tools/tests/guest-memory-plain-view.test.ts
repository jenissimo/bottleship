/**
 * Guest memory reaches leaf hot loops as a REAL typed array, not v86's Proxy.
 *
 * v86's fork hands out `cpu.mem8` wrapped in a Proxy so that a WASM memory growth
 * (which detaches `memory.buffer`) is transparent. ThunkDispatcher must keep passing
 * that Proxy — it writes the guest stack after a thunk may have re-entered the guest —
 * so every leaf loop that indexes guest memory per element has to unwrap it itself.
 * Through the Proxy each `mem[i]` is a trap V8 cannot JIT; measured on the gdi32 DIB
 * path, a 640x480x24bpp blit read 921,600 bytes in ~300ms instead of ~2ms, which pinned
 * Blade of Darkness's menu at 3.5 FPS.
 */
import { describe, expect, it } from "bun:test";
import { toPlainGuestMemory } from "../../src/worker/core/memory/guest-memory";

/** Stand-in for vendor/v86/src/lib.js `view()`: element access goes through a trap. */
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

describe("toPlainGuestMemory", () => {
    it("turns v86's Proxy into a real typed array over the same bytes", () => {
        const backing = new Uint8Array(4096);
        for (let i = 0; i < backing.length; i++) backing[i] = i & 0xff;
        const proxied = v86StyleProxy(backing);

        // The Proxy is what makes the leaf loops slow: it is not even a view.
        expect(ArrayBuffer.isView(proxied)).toBe(false);

        const plain = toPlainGuestMemory(proxied);
        expect(ArrayBuffer.isView(plain)).toBe(true);
        expect(plain.constructor).toBe(Uint8Array);
        // Same window over the SAME buffer — an unwrap, never a copy.
        expect(plain.buffer).toBe(backing.buffer);
        expect(plain.byteOffset).toBe(backing.byteOffset);
        expect(plain.length).toBe(backing.length);
        for (const i of [0, 1, 255, 256, 4095]) expect(plain[i]).toBe(backing[i]);
    });

    it("writes through to the same memory the guest sees", () => {
        const backing = new Uint8Array(64);
        const plain = toPlainGuestMemory(v86StyleProxy(backing));
        plain[7] = 0xab;
        expect(backing[7]).toBe(0xab);
    });

    it("re-derives after a WASM growth swaps the buffer", () => {
        const first = new Uint8Array(1024);
        const a = toPlainGuestMemory(v86StyleProxy(first));
        expect(a.buffer).toBe(first.buffer);

        // Growth detaches the old buffer and installs a fresh one; the cache is keyed
        // on buffer identity, so the next borrow must follow it rather than hand back
        // a view onto memory the guest no longer uses.
        const grown = new Uint8Array(2048);
        const b = toPlainGuestMemory(v86StyleProxy(grown));
        expect(b.buffer).toBe(grown.buffer);
        expect(b.length).toBe(2048);
    });

    it("passes an already-plain view straight through", () => {
        const plain = new Uint8Array(32);
        expect(toPlainGuestMemory(plain)).toBe(plain);
    });

    it("tolerates null/undefined so callers need no guard", () => {
        expect(toPlainGuestMemory(null)).toBe(null);
        expect(toPlainGuestMemory(undefined)).toBe(undefined);
    });
});
