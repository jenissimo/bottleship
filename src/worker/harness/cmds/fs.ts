/**
 * VFS read-back harness verbs (the #1 unspoken gap — half the hardest
 * bring-up bugs were "game wrote a file, didn't persist / 0 bytes / wrong").
 *
 * fsRead/fsList/fsStat over System.fileSystem (VirtualFileSystem); fsFlush is the
 * durability barrier (flushAll closes OPFS writers). Reads go through openSync +
 * readSync (there is no read(path)->bytes helper). Also emits the gated
 * fileWritten event (watchFiles) so a script can wait on a guest write.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { bytesToBase64 } from "./screen";
import { harnessBus } from "../event-bus";

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;
const READ_CAP = 256 * 1024;

function vfs(): any {
    const fsx = sys().fileSystem;
    if (!fsx) throw new HarnessError("no filesystem", HarnessErrorCode.NO_PROCESS);
    return fsx as any;
}

export function registerFsCommands(svc: HarnessService): void {
    /** fsRead(path, {maxBytes?, encoding?}) — read a file (capped). Uses the async
     *  read path so compressed/uncached ROM entries return real bytes (readSync
     *  returns null for those → would falsely report a non-empty file as 0 bytes). */
    svc.register("fsRead", async (args) => {
        const path = String(args[0] ?? "");
        const opts = (args[1] ?? {}) as { maxBytes?: number; encoding?: "base64" | "utf8" | "hex" };
        const fsx = vfs();
        const handle = fsx.openSync(path, GENERIC_READ, OPEN_EXISTING);
        if (!handle) throw new HarnessError(`file not found: ${path}`, HarnessErrorCode.NOT_FOUND);
        const size = fsx.getFileSize(path);
        const cap = Math.min(size, opts.maxBytes ?? READ_CAP);
        const data: Uint8Array | null = await fsx.read(handle, cap);
        const bytes = data ?? new Uint8Array(0);
        const enc = opts.encoding ?? "base64";
        let content: string;
        if (enc === "utf8") content = new TextDecoder().decode(bytes);
        else if (enc === "hex") content = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        else content = bytesToBase64(bytes);
        return { path, size, read: bytes.length, truncated: size > cap, source: handle.source, encoding: enc, content };
    });

    /** fsWrite(path, content, {encoding?}) — write a file into the CoW overlay (creates
     *  parent dirs, CREATE_ALWAYS, flushes). For fast config/ini experiments without a
     *  code change: edit a guest .ini then reload to have the engine read it. encoding
     *  'utf8' (default) or 'base64'. Returns bytes written + overlay/rom source. */
    svc.register("fsWrite", async (args) => {
        const path = String(args[0] ?? "");
        if (!path) throw new HarnessError("fsWrite needs a path", HarnessErrorCode.BAD_ARGS);
        const content = String(args[1] ?? "");
        const enc = ((args[2] as { encoding?: string })?.encoding ?? "utf8") as "utf8" | "base64";
        const bytes = enc === "base64"
            ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(content);
        const fsx = vfs();
        fsx.ensureParentDirsSync?.(path);
        const h = await fsx.open(path, GENERIC_WRITE, CREATE_ALWAYS);
        if (!h) throw new HarnessError(`could not open for write: ${path}`, HarnessErrorCode.BAD_ARGS);
        if (bytes.length) await fsx.write(h, bytes);
        await fsx.flushFile?.(h.path ?? path);
        return { path, written: bytes.length, source: h.source ?? "overlay" };
    });

    /** fsList(path) — directory listing. */
    svc.register("fsList", (args) => {
        const path = String(args[0] ?? "C:\\");
        const entries = vfs().listDirectory(path) ?? [];
        return entries.map((e: any) => ({ name: e.name, path: e.path, kind: e.kind, size: e.size, source: e.source }));
    });

    /** fsStat(path) — existence + size + rom/overlay origin. getFileSize returns 0
     *  (not -1) for a missing file, so existence is probed with a read-only
     *  openSync (null = absent) — a real 0-byte file still reports exists:true. */
    svc.register("fsStat", (args) => {
        const path = String(args[0] ?? "");
        const fsx = vfs();
        const isDir = fsx.directoryExists(path);
        const handle = isDir ? null : fsx.openSync(path, GENERIC_READ, OPEN_EXISTING);
        const exists = !!handle || isDir;
        return { path, exists, isDir, size: handle ? fsx.getFileSize(path) : null, source: handle?.source ?? null, inRom: fsx.hasRomFile?.(path) ?? null };
    });

    /** fsDelete(path) — remove a file from the CoW overlay (reproduces a first-run
     *  state after a seed/write; does not touch ROM). */
    svc.register("fsDelete", async (args) => {
        const path = String(args[0] ?? "");
        if (!path) throw new HarnessError("fsDelete needs a path", HarnessErrorCode.BAD_ARGS);
        const deleted = await vfs().deleteFile(path);
        return { path, deleted };
    });

    /** fsFlush() — durable flush (closes OPFS writers). The record/replay teardown barrier. */
    svc.register("fsFlush", async () => {
        await vfs().flushAll();
        return { flushed: true };
    });

    /** watchFiles(on?) — enable/disable the fileWritten event (off by default; the
     *  guest write path is hot). */
    svc.register("watchFiles", (args) => {
        harnessBus.fileEvents = args[0] === undefined ? true : !!args[0];
        return { fileEvents: harnessBus.fileEvents };
    });
}
