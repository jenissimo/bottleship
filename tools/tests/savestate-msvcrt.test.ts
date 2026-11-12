import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { Msvcrt, MSVCRT_BOOT_ADDRESSES, MSVCRT_FIELDS, type MsvcrtState } from "../../src/worker/modules/msvcrt";
import { resetCrtTimeStatics } from "../../src/worker/modules/crt-time";
import { resetCrtConvStatics } from "../../src/worker/modules/crt-conv";
import { openFindHandleCount, restoreVc9IoStatics } from "../../src/worker/modules/crt-vc9-io";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { ParticipantRegistry, savestateParticipants, uncoveredModules } from "../../src/worker/savestate/participant";
import { coverageModules, touchedModules } from "../../src/worker/savestate/core-participants";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Internals = Record<string, unknown> & { exports: Record<string, (c: unknown, m: Uint8Array, a: number[]) => number> };

let mem: Uint8Array;
let oldScheduler: unknown;

function boot(): Msvcrt & Internals {
    let heap = 0x2000;
    const process = {
        resetGeneration: 0,
        environment: new Map([["PATH", "C:\\"]]),
        memory: { alloc: (size: number) => { const p = heap; heap += (size + 3) & ~3; return p; }, free: () => undefined },
        v86: { mem8: mem },
        getCurrentMemory: () => mem,
    };
    const crt = new Msvcrt() as Msvcrt & Internals;
    crt.registerDataExports = () => undefined;
    crt.initialize(process as never);
    return crt;
}

function played(): Msvcrt & Internals {
    const crt = boot();
    crt.randSeed = 0x1234;
    crt.appType = 2;
    crt.userMathErrHandler = 0x401000;
    crt.newHandlerPtr = 0x402000;
    crt.newMode = 1;
    crt.crtDbgFlag = 5;
    crt.controlFpDnBits = 0x03000000;
    crt.tempnamCounter = 7;
    (crt.exitHandlers as number[]).push(0x403000, 0x404000);
    crt.fdNext = 9;
    (crt.crtAllocations as Map<number, number>).set(0x500000, 64).set(0x500100, 0);
    crt.currentLocale = "German";
    crt.localeAddr = 0x6000;
    crt.lconvAddr = 0x6100;
    crt.strerrorBuf = 0x6200;
    crt.tmpnamBuf = 0x6300;
    crt.nextFilePtr = 0x70000010;
    return crt;
}

beforeEach(() => {
    const system = System.getInstance();
    oldScheduler = system.scheduler;
    system.scheduler = { getCurrentThread: () => ({ id: 1 }), isMainThread: (id: number) => id === 1, setLastError: () => undefined } as never;
    mem = new Uint8Array(0x40000);
    Mem.bind(() => mem);
    resetCrtTimeStatics();
    resetCrtConvStatics();
    restoreVc9IoStatics({ nextFindHandle: 0x4000, asctimeBuf: 0, localtime64Buf: 0 });
});
afterEach(() => {
    System.getInstance().scheduler = oldScheduler as never;
    System.getInstance().fileSystem.reset();
    resetCrtTimeStatics();
    resetCrtConvStatics();
    restoreVc9IoStatics({ nextFindHandle: 0x4000, asctimeBuf: 0, localtime64Buf: 0 });
});

