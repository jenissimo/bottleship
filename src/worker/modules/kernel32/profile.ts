/**
 * Kernel32 Profile (INI file) functions
 *
 * Reading and writing .ini configuration files
 * Parses INI files from VFS with caching
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { encodeAnsi } from '../codepage-utils';

// Parsed INI file: section name -> key -> value (all case-insensitive)
type IniData = Map<string, Map<string, string>>;

// Cache: normalized file path -> parsed data
const iniCache = new Map<string, IniData>();

export function resetIniCache(): void {
    iniCache.clear();
}

/**
 * Invalidate cached INI data for a specific file path.
 * Called when shellExecFake writes a new INI file that was previously cached as empty.
 */
export function invalidateIniCache(filePath: string): void {
    const system = System.getInstance();
    const vfs = system.fileSystem;
    const resolved = vfs.resolvePath(filePath).toLowerCase();
    if (iniCache.has(resolved)) {
        iniCache.delete(resolved);
        Logger.log(LogCategory.KERNEL32, `INI cache invalidated for "${filePath}" (resolved: "${resolved}")`);
    }
    // Also try exact path lowercase
    const lower = filePath.toLowerCase();
    if (iniCache.has(lower)) {
        iniCache.delete(lower);
    }
}

/**
 * Parse INI file content into sections/keys/values
 * Handles standard Windows INI format:
 *   [Section]
 *   Key=Value
 *   ; comments
 */
function parseIniContent(content: string): IniData {
    const data: IniData = new Map();
    let currentSection = ""; // keys before any section header go in empty-string section

    const stripOuterQuotes = (value: string): string => {
        if (value.length < 2) return value;
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
        return value;
    };

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;

        // Section header
        const sectionMatch = line.match(/^\[([^\]]*)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1].trim().toLowerCase();
            if (!data.has(currentSection)) {
                data.set(currentSection, new Map());
            }
            continue;
        }

        // Key=Value
        const eqIdx = line.indexOf('=');
        if (eqIdx !== -1) {
            const key = line.substring(0, eqIdx).trim().toLowerCase();
            // WinAPI profile reads return values without surrounding quotes.
            const value = stripOuterQuotes(line.substring(eqIdx + 1).trim());
            if (!data.has(currentSection)) {
                data.set(currentSection, new Map());
            }
            data.get(currentSection)!.set(key, value);
        }
    }

    return data;
}

/**
 * Read and parse an INI file from VFS, with caching
 */
function getIniData(fileName: string): IniData | null {
    const system = System.getInstance();
    const vfs = system.fileSystem;

    const resolved = vfs.resolvePath(fileName);
    const cacheKey = resolved.toLowerCase();

    const cached = iniCache.get(cacheKey);
    if (cached) return cached;

    // Try to open and read the file synchronously
    const handle = vfs.openSync(fileName, 0x80000000 /* GENERIC_READ */, 3 /* OPEN_EXISTING */);
    if (!handle) {
        // Genuinely absent — negative-cache to avoid repeated index lookups.
        Logger.verbose(LogCategory.KERNEL32, `INI: file not found: "${fileName}"`);
        iniCache.set(cacheKey, new Map());
        return null;
    }

    const fileSize = vfs.getFileSize(handle.path);
    if (fileSize <= 0) {
        // Genuinely empty file — negative-cache is correct.
        iniCache.set(cacheKey, new Map());
        return null;
    }

    const data = vfs.readSync(handle, fileSize);
    if (!data || data.length < fileSize) {
        // File exists with size>0 but the sync read came up short — a transient
        // miss (non-resident ROM blocks), NOT an empty file. Don't negative-cache:
        // that would poison this INI as empty for the whole run. Returning null
        // lets a later call retry once the bytes are resident (config files are
        // pinned at boot, so this should not recur).
        Logger.verbose(LogCategory.KERNEL32, `INI: transient sync-read miss (not caching): "${fileName}" (got ${data?.length ?? 0}/${fileSize})`);
        return null;
    }

    // Decode as ASCII/Latin-1
    const text = new TextDecoder('latin1').decode(data);
    const parsed = parseIniContent(text);

    Logger.log(LogCategory.KERNEL32, `INI: parsed "${fileName}" -> ${parsed.size} sections`);
    iniCache.set(cacheKey, parsed);

    return parsed;
}

/**
 * Look up a value from INI data
 */
function getIniValue(ini: IniData, section: string, key: string): string | undefined {
    const sectionData = ini.get(section.toLowerCase());
    if (!sectionData) return undefined;
    return sectionData.get(key.toLowerCase());
}

