/**
 * A directory is a path that exists.
 *
 * `_access(path, 0)` asks about the path's attributes, so it succeeds for a folder, and a
 * failed open of a folder is ERROR_ACCESS_DENIED / EACCES, never "not found". Director's
 * runtime probes its preferences folder with `_access` and creates it only on failure; told
 * "missing" for a folder that exists, `_mkdir` then answers EEXIST and it gives up without
 * ever writing the preferences file (Diner Dash lost every profile on exit).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { registerCrtPathExports, type CrtPathHost } from "../../src/worker/modules/crt-path";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import { preserveMemBinding } from "./helpers/scoped-process-state";

preserveMemBinding();

describe("a directory as an _access / open target", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let errno: number;

    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        Mem.bind(() => mem);
        errno = 0;
        exports = {};
        const host: CrtPathHost = {
            readCString: (ptr) => {
                let s = "";
                for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
                return s;
            },
            writeCString: (ptr, value) => {
                for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i) & 0xff;
                mem[ptr + value.length] = 0;
            },
            malloc: () => 0x8000,
            setErrno: (value) => { errno = value; return true; },
            nextTempnamSeq: () => 1,
        };
        registerCrtPathExports(exports, host);
    });
    afterEach(() => { errno = 0; });

    const access = (path: string): number => {
        for (let i = 0; i < path.length; i++) mem[0x100 + i] = path.charCodeAt(i);
        mem[0x100 + path.length] = 0;
        return (exports["_access"] as any)(null, mem, [0x100, 0]) as number;
    };

    test("_access succeeds for an existing directory", () => {
        expect(System.getInstance().fileSystem.directoryExists("C:\\")).toBe(true);
        expect(access("C:\\")).toBe(0);
    });

    test("_access still fails with ENOENT for a path that does not exist", () => {
        expect(access("C:\\no-such-folder-7f3a\\nothing.txt")).toBe(-1);
        expect(errno).toBe(2);
    });

    test("a failed open of a directory is ERROR_ACCESS_DENIED, not ERROR_FILE_NOT_FOUND", () => {
        const vfs = new VirtualFileSystem();
        const entry = (name: string): [string, ZipEntry] =>
            [name, { name, compressedSize: 1, uncompressedSize: 1, compression: 0, localHeaderOffset: 0, isDirectory: false }];
        vfs.mountRom(null as unknown as ZipArchive, "", new Map([entry("Prefs/readme.txt")]));
        expect(vfs.directoryExists("C:\\Prefs")).toBe(true);
        expect(vfs.classifyOpenFailure("C:\\Prefs", 3)).toBe(5);
        expect(vfs.classifyOpenFailure("C:\\Prefs\\missing.txt", 3)).toBe(2);
    });
});