describe("msvcrt participant", () => {
    test("capture → restore → capture is byte-identical in a freshly booted module", () => {
        const first = played().captureSavestate();
        const fresh = boot();
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect((fresh.crtAllocations as Map<number, number>).get(0x500000)).toBe(64);
        expect(fresh.exitHandlers).toEqual([0x403000, 0x404000]);
    });

    test("every instance field has a policy", () => {
        expect(Object.keys(new Msvcrt()).sort()).toEqual(Object.keys(MSVCRT_FIELDS).sort());
    });

    test("every address the module allocates at boot is listed and derived", () => {
        const crt = boot();
        for (const name of MSVCRT_BOOT_ADDRESSES) {
            expect({ name, policy: (MSVCRT_FIELDS as Record<string, string>)[name] }).toEqual({ name, policy: "derive" });
        }
        const derived = Object.entries(MSVCRT_FIELDS).filter(([k, p]) => p === "derive" && k !== "timezoneState").map(([k]) => k).sort();
        expect(derived).toEqual([...MSVCRT_BOOT_ADDRESSES].sort());
        expect(crt.captureSavestate().bootAddresses.map(r => r[0])).toEqual([...MSVCRT_BOOT_ADDRESSES, "timezone"]);
    });

    test("every saved field reaches the capture and survives a restore", () => {
        const base = played().captureSavestate();
        const values: Record<keyof MsvcrtState, unknown> = {
            randSeed: 99, envpVectorAddr: 0x7000, tmpnamBuf: 0x7100, appType: 1, userMathErrHandler: 0x408000, newHandlerPtr: 0x409000,
            newMode: 0, strerrorBuf: 0x7200, crtDbgFlag: 1, controlFpDnBits: 0, tempnamCounter: 44, exitHandlers: [0x40a000],
            fdNext: 12, crtAllocations: new Uint32Array([0x600000, 8]), localeAddr: 0x7300, currentLocale: "C", lconvAddr: 0x7400,
            nextFilePtr: 0x70000020, useRealFileStructs: true,
            environment: { entries: [["A", "1"]], narrow: { ptr: 0x7500, values: [["A", 0x7506]] }, wide: { ptr: 0x7600, values: [["A", 0x760c]] } },
            strtok: 0x7700, umask: 0x80, time: { gmtimeBuf: 0x7800, localtimeBuf: 0x7900, ctimeBuf: 0x7a00 },
            cvtBuffers: [[1, 0x7b00], [2, 0x7c00]], vc9Io: { nextFindHandle: 0x4005, asctimeBuf: 0x7d00, localtime64Buf: 0x7e00 },
            bootAddresses: base.bootAddresses,
        };
        expect(Object.keys(values).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof MsvcrtState, unknown]>) {
            if (field === "bootAddresses") continue;
            expect({ field, same: bytes(value) === bytes(base[field]) }).toEqual({ field, same: false });
            const fresh = boot();
            fresh.restoreSavestate(structuredClone({ ...base, [field]: value }) as MsvcrtState);
            expect({ field, value: bytes(fresh.captureSavestate()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("strtok continues from the saved position", () => {
        const crt = boot();
        mem.set(new TextEncoder().encode("a,b,c\0"), 0x9000);
        mem.set(new TextEncoder().encode(",\0"), 0x9100);
        expect(crt.exports["strtok"]!({}, mem, [0x9000, 0x9100])).toBe(0x9000);
        const saved = crt.captureSavestate();
        expect(saved.strtok).toBe(0x9002);
        const fresh = boot();
        fresh.restoreSavestate(structuredClone(saved));
        expect(fresh.exports["strtok"]!({}, mem, [0, 0x9100])).toBe(0x9002);
        expect(fresh.exports["strtok"]!({}, mem, [0, 0x9100])).toBe(0x9004);
    });

    test("a snapshot whose boot storage sits elsewhere is not restored", () => {
        const saved = played().captureSavestate();
        const moved = structuredClone(saved);
        moved.bootAddresses[0]![1] += 4;
        const fresh = boot();
        expect(() => fresh.restoreSavestate(moved)).toThrow("errnoAddr booted at");
        expect(fresh.randSeed).toBe(1);
    });

    test("refuses open descriptors, streams, temporary files, searches and a running exit chain", () => {
        const crt = played();
        (crt.fds as Map<number, unknown>).set(3, { path: "C:\\save.dat" });
        expect(() => crt.captureSavestate()).toThrow("open file(s) are not part of a v1 savestate (C:\\save.dat)");
        (crt.fds as Map<number, unknown>).clear();
        (crt.fileStreams as Map<number, unknown>).set(0x70000000, {});
        expect(() => crt.captureSavestate()).toThrow("open file(s)");
        (crt.fileStreams as Map<number, unknown>).clear();
        (crt.temporaryFiles as Map<string, unknown>).set("x", {});
        expect(() => crt.captureSavestate()).toThrow("tmpfile");
        (crt.temporaryFiles as Map<string, unknown>).clear();
        (crt.fdHandles as Map<number, number>).set(3, 0x44);
        expect(() => crt.captureSavestate()).toThrow("Win32 handle");
        (crt.fdHandles as Map<number, number>).clear();
        crt.exitChainRunning = true;
        expect(() => crt.captureSavestate()).toThrow("exit handlers");
        crt.exitChainRunning = false;
        expect(() => crt.captureSavestate()).not.toThrow();
    });

    test("_close drops both _open_osfhandle mappings so the save and a reused handle value work again", () => {
        const crt = played();
        const fd = crt.exports["_open_osfhandle"]!({}, mem, [0x44, 0]);
        expect(crt.exports["_get_osfhandle"]!({}, mem, [fd])).toBe(0x44);
        expect(() => crt.captureSavestate()).toThrow("Win32 handle");
        // 0x44 has no kernel object behind it, so CloseHandle fails: -1, yet the fd is released.
        expect(crt.exports["_close"]!({}, mem, [fd])).toBe(-1);
        expect((crt.fdHandles as Map<number, number>).size).toBe(0);
        expect((crt.handleFds as Map<number, number>).size).toBe(0);
        expect(() => crt.captureSavestate()).not.toThrow();
        expect(crt.exports["_close"]!({}, mem, [fd])).toBe(-1);
        const again = crt.exports["_open_osfhandle"]!({}, mem, [0x44, 0]);
        expect(again).not.toBe(fd);
        expect(crt.exports["_get_osfhandle"]!({}, mem, [again])).toBe(0x44);
        expect(crt.exports["_close"]!({}, mem, [again])).toBe(-1);
        expect((crt.fdHandles as Map<number, number>).size).toBe(0);
    });

    test("_close reports a failed CloseHandle like the CRT; std pseudo-handles close cleanly", () => {
        const crt = played();
        const errno = (): number => Mem.readUint32(crt.exports["_errno"]!({}, mem, []) as number) ?? 0;
        const bad = crt.exports["_open_osfhandle"]!({}, mem, [0x4c, 0]);
        expect(crt.exports["_close"]!({}, mem, [bad])).toBe(-1);
        expect(errno()).toBe(9);
        expect(crt.exports["_get_osfhandle"]!({}, mem, [bad])).toBe(-1);
        const out = crt.exports["_open_osfhandle"]!({}, mem, [1, 0]);
        expect(crt.exports["_close"]!({}, mem, [out])).toBe(0);
        expect((crt.fdHandles as Map<number, number>).size).toBe(0);
    });

    test("fclose on an _fdopen stream drops the _open_osfhandle mappings", () => {
        const crt = played();
        const fd = crt.exports["_open_osfhandle"]!({}, mem, [0x48, 0]);
        (crt.fds as Map<number, unknown>).set(fd, { path: "C:\\log.txt", position: 0 });
        (crt.fileStreams as Map<number, unknown>).set(0x70000040, { fd, handle: { path: "C:\\log.txt" }, bufPtr: 0, structPtr: 0 });
        crt.exports["fclose"]!({}, mem, [0x70000040]);
        expect((crt.fdHandles as Map<number, number>).size).toBe(0);
        expect((crt.handleFds as Map<number, number>).size).toBe(0);
        expect(() => crt.captureSavestate()).not.toThrow();
    });

    test("_close closes the Win32 handle behind an _open_osfhandle descriptor", () => {
        const crt = played();
        const system = System.getInstance();
        const flushed: string[] = [];
        const oldFlush = system.fileSystem.flushFile;
        system.fileSystem.flushFile = async (path: string) => { flushed.push(path); };
        let closed = 0;
        const h = system.resourceProvider.registerFileHandle({ vfsHandle: { path: "C:\\log.txt", source: "overlay", position: 0 }, close: () => { closed++; } });
        try {
            const fd = crt.exports["_open_osfhandle"]!({}, mem, [h, 0]);
            expect(crt.exports["_close"]!({}, mem, [fd])).toBe(0);
            expect(system.resourceProvider.getFileHandle(h)).toBeFalsy();
            expect(closed).toBe(1);
            expect(flushed).toEqual(["C:\\log.txt"]);
            expect(fileIo.CloseHandle!({} as never, mem, [h])).toBe(0);
        } finally {
            system.fileSystem.flushFile = oldFlush;
            system.resourceProvider.unregisterFileHandle(h);
        }
    });

    test("fclose on an _fdopen stream closes the Win32 handle behind its descriptor", () => {
        const crt = played();
        const system = System.getInstance();
        mem.set([0x72, 0], 0x3000);
        let closed = 0;
        const h = system.resourceProvider.registerFileHandle({ vfsHandle: { path: "C:\\log.txt", source: "rom", position: 0 }, close: () => { closed++; } });
        try {
            const fd = crt.exports["_open_osfhandle"]!({}, mem, [h, 0]);
            const fp = crt.exports["_fdopen"]!({}, mem, [fd, 0x3000]);
            expect(fp).not.toBe(0);
            expect(crt.exports["fclose"]!({}, mem, [fp])).toBe(0);
            expect(system.resourceProvider.getFileHandle(h)).toBeFalsy();
            expect(closed).toBe(1);
            expect(fileIo.CloseHandle!({} as never, mem, [h])).toBe(0);
        } finally {
            system.resourceProvider.unregisterFileHandle(h);
        }
    });

    test("refuses while a _findfirst search is open and saves again once it is closed", () => {
        const crt = played();
        const vfs = System.getInstance().fileSystem;
        vfs.reset();
        const entry: ZipEntry = { name: "data/a.txt", compressedSize: 1, uncompressedSize: 1, compression: 0, localHeaderOffset: 0, isDirectory: false };
        const archive = { readEntryRangeSync: () => new Uint8Array(1) } as unknown as ZipArchive;
        vfs.mountRom(archive, "rom", new Map([[entry.name, entry]]));
        mem.set(new TextEncoder().encode("C:\\data\\*.txt\0"), 0xa000);
        const handle = crt.exports["_findfirst"]!({}, mem, [0xa000, 0xb000]);
        expect(handle).toBeGreaterThan(0);
        expect(openFindHandleCount()).toBe(1);
        expect(() => crt.captureSavestate()).toThrow("_findfirst");
        expect(crt.exports["_findclose"]!({}, mem, [handle])).toBe(0);
        expect(crt.captureSavestate().vc9Io.nextFindHandle).toBe(handle + 1);
    });

    test("the registered participant refuses with a CaptureRefusal and covers msvcrt", () => {
        const crt = played();
        const undo = crt.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("msvcrt")).toBe(true);
            const p = savestateParticipants.all().find(x => x.id === "msvcrt")!;
            expect(bytes(p.capture({} as never))).toBe(bytes(crt.captureSavestate()));
            (crt.fds as Map<number, unknown>).set(3, { path: "" });
            expect(() => p.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("msvcrt")).toBe(false);
    });

    test("the participant version and schema hash are pinned; a change here needs a version bump", () => {
        const undo = new Msvcrt().registerSavestate();
        const schema = savestateParticipants.schemas().msvcrt;
        undo();
        expect(schema).toEqual({ version: 1, schemaHash: "1f2216ea6607ed22" });
    });

    test("coverage names every C runtime flavour as msvcrt; the loaded-module list keeps the import names", () => {
        const loaded = () => [{ name: "kernel32" }, { name: "msvcr90" }, { name: "msvcrt" }, { name: "MSVCR71" }, { name: "api-ms-win-crt-runtime-l1-1-0" }, { name: "msvcp60" }];
        expect(touchedModules(loaded)).toEqual(["kernel32", "msvcr90", "msvcrt", "MSVCR71", "api-ms-win-crt-runtime-l1-1-0", "msvcp60"]);
        expect(coverageModules(loaded)).toEqual(["kernel32", "msvcrt", "msvcp60"]);
        const registry = new ParticipantRegistry();
        registry.add({ id: "kernel32", version: 1, covers: ["kernel32"], capture: () => null, restore: () => undefined });
        expect(uncoveredModules(coverageModules(loaded), registry.coveredModules())).toEqual(["msvcp60", "msvcrt"]);
        registry.add({ id: "msvcrt", version: 1, covers: ["msvcrt"], capture: () => null, restore: () => undefined });
        expect(uncoveredModules(coverageModules(loaded), registry.coveredModules())).toEqual(["msvcp60"]);
    });
});
