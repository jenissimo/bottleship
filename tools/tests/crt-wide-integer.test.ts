import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Logger } from "../../src/worker/core/logger";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import { registerCrtWideIntegerExports } from "../../src/worker/modules/crt-wide-integer";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";
import { preserveMemBinding } from "./helpers/scoped-process-state";

preserveMemBinding();
let mem: Uint8Array, errno: number;
let exports: Record<string, ThunkImplementation>;
const OUT = 0x2000;
const read = (): string => {
    let value = "";
    for (let i = 0; i < 64; i++) {
        const code = Mem.readUint16(OUT + i * 2);
        if (!code) break;
        value += String.fromCharCode(code);
    }
    return value;
};
const call = (name: string, ...args: number[]): number => exports[name]!(null as never, mem, args) as number;
let quietLog: ReturnType<typeof spyOn>, quietError: ReturnType<typeof spyOn>;
afterEach(() => { quietLog.mockRestore(); quietError.mockRestore(); });
beforeEach(() => {
    quietLog = spyOn(Logger, "log").mockImplementation(() => {});
    quietError = spyOn(Logger, "error").mockImplementation(() => {});
    mem = new Uint8Array(0x10000).fill(0x55);
    Mem.bind(() => mem);
    errno = 123;
    exports = {};
    registerCrtWideIntegerExports(exports, { setErrno: e => { errno = e; } });
});
for (const name of ["_ltow", "_ltow_s"]) {
    test(name + " declares cdecl with 32-bit long parameters", () => {
        const f = msvcrtModule.functions.find(f => f.name === name)!;
        expect(f.callingConvention).toBe("cdecl");
        expect(f.params.length).toBe(name.endsWith("_s") ? 4 : 3);
    });
    test(name + " formats signed decimal and unsigned non-decimal 32-bit values", () => {
        for (const [value, radix, expected] of [[0, 10, "0"], [-1, 10, "-1"], [-1, 16, "ffffffff"], [0x80000000, 10, "-2147483648"], [0x80000000, 2, "10000000000000000000000000000000"], [35, 36, "z"]] as const) {
            const result = name.endsWith("_s") ? call(name, value, OUT, 64, radix) : call(name, value, OUT, radix);
            expect(result).toBe(name.endsWith("_s") ? 0 : OUT);
            expect(read()).toBe(expected);
            expect(errno).toBe(123);
        }
    });
}
test("secure capacity counts wchar_t units including the terminator", () => {
    expect(call("_ltow_s", 123, OUT, 4, 10)).toBe(0);
    expect(read()).toBe("123");
    expect(Mem.readUint16(OUT + 8)).toBe(0x5555);
    expect(errno).toBe(123);
});
test("a short secure buffer is emptied with ERANGE and no write past capacity", () => {
    expect(call("_ltow_s", 123, OUT, 3, 10)).toBe(34);
    expect(read()).toBe("");
    expect(Mem.readUint16(OUT + 6)).toBe(0x5555);
    expect(errno).toBe(34);
    expect(call("_ltow_s", 0, OUT, 1, 10)).toBe(34);
});
test("null or zero capacity returns EINVAL without writing", () => {
    expect(call("_ltow_s", 1, 0, 64, 10)).toBe(22);
    expect(call("_ltow_s", 1, OUT, 0, 10)).toBe(22);
    expect(Mem.readUint16(OUT)).toBe(0x5555);
    expect(errno).toBe(22);
});
test("invalid radices empty a nonempty secure buffer", () => {
    for (const radix of [-1, 0, 1, 37]) {
        expect(call("_ltow_s", 1, OUT, 64, radix)).toBe(22);
        expect(read()).toBe("");
        expect(errno).toBe(22);
    }
});
test("large capacity does not cause a capacity-sized scan or write", () => {
    expect(call("_ltow_s", 1, OUT, 0xffffffff, 10)).toBe(0);
    expect(read()).toBe("1");
    expect(Mem.readUint16(OUT + 4)).toBe(0x5555);
});
