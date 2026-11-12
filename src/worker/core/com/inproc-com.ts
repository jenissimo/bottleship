/**
 * Generic in-process COM object creation via native guest DLLs.
 *
 * CoCreateInstance path:
 *   resolve DLL (registry → ROM filename fallback)
 *   LoadLibrary if needed (+ DllMain chain)
 *   DllGetClassObject(CLSID, IID_IClassFactory, &factory)
 *   factory->CreateInstance(NULL, riid, ppv)
 *   factory->Release()
 */

import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import type { Process } from "../process";
import type { ThunkResult } from "../thunking/thunk-dispatcher";
import { Mem } from "../memory/mem-accessor";
import type { DllInitEntry } from "../pe-loader";

const S_OK = 0x00000000;
const REGDB_E_CLASSNOTREG = 0x80040154;
const COCREATEINSTANCE_STACK_CLEANUP = 20;

/** IClassFactory — {00000001-0000-0000-C000-000000000046} */
const IID_CLASSFACTORY_NORMALIZED = "00000001-0000-0000-c000-000000000046";

/** CLSID → ROM filenames to try when registry has no InprocServer32 entry. */
const INPROC_ROM_FALLBACKS: Record<string, string[]> = {
    "1440ad10-6aa8-11d1-b6f9-00a024ddafd1": ["BLOWFISH.DLL"],
};

export interface InprocCoCreateArgs {
    rclsid: number;
    riid: number;
    ppv: number;
    clsidNormalized: string;
}

function normalizeGuid(value: string): string {
    return value.replace(/[{}]/g, "").toLowerCase();
}

function guidToBytes(normalized: string): Uint8Array {
    const text = normalizeGuid(normalized);
    const parts = text.split("-");
    const bytes = new Uint8Array(16);
    const data1 = parseInt(parts[0], 16) >>> 0;
    const data2 = parseInt(parts[1], 16) & 0xffff;
    const data3 = parseInt(parts[2], 16) & 0xffff;
    const tail = parts[3] + parts[4];
    bytes[0] = data1 & 0xff;
    bytes[1] = (data1 >>> 8) & 0xff;
    bytes[2] = (data1 >>> 16) & 0xff;
    bytes[3] = (data1 >>> 24) & 0xff;
    bytes[4] = data2 & 0xff;
    bytes[5] = (data2 >>> 8) & 0xff;
    bytes[6] = data3 & 0xff;
    bytes[7] = (data3 >>> 8) & 0xff;
    for (let i = 0; i < 8; i++) {
        bytes[8 + i] = parseInt(tail.slice(i * 2, i * 2 + 2), 16) & 0xff;
    }
    return bytes;
}

/** Read HKCR\CLSID\{guid}\InprocServer32 default (empty name) value. */
export function resolveInprocServerPath(clsidNormalized: string): string | null {
    const store = System.getInstance().registry;
    if (!store) return null;

    const guidBraced = `{${normalizeGuid(clsidNormalized)}}`;
    const key = store.open("HKEY_CLASSES_ROOT", `CLSID\\${guidBraced}\\InprocServer32`);
    if (!key) return null;

    const val = store.getValue(key, "");
    if (!val || val.type !== "REG_SZ") return null;

    const path = String(val.data).trim();
    return path || null;
}

function resolveRomFallbackPath(clsidNormalized: string): string | null {
    const names = INPROC_ROM_FALLBACKS[normalizeGuid(clsidNormalized)];
    if (!names?.length) return null;

    const vfs = System.getInstance().fileSystem;
    if (!vfs) return null;

    for (const name of names) {
        const direct = `C:\\${name}`;
        if (vfs.hasRomFile(direct)) {
            Logger.log(LogCategory.COM, `inproc: ROM fallback ${clsidNormalized} → ${direct}`);
            return direct;
        }
    }

    try {
        for (const entry of vfs.listDirectory("C:\\")) {
            if (entry.kind !== "file") continue;
            for (const name of names) {
                if (entry.name.toLowerCase() === name.toLowerCase()) {
                    const path = `C:\\${entry.name}`;
                    Logger.log(LogCategory.COM, `inproc: ROM fallback (listing) ${clsidNormalized} → ${path}`);
                    return path;
                }
            }
        }
    } catch {
        // listDirectory may fail
    }

    return null;
}

export function resolveInprocDllPath(clsidNormalized: string): string | null {
    return resolveInprocServerPath(clsidNormalized) ?? resolveRomFallbackPath(clsidNormalized);
}

