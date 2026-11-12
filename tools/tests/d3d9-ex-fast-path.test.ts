/**
 * IDirect3DDevice9Ex gets the base device's fast paths and WBUF trampolines.
 *
 * The Ex vtable is a separate set of thunk stubs (`IDirect3DDevice9Ex_*`), and every fast path
 * and ring trampoline is registered by exact stub name. Half-Life 2 creates an Ex device, and
 * ~3300 calls a frame (SetStreamSource, SetTexture, the shader constants, DrawIndexedPrimitive,
 * ...) took the slow JS path while the identical calls of a non-Ex title never trapped.
 *
 * Pinned here:
 *  - the Ex pass registers exactly the base pass's device/factory registrations, under the Ex
 *    names, with the same kind, arity, coalesce mask, shadow spec and handler code, and nothing
 *    that belongs to another interface or to the process;
 *  - every Ex method it covers is a PURE forwarder in ex.ts (an Ex override would make the fast
 *    path answer differently from the slow path);
 *  - on a real dispatcher the Ex stubs are untouched until an Ex device exists, and afterwards
 *    carry fast paths and patched stubs, and a ring entry tagged with an Ex stub's id executes
 *    on the front AND decodes on the split render twin, which rebuilds its table by name.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';
import { devices, beginD3D9SplitReplay, endD3D9SplitReplay } from '../../src/worker/modules/d3d9/shared-state';
import { IDirect3D9, IDirect3D9Ex, IDirect3DDevice9, IDirect3DDevice9Ex } from '../../src/worker/api/d3d9.api';
import { walkSplitQueue, type QueueHandler } from '../../src/worker/render/split-queue-walk';

type AnyFn = (...args: any[]) => any;
interface Call { method: string; name: string; args: unknown[] }

const D3D_OK = 0;
const DEVICE = 0x5f002000;

/** Records every dispatcher registration; declines the guest refcount stubs (installing them
 *  pins the process-wide refcount store for every later test file). */
function recordingDispatcher(): { dispatcher: Record<string, unknown>; calls: Call[] } {
    const calls: Call[] = [];
    const dispatcher = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => {
            if (typeof prop !== 'string') return undefined;
            if (prop.includes('Guest') || prop.includes('IncRef')) return undefined;
            if (prop === 'wbufDeferring') return () => false;
            if (prop === 'registerWriteBufferPairRun') {
                return (d1: string, n1: string, d2: string, n2: string, handler: AnyFn) =>
                    calls.push({ method: prop, name: `${n1}+${n2}`, args: [d1, d2, handler] });
            }
            if (prop.startsWith('register')) {
                return (dll: string, name: string, ...rest: unknown[]) => calls.push({ method: prop, name, args: [dll, ...rest] });
            }
            return () => undefined;
        },
    });
    return { dispatcher, calls };
}

const exName = (name: string): string => name
    .replace(/^IDirect3DDevice9_/, 'IDirect3DDevice9Ex_')
    .replace(/^IDirect3D9_/, 'IDirect3D9Ex_')
    .replace(/\+IDirect3DDevice9_/, '+IDirect3DDevice9Ex_');
const inherited = (c: Call): boolean => /^(IDirect3DDevice9|IDirect3D9)_/.test(c.name)
    && c.method !== 'registerDeferredWriteBufHandler';
/** Same registration modulo the handler closures: same non-function args, same handler code. */
const shape = (c: Call) => ({
    method: c.method,
    args: c.args.map((a) => (typeof a === 'function' ? `fn:${a.toString()}` : a)),
});

async function passes() {
    const fp = await import('../../src/worker/modules/d3d9/fast-path');
    const base = recordingDispatcher();
    fp.registerFastPathD3D9Functions(base.dispatcher as never);
    const ex = recordingDispatcher();
    expect(fp.registerD3D9ExInheritedFastPaths(ex.dispatcher as never)).toBe(true);
    // Once per dispatcher: the pending-registration maps carry it across Process.reset().
    expect(fp.registerD3D9ExInheritedFastPaths(ex.dispatcher as never)).toBe(false);
    return { base: base.calls, ex: ex.calls };
}

