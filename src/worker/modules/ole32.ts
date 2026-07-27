import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import { InterfaceRegistry, registerStandardDirectXInterfaces } from "../core/com/interface-registry";
import { ComObjectFactory, BaseComObject } from "../core/com/base-com-object";
import { SystemResourceProvider } from "../core/resources/system-resource-provider";
import { allocateComObject } from "../core/com/com-memory";
import { installComVtable, ComVtableMethod } from "../core/com/install-com-vtable";
import { tryInprocCoCreateInstance, startInprocFromFactory } from "../core/com/inproc-com";
import { Mem } from "../core/memory/mem-accessor";
import { writeGuestCode } from "../core/memory/guest-code";
import { MEM_THUNK_CODE_BASE, MEM_THUNK_CODE_SIZE } from "../core/cpu/emulator-config";

// COM error codes
const REGDB_E_CLASSNOTREG = 0x80040154;
const CO_E_CLASSSTRING = 0x800401F3;
const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const CO_E_NOTLOADED = 0x800401f0;

// BLOWFISH.DLL IBlockCipher::Submit_Key — stdcall, max 56-byte key (Ghidra @ 0x11002011)
const BF_MAX_KEY_LEN = 0x38;

// Thread-local storage for COM initialization state
const comInitialized = new Map<number, boolean>(); // Thread ID -> initialized

export class Ole32 implements IModule {
    name = "ole32";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private iunknownStubs: { QueryInterface: number; AddRef: number; Release: number } | null = null;
    private guidState = 0xa341316c;
    private guidCounter = 1;
    private blowfishInstances: Map<number, BlowfishState> = new Map(); // objAddr -> state
    private blowfishVtableAddr = 0;
    private classRegistrations = new Map<number, { clsid: string; punk: number; flags: number }>();
    private nextClassRegistration = 0x1000;
    private messageFilter = 0;

    // Map: object address in memory -> BaseComObject instance
    // This allows IUnknown methods to find the object by its memory address
    private objectAddressMap: Map<number, BaseComObject> = new Map();

    initialize(process: Process): void {
        this.process = process;
        const system = System.getInstance();
        const interfaceRegistry = InterfaceRegistry.getInstance();

        // Register standard DirectX interfaces
        registerStandardDirectXInterfaces();

        // Create universal IUnknown stubs that can be used by any COM object
        this.createIUnknownStubs();

        // CoInitialize - initialize COM library
        this.exports["CoInitialize"] = (ctx, mem, args) => {
            const pvReserved = args[0];

            Logger.log(LogCategory.COM, `CoInitialize called: pvReserved=0x${pvReserved.toString(16)}`);

            const threadId = System.getInstance().scheduler.getCurrentThreadId();
            comInitialized.set(threadId, true);

            Logger.verbose(LogCategory.COM, `CoInitialize: Thread ${threadId} initialized`);
            return S_OK;
        };

        // CoInitializeEx - initialize COM library with threading model
        this.exports["CoInitializeEx"] = (ctx, mem, args) => {
            const pvReserved = args[0];
            const coInit = args[1];

            Logger.log(LogCategory.COM, `CoInitializeEx called: pvReserved=0x${pvReserved.toString(16)}, coInit=0x${coInit.toString(16)}`);

            const threadId = System.getInstance().scheduler.getCurrentThreadId();
            if (comInitialized.get(threadId)) {
                return S_FALSE; // already initialized on this thread
            }
            comInitialized.set(threadId, true);
            return S_OK;
        };

        // CoUninitialize - uninitialize COM library
        this.exports["CoUninitialize"] = (ctx, mem, args) => {
            Logger.log(LogCategory.COM, 'CoUninitialize called');

            const threadId = System.getInstance().scheduler.getCurrentThreadId();
            if (comInitialized.delete(threadId)) {
                Logger.verbose(LogCategory.COM, `CoUninitialize: Thread ${threadId} uninitialized`);
            }

            return 0; // Return 0 for void function (COM convention)
        };

        // void CoFreeUnusedLibraries()
        this.exports["CoFreeUnusedLibraries"] = () => {
            Logger.verbose(LogCategory.COM, "CoFreeUnusedLibraries() - no-op");
            return 0;
        };

        // void CoFreeUnusedLibrariesEx(DWORD dwUnloadDelay, DWORD dwReserved)
        this.exports["CoFreeUnusedLibrariesEx"] = () => {
            Logger.verbose(LogCategory.COM, "CoFreeUnusedLibrariesEx() - no-op");
            return 0;
        };

        // CoCreateInstance - create COM object instance
        this.exports["CoCreateInstance"] = ((ctx, mem, args) => {
            const rclsid = args[0]; // CLSID pointer
            const pUnkOuter = args[1]; // Aggregation pointer
            const dwClsContext = args[2]; // Context
            const riid = args[3]; // IID pointer
            const ppv = args[4]; // Output pointer

            Logger.log(LogCategory.COM, `CoCreateInstance called: rclsid=0x${rclsid.toString(16)}, riid=0x${riid.toString(16)}, ppv=0x${ppv.toString(16)}`);

            if (!rclsid || !riid || !ppv) {
                Logger.warn(LogCategory.COM, 'CoCreateInstance: NULL pointer');
                return 0x80004003; // E_POINTER
            }

            // Aggregation not supported yet
            if (pUnkOuter !== 0) {
                Logger.warn(LogCategory.COM, 'CoCreateInstance: Aggregation not supported');
                return 0x80004001; // CLASS_E_NOAGGREGATION
            }

            // Read CLSID and IID from memory (GUID structure: 16 bytes)
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Validate memory bounds for GUID reading
            const guidSize = 16;
            if (rclsid + guidSize > mem.length || riid + guidSize > mem.length) {
                Logger.warn(LogCategory.COM, `CoCreateInstance: GUID read out of bounds (rclsid=0x${rclsid.toString(16)}, riid=0x${riid.toString(16)}, mem.length=${mem.length})`);
                if (ppv) {
                    view.setUint32(ppv, 0, true); // NULL
                }
                return 0x80004003; // E_POINTER
            }

            // Read CLSID from memory
            const clsidBytes = new Uint8Array(guidSize);
            for (let i = 0; i < guidSize; i++) {
                clsidBytes[i] = mem[rclsid + i];
            }

            // Read IID from memory
            const iidBytes = new Uint8Array(guidSize);
            for (let i = 0; i < guidSize; i++) {
                iidBytes[i] = mem[riid + i];
            }

            // Convert CLSID and IID bytes to string format (GUID format)
            const clsidStr = this.bytesToGuid(clsidBytes);
            const iidStr = this.bytesToGuid(iidBytes);
            const clsidNormalized = this.normalizeGuid(clsidStr);
            const iidNormalized = this.normalizeGuid(iidStr);

            Logger.log(LogCategory.COM, `CoCreateInstance: CLSID=${clsidStr}, IID=${iidStr}`);

            // CoRegisterClassObject — in-process factory registered at runtime
            const registeredFactory = this.findRegisteredClassFactory(clsidNormalized);
            if (registeredFactory !== 0) {
                const fromFactory = startInprocFromFactory(
                    this.process, ctx, mem, registeredFactory, riid, ppv,
                );
                if (fromFactory) {
                    Logger.log(LogCategory.COM,
                        `CoCreateInstance: using CoRegisterClassObject factory punk=0x${registeredFactory.toString(16)}`);
                    return fromFactory;
                }
            }

            // Generic native inproc COM (registry / ROM DLL → DllGetClassObject chain)
            const inprocArgs = { rclsid, riid, ppv, clsidNormalized };
            const inprocResult = tryInprocCoCreateInstance(this.process, ctx, mem, inprocArgs);
            if (inprocResult !== null) {
                if (inprocResult instanceof Promise) {
                    return inprocResult.then((r) =>
                        r ?? this.coCreateInstanceHle(mem, ppv, clsidStr, iidStr, clsidNormalized, iidNormalized),
                    );
                }
                return inprocResult;
            }

            return this.coCreateInstanceHle(mem, ppv, clsidStr, iidStr, clsidNormalized, iidNormalized);
        }) as ThunkImplementation;

        // CoCreateGuid - create a new GUID
        this.exports["CoCreateGuid"] = (ctx, mem, args) => {
            const pguid = args[0] >>> 0;
            if (!pguid) {
                return E_POINTER;
            }

            const guidBytes = this.createGuidBytes();
            if (Mem.writeBytes(pguid, guidBytes) !== 16) {
                return E_POINTER;
            }

            return S_OK;
        };

        // StringFromGUID2 - convert GUID to wide string: "{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"
        this.exports["StringFromGUID2"] = (ctx, mem, args) => {
            const rguid = args[0] >>> 0;
            const lpsz = args[1] >>> 0;
            const cchMax = args[2] | 0;

            if (!rguid || !lpsz || cchMax <= 0 || rguid + 16 > mem.length) {
                return 0;
            }

            const guidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) {
                guidBytes[i] = mem[rguid + i];
            }
            const guid = this.bytesToGuid(guidBytes).toUpperCase();
            const neededChars = guid.length + 1; // include null terminator
            if (cchMax < neededChars) {
                return 0;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < guid.length; i++) {
                view.setUint16(lpsz + i * 2, guid.charCodeAt(i), true);
            }
            view.setUint16(lpsz + guid.length * 2, 0, true);
            return neededChars;
        };

