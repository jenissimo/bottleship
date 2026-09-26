/**
 * Device bindings versus the PUBLIC COM count. The spec is Wine's d3d9 test_refcount
 * (dlls/d3d9/tests/device.c): SetIndices / SetStreamSource / SetTexture leave the object's
 * refcount unchanged ("SetTexture should not increase refcounts"), the Get* methods AddRef what
 * they return, and the runtime holds only an internal (wined3d) reference while an object is
 * bound — so a Release that returns 0 on a bound object is legal and the object lives until the
 * binding lets go. A d3d9 child also drops its device reference at public zero
 * (d3d9_vertexbuffer_Release et al.), which is what lets "release the device last" destroy it.
 *
 * `__d3d9InternalBindingRefs` turns that model on. Suites run in BOTH flag states: the default
 * arm pins the historical public-reference behaviour, so each flag-dependent assertion fails
 * the moment the flag stops making a difference.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { COM_GUARD_SIZE } from "../../src/worker/core/com/com-memory";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { D3D9_TEXTURE_SLOT_COUNT } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { StreamBindingTable } from "../../src/worker/backends/webgpu/shared/vertex-streams";
import {
    pixelShaderComObjects,
    vertexDeclComObjects,
    vertexShaderComObjects,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-com-objects";
import {
    D3DSBT_ALL,
    disposeStateBlockData,
    retainStateBlockRefs,
    type D3D9StateBlockData,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-block";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { createDeviceExports } from "../../src/worker/modules/d3d9/device";
import {
    addComRef,
    createComObject,
    devices,
    getComRefCount,
    registerComFinalizer,
    registerDeviceChildFinalizer,
    releaseComRef,
    resetD3D9SharedState,
    resourceToDevice,
} from "../../src/worker/modules/d3d9/shared-state";
import { surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";
import {
    D3D9_COM_REFCOUNT_OFFSET,
    adoptBindingRef,
    d3d9BindingRefStats,
    d3d9RefcountStorageStats,
    releaseBindingRef,
    unpinGuestRefcountStoreForTests,
} from "../../src/worker/modules/d3d9/com-refs";

const D3D_OK = 0;
const OUT = 0x3000;
const ctx = {} as any;

type Flags = {
    __d3d9InternalBindingRefs?: boolean;
    __d3d9MirrorRefcount?: boolean;
    __d3d9RefcountVerify?: boolean;
};
const flags = globalThis as Flags;
const FLAG_NAMES = ["__d3d9InternalBindingRefs", "__d3d9MirrorRefcount", "__d3d9RefcountVerify"] as const;

let originalProcess: unknown;
let savedFlags: Flags;
let mem: Uint8Array;
let nextPtr: number;
let freedBlocks: number[];
/** Was this object's guest block handed back? (The pool frees the block, guard word first.) */
const blockFreed = (objPtr: number): boolean => freedBlocks.includes((objPtr - COM_GUARD_SIZE) >>> 0);

beforeEach(() => {
    const system = System.getInstance();
    originalProcess = system.process;
    savedFlags = {};
    for (const name of FLAG_NAMES) savedFlags[name] = flags[name];
    mem = new Uint8Array(0x40000);
    nextPtr = 0x100;
    freedBlocks = [];
    system.process = {
        memory: {
            alloc(size: number) {
                const ptr = nextPtr;
                nextPtr += Math.max(4, size);
                return ptr;
            },
            allocSystemBlock(size: number) {
                const ptr = nextPtr;
                nextPtr += Math.max(16, size);
                return ptr;
            },
            freeSystemBlock(addr: number) {
                freedBlocks.push(addr);
            },
        },
        getCurrentMemory: () => mem,
    } as any;
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    resetD3D9SharedState();
});

afterEach(() => {
    resetD3D9SharedState();
    for (const name of FLAG_NAMES) {
        if (savedFlags[name] === undefined) delete flags[name];
        else flags[name] = savedFlags[name];
    }
    System.getInstance().process = originalProcess as any;
});