afterEach(() => {
    devices.delete(DEVICE);
    delete (globalThis as { __noSetterShadow?: boolean }).__noSetterShadow;
});

describe('the Ex inherited pass mirrors the base registrations', () => {
    it('registers every base device/factory path under the Ex name, and nothing else', async () => {
        const { base, ex } = await passes();
        const expected = base.filter(inherited);
        expect(expected.length).toBeGreaterThan(40);
        expect(ex.map((c) => c.name)).toEqual(expected.map((c) => exName(c.name)));
        for (let i = 0; i < expected.length; i++) {
            expect({ name: ex[i]!.name, ...shape(ex[i]!) }).toEqual({ name: exName(expected[i]!.name), ...shape(expected[i]!) });
        }
        // The hot HL2 set is all there: fast path AND a ring trampoline.
        const has = (method: string, name: string) => ex.some((c) => c.method === method && c.name === name);
        for (const m of ['SetStreamSource', 'SetTexture', 'SetVertexShaderConstantF', 'SetPixelShaderConstantF',
            'DrawIndexedPrimitive', 'SetRenderState', 'SetSamplerState', 'SetIndices', 'SetPixelShader',
            'SetVertexShader', 'SetVertexDeclaration', 'SetStreamSourceFreq']) {
            expect(has('registerFastPath', `IDirect3DDevice9Ex_${m}`)).toBe(true);
        }
        for (const m of ['SetTexture', 'DrawIndexedPrimitive', 'SetVertexDeclaration', 'SetPixelShader', 'SetVertexShader',
            'SetStreamSource', 'SetIndices', 'SetStreamSourceFreq']) {
            expect(has('registerWriteBufferFunction', `IDirect3DDevice9Ex_${m}`)).toBe(true);
        }
        expect(has('registerShadowedWriteBufferFunction', 'IDirect3DDevice9Ex_SetRenderState')).toBe(true);
        expect(has('registerShadowedWriteBufferFunction', 'IDirect3DDevice9Ex_SetSamplerState')).toBe(true);
        expect(has('registerShaderConstantWriteBufferFunction', 'IDirect3DDevice9Ex_SetVertexShaderConstantF')).toBe(true);
        expect(has('registerShaderConstantWriteBufferFunction', 'IDirect3DDevice9Ex_SetPixelShaderConstantF')).toBe(true);
        expect(has('registerWriteBufferPairRun', 'IDirect3DDevice9Ex_SetVertexShaderConstantF+IDirect3DDevice9Ex_DrawIndexedPrimitive')).toBe(true);
        // Never in the Ex pass: other interfaces, process-wide stubs, the BASE-keyed deferred queue.
        expect(ex.some((c) => !/^IDirect3D(Device)?9Ex_/.test(c.name))).toBe(false);
        expect(ex.some((c) => c.method === 'registerDeferredWriteBufHandler' || c.method === 'registerConstantReturnStub')).toBe(false);
    });

    it('the Ex vtable prefix is the base method list, so every inherited stub has the base arity', () => {
        expect(IDirect3DDevice9Ex.methods.slice(0, IDirect3DDevice9.methods.length)).toEqual(IDirect3DDevice9.methods);
        expect(IDirect3D9Ex.methods.slice(0, IDirect3D9.methods.length)).toEqual(IDirect3D9.methods);
    });

    it('every Ex method the pass covers is a pure forwarder in ex.ts', async () => {
        const { ex } = await passes();
        const { createExExports } = await import('../../src/worker/modules/d3d9/ex');
        const seen: Array<[string, number[]]> = [];
        const baseHandlers: Record<string, AnyFn> = new Proxy({}, {
            get: (_t, prop) => (typeof prop === 'string'
                ? (_ctx: unknown, _mem: unknown, args: number[]) => { seen.push([prop, args]); return 0x1234; }
                : undefined),
        });
        const exports = createExExports(baseHandlers as never);
        const names = new Set(ex.flatMap((c) => c.name.split('+')));
        expect(names.size).toBeGreaterThan(20);
        for (const name of names) {
            seen.length = 0;
            const args = [DEVICE, 1, 2, 3, 4, 5, 6, 7];
            const result = (exports[name] as AnyFn)({}, new Uint8Array(16), args);
            const baseName = name.replace('IDirect3DDevice9Ex_', 'IDirect3DDevice9_').replace('IDirect3D9Ex_', 'IDirect3D9_');
            expect({ name, result, seen }).toEqual({ name, result: 0x1234, seen: [[baseName, args]] });
        }
    });
});