        // CLSIDFromString - parse GUID string to binary GUID
        this.exports["CLSIDFromString"] = (ctx, mem, args) => {
            const lpsz = args[0] >>> 0;
            const pclsid = args[1] >>> 0;
            if (!pclsid || pclsid + 16 > mem.length) {
                return CO_E_CLASSSTRING;
            }

            if (lpsz === 0) {
                // Per WinAPI, NULL string maps to GUID_NULL.
                mem.fill(0, pclsid, pclsid + 16);
                return S_OK;
            }

            const text = this.normalizeGuid(System.getInstance().process ? this.readWide(mem, lpsz) : this.readWide(mem, lpsz));
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
                return CO_E_CLASSSTRING;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const parts = text.split("-");
            const data1 = parseInt(parts[0], 16) >>> 0;
            const data2 = parseInt(parts[1], 16) & 0xffff;
            const data3 = parseInt(parts[2], 16) & 0xffff;
            const tail = parts[3] + parts[4];

            view.setUint32(pclsid + 0, data1, true);
            view.setUint16(pclsid + 4, data2, true);
            view.setUint16(pclsid + 6, data3, true);
            for (let i = 0; i < 8; i++) {
                mem[pclsid + 8 + i] = parseInt(tail.slice(i * 2, i * 2 + 2), 16) & 0xff;
            }
            return S_OK;
        };

        // LPVOID CoTaskMemAlloc(SIZE_T cb)
        this.exports["CoTaskMemAlloc"] = (ctx, mem, args) => {
            const cb = args[0] >>> 0;
            if (cb === 0) return 0;
            const ptr = System.getInstance().process?.memory?.alloc(cb);
            return ptr ? (ptr >>> 0) : 0;
        };

        // void CoTaskMemFree(LPVOID pv)
        this.exports["CoTaskMemFree"] = (ctx, mem, args) => {
            // No-op: small allocations aren't individually tracked for freeing.
            return 0;
        };

        // HRESULT OleInitialize(LPVOID pvReserved)
        this.exports["OleInitialize"] = (ctx, mem, args) => {
            Logger.log(LogCategory.COM, `OleInitialize called`);
            const threadId = System.getInstance().scheduler.getCurrentThreadId();
            comInitialized.set(threadId, true);
            return S_OK;
        };

        // void OleUninitialize()
        this.exports["OleUninitialize"] = (ctx, mem, args) => {
            Logger.log(LogCategory.COM, `OleUninitialize called`);
            const threadId = System.getInstance().scheduler.getCurrentThreadId();
            comInitialized.delete(threadId);
            return 0;
        };

        // HRESULT CoRegisterMessageFilter(LPMESSAGEFILTER lpMessageFilter, LPMESSAGEFILTER *lplpMessageFilter)
        this.exports["CoRegisterMessageFilter"] = (ctx, mem, args) => {
            const newFilter = args[0] >>> 0;
            const oldFilterOut = args[1] >>> 0;
            const oldFilter = this.messageFilter >>> 0;

            if (oldFilterOut && !Mem.writeUint32(oldFilterOut, oldFilter)) {
                return E_POINTER;
            }

            this.messageFilter = newFilter;
            Logger.verbose(
                LogCategory.COM,
                `CoRegisterMessageFilter(new=0x${newFilter.toString(16)}, old=0x${oldFilter.toString(16)})`
            );
            return S_OK;
        };

        // HRESULT CoRegisterClassObject(REFCLSID rclsid, LPUNKNOWN pUnk, DWORD dwClsContext, DWORD flags, LPDWORD lpdwRegister)
        this.exports["CoRegisterClassObject"] = (ctx, mem, args) => {
            const rclsid = args[0] >>> 0;
            const punk = args[1] >>> 0;
            const dwClsContext = args[2] >>> 0;
            const flags = args[3] >>> 0;
            const lpdwRegister = args[4] >>> 0;

            if (!lpdwRegister) {
                return E_POINTER;
            }
            if (!rclsid || rclsid + 16 > mem.length) {
                return E_INVALIDARG;
            }
            if (!punk) {
                return E_INVALIDARG;
            }

            const clsidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) clsidBytes[i] = mem[rclsid + i];
            const clsid = this.bytesToGuid(clsidBytes);

            this.addRefGuestUnknown(punk);

            const cookie = this.nextClassRegistration++ >>> 0;
            this.classRegistrations.set(cookie, { clsid, punk, flags });
            Mem.writeUint32(lpdwRegister, cookie);

