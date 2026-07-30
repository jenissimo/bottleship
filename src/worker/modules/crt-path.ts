/**
 * CRT path/directory functions (_getcwd, _fullpath, _makepath, _splitpath,
 * _chdir, _mkdir, _access, _tempnam, remove/_unlink/rename, and the EACCES
 * stubs _chmod/_rmdir).
 *
 * Host supplies codepage-aware string readers/writers, CRT malloc
 * (getcwd(NULL)/_tempnam return heap blocks the guest free()s), errno, and the
 * _tempnam sequence counter (owned by Msvcrt so reset() zeroes it). VFS /
 * current-directory go through System.
 *
 * Returns the getcwd implementation so msvcrt's VC9 ABI host
 * (registerVc9AbiExports) can delegate to the same function.
 */

import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

export interface CrtPathHost {
    readCString(ptr: number, maxLen: number): string;
    writeCString(ptr: number, value: string): void;
    malloc(size: number): number;
    setErrno(value: number): boolean;
    /** Next _tempnam sequence value ((counter++ & 0xffff) — counter lives in Msvcrt so reset() clears it). */
    nextTempnamSeq(): number;
}

export interface CrtPathFns {
    getcwd(buffer: number, maxLen: number): number;
}

/** _MAX_PATH — the block size _fullpath(NULL, …) grants (it ignores maxLength there). */
const MAX_PATH_BYTES = 260;

/** Ensure a path carries a drive letter — _getcwd/_getdcwd never return a bare path. */
function qualifyDrive(path: string): string {
    if (/^[A-Za-z]:/.test(path)) return path;
    return "C:\\" + path.replace(/^\\+/, "");
}

