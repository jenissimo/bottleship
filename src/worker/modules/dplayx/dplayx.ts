import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { createVTablesFromDescriptor, VTableInfo } from "../../api/adapters/module-adapter";
import { dplayxModule } from "../../api/dplayx.api";
import { InterfaceRegistry } from "../../core/com/interface-registry";
import { BaseComObject, ComObjectFactory } from "../../core/com/base-com-object";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { allocateComObject } from "../../core/com/com-memory";
import { readString } from "../../api/codegen";
import { System } from "../../core/system";

// COM error codes
const DP_OK = 0x00000000;
const E_NOINTERFACE = 0x80004002;
const E_NOTIMPL = 0x80004001;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const DPERR_BUFFERTOOSMALL = 0x8877001e;
const DPERR_NOTLOBBIED = 0x88770023;
const DPERR_NOMESSAGES = 0x887700BE;
const DPERR_INVALIDOBJECT = 0x88770082;
const DPERR_UNINITIALIZED = 0x88770140;
const E_FAIL = 0x80004005;

// DirectPlay constants
const DPID_ALLPLAYERS = 0;
const DPRECEIVE_ALL = 0x00000001;
const DPRECEIVE_TOPLAYER = 0x00000002;
const DPRECEIVE_FROMPLAYER = 0x00000004;
const DPRECEIVE_PEEK = 0x00000008;

interface DPlayMessage {
    idFrom: number;
    idTo: number;
    data: Uint8Array;
}
const IID_DPLAY_LOBBY3A = "2db72491-652c-11d1-a7a8-0000f803abfc";
const IID_DPLAY_LOBBY_COMPAT = "5959df62-2911-11d1-b049-0020af30269a";
const IID_DPLAY4A = "0ab1c531-4745-11d1-a7a1-0000f803abfc";
const IID_DPLAY_LOBBY = "af465c71-9588-11cf-a020-00aa006157ac";
// ANSI variant of IDirectPlayLobby — same vtable shape, so one object serves both.
const IID_DPLAY_LOBBY_ANSI = "26c66a70-b367-11cf-a024-00aa006157ac";
const IID_DPLAY = "5454e9a0-db65-11ce-921c-00aa006c4972";
const IID_DPLAY8_LOBBY_CLIENT = "819074a2-016c-11d3-ae14-006097b01411";

const GUID_SIZE = 16;
const DPAID_SERVICE_PROVIDER_GUID = new Uint8Array([
    0xc0, 0x16, 0xd9, 0x07, 0xaf, 0xe0, 0xcf, 0x11, 0x9c, 0x4e, 0x00, 0xa0, 0xc9, 0x05, 0x42, 0x5e
]);
// {1318F560-912C-11d0-9DAA-00A0C90A43CB}
const DPAID_TOTAL_SIZE = new Uint8Array([
    0x60, 0xf5, 0x18, 0x13, 0x2c, 0x91, 0xd0, 0x11, 0x9d, 0xaa, 0x00, 0xa0, 0xc9, 0x0a, 0x43, 0xcb
]);
const DPCOMPOUNDADDRESSELEMENT_SIZE = 24; // GUID(16) + DWORD(4) + LPVOID(4)
const DPADDRESS_HEADER_SIZE = 20; // GUID(16) + DWORD(4)

/**
 * DirectPlay COM object implementation (minimal stub).
 */
class DirectPlayObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_DPLAY4A, vtableAddress); // IDirectPlay4A IID
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectPlayObject destroyed");
    }
}

class DirectPlayObjectV1 extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_DPLAY, vtableAddress);
    }
    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectPlayObjectV1 destroyed");
    }
}

/**
 * DirectPlay Lobby COM object implementation (minimal stub).
 */
class DirectPlayLobbyObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_DPLAY_LOBBY3A, vtableAddress); // IDirectPlayLobby3A IID
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectPlayLobbyObject destroyed");
    }
}

class DirectPlayLobbyObjectV1 extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_DPLAY_LOBBY, vtableAddress);
    }
    protected queryAdditionalInterfaces(riid: string): string | null {
        return riid === IID_DPLAY_LOBBY_ANSI ? riid : null;
    }
    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectPlayLobbyObjectV1 destroyed");
    }
}

/**
 * Legacy DirectPlay Lobby COM object used by IFC20.
 */
class DirectPlayLobbyCompatObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_DPLAY_LOBBY_COMPAT, vtableAddress); // Legacy lobby IID
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectPlayLobbyCompatObject destroyed");
    }
}

/**
 * DirectPlay 8 Lobby COM object.
 */
class DirectPlay8LobbyObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_DPLAY8_LOBBY_CLIENT, vtableAddress);
    }
    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectPlay8LobbyObject destroyed");
    }
}

export class DPlayX implements IModule {
    name = "dplayx";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private memory!: Uint8Array;
    private vtables: Record<string, VTableInfo> = {};
    private messageQueue: DPlayMessage[] = [];
    private localPlayerId: number = 0;
    private nextGroupId: number = 0x10001;
    private sessionOpen: boolean = false;
    private directPlayV1Initialized: boolean = false;
    private directPlayV1Open: boolean = false;

    private validateRange(address: number, size: number, perms: "r" | "rw" | "rx"): boolean {
        if (!Number.isFinite(address) || !Number.isFinite(size)) return false;
        if (address <= 0 || size < 0) return false;
        if (address < 0x1000) return false;
        if (address + size < address) return false; // overflow
        const mem = this.getMemory();
        if (address + size > mem.length) return false;

        const space = this.process?.addressSpace;
        if (!space) return true;
        return space.validateRange(address, size, perms);
    }

    private readGuidBytes(mem: Uint8Array, ptr: number): Uint8Array | null {
        if (!this.validateRange(ptr, GUID_SIZE, "r")) return null;
        return mem.slice(ptr, ptr + GUID_SIZE);
    }

