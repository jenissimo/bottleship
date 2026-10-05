/**
 * WBUF transport mode — the first step of the threaded D3D9 split.
 *
 * With `__wbufTransport` the drain copies the pending entries out of the guest ring and parses
 * the copy, the way a consumer on another worker would have to. The contract: the LOGICAL
 * LEDGER (which handler saw which argument words, in what order) is identical to the in-place
 * drain; entries of modules not marked transport-safe are still handed the guest ring; and the
 * copy carries exactly the pending bytes.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';

const RING_CTRL = 0x3000;
const RING_DATA = 0x4000;
const RING_CAP = 0x8000;

const FNS = [
    { id: 40, dll: 'd3d9', name: 'Fake_SetState', argCount: 3, barrier: false },
    { id: 41, dll: 'd3d9', name: 'Fake_SetTexture', argCount: 2, barrier: false },
    { id: 42, dll: 'd3d9', name: 'Fake_Draw', argCount: 5, barrier: true },
    { id: 43, dll: 'opengl32', name: 'Fake_glVertex', argCount: 3, barrier: false },
    { id: 44, dll: 'd3d9', name: 'Fake_SetStream', argCount: 2, barrier: false },
    { id: 45, dll: 'd3d9', name: 'Fake_Unlock', argCount: 253, barrier: false },
] as const;
type Fn = (typeof FNS)[number];

interface Seen { id: number; args: number[]; guestView: boolean }

function mkDispatcher(mem: Uint8Array): any {
    const stubs = FNS.map((f, i) => ({
        dllName: f.dll, functionName: f.name, functionId: f.id,
        address: 0x1000 + i * 0x20, argCount: f.argCount, stackCleanupBytes: f.argCount * 4,
    }));
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
    for (let i = 0; i < 32; i++) d.writeBufTrampolineAddrs[i] = 0x2000 + i * 0x40;
    return d;
}

function emit(mem: Uint8Array, seq: Fn[], seed: number): number {
    const m32 = new Uint32Array(mem.buffer);
    let s = seed >>> 0 || 1;
    let off = 0;
    for (const f of seq) {
        m32[(RING_DATA + off) >> 2] = f.id;
        for (let a = 0; a < f.argCount; a++) {
            s = (Math.imul(s, 1103515245) + 12345) >>> 0;
            m32[(RING_DATA + off + 4 + a * 4) >> 2] = s;
        }
        off += (f.argCount + 1) * 4;
    }
    m32[RING_CTRL >> 2] = off;
    return off;
}

function drain(seq: Fn[], seed: number, transport: boolean) {
    (globalThis as { __wbufTransport?: boolean }).__wbufTransport = transport;
    const mem = new Uint8Array(0x20000);
    const d = mkDispatcher(mem);
    const seen: Seen[] = [];
    for (const f of FNS) {
        d.registerWriteBufferFunction(f.dll, f.name, f.argCount,
            (m8: Uint8Array, m32: Uint32Array, ptr: number) => {
                const args: number[] = [];
                for (let a = 0; a < f.argCount; a++) args.push(m32[(ptr + a * 4) >> 2] >>> 0);
                seen.push({ id: f.id, args, guestView: m8 === mem });
            }, true, 0, { barrier: f.barrier });
    }
    const head = emit(mem, seq, seed);
    const ringBefore = mem.slice(RING_DATA, RING_DATA + head);
    d.drainWriteBuffer();
    return { seen, head, ringBefore, mem, stats: d.getWbufTransportStats(), tail: d.wbufTail };
}

function sequence(seed: number, len: number): Fn[] {
    let s = seed >>> 0 || 1;
    const out: Fn[] = [];
    for (let i = 0; i < len; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        out.push(FNS[s % 4]!);
    }
    return out;
}

afterEach(() => {
    delete (globalThis as { __wbufTransport?: boolean }).__wbufTransport;
    delete (globalThis as { __wbufDefer?: boolean }).__wbufDefer;
});

const RING_FNS = FNS.filter((f) => f.id <= 43);
const NO_FENCE = 90;
const FENCE = 91;

/** A dispatcher in deferred mode with every ring handler registered, plus a queue-only
 *  handler for id 44 (the stand-in for a trapped setter whose fast path enqueues). */
