import { afterEach, describe, expect, test } from "bun:test";
import "../../src/worker/modules/ddraw/d3d/types";
import { createDeviceExports } from "../../src/worker/modules/ddraw/d3d/device-impl";
import { freeStridedDrawScratch } from "../../src/worker/modules/ddraw/d3d/strided-draw";
import { System } from "../../src/worker/core/system";

const OK = 0;
const INVALID = 0x80070057;
const UNSUPPORTED = 0x80004001;
const OOM = 0x8007000e;
const DESC = 0x100;
const POS = 0x300;
const NORMAL = 0x400;
const DIFFUSE = 0x500;
const TEX = 0x600;
const INDICES = 0x800;

const system = System.getInstance() as any;
const priorProcess = system.process;
afterEach(() => { system.process = priorProcess; });

function fixture(grow = false) {
    const wasm = new WebAssembly.Memory({ initial: 2, maximum: 16 });
    const current = () => new Uint8Array(wasm.buffer);
    const view = () => new DataView(wasm.buffer);
    const allocations: number[] = [];
    const frees: number[] = [];
    let bump = 0x10000;
    let failAllocation = false;
    const validated: [number, number, string][] = [];
    let forbidden = -1;
    system.process = { addressSpace: { validateRange(ptr: number, bytes: number, perms: string) {
        validated.push([ptr, bytes, perms]);
        return !(ptr <= forbidden && ptr + bytes > forbidden);
    } } };
    const memory: any = {
        alloc(bytes: number) {
            if (failAllocation) throw new Error("heap exhausted");
            if (grow || bump + bytes > wasm.buffer.byteLength) wasm.grow(Math.ceil(bytes / 65536));
            const addr = bump;
            bump += bytes;
            allocations.push(addr);
            return addr;
        },
        free(addr: number) { frees.push(addr); },
    };
    const draws: any[] = [];
    const drawHandler: any = { handleDrawPrimitive(
        device: number, primitive: number, fvf: number, ptr: number, count: number,
        mem: Uint8Array, indexed: boolean, indexPtr: number, indexCount: number,
    ) {
        // Independent expected strides for the transcript cases below, not the
        // production FVF parser. Snapshot now, as the actual executor uploads now.
        const stride = fvf === 0x112 ? 32 : fvf === 0x144 || fvf === 0x1c2 ? 28 : fvf === 0x1c4 ? 32
            : fvf === 0x270302 ? 44 : 12;
        draws.push({ device, primitive, fvf, count, indexed,
            bytes: [...mem.slice(ptr, ptr + count * stride)],
            indices: Array.from({ length: indexCount }, (_, i) =>
                new DataView(mem.buffer).getUint16(indexPtr + 2 * i, true)) });
    } };
    const context: any = { process: { memory, getCurrentMemory: current }, resourceProvider: {} };
    const api = createDeviceExports(context, {} as any, drawHandler);
    const pair = (slot: number, ptr: number, stride: number) => {
        view().setUint32(DESC + slot * 8, ptr, true);
        view().setUint32(DESC + slot * 8 + 4, stride, true);
    };
    const floats = (ptr: number, values: number[]) => values.forEach((x, i) => view().setFloat32(ptr + i * 4, x, true));
    const call = (version: 3 | 7, indexed = true, fvf = 0x112, count = 3, indexCount = 3, desc = DESC, indices = INDICES) => {
        const name = `IDirect3DDevice${version}_Draw${indexed ? "Indexed" : ""}PrimitiveStrided`;
        return api[name]!({} as any, current(), indexed
            ? [0x1234, 4, fvf, desc, count, indices, indexCount, 0]
            : [0x1234, 4, fvf, desc, count, 0]) as number;
    };
    // Poison every inactive descriptor; the FVF alone selects what is accessed.
    for (let slot = 0; slot < 12; slot++) pair(slot, 0xdeadbeef, 0xffffffff);
    pair(0, POS, 16); pair(1, NORMAL, 12); pair(4, TEX, 8);
    floats(POS, [1, 2, 3, 999, 4, 5, 6, 999, 7, 8, 9, 999]);
    floats(NORMAL, [0, 1, 0, 1, 0, 0, 0, 0, 1]);
    floats(TEX, [0, 0, 1, 0, 0, 1]);
    [2, 0, 1].forEach((x, i) => view().setUint16(INDICES + 2 * i, x, true));
    return { current, view, pair, floats, call, draws, memory, allocations, frees, validated,
        forbid: (ptr: number) => { forbidden = ptr; }, fail: () => { failAllocation = true; } };
}

const floatBytes = (values: number[]) => [...new Uint8Array(new Float32Array(values).buffer)];

