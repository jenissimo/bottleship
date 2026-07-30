import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { registerVc9IoExports, type Vc9IoHost } from "../../src/worker/modules/crt-vc9-io";
import type { VfsEntry } from "../../src/worker/runtime/filesystem/vfs";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

describe("crt-vc9-io", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let host: Vc9IoHost;

    beforeEach(() => {
        mem = new Uint8Array(0x4000);
        Mem.bind(() => mem);
        exports = {};
        host = {
            process: { v86: null },
            readCString: (ptr) => {
                let s = "";
                for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
                return s;
            },
            setErrno: () => true,
            statImpl: () => 0,
            fseek: () => 0,
            ftell: () => 42,
            filelength: () => 100,
            fileStreams: new Map(),
            malloc: (n) => {
                const p = 0x2000;
                return p + n;
            },
            writeCString: (ptr, value) => {
                for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i) & 0xff;
                mem[ptr + value.length] = 0;
            },
            memset: (ptr, val, size) => {
                mem.fill(val & 0xff, ptr, ptr + size);
                return ptr;
            },
        };
        registerVc9IoExports(exports, host);
    });

    test("asctime formats struct tm", () => {
        const tm = 0x100;
        Mem.writeUint32(tm + 0, 5);
        Mem.writeUint32(tm + 4, 30);
        Mem.writeUint32(tm + 8, 14);
        Mem.writeUint32(tm + 12, 12);
        Mem.writeUint32(tm + 16, 5);
        Mem.writeUint32(tm + 20, 126);
        const ptr = exports["asctime"]!(null as any, mem, [tm]);
        expect(ptr).toBeGreaterThan(0);
        const text = host.readCString(ptr);
        expect(text).toContain("Jun");
        expect(text).toContain("2026");
    });

    test("_time64 writes timer and returns low dword", () => {
        const timer = 0x200;
        const lo = exports["_time64"]!(null as any, mem, [timer]);
        expect(lo).toBeGreaterThan(0);
        expect(Mem.readUint32(timer)).toBe(lo);
    });

    test("_findfirst64i32 writes bounded finddata64i32 layout", () => {
        const system = System.getInstance();
        const originalListDirectory = system.fileSystem.listDirectory;
        const entry: VfsEntry = {
            path: "C:\\Games\\readme.txt",
            name: "readme.txt",
            kind: "file",
            size: 0x1234,
            source: "rom",
        };

        system.fileSystem.listDirectory = (() => [entry]) as typeof system.fileSystem.listDirectory;
        try {
            const filespec = 0x100;
            const findData = 0x300;
            const sentinel = findData + 296;
            host.writeCString(filespec, "C:\\Games\\*.txt");
            mem[sentinel] = 0xa5;

            const handle = exports["_findfirst64i32"]!(null as any, mem, [filespec, findData]);

            expect(handle).toBeGreaterThan(0);
            // attrib is the Win32 _A_* bitmask, not st_mode: _A_ARCH for a file,
            // _A_SUBDIR for a directory. A mode-shaped value here reads as
            // "no subdirectories" to every directory walker.
            expect(Mem.readUint32(findData + 0)).toBe(0x20);
            expect(Mem.readUint32(findData + 32)).toBe(0x1234);
            expect(host.readCString(findData + 36)).toBe("readme.txt");
            expect(mem[sentinel]).toBe(0xa5);
        } finally {
            system.fileSystem.listDirectory = originalListDirectory;
        }
    });

    test("_findfirst64i32 marks directories with _A_SUBDIR", () => {
        const system = System.getInstance();
        const original = system.fileSystem.listDirectory;
        const entry: VfsEntry = { path: "C:\\Games\\res", name: "res", kind: "dir", size: 0, source: "rom" };
        system.fileSystem.listDirectory = (() => [entry]) as typeof system.fileSystem.listDirectory;
        try {
            host.writeCString(0x100, "C:\\Games\\*");
            expect(exports["_findfirst64i32"]!(null as any, mem, [0x100, 0x300])).toBeGreaterThan(0);
            expect(Mem.readUint32(0x300)).toBe(0x10);
        } finally {
            system.fileSystem.listDirectory = original;
        }
    });

    test("_stat64i32 reports a directory with _S_IFDIR at st_mode (+6)", () => {
        const system = System.getInstance();
        const originalDir = system.fileSystem.directoryExists;
        system.fileSystem.directoryExists = ((p: string) =>
            p === "C:\\Data\\res") as typeof system.fileSystem.directoryExists;
        try {
            host.writeCString(0x100, "C:\\Data\\res");
            expect(exports["_stat64i32"]!(null as any, mem, [0x100, 0x300])).toBe(0);
            expect(Mem.readUint16(0x300 + 6) & 0xf000).toBe(0x4000);   // _S_IFDIR
            expect(Mem.readUint32(0x300 + 20)).toBe(0);                // st_size
        } finally {
            system.fileSystem.directoryExists = originalDir;
        }
    });

    test("_fstat64i32 reports a regular file with _S_IFREG and st_size at +20", () => {
        expect(exports["_fstat64i32"]!(null as any, mem, [3, 0x300])).toBe(0);
        expect(Mem.readUint16(0x300 + 6) & 0xf000).toBe(0x8000);       // _S_IFREG
        expect(Mem.readUint32(0x300 + 20)).toBe(100);                  // host.filelength()
    });
});