function deferredRig() {
    (globalThis as { __wbufDefer?: boolean }).__wbufDefer = true;
    const mem = new Uint8Array(0x20000);
    const d = mkDispatcher(mem);
    const seen: Seen[] = [];
    const record = (f: Fn) => (m8: Uint8Array, m32: Uint32Array, ptr: number) => {
        const args: number[] = [];
        for (let a = 0; a < f.argCount; a++) args.push(m32[(ptr + a * 4) >> 2] >>> 0);
        seen.push({ id: f.id, args, guestView: m8 === mem });
    };
    for (const f of RING_FNS) d.registerWriteBufferFunction(f.dll, f.name, f.argCount, record(f), true, 0, { barrier: f.barrier });
    d.registerDeferredWriteBufHandler('d3d9', 'Fake_SetStream', 2, record(FNS[4]));
    d.namesTable[NO_FENCE] = 'kernel32:Sleep';
    d.namesTable[FENCE] = 'd3d9:IDirect3DDevice9_Present';
    return { d, mem, seen };
}

function ledgerOf(seq: Fn[], seed: number): Array<{ id: number; args: number[] }> {
    const mem = new Uint8Array(0x20000);
    emit(mem, seq, seed);
    const m32 = new Uint32Array(mem.buffer);
    const out: Array<{ id: number; args: number[] }> = [];
    let off = 0;
    for (const f of seq) {
        const args: number[] = [];
        for (let a = 0; a < f.argCount; a++) args.push(m32[(RING_DATA + off + 4 + a * 4) >> 2] >>> 0);
        out.push({ id: f.id, args });
        off += (f.argCount + 1) * 4;
    }
    return out;
}

const d3d9Only = (seed: number, len: number) => sequence(seed, len).filter((f) => f.dll === 'd3d9' && f.id !== 44);