/** Resolve a valid immediate TreatAs target for native in-process activation. */
function resolveTreatAsClass(clsid: string): string {
    const store = System.getInstance().registry;
    const key = store?.open("HKEY_CLASSES_ROOT", `CLSID\\{${normalizeGuid(clsid)}}\\TreatAs`);
    const value = key ? store.getValue(key, "") : null;
    if (!value) return normalizeGuid(clsid);
    const text = value.type === "REG_SZ" ? String(value.data).trim() : "";
    const guid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    if (!new RegExp(`^(?:${guid}|\\{${guid}\\})$`, "i").test(text)) {
        return normalizeGuid(clsid);
    }
    return normalizeGuid(text);
}

function readGuestVtblSlot(mem: Uint8Array, objPtr: number, slot: number): number {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const vtable = view.getUint32(objPtr, true) >>> 0;
    if (!vtable || vtable + (slot + 1) * 4 > mem.length) return 0;
    return view.getUint32(vtable + slot * 4, true) >>> 0;
}

function runDllMainChain(
    process: Process,
    ctx: { esp: number; returnAddr?: number },
    stackCleanup: number,
    dllInits: DllInitEntry[],
    mem: Uint8Array,
    args: InprocCoCreateArgs,
    dllPath: string,
    dllGetClassObject: number,
): ThunkResult | null {
    const callbackManager = process.dispatcher.callbackManager;
    if (!callbackManager) return null;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    // Prefer the return address pinned by tryInprocCoCreateInstance (captured before any async
    // park clobbered [ESP] with spinLoopAddress); fall back to [ESP] only on the sync path.
    const thunkReturnAddr = ctx.returnAddr !== undefined ? (ctx.returnAddr >>> 0) : view.getUint32(ctx.esp, true);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: thunkReturnAddr } as Parameters<typeof callbackManager.saveSuspendedThunkContext>[0],
        stackCleanup,
        "inproc-DllMain",
    );
    if (!frameId) return null;

    let initIndex = 0;
    const chainDllMain = (_ret: number): number | null => {
        initIndex++;
        if (initIndex < dllInits.length) {
            const next = dllInits[initIndex]!;
            Logger.log(LogCategory.COM,
                `inproc: DllMain chain ${next.name} @ 0x${next.entryPoint.toString(16)}`);
            callbackManager.invokeCallback(
                next.entryPoint,
                [next.baseAddress, 1, 0],
                0,
                chainDllMain,
                false,
                "inproc-DllMain",
                frameId,
            );
            return null;
        }
        beginGuestCreateChain(
            process, callbackManager, frameId, mem, args, dllPath, dllGetClassObject,
        );
        return null;
    };

    const first = dllInits[0]!;
    Logger.log(LogCategory.COM,
        `inproc: DllMain chain start ${first.name} @ 0x${first.entryPoint.toString(16)} (${dllInits.length} total)`);
    const { callbackId } = callbackManager.invokeCallback(
        first.entryPoint,
        [first.baseAddress, 1, 0],
        0,
        chainDllMain,
        false,
        "inproc-DllMain",
        frameId,
    );

    return {
        value: S_OK,
        suspendedForCallback: true,
        callbackId,
        stackCleanup,
    };
}