            Logger.log(LogCategory.COM,
                `CoRegisterClassObject: CLSID=${clsid} punk=0x${punk.toString(16)} ` +
                `context=0x${dwClsContext.toString(16)} flags=0x${flags.toString(16)} cookie=0x${cookie.toString(16)}`);
            return S_OK;
        };

        // HRESULT CoRevokeClassObject(DWORD dwRegister)
        this.exports["CoRevokeClassObject"] = (ctx, mem, args) => {
            const cookie = args[0] >>> 0;
            const reg = this.classRegistrations.get(cookie);
            if (!reg) {
                Logger.verbose(LogCategory.COM, `CoRevokeClassObject(0x${cookie.toString(16)}) — not registered`);
                return CO_E_NOTLOADED;
            }

            this.classRegistrations.delete(cookie);
            this.releaseGuestUnknown(reg.punk);
            Logger.verbose(LogCategory.COM,
                `CoRevokeClassObject(0x${cookie.toString(16)}) CLSID=${reg.clsid} punk=0x${reg.punk.toString(16)}`);
            return S_OK;
        };

        // HRESULT CoDisconnectObject(LPUNKNOWN pUnk, DWORD dwReserved)
        this.exports["CoDisconnectObject"] = (ctx, mem, args) => {
            Logger.verbose(LogCategory.COM, `CoDisconnectObject(0x${args[0].toString(16)}) — stub`);
            return S_OK;
        };

        // HRESULT OleRun(LPUNKNOWN pUnknown)
        this.exports["OleRun"] = (ctx, mem, args) => {
            Logger.verbose(LogCategory.COM, `OleRun(0x${args[0].toString(16)}) — stub`);
            return S_OK;
        };

        // HRESULT StgCreateDocfile(LPCOLESTR pwcsName, DWORD grfMode, DWORD reserved, IStorage **ppstgOpen)
        this.exports["StgCreateDocfile"] = (ctx, mem, args) => {
            const ppstgOpen = args[3] >>> 0;
            Logger.warn(LogCategory.COM, `StgCreateDocfile — stub, returning E_NOTIMPL`);
            if (ppstgOpen) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppstgOpen, 0, true);
            }
            return 0x80004001; // E_NOTIMPL
        };

        // HRESULT StgOpenStorage(LPCOLESTR pwcsName, IStorage *pstgPriority, DWORD grfMode, SNB snbExclude, DWORD reserved, IStorage **ppstgOpen)
        this.exports["StgOpenStorage"] = (ctx, mem, args) => {
            const ppstgOpen = args[5] >>> 0;
            Logger.warn(LogCategory.COM, `StgOpenStorage — stub, returning STG_E_FILENOTFOUND`);
            if (ppstgOpen) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppstgOpen, 0, true);
            }
            return 0x80030002; // STG_E_FILENOTFOUND
        };

        // HRESULT CoFileTimeNow(FILETIME *lpFileTime)
        this.exports["CoFileTimeNow"] = (ctx, mem, args) => {
            const lpFileTime = args[0] >>> 0;
            if (!lpFileTime || lpFileTime + 8 > mem.length) return E_POINTER;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const now = BigInt(Date.now());
            const windowsTicks = (now + 11644473600000n) * 10000n;
            view.setBigUint64(lpFileTime, windowsTicks, true);
            return S_OK;
        };

        // HRESULT StringFromCLSID(REFCLSID rclsid, LPOLESTR *lplpsz)
        this.exports["StringFromCLSID"] = (ctx, mem, args) => {
            const rclsid = args[0] >>> 0;
            const lplpsz = args[1] >>> 0;

            if (!rclsid || !lplpsz || rclsid + 16 > mem.length) return E_POINTER;

            const guidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) guidBytes[i] = mem[rclsid + i];
            const guid = this.bytesToGuid(guidBytes).toUpperCase();

            // Allocate wide string via CoTaskMemAlloc
            const byteLen = (guid.length + 1) * 2;
            const ptr = System.getInstance().process?.memory?.alloc(byteLen);
            if (!ptr) return 0x8007000E; // E_OUTOFMEMORY

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < guid.length; i++) {
                view.setUint16(ptr + i * 2, guid.charCodeAt(i), true);
            }
            view.setUint16(ptr + guid.length * 2, 0, true);
            view.setUint32(lplpsz, ptr, true);
            return S_OK;
        };

        // HRESULT OleSaveToStream(LPPERSISTSTREAM pPStm, LPSTREAM pStm)
        this.exports["OleSaveToStream"] = (ctx, mem, args) => {
            Logger.warn(LogCategory.COM, `OleSaveToStream — stub, returning E_NOTIMPL`);
            return 0x80004001; // E_NOTIMPL
        };

        // HRESULT OleLoadFromStream(LPSTREAM pStm, REFIID iidInterface, LPVOID *ppvObj)
        this.exports["OleLoadFromStream"] = (ctx, mem, args) => {
            const ppvObj = args[2] >>> 0;
            Logger.warn(LogCategory.COM, `OleLoadFromStream — stub, returning E_NOTIMPL`);
            if (ppvObj) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppvObj, 0, true);
            }
            return 0x80004001; // E_NOTIMPL
        };

        // HRESULT PropVariantClear(PROPVARIANT *pvar)
        //
        // PROPVARIANT layout (x86, 16 bytes):
        //   +0  VARTYPE vt         (2 bytes) — type tag
        //   +2  WORD wReserved1
        //   +4  WORD wReserved2
        //   +6  WORD wReserved3
        //   +8  union              (8 bytes) — the payload
        //
        // For pointer-bearing types the payload at +8 is a 32-bit guest pointer.
        // VT_BLOB stores cbSize at +8 and pBlobData at +12.
        // VT_VECTOR types store cElems at +8 and pElems at +12.
        //
        // Memory ownership rules (matching Windows behaviour):
        //   VT_BSTR          — payload is BSTR; free via SysFreeString (oleaut32)
        //   VT_LPSTR         — payload is LPSTR;  free via CoTaskMemFree
        //   VT_LPWSTR        — payload is LPWSTR; free via CoTaskMemFree
        //   VT_CLSID         — payload is CLSID*; free via CoTaskMemFree
        //   VT_BLOB          — pBlobData at +12;   free via CoTaskMemFree
        //   VT_DISPATCH/
        //   VT_UNKNOWN       — IUnknown::Release on the stored pointer (best-effort)
        //   All others       — no allocation to free (scalar / stack value)
        // After freeing, zero the entire 16-byte struct (sets vt = VT_EMPTY).
        this.exports["PropVariantClear"] = (ctx, mem, args) => {
            const pvar = args[0] >>> 0;

            if (!pvar) return E_POINTER;
            if (pvar + 16 > mem.length) return E_INVALIDARG;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const vt = view.getUint16(pvar, true);

            // Strip VT_VECTOR / VT_ARRAY / VT_BYREF modifier bits to get the base type.
            // For this emulation we only handle the scalar allocation cases;
            // vector/array freeing is left as a no-op (memory leaks are benign here).
            const VT_VECTOR = 0x1000;
            const VT_ARRAY  = 0x2000;
            const VT_BYREF  = 0x4000;
            const baseVt = vt & ~(VT_VECTOR | VT_ARRAY | VT_BYREF);
            const hasModifier = (vt & (VT_VECTOR | VT_ARRAY)) !== 0;

            if (!hasModifier) {
                // --- BSTR (VT_BSTR = 8) ---
                // Freed through SysFreeString: locate oleaut32 and call its export.
                const VT_BSTR = 8;
                if (baseVt === VT_BSTR) {
                    const bstr = view.getUint32(pvar + 8, true);
                    if (bstr) {
                        // Delegate to the oleaut32 SysFreeString thunk if available.
                        const oleaut32 = System.getInstance().process?.modules?.get("oleaut32");
                        if (oleaut32 && typeof (oleaut32 as any).exports?.["SysFreeString"] === "function") {
                            (oleaut32 as any).exports["SysFreeString"](ctx, mem, [bstr]);
                        }
                        // If oleaut32 isn't loaded we simply clear the pointer — the BSTR
                        // allocator isn't individually tracked so there is nothing to free.
                    }
                }

                // --- CoTaskMemFree types: LPSTR (30), LPWSTR (31), CLSID* (72) ---
                const VT_LPSTR  = 30;
                const VT_LPWSTR = 31;
                const VT_CLSID  = 72;
                if (baseVt === VT_LPSTR || baseVt === VT_LPWSTR || baseVt === VT_CLSID) {
                    const ptr = view.getUint32(pvar + 8, true);
                    if (ptr) {
                        // CoTaskMemFree is a no-op stub in our allocator model, but
                        // calling through the registered export keeps the call-trace correct.
                        this.exports["CoTaskMemFree"]?.(ctx, mem, [ptr]);
                    }
                }

                // --- BLOB (VT_BLOB = 65): cbSize at +8, pBlobData at +12 ---
                const VT_BLOB = 65;
                if (baseVt === VT_BLOB) {
                    const pBlobData = view.getUint32(pvar + 12, true);
                    if (pBlobData) {
                        this.exports["CoTaskMemFree"]?.(ctx, mem, [pBlobData]);
                    }
                }

                // --- IDispatch (9) / IUnknown (13): call Release ---
                const VT_DISPATCH = 9;
                const VT_UNKNOWN  = 13;
                if (baseVt === VT_DISPATCH || baseVt === VT_UNKNOWN) {
                    const punk = view.getUint32(pvar + 8, true);
                    if (punk) {
                        // Best-effort: call Release through the guest vtable if mapped.
                        this.releaseGuestUnknown(punk);
                    }
                }
            }
            // For VT_VECTOR / VT_ARRAY we skip element-wise freeing (acceptable
            // for the vast majority of titles that use only scalar PROPVARIANT values).

            // Zero the entire PROPVARIANT → vt becomes VT_EMPTY (0).
            mem.fill(0, pvar, pvar + 16);

            Logger.verbose(LogCategory.COM, `PropVariantClear(0x${pvar.toString(16)}) vt=0x${vt.toString(16)}`);
            return S_OK;
        };
    }

    /**
     * Create universal IUnknown stubs that can be used by any COM object
     * These stubs will look up the object by address and call methods on BaseComObject
     */
    private createIUnknownStubs(): void {
        const system = System.getInstance();
        const resourceProvider = SystemResourceProvider.getInstance();

        // Register universal IUnknown methods in exports
        // These will be called through thunk dispatcher when game calls VTable methods

        // COM_IUnknown_QueryInterface - universal QueryInterface implementation
        this.exports["COM_IUnknown_QueryInterface"] = (ctx, mem, args) => {
            const thisPtr = args[0];
            const riid = args[1];
            const ppvObject = args[2];

            Logger.verbose(LogCategory.COM, `COM_IUnknown_QueryInterface: thisPtr=0x${thisPtr.toString(16)}, riid=0x${riid.toString(16)}, ppvObject=0x${ppvObject.toString(16)}`);

            // Get COM object by memory address
            const obj = resourceProvider.getComObjectByAddress(thisPtr);
            if (!obj) {
                Logger.warn(LogCategory.COM, `COM_IUnknown_QueryInterface: Invalid object 0x${thisPtr.toString(16)}`);
                if (ppvObject) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(ppvObject, 0, true); // NULL
                }
                return 0x80004002; // E_NOINTERFACE
            }

            // Read IID from memory
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) {
                iidBytes[i] = mem[riid + i];
            }
            const iidStr = this.bytesToGuid(iidBytes);

            return obj.queryInterface(iidStr, ppvObject, mem);
        };

        // COM_IUnknown_AddRef - universal AddRef implementation
        this.exports["COM_IUnknown_AddRef"] = (ctx, mem, args) => {
            const thisPtr = args[0];

            Logger.verbose(LogCategory.COM, `COM_IUnknown_AddRef: thisPtr=0x${thisPtr.toString(16)}`);

            const obj = resourceProvider.getComObjectByAddress(thisPtr);
            if (!obj) {
                Logger.warn(LogCategory.COM, `COM_IUnknown_AddRef: Invalid object 0x${thisPtr.toString(16)}`);
                return 0;
            }

            return obj.addRef();
        };

        // COM_IUnknown_Release - universal Release implementation
        this.exports["COM_IUnknown_Release"] = (ctx, mem, args) => {
            const thisPtr = args[0];

            Logger.verbose(LogCategory.COM, `COM_IUnknown_Release: thisPtr=0x${thisPtr.toString(16)}`);

            const obj = resourceProvider.getComObjectByAddress(thisPtr);
            if (!obj) {
                Logger.warn(LogCategory.COM, `COM_IUnknown_Release: Invalid object 0x${thisPtr.toString(16)}`);
                return 0;
            }

            return obj.release();
        };

        // Register these methods in dispatcher and create thunk stubs
        this.process.dispatcher.registerModule("ole32_iunknown", {
            "COM_IUnknown_QueryInterface": this.exports["COM_IUnknown_QueryInterface"],
            "COM_IUnknown_AddRef": this.exports["COM_IUnknown_AddRef"],
            "COM_IUnknown_Release": this.exports["COM_IUnknown_Release"]
        });

        // Create thunk stubs for IUnknown methods
        const stubDll = this.process.thunkGenerator.generateStubDll("ole32_iunknown", [
            { name: "COM_IUnknown_QueryInterface", argCount: 3 },
            { name: "COM_IUnknown_AddRef", argCount: 1 },
            { name: "COM_IUnknown_Release", argCount: 1 }
        ]);

        // Allocate memory for stub code
        const stubAddress = this.process.memory.alloc(stubDll.stubCode.length);
        const currentMemory = this.process.getCurrentMemory();
        writeGuestCode(currentMemory, stubDll.stubCode, stubAddress);

        Logger.verbose(LogCategory.COM, `OLE32: Allocated ${stubDll.stubCode.length} bytes for IUnknown stubs at 0x${stubAddress.toString(16)}`);

        // Update export table with allocated addresses
        const updatedExportTable = new Map<string, number>();
        for (const [name, originalAddr] of stubDll.exportTable) {
            const offset = originalAddr - stubDll.baseAddress;
            const newAddr = stubAddress + offset;
            updatedExportTable.set(name, newAddr);
        }

        // Get stub addresses
        const queryInterfaceAddr = updatedExportTable.get("com_iunknown_queryinterface");
        const addRefAddr = updatedExportTable.get("com_iunknown_addref");
        const releaseAddr = updatedExportTable.get("com_iunknown_release");

        if (!queryInterfaceAddr || !addRefAddr || !releaseAddr) {
            Logger.error(LogCategory.COM, 'Failed to create IUnknown stubs');
            return;
        }

        this.iunknownStubs = {
            QueryInterface: queryInterfaceAddr,
            AddRef: addRefAddr,
            Release: releaseAddr
        };

        Logger.log(LogCategory.COM, `Created IUnknown stubs: QueryInterface=0x${queryInterfaceAddr.toString(16)}, AddRef=0x${addRefAddr.toString(16)}, Release=0x${releaseAddr.toString(16)}`);

        // Apply any pending registrations now that stubs are created
        if (this.process.dispatcher) {
            this.process.dispatcher.applyPendingRegistrations();
        }
    }

    /**
     * Convert GUID bytes to string format
     */
    private bytesToGuid(bytes: Uint8Array): string {
        // GUID format: {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}
        const data1 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
        const data2 = (bytes[4] | (bytes[5] << 8)) >>> 0;
        const data3 = (bytes[6] | (bytes[7] << 8)) >>> 0;
        const data4 = Array.from(bytes.slice(8, 16))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        return `{${data1.toString(16).padStart(8, '0')}-${data2.toString(16).padStart(4, '0')}-${data3.toString(16).padStart(4, '0')}-${data4.slice(0, 4)}-${data4.slice(4)}}`;
    }

    private normalizeGuid(value: string): string {
        return value.replace(/[{}]/g, "").toLowerCase();
    }

    /** HLE / InterfaceRegistry CoCreateInstance path (after native inproc attempt). */
    private coCreateInstanceHle(
        mem: Uint8Array,
        ppv: number,
        clsidStr: string,
        iidStr: string,
        clsidNormalized: string,
        iidNormalized: string,
    ): number {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const interfaceRegistry = InterfaceRegistry.getInstance();
        const process = this.process;

        let targetIID = iidNormalized;
        if (clsidNormalized === "d7b70ee0-4340-11cf-b063-0020afc2cd35") {
            if (!interfaceRegistry.isRegistered(iidNormalized)) {
                Logger.verbose(LogCategory.COM, `CoCreateInstance: DirectDraw CLSID detected, trying IDirectDraw7 IID`);
                targetIID = "15e65ec0-3b9c-11d2-b92f-00c04fc2c602";
            }
        } else if (clsidNormalized === "25e609e0-b259-11cf-bfc7-444553540000") {
            if (!interfaceRegistry.isRegistered(iidNormalized)) {
                Logger.verbose(LogCategory.COM, `CoCreateInstance: DirectInput CLSID detected, trying IDirectInputA IID`);
                targetIID = "89521360-AA8A-11CF-BFC7-444553540000";
            }
        } else if (clsidNormalized === "25e609e4-b259-11cf-bfc7-444553540000") {
            if (!interfaceRegistry.isRegistered(iidNormalized)) {
                Logger.verbose(LogCategory.COM, `CoCreateInstance: DirectInput8 CLSID detected, trying IDirectInput8W IID`);
                targetIID = "bf798031-483a-4da2-aa99-5d64ed369700";
            }
        } else if (clsidNormalized === "2fe8f810-b2a5-11d0-a787-0000f803abfc") {
            if (!interfaceRegistry.isRegistered(iidNormalized)) {
                Logger.verbose(LogCategory.COM, `CoCreateInstance: DirectPlay Lobby CLSID detected, trying IDirectPlayLobby3A IID`);
                targetIID = "2db72491-652c-11d1-a7a8-0000f803abfc";
            }
        } else if (clsidNormalized === "d8f1eee0-f634-11cf-8700-00a0245d918b") {
            Logger.log(LogCategory.COM, `CoCreateInstance: CLSID_A3d (A3D 1.0) detected, A3D not available — returning REGDB_E_CLASSNOTREG`);
            if (ppv) view.setUint32(ppv, 0, true);
            return REGDB_E_CLASSNOTREG;
        } else if (clsidNormalized === "92fa2c24-253c-11d2-90fb-006008a1f441") {
            Logger.log(LogCategory.COM, `CoCreateInstance: A3D CLSID detected, A3D not available — returning REGDB_E_CLASSNOTREG`);
            if (ppv) view.setUint32(ppv, 0, true);
            return REGDB_E_CLASSNOTREG;
        } else if (clsidNormalized === "5959df60-2911-11d1-b049-0020af30269a") {
            Logger.warn(LogCategory.COM, `CoCreateInstance: Immersion TouchSense CLSID ${clsidStr} not supported, returning REGDB_E_CLASSNOTREG`);
            if (ppv) view.setUint32(ppv, 0, true);
            return REGDB_E_CLASSNOTREG;
        } else if (clsidNormalized === "e436ebb3-524f-11ce-9f53-0020af0ba770") {
            Logger.log(LogCategory.COM, `CoCreateInstance: FilterGraph CLSID detected, routing to Quartz`);
        } else if (clsidNormalized === "1440ad10-6aa8-11d1-b6f9-00a024ddafd1") {
            Logger.warn(LogCategory.COM, `CoCreateInstance: Blowfish inproc failed, falling back to HLE`);
            const objAddr = this.createBlowfishObject(mem, view, ppv);
            if (objAddr) return S_OK;
            return REGDB_E_CLASSNOTREG;
        } else if (clsidNormalized === "47d4d946-62e8-11cf-93bc-444553540000") {
            const dsoundModule = this.process.modules.get("dsound") as { exports?: { directsoundcreate8?: Function; directsoundcreate?: Function } } | undefined;
            // Preserve the interface generation: IID_IDirectSound8 → DS8 (enforces the DX8
            // 3D-buffer rules), any other IID (IID_IDirectSound / IUnknown) → legacy, which
            // skips those rules. Getting this wrong makes legacy titles (Max Payne) hit the
            // DS8-only CTRL3D+CTRLPAN rejection and crash — see dsound CreateSoundBuffer.
            const wantsDs8 = iidNormalized === "c50a7e93-f395-4834-9ef6-7fa99de50966";
            const creator = wantsDs8 ? dsoundModule?.exports?.directsoundcreate8 : dsoundModule?.exports?.directsoundcreate;
            if (creator) {
                Logger.log(LogCategory.COM, `CoCreateInstance: DirectSound CLSID via DirectSoundCreate${wantsDs8 ? "8" : ""} (IID=${iidStr})`);
                const result = creator(null, mem, [0, ppv, 0]);
                return result === 0 ? S_OK : REGDB_E_CLASSNOTREG;
            }
            Logger.warn(LogCategory.COM, `CoCreateInstance: DirectSound CLSID but dsound module not loaded — returning REGDB_E_CLASSNOTREG`);
            if (ppv) view.setUint32(ppv, 0, true);
            return REGDB_E_CLASSNOTREG;
        } else if (clsidNormalized === "d1eb6d20-8923-11d0-9d97-00a0c90a43cb") {
            if (!interfaceRegistry.isRegistered(iidNormalized)) {
                Logger.log(LogCategory.COM, `CoCreateInstance: DirectPlay CLSID detected, requested IID ${iidStr} not found, trying IDirectPlay4A IID`);
                targetIID = "0ab1c531-4745-11d1-a7a1-0000f803abfc";
            } else {
                Logger.verbose(LogCategory.COM, `CoCreateInstance: DirectPlay CLSID detected, requested IID ${iidStr} is registered`);
            }
        }

        const mapping = interfaceRegistry.getMapping(targetIID);
        if (!mapping) {
            Logger.warn(LogCategory.COM, `CoCreateInstance: CLSID/IID not found: CLSID=${clsidStr}, IID=${iidStr} (tried ${targetIID})`);
            if (ppv) view.setUint32(ppv, 0, true);
            return REGDB_E_CLASSNOTREG;
        }

        Logger.verbose(LogCategory.COM, `CoCreateInstance: Found mapping ${targetIID} -> ${mapping.className}`);

        const registeredIIDs = ComObjectFactory.getRegisteredIIDs();
        const isRegistered = registeredIIDs.some(regIid => regIid.toLowerCase() === targetIID.toLowerCase());
        if (!isRegistered) {
            Logger.warn(LogCategory.COM, `CoCreateInstance: IID ${iidStr} not registered in ComObjectFactory`);
            if (ppv) view.setUint32(ppv, 0, true);
            return REGDB_E_CLASSNOTREG;
        }

        let vtableAddr: number;
        const ddrawModule = this.process.modules.get("ddraw") as { vtables?: Record<string, { address: number }> } | undefined;
        const dinputModule = this.process.modules.get("dinput") as { vtables?: Record<string, { address: number }> } | undefined;
        const dplayxModule = this.process.modules.get("dplayx") as { vtables?: Record<string, { address: number }> } | undefined;

        if (mapping.moduleName === "ddraw") {
            const specificVtable = ddrawModule?.vtables?.[mapping.className];
            if (specificVtable) {
                vtableAddr = specificVtable.address;
            } else if (ddrawModule?.vtables?.IDirectDraw7) {
                Logger.warn(LogCategory.COM, `CoCreateInstance: VTable for ${mapping.className} NOT FOUND! Fallback to IDirectDraw7 (DANGEROUS Mismatch)`);
                vtableAddr = ddrawModule.vtables.IDirectDraw7.address;
            } else {
                if (ppv) view.setUint32(ppv, 0, true);
                return 0x80004002;
            }
        } else if (mapping.moduleName === "dinput") {
            const specificVtable = dinputModule?.vtables?.[mapping.className];
            if (specificVtable) {
                vtableAddr = specificVtable.address;
            } else if (dinputModule?.vtables?.IDirectInput8W) {
                Logger.warn(LogCategory.COM, `CoCreateInstance: VTable for ${mapping.className} NOT FOUND! Fallback to IDirectInput8W`);
                vtableAddr = dinputModule.vtables.IDirectInput8W.address;
            } else if (dinputModule?.vtables?.IDirectInput8A) {
                Logger.warn(LogCategory.COM, `CoCreateInstance: VTable for ${mapping.className} NOT FOUND! Fallback to IDirectInput8A`);
                vtableAddr = dinputModule.vtables.IDirectInput8A.address;
            } else if (dinputModule?.vtables?.IDirectInputA) {
                Logger.warn(LogCategory.COM, `CoCreateInstance: VTable for ${mapping.className} NOT FOUND! Fallback to IDirectInputA (DANGEROUS Mismatch)`);
                vtableAddr = dinputModule.vtables.IDirectInputA.address;
            } else {
                if (ppv) view.setUint32(ppv, 0, true);
                return 0x80004002;
            }
        } else if (mapping.moduleName === "dplayx") {
            const specificVtable = dplayxModule?.vtables?.[mapping.className];
            if (!specificVtable) {
                if (ppv) view.setUint32(ppv, 0, true);
                return 0x80004002;
            }
            vtableAddr = specificVtable.address;
        } else if (mapping.moduleName === "quartz") {
            const quartzMod = this.process.modules.get("quartz") as { vtables?: Record<string, { address: number }> } | undefined;
            const specificVtable = quartzMod?.vtables?.[mapping.className];
            if (!specificVtable) {
                if (ppv) view.setUint32(ppv, 0, true);
                return 0x80004002;
            }
            vtableAddr = specificVtable.address;
        } else if (mapping.moduleName === "a3d") {
            const a3dMod = this.process.modules.get("a3d") as { vtables?: Record<string, { address: number }> } | undefined;
            const specificVtable = a3dMod?.vtables?.[mapping.className];
            if (!specificVtable) {
                if (ppv) view.setUint32(ppv, 0, true);
                return 0x80004002;
            }
            vtableAddr = specificVtable.address;
        } else {
            if (!this.iunknownStubs) {
                if (ppv) view.setUint32(ppv, 0, true);
                return REGDB_E_CLASSNOTREG;
            }
            vtableAddr = process.memory.alloc(12);
            const vtableView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            vtableView.setUint32(vtableAddr, this.iunknownStubs.QueryInterface, true);
            vtableView.setUint32(vtableAddr + 4, this.iunknownStubs.AddRef, true);
            vtableView.setUint32(vtableAddr + 8, this.iunknownStubs.Release, true);
        }

        const obj = ComObjectFactory.create(targetIID, vtableAddr);
        if (!obj) {
            if (ppv) view.setUint32(ppv, 0, true);
            return REGDB_E_CLASSNOTREG;
        }

        const objAddress = allocateComObject(this.process.memory, mem, vtableAddr);
        SystemResourceProvider.getInstance().mapAddressToHandle(objAddress, obj.handle);
        if (ppv) view.setUint32(ppv, objAddress, true);

        Logger.log(LogCategory.COM, `CoCreateInstance: Created ${mapping.className} at 0x${objAddress.toString(16)}, vtable=0x${vtableAddr.toString(16)}, handle=0x${obj.handle.toString(16)}`);

        if (targetIID === "9ae07221-8ac4-11d3-b6aa-00600879f3ee") {
            const vtableEntryCount = 51;
            const readBackVtable = view.getUint32(objAddress, true);
            if (readBackVtable !== vtableAddr) {
                Logger.warn(LogCategory.COM, `ActiveX3D vtable mismatch at 0x${objAddress.toString(16)}: got=0x${readBackVtable.toString(16)} expected=0x${vtableAddr.toString(16)}`);
            }
            const badEntries: string[] = [];
            for (let i = 0; i < vtableEntryCount + 4; i++) {
                const entryAddr = vtableAddr + i * 4;
                const entryVal = view.getUint32(entryAddr, true);
                const inThunkRegion = entryVal >= MEM_THUNK_CODE_BASE && entryVal < (MEM_THUNK_CODE_BASE + MEM_THUNK_CODE_SIZE);
                if (!inThunkRegion || i >= vtableEntryCount) {
                    badEntries.push(`[${i}]=0x${entryVal.toString(16)}`);
                }
            }
            if (badEntries.length > 0) {
                Logger.error(LogCategory.COM, `ActiveX3D invalid vtable entries: ${badEntries.join(', ')}`);
            }
        }

        return S_OK;
    }

    /** Find a CoRegisterClassObject factory for the given CLSID. */
    private findRegisteredClassFactory(clsidNormalized: string): number {
        for (const reg of this.classRegistrations.values()) {
            if (this.normalizeGuid(reg.clsid) === clsidNormalized) {
                return reg.punk >>> 0;
            }
        }
        return 0;
    }

    /** Best-effort AddRef for a guest IUnknown* passed to CoRegisterClassObject. */
    private addRefGuestUnknown(punk: number): void {
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(punk);
        if (obj) {
            obj.addRef();
            return;
        }
        const mem = this.process.getCurrentMemory();
        if (punk + 4 > mem.length) return;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const vtable = view.getUint32(punk, true) >>> 0;
        if (vtable + 8 > mem.length) return;
        const addRefAddr = view.getUint32(vtable + 4, true) >>> 0;
        if (addRefAddr < 0x10000) return;
        Logger.verbose(LogCategory.COM, `CoRegisterClassObject: guest AddRef skipped for punk=0x${punk.toString(16)} (stub at 0x${addRefAddr.toString(16)})`);
    }

    /** Best-effort Release paired with addRefGuestUnknown. */
    private releaseGuestUnknown(punk: number): void {
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(punk);
        if (obj) {
            obj.release();
            return;
        }
        Logger.verbose(LogCategory.COM, `CoRevokeClassObject: guest Release skipped for punk=0x${punk.toString(16)}`);
    }

    private readWide(mem: Uint8Array, addr: number): string {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let out = "";
        let p = addr;
        while (p + 1 < mem.length) {
            const ch = view.getUint16(p, true);
            if (ch === 0) break;
            out += String.fromCharCode(ch);
            p += 2;
        }
        return out;
    }

    private nextGuidWord(): number {
        // xorshift32-based PRNG with monotonic counter mix for GUID generation.
        let x = (this.guidState ^ this.guidCounter) >>> 0;
        x ^= (x << 13) >>> 0;
        x ^= x >>> 17;
        x ^= (x << 5) >>> 0;
        this.guidState = x >>> 0;
        this.guidCounter = (this.guidCounter + 1) >>> 0;
        return this.guidState;
    }

    private createGuidBytes(): Uint8Array {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i += 4) {
            const word = this.nextGuidWord();
            bytes[i] = word & 0xff;
            bytes[i + 1] = (word >>> 8) & 0xff;
            bytes[i + 2] = (word >>> 16) & 0xff;
            bytes[i + 3] = (word >>> 24) & 0xff;
        }

        // UUID v4 layout bits (version and variant).
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        return bytes;
    }

    /**
     * Create a Blowfish COM object (IBlockCipher vtable: QI, AddRef, Release, Submit_Key, Encrypt, Decrypt)
     */
    private createBlowfishObject(mem: Uint8Array, view: DataView, ppv: number): number {
        const process = this.process;
        const system = System.getInstance();

        // Create vtable stubs once
        if (!this.blowfishVtableAddr) {
            // Register Blowfish thunk implementations
            this.exports["BF_QueryInterface"] = (ctx, m, args) => {
                const thisPtr = args[0];
                const ppvOut = args[2] >>> 0;
                // Return self for any QI — game only asks for IUnknown or IBlockCipher
                if (ppvOut) {
                    const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
                    v.setUint32(ppvOut, thisPtr, true);
                }
                // AddRef
                const bf = this.blowfishInstances.get(thisPtr);
                if (bf) bf.refCount++;
                return S_OK;
            };
            this.exports["BF_AddRef"] = (ctx, m, args) => {
                const bf = this.blowfishInstances.get(args[0]);
                if (bf) return ++bf.refCount;
                return 1;
            };
            this.exports["BF_Release"] = (ctx, m, args) => {
                const bf = this.blowfishInstances.get(args[0]);
                if (!bf) return 0;
                if (--bf.refCount <= 0) {
                    this.blowfishInstances.delete(args[0]);
                    return 0;
                }
                return bf.refCount;
            };
            // HRESULT Submit_Key(LONG length, LPVOID key) — stdcall; real BLOWFISH.DLL @ 0x11002011
            this.exports["BF_Submit_Key"] = (ctx, m, args) => {
                const thisPtr = args[0];
                const keyLen = args[1] | 0;
                const keyPtr = args[2] >>> 0;
                const bf = this.blowfishInstances.get(thisPtr);
                if (!bf) return 0x80004005; // E_FAIL
                if (!keyPtr) return E_POINTER;
                if (keyLen < 0 || keyLen > BF_MAX_KEY_LEN) return E_INVALIDARG;
                const keyData = Mem.readBytes(keyPtr, keyLen);
                if (!keyData) return E_INVALIDARG;
                bf.cipher.submitKey(keyData);
                Logger.log(LogCategory.COM, `Blowfish: Submit_Key len=${keyLen} ptr=0x${keyPtr.toString(16)}`);
                return S_OK;
            };
            // IBlockCipher vtable slots 4–5 (BLOWFISH.DLL @ 0x1100204d / 0x1100206c) — RET 8
            this.exports["BF_Get_Max_Key_Length"] = (ctx, m, args) => {
                const outPtr = args[1] >>> 0;
                if (!outPtr) return E_POINTER;
                Mem.writeUint32(outPtr, BF_MAX_KEY_LEN);
                return S_OK;
            };
            this.exports["BF_Get_Block_Size"] = (ctx, m, args) => {
                const outPtr = args[1] >>> 0;
                if (!outPtr) return E_POINTER;
                Mem.writeUint32(outPtr, 8);
                return S_OK;
            };
            // HRESULT Encrypt(...) — stdcall RET 16; src @ arg2, dst @ arg3 (BLOWFISH.DLL @ 0x1100208b)
            this.exports["BF_Encrypt"] = (ctx, m, args) => {
                const thisPtr = args[0];
                const dataLen = args[1] | 0;
                const srcPtr = args[2] >>> 0;
                const dstPtr = (args[3] >>> 0) || srcPtr;
                const bf = this.blowfishInstances.get(thisPtr);
                if (!bf) return 0x80004005;
                if (!srcPtr || !dstPtr) return E_POINTER;
                if (dataLen < 0) return E_INVALIDARG;
                const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
                bf.cipher.transformBuffer(v, srcPtr, dstPtr, dataLen, true);
                return S_OK;
            };
            // HRESULT Decrypt(...) — stdcall RET 16; src @ arg2, dst @ arg3 (BLOWFISH.DLL @ 0x110020cb)
            this.exports["BF_Decrypt"] = (ctx, m, args) => {
                const thisPtr = args[0];
                const dataLen = args[1] | 0;
                const srcPtr = args[2] >>> 0;
                const dstPtr = (args[3] >>> 0) || srcPtr;
                const bf = this.blowfishInstances.get(thisPtr);
                if (!bf) return 0x80004005;
                if (!srcPtr || !dstPtr) return E_POINTER;
                if (dataLen < 0) return E_INVALIDARG;
                const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
                bf.cipher.transformBuffer(v, srcPtr, dstPtr, dataLen, false);
                return S_OK;
            };

            const bfHandlers = {
                BF_QueryInterface: this.exports["BF_QueryInterface"],
                BF_AddRef: this.exports["BF_AddRef"],
                BF_Release: this.exports["BF_Release"],
                BF_Submit_Key: this.exports["BF_Submit_Key"],
                BF_Get_Max_Key_Length: this.exports["BF_Get_Max_Key_Length"],
                BF_Get_Block_Size: this.exports["BF_Get_Block_Size"],
                BF_Encrypt: this.exports["BF_Encrypt"],
                BF_Decrypt: this.exports["BF_Decrypt"],
            };

            const bfMethods: ComVtableMethod[] = [
                { name: "BF_QueryInterface", argCount: 3, stackCleanupBytes: 12 },
                { name: "BF_AddRef", argCount: 1, stackCleanupBytes: 4 },
                { name: "BF_Release", argCount: 1, stackCleanupBytes: 4 },
                { name: "BF_Submit_Key", argCount: 3, stackCleanupBytes: 12 },
                { name: "BF_Get_Max_Key_Length", argCount: 2, stackCleanupBytes: 8 },
                { name: "BF_Get_Block_Size", argCount: 2, stackCleanupBytes: 8 },
                { name: "BF_Encrypt", argCount: 4, stackCleanupBytes: 16 },
                { name: "BF_Decrypt", argCount: 4, stackCleanupBytes: 16 },
            ];

            const installed = installComVtable(process, {
                moduleName: "ole32_blowfish",
                methods: bfMethods,
                handlers: bfHandlers,
                logLabel: "Blowfish",
            });
            if (!installed) return 0;
            this.blowfishVtableAddr = installed.vtableAddr;
        }

        // Allocate COM object: [vtablePtr]
        const objAddr = allocateComObject(process.memory, mem, this.blowfishVtableAddr);

        // Create Blowfish state
        this.blowfishInstances.set(objAddr, { refCount: 1, cipher: new BlowfishCipher() });

        // Write to ppv
        if (ppv) {
            const outMem = process.getCurrentMemory();
            const outView = new DataView(outMem.buffer, outMem.byteOffset, outMem.byteLength);
            outView.setUint32(ppv, objAddr, true);
        }

        Logger.log(LogCategory.COM, `Blowfish: created object at 0x${objAddr.toString(16)}`);
        return objAddr;
    }
}

