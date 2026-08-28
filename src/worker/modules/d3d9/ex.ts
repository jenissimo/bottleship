/**
 * D3D9Ex surface.
 *
 * The Ex interfaces are append-only COM interfaces.  This module owns the
 * Ex-specific exports and deliberately keeps unsupported Ex-only operations
 * failing with a D3D error rather than returning success with unwritten
 * out-parameters.  The base prefix is forwarded to the already-tested D3D9
 * implementation after the descriptor has established the correct vtable.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { IDirect3D9, IDirect3DDevice9 } from '../../api/d3d9.api';
import {
    addComRef,
    createComObject,
    devices,
    getComRefCount,
    getVTables,
    releaseComRef,
} from './shared-state';
import {
    E_NOINTERFACE,
    E_POINTER,
    IID_IUNKNOWN,
    IID_IDIRECT3D9,
    IID_IDIRECT3D9EX,
    IID_IDIRECT3DDEVICE9,
    IID_IDIRECT3DDEVICE9EX,
    readD3D9GuidKey,
} from './object-contracts';
import {
    getDeviceSwapChain,
    recordDevicePresent,
    validateDevicePresent,
    validatePresentExFlags,
} from './swapchain';
import { notifyDeviceSubmission } from './query';
import { isDxDisplayFormat } from '../../backends/webgpu/shared/dx-format-support';
import { parsePresentationParameters9, validatePresentationParameters9 } from '../../backends/webgpu/d3d9/presentation';
import {
    clearDeviceRenderTargets,
    deviceBoundDepthStencil,
    takeAllDeviceSlotRefs,
} from './resource-registry';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DPOOL_MANAGED = 1;
const D3D_SDK_VERSION = 32;
const D3DUSAGE_RESTRICTED_CONTENT = 0x00000800;
const D3DUSAGE_RESTRICT_SHARED_RESOURCE_DRIVER = 0x00001000;
const D3DUSAGE_RESTRICT_SHARED_RESOURCE = 0x00002000;
const D3D9EX_CREATION_USAGE_MASK = D3DUSAGE_RESTRICTED_CONTENT
    | D3DUSAGE_RESTRICT_SHARED_RESOURCE_DRIVER
    | D3DUSAGE_RESTRICT_SHARED_RESOURCE;
const DEFAULT_FRAME_LATENCY = 3;
const MAX_FRAME_LATENCY = 20;
// DXVK accepts the D3D9Ex API's request range through 30, then clamps the
// value to the backend's effective queue limit above.  Rejecting 21..30 here
// is observably different from D3D9Ex even though the stored value is 20.
const MAX_REQUESTED_FRAME_LATENCY = 30;
const D3DFMT_X8R8G8B8 = 22;
const D3DDISPLAYMODEEX_SIZE = 24;
const D3DSCANLINEORDERING_PROGRESSIVE = 1;
const D3DSCANLINEORDERING_INTERLACED = 2;

const maxFrameLatencies = new Map<number, number>();
const extendedD3D9Objects = new Set<number>();
const extendedDevices = new Set<number>();

/** Parent-derived Ex identity used by resource/device handlers and tests. */
export function isD3D9ExDevice(devicePtr: number): boolean {
    const key = devicePtr >>> 0;
    if (!getComRefCount(key)) {
        extendedDevices.delete(key);
        return false;
    }
    return extendedDevices.has(key);
}

function promoteDeviceToEx(devicePtr: number): boolean {
    const key = devicePtr >>> 0;
    const exVtable = getVTables()['IDirect3DDevice9Ex']?.address ?? 0;
    if (!key || !exVtable || !Mem.writeUint32(key, exVtable)) return false;
    const device = devices.get(key) as unknown as ({ isExtended?: boolean } | undefined);
    if (device) device.isExtended = true;
    extendedDevices.add(key);
    return true;
}

