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
import { DirectPlayNetworkApi } from "./network-api";
import { HleComServer } from '../../core/com/hle-com-server';
import { installDirectPlayRegistration } from '../directplay-registration';
import { DIRECTPLAY_COM_CLASSES } from '../directplay-classes';

// COM error codes
const DP_OK = 0x00000000;
const E_NOINTERFACE = 0x80004002;
const E_NOTIMPL = 0x80004001;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const DPERR_BUFFERTOOSMALL = 0x8877001e;
// MAKE_DPHRESULT(code) = 0x8877_0000 | code, with `code` the DECIMAL value from dplay.h.
const DPERR_NOTLOBBIED = 0x8877042e; // MAKE_DPHRESULT(1070)
const E_FAIL = 0x80004005;

const IID_DPLAY_LOBBY3A = "2db72491-652c-11d1-a7a8-0000f803abfc";
const IID_DPLAY_LOBBY_COMPAT = "5959df62-2911-11d1-b049-0020af30269a";
const IID_DPLAY4A = "0ab1c531-4745-11d1-a7a1-0000f803abfc";
const IID_DPLAY_LOBBY = "af465c71-9588-11cf-a020-00aa006157ac";
// ANSI variant of IDirectPlayLobby — same vtable shape, so one object serves both.
const IID_DPLAY_LOBBY_ANSI = "26c66a70-b367-11cf-a024-00aa006157ac";
const IID_DPLAY = "5454e9a0-db65-11ce-921c-00aa006c4972";

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
 * DirectPlay COM object lifetime.
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
 * DirectPlay Lobby COM object lifetime.
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

export class DPlayX implements IModule {
    name = "dplayx";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private vtables: Record<string, VTableInfo> = {};
    private networkApi!: DirectPlayNetworkApi;
    private comServer!: HleComServer;

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

        const interfaceRegistry = InterfaceRegistry.getInstance();
        interfaceRegistry.registerFromModuleDescriptor(dplayxModule);

        this.vtables = createVTablesFromDescriptor(this.process, dplayxModule);

        for (const [name, info] of Object.entries(this.vtables)) {
            Logger.verbose(LogCategory.SYSTEM, `DirectPlay: Created vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
        }

        ComObjectFactory.register(IID_DPLAY_LOBBY3A, DirectPlayLobbyObject);
        ComObjectFactory.register(IID_DPLAY_LOBBY_COMPAT, DirectPlayLobbyCompatObject);
        ComObjectFactory.register(IID_DPLAY4A, DirectPlayObject);
        ComObjectFactory.register("9d460580-a822-11cf-960c-0080c7534e82", DirectPlayObject);
        ComObjectFactory.register("133efe41-32dc-11d0-9cfb-00a0c90a43cb", DirectPlayObject);
        ComObjectFactory.register(IID_DPLAY_LOBBY, DirectPlayLobbyObjectV1);
        ComObjectFactory.register(IID_DPLAY, DirectPlayObjectV1);
        for (const iface of dplayxModule.interfaces ?? []) {
            if (iface.iid && /^IDirectPlay[234]$/.test(iface.name)) ComObjectFactory.register(iface.iid, DirectPlayObject);
            if (iface.iid && /^IDirectPlayLobby[23]?A?$/.test(iface.name)) ComObjectFactory.register(iface.iid, DirectPlayLobbyObject);
        }

        this.registerMethodStubs();

        this.networkApi = new DirectPlayNetworkApi(process, () => this.vtables);
        this.networkApi.install(this.exports);
        this.exports.DirectPlayEnumerate = this.exports.directplayenumeratea;
        this.exports.directplayenumerate = this.exports.directplayenumeratea;
        this.exports.ord_9 = this.exports.directplayenumeratea;
        this.comServer = new HleComServer(process, dplayxModule, () => this.vtables, DIRECTPLAY_COM_CLASSES);
        this.comServer.install(this.exports);
        installDirectPlayRegistration(this.exports, 'dplayx');
    }

    private registerMethodStubs(): void {
        const lobbyStubMethods = [
            "ReceiveLobbyMessage", "RunApplication", "SendLobbyMessage", "SetLobbyMessageEvent",
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
                // Waiting for settings that a lobby would have supplied: same answer as
                // GetConnectionSettings, and it must ANSWER rather than block forever.
                if (method === "WaitForConnectionSettings") {
                    return DPERR_NOTLOBBIED;
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
                if (method === "WaitForConnectionSettings") {
                    return DPERR_NOTLOBBIED;
                }

                return E_NOTIMPL;
            };
        }

        // Methods for IDirectPlayLobby (v1)
        for (const method of lobbyStubMethods) {
            this.exports[`IDirectPlayLobby_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = view.getUint32(ctx.esp, true);
                Logger.log(LogCategory.SYSTEM, `IDirectPlayLobby_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
                return E_NOTIMPL;
            };
        }

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
        this.networkApi?.reset();
        this.comServer?.reset();
    }

    recreateVTables(): void {
        if (this.process) {
            this.vtables = createVTablesFromDescriptor(this.process, dplayxModule);
            Logger.verbose(LogCategory.SYSTEM, "DirectPlay: Recreated vtables after reset");

            for (const [name, info] of Object.entries(this.vtables)) {
                Logger.verbose(LogCategory.SYSTEM, `DirectPlay: Recreated vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
            }
        }
    }
}
