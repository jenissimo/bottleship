import { afterEach, describe, expect, it } from 'bun:test';
import { devices } from '../../src/worker/modules/d3d9/shared-state';
import { d3d9StreamRingEnabled } from '../../src/worker/modules/d3d9/stream-ring';
import {
    D3DSTREAMSOURCE_INDEXEDDATA, D3DSTREAMSOURCE_INSTANCEDATA, MAX_VERTEX_STREAMS, planInstancing,
} from '../../src/worker/backends/webgpu/shared/vertex-streams';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';

type RingHandler = (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => void;
type Registration = { argCount: number; handler: RingHandler; coalesce: boolean; mask: number };

const DEVICE = 0x5f002000;
const g = globalThis as { __d3d9StreamRing?: boolean };

async function ringRegistrations(): Promise<Map<string, Registration>> {
    const { registerFastPathD3D9Functions } = await import('../../src/worker/modules/d3d9/fast-path');
    const out = new Map<string, Registration>();
    const keep = (_dll: string, name: string, argCount: number, handler: RingHandler, coalesce: boolean, mask: number) => {
        out.set(name, { argCount, handler, coalesce, mask });
    };
    const dispatcher = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => {
            if (prop === 'registerWriteBufferFunction') return keep;
            if (typeof prop !== 'string' || !prop.startsWith('register') || prop.includes('Guest')) return undefined;
            return () => undefined;
        },
    });
    registerFastPathD3D9Functions(dispatcher as never);
    return out;
}

type FastPath = (esp: number, view: DataView) => number;

async function freqFastPath(deferring: boolean, enqueued: number[][] = []): Promise<FastPath> {
    const { registerFastPathD3D9Functions } = await import('../../src/worker/modules/d3d9/fast-path');
    let fast: FastPath | null = null;
    const dispatcher = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => {
            if (prop === 'registerFastPath') return (_d: string, name: string, h: FastPath) => {
                if (name === 'IDirect3DDevice9_SetStreamSourceFreq') fast = h;
            };
            if (prop === 'wbufDeferring') return () => deferring;
            if (prop === 'enqueueWriteBufCall') return (_d: string, name: string, view: DataView, at: number) => {
                enqueued.push([name === 'IDirect3DDevice9_SetStreamSourceFreq' ? 1 : 0, view.getUint32(at + 4, true), view.getUint32(at + 8, true)]);
                return true;
            };
            if (typeof prop !== 'string' || !prop.startsWith('register') || prop.includes('Guest')) return undefined;
            return () => undefined;
        },
    });
    registerFastPathD3D9Functions(dispatcher as never);
    return fast!;
}

function callFreq(fast: FastPath, device: number, stream: number, setting: number): number {
    const view = new DataView(new ArrayBuffer(32));
    [0, device, stream, setting].forEach((w, i) => view.setUint32(i * 4, w >>> 0, true));
    return fast(0, view);
}

function copyWith(words: number[]): { u8: Uint8Array; u32: Uint32Array } {
    const buffer = new ArrayBuffer(256);
    const u32 = new Uint32Array(buffer);
    words.forEach((w, i) => { u32[i] = w >>> 0; });
    return { u8: new Uint8Array(buffer), u32 };
}

afterEach(() => {
    delete g.__d3d9StreamRing;
    devices.delete(DEVICE);
});