// ---- Blowfish State ----
interface BlowfishState {
    refCount: number;
    cipher: BlowfishCipher;
}

// ---- Blowfish Cipher Implementation ----
// Standard Blowfish block cipher (ECB mode, 8-byte blocks, little-endian)
class BlowfishCipher {
    private P = new Uint32Array(18);
    private S0 = new Uint32Array(256);
    private S1 = new Uint32Array(256);
    private S2 = new Uint32Array(256);
    private S3 = new Uint32Array(256);

    constructor() {
        // Initialize P and S-boxes with digits of pi
        this.P.set(BF_P_INIT);
        this.S0.set(BF_S_INIT.subarray(0, 256));
        this.S1.set(BF_S_INIT.subarray(256, 512));
        this.S2.set(BF_S_INIT.subarray(512, 768));
        this.S3.set(BF_S_INIT.subarray(768, 1024));
    }

    submitKey(key: Uint8Array): void {
        // XOR key bytes into P-array
        let j = 0;
        for (let i = 0; i < 18; i++) {
            let data = 0;
            for (let k = 0; k < 4; k++) {
                data = ((data << 8) | key[j]) >>> 0;
                j = (j + 1) % key.length;
            }
            this.P[i] = (this.P[i] ^ data) >>> 0;
        }

        // Expand key: encrypt all-zero block, feed result back into P then S
        let xl = 0, xr = 0;
        for (let i = 0; i < 18; i += 2) {
            [xl, xr] = this.encryptBlock(xl, xr);
            this.P[i] = xl;
            this.P[i + 1] = xr;
        }
        const sboxes = [this.S0, this.S1, this.S2, this.S3];
        for (const sbox of sboxes) {
            for (let i = 0; i < 256; i += 2) {
                [xl, xr] = this.encryptBlock(xl, xr);
                sbox[i] = xl;
                sbox[i + 1] = xr;
            }
        }
    }

