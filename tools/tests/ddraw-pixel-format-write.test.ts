import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { writePixelFormat } from "../../src/worker/modules/ddraw/structs";

describe("writing a DDPIXELFORMAT validates the guest range once", () => {
    let spy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => { spy?.mockRestore(); spy = null; });

    test("all eight fields land with a single address check", () => {
        let checks = 0;
        spy = spyOn(System, "getInstance").mockReturnValue({
            process: { addressSpace: { validateRange: () => { checks++; return true; } } },
        } as any);
        const mem = new Uint8Array(0x1000);
        writePixelFormat(mem, 0x100, { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 } as any);
        const v = new DataView(mem.buffer);
        expect([0, 4, 8, 12, 16, 20, 24, 28].map((o) => v.getUint32(0x100 + o, true)))
            .toEqual([32, 0x40, 0, 16, 0xf800, 0x07e0, 0x001f, 0]);
        expect(checks).toBe(1);
    });

    test("a short struct keeps its fields untouched beyond its size", () => {
        spy = spyOn(System, "getInstance").mockReturnValue({
            process: { addressSpace: { validateRange: () => true } },
        } as any);
        const mem = new Uint8Array(0x1000).fill(0xee);
        writePixelFormat(mem, 0x100, { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 } as any, 12);
        const v = new DataView(mem.buffer);
        expect(v.getUint32(0x100 + 8, true)).toBe(0);
        expect(v.getUint32(0x100 + 12, true)).toBe(0xeeeeeeee);
    });
});