describe('d3d9 stream ring', () => {
    it('is on unless the flag is explicitly false', () => {
        expect(d3d9StreamRingEnabled()).toBe(true);
        g.__d3d9StreamRing = true;
        expect(d3d9StreamRingEnabled()).toBe(true);
        g.__d3d9StreamRing = false;
        expect(d3d9StreamRingEnabled()).toBe(false);
    });

    it('registers SetStreamSource and SetIndices on the ring by default, coalescing per stream / per device', async () => {
        const regs = await ringRegistrations();
        const stream = regs.get('IDirect3DDevice9_SetStreamSource');
        const indices = regs.get('IDirect3DDevice9_SetIndices');
        expect(stream).toBeDefined();
        expect(indices).toBeDefined();
        expect([stream!.argCount, stream!.coalesce, stream!.mask]).toEqual([5, true, 0x3]);
        expect([indices!.argCount, indices!.coalesce, indices!.mask]).toEqual([2, true, 0x1]);
    });

    it('leaves both as trapping calls when opted out', async () => {
        g.__d3d9StreamRing = false;
        const regs = await ringRegistrations();
        expect(regs.has('IDirect3DDevice9_SetStreamSource')).toBe(false);
        expect(regs.has('IDirect3DDevice9_SetIndices')).toBe(false);
        expect(regs.has('IDirect3DDevice9_SetVertexDeclaration')).toBe(true);
    });

    it('applies entries to the owning device in ring order, from the view it is handed', async () => {
        const seen: string[] = [];
        devices.set(DEVICE, {
            setStreamSource: (n: number, vb: number, off: number, stride: number) => { seen.push(`ss ${n} ${vb} ${off} ${stride}`); },
            setIndices: (ib: number) => { seen.push(`ix ${ib}`); },
        } as never);
        const regs = await ringRegistrations();
        const stream = regs.get('IDirect3DDevice9_SetStreamSource')!.handler;
        const indices = regs.get('IDirect3DDevice9_SetIndices')!.handler;

        const a = copyWith([0, 0, DEVICE, 1, 0x7000, 64, 32]);
        stream(a.u8, a.u32, 8);
        const b = copyWith([DEVICE, 0x8000]);
        indices(b.u8, b.u32, 0);
        const c = copyWith([DEVICE, 1, 0, 0, 0]);
        stream(c.u8, c.u32, 0);
        expect(seen).toEqual(['ss 1 28672 64 32', 'ix 32768', 'ss 1 0 0 0']);
    });

    it('drops an entry whose device is gone instead of throwing', async () => {
        const regs = await ringRegistrations();
        const a = copyWith([DEVICE, 0, 0x7000, 0, 32]);
        expect(() => regs.get('IDirect3DDevice9_SetStreamSource')!.handler(a.u8, a.u32, 0)).not.toThrow();
        expect(() => regs.get('IDirect3DDevice9_SetIndices')!.handler(a.u8, a.u32, 0)).not.toThrow();
    });

    it('registers SetStreamSourceFreq on the ring by default, coalescing per stream, and not when opted out', async () => {
        const freq = (await ringRegistrations()).get('IDirect3DDevice9_SetStreamSourceFreq');
        expect(freq).toBeDefined();
        expect([freq!.argCount, freq!.coalesce, freq!.mask]).toEqual([3, true, 0x3]);
        g.__d3d9StreamRing = false;
        expect((await ringRegistrations()).has('IDirect3DDevice9_SetStreamSourceFreq')).toBe(false);
    });

    it('applies a divider between a buffered stream binding and the draw that reads it, in ring order', async () => {
        const freqs = new Uint32Array(MAX_VERTEX_STREAMS).fill(1);
        const seen: string[] = [];
        devices.set(DEVICE, {
            setStreamSource: (n: number) => { seen.push(`ss ${n}`); },
            setStreamSourceFreq: (n: number, v: number) => { freqs[n] = v; seen.push(`freq ${n}`); return 0; },
            drawIndexedPrimitive: () => { seen.push(`draw x${planInstancing(freqs, 0b11).instanceCount}`); },
        } as never);
        const regs = await ringRegistrations();
        const run = (name: string, words: number[]) => {
            const c = copyWith(words);
            regs.get(name)!.handler(c.u8, c.u32, 0);
        };
        run('IDirect3DDevice9_SetStreamSource', [DEVICE, 0, 0x7000, 0, 32]);
        run('IDirect3DDevice9_SetStreamSourceFreq', [DEVICE, 0, D3DSTREAMSOURCE_INDEXEDDATA | 64]);
        run('IDirect3DDevice9_SetStreamSourceFreq', [DEVICE, 1, D3DSTREAMSOURCE_INSTANCEDATA | 1]);
        run('IDirect3DDevice9_DrawIndexedPrimitive', [DEVICE, 4, 0, 0, 10, 0, 5]);
        run('IDirect3DDevice9_SetStreamSourceFreq', [DEVICE, 0, 1]);
        run('IDirect3DDevice9_SetStreamSourceFreq', [DEVICE, 1, 1]);
        run('IDirect3DDevice9_DrawIndexedPrimitive', [DEVICE, 4, 0, 0, 10, 0, 5]);
        expect(seen).toEqual(['ss 0', 'freq 0', 'freq 1', 'draw x64', 'freq 0', 'freq 1', 'draw x1']);
    });

    it('drops a ring entry whose device is gone instead of throwing', async () => {
        const regs = await ringRegistrations();
        const a = copyWith([DEVICE, 0, D3DSTREAMSOURCE_INDEXEDDATA | 2]);
        expect(() => regs.get('IDirect3DDevice9_SetStreamSourceFreq')!.handler(a.u8, a.u32, 0)).not.toThrow();
    });
});