/**
 * Write a string result to guest memory buffer
 */
function writeStringToBuffer(mem: Uint8Array, addr: number, value: string, bufSize: number): number {
    const encoded = encodeAnsi(value);
    const bytesToWrite = Math.min(encoded.length, bufSize - 1);
    mem.set(encoded.subarray(0, bytesToWrite), addr);
    mem[addr + bytesToWrite] = 0;
    return bytesToWrite;
}

/**
 * Enumerate all keys in a section, writing null-separated list with double-null terminator
 */
function enumerateKeys(mem: Uint8Array, addr: number, bufSize: number, sectionData: Map<string, string>): number {
    let pos = 0;
    for (const key of sectionData.keys()) {
        const encoded = encodeAnsi(key);
        if (pos + encoded.length + 2 > bufSize) break; // need room for key + null + final null
        mem.set(encoded, addr + pos);
        pos += encoded.length;
        mem[addr + pos++] = 0; // null separator
    }
    mem[addr + pos] = 0; // double-null terminator
    return pos;
}

/**
 * Enumerate all section names, writing null-separated list with double-null terminator
 */
function enumerateSections(mem: Uint8Array, addr: number, bufSize: number, ini: IniData): number {
    let pos = 0;
    for (const section of ini.keys()) {
        if (!section) continue; // skip empty-string section
        const encoded = encodeAnsi(section);
        if (pos + encoded.length + 2 > bufSize) break;
        mem.set(encoded, addr + pos);
        pos += encoded.length;
        mem[addr + pos++] = 0;
    }
    mem[addr + pos] = 0;
    return pos;
}

function writeWideStringToBuffer(addr: number, value: string, bufSizeChars: number): number {
    const size = bufSizeChars | 0;
    if (addr === 0 || size <= 0) return 0;

    const charsToWrite = Math.min(value.length, size - 1);
    for (let i = 0; i < charsToWrite; i++) {
        if (!Mem.writeUint16(addr + i * 2, value.charCodeAt(i))) {
            return i;
        }
    }
    Mem.writeUint16(addr + charsToWrite * 2, 0);
    return charsToWrite;
}

function enumerateKeysWide(addr: number, bufSizeChars: number, sectionData: Map<string, string>): number {
    const size = bufSizeChars | 0;
    if (addr === 0 || size <= 0) return 0;

    let pos = 0;
    for (const key of sectionData.keys()) {
        if (pos + key.length + 2 > size) break; // key + separator + final null

        for (let i = 0; i < key.length; i++) {
            if (!Mem.writeUint16(addr + (pos + i) * 2, key.charCodeAt(i))) {
                return pos;
            }
        }
        pos += key.length;
        if (!Mem.writeUint16(addr + pos * 2, 0)) {
            return pos;
        }
        pos += 1;
    }

    Mem.writeUint16(addr + pos * 2, 0);
    return pos;
}

function enumerateSectionsWide(addr: number, bufSizeChars: number, ini: IniData): number {
    const size = bufSizeChars | 0;
    if (addr === 0 || size <= 0) return 0;

    let pos = 0;
    for (const section of ini.keys()) {
        if (!section) continue;
        if (pos + section.length + 2 > size) break; // section + separator + final null

        for (let i = 0; i < section.length; i++) {
            if (!Mem.writeUint16(addr + (pos + i) * 2, section.charCodeAt(i))) {
                return pos;
            }
        }
        pos += section.length;
        if (!Mem.writeUint16(addr + pos * 2, 0)) {
            return pos;
        }
        pos += 1;
    }

    Mem.writeUint16(addr + pos * 2, 0);
    return pos;
}

