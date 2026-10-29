/**
 * Every surface that reports a file's time reports the SAME, non-zero instant: the time a
 * ROM entry records, else the shared default.
 *
 * MSVC's _findfirst/_stat convert a zero FILETIME to time_t -1, and localtime(-1) is NULL:
 * a title that formats a save's date dereferences it. Four producers answering four
 * different instants (zero among them) is how that slipped through. A title can also
 * check a data file's date against the one it shipped with, and take another load path
 * when they differ. That date is a DOS wall-clock reading, so the guest must see it as LOCAL
 * time: the FILETIME is the reading converted to UTC with the guest's bias.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";
import { exports as time } from "../../src/worker/modules/kernel32/time/time";
import type { VfsEntry } from "../../src/worker/runtime/filesystem/vfs";
import { VFS_FILETIME, VFS_FILE_TIME_UNIX_SECONDS } from "../../src/worker/runtime/filesystem/file-time";

const PATH = 0x100;
const FIND_DATA = 0x400;
const FT_OUT = 0x800;

const save: VfsEntry = { path: "C:\\Saves\\Rage\\Rage", name: "Rage", kind: "file", size: 16, source: "overlay" };
const dir: VfsEntry = { path: "C:\\Saves\\Rage", name: "Rage", kind: "dir", size: 0, source: "overlay" };
/** 2001-10-05 12:07:22 wall clock, as an installer recorded it. */
const SHIPPED = 1002283642;
/** Pinned so the bias is known and non-zero: Tokyo is UTC+9 with no DST. */
const ZONE = "Asia/Tokyo";
const SHIPPED_FILETIME = (BigInt(SHIPPED - 9 * 3600) + 11644473600n) * 10_000_000n;
const map: VfsEntry = { path: "C:\\Mods\\mp_castle.map", name: "mp_castle.map", kind: "file", size: 3214482, source: "rom", modified: SHIPPED };
const SAVE_HANDLE = 0x50004, MAP_HANDLE = 0x50008;

let mem: Uint8Array;
let view: DataView;
const restore: Array<() => void> = [];

function writeA(ptr: number, s: string): void {
    for (let i = 0; i < s.length; i++) mem[ptr + i] = s.charCodeAt(i);
    mem[ptr + s.length] = 0;
}

/** WIN32_FIND_DATA ftCreationTime / ftLastAccessTime / ftLastWriteTime. */
function findTimes(): bigint[] {
    return [4, 12, 20].map((o) => view.getBigUint64(FIND_DATA + o, true));
}

