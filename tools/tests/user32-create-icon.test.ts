import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { registerWindowDrawingExports } from "../../src/worker/modules/user32/window-drawing";
import { composeIconFromBits, ddbRowBytes } from "../../src/worker/modules/user32/icon-bits";

afterEach(() => { (System as unknown as { instance: unknown }).instance = undefined; });

function install() {
    const objects: Record<string, unknown>[] = [];
    let lastError = 0;
    (System as unknown as { instance: unknown }).instance = {
        resourceProvider: { registerUserObject: (o: Record<string, unknown>) => { objects.push(o); return 0x5000 + objects.length; } },
        scheduler: { setLastError: (e: number) => { lastError = e; } },
    };
    const exports: Record<string, (ctx: never, mem: Uint8Array, args: number[]) => unknown> = {};
    registerWindowDrawingExports(exports as never);
    return { exports, objects, lastError: () => lastError };
}

test("rows are WORD aligned", () => {
    expect(ddbRowBytes(32, 1)).toBe(4);
    expect(ddbRowBytes(3, 1)).toBe(2);
    expect(ddbRowBytes(3, 24)).toBe(10);
    expect(ddbRowBytes(5, 4)).toBe(4);
});

test("AND 1 with black XOR is transparent, AND 0 shows the XOR colour", () => {
    const and = new Uint8Array([0b0100_0000, 0]);
    const xor = new Uint8Array([0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0, 0]);
    const px = composeIconFromBits(and, xor, 2, 1, 32);
    expect([...px]).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
});

test("CreateIcon registers an icon built from monochrome bits", () => {
    const { exports, objects } = install();
    const mem = new Uint8Array(0x400);
    const AND = 0x100, XOR = 0x200;
    for (let y = 0; y < 32; y++) {
        mem[AND + y * 4] = 0x0f;
        mem[XOR + y * 4] = 0xf0;
    }
    const h = exports["CreateIcon"]!(null as never, mem, [0x400000, 32, 32, 1, 1, AND, XOR]);
    expect(h).toBe(0x5001);
    const icon = objects[0] as { type: string; width: number; height: number; pixels: Uint8Array };
    expect([icon.type, icon.width, icon.height]).toEqual(["ICON", 32, 32]);
    expect([...icon.pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(icon.pixels[4 * 4 + 3]).toBe(0);
    expect([...icon.pixels.subarray(8 * 4, 8 * 4 + 4)]).toEqual([0, 0, 0, 255]);
});

test("CreateIcon fails with ERROR_INVALID_PARAMETER for missing bits or a bad depth", () => {
    const { exports, objects, lastError } = install();
    const mem = new Uint8Array(0x400);
    expect(exports["CreateIcon"]!(null as never, mem, [0, 32, 32, 1, 1, 0, 0x200])).toBe(0);
    expect(lastError()).toBe(87);
    expect(exports["CreateIcon"]!(null as never, mem, [0, 32, 32, 1, 3, 0x100, 0x200])).toBe(0);
    expect(objects.length).toBe(0);
});