    private f(x: number): number {
        const a = (x >>> 24) & 0xFF;
        const b = (x >>> 16) & 0xFF;
        const c = (x >>> 8) & 0xFF;
        const d = x & 0xFF;
        return (((this.S0[a] + this.S1[b]) >>> 0) ^ this.S2[c]) + this.S3[d] >>> 0;
    }

    encryptBlock(xl: number, xr: number): [number, number] {
        for (let i = 0; i < 16; i += 2) {
            xl = (xl ^ this.P[i]) >>> 0;
            xr = (xr ^ this.f(xl)) >>> 0;
            xr = (xr ^ this.P[i + 1]) >>> 0;
            xl = (xl ^ this.f(xr)) >>> 0;
        }
        xl = (xl ^ this.P[16]) >>> 0;
        xr = (xr ^ this.P[17]) >>> 0;
        return [xr, xl]; // swap
    }

    decryptBlock(xl: number, xr: number): [number, number] {
        for (let i = 16; i > 0; i -= 2) {
            xl = (xl ^ this.P[i + 1]) >>> 0;
            xr = (xr ^ this.f(xl)) >>> 0;
            xr = (xr ^ this.P[i]) >>> 0;
            xl = (xl ^ this.f(xr)) >>> 0;
        }
        xl = (xl ^ this.P[1]) >>> 0;
        xr = (xr ^ this.P[0]) >>> 0;
        return [xr, xl]; // swap
    }

