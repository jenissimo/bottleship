import { afterEach, describe, expect, it } from 'bun:test';
import { devices } from '../../src/worker/modules/d3d9/shared-state';
import { d3d9StreamRingEnabled } from '../../src/worker/modules/d3d9/stream-ring';

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
});