export function registerCrtPathExports(exports: Record<string, ThunkImplementation>, host: CrtPathHost): CrtPathFns {

    function getcwd(buffer: number, maxLen: number): number {
        const system = System.getInstance();
        // Both _getcwd and _getdcwd return a DRIVE-QUALIFIED absolute path on Windows, so
        // qualify here — once, before the size is chosen. Doing it in the _getdcwd wrapper
        // instead only covered the caller-supplied-buffer form, so a cwd without a drive
        // came back qualified through one form and bare through the other, and the
        // NULL-buffer form could not have been fixed up anyway (its block is already sized).
        const cwd = qualifyDrive((system as any).currentDirectory || "C:\\");
        if (!buffer) {
            // buffer==NULL: the CRT mallocs a block of AT LEAST `maxLen` characters and
            // hands ownership to the caller — the size is the caller's, not strlen(cwd)'s.
            // Callers legitimately keep writing into the block up to maxLen (a string class
            // adopts it with capacity=maxLen and appends in place), so sizing it to the cwd
            // is a silent heap overrun into whatever we allocated next.
            const len = Math.max(maxLen >>> 0, cwd.length + 1);
            const ptr = host.malloc(len);
            if (ptr) host.writeCString(ptr, cwd);
            return ptr;
        }
        const max = maxLen >>> 0;
        if (cwd.length >= max) {
            host.setErrno(34); // ERANGE
            return 0;
        }
        host.writeCString(buffer, cwd);
        return buffer >>> 0;
    }

    function fullpath(absPath: number, relPath: number, maxLen: number): number {
        if (!relPath) return 0;
        const rel = host.readCString(relPath, 512);
        let full = rel.replace(/\//g, "\\");

        if (!full.match(/^[A-Za-z]:/)) {
            const system = System.getInstance();
            const cwd = (system as any).currentDirectory || "C:\\";
            if (full.startsWith("\\")) {
                full = cwd.slice(0, 2) + full; // drive letter from CWD
            } else {
                full = cwd.endsWith("\\") ? cwd + full : cwd + "\\" + full;
            }
        }

        // Normalize path: resolve . and ..
        const parts = full.split("\\");
        const result: string[] = [];
        for (const part of parts) {
            if (part === "." || part === "") continue;
            if (part === "..") {
                if (result.length > 1) result.pop();
            } else {
                result.push(part);
            }
        }
        full = result.join("\\");

        if (!absPath) {
            // Same ownership contract as getcwd(NULL): malloc the buffer and return it.
            // _fullpath ignores maxLength in this form and grants _MAX_PATH. Returning a
            // LENGTH here handed the guest a small integer as a char* — a near-NULL deref
            // for anyone using the documented form.
            const len = Math.max(MAX_PATH_BYTES, full.length + 1);
            const ptr = host.malloc(len);
            if (ptr) host.writeCString(ptr, full);
            return ptr;
        }
        const max = maxLen >>> 0;
        if (full.length >= max) {
            host.setErrno(34);
            return 0;
        }
        host.writeCString(absPath, full);
        return absPath >>> 0;
    }

    function makepath(pathPtr: number, drivePtr: number, dirPtr: number, fnamePtr: number, extPtr: number): number {
        if (!pathPtr) return 0;
        const drive = drivePtr ? host.readCString(drivePtr, 8) : "";
        const dir = dirPtr ? host.readCString(dirPtr, 512) : "";
        const fname = fnamePtr ? host.readCString(fnamePtr, 256) : "";
        const ext = extPtr ? host.readCString(extPtr, 64) : "";

        let path = "";
        if (drive) {
            path += drive;
            if (!drive.endsWith(":")) path += ":";
        }
        if (dir) {
            path += dir;
            if (!dir.endsWith("\\") && !dir.endsWith("/")) path += "\\";
        }
        path += fname;
        if (ext) {
            if (!ext.startsWith(".")) path += ".";
            path += ext;
        }
        host.writeCString(pathPtr, path);
        return 0;
    }

    function chdir(pathPtr: number): number {
        if (!pathPtr) { host.setErrno(22); return -1; }
        const path = host.readCString(pathPtr, 512);
        const system = System.getInstance();
        (system as any).currentDirectory = path;
        Logger.log(LogCategory.SYSTEM, `msvcrt._chdir("${path}")`);
        return 0;
    }

    function splitpath(pathPtr: number, drivePtr: number, dirPtr: number, fnamePtr: number, extPtr: number): number {
        const path = host.readCString(pathPtr, 1024);
        const normalized = path.replace(/\//g, "\\");
        let drive = "";
        let dir = "";
        let fname = normalized;
        let ext = "";

        const driveMatch = normalized.match(/^[A-Za-z]:/);
        if (driveMatch) {
            drive = driveMatch[0];
            fname = normalized.slice(2);
        }

        const lastSlash = fname.lastIndexOf("\\");
        if (lastSlash >= 0) {
            dir = fname.slice(0, lastSlash + 1);
            fname = fname.slice(lastSlash + 1);
        }

        const lastDot = fname.lastIndexOf(".");
        if (lastDot > 0) {
            ext = fname.slice(lastDot);
            fname = fname.slice(0, lastDot);
        }

        if (drivePtr) host.writeCString(drivePtr, drive);
        if (dirPtr) host.writeCString(dirPtr, dir);
        if (fnamePtr) host.writeCString(fnamePtr, fname);
        if (extPtr) host.writeCString(extPtr, ext);

        return 0;
    }

    function mkdir(pathPtr: number): number {
        const path = host.readCString(pathPtr, 512).trim();
        if (!path) {
            host.setErrno(22);
            return -1;
        }

        if (/^[A-Za-z]:\\?$/.test(path)) {
            return 0;
        }

        const result = System.getInstance().fileSystem.createDirectorySync(path);
        if (result.ok) {
            return 0;
        }

        switch (result.error) {
            case 183: host.setErrno(17); break; // EEXIST
            case 3: host.setErrno(2); break;    // ENOENT
            case 5: host.setErrno(13); break;   // EACCES
            default: host.setErrno(22); break;  // EINVAL
        }
        return -1;
    }

    function access(pathPtr: number, _mode: number): number {
        const path = host.readCString(pathPtr, 512);
        if (!path) {
            host.setErrno(2);
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        if (vfs.hasRomFile(path)) return 0;
        const handle = vfs.openSync(path, 0x80000000, 3);
        if (handle) return 0;
        host.setErrno(2);
        return -1;
    }

    function tempnam(dirPtr: number, prefixPtr: number): number {
        const dir = dirPtr ? host.readCString(dirPtr, 260) : "";
        const prefix = prefixPtr ? host.readCString(prefixPtr, 32) : "";
        const safePrefix = prefix.replace(/[^A-Za-z0-9_$-]/g, "").slice(0, 8) || "tmp";
        const name = `${safePrefix}${host.nextTempnamSeq().toString(16).padStart(4, "0")}.tmp`;
        const sep = dir.length > 0 && !dir.endsWith("\\") && !dir.endsWith("/") ? "\\" : "";
        const path = dir.length > 0 ? `${dir}${sep}${name}` : name;
        const ptr = host.malloc(path.length + 1);
        if (!ptr) return 0;
        host.writeCString(ptr, path);
        return ptr >>> 0;
    }

    // remove()/_unlink(): delete via VFS. Real msvcrt maps straight to DeleteFileA;
    // errno mirrors that (ENOENT missing, EACCES for directories/denied). Games use
    // this on their own save/temp files — e.g. Max Payne's R_File::save() del()s the
    // existing slot, then checks GetFileAttributesA and REFUSES to write while the
    // old file is still there ("Unable to write save game" with an always-EACCES stub).
    async function unlinkImpl(pathPtr: number): Promise<number> {
        const path = pathPtr ? host.readCString(pathPtr, 512) : "";
        if (!path) {
            host.setErrno(22); // EINVAL
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        if (vfs.directoryExists(resolved)) {
            host.setErrno(13); // EACCES — unlink on a directory
            return -1;
        }
        const existing = vfs.openSync(resolved, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
        if (!existing) {
            host.setErrno(2); // ENOENT
            return -1;
        }
        try {
            const deleted = await vfs.deleteFile(resolved);
            if (!deleted) {
                host.setErrno(13);
                return -1;
            }
            return 0;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `CRT remove("${path}") failed: ${e}`);
            host.setErrno(13);
            return -1;
        }
    }

    // rename(): MSVCRT semantics — fails with EACCES if newname already exists
    // (unlike POSIX overwrite), ENOENT if oldname is missing. Copy+delete through
    // the VFS (same shape as kernel32 MoveFileA).
    async function renameImpl(oldPtr: number, newPtr: number): Promise<number> {
        const oldPath = oldPtr ? host.readCString(oldPtr, 512) : "";
        const newPath = newPtr ? host.readCString(newPtr, 512) : "";
        if (!oldPath || !newPath) {
            host.setErrno(22); // EINVAL
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const oldResolved = vfs.resolvePath(oldPath);
        const newResolved = vfs.resolvePath(newPath);
        if (vfs.directoryExists(oldResolved)) {
            host.setErrno(13); // directory rename unsupported here
            return -1;
        }
        if (vfs.directoryExists(newResolved) || vfs.openSync(newResolved, 0x80000000, 3)) {
            host.setErrno(13); // EACCES — newname exists
            return -1;
        }
        try {
            const src = await vfs.open(oldResolved, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
            if (!src) {
                host.setErrno(2); // ENOENT
                return -1;
            }
            const size = vfs.getFileSize(oldResolved);
            const data = size > 0 ? await vfs.read(src, size) : new Uint8Array(0);
            const dst = await vfs.open(newResolved, 0x40000000, 1); // GENERIC_WRITE, CREATE_NEW
            if (!dst) {
                host.setErrno(13);
                return -1;
            }
            if (data.length > 0) await vfs.write(dst, data);
            await vfs.flushFile(newResolved);
            await vfs.deleteFile(oldResolved);
            return 0;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `CRT rename("${oldPath}" -> "${newPath}") failed: ${e}`);
            host.setErrno(13);
            return -1;
        }
    }

    // _rmdir(): faithful RemoveDirectory (must exist, be empty, not ROM-backed).
    async function rmdirImpl(pathPtr: number): Promise<number> {
        const path = pathPtr ? host.readCString(pathPtr, 512) : "";
        if (!path) {
            host.setErrno(22); // EINVAL
            return -1;
        }
        const result = await System.getInstance().fileSystem.removeDirectory(path);
        if (result.ok) return 0;
        switch (result.error) {
            case 2: host.setErrno(2); break;    // ENOENT
            case 145: host.setErrno(41); break; // ENOTEMPTY
            default: host.setErrno(13); break;  // EACCES
        }
        return -1;
    }

    // _chmod(): the VFS has no read-only attribute to flip — succeeding on an
    // existing path (and ENOENT otherwise) matches what every game observes on
    // a writable install dir.
    function chmodImpl(pathPtr: number): number {
        const path = pathPtr ? host.readCString(pathPtr, 512) : "";
        if (!path) {
            host.setErrno(22);
            return -1;
        }
        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        if (vfs.directoryExists(resolved) || vfs.fileExists(resolved)) {
            return 0;
        }
        host.setErrno(2); // ENOENT
        return -1;
    }

    exports["_access"] = (ctx, mem, args) => access(args[0] ?? 0, args[1] ?? 0);
    exports["_chmod"] = (ctx, mem, args) => chmodImpl(args[0] ?? 0);
    exports["_mkdir"] = (ctx, mem, args) => mkdir(args[0] ?? 0);
    exports["_rmdir"] = (ctx, mem, args) => rmdirImpl(args[0] ?? 0);
    exports["_unlink"] = (ctx, mem, args) => unlinkImpl(args[0] ?? 0);
    exports["_splitpath"] = (ctx, mem, args) => splitpath(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0);

    exports["_getcwd"] = (ctx, mem, args) => getcwd(args[0] ?? 0, args[1] ?? 0);
    exports["_fullpath"] = (ctx, mem, args) => fullpath(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
    exports["_makepath"] = (ctx, mem, args) => makepath(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0);
    exports["_chdir"] = (ctx, mem, args) => chdir(args[0] ?? 0);
    exports["remove"] = (ctx, mem, args) => unlinkImpl(args[0] ?? 0);
    exports["rename"] = (ctx, mem, args) => renameImpl(args[0] ?? 0, args[1] ?? 0);

    exports["_tempnam"] = (ctx, mem, args) => tempnam(args[0] ?? 0, args[1] ?? 0);

    return { getcwd };
}
