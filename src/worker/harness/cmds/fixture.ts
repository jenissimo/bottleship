/**
 * OPFS container verbs — read/write a game's persisted profile (the CoW overlay
 * for one container) as a portable fixture.
 *
 * Why these bypass the VFS: a container must be restorable BEFORE a bundle loads
 * (a running game holds its settings files open), and at that point there is no
 * System.fileSystem to write through. So these address OPFS directly at
 * bottleship/games/<container>/ and are keyed by container, never by title.
 *
 * Paths are container-relative with a leading slash (/overlay/C/Game/x.cfg), which
 * is the shape the fixture manifest already stores.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { bytesToBase64 } from "./screen";

/** Deep enough for overlay/<drive>/<game>/<subdir...>; bounds a pathological tree. */
const MAX_DEPTH = 8;

async function containerDir(container: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!container) throw new HarnessError("container name required", HarnessErrorCode.BAD_ARGS);
    const storage = (navigator as any)?.storage;
    if (!storage?.getDirectory) throw new HarnessError("OPFS unavailable in this context", HarnessErrorCode.UNSUPPORTED);
    try {
        const root = await storage.getDirectory();
        const bs = await root.getDirectoryHandle("bottleship", { create });
        const games = await bs.getDirectoryHandle("games", { create });
        return await games.getDirectoryHandle(container, { create });
    } catch (e) {
        throw new HarnessError(`container '${container}' not found: ${(e as Error).message}`, HarnessErrorCode.NOT_FOUND);
    }
}

/** Resolve a container-relative path to its parent dir + leaf name. */
async function resolvePath(
    container: string,
    path: string,
    create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = String(path).split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new HarnessError(`bad path: ${path}`, HarnessErrorCode.BAD_ARGS);
    let dir = await containerDir(container, create);
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return { dir, name };
}

async function walk(
    dir: FileSystemDirectoryHandle,
    prefix: string,
    depth: number,
    out: Array<{ path: string; size: number }>,
): Promise<void> {
    if (depth > MAX_DEPTH) return;
    for await (const [name, handle] of (dir as any).entries()) {
        const path = `${prefix}/${name}`;
        if (handle.kind === "file") {
            const f = await handle.getFile();
            out.push({ path, size: f.size });
        } else {
            await walk(handle, path, depth + 1, out);
        }
    }
}

export function registerFixtureCommands(svc: HarnessService): void {
    /** containerList(container) — every file in the container, with sizes. */
    svc.register("containerList", async (args) => {
        const container = String(args[0] ?? "");
        const dir = await containerDir(container, false);
        const files: Array<{ path: string; size: number }> = [];
        await walk(dir, "", 0, files);
        return { container, files };
    });

    /** containerRead(container, path) — base64 file bytes. */
    svc.register("containerRead", async (args) => {
        const container = String(args[0] ?? "");
        const path = String(args[1] ?? "");
        const { dir, name } = await resolvePath(container, path, false);
        let file: File;
        try {
            file = await (await dir.getFileHandle(name)).getFile();
        } catch {
            throw new HarnessError(`file not found: ${path}`, HarnessErrorCode.NOT_FOUND);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { path, size: bytes.length, content: bytesToBase64(bytes) };
    });

    /** containerWrite(container, path, base64) — write a file, creating parent dirs. */
    svc.register("containerWrite", async (args) => {
        const container = String(args[0] ?? "");
        const path = String(args[1] ?? "");
        const b64 = String(args[2] ?? "");
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const { dir, name } = await resolvePath(container, path, true);
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
        return { path, written: bytes.length };
    });

    /** containerDelete(container, path?) — remove one file, or every file in the
     *  container when path is omitted (reproduces a first-run overlay). */
    svc.register("containerDelete", async (args) => {
        const container = String(args[0] ?? "");
        const path = args[1] === undefined ? null : String(args[1]);
        if (path) {
            const { dir, name } = await resolvePath(container, path, false);
            await dir.removeEntry(name);
            return { container, deleted: [path] };
        }
        const dir = await containerDir(container, false);
        const names: string[] = [];
        for await (const [name] of (dir as any).entries()) names.push(name);
        for (const name of names) await dir.removeEntry(name, { recursive: true });
        return { container, deleted: names, wiped: true };
    });
}
