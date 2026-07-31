/**
 * DirectDraw interface tear-offs.
 *
 * One DirectDraw COM object exposes every DirectDraw generation AND the Direct3D
 * interface of the matching generation: IDirect3D7 is what IDirectDraw7 hands back
 * for IID_IDirect3D7, and it must navigate back the same way — that round trip is
 * how a DX7 app recovers the DirectDraw from a device (GetDirect3D, then
 * QueryInterface(IID_IDirectDraw7)) before creating texture surfaces.
 *
 * Every interface needs its own vtable (the method counts differ), so a tear-off is
 * a fresh guest address carrying that vtable but mapped onto the owner's handle.
 * Addresses are cached per interface so QueryInterface is idempotent and a game can
 * compare the pointers it gets back.
 */
import { BaseComObject } from "../../core/com/base-com-object";
import { allocateComObject } from "../../core/com/com-memory";
import { Logger, LogCategory } from "../../core/logger";
import { DirectDrawObject } from "./com-objects-ddraw";
import { DDrawContext } from "./context";
import {
    IID_IDirectDraw,
    IID_IDirectDrawAlias,
    IID_IDirectDraw2,
    IID_IDirectDraw4,
    IID_IDirectDraw7,
    IID_IDirect3D,
    IID_IDirect3D2,
    IID_IDirect3D3,
    IID_IDirect3D7,
} from "./constants";

const DD_OK = 0;
const E_NOINTERFACE = 0x80004002;

/** Normalized IID -> the vtable that interface must be handed out with. */
const TEAROFF_VTABLE: Record<string, string> = {
    [IID_IDirectDraw]: "IDirectDraw",
    [IID_IDirectDrawAlias]: "IDirectDraw",
    [IID_IDirectDraw2]: "IDirectDraw2",
    [IID_IDirectDraw4]: "IDirectDraw4",
    [IID_IDirectDraw7]: "IDirectDraw7",
    [IID_IDirect3D]: "IDirect3D",
    [IID_IDirect3D2]: "IDirect3D2",
    [IID_IDirect3D3]: "IDirect3D3",
    [IID_IDirect3D7]: "IDirect3D7",
};

const tearOffsByObject = new WeakMap<BaseComObject, Map<string, number>>();

const tearOffCache = (context: DDrawContext, obj: BaseComObject): Map<string, number> => {
    let cache = tearOffsByObject.get(obj);
    if (cache) return cache;

    cache = new Map<string, number>();
    // The address the object was created at already IS one of these interfaces (whichever
    // vtable it was built with), so seed it: QI for that generation must return the very
    // pointer the app already holds, not a second one.
    // The PRIMARY address, not the last-mapped one: every tear-off registered after birth
    // overwrites `getAddressForHandle`, so seeding from it credits the object's own
    // interface to whichever tear-off was created most recently.
    const primary = context.resourceProvider.getPrimaryAddressForHandle?.(obj.handle)
        ?? context.resourceProvider.getAddressForHandle(obj.handle);
    if (primary) {
        for (const [name, info] of Object.entries(context.vtables)) {
            if (info?.address === obj.vtableAddress) {
                cache.set(name, primary >>> 0);
                break;
            }
        }
    }
    tearOffsByObject.set(obj, cache);
    return cache;
};

/**
 * Resolve `iidNormalized` as a tear-off of the DirectDraw object `obj`, writing the
 * interface pointer to `ppvObject`. Returns an HRESULT, or null when the request is
 * none of this table's business — the caller then falls through to the object's own
 * QueryInterface.
 */
export const resolveDDrawTearOff = (
    context: DDrawContext,
    obj: BaseComObject,
    iidNormalized: string,
    ppvObject: number,
    mem: Uint8Array,
): number | null => {
    if (!(obj instanceof DirectDrawObject)) return null;
    const vtableName = TEAROFF_VTABLE[iidNormalized];
    if (!vtableName) return null;

    const vtableAddr = context.vtables[vtableName]?.address;
    if (!vtableAddr) {
        Logger.warn(LogCategory.COM, `QueryInterface: ${vtableName} requested but its vtable is missing`);
        return E_NOINTERFACE;
    }

    const cache = tearOffCache(context, obj);
    let addr = cache.get(vtableName) ?? 0;
    if (!addr) {
        addr = allocateComObject(context.process.memory, mem, vtableAddr) >>> 0;
        context.resourceProvider.mapAddressToHandle(addr, obj.handle);
        cache.set(vtableName, addr);
        Logger.log(LogCategory.COM,
            `DirectDraw tear-off ${vtableName} -> 0x${addr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
    }

    obj.addRef(addr);
    new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(ppvObject, addr, true);
    return DD_OK;
};