function validateExCreationUsage(usage: number, pSharedHandle: number): number {
    const u = usage >>> 0;
    if ((u & ~D3D9EX_CREATION_USAGE_MASK) !== 0) return D3DERR_INVALIDCALL;
    const shared = u & (D3DUSAGE_RESTRICT_SHARED_RESOURCE_DRIVER | D3DUSAGE_RESTRICT_SHARED_RESOURCE);
    if (shared !== 0 && !pSharedHandle) return D3DERR_INVALIDCALL;
    // The WebGPU resource model has no protected/shared-handle storage
    // contract. Refuse the recognized Ex-only flags instead of forwarding a
    // successful creation while silently dropping Usage.
    return u === 0 ? D3D_OK : D3DERR_NOTAVAILABLE;
}

function resetExDevice(devicePtr: number, pPresentationParameters: number, mem: Uint8Array): number {
    const device = devices.get(devicePtr >>> 0) as unknown as ({
        setRenderTarget?: (index: number, texturePtr: number, face?: number, multiSampleType?: number) => number;
        setDepthStencilTexture?: (texturePtr: number) => number;
        reset?: (parameters: number, memory: Uint8Array) => number;
        getViewport?: () => { x: number; y: number; width: number; height: number; minZ: number; maxZ: number };
        viewport?: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number };
    } | undefined);
    if (!device || !pPresentationParameters) return D3DERR_INVALIDCALL;
    const params = parsePresentationParameters9(mem, pPresentationParameters);
    if (!params) return D3DERR_INVALIDCALL;
    const presentationHr = validatePresentationParameters9(params, true);
    if (presentationHr !== D3D_OK) return presentationHr;

    const viewport = device.getViewport?.();

    // Ex Reset does not require application DEFAULT resources to be released.
    // Detach the backend bindings first, then release the COM references held by
    // the module's binding slots so the next frame starts unbound.
    for (let index = 0; index < 4; index++) device.setRenderTarget?.(index, 0, -1, 0);
    device.setDepthStencilTexture?.(0);
    for (const held of takeAllDeviceSlotRefs(devicePtr)) releaseComRef(held);
    deviceBoundDepthStencil.delete(devicePtr >>> 0);
    clearDeviceRenderTargets(devicePtr);

    const result = device.reset?.(pPresentationParameters, mem) ?? D3DERR_INVALIDCALL;
    if (result === D3D_OK && viewport) {
        // D3D9Ex preserves the viewport's depth range across ResetEx.  The
        // backend stores this state on the device; restore the complete snapshot
        // after reset so x/y/extent and MinZ/MaxZ remain coherent together.
        device.viewport = { ...viewport };
    }
    return result;
}

function callBase(
    base: Record<string, ThunkImplementation>,
    name: string,
    ctx: any,
    mem: Uint8Array,
    args: number[],
): any {
    const fn = base[name] ?? (System.getInstance().process?.getModule('d3d9') as {
        exports?: Record<string, ThunkImplementation>;
    } | undefined)?.exports?.[name];
    if (!fn) return D3DERR_NOTAVAILABLE;
    return fn(ctx, mem, args);
}

function writeDisplayModeExFromLegacy(pMode: number, mem: Uint8Array): boolean {
    if (!pMode) return false;
    // IDirect3D9 writes D3DDISPLAYMODE as {Width, Height, RefreshRate,
    // Format}; turn that temporary layout into D3DDISPLAYMODEEX without a
    // guest allocation.  Read every source field before overwriting it.
    const width = Mem.readUint32(pMode + 0);
    const height = Mem.readUint32(pMode + 4);
    const refreshRate = Mem.readUint32(pMode + 8);
    const format = Mem.readUint32(pMode + 12);
    if (width === null || height === null || refreshRate === null || format === null) return false;
    return (
        Mem.writeUint32(pMode + 0, D3DDISPLAYMODEEX_SIZE) &&
        Mem.writeUint32(pMode + 4, width) &&
        Mem.writeUint32(pMode + 8, height) &&
        Mem.writeUint32(pMode + 12, refreshRate) &&
        Mem.writeUint32(pMode + 16, format) &&
        // D3DSCANLINEORDERING_PROGRESSIVE.  The host presentation path is
        // progressive, and callers require a deterministic initialized field.
        Mem.writeUint32(pMode + 20, 1)
    );
}

