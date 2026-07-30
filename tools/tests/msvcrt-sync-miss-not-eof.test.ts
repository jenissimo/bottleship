/**
 * Regression for F10: `readSync` returning null means "not available synchronously — go
 * async", NOT end of file. fgets/fgetc collapsed the two, so on the first-run streaming
 * path (HttpRangeSource / SAB, where every cold block returns null) a config file reads
 * as empty and the game silently takes its "no config" branch.
 *
 * Driven through the real Msvcrt methods over a real VFS whose ROM can only be read
 * asynchronously — the exact shape of a cold streamed bundle.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { Msvcrt } from "../../src/worker/modules/msvcrt";
import type { VfsFileHandle } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
const FILE_PTR = 0x70000000;
const BUF = 0x1000;

/** A ROM whose SYNC range read always misses — every cold block must be awaited. */
function asyncOnlyRom(text: string): { archive: ZipArchive; index: Map<string, ZipEntry> } {
    const bytes = new TextEncoder().encode(text);
    const entry: ZipEntry = {
        name: "cfg.txt", compressedSize: bytes.length, uncompressedSize: bytes.length,
        compression: 0, localHeaderOffset: 0, isDirectory: false,
    };
    const archive = {
        readEntryRangeSync: () => null,                       // never resident synchronously
        readEntryRange: async (_e: ZipEntry, off: number, len: number) =>
            bytes.subarray(off, Math.min(bytes.length, off + len)),
        readEntry: async () => bytes,
    } as unknown as ZipArchive;
    return { archive, index: new Map([["cfg.txt", entry]]) };
}

let mem: Uint8Array;

/**
 * The two methods under test only touch `fileStreams` and (for fgetc) the real-FILE-struct
 * flag, so a prototype instance avoids standing up a whole Process just to reach them.
 */
function makeCrt(handle: VfsFileHandle, text = false): {
    fgets(buf: number, n: number, fp: number): unknown;
    fgetc(fp: number): unknown;
} {
    const crt = Object.create(Msvcrt.prototype) as Record<string, unknown>;
    crt.useRealFileStructs = false;
    crt.fileStreams = new Map([[FILE_PTR, {
        fd: 3, handle, ungetChar: -1, text, eof: false, err: false,
    }]]);
    return crt as unknown as { fgets(b: number, n: number, f: number): unknown; fgetc(f: number): unknown };
}

const origNavigator = (globalThis as unknown as { navigator: unknown }).navigator;
afterAll(() => { (globalThis as unknown as { navigator: unknown }).navigator = origNavigator; });

function openAsyncOnly(text: string): VfsFileHandle {
    const { archive, index } = asyncOnlyRom(text);
    const vfs = System.getInstance().fileSystem;
    vfs.reset();
    vfs.mountRom(archive, "rom", index);
    mem = new Uint8Array(0x8000);
    Mem.bind(() => mem);
    return vfs.openSync("C:\\cfg.txt", GENERIC_READ, OPEN_EXISTING)!;
}

function readCString(ptr: number): string {
    let s = "";
    for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
    return s;
}

describe("F10 — a sync miss is awaited, not reported as EOF", () => {
    test("fgetc awaits the byte instead of returning EOF", async () => {
        const handle = openAsyncOnly("Az");
        const crt = makeCrt(handle);

        const first = crt.fgetc(FILE_PTR);
        // The byte is not resident, so this must be the async continuation — not -1.
        expect(first).toBeInstanceOf(Promise);
        expect((await (first as Promise<{ value: number }>)).value).toBe(0x41);

        // Once the entry is cached the sync path takes over again.
        expect(crt.fgetc(FILE_PTR)).toBe(0x7a);
    });

    test("fgetc still reports a genuine EOF", async () => {
        const handle = openAsyncOnly("A");
        const crt = makeCrt(handle);
        await (crt.fgetc(FILE_PTR) as Promise<{ value: number }>);
        expect(crt.fgetc(FILE_PTR)).toBe(-1);
    });

    test("fgets returns the whole line instead of NULL", async () => {
        const handle = openAsyncOnly("Resolution=1024\nDepth=32\n");
        const crt = makeCrt(handle);

        const r = crt.fgets(BUF, 64, FILE_PTR);
        expect(r).toBeInstanceOf(Promise);
        expect((await (r as Promise<{ value: number }>)).value).toBe(BUF);
        expect(readCString(BUF)).toBe("Resolution=1024\n");

        // The rest of the file is resident now; the sync driver finishes the next line.
        expect(crt.fgets(BUF, 64, FILE_PTR)).toBe(BUF);
        expect(readCString(BUF)).toBe("Depth=32\n");
    });

    test("fgets in text mode collapses CRLF across the async handoff", async () => {
        const handle = openAsyncOnly("a\r\nb\r\n");
        const crt = makeCrt(handle, true);

        const r = crt.fgets(BUF, 64, FILE_PTR);
        expect(r).toBeInstanceOf(Promise);
        await (r as Promise<{ value: number }>);
        expect(readCString(BUF)).toBe("a\n");
    });

    test("fgets still returns NULL at a genuine EOF", async () => {
        const handle = openAsyncOnly("x\n");
        const crt = makeCrt(handle);
        await (crt.fgets(BUF, 64, FILE_PTR) as Promise<{ value: number }>);
        expect(crt.fgets(BUF, 64, FILE_PTR)).toBe(0);
    });
});
