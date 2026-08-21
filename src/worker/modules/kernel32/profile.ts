/**
 * Kernel32 Profile (INI file) functions
 *
 * Reading and writing .ini configuration files
 * Parses INI files from VFS with caching
 */

import { ThunkImplementation, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import type { VfsFileHandle } from '../../runtime/filesystem/vfs';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import { encodeAnsi } from '../codepage-utils';

// Parsed INI file: section name -> key -> value (all case-insensitive)
type IniData = Map<string, Map<string, string>>;

// Cache: normalized file path -> parsed data
const iniCache = new Map<string, IniData>();
// Raw file text per normalized path. Windows edits the FILE, not a model of it: comments,
// key order and unknown sections all survive a WritePrivateProfileString, and an app that
// hand-edits its own ini alongside the API must not have the rest of it rewritten away.
const iniText = new Map<string, string>();

export function resetIniCache(): void {
    iniCache.clear();
    iniText.clear();
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

interface IniLookup {
    ini: IniData | null;
    /** Set when the file is present but its bytes need an async read to finish. */
    pending?: { handle: VfsFileHandle; fileSize: number; cacheKey: string };
}

/**
 * Read and parse an INI file from VFS, with caching
 */
function lookupIniData(fileName: string): IniLookup {
    const system = System.getInstance();
    const vfs = system.fileSystem;

    const resolved = vfs.resolvePath(fileName);
    const cacheKey = resolved.toLowerCase();

    const cached = iniCache.get(cacheKey);
    if (cached) return { ini: cached };

    // Try to open and read the file synchronously
    const handle = vfs.openSync(fileName, 0x80000000 /* GENERIC_READ */, 3 /* OPEN_EXISTING */);
    if (!handle) {
        // Genuinely absent — negative-cache to avoid repeated index lookups.
        Logger.verbose(LogCategory.KERNEL32, `INI: file not found: "${fileName}"`);
        iniCache.set(cacheKey, new Map());
        return { ini: null };
    }

    const fileSize = vfs.getFileSize(handle.path);
    if (fileSize <= 0) {
        // Genuinely empty file — negative-cache is correct.
        iniCache.set(cacheKey, new Map());
        return { ini: null };
    }

    const data = vfs.readSync(handle, fileSize);
    if (!data || data.length < fileSize) {
        // File exists with size>0 but the sync read came up short: the blocks are not
        // resident yet. NOT an empty file, so don't negative-cache — and don't answer
        // either. The caller finishes the read asynchronously (see withIniData).
        Logger.verbose(LogCategory.KERNEL32, `INI: sync-read miss, deferring to async: "${fileName}" (got ${data?.length ?? 0}/${fileSize})`);
        return { ini: null, pending: { handle, fileSize, cacheKey } };
    }

    return { ini: cacheParsedIni(cacheKey, fileName, data) };
}

function cacheParsedIni(cacheKey: string, fileName: string, data: Uint8Array): IniData {
    const text = new TextDecoder('latin1').decode(data);
    const parsed = parseIniContent(text);
    Logger.log(LogCategory.KERNEL32, `INI: parsed "${fileName}" -> ${parsed.size} sections`);
    iniCache.set(cacheKey, parsed);
    iniText.set(cacheKey, text);
    return parsed;
}

/**
 * Apply one WritePrivateProfileString edit to raw INI text, Win32-style.
 *
 * `key === null` deletes the whole section; `value === null` deletes the key. A key set in
 * a section that exists is rewritten IN PLACE (order and comments preserved); a new key is
 * appended to the end of its section, and a new section to the end of the file.
 */
function applyIniEdit(text: string, section: string, key: string | null, value: string | null): string {
    const eol = text.includes('\r\n') || text === '' ? '\r\n' : '\n';
    const lines = text.length ? text.split(/\r?\n/) : [];
    const isHeader = (l: string): RegExpMatchArray | null => l.trim().match(/^\[([^\]]*)\]$/);
    const want = section.toLowerCase();

    let start = -1;   // index of the section header
    let end = lines.length; // first line past the section body
    for (let i = 0; i < lines.length; i++) {
        const h = isHeader(lines[i]);
        if (!h) continue;
        if (start === -1 && h[1].trim().toLowerCase() === want) start = i;
        else if (start !== -1) { end = i; break; }
    }

    if (key === null) {
        if (start === -1) return text;
        lines.splice(start, end - start);
        return lines.join(eol);
    }

    const wantKey = key.toLowerCase();
    if (start !== -1) {
        for (let i = start + 1; i < end; i++) {
            const eq = lines[i].indexOf('=');
            if (eq === -1 || lines[i].trim().startsWith(';') || lines[i].trim().startsWith('#')) continue;
            if (lines[i].slice(0, eq).trim().toLowerCase() !== wantKey) continue;
            if (value === null) lines.splice(i, 1);
            else lines[i] = `${key}=${value}`;
            return lines.join(eol);
        }
        if (value === null) return text;
        // Append inside the section, before the blank lines that separate it from the next.
        let at = end;
        while (at > start + 1 && lines[at - 1].trim() === '') at--;
        lines.splice(at, 0, `${key}=${value}`);
        return lines.join(eol);
    }

    if (value === null) return text;
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(`[${section}]`, `${key}=${value}`, '');
    return lines.join(eol);
}

/**
 * WritePrivateProfileString — the real thing: edit the file on disk.
 *
 * Returning TRUE while only touching an in-memory model is a wrong answer the caller cannot
 * detect: the write "succeeds", nothing lands, and every setting is lost the moment the
 * process (or the page) goes away. Games hand their whole detected-hardware/graphics config
 * over this API and read it back in a LATER process, so the file is the contract.
 */
/** Guest ANSI string -> the one-char-per-byte form the ini text is held in. */
function toLatin1(value: string): string {
    return new TextDecoder('latin1').decode(encodeAnsi(value));
}

function writeIniValue(
    fileName: string | null, section: string | null, key: string | null, value: string | null,
    who: string,
): number {
    // lpAppName === NULL is "flush my cached writes" — we never defer, so it is already true.
    if (!fileName || section === null) return 1;

    const vfs = System.getInstance().fileSystem;
    const resolved = vfs.resolvePath(fileName);
    const cacheKey = resolved.toLowerCase();

    let text = iniText.get(cacheKey);
    if (text === undefined) {
        // Not read yet this session. Pull the current bytes so unrelated content survives.
        // A sync read can MISS on a file that exists — an active writer's buffer that cannot
        // serve the range, a pending flush, no handle in the LRU cache — and the write below
        // is CREATE_ALWAYS. Treating a miss as "empty file" would truncate a 200-line ini to
        // the one key being written, which is exactly the wrong answer a caller cannot detect.
        // Absent is the only case an edit may legitimately create from nothing.
        const handle = vfs.openSync(fileName, 0x80000000 /* GENERIC_READ */, 3 /* OPEN_EXISTING */);
        if (!handle) {
            text = '';
        } else {
            const size = vfs.getFileSize(handle.path);
            if (size <= 0) {
                text = '';
            } else {
                const data = vfs.readSync(handle, size);
                if (!data || data.length < size) {
                    Logger.warn(LogCategory.KERNEL32,
                        `${who}: refusing to rewrite "${resolved}" — its ${size} bytes are not readable synchronously right now (would truncate)`);
                    return 0;
                }
                text = new TextDecoder('latin1').decode(data);
            }
        }
    }

    // The file is held as latin1, i.e. one char per byte, so bytes we did not touch survive
    // verbatim. The incoming strings arrive decoded from the guest's ANSI codepage, so they
    // have to be re-encoded to bytes before being spliced into that representation — otherwise
    // a cp1251 value round-trips through encodeAnsi's '?' substitution.
    const updated = applyIniEdit(text, toLatin1(section), key === null ? null : toLatin1(key), value === null ? null : toLatin1(value));
    iniText.set(cacheKey, updated);
    iniCache.set(cacheKey, parseIniContent(updated));

    const out = vfs.openSync(fileName, 0x40000000 /* GENERIC_WRITE */, 2 /* CREATE_ALWAYS */);
    if (!out) {
        Logger.warn(LogCategory.KERNEL32, `${who}: cannot open "${resolved}" for write`);
        return 0;
    }
    const bytes = Uint8Array.from(updated, (ch) => ch.charCodeAt(0) & 0xff);
    const written = vfs.writeSync(out, bytes);
    if (written < 0) {
        Logger.warn(LogCategory.KERNEL32, `${who}: write to "${resolved}" failed`);
        return 0;
    }
    return 1;
}

/**
 * Answer an INI query, finishing the file read asynchronously when its bytes are not yet
 * resident. Windows always reads the file, so handing back the caller's default on a
 * transient miss is a wrong answer that is indistinguishable from "key absent" at the
 * call site — a launcher reads its config once at startup and renders empty forever.
 * The resident case stays fully synchronous.
 */
function withIniData(
    fileName: string,
    stackCleanup: number,
    produce: (ini: IniData | null) => number,
): number | Promise<ThunkResult> {
    const lookup = lookupIniData(fileName);
    if (!lookup.pending) return produce(lookup.ini);

    const { handle, fileSize, cacheKey } = lookup.pending;
    return (async (): Promise<ThunkResult> => {
        let ini: IniData | null = null;
        try {
            // The sync attempt already advanced `handle`'s cursor by whatever it got, and that
            // cursor is the file OBJECT's state (CLAUDE.md §3.2). Re-read from a PRIVATE cursor
            // at offset 0 instead — reusing the handle reads from the wrong offset, comes up
            // short, and hands the caller the default we exist to avoid.
            const vfs = System.getInstance().fileSystem;
            const data = await vfs.read(vfs.duplicateHandle(handle, 0), fileSize);
            ini = data && data.length >= fileSize
                ? cacheParsedIni(cacheKey, fileName, data)
                : null;
            if (!ini) {
                Logger.warn(LogCategory.KERNEL32,
                    `INI: async read still short for "${fileName}" (${data?.length ?? 0}/${fileSize})`);
            }
        } catch (e) {
            Logger.warn(LogCategory.KERNEL32, `INI: async read failed for "${fileName}": ${e}`);
        }
        return { value: produce(ini), stackCleanup };
    })();
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

        return withIniData(fileName, 24, (ini) => {
            // lpAppName == NULL -> enumerate sections
            if (!lpAppName) {
                if (!ini) return writeStringToBuffer(mem, lpReturnedString, '', nSize);
                return enumerateSections(mem, lpReturnedString, nSize, ini);
            }

            // lpKeyName == NULL -> enumerate keys in section
            if (!lpKeyName) {
                if (!ini) return writeStringToBuffer(mem, lpReturnedString, '', nSize);
                const sectionData = ini.get(appName.toLowerCase());
                if (!sectionData) return writeStringToBuffer(mem, lpReturnedString, '', nSize);
                return enumerateKeys(mem, lpReturnedString, nSize, sectionData);
            }

            const value = ini ? getIniValue(ini, appName, keyName) : undefined;
            if (value !== undefined) {
                Logger.verboseLazy(
                    LogCategory.KERNEL32,
                    () => `GetPrivateProfileStringA: [${appName}]${keyName} = "${value}" (from file)`
                );
            }
            return writeStringToBuffer(mem, lpReturnedString, value !== undefined ? value : defaultValue, nSize);
        });
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

        return withIniData(fileName, 16, (ini) => {
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
        });
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

        return withIniData(fileName, 16, (ini) => {
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
        });
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

        return writeIniValue(fileName, section, key, value, 'WritePrivateProfileStringA');
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

        return writeIniValue(fileName, section, key, value, 'WritePrivateProfileStringW');
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

        return withIniData(fileName, 24, (ini) => {
            if (!lpAppName) {
                if (!ini) return writeWideStringToBuffer(lpReturnedString, '', nSize);
                return enumerateSectionsWide(lpReturnedString, nSize, ini);
            }

            if (!lpKeyName) {
                if (!ini) return writeWideStringToBuffer(lpReturnedString, '', nSize);
                const sectionData = ini.get(appName.toLowerCase());
                if (!sectionData) return writeWideStringToBuffer(lpReturnedString, '', nSize);
                return enumerateKeysWide(lpReturnedString, nSize, sectionData);
            }

            const value = ini ? getIniValue(ini, appName, keyName) : undefined;
            if (value !== undefined) {
                Logger.verboseLazy(
                    LogCategory.KERNEL32,
                    () => `GetPrivateProfileStringW: [${appName}]${keyName} = "${value}" (from file)`
                );
            }
            return writeWideStringToBuffer(lpReturnedString, value !== undefined ? value : defaultValue, nSize);
        });
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
