/**
 * _hwrite/_lwrite are WriteFile with a count result, and a zero count is SetEndOfFile at the
 * file pointer — they share those implementations rather than a copy of them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";

const HANDLE = 0x50004, BUF = 0x100, HFILE_ERROR = -1;

let mem: Uint8Array;
let written: Uint8Array[];
let truncated: Array<[string, number]>;
const restore: Array<() => void> = [];

describe("kernel32 _hwrite", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x1000);
        Mem.bind(() => mem);
        written = [];
        truncated = [];
        const system = System.getInstance() as any;
        const fs = system.fileSystem;
        const { writeSync, truncateAt } = fs;
        fs.writeSync = (_h: unknown, data: Uint8Array) => { written.push(data); return data.length; };
        fs.truncateAt = async (path: string, at: number) => { truncated.push([path, at]); };
        restore.push(() => { fs.writeSync = writeSync; fs.truncateAt = truncateAt; });
        const rp = system.resourceProvider;
        system.resourceProvider = {
            ...rp,
            getFileHandle: (h: number) => h === HANDLE ? { vfsHandle: { path: "C:\\save.dat", position: 3 } } : null,
        };
        restore.push(() => { system.resourceProvider = rp; });
    });

    afterEach(() => {
        while (restore.length) restore.pop()!();
    });

    test("writes the buffer through WriteFile and returns the count", () => {
        mem.set([1, 2, 3, 4], BUF);
        expect(fileIo["_hwrite"]!(null as any, mem, [HANDLE, BUF, 4])).toBe(4);
        expect([...written[0]!]).toEqual([1, 2, 3, 4]);
        expect(fileIo["_lwrite"]!(null as any, mem, [HANDLE, BUF, 2])).toBe(2);
    });

    test("a zero count truncates at the file pointer and returns 0", async () => {
        const r = await fileIo["_hwrite"]!(null as any, mem, [HANDLE, BUF, 0]);
        expect(r).toEqual({ value: 0 });
        expect(truncated).toEqual([["C:\\save.dat", 3]]);
        expect(written).toEqual([]);
    });

    test("an invalid handle is HFILE_ERROR", () => {
        expect(fileIo["_hwrite"]!(null as any, mem, [0x1234, BUF, 4])).toBe(HFILE_ERROR);
        expect(fileIo["_hwrite"]!(null as any, mem, [0x1234, BUF, 0])).toBe(HFILE_ERROR);
    });
});
