/**
 * CreateSurface refuses what the advertised hardware cannot do: an overlay without
 * DDCAPS_OVERLAY, and a FourCC that GetFourCCCodes does not list. A movie player probes
 * exactly these and blits RGB itself once the create fails; a DD_OK here commits it to a
 * plane nothing ever shows.
 *
 * The FourCC refusal and GetFourCCCodes read ONE support set, so the two APIs cannot
 * disagree about a code: what is enumerated can be created, what is not is refused.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { createDirectDrawExports } from "../../src/worker/modules/ddraw/directdraw";
import {
    DDERR_INVALIDPIXELFORMAT, DDERR_NOOVERLAYHW,
    DDSCAPS_OFFSCREENPLAIN, DDSCAPS_OVERLAY, DDSCAPS_SYSTEMMEMORY, DDSCAPS_TEXTURE, DDSCAPS_VIDEOMEMORY,
    DDSD_CAPS, DDSD_HEIGHT, DDSD_WIDTH, DDSD_PIXELFORMAT, DDPF_FOURCC,
    DDSURFACEDESC2_OFFSETS, DDPIXELFORMAT_OFFSETS, SUPPORTED_FOURCC_CODES,
} from "../../src/worker/modules/ddraw/constants";

const fourCC = (s: string): number =>
    (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;

const DESC = 0x11000;
const OUT = 0x12000;
const CODES = 0x13000;

let mem: Uint8Array;
let view: DataView;
let dd: ReturnType<typeof createDirectDrawExports>;
let created: any[];
let restore: Array<() => void>;

beforeEach(() => {
    mem = new Uint8Array(0x40000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    created = [];
    const objects = new Map<number, unknown>();
    let nextBlock = 0x18000, nextSurface = 0x20000, nextHandle = 1;
    const context: any = {
        display: { width: 640, height: 480, bpp: 16 },
        vtables: { IDirectDrawSurface7: { address: 0x3000 } },
        surfaces: {},
        usedVidMem: 0,
        process: {
            memory: { allocSystemBlock(size: number) { const p = nextBlock; nextBlock += size; return p; } },
            allocateSurface(size: number) { const p = nextSurface; nextSurface += size; return p; },
            getModule: () => undefined,
        },
        resourceProvider: {
            mapAddressToHandle(addr: number, handle: number) { objects.set(addr, objects.get(handle)); },
            registerSurfacePtr() {},
            getComObjectByAddress(addr: number) { return objects.get(addr); },
        },
        executor: { clear() {} },
    };
    const oldSystem = (globalThis as any).System;
    (globalThis as any).System = System;
    const systemSpy = spyOn(System, "getInstance").mockReturnValue({ scheduler: {} } as any);
    const factorySpy = spyOn(ComObjectFactory, "create").mockImplementation((_iid, _vt, state: any) => {
        const obj = Object.create(DirectDrawSurfaceObject.prototype);
        Object.defineProperties(obj, {
            handle: { value: nextHandle++ },
            getState: { value: () => state },
            setDDrawOwnerAddr: { value: () => {} },
        });
        objects.set(obj.handle, obj);
        created.push(state);
        return obj;
    });
    restore = [() => factorySpy.mockRestore(), () => systemSpy.mockRestore(), () => { (globalThis as any).System = oldSystem; }];
    dd = createDirectDrawExports(context);
});
afterEach(() => { for (const undo of restore) undo(); });

/** CreateSurface with a DDPF_FOURCC pixel format carrying `code`. */
function createSurface(caps: number, code: number, width = 64, height = 64): { hr: number; out: number } {
    mem.fill(0, DESC, DESC + 124);
    const O = DDSURFACEDESC2_OFFSETS;
    view.setUint32(DESC, 124, true);
    view.setUint32(DESC + O.flags, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT, true);
    view.setUint32(DESC + O.height, height, true);
    view.setUint32(DESC + O.width, width, true);
    view.setUint32(DESC + O.caps, caps, true);
    view.setUint32(DESC + O.pixelFormat, 32, true);
    view.setUint32(DESC + O.pixelFormat + DDPIXELFORMAT_OFFSETS.flags, DDPF_FOURCC, true);
    view.setUint32(DESC + O.pixelFormat + DDPIXELFORMAT_OFFSETS.fourCC, code, true);
    view.setUint32(OUT, 0xdeadbeef, true);
    const hr = dd.IDirectDraw7_CreateSurface!({ esp: 0 } as any, mem, [0, DESC, OUT, 0]) as number;
    return { hr: hr >>> 0, out: view.getUint32(OUT, true) };
}

/** The codes IDirectDraw7::GetFourCCCodes hands a caller with room for 32. */
function enumeratedCodes(): number[] {
    view.setUint32(CODES, 32, true);
    expect(dd.IDirectDraw7_GetFourCCCodes!({ esp: 0 } as any, mem, [0, CODES, CODES + 4])).toBe(0);
    const n = view.getUint32(CODES, true);
    return Array.from({ length: n }, (_, i) => view.getUint32(CODES + 4 + i * 4, true));
}

describe("CreateSurface refusals", () => {
    test("an overlay surface is refused with DDERR_NOOVERLAYHW when DDCAPS_OVERLAY is not advertised", () => {
        const r = createSurface(DDSCAPS_OVERLAY | DDSCAPS_VIDEOMEMORY, fourCC("YUY2"), 320, 176);
        expect(r.hr).toBe(DDERR_NOOVERLAYHW);
        expect(r.out).toBe(0);
        expect(created).toHaveLength(0);
    });

    test("a FourCC outside GetFourCCCodes is refused with DDERR_INVALIDPIXELFORMAT", () => {
        const r = createSurface(DDSCAPS_OFFSCREENPLAIN, fourCC("UYVY"));
        expect(r.hr).toBe(DDERR_INVALIDPIXELFORMAT);
        expect(r.out).toBe(0);
    });

    test("DDPF_FOURCC with a zero code is an invalid pixel format, not an RGB surface", () => {
        const r = createSurface(DDSCAPS_OFFSCREENPLAIN, 0);
        expect(r.hr).toBe(DDERR_INVALIDPIXELFORMAT);
        expect(r.out).toBe(0);
        expect(created).toHaveLength(0);
    });
});

describe("one FourCC support set for GetFourCCCodes and CreateSurface", () => {
    test("GetFourCCCodes reports exactly the shared set", () => {
        expect(enumeratedCodes()).toEqual([...SUPPORTED_FOURCC_CODES]);
        expect(enumeratedCodes()).toContain(fourCC("DXT1"));
    });

    test("every enumerated code can be created", () => {
        for (const code of enumeratedCodes()) {
            const before = created.length;
            const r = createSurface(DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, code);
            expect(r.hr).toBe(0);
            expect(r.out).not.toBe(0);
            expect(created.length).toBe(before + 1);
            expect(created[before].format.fourCC).toBe(code);
        }
    });

    test("a block-compressed code that is not enumerated is refused: ATI1, ATI2, BC4/BC5", () => {
        const enumerated = enumeratedCodes();
        for (const name of ["ATI1", "ATI2", "BC4U", "BC4S", "BC5U", "BC5S"]) {
            expect(enumerated).not.toContain(fourCC(name));
            const r = createSurface(DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, fourCC(name));
            expect(r.hr).toBe(DDERR_INVALIDPIXELFORMAT);
            expect(r.out).toBe(0);
        }
        expect(created).toHaveLength(0);
    });
});
