/**
 * Direct3D v1 execute-buffer interpreter contract.
 *
 * The opcode stream is guest-authored data the interpreter walks as a program, so both
 * halves matter: the control flow has to match what D3D actually did (Wine's
 * dlls/ddraw/executebuffer.c is the reference implementation of the same driver
 * behaviour), and every offset in it is attacker-shaped input that must stay inside the
 * buffer the app allocated.
 *
 * Pinned behaviours:
 *  - D3DOP_BRANCHFORWARD's dwOffset counts from the START of the D3DINSTRUCTION header
 *    (`instr = (char *)current + ci->dwOffset`), and dwOffset == 0 is not a branch.
 *  - An unknown opcode skips its records (`instr += count * size`) instead of aborting.
 *  - Destination vertex blocks ACCUMULATE: several D3DOP_PROCESSVERTICES records fill
 *    disjoint ranges of one destination buffer, and the following triangle list indexes
 *    across all of them in DESTINATION space.
 */

import { describe, expect, test } from "bun:test";
// d3d/types.ts builds its default render-state table at module scope out of ../constants,
// so the module graph has to be entered through it; starting anywhere else resolves the
// ddraw import cycle into a temporal-dead-zone error.
import "../../src/worker/modules/ddraw/d3d/types";
import {
    createExecuteBufferExports,
    freeExecuteBufferScratch,
} from "../../src/worker/modules/ddraw/d3d/execute-buffer-impl";

const D3D_OK = 0;
const DDERR_INVALIDPARAMS = 0x80070057;

const D3DOP_POINT = 1;
const D3DOP_TRIANGLE = 3;
const D3DOP_PROCESSVERTICES = 9;
const D3DOP_EXIT = 11;
const D3DOP_BRANCHFORWARD = 12;

const D3DPROCESSVERTICES_COPY = 2;
const D3DFVF_TLVERTEX = 0x1c4;
const VERTEX_STRIDE = 32;
const D3DEXECUTEDATA_SIZE = 48;

const BUF = 0x1000;
const BUF_SIZE = 0x1000;
const BUFFER_OBJ = 0x900;
const DEVICE = 0x800;
const EXEC_DATA = 0x400;
const VERTEX_OFFSET = 0x800; // inside the execute buffer
const SCRATCH_BASE = 0x8000;

interface Draw {
    type: number;
    fvf: number;
    lpVertices: number;
    count: number;
    indexed: boolean;
    indices: number[];
}