type Kind = "texture" | "stream" | "indices" | "vs" | "ps" | "decl";
const KINDS: Kind[] = ["texture", "stream", "indices", "vs", "ps", "decl"];
const PREFIX: Record<Kind, string> = {
    texture: "IDirect3DTexture9",
    stream: "IDirect3DVertexBuffer9",
    indices: "IDirect3DIndexBuffer9",
    vs: "IDirect3DVertexShader9",
    ps: "IDirect3DPixelShader9",
    decl: "IDirect3DVertexDeclaration9",
};

/** A D3D9Device carrying only the state the six binding setters and releaseComBindings touch. */
function makeDevice(known: { textures: number[]; vbs: number[]; ibs: number[] }): any {
    const indexOf = (list: number[]) => (ptr: number): number | null => {
        const i = list.indexOf(ptr >>> 0);
        return i < 0 ? null : i;
    };
    const device: any = Object.create(D3D9Device.prototype);
    // defineProperty, not assignment: some of these names are accessors on the prototype.
    const own = (fields: Record<string, unknown>): void => {
        for (const [key, value] of Object.entries(fields)) {
            Object.defineProperty(device, key, { value, writable: true, configurable: true, enumerable: true });
        }
    };
    own({
        recordingStateBlock: false,
        activeVertexShader: 0, activeVertexShaderComPtr: 0,
        activePixelShader: 0, activePixelShaderComPtr: 0,
        activeVertexDecl: 0, activeVertexDeclComPtr: 0,
        boundIndexPtr: 0,
        currentPipelineKey: null, currentPipelineId: null,
        streams: new StreamBindingTable(),
        boundTexturePtrs: new Array<number>(D3D9_TEXTURE_SLOT_COUNT).fill(0),
        arenaSamplerBankGeneration: 0,
        frameSnapshot: { frameCounters: null },
        rtDepthCache: new Map(),
        standaloneDepthSurfaces: new Map(),
        activeStandaloneDepthSurface: null,
        volumeByPointer: new Map(),
        textures: { getIndex: indexOf(known.textures) },
        vertexBuffers: { getIndex: indexOf(known.vbs) },
        indexBuffers: { getIndex: indexOf(known.ibs), getFormat: () => 101 },
        stateTracker: {
            setFVF() {},
            markStreamsDirty() {},
            setIndexSource: () => true,
            setTexture: () => true,
        },
        // Guest-side setter shadows belong to the dispatcher, which this test does not have.
        syncSetterShadow() {},
        resetSetterShadows() {},
        resetSubsystemPerf() {},
        // SetDepthStencilSurface's backend half.
        setDepthStencilSurface: () => D3D_OK,
        setDepthStencilTexture: () => D3D_OK,
    });
    return device;
}

interface Scene {
    devicePtr: number;
    device: any;
    state: ReturnType<typeof createStateExports>;
    obj: Record<Kind, number>;
    destroyed: string[];
    child(name: string): number;
}

/** A device COM object whose finalizer unbinds like the real one, plus one child per kind. */
function buildScene(): Scene {
    const devicePtr = createComObject(0x1111);
    const destroyed: string[] = [];
    const child = (name: string): number => {
        const ptr = createComObject(0x2222);
        registerDeviceChildFinalizer(ptr, devicePtr, () => destroyed.push(name));
        return ptr;
    };
    const obj = {} as Record<Kind, number>;
    for (const kind of KINDS) obj[kind] = child(kind);
    vertexShaderComObjects.set(obj.vs, { devicePtr, internalHandle: 7, bytecode: new Uint32Array(0) });
    pixelShaderComObjects.set(obj.ps, { devicePtr, internalHandle: 8, bytecode: new Uint32Array(0) });
    vertexDeclComObjects.set(obj.decl, { devicePtr, internalHandle: 3, elements: [] });
    const device = makeDevice({ textures: [obj.texture], vbs: [obj.stream], ibs: [obj.indices] });
    devices.set(devicePtr, device);
    registerComFinalizer(devicePtr, () => {
        destroyed.push("device");
        device.releaseComBindings();
    });
    return { devicePtr, device, state: createStateExports(), obj, destroyed, child };
}

