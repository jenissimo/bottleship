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
import { registerCrtWideCopyExports } from "../../src/worker/modules/crt-wide-copy";
let quietLog: ReturnType<typeof spyOn>, quietError: ReturnType<typeof spyOn>;
afterEach(() => { quietLog.mockRestore(); quietError.mockRestore(); });
beforeEach(() => {
    quietLog = spyOn(Logger, "log").mockImplementation(() => {});
    quietError = spyOn(Logger, "error").mockImplementation(() => {});
    mem = new Uint8Array(0x10000).fill(0x55); Mem.bind(() => mem);
    errno = 123; next = 0x2000; exports = {};
    registerCrtWideCopyExports(exports, { setErrno: e => { errno = e; } });
});
for (const name of ["wcscpy_s", "wcscat_s", "wcsncpy_s", "wcsncat_s"]) {
    test(name + " declares a cdecl ABI", () => {
        const f = msvcrtModule.functions.find(f => f.name === name)!;
        expect(f.callingConvention).toBe("cdecl");
        expect(f.params.length).toBe(name.includes("n") ? 4 : 3);
    });
    test(name + " counts UTF-16 units, preserves the buffer tail and errno", () => {
        const append = name.includes("cat");
        put(0x1000, append ? "a" : "old text");
        const text = "日本😀";
        expect(call(name, 0x1000, append ? 6 : 5, str(text), 100)).toBe(0);
        expect(read(0x1000)).toBe((append ? "a" : "") + text);
        expect(Mem.readUint16(0x1000 + (append ? 12 : 10))).toBe(append ? 0x5555 : 'e'.charCodeAt(0));
        expect(errno).toBe(123);
    });
    test(name + " clears only the first unit on overflow", () => {
        put(0x1000, "ab");
        Mem.writeUint16(0x1008, 0xbeef);
        expect(call(name, 0x1000, 4, str("abcdef"), 6)).toBe(34);
        expect(read(0x1000)).toBe("");
        expect(Mem.readUint16(0x1008)).toBe(0xbeef);
        expect(errno).toBe(34);
    });
    test(name + " rejects null arguments and zero capacity", () => {
        expect(call(name, 0, 4, str("x"), 1)).toBe(22);
        put(0x1000, "keep");
        expect(call(name, 0x1000, 0, str("x"), 1)).toBe(22);
        expect(read(0x1000)).toBe("keep");
        expect(call(name, 0x1000, 8, 0, 1)).toBe(22);
        expect(read(0x1000)).toBe("");
    });
}
test("bounded copies do not require a source terminator or pad the output", () => {
    const src = str("abcdef");
    expect(call("wcsncpy_s", 0x1000, 4, src, 3)).toBe(0);
    expect(read(0x1000)).toBe("abc");
    expect(Mem.readUint16(0x1008)).toBe(0x5555);
});
test("_TRUNCATE reports truncation without changing errno", () => {
    put(0x1000, "a");
    expect(call("wcsncat_s", 0x1000, 4, str("bcd"), 0xffffffff)).toBe(80);
    expect(read(0x1000)).toBe("abc");
    expect(errno).toBe(123);
    expect(call("wcsncpy_s", 0x1000, 4, str("abc"), 0xffffffff)).toBe(0);
    expect(call("wcsncpy_s", 0x1000, 1, str("a"), 0xffffffff)).toBe(80);
    expect(read(0x1000)).toBe("");
});
test("zero-count copies allow a null source; a null/zero destination is a no-op", () => {
    expect(call("wcsncpy_s", 0, 0, 0, 0)).toBe(0);
    put(0x1000, "ab");
    expect(call("wcsncat_s", 0x1000, 4, 0, 0)).toBe(0);
    expect(read(0x1000)).toBe("ab");
    expect(call("wcsncpy_s", 0x1000, 4, 0, 0)).toBe(0);
    expect(read(0x1000)).toBe("");
});
test("append rejects an unterminated destination within its capacity", () => {
    const src = str("x");
    expect(call("wcscat_s", 0x1000, 4, src)).toBe(22);
    expect(read(0x1000)).toBe("");
    expect(Mem.readUint16(0x1008)).toBe(0x5555);
});

const savedMemBinding = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, Object.getOwnPropertyDescriptor(Mem, k)] as const);
afterAll(() => { for (const [k, d] of savedMemBinding) if (d) Object.defineProperty(Mem, k, d); });

for (const name of ["wcsncpy_s", "wcsncat_s"]) {
    test(name + " accepts the null destination zero-count no-op without changing errno", () => {
        expect(call(name, 0, 0, 0, 0)).toBe(0);
        expect(errno).toBe(123);
    });
}

test("wcscpy_s propagates a refused character store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcscpy_s", 0x1000, 8, src)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});

test("wcscpy_s propagates a refused terminator store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000 + 4;
    });
    expect(() => call("wcscpy_s", 0x1000, 8, src)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000 + 4);
    expect(Mem.readUint16(0x1000 + 4)).toBe(0x5555);
    expect(errno).toBe(123);
});

test("wcscpy_s propagates a refused clearing store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcscpy_s", 0x1000, 8, 0)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});

test("wcscat_s propagates a refused character store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcscat_s", 0x1000, 8, src)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});

test("wcscat_s propagates a refused terminator store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000 + 4;
    });
    expect(() => call("wcscat_s", 0x1000, 8, src)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000 + 4);
    expect(Mem.readUint16(0x1000 + 4)).toBe(0x5555);
    expect(errno).toBe(123);
});

test("wcscat_s propagates a refused clearing store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcscat_s", 0x1000, 8, 0)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});

test("wcsncpy_s propagates a refused character store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcsncpy_s", 0x1000, 8, src, 2)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});

test("wcsncpy_s propagates a refused terminator store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000 + 4;
    });
    expect(() => call("wcsncpy_s", 0x1000, 8, src, 2)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000 + 4);
    expect(Mem.readUint16(0x1000 + 4)).toBe(0x5555);
    expect(errno).toBe(123);
});

test("wcsncpy_s propagates a refused clearing store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcsncpy_s", 0x1000, 8, 0, 2)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});

test("wcsncat_s propagates a refused character store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcsncat_s", 0x1000, 8, src, 2)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});

test("wcsncat_s propagates a refused terminator store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000 + 4;
    });
    expect(() => call("wcsncat_s", 0x1000, 8, src, 2)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000 + 4);
    expect(Mem.readUint16(0x1000 + 4)).toBe(0x5555);
    expect(errno).toBe(123);
});

test("wcsncat_s propagates a refused clearing store", () => {
    put(0x1000, ""); const src = str("xy");
    const writes: number[] = [];
    Mem.bind(() => mem, (address, _size, perms) => {
        if (!perms.includes("w")) return true;
        writes.push(address);
        return address !== 0x1000;
    });
    expect(() => call("wcsncat_s", 0x1000, 8, 0, 2)).toThrow(/invalid guest write/);
    expect(writes.at(-1)).toBe(0x1000);
    expect(Mem.readUint16(0x1000)).toBe(0);
    expect(errno).toBe(123);
});
