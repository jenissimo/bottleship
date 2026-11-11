import { afterEach, describe, expect, test } from "bun:test";
import { d3d9BufferAlignment } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

const g = globalThis as { __d3d9BufferAlign?: number };

afterEach(() => { delete g.__d3d9BufferAlign; });

describe("D3D9 vertex/index buffer guest storage alignment", () => {
    test("defaults to 16 bytes", () => {
        expect(d3d9BufferAlignment()).toBe(16);
    });

    test("8 and 32 are accepted, anything else falls back to 16", () => {
        g.__d3d9BufferAlign = 8;
        expect(d3d9BufferAlignment()).toBe(8);
        g.__d3d9BufferAlign = 32;
        expect(d3d9BufferAlignment()).toBe(32);
        for (const v of [0, 1, 4, 12, 24, 64, -16, NaN]) {
            g.__d3d9BufferAlign = v;
            expect(d3d9BufferAlignment()).toBe(16);
        }
    });
});
