/**
 * kernel32 path/directory query handlers (GetCurrentDirectory, GetFullPathName,
 * SearchPath, GetShortPathName/GetLongPathName, GetTempPath, SetCurrentDirectory)
 * plus their path-normalization helpers. All state lives in the VFS / process
 * environment.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { VirtualFileSystem } from '../../runtime/filesystem/vfs';
import { dirOfWindowsPath } from '../../runtime/filesystem/ue1-firstrun';
import { readStringA, readStringW, encodeUTF16LE, encodeFileApiString } from './file-io-strings';
import { searchPathSafeMode } from '../../core/dll-search-order';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;

const pathHasSeparator = (path: string): boolean => path.includes('\\') || path.includes('/');

const fileNameHasExtension = (fileName: string): boolean => {
    const base = fileName.split(/[\\/]/).pop() ?? fileName;
    const dot = base.lastIndexOf('.');
    return dot > 0;
};

const guestFileExists = (vfs: VirtualFileSystem, path: string): boolean => {
    const resolved = vfs.resolvePath(path);
    if (vfs.directoryExists(resolved)) return false;
    return vfs.fileExists(resolved);
};

const joinWindowsPath = (dir: string, file: string): string => {
    const d = dir.replace(/[\\/]+$/, '');
    const f = file.replace(/^[\\/]+/, '');
    if (d.length === 0) return f.replace(/\//g, '\\');
    if (d.endsWith(':')) return `${d}\\${f}`.replace(/\//g, '\\');
    return `${d}\\${f}`.replace(/\//g, '\\');
};

const collectDefaultSearchDirectories = (): string[] => {
    const system = System.getInstance();
    const vfs = system.fileSystem;
    const dirs: string[] = [];

    const exePath = system.executablePath || `C:\\${system.executableName}`;
    const appDir = dirOfWindowsPath(exePath);
    if (appDir) dirs.push(appDir);

    // SetSearchPathMode's safe mode moves the current directory behind the system ones.
    const safeMode = searchPathSafeMode();
    if (vfs?.currentDir && !safeMode) dirs.push(vfs.currentDir);

    dirs.push('C:\\WINDOWS', 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS\\SYSTEM32');
    if (vfs?.currentDir && safeMode) dirs.push(vfs.currentDir);

    const pathEnv = system.process?.environment.get('PATH');
    if (pathEnv) {
        for (const part of pathEnv.split(';')) {
            const trimmed = part.trim();
            if (trimmed) dirs.push(trimmed);
        }
    }

    return dirs;
};

const writeSearchPathResultA = (
    mem: Uint8Array,
    fullPath: string,
    nBufferLength: number,
    lpBuffer: number,
    lpFilePart: number,
): number => {
    const pathBytes = encodeFileApiString(fullPath + '\0');
    const required = pathBytes.length;

    if (nBufferLength < required) {
        return required;
    }

    if (lpBuffer) {
        mem.set(pathBytes, lpBuffer);
        if (lpFilePart && lpFilePart + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const lastSlash = fullPath.lastIndexOf('\\');
            if (lastSlash >= 0 && lastSlash < fullPath.length - 1) {
                view.setUint32(lpFilePart, lpBuffer + lastSlash + 1, true);
            } else {
                view.setUint32(lpFilePart, lpBuffer, true);
            }
        }
    }

    return required - 1;
};

export function registerFileIoPathExports(exports: Record<string, ThunkImplementation>): void {
    exports['GetCurrentDirectoryA'] = (ctx, mem, args) => {
        const nBufferLength = args[0];
        const lpBuffer = args[1];

        Logger.verbose(LogCategory.KERNEL32, `GetCurrentDirectoryA(${nBufferLength})`);

        let currentDir = System.getInstance().fileSystem.currentDir || 'C:\\';
        // Many old games expect trailing backslash and concatenate filenames directly
        // Add trailing backslash for compatibility (technically wrong per Windows spec, but works)
        if (!currentDir.endsWith('\\')) {
            currentDir += '\\';
        }

        const dirBytes = encodeFileApiString(currentDir + '\0');

        if (nBufferLength < dirBytes.length) {
            return dirBytes.length; // Required buffer size
        }

        mem.set(dirBytes, lpBuffer);
        Logger.verbose(LogCategory.KERNEL32, `GetCurrentDirectoryA -> "${currentDir}"`);
        return dirBytes.length - 1; // Length without null terminator
    };

    exports['GetCurrentDirectoryW'] = (ctx, mem, args) => {
        const nBufferLength = args[0];
        const lpBuffer = args[1];

        Logger.verbose(LogCategory.KERNEL32, `GetCurrentDirectoryW(${nBufferLength})`);

        let currentDir = System.getInstance().fileSystem.currentDir || 'C:\\';
        // Many old games expect trailing backslash - add for compatibility
        if (!currentDir.endsWith('\\')) {
            currentDir += '\\';
        }

        const dirBytes = encodeUTF16LE(currentDir);
        const dirLengthChars = dirBytes.length / 2 - 1; // Length without null terminator (in characters)

        if (nBufferLength < dirLengthChars + 1) {
            return dirLengthChars + 1; // Required buffer size in characters (including null terminator)
        }

        if (lpBuffer) {
            mem.set(dirBytes, lpBuffer);
        }
        Logger.verbose(LogCategory.KERNEL32, `GetCurrentDirectoryW -> "${currentDir}"`);
        return dirLengthChars; // Length without null terminator (in characters)
    };

    exports['GetFullPathNameA'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const nBufferLength = args[1];
        const lpBuffer = args[2];
        const lpFilePart = args[3];

        const fileName = lpFileName ? readStringA(mem, lpFileName) : '';
        Logger.verbose(LogCategory.KERNEL32, `GetFullPathNameA("${fileName}", ${nBufferLength})`);

        // Check if input ends with backslash (directory path) - we need to preserve this
        const endsWithSlash = fileName.endsWith('\\') || fileName.endsWith('/');

        // Build full path
        let fullPath: string;
        if (fileName.length >= 2 && fileName[1] === ':') {
            // Already absolute path (e.g., "C:\...")
            fullPath = fileName;
        } else if (fileName.startsWith('\\') || fileName.startsWith('/')) {
            // Root-relative path
            const currentDir = System.getInstance().fileSystem?.currentDir || 'C:\\';
            const drive = currentDir.substring(0, 2); // "C:"
            fullPath = drive + fileName.replace(/\//g, '\\');
        } else {
            // Relative path
            const currentDir = System.getInstance().fileSystem?.currentDir || 'C:\\';
            const base = currentDir.endsWith('\\') ? currentDir : currentDir + '\\';
            fullPath = base + fileName.replace(/\//g, '\\');
        }

        // Normalize path (remove . and ..)
        const parts = fullPath.split(/[\\/]/);
        const normalized: string[] = [];
        for (const part of parts) {
            if (part === '..') {
                if (normalized.length > 1) normalized.pop();
            } else if (part !== '.' && part !== '') {
                normalized.push(part);
            }
        }
        fullPath = normalized.join('\\');
        if (fullPath.length === 2 && fullPath[1] === ':') {
            fullPath += '\\'; // Root of drive
        }

        // Preserve trailing backslash if input had one (directory path)
        if (endsWithSlash && !fullPath.endsWith('\\')) {
            fullPath += '\\';
        }

        Logger.verbose(LogCategory.KERNEL32, `GetFullPathNameA("${fileName}") -> "${fullPath}"`);
        const pathBytes = encodeFileApiString(fullPath + '\0');

        if (nBufferLength < pathBytes.length) {
            return pathBytes.length; // Required size
        }

        if (lpBuffer) {
            mem.set(pathBytes, lpBuffer);

            // Set lpFilePart to point to filename portion (NULL if path ends with backslash)
            if (lpFilePart && lpFilePart + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                if (fullPath.endsWith('\\')) {
                    // Directory path - no file part
                    view.setUint32(lpFilePart, 0, true);
                } else {
                    const lastSlash = fullPath.lastIndexOf('\\');
                    if (lastSlash >= 0 && lastSlash < fullPath.length - 1) {
                        view.setUint32(lpFilePart, lpBuffer + lastSlash + 1, true);
                    } else {
                        view.setUint32(lpFilePart, 0, true);
                    }
                }
            }
        }

        return pathBytes.length - 1; // Length without null terminator
    };

    // DWORD GetFullPathNameW(LPCWSTR lpFileName, DWORD nBufferLength, LPWSTR lpBuffer, LPWSTR *lpFilePart)
    exports['GetFullPathNameW'] = (ctx, mem, args) => {
        const lpFileName = args[0];
        const nBufferLength = args[1]; // in WCHARs
        const lpBuffer = args[2];
        const lpFilePart = args[3];

        const fileName = lpFileName ? readStringW(mem, lpFileName) : '';
        Logger.verbose(LogCategory.KERNEL32, `GetFullPathNameW("${fileName}", ${nBufferLength})`);

        const endsWithSlash = fileName.endsWith('\\') || fileName.endsWith('/');

        let fullPath: string;
        if (fileName.length >= 2 && fileName[1] === ':') {
            fullPath = fileName;
        } else if (fileName.startsWith('\\') || fileName.startsWith('/')) {
            const currentDir = System.getInstance().fileSystem?.currentDir || 'C:\\';
            const drive = currentDir.substring(0, 2);
            fullPath = drive + fileName.replace(/\//g, '\\');
        } else {
            const currentDir = System.getInstance().fileSystem?.currentDir || 'C:\\';
            const base = currentDir.endsWith('\\') ? currentDir : currentDir + '\\';
            fullPath = base + fileName.replace(/\//g, '\\');
        }

        const parts = fullPath.split(/[\\/]/);
        const normalized: string[] = [];
        for (const part of parts) {
            if (part === '..') {
                if (normalized.length > 1) normalized.pop();
            } else if (part !== '.' && part !== '') {
                normalized.push(part);
            }
        }
        fullPath = normalized.join('\\');
        if (fullPath.length === 2 && fullPath[1] === ':') {
            fullPath += '\\';
        }
        if (endsWithSlash && !fullPath.endsWith('\\')) {
            fullPath += '\\';
        }

        Logger.verbose(LogCategory.KERNEL32, `GetFullPathNameW("${fileName}") -> "${fullPath}"`);

        const requiredChars = fullPath.length + 1; // including null
        if (nBufferLength < requiredChars) {
            return requiredChars;
        }

        if (lpBuffer) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < fullPath.length; i++) {
                view.setUint16(lpBuffer + i * 2, fullPath.charCodeAt(i), true);
            }
            view.setUint16(lpBuffer + fullPath.length * 2, 0, true); // null terminator

            if (lpFilePart) {
                if (fullPath.endsWith('\\')) {
                    view.setUint32(lpFilePart, 0, true);
                } else {
                    const lastSlash = fullPath.lastIndexOf('\\');
                    if (lastSlash >= 0 && lastSlash < fullPath.length - 1) {
                        view.setUint32(lpFilePart, lpBuffer + (lastSlash + 1) * 2, true);
                    } else {
                        view.setUint32(lpFilePart, 0, true);
                    }
                }
            }
        }

        return fullPath.length; // length without null
    };

    // DWORD SearchPathA(lpPath, lpFileName, lpExtension, nBufferLength, lpBuffer, lpFilePart)
    exports['SearchPathA'] = (ctx, mem, args) => {
        const lpPath = args[0];
        const lpFileName = args[1];
        const lpExtension = args[2];
        const nBufferLength = args[3] >>> 0;
        const lpBuffer = args[4];
        const lpFilePart = args[5];

        if (!lpFileName) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const fileName = readStringA(mem, lpFileName);
        const extension = lpExtension ? readStringA(mem, lpExtension) : '';
        const searchPath = lpPath ? readStringA(mem, lpPath) : '';

        Logger.verbose(
            LogCategory.KERNEL32,
            `SearchPathA(path="${searchPath}", file="${fileName}", ext="${extension}")`,
        );

        const vfs = System.getInstance().fileSystem;
        if (!vfs) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }

        const tryCandidate = (candidate: string): string | null => {
            const normalized = candidate.replace(/\//g, '\\');
            return guestFileExists(vfs, normalized) ? normalized : null;
        };

        const tryFileNameVariants = (basePath: string): string | null => {
            const names = [fileName];
            if (extension && extension.startsWith('.') && !fileNameHasExtension(fileName)) {
                names.push(fileName + extension);
            }
            for (const name of names) {
                const candidate = basePath ? joinWindowsPath(basePath, name) : name.replace(/\//g, '\\');
                const hit = tryCandidate(candidate);
                if (hit) return hit;
            }
            return null;
        };

        let found: string | null = null;

        if (pathHasSeparator(fileName)) {
            found = tryFileNameVariants('');
        } else {
            const directories = searchPath
                ? searchPath.split(';').map((d) => d.trim()).filter(Boolean)
                : collectDefaultSearchDirectories();

            for (const dir of directories) {
                found = tryFileNameVariants(dir);
                if (found) break;
            }
        }

        if (!found) {
            Logger.verbose(LogCategory.KERNEL32, `SearchPathA: not found "${fileName}"`);
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }

        Logger.verbose(LogCategory.KERNEL32, `SearchPathA: found -> "${found}"`);
        return writeSearchPathResultA(mem, found, nBufferLength, lpBuffer, lpFilePart);
    };

    exports['GetShortPathNameA'] = (ctx, mem, args) => {
        const lpszLongPath = args[0];
        const lpszShortPath = args[1];
        const cchBuffer = args[2] >>> 0;

        const longPath = lpszLongPath ? readStringA(mem, lpszLongPath) : '';
        const shortPath = longPath;
        const pathBytes = encodeFileApiString(shortPath + '\0');

        if (cchBuffer < pathBytes.length) {
            return shortPath.length; // Required size (excluding null)
        }

        if (lpszShortPath) {
            Mem.writeBytes(lpszShortPath, pathBytes);
        }
        return shortPath.length;
    };

    exports['GetLongPathNameA'] = (ctx, mem, args) => {
        const lpszShortPath = args[0] >>> 0;
        const lpszLongPath = args[1] >>> 0;
        const cchBuffer = args[2] >>> 0;

        const inputPath = lpszShortPath ? readStringA(mem, lpszShortPath) : '';
        // Real Windows resolves the path to its long (fully-qualified) form. We have no 8.3
        // short names, so for ABSOLUTE inputs we echo verbatim. For RELATIVE inputs we must
        // qualify against the current directory — code that takes longPath[0] as a drive
        // letter (e.g. CD-drive detection: GetLongPathName("CD Drive"=".\")
        // expects "C:\") otherwise gets '.' and later dereferences a bogus device slot.
        const isAbsolute = (inputPath.length >= 2 && inputPath[1] === ':') || inputPath.startsWith('\\\\');
        let longPath: string;
        if (!inputPath || isAbsolute) {
            longPath = inputPath;
        } else {
            const currentDir = System.getInstance().fileSystem?.currentDir || 'C:\\';
            let full: string;
            if (inputPath.startsWith('\\') || inputPath.startsWith('/')) {
                full = currentDir.substring(0, 2) + inputPath.replace(/\//g, '\\');
            } else {
                const base = currentDir.endsWith('\\') ? currentDir : currentDir + '\\';
                full = base + inputPath.replace(/\//g, '\\');
            }
            const normalized: string[] = [];
            for (const part of full.split(/[\\/]/)) {
                if (part === '..') { if (normalized.length > 1) normalized.pop(); }
                else if (part !== '.' && part !== '') normalized.push(part);
            }
            full = normalized.join('\\');
            if (full.length === 2 && full[1] === ':') full += '\\';
            longPath = full;
        }
        const pathBytes = encodeFileApiString(longPath + '\0');

        Logger.verbose(LogCategory.KERNEL32, `GetLongPathNameA("${inputPath}") -> "${longPath}"`);

        if (cchBuffer < pathBytes.length) {
            return longPath.length;
        }

        if (lpszLongPath && Mem.writeBytes(lpszLongPath, pathBytes) !== pathBytes.length) {
            System.getInstance().scheduler.setLastError(122); // ERROR_INSUFFICIENT_BUFFER / invalid destination
            return 0;
        }

        System.getInstance().scheduler.setLastError(0);
        return longPath.length;
    };

    exports['GetTempPathA'] = (ctx, mem, args) => {
        const nBufferLength = args[0];
        const lpBuffer = args[1];

        Logger.verbose(LogCategory.KERNEL32, `GetTempPathA(${nBufferLength})`);

        const process = System.getInstance().process;
        let tempPath = 'C:\\TEMP'; // Default fallback

        if (process && process.environment) {
            const temp = process.environment.get('TEMP');
            if (temp) {
                tempPath = temp;
            }
        }

        // Ensure path ends with backslash (Windows convention for GetTempPathA)
        if (!tempPath.endsWith('\\')) {
            tempPath += '\\';
        }

        const pathBytes = encodeFileApiString(tempPath + '\0');

        // Windows API behavior: if buffer is too small, return required size without writing
        if (nBufferLength < pathBytes.length) {
            return pathBytes.length; // Required buffer size
        }

        // Buffer is large enough - write string with null terminator
        if (lpBuffer) {
            mem.set(pathBytes, lpBuffer);
        }

        return pathBytes.length - 1; // Length without null terminator
    };

    exports['GetTempPathW'] = (ctx, mem, args) => {
        const nBufferLength = args[0]; // in WCHARs
        const lpBuffer = args[1];

        const process = System.getInstance().process;
        let tempPath = 'C:\\TEMP';

        if (process && process.environment) {
            const temp = process.environment.get('TEMP');
            if (temp) {
                tempPath = temp;
            }
        }

        if (!tempPath.endsWith('\\')) {
            tempPath += '\\';
        }

        const requiredChars = tempPath.length + 1; // including null

        if (nBufferLength < requiredChars) {
            return requiredChars;
        }

        if (lpBuffer) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < tempPath.length; i++) {
                view.setUint16(lpBuffer + i * 2, tempPath.charCodeAt(i), true);
            }
            view.setUint16(lpBuffer + tempPath.length * 2, 0, true);
        }

        return tempPath.length; // Length without null terminator
    };

    exports['SetCurrentDirectoryA'] = (ctx, mem, args) => {
        const lpPathName = args[0];

        const path = lpPathName ? readStringA(mem, lpPathName) : '';
        const fs = System.getInstance().fileSystem;
        if (fs) {
            const ok = fs.setCurrentDirectory(path);
            Logger.log(LogCategory.KERNEL32, `SetCurrentDirectoryA("${path}") -> ${ok ? 'TRUE' : 'FALSE'} (currentDir="${fs.currentDir}")`);
            return ok ? 1 : 0;
        }

        return 0; // FALSE
    };

    exports['SetCurrentDirectoryW'] = (ctx, mem, args) => {
        const lpPathName = args[0];

        // For simplicity, convert wide string to ASCII
        const path = lpPathName ? readStringW(mem, lpPathName) : '';
        const fs = System.getInstance().fileSystem;
        if (fs) {
            const ok = fs.setCurrentDirectory(path);
            Logger.log(LogCategory.KERNEL32, `SetCurrentDirectoryW("${path}") -> ${ok ? 'TRUE' : 'FALSE'} (currentDir="${fs.currentDir}")`);
            return ok ? 1 : 0;
        }

        return 0; // FALSE
    };
}
