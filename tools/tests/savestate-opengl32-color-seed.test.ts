import { describe, expect, test } from "bun:test";
import { colorSeedPixels, readbackSourceRect, resolveReadback } from "../../src/worker/backends/webgpu/opengl/opengl-readback";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";

const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
const RED = px(200, 10, 20), GREEN = px(10, 200, 30), BLUE = px(5, 15, 250), GREY = px(90, 91, 92, 128);
const bottomFirst2x2 = Uint8Array.from([...RED, ...GREEN, ...BLUE, ...GREY]);
const at = (img: Uint8Array, w: number, x: number, y: number) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
const swap = (p: number[]) => [p[2]!, p[1]!, p[0]!, p[3]!];

describe("the colour seed written into the render target after a load", () => {
    test("at scale 1 it is the read-back turned top row first", () => {
        const out = colorSeedPixels(bottomFirst2x2, 2, 2, 2, 2, false);
        expect([at(out, 2, 0, 0), at(out, 2, 1, 0), at(out, 2, 0, 1), at(out, 2, 1, 1)]).toEqual([BLUE, GREY, RED, GREEN]);
    });

    test("a BGRA target gets red and blue exchanged", () => {
        const out = colorSeedPixels(bottomFirst2x2, 2, 2, 2, 2, true);
        expect([at(out, 2, 0, 0), at(out, 2, 1, 1)]).toEqual([swap(BLUE), swap(GREEN)]);
    });

    test("at the default internal scale of 2 every guest pixel fills its 2x2 block of the target", () => {
        const out = colorSeedPixels(bottomFirst2x2, 2, 2, 4, 4, false);
        expect(out.length).toBe(4 * 4 * 4);
        for (const [x, y, want] of [[0, 0, BLUE], [1, 1, BLUE], [2, 0, GREY], [3, 1, GREY], [0, 2, RED], [1, 3, RED], [2, 2, GREEN], [3, 3, GREEN]] as const) {
            expect({ x, y, got: at(out, 4, x, y) }).toEqual({ x, y, got: [...want] });
        }
    });

    test("a fractional scale and a target smaller than the read-back stay inside the image", () => {
        const up = colorSeedPixels(bottomFirst2x2, 2, 2, 3, 3, false);
        expect([at(up, 3, 0, 0), at(up, 3, 2, 0), at(up, 3, 0, 2), at(up, 3, 2, 2)]).toEqual([BLUE, GREY, RED, GREEN]);
        const down = colorSeedPixels(bottomFirst2x2, 2, 2, 1, 1, false);
        expect(down.length).toBe(4);
    });

    test("reading a scaled target back and seeding a new one with it gives the target again", () => {
        for (const bgra of [false, true]) {
            const guestW = 3, guestH = 2, scale = 2, targetW = guestW * scale, targetH = guestH * scale;
            const target = new Uint8Array(targetW * targetH * 4);
            for (let gy = 0; gy < guestH; gy++) for (let gx = 0; gx < guestW; gx++) {
                for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
                    target.set([10 + gx * 40, 20 + gy * 90, 200 - gx * 30, 255], ((gy * scale + dy) * targetW + gx * scale + dx) * 4);
                }
            }
            const rect = readbackSourceRect(0, 0, guestW, guestH, guestH, scale, targetW, targetH);
            const bytesPerRow = rect.width * 4;
            const mapped = new Uint8Array(bytesPerRow * rect.height);
            for (let y = 0; y < rect.height; y++) mapped.set(target.subarray(((rect.y + y) * targetW + rect.x) * 4, ((rect.y + y) * targetW + rect.x + rect.width) * 4), y * bytesPerRow);
            const readBack = resolveReadback(mapped, bytesPerRow, rect, 0, 0, guestW, guestH, guestH, scale, bgra);
            expect([...colorSeedPixels(readBack, guestW, guestH, targetW, targetH, bgra)]).toEqual([...target]);
        }
    });

    test("the executor writes the seed into a target twice the guest size, once", () => {
        const executor = new OpenGLBackendExecutor({} as never);
        const internals = executor as unknown as {
            offscreenTexture: unknown; targetFormat: string; offscreenInitialized: boolean;
            applyColorSeed(queue: unknown, renderW: number, renderH: number): void;
        };
        const texture = { label: "offscreen" };
        internals.offscreenTexture = texture;
        internals.targetFormat = "bgra8unorm";
        const writes: Array<{ texture: unknown; bytes: number[]; bytesPerRow: number; width: number; height: number }> = [];
        const queue = {
            writeTexture: (dst: { texture: unknown }, data: Uint8Array, layout: { bytesPerRow: number }, size: { width: number; height: number }) => {
                writes.push({ texture: dst.texture, bytes: [...data], bytesPerRow: layout.bytesPerRow, width: size.width, height: size.height });
            },
        };
        executor.seedColor(bottomFirst2x2, 2, 2);
        internals.applyColorSeed(queue, 4, 4);
        internals.applyColorSeed(queue, 4, 4);
        expect(writes.length).toBe(1);
        expect({ texture: writes[0]!.texture, bytesPerRow: writes[0]!.bytesPerRow, width: writes[0]!.width, height: writes[0]!.height })
            .toEqual({ texture, bytesPerRow: 16, width: 4, height: 4 });
        expect(writes[0]!.bytes).toEqual([...colorSeedPixels(bottomFirst2x2, 2, 2, 4, 4, true)]);
        expect(internals.offscreenInitialized).toBe(true);
    });

    test("a seed of the wrong length is not kept, and without a target nothing is written", () => {
        const executor = new OpenGLBackendExecutor({} as never);
        const internals = executor as unknown as { offscreenTexture: unknown; applyColorSeed(queue: unknown, w: number, h: number): void };
        let writes = 0;
        const queue = { writeTexture: () => { writes++; } };
        executor.seedColor(new Uint8Array(7), 2, 2);
        internals.offscreenTexture = {};
        internals.applyColorSeed(queue, 4, 4);
        executor.seedColor(bottomFirst2x2, 2, 2);
        internals.offscreenTexture = null;
        internals.applyColorSeed(queue, 4, 4);
        expect(writes).toBe(0);
    });
});
