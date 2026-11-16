import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Logger } from "../../src/worker/core/logger";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

let mem: Uint8Array, errno: number, next: number;
let exports: Record<string, ThunkImplementation>;
function put(ptr: number, value: string): number {
    for (let i = 0; i < value.length; i++) Mem.writeUint16(ptr + i * 2, value.charCodeAt(i));
    Mem.writeUint16(ptr + value.length * 2, 0);
    return ptr;
}
function read(ptr: number, max = 32768): string {
    let value = "";
    for (let i = 0; i < max; i++) {
        const ch = Mem.readUint16(ptr + i * 2);
        if (!ch) break;
        value += String.fromCharCode(ch);
    }
    return value;
}
const str = (value: string): number => { const ptr = next; next += value.length * 2 + 16; return put(ptr, value); };
const call = (name: string, ...args: number[]): number => exports[name]!(null as never, mem, args) as number;
import { registerCrtWideFormatExports } from "../../src/worker/modules/crt-wide-format";
import { ArrayVaListReader, formatCLazy } from "../../src/worker/modules/crt-format";
let quietLog: ReturnType<typeof spyOn>, quietError: ReturnType<typeof spyOn>;
afterEach(() => { quietLog.mockRestore(); quietError.mockRestore(); });
beforeEach(() => {
    quietLog = spyOn(Logger, "log").mockImplementation(() => {});
    quietError = spyOn(Logger, "error").mockImplementation(() => {});
    mem = new Uint8Array(0x10000).fill(0x55); Mem.bind(() => mem);
    errno = 123; next = 0x2000; exports = {};
    registerCrtWideFormatExports(exports, {
        setErrno: e => { errno = e; },
    });
});
for (const name of ["swprintf_s", "_snwprintf_s"]) {
    test(name + " binds cdecl varargs with the same slot budget as printf", () => {
        const f = msvcrtModule.functions.find(f => f.name === name)!;
        expect(f.callingConvention).toBe("cdecl");
        expect(f.params.length).toBe(msvcrtModule.functions.find(f => f.name === "printf")!.params.length);
    });
    test(name + " formats wide/narrow strings and a promoted double", () => {
        mem.set(new TextEncoder().encode("ANSI\0"), 0x800);
        const value = new DataView(new ArrayBuffer(8)); value.setFloat64(0, 1.25, true);
        const args = [0x1000, 32, ...(name.startsWith("_") ? [31] : []), str("%s %hs %d %.2f"), str("日本"), 0x800, -7,
            value.getUint32(0, true), value.getUint32(4, true)];
        expect(call(name, ...args)).toBe(15);
        expect(read(0x1000)).toBe("日本 ANSI -7 1.25");
        expect(errno).toBe(123);
    });
    test(name + " clears overflow and keeps the guard unit", () => {
        expect(call(name, 0x1000, 4, ...(name.startsWith("_") ? [4] : []), str("abcdef"))).toBe(-1);
        expect(read(0x1000)).toBe(""); expect(errno).toBe(34);
        expect(Mem.readUint16(0x1008)).toBe(0x5555);
    });
    test(name + " handles exact fit and invalid output/format", () => {
        const args = name.startsWith("_") ? [4] : [];
        expect(call(name, 0x1000, 4, ...args, str("abc"))).toBe(3);
        expect(read(0x1000)).toBe("abc");
        expect(call(name, 0x1000, 4, ...args, 0)).toBe(-1);
        expect(errno).toBe(22);
        expect(call(name, 0, 4, ...args, str("x"))).toBe(-1);
        expect(call(name, 0x1000, 0, ...args, str("x"))).toBe(-1);
    });
}
test("count truncation and _TRUNCATE preserve errno and terminate", () => {
    const fmt = str("abcdef");
    expect(call("_snwprintf_s", 0x1000, 8, 3, fmt)).toBe(-1);
    expect(read(0x1000)).toBe("abc"); expect(errno).toBe(123);
    expect(call("_snwprintf_s", 0x1000, 4, 0xffffffff, fmt)).toBe(-1);
    expect(read(0x1000)).toBe("abc"); expect(errno).toBe(123);
    expect(call("_snwprintf_s", 0x1000, 8, 0xffffffff, fmt)).toBe(6);
});
test("zero count terminates output and distinguishes an empty result", () => {
    expect(call("_snwprintf_s", 0, 0, 0, 0)).toBe(0);
    expect(call("_snwprintf_s", 0x1000, 4, 0, str("%s"), str("x"))).toBe(-1);
    expect(read(0x1000)).toBe(""); expect(errno).toBe(123);
    expect(call("_snwprintf_s", 0x1000, 4, 0, str(""))).toBe(0);
});

const savedMemBinding = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, Object.getOwnPropertyDescriptor(Mem, k)] as const);
afterAll(() => { for (const [k, d] of savedMemBinding) if (d) Object.defineProperty(Mem, k, d); });

for (const name of ["swprintf_s", "_snwprintf_s"]) {
    for (const value of ["%q", "%", "x%n", "%hn", "%I64n", "%s %q", "%3$u", "%I32"]) {
        test(name + " refuses secure format " + value + " before formatting side effects", () => {
            const canary = 0x1800;
            const fmt = str(value);
            expect(call(name, 0x1000, 32, ...(name.startsWith("_") ? [31] : []), fmt, canary)).toBe(-1);
            expect(errno).toBe(22);
            expect(read(0x1000)).toBe("");
            expect(Mem.readUint32(canary)).toBe(0x55555555);
            expect(Mem.readUint16(0x1002)).toBe(0x5555);
        });
    }
    test(name + " permits literal percent signs and valid flags, width and precision", () => {
        expect(call(name, 0x1000, 32, ...(name.startsWith("_") ? [31] : []), str("%% %#08x %*.*d"), 42, 4, 2, 7)).toBe(15);
        expect(read(0x1000)).toBe("% 0x00002a   07");
    });
}
test("legacy formatter retains its existing %n and unknown-format behavior", () => {
    expect(formatCLazy("x%n %q", new ArrayVaListReader([0x1800], 0), () => "")).toBe("x %q");
    expect(Mem.readUint32(0x1800)).toBe(1);
});