/** Continue an in-flight suspended thunk; DllMain completeThunk returns null to stay suspended. */
function beginGuestCreateChain(
    process: Process,
    callbackManager: NonNullable<Process["dispatcher"]["callbackManager"]>,
    frameId: number,
    mem: Uint8Array,
    args: InprocCoCreateArgs,
    dllPath: string,
    dllGetClassObject: number,
): { callbackId: number } {
    const scratch = process.memory.alloc(48, "THUNK_DATA");
    const iidClassFactoryPtr = scratch;
    const pFactoryOut = scratch + 16;
    const pClassId = scratch + 32;

    const iidBytes = guidToBytes(IID_CLASSFACTORY_NORMALIZED);
    if (Mem.writeBytes(iidClassFactoryPtr, iidBytes) !== 16) {
        process.memory.free(scratch);
        throw new Error("inproc: failed to write IClassFactory IID");
    }
    if (Mem.writeBytes(pClassId, guidToBytes(args.clsidNormalized)) !== 16) {
        process.memory.free(scratch);
        throw new Error("inproc: failed to write activation CLSID");
    }
    Mem.writeUint32(pFactoryOut, 0);

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    const cleanup = () => {
        process.memory.free(scratch);
    };

    const finish = (hr: number): number => {
        cleanup();
        Logger.log(LogCategory.COM,
            `inproc: CoCreateInstance done CLSID=${args.clsidNormalized} DLL=${dllPath} hr=0x${(hr >>> 0).toString(16)}`);
        return hr >>> 0;
    };

    const invokeFactoryRelease = (factory: number, createHr: number): number | null => {
        const releaseAddr = readGuestVtblSlot(mem, factory, 2);
        if (!releaseAddr) {
            return finish(createHr);
        }
        callbackManager.invokeCallback(
            releaseAddr,
            [factory],
            4,
            () => finish(createHr),
            false,
            "inproc-Release",
            frameId,
        );
        return null;
    };

    const afterCreateInstance = (createHr: number): number | null => {
        const factory = Mem.readUint32(pFactoryOut) ?? 0;
        if (!factory) return finish(createHr);
        return invokeFactoryRelease(factory, createHr);
    };

    const afterGetClassObject = (getObjHr: number): number | null => {
        const hr = getObjHr >>> 0;
        if (hr !== S_OK) {
            if (args.ppv) view.setUint32(args.ppv, 0, true);
            return finish(hr);
        }

        const factory = Mem.readUint32(pFactoryOut) ?? 0;
        if (!factory) {
            if (args.ppv) view.setUint32(args.ppv, 0, true);
            return finish(REGDB_E_CLASSNOTREG);
        }

        const createAddr = readGuestVtblSlot(mem, factory, 3);
        if (!createAddr) {
            if (args.ppv) view.setUint32(args.ppv, 0, true);
            return finish(REGDB_E_CLASSNOTREG);
        }

        Logger.log(LogCategory.COM,
            `inproc: CreateInstance factory=0x${factory.toString(16)} fn=0x${createAddr.toString(16)} riid=0x${args.riid.toString(16)}`);

        callbackManager.invokeCallback(
            createAddr,
            [factory, 0, args.riid, args.ppv],
            16,
            afterCreateInstance,
            false,
            "inproc-CreateInstance",
            frameId,
        );
        return null;
    };

    Logger.log(LogCategory.COM,
        `inproc: DllGetClassObject CLSID=${args.clsidNormalized} DLL=${dllPath} fn=0x${dllGetClassObject.toString(16)}`);

    return callbackManager.invokeCallback(
        dllGetClassObject,
        [pClassId, iidClassFactoryPtr, pFactoryOut],
        12,
        afterGetClassObject,
        false,
        "inproc-DllGetClassObject",
        frameId,
    );
}

function startGuestCreateChain(
    process: Process,
    ctx: { esp: number; returnAddr?: number },
    mem: Uint8Array,
    args: InprocCoCreateArgs,
    dllPath: string,
    dllGetClassObject: number,
): ThunkResult | null {
    const callbackManager = process.dispatcher.callbackManager;
    if (!callbackManager) return null;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    // Prefer the return address pinned by tryInprocCoCreateInstance (captured before any async
    // park clobbered [ESP] with spinLoopAddress); fall back to [ESP] only on the sync path.
    const thunkReturnAddr = ctx.returnAddr !== undefined ? (ctx.returnAddr >>> 0) : view.getUint32(ctx.esp, true);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: thunkReturnAddr } as Parameters<typeof callbackManager.saveSuspendedThunkContext>[0],
        COCREATEINSTANCE_STACK_CLEANUP,
        "inproc-CoCreate",
    );
    if (!frameId) return null;

    const { callbackId } = beginGuestCreateChain(
        process, callbackManager, frameId, mem, args, dllPath, dllGetClassObject,
    );

    return {
        value: S_OK,
        suspendedForCallback: true,
        callbackId,
        stackCleanup: COCREATEINSTANCE_STACK_CLEANUP,
    };
}

/** Create via an already-registered in-process class factory (CoRegisterClassObject). */
export function startInprocFromFactory(
    process: Process,
    ctx: { esp: number },
    mem: Uint8Array,
    factoryPunk: number,
    riid: number,
    ppv: number,
): ThunkResult | null {
    const callbackManager = process.dispatcher.callbackManager;
    if (!callbackManager) return null;

    const createAddr = readGuestVtblSlot(mem, factoryPunk, 3);
    if (!createAddr) return null;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const thunkReturnAddr = view.getUint32(ctx.esp, true);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: thunkReturnAddr } as Parameters<typeof callbackManager.saveSuspendedThunkContext>[0],
        COCREATEINSTANCE_STACK_CLEANUP,
        "inproc-Factory",
    );
    if (!frameId) return null;

    const finish = (hr: number): number => hr >>> 0;

    const afterCreate = (hr: number): number => finish(hr);

    Logger.log(LogCategory.COM,
        `inproc: factory CreateInstance punk=0x${factoryPunk.toString(16)} fn=0x${createAddr.toString(16)}`);

    const { callbackId } = callbackManager.invokeCallback(
        createAddr,
        [factoryPunk, 0, riid, ppv],
        16,
        afterCreate,
        false,
        "inproc-FactoryCreate",
        frameId,
    );

    return {
        value: S_OK,
        suspendedForCallback: true,
        callbackId,
        stackCleanup: COCREATEINSTANCE_STACK_CLEANUP,
    };
}

