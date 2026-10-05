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

/** Sibling container names, for telling "no such container" apart from "nothing to delete". */
async function listContainers(): Promise<string[]> {
    try {
        const root = await (navigator as any).storage.getDirectory();
        const games = await (await root.getDirectoryHandle("bottleship")).getDirectoryHandle("games");
        const names: string[] = [];
        for await (const [name] of (games as any).entries()) names.push(name);
        return names.sort();
    } catch {
        return [];
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
     *  container when path is omitted (reproduces a first-run overlay).
     *
     *  The whole-container wipe is IDEMPOTENT: a container that does not exist yet is already
     *  in the state the caller is asking for. It used to raise NOT_FOUND, which aborted the
     *  chain at step 0 on any machine that had never run the title — i.e. exactly the
     *  first-run case the wipe exists to reproduce. A named path still errors, so a typo
     *  stays visible. */
    svc.register("containerDelete", async (args) => {
        const container = String(args[0] ?? "");
        // JSON.stringify drops `undefined` in an array to `null`, so a DSL `.containerDelete(id)`
        // (which pushes [id, undefined]) arrives as [id, null]. Guarding only `undefined` turned
        // that into String(null) === "null" and a whole-container wipe silently became "delete the
        // file named null" - NotFound, on every DSL caller, while the CLI form worked.
        const rawPath = args[1];
        const path = rawPath === undefined || rawPath === null || rawPath === "" ? null : String(rawPath);
        if (path) {
            const { dir, name } = await resolvePath(container, path, false);
            await dir.removeEntry(name);
            return { container, deleted: [path] };
        }
        let dir: FileSystemDirectoryHandle;
        try {
            dir = await containerDir(container, false);
        } catch (e) {
            if (e instanceof HarnessError && e.code === HarnessErrorCode.NOT_FOUND) {
                // Name the containers that DO exist. Idempotence alone would turn a mistyped id
                // into a silent no-op, and a determinism wipe that quietly wiped nothing is
                // indistinguishable from one that worked - the caller can compare against this.
                return { container, deleted: [], wiped: true, existed: false, knownContainers: await listContainers() };
            }
            throw e;
        }
        // Enumeration itself can throw NotFound: a worker torn down by a page reload dies with
        // a debounced OPFS flush in flight, so an entry can vanish mid-iteration. That is
        // transient, so retry it - but COUNT the retries into the result, because a wipe that
        // quietly needed three attempts is telling you something about teardown ordering.
        let names: string[] = [];
        const attempts: string[] = [];
        for (let attempt = 1; ; attempt++) {
            try {
                const acc: string[] = [];
                for await (const [name] of (dir as any).entries()) acc.push(name);
                names = acc;
                break;
            } catch (e) {
                attempts.push(`${(e as Error).name}: ${(e as Error).message}`);
                if (attempt >= 3) {
                    throw new HarnessError(
                        `container '${container}': could not enumerate after ${attempt} attempts `
                        + `(${attempts.join("; ")}) - first-run state was NOT reproduced`,
                        HarnessErrorCode.INTERNAL);
                }
                await new Promise((r) => setTimeout(r, 250 * attempt));
            }
        }
        // Name the entry that resisted. A bare OPFS "file or directory could not be found"
        // aborts the whole chain without saying WHICH entry or WHICH container, and the wipe
        // is usually step 0 of a scenario - the reader then blames the scenario, not the file.
        const deleted: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];
        for (const name of names) {
            try {
                await dir.removeEntry(name, { recursive: true });
                deleted.push(name);
            } catch (e) {
                failed.push({ name, error: `${(e as Error).name}: ${(e as Error).message}` });
            }
        }
        if (failed.length) {
            throw new HarnessError(
                `container '${container}': ${failed.length} of ${names.length} entries survived the wipe `
                + `(${failed.map((f) => `${f.name} -> ${f.error}`).join("; ")}) - first-run state was NOT reproduced`,
                HarnessErrorCode.INTERNAL);
        }
        return { container, deleted, wiped: true, existed: true, enumerateRetries: attempts.length, ...(attempts.length ? { enumerateErrors: attempts } : {}) };
    });
}
