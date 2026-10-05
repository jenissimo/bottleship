import { describe, expect, test } from "bun:test";
import { dwordToUnsignedLong } from "../../src/worker/backends/webgpu/shared/dword";

describe("WebGPU DWORD conversion", () => {
    test("reinterprets signed render-state storage for WebIDL unsigned long fields", () => {
        const states = new Int32Array(1);
        states[0] = 0xffffffff;

        expect(states[0]).toBe(-1);
        expect(dwordToUnsignedLong(states[0])).toBe(0xffffffff);
    });
});
