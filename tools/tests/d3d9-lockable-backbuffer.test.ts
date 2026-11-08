import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createComObject, devices, resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";
import {
    defaultPresentationParameters9,
    normalizePresentationParameters9,
    writePresentationParameters9,
} from "../../src/worker/backends/webgpu/d3d9/presentation";
import {
    createSwapChainExports,
    registerImplicitSwapChain,
    resetSwapChainRegistry,
} from "../../src/worker/modules/d3d9/swapchain";
import { createResourcesExports } from "../../src/worker/modules/d3d9/resources";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DLOCK_READONLY = 0x10;
const PARAMS = 0x800;
const OUT = 0x900;
const LOCKED = 0x920;
const BITS = 0x4000;

describe("D3D9 lockable back buffer", () => {
    let mem: Uint8Array;
    let originalProcess: unknown;
    let swap: Record<string, any>;
    let res: Record<string, any>;
    let devicePtr: number;
    let copies: Array<{ from: string; to: string }>;
    let unlocks: Array<{ texture: number; readOnly: boolean }>;
    let created: number[];

    const endpoint = (e: { texturePtr: number } | null) => e ? `tex:${e.texturePtr}` : "backbuffer";
    const fakeDevice = {
        isExtended: false,
        supportsD3D9MultisampleType: (type: number) => type === 0,
        resetSubsystemPerf: () => {},
        createTexture: (ptr: number) => { created.push(ptr); return ptr; },
        stretchRect: (src: { texturePtr: number } | null, dst: { texturePtr: number } | null) => {
            copies.push({ from: endpoint(src), to: endpoint(dst) });
            return Promise.resolve(true);
        },
        textureReadbackForLock: () => null,
        isRenderTargetTexture: () => true,
        lockTexture: () => ({ ptr: BITS, pitch: 64 * 4 }),
        unlockTexture: (texture: number, _level: number, _mem: Uint8Array, opts: { readOnly: boolean }) => {
            unlocks.push({ texture, readOnly: opts.readOnly });
        },
        releaseTexture: () => {},
        deleteTexture: () => {},
    } as any;

    const backBuffer = (flags: number): number => {
        writePresentationParameters9(mem, PARAMS, normalizePresentationParameters9({
            ...defaultPresentationParameters9(),
            windowed: true,
            backBufferWidth: 64,
            backBufferHeight: 32,
            backBufferFormat: 22,
            flags,
        }));
        const chainPtr = registerImplicitSwapChain(devicePtr, mem, PARAMS);
        expect(swap.IDirect3DSwapChain9_GetBackBuffer({}, mem, [chainPtr, 0, 0, OUT])).toBe(D3D_OK);
        return new DataView(mem.buffer).getUint32(OUT, true);
    };
    const lock = (surface: number, flags = 0) => res.IDirect3DSurface9_LockRect({ esp: 0 }, mem, [surface, LOCKED, 0, flags]);
    const unlock = (surface: number) => res.IDirect3DSurface9_UnlockRect({ esp: 0 }, mem, [surface]);

    beforeEach(() => {
        const system = System.getInstance() as any;
        originalProcess = system.process;
        mem = new Uint8Array(0x200000);
        let next = 0x1f0000;
        const thunkGenerator = new ThunkGenerator();
        thunkGenerator.setBaseAddress(0x10000);
        system.process = {
            memory: {
                alloc: (size: number) => { const ptr = next; next += Math.max(4, size); return ptr; },
                allocAt: () => undefined,
                allocSystemBlock: (size: number) => { const ptr = next; next += Math.max(16, size); return ptr; },
                free: () => undefined,
                freeSystemBlock: () => {},
            },
            dispatcher: { registerModule: () => undefined, applyPendingRegistrations: () => undefined },
            thunkGenerator,
            addressSpace: { validateRange: (address: number, size: number) => address >= 0 && address + size <= mem.length },
            getCurrentMemory: () => mem,
        };
        Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
        resetD3D9SharedState();
        resetSwapChainRegistry();
        swap = createSwapChainExports();
        res = createResourcesExports();
        devicePtr = createComObject(0x1111);
        devices.set(devicePtr, fakeDevice);
        copies = [];
        unlocks = [];
        created = [];
    });

    afterEach(() => {
        resetSwapChainRegistry();
        resetD3D9SharedState();
        System.getInstance().process = originalProcess as any;
    });

    test("a back buffer created without D3DPRESENTFLAG_LOCKABLE_BACKBUFFER refuses LockRect", () => {
        const surface = backBuffer(0);
        expect(lock(surface)).toBe(D3DERR_INVALIDCALL);
        expect(copies).toEqual([]);
    });

    test("LockRect reads the back buffer into CPU bits and UnlockRect writes them back", async () => {
        const surface = backBuffer(1);
        expect(await lock(surface)).toBe(D3D_OK);
        expect(created.length).toBe(1);
        const shadow = `tex:${created[0]}`;
        expect(copies).toEqual([{ from: "backbuffer", to: shadow }]);
        const view = new DataView(mem.buffer);
        expect(view.getUint32(LOCKED, true)).toBe(256);
        expect(view.getUint32(LOCKED + 4, true)).toBe(BITS);
        expect(await lock(surface)).toBe(D3DERR_INVALIDCALL);

        expect(await unlock(surface)).toBe(D3D_OK);
        expect(unlocks).toEqual([{ texture: created[0]!, readOnly: false }]);
        expect(copies).toEqual([{ from: "backbuffer", to: shadow }, { from: shadow, to: "backbuffer" }]);
        expect(await unlock(surface)).toBe(D3DERR_INVALIDCALL);
    });

    test("a READONLY lock does not write the bits back", async () => {
        const surface = backBuffer(1);
        expect(await lock(surface, D3DLOCK_READONLY)).toBe(D3D_OK);
        expect(await unlock(surface)).toBe(D3D_OK);
        expect(copies.map((c) => c.to)).toEqual([`tex:${created[0]}`]);
        expect(unlocks[0]?.readOnly).toBe(true);
    });
});