/**
 * Validate the optional mode descriptor accepted by ResetEx.  The base Reset
 * handler consumes only D3DPRESENT_PARAMETERS, so silently forwarding a
 * malformed/unsupported D3DDISPLAYMODEEX would report success while applying
 * a different display mode than the caller requested.
 */
function validateResetExMode(pMode: number, pPresentationParameters: number, mem: Uint8Array): number {
    if (!pPresentationParameters) return D3DERR_INVALIDCALL;
    const windowed = Mem.readUint32(pPresentationParameters + 32);
    const backBufferWidth = Mem.readUint32(pPresentationParameters + 0);
    const backBufferHeight = Mem.readUint32(pPresentationParameters + 4);
    const backBufferFormat = Mem.readUint32(pPresentationParameters + 8);
    if (windowed === null || backBufferWidth === null || backBufferHeight === null || backBufferFormat === null) {
        return D3DERR_INVALIDCALL;
    }
    // D3D9Ex treats the mode pointer as an explicit fullscreen discriminator:
    // windowed resets must pass NULL, fullscreen resets must provide a mode.
    if (windowed !== 0) return pMode ? D3DERR_INVALIDCALL : D3D_OK;
    if (!pMode) return D3DERR_INVALIDCALL;
    const size = Mem.readUint32(pMode + 0);
    const width = Mem.readUint32(pMode + 4);
    const height = Mem.readUint32(pMode + 8);
    const format = Mem.readUint32(pMode + 16);
    const scanline = Mem.readUint32(pMode + 20);
    if (size === null || width === null || height === null || format === null || scanline === null
        || size !== D3DDISPLAYMODEEX_SIZE || width === 0 || height === 0) {
        return D3DERR_INVALIDCALL;
    }
    if (!isDxDisplayFormat(format, 9) || scanline !== D3DSCANLINEORDERING_PROGRESSIVE) {
        return D3DERR_NOTAVAILABLE;
    }
    if (backBufferWidth !== 0 && backBufferWidth !== width) return D3DERR_INVALIDCALL;
    if (backBufferHeight !== 0 && backBufferHeight !== height) return D3DERR_INVALIDCALL;
    if (backBufferFormat !== 0 && backBufferFormat !== format) return D3DERR_INVALIDCALL;
    return D3D_OK;
}

function queryInterface(
    mem: Uint8Array,
    thisPtr: number,
    riid: number,
    ppvObject: number,
    accepted: Set<string>,
): number {
    if (!ppvObject) return E_POINTER;
    // REFIID is a required input. Keep the COM pointer contract distinct from
    // an otherwise well-formed but unrelated IID: callers passing NULL have
    // made an invalid pointer call, not an interface probe.
    if (!riid) {
        Mem.writeUint32(ppvObject, 0);
        return E_POINTER;
    }
    const key = readD3D9GuidKey(mem, riid);
    // A valid IID is not enough: QI on a stale/external pointer must not hand
    // back a pointer whose vtable has already been freed.  The base D3D9
    // prefixes enforce the same live-reference invariant.
    if (!getComRefCount(thisPtr) || !key || !accepted.has(key)) {
        Mem.writeUint32(ppvObject, 0);
        return E_NOINTERFACE;
    }
    if (!Mem.writeUint32(ppvObject, thisPtr)) return E_POINTER;
    addComRef(thisPtr);
    return D3D_OK;
}

/**
 * Build the Ex exports after the base module parts have been assembled.  The
 * base handlers are passed in so aliases remain the exact same implementation
 * (and do not accidentally drift in validation or lifetime bookkeeping).
 */