describe('the Ex setter shadows stay in lock-step with the base ones', () => {
    // The Ex shadowed setters get their own guest shadow tables; every JS write-back and
    // re-sentinel that reaches a base table must reach the Ex table too, or an Ex guest call
    // compares against a stale slot and skips a set the device needs (state-block Apply,
    // BeginStateBlock recording and Reset all change state without the trampoline).
    it('syncSetterShadow and resetSetterShadows name both tables', async () => {
        const { D3D9Device } = await import('../../src/worker/backends/webgpu/d3d9/d3d9-device');
        const writes: Array<[string, number, number]> = [];
        const resets: string[] = [];
        const self = {
            role: 'both',
            shadowSyncDispatcher: {
                writeShadowSlot: (_d: string, fn: string, slot: number, value: number) => { writes.push([fn, slot, value]); },
                resetShadow: (_d: string, fn: string) => { resets.push(fn); },
            },
        };
        (D3D9Device.prototype as any).syncSetterShadow.call(self, 'IDirect3DDevice9_SetRenderState', 7, 1);
        expect(writes).toEqual([['IDirect3DDevice9_SetRenderState', 7, 1], ['IDirect3DDevice9Ex_SetRenderState', 7, 1]]);
        (D3D9Device.prototype as any).resetSetterShadows.call(self);
        for (const m of ['SetRenderState', 'SetSamplerState', 'SetTexture', 'SetVertexShader', 'SetPixelShader']) {
            expect(resets).toContain(`IDirect3DDevice9_${m}`);
            expect(resets).toContain(`IDirect3DDevice9Ex_${m}`);
        }
    });

    it('every shadowed registration of the Ex pass has its base name in D3D9EX_SHADOWED_SETTERS', async () => {
        const { D3D9EX_SHADOWED_SETTERS } = await import('../../src/worker/modules/d3d9/shared-state');
        (globalThis as { __d3d9PtrShadow?: boolean }).__d3d9PtrShadow = true;
        try {
            const { ex } = await passes();
            const shadowed = ex.filter((c) => c.method === 'registerShadowedWriteBufferFunction').map((c) => c.name);
            expect(shadowed.length).toBe(5);
            expect(shadowed.sort()).toEqual(Object.values(D3D9EX_SHADOWED_SETTERS).sort());
            for (const [base, exFn] of Object.entries(D3D9EX_SHADOWED_SETTERS)) expect(exName(base)).toBe(exFn);
        } finally {
            delete (globalThis as { __d3d9PtrShadow?: boolean }).__d3d9PtrShadow;
        }
    });
});

// ── A real dispatcher, base + Ex stubs ──────────────────────────────────────────────
const RING_CTRL = 0x3000;
const RING_DATA = 0x4000;
const RING_CAP = 0x8000;

const STUBS = [
    { id: 60, name: 'IDirect3DDevice9_SetTexture', argCount: 3 },
    { id: 61, name: 'IDirect3DDevice9_DrawIndexedPrimitive', argCount: 7 },
    { id: 62, name: 'IDirect3DDevice9_SetRenderState', argCount: 3 },
    { id: 160, name: 'IDirect3DDevice9Ex_SetTexture', argCount: 3 },
    { id: 161, name: 'IDirect3DDevice9Ex_DrawIndexedPrimitive', argCount: 7 },
    { id: 162, name: 'IDirect3DDevice9Ex_SetRenderState', argCount: 3 },
] as const;
const stubAddr = (i: number) => 0x1000 + i * 0x10;