    /** Westwood fish::encipher/decipher — separate src/dst; tail bytes memcpy (Ghidra @ 0x1100183c / 0x11001919).
     *  Block words are BIG-endian (standard Blowfish; the DLL byte-reorders internally, cf. XCC reorder()).
     *  Verified against TIBSUN.MIX: BE decrypts header to count=17/dataSize≈filesize, LE gives garbage. */
    transformBuffer(v: DataView, srcPtr: number, dstPtr: number, dataLen: number, encrypt: boolean): void {
        const blocks = dataLen >> 3;
        for (let b = 0; b < blocks; b++) {
            const off = b * 8;
            let xl = v.getUint32(srcPtr + off, false);
            let xr = v.getUint32(srcPtr + off + 4, false);
            [xl, xr] = encrypt ? this.encryptBlock(xl, xr) : this.decryptBlock(xl, xr);
            v.setUint32(dstPtr + off, xl, false);
            v.setUint32(dstPtr + off + 4, xr, false);
        }
        const tailOff = blocks * 8;
        const tailLen = dataLen - tailOff;
        if (tailLen > 0) {
            const tail = Mem.readBytes(srcPtr + tailOff, tailLen);
            if (tail) Mem.writeBytes(dstPtr + tailOff, tail);
        }
    }
}

// Blowfish initial P-array (digits of pi)
const BF_P_INIT = new Uint32Array([
    0x243F6A88, 0x85A308D3, 0x13198A2E, 0x03707344,
    0xA4093822, 0x299F31D0, 0x082EFA98, 0xEC4E6C89,
    0x452821E6, 0x38D01377, 0xBE5466CF, 0x34E90C6C,
    0xC0AC29B7, 0xC97C50DD, 0x3F84D5B5, 0xB5470917,
    0x9216D5D9, 0x8979FB1B,
]);

