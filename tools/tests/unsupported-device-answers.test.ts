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

// SmackSum (Smacker 3.x) is 19 DWORDs = 0x4c. HEROES2W.EXE benchmarks its intro clip with
// TotalOpenTime(+0x08) + TotalReadTime(+0x1c) < 2000 and TotalDecompTime(+0x20) < 1300;
// the field right after the struct in its globals is a separate byte.
function smackWithSum() {
    const mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    let heap = 0x1000;
    const process = { memory: { alloc: (n: number) => { const p = heap; heap += n; return p; } }, getCurrentMemory: () => mem };
    const smack = new SmackW32();
    smack.initialize(process as never);
    const sum = 0x8000;
    mem.fill(0xcc, sum, sum + 0x100);
    const u32 = (o: number) => new DataView(mem.buffer).getUint32(sum + o, true);
    return { mem, smack, sum, u32 };
}

test("SmackSummary fills frame rate and frames shown, zeroes every measured statistic", () => {
    const { mem, smack, sum, u32 } = smackWithSum();
    const hSmack = 0x4000;
    (smack as unknown as { sessions: Map<number, unknown> }).sessions.set(hSmack, { fps: 15, framesDisplayed: 42 });
    smack.exports["_SmackSummary@8"]!(null as never, mem, [hSmack, sum]);
    expect(u32(0x04)).toBe(6667);           // MS100PerFrame: 100000 / 15 fps
    expect(u32(0x0c)).toBe(42);             // TotalFrames
    for (const off of [0x00, 0x08, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x28, 0x2c, 0x30, 0x34, 0x38, 0x3c, 0x40, 0x44, 0x48]) {
        expect(u32(off)).toBe(0);
    }
    expect(mem[sum + 0x4c]).toBe(0xcc);     // nothing past the 0x4c-byte struct
});

test("SmackSummary on a handle with no session reports an empty summary", () => {
    const { mem, smack, sum, u32 } = smackWithSum();
    smack.exports["_SmackSummary@8"]!(null as never, mem, [0x1234, sum]);
    for (let off = 0; off < 0x4c; off += 4) expect(u32(off)).toBe(0);
    expect(mem[sum + 0x4c]).toBe(0xcc);
    expect(() => smack.exports["_SmackSummary@8"]!(null as never, mem, [0x1234, 0])).not.toThrow();
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