describe("kernel32 file times", () => {
    const hostZone = process.env.TZ;
    beforeAll(() => { process.env.TZ = ZONE; });
    afterAll(() => {
        if (hostZone === undefined) delete process.env.TZ;
        else process.env.TZ = hostZone;
    });

    beforeEach(() => {
        mem = new Uint8Array(0x4000);
        view = new DataView(mem.buffer);
        Mem.bind(() => mem);
        const system = System.getInstance() as any;
        const fs = system.fileSystem;
        const { statEntry, listDirectory } = fs;
        fs.statEntry = (p: string) => [save, map].find((e) => e.path.toLowerCase() === p.toLowerCase()) ?? null;
        fs.listDirectory = () => [dir, save];
        restore.push(() => { fs.statEntry = statEntry; fs.listDirectory = listDirectory; });
        const rp = system.resourceProvider;
        const objects = new Map<number, unknown>();
        let next = 0x30000;
        system.resourceProvider = {
            ...rp,
            registerKernelObject: (o: unknown) => { objects.set(next += 4, o); return next; },
            getKernelObject: (h: number) => objects.get(h),
            unregisterKernelObject: (h: number) => objects.delete(h),
            getFileHandle: (h: number) => h === SAVE_HANDLE ? { vfsHandle: { path: save.path } }
                : h === MAP_HANDLE ? { vfsHandle: { path: map.path } } : null,
        };
        restore.push(() => { system.resourceProvider = rp; });
    });

    afterEach(() => {
        while (restore.length) restore.pop()!();
    });

    test("the shared instant is the time_t the CRT reports, and is not zero", () => {
        expect(VFS_FILETIME).not.toBe(0n);
        expect((VFS_FILETIME / 10_000_000n) - 11644473600n).toBe(BigInt(VFS_FILE_TIME_UNIX_SECONDS));
    });

    test("FindFirstFileA on an exact path fills the shared instant", () => {
        writeA(PATH, save.path);
        expect(fileIo["FindFirstFileA"]!(null as any, mem, [PATH, FIND_DATA])).not.toBe(-1);
        expect(findTimes()).toEqual([VFS_FILETIME, VFS_FILETIME, VFS_FILETIME]);
    });

    test("FindFirstFileA/FindNextFileA enumeration fills the shared instant for dirs and files", () => {
        writeA(PATH, "C:\\Saves\\*");
        const h = fileIo["FindFirstFileA"]!(null as any, mem, [PATH, FIND_DATA]) as number;
        expect(h).not.toBe(-1);
        expect(findTimes()).toEqual([VFS_FILETIME, VFS_FILETIME, VFS_FILETIME]);
        mem.fill(0, FIND_DATA, FIND_DATA + 320);
        expect(fileIo["FindNextFileA"]!(null as any, mem, [h, FIND_DATA])).toBe(1);
        expect(findTimes()).toEqual([VFS_FILETIME, VFS_FILETIME, VFS_FILETIME]);
    });

    test("FindFirstFileW fills the shared instant", () => {
        for (let i = 0; i < save.path.length; i++) view.setUint16(PATH + i * 2, save.path.charCodeAt(i), true);
        view.setUint16(PATH + save.path.length * 2, 0, true);
        expect(fileIo["FindFirstFileW"]!(null as any, mem, [PATH, FIND_DATA])).not.toBe(-1);
        expect(findTimes()).toEqual([VFS_FILETIME, VFS_FILETIME, VFS_FILETIME]);
    });

    test("GetFileTime reports the same instant as the find data", () => {
        expect(time["GetFileTime"]!(null as any, mem, [SAVE_HANDLE, FT_OUT, FT_OUT + 8, FT_OUT + 16])).toBe(1);
        expect([0, 8, 16].map((o) => view.getBigUint64(FT_OUT + o, true)))
            .toEqual([VFS_FILETIME, VFS_FILETIME, VFS_FILETIME]);
    });

    test("a ROM entry's recorded time reaches the find data, GetFileTime and GetFileAttributesEx", () => {
        writeA(PATH, map.path);
        expect(fileIo["FindFirstFileA"]!(null as any, mem, [PATH, FIND_DATA])).not.toBe(-1);
        expect(findTimes()).toEqual([SHIPPED_FILETIME, SHIPPED_FILETIME, SHIPPED_FILETIME]);

        expect(time["GetFileTime"]!(null as any, mem, [MAP_HANDLE, FT_OUT, FT_OUT + 8, FT_OUT + 16])).toBe(1);
        expect([0, 8, 16].map((o) => view.getBigUint64(FT_OUT + o, true)))
            .toEqual([SHIPPED_FILETIME, SHIPPED_FILETIME, SHIPPED_FILETIME]);

        mem.fill(0, FIND_DATA, FIND_DATA + 64);
        expect(fileIo["GetFileAttributesExA"]!(null as any, mem, [PATH, 0, FIND_DATA])).toBe(1);
        expect(findTimes()).toEqual([SHIPPED_FILETIME, SHIPPED_FILETIME, SHIPPED_FILETIME]);
    });

    test("the guest's local view of a ROM entry's time is the recorded reading", () => {
        expect(time["GetFileTime"]!(null as any, mem, [MAP_HANDLE, 0, 0, FT_OUT])).toBe(1);
        time["FileTimeToLocalFileTime"]!(null as any, mem, [FT_OUT, FT_OUT + 8]);
        expect(view.getBigUint64(FT_OUT + 8, true)).toBe((BigInt(SHIPPED) + 11644473600n) * 10_000_000n);
    });
});