// Blowfish initial S-boxes (1024 entries = 4 * 256)
const BF_S_INIT = new Uint32Array([
    // S-box 0
    0xD1310BA6,0x98DFB5AC,0x2FFD72DB,0xD01ADFB7,0xB8E1AFED,0x6A267E96,0xBA7C9045,0xF12C7F99,
    0x24A19947,0xB3916CF7,0x0801F2E2,0x858EFC16,0x636920D8,0x71574E69,0xA458FEA3,0xF4933D7E,
    0x0D95748F,0x728EB658,0x718BCD58,0x82154AEE,0x7B54A41D,0xC25A59B5,0x9C30D539,0x2AF26013,
    0xC5D1B023,0x286085F0,0xCA417918,0xB8DB38EF,0x8E79DCB0,0x603A180E,0x6C9E0E8B,0xB01E8A3E,
    0xD71577C1,0xBD314B27,0x78AF2FDA,0x55605C60,0xE65525F3,0xAA55AB94,0x57489862,0x63E81440,
    0x55CA396A,0x2AAB10B6,0xB4CC5C34,0x1141E8CE,0xA15486AF,0x7C72E993,0xB3EE1411,0x636FBC2A,
    0x2BA9C55D,0x741831F6,0xCE5C3E16,0x9B87931E,0xAFD6BA33,0x6C24CF5C,0x7A325381,0x28958677,
    0x3B8F4898,0x6B4BB9AF,0xC4BFE81B,0x66282193,0x61D809CC,0xFB21A991,0x487CAC60,0x5DEC8032,
    0xEF845D5D,0xE98575B1,0xDC262302,0xEB651B88,0x23893E81,0xD396ACC5,0x0F6D6FF3,0x83F44239,
    0x2E0B4482,0xA4842004,0x69C8F04A,0x9E1F9B5E,0x21C66842,0xF6E96C9A,0x670C9C61,0xABD388F0,
    0x6A51A0D2,0xD8542F68,0x960FA728,0xAB5133A3,0x6EEF0B6C,0x137A3BE4,0xBA3BF050,0x7EFB2A98,
    0xA1F1651D,0x39AF0176,0x66CA593E,0x82430E88,0x8CEE8619,0x456F9FB4,0x7D84A5C3,0x3B8B5EBE,
    0xE06F75D8,0x85C12073,0x401A449F,0x56C16AA6,0x4ED3AA62,0x363F7706,0x1BFEDF72,0x429B023D,
    0x37D0D724,0xD00A1248,0xDB0FEAD3,0x49F1C09B,0x075372C9,0x80991B7B,0x25D479D8,0xF6E8DEF7,
    0xE3FE501A,0xB6794C3B,0x976CE0BD,0x04C006BA,0xC1A94FB6,0x409F60C4,0x5E5C9EC2,0x196A2463,
    0x68FB6FAF,0x3E6C53B5,0x1339B2EB,0x3B52EC6F,0x6DFC511F,0x9B30952C,0xCC814544,0xAF5EBD09,
    0xBEE3D004,0xDE334AFD,0x660F2807,0x192E4BB3,0xC0CBA857,0x45C8740F,0xD20B5F39,0xB9D3FBDB,
    0x5579C0BD,0x1A60320A,0xD6A100C6,0x402C7279,0x679F25FE,0xFB1FA3CC,0x8EA5E9F8,0xDB3222F8,
    0x3C7516DF,0xFD616B15,0x2F501EC8,0xAD0552AB,0x323DB5FA,0xFD238760,0x53317B48,0x3E00DF82,
    0x9E5C57BB,0xCA6F8CA0,0x1A87562E,0xDF1769DB,0xD542A8F6,0x287EFFC3,0xAC6732C6,0x8C4F5573,
    0x695B27B0,0xBBCA58C8,0xE1FFA35D,0xB8F011A0,0x10FA3D98,0xFD2183B8,0x4AFCB56C,0x2DD1D35B,
    0x9A53E479,0xB6F84565,0xD28E49BC,0x4BFB9790,0xE1DDF2DA,0xA4CB7E33,0x62FB1341,0xCEE4C6E8,
    0xEF20CADA,0x36774C01,0xD07E9EFE,0x2BF11FB4,0x95DBDA4D,0xAE909198,0xEAAD8E71,0x6B93D5A0,
    0xD08ED1D0,0xAFC725E0,0x8E3C5B2F,0x8E7594B7,0x8FF6E2FB,0xF2122B64,0x8888B812,0x900DF01C,
    0x4FAD5EA0,0x688FC31C,0xD1CFF191,0xB3A8C1AD,0x2F2F2218,0xBE0E1777,0xEA752DFE,0x8B021FA1,
    0xE5A0CC0F,0xB56F74E8,0x18ACF3D6,0xCE89E299,0xB4A84FE0,0xFD13E0B7,0x7CC43B81,0xD2ADA8D9,
    0x165FA266,0x80957705,0x93CC7314,0x211A1477,0xE6AD2065,0x77B5FA86,0xC75442F5,0xFB9D35CF,
    0xEBCDAF0C,0x7B3E89A0,0xD6411BD3,0xAE1E7E49,0x00250E2D,0x2071B35E,0x226800BB,0x57B8E0AF,
    0x2464369B,0xF009B91E,0x5563911D,0x59DFA6AA,0x78C14389,0xD95A537F,0x207D5BA2,0x02E5B9C5,
    0x83260376,0x6295CFA9,0x11C81968,0x4E734A41,0xB3472DCA,0x7B14A94A,0x1B510052,0x9A532915,
    0xD60F573F,0xBC9BC6E4,0x2B60A476,0x81E67400,0x08BA6FB5,0x571BE91F,0xF296EC6B,0x2A0DD915,
    0xB6636521,0xE7B9F9B6,0xFF34052E,0xC5855664,0x53B02D5D,0xA99F8FA1,0x08BA4799,0x6E85076A,
    // S-box 1
    0x4B7A70E9,0xB5B32944,0xDB75092E,0xC4192623,0xAD6EA6B0,0x49A7DF7D,0x9CEE60B8,0x8FEDB266,
    0xECAA8C71,0x699A17FF,0x5664526C,0xC2B19EE1,0x193602A5,0x75094C29,0xA0591340,0xE4183A3E,
    0x3F54989A,0x5B429D65,0x6B8FE4D6,0x99F73FD6,0xA1D29C07,0xEFE830F5,0x4D2D38E6,0xF0255DC1,
    0x4CDD2086,0x8470EB26,0x6382E9C6,0x021ECC5E,0x09686B3F,0x3EBAEFC9,0x3C971814,0x6B6A70A1,
    0x687F3584,0x52A0E286,0xB79C5305,0xAA500737,0x3E07841C,0x7FDEAE5C,0x8E7D44EC,0x5716F2B8,
    0xB03ADA37,0xF0500C0D,0xF01C1F04,0x0200B3FF,0xAE0CF51A,0x3CB574B2,0x25837A58,0xDC0921BD,
    0xD19113F9,0x7CA92FF6,0x94324773,0x22F54701,0x3AE5E581,0x37C2DADC,0xC8B57634,0x9AF3DDA7,
    0xA9446146,0x0FD0030E,0xECC8C73E,0xA4751E41,0xE238CD99,0x3BEA0E2F,0x3280BBA1,0x183EB331,
    0x4E548B38,0x4F6DB908,0x6F420D03,0xF60A04BF,0x2CB81290,0x24977C79,0x5679B072,0xBCAF89AF,
    0xDE9A771F,0xD9930810,0xB38BAE12,0xDCCF3F2E,0x5512721F,0x2E6B7124,0x501ADDE6,0x9F84CD87,
    0x7A584718,0x7408DA17,0xBC9F9ABC,0xE94B7D8C,0xEC7AEC3A,0xDB851DFA,0x63094366,0xC464C3D2,
    0xEF1C1847,0x3215D908,0xDD433B37,0x24C2BA16,0x12A14D43,0x2A65C451,0x50940002,0x133AE4DD,
    0x71DFF89E,0x10314E55,0x81AC77D6,0x5F11199B,0x043556F1,0xD7A3C76B,0x3C11183B,0x5924A509,
    0xF28FE6ED,0x97F1FBFA,0x9EBABF2C,0x1E153C6E,0x86E34570,0xEAE96FB1,0x860E5E0A,0x5A3E2AB3,
    0x771FE71C,0x4E3D06FA,0x2965DCB9,0x99E71D0F,0x803E89D6,0x5266C825,0x2E4CC978,0x9C10B36A,
    0xC6150EBA,0x94E2EA78,0xA5FC3C53,0x1E0A2DF4,0xF2F74EA7,0x361D2B3D,0x1939260F,0x19C27960,
    0x5223A708,0xF71312B6,0xEBADFE6E,0xEAC31F66,0xE3BC4595,0xA67BC883,0xB17F37D1,0x018CFF28,
    0xC332DDEF,0xBE6C5AA5,0x65582185,0x68AB9802,0xEECEA50F,0xDB2F953B,0x2AEF7DAD,0x5B6E2F84,
    0x1521B628,0x29076170,0xECDD4775,0x619F1510,0x13CCA830,0xEB61BD96,0x0334FE1E,0xAA0363CF,
    0xB5735C90,0x4C70A239,0xD59E9E0B,0xCBAADE14,0xEECC86BC,0x60622CA7,0x9CAB5CAB,0xB2F3846E,
    0x648B1EAF,0x19BDF0CA,0xA02369B9,0x655ABB50,0x40685A32,0x3C2AB4B3,0x319EE9D5,0xC021B8F7,
    0x9B540B19,0x875FA099,0x95F7997E,0x623D7DA8,0xF837889A,0x97E32D77,0x11ED935F,0x16681281,
    0x0E358829,0xC7E61FD6,0x96DEDFA1,0x7858BA99,0x57F584A5,0x1B227263,0x9B83C3FF,0x1AC24696,
    0xCDB30AEB,0x532E3054,0x8FD948E4,0x6DBC3128,0x58EBF2EF,0x34C6FFEA,0xFE28ED61,0xEE7C3C73,
    0x5D4A14D9,0xE864B7E3,0x42105D14,0x203E13E0,0x45EEE2B6,0xA3AAABEA,0xDB6C4F15,0xFACB4FD0,
    0xC742F442,0xEF6ABBB5,0x654F3B1D,0x41CD2105,0xD81E799E,0x86854DC7,0xE44B476A,0x3D816250,
    0xCF62A1F2,0x5B8D2646,0xFC8883A0,0xC1C7B6A3,0x7F1524C3,0x69CB7492,0x47848A0B,0x5692B285,
    0x095BBF00,0xAD19489D,0x1462B174,0x23820E00,0x58428D2A,0x0C55F5EA,0x1DADF43E,0x233F7061,
    0x3372F092,0x8D937E41,0xD65FECF1,0x6C223BDB,0x7CDE3759,0xCBEE7460,0x4085F2A7,0xCE77326E,
    0xA6078084,0x19F8509E,0xE8EFD855,0x61D99735,0xA969A7AA,0xC50C06C2,0x5A04ABFC,0x800BCADC,
    0x9E447A2E,0xC3453484,0xFDD56705,0x0E1E9EC9,0xDB73DBD3,0x105588CD,0x675FDA79,0xE3674340,
    0xC5C43465,0x713E38D8,0x3D28F89E,0xF16DFF20,0x153E21E7,0x8FB03D4A,0xE6E39F2B,0xDB83ADF7,
    // S-box 2
    0xE93D5A68,0x948140F7,0xF64C261C,0x94692934,0x411520F7,0x7602D4F7,0xBCF46B2E,0xD4A20068,
    0xD4082471,0x3320F46A,0x43B7D4B7,0x500061AF,0x1E39F62E,0x97244546,0x14214F74,0xBF8B8840,
    0x4D95FC1D,0x96B591AF,0x70F4DDD3,0x66A02F45,0xBFBC09EC,0x03BD9785,0x7FAC6DD0,0x31CB8504,
    0x96EB27B3,0x55FD3941,0xDA2547E6,0xABCA0A9A,0x28507825,0x530429F4,0x0A2C86DA,0xE9B66DFB,
    0x68DC1462,0xD7486900,0x680EC0A4,0x27A18DEE,0x4F3FFEA2,0xE887AD8C,0xB58CE006,0x7AF4D6B6,
    0xAACE1E7C,0xD3375FEC,0xCE78A399,0x406B2A42,0x20FE9E35,0xD9F385B9,0xEE39D7AB,0x3B124E8B,
    0x1DC9FAF7,0x4B6D1856,0x26A36631,0xEAE397B2,0x3A6EFA74,0xDD5B4332,0x6841E7F7,0xCA7820FB,
    0xFB0AF54E,0xD8FEB397,0x454056AC,0xBA489527,0x55533A3A,0x20838D87,0xFE6BA9B7,0xD096954B,
    0x55A867BC,0xA1159A58,0xCCA92963,0x99E1DB33,0xA62A4A56,0x3F3125F9,0x5EF47E1C,0x9029317C,
    0xFDF8E802,0x04272F70,0x80BB155C,0x05282CE3,0x95C11548,0xE4C66D22,0x48C1133F,0xC70F86DC,
    0x07F9C9EE,0x41041F0F,0x404779A4,0x5D886E17,0x325F51EB,0xD59BC0D1,0xF2BCC18F,0x41113564,
    0x257B7834,0x602A9C60,0xDFF8E8A3,0x1F636C1B,0x0E12B4C2,0x02E1329E,0xAF664FD1,0xCAD18115,
    0x6B2395E0,0x333E92E1,0x3B240B62,0xEEBEB922,0x85B2A20E,0xE6BA0D99,0xDE720C8C,0x2DA2F728,
    0xD0127845,0x95B794FD,0x647D0862,0xE7CCF5F0,0x5449A36F,0x877D48FA,0xC39DFD27,0xF33E8D1E,
    0x0A476341,0x992EFF74,0x3A6F6EAB,0xF4F8FD37,0xA812DC60,0xA1EBDDF8,0x991BE14C,0xDB6E6B0D,
    0xC67B5510,0x6D672C37,0x2765D43B,0xDCD0E804,0xF1290DC7,0xCC00FFA3,0xB5390F92,0x690FED0B,
    0x667B9FFB,0xCEDB7D9C,0xA091CF0B,0xD9155EA3,0xBB132F88,0x515BAD24,0x7B9479BF,0x763BD6EB,
    0x37392EB3,0xCC115979,0x8026E297,0xF42E312D,0x6842ADA7,0xC66A2B3B,0x12754CCC,0x782EF11C,
    0x6A124237,0xB79251E7,0x06A1BBE6,0x4BFB6350,0x1A6B1018,0x11CAEDFA,0x3D25BDD8,0xE2E1C3C9,
    0x44421659,0x0A121386,0xD90CEC6E,0xD5ABEA2A,0x64AF674E,0xDA86A85F,0xBEBFE988,0x64E4C3FE,
    0x9DBC8057,0xF0F7C086,0x60787BF8,0x6003604D,0xD1FD8346,0xF6381FB0,0x7745AE04,0xD736FCCC,
    0x83426B33,0xF01EAB71,0xB0804187,0x3C005E5F,0x77A057BE,0xBDE8AE24,0x55464299,0xBF582E61,
    0x4E58F48F,0xF2DDFDA2,0xF474EF38,0x8789BDC2,0x5366F9C3,0xC8B38E74,0xB475F255,0x46FCD9B9,
    0x7AEB2661,0x8B1DDF84,0x846A0E79,0x915F95E2,0x466E598E,0x20B45770,0x8CD55591,0xC902DE4C,
    0xB90BACE1,0xBB8205D0,0x11A86248,0x7574A99E,0xB77F19B6,0xE0A9DC09,0x662D09A1,0xC4324633,
    0xE85A1F02,0x09F0BE8C,0x4A99A025,0x1D6EFE10,0x1AB93D1D,0x0BA5A4DF,0xA186F20F,0x2868F169,
    0xDCB7DA83,0x573906FE,0xA1E2CE9B,0x4FCD7F52,0x50115E01,0xA70683FA,0xA002B5C4,0x0DE6D027,
    0x9AF88C27,0x773F8641,0xC3604C06,0x61A806B5,0xF0177A28,0xC0F586E0,0x006058AA,0x30DC7D62,
    0x11E69ED7,0x2338EA63,0x53C2DD94,0xC2C21634,0xBBCBEE56,0x90BCB6DE,0xEBFC7DA1,0xCE591D76,
    0x6F05E409,0x4B7C0188,0x39720A3D,0x7C927C24,0x86E3725F,0x724D9DB9,0x1AC15BB4,0xD39EB8FC,
    0xED545578,0x08FCA5B5,0xD83D7CD3,0x4DAD0FC4,0x1E50EF5E,0xB161E6F8,0xA28514D9,0x6C51133C,
    0x6FD5C7E7,0x56E14EC4,0x362ABFCE,0xDDC6C837,0xD79A3234,0x92638212,0x670EFA8E,0x406000E0,
    // S-box 3
    0x3A39CE37,0xD3FAF5CF,0xABC27737,0x5AC52D1B,0x5CB0679E,0x4FA33742,0xD3822740,0x99BC9BBE,
    0xD5118E9D,0xBF0F7315,0xD62D1C7E,0xC700C47B,0xB78C1B6B,0x21A19045,0xB26EB1BE,0x6A366EB4,
    0x5748AB2F,0xBC946E79,0xC6A376D2,0x6549C2C8,0x530FF8EE,0x468DDE7D,0xD5730A1D,0x4CD04DC6,
    0x2939BBDB,0xA9BA4650,0xAC9526E8,0xBE5EE304,0xA1FAD5F0,0x6A2D519A,0x63EF8CE2,0x9A86EE22,
    0xC089C2B8,0x43242EF6,0xA51E03AA,0x9CF2D0A4,0x83C061BA,0x9BE96A4D,0x8FE51550,0xBA645BD6,
    0x2826A2F9,0xA73A3AE1,0x4BA99586,0xEF5562E9,0xC72FEFD3,0xF752F7DA,0x3F046F69,0x77FA0A59,
    0x80E4A915,0x87B08601,0x9B09E6AD,0x3B3EE593,0xE990FD5A,0x9E34D797,0x2CF0B7D9,0x022B8B51,
    0x96D5AC3A,0x017DA67D,0xD1CF3ED6,0x7C7D2D28,0x1F9F25CF,0xADF2B89B,0x5AD6B472,0x5A88F54C,
    0xE029AC71,0xE019A5E6,0x47B0ACFD,0xED93FA9B,0xE8D3C48D,0x283B57CC,0xF8D56629,0x79132E28,
    0x785F0191,0xED756055,0xF7960E44,0xE3D35E8C,0x15056DD4,0x88F46DBA,0x03A16125,0x0564F0BD,
    0xC3EB9E15,0x3C9057A2,0x97271AEC,0xA93A072A,0x1B3F6D9B,0x1E6321F5,0xF59C66FB,0x26DCF319,
    0x7533D928,0xB155FDF5,0x03563482,0x8ABA3CBB,0x28517711,0xC20AD9F8,0xABCC5167,0xCCAD925F,
    0x4DE81751,0x3830DC8E,0x379D5862,0x9320F991,0xEA7A90C2,0xFB3E7BCE,0x5121CE64,0x774FBE32,
    0xA8B6E37E,0xC3293D46,0x48DE5369,0x6413E680,0xA2AE0810,0xDD6DB224,0x69852DFD,0x09072166,
    0xB39A460A,0x6445C0DD,0x586CDECF,0x1C20C8AE,0x5BBEF7DD,0x1B588D40,0xCCD2017F,0x6BB4E3BB,
    0xDDA26A7E,0x3A59FF45,0x3E350A44,0xBCB4CDD5,0x72EACEA8,0xFA6484BB,0x8D6612AE,0xBF3C6F47,
    0xD29BE463,0x542F5D9E,0xAEC2771B,0xF64E6370,0x740E0D8D,0xE75B1357,0xF8721671,0xAF537D5D,
    0x4040CB08,0x4EB4E2CC,0x34D2466A,0x0115AF84,0xE1B00428,0x95983A1D,0x06B89FB4,0xCE6EA048,
    0x6F3F3B82,0x3520AB82,0x011A1D4B,0x277227F8,0x611560B1,0xE7933FDC,0xBB3A792B,0x344525BD,
    0xA08839E1,0x51CE794B,0x2F32C9B7,0xA01FBAC9,0xE01CC87E,0xBCC7D1F6,0xCF0111C3,0xA1E8AAC7,
    0x1A908749,0xD44FBD9A,0xD0DADECB,0xD50ADA38,0x0339C32A,0xC6913667,0x8DF9317C,0xE0B12B4F,
    0xF79E59B7,0x43F5BB3A,0xF2D519FF,0x27D9459C,0xBF97222C,0x15E6FC2A,0x0F91FC71,0x9B941525,
    0xFAE59361,0xCEB69CEB,0xC2A86459,0x12BAA8D1,0xB6C1075E,0xE3056A0C,0x10D25065,0xCB03A442,
    0xE0EC6E0E,0x1698DB3B,0x4C98A0BE,0x3278E964,0x9F1F9532,0xE0D392DF,0xD3A0342B,0x8971F21E,
    0x1B0A7441,0x4BA3348C,0xC5BE7120,0xC37632D8,0xDF359F8D,0x9B992F2E,0xE60B6F47,0x0FE3F11D,
    0xE54CDA54,0x1EDAD891,0xCE6279CF,0xCD3E7E6F,0x1618B166,0xFD2C1D05,0x848FD2C5,0xF6FB2299,
    0xF523F357,0xA6327623,0x93A83531,0x56CCCD02,0xACF08162,0x5A75EBB5,0x6E163697,0x88D273CC,
    0xDE966292,0x81B949D0,0x4C50901B,0x71C65614,0xE6C6C7BD,0x327A140A,0x45E1D006,0xC3F27B9A,
    0xC9AA53FD,0x62A80F00,0xBB25BFE2,0x35BDD2F6,0x71126905,0xB2040222,0xB6CBCF7C,0xCD769C2B,
    0x53113EC0,0x1640E3D3,0x38ABBD60,0x2547ADF0,0xBA38209C,0xF746CE76,0x77AFA1C5,0x20756060,
    0x85CBFE4E,0x8AE88DD8,0x7AAAF9B0,0x4CF9AA7E,0x1948C25C,0x02FB8A8C,0x01C36AE4,0xD6EBE1F9,
    0x90D4F869,0xA65CDEA0,0x3F09252D,0xC208E69F,0xB74E6132,0xCE77E25B,0x578FDFE3,0x3AC372E6,
]);