export const exports: Record<string, ThunkImplementation> = {
    'GetPrivateProfileStringA': (ctx, mem, args) => {
        const lpAppName = args[0];
        const lpKeyName = args[1];
        const lpDefault = args[2];
        const lpReturnedString = args[3];
        const nSize = args[4];
        const lpFileName = args[5];

        const appName = lpAppName ? Marshaler.readString(mem, lpAppName) : '';
        const keyName = lpKeyName ? Marshaler.readString(mem, lpKeyName) : '';
        const defaultValue = lpDefault ? Marshaler.readString(mem, lpDefault) : '';
        const fileName = lpFileName ? Marshaler.readString(mem, lpFileName) : '';

        Logger.verboseLazy(
            LogCategory.KERNEL32,
            () => `GetPrivateProfileStringA(section="${appName}", key="${keyName}", default="${defaultValue}", bufSize=${nSize}, file="${fileName}")`
        );

        if (!lpReturnedString || nSize === 0) {
            return 0;
        }

        // Special case: lpAppName == NULL -> enumerate sections
        if (!lpAppName) {
            const ini = getIniData(fileName);
            if (!ini) return writeStringToBuffer(mem, lpReturnedString, '', nSize);
            return enumerateSections(mem, lpReturnedString, nSize, ini);
        }

        // Special case: lpKeyName == NULL -> enumerate keys in section
        if (!lpKeyName) {
            const ini = getIniData(fileName);
            if (!ini) return writeStringToBuffer(mem, lpReturnedString, '', nSize);
            const sectionData = ini.get(appName.toLowerCase());
            if (!sectionData) return writeStringToBuffer(mem, lpReturnedString, '', nSize);
            return enumerateKeys(mem, lpReturnedString, nSize, sectionData);
        }

        // Normal case: read specific key
        const ini = getIniData(fileName);
        const value = ini ? getIniValue(ini, appName, keyName) : undefined;
        const result = value !== undefined ? value : defaultValue;

        if (value !== undefined) {
            Logger.verboseLazy(
                LogCategory.KERNEL32,
                () => `GetPrivateProfileStringA: [${appName}]${keyName} = "${value}" (from file)`
            );
        }

        return writeStringToBuffer(mem, lpReturnedString, result, nSize);
    },

    'GetPrivateProfileIntA': (ctx, mem, args) => {
        const lpAppName = args[0];
        const lpKeyName = args[1];
        const nDefault = args[2];
        const lpFileName = args[3];

        const appName = lpAppName ? Marshaler.readString(mem, lpAppName) : '';
        const keyName = lpKeyName ? Marshaler.readString(mem, lpKeyName) : '';
        const fileName = lpFileName ? Marshaler.readString(mem, lpFileName) : '';

        Logger.verboseLazy(
            LogCategory.KERNEL32,
            () => `GetPrivateProfileIntA(section="${appName}", key="${keyName}", default=${nDefault}, file="${fileName}")`
        );

        const ini = getIniData(fileName);
        const value = ini ? getIniValue(ini, appName, keyName) : undefined;

        if (value !== undefined) {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed)) {
                Logger.verboseLazy(
                    LogCategory.KERNEL32,
                    () => `GetPrivateProfileIntA: [${appName}]${keyName} = ${parsed} (from file)`
                );
                return parsed;
            }
        }

        return nDefault;
    },

    'GetPrivateProfileIntW': (ctx, mem, args) => {
        const lpAppName = args[0];
        const lpKeyName = args[1];
        const nDefault = args[2];
        const lpFileName = args[3];

        const appName = lpAppName ? Marshaler.readWideString(mem, lpAppName) : '';
        const keyName = lpKeyName ? Marshaler.readWideString(mem, lpKeyName) : '';
        const fileName = lpFileName ? Marshaler.readWideString(mem, lpFileName) : '';

        Logger.verboseLazy(
            LogCategory.KERNEL32,
            () => `GetPrivateProfileIntW(section="${appName}", key="${keyName}", default=${nDefault}, file="${fileName}")`
        );

        const ini = getIniData(fileName);
        const value = ini ? getIniValue(ini, appName, keyName) : undefined;

        if (value !== undefined) {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed)) {
                Logger.verboseLazy(
                    LogCategory.KERNEL32,
                    () => `GetPrivateProfileIntW: [${appName}]${keyName} = ${parsed} (from file)`
                );
                return parsed;
            }
        }

        return nDefault;
    },

    'WritePrivateProfileStringA': (ctx, mem, args) => {
        const lpAppName = args[0];
        const lpKeyName = args[1];
        const lpString = args[2];
        const lpFileName = args[3];

        const section = lpAppName ? Marshaler.readString(mem, lpAppName) : null;
        const key = lpKeyName ? Marshaler.readString(mem, lpKeyName) : null;
        const value = lpString ? Marshaler.readString(mem, lpString) : null;
        const fileName = lpFileName ? Marshaler.readString(mem, lpFileName) : null;

        Logger.log(LogCategory.KERNEL32, `WritePrivateProfileStringA: [${section}] ${key}=${value} in "${fileName}"`);

        // Update in-memory cache if the file was already parsed
        if (fileName && section && key && value !== null) {
            const system = System.getInstance();
            const resolved = system.fileSystem.resolvePath(fileName).toLowerCase();
            const cached = iniCache.get(resolved);
            if (cached) {
                const sectionKey = section.toLowerCase();
                if (!cached.has(sectionKey)) {
                    cached.set(sectionKey, new Map());
                }
                cached.get(sectionKey)!.set(key.toLowerCase(), value);
            }
        }

        return 1; // TRUE
    },

    'WritePrivateProfileStringW': (ctx, mem, args) => {
        const lpAppName = args[0];
        const lpKeyName = args[1];
        const lpString = args[2];
        const lpFileName = args[3];

        const section = lpAppName ? Marshaler.readWideString(mem, lpAppName) : null;
        const key = lpKeyName ? Marshaler.readWideString(mem, lpKeyName) : null;
        const value = lpString ? Marshaler.readWideString(mem, lpString) : null;
        const fileName = lpFileName ? Marshaler.readWideString(mem, lpFileName) : null;

        Logger.log(LogCategory.KERNEL32, `WritePrivateProfileStringW: [${section}] ${key}=${value} in "${fileName}"`);

        // Update in-memory cache if the file was already parsed
        if (fileName && section && key && value !== null) {
            const system = System.getInstance();
            const resolved = system.fileSystem.resolvePath(fileName).toLowerCase();
            const cached = iniCache.get(resolved);
            if (cached) {
                const sectionKey = section.toLowerCase();
                if (!cached.has(sectionKey)) {
                    cached.set(sectionKey, new Map());
                }
                cached.get(sectionKey)!.set(key.toLowerCase(), value);
            }
        }

        return 1; // TRUE
    },

    'GetPrivateProfileStringW': (ctx, mem, args) => {
        const lpAppName = args[0];
        const lpKeyName = args[1];
        const lpDefault = args[2];
        const lpReturnedString = args[3];
        const nSize = args[4];
        const lpFileName = args[5];

        const appName = lpAppName ? Marshaler.readWideString(mem, lpAppName) : '';
        const keyName = lpKeyName ? Marshaler.readWideString(mem, lpKeyName) : '';
        const defaultValue = lpDefault ? Marshaler.readWideString(mem, lpDefault) : '';
        const fileName = lpFileName ? Marshaler.readWideString(mem, lpFileName) : '';

        Logger.verboseLazy(
            LogCategory.KERNEL32,
            () => `GetPrivateProfileStringW(section="${appName}", key="${keyName}", default="${defaultValue}", bufSize=${nSize}, file="${fileName}")`
        );

        if (!lpReturnedString || nSize === 0) {
            return 0;
        }

        // Special case: lpAppName == NULL -> enumerate sections
        if (!lpAppName) {
            const ini = getIniData(fileName);
            if (!ini) return writeWideStringToBuffer(lpReturnedString, '', nSize);
            return enumerateSectionsWide(lpReturnedString, nSize, ini);
        }

        // Special case: lpKeyName == NULL -> enumerate keys in section
        if (!lpKeyName) {
            const ini = getIniData(fileName);
            if (!ini) return writeWideStringToBuffer(lpReturnedString, '', nSize);
            const sectionData = ini.get(appName.toLowerCase());
            if (!sectionData) return writeWideStringToBuffer(lpReturnedString, '', nSize);
            return enumerateKeysWide(lpReturnedString, nSize, sectionData);
        }

        // Normal case: read specific key
        const ini = getIniData(fileName);
        const value = ini ? getIniValue(ini, appName, keyName) : undefined;
        const result = value !== undefined ? value : defaultValue;

        if (value !== undefined) {
            Logger.verboseLazy(
                LogCategory.KERNEL32,
                () => `GetPrivateProfileStringW: [${appName}]${keyName} = "${value}" (from file)`
            );
        }

        return writeWideStringToBuffer(lpReturnedString, result, nSize);
    },

    'GetProfileStringA': (ctx, mem, args) => {
        // Same as GetPrivateProfileStringA but reads WIN.INI
        const lpAppName = args[0];
        const lpKeyName = args[1];
        const lpDefault = args[2];
        const lpReturnedString = args[3];
        const nSize = args[4];

        const defaultValue = lpDefault ? Marshaler.readString(mem, lpDefault) : '';

        if (!lpReturnedString || nSize === 0) return 0;

        // WIN.INI doesn't exist in our emulation, return default
        return writeStringToBuffer(mem, lpReturnedString, defaultValue, nSize);
    },

    'GetProfileIntA': (ctx, mem, args) => {
        // Same as GetPrivateProfileIntA but reads WIN.INI
        const nDefault = args[2];
        return nDefault;
    },
};
