/**
 * Kernel handle values come back round once their handle is closed, as on NT. The range
 * 0x30000-0x3FFFF holds 16384 open handles; a title that opens and closes one per frame
 * used to walk the cursor past its end, after which every new handle landed in the USER
 * range and no lookup found it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";

const rp = SystemResourceProvider.getInstance();
const inKernelRange = (h: number) => h >= 0x30000 && h < 0x40000 && (h & 3) === 0;

describe("kernel handle values", () => {
    beforeEach(() => rp.cleanup());
    afterEach(() => rp.cleanup());

    test("open/close far past the range stays inside it, and each handle resolves to its object", () => {
        const open = rp.registerKernelObject({ kind: "event", id: "kept" });
        for (let i = 0; i < 40000; i++) {
            const obj = { kind: "event", id: i };
            const h = rp.registerKernelObject(obj);
            expect(inKernelRange(h)).toBe(true);
            expect(h).not.toBe(open);
            expect(rp.getKernelObject(h)).toBe(obj);
            rp.unregisterKernelObject(h);
        }
        expect((rp.getKernelObject(open) as { id: string }).id).toBe("kept");
    });

    test("an open handle's value is never handed out again; a full table refuses with 0", () => {
        const held = new Set<number>();
        for (let i = 0; i < 16384; i++) {
            const h = rp.registerKernelObject({ kind: "event", id: i });
            expect(inKernelRange(h)).toBe(true);
            expect(held.has(h)).toBe(false);
            held.add(h);
        }
        expect(rp.registerKernelObject({ kind: "event" })).toBe(0);
        const freed = [...held][1234]!;
        rp.unregisterKernelObject(freed);
        expect(rp.registerKernelObject({ kind: "event", id: "again" })).toBe(freed);
    });
});
