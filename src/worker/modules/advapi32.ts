import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Marshaler } from "../core/memory/marshaler";
import { isValidAddress } from "../core/memory/address-guard";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { RegistryValue } from "../runtime/filesystem/registry";
import { Logger, LogCategory } from "../core/logger";
import { encodeAnsi } from "./codepage-utils";
import { Md5, Sha1 } from "@bottleship/formats/unpack";

const HKEY_CLASSES_ROOT = 0x80000000;
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const HKEY_USERS = 0x80000003;
const HKEY_PERFORMANCE_DATA = 0x80000004;
const HKEY_CURRENT_CONFIG = 0x80000005;
const HKEY_DYN_DATA = 0x80000006;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_SERVICE_DISABLED = 1058;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const SERVICE_STATUS_SIZE = 28;
const SERVICE_KERNEL_DRIVER = 1;
const SERVICE_STOPPED = 1;
const SERVICE_NO_CHANGE = 0xffffffff;
const ERROR_UNKNOWN_REVISION = 1305;
const ERROR_NO_TOKEN = 1008;
const SECURITY_DESCRIPTOR_REVISION = 1;
const SECURITY_DESCRIPTOR_MIN_LENGTH = 20;
const SE_DACL_PRESENT = 0x0004;
const SE_DACL_DEFAULTED = 0x0008;

/** wincrypt.h ALG_IDs we can compute for real; anything else has no digest to report. */
const CALG_MD5 = 0x00008003;
const CALG_SHA1 = 0x00008004;

/** CryptGetHashParam dwParam values. */
const HP_ALGID = 0x0001;
const HP_HASHVAL = 0x0002;
const HP_HASHSIZE = 0x0004;

const ERROR_MORE_DATA = 234;
const NTE_BAD_ALGID = 0x80090008 | 0;
const NTE_BAD_KEY = 0x80090003 | 0;
const NTE_BAD_HASH_STATE = 0x8009000b | 0;

interface CryptHasher {
    update(data: Uint8Array): void;
    digest(): Uint8Array;
    readonly size: number;
}

/**
 * A real digest for the algorithms we implement, and NOTHING for the rest — a hash a
 * caller can read back has to be the actual MD5/SHA-1 of the bytes it fed in, because the
 * usual use is "hash this, compare with what I stored last run". An unsupported ALG_ID
 * still gets a handle (CryptCreateHash succeeded on real Windows, and callers that only
 * sign/verify never read the value) but CryptGetHashParam then fails with NTE_BAD_ALGID
 * rather than invent bytes.
 */
function makeCryptHasher(algId: number): CryptHasher | null {
    if (algId === CALG_MD5) {
        const h = new Md5();
        return { update: (d) => h.update(d), digest: () => h.finalize(), size: 16 };
    }
    if (algId === CALG_SHA1) {
        const h = new Sha1();
        return { update: (d) => h.update(d), digest: () => h.finalize(), size: 20 };
    }
    return null;
}

export class Advapi32 implements IModule {
    name = "advapi32";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        const system = System.getInstance();

        // All seven predefined HKEYs resolve to a canonical registry root. A predefined
        // key is ALWAYS valid in Win32 — never ERROR_INVALID_HANDLE. The Win9x-only
        // hives (HKEY_DYN_DATA = dynamic perf/Config-Manager data, HKEY_PERFORMANCE_DATA,
        // HKEY_CURRENT_CONFIG, HKEY_USERS) were previously unmapped → resolveRoot returned
        // null → every reg call on them returned ERROR_INVALID_HANDLE (6). NFS-PU opens
        // HKEY_DYN_DATA every frame on the load-transition screen; a hard INVALID_HANDLE
        // (vs a clean FILE_NOT_FOUND for a missing subkey) drove its state machine into a
        // retry loop → black-screen/hourglass hang. Mapping the hive lets a missing subkey
        // return FILE_NOT_FOUND so the game falls back (it also polls GlobalMemoryStatus).
        const resolveRoot = (hKey: number): string | null => {
            switch (hKey) {
                case HKEY_CLASSES_ROOT: return "HKCR";
                case HKEY_CURRENT_USER: return "HKCU";
                case HKEY_LOCAL_MACHINE: return "HKLM";
                case HKEY_USERS: return "HKU";
                case HKEY_PERFORMANCE_DATA: return "HKPD";
                case HKEY_CURRENT_CONFIG: return "HKCC";
                case HKEY_DYN_DATA: return "HKDD";
            }
            const handle = process.resourceProvider.getKernelObject(hKey);
            if (handle && handle.kind === "reg") {
                return handle.key;
            }
            return null;
        };

        // Win32: opening a predefined hive with a NULL/empty subkey returns a handle to the
        // hive root itself, and ALWAYS succeeds — even if our virtual store has nothing
        // seeded under it. Returns the resolved full key, or null only for an invalid hive.
        const openKey = (root: string, subKey: string): string | null => {
            if (!subKey) return root; // open the predefined root itself
            return system.registry.open(root, subKey);
        };

        const writeAnsi = (mem: Uint8Array, addr: number, value: string, max: number) => {
            const encoded = encodeAnsi(value);
            const bytes = new Uint8Array(encoded.length + 1);
            bytes.set(encoded);
            // null terminator already 0
            const toWrite = Math.min(bytes.length, max);
            mem.set(bytes.subarray(0, toWrite), addr);
            return toWrite;
        };

        const writeWide = (mem: Uint8Array, addr: number, value: string, maxChars: number) => {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const toWrite = Math.min(value.length, maxChars - 1);
            for (let i = 0; i < toWrite; i++) {
                view.setUint16(addr + i * 2, value.charCodeAt(i), true);
            }
            view.setUint16(addr + toWrite * 2, 0, true);
            return toWrite * 2;
        };

