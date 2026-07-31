/**
 * SystemResourceProvider handle identity.
 *
 * Two properties, both of which used to fail silently rather than loudly:
 *   - a COM object's PRIMARY address (the pointer it was born as) survives QueryInterface
 *     tear-offs remapping the same handle. Per-interface refcounting credits the birth
 *     reference to that pointer, so if a tear-off can become "the" address, the original
 *     pointer's Release finds no reference, the object never reaches zero, and destroy()'s
 *     surface/device cascade never runs.
 *   - a recycled USER handle is generation-tagged, so a stale HBITMAP resolves to NOTHING
 *     rather than to whatever unrelated icon/cursor/window took the slot.
 */

import { beforeEach, describe, expect, test } from "bun:test";
// System first: the resource provider pulls in the ddraw constants, whose module graph has a
// initialisation-order cycle that only resolves when core/system is evaluated first.
import "../../src/worker/core/system";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";

const rp = () => SystemResourceProvider.getInstance();

beforeEach(() => {
    rp().cleanup();
});

describe("COM primary address", () => {
    test("a tear-off remap does not become the object's own pointer", () => {
        const handle = 0x1234;
        rp().mapAddressToHandle(0xA000, handle);   // birth address
        rp().mapAddressToHandle(0xB000, handle);   // QueryInterface tear-off
        rp().mapAddressToHandle(0xC000, handle);   // another generation's tear-off

        expect(rp().getPrimaryAddressForHandle(handle)).toBe(0xA000);
        // The plain lookup still answers "most recently mapped" — that is what the tear-off
        // table wants, and exactly why it must not be used for identity.
        expect(rp().getAddressForHandle(handle)).toBe(0xC000);
    });

    test("an unmapped handle has no primary address", () => {
        expect(rp().getPrimaryAddressForHandle(0x9999)).toBeNull();
    });
});

describe("USER handle recycling", () => {
    test("a recycled slot yields a DIFFERENT handle, and the stale one resolves to nothing", () => {
        const first = rp().registerUserObject({ type: "bitmap", tag: "a" });
        expect(rp().getUserObject(first)?.tag).toBe("a");

        rp().unregisterUserObject(first);
        expect(rp().getUserObject(first)).toBeFalsy();

        const second = rp().registerUserObject({ type: "icon", tag: "b" });
        // Same slot, different handle — that difference IS the protection.
        expect(second & ~0x3).toBe(first & ~0x3);
        expect(second).not.toBe(first);
        expect(rp().getUserObject(second)?.tag).toBe("b");
        // The stale handle must NOT name the new object.
        expect(rp().getUserObject(first)).toBeFalsy();
    });

    test("tagged handles stay inside the USER range, so getResource still dispatches them", () => {
        const handles: number[] = [];
        for (let i = 0; i < 8; i++) handles.push(rp().registerUserObject({ type: "bitmap" }));
        // Recycle the same slot repeatedly and confirm every generation stays addressable.
        for (let round = 0; round < 6; round++) {
            const h = handles.pop()!;
            rp().unregisterUserObject(h);
            const next = rp().registerUserObject({ type: "cursor", round });
            expect(next).toBeGreaterThanOrEqual(0x40000);
            expect(next).toBeLessThan(0x50000);
            const res = rp().getResource(next);
            expect(res?.type).toBe("user_object");
            expect(res?.resource.round).toBe(round);
            handles.push(next);
        }
    });

    test("the generation wraps rather than escaping the range", () => {
        let h = rp().registerUserObject({ type: "bitmap", n: 0 });
        const slot = h & ~0x3;
        const seen = new Set<number>();
        for (let i = 0; i < 12; i++) {
            seen.add(h);
            rp().unregisterUserObject(h);
            h = rp().registerUserObject({ type: "bitmap", n: i + 1 });
            expect(h & ~0x3).toBe(slot); // FIFO of one slot keeps returning it
        }
        // 2 generation bits: four distinct handles for one slot, and never more.
        expect(seen.size).toBe(4);
    });
});