function realDispatcher(mem: Uint8Array): any {
    const stubs = STUBS.map((s, i) => ({
        dllName: 'd3d9', functionName: s.name, functionId: s.id,
        address: stubAddr(i), argCount: s.argCount, stackCleanupBytes: s.argCount * 4,
    }));
    const generator = {
        findStubsByName: (dll: string, fn: string) => stubs.filter((s) =>
            s.dllName === dll.toLowerCase() && s.functionName.toLowerCase() === fn.toLowerCase()),
        getAllStubs: () => stubs,
        getStubById: (id: number) => stubs.find((s) => s.functionId === id),
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
    // Every export has its slow-path handler, as the module registration gives it: this is
    // what names the stub ids for the split twin.
    for (const s of STUBS) d.register('d3d9', s.name, () => D3D_OK);
    return d;
}

/** The real dispatcher, minus the guest refcount stubs (see recordingDispatcher). */
function withoutGuestStubs(d: any): any {
    return new Proxy(d, {
        get: (t, prop) => {
            if (typeof prop === 'string' && (prop.includes('Guest') || prop.includes('IncRef'))) return undefined;
            const v = t[prop];
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}

function fakeDevice() {
    const log: Array<[string, string, number[]]> = [];
    const make = (who: string) => ({
        setTexture: (...a: number[]) => { log.push([who, 'setTexture', a]); return D3D_OK; },
        drawIndexedPrimitive: (...a: number[]) => { log.push([who, 'drawIndexedPrimitive', a]); return D3D_OK; },
        setRenderState: (...a: number[]) => { log.push([who, 'setRenderState', a]); return D3D_OK; },
    });
    const front = { ...make('front'), renderTwin: make('twin') };
    return { front, log };
}

describe('a real dispatcher binds the Ex stubs only once an Ex device exists', () => {
    it('Ex stubs: untouched by the base pass; fast path + patched stub + ring entry on front and twin after', async () => {
        (globalThis as { __noSetterShadow?: boolean }).__noSetterShadow = true;
        const fp = await import('../../src/worker/modules/d3d9/fast-path');
        const mem = new Uint8Array(0x20000);
        const d = realDispatcher(mem);
        const view = withoutGuestStubs(d);
        fp.registerFastPathD3D9Functions(view);

        // A title without an Ex device keeps exactly the base registration set.
        for (const [i, s] of STUBS.entries()) {
            const ex = s.name.startsWith('IDirect3DDevice9Ex_');
            expect({ name: s.name, fast: !!d.fastPathTable[s.id], ring: !!d.writeBufHandlerTable[s.id], patched: mem[stubAddr(i) + 5] === 0xE9 })
                .toEqual({ name: s.name, fast: !ex, ring: !ex, patched: !ex });
        }

        expect(fp.registerD3D9ExInheritedFastPaths(view)).toBe(true);
        for (const [i, s] of STUBS.entries()) {
            const baseId = s.id % 100;
            expect({
                name: s.name, fast: !!d.fastPathTable[s.id], trivial: d.trivialFastPathTable[s.id],
                ring: !!d.writeBufHandlerTable[s.id], argCount: d.writeBufArgCountTable[s.id],
                barrier: d.writeBufBarrierTable[s.id], patched: mem[stubAddr(i) + 5] === 0xE9,
            }).toEqual({
                name: s.name, fast: true, trivial: d.trivialFastPathTable[baseId],
                ring: true, argCount: d.writeBufArgCountTable[baseId],
                barrier: d.writeBufBarrierTable[baseId], patched: true,
            });
        }

        const { front, log } = fakeDevice();
        devices.set(DEVICE, front as never);

        // Fast path through the Ex stub's id (ring-overflow fallback): same answer, same device call.
        const esp = 0x8000;
        const dv = new DataView(mem.buffer);
        [0xdead, DEVICE, 7, 1].forEach((w, i) => dv.setUint32(esp + i * 4, w, true));
        expect(d.fastPathTable[162](esp, dv, mem)).toBe(D3D_OK);
        expect(log).toEqual([['front', 'setRenderState', [7, 1]]]);
        log.length = 0;

        // Ring entries tagged with Ex stub ids, in program order, drained on the front.
        const entries = [
            [160, DEVICE, 0, 0xabc0],
            [161, DEVICE, 4, -2 >>> 0, 0, 100, 30, 10],
            [162, DEVICE, 27, 1],
        ];
        const words = entries.flat();
        const m32 = new Uint32Array(mem.buffer);
        words.forEach((w, i) => { m32[(RING_DATA >> 2) + i] = w >>> 0; });
        m32[RING_CTRL >> 2] = words.length * 4;
        d.drainWriteBuffer();
        const expectedCalls = [
            ['setTexture', [0, 0xabc0]],
            ['drawIndexedPrimitive', [4, -2, 0, 100, 30, 10]],
            ['setRenderState', [27, 1]],
        ];
        expect(log).toEqual(expectedCalls.map(([m, a]) => ['front', m, a]));
        log.length = 0;

        // The split twin: it rebuilds its handler table by NAME from the same registration
        // function (d3d9-render-worker captureRingHandlers), under split replay, and the front
        // describes its ring ids with the stub's own name.
        const handlersByName = new Map<string, QueueHandler>();
        const ringRegs = new Set(['registerWriteBufferFunction', 'registerShadowedWriteBufferFunction',
            'registerStructCaptureWriteBufferFunction', 'registerShaderConstantWriteBufferFunction',
            'registerUpDrawWriteBufferFunction', 'registerOwnerDisarmWriteBufferFunction', 'registerDeferredWriteBufHandler']);
        const twinDispatcher = new Proxy({} as Record<string, unknown>, {
            get: (_t, prop) => {
                if (typeof prop !== 'string') return undefined;
                if (ringRegs.has(prop)) {
                    return (dll: string, name: string, ...rest: unknown[]) => {
                        const h = rest.find((r) => typeof r === 'function') as QueueHandler | undefined;
                        if (h) handlersByName.set(`${dll.toLowerCase()}:${name}`, h);
                    };
                }
                if (prop.includes('Guest') || prop.includes('IncRef')) return undefined;
                if (prop === 'wbufDeferring') return () => false;
                return () => undefined;
            },
        });
        const table = d.describeTransportSafeHandlers().entries as Array<[number, string, number]>;
        for (const id of [160, 161, 162]) expect(table.some(([tid]) => tid === id)).toBe(true);
        beginD3D9SplitReplay();
        try {
            fp.registerFastPathD3D9Functions(twinDispatcher as never);
            const handlers: Array<QueueHandler | null> = new Array(200).fill(null);
            const argCounts = new Int32Array(200);
            for (const [id, name, argCount] of table) {
                const sep = name.indexOf(':');
                const h = handlersByName.get(`${name.slice(0, sep).toLowerCase()}:${name.slice(sep + 1)}`);
                if (!h) continue;
                handlers[id] = h;
                argCounts[id] = argCount;
            }
            const q = new Uint32Array(words.map((w) => w >>> 0));
            const walked = walkSplitQueue(new Uint8Array(q.buffer), q, q.byteLength, handlers, argCounts, 199, () => { });
            expect(walked).toMatchObject({ entries: 3, unknown: 0, malformedAt: -1, handlerThrows: 0 });
        } finally {
            endD3D9SplitReplay();
        }
        expect(log).toEqual(expectedCalls.map(([m, a]) => ['twin', m, a]));
    });
});
