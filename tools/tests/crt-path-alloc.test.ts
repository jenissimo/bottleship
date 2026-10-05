/**
 * CRT path functions: the buffer==NULL OWNERSHIP contract.
 *
 * `_getcwd`/`_getdcwd`/`_fullpath` with a NULL buffer malloc the block themselves and
 * hand ownership to the caller — and the block must be at least as large as the size the
 * caller asked for, because the caller keeps writing into it up to that size. Sizing it to
 * strlen(cwd) instead is a silent heap overrun into the next allocation, which is how
 * System Shock 2 (NewDark) died: the engine's string class adopts the block with
 * capacity=maxLen, appends the relative path in place, and overran an 8-byte block by 21
 * bytes onto a neighbouring container's element array.
 *
 * Ground truth: Wine dlls/msvcrt/dir.c `_getcwd` — `if (size < len) size = len; buf = malloc(size)`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { registerCrtPathExports, type CrtPathHost } from "../../src/worker/modules/crt-path";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const MAX_PATH = 260;

describe("crt-path NULL-buffer allocation contract", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let mallocSizes: number[];
    let host: CrtPathHost;

    /** Bump allocator that remembers every requested size. */
    function makeHost(): CrtPathHost {
        let next = 0x1000;
        return {
            readCString: (ptr) => {
                let s = "";
                for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
                return s;
            },
            writeCString: (ptr, value) => {
                for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i) & 0xff;
                mem[ptr + value.length] = 0;
            },
            malloc: (size) => {
                mallocSizes.push(size);
                const p = next;
                next += Math.max(8, size + 8);
                return p;
            },
            setErrno: () => true,
            nextTempnamSeq: () => 1,
        };
    }

    beforeEach(() => {
        mem = new Uint8Array(0x20000);
        Mem.bind(() => mem);
        exports = {};
        mallocSizes = [];
        host = makeHost();
        (System.getInstance() as any).currentDirectory = "C:\\";
        registerCrtPathExports(exports, host);
    });

    const call = (name: string, ...args: number[]) =>
        (exports[name] as any)(null, mem, args) as number;

    test("_getcwd(NULL, maxLen) allocates at least maxLen bytes, not strlen(cwd)+1", () => {
        const ptr = call("_getcwd", 0, MAX_PATH);
        expect(ptr).toBeGreaterThan(0);
        expect(mallocSizes).toHaveLength(1);
        // The regression: cwd is "C:\" so the buggy version asked for 4 bytes.
        expect(mallocSizes[0]).toBeGreaterThanOrEqual(MAX_PATH);
        expect(host.readCString(ptr, MAX_PATH)).toBe("C:\\");
    });

    test("_getcwd(NULL, tiny) still fits the cwd itself", () => {
        (System.getInstance() as any).currentDirectory = "C:\\Games\\SS2\\Data";
        const ptr = call("_getcwd", 0, 4);
        expect(ptr).toBeGreaterThan(0);
        expect(mallocSizes[0]).toBeGreaterThanOrEqual("C:\\Games\\SS2\\Data".length + 1);
        expect(host.readCString(ptr, 64)).toBe("C:\\Games\\SS2\\Data");
    });

    test("_getcwd(buffer, maxLen) still writes in place and never allocates", () => {
        const buf = 0x8000;
        const ptr = call("_getcwd", buf, 64);
        expect(ptr).toBe(buf);
        expect(mallocSizes).toHaveLength(0);
    });

    test("_getcwd(buffer, tooSmall) fails with ERANGE rather than overrunning", () => {
        (System.getInstance() as any).currentDirectory = "C:\\Games\\SS2";
        const buf = 0x8000;
        mem[buf + 3] = 0x7f;                       // canary just past the room we allow
        expect(call("_getcwd", buf, 3)).toBe(0);
        expect(mem[buf + 3]).toBe(0x7f);
    });

    test("_fullpath(NULL, rel, n) returns a POINTER to a _MAX_PATH block, not a length", () => {
        const rel = 0x9000;
        host.writeCString(rel, "Data\\cutscenes\\intro.avi");
        const ptr = call("_fullpath", 0, rel, 32);
        expect(mallocSizes).toHaveLength(1);
        expect(mallocSizes[0]).toBeGreaterThanOrEqual(MAX_PATH);
        expect(ptr).toBe(0x1000);                  // the block, not strlen+1
        expect(host.readCString(ptr, MAX_PATH)).toBe("C:\\Data\\cutscenes\\intro.avi");
    });
});