describe("D3D3/7 strided draw transcript", () => {
    for (const version of [3, 7] as const) {
        test(`Device${version}: indexed FVF 0x112 reaches the existing draw path with exact vertices and WORD indices`, () => {
            const h = fixture();
            expect(h.call(version)).toBe(OK);
            expect(h.draws).toEqual([{ device: 0x1234, primitive: 4, fvf: 0x112, count: 3, indexed: true,
                indices: [2, 0, 1], bytes: floatBytes([
                    1, 2, 3, 0, 1, 0, 0, 0,
                    4, 5, 6, 1, 0, 0, 1, 0,
                    7, 8, 9, 0, 0, 1, 0, 1,
                ]) }]);
            expect(h.validated).toContainEqual([POS, 44, "r"]);
            expect(h.validated.some(([p]) => p === 0xdeadbeef)).toBe(false);
        });
        test(`Device${version}: nonindexed XYZRHW and broadcast diffuse preserve exact DWORD colour`, () => {
            const h = fixture();
            h.pair(0, POS, 16); h.pair(2, DIFFUSE, 0); h.pair(4, TEX, 8);
            h.floats(POS, [10, 20, 0.5, 1, 30, 40, 0.5, 1, 50, 60, 0.5, 1]);
            h.view().setUint32(DIFFUSE, 0x81234567, true);
            expect(h.call(version, false, 0x144)).toBe(OK);
            const colour = [0x67, 0x45, 0x23, 0x81];
            expect(h.draws[0].bytes).toEqual([
                ...floatBytes([10, 20, 0.5, 1]), ...colour, ...floatBytes([0, 0]),
                ...floatBytes([30, 40, 0.5, 1]), ...colour, ...floatBytes([1, 0]),
                ...floatBytes([50, 60, 0.5, 1]), ...colour, ...floatBytes([0, 1]),
            ]);
            expect(h.validated).toContainEqual([DIFFUSE, 4, "r"]);
            expect(h.draws[0].indexed).toBe(false);
        });
    }

    test("one-, three- and four-component texture coordinates preserve independent strides", () => {
        const h = fixture();
        h.pair(4, TEX, 4); h.pair(5, TEX + 32, 16); h.pair(6, TEX + 64, 20);
        h.floats(TEX, [11, 12]); h.floats(TEX + 32, [21, 22, 23, 999, 24, 25, 26]);
        h.floats(TEX + 64, [31, 32, 33, 34, 999, 35, 36, 37, 38]);
        // TEX3 + size1(0), size3(1), size4(2).
        const fvf = 0x270302;
        expect(h.call(7, false, fvf, 2)).toBe(OK);
        expect(h.draws[0].bytes).toEqual(floatBytes([
            1, 2, 3, 11, 21, 22, 23, 31, 32, 33, 34,
            4, 5, 6, 12, 24, 25, 26, 35, 36, 37, 38,
        ]));
    });

    test("DX6/7 LVERTEX's RESERVED1 never becomes a DX8 point-size stream", () => {
        const h = fixture();
        h.pair(2, DIFFUSE, 0); h.pair(3, DIFFUSE + 4, 0);
        h.view().setUint32(DIFFUSE, 0xaabbccdd, true);
        h.view().setUint32(DIFFUSE + 4, 0x11223344, true);
        expect(h.call(7, false, 0x1e2, 1)).toBe(OK);
        expect(h.draws[0].fvf).toBe(0x1c2);
        expect(h.draws[0].bytes).toEqual([
            ...floatBytes([1, 2, 3]), 0xdd, 0xcc, 0xbb, 0xaa,
            0x44, 0x33, 0x22, 0x11, ...floatBytes([0, 0]),
        ]);
    });

    test("invalid descriptor, active streams, full strided extent and index extent decline before drawing", () => {
        for (const damage of [
            (h: ReturnType<typeof fixture>) => h.pair(0, 0, 12),
            (h: ReturnType<typeof fixture>) => h.pair(0, 0xfffffff0, 12),
            (h: ReturnType<typeof fixture>) => h.pair(0, POS, 0xffffffff),
            (h: ReturnType<typeof fixture>) => h.forbid(POS + 43),
            (h: ReturnType<typeof fixture>) => h.forbid(INDICES + 5),
            (h: ReturnType<typeof fixture>) => h.forbid(DESC + 95),
        ]) {
            const h = fixture(); damage(h);
            expect(h.call(7)).toBe(INVALID);
            expect(h.draws).toHaveLength(0);
            expect(h.allocations).toHaveLength(0);
        }
        const h = fixture();
        expect(h.call(7, true, 0x112, 3, 3, 0)).toBe(INVALID);
        expect(h.call(7, true, 0x112, 3, 3, DESC, 0)).toBe(INVALID);
        expect(h.call(7, true, 0x902)).toBe(INVALID);
    });

    test("zero counts never touch poisoned pointers; unsupported layouts report a limitation", () => {
        const h = fixture();
        expect(h.call(7, true, 0x112, 0, 3, 0, 0)).toBe(OK);
        expect(h.call(3, true, 0x112, 3, 0, 0, 0)).toBe(OK);
        expect(h.call(7, false, 0x112, 0, 0, 0)).toBe(OK);
        expect(h.call(7, false, 0x106)).toBe(UNSUPPORTED);
        expect(h.draws).toHaveLength(0);
        expect(h.validated).toHaveLength(0);
    });

    test("scratch reuse cannot change earlier uploads; growth re-derives detached memory and reset frees scratch", () => {
        const h = fixture(true);
        const stale = h.current();
        expect(h.call(7)).toBe(OK);
        expect(stale.byteLength).toBe(0);
        const original = [...h.draws[0].bytes];
        h.floats(POS, [-1, -2, -3]);
        expect(h.call(3)).toBe(OK);
        expect(h.allocations).toHaveLength(1);
        expect(h.draws[0].bytes).toEqual(original);
        expect(h.draws[1].bytes.slice(0, 12)).toEqual(floatBytes([-1, -2, -3]));
        freeStridedDrawScratch(h.memory);
        expect(h.frees).toEqual(h.allocations);
        expect(h.call(7)).toBe(OK);
        expect(h.allocations).toHaveLength(2);
    });

    test("allocation failure becomes OUTOFMEMORY without submitting an incomplete draw", () => {
        const h = fixture(); h.fail();
        expect(h.call(7)).toBe(OOM);
        expect(h.draws).toHaveLength(0);
    });
});
