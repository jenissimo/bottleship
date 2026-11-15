import { closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssemblyStore } from "@bottleship/formats/inno";

/** Disk workspace for segmented Galaxy files; callers read/hash/fan out in bounded ranges. */
export function createInnoAssemblyStore(directory: string, size: number): AssemblyStore {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid Inno assembly size");
    const path = join(directory, `.inno-assembly-${randomUUID()}.tmp`);
    const fd = openSync(path, "wx+");
    let identity: { dev: bigint; ino: bigint } | undefined;
    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        try { closeSync(fd); }
        finally {
            try {
                // Never unlink a foreign file moved over our unique scratch path.
                const current = lstatSync(path, { bigint: true });
                if (!identity || (current.dev === identity.dev && current.ino === identity.ino)) unlinkSync(path);
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
        }
    };
    try { identity = fstatSync(fd, { bigint: true }); ftruncateSync(fd, size); }
    catch (e) { close(); throw e; }
    const checkRange = (start: number, end: number): void => {
        if (closed) throw new Error("Inno assembly store is closed");
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) {
            throw new RangeError("Invalid Inno assembly range");
        }
    };
    return {
        size,
        readRangeSync(start, end) {
            checkRange(start, end);
            const bytes = new Uint8Array(end - start);
            for (let at = 0; at < bytes.length;) {
                const n = readSync(fd, bytes, at, bytes.length - at, start + at);
                if (n <= 0) throw new Error(`Inno assembly short read at ${start + at}/${end}`);
                at += n;
            }
            return bytes;
        },
        writeAt(bytes, offset) {
            if (!Number.isSafeInteger(offset) || offset > size - bytes.byteLength) {
                throw new RangeError("Invalid Inno assembly write range");
            }
            checkRange(offset, offset + bytes.byteLength);
            for (let at = 0; at < bytes.length;) {
                const n = writeSync(fd, bytes, at, bytes.length - at, offset + at);
                if (n <= 0) throw new Error(`Inno assembly short write at ${offset + at}`);
                at += n;
            }
        },
        close,
    };
}