function bind(s: Scene, kind: Kind, ptr: number, stage = 0): number {
    const d = s.devicePtr;
    switch (kind) {
        case "texture": return s.state.IDirect3DDevice9_SetTexture!(ctx, mem, [d, stage, ptr] as any);
        case "stream": return s.state.IDirect3DDevice9_SetStreamSource!(ctx, mem, [d, stage, ptr, 0, ptr ? 16 : 0] as any);
        case "indices": return s.state.IDirect3DDevice9_SetIndices!(ctx, mem, [d, ptr] as any);
        case "vs": return s.state.IDirect3DDevice9_SetVertexShader!(ctx, mem, [d, ptr] as any);
        case "ps": return s.state.IDirect3DDevice9_SetPixelShader!(ctx, mem, [d, ptr] as any);
        case "decl": return s.state.IDirect3DDevice9_SetVertexDeclaration!(ctx, mem, [d, ptr] as any);
    }
}

function get(s: Scene, kind: Kind, out: number): number {
    const d = s.devicePtr;
    switch (kind) {
        case "texture": return s.state.IDirect3DDevice9_GetTexture!(ctx, mem, [d, 0, out] as any);
        case "stream": return s.state.IDirect3DDevice9_GetStreamSource!(ctx, mem, [d, 0, out, 0, 0] as any);
        case "indices": return s.state.IDirect3DDevice9_GetIndices!(ctx, mem, [d, out] as any);
        case "vs": return s.state.IDirect3DDevice9_GetVertexShader!(ctx, mem, [d, out] as any);
        case "ps": return s.state.IDirect3DDevice9_GetPixelShader!(ctx, mem, [d, out] as any);
        case "decl": return s.state.IDirect3DDevice9_GetVertexDeclaration!(ctx, mem, [d, out] as any);
    }
}

function release(s: Scene, kind: Kind): number {
    return s.state[`${PREFIX[kind]}_Release`]!(ctx, mem, [s.obj[kind]] as any) as number;
}

const MODES = [
    { name: "internal binding refs", internal: true },
    { name: "public binding refs (default)", internal: false },
] as const;

