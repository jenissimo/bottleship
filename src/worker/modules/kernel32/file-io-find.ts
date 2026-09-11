/**
 * kernel32 directory-enumeration handlers (FindFirstFile/FindNextFile/FindClose
 * families) plus their pattern-matching and WIN32_FIND_DATA fill helpers.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { encodeAnsi } from '../codepage-utils';
import { readStringA, readStringW } from './file-io-strings';

const INVALID_HANDLE_VALUE = -1;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NO_MORE_FILES = 18;

/** FINDEX_INFO_LEVELS / FINDEX_SEARCH_OPS. */
const FIND_EX_INFO_BASIC = 1;
const FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES = 1;
const FIND_EX_SEARCH_LIMIT_TO_DEVICES = 2;

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_ARCHIVE = 0x20;
const WIN32_FIND_DATAA_SIZE = 320;
const WIN32_FIND_DATAW_SIZE = 592;

const patternToRegex = (pattern: string): RegExp => {
    // Special cases for Windows file masks
    if (pattern === '*.*' || pattern === '*') return /^.*$/i;
    if (pattern === '*.') return /^[^.]*$/i; // Files without extension

    // Handle patterns like "test.*" or "*_pa.*" — extension optional; wildcards in base.
    if (pattern.endsWith('.*')) {
        const basePattern = pattern.slice(0, -2);
        const escaped = basePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(`^${withWildcards}(\\..*)?$`, 'i');
    }

    // Standard escaping and wildcards
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${withWildcards}$`, 'i');
};

const splitFindPattern = (rawPattern: string): { searchPath: string; searchMask: string } => {
    const pattern = rawPattern.replace(/\//g, '\\');

    let searchPath = pattern;
    let searchMask = '*';

    const lastSlash = pattern.lastIndexOf('\\');
    if (lastSlash !== -1) {
        searchPath = pattern.substring(0, lastSlash);
        searchMask = pattern.substring(lastSlash + 1) || '*';
    } else {
        // Drive-relative form: "C:FILE.TXT" means search on drive C: with mask FILE.TXT
        const driveRelative = pattern.match(/^([A-Za-z]):(.*)$/);
        if (driveRelative) {
            const drive = driveRelative[1]!.toUpperCase();
            const tail = driveRelative[2] ?? '';
            searchPath = `${drive}:`;
            searchMask = tail.length > 0 ? tail : '*';
        } else {
            searchPath = '.';
            searchMask = pattern;
        }
    }

    if (searchPath === '') searchPath = '\\';
    // "C:\*.gro" splits to a bare "C:", which is drive-RELATIVE (the drive's current
    // directory) — put the separator back so the root is searched, not the CWD.
    if (/^[A-Za-z]:$/.test(searchPath) && lastSlash !== -1) searchPath += '\\';
    if (searchMask === '') searchMask = '*';
    return { searchPath, searchMask };
};

const fillFindDataA = (mem: Uint8Array, addr: number, entry: any) => {
    // Keep ABI-compatible layout and avoid leaking stale heap bytes.
    mem.fill(0, addr, Math.min(addr + WIN32_FIND_DATAA_SIZE, mem.length));
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(addr, entry.kind === 'dir' ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE, true);
    // Times (stubs)
    view.setBigUint64(addr + 4, 0n, true);
    view.setBigUint64(addr + 12, 0n, true);
    view.setBigUint64(addr + 20, 0n, true);
    view.setUint32(addr + 28, Math.floor(entry.size / 0x100000000), true);
    view.setUint32(addr + 32, entry.size >>> 0, true);

    // FileName (A) - limit to 259 chars + null
    const name = entry.name.substring(0, 259);
    const nameBytes = encodeAnsi(name + '\0');
    mem.set(nameBytes, addr + 44);
};

const fillFindDataW = (mem: Uint8Array, addr: number, entry: any) => {
    // Keep ABI-compatible layout and avoid leaking stale heap bytes.
    mem.fill(0, addr, Math.min(addr + WIN32_FIND_DATAW_SIZE, mem.length));
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(addr, entry.kind === 'dir' ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE, true);
    // Times (stubs)
    view.setBigUint64(addr + 4, 0n, true);
    view.setBigUint64(addr + 12, 0n, true);
    view.setBigUint64(addr + 20, 0n, true);
    view.setUint32(addr + 28, Math.floor(entry.size / 0x100000000), true);
    view.setUint32(addr + 32, entry.size >>> 0, true);

    // FileName (W) - limit to 259 chars + null
    const name = entry.name.substring(0, 259);
    for (let i = 0; i < name.length; i++) {
        view.setUint16(addr + 44 + i * 2, name.charCodeAt(i), true);
    }
    view.setUint16(addr + 44 + name.length * 2, 0, true);
};

export function registerFileIoFindExports(exports: Record<string, ThunkImplementation>): void {
    exports['FindFirstFileA'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const lpFindFileData = args[1];

        const pattern = lpFileName ? readStringA(mem, lpFileName) : '';

        if (!lpFindFileData) {
            Logger.log(LogCategory.KERNEL32, `FindFirstFileA("${pattern}") -> INVALID (null lpFindFileData)`);
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return INVALID_HANDLE_VALUE;
        }

        const vfs = System.getInstance().fileSystem;

        // Fast path: an explicit path with no wildcard is an existence check, not an
        // enumeration. Stat it directly (O(1)) instead of scanning the whole ROM index.
        const exactPath = pattern.replace(/\//g, '\\');
        if (exactPath.includes('\\') && !/[*?]/.test(exactPath)) {
            const entry = vfs.statEntry(exactPath);
            if (!entry) {
                System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
                return INVALID_HANDLE_VALUE;
            }
            fillFindDataA(mem, lpFindFileData, entry);
            const handleId = System.getInstance().resourceProvider.registerKernelObject({
                kind: 'find' as const,
                entries: [entry],
                index: 1,
            });
            Logger.log(LogCategory.KERNEL32, `FindFirstFileA("${pattern}") -> handle=0x${handleId.toString(16)} first="${entry.name}" (exact)`);
            return handleId;
        }

        const { searchPath, searchMask } = splitFindPattern(pattern);

        const entries = vfs.listDirectory(searchPath);
        const regex = patternToRegex(searchMask);
        const matches = entries.filter(e => regex.test(e.name));

        if (matches.length === 0) {
            Logger.log(LogCategory.KERNEL32, `FindFirstFileA("${pattern}") -> NOT FOUND (searchPath="${searchPath}", mask="${searchMask}", cwd="${vfs.currentDir}")`);
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }

        fillFindDataA(mem, lpFindFileData, matches[0]);

        const findHandle = {
            kind: 'find' as const,
            entries: matches,
            index: 1 // Next index to return
        };

        const handleId = System.getInstance().resourceProvider.registerKernelObject(findHandle);
        Logger.log(LogCategory.KERNEL32, `FindFirstFileA("${pattern}") -> handle=0x${handleId.toString(16)} first="${matches[0].name}" (${matches.length} match${matches.length === 1 ? '' : 'es'})`);
        return handleId;
    };

    exports['FindFirstFileW'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const lpFindFileData = args[1];

        const pattern = lpFileName ? readStringW(mem, lpFileName) : '';
        Logger.log(LogCategory.KERNEL32, `FindFirstFileW("${pattern}")`);

        if (!lpFindFileData) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return INVALID_HANDLE_VALUE;
        }

        const vfs = System.getInstance().fileSystem;

        // Fast path: explicit path, no wildcard → direct stat (see FindFirstFileA).
        const exactPath = pattern.replace(/\//g, '\\');
        if (exactPath.includes('\\') && !/[*?]/.test(exactPath)) {
            const entry = vfs.statEntry(exactPath);
            if (!entry) {
                System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
                return INVALID_HANDLE_VALUE;
            }
            fillFindDataW(mem, lpFindFileData, entry);
            return System.getInstance().resourceProvider.registerKernelObject({
                kind: 'find' as const,
                entries: [entry],
                index: 1,
            });
        }

        const { searchPath, searchMask } = splitFindPattern(pattern);

        const entries = vfs.listDirectory(searchPath);
        const regex = patternToRegex(searchMask);
        const matches = entries.filter(e => regex.test(e.name));

        if (matches.length === 0) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }

        fillFindDataW(mem, lpFindFileData, matches[0]);

        const findHandle = {
            kind: 'find' as const,
            entries: matches,
            index: 1
        };

        const handleId = System.getInstance().resourceProvider.registerKernelObject(findHandle);
        return handleId;
    };

    /**
     * FindFirstFileEx adds an info level, a search op and a filter to FindFirstFile.
     * The op is NOT decoration: FindExSearchLimitToDirectories makes the enumeration
     * return directories only, and a caller that asked for it and got files back walks
     * into every one of them. The unsupported values must fail rather than quietly
     * degrade into a plain name match — a caller cannot tell the difference, and
     * Windows itself refuses them.
     */
    const findFirstFileEx = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
        const lpFileName = args[0];
        const fInfoLevelId = args[1] >>> 0;
        const lpFindFileData = args[2];
        const fSearchOp = args[3] >>> 0;
        const lpSearchFilter = args[4] >>> 0;
        const name = wide ? 'FindFirstFileExW' : 'FindFirstFileExA';
        const pattern = lpFileName ? (wide ? readStringW(mem, lpFileName) : readStringA(mem, lpFileName)) : '';

        const fail = (err: number, why: string): number => {
            Logger.log(LogCategory.KERNEL32, `${name}("${pattern}") -> INVALID (${why})`);
            System.getInstance().scheduler.setLastError(err);
            return INVALID_HANDLE_VALUE;
        };

        // FindExInfoStandard / FindExInfoBasic only. Basic just omits the short name,
        // which our WIN32_FIND_DATA already leaves empty, so the two coincide here.
        if (fInfoLevelId > FIND_EX_INFO_BASIC) return fail(ERROR_INVALID_PARAMETER, `info level ${fInfoLevelId}`);
        // A filter is only meaningful for a search op that takes one, and none we
        // support does — Windows requires NULL.
        if (lpSearchFilter !== 0) return fail(ERROR_INVALID_PARAMETER, 'lpSearchFilter must be NULL');
        if (fSearchOp === FIND_EX_SEARCH_LIMIT_TO_DEVICES) {
            return fail(ERROR_INVALID_PARAMETER, 'FindExSearchLimitToDevices is not supported by Win32');
        }
        if (fSearchOp > FIND_EX_SEARCH_LIMIT_TO_DEVICES) return fail(ERROR_INVALID_PARAMETER, `search op ${fSearchOp}`);

        const base = exports[wide ? 'FindFirstFileW' : 'FindFirstFileA'];
        const handleId = base(ctx, mem, [lpFileName, lpFindFileData]) as number;
        if (fSearchOp !== FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES || handleId === INVALID_HANDLE_VALUE) {
            return handleId;
        }

        // Directories only: drop the rest from the handle the base call registered and
        // re-fill the caller's buffer from the first survivor, so FindNextFile continues
        // the same filtered walk.
        const findHandle = System.getInstance().resourceProvider.getKernelObject(handleId);
        if (!findHandle || findHandle.kind !== 'find') return handleId;
        findHandle.entries = findHandle.entries.filter((e: { kind: string }) => e.kind === 'dir');
        findHandle.index = 1;
        if (findHandle.entries.length === 0) {
            System.getInstance().resourceProvider.unregisterKernelObject(handleId);
            return fail(ERROR_FILE_NOT_FOUND, 'no directories match');
        }
        if (wide) fillFindDataW(mem, lpFindFileData, findHandle.entries[0]);
        else fillFindDataA(mem, lpFindFileData, findHandle.entries[0]);
        return handleId;
    };

    exports['FindFirstFileExA'] = findFirstFileEx(false);
    exports['FindFirstFileExW'] = findFirstFileEx(true);

    exports['FindNextFileA'] = (ctx, mem, args) => {
        const hFindFile = args[0];
        const lpFindFileData = args[1];

        Logger.verbose(LogCategory.KERNEL32, `FindNextFileA(0x${hFindFile.toString(16)})`);

        const findHandle = System.getInstance().resourceProvider.getKernelObject(hFindFile);
        if (!findHandle || findHandle.kind !== 'find') {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }

        if (findHandle.index >= findHandle.entries.length) {
            System.getInstance().scheduler.setLastError(ERROR_NO_MORE_FILES);
            return 0; // FALSE
        }

        fillFindDataA(mem, lpFindFileData, findHandle.entries[findHandle.index]);
        findHandle.index++;
        return 1; // TRUE
    };

    exports['FindNextFileW'] = (ctx, mem, args) => {
        const hFindFile = args[0];
        const lpFindFileData = args[1];

        Logger.verbose(LogCategory.KERNEL32, `FindNextFileW(0x${hFindFile.toString(16)})`);

        const findHandle = System.getInstance().resourceProvider.getKernelObject(hFindFile);
        if (!findHandle || findHandle.kind !== 'find') {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }

        if (findHandle.index >= findHandle.entries.length) {
            System.getInstance().scheduler.setLastError(ERROR_NO_MORE_FILES);
            return 0; // FALSE
        }

        fillFindDataW(mem, lpFindFileData, findHandle.entries[findHandle.index]);
        findHandle.index++;
        return 1; // TRUE
    };

    exports['FindClose'] = (ctx, mem, args) => {
        const hFindFile = args[0];

        Logger.verbose(LogCategory.KERNEL32, `FindClose(0x${hFindFile.toString(16)})`);
        System.getInstance().resourceProvider.unregisterKernelObject(hFindFile);
        return 1; // TRUE
    };
}
