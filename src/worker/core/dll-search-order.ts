// Process-wide DLL search configuration: SetDllDirectory, AddDllDirectory /
// RemoveDllDirectory, SetDefaultDllDirectories and SetSearchPathMode, and the directory
// list the loader probes for a bare DLL name under them.
//
// Owned here rather than in kernel32 because the PE loader resolves static imports of
// runtime-loaded DLLs through the same list LoadLibrary does.

export const LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008;
export const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR = 0x00000100;
export const LOAD_LIBRARY_SEARCH_APPLICATION_DIR = 0x00000200;
export const LOAD_LIBRARY_SEARCH_USER_DIRS = 0x00000400;
export const LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
export const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS = 0x00001000;

const SEARCH_FLAGS = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_APPLICATION_DIR
    | LOAD_LIBRARY_SEARCH_USER_DIRS | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
/** DLL_LOAD_DIR names the directory of the DLL being loaded — meaningless as a default. */
const DEFAULT_DIR_FLAGS = SEARCH_FLAGS & ~LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR;

export const BASE_SEARCH_PATH_ENABLE_SAFE_SEARCHMODE = 0x00001;
export const BASE_SEARCH_PATH_DISABLE_SAFE_SEARCHMODE = 0x10000;
export const BASE_SEARCH_PATH_PERMANENT = 0x08000;

export const SYSTEM32_DIR = 'C:\\WINDOWS\\SYSTEM32\\';
const SYSTEM_DIRS = [SYSTEM32_DIR, 'C:\\WINDOWS\\SYSTEM\\', 'C:\\WINDOWS\\'];

interface UserDir { cookie: number; dir: string; }

const state = {
    /** SetDllDirectory: null = never set / reset to default; "" = current dir removed. */
    dllDirectory: null as string | null,
    /** AddDllDirectory, most recent first (the loader's list_add_head). */
    userDirs: [] as UserDir[],
    nextCookie: 1,
    defaultSearchFlags: 0,
    /** SetSearchPathMode: 0 off, 1 on, 2 on and locked. */
    searchPathSafeMode: 0,
};

export function resetDllSearchState(): void {
    state.dllDirectory = null;
    state.userDirs = [];
    state.nextCookie = 1;
    state.defaultSearchFlags = 0;
    state.searchPathSafeMode = 0;
}

/** "C:\dir" and "C:\dir\" are one directory; keep one spelling, with the separator. */
function withSlash(dir: string): string {
    const d = dir.replace(/\//g, '\\');
    return d.endsWith('\\') ? d : `${d}\\`;
}

export function setDllDirectory(dir: string | null): void {
    state.dllDirectory = dir;
}

export function getDllDirectory(): string | null {
    return state.dllDirectory;
}

/**
 * The cookie a DLL_DIRECTORY_COOKIE stands for. Opaque to the guest; never 0, which is the
 * failure return.
 */
export function addDllDirectory(dir: string): number {
    const cookie = 0x00dd0000 + (state.nextCookie++) * 4;
    state.userDirs.unshift({ cookie, dir: withSlash(dir) });
    return cookie;
}

export function removeDllDirectory(cookie: number): boolean {
    const i = state.userDirs.findIndex((u) => u.cookie === cookie >>> 0);
    if (i < 0) return false;
    state.userDirs.splice(i, 1);
    return true;
}

export function userDllDirectories(): string[] {
    return state.userDirs.map((u) => u.dir);
}

/** LdrSetDefaultDllDirectories: a non-empty subset of the default-able search flags. */
export function setDefaultDllDirectories(flags: number): boolean {
    if (!flags || (flags & ~DEFAULT_DIR_FLAGS)) return false;
    state.defaultSearchFlags = flags >>> 0;
    return true;
}

export type SearchPathModeResult = 'ok' | 'invalid' | 'denied';

/** RtlSetSearchPathMode. Once enabled permanently the mode can no longer change. */
export function setSearchPathMode(flags: number): SearchPathModeResult {
    let val: number;
    switch (flags >>> 0) {
        case BASE_SEARCH_PATH_ENABLE_SAFE_SEARCHMODE: val = 1; break;
        case BASE_SEARCH_PATH_DISABLE_SAFE_SEARCHMODE: val = 0; break;
        case BASE_SEARCH_PATH_ENABLE_SAFE_SEARCHMODE | BASE_SEARCH_PATH_PERMANENT:
            state.searchPathSafeMode = 2;
            return 'ok';
        default:
            return 'invalid';
    }
    if (state.searchPathSafeMode === 2) return 'denied';
    state.searchPathSafeMode = val;
    return 'ok';
}

/** SearchPath's process-wide safe mode: the current directory is searched after the system ones. */
export function searchPathSafeMode(): boolean {
    return state.searchPathSafeMode !== 0;
}

/**
 * Whether LoadLibraryEx flags are a legal combination: ALTERED_SEARCH_PATH excludes the
 * LOAD_LIBRARY_SEARCH_* family, and SEARCH_DLL_LOAD_DIR needs a fully qualified name.
 */
export function validLoadLibrarySearchFlags(flags: number, name: string): boolean {
    if ((flags & LOAD_WITH_ALTERED_SEARCH_PATH) && (flags & SEARCH_FLAGS)) return false;
    if ((flags & LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR) && !isFullyQualified(name)) return false;
    return true;
}

function isFullyQualified(name: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(name) || /^[\\/]{2}/.test(name);
}

export interface DllSearchContext {
    /** Directory of the process image, with trailing separator. */
    appDir: string;
    /** Current directory, with trailing separator. */
    currentDir: string;
    /** LoadLibraryEx dwFlags (0 for implicit loads). */
    loadFlags?: number;
}

/**
 * The directories probed, in order, for a DLL named without a path.
 *
 * With LOAD_LIBRARY_SEARCH_* in effect (from the call, else SetDefaultDllDirectories) only
 * the named directories are searched: application dir, AddDllDirectory dirs then the
 * SetDllDirectory dir, System32 — never the current directory. Otherwise it is the
 * standard order, where SetDllDirectory's directory takes the current directory's place
 * right after the application directory, and SetDllDirectory("") drops that slot.
 */
export function dllSearchDirectories(ctx: DllSearchContext): string[] {
    let flags = (ctx.loadFlags ?? 0) >>> 0;
    if (!(flags & LOAD_WITH_ALTERED_SEARCH_PATH) && !(flags & SEARCH_FLAGS)) flags |= state.defaultSearchFlags;
    const appDir = withSlash(ctx.appDir);
    const dirs: string[] = [];
    const push = (d: string) => {
        const w = withSlash(d);
        if (!dirs.some((x) => x.toLowerCase() === w.toLowerCase())) dirs.push(w);
    };

    if (flags & SEARCH_FLAGS) {
        if (flags & LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) {
            flags |= LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_USER_DIRS | LOAD_LIBRARY_SEARCH_SYSTEM32;
        }
        if (flags & LOAD_LIBRARY_SEARCH_APPLICATION_DIR) push(appDir);
        if (flags & LOAD_LIBRARY_SEARCH_USER_DIRS) {
            for (const u of state.userDirs) push(u.dir);
            if (state.dllDirectory) push(state.dllDirectory);
        }
        if (flags & LOAD_LIBRARY_SEARCH_SYSTEM32) push(SYSTEM32_DIR);
        return dirs;
    }

    push(appDir);
    if (state.dllDirectory === null) push(ctx.currentDir);
    else if (state.dllDirectory !== '') push(state.dllDirectory);
    push('C:\\');
    for (const d of SYSTEM_DIRS) push(d);
    return dirs;
}