for (const mode of MODES) {
    describe(`D3D9 bindings and the public count — ${mode.name}`, () => {
        beforeEach(() => {
            flags.__d3d9InternalBindingRefs = mode.internal;
        });

        // A binding is invisible in the public count under the native model, +1 under the old one.
        const bound = (n: number): number => (mode.internal ? n : n + 1);

        for (const kind of KINDS) {
            test(`${kind}: Set leaves the public count alone, Get AddRefs what it returns`, () => {
                const s = buildScene();
                const p = s.obj[kind];
                expect(getComRefCount(p)).toBe(1);
                expect(bind(s, kind, p)).toBe(D3D_OK);
                expect(getComRefCount(p)).toBe(bound(1));

                Mem.writeUint32(OUT, 0xdeadbeef);
                expect(get(s, kind, OUT)).toBe(D3D_OK);
                expect(Mem.readUint32(OUT)).toBe(p);
                expect(getComRefCount(p)).toBe(bound(2));
                expect(releaseComRef(p)).toBe(bound(1));

                expect(bind(s, kind, 0)).toBe(D3D_OK);
                expect(getComRefCount(p)).toBe(1);
                expect(s.destroyed).toEqual([]);
            });

            test(`${kind}: Release to zero while bound keeps the object; unbinding destroys it`, () => {
                const s = buildScene();
                const p = s.obj[kind];
                expect(bind(s, kind, p)).toBe(D3D_OK);

                expect(release(s, kind)).toBe(bound(0));
                expect(s.destroyed).toEqual([]);
                expect(blockFreed(p)).toBe(false);
                expect(getComRefCount(p)).toBe(bound(0));
                if (mode.internal) expect(d3d9BindingRefStats().pendingDestruction).toBe(1);

                expect(bind(s, kind, 0)).toBe(D3D_OK);
                expect(s.destroyed).toEqual([kind]);
                expect(blockFreed(p)).toBe(true);
                expect(getComRefCount(p)).toBeUndefined();
                expect(d3d9BindingRefStats().bindingRefs).toBe(0);
            });
        }

        test("rebinding the same object is idempotent; two slots hold two binding references", () => {
            const s = buildScene();
            for (const kind of KINDS) {
                for (let i = 0; i < 3; i++) expect(bind(s, kind, s.obj[kind])).toBe(D3D_OK);
                expect(getComRefCount(s.obj[kind])).toBe(bound(1));
            }
            expect(d3d9BindingRefStats().bindingRefs).toBe(mode.internal ? KINDS.length : 0);
            for (const kind of KINDS) if (kind !== "texture") bind(s, kind, 0);

            const tex = s.obj.texture;
            expect(d3d9BindingRefStats().bindingRefs).toBe(mode.internal ? 1 : 0);

            expect(bind(s, "texture", tex, 1)).toBe(D3D_OK);
            expect(getComRefCount(tex)).toBe(mode.internal ? 1 : 3);
            expect(d3d9BindingRefStats().bindingRefs).toBe(mode.internal ? 2 : 0);

            expect(release(s, "texture")).toBe(mode.internal ? 0 : 2);
            expect(bind(s, "texture", 0)).toBe(D3D_OK);
            expect(s.destroyed).toEqual([]);          // stage 1 still holds it
            expect(bind(s, "texture", 0, 1)).toBe(D3D_OK);
            expect(s.destroyed).toEqual(["texture"]);
        });

        test("the device reference follows the child's public count, not its bindings", () => {
            const s = buildScene();
            // The app's device reference plus one per publicly referenced child.
            expect(getComRefCount(s.devicePtr)).toBe(1 + KINDS.length);
            bind(s, "texture", s.obj.texture);
            expect(release(s, "texture")).toBe(bound(0));
            expect(getComRefCount(s.devicePtr)).toBe(mode.internal ? KINDS.length : 1 + KINDS.length);

            // GetTexture on a texture the app had released lifts it off zero, device reference included.
            expect(get(s, "texture", OUT)).toBe(D3D_OK);
            expect(getComRefCount(s.obj.texture)).toBe(bound(1));
            expect(getComRefCount(s.devicePtr)).toBe(1 + KINDS.length);
            expect(release(s, "texture")).toBe(bound(0));
            expect(getComRefCount(s.devicePtr)).toBe(mode.internal ? KINDS.length : 1 + KINDS.length);
        });

        test("releasing the device last destroys it and everything only its bindings held", () => {
            const s = buildScene();
            for (const kind of KINDS) bind(s, kind, s.obj[kind]);
            for (const kind of KINDS) expect(release(s, kind)).toBe(bound(0));

            if (mode.internal) {
                expect(releaseComRef(s.devicePtr)).toBe(0);
                expect(s.destroyed[0]).toBe("device");
                expect([...s.destroyed].sort()).toEqual(["device", ...KINDS].sort());
                expect(blockFreed(s.devicePtr)).toBe(true);
                for (const kind of KINDS) expect(blockFreed(s.obj[kind])).toBe(true);
            } else {
                // The historical cycle: each bound child keeps a device reference the app cannot drop.
                expect(releaseComRef(s.devicePtr)).toBe(KINDS.length);
                expect(s.destroyed).toEqual([]);
            }
        });

        test("unbinding everything (Reset, device teardown) drops every binding reference", () => {
            const s = buildScene();
            for (const kind of KINDS) bind(s, kind, s.obj[kind]);
            for (const kind of KINDS) release(s, kind);
            expect(s.destroyed).toEqual([]);

            s.device.releaseComBindings();
            expect([...s.destroyed].sort()).toEqual([...KINDS].sort());
            for (const kind of KINDS) expect(getComRefCount(s.obj[kind])).toBeUndefined();
            // Every child's device reference came back exactly once, whichever way it was held.
            expect(getComRefCount(s.devicePtr)).toBe(1);
            expect(d3d9BindingRefStats().bindingRefs).toBe(0);
        });

        test("a state block holds captured objects the way a binding does", () => {
            const s = buildScene();
            const { texture, stream, indices, vs, ps, decl } = s.obj;
            const data: D3D9StateBlockData = {
                devicePtr: s.devicePtr,
                blockType: D3DSBT_ALL,
                entries: [
                    { op: "texture", stage: 0, texPtr: texture },
                    { op: "streamSource", stream: 0, vbPtr: stream, offset: 0, stride: 16 },
                    { op: "indices", ibPtr: indices },
                    { op: "vertexShader", handle: vs },
                    { op: "pixelShader", handle: ps },
                    { op: "vertexDeclaration", handle: decl },
                ],
            };
            retainStateBlockRefs(data);
            retainStateBlockRefs(data);   // a re-Capture does not stack references
            for (const kind of KINDS) expect(getComRefCount(s.obj[kind])).toBe(bound(1));

            for (const kind of KINDS) expect(release(s, kind)).toBe(bound(0));
            expect(s.destroyed).toEqual([]);

            disposeStateBlockData(data);
            expect([...s.destroyed].sort()).toEqual([...KINDS].sort());
            expect(getComRefCount(s.devicePtr)).toBe(1);
        });

        test("SetDepthStencilSurface / GetDepthStencilSurface follow the same contract", () => {
            const s = buildScene();
            const dev = createDeviceExports();
            const ds = s.child("ds");
            resourceToDevice.set(ds, s.device);
            surfaceMeta.set(ds, {
                format: 75, type: 1, usage: 2, pool: 0,
                multiSampleType: 0, multiSampleQuality: 0, width: 4, height: 4,
            });

            expect(dev.IDirect3DDevice9_SetDepthStencilSurface!(ctx, mem, [s.devicePtr, ds] as any)).toBe(D3D_OK);
            expect(getComRefCount(ds)).toBe(bound(1));
            expect(dev.IDirect3DDevice9_GetDepthStencilSurface!(ctx, mem, [s.devicePtr, OUT] as any)).toBe(D3D_OK);
            expect(Mem.readUint32(OUT)).toBe(ds);
            expect(getComRefCount(ds)).toBe(bound(2));
            expect(releaseComRef(ds)).toBe(bound(1));
            expect(releaseComRef(ds)).toBe(bound(0));
            expect(s.destroyed).toEqual([]);

            expect(dev.IDirect3DDevice9_SetDepthStencilSurface!(ctx, mem, [s.devicePtr, 0] as any)).toBe(D3D_OK);
            expect(s.destroyed).toEqual(["ds"]);
        });

        test("an implicit object adopted by its slot starts at public zero", () => {
            // Native implicit surfaces are "created with a refcount of 0 ... not freed if refcount
            // reaches 0" (test_refcount, again): the slot's reference is the only one there is.
            const obj = createComObject(0x3333);
            adoptBindingRef(obj);
            expect(getComRefCount(obj)).toBe(mode.internal ? 0 : 1);
            expect(addComRef(obj)).toBe(mode.internal ? 1 : 2);        // GetDepthStencilSurface
            expect(releaseComRef(obj)).toBe(mode.internal ? 0 : 1);
            expect(blockFreed(obj)).toBe(false);
            releaseBindingRef(obj);
            expect(blockFreed(obj)).toBe(true);
            expect(getComRefCount(obj)).toBeUndefined();
        });
    });
}

