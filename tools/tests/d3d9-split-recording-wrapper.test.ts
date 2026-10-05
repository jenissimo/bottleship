/**
 * The split recorder's per-method wrapper: a pass-through while the ring drains (suppressed) or
 * inside another recorded call, and a record of the OUTERMOST call otherwise. The wrapper runs
 * ~20k times a frame on the pass-through path, so it must not name `arguments` (which V8
 * materializes on every call); the recorded argument list drops trailing `undefined` instead,
 * which no recorded method can tell apart from a missing argument.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { attachD3D9Split, d3d9SplitStats, resetD3D9SplitStreamForTests } from "../../src/worker/modules/d3d9/split";
import { SplitDecoder } from "../../src/worker/backends/webgpu/d3d9/split-codec";

const noRefs = { idOf: () => undefined, twinOf: () => undefined };

class FakeDevice {
    role = "both";
    isExtended = false;
    calls: Array<[string, unknown[]]> = [];
    setRenderState(state: number, value: number): number {
        this.calls.push(["setRenderState", [state, value]]);
        return 0;
    }
    lockTexture(texPtr: number, level: number, discard = false): number {
        this.calls.push(["lockTexture", [texPtr, level, discard]]);
        return 7;
    }
    setVertexShader(handle: number, comPtr = 0): number {
        this.calls.push(["setVertexShader", [handle, comPtr]]);
        // A recorded method calling another one: only the outer call may reach the stream.
        this.setRenderState(99, handle);
        return 0;
    }
}

function harness() {
    const records: Array<{ method: number; slot: number; result: unknown; args: unknown[] }> = [];
    let client: { drainBegin(): void; drainEnd(): void } | null = null;
    const dispatcher = {
        registerQueuePayloadHandler: () => -2,
        enqueuePayloadById: (_id: number, h0: number, h1: number, _h2: number, _h3: number,
            src: Uint8Array, off: number, len: number) => {
            const bytes = src.slice(off, off + len);
            const d = new SplitDecoder(bytes, 0, bytes.length, noRefs);
            const result = d.value();
            const argc = d.value() as number;
            const args: unknown[] = [];
            for (let i = 0; i < argc; i++) args.push(d.value());
            expect(d.done).toBe(true);
            records.push({ method: h0, slot: h1, result, args });
            return true;
        },
        executeWbufQueue: () => {},
        setWbufSplitClient: (c: never) => { client = c; },
    };
    resetD3D9SplitStreamForTests();
    const front = new FakeDevice();
    attachD3D9Split(front as never, null, dispatcher, null);
    return { front, records, client: () => client! };
}

afterEach(() => resetD3D9SplitStreamForTests());

describe("d3d9 split: recording wrapper", () => {
    test("an outside call runs on the front and is recorded with its answer", () => {
        const { front, records } = harness();
        expect(front.setRenderState(7, 3)).toBe(0);
        expect(front.calls).toEqual([["setRenderState", [7, 3]]]);
        expect(records).toHaveLength(1);
        expect(records[0]!.result).toBe(0);
        expect(records[0]!.args).toEqual([7, 3]);
        expect(d3d9SplitStats()!.recorded).toBe(1);
    });

    test("trailing undefined is dropped; a missing and an explicit default are the same call", () => {
        const { front, records } = harness();
        expect(front.lockTexture(0x1000, 2)).toBe(7);
        expect(front.lockTexture(0x1000, 2, undefined)).toBe(7);
        expect(front.calls).toEqual([["lockTexture", [0x1000, 2, false]], ["lockTexture", [0x1000, 2, false]]]);
        expect(records.map((r) => r.args)).toEqual([[0x1000, 2], [0x1000, 2]]);
        expect(records.map((r) => r.result)).toEqual([7, 7]);
    });

    test("an interior undefined keeps its position", () => {
        const { front, records } = harness();
        front.lockTexture(0x2000, undefined as never, true);
        expect(records[0]!.args).toEqual([0x2000, undefined, true]);
    });

    test("only the outermost call is recorded", () => {
        const { front, records } = harness();
        front.setVertexShader(5);
        expect(front.calls).toEqual([["setVertexShader", [5, 0]], ["setRenderState", [99, 5]]]);
        expect(records).toHaveLength(1);
        expect(records[0]!.args).toEqual([5]);
    });

    test("a drain (suppressed) passes every argument through and records nothing", () => {
        const { front, records, client } = harness();
        client().drainBegin();
        try {
            expect(front.lockTexture(0x3000, 1, true)).toBe(7);
            front.setVertexShader(4, 0x44);
        } finally {
            client().drainEnd();
        }
        expect(front.calls).toEqual([
            ["lockTexture", [0x3000, 1, true]], ["setVertexShader", [4, 0x44]], ["setRenderState", [99, 4]],
        ]);
        expect(records).toHaveLength(0);
    });

    test("the installed wrapper does not name `arguments`", () => {
        const src = fs.readFileSync("src/worker/modules/d3d9/split.ts", "utf8").replace(/\r/g, "");
        const start = src.indexOf("    private recordingWrapper(");
        const end = src.indexOf("\n    }\n", start);
        expect(start).toBeGreaterThan(0);
        const code = src.slice(start, end).replace(/\/\/.*$/gm, "");
        expect(code).toContain("return function (");
        expect(code).not.toMatch(/\barguments\b/);
    });
});