/**
 * Try native inproc COM for the given CLSID.
 * Returns null to fall through to HLE; may return a Promise when LoadLibrary is required.
 */
export function tryInprocCoCreateInstance(
    process: Process,
    ctx: { esp: number; returnAddr?: number },
    mem: Uint8Array,
    args: InprocCoCreateArgs,
): ThunkResult | Promise<ThunkResult | null> | null {
    const resolved = resolveTreatAsClass(args.clsidNormalized);
    const redirected = resolved !== normalizeGuid(args.clsidNormalized);
    args = { ...args, clsidNormalized: resolved };
    // A failed redirect must not activate the original class via the HLE fallback.
    const activationResult = (result: ThunkResult | null): ThunkResult | null => {
        if (result !== null || !redirected) return result;
        if (args.ppv) Mem.writeUint32(args.ppv, 0);
        return { value: REGDB_E_CLASSNOTREG, stackCleanup: COCREATEINSTANCE_STACK_CLEANUP };
    };
    const dllPath = resolveInprocDllPath(args.clsidNormalized);
    if (!dllPath) return activationResult(null);

    const moduleName = dllPath.split(/[/\\]/).pop() ?? dllPath;
    const existing = process.moduleRegistry.getByName(moduleName);
    if (existing) {
        const getClassObject = process.moduleRegistry.getExportAddress(existing.name, "DllGetClassObject");
        if (!getClassObject) {
            Logger.warn(LogCategory.COM, `inproc: ${dllPath} loaded but no DllGetClassObject`);
            return activationResult(null);
        }
        // Sync path: the DLL is already loaded, no async park happens — [ctx.esp] still holds the real
        // guest return address. startGuestCreateChain reads it (returnAddr undefined → [ESP]).
        return activationResult(startGuestCreateChain(process, ctx, mem, args, dllPath, getClassObject));
    }

    return loadDllThenCreate(process, args, dllPath).then(activationResult);
}

/**
 * Async path: the inproc DLL must be loaded first, so CoCreateInstance becomes an async thunk and the
 * issuing thread is async-parked. We MUST NOT run the guest-callback chain (invokeCallback) here in the
 * Promise body — the thread is parked at the spin loop and a live-CPU mutation here is lost/raced (it
 * collided with _onAsyncComplete's return-to-guest restore → stack corruption → 0x7c07). Instead return
 * a ThunkResult.startCallbackChain: the dispatcher's safe apply point un-parks the thread (RUNNING, CPU
 * live) and calls it with the genuine guest return frame captured at park (esp/returnAddr from the async
 * park record). See thunk-dispatcher applyPendingAsyncRestoreAtSafePoint + the dllInits precedent.
 */
async function loadDllThenCreate(
    process: Process,
    args: InprocCoCreateArgs,
    dllPath: string,
): Promise<ThunkResult | null> {
    const loader = process.loader;
    if (!loader) return null;

    Logger.log(LogCategory.COM, `inproc: loading ${dllPath} for CLSID=${args.clsidNormalized}`);

    let module;
    try {
        module = await loader.loadDll(dllPath, true);
    } catch (e) {
        Logger.warn(LogCategory.COM, `inproc: loadDll("${dllPath}") failed: ${e}`);
        return null;
    }
    if (!module) return null;

    const dllInits = loader.getPendingDllInits();
    const getClassObject = process.moduleRegistry.getExportAddress(module.name, "DllGetClassObject");
    if (!getClassObject) {
        Logger.warn(LogCategory.COM, `inproc: ${dllPath} has no DllGetClassObject export`);
        return null;
    }

    return {
        value: S_OK,
        startCallbackChain: ({ esp, returnAddr, mem }) => {
            // Runs at the dispatcher's safe apply point: thread RUNNING, CPU live. ctx carries the genuine
            // guest return (returnAddr) so the chain's suspended frame records the real caller. Returns
            // whether the chain set up the callback (null = frame save / callback failed → caller falls back).
            const chainCtx = { esp, returnAddr };
            const r = dllInits.length > 0
                ? runDllMainChain(
                    process, chainCtx, COCREATEINSTANCE_STACK_CLEANUP, dllInits,
                    mem, args, dllPath, getClassObject,
                )
                : startGuestCreateChain(process, chainCtx, mem, args, dllPath, getClassObject);
            return r != null;
        },
    };
}
