/**
 * The real d3d9 ring handlers, driven from a TRANSPORT COPY of the ring.
 *
 * In transport mode a handler is handed a buffer that is not guest memory, and `ptr` is an
 * offset into that buffer. A handler that forwards `ptr` but lets the device read through its
 * own guest view (or validate `ptr` against the guest region map) reads the wrong bytes — NFSU
 * rendered a black frame that way while every ledger still matched.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';
import { devices } from '../../src/worker/modules/d3d9/shared-state';
import { System } from '../../src/worker/core/system';
import { Logger } from '../../src/worker/core/logger';

type RingHandler = (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => void;

const DEVICE = 0x5f001000;

async function ringHandlers(): Promise<Map<string, RingHandler>> {
    const { registerFastPathD3D9Functions } = await import('../../src/worker/modules/d3d9/fast-path');
    const handlers = new Map<string, RingHandler>();
    const keep = (_dll: string, name: string, ...rest: unknown[]) => {
        const fn = rest.find((r) => typeof r === 'function') as RingHandler | undefined;
        if (fn) handlers.set(name, fn);
    };
    // Every other registration is a no-op; the guest refcount stubs are declined outright, since
    // installing them pins the process-wide refcount store for every later test file.
    const dispatcher = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => {
            if (prop === 'registerStructCaptureWriteBufferFunction' || prop === 'registerUpDrawWriteBufferFunction'
                || prop === 'registerWriteBufferFunction') return keep;
            if (typeof prop !== 'string' || !prop.startsWith('register') || prop.includes('Guest')) return undefined;
            return () => undefined;
        },
    });
    registerFastPathD3D9Functions(dispatcher as never);
    return handlers;
}

/** A transport copy: a fresh buffer holding one entry at offset 0. */
function copyWith(words: number[], bytes = 256): { u8: Uint8Array; u32: Uint32Array } {
    const buffer = new ArrayBuffer(bytes);
    const u32 = new Uint32Array(buffer);
    words.forEach((w, i) => { u32[i] = w >>> 0; });
    return { u8: new Uint8Array(buffer), u32 };
}

afterEach(() => { devices.delete(DEVICE); });

describe('d3d9 ring handlers read the view they are handed', () => {
    it('SetViewport applies a D3DVIEWPORT9 captured in the copy', async () => {
        const receiver = {
            recordingStateBlock: false,
            getCurrentTargetSize: () => ({ w: 1024, h: 768 }),
            viewport: { x: 0, y: 0, width: 1024, height: 768, minZ: 0, maxZ: 1 },
            setViewport(this: unknown, p: number, m: Uint8Array, captured?: boolean) {
                return (D3D9Device.prototype as any).setViewport.call(receiver, p, m, captured);
            },
        };
        devices.set(DEVICE, receiver as never);
        const handler = (await ringHandlers()).get('IDirect3DDevice9_SetViewport');
        expect(handler).toBeDefined();

        // [this][pViewport word][x y w h minZ maxZ] — the payload rides at ptr+8.
        const { u8, u32 } = copyWith([DEVICE, 0, 16, 32, 512, 256, 0, 0]);
        new Float32Array(u32.buffer)[6] = 0;
        new Float32Array(u32.buffer)[7] = 1;
        // A guest region map, as in a running process: the low 64 KiB is never valid, which is
        // where an offset into the copy lands if it is mistaken for a guest address.
        const sys = System.getInstance() as unknown as { process: unknown };
        const saved = sys.process;
        sys.process = { addressSpace: { validateRange: (addr: number) => addr >= 0x10000 } };
        const warn = (Logger as any).warn;
        (Logger as any).warn = () => {};
        try {
            handler!(u8, u32, 0);
        } finally {
            sys.process = saved;
            (Logger as any).warn = warn;
        }

        expect(receiver.viewport).toMatchObject({ x: 16, y: 32, width: 512, height: 256, minZ: 0, maxZ: 1 });
    });

    it('DrawPrimitiveUP hands the device the view holding the captured vertices', async () => {
        const seen: unknown[][] = [];
        devices.set(DEVICE, { drawPrimitiveUP: (...args: unknown[]) => { seen.push(args); return 0; } } as never);
        const handler = (await ringHandlers()).get('IDirect3DDevice9_DrawPrimitiveUP');
        expect(handler).toBeDefined();

        // [this][type][primCount][stride][byteCount][vertex bytes...]
        const { u8, u32 } = copyWith([DEVICE, 4, 1, 12, 36]);
        handler!(u8, u32, 0);

        expect(seen).toHaveLength(1);
        expect(seen[0]!.slice(0, 4)).toEqual([4, 1, 20, 12]);
        expect(seen[0]![4]).toBe(u8);
    });
});
