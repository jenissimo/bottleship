/**
 * SHFileOperation — the shell's bulk copy/move/rename/delete, over the VFS.
 *
 * This is the API an installer-era title uses to lay down its per-user state on first
 * run ("copy defaultSave\user\*.* to the writable user directory"), and it is the whole
 * reason a game can boot, render, and still save nothing: the call is one function, the
 * work is a recursive directory copy, and returning 0 without doing it looks exactly
 * like success to the caller. Nothing downstream can tell the difference — the title
 * simply finds its data missing later, in code with no connection to this call.
 *
 * Semantics follow the documented shell behaviour (cross-checked against Wine's
 * dlls/shell32/shlfileop.c):
 *   - pFrom/pTo are DOUBLE-NUL-TERMINATED LISTS, not strings. A lone NUL-terminated
 *     path is accepted too, which is what most callers actually pass.
 *   - the final component of a source may be a WILDCARD (`*.*`, `*.bmp`), matched
 *     against the parent directory.
 *   - a directory source is copied RECURSIVELY unless FOF_NORECURSION.
 *   - the destination directory tree is created as needed. That is this API's contract
 *     (FOF_NOCONFIRMMKDIR only suppresses the prompt, never the creation) — unlike
 *     CreateFile, which faithfully fails on a missing parent.
 *   - FOF_MULTIDESTFILES pairs the two lists element-by-element; otherwise there is one
 *     destination for all sources.
 *
 * The return value is NOT a Win32 error code: SHFileOperation has its own DE_* space and
 * a caller that tests `== 0` would read ERROR_FILE_NOT_FOUND (2) as a different failure
 * and ERROR_SUCCESS-shaped codes as success. Failures also set fAnyOperationsAborted.
 */

import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";

/** wFunc */
export const FO_MOVE = 0x0001;
export const FO_COPY = 0x0002;
export const FO_DELETE = 0x0003;
export const FO_RENAME = 0x0004;

/** fFlags that change what this implementation does (the rest are UI-only). */
export const FOF_MULTIDESTFILES = 0x0001;
export const FOF_RENAMEONCOLLISION = 0x0008;
export const FOF_FILESONLY = 0x0080;
export const FOF_NORECURSION = 0x1000;

/**
 * DE_* results. Shell error space, not Win32 — 0x71.. are the classic codes and 0x402 is
 * the modern "unspecified error" the shell returns where Win32 would say FILE_NOT_FOUND.
 */
export const DE_SAMEFILE = 0x71;
export const DE_MANYSRC1DEST = 0x72;
export const DE_OPCANCELLED = 0x75;
export const DE_DESTSUBTREE = 0x76;
export const DE_ACCESSDENIEDSRC = 0x78;
export const DE_INVALIDFILES = 0x7c;
export const DE_UNKNOWN_ERROR = 0x402;

/** GENERIC_READ / GENERIC_WRITE, OPEN_EXISTING / CREATE_ALWAYS. */
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;

export interface ShFileOpRequest {
    wFunc: number;
    from: string[];
    to: string[];
    flags: number;
}

export interface ShFileOpResult {
    /** 0 on success, a DE_* code otherwise. */
    result: number;
    /** SHFILEOPSTRUCT.fAnyOperationsAborted — true when any item was not carried out. */
    aborted: boolean;
    /** Files actually written/removed. The ledger this operation can be checked against. */
    filesTouched: number;
}

function baseName(path: string): string {
    const i = path.lastIndexOf("\\");
    return i < 0 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
    const i = path.lastIndexOf("\\");
    return i <= 2 ? path.slice(0, i + 1) : path.slice(0, i);
}

function join(dir: string, name: string): string {
    return dir.endsWith("\\") ? `${dir}${name}` : `${dir}\\${name}`;
}

function hasWildcard(path: string): boolean {
    return path.includes("*") || path.includes("?");
}

/** DOS wildcard match, case-insensitive. `*.*` matches everything, as it does on Windows. */
function wildcardMatch(pattern: string, name: string): boolean {
    if (pattern === "*" || pattern === "*.*") return true;
    const rx = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
        "i",
    );
    return rx.test(name);
}

/**
 * One source item, resolved. `asName` is the name it keeps when copied into a directory —
 * for a wildcard expansion that is the matched entry's own name, not the pattern.
 */
interface SourceItem {
    path: string;
    name: string;
    isDir: boolean;
}

