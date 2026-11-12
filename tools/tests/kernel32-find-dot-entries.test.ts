import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";

const PATH = 0x100, FIND_DATA = 0x400;
let mem: Uint8Array;
let view: DataView;
const restore: Array<() => void> = [];

const DIRS = new Set(["C:\\", "C:\\TEMP", "C:\\TEMP\\DBPDATA"]);
const LISTING: Record<string, Array<{ name: string; kind: "file" | "dir" }>> = {
    "C:\\": [{ name: "TEMP", kind: "dir" }],
    "C:\\TEMP": [{ name: "dbpdata", kind: "dir" }, { name: "log.txt", kind: "file" }],
    "C:\\TEMP\\DBPDATA": [],
};

function writeA(s: string): void {
    for (let i = 0; i < s.length; i++) mem[PATH + i] = s.charCodeAt(i);
    mem[PATH + s.length] = 0;
}
function writeW(s: string): void {
    for (let i = 0; i < s.length; i++) view.setUint16(PATH + i * 2, s.charCodeAt(i), true);
    view.setUint16(PATH + s.length * 2, 0, true);
}
function nameA(): string {
    let s = "";
    for (let i = FIND_DATA + 44; mem[i]; i++) s += String.fromCharCode(mem[i]!);
    return s;
}
function nameW(): string {
    let s = "";
    for (let i = FIND_DATA + 44; view.getUint16(i, true); i += 2) s += String.fromCharCode(view.getUint16(i, true));
    return s;
}
function enumerate(pattern: string, wide = false): string[] {
    (wide ? writeW : writeA)(pattern);
    const h = fileIo[wide ? "FindFirstFileW" : "FindFirstFileA"]!(null as any, mem, [PATH, FIND_DATA]) as number;
    if (h === -1) return [];
    const names = [wide ? nameW() : nameA()];
    while (fileIo[wide ? "FindNextFileW" : "FindNextFileA"]!(null as any, mem, [h, FIND_DATA])) names.push(wide ? nameW() : nameA());
    fileIo["FindClose"]!(null as any, mem, [h]);
    return names;
}

describe("FindFirstFile reports . and .. outside a drive root", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x2000);
        view = new DataView(mem.buffer);
        Mem.bind(() => mem);
        const system = System.getInstance() as any;
        const rp = system.resourceProvider;
        const fs = system.fileSystem;
        const objects = new Map<number, unknown>();
        let next = 0x30000;
        system.resourceProvider = {
            ...rp,
            registerKernelObject: (o: unknown) => { objects.set(next += 4, o); return next; },
            getKernelObject: (h: number) => objects.get(h),
            unregisterKernelObject: (h: number) => objects.delete(h),
        };
        const fake = {
            currentDir: "C:\\TEMP\\DBPDATA\\",
            resolvePath(p: string): string {
                const abs = /^[A-Za-z]:\\/.test(p) ? p : fake.currentDir + p;
                const parts = abs.slice(3).split("\\").filter(x => x && x !== ".");
                return ("C:\\" + parts.join("\\")).toUpperCase();
            },
            directoryExists: (p: string) => DIRS.has(fake.resolvePath(p)),
            listDirectory: (p: string) => (LISTING[fake.resolvePath(p)] ?? []).map(e => ({ ...e, path: "", size: 0, source: "overlay" })),
            statEntry: () => null,
            statVirtualSystemFile: () => null,
        };
        system.fileSystem = fake;
        restore.push(() => { system.resourceProvider = rp; system.fileSystem = fs; });
    });
    afterEach(() => { while (restore.length) restore.pop()!(); });

    test("an empty subdirectory enumerates as . and .. instead of failing", () => {
        expect(enumerate("*.*")).toEqual([".", ".."]);
        expect(view.getUint32(FIND_DATA, true) & 0x10).toBe(0x10);
        expect(enumerate("*", true)).toEqual([".", ".."]);
    });

    test("a populated subdirectory lists . and .. ahead of its entries", () => {
        expect(enumerate("C:\\TEMP\\*.*")).toEqual([".", "..", "dbpdata", "log.txt"]);
    });

    test("a drive root, a narrower mask and a missing directory get no dot entries", () => {
        expect(enumerate("C:\\*.*")).toEqual(["TEMP"]);
        expect(enumerate("C:\\TEMP\\*.txt")).toEqual(["log.txt"]);
        expect(enumerate("C:\\NOWHERE\\*.*")).toEqual([]);
    });
});