describe('WBUF transport mode', () => {
    it('applies the same ledger as the in-place drain over random producer sequences', () => {
        for (let seed = 1; seed <= 200; seed++) {
            const seq = sequence(seed, 5 + (seed % 60));
            const inPlace = drain(seq, seed, false);
            const copied = drain(seq, seed, true);
            expect(copied.seen.map(({ id, args }) => ({ id, args })))
                .toEqual(inPlace.seen.map(({ id, args }) => ({ id, args })));
            expect(copied.tail).toBe(inPlace.tail);
        }
    });

    it('hands transport-safe entries the copy and every other entry the guest ring', () => {
        const seq = sequence(7, 80);
        const { seen } = drain(seq, 7, true);
        for (const e of seen) expect(e.guestView).toBe(e.id === 43);
        const inPlace = drain(seq, 7, false);
        expect(inPlace.seen.every((e) => e.guestView)).toBe(true);
    });

    it('carries exactly the pending bytes and leaves the guest entries untouched', () => {
        const seq = sequence(11, 40);
        const r = drain(seq, 11, true);
        expect(r.stats.drains).toBe(1);
        expect(r.stats.bytes).toBe(r.head);
        expect(r.mem.slice(RING_DATA, RING_DATA + r.head)).toEqual(r.ringBefore);
    });

    it('stays off unless armed', () => {
        const r = drain(sequence(3, 20), 3, false);
        expect(r.stats.drains).toBe(0);
        expect(r.seen.every((e) => e.guestView)).toBe(true);
    });

    describe('deferred execution', () => {
        it('keeps entries queued across no-fence traps and runs them in order at a fence', () => {
            const { d, mem, seen } = deferredRig();
            const a = d3d9Only(21, 30), b = d3d9Only(22, 30);
            emit(mem, a, 21);
            d.deferredTrapBoundary(NO_FENCE);
            expect(seen.length).toBe(0);
            expect(new Uint32Array(mem.buffer)[RING_CTRL >> 2]).toBe(0);
            emit(mem, b, 22);
            d.deferredTrapBoundary(NO_FENCE);
            expect(seen.length).toBe(0);
            d.deferredTrapBoundary(FENCE);
            expect(seen.map(({ id, args }) => ({ id, args }))).toEqual([...ledgerOf(a, 21), ...ledgerOf(b, 22)]);
            expect(seen.every((e) => !e.guestView)).toBe(true);
        });

        it('places a call enqueued by a trapped fast path after the ring entries that preceded it', () => {
            const { d, mem, seen } = deferredRig();
            const a = d3d9Only(31, 12), b = d3d9Only(32, 12);
            emit(mem, a, 31);
            d.deferredTrapBoundary(NO_FENCE);
            const args = new DataView(new ArrayBuffer(8));
            args.setUint32(0, 0xabcd, true);
            args.setUint32(4, 0x1234, true);
            expect(d.enqueueWriteBufCall('d3d9', 'Fake_SetStream', args, 0)).toBe(true);
            emit(mem, b, 32);
            d.deferredTrapBoundary(FENCE);
            expect(seen.map(({ id, args }) => ({ id, args }))).toEqual([
                ...ledgerOf(a, 31), { id: 44, args: [0xabcd, 0x1234] }, ...ledgerOf(b, 32),
            ]);
        });

        it('runs the queue before draining an entry whose module is not transport-safe', () => {
            const { d, mem, seen } = deferredRig();
            const a = d3d9Only(41, 10);
            const b: Fn[] = [FNS[0], FNS[3], FNS[2]];
            emit(mem, a, 41);
            d.deferredTrapBoundary(NO_FENCE);
            emit(mem, b, 42);
            d.deferredTrapBoundary(NO_FENCE);
            expect(seen.map(({ id, args }) => ({ id, args }))).toEqual([...ledgerOf(a, 41), ...ledgerOf(b, 42)]);
            expect(seen.find((e) => e.id === 43)!.guestView).toBe(true);
        });

        it('carries a payload entry: header dwords and the bytes copied at the call', () => {
            const { d, mem, seen } = deferredRig();
            const got: Array<{ header: number[]; bytes: number[] }> = [];
            d.registerDeferredWriteBufHandler('d3d9', 'Fake_Unlock', 253, (m8: Uint8Array, m32: Uint32Array, ptr: number) => {
                const n = m32[(ptr + 16) >> 2]!;
                got.push({ header: [0, 1, 2, 3].map((i) => m32[(ptr >> 2) + i]! >>> 0), bytes: Array.from(m8.subarray(ptr + 20, ptr + 20 + n)) });
            });
            const src = new Uint8Array([9, 8, 7, 6, 5, 4, 3]);
            const a = d3d9Only(51, 6);
            emit(mem, a, 51);
            d.deferredTrapBoundary(NO_FENCE);
            expect(d.enqueueWriteBufPayload('d3d9', 'Fake_Unlock', 0x11, 0x22, 0x33, 0x44, src, 0, src.length)).toBe(true);
            src.fill(0); // the call's bytes were captured when it was made
            d.deferredTrapBoundary(FENCE);
            expect(seen.map(({ id, args }) => ({ id, args }))).toEqual(ledgerOf(a, 51));
            expect(got).toEqual([{ header: [0x11, 0x22, 0x33, 0x44], bytes: [9, 8, 7, 6, 5, 4, 3] }]);
        });

        it('refuses to enqueue a call with no deferred handler', () => {
            const { d } = deferredRig();
            expect(d.enqueueWriteBufCall('d3d9', 'Fake_Unregistered', new DataView(new ArrayBuffer(8)), 0)).toBe(false);
        });

        it('classifies traps by module: kernel32 keeps the queue, d3d9 is a fence', () => {
            const { d } = deferredRig();
            expect(d.trapNeedsFence(NO_FENCE)).toBe(false);
            expect(d.trapNeedsFence(FENCE)).toBe(true);
            d.namesTable[92] = 'd3d9:Fake_SetStream';
            expect(d.trapNeedsFence(92)).toBe(false);
        });
    });
});
