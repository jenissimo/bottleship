/**
 * CreateFileMapping(INVALID_HANDLE_VALUE, …) is pagefile-backed shared memory. Thunk args
 * arrive as uint32, so the sentinel is 0xFFFFFFFF here, never -1.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo, resetFileIoState } from "../../src/worker/modules/kernel32/file-io";

const ESP = 0x1000;
const NAME = 0x2000;

let mem: Uint8Array;

const ctx = () => ({ eax: 0, ecx: 0, edx: 0, ebx: 0, esp: ESP, ebp: 0, esi: 0, edi: 0, eip: 0, eflags: 0x202 });

function call(name: string, ...args: number[]): number {
    const r = (fileIo[name] as any)(ctx(), mem, args);
    return typeof r === "number" ? r >>> 0 : (r.value >>> 0);
}

function kernelObject(handle: number): any {
    return System.getInstance().resourceProvider.getKernelObject(handle);
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    resetFileIoState();
});

describe("pagefile-backed CreateFileMapping", () => {
    test("INVALID_HANDLE_VALUE creates an anonymous section of the requested size", () => {
        const h = call("CreateFileMappingA", 0xFFFFFFFF, 0, 4 /* PAGE_READWRITE */, 0, 0x2c, 0);
        expect(h).not.toBe(0);
        expect(kernelObject(h)).toMatchObject({ kind: "file_mapping", size: 0x2c, file: null });
    });

    test("a named section is shared by the next create of that name", () => {
        mem.set(new TextEncoder().encode("C4Shared\0"), NAME);
        const first = call("CreateFileMappingA", 0xFFFFFFFF, 0, 4, 0, 0x100, NAME);
        expect(first).not.toBe(0);
        expect(call("CreateFileMappingA", 0xFFFFFFFF, 0, 4, 0, 0x100, NAME)).toBe(first);
    });

    test("the wide form takes the same sentinel", () => {
        const h = call("CreateFileMappingW", 0xFFFFFFFF, 0, 4, 0, 0x40, 0);
        expect(h).not.toBe(0);
        expect(kernelObject(h)).toMatchObject({ size: 0x40, file: null });
    });

    test("a handle that is not a file still fails", () => {
        expect(call("CreateFileMappingA", 0x0BADF00D, 0, 4, 0, 0x40, 0)).toBe(0);
    });
});