function freqOnlyDevice(): D3D9Device {
    return Object.assign(Object.create(D3D9Device.prototype), {
        streams: { freq: new Uint32Array(MAX_VERTEX_STREAMS).fill(1) },
        suppressStateBlockRecording: false,
        stateBlockRecorder: { isRecording: () => false },
    });
}

describe('d3d9 SetStreamSourceFreq fast path', () => {
    const settings = [
        1, 2, 0, D3DSTREAMSOURCE_INDEXEDDATA | 64, D3DSTREAMSOURCE_INSTANCEDATA | 1, D3DSTREAMSOURCE_INDEXEDDATA,
        D3DSTREAMSOURCE_INSTANCEDATA, D3DSTREAMSOURCE_INDEXEDDATA | D3DSTREAMSOURCE_INSTANCEDATA | 1, 0xffffffff,
    ];
    const streams = [0, 1, 15, 16, 17, 0xffffffff];

    it('answers every stream/setting pair like the device, in immediate and in deferred mode', async () => {
        const device = freqOnlyDevice();
        devices.set(DEVICE, device as never);
        const immediate = await freqFastPath(false);
        const deferred = await freqFastPath(true);
        for (const stream of streams) {
            for (const setting of settings) {
                const slow = device.setStreamSourceFreq(stream, setting);
                const before = device.getStreamSourceFreq(stream);
                const direct = callFreq(immediate, DEVICE, stream, setting);
                expect({ stream, setting, direct }).toEqual({ stream, setting, direct: slow });
                expect(device.getStreamSourceFreq(stream)).toBe(slow === 0 ? setting >>> 0 : before);
                const queued = callFreq(deferred, DEVICE, stream, setting);
                expect({ stream, setting, queued }).toEqual({ stream, setting, queued: slow });
            }
        }
    });

    it('reads the divider back after an immediate call and defers only valid calls', async () => {
        const device = freqOnlyDevice();
        devices.set(DEVICE, device as never);
        const value = D3DSTREAMSOURCE_INSTANCEDATA | 1;
        expect(callFreq(await freqFastPath(false), DEVICE, 1, value)).toBe(0);
        expect(device.getStreamSourceFreq(1)).toBe(value >>> 0);

        const enqueued: number[][] = [];
        const deferred = await freqFastPath(true, enqueued);
        expect(callFreq(deferred, DEVICE, 3, D3DSTREAMSOURCE_INDEXEDDATA | 8)).toBe(0);
        expect(callFreq(deferred, DEVICE, 16, 2)).toBe(0x8876086c);
        expect(callFreq(deferred, DEVICE, 3, 0)).toBe(0x8876086c);
        expect(enqueued).toEqual([[1, 3, D3DSTREAMSOURCE_INDEXEDDATA | 8]]);
        expect(device.getStreamSourceFreq(3)).toBe(1);
    });

    it('answers an unknown device with D3DERR_INVALIDCALL when not deferring', async () => {
        expect(callFreq(await freqFastPath(false), 0x1234, 0, 2)).toBe(0x8876086c);
    });
});
