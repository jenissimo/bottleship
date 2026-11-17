import { afterEach, describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive } from "@bottleship/formats/zip";
import { findFakeByName, installFakeOpfs } from "./fixtures/fake-opfs";

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as any).navigator;
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

function strictWritable(writer: any, events: string[]) {
    let closed = false;
    const check = (op: string) => {
        if (closed) throw new TypeError("Cannot " + op + " a closing writable stream");
    };
    return {
        seek: async (offset: number) => { check("seek"); events.push("seek"); await writer.seek(offset); },
        write: async (data: any) => { check("write"); events.push("write"); await writer.write(data); },
        truncate: async (size: number) => { check("truncate"); await writer.truncate(size); },
        close: async () => { check("close"); closed = true; events.push("close"); await writer.close(); },
    };
}

let sequence = 0;
async function fixture() {
    const root = installFakeOpfs();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
    await vfs.initOverlay("test:directwrite" + ++sequence);
    const path = "C:\\Large.bin";
    const seed = vfs.openSync(path, 0x40000000, 2)!;
    vfs.writeSync(seed, new Uint8Array([0x19]));
    await vfs.flushAll();
    const handle = vfs.openSync(path, 0x40000000, 3)!;
    const overlay = (vfs as any).overlay;
    const events: string[] = [];
    const originalFileHandle = overlay.getFileHandle.bind(overlay);
    const wrapped = new WeakSet<object>();
    overlay.getFileHandle = async (...args: any[]) => {
        const file = await originalFileHandle(...args);
        if (!wrapped.has(file)) {
            wrapped.add(file);
            const create = file.createWritable.bind(file);
            file.createWritable = async (...options: any[]) => strictWritable(await create(...options), events);
        }
        return file;
    };
    const opened = deferred(), release = deferred();
    const ensureWriter = overlay.ensureWriter.bind(overlay);
    let intercepted = false;
    overlay.ensureWriter = async (entry: any) => {
        await ensureWriter(entry); // Real VFS admission and real fake stream creation.
        if (!intercepted) {
            intercepted = true;
            opened.resolve();
            await release.promise;
        }
    };
    const big = Uint8Array.from({ length: 421254 }, (_, i) => (i * 37 + 11) & 255);
    const writing = vfs.write(handle, big);
    void writing.catch(() => {});
    await opened.promise;
    const entry = overlay.writerCache.get(path.toLowerCase());
    entry.lastUsed = performance.now() - 2000;
    return { root, vfs, path, handle, overlay, events, big, writing, release };
}

describe("direct async writes own their stream until their final write settles", () => {
    for (const mode of ["idle", "close", "all", "successor"] as const) {
        test(mode + " cannot close a large write while ensureWriter is returning", async () => {
            const f = await fixture();
            let closing: Promise<void> | undefined;
            const tail = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
            let beforeRelease: string[] = [];
            try {
                closing = mode === "idle" ? f.overlay.cleanupWriters()
                    : mode === "all" ? f.vfs.flushAll() : f.vfs.flushFile(f.path);
                // No wall-clock race: the real close path can drain every already-ready
                // promise, while the explicit admission gate remains closed.
                for (let i = 0; i < 24; i++) await Promise.resolve();
                beforeRelease = [...f.events];
                if (mode === "successor") {
                    const next = f.vfs.openSync(f.path, 0x40000000, 3)!;
                    f.vfs.setPosition(next, f.big.length, 0);
                    expect(f.vfs.writeSync(next, tail)).toBe(tail.length);
                }
            } finally {
                f.release.resolve();
            }
            const [writeResult, closeResult] = await Promise.allSettled([f.writing, closing!]);
            try {
                expect(writeResult).toMatchObject({ status: "fulfilled", value: f.big.length });
                expect(closeResult.status).toBe("fulfilled");
                expect(beforeRelease).not.toContain("close");
                await f.vfs.flushAll();
                const actual = findFakeByName(f.root, "Large.bin")!.data;
                const expected = new Uint8Array(f.big.length + (mode === "successor" ? tail.length : 0));
                expected.set(f.big);
                if (mode === "successor") expected.set(tail, f.big.length);
                expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
                expect(actual.length).toBe(expected.length);
            } finally {
                await f.overlay.close();
            }
        });
    }

    test("the local stream refuses operations once close has begun", async () => {
        const events: string[] = [];
        const writer = strictWritable({ close: async () => {} }, events);
        await writer.close();
        await expect(writer.seek(0)).rejects.toThrow("closing writable stream");
        await expect(writer.write(new Uint8Array([1]))).rejects.toThrow("closing writable stream");
        expect(events).toEqual(["close"]);
    });
});