function harness() {
    // The interpreter's guest scratch outlives one exports table (DDraw.reset frees it),
    // so each case starts from an unallocated one or it would keep the previous
    // harness's addresses over this harness's fresh heap.
    freeExecuteBufferScratch({ free() { } });

    const mem = new Uint8Array(0x20000);
    const view = new DataView(mem.buffer);

    let bump = SCRATCH_BASE;
    const allocs = new Set<number>();
    const memory = {
        alloc(size: number): number {
            const addr = bump;
            bump += (size + 0xfff) & ~0xfff;
            allocs.add(addr);
            return addr;
        },
        free(addr: number): void { allocs.delete(addr); },
    };

    const execData = {
        vertexOffset: VERTEX_OFFSET, vertexCount: 8, instructionOffset: 0, instructionLength: 0x200,
        hVertexOffset: 0, statusFlags: 0, status: 0,
        statusExtent: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const buffer = {
        getExecuteData: () => execData,
        setExecuteData: (d: typeof execData) => Object.assign(execData, d),
        getDataAddr: () => BUF,
        getDataSize: () => BUF_SIZE,
    };

    const context: any = {
        process: { memory },
        resourceProvider: {
            getComObjectByAddress: (addr: number) => (addr === BUFFER_OBJ ? buffer : null),
        },
        vtables: {},
    };

    const draws: Draw[] = [];
    const drawHandler: any = {
        handleDrawPrimitive(
            _devicePtr: number, type: number, fvf: number, lpVertices: number, count: number,
            _mem: Uint8Array, indexed = false, lpIndices = 0, iCount = 0,
        ) {
            const indices: number[] = [];
            for (let i = 0; i < iCount; i++) indices.push(view.getUint16(lpIndices + i * 2, true));
            draws.push({ type, fvf, lpVertices, count, indexed, indices });
        },
    };

    const api = createExecuteBufferExports(context, drawHandler, {});
    const call = (name: string, ...args: number[]) =>
        api[`IDirect3D${name}`]!({} as any, mem, args as any) as number;

    /** Write one D3DINSTRUCTION header at `off` (buffer-relative). */
    const instr = (off: number, opcode: number, size: number, count: number): number => {
        view.setUint8(BUF + off, opcode);
        view.setUint8(BUF + off + 1, size);
        view.setUint16(BUF + off + 2, count, true);
        return off + 4;
    };
    const u32 = (off: number, v: number): void => view.setUint32(BUF + off, v, true);
    const u16 = (off: number, v: number): void => view.setUint16(BUF + off, v, true);

    return { mem, view, execData, draws, call, instr, u32, u16, api };
}

describe("d3d execute buffer interpreter", () => {
    test("BRANCHFORWARD's dwOffset counts from the instruction header, not from its end", () => {
        const h = harness();
        // Branch record at 0: header 4 + body 16, so the record ends at 20. dwOffset=20
        // therefore names offset 20 (header + 20); measuring from the END would land at 40.
        let p = h.instr(0, D3DOP_BRANCHFORWARD, 16, 1);
        h.u32(p, 0);        // dwMask   — (status & 0) == 0, so the branch is taken
        h.u32(p + 4, 0);    // dwValue
        h.u32(p + 8, 0);    // bNegate
        h.u32(p + 12, 20);  // dwOffset

        p = h.instr(20, D3DOP_TRIANGLE, 8, 1);
        h.u16(p, 1); h.u16(p + 2, 2); h.u16(p + 4, 3);
        h.instr(32, D3DOP_EXIT, 0, 0);

        p = h.instr(40, D3DOP_TRIANGLE, 8, 1);
        h.u16(p, 5); h.u16(p + 2, 6); h.u16(p + 4, 7);
        h.instr(52, D3DOP_EXIT, 0, 0);

        expect(h.call("Device_Execute", DEVICE, BUFFER_OBJ, 0)).toBe(D3D_OK);
        expect(h.draws.length).toBe(1);
        expect(h.draws[0]!.indices).toEqual([1, 2, 3]);
    });

    test("a zero dwOffset falls through instead of ending the buffer", () => {
        const h = harness();
        let p = h.instr(0, D3DOP_BRANCHFORWARD, 16, 1);
        h.u32(p, 0); h.u32(p + 4, 0); h.u32(p + 8, 0); h.u32(p + 12, 0); // taken, offset 0

        p = h.instr(20, D3DOP_TRIANGLE, 8, 1);
        h.u16(p, 0); h.u16(p + 2, 1); h.u16(p + 4, 2);
        h.instr(32, D3DOP_EXIT, 0, 0);

        h.call("Device_Execute", DEVICE, BUFFER_OBJ, 0);
        expect(h.draws.length).toBe(1);
    });

    test("an unknown opcode skips its records and the rest of the buffer still runs", () => {
        const h = harness();
        h.instr(0, 99, 8, 2); // 16 bytes of payload we know nothing about
        const p = h.instr(20, D3DOP_TRIANGLE, 8, 1);
        h.u16(p, 0); h.u16(p + 2, 1); h.u16(p + 4, 2);
        h.instr(32, D3DOP_EXIT, 0, 0);

        h.call("Device_Execute", DEVICE, BUFFER_OBJ, 0);
        expect(h.draws.length).toBe(1);
        expect(h.draws[0]!.indices).toEqual([0, 1, 2]);
    });

    test("destination vertex blocks accumulate and triangles index across all of them", () => {
        const h = harness();
        // Two PROCESSVERTICES records, source 0..3 -> dest 0..3 and source 4..7 -> dest 4..7.
        // Tag each source vertex so the copy into the destination buffer is checkable.
        for (let v = 0; v < 8; v++) h.view.setUint32(BUF + VERTEX_OFFSET + v * VERTEX_STRIDE, 0xbeef0000 + v, true);

        let p = h.instr(0, D3DOP_PROCESSVERTICES, 16, 2);
        h.u32(p, D3DPROCESSVERTICES_COPY); h.u16(p + 4, 0); h.u16(p + 6, 0); h.u32(p + 8, 4);
        h.u32(p + 16, D3DPROCESSVERTICES_COPY); h.u16(p + 20, 4); h.u16(p + 22, 4); h.u32(p + 24, 4);

        p = h.instr(36, D3DOP_TRIANGLE, 8, 1);
        h.u16(p, 0); h.u16(p + 2, 4); h.u16(p + 4, 5); // spans BOTH blocks
        h.instr(48, D3DOP_EXIT, 0, 0);

        h.call("Device_Execute", DEVICE, BUFFER_OBJ, 0);

        expect(h.draws.length).toBe(1);
        const draw = h.draws[0]!;
        // Indices stay in destination space: rebasing to the last block would collapse
        // index 0 (from the first block) onto vertex 0 of the second.
        expect(draw.indices).toEqual([0, 4, 5]);
        expect(draw.count).toBe(8);
        expect(draw.fvf).toBe(D3DFVF_TLVERTEX);
        expect(draw.lpVertices).toBeGreaterThanOrEqual(SCRATCH_BASE);
        // …and the destination buffer really holds both blocks' vertices.
        expect(h.view.getUint32(draw.lpVertices + 0 * VERTEX_STRIDE, true)).toBe(0xbeef0000);
        expect(h.view.getUint32(draw.lpVertices + 5 * VERTEX_STRIDE, true)).toBe(0xbeef0005);
    });

    test("D3DOP_POINT ignores a wFirst that names no processed vertex", () => {
        const h = harness();
        let p = h.instr(0, D3DOP_PROCESSVERTICES, 16, 1);
        h.u32(p, D3DPROCESSVERTICES_COPY); h.u16(p + 4, 0); h.u16(p + 6, 0); h.u32(p + 8, 4);

        // wFirst=9 is outside the 0..3 block, so it would address BELOW the buffer once
        // rebased; wCount=100 overruns what the block holds.
        p = h.instr(20, D3DOP_POINT, 4, 2);
        h.u16(p, 1); h.u16(p + 2, 9);
        h.u16(p + 4, 100); h.u16(p + 6, 2);
        h.instr(32, D3DOP_EXIT, 0, 0);

        h.call("Device_Execute", DEVICE, BUFFER_OBJ, 0);

        expect(h.draws.length).toBe(1);           // the out-of-range record is dropped
        expect(h.draws[0]!.count).toBe(2);        // clamped to what the block holds
    });

    test("an instruction whose records run past the buffer stops the interpreter", () => {
        const h = harness();
        // size 255 * count 65535 = ~16 MB claimed by one record set.
        h.instr(0, D3DOP_TRIANGLE, 255, 0xffff);
        h.execData.instructionLength = 0x100;

        expect(h.call("Device_Execute", DEVICE, BUFFER_OBJ, 0)).toBe(D3D_OK);
        expect(h.draws.length).toBe(0);
    });

    test("SetExecuteData refuses data that does not describe this buffer", () => {
        const h = harness();
        const write = (size: number, instrOffset: number, instrLen: number, vtxOff = 0, vtxCount = 0) => {
            h.view.setUint32(EXEC_DATA, size, true);
            h.view.setUint32(EXEC_DATA + 4, vtxOff, true);
            h.view.setUint32(EXEC_DATA + 8, vtxCount, true);
            h.view.setUint32(EXEC_DATA + 12, instrOffset, true);
            h.view.setUint32(EXEC_DATA + 16, instrLen, true);
        };

        // A struct whose dwSize is not sizeof(D3DEXECUTEDATA) is rejected outright.
        write(20, 0, 16);
        expect(h.call("ExecuteBuffer_SetExecuteData", BUFFER_OBJ, EXEC_DATA)).toBe(DDERR_INVALIDPARAMS);

        // An instruction range past the end of the buffer would make Execute interpret
        // arbitrary guest memory as opcodes.
        write(D3DEXECUTEDATA_SIZE, BUF_SIZE - 8, 64);
        expect(h.call("ExecuteBuffer_SetExecuteData", BUFFER_OBJ, EXEC_DATA)).toBe(DDERR_INVALIDPARAMS);

        // So would a vertex block that does not fit.
        write(D3DEXECUTEDATA_SIZE, 0, 16, 0, BUF_SIZE);
        expect(h.call("ExecuteBuffer_SetExecuteData", BUFFER_OBJ, EXEC_DATA)).toBe(DDERR_INVALIDPARAMS);

        write(D3DEXECUTEDATA_SIZE, 0, 16, 0, 4);
        expect(h.call("ExecuteBuffer_SetExecuteData", BUFFER_OBJ, EXEC_DATA)).toBe(D3D_OK);
    });

    test("GetExecuteData hands back the whole struct, dsStatus included", () => {
        const h = harness();
        h.execData.status = 0x1234;
        h.execData.statusFlags = 0x1;
        h.execData.statusExtent = { left: 1, top: 2, right: 3, bottom: 4 };

        expect(h.call("ExecuteBuffer_GetExecuteData", BUFFER_OBJ, EXEC_DATA)).toBe(D3D_OK);

        expect(h.view.getUint32(EXEC_DATA, true)).toBe(D3DEXECUTEDATA_SIZE);
        expect(h.view.getUint32(EXEC_DATA + 24, true)).toBe(0x1);
        expect(h.view.getUint32(EXEC_DATA + 28, true)).toBe(0x1234);
        expect(h.view.getInt32(EXEC_DATA + 40, true)).toBe(3);
    });
});