export function createExExports(base: Record<string, ThunkImplementation> = {}): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // The generated module index initializes atomic files alphabetically, so
    // this factory can run before device/factory handlers are merged.  Resolve
    // those inherited handlers lazily in that case; the hand-written path
    // still passes the assembled map and takes the direct fast path.
    const resolveBase = (name: string): ThunkImplementation | undefined => {
        const direct = base[name];
        if (direct) return direct;
        const module = System.getInstance().process?.getModule('d3d9') as {
            exports?: Record<string, ThunkImplementation>;
        } | undefined;
        return module?.exports?.[name];
    };

    exports['Direct3DCreate9Ex'] = (_ctx, _mem, args) => {
        const ppD3D9Ex = args[1] >>> 0;
        if (!ppD3D9Ex) return E_POINTER;
        Mem.writeUint32(ppD3D9Ex, 0);
        if ((args[0] >>> 0) !== D3D_SDK_VERSION) return D3DERR_NOTAVAILABLE;
        try {
            const vtable = getVTables()['IDirect3D9Ex']?.address ?? 0;
            if (!vtable) return D3DERR_INVALIDCALL;
            const objectPtr = createComObject(vtable);
            if (!Mem.writeUint32(ppD3D9Ex, objectPtr)) {
                releaseComRef(objectPtr);
                return E_POINTER;
            }
            extendedD3D9Objects.add(objectPtr >>> 0);
            Logger.log(LogCategory.D3D9, `Direct3DCreate9Ex(SDK=0x${(args[0] >>> 0).toString(16)}) -> 0x${objectPtr.toString(16)}`);
            return D3D_OK;
        } catch (error) {
            Logger.error(LogCategory.D3D9, `Direct3DCreate9Ex failed: ${error}`);
            return D3DERR_INVALIDCALL;
        }
    };

    // The inherited prefix is part of the Ex vtable.  Alias only handlers that
    // are genuinely implemented; the descriptor still emits a correctly sized
    // stub for every method, and unimplemented methods retain the global COM
    // E_NOTIMPL behavior.
    for (const method of IDirect3D9.methods) {
        const name = `IDirect3D9_${method.name}`;
        const exName = `IDirect3D9Ex_${method.name}`;
        exports[exName] = (ctx, mem, args) => {
            const fn = resolveBase(name);
            return fn ? fn(ctx, mem, args) : D3DERR_NOTAVAILABLE;
        };
    }
    for (const method of IDirect3DDevice9.methods) {
        const name = `IDirect3DDevice9_${method.name}`;
        const exName = `IDirect3DDevice9Ex_${method.name}`;
        exports[exName] = (ctx, mem, args) => {
            const fn = resolveBase(name);
            return fn ? fn(ctx, mem, args) : D3DERR_NOTAVAILABLE;
        };
    }

    exports['IDirect3D9Ex_QueryInterface'] = (_ctx, mem, args) => queryInterface(
        mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0,
        new Set([IID_IUNKNOWN, IID_IDIRECT3D9, IID_IDIRECT3D9EX]),
    );
    // Never fabricate a reference count for a stale/external pointer.  The base
    // state/resource contracts return 0 for the same condition; Ex prefixes must
    // preserve that lifetime invariant rather than masking use-after-release.
    exports['IDirect3D9Ex_AddRef'] = (_ctx, _mem, args) => addComRef(args[0] >>> 0) ?? 0;
    exports['IDirect3D9Ex_Release'] = (_ctx, _mem, args) => {
        const objectPtr = args[0] >>> 0;
        const remaining = releaseComRef(objectPtr) ?? 0;
        if (remaining === 0) extendedD3D9Objects.delete(objectPtr);
        return remaining;
    };

    exports['IDirect3DDevice9Ex_QueryInterface'] = (_ctx, mem, args) => queryInterface(
        mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0,
        new Set([IID_IUNKNOWN, IID_IDIRECT3DDEVICE9, IID_IDIRECT3DDEVICE9EX]),
    );
    exports['IDirect3DDevice9Ex_AddRef'] = (_ctx, _mem, args) => addComRef(args[0] >>> 0) ?? 0;
    exports['IDirect3DDevice9Ex_Release'] = (_ctx, _mem, args) => {
        const devicePtr = args[0] >>> 0;
        const remaining = releaseComRef(devicePtr) ?? 0;
        if (remaining === 0) {
            extendedDevices.delete(devicePtr);
            maxFrameLatencies.delete(devicePtr);
        }
        return remaining;
    };

    // The inherited CreateDevice call on an IDirect3D9Ex parent is still an
    // Ex device. Identity follows the parent vtable, not the method spelling.
    exports['IDirect3D9Ex_CreateDevice'] = async (ctx, mem, args) => {
        const parentPtr = args[0] >>> 0;
        if (!extendedD3D9Objects.has(parentPtr) || !getComRefCount(parentPtr)) return D3DERR_INVALIDCALL;
        const result = await callBase(base, 'IDirect3D9_CreateDevice', ctx, mem, [...args, 1]);
        if (typeof result !== 'number' || result !== D3D_OK) return result;
        const devicePtr = Mem.readUint32(args[6] >>> 0) ?? 0;
        if (!promoteDeviceToEx(devicePtr)) {
            if (devicePtr) releaseComRef(devicePtr);
            Mem.writeUint32(args[6] >>> 0, 0);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    // Ex devices have no cooperative-level recovery phase: ResetEx is the
    // recovery operation and TestCooperativeLevel remains usable throughout it.
    exports['IDirect3DDevice9Ex_TestCooperativeLevel'] = (_ctx, _mem, args) =>
        devices.has(args[0] >>> 0) ? D3D_OK : D3DERR_INVALIDCALL;

    const rejectManagedPool = (ctx: any, mem: Uint8Array, args: number[], baseName: string, poolIndex: number): any => {
        if ((args[poolIndex] >>> 0) === D3DPOOL_MANAGED) return D3DERR_INVALIDCALL;
        return callBase(base, baseName, ctx, mem, args);
    };
    exports['IDirect3DDevice9Ex_CreateTexture'] = (ctx, mem, args) =>
        rejectManagedPool(ctx, mem, args, 'IDirect3DDevice9_CreateTexture', 6);
    exports['IDirect3DDevice9Ex_CreateCubeTexture'] = (ctx, mem, args) =>
        rejectManagedPool(ctx, mem, args, 'IDirect3DDevice9_CreateCubeTexture', 5);
    exports['IDirect3DDevice9Ex_CreateVolumeTexture'] = (ctx, mem, args) =>
        rejectManagedPool(ctx, mem, args, 'IDirect3DDevice9_CreateVolumeTexture', 7);
    exports['IDirect3DDevice9Ex_CreateVertexBuffer'] = (ctx, mem, args) =>
        rejectManagedPool(ctx, mem, args, 'IDirect3DDevice9_CreateVertexBuffer', 4);
    exports['IDirect3DDevice9Ex_CreateIndexBuffer'] = (ctx, mem, args) =>
        rejectManagedPool(ctx, mem, args, 'IDirect3DDevice9_CreateIndexBuffer', 4);

    exports['IDirect3D9Ex_GetAdapterModeCountEx'] = (ctx, mem, args) => {
        const pFilter = args[2] >>> 0;
        // DXVK returns zero for a NULL filter, and does not silently substitute
        // a default format.  A bad guest pointer is the same unqueryable input.
        if (!pFilter) return 0;
        // D3DDISPLAYMODEFILTER is {Size, Format, ScanLineOrdering}.  Interlaced
        // modes are not exposed by the backend and therefore have an empty set.
        const format = Mem.readUint32(pFilter + 4);
        const scanline = Mem.readUint32(pFilter + 8);
        if (format === null || scanline === null || scanline === D3DSCANLINEORDERING_INTERLACED) return 0;
        return callBase(base, 'IDirect3D9_GetAdapterModeCount', ctx, mem,
            [args[0], args[1], format]);
    };

    exports['IDirect3D9Ex_EnumAdapterModesEx'] = (ctx, mem, args) => {
        const pFilter = args[2] >>> 0;
        const pMode = args[4] >>> 0;
        if (!pFilter || !pMode) return D3DERR_INVALIDCALL;
        const format = Mem.readUint32(pFilter + 4);
        const scanline = Mem.readUint32(pFilter + 8);
        if (format === null || scanline === null || scanline === D3DSCANLINEORDERING_INTERLACED) {
            return D3DERR_INVALIDCALL;
        }
        const result = callBase(base, 'IDirect3D9_EnumAdapterModes', ctx, mem,
            [args[0], args[1], format, args[3], pMode]);
        const finish = (hr: number): number => {
            if (hr !== D3D_OK) return hr;
            return writeDisplayModeExFromLegacy(pMode, mem) ? D3D_OK : D3DERR_INVALIDCALL;
        };
        const pending: any = result;
        if (pending && typeof pending.then === 'function') {
            return pending.then((hr: unknown) => finish(Number(hr))) as Promise<number>;
        }
        return finish(Number(result));
    };

    exports['IDirect3D9Ex_GetAdapterDisplayModeEx'] = (ctx, mem, args) => {
        const pMode = args[2] >>> 0;
        // Unlike EnumAdapterModesEx (whose mode is purely an output), the
        // Get*DisplayModeEx APIs take D3DDISPLAYMODEEX as an in/out structure.
        // The caller must seed Size before the legacy base handler writes its
        // 16-byte prefix; otherwise the size word would be overwritten before
        // we had a chance to validate it.
        if (!pMode || Mem.readUint32(pMode) !== D3DDISPLAYMODEEX_SIZE) return D3DERR_INVALIDCALL;
        const result = callBase(base, 'IDirect3D9_GetAdapterDisplayMode', ctx, mem,
            [args[0], args[1], pMode]);
        const finish = (hr: number) => {
            if (hr !== D3D_OK) return hr;
            if (!writeDisplayModeExFromLegacy(pMode, mem)) return D3DERR_INVALIDCALL;
            const pRotation = args[3] >>> 0;
            if (pRotation && !Mem.writeUint32(pRotation, 1)) return D3DERR_INVALIDCALL;
            return D3D_OK;
        };
        const pending: any = result;
        return pending && typeof pending.then === 'function'
            ? pending.then((hr: number) => finish(hr))
            : finish(Number(result));
    };

    exports['IDirect3D9Ex_GetAdapterLUID'] = (_ctx, _mem, args) => {
        const adapter = args[1] >>> 0;
        const pLuid = args[2] >>> 0;
        if (adapter !== 0 || !pLuid) return D3DERR_INVALIDCALL;
        // A stable synthetic LUID is preferable to an uninitialized out-param.
        return Mem.writeUint32(pLuid, 0) && Mem.writeUint32(pLuid + 4, 1)
            ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D9Ex_CreateDeviceEx'] = async (ctx, mem, args) => {
        const parentPtr = args[0] >>> 0;
        if (!extendedD3D9Objects.has(parentPtr) || !getComRefCount(parentPtr)) return D3DERR_INVALIDCALL;
        const ppDevice = args[7] >>> 0;
        if (!ppDevice) return E_POINTER;
        Mem.writeUint32(ppDevice, 0);
        const modeHr = validateResetExMode(args[6] >>> 0, args[5] >>> 0, mem);
        if (modeHr !== D3D_OK) return modeHr;
        const result = await callBase(base, 'IDirect3D9_CreateDevice', ctx, mem,
            [args[0], args[1], args[2], args[3], args[4], args[5], ppDevice, 1]);
        if (typeof result !== 'number' || result !== D3D_OK) return typeof result === 'number' ? result : D3DERR_INVALIDCALL;

        const devicePtr = Mem.readUint32(ppDevice) ?? 0;
        if (!devicePtr || !promoteDeviceToEx(devicePtr)) {
            if (devicePtr) releaseComRef(devicePtr);
            Mem.writeUint32(ppDevice, 0);
            return D3DERR_INVALIDCALL;
        }
        Logger.log(LogCategory.D3D9, `Created IDirect3DDevice9Ex at 0x${devicePtr.toString(16)}`);
        return D3D_OK;
    };

    exports['IDirect3DDevice9Ex_PresentEx'] = (ctx, mem, args) => {
        const flags = args[5] >>> 0;
        const flagsHr = validatePresentExFlags(flags);
        if (flagsHr !== D3D_OK) return flagsHr;
        const device = devices.get(args[0] >>> 0);
        if (!device) {
            // Keep the forwarding seam usable by descriptor-level tests and by a module that
            // is still assembling its device registry; the base handler remains the authority
            // for the actual pointer validation.
            const fn = resolveBase('IDirect3DDevice9_Present');
            return (fn ? fn(ctx, mem, args.slice(0, 5)) : D3DERR_INVALIDCALL) as any;
        }
        // Validate guest pointers before entering the async presenter, but do
        // not mutate the swap-chain history until PresentEx succeeds. A
        // DONOTWAIT/WASSTILLDRAWING result is not a presented frame.
        const validated = validateDevicePresent(
            args[0] >>> 0,
            mem,
            args[1] >>> 0,
            args[2] >>> 0,
            args[3] >>> 0,
            args[4] >>> 0,
            flags,
        );
        if (validated !== D3D_OK) return validated;
        return device.presentEx(flags).then((hr) => {
            if (hr !== D3D_OK) return hr;
            const recorded = recordDevicePresent(
                args[0] >>> 0,
                mem,
                args[1] >>> 0,
                args[2] >>> 0,
                args[3] >>> 0,
                args[4] >>> 0,
                flags,
            );
            if (recorded !== D3D_OK) return recorded;
            // Match the base Present submission serial only after a frame really made it
            // through the presenter; DONOTWAIT/WASSTILLDRAWING must not advance queries.
            notifyDeviceSubmission(args[0] >>> 0);
            return hr;
        });
    };
    exports['IDirect3DDevice9Ex_Reset'] = (ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        if (devices.has(devicePtr)) return resetExDevice(devicePtr, args[1] >>> 0, mem);
        return callBase(base, 'IDirect3DDevice9_Reset', ctx, mem, [args[0], args[1]]);
    };
    exports['IDirect3DDevice9Ex_ResetEx'] = (ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pPresentationParameters = args[1] >>> 0;
        if (!pPresentationParameters) return D3DERR_INVALIDCALL;
        const modeHr = validateResetExMode(args[2] >>> 0, pPresentationParameters, mem);
        if (modeHr !== D3D_OK) return modeHr;
        if (devices.has(devicePtr)) return resetExDevice(devicePtr, pPresentationParameters, mem);
        return callBase(base, 'IDirect3DDevice9_Reset', ctx, mem, [args[0], pPresentationParameters]);
    };
    exports['IDirect3DDevice9Ex_GetDisplayModeEx'] = (ctx, mem, args) => {
        const pMode = args[2] >>> 0;
        // GetDisplayModeEx has the same in/out Size contract as the adapter
        // query.  Validate it before forwarding because the base D3D9 call
        // overwrites the first four bytes with Width.
        if (!pMode || Mem.readUint32(pMode) !== D3DDISPLAYMODEEX_SIZE) return D3DERR_INVALIDCALL;
        const result = callBase(base, 'IDirect3DDevice9_GetDisplayMode', ctx, mem,
            [args[0], args[1], pMode]);
        const finish = (hr: number) => {
            if (hr !== D3D_OK) return hr;
            if (!writeDisplayModeExFromLegacy(pMode, mem)) return D3DERR_INVALIDCALL;
            const pRotation = args[3] >>> 0;
            return !pRotation || Mem.writeUint32(pRotation, 1) ? D3D_OK : D3DERR_INVALIDCALL;
        };
        const pending: any = result;
        return pending && typeof pending.then === 'function'
            ? pending.then((hr: number) => finish(hr))
            : finish(Number(result));
    };

    exports['IDirect3DDevice9Ex_CreateRenderTargetEx'] = (ctx, mem, args) => {
        const usageHr = validateExCreationUsage(args[9] >>> 0, args[8] >>> 0);
        if (usageHr !== D3D_OK) return usageHr;
        return callBase(base, 'IDirect3DDevice9_CreateRenderTarget', ctx, mem, args.slice(0, 9));
    };
    exports['IDirect3DDevice9Ex_CreateOffscreenPlainSurfaceEx'] = (ctx, mem, args) => {
        if ((args[4] >>> 0) === D3DPOOL_MANAGED) return D3DERR_INVALIDCALL;
        const usageHr = validateExCreationUsage(args[7] >>> 0, args[6] >>> 0);
        if (usageHr !== D3D_OK) return usageHr;
        return callBase(base, 'IDirect3DDevice9_CreateOffscreenPlainSurface', ctx, mem, args.slice(0, 7));
    };
    exports['IDirect3DDevice9Ex_CreateDepthStencilSurfaceEx'] = (ctx, mem, args) => {
        const usageHr = validateExCreationUsage(args[9] >>> 0, args[8] >>> 0);
        if (usageHr !== D3D_OK) return usageHr;
        return callBase(base, 'IDirect3DDevice9_CreateDepthStencilSurface', ctx, mem, args.slice(0, 9));
    };

    exports['IDirect3DDevice9Ex_GetGPUThreadPriority'] = (_ctx, _mem, args) => {
        const device = args[0] >>> 0;
        const pPriority = args[1] >>> 0;
        if (!devices.has(device) || !pPriority) return D3DERR_INVALIDCALL;
        // DXVK deliberately exposes this as a compatibility stub: SetGPUThreadPriority
        // is accepted but does not change a scheduler priority, and Get always reports 0.
        return Mem.writeUint32(pPriority, 0) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['IDirect3DDevice9Ex_SetGPUThreadPriority'] = (_ctx, _mem, args) => {
        const device = args[0] >>> 0;
        if (!devices.has(device)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };
    exports['IDirect3DDevice9Ex_WaitForVBlank'] = (_ctx, _mem, args) =>
        devices.has(args[0] >>> 0) && !!getDeviceSwapChain(args[0] >>> 0, args[1] >>> 0)
            ? D3D_OK : D3DERR_INVALIDCALL;
    exports['IDirect3DDevice9Ex_CheckResourceResidency'] = (_ctx, _mem, args) => {
        const device = args[0] >>> 0;
        if (!devices.has(device)) return D3DERR_INVALIDCALL;
        // DXVK exposes this Ex control-plane method as a compatibility stub and
        // returns D3D_OK without trying to manufacture a WebGPU residency model.
        // Do not validate or dereference the guest array: doing so would turn a
        // native stub into a stricter, observably different policy.
        return D3D_OK;
    };
    exports['IDirect3DDevice9Ex_SetMaximumFrameLatency'] = (_ctx, _mem, args) => {
        const device = args[0] >>> 0;
        const requested = args[1] >>> 0;
        if (!devices.has(device) || requested > MAX_REQUESTED_FRAME_LATENCY) return D3DERR_INVALIDCALL;
        const normalized = requested === 0 ? DEFAULT_FRAME_LATENCY : Math.min(requested, MAX_FRAME_LATENCY);
        maxFrameLatencies.set(device, normalized);
        return D3D_OK;
    };
    exports['IDirect3DDevice9Ex_GetMaximumFrameLatency'] = (_ctx, _mem, args) => {
        const device = args[0] >>> 0;
        const pLatency = args[1] >>> 0;
        if (!devices.has(device) || !pLatency) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(pLatency, maxFrameLatencies.get(device) ?? DEFAULT_FRAME_LATENCY)
            ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['IDirect3DDevice9Ex_CheckDeviceState'] = (_ctx, _mem, args) => {
        // DXVK keeps this Ex control-plane query as a compatibility stub. The
        // base device's cooperative-level state machine remains authoritative
        // for TestCooperativeLevel; do not expose a second, divergent Ex policy.
        return devices.has(args[0] >>> 0) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // No WebGPU equivalent exists yet for these legacy Ex control-plane APIs.
    // SetConvolutionMonoKernel follows the DXVK/Windows INVALIDCALL contract.
    // DXVK itself exposes ComposeRects as a compatibility stub returning D3D_OK;
    // mirror that observable HRESULT even though no composition work is performed.
    exports['IDirect3DDevice9Ex_SetConvolutionMonoKernel'] = () => D3DERR_INVALIDCALL;
    exports['IDirect3DDevice9Ex_ComposeRects'] = () => D3D_OK;

    return exports;
}