    initialize(process: Process): void {
        this.process = process;
        this.memory = this.getMemory();

        const interfaceRegistry = InterfaceRegistry.getInstance();
        interfaceRegistry.registerFromModuleDescriptor(dplayxModule);
        // IID_DPLAY8_LOBBY_CLIENT is already registered via registerFromModuleDescriptor above

        this.vtables = createVTablesFromDescriptor(this.process, dplayxModule);

        for (const [name, info] of Object.entries(this.vtables)) {
            Logger.verbose(LogCategory.SYSTEM, `DirectPlay: Created vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
        }

        ComObjectFactory.register(IID_DPLAY_LOBBY3A, DirectPlayLobbyObject);
        ComObjectFactory.register(IID_DPLAY_LOBBY_COMPAT, DirectPlayLobbyCompatObject);
        ComObjectFactory.register(IID_DPLAY4A, DirectPlayObject);
        ComObjectFactory.register(IID_DPLAY_LOBBY, DirectPlayLobbyObjectV1);
        ComObjectFactory.register(IID_DPLAY, DirectPlayObjectV1);
        ComObjectFactory.register(IID_DPLAY8_LOBBY_CLIENT, DirectPlay8LobbyObject);

        this.registerIUnknown();
        this.registerMethodStubs();
        this.registerDirectExports();
    }

    private registerIUnknown(): void {
        const resourceProvider = SystemResourceProvider.getInstance();
        const dplayIUnknownPrefixes = [
            "IDirectPlayLobby3A",
            "IDirectPlayLobbyCompatA",
            "IDirectPlay4A",
            "IDirectPlayLobby",
            "IDirectPlay",
            "IDirectPlay8LobbyClient",
        ];

        for (const ifacePrefix of dplayIUnknownPrefixes) {
            this.exports[`${ifacePrefix}_QueryInterface`] = (ctx, mem, args) => {
                const thisPtr = args[0];
                const riidPtr = args[1];
                const ppvObject = args[2];

                const obj = resourceProvider.getComObjectByAddress(thisPtr);
                if (!obj) {
                    if (ppvObject) {
                        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                        view.setUint32(ppvObject, 0, true);
                    }
                    return E_NOINTERFACE;
                }

                const iidBytes = new Uint8Array(16);
                for (let i = 0; i < 16; i++) {
                    iidBytes[i] = mem[riidPtr + i];
                }
                const iidStr = this.bytesToGuid(iidBytes);
                return obj.queryInterface(iidStr, ppvObject, mem);
            };

            this.exports[`${ifacePrefix}_AddRef`] = (ctx, mem, args) => {
                const obj = resourceProvider.getComObjectByAddress(args[0]);
                return obj ? obj.addRef() : 0;
            };

            this.exports[`${ifacePrefix}_Release`] = (ctx, mem, args) => {
                const obj = resourceProvider.getComObjectByAddress(args[0]);
                return obj ? obj.release() : 0;
            };
        }
    }

    private registerMethodStubs(): void {
        const resourceProvider = SystemResourceProvider.getInstance();
        const validateDirectPlayV1Object = (thisPtr: number): number =>
            resourceProvider.getComObjectByAddress(thisPtr >>> 0) ? DP_OK : DPERR_INVALIDOBJECT;
        const requireDirectPlayV1Ready = (thisPtr: number): number => {
            const valid = validateDirectPlayV1Object(thisPtr);
            if (valid !== DP_OK) return valid;
            return (this.directPlayV1Initialized && this.directPlayV1Open) ? DP_OK : DPERR_UNINITIALIZED;
        };

        // ThunkDispatcher passes a reusable fixed-size args buffer.
        // Do not branch on args.length; use per-interface signatures instead.
        const enumLocalApplicationsImpl = (isLegacyCompatCall: boolean): ThunkImplementation => (ctx, mem, args) => {
            const thisPtr = args[0];
            const lpEnumLocalAppCallback = args[1];
            const lpContext = args[2];
            const dwFlags = isLegacyCompatCall ? 0 : (args[3] ?? 0);
            const stackCleanup = isLegacyCompatCall ? 12 : 16;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const retAddr = view.getUint32(ctx.esp, true);
            Logger.log(
                LogCategory.SYSTEM,
                `${isLegacyCompatCall ? "IDirectPlayLobbyCompatA" : "IDirectPlayLobby3A"}_EnumLocalApplications called: this=0x${thisPtr.toString(16)}, cb=0x${lpEnumLocalAppCallback.toString(16)}, ctx=0x${lpContext.toString(16)}, flags=0x${dwFlags.toString(16)}, ret=0x${retAddr.toString(16)}`
            );

            // Legacy IFC20 path uses a different callback prototype and does not need
            // callback re-entry for startup probing.
            if (isLegacyCompatCall) {
                return DP_OK;
            }

            if (!lpEnumLocalAppCallback) {
                Logger.warn(LogCategory.SYSTEM, "IDirectPlayLobby3A_EnumLocalApplications: NULL callback");
                return DP_OK;
            }

            const callbackManager = this.process.dispatcher.callbackManager;
            if (!callbackManager) {
                Logger.warn(LogCategory.SYSTEM, "IDirectPlayLobby3A_EnumLocalApplications: CallbackManager not available");
                return DP_OK;
            }

            // Callback must point to executable guest code.
            // Reject PE-header pointers (MZ) even if mapped.
            const callbackLooksLikePeHeader =
                this.validateRange(lpEnumLocalAppCallback, 2, "r") &&
                mem[lpEnumLocalAppCallback] === 0x4d &&
                mem[lpEnumLocalAppCallback + 1] === 0x5a;
            if (!this.validateRange(lpEnumLocalAppCallback, 1, "rx") || callbackLooksLikePeHeader) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `IDirectPlayLobby3A_EnumLocalApplications: skipping invalid callback pointer 0x${lpEnumLocalAppCallback.toString(16)}`
                );
                return DP_OK;
            }

            // DPLAPPINFOA: dwSize(4), dwFlags(4), guidApplication(16), lpszAppNameA(4)
            const DPLAPPINFOA_SIZE = 28;
            const appInfoAddr = this.process.memory.alloc(DPLAPPINFOA_SIZE);
            const appName = "BottleShip";
            const appNameBytes = new TextEncoder().encode(`${appName}\0`);
            const appNameAddr = this.process.memory.alloc(appNameBytes.length);

            for (let i = 0; i < appNameBytes.length; i++) {
                mem[appNameAddr + i] = appNameBytes[i];
            }

            // Zero full structure first.
            for (let i = 0; i < DPLAPPINFOA_SIZE; i++) {
                mem[appInfoAddr + i] = 0;
            }

            view.setUint32(appInfoAddr, DPLAPPINFOA_SIZE, true); // dwSize
            view.setUint32(appInfoAddr + 4, 0, true); // dwFlags
            view.setUint32(appInfoAddr + 24, appNameAddr, true); // lpszAppNameA

            callbackManager.saveSuspendedThunkContext(ctx, stackCleanup);

            let callbackId = 0;
            try {
                const invoked = callbackManager.invokeCallback(
                    lpEnumLocalAppCallback,
                    [appInfoAddr, lpContext, dwFlags],
                    0,
                    () => {
                        this.process.memory.free(appInfoAddr);
                        this.process.memory.free(appNameAddr);
                        return DP_OK;
                    }
                );
                callbackId = invoked.callbackId;
            } catch (e) {
                this.process.memory.free(appInfoAddr);
                this.process.memory.free(appNameAddr);
                Logger.warn(
                    LogCategory.SYSTEM,
                    `IDirectPlayLobby3A_EnumLocalApplications: callback invoke failed, returning DP_OK (${String(e)})`
                );
                return DP_OK;
            }

            return {
                value: 0,
                suspendedForCallback: true,
                callbackId,
                stackCleanup,
            };
        };
        this.exports["IDirectPlayLobby3A_EnumLocalApplications"] = enumLocalApplicationsImpl(false);
        this.exports["IDirectPlayLobbyCompatA_EnumLocalApplications"] = enumLocalApplicationsImpl(true);

        const createAddressLobby3Impl: ThunkImplementation = (ctx, mem, args) => {

            // CreateAddress builds a 2-element compound address:
            //   1) DPAID_ServiceProvider -> GUID service provider
            //   2) guidDataType          -> caller-provided data blob
            const thisPtr = args[0];
            const lpGuidSP = args[1];
            const lpGuidDataType = args[2];
            const lpData = args[3];
            const dwDataSize = args[4] >>> 0;
            const lpAddress = args[5];
            const lpdwAddressSize = args[6];

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const retAddr = view.getUint32(ctx.esp, true);
            const guidSpBytes = this.readGuidBytes(mem, lpGuidSP);
            const guidDataTypeBytes = this.readGuidBytes(mem, lpGuidDataType);
            Logger.log(
                LogCategory.SYSTEM,
                `IDirectPlayLobby3A_CreateAddress called: this=0x${thisPtr.toString(16)}, spGuid=0x${lpGuidSP.toString(16)}${guidSpBytes ? `(${this.bytesToGuid(guidSpBytes)})` : ""}, dataGuid=0x${lpGuidDataType.toString(16)}${guidDataTypeBytes ? `(${this.bytesToGuid(guidDataTypeBytes)})` : ""}, data=0x${lpData.toString(16)}, dataSize=${dwDataSize}, out=0x${lpAddress.toString(16)}, outSize=0x${lpdwAddressSize.toString(16)}, ret=0x${retAddr.toString(16)}`
            );

            if (!guidSpBytes || !guidDataTypeBytes) {
                Logger.warn(LogCategory.SYSTEM, "IDirectPlayLobby3A_CreateAddress: invalid GUID pointer(s)");
                return E_INVALIDARG;
            }

            if (dwDataSize > 0 && !this.validateRange(lpData, dwDataSize, "r")) {
                Logger.warn(LogCategory.SYSTEM, "IDirectPlayLobby3A_CreateAddress: invalid data pointer/size");
                return E_INVALIDARG;
            }

            if (!this.validateRange(lpdwAddressSize, 4, "rw")) {
                return E_POINTER;
            }

            const requestedSize = view.getUint32(lpdwAddressSize, true);
            const spElementSize = GUID_SIZE + 4 + GUID_SIZE;
            const dataElementSize = GUID_SIZE + 4 + dwDataSize;
            const requiredSize = spElementSize + dataElementSize;

            // Always report required size to caller.
            view.setUint32(lpdwAddressSize, requiredSize, true);

            if (!lpAddress || requestedSize < requiredSize) {
                return DPERR_BUFFERTOOSMALL;
            }

            if (!this.validateRange(lpAddress, requiredSize, "rw")) {
                return E_POINTER;
            }

            let out = lpAddress;

            // Element 1: DPAID_ServiceProvider -> GUID service provider value.
            mem.set(DPAID_SERVICE_PROVIDER_GUID, out);
            out += GUID_SIZE;
            view.setUint32(out, GUID_SIZE, true);
            out += 4;
            mem.set(guidSpBytes, out);
            out += GUID_SIZE;

            // Element 2: caller-guided data element.
            mem.set(guidDataTypeBytes, out);
            out += GUID_SIZE;
            view.setUint32(out, dwDataSize, true);
            out += 4;
            if (dwDataSize > 0) {
                mem.set(mem.subarray(lpData, lpData + dwDataSize), out);
            }

            return DP_OK;
        };
        const createAddressCompatImpl: ThunkImplementation = (ctx, mem, args) => {
            const thisPtr = args[0];
            const arg1 = args[1];
            const arg2 = args[2];
            const arg3 = args[3];
            const arg4 = args[4];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const retAddr = view.getUint32(ctx.esp, true);
            Logger.log(
                LogCategory.SYSTEM,
                `IDirectPlayLobbyCompatA_CreateAddress called: this=0x${thisPtr.toString(16)}, arg1=0x${arg1.toString(16)}, arg2=0x${arg2.toString(16)}, arg3=0x${arg3.toString(16)}, arg4=0x${arg4.toString(16)}, ret=0x${retAddr.toString(16)}`
            );
            return DP_OK;
        };
        this.exports["IDirectPlayLobby3A_CreateAddress"] = createAddressLobby3Impl;
        this.exports["IDirectPlayLobbyCompatA_CreateAddress"] = createAddressCompatImpl;

        // CreateCompoundAddress: packs N caller-provided address elements into a flat
        // DPADDRESS buffer with a leading TotalSize chunk.  Two-call pattern: first call
        // with lpAddress=0 returns required size, second call fills the buffer.
        const createCompoundAddressImpl: ThunkImplementation = (ctx, mem, args) => {
            const thisPtr = args[0];
            const lpElements = args[1] >>> 0;
            const dwElementCount = args[2] >>> 0;
            const lpAddress = args[3] >>> 0;
            const lpdwAddressSize = args[4] >>> 0;

            Logger.log(LogCategory.SYSTEM,
                `CreateCompoundAddress called: this=0x${thisPtr.toString(16)}, lpElements=0x${lpElements.toString(16)}, count=${dwElementCount}, lpAddress=0x${lpAddress.toString(16)}, lpdwAddressSize=0x${lpdwAddressSize.toString(16)}`);

            if (!lpdwAddressSize || !this.validateRange(lpdwAddressSize, 4, "rw")) {
                return E_POINTER;
            }
            if (dwElementCount === 0) {
                return E_INVALIDARG;
            }

            const elemArraySize = dwElementCount * DPCOMPOUNDADDRESSELEMENT_SIZE;
            if (!this.validateRange(lpElements, elemArraySize, "r")) {
                return E_INVALIDARG;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Calculate total required size:
            // TotalSize chunk (DPADDRESS_HEADER_SIZE + 4) + each element (DPADDRESS_HEADER_SIZE + dwDataSize)
            let totalDataSize = 0;
            for (let i = 0; i < dwElementCount; i++) {
                const elemOff = lpElements + i * DPCOMPOUNDADDRESSELEMENT_SIZE;
                const dataSize = view.getUint32(elemOff + 16, true); // dwDataSize at offset 0x10
                totalDataSize += dataSize;
            }
            const totalSizeChunkSize = DPADDRESS_HEADER_SIZE + 4; // header + DWORD value
            const requiredSize = totalSizeChunkSize + dwElementCount * DPADDRESS_HEADER_SIZE + totalDataSize;

            if (lpAddress === 0) {
                // Size query: write required size and return BUFFERTOOSMALL
                view.setUint32(lpdwAddressSize, requiredSize, true);
                Logger.log(LogCategory.SYSTEM, `CreateCompoundAddress: size query → ${requiredSize} bytes`);
                return DPERR_BUFFERTOOSMALL;
            }

            // Read caller's buffer capacity before overwriting with required size
            const capacity = view.getUint32(lpdwAddressSize, true);
            view.setUint32(lpdwAddressSize, requiredSize, true);
            if (capacity < requiredSize) {
                return DPERR_BUFFERTOOSMALL;
            }

            if (!this.validateRange(lpAddress, requiredSize, "rw")) {
                return E_POINTER;
            }

            let out = lpAddress;

            // TotalSize chunk: DPAID_TotalSize GUID + dwDataSize=4 + DWORD totalSize
            mem.set(DPAID_TOTAL_SIZE, out);
            out += GUID_SIZE;
            view.setUint32(out, 4, true); // dwDataSize for the size value
            out += 4;
            view.setUint32(out, requiredSize, true); // the actual total size
            out += 4;

            // Pack each element: GUID + dwDataSize + data blob
            for (let i = 0; i < dwElementCount; i++) {
                const elemOff = lpElements + i * DPCOMPOUNDADDRESSELEMENT_SIZE;
                const guidBytes = mem.subarray(elemOff, elemOff + GUID_SIZE);
                const dataSize = view.getUint32(elemOff + 16, true);
                const dataPtr = view.getUint32(elemOff + 20, true);

                // Write DPADDRESS header
                mem.set(guidBytes, out);
                out += GUID_SIZE;
                view.setUint32(out, dataSize, true);
                out += 4;

                // Copy element data
                if (dataSize > 0 && dataPtr !== 0) {
                    mem.set(mem.subarray(dataPtr, dataPtr + dataSize), out);
                }
                out += dataSize;
            }

            Logger.log(LogCategory.SYSTEM, `CreateCompoundAddress: packed ${dwElementCount} elements → ${requiredSize} bytes at 0x${lpAddress.toString(16)}`);
            return DP_OK;
        };
        this.exports["IDirectPlayLobby3A_CreateCompoundAddress"] = createCompoundAddressImpl;
        this.exports["IDirectPlayLobbyCompatA_CreateCompoundAddress"] = createCompoundAddressImpl;

        // Shared helper: allocate a DirectPlay4A COM object in guest memory and return its address
        const createDirectPlayInGuest = (mem: Uint8Array): number | null => {
            const vtableAddr = this.vtables["IDirectPlay4A"].address;
            const dp = ComObjectFactory.create<DirectPlayObject>(IID_DPLAY4A, vtableAddr);
            if (!dp) return null;
            const objAddr = allocateComObject(this.process.memory, mem, vtableAddr);
            SystemResourceProvider.getInstance().mapAddressToHandle(objAddr, dp.handle);
            return objAddr;
        };

        const connectImpl = (iface: string): ThunkImplementation => (ctx, mem, args) => {
            const dwFlags = args[1] >>> 0;
            const lplpDP = args[2];
            Logger.log(LogCategory.SYSTEM, `${iface}_Connect called: flags=0x${dwFlags.toString(16)}, lplpDP=0x${lplpDP.toString(16)}`);

            if (lplpDP && this.validateRange(lplpDP, 4, "rw")) {
                const objAddr = createDirectPlayInGuest(mem);
                if (objAddr !== null) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(lplpDP, objAddr >>> 0, true);
                    Logger.log(LogCategory.SYSTEM, `${iface}_Connect: created IDirectPlay4A at 0x${(objAddr >>> 0).toString(16)}`);
                    return DP_OK;
                }
            }
            return E_FAIL;
        };

        this.exports["IDirectPlayLobby3A_Connect"] = connectImpl("IDirectPlayLobby3A");
        this.exports["IDirectPlayLobbyCompatA_Connect"] = connectImpl("IDirectPlayLobbyCompatA");

        // ConnectEx(dwFlags, riid, lplpDP, pUnkOuter) — same as Connect but with riid param
        const connectExImpl = (iface: string): ThunkImplementation => (ctx, mem, args) => {
            const dwFlags = args[1] >>> 0;
            const riid = args[2] >>> 0;
            const lplpDP = args[3] >>> 0;
            Logger.log(LogCategory.SYSTEM, `${iface}_ConnectEx called: flags=0x${dwFlags.toString(16)}, riid=0x${riid.toString(16)}, lplpDP=0x${lplpDP.toString(16)}`);

            if (lplpDP && this.validateRange(lplpDP, 4, "rw")) {
                const objAddr = createDirectPlayInGuest(mem);
                if (objAddr !== null) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(lplpDP, objAddr >>> 0, true);
                    Logger.log(LogCategory.SYSTEM, `${iface}_ConnectEx: created IDirectPlay4A at 0x${(objAddr >>> 0).toString(16)}`);
                    return DP_OK;
                }
            }
            return E_FAIL;
        };
        this.exports["IDirectPlayLobby3A_ConnectEx"] = connectExImpl("IDirectPlayLobby3A");
        this.exports["IDirectPlayLobbyCompatA_ConnectEx"] = connectExImpl("IDirectPlayLobbyCompatA");

        // GetConnectionSettings: return DPERR_NOTLOBBIED for non-lobby-launched games.
        // Games launched directly (not via IDirectPlayLobby::RunApplication) are not
        // lobby-aware. HoMM3's FUN_00498b70 checks for DPERR_BUFFERTOOSMALL to detect
        // lobby launch — returning BUFFERTOOSMALL pushes the game into the network
        // connection path → "Error connecting to host computer". Keep NOTLOBBIED.
        // Campaign narration (Path B) does NOT check sess_connected — the issue is elsewhere.
        const getConnectionSettingsImpl = (iface: string): ThunkImplementation => (ctx, mem, args) => {
            const dwAppID = args[1] >>> 0;
            const lpdwDataSize = args[3] >>> 0;
            // Zero out *lpdwDataSize so games that blindly read it after an error
            // (e.g. Re-Volt) don't LocalAlloc with garbage → OOM crash.
            if (lpdwDataSize) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpdwDataSize, 0, true);
            }
            Logger.log(LogCategory.SYSTEM,
                `${iface}_GetConnectionSettings: appID=${dwAppID} → DPERR_NOTLOBBIED (not lobby-launched)`);
            return DPERR_NOTLOBBIED;
        };

        this.exports["IDirectPlayLobby3A_GetConnectionSettings"] = getConnectionSettingsImpl("IDirectPlayLobby3A");
        this.exports["IDirectPlayLobbyCompatA_GetConnectionSettings"] = getConnectionSettingsImpl("IDirectPlayLobbyCompatA");

        const lobbyStubMethods = [
            "Connect",
            "EnumAddressTypes",
            "EnumAddresses",
            "GetConnectionSettings",
            "ReceiveLobbyMessage",
            "RunApplication",
            "SendLobbyMessage",
            "SetConnectionSettings",
            "SetLobbyMessageEvent",
            "CreateCompoundAddress",
            "ConnectEx",
            "RegisterApplication",
            "UnregisterApplication",
            "WaitForConnectionSettings",
        ];

        // RegisterApplication: read DPAPPLICATIONDESC and write to registry
        const registerAppImpl: ThunkImplementation = (ctx, mem, args) => {
            const thisPtr = args[0];
            const dwFlags = args[1];
            const lpDesc = args[2];

            if (!lpDesc) {
                Logger.warn(LogCategory.SYSTEM, `RegisterApplication: NULL lpDesc`);
                return E_POINTER;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // DPAPPLICATIONDESC layout:
            // +0x00: dwSize (4)
            // +0x04: dwFlags (4)
            // +0x08: lpszApplicationNameA (4)
            // +0x0C: guidApplication (16)
            // +0x1C: lpszFilenameA (4)
            // +0x20: lpszCommandLineA (4)
            // +0x24: lpszPathA (4)
            // +0x28: lpszCurrentDirectoryA (4)
            // +0x2C: lpszDescriptionA (4)
            // +0x30: lpszDescriptionW (4)
            const namePtr = view.getUint32(lpDesc + 0x08, true);
            const guidOffset = lpDesc + 0x0C;
            const filenamePtr = view.getUint32(lpDesc + 0x1C, true);
            const cmdLinePtr = view.getUint32(lpDesc + 0x20, true);
            const pathPtr = view.getUint32(lpDesc + 0x24, true);
            const curDirPtr = view.getUint32(lpDesc + 0x28, true);

            const appName = namePtr ? readString(mem, namePtr) : "";
            const filename = filenamePtr ? readString(mem, filenamePtr) : "";
            const cmdLine = cmdLinePtr ? readString(mem, cmdLinePtr) : "";
            const appPath = pathPtr ? readString(mem, pathPtr) : "";
            const curDir = curDirPtr ? readString(mem, curDirPtr) : "";

            // Read GUID bytes and format as string
            const guidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) guidBytes[i] = mem[guidOffset + i];
            const guidStr = this.bytesToGuid(guidBytes);

            Logger.log(LogCategory.SYSTEM,
                `RegisterApplication: name="${appName}", guid=${guidStr}, file="${filename}", path="${appPath}"`);

            if (!appName) {
                Logger.warn(LogCategory.SYSTEM, `RegisterApplication: empty application name`);
                return DP_OK;
            }

            // Write to registry: SOFTWARE\Microsoft\DirectPlay\Applications\{appName}
            const registry = System.getInstance().registry;
            const regPath = `Software\\Microsoft\\DirectPlay\\Applications\\${appName}`;
            registry.createKey("hklm", regPath);
            const keyHandle = registry.open("hklm", regPath);
            if (keyHandle) {
                // bytesToGuid already brace-wraps.
                registry.setValue(keyHandle, "Guid", { name: "Guid", type: "REG_SZ", data: guidStr });
                if (filename) registry.setValue(keyHandle, "File", { name: "File", type: "REG_SZ", data: filename });
                if (appPath) registry.setValue(keyHandle, "Path", { name: "Path", type: "REG_SZ", data: appPath });
                if (cmdLine) registry.setValue(keyHandle, "CommandLine", { name: "CommandLine", type: "REG_SZ", data: cmdLine });
                if (curDir) registry.setValue(keyHandle, "CurrentDirectory", { name: "CurrentDirectory", type: "REG_SZ", data: curDir });
            }

            return DP_OK;
        };
        this.exports["IDirectPlayLobby3A_RegisterApplication"] = registerAppImpl;
        this.exports["IDirectPlayLobbyCompatA_RegisterApplication"] = registerAppImpl;

        // UnregisterApplication(dwFlags, REFGUID) — the registry keys RegisterApplication
        // writes are named by application, so the GUID must be matched against their Guid value.
        const unregisterAppImpl: ThunkImplementation = (_ctx, mem, args) => {
            const lpGuid = args[2] >>> 0;

            const guidBytes = this.readGuidBytes(mem, lpGuid);
            if (!guidBytes) {
                Logger.warn(LogCategory.SYSTEM, "UnregisterApplication: invalid GUID pointer");
                return E_INVALIDARG;
            }
            const guidStr = this.bytesToGuid(guidBytes);

            const registry = System.getInstance().registry;
            const basePath = "Software\\Microsoft\\DirectPlay\\Applications";
            const baseKey = registry.open("hklm", basePath);
            if (!baseKey) {
                Logger.log(LogCategory.SYSTEM, `UnregisterApplication: ${guidStr} not registered`);
                return DP_OK;
            }

            for (const appName of registry.enumSubKeys(baseKey)) {
                const appKey = registry.open("hklm", `${basePath}\\${appName}`);
                if (!appKey) continue;
                const value = registry.getValue(appKey, "Guid");
                if (typeof value?.data !== "string" || value.data.toLowerCase() !== guidStr.toLowerCase()) continue;

                registry.deleteKey(appKey);
                Logger.log(LogCategory.SYSTEM, `UnregisterApplication: removed "${appName}" (${guidStr})`);
                return DP_OK;
            }

            Logger.log(LogCategory.SYSTEM, `UnregisterApplication: ${guidStr} not registered`);
            return DP_OK;
        };
        this.exports["IDirectPlayLobby3A_UnregisterApplication"] = unregisterAppImpl;
        this.exports["IDirectPlayLobbyCompatA_UnregisterApplication"] = unregisterAppImpl;

        for (const method of lobbyStubMethods) {
            if (method === "EnumLocalApplications" || method === "CreateAddress" || method === "Connect" || method === "GetConnectionSettings" || method === "CreateCompoundAddress" || method === "ConnectEx" || method === "RegisterApplication" || method === "UnregisterApplication") {
                continue;
            }

            this.exports[`IDirectPlayLobby3A_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = view.getUint32(ctx.esp, true);
                Logger.log(LogCategory.SYSTEM, `IDirectPlayLobby3A_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);

                // SetConnectionSettings must succeed for games that use lobby-connect path
                if (method === "SetConnectionSettings") {
                    return DP_OK;
                }

                return E_NOTIMPL;
            };

            this.exports[`IDirectPlayLobbyCompatA_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = view.getUint32(ctx.esp, true);
                Logger.log(LogCategory.SYSTEM, `IDirectPlayLobbyCompatA_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);

                if (method === "SetConnectionSettings") {
                    return DP_OK;
                }

                return E_NOTIMPL;
            };
        }

        this.exports["IDirectPlay4A_Initialize"] = (ctx, mem, args) => {
            const lpGuid = args[1];
            const guidBytes = this.readGuidBytes(mem, lpGuid);
            Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_Initialize called: lpGuid=0x${lpGuid.toString(16)}${guidBytes ? `(${this.bytesToGuid(guidBytes)})` : ""}`);
            return DP_OK;
        };

        this.exports["IDirectPlay4A_Open"] = (ctx, mem, args) => {
            const lpSessionDesc = args[1];
            const dwFlags = args[2];
            Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_Open called: lpSessionDesc=0x${lpSessionDesc.toString(16)}, dwFlags=0x${dwFlags.toString(16)}`);
            this.sessionOpen = true;
            return DP_OK;
        };

        this.exports["IDirectPlay4A_CreatePlayer"] = (ctx, mem, args) => {
            const lpidPlayer = args[1];
            const lpPlayerName = args[2];
            const hEvent = args[3];
            const lpData = args[4];
            const dwDataSize = args[5];
            const dwFlags = args[6];

            const syntheticPlayerId = 0xDEAFBEEF; // Synthetic Player ID

            Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_CreatePlayer called: lpidPlayer=0x${lpidPlayer.toString(16)}, namePtr=0x${lpPlayerName.toString(16)}, id=0x${syntheticPlayerId.toString(16)}`);

            if (lpidPlayer && this.validateRange(lpidPlayer, 4, "rw")) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpidPlayer, syntheticPlayerId, true);
            }

            this.localPlayerId = syntheticPlayerId;
            return DP_OK;
        };