        const queryValueCommon = (
            mem: Uint8Array,
            keyHandle: string | null,
            valueName: string,
            lpType: number,
            lpData: number,
            lpcbData: number,
            wideString: boolean,
            stackCleanup: number
        ) => {
            if (!keyHandle) {
                return { value: 6, stackCleanup }; // ERROR_INVALID_HANDLE
            }
            let value = system.registry.getValue(keyHandle, valueName);
            if (!value && keyHandle.toLowerCase().includes("perfstats")) {
                // Simplified-faithful Win9x PerfStats: any counter under HKEY_DYN_DATA\PerfStats
                // returns a live DWORD. We don't run a real perf collector, so synthesize a
                // plausible value. Log the exact counter name so the specific stat a game polls
                // (e.g. free-memory pages on a load gate) can be given a meaningful value.
                Logger.log(LogCategory.SYSTEM, `PerfStats query: ${keyHandle} "${valueName}" -> synthesized REG_DWORD 0 (simplified HLE)`);
                value = { name: valueName, type: "REG_DWORD", data: 0 };
            }
            if (!value) {
                return { value: 2, stackCleanup }; // ERROR_FILE_NOT_FOUND
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            let requiredSize = 0;
            let dwordValue = 0;
            let ansiBytes: Uint8Array | null = null;
            let wideValue = "";

            if (value.type === "REG_DWORD") {
                requiredSize = 4;
                dwordValue = Number(value.data) >>> 0;
            } else if (value.type === "REG_BINARY" || value.type === "REG_MULTI_SZ") {
                const hexStr = String(value.data);
                requiredSize = hexStr.length / 2;
                ansiBytes = new Uint8Array(requiredSize);
                for (let i = 0; i < requiredSize; i++) {
                    ansiBytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
                }
            } else if (wideString) {
                wideValue = String(value.data);
                requiredSize = (wideValue.length + 1) * 2;
            } else {
                ansiBytes = encodeAnsi(String(value.data) + "\0");
                requiredSize = ansiBytes.length;
            }

            let availableSize = 0;
            if (lpcbData !== 0) {
                if (lpcbData + 4 > mem.length) return { value: 998, stackCleanup }; // ERROR_NOACCESS
                availableSize = view.getUint32(lpcbData, true);
            }

            if (lpType !== 0 && lpType + 4 <= mem.length) {
                const typeCode = value.type === "REG_DWORD" ? 4 : value.type === "REG_BINARY" ? 3 : value.type === "REG_MULTI_SZ" ? 7 : 1;
                view.setUint32(lpType, typeCode, true);
            }
            if (lpcbData !== 0) {
                view.setUint32(lpcbData, requiredSize, true);
            }

            if (lpData !== 0) {
                if (availableSize < requiredSize) return { value: 234, stackCleanup }; // ERROR_MORE_DATA
                if (lpData + requiredSize > mem.length) return { value: 998, stackCleanup };
                if (value.type === "REG_DWORD") {
                    view.setUint32(lpData, dwordValue, true);
                } else if (wideString) {
                    writeWide(mem, lpData, wideValue, wideValue.length + 1);
                } else if (ansiBytes) {
                    mem.set(ansiBytes, lpData);
                }
            }

            return { value: 0, stackCleanup };
        };

        this.exports["RegOpenKeyExA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const phkResult = args[4];
            const root = resolveRoot(hKey);
            if (!root) {
                Logger.warn(LogCategory.SYSTEM, `RegOpenKeyExA: invalid hKey=0x${hKey.toString(16)}`);
                return { value: 6, stackCleanup: 20 };
            }
            const subKey = Marshaler.readString(mem, lpSubKey);
            const fullKey = openKey(root, subKey);
            if (!fullKey) {
                Logger.log(LogCategory.SYSTEM, `RegOpenKeyExA(${root}\\"${subKey}") -> NOT FOUND`);
                return { value: 2, stackCleanup: 20 };
            }
            Logger.log(LogCategory.SYSTEM, `RegOpenKeyExA(${root}\\"${subKey}") -> OK`);
            if (phkResult && !isValidAddress(mem, phkResult, 4, "rw")) {
                return { value: 87, stackCleanup: 20 }; // ERROR_INVALID_PARAMETER (e.g. thunk region)
            }
            const handle = process.resourceProvider.registerKernelObject({ kind: "reg", key: fullKey });
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (phkResult && phkResult + 4 <= mem.length) view.setUint32(phkResult, handle >>> 0, true);
            return { value: 0, stackCleanup: 20 };
        };

        this.exports["RegOpenKeyExW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const phkResult = args[4];
            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 20 };
            }
            const subKey = Marshaler.readWideString(mem, lpSubKey);
            const fullKey = openKey(root, subKey);
            if (!fullKey) {
                return { value: 2, stackCleanup: 20 };
            }
            if (phkResult && !isValidAddress(mem, phkResult, 4, "rw")) {
                return { value: 87, stackCleanup: 20 }; // ERROR_INVALID_PARAMETER
            }
            const handle = process.resourceProvider.registerKernelObject({ kind: "reg", key: fullKey });
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (phkResult && phkResult + 4 <= mem.length) view.setUint32(phkResult, handle >>> 0, true);
            return { value: 0, stackCleanup: 20 };
        };

        this.exports["RegOpenKeyA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const phkResult = args[2];
            const root = resolveRoot(hKey);
            if (!root) {
                Logger.warn(LogCategory.SYSTEM, `RegOpenKeyA: invalid hKey=0x${hKey.toString(16)}`);
                return { value: 6, stackCleanup: 12 };
            }
            const subKey = Marshaler.readString(mem, lpSubKey);
            const fullKey = openKey(root, subKey);
            if (!fullKey) {
                Logger.log(LogCategory.SYSTEM, `RegOpenKeyA(${root}\\"${subKey}") -> NOT FOUND`);
                return { value: 2, stackCleanup: 12 };
            }
            Logger.log(LogCategory.SYSTEM, `RegOpenKeyA(${root}\\"${subKey}") -> OK`);
            if (phkResult && !isValidAddress(mem, phkResult, 4, "rw")) {
                return { value: 87, stackCleanup: 12 };
            }
            const handle = process.resourceProvider.registerKernelObject({ kind: "reg", key: fullKey });
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (phkResult && phkResult + 4 <= mem.length) view.setUint32(phkResult, handle >>> 0, true);
            return { value: 0, stackCleanup: 12 };
        };

        this.exports["RegOpenKeyW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const phkResult = args[2];
            return this.exports["RegOpenKeyExW"]!(ctx, mem, [hKey, lpSubKey, 0, 0, phkResult]);
        };

        this.exports["RegOpenKeyTransactedA"] = (ctx, mem, args) => {
            return this.exports["RegOpenKeyExA"]!(ctx, mem, [args[0], args[1], args[2], args[3], args[4]]);
        };

        this.exports["RegOpenKeyTransactedW"] = (ctx, mem, args) => {
            return this.exports["RegOpenKeyExW"]!(ctx, mem, [args[0], args[1], args[2], args[3], args[4]]);
        };

        this.exports["RegQueryValueExA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpValueName = args[1];
            const lpType = args[3];
            const lpData = args[4];
            const lpcbData = args[5];
            const keyHandle = resolveRoot(hKey);
            if (!keyHandle) {
                Logger.warn(LogCategory.SYSTEM, `RegQueryValueExA: invalid hKey=0x${hKey.toString(16)}`);
                return { value: 6, stackCleanup: 24 };
            }
            const valueName = Marshaler.readString(mem, lpValueName);
            const value = system.registry.getValue(keyHandle, valueName);
            if (!value) {
                Logger.log(LogCategory.SYSTEM, `RegQueryValueExA(key="${keyHandle}", name="${valueName}") -> NOT FOUND`);
                return { value: 2, stackCleanup: 24 };
            }
            Logger.log(LogCategory.SYSTEM, `RegQueryValueExA(key="${keyHandle}", name="${valueName}") -> ${value.type}: ${value.data}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Calculate required size first
            let requiredSize = 0;
            let bytes: Uint8Array | null = null;
            let dwordValue = 0;

            if (value.type === "REG_DWORD") {
                requiredSize = 4;
                dwordValue = Number(value.data) >>> 0;
            } else if (value.type === "REG_BINARY" || value.type === "REG_MULTI_SZ") {
                // Binary/multi-string data stored as hex string
                const hexStr = String(value.data);
                requiredSize = hexStr.length / 2;
                bytes = new Uint8Array(requiredSize);
                for (let i = 0; i < requiredSize; i++) {
                    bytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
                }
            } else {
                bytes = encodeAnsi(String(value.data) + "\0");
                requiredSize = bytes.length;
            }

            // Read available size
            let availableSize = 0;
            if (lpcbData !== 0) {
                // Verify lpcbData pointer
                if (lpcbData + 4 > mem.length) {
                    return { value: 998, stackCleanup: 24 }; // ERROR_NOACCESS
                }
                availableSize = view.getUint32(lpcbData, true);
            }

            // Write type if requested (REG_SZ=1, REG_BINARY=3, REG_DWORD=4)
            if (lpType !== 0) {
                if (lpType + 4 <= mem.length) {
                    const typeCode = value.type === "REG_DWORD" ? 4 : value.type === "REG_BINARY" ? 3 : value.type === "REG_MULTI_SZ" ? 7 : 1;
                    view.setUint32(lpType, typeCode, true);
                }
            }

            // Write required size back to lpcbData
            if (lpcbData !== 0) {
                view.setUint32(lpcbData, requiredSize, true);
            }

            // Check if buffer is sufficient (only if lpData is provided)
            if (lpData !== 0) {
                if (availableSize < requiredSize) {
                    return { value: 234, stackCleanup: 24 }; // ERROR_MORE_DATA
                }

                // Verify target buffer accessibility
                if (lpData + requiredSize > mem.length) {
                    return { value: 998, stackCleanup: 24 }; // ERROR_NOACCESS
                }

                if (value.type === "REG_DWORD") {
                    view.setUint32(lpData, dwordValue, true);
                } else if (bytes) {
                    mem.set(bytes, lpData);
                }
            }

            return { value: 0, stackCleanup: 24 };
        };

        this.exports["RegQueryValueExW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpValueName = args[1];
            const lpType = args[3];
            const lpData = args[4];
            const lpcbData = args[5];
            const keyHandle = resolveRoot(hKey);
            if (!keyHandle) {
                return { value: 6, stackCleanup: 24 };
            }
            const valueName = Marshaler.readWideString(mem, lpValueName);
            const value = system.registry.getValue(keyHandle, valueName);
            if (!value) {
                return { value: 2, stackCleanup: 24 };
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Calculate required size
            let requiredSize = 0;
            let dwordValue = 0;
            let wideString = "";

            let binaryBytes: Uint8Array | null = null;

            if (value.type === "REG_DWORD") {
                requiredSize = 4;
                dwordValue = Number(value.data) >>> 0;
            } else if (value.type === "REG_BINARY" || value.type === "REG_MULTI_SZ") {
                const hexStr = String(value.data);
                requiredSize = hexStr.length / 2;
                binaryBytes = new Uint8Array(requiredSize);
                for (let i = 0; i < requiredSize; i++) {
                    binaryBytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
                }
            } else {
                wideString = String(value.data);
                // Wide string length in bytes: (chars + null) * 2
                requiredSize = (wideString.length + 1) * 2;
            }

            // Read available size
            let availableSize = 0;
            if (lpcbData !== 0) {
                if (lpcbData + 4 > mem.length) {
                    return { value: 998, stackCleanup: 24 };
                }
                availableSize = view.getUint32(lpcbData, true);
            }

            if (lpType !== 0) {
                if (lpType + 4 <= mem.length) {
                    const typeCode = value.type === "REG_DWORD" ? 4 : value.type === "REG_BINARY" ? 3 : value.type === "REG_MULTI_SZ" ? 7 : 1;
                    view.setUint32(lpType, typeCode, true);
                }
            }

            if (lpcbData !== 0) {
                view.setUint32(lpcbData, requiredSize, true);
            }

            if (lpData !== 0) {
                if (availableSize < requiredSize) {
                    return { value: 234, stackCleanup: 24 }; // ERROR_MORE_DATA
                }

                if (lpData + requiredSize > mem.length) {
                    return { value: 998, stackCleanup: 24 };
                }

                if (value.type === "REG_DWORD") {
                    view.setUint32(lpData, dwordValue, true);
                } else if (binaryBytes) {
                    mem.set(binaryBytes, lpData);
                } else {
                    writeWide(mem, lpData, wideString, wideString.length + 1);
                }
            }

            return { value: 0, stackCleanup: 24 };
        };

        this.exports["RegGetValueA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const lpValue = args[2];
            const lpType = args[4];
            const pvData = args[5];
            const pcbData = args[6];

            const rootOrHandle = resolveRoot(hKey);
            if (!rootOrHandle) return { value: 6, stackCleanup: 28 };
            const subKey = lpSubKey ? Marshaler.readString(mem, lpSubKey) : "";
            const targetKey = subKey ? system.registry.open(rootOrHandle, subKey) : rootOrHandle;
            const valueName = lpValue ? Marshaler.readString(mem, lpValue) : "";

            return queryValueCommon(mem, targetKey, valueName, lpType, pvData, pcbData, false, 28);
        };

        this.exports["RegGetValueW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const lpValue = args[2];
            const lpType = args[4];
            const pvData = args[5];
            const pcbData = args[6];

            const rootOrHandle = resolveRoot(hKey);
            if (!rootOrHandle) return { value: 6, stackCleanup: 28 };
            const subKey = lpSubKey ? Marshaler.readWideString(mem, lpSubKey) : "";
            const targetKey = subKey ? system.registry.open(rootOrHandle, subKey) : rootOrHandle;
            const valueName = lpValue ? Marshaler.readWideString(mem, lpValue) : "";

            return queryValueCommon(mem, targetKey, valueName, lpType, pvData, pcbData, true, 28);
        };

        this.exports["RegCloseKey"] = (ctx, mem, args) => {
            const hKey = args[0];
            const handle = process.resourceProvider.getKernelObject(hKey);
            if (handle && handle.kind === "reg") {
                process.resourceProvider.unregisterKernelObject(hKey);
            }
            return { value: 0, stackCleanup: 4 };
        };

        this.exports["RegFlushKey"] = (ctx, mem, args) => {
            const hKey = args[0];
            const handle = process.resourceProvider.getKernelObject(hKey);
            if (handle && handle.kind === "reg") {
                return { value: 0, stackCleanup: 4 };
            }
            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 4 };
            }
            return { value: 0, stackCleanup: 4 };
        };

        // RegSetValueExA - set registry value
        this.exports["RegSetValueExA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpValueName = args[1];
            const Reserved = args[2];
            const dwType = args[3];
            const lpData = args[4];
            const cbData = args[5];

            const keyHandle = resolveRoot(hKey);
            if (!keyHandle) {
                Logger.warn(LogCategory.SYSTEM, `RegSetValueExA: invalid hKey=0x${hKey.toString(16)}`);
                return { value: 6, stackCleanup: 24 }; // ERROR_INVALID_HANDLE
            }

            const valueName = lpValueName ? Marshaler.readString(mem, lpValueName) : "";
            // NOTE: actual value logged below after parsing (verbose → log promoted for visibility)

            let valueData: string | number;
            let valueType: "REG_SZ" | "REG_DWORD" | "REG_BINARY" | "REG_MULTI_SZ";
            if (dwType === 4) { // REG_DWORD
                valueType = "REG_DWORD";
                if (lpData && cbData >= 4) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    valueData = view.getUint32(lpData, true);
                } else {
                    valueData = 0;
                }
            } else if (dwType === 3) { // REG_BINARY
                valueType = "REG_BINARY";
                if (lpData && cbData > 0) {
                    // Store as hex string
                    let hex = "";
                    for (let i = 0; i < cbData; i++) {
                        hex += mem[lpData + i].toString(16).padStart(2, "0");
                    }
                    valueData = hex;
                } else {
                    valueData = "";
                }
            } else if (dwType === 7) { // REG_MULTI_SZ — store raw bytes as hex to preserve null separators
                valueType = "REG_MULTI_SZ";
                if (lpData && cbData > 0) {
                    let hex = "";
                    for (let i = 0; i < cbData; i++) {
                        hex += mem[lpData + i].toString(16).padStart(2, "0");
                    }
                    valueData = hex;
                } else {
                    valueData = "";
                }
            } else { // REG_SZ (1), REG_EXPAND_SZ (2), or other string types
                valueType = "REG_SZ";
                if (lpData && cbData > 0) {
                    valueData = Marshaler.readString(mem, lpData);
                } else {
                    valueData = "";
                }
            }

            const registryValue: RegistryValue = {
                name: valueName,
                type: valueType,
                data: valueData
            };

            system.registry.setValue(keyHandle, valueName, registryValue);
            Logger.log(LogCategory.SYSTEM, `RegSetValueExA(key="${keyHandle}", name="${valueName}", type=${valueType}, value=${valueData})`);

            return { value: 0, stackCleanup: 24 }; // ERROR_SUCCESS
        };

        this.exports["RegSetValueExW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpValueName = args[1];
            const Reserved = args[2];
            const dwType = args[3];
            const lpData = args[4];
            const cbData = args[5];

            Logger.log(LogCategory.SYSTEM, `RegSetValueExW called: hKey=0x${hKey.toString(16)}, lpValueName=0x${lpValueName.toString(16)}, dwType=${dwType}, cbData=${cbData}`);

            const keyHandle = resolveRoot(hKey);
            if (!keyHandle) {
                return { value: 6, stackCleanup: 24 }; // ERROR_INVALID_HANDLE
            }

            const valueName = lpValueName ? Marshaler.readWideString(mem, lpValueName) : "";
            Logger.verbose(LogCategory.SYSTEM, `RegSetValueExW: keyHandle=${keyHandle}, valueName="${valueName}"`);

            let valueData: string | number;
            let valueType: "REG_SZ" | "REG_DWORD" | "REG_BINARY" | "REG_MULTI_SZ";
            if (dwType === 4) { // REG_DWORD
                valueType = "REG_DWORD";
                if (lpData && cbData >= 4) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    valueData = view.getUint32(lpData, true);
                } else {
                    valueData = 0;
                }
            } else if (dwType === 3) { // REG_BINARY
                valueType = "REG_BINARY";
                if (lpData && cbData > 0) {
                    let hex = "";
                    for (let i = 0; i < cbData; i++) {
                        hex += mem[lpData + i].toString(16).padStart(2, "0");
                    }
                    valueData = hex;
                } else {
                    valueData = "";
                }
            } else if (dwType === 7) { // REG_MULTI_SZ — store raw bytes as hex to preserve null separators
                valueType = "REG_MULTI_SZ";
                if (lpData && cbData > 0) {
                    let hex = "";
                    for (let i = 0; i < cbData; i++) {
                        hex += mem[lpData + i].toString(16).padStart(2, "0");
                    }
                    valueData = hex;
                } else {
                    valueData = "";
                }
            } else { // REG_SZ or other string types
                valueType = "REG_SZ";
                if (lpData && cbData > 0) {
                    valueData = Marshaler.readWideString(mem, lpData);
                } else {
                    valueData = "";
                }
            }

            const registryValue: RegistryValue = {
                name: valueName,
                type: valueType,
                data: valueData
            };

            system.registry.setValue(keyHandle, valueName, registryValue);
            Logger.verbose(LogCategory.SYSTEM, `RegSetValueExW: Set value "${valueName}" = ${valueData}`);

            return { value: 0, stackCleanup: 24 }; // ERROR_SUCCESS
        };

        const regSetValueCommon = (
            mem: Uint8Array,
            hKey: number,
            lpSubKey: number,
            dwType: number,
            lpData: number,
            cbData: number,
            wide: boolean,
            stackCleanup: number
        ) => {
            const root = resolveRoot(hKey);
            if (!root) {
                Logger.warn(LogCategory.SYSTEM, `RegSetValue${wide ? "W" : "A"}: invalid hKey=0x${hKey.toString(16)}`);
                return { value: ERROR_INVALID_HANDLE, stackCleanup };
            }

            const type = dwType >>> 0;
            const dataSize = cbData >>> 0;
            if (type !== 1) {
                return { value: ERROR_INVALID_PARAMETER, stackCleanup };
            }

            const subKey = lpSubKey
                ? (wide ? Marshaler.readWideString(mem, lpSubKey) : Marshaler.readString(mem, lpSubKey))
                : "";
            const targetKey = subKey ? system.registry.createKey(root, subKey).key : root;
            const valueData = lpData && dataSize > 0
                ? (wide ? Marshaler.readWideString(mem, lpData) : Marshaler.readString(mem, lpData))
                : "";

            const registryValue: RegistryValue = {
                name: "",
                type: "REG_SZ",
                data: valueData,
            };

            system.registry.setValue(targetKey, "", registryValue);
            Logger.log(
                LogCategory.SYSTEM,
                `RegSetValue${wide ? "W" : "A"}(key="${targetKey}", default="${valueData}")`
            );
            return { value: 0, stackCleanup };
        };

        this.exports["RegSetValueA"] = (ctx, mem, args) =>
            regSetValueCommon(mem, args[0], args[1], args[2], args[3], args[4], false, 20);

        this.exports["RegSetValueW"] = (ctx, mem, args) =>
            regSetValueCommon(mem, args[0], args[1], args[2], args[3], args[4], true, 20);

        // RegCreateKeyA - create/open registry key (simplified, no options)
        this.exports["RegCreateKeyA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const phkResult = args[2];
            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 12 };
            const subKey = lpSubKey ? Marshaler.readString(mem, lpSubKey) : "";
            const { key: fullKey } = system.registry.createKey(root, subKey);
            const handle = process.resourceProvider.registerKernelObject({ kind: "reg", key: fullKey });
            if (phkResult && phkResult + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(phkResult, handle >>> 0, true);
            }
            return { value: 0, stackCleanup: 12 };
        };

        this.exports["RegCreateKeyW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const phkResult = args[2];
            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 12 };
            const subKey = lpSubKey ? Marshaler.readWideString(mem, lpSubKey) : "";
            const { key: fullKey } = system.registry.createKey(root, subKey);
            const handle = process.resourceProvider.registerKernelObject({ kind: "reg", key: fullKey });
            if (phkResult && phkResult + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(phkResult, handle >>> 0, true);
            }
            return { value: 0, stackCleanup: 12 };
        };

        // RegCreateKeyExA - create registry key
        this.exports["RegCreateKeyExA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const Reserved = args[2];
            const lpClass = args[3];
            const dwOptions = args[4];
            const samDesired = args[5];
            const lpSecurityAttributes = args[6];
            const phkResult = args[7];
            const lpdwDisposition = args[8];

            Logger.log(LogCategory.SYSTEM, `RegCreateKeyExA called: hKey=0x${hKey.toString(16)}, lpSubKey=0x${lpSubKey.toString(16)}, phkResult=0x${phkResult.toString(16)}`);

            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 36 }; // ERROR_INVALID_HANDLE
            }

            const subKey = lpSubKey ? Marshaler.readString(mem, lpSubKey) : "";
            Logger.verbose(LogCategory.SYSTEM, `RegCreateKeyExA: root=${root}, subKey="${subKey}"`);

            const { key: fullKey, isNew } = system.registry.createKey(root, subKey);
            const handle = process.resourceProvider.registerKernelObject({ kind: "reg", key: fullKey });

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (phkResult) {
                if (phkResult + 4 > mem.length) {
                    Logger.error(LogCategory.SYSTEM, `RegCreateKeyExA: phkResult address 0x${phkResult.toString(16)} is out of bounds!`);
                    return { value: 6, stackCleanup: 36 };
                }
                if (!isValidAddress(mem, phkResult, 4, "rw")) {
                    return { value: 87, stackCleanup: 36 }; // ERROR_INVALID_PARAMETER (e.g. thunk/rx region)
                }
                view.setUint32(phkResult, handle >>> 0, true);
            }
            if (lpdwDisposition) {
                if (lpdwDisposition + 4 > mem.length) {
                    Logger.error(LogCategory.SYSTEM, `RegCreateKeyExA: lpdwDisposition address 0x${lpdwDisposition.toString(16)} is out of bounds!`);
                    return { value: 6, stackCleanup: 36 };
                }
                if (!isValidAddress(mem, lpdwDisposition, 4, "rw")) {
                    return { value: 87, stackCleanup: 36 }; // ERROR_INVALID_PARAMETER
                }
                // REG_CREATED_NEW_KEY = 1, REG_OPENED_EXISTING_KEY = 2
                view.setUint32(lpdwDisposition, isNew ? 1 : 2, true);
            }

            Logger.verbose(LogCategory.SYSTEM, `RegCreateKeyExA: ${isNew ? "Created" : "Opened"} key "${fullKey}", handle=0x${handle.toString(16)}`);

            return { value: 0, stackCleanup: 36 }; // ERROR_SUCCESS
        };

        this.exports["RegCreateKeyExW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const phkResult = args[7];
            const lpdwDisposition = args[8];

            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 36 };

            const subKey = lpSubKey ? Marshaler.readWideString(mem, lpSubKey) : "";
            const { key: fullKey, isNew } = system.registry.createKey(root, subKey);
            const handle = process.resourceProvider.registerKernelObject({ kind: "reg", key: fullKey });
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            if (phkResult) {
                if (phkResult + 4 > mem.length || !isValidAddress(mem, phkResult, 4, "rw")) {
                    return { value: 87, stackCleanup: 36 };
                }
                view.setUint32(phkResult, handle >>> 0, true);
            }
            if (lpdwDisposition) {
                if (lpdwDisposition + 4 > mem.length || !isValidAddress(mem, lpdwDisposition, 4, "rw")) {
                    return { value: 87, stackCleanup: 36 };
                }
                view.setUint32(lpdwDisposition, isNew ? 1 : 2, true);
            }
            return { value: 0, stackCleanup: 36 };
        };

        this.exports["RegCreateKeyTransactedA"] = (ctx, mem, args) => {
            return this.exports["RegCreateKeyExA"]!(ctx, mem, [
                args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8]
            ]);
        };

        this.exports["RegCreateKeyTransactedW"] = (ctx, mem, args) => {
            return this.exports["RegCreateKeyExW"]!(ctx, mem, [
                args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8]
            ]);
        };

        this.exports["RegDeleteKeyA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 8 }; // ERROR_INVALID_HANDLE
            }

            const subKey = lpSubKey ? Marshaler.readString(mem, lpSubKey) : "";
            if (!subKey) {
                return { value: 87, stackCleanup: 8 }; // ERROR_INVALID_PARAMETER
            }

            const deleted = system.registry.deleteKey(root, subKey);
            return { value: deleted ? 0 : 2, stackCleanup: 8 };
        };

        this.exports["RegDeleteValueA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpValueName = args[1];
            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 8 };
            }

            const valueName = lpValueName ? Marshaler.readString(mem, lpValueName) : "";
            const deleted = system.registry.deleteValue(root, valueName);
            return { value: deleted ? 0 : 2, stackCleanup: 8 };
        };

        this.exports["RegDeleteKeyW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 8 };
            }

            const subKey = lpSubKey ? Marshaler.readWideString(mem, lpSubKey) : "";
            if (!subKey) {
                return { value: 87, stackCleanup: 8 }; // ERROR_INVALID_PARAMETER
            }

            const deleted = system.registry.deleteKey(root, subKey);
            return { value: deleted ? 0 : 2, stackCleanup: 8 };
        };

        this.exports["RegDeleteValueW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpValueName = args[1];
            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 8 };
            }

            const valueName = lpValueName ? Marshaler.readWideString(mem, lpValueName) : "";
            const deleted = system.registry.deleteValue(root, valueName);
            return { value: deleted ? 0 : 2, stackCleanup: 8 };
        };

        // RegQueryInfoKeyA - query metadata about a registry key
        // LSTATUS RegQueryInfoKeyA(hKey, lpClass, lpcchClass, lpReserved,
        //   lpcSubKeys, lpcbMaxSubKeyLen, lpcbMaxClassLen,
        //   lpcValues, lpcbMaxValueNameLen, lpcbMaxValueLen,
        //   lpcbSecurityDescriptor, lpftLastWriteTime)
        this.exports["RegQueryInfoKeyA"] = (ctx, mem, args) => {
            const hKey              = args[0];
            const lpClass           = args[1] >>> 0;
            const lpcchClass        = args[2] >>> 0;
            const /* reserved */    _ = args[3];
            const lpcSubKeys        = args[4] >>> 0;
            const lpcbMaxSubKeyLen  = args[5] >>> 0;
            const lpcbMaxClassLen   = args[6] >>> 0;
            const lpcValues         = args[7] >>> 0;
            const lpcbMaxValueNameLen = args[8] >>> 0;
            const lpcbMaxValueLen   = args[9] >>> 0;
            const lpcbSecDesc       = args[10] >>> 0;
            const lpftLastWriteTime = args[11] >>> 0;

            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 48 }; // ERROR_INVALID_HANDLE

            const subKeys = system.registry.enumSubKeys(root);
            const subKeyCount = subKeys.length;
            const maxSubKeyLen = subKeys.reduce((m, k) => Math.max(m, k.length), 0);
            const keyInfo = system.registry.getKeyInfo(root);

            const writeOptU32 = (ptr: number, val: number) => {
                if (ptr && ptr + 4 <= mem.length) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(ptr, val, true);
                }
            };

            // Class string — empty
            if (lpClass && lpcchClass) {
                writeOptU32(lpcchClass, 0);
                if (lpClass < mem.length) mem[lpClass] = 0;
            } else if (lpcchClass) {
                writeOptU32(lpcchClass, 0);
            }

            writeOptU32(lpcSubKeys, subKeyCount);
            writeOptU32(lpcbMaxSubKeyLen, maxSubKeyLen);
            writeOptU32(lpcbMaxClassLen, 0);
            writeOptU32(lpcValues, keyInfo.valueCount);
            writeOptU32(lpcbMaxValueNameLen, keyInfo.maxValueNameLen);
            writeOptU32(lpcbMaxValueLen, keyInfo.maxValueDataLen);
            writeOptU32(lpcbSecDesc, 0);
            if (lpftLastWriteTime && lpftLastWriteTime + 8 <= mem.length) {
                writeOptU32(lpftLastWriteTime, 0);
                writeOptU32(lpftLastWriteTime + 4, 0);
            }

            Logger.verbose(LogCategory.SYSTEM, `RegQueryInfoKeyA(hKey=0x${hKey.toString(16)}) subKeys=${subKeyCount} values=${keyInfo.valueCount}`);
            return { value: 0, stackCleanup: 48 }; // ERROR_SUCCESS
        };

        // RegQueryInfoKeyW — Wide version, same logic but wide class string
        this.exports["RegQueryInfoKeyW"] = (ctx, mem, args) => {
            const hKey              = args[0];
            const lpClass           = args[1] >>> 0;
            const lpcchClass        = args[2] >>> 0;
            const lpcSubKeys        = args[4] >>> 0;
            const lpcbMaxSubKeyLen  = args[5] >>> 0;
            const lpcbMaxClassLen   = args[6] >>> 0;
            const lpcValues         = args[7] >>> 0;
            const lpcbMaxValueNameLen = args[8] >>> 0;
            const lpcbMaxValueLen   = args[9] >>> 0;
            const lpcbSecDesc       = args[10] >>> 0;
            const lpftLastWriteTime = args[11] >>> 0;

            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 48 };

            const subKeys = system.registry.enumSubKeys(root);
            const keyInfo = system.registry.getKeyInfo(root);

            const writeOptU32 = (ptr: number, val: number) => {
                if (ptr && ptr + 4 <= mem.length) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(ptr, val, true);
                }
            };

            if (lpClass && lpcchClass) {
                writeOptU32(lpcchClass, 0);
                if (lpClass + 1 < mem.length) { mem[lpClass] = 0; mem[lpClass + 1] = 0; }
            } else if (lpcchClass) {
                writeOptU32(lpcchClass, 0);
            }

            writeOptU32(lpcSubKeys, subKeys.length);
            writeOptU32(lpcbMaxSubKeyLen, subKeys.reduce((m, k) => Math.max(m, k.length), 0));
            writeOptU32(lpcbMaxClassLen, 0);
            writeOptU32(lpcValues, keyInfo.valueCount);
            writeOptU32(lpcbMaxValueNameLen, keyInfo.maxValueNameLen);
            writeOptU32(lpcbMaxValueLen, keyInfo.maxValueDataLen);
            writeOptU32(lpcbSecDesc, 0);
            if (lpftLastWriteTime && lpftLastWriteTime + 8 <= mem.length) {
                writeOptU32(lpftLastWriteTime, 0);
                writeOptU32(lpftLastWriteTime + 4, 0);
            }

            return { value: 0, stackCleanup: 48 };
        };

        this.exports["RegEnumKeyExA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const dwIndex = args[1];
            const lpName = args[2];
            const lpcName = args[3];
            const lpReserved = args[4];
            const lpClass = args[5];
            const lpcClass = args[6];
            const lpftLastWriteTime = args[7];

            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 32 };
            }

            if (!lpcName || lpcName + 4 > mem.length || !isValidAddress(mem, lpcName, 4, "rw")) {
                return { value: 87, stackCleanup: 32 };
            }

            const subKeys = system.registry.enumSubKeys(root);
            if (dwIndex >= subKeys.length) {
                return { value: 259, stackCleanup: 32 }; // ERROR_NO_MORE_ITEMS
            }

            const name = subKeys[dwIndex] ?? "";
            const requiredChars = name.length;
            const bufChars = Mem.readUint32(lpcName);
            if (bufChars === null) {
                return { value: 998, stackCleanup: 32 }; // ERROR_NOACCESS
            }
            Mem.writeUint32(lpcName, requiredChars);

            if (!lpName || lpName + Math.max(bufChars, 1) > mem.length || !isValidAddress(mem, lpName, Math.max(bufChars, 1), "rw")) {
                return { value: 87, stackCleanup: 32 };
            }

            if (bufChars <= requiredChars) {
                return { value: 234, stackCleanup: 32 }; // ERROR_MORE_DATA
            }

            writeAnsi(mem, lpName, name, bufChars);

            if (lpClass && lpcClass && isValidAddress(mem, lpcClass, 4, "rw")) {
                Mem.writeUint32(lpcClass, 0);
                if (isValidAddress(mem, lpClass, 1, "rw")) {
                    mem[lpClass] = 0;
                }
            }

            if (lpftLastWriteTime && isValidAddress(mem, lpftLastWriteTime, 8, "rw")) {
                Mem.writeUint32(lpftLastWriteTime, 0);
                Mem.writeUint32(lpftLastWriteTime + 4, 0);
            }

            return { value: 0, stackCleanup: 32 };
        };

        // LONG RegEnumKeyExW(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPWSTR, LPDWORD, PFILETIME)
        this.exports["RegEnumKeyExW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const dwIndex = args[1];
            const lpName = args[2];
            const lpcName = args[3];
            const lpClass = args[5];
            const lpcClass = args[6];
            const lpftLastWriteTime = args[7];

            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 32 };

            if (!lpcName || !isValidAddress(mem, lpcName, 4, "rw"))
                return { value: 87, stackCleanup: 32 };

            const subKeys = system.registry.enumSubKeys(root);
            if (dwIndex >= subKeys.length)
                return { value: 259, stackCleanup: 32 }; // ERROR_NO_MORE_ITEMS

            const name = subKeys[dwIndex] ?? "";
            const bufChars = Mem.readUint32(lpcName) ?? 0;
            Mem.writeUint32(lpcName, name.length);

            if (!lpName || !isValidAddress(mem, lpName, Math.max(bufChars, 1) * 2, "rw"))
                return { value: 87, stackCleanup: 32 };

            if (bufChars <= name.length)
                return { value: 234, stackCleanup: 32 }; // ERROR_MORE_DATA

            writeWide(mem, lpName, name, bufChars);

            if (lpClass && lpcClass && isValidAddress(mem, lpcClass, 4, "rw")) {
                Mem.writeUint32(lpcClass, 0);
                if (isValidAddress(mem, lpClass, 2, "rw")) {
                    mem[lpClass] = 0; mem[lpClass + 1] = 0;
                }
            }

            if (lpftLastWriteTime && isValidAddress(mem, lpftLastWriteTime, 8, "rw")) {
                Mem.writeUint32(lpftLastWriteTime, 0);
                Mem.writeUint32(lpftLastWriteTime + 4, 0);
            }

            return { value: 0, stackCleanup: 32 };
        };

        // LONG RegEnumKeyA(HKEY hKey, DWORD dwIndex, LPSTR lpName, DWORD cchName)
        // Simplified version of RegEnumKeyExA — no class/timestamp outputs
        this.exports["RegEnumKeyA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const dwIndex = args[1];
            const lpName = args[2];
            const cchName = args[3];

            const root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 16 }; // ERROR_INVALID_HANDLE
            }

            const subKeys = system.registry.enumSubKeys(root);
            if (dwIndex >= subKeys.length) {
                return { value: 259, stackCleanup: 16 }; // ERROR_NO_MORE_ITEMS
            }

            const name = subKeys[dwIndex] ?? "";
            if (cchName <= name.length) {
                return { value: 234, stackCleanup: 16 }; // ERROR_MORE_DATA
            }

            if (lpName && isValidAddress(mem, lpName, cchName, "rw")) {
                writeAnsi(mem, lpName, name, cchName);
            }

            return { value: 0, stackCleanup: 16 }; // ERROR_SUCCESS
        };

        // LONG RegQueryValueA(HKEY hKey, LPCSTR lpSubKey, LPSTR lpValue, PLONG lpcbValue)
        // Opens subkey (if provided), reads default (unnamed) value
        this.exports["RegQueryValueA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const lpSubKey = args[1];
            const lpValue = args[2];
            const lpcbValue = args[3];

            let root = resolveRoot(hKey);
            if (!root) {
                return { value: 6, stackCleanup: 16 }; // ERROR_INVALID_HANDLE
            }

            // If subkey specified, append it to the path
            if (lpSubKey) {
                const subKey = Marshaler.readString(mem, lpSubKey);
                if (subKey) {
                    root = root + "\\" + subKey;
                }
            }

            // Query the default (empty-name) value
            const value = system.registry.getValue(root, "");
            if (!value) {
                Logger.log(LogCategory.SYSTEM, `RegQueryValueA("${root}") -> NOT FOUND`);
                return { value: 2, stackCleanup: 16 }; // ERROR_FILE_NOT_FOUND
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const str = String(value.data);
            const requiredSize = str.length + 1; // null terminator

            if (lpcbValue && isValidAddress(mem, lpcbValue, 4, "rw")) {
                const bufSize = view.getInt32(lpcbValue, true);
                view.setInt32(lpcbValue, requiredSize, true);

                if (lpValue && bufSize >= requiredSize) {
                    writeAnsi(mem, lpValue, str, bufSize);
                } else if (lpValue) {
                    return { value: 234, stackCleanup: 16 }; // ERROR_MORE_DATA
                }
            }

            return { value: 0, stackCleanup: 16 }; // ERROR_SUCCESS
        };

        this.exports["RegEnumValueA"] = (ctx, mem, args) => {
            const hKey = args[0];
            const dwIndex = args[1];
            const lpValueName = args[2];
            const lpcchValueName = args[3];
            const lpReserved = args[4];
            const lpType = args[5];
            const lpData = args[6];
            const lpcbData = args[7];

            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 32 };

            const values = system.registry.enumValues(root);
            if (dwIndex >= values.length) {
                return { value: 259, stackCleanup: 32 }; // ERROR_NO_MORE_ITEMS
            }

            const entry = values[dwIndex];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Write value name
            if (lpcchValueName && lpcchValueName + 4 <= mem.length) {
                const bufChars = view.getUint32(lpcchValueName, true);
                const nameLen = entry.name.length;
                view.setUint32(lpcchValueName, nameLen, true);
                if (lpValueName && bufChars > nameLen) {
                    writeAnsi(mem, lpValueName, entry.name, bufChars);
                } else if (lpValueName) {
                    return { value: 234, stackCleanup: 32 }; // ERROR_MORE_DATA
                }
            }

            // Write type
            if (lpType && lpType + 4 <= mem.length) {
                const typeCode = entry.type === "REG_DWORD" ? 4 : entry.type === "REG_BINARY" ? 3 : entry.type === "REG_MULTI_SZ" ? 7 : 1;
                view.setUint32(lpType, typeCode, true);
            }

            // Write data
            let dataBytes: Uint8Array;
            if (entry.type === "REG_DWORD") {
                dataBytes = new Uint8Array(4);
                new DataView(dataBytes.buffer).setUint32(0, Number(entry.data) >>> 0, true);
            } else if (entry.type === "REG_BINARY" || entry.type === "REG_MULTI_SZ") {
                const hexStr = String(entry.data);
                dataBytes = new Uint8Array(hexStr.length / 2);
                for (let i = 0; i < dataBytes.length; i++) {
                    dataBytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
                }
            } else {
                dataBytes = encodeAnsi(String(entry.data) + "\0");
            }

            if (lpcbData && lpcbData + 4 <= mem.length) {
                const bufSize = view.getUint32(lpcbData, true);
                view.setUint32(lpcbData, dataBytes.length, true);
                if (lpData) {
                    if (bufSize < dataBytes.length) {
                        return { value: 234, stackCleanup: 32 }; // ERROR_MORE_DATA
                    }
                    mem.set(dataBytes, lpData);
                }
            }

            return { value: 0, stackCleanup: 32 };
        };

        this.exports["RegEnumValueW"] = (ctx, mem, args) => {
            const hKey = args[0];
            const dwIndex = args[1];
            const lpValueName = args[2];
            const lpcchValueName = args[3];
            const lpReserved = args[4];
            const lpType = args[5];
            const lpData = args[6];
            const lpcbData = args[7];

            const root = resolveRoot(hKey);
            if (!root) return { value: 6, stackCleanup: 32 };

            const values = system.registry.enumValues(root);
            if (dwIndex >= values.length) {
                return { value: 259, stackCleanup: 32 }; // ERROR_NO_MORE_ITEMS
            }

            const entry = values[dwIndex];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Write value name (wide)
            if (lpcchValueName && lpcchValueName + 4 <= mem.length) {
                const bufChars = view.getUint32(lpcchValueName, true);
                const nameLen = entry.name.length;
                view.setUint32(lpcchValueName, nameLen, true);
                if (lpValueName && bufChars > nameLen) {
                    writeWide(mem, lpValueName, entry.name, bufChars);
                } else if (lpValueName) {
                    return { value: 234, stackCleanup: 32 }; // ERROR_MORE_DATA
                }
            }

            // Write type
            if (lpType && lpType + 4 <= mem.length) {
                const typeCode = entry.type === "REG_DWORD" ? 4 : entry.type === "REG_BINARY" ? 3 : entry.type === "REG_MULTI_SZ" ? 7 : 1;
                view.setUint32(lpType, typeCode, true);
            }

            // Write data
            let dataBytes: Uint8Array;
            if (entry.type === "REG_DWORD") {
                dataBytes = new Uint8Array(4);
                new DataView(dataBytes.buffer).setUint32(0, Number(entry.data) >>> 0, true);
            } else if (entry.type === "REG_BINARY" || entry.type === "REG_MULTI_SZ") {
                const hexStr = String(entry.data);
                dataBytes = new Uint8Array(hexStr.length / 2);
                for (let i = 0; i < dataBytes.length; i++) {
                    dataBytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
                }
            } else {
                // REG_SZ — wide string bytes
                const str = String(entry.data);
                dataBytes = new Uint8Array((str.length + 1) * 2);
                const dv = new DataView(dataBytes.buffer);
                for (let i = 0; i < str.length; i++) {
                    dv.setUint16(i * 2, str.charCodeAt(i), true);
                }
                dv.setUint16(str.length * 2, 0, true);
            }

            if (lpcbData && lpcbData + 4 <= mem.length) {
                const bufSize = view.getUint32(lpcbData, true);
                view.setUint32(lpcbData, dataBytes.length, true);
                if (lpData) {
                    if (bufSize < dataBytes.length) {
                        return { value: 234, stackCleanup: 32 }; // ERROR_MORE_DATA
                    }
                    mem.set(dataBytes, lpData);
                }
            }

            return { value: 0, stackCleanup: 32 };
        };

        this.exports["OpenSCManagerA"] = (ctx, mem, args) => {
            const lpMachineName = args[0] >>> 0;
            const lpDatabaseName = args[1] >>> 0;
            const dwDesiredAccess = args[2] >>> 0;

            const machine = lpMachineName ? Marshaler.readString(mem, lpMachineName) : "";
            const database = lpDatabaseName ? Marshaler.readString(mem, lpDatabaseName) : "ServicesActive";

            const handle = process.resourceProvider.registerKernelObject({
                kind: "scm",
                machine,
                database,
                desiredAccess: dwDesiredAccess,
            });

            return { value: handle >>> 0, stackCleanup: 12 };
        };

        this.exports["CreateServiceA"] = (ctx, mem, args) => {
            const hSCManager = args[0] >>> 0;
            const lpServiceName = args[1] >>> 0;
            const lpDisplayName = args[2] >>> 0;
            const dwDesiredAccess = args[3] >>> 0;
            const dwServiceType = args[4] >>> 0;
            const dwStartType = args[5] >>> 0;
            const dwErrorControl = args[6] >>> 0;
            const lpBinaryPathName = args[7] >>> 0;
            const lpLoadOrderGroup = args[8] >>> 0;
            const lpdwTagId = args[9] >>> 0;
            const lpDependencies = args[10] >>> 0;
            const lpServiceStartName = args[11] >>> 0;
            const lpPassword = args[12] >>> 0;

            const scm = process.resourceProvider.getKernelObject(hSCManager);
            if (!scm || scm.kind !== "scm") {
                system.scheduler.setLastError(6); // ERROR_INVALID_HANDLE
                return { value: 0, stackCleanup: 52 };
            }

            const name = lpServiceName ? Marshaler.readString(mem, lpServiceName) : "";
            const displayName = lpDisplayName ? Marshaler.readString(mem, lpDisplayName) : name;
            const binaryPath = lpBinaryPathName ? Marshaler.readString(mem, lpBinaryPathName) : "";
            const loadOrderGroup = lpLoadOrderGroup ? Marshaler.readString(mem, lpLoadOrderGroup) : "";
            const dependencies = lpDependencies ? Marshaler.readString(mem, lpDependencies) : "";
            const startName = lpServiceStartName ? Marshaler.readString(mem, lpServiceStartName) : "";
            const password = lpPassword ? Marshaler.readString(mem, lpPassword) : "";

            if (!name) {
                system.scheduler.setLastError(87); // ERROR_INVALID_PARAMETER
                return { value: 0, stackCleanup: 52 };
            }

            const handle = process.resourceProvider.registerKernelObject({
                kind: "service",
                name,
                displayName,
                binaryPath,
                desiredAccess: dwDesiredAccess,
                serviceType: dwServiceType,
                startType: dwStartType,
                errorControl: dwErrorControl,
                loadOrderGroup,
                dependencies,
                startName,
                password,
            });

            if (lpdwTagId && lpdwTagId + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(lpdwTagId, 0, true);
            }

            system.scheduler.setLastError(0);
            return { value: handle >>> 0, stackCleanup: 52 };
        };

        this.exports["OpenServiceA"] = (ctx, mem, args) => {
            const hSCManager = args[0] >>> 0;
            const lpServiceName = args[1] >>> 0;
            const dwDesiredAccess = args[2] >>> 0;

            const scm = process.resourceProvider.getKernelObject(hSCManager);
            if (!scm || scm.kind !== "scm") {
                system.scheduler.setLastError(6); // ERROR_INVALID_HANDLE
                return { value: 0, stackCleanup: 12 };
            }

            const name = lpServiceName ? Marshaler.readString(mem, lpServiceName) : "";
            if (!name) {
                system.scheduler.setLastError(87); // ERROR_INVALID_PARAMETER
                return { value: 0, stackCleanup: 12 };
            }

            // Minimal emulation: create a service handle on demand.
            const handle = process.resourceProvider.registerKernelObject({
                kind: "service",
                name,
                desiredAccess: dwDesiredAccess,
            });

            system.scheduler.setLastError(0);
            return { value: handle >>> 0, stackCleanup: 12 };
        };

        this.exports["CloseServiceHandle"] = (ctx, mem, args) => {
            const hSCObject = args[0] >>> 0;
            const obj = process.resourceProvider.getKernelObject(hSCObject);
            if (!obj || (obj.kind !== "scm" && obj.kind !== "service" && obj.kind !== "service_status")) {
                system.scheduler.setLastError(6); // ERROR_INVALID_HANDLE
                return { value: 0, stackCleanup: 4 };
            }

            process.resourceProvider.unregisterKernelObject(hSCObject);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 4 };
        };

        // Service control/query. Nothing here can run a kernel driver, so every verb that
        // would need one FAILS — a declared-but-unimplemented export returns
        // ERROR_NOT_SUPPORTED (50) in EAX, which a BOOL-returning caller reads as TRUE
        // over an untouched SERVICE_STATUS.
        const serviceObject = (handle: number): any | null => {
            const obj = process.resourceProvider.getKernelObject(handle >>> 0);
            return obj && obj.kind === "service" ? obj : null;
        };
        /** SERVICE_STATUS (28 bytes): stopped, and stopped is the truth. */
        const writeStoppedStatus = (mem: Uint8Array, ptr: number, svc: any): boolean => {
            if (!ptr || !isValidAddress(mem, ptr, SERVICE_STATUS_SIZE, "rw")) return false;
            const buf = new Uint8Array(SERVICE_STATUS_SIZE);
            new DataView(buf.buffer).setUint32(0, svc.serviceType ?? SERVICE_KERNEL_DRIVER, true);
            new DataView(buf.buffer).setUint32(4, SERVICE_STOPPED, true);
            return Mem.writeBytes(ptr, buf) > 0;
        };

        this.exports["StartServiceA"] = (ctx, mem, args) => {
            const svc = serviceObject(args[0]);
            if (!svc) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 12 };
            }
            Logger.log(LogCategory.SYSTEM, `StartServiceA("${svc.name}") -> ERROR_SERVICE_DISABLED (no kernel-mode services)`);
            system.scheduler.setLastError(ERROR_SERVICE_DISABLED);
            return { value: 0, stackCleanup: 12 };
        };

        this.exports["ControlService"] = (ctx, mem, args) => {
            const svc = serviceObject(args[0]);
            if (!svc) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 12 };
            }
            writeStoppedStatus(mem, args[2] >>> 0, svc);
            system.scheduler.setLastError(ERROR_SERVICE_NOT_ACTIVE);
            return { value: 0, stackCleanup: 12 };
        };

        this.exports["QueryServiceStatus"] = (ctx, mem, args) => {
            const svc = serviceObject(args[0]);
            if (!svc) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 8 };
            }
            if (!writeStoppedStatus(mem, args[1] >>> 0, svc)) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 8 };
            }
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 8 };
        };

        this.exports["DeleteService"] = (ctx, mem, args) => {
            const svc = serviceObject(args[0]);
            if (!svc) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 4 };
            }
            svc.deleted = true;
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 4 };
        };

        // QUERY_SERVICE_CONFIGA: a 36-byte header whose five string pointers must point
        // INTO the caller's own buffer, so the whole thing is sized first and the caller
        // gets ERROR_INSUFFICIENT_BUFFER plus the byte count when its buffer is short.
        this.exports["QueryServiceConfigA"] = (ctx, mem, args) => {
            const lpServiceConfig = args[1] >>> 0;
            const cbBufSize = args[2] >>> 0;
            const pcbBytesNeeded = args[3] >>> 0;
            const svc = serviceObject(args[0]);
            if (!svc) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 16 };
            }
            const header = 36;
            const placed: { off: number; bytes: Uint8Array }[] = [];
            let cursor = header;
            const place = (s: string, trailingNuls = 1): number => {
                const bytes = encodeAnsi(s ?? "");
                const off = cursor;
                placed.push({ off, bytes });
                cursor += bytes.length + trailingNuls;
                return off;
            };
            const binOff = place(svc.binaryPath ?? "");
            const grpOff = place(svc.loadOrderGroup ?? "");
            const depOff = place(svc.dependencies ?? "", 2);   // REG_MULTI_SZ: double-NUL
            const usrOff = place(svc.startName ?? "");
            const dspOff = place(svc.displayName ?? svc.name ?? "");
            const needed = cursor;
            if (pcbBytesNeeded) Mem.writeUint32(pcbBytesNeeded, needed);
            if (!lpServiceConfig || cbBufSize < needed
                || !isValidAddress(mem, lpServiceConfig, needed, "rw")) {
                system.scheduler.setLastError(cbBufSize < needed ? ERROR_INSUFFICIENT_BUFFER : ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 16 };
            }
            const buf = new Uint8Array(needed);
            const view = new DataView(buf.buffer);
            view.setUint32(0, svc.serviceType ?? SERVICE_KERNEL_DRIVER, true);
            view.setUint32(4, svc.startType ?? 3, true);       // SERVICE_DEMAND_START
            view.setUint32(8, svc.errorControl ?? 0, true);
            view.setUint32(12, (lpServiceConfig + binOff) >>> 0, true);
            view.setUint32(16, (lpServiceConfig + grpOff) >>> 0, true);
            view.setUint32(20, 0, true);                        // dwTagId
            view.setUint32(24, (lpServiceConfig + depOff) >>> 0, true);
            view.setUint32(28, (lpServiceConfig + usrOff) >>> 0, true);
            view.setUint32(32, (lpServiceConfig + dspOff) >>> 0, true);
            for (const s of placed) buf.set(s.bytes, s.off);
            Mem.writeBytes(lpServiceConfig, buf);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 16 };
        };

        this.exports["ChangeServiceConfigA"] = (ctx, mem, args) => {
            const svc = serviceObject(args[0]);
            if (!svc) {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 44 };
            }
            const noChange = (v: number) => (v >>> 0) === SERVICE_NO_CHANGE;
            if (!noChange(args[1])) svc.serviceType = args[1] >>> 0;
            if (!noChange(args[2])) svc.startType = args[2] >>> 0;
            if (!noChange(args[3])) svc.errorControl = args[3] >>> 0;
            if (args[4]) svc.binaryPath = Marshaler.readString(mem, args[4] >>> 0);
            if (args[5]) svc.loadOrderGroup = Marshaler.readString(mem, args[5] >>> 0);
            if (args[7]) svc.dependencies = Marshaler.readString(mem, args[7] >>> 0);
            if (args[8]) svc.startName = Marshaler.readString(mem, args[8] >>> 0);
            if (args[10]) svc.displayName = Marshaler.readString(mem, args[10] >>> 0);
            if (args[6]) Mem.writeUint32(args[6] >>> 0, 0);   // lpdwTagId
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 44 };
        };

        // No security descriptors exist behind these services; a locked-down box answers
        // the same way, and it is a branch callers handle.
        this.exports["QueryServiceObjectSecurity"] = (ctx, mem, args) => {
            if (args[4]) Mem.writeUint32(args[4] >>> 0, 0);   // pcbBytesNeeded
            system.scheduler.setLastError(ERROR_ACCESS_DENIED);
            return { value: 0, stackCleanup: 20 };
        };
        this.exports["SetServiceObjectSecurity"] = () => {
            system.scheduler.setLastError(ERROR_ACCESS_DENIED);
            return { value: 0, stackCleanup: 12 };
        };

        // The SCM database is single-threaded here, so the lock always succeeds; its
        // handle has to be non-NULL or the caller treats the call as failed.
        this.exports["LockServiceDatabase"] = (ctx, mem, args) => {
            const scm = process.resourceProvider.getKernelObject(args[0] >>> 0);
            if (!scm || scm.kind !== "scm") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 4 };
            }
            const handle = process.resourceProvider.registerKernelObject({ kind: "sc_lock" });
            system.scheduler.setLastError(0);
            return { value: handle >>> 0, stackCleanup: 4 };
        };
        this.exports["UnlockServiceDatabase"] = (ctx, mem, args) => {
            const lock = process.resourceProvider.getKernelObject(args[0] >>> 0);
            if (!lock || lock.kind !== "sc_lock") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 4 };
            }
            process.resourceProvider.unregisterKernelObject(args[0] >>> 0);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 4 };
        };

        // BOOLEAN SystemFunction036(PVOID pbBuffer, ULONG ulLen) — RtlGenRandom. Callers
        // seed an RNG from it and never check the return, so it must actually write.
        this.exports["SystemFunction036"] = (ctx, mem, args) => {
            const pbBuffer = args[0] >>> 0;
            const ulLen = args[1] >>> 0;
            if (!pbBuffer || ulLen === 0 || !isValidAddress(mem, pbBuffer, ulLen, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 8 };
            }
            const random = new Uint8Array(ulLen);
            // getRandomValues refuses more than 65536 bytes per call.
            for (let off = 0; off < ulLen; off += 0x10000) {
                crypto.getRandomValues(random.subarray(off, Math.min(off + 0x10000, ulLen)));
            }
            mem.set(random, pbBuffer);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 8 };
        };

        this.exports["StartServiceCtrlDispatcherA"] = (ctx, mem, args) => {
            const lpServiceStartTable = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `StartServiceCtrlDispatcherA(table=0x${lpServiceStartTable.toString(16)})`);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 4 };
        };

        this.exports["RegisterServiceCtrlHandlerA"] = (ctx, mem, args) => {
            const lpServiceName = args[0] >>> 0;
            const lpHandlerProc = args[1] >>> 0;
            const serviceName = lpServiceName ? Marshaler.readString(mem, lpServiceName) : "";

            const handle = process.resourceProvider.registerKernelObject({
                kind: "service_status",
                serviceName,
                handler: lpHandlerProc,
            });

            system.scheduler.setLastError(0);
            return { value: handle >>> 0, stackCleanup: 8 };
        };

        this.exports["SetServiceStatus"] = (ctx, mem, args) => {
            const hServiceStatus = args[0] >>> 0;
            const lpServiceStatus = args[1] >>> 0;
            const obj = process.resourceProvider.getKernelObject(hServiceStatus);
            if (!obj || obj.kind !== "service_status") {
                system.scheduler.setLastError(6); // ERROR_INVALID_HANDLE
                return { value: 0, stackCleanup: 8 };
            }

            // Accept status updates as successful; SCM state machine is not modeled yet.
            Logger.verbose(LogCategory.SYSTEM, `SetServiceStatus(handle=0x${hServiceStatus.toString(16)}, status=0x${lpServiceStatus.toString(16)})`);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 8 };
        };

        // GetUserNameA - Retrieve the name of the user associated with the current thread
        // BOOL GetUserNameA(LPSTR lpBuffer, LPDWORD pcbBuffer)
        this.exports["GetUserNameA"] = (ctx, mem, args) => {
            const lpBuffer = args[0];
            const pcbBuffer = args[1];
            const username = "Player";

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const requiredSize = username.length + 1; // includes null terminator

            if (!pcbBuffer || pcbBuffer + 4 > mem.length) {
                return { value: 0, stackCleanup: 8 }; // FALSE
            }

            const availableSize = view.getUint32(pcbBuffer, true);
            view.setUint32(pcbBuffer, requiredSize, true);

            if (!lpBuffer || availableSize < requiredSize) {
                // ERROR_INSUFFICIENT_BUFFER (122) via SetLastError
                return { value: 0, stackCleanup: 8 }; // FALSE
            }

            writeAnsi(mem, lpBuffer, username, requiredSize);
            return { value: 1, stackCleanup: 8 }; // TRUE
        };

        // GetUserNameW - Wide variant
        this.exports["GetUserNameW"] = (ctx, mem, args) => {
            const lpBuffer = args[0];
            const pcbBuffer = args[1];
            const username = "Player";

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const requiredChars = username.length + 1; // includes null terminator

            if (!pcbBuffer || pcbBuffer + 4 > mem.length) {
                return { value: 0, stackCleanup: 8 };
            }

            const availableChars = view.getUint32(pcbBuffer, true);
            view.setUint32(pcbBuffer, requiredChars, true);

            if (!lpBuffer || availableChars < requiredChars) {
                return { value: 0, stackCleanup: 8 };
            }

            writeWide(mem, lpBuffer, username, requiredChars);
            return { value: 1, stackCleanup: 8 }; // TRUE
        };

        // AllocateAndInitializeSid - allocate a SID with up to 8 sub-authorities
        // BOOL AllocateAndInitializeSid(pIdentifierAuthority, nSubAuthorityCount,
        //   sa0..sa7, pSid)
        this.exports["AllocateAndInitializeSid"] = (ctx, mem, args) => {
            const pIdentifierAuthority = args[0] >>> 0;
            const nSubAuthorityCount = args[1] & 0xFF;
            // args[2]..args[9] = sub-authorities 0-7
            const pSid = args[10] >>> 0;

            // Build a minimal SID in guest memory.
            // SID layout: Revision(1) + SubAuthorityCount(1) + IdentifierAuthority(6) + SubAuthority[n](4*n)
            const sidSize = 8 + nSubAuthorityCount * 4;
            const alloc = process.memory?.alloc(sidSize);
            if (!alloc) {
                system.scheduler.setLastError(8); // ERROR_NOT_ENOUGH_MEMORY
                return { value: 0, stackCleanup: 44 }; // FALSE
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            mem[alloc] = 1; // Revision
            mem[alloc + 1] = nSubAuthorityCount;

            // Copy 6-byte IdentifierAuthority from caller
            if (pIdentifierAuthority && pIdentifierAuthority + 6 <= mem.length) {
                for (let i = 0; i < 6; i++) {
                    mem[alloc + 2 + i] = mem[pIdentifierAuthority + i];
                }
            }

            // Sub-authorities
            const count = Math.min(nSubAuthorityCount, 8);
            for (let i = 0; i < count; i++) {
                view.setUint32(alloc + 8 + i * 4, args[2 + i] >>> 0, true);
            }

            // Write SID pointer to caller's output
            if (pSid && pSid + 4 <= mem.length) {
                view.setUint32(pSid, alloc >>> 0, true);
            }

            return { value: 1, stackCleanup: 44 }; // TRUE
        };

        // FreeSid - free a SID allocated by AllocateAndInitializeSid
        // PVOID FreeSid(PSID pSid)
        this.exports["FreeSid"] = (ctx, mem, args) => {
            // We don't track individual small allocs for freeing, just return NULL (success).
            return { value: 0, stackCleanup: 4 }; // NULL = success
        };

        // IsValidSid - check if a SID has a valid structure
        // BOOL IsValidSid(PSID pSid)
        this.exports["IsValidSid"] = (ctx, mem, args) => {
            const pSid = args[0] >>> 0;
            return { value: pSid ? 1 : 0, stackCleanup: 4 };
        };

        // IsTextUnicode - determine if buffer contains Unicode text
        // BOOL IsTextUnicode(const VOID *lpv, int iSize, LPINT lpiResult)
        this.exports["IsTextUnicode"] = (ctx, mem, args) => {
            return { value: 0, stackCleanup: 12 }; // FALSE = not unicode
        };

        // InitializeAcl - initialize an ACL structure
        // BOOL InitializeAcl(PACL pAcl, DWORD nAclLength, DWORD dwAclRevision)
        this.exports["InitializeAcl"] = (ctx, mem, args) => {
            const pAcl = args[0] >>> 0;
            const nAclLength = args[1] >>> 0;
            if (pAcl && nAclLength >= 8 && pAcl + nAclLength <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                mem.fill(0, pAcl, pAcl + nAclLength);
                view.setUint8(pAcl, 2);            // AclRevision = ACL_REVISION
                view.setUint16(pAcl + 2, nAclLength, true); // AclSize
            }
            return { value: 1, stackCleanup: 12 }; // TRUE
        };

        // InitializeSecurityDescriptor - initialize an absolute SECURITY_DESCRIPTOR
        // BOOL InitializeSecurityDescriptor(PSECURITY_DESCRIPTOR pSecurityDescriptor, DWORD dwRevision)
        this.exports["InitializeSecurityDescriptor"] = (ctx, mem, args) => {
            const pSecurityDescriptor = args[0] >>> 0;
            const dwRevision = args[1] >>> 0;

            if (!pSecurityDescriptor || !isValidAddress(mem, pSecurityDescriptor, SECURITY_DESCRIPTOR_MIN_LENGTH, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 8 };
            }

            if (dwRevision !== SECURITY_DESCRIPTOR_REVISION) {
                system.scheduler.setLastError(ERROR_UNKNOWN_REVISION);
                return { value: 0, stackCleanup: 8 };
            }

            const zeroed = new Uint8Array(SECURITY_DESCRIPTOR_MIN_LENGTH);
            zeroed[0] = SECURITY_DESCRIPTOR_REVISION;
            if (Mem.writeBytes(pSecurityDescriptor, zeroed) !== zeroed.length) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 8 };
            }

            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 8 };
        };

        // SetSecurityDescriptorDacl - attach or clear the DACL pointer on an absolute SECURITY_DESCRIPTOR
        // BOOL SetSecurityDescriptorDacl(PSECURITY_DESCRIPTOR pSecurityDescriptor, BOOL bDaclPresent, PACL pDacl, BOOL bDaclDefaulted)
        this.exports["SetSecurityDescriptorDacl"] = (ctx, mem, args) => {
            const pSecurityDescriptor = args[0] >>> 0;
            const bDaclPresent = args[1] >>> 0;
            const pDacl = args[2] >>> 0;
            const bDaclDefaulted = args[3] >>> 0;

            if (!pSecurityDescriptor || !isValidAddress(mem, pSecurityDescriptor, SECURITY_DESCRIPTOR_MIN_LENGTH, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 16 };
            }

            const revision = Mem.readUint8(pSecurityDescriptor);
            if (revision !== SECURITY_DESCRIPTOR_REVISION) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 16 };
            }

            let control = Mem.readUint16(pSecurityDescriptor + 2) ?? 0;
            control &= ~(SE_DACL_PRESENT | SE_DACL_DEFAULTED);

            if (bDaclPresent) {
                control |= SE_DACL_PRESENT;
            }
            if (bDaclDefaulted) {
                control |= SE_DACL_DEFAULTED;
            }

            if (!Mem.writeUint16(pSecurityDescriptor + 2, control)) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 16 };
            }

            if (!Mem.writeUint32(pSecurityDescriptor + 16, bDaclPresent ? pDacl : 0)) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 16 };
            }

            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 16 };
        };

        // AddAccessAllowedAce - add an access-allowed ACE to an ACL
        // BOOL AddAccessAllowedAce(PACL pAcl, DWORD dwAceRevision, DWORD AccessMask, PSID pSid)
        this.exports["AddAccessAllowedAce"] = (ctx, mem, args) => {
            // Stub: accept without actually modifying the ACL
            return { value: 1, stackCleanup: 16 }; // TRUE
        };

        // AddAccessDeniedAce - add an access-denied ACE to an ACL
        // BOOL AddAccessDeniedAce(PACL pAcl, DWORD dwAceRevision, DWORD AccessMask, PSID pSid)
        this.exports["AddAccessDeniedAce"] = (ctx, mem, args) => {
            return { value: 1, stackCleanup: 16 }; // TRUE
        };

        // OpenProcessToken - open the access token for a process
        // BOOL OpenProcessToken(HANDLE ProcessHandle, DWORD DesiredAccess, PHANDLE TokenHandle)
        this.exports["OpenProcessToken"] = (ctx, mem, args) => {
            const pTokenHandle = args[2] >>> 0;
            if (pTokenHandle && pTokenHandle + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(pTokenHandle, 0x1ACC, true); // dummy token handle
            }
            return { value: 1, stackCleanup: 12 }; // TRUE
        };

        // OpenThreadToken - open the access token of a thread
        // BOOL OpenThreadToken(HANDLE ThreadHandle, DWORD DesiredAccess, BOOL OpenAsSelf, PHANDLE TokenHandle)
        // A thread only has a token while impersonating; ours never does, so the faithful
        // answer is failure with ERROR_NO_TOKEN — the branch callers take to fall back to
        // OpenProcessToken. Handing out the process token instead makes an impersonation
        // check silently succeed.
        this.exports["OpenThreadToken"] = (ctx, mem, args) => {
            const pTokenHandle = args[3] >>> 0;
            if (pTokenHandle) Mem.writeUint32(pTokenHandle, 0);
            system.scheduler.setLastError(ERROR_NO_TOKEN);
            return { value: 0, stackCleanup: 16 }; // FALSE
        };

        // GetTokenInformation - retrieve information about an access token
        // BOOL GetTokenInformation(HANDLE, TOKEN_INFORMATION_CLASS, LPVOID, DWORD, PDWORD)
        this.exports["GetTokenInformation"] = (ctx, mem, args) => {
            const tokenInfoClass = args[1] >>> 0;
            const pTokenInfo = args[2] >>> 0;
            const tokenInfoLength = args[3] >>> 0;
            const pReturnLength = args[4] >>> 0;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // TokenType = 1 (TokenPrimary), TokenElevationType = 2 (not elevated)
            // For TokenGroups/TokenPrivileges return empty (GroupCount=0)
            if (pTokenInfo && tokenInfoLength >= 4) {
                view.setUint32(pTokenInfo, 0, true);
            }
            if (pReturnLength && pReturnLength + 4 <= mem.length) {
                view.setUint32(pReturnLength, Math.min(4, tokenInfoLength), true);
            }
            return { value: 1, stackCleanup: 20 }; // TRUE
        };

        // CheckTokenMembership - check if a SID is in the current token
        // BOOL CheckTokenMembership(HANDLE TokenHandle, PSID SidToCheck, PBOOL IsMember)
        this.exports["CheckTokenMembership"] = (ctx, mem, args) => {
            const hToken = args[0] >>> 0;
            const pSidToCheck = args[1] >>> 0;
            const pIsMember = args[2] >>> 0;

            // Always report "not a member" — safe default (not admin).
            if (pIsMember && pIsMember + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(pIsMember, 0, true); // FALSE — not a member
            }

            return { value: 1, stackCleanup: 12 }; // TRUE (call succeeded)
        };

        // BOOL CryptAcquireContextA(PHCRYPTPROV, LPCSTR, LPCSTR, DWORD, DWORD)
        this.exports["CryptAcquireContextA"] = (ctx, mem, args) => {
            const phProv = args[0] >>> 0;
            const pszContainer = args[1] >>> 0;
            const pszProvider = args[2] >>> 0;
            const dwProvType = args[3] >>> 0;
            const dwFlags = args[4] >>> 0;

            if (!phProv || phProv + 4 > mem.length || !isValidAddress(mem, phProv, 4, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 20 };
            }

            const container = pszContainer ? Marshaler.readString(mem, pszContainer) : "";
            const provider = pszProvider ? Marshaler.readString(mem, pszProvider) : "";
            const handle = process.resourceProvider.registerKernelObject({
                kind: "crypt_prov",
                container,
                provider,
                provType: dwProvType,
                flags: dwFlags,
            });

            if (!Mem.writeUint32(phProv, handle >>> 0)) {
                process.resourceProvider.unregisterKernelObject(handle);
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 20 };
            }

            Logger.verbose(
                LogCategory.SYSTEM,
                `CryptAcquireContextA(container="${container}", provider="${provider}", type=${dwProvType}, flags=0x${dwFlags.toString(16)}) -> 0x${handle.toString(16)}`
            );
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 20 };
        };

        // BOOL CryptReleaseContext(HCRYPTPROV, DWORD)
        this.exports["CryptReleaseContext"] = (ctx, mem, args) => {
            const hProv = args[0] >>> 0;
            const obj = process.resourceProvider.getKernelObject(hProv);
            if (!obj || obj.kind !== "crypt_prov") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 8 };
            }

            process.resourceProvider.unregisterKernelObject(hProv);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 8 };
        };

        // BOOL CryptGenRandom(HCRYPTPROV, DWORD, BYTE*)
        this.exports["CryptGenRandom"] = (ctx, mem, args) => {
            const hProv = args[0] >>> 0;
            const dwLen = args[1] >>> 0;
            const pbBuffer = args[2] >>> 0;

            if (!pbBuffer || dwLen === 0 || !isValidAddress(mem, pbBuffer, dwLen, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 12 };
            }

            if (hProv !== 0) {
                const provObj = process.resourceProvider.getKernelObject(hProv);
                if (!provObj || provObj.kind !== "crypt_prov") {
                    system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                    return { value: 0, stackCleanup: 12 };
                }
            }

            const random = new Uint8Array(dwLen);
            crypto.getRandomValues(random);
            mem.set(random, pbBuffer);

            Logger.verbose(LogCategory.SYSTEM, `CryptGenRandom(prov=0x${hProv.toString(16)}, len=${dwLen})`);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 12 };
        };

        // BOOL CryptCreateHash(HCRYPTPROV, ALG_ID, HCRYPTKEY, DWORD, HCRYPTHASH*)
        this.exports["CryptCreateHash"] = (ctx, mem, args) => {
            const hProv = args[0] >>> 0;
            const algId = args[1] >>> 0;
            const hKey = args[2] >>> 0;
            const dwFlags = args[3] >>> 0;
            const phHash = args[4] >>> 0;

            const provObj = process.resourceProvider.getKernelObject(hProv);
            if (!provObj || provObj.kind !== "crypt_prov") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 20 };
            }
            if (!phHash || phHash + 4 > mem.length || !isValidAddress(mem, phHash, 4, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 20 };
            }

            const handle = process.resourceProvider.registerKernelObject({
                kind: "crypt_hash",
                prov: hProv,
                algId,
                key: hKey,
                flags: dwFlags,
                bytesHashed: 0,
                hasher: makeCryptHasher(algId),
                finalDigest: null as Uint8Array | null,
            });

            if (!Mem.writeUint32(phHash, handle >>> 0)) {
                process.resourceProvider.unregisterKernelObject(handle);
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 20 };
            }

            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 20 };
        };

        // BOOL CryptHashData(HCRYPTHASH, const BYTE*, DWORD, DWORD)
        this.exports["CryptHashData"] = (ctx, mem, args) => {
            const hHash = args[0] >>> 0;
            const pbData = args[1] >>> 0;
            const dwDataLen = args[2] >>> 0;
            const dwFlags = args[3] >>> 0;

            const hashObj = process.resourceProvider.getKernelObject(hHash);
            if (!hashObj || hashObj.kind !== "crypt_hash") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 16 };
            }

            // Reading HP_HASHVAL finalizes the hash; feeding it more is the documented error.
            if (hashObj.finalDigest) {
                system.scheduler.setLastError(NTE_BAD_HASH_STATE);
                return { value: 0, stackCleanup: 16 };
            }

            if (dwDataLen > 0) {
                if (!pbData || pbData + dwDataLen > mem.length || !isValidAddress(mem, pbData, dwDataLen, "r")) {
                    system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                    return { value: 0, stackCleanup: 16 };
                }
                const chunk = Mem.readBytes(pbData, dwDataLen);
                if (!chunk) {
                    system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                    return { value: 0, stackCleanup: 16 };
                }
                (hashObj.hasher as CryptHasher | null)?.update(chunk);
                hashObj.bytesHashed = ((hashObj.bytesHashed >>> 0) + dwDataLen) >>> 0;
            }

            Logger.verbose(
                LogCategory.SYSTEM,
                `CryptHashData(hash=0x${hHash.toString(16)}, len=${dwDataLen}, flags=0x${dwFlags.toString(16)})`
            );
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 16 };
        };

        // BOOL CryptImportKey(HCRYPTPROV, const BYTE*, DWORD, HCRYPTKEY, DWORD, HCRYPTKEY*)
        this.exports["CryptImportKey"] = (ctx, mem, args) => {
            const hProv = args[0] >>> 0;
            const pbData = args[1] >>> 0;
            const dwDataLen = args[2] >>> 0;
            const hPubKey = args[3] >>> 0;
            const dwFlags = args[4] >>> 0;
            const phKey = args[5] >>> 0;

            const provObj = process.resourceProvider.getKernelObject(hProv);
            if (!provObj || provObj.kind !== "crypt_prov") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 24 };
            }
            if (!phKey || phKey + 4 > mem.length || !isValidAddress(mem, phKey, 4, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 24 };
            }
            if (dwDataLen > 0 && (!pbData || pbData + dwDataLen > mem.length || !isValidAddress(mem, pbData, dwDataLen, "r"))) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 24 };
            }

            const handle = process.resourceProvider.registerKernelObject({
                kind: "crypt_key",
                prov: hProv,
                importedFrom: hPubKey,
                flags: dwFlags,
                dataLen: dwDataLen,
            });

            if (!Mem.writeUint32(phKey, handle >>> 0)) {
                process.resourceProvider.unregisterKernelObject(handle);
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 24 };
            }

            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 24 };
        };

        // BOOL CryptVerifySignatureA(HCRYPTHASH, const BYTE*, DWORD, HCRYPTKEY, LPCSTR, DWORD)
        this.exports["CryptVerifySignatureA"] = (ctx, mem, args) => {
            const hHash = args[0] >>> 0;
            const pbSignature = args[1] >>> 0;
            const dwSigLen = args[2] >>> 0;
            const hPubKey = args[3] >>> 0;
            const sDescription = args[4] >>> 0;
            const dwFlags = args[5] >>> 0;

            const hashObj = process.resourceProvider.getKernelObject(hHash);
            if (!hashObj || hashObj.kind !== "crypt_hash") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 24 };
            }
            if (hPubKey !== 0) {
                const keyObj = process.resourceProvider.getKernelObject(hPubKey);
                if (!keyObj || keyObj.kind !== "crypt_key") {
                    system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                    return { value: 0, stackCleanup: 24 };
                }
            }
            if (dwSigLen > 0 && (!pbSignature || pbSignature + dwSigLen > mem.length || !isValidAddress(mem, pbSignature, dwSigLen, "r"))) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 24 };
            }

            const description = sDescription ? Marshaler.readString(mem, sDescription) : "";
            Logger.verbose(
                LogCategory.SYSTEM,
                `CryptVerifySignatureA(hash=0x${hHash.toString(16)}, sigLen=${dwSigLen}, key=0x${hPubKey.toString(16)}, desc="${description}", flags=0x${dwFlags.toString(16)}) -> TRUE`
            );
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 24 };
        };

        // BOOL CryptGetHashParam(HCRYPTHASH, DWORD dwParam, BYTE *pbData, DWORD *pdwDataLen, DWORD dwFlags)
        this.exports["CryptGetHashParam"] = (ctx, mem, args) => {
            const hHash = args[0] >>> 0;
            const dwParam = args[1] >>> 0;
            const pbData = args[2] >>> 0;
            const pdwDataLen = args[3] >>> 0;

            const hashObj = process.resourceProvider.getKernelObject(hHash);
            if (!hashObj || hashObj.kind !== "crypt_hash") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 20 };
            }
            if (!pdwDataLen || !isValidAddress(mem, pdwDataLen, 4, "rw")) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 20 };
            }

            const hasher = hashObj.hasher as CryptHasher | null;
            let payload: Uint8Array;
            switch (dwParam) {
                case HP_ALGID: {
                    payload = new Uint8Array(4);
                    new DataView(payload.buffer).setUint32(0, hashObj.algId >>> 0, true);
                    break;
                }
                case HP_HASHSIZE: {
                    if (!hasher) { system.scheduler.setLastError(NTE_BAD_ALGID); return { value: 0, stackCleanup: 20 }; }
                    payload = new Uint8Array(4);
                    new DataView(payload.buffer).setUint32(0, hasher.size, true);
                    break;
                }
                case HP_HASHVAL: {
                    if (!hasher) { system.scheduler.setLastError(NTE_BAD_ALGID); return { value: 0, stackCleanup: 20 }; }
                    // A NULL-buffer size query must NOT finalize: "ask the size, then keep
                    // hashing" is the documented sequence, and finalizing here would make the
                    // next CryptHashData fail with NTE_BAD_HASH_STATE.
                    if (!pbData) {
                        Mem.writeUint32(pdwDataLen, hasher.size);
                        system.scheduler.setLastError(0);
                        return { value: 1, stackCleanup: 20 };
                    }
                    // The digest is computed once and cached: a second read must return the
                    // same bytes, and a streaming hasher cannot be finalized twice.
                    if (!hashObj.finalDigest) hashObj.finalDigest = hasher.digest();
                    payload = hashObj.finalDigest as Uint8Array;
                    break;
                }
                default:
                    system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                    return { value: 0, stackCleanup: 20 };
            }

            // A NULL buffer is the documented "how big?" query; a short one is ERROR_MORE_DATA.
            const avail = Mem.readUint32(pdwDataLen) ?? 0;
            if (!pbData) {
                Mem.writeUint32(pdwDataLen, payload.length);
                system.scheduler.setLastError(0);
                return { value: 1, stackCleanup: 20 };
            }
            if (avail < payload.length) {
                Mem.writeUint32(pdwDataLen, payload.length);
                system.scheduler.setLastError(ERROR_MORE_DATA);
                return { value: 0, stackCleanup: 20 };
            }
            if (!isValidAddress(mem, pbData, payload.length, "rw") ||
                Mem.writeBytes(pbData, payload) !== payload.length) {
                system.scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 20 };
            }
            Mem.writeUint32(pdwDataLen, payload.length);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 20 };
        };

        // BOOL CryptEncrypt(HCRYPTKEY, HCRYPTHASH, BOOL Final, DWORD dwFlags, BYTE *pbData,
        //   DWORD *pdwDataLen, DWORD dwBufLen)
        //
        // CryptImportKey keeps no key MATERIAL (the blob is recorded, not parsed), so there is
        // no cipher to run. Returning the plaintext unchanged would hand the caller data it
        // believes is encrypted; failing with NTE_BAD_KEY is the answer a caller can actually
        // detect. The warning names what a title needing this would require.
        this.exports["CryptEncrypt"] = (ctx, mem, args) => {
            const hKey = args[0] >>> 0;
            const dwDataLenPtr = args[5] >>> 0;
            const len = dwDataLenPtr ? (Mem.readUint32(dwDataLenPtr) ?? 0) : 0;
            Logger.warn(
                LogCategory.SYSTEM,
                `CryptEncrypt(key=0x${hKey.toString(16)}, ${len} bytes) -> NTE_BAD_KEY ` +
                `(no key material: CryptImportKey does not parse the blob)`
            );
            system.scheduler.setLastError(NTE_BAD_KEY);
            return { value: 0, stackCleanup: 28 };
        };

        // BOOL CryptDestroyHash(HCRYPTHASH)
        this.exports["CryptDestroyHash"] = (ctx, mem, args) => {
            const hHash = args[0] >>> 0;
            const obj = process.resourceProvider.getKernelObject(hHash);
            if (!obj || obj.kind !== "crypt_hash") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 4 };
            }

            process.resourceProvider.unregisterKernelObject(hHash);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 4 };
        };

        // BOOL CryptDestroyKey(HCRYPTKEY)
        this.exports["CryptDestroyKey"] = (ctx, mem, args) => {
            const hKey = args[0] >>> 0;
            const obj = process.resourceProvider.getKernelObject(hKey);
            if (!obj || obj.kind !== "crypt_key") {
                system.scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 4 };
            }

            process.resourceProvider.unregisterKernelObject(hKey);
            system.scheduler.setLastError(0);
            return { value: 1, stackCleanup: 4 };
        };

        // SetNamedSecurityInfoA - stub (always succeeds)
        this.exports['SetNamedSecurityInfoA'] = (ctx, mem, args): number => {
            const pObjectName = args[0];
            const name = pObjectName ? Marshaler.readString(mem, pObjectName) : '';
            Logger.log(LogCategory.SYSTEM, `SetNamedSecurityInfoA("${name}") -> stub ERROR_SUCCESS`);
            return 0; // ERROR_SUCCESS
        };
    }
}