/** Expand one pFrom entry into concrete existing items (wildcards included). */
function expandSource(spec: string): SourceItem[] {
    const vfs = System.getInstance().fileSystem;
    const full = vfs.resolvePath(spec);
    if (!hasWildcard(full)) {
        if (vfs.directoryExists(full)) return [{ path: full, name: baseName(full), isDir: true }];
        if (vfs.fileExists(full)) return [{ path: full, name: baseName(full), isDir: false }];
        return [];
    }
    const parent = dirName(full);
    const pattern = baseName(full);
    if (!vfs.directoryExists(parent)) return [];
    const out: SourceItem[] = [];
    for (const entry of vfs.listDirectory(parent)) {
        if (entry.name === "." || entry.name === "..") continue;
        if (!wildcardMatch(pattern, entry.name)) continue;
        out.push({ path: join(parent, entry.name), name: entry.name, isDir: entry.kind === "dir" });
    }
    return out;
}

/** Copy one file, whole. Fresh handles only: a shared cursor is the file object's state. */
async function copyOneFile(src: string, dst: string): Promise<boolean> {
    const vfs = System.getInstance().fileSystem;
    const srcHandle = await vfs.open(src, GENERIC_READ, OPEN_EXISTING);
    if (!srcHandle) return false;
    vfs.ensureParentDirsSync(dst);
    const dstHandle = await vfs.open(dst, GENERIC_WRITE, CREATE_ALWAYS);
    if (!dstHandle) return false;

    const total = vfs.getFileSize(srcHandle.path);
    let remaining = total;
    const CHUNK = 256 * 1024;
    while (remaining > 0) {
        const data = await vfs.read(srcHandle, Math.min(CHUNK, remaining));
        if (data.length === 0) break;
        await vfs.write(dstHandle, data);
        remaining -= data.length;
    }
    // A short copy is a FAILED copy: the destination exists at the wrong length and the
    // caller would go on to parse it. Say so rather than counting it.
    return remaining === 0;
}

/** Recursive directory copy. Returns the number of files written, or null on failure. */
async function copyTree(src: string, dst: string, recurse: boolean): Promise<number | null> {
    const vfs = System.getInstance().fileSystem;
    vfs.ensureDirTreeSync(dst);
    let written = 0;
    for (const entry of vfs.listDirectory(src)) {
        if (entry.name === "." || entry.name === "..") continue;
        const from = join(src, entry.name);
        const to = join(dst, entry.name);
        if (entry.kind === "dir") {
            if (!recurse) continue;
            const sub = await copyTree(from, to, recurse);
            if (sub === null) return null;
            written += sub;
        } else {
            if (!await copyOneFile(from, to)) return null;
            written++;
        }
    }
    return written;
}

/** Delete selected contents, retaining the directory when recursion skips a child. */
async function deleteTree(path: string, recurse = true): Promise<number | null> {
    const vfs = System.getInstance().fileSystem;
    let removed = 0;
    let skippedDirectory = false;
    for (const entry of vfs.listDirectory(path)) {
        if (entry.name === "." || entry.name === "..") continue;
        const child = join(path, entry.name);
        if (entry.kind === "dir") {
            if (!recurse) {
                skippedDirectory = true;
                continue;
            }
            const sub = await deleteTree(child);
            if (sub === null) return null;
            removed += sub;
        } else {
            if (!await vfs.deleteFile(child)) return null;
            removed++;
        }
    }
    if (skippedDirectory) return removed;
    const rmdir = await vfs.removeDirectory(path);
    return rmdir.ok ? removed : null;
}

/**
 * Where one source item lands.
 *
 * The shell's rule, and the one place a naive implementation goes wrong: a destination
 * that EXISTS AS A DIRECTORY always receives the item under its own name. Only a single
 * non-wildcard source with a non-existent destination renames — otherwise `copy *.* to
 * C:\user` would write every matched file over one another at the path `C:\user`.
 */
function destinationFor(item: SourceItem, dest: string, destIsDir: boolean): string {
    return destIsDir ? join(dest, item.name) : dest;
}

