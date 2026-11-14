import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Advapi32 } from "../../src/worker/modules/advapi32";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { System } from "../../src/worker/core/system";

const OUT = 0x200000, LEN = 0x210000, SRC = 0x220000, DEST = 0x230000;
const SID = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 16, 0, 32, 0, 0]);
let mem: Uint8Array, view: DataView, space: AddressSpace, api: Advapi32["exports"], lastError: number;
let previousProcess: ReturnType<typeof System.getInstance>["process"];
let errorSpy: { mockRestore(): void };

beforeEach(() => {
    const system = System.getInstance();
    previousProcess = system.process;
    mem = new Uint8Array(4 << 20);
    view = new DataView(mem.buffer);
    space = new AddressSpace(() => mem);
    for (const base of [OUT, LEN, SRC, DEST]) space.registerRegion({ base, size: 0x1000, perms: "rw", kind: "HEAP" });
    system.process = { addressSpace: space } as never;
    errorSpy = spyOn(system.scheduler, "setLastError").mockImplementation(value => { lastError = value; });
    const mod = new Advapi32();
    mod.initialize({ resourceProvider: { getKernelObject: () => null } } as never);
    api = mod.exports;
    mem.set(SID, SRC);
    lastError = 0;
});

afterEach(() => {
    errorSpy.mockRestore();
    System.getInstance().process = previousProcess;
});

function call(name: string, ...args: number[]): number {
    return (api[name]!({} as never, mem, args) as { value: number }).value >>> 0;
}

test("GetTokenInformation probes all four ReturnLength bytes before writing, including size queries", () => {
    for (const perms of ["r", "noaccess"] as const) {
        space.protect(LEN + 2, 2, perms);
        for (const [buffer, capacity] of [[0, 0], [OUT, 64]]) {
            view.setUint32(LEN, 0xdeadbeef, true);
            expect(call("GetTokenInformation", 0x1acc, 25, buffer!, capacity!, LEN)).toBe(0);
            expect(lastError).toBe(87);
            expect(view.getUint32(LEN, true)).toBe(0xdeadbeef);
        }
    }
});

test("GetTokenInformation refuses a protected result and out-of-bounds pointers without partial writes", () => {
    mem.fill(0x5a, OUT, OUT + 64);
    space.protect(OUT + 8, 12, "r");
    expect(call("GetTokenInformation", 0x1acc, 25, OUT, 64, LEN)).toBe(0);
    expect(mem.slice(OUT, OUT + 64)).toEqual(new Uint8Array(64).fill(0x5a));
    expect(view.getUint32(LEN, true)).toBe(20);
    expect(call("GetTokenInformation", 0x1acc, 25, mem.length - 1, 64, LEN)).toBe(0);
    expect(call("GetTokenInformation", 0x1acc, 25, OUT, 64, mem.length - 2)).toBe(0);
    expect(call("GetTokenInformation", 0x1acc, 25, OUT, 64, 0)).toBe(0);
});

test("SID readers refuse both an unreadable header and an unreadable subauthority before copying", () => {
    for (const [offset, length] of [[0, 8], [8, 4]]) {
        space.protect(SRC, 12, "rw");
        space.protect(SRC + offset!, length!, "noaccess");
        mem.fill(0x5a, DEST, DEST + 12);
        expect(call("CopySid", 12, DEST, SRC)).toBe(0);
        expect(lastError).toBe(87);
        expect(mem.slice(DEST, DEST + 12)).toEqual(new Uint8Array(12).fill(0x5a));
        expect(call("GetLengthSid", SRC)).toBe(0);
        expect(call("EqualSid", SRC, SRC)).toBe(0);
        // These two Win32 accessors compute addresses; they do not dereference the SID.
        expect(call("GetSidSubAuthorityCount", SRC)).toBe(SRC + 1);
        expect(call("GetSidSubAuthority", SRC, 0)).toBe(SRC + 8);
    }
});

test("SID readers accept a read-only source while CopySid probes the entire destination", () => {
    space.protect(SRC, 12, "r");
    expect(call("GetLengthSid", SRC)).toBe(12);
    expect(call("CopySid", 12, DEST, SRC)).toBe(1);
    expect(mem.slice(DEST, DEST + 12)).toEqual(SID);
    expect(call("EqualSid", SRC, DEST)).toBe(1);
    space.protect(DEST + 11, 1, "r");
    mem.fill(0x5a, DEST, DEST + 12);
    expect(call("CopySid", 12, DEST, SRC)).toBe(0);
    expect(mem.slice(DEST, DEST + 12)).toEqual(new Uint8Array(12).fill(0x5a));
    expect(call("CopySid", 12, mem.length - 2, SRC)).toBe(0);
});

test("a SID header whose body extends beyond memory is refused without a host exception", () => {
    const truncated = mem.length - 10;
    space.registerRegion({ base: truncated, size: 10, perms: "rw", kind: "HEAP" });
    mem.set(SID.subarray(0, 10), truncated);
    expect(call("CopySid", 12, DEST, truncated)).toBe(0);
    expect(call("GetLengthSid", truncated)).toBe(0);
    expect(call("EqualSid", truncated, truncated)).toBe(0);
});
