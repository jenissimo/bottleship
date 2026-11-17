import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { registerFileIoFindExports } from "../../src/worker/modules/kernel32/file-io-find";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const PATH = 0x100, DATA = 0x400;
const api: Record<string, ThunkImplementation> = {};
registerFileIoFindExports(api);
let mem: Uint8Array, view: DataView, vfs: VirtualFileSystem, lastError: number;
let objects: Map<number, unknown>;
const restore: Array<() => void> = [];

function first(pattern: string, wide: boolean): number {
    mem.fill(0, PATH, DATA);
    for (let i = 0; i < pattern.length; i++) {
        if (wide) view.setUint16(PATH + i * 2, pattern.charCodeAt(i), true);
        else mem[PATH + i] = pattern.charCodeAt(i);
    }
    return api[wide ? "FindFirstFileW" : "FindFirstFileA"]!(null as any, mem, [PATH, DATA]) as number;
}
function name(wide: boolean): string {
    let out = "";
    for (let i = DATA + 44; ; i += wide ? 2 : 1) {
        const ch = wide ? view.getUint16(i, true) : mem[i]!;
        if (!ch) return out;
        out += String.fromCharCode(ch);
    }
}
function checkDirectory(pattern: string, expected: string, wide: boolean): void {
    const handle = first(pattern, wide);
    expect(handle).not.toBe(-1);
    if (handle === -1) return;
    expect(name(wide)).toBe(expected);
    expect(view.getUint32(DATA, true)).toBe(0x10);
    expect(api[wide ? "FindNextFileW" : "FindNextFileA"]!(null as any, mem, [handle, DATA])).toBe(0);
    expect(lastError).toBe(18);
    expect(api.FindClose!(null as any, mem, [handle])).toBe(1);
    expect(objects.has(handle)).toBe(false);
}
function enumerate(pattern: string, wide: boolean): string[] {
    const handle = first(pattern, wide);
    if (handle === -1) return [];
    const names = [name(wide)];
    while (api[wide ? "FindNextFileW" : "FindNextFileA"]!(null as any, mem, [handle, DATA])) names.push(name(wide));
    api.FindClose!(null as any, mem, [handle]);
    return names;
}

beforeEach(() => {
    const descriptors = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(
        key => [key, Object.getOwnPropertyDescriptor(Mem, key)] as const,
    );
    restore.push(() => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(Mem, key, descriptor);
            else Reflect.deleteProperty(Mem, key);
        }
    });
    mem = new Uint8Array(0x2000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    vfs = new VirtualFileSystem();
    const entries = ["Parent/Game/game.dat", "Parent/Game/readme.txt", "Parent/Empty/"].map(rel => [
        rel, { name: "rom/" + rel, compressedSize: 1, uncompressedSize: 1, compression: 0,
            localHeaderOffset: 0, isDirectory: rel.endsWith("/") } as ZipEntry,
    ] as const);
    // Enumeration only uses metadata; no archive payload is read.
    vfs.mountRom(null as unknown as ZipArchive, "rom", new Map(entries));
    expect(vfs.setCurrentDirectory("C:\\Parent\\Game")).toBe(true);
    const system = System.getInstance() as any;
    const oldFs = system.fileSystem, oldResources = system.resourceProvider;
    const oldLastError = system.scheduler.setLastError;
    objects = new Map();
    let next = 0x30000;
    system.fileSystem = vfs;
    system.resourceProvider = {
        registerKernelObject(o: unknown) { const h = next += 4; objects.set(h, o); return h; },
        getKernelObject(h: number) { return objects.get(h); },
        unregisterKernelObject(h: number) { return objects.delete(h); },
    };
    lastError = 0;
    system.scheduler.setLastError = (e: number) => { lastError = e; };
    restore.push(() => {
        system.fileSystem = oldFs;
        system.resourceProvider = oldResources;
        system.scheduler.setLastError = oldLastError;
    });
});
afterEach(() => { while (restore.length) restore.pop()!(); });

for (const wide of [false, true]) {
    describe("FindFirstFile" + (wide ? "W" : "A") + " exact dot directories", () => {
        test("bare and drive-relative dot paths return the actual directory name", () => {
            for (const [pattern, expected] of [[".", "Game"], ["..", "Parent"], ["C:.", "Game"], ["C:..", "Parent"]]) {
                checkDirectory(pattern!, expected!, wide);
            }
        });
        test("qualified dot paths and empty directories use the same exact handle semantics", () => {
            checkDirectory("C:/Parent/Game/.", "Game", wide);
            checkDirectory("C:/Parent/Game/..", "Parent", wide);
            expect(vfs.setCurrentDirectory("C:\\Parent\\Empty")).toBe(true);
            checkDirectory(".", "Empty", wide);
        });
        test("a resolved drive root has no matching directory entry", () => {
            for (const pattern of ["C:/.", "C:/..", "C:/Parent/.."]) {
                expect(first(pattern, wide)).toBe(-1);
                expect(lastError).toBe(2);
            }
            expect(vfs.setCurrentDirectory("C:\\Parent")).toBe(true);
            expect(first("..", wide)).toBe(-1);
            expect(lastError).toBe(2);
            expect(vfs.setCurrentDirectory("C:\\")).toBe(true);
            for (const pattern of [".", ".."]) {
                expect(first(pattern, wide)).toBe(-1);
                expect(lastError).toBe(2);
            }
            expect(objects.size).toBe(0);
        });
        test("root rejection is independent of writable overlay root metadata", () => {
            const original = vfs.statEntry.bind(vfs);
            vfs.statEntry = p => vfs.resolvePath(p) === "C:\\"
                ? { path: "C:\\", name: "", kind: "dir", size: 0, source: "overlay" }
                : original(p);
            expect(vfs.setCurrentDirectory("C:\\")).toBe(true);
            expect(first(".", wide)).toBe(-1);
            expect(lastError).toBe(2);
            expect(first("C:/Parent/..", wide)).toBe(-1);
            expect(lastError).toBe(2);
            expect(objects.size).toBe(0);
        });
        test("DOS wildcards retain dot entries and narrower masks retain file results", () => {
            for (const pattern of ["*", "*.*"]) {
                expect(enumerate(pattern, wide)).toEqual([".", "..", "game.dat", "readme.txt"]);
            }
            expect(enumerate("*.dat", wide)).toEqual(["game.dat"]);
            expect(enumerate("C:/Parent/Game/missing.dat", wide)).toEqual([]);
            expect(lastError).toBe(2);
            expect(first("", wide)).toBe(-1);
            expect(lastError).toBe(3);
        });
    });
}