export async function performShFileOperation(req: ShFileOpRequest): Promise<ShFileOpResult> {
    const vfs = System.getInstance().fileSystem;
    const fail = (result: number, why: string): ShFileOpResult => {
        Logger.warn(LogCategory.SYSTEM, `SHFileOperation: ${why} — 0x${result.toString(16)}`);
        return { result, aborted: true, filesTouched: 0 };
    };

    if (req.wFunc !== FO_COPY && req.wFunc !== FO_MOVE
        && req.wFunc !== FO_DELETE && req.wFunc !== FO_RENAME) {
        return fail(DE_INVALIDFILES, `unknown wFunc ${req.wFunc}`);
    }
    if (req.from.length === 0) return fail(DE_INVALIDFILES, "empty pFrom list");

    const recurse = (req.flags & FOF_NORECURSION) === 0;
    const filesOnly = (req.flags & FOF_FILESONLY) !== 0;
    let touched = 0;

    if (req.wFunc === FO_DELETE) {
        for (const spec of req.from) {
            const items = expandSource(spec);
            if (items.length === 0) return fail(DE_INVALIDFILES, `no such source "${spec}"`);
            for (const item of items) {
                if (item.isDir) {
                    if (filesOnly) continue;
                    const removed = await deleteTree(item.path);
                    if (removed === null) return fail(DE_ACCESSDENIEDSRC, `cannot delete "${item.path}"`);
                    touched += removed;
                } else {
                    if (!await vfs.deleteFile(item.path)) {
                        return fail(DE_ACCESSDENIEDSRC, `cannot delete "${item.path}"`);
                    }
                    touched++;
                }
            }
        }
        Logger.log(LogCategory.SYSTEM, `SHFileOperation FO_DELETE: ${touched} file(s)`);
        return { result: 0, aborted: false, filesTouched: touched };
    }

    if (req.to.length === 0) return fail(DE_INVALIDFILES, "empty pTo list");

    const multiDest = (req.flags & FOF_MULTIDESTFILES) !== 0;
    if (multiDest && req.to.length !== req.from.length) {
        return fail(DE_MANYSRC1DEST, "FOF_MULTIDESTFILES with mismatched list lengths");
    }
    if (!multiDest && req.to.length > 1) {
        return fail(DE_MANYSRC1DEST, "several destinations without FOF_MULTIDESTFILES");
    }

    for (let i = 0; i < req.from.length; i++) {
        const spec = req.from[i]!;
        const destSpec = vfs.resolvePath(multiDest ? req.to[i]! : req.to[0]!);
        const items = expandSource(spec);
        if (items.length === 0) return fail(DE_INVALIDFILES, `no such source "${spec}"`);

        // A destination that already is a directory receives items by name. So does one
        // that does not exist yet whenever there is more than one item to place there —
        // otherwise they would all collapse onto the same path.
        const destIsDir = vfs.directoryExists(destSpec)
            || items.length > 1
            || (!multiDest && req.from.length > 1)
            || (items.length === 1 && items[0]!.isDir && hasWildcard(spec));

        for (const item of items) {
            if (item.isDir && filesOnly) continue;
            const target = destinationFor(item, destSpec, destIsDir);
            if (target.toLowerCase() === item.path.toLowerCase()) {
                return fail(DE_SAMEFILE, `source and destination are the same ("${target}")`);
            }
            if (item.isDir && `${target.toLowerCase()}\\`.startsWith(`${item.path.toLowerCase()}\\`)) {
                return fail(DE_DESTSUBTREE, `destination "${target}" is inside source "${item.path}"`);
            }
            if ((req.flags & FOF_RENAMEONCOLLISION) !== 0 && vfs.fileExists(target)) {
                // Windows would write "Copy of X". We have no user-visible naming policy
                // to invent, and silently overwriting is the one thing the flag forbids.
                return fail(DE_UNKNOWN_ERROR, `FOF_RENAMEONCOLLISION is not implemented ("${target}")`);
            }

            if (item.isDir) {
                const written = await copyTree(item.path, target, recurse);
                if (written === null) return fail(DE_UNKNOWN_ERROR, `cannot copy tree "${item.path}"`);
                touched += written;
            } else {
                if (!await copyOneFile(item.path, target)) {
                    return fail(DE_UNKNOWN_ERROR, `cannot copy "${item.path}" -> "${target}"`);
                }
                touched++;
            }

            if (req.wFunc === FO_MOVE || req.wFunc === FO_RENAME) {
                // The cleanup must select the same contents as copyTree: skipped
                // subdirectories still belong to the source and must survive the move.
                const removed = item.isDir ? await deleteTree(item.path, recurse) : (await vfs.deleteFile(item.path) ? 1 : null);
                if (removed === null) {
                    return fail(DE_ACCESSDENIEDSRC, `copied but cannot remove source "${item.path}"`);
                }
            }
        }
    }

    Logger.log(LogCategory.SYSTEM,
        `SHFileOperation wFunc=${req.wFunc}: ${touched} file(s) ${req.wFunc === FO_COPY ? "copied" : "moved"}`);
    return { result: 0, aborted: false, filesTouched: touched };
}
