import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";
import { newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import type { VfsEntry } from "../../src/worker/runtime/filesystem/vfs";

const PATH = 0x100, FIND_DATA = 0x400;
const listing: VfsEntry[] = [
    { path: "C:\\Data\\a.dat", name: "a.dat", kind: "file", size: 10, source: "rom", modified: 1002283642 },
    { path: "C:\\Data\\b.dat", name: "b.dat", kind: "file", size: 20, source: "overlay" },
    { path: "C:\\Data\\sub", name: "sub", kind: "dir", size: 0, source: "rom" },
    { path: "C:\\Data\\c.dat", name: "c.dat", kind: "file", size: 30, source: "rom" },
];

let mem: Uint8Array;
let objects: Map<number, unknown>;
const undo: Array<() => void> = [];

const nameAt = (): string => {
    let s = "";
    for (let i = FIND_DATA + 44; mem[i]; i++) s += String.fromCharCode(mem[i]!);
    return s;
};
const found = (): [string, number, number] => {
    const v = new DataView(mem.buffer);
    return [nameAt(), v.getUint32(FIND_DATA + 32, true), v.getUint32(FIND_DATA, true) & 0x10];
};
const next = (h: number): number => fileIo["FindNextFileA"]!(null as never, mem, [h, FIND_DATA]) as number;

describe("an open FindFirstFile handle in a savestate", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x4000);
        Mem.bind(() => mem);
        const system = System.getInstance() as unknown as Record<string, any>;
        const fs = system.fileSystem;
        const { listDirectory } = fs;
        fs.listDirectory = () => listing;
        undo.push(() => { fs.listDirectory = listDirectory; });
        const rp = system.resourceProvider;
        objects = new Map();
        let id = 0x30000;
        system.resourceProvider = {
            ...rp,
            registerKernelObject: (o: unknown) => { objects.set(id += 4, o); return id; },
            getKernelObject: (h: number) => objects.get(h),
            unregisterKernelObject: (h: number) => objects.delete(h),
        };
        undo.push(() => { system.resourceProvider = rp; });
        const text = "C:\\Data\\*.dat";
        for (let i = 0; i < text.length; i++) mem[PATH + i] = text.charCodeAt(i);
    });

    afterEach(() => { while (undo.length) undo.pop()!(); });

    function roundTrip(h: number): void {
        const graph = newObjectGraph();
        const ref = graph.ref(objects.get(h), "find handle");
        const encoded = encodeValue(graph.objects as unknown as SaveValue);
        const saved = decodeValue({ json: encoded.json, blobs: encoded.blobs.map(b => b.slice()) }) as unknown as Array<[string, SaveValue]>;
        expect(saved[ref]![0]).toBe("kernel32-find");
        objects.set(h, restoreObjectGraph(saved).object(ref));
    }

    test("the walk continues after a restore with the entries that were still to come", () => {
        const h = fileIo["FindFirstFileA"]!(null as never, mem, [PATH, FIND_DATA]) as number;
        expect(found()).toEqual(["a.dat", 10, 0]);
        expect(next(h)).toBe(1);
        expect(found()).toEqual(["b.dat", 20, 0]);
        const before = objects.get(h);
        roundTrip(h);
        expect(objects.get(h)).not.toBe(before);
        expect(next(h)).toBe(1);
        expect(found()).toEqual(["c.dat", 30, 0]);
        expect(next(h)).toBe(0);
        roundTrip(h);
        expect(next(h)).toBe(0);
    });

    test("a restored walk matches the one that was never saved, entry for entry, times included", () => {
        const live = fileIo["FindFirstFileA"]!(null as never, mem, [PATH, FIND_DATA]) as number;
        const saved = fileIo["FindFirstFileA"]!(null as never, mem, [PATH, FIND_DATA]) as number;
        roundTrip(saved);
        for (;;) {
            const a = next(live);
            const liveBytes = mem.slice(FIND_DATA, FIND_DATA + 320);
            const b = next(saved);
            expect(b).toBe(a);
            if (!a) break;
            expect([...mem.subarray(FIND_DATA, FIND_DATA + 320)]).toEqual([...liveBytes]);
        }
    });

    test("only the remaining entries are saved, and a listing that changes afterwards does not reach the handle", () => {
        const h = fileIo["FindFirstFileA"]!(null as never, mem, [PATH, FIND_DATA]) as number;
        const graph = newObjectGraph();
        graph.ref(objects.get(h), "find handle");
        expect((graph.objects[0]![1] as { remaining: unknown[] }).remaining.length).toBe(2);
        roundTrip(h);
        listing.push({ path: "C:\\Data\\z.dat", name: "z.dat", kind: "file", size: 1, source: "overlay" });
        undo.push(() => { listing.pop(); });
        expect(next(h)).toBe(1);
        expect(next(h)).toBe(1);
        expect(found()[0]).toBe("c.dat");
        expect(next(h)).toBe(0);
    });
});
