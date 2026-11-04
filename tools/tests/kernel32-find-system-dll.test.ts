/**
 * An HLE system DLL is on disk as far as the guest can tell: FindFirstFile and
 * GetFileAttributesEx find <system dir>\ddraw.dll exactly as GetFileAttributes already did.
 * SciTech MGL (GTA, 1997) probes for DirectDraw this way and, finding no ddraw.dll, reports
 * "Cannot find a suitable display mode" without ever calling DirectDrawCreate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";

const PATH = 0x100, FIND_DATA = 0x400, ATTR = 0x800;
let mem: Uint8Array;
let view: DataView;
const restore: Array<() => void> = [];

function writeA(s: string): void {
    for (let i = 0; i < s.length; i++) mem[PATH + i] = s.charCodeAt(i);
    mem[PATH + s.length] = 0;
}
function findName(): string {
    let s = "";
    for (let i = FIND_DATA + 44; mem[i]; i++) s += String.fromCharCode(mem[i]!);
    return s;
}

describe("HLE system DLLs are visible to directory probes", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x2000);
        view = new DataView(mem.buffer);
        Mem.bind(() => mem);
        const system = System.getInstance() as any;
        const rp = system.resourceProvider;
        const objects = new Map<number, unknown>();
        let next = 0x30000;
        system.resourceProvider = {
            ...rp,
            registerKernelObject: (o: unknown) => { objects.set(next += 4, o); return next; },
            getKernelObject: (h: number) => objects.get(h),
            unregisterKernelObject: (h: number) => objects.delete(h),
        };
        restore.push(() => { system.resourceProvider = rp; });
    });
    afterEach(() => { while (restore.length) restore.pop()!(); });

    for (const dir of ["C:\\WINDOWS\\SYSTEM", "C:\\WINDOWS\\system32"]) {
        test(`FindFirstFileA finds ${dir}\\ddraw.dll`, () => {
            writeA(`${dir}\\DDRAW.DLL`);
            const h = fileIo["FindFirstFileA"]!(null as any, mem, [PATH, FIND_DATA]) as number;
            expect(h).not.toBe(-1);
            expect(findName()).toBe("ddraw.dll");
            expect(view.getUint32(FIND_DATA, true) & 0x10).toBe(0);
            expect(view.getUint32(FIND_DATA + 32, true)).toBeGreaterThan(0);
        });
    }

    test("GetFileAttributesExA reports the same file", () => {
        writeA("C:\\WINDOWS\\SYSTEM\\ddraw.dll");
        expect(fileIo["GetFileAttributesExA"]!(null as any, mem, [PATH, 0, ATTR])).toBe(1);
        expect(view.getUint32(ATTR, true)).toBe(0x20);
    });

    test("a DLL we do not provide, and the same name outside the system directory, stay absent", () => {
        writeA("C:\\WINDOWS\\SYSTEM\\nosuchlib.dll");
        expect(fileIo["FindFirstFileA"]!(null as any, mem, [PATH, FIND_DATA])).toBe(-1);
        writeA("C:\\GAME\\ddraw.dll");
        expect(fileIo["FindFirstFileA"]!(null as any, mem, [PATH, FIND_DATA])).toBe(-1);
    });
});