        // CreateGroup: allocate a synthetic group DPID
        this.exports["IDirectPlay4A_CreateGroup"] = (ctx, mem, args) => {
            const lpidGroup = args[1] >>> 0;
            const lpGroupName = args[2] >>> 0;
            const lpData = args[3] >>> 0;
            const dwDataSize = args[4] >>> 0;
            const dwFlags = args[5] >>> 0;

            const groupId = this.nextGroupId++;

            if (lpidGroup && this.validateRange(lpidGroup, 4, "rw")) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpidGroup, groupId, true);
            }

            Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_CreateGroup: groupId=0x${groupId.toString(16)}, flags=0x${dwFlags.toString(16)} → DP_OK`);
            return DP_OK;
        };

        // --- Real implementations for loopback message queue ---

        this.exports["IDirectPlay4A_Send"] = (ctx, mem, args) => {
            const idFrom = args[1] >>> 0;
            const idTo = args[2] >>> 0;
            const dwFlags = args[3] >>> 0;
            const lpData = args[4] >>> 0;
            const dwDataSize = args[5] >>> 0;

            Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_Send: from=0x${idFrom.toString(16)}, to=0x${idTo.toString(16)}, flags=0x${dwFlags.toString(16)}, size=${dwDataSize}`);

            if (dwDataSize > 0 && !this.validateRange(lpData, dwDataSize, "r")) {
                Logger.warn(LogCategory.SYSTEM, "IDirectPlay4A_Send: invalid data pointer");
                return E_INVALIDARG;
            }

            const data = dwDataSize > 0 ? mem.slice(lpData, lpData + dwDataSize) : new Uint8Array(0);
            const targetId = idTo === DPID_ALLPLAYERS ? this.localPlayerId : idTo;

            this.messageQueue.push({ idFrom, idTo: targetId, data });
            return DP_OK;
        };

        this.exports["IDirectPlay4A_Receive"] = (ctx, mem, args) => {
            const lpidFrom = args[1] >>> 0;
            const lpidTo = args[2] >>> 0;
            const dwFlags = args[3] >>> 0;
            const lpData = args[4] >>> 0;
            const lpdwDataSize = args[5] >>> 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Read filter IDs from guest pointers
            const filterFrom = (dwFlags & DPRECEIVE_FROMPLAYER) && lpidFrom ? view.getUint32(lpidFrom, true) : 0;
            const filterTo = (dwFlags & DPRECEIVE_TOPLAYER) && lpidTo ? view.getUint32(lpidTo, true) : 0;

            // Find matching message (FIFO)
            let matchIdx = -1;
            for (let i = 0; i < this.messageQueue.length; i++) {
                const msg = this.messageQueue[i];
                if ((dwFlags & DPRECEIVE_FROMPLAYER) && msg.idFrom !== filterFrom) continue;
                if ((dwFlags & DPRECEIVE_TOPLAYER) && msg.idTo !== filterTo) continue;
                matchIdx = i;
                break;
            }

            if (matchIdx === -1) {
                return DPERR_NOMESSAGES;
            }

            const msg = this.messageQueue[matchIdx];

            // Check buffer capacity
            if (!this.validateRange(lpdwDataSize, 4, "rw")) {
                return E_POINTER;
            }
            const capacity = view.getUint32(lpdwDataSize, true);

            if (lpData === 0 || capacity < msg.data.length) {
                view.setUint32(lpdwDataSize, msg.data.length, true);
                return DPERR_BUFFERTOOSMALL;
            }

            if (!this.validateRange(lpData, msg.data.length, "rw")) {
                return E_POINTER;
            }

            // Copy message data to guest memory
            mem.set(msg.data, lpData);
            view.setUint32(lpdwDataSize, msg.data.length, true);

            // Write back idFrom/idTo
            if (lpidFrom && this.validateRange(lpidFrom, 4, "rw")) {
                view.setUint32(lpidFrom, msg.idFrom, true);
            }
            if (lpidTo && this.validateRange(lpidTo, 4, "rw")) {
                view.setUint32(lpidTo, msg.idTo, true);
            }

            // Remove from queue unless peeking
            if (!(dwFlags & DPRECEIVE_PEEK)) {
                this.messageQueue.splice(matchIdx, 1);
            }

            Logger.verbose(LogCategory.SYSTEM, `IDirectPlay4A_Receive: delivered msg from=0x${msg.idFrom.toString(16)}, to=0x${msg.idTo.toString(16)}, size=${msg.data.length}`);
            return DP_OK;
        };

        this.exports["IDirectPlay4A_GetMessageCount"] = (ctx, mem, args) => {
            const idPlayer = args[1] >>> 0;
            const lpdwCount = args[2] >>> 0;

            if (!lpdwCount || !this.validateRange(lpdwCount, 4, "rw")) {
                return E_POINTER;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            let count: number;
            if (idPlayer === 0) {
                count = this.messageQueue.length;
            } else {
                count = 0;
                for (const msg of this.messageQueue) {
                    if (msg.idTo === idPlayer) count++;
                }
            }

            view.setUint32(lpdwCount, count, true);
            Logger.verbose(LogCategory.SYSTEM, `IDirectPlay4A_GetMessageCount: player=0x${idPlayer.toString(16)}, count=${count}`);
            return DP_OK;
        };

        this.exports["IDirectPlay4A_GetCaps"] = (ctx, mem, args) => {
            const lpDPCaps = args[1] >>> 0;
            const dwFlags = args[2] >>> 0;

            Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_GetCaps called: lpDPCaps=0x${lpDPCaps.toString(16)}, flags=0x${dwFlags.toString(16)}`);

            if (!lpDPCaps || !this.validateRange(lpDPCaps, 4, "r")) {
                return E_INVALIDARG;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const dwSize = view.getUint32(lpDPCaps, true);

            if (dwSize < 4 || !this.validateRange(lpDPCaps, dwSize, "rw")) {
                return E_INVALIDARG;
            }

            // Zero the struct, then fill known fields
            for (let i = 4; i < dwSize; i++) {
                mem[lpDPCaps + i] = 0;
            }

            // DPCAPS: dwSize(4), dwFlags(4), dwMaxBufferSize(4), dwMaxQueueSize(4),
            //         dwMaxPlayers(4), dwHundredBaud(4), dwLatency(4), dwMaxLocalPlayers(4), ...
            if (dwSize >= 8) view.setUint32(lpDPCaps + 4, 0x02, true);      // dwFlags = DPCAPS_ISHOST
            if (dwSize >= 12) view.setUint32(lpDPCaps + 8, 0x10000, true); // dwMaxBufferSize (64KB)
            if (dwSize >= 20) view.setUint32(lpDPCaps + 16, 1, true);      // dwMaxPlayers
            if (dwSize >= 32) view.setUint32(lpDPCaps + 28, 1, true);      // dwMaxLocalPlayers

            return DP_OK;
        };

        // EnumSessions: for single-player, the game creates its own session
        // via Open(DPOPEN_CREATE). Just return DP_OK ("no sessions found").
        this.exports["IDirectPlay4A_EnumSessions"] = (ctx, mem, args) => {
            const lpsd = args[1] >>> 0;
            const dwFlags = args[5] >>> 0;

            Logger.log(LogCategory.SYSTEM,
                `IDirectPlay4A_EnumSessions: lpsd=0x${lpsd.toString(16)}, flags=0x${dwFlags.toString(16)} → DP_OK (no sessions)`);

            return DP_OK;
        };

        this.exports["IDirectPlay4A_Close"] = (ctx, mem, args) => {
            Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_Close called, clearing ${this.messageQueue.length} queued messages`);
            this.messageQueue.length = 0;
            this.sessionOpen = false;
            this.localPlayerId = 0;
            return DP_OK;
        };

        // GetMessageQueue: returns count/bytes of pending messages in send queue.
        // For loopback, the send queue is always empty (messages are delivered instantly).
        this.exports["IDirectPlay4A_GetMessageQueue"] = (ctx, mem, args) => {
            const idFrom = args[1] >>> 0;
            const idTo = args[2] >>> 0;
            const dwFlags = args[3] >>> 0;
            const lpdwNumMsgs = args[4] >>> 0;
            const lpdwNumBytes = args[5] >>> 0;

            Logger.log(LogCategory.SYSTEM,
                `IDirectPlay4A_GetMessageQueue: from=0x${idFrom.toString(16)}, to=0x${idTo.toString(16)}, flags=0x${dwFlags.toString(16)}, pNumMsgs=0x${lpdwNumMsgs.toString(16)}, pNumBytes=0x${lpdwNumBytes.toString(16)}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (lpdwNumMsgs && this.validateRange(lpdwNumMsgs, 4, "rw")) {
                view.setUint32(lpdwNumMsgs, 0, true);
            }
            if (lpdwNumBytes && this.validateRange(lpdwNumBytes, 4, "rw")) {
                view.setUint32(lpdwNumBytes, 0, true);
            }
            return DP_OK;
        };

        // InitializeConnection: accept the compound address for loopback.
        // In real DirectPlay this loads the SP DLL; for us it's a no-op.
        this.exports["IDirectPlay4A_InitializeConnection"] = (ctx, mem, args) => {
            const lpConnection = args[1] >>> 0;
            const dwFlags = args[2] >>> 0;
            Logger.log(LogCategory.SYSTEM,
                `IDirectPlay4A_InitializeConnection: lpConnection=0x${lpConnection.toString(16)}, flags=0x${dwFlags.toString(16)} → DP_OK`);
            return DP_OK;
        };

        const dplayStubMethods = [
            // IDirectPlay2 methods
            "AddPlayerToGroup",
            "Close",
            "CreateGroup",
            "CreatePlayer",
            "DeletePlayerFromGroup",
            "DestroyGroup",
            "DestroyPlayer",
            "EnumGroupPlayers",
            "EnumGroups",
            "EnumPlayers",
            "EnumSessions",
            "GetCaps",
            "GetGroupData",
            "GetGroupName",
            "GetMessageCount",
            "GetPlayerAddress",
            "GetPlayerCaps",
            "GetPlayerData",
            "GetPlayerName",
            "GetSessionDesc",
            "Initialize",
            "Open",
            "Receive",
            "Send",
            "SetGroupData",
            "SetGroupName",
            "SetPlayerData",
            "SetPlayerName",
            "SetSessionDesc",
            // IDirectPlay3 methods
            "AddGroupToGroup",
            "CreateGroupInGroup",
            "DeleteGroupFromGroup",
            "EnumConnections",
            "EnumGroupsInGroup",
            "GetGroupConnectionSettings",
            "InitializeConnection",
            "SecureOpen",
            "SendChatMessage",
            "SetGroupConnectionSettings",
            "StartSession",
            "GetGroupFlags",
            "GetGroupParent",
            // IDirectPlay4 methods
            "GetPlayerAccount",
            "GetPlayerFlags",
            "GetGroupOwner",
            "SetGroupOwner",
            "SendEx",
            "GetMessageQueue",
            "CancelMessage",
            "CancelPriority",
        ];

        // Methods that return DP_OK as no-ops (empty enumerations, session state queries)
        const dplayNoOpSuccess = new Set([
            "EnumGroups", "EnumPlayers", "EnumGroupPlayers", "EnumGroupsInGroup",
            "SetSessionDesc", "GetSessionDesc", "SetPlayerData", "SetGroupData",
            "AddPlayerToGroup", "DeletePlayerFromGroup", "SetPlayerName",
        ]);
        const dplayImplementedMethods = new Set(["Initialize", "Open", "CreatePlayer", "CreateGroup", "Send", "Receive", "GetMessageCount", "GetCaps", "EnumSessions", "Close", "GetMessageQueue", "InitializeConnection"]);
        for (const method of dplayStubMethods) {
            if (dplayImplementedMethods.has(method)) continue;
            const returnOk = dplayNoOpSuccess.has(method);
            this.exports[`IDirectPlay4A_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = view.getUint32(ctx.esp, true);
                Logger.log(LogCategory.SYSTEM, `IDirectPlay4A_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
                return returnOk ? DP_OK : E_NOTIMPL;
            };
        }

        // Methods for IDirectPlay (v1) — share no-op success list with v4, but v1 has different param layouts
        this.exports["IDirectPlay_Initialize"] = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const state = validateDirectPlayV1Object(thisPtr);
            if (state !== DP_OK) return state;

            this.directPlayV1Initialized = true;
            Logger.log(LogCategory.SYSTEM, `IDirectPlay_Initialize called: this=0x${thisPtr.toString(16)} -> DP_OK`);
            return DP_OK;
        };
        this.exports["IDirectPlay_Open"] = (_ctx, _mem, args) => {
            const thisPtr = args[0] >>> 0;
            const state = validateDirectPlayV1Object(thisPtr);
            if (state !== DP_OK) return state;
            if (!this.directPlayV1Initialized) {
                Logger.log(LogCategory.SYSTEM, `IDirectPlay_Open called before Initialize: this=0x${thisPtr.toString(16)} -> DPERR_UNINITIALIZED`);
                return DPERR_UNINITIALIZED;
            }

            this.directPlayV1Open = true;
            Logger.log(LogCategory.SYSTEM, `IDirectPlay_Open called: this=0x${thisPtr.toString(16)} -> DP_OK`);
            return DP_OK;
        };

        // v1 CreateGroup: (LPDPID, LPSTR friendlyName, LPSTR formalName) — 3 args + this = 4 params
        this.exports["IDirectPlay_CreateGroup"] = (_ctx, mem, args) => {
            const state = requireDirectPlayV1Ready(args[0] >>> 0);
            if (state !== DP_OK) return state;

            const lpidGroup = args[1] >>> 0;
            const groupId = this.nextGroupId++;
            if (lpidGroup && this.validateRange(lpidGroup, 4, "rw")) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpidGroup, groupId, true);
            }
            Logger.log(LogCategory.SYSTEM, `IDirectPlay_CreateGroup: groupId=0x${groupId.toString(16)} → DP_OK`);
            return DP_OK;
        };
        // v1 CreatePlayer: (LPDPID, LPSTR friendlyName, LPSTR formalName, LPHANDLE event) — 4 args + this = 5 params
        this.exports["IDirectPlay_CreatePlayer"] = (_ctx, mem, args) => {
            const state = requireDirectPlayV1Ready(args[0] >>> 0);
            if (state !== DP_OK) return state;

            const lpidPlayer = args[1] >>> 0;
            const syntheticPlayerId = 0xDEAFBEEF;
            if (lpidPlayer && this.validateRange(lpidPlayer, 4, "rw")) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpidPlayer, syntheticPlayerId, true);
            }
            this.localPlayerId = syntheticPlayerId;
            Logger.log(LogCategory.SYSTEM, `IDirectPlay_CreatePlayer: playerId=0x${syntheticPlayerId.toString(16)} → DP_OK`);
            return DP_OK;
        };
        // v1 Close: same logic as v4
        this.exports["IDirectPlay_Close"] = (_ctx, _mem, args) => {
            const state = validateDirectPlayV1Object(args[0] >>> 0);
            if (state !== DP_OK) return state;
            if (!this.directPlayV1Initialized) return DPERR_UNINITIALIZED;

            Logger.log(LogCategory.SYSTEM, `IDirectPlay_Close called, clearing ${this.messageQueue.length} queued messages`);
            this.messageQueue.length = 0;
            this.directPlayV1Open = false;
            this.localPlayerId = 0;
            return DP_OK;
        };
        for (const method of dplayStubMethods) {
            // Skip methods with explicit v1 implementations above
            if (method === "Initialize" || method === "Open" || method === "CreateGroup" || method === "CreatePlayer" || method === "Close") continue;
            const returnOk = dplayNoOpSuccess.has(method);
            this.exports[`IDirectPlay_${method}`] = (ctx, mem, args) => {
                const state = requireDirectPlayV1Ready(args[0] >>> 0);
                if (state !== DP_OK) return state;

                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = view.getUint32(ctx.esp, true);
                Logger.log(LogCategory.SYSTEM, `IDirectPlay_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
                return returnOk ? DP_OK : E_NOTIMPL;
            };
        }

        // v1-only methods not in dplayStubMethods (IDirectPlay2+ method list)
        this.exports["IDirectPlay_EnableNewPlayers"] = (_ctx, _mem, args) => {
            const state = requireDirectPlayV1Ready(args[0] >>> 0);
            if (state !== DP_OK) return state;
            Logger.log(LogCategory.SYSTEM, `IDirectPlay_EnableNewPlayers stub: this=0x${args[0].toString(16)}, enable=${args[1]}`);
            return DP_OK;
        };
        this.exports["IDirectPlay_SaveSession"] = (_ctx, _mem, args) => {
            const state = requireDirectPlayV1Ready(args[0] >>> 0);
            if (state !== DP_OK) return state;
            Logger.log(LogCategory.SYSTEM, `IDirectPlay_SaveSession stub: this=0x${args[0].toString(16)}`);
            return DP_OK;
        };

        // Methods for IDirectPlayLobby (v1)
        for (const method of lobbyStubMethods) {
            this.exports[`IDirectPlayLobby_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = view.getUint32(ctx.esp, true);
                Logger.log(LogCategory.SYSTEM, `IDirectPlayLobby_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
                return E_NOTIMPL;
            };
        }
        this.exports["IDirectPlayLobby_CreateAddress"] = createAddressLobby3Impl;
        this.exports["IDirectPlayLobby_EnumLocalApplications"] = enumLocalApplicationsImpl(false);

        const dplay8LobbyStubMethods = [
            "Initialize",
            "EnumLocalPrograms",
            "ConnectApplication",
            "Send",
            "ReleaseApplication",
            "Close",
            "GetConnectionSettings",
            "SetConnectionSettings",
        ];

        for (const method of dplay8LobbyStubMethods) {
            this.exports[`IDirectPlay8LobbyClient_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = view.getUint32(ctx.esp, true);
                Logger.log(LogCategory.SYSTEM, `IDirectPlay8LobbyClient_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);

                if (method === "Initialize") {
                    return DP_OK;
                }
                if (method === "GetConnectionSettings") {
                    const pdwSize = args[3];
                    if (pdwSize && this.validateRange(pdwSize, 4, "rw")) {
                        view.setUint32(pdwSize, 0, true);
                    }
                    return DP_OK;
                }
                return E_NOTIMPL;
            };
        }
    }

    private registerDirectExports(): void {
        const resourceProvider = SystemResourceProvider.getInstance();

        // DirectPlayCreate (ordinal 1)
        // Creates an IDirectPlay object. HoMM3's CNetManager immediately QIs to IDirectPlay4A,
        // so we create the object with IDirectPlay4A vtable directly — QI returns the same
        // guest address, and the vtable must match the interface the game actually uses.
        const directPlayCreateImpl: ThunkImplementation = (ctx, mem, args) => {
            const lpGUID = args[0];
            const lplpDP = args[1];
            const pUnkOuter = args[2];

            Logger.log(LogCategory.SYSTEM,
                `DirectPlayCreate called: lpGUID=0x${lpGUID.toString(16)}, lplpDP=0x${lplpDP.toString(16)}, pUnkOuter=0x${pUnkOuter.toString(16)}`);

            if (!lplpDP || !this.validateRange(lplpDP, 4, "rw")) {
                Logger.warn(LogCategory.SYSTEM, "DirectPlayCreate: invalid lplpDP pointer");
                return E_POINTER;
            }

            const dp = ComObjectFactory.create<DirectPlayObject>(IID_DPLAY4A, this.vtables["IDirectPlay4A"].address);
            if (!dp) {
                Logger.warn(LogCategory.SYSTEM, "DirectPlayCreate: failed to create COM object");
                return E_FAIL;
            }

            const addr = resourceProvider.getAddressForHandle(dp.handle);
            if (addr === null) {
                Logger.warn(LogCategory.SYSTEM, "DirectPlayCreate: failed to get guest address");
                return E_FAIL;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lplpDP, addr >>> 0, true);

            Logger.log(LogCategory.SYSTEM,
                `DirectPlayCreate: created IDirectPlay at 0x${(addr >>> 0).toString(16)}`);
            return DP_OK;
        };

        this.exports["directplaycreate"] = directPlayCreateImpl;
        this.exports["ord_1"] = directPlayCreateImpl;

        // DirectPlayEnumerateA (ordinal 2)
        // Enumerates service providers. For HLE standalone mode, return DP_OK without
        // calling the callback (no providers = standalone/loopback).
        const directPlayEnumerateAImpl: ThunkImplementation = (ctx, mem, args) => {
            const lpEnumCallback = args[0];
            const lpContext = args[1];

            Logger.log(LogCategory.SYSTEM,
                `DirectPlayEnumerateA called: callback=0x${lpEnumCallback.toString(16)}, context=0x${lpContext.toString(16)}`);

            return DP_OK;
        };

        this.exports["directplayenumeratea"] = directPlayEnumerateAImpl;
        this.exports["ord_2"] = directPlayEnumerateAImpl;

        // DirectPlayLobbyCreateA (ordinal 4)
        // Creates an IDirectPlayLobby object. Games QI to IDirectPlayLobby3A,
        // so we use the Lobby3A vtable directly.
        const directPlayLobbyCreateAImpl: ThunkImplementation = (ctx, mem, args) => {
            const lpGUID = args[0];
            const lplpDPL = args[1];
            const pUnkOuter = args[2];
            const lpData = args[3];
            const dwDataSize = args[4] >>> 0;

            Logger.log(LogCategory.SYSTEM,
                `DirectPlayLobbyCreateA called: lpGUID=0x${lpGUID.toString(16)}, lplpDPL=0x${lplpDPL.toString(16)}, pUnkOuter=0x${pUnkOuter.toString(16)}, lpData=0x${lpData.toString(16)}, dwDataSize=${dwDataSize}`);

            if (!lplpDPL || !this.validateRange(lplpDPL, 4, "rw")) {
                Logger.warn(LogCategory.SYSTEM, "DirectPlayLobbyCreateA: invalid lplpDPL pointer");
                return E_POINTER;
            }

            const lobby = ComObjectFactory.create<DirectPlayLobbyObject>(IID_DPLAY_LOBBY3A, this.vtables["IDirectPlayLobby3A"].address);
            if (!lobby) {
                Logger.warn(LogCategory.SYSTEM, "DirectPlayLobbyCreateA: failed to create COM object");
                return E_FAIL;
            }

            const addr = resourceProvider.getAddressForHandle(lobby.handle);
            if (addr === null) {
                Logger.warn(LogCategory.SYSTEM, "DirectPlayLobbyCreateA: failed to get guest address");
                return E_FAIL;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lplpDPL, addr >>> 0, true);

            Logger.log(LogCategory.SYSTEM,
                `DirectPlayLobbyCreateA: created IDirectPlayLobby at 0x${(addr >>> 0).toString(16)}`);
            return DP_OK;
        };

        this.exports["directplaylobbycreatea"] = directPlayLobbyCreateAImpl;
        this.exports["ord_4"] = directPlayLobbyCreateAImpl;
    }

    private bytesToGuid(bytes: Uint8Array): string {
        const data1 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
        const data2 = (bytes[4] | (bytes[5] << 8)) >>> 0;
        const data3 = (bytes[6] | (bytes[7] << 8)) >>> 0;
        const data4 = Array.from(bytes.slice(8, 16))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");

        return `{${data1.toString(16).padStart(8, "0")}-${data2.toString(16).padStart(4, "0")}-${data3.toString(16).padStart(4, "0")}-${data4.slice(0, 4)}-${data4.slice(4)}}`;
    }

    private getMemory(): Uint8Array {
        return this.process.getCurrentMemory();
    }

    reset(): void {
        this.messageQueue.length = 0;
        this.localPlayerId = 0;
        this.sessionOpen = false;
        this.directPlayV1Initialized = false;
        this.directPlayV1Open = false;
    }

    recreateVTables(): void {
        if (this.process) {
            this.memory = this.getMemory();
            this.vtables = createVTablesFromDescriptor(this.process, dplayxModule);
            Logger.verbose(LogCategory.SYSTEM, "DirectPlay: Recreated vtables after reset");

            for (const [name, info] of Object.entries(this.vtables)) {
                Logger.verbose(LogCategory.SYSTEM, `DirectPlay: Recreated vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
            }
        }
    }
}
