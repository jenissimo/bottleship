// SetDllDirectory / AddDllDirectory / RemoveDllDirectory / SetDefaultDllDirectories /
// SetSearchPathMode. The state and the search order it produces live in
// core/dll-search-order.ts, which the PE loader probes for every bare DLL name.

import type { ThunkImplementation } from '../../../core/thunking/thunk-dispatcher';
import { System } from '../../../core/system';
import { Marshaler } from '../../../core/memory/marshaler';
import {
    addDllDirectory,
    removeDllDirectory,
    setDefaultDllDirectories,
    setDllDirectory,
    setSearchPathMode,
} from '../../../core/dll-search-order';
import { readStringA } from '../file-io-strings';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;

function fail(code: number): number {
    System.getInstance().scheduler.setLastError(code);
    return 0;
}

/** RtlDetermineDosPathNameType_U: drive-absolute, rooted, UNC or device path. */
function isAbsoluteDosPath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);
}

export const exports: Record<string, ThunkImplementation> = {
    // BOOL SetDllDirectoryW(LPCWSTR lpPathName): NULL restores the standard order, ""
    // removes the current directory from it, a path takes the current directory's slot.
    'SetDllDirectoryW': (_ctx, mem, args) => {
        setDllDirectory(args[0] ? Marshaler.readStringW(mem, args[0]) : null);
        return 1;
    },

    'SetDllDirectoryA': (_ctx, mem, args) => {
        setDllDirectory(args[0] ? readStringA(mem, args[0], 0x7fff) : null);
        return 1;
    },

    // DLL_DIRECTORY_COOKIE AddDllDirectory(PCWSTR NewDirectory): an absolute path to an
    // existing directory, searched under LOAD_LIBRARY_SEARCH_USER_DIRS.
    'AddDllDirectory': (_ctx, mem, args) => {
        const dir = args[0] ? Marshaler.readStringW(mem, args[0]) : '';
        if (!isAbsoluteDosPath(dir)) return fail(ERROR_INVALID_PARAMETER);
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(dir);
        if (!vfs.directoryExists(resolved)) {
            const cut = resolved.replace(/\\+$/, '').lastIndexOf('\\');
            const parent = cut > 2 ? resolved.slice(0, cut) : resolved.slice(0, 3);
            return fail(vfs.directoryExists(parent) ? ERROR_FILE_NOT_FOUND : ERROR_PATH_NOT_FOUND);
        }
        return addDllDirectory(resolved);
    },

    // BOOL RemoveDllDirectory(DLL_DIRECTORY_COOKIE Cookie)
    'RemoveDllDirectory': (_ctx, _mem, args) =>
        removeDllDirectory(args[0]!) ? 1 : fail(ERROR_INVALID_PARAMETER),

    // BOOL SetDefaultDllDirectories(DWORD DirectoryFlags)
    'SetDefaultDllDirectories': (_ctx, _mem, args) =>
        setDefaultDllDirectories(args[0]!) ? 1 : fail(ERROR_INVALID_PARAMETER),

    // BOOL SetSearchPathMode(DWORD Flags) — governs SearchPath, not LoadLibrary.
    'SetSearchPathMode': (_ctx, _mem, args) => {
        switch (setSearchPathMode(args[0]!)) {
            case 'ok': return 1;
            case 'denied': return fail(ERROR_ACCESS_DENIED);
            default: return fail(ERROR_INVALID_PARAMETER);
        }
    },
};
