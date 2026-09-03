/**
 * Multi-struct capture-at-call registration, and the barrier that makes putting a DRAW on
 * the write-buffer ring safe.
 *
 * The ring's per-funcId coalescing is "last write wins", and it was only ever safe because
 * a drain could not span two draws — draws trapped, and the dispatcher drains before every
 * trap. Registering a draw on the ring ends that. Without a barrier, the setters preceding
 * triangle 1 and triangle 2 collapse into one and BOTH triangles observe triangle 2's
 * state: wrong colours and textures on some triangles, no crash, nothing in any log. This
 * pins the mechanism that prevents it, and the second arm shows the bug it prevents.
 */

import { describe, it, expect } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';

const RING_CTRL = 0x3000;
const RING_DATA = 0x4000;
const RING_CAP = 0x8000;

// Shaped like the glide per-TMU setters that actually coalesce (_grTexFilterMode
// and friends, mask 0x1): arg0 is the TMU index and selects the state slot, arg1 is
// the value. A mask of 0 means the entry is not indexed for coalescing at all.
const SET = { id: 41, name: 'Fake_SetTexFilter', argCount: 2 };
const DRAW = { id: 43, name: 'Fake_DrawTri', argCount: 3, ptrArgIndices: [0, 1, 2], payloadDwords: 4 };

function mkDispatcher(mem: Uint8Array): any {
    const stubs = [
        { dllName: 'fake', functionName: SET.name, functionId: SET.id, address: 0x1000, argCount: SET.argCount, stackCleanupBytes: 4 },
        { dllName: 'fake', functionName: DRAW.name, functionId: DRAW.id, address: 0x1020, argCount: DRAW.argCount, stackCleanupBytes: 12 },
    ];
    const generator = {
        findStubsByName: (dll: string, fn: string) => stubs.filter(s =>
            s.dllName.toLowerCase() === dll.toLowerCase() && s.functionName.toLowerCase() === fn.toLowerCase()),
        getAllStubs: () => stubs,
        getStubById: (id: number) => stubs.find(s => s.functionId === id),
    };
    const d = new ThunkDispatcher({ add_listener: () => { } } as any, generator as any) as any;
    d.cachedMem8 = mem;
    d.cachedDataView = new DataView(mem.buffer);
    d.cachedMem32 = new Uint32Array(mem.buffer, 0, mem.byteLength >>> 2);
    d.cachedWasmBuffer = mem.buffer;
    d.cachedReg32Raw = new Int32Array(mem.buffer, 64, 8);
    d.memLength = mem.length;
    d.writeBufControlAddr = RING_CTRL;
    d.writeBufDataBase = RING_DATA;
    d.writeBufCapacity = RING_CAP;
    for (let i = 0; i < 64; i++) d.writeBufTrampolineAddrs[i] = 0x2000 + i * 0x40;
    return d;
}

describe('registerMultiStructCaptureWriteBufferFunction', () => {
    it('registers a draw as a BARRIER, with the scalars+payload stride', () => {
        const mem = new Uint8Array(0x20000);
        const d = mkDispatcher(mem);
        let bump = 0x10000;
        d.thunkMemoryManager = { stubAllocator: { alloc: (size: number) => { const a = bump; bump += size; return a; } } };
        d.getMemory = () => mem;

        d.registerMultiStructCaptureWriteBufferFunction(
            'fake', DRAW.name, DRAW.argCount, DRAW.ptrArgIndices, DRAW.payloadDwords, () => { });

        expect(d.writeBufBarrierTable[DRAW.id]).toBe(1);
        // Stride is the ordinary (n+1)*4 with n = scalars + every captured payload, so the
        // dispatcher needs no new stride case for this shape.
        expect(d.writeBufArgCountTable[DRAW.id])
            .toBe(DRAW.argCount + DRAW.ptrArgIndices.length * DRAW.payloadDwords);
        // A capture must never coalesce: two draws are two draws.
        expect(d.writeBufCoalesceMaskTable[DRAW.id]).toBe(0);
    });
});

/**
 * Lay SET(v1) DRAW SET(v2) DRAW into the ring and drain it with coalescing on, recording
 * what each draw observed. `barrier` selects the arm.
 */
function drainSetDrawSetDraw(barrier: 0 | 1): { observed: number[]; sets: number[] } {
    const mem = new Uint8Array(0x20000);
    const d = mkDispatcher(mem);
    const m32 = new Uint32Array(mem.buffer);

    let live = 0;
    const observed: number[] = [];
    const sets: number[] = [];

    d.writeBufHandlerTable[SET.id] = (_m8: Uint8Array, m: Uint32Array, p: number) => {
        live = m[(p >> 2) + 1]!;   // arg1 = the value; arg0 is the TMU slot
        sets.push(live);
    };
    d.writeBufArgCountTable[SET.id] = SET.argCount;
    d.writeBufCoalesceMaskTable[SET.id] = 0x1;   // key on arg0 (the TMU)
    d.writeBufBarrierTable[SET.id] = 0;

    d.writeBufHandlerTable[DRAW.id] = () => { observed.push(live); };
    d.writeBufArgCountTable[DRAW.id] = DRAW.argCount + DRAW.ptrArgIndices.length * DRAW.payloadDwords;
    d.writeBufCoalesceMaskTable[DRAW.id] = 0;
    d.writeBufBarrierTable[DRAW.id] = barrier;

    let off = 0;
    const put = (id: number, dwords: number[]) => {
        m32[(RING_DATA + off) >> 2] = id;
        for (let i = 0; i < dwords.length; i++) m32[(RING_DATA + off + 4 + i * 4) >> 2] = dwords[i]!;
        off += (dwords.length + 1) * 4;
    };
    const drawPayload = new Array<number>(DRAW.argCount + DRAW.ptrArgIndices.length * DRAW.payloadDwords).fill(0);
    put(SET.id, [0, 0x1111]);
    put(DRAW.id, drawPayload);
    put(SET.id, [0, 0x2222]);
    put(DRAW.id, drawPayload);
    m32[RING_CTRL >> 2] = off;

    d.wbufCoalescingEnabled = true;
    d.drainWriteBuffer();
    return { observed, sets };
}

describe('a draw on the ring scopes coalescing', () => {
    it('with the barrier, each draw observes the setter that preceded IT', () => {
        const { observed, sets } = drainSetDrawSetDraw(1);
        expect(sets).toEqual([0x1111, 0x2222]);
        expect(observed).toEqual([0x1111, 0x2222]);
    });

    it('without the barrier, the first setter is coalesced AWAY across the draw — the bug', () => {
        // Not an aspiration: this is what the ring does to a draw registered without a
        // barrier, and it is why the barrier is not optional in the glide registration.
        // Both SETs key to the same TMU slot, so only the last one runs, and the first
        // triangle is drawn with state it was never given.
        const { observed, sets } = drainSetDrawSetDraw(0);
        expect(sets).toEqual([0x2222]);
        expect(observed).toEqual([0, 0x2222]);
    });
});