describe("D3D9 internal binding refs — guest word and oracles", () => {
    const guestWord = (ptr: number): number => Mem.readUint32(ptr + D3D9_COM_REFCOUNT_OFFSET) >>> 0;

    beforeEach(() => {
        flags.__d3d9InternalBindingRefs = true;
        flags.__d3d9MirrorRefcount = false;
        // A live stub elsewhere in the process pins the guest store, which turns the oracle off.
        unpinGuestRefcountStoreForTests();
    });

    test("the verify oracle still agrees across bind, Get, release-to-zero and unbind", () => {
        flags.__d3d9RefcountVerify = true;
        d3d9RefcountStorageStats(true);
        const s = buildScene();
        for (const kind of KINDS) {
            bind(s, kind, s.obj[kind]);
            get(s, kind, OUT);
            release(s, kind);
            expect(release(s, kind)).toBe(0);
            expect(guestWord(s.obj[kind])).toBe(0);          // the count of record, object still alive
            bind(s, kind, 0);
        }
        expect([...s.destroyed].sort()).toEqual([...KINDS].sort());
        const stats = d3d9RefcountStorageStats(true);
        expect(stats.checked).toBeGreaterThan(0);
        expect(stats.mismatch).toBe(0);
        expect(stats.verdict).toBe("agree");
    });

    test("a guest-side AddRef off zero keeps the unbound object alive and its device balanced", () => {
        const s = buildScene();
        const tex = s.obj.texture;
        bind(s, "texture", tex);
        expect(release(s, "texture")).toBe(0);
        expect(getComRefCount(s.devicePtr)).toBe(KINDS.length);

        // The Texture9 AddRef stub: `inc [this+4]` in guest code, no trap, JS never sees it.
        Mem.writeUint32(tex + D3D9_COM_REFCOUNT_OFFSET, 1);
        bind(s, "texture", 0);
        expect(s.destroyed).toEqual([]);
        expect(getComRefCount(tex)).toBe(1);

        expect(release(s, "texture")).toBe(0);
        expect(s.destroyed).toEqual(["texture"]);
        // Its device reference was dropped at the first zero and must not be dropped twice.
        expect(getComRefCount(s.devicePtr)).toBe(KINDS.length);
    });

    test("an over-release of a bound object at zero does not destroy it", () => {
        const s = buildScene();
        bind(s, "stream", s.obj.stream);
        expect(release(s, "stream")).toBe(0);
        expect(release(s, "stream")).toBe(0);
        expect(s.destroyed).toEqual([]);
        bind(s, "stream", 0);
        expect(s.destroyed).toEqual(["stream"]);
    });
});

describe("D3D9 binding refs — flipping the flag mid-run stays balanced", () => {
    test("bound under public refs, unbound under internal", () => {
        flags.__d3d9InternalBindingRefs = false;
        const s = buildScene();
        bind(s, "texture", s.obj.texture);
        expect(getComRefCount(s.obj.texture)).toBe(2);
        flags.__d3d9InternalBindingRefs = true;
        bind(s, "texture", 0);
        expect(getComRefCount(s.obj.texture)).toBe(1);
        expect(release(s, "texture")).toBe(0);
        expect(s.destroyed).toEqual(["texture"]);
    });

    test("bound under internal refs, unbound under public", () => {
        flags.__d3d9InternalBindingRefs = true;
        const s = buildScene();
        bind(s, "texture", s.obj.texture);
        flags.__d3d9InternalBindingRefs = false;
        bind(s, "texture", 0);
        expect(getComRefCount(s.obj.texture)).toBe(1);
        expect(d3d9BindingRefStats().bindingRefs).toBe(0);
        expect(release(s, "texture")).toBe(0);
        expect(s.destroyed).toEqual(["texture"]);
    });
});
