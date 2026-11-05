/**
 * Devices we do not emulate must answer the documented FAILURE, not a fabricated success:
 * no serial port (GetCommTimeouts), no help engine (WinHelp), no MIDI output (Miles'
 * AIL_midiOutOpen). A success here hands the caller an untouched out-struct or handle.
 */
import { afterEach, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { registerFileIoCommExports } from "../../src/worker/modules/kernel32/file-io-comm";
import { createSystemExports } from "../../src/worker/modules/user32/system";
import { createMidiDriverExports } from "../../src/worker/modules/mss32/midi-driver";
import { SmackW32 } from "../../src/worker/modules/smackw32";

afterEach(() => {
    (System as unknown as { instance: unknown }).instance = undefined;
});

test("GetCommTimeouts fails: a file is not a comm device, garbage is not a handle", () => {
    let lastError = -1;
    const FILE = 0x44;
    (System as unknown as { instance: unknown }).instance = {
        resourceProvider: { getFileHandle: (h: number) => (h === FILE ? {} : undefined) },
        scheduler: { setLastError: (e: number) => { lastError = e; } },
    };
    const exports: Record<string, any> = {};
    registerFileIoCommExports(exports);
    const mem = new Uint8Array(0x100).fill(0xcc);
    expect(exports.GetCommTimeouts(null, mem, [FILE, 0x10])).toBe(0);
    expect(lastError).toBe(1);  // ERROR_INVALID_FUNCTION
    expect(exports.GetCommTimeouts(null, mem, [0x1234, 0x10])).toBe(0);
    expect(lastError).toBe(6);  // ERROR_INVALID_HANDLE
    expect(mem[0x10]).toBe(0xcc); // COMMTIMEOUTS untouched
});

test("WinHelp fails with no help engine, but HELP_QUIT has nothing to close", () => {
    const exports = createSystemExports();
    const mem = new Uint8Array(16);
    const HELP_CONTENTS = 0x0003, HELP_QUIT = 0x0002;
    expect(exports.WinHelpA!(null as never, mem, [0x100, 0, HELP_CONTENTS, 0])).toBe(0);
    expect(exports.WinHelpW!(null as never, mem, [0x100, 0, HELP_CONTENTS, 0])).toBe(0);
    expect(exports.WinHelpA!(null as never, mem, [0x100, 0, HELP_QUIT, 0])).toBe(1);
});

test("SmackSummary leaves the caller's SmackSum untouched (layout unverified)", () => {
    const mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    let heap = 0x1000;
    const process = { memory: { alloc: (n: number) => { const p = heap; heap += n; return p; } }, getCurrentMemory: () => mem };
    const smack = new SmackW32();
    smack.initialize(process as never);
    const sum = 0x8000;
    mem.fill(0xcc, sum, sum + 0x100);
    expect(() => smack.exports["_SmackSummary@8"]!(null as never, mem, [0x1234, sum])).not.toThrow();
    expect(mem.subarray(sum, sum + 0x100).every(b => b === 0xcc)).toBe(true);
});

test("AIL_midiOutOpen reports no MIDI device and NULLs both out-handles", () => {
    const mem = new Uint8Array(0x100).fill(0xcc);
    Mem.bind(() => mem);
    const ctx = { lastErrorStr: "" } as never;
    const exports = createMidiDriverExports(ctx);
    expect(exports["_AIL_midiOutOpen@12"]!(null as never, mem, [0x10, 0x20, -1 >>> 0])).toBe(2); // MMSYSERR_BADDEVICEID
    expect([...mem.subarray(0x10, 0x14)]).toEqual([0, 0, 0, 0]);
    expect([...mem.subarray(0x20, 0x24)]).toEqual([0, 0, 0, 0]);
    expect((ctx as { lastErrorStr: string }).lastErrorStr).not.toBe("");
});
