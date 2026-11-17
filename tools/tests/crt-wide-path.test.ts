import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

let originalProcess: ReturnType<typeof System.getInstance>["process"];
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
import { registerCrtWidePathExports } from "../../src/worker/modules/crt-wide-path";
import { System } from "../../src/worker/core/system";
let cwd: string, allocated: number[], failAllocation: boolean;
beforeEach(() => {
    originalProcess = System.getInstance().process;
    System.getInstance().process = null;
    mem = new Uint8Array(0x10000).fill(0x55); Mem.bind(() => mem);
    errno = 123; next = 0x2000; exports = {}; allocated = []; failAllocation = false;
    cwd = System.getInstance().fileSystem.currentDir;
    System.getInstance().fileSystem.currentDir = "C:\\Game\\data\\";
    registerCrtWidePathExports(exports, {
        malloc: bytes => { allocated.push(bytes); return failAllocation ? 0 : 0x8000; },
        setErrno: e => { errno = e; } });
});
afterEach(() => { System.getInstance().fileSystem.currentDir = cwd; });
test("path declarations have cdecl arities", () => {
    for (const [name, arity] of [["_wfullpath", 3], ["_wmakepath_s", 6], ["_wsplitpath_s", 9]] as const) {
        const f = msvcrtModule.functions.find(f => f.name === name)!;
        expect(f.callingConvention).toBe("cdecl"); expect(f.params.length).toBe(arity);
    }
});
for (const [input, expected] of [
    ["../日本/file.dat", "C:/Game/日本/file.dat"], ["C:../x", "C:/Game/x"],
    ["D:x", "D:/x"], ["/root/../x", "C:/x"], ["C:/../../x", "C:/x"],
    ["//server/share/dir/../../x", "//server/share/x"], ["", "C:/Game/data"],
]) test("_wfullpath resolves " + input, () => {
    expect(call("_wfullpath", 0x1000, str(input), 100)).toBe(0x1000);
    expect(read(0x1000).replaceAll("\\", "/")).toBe(expected);
});
test("allocation uses UTF-16 bytes and failure does not publish a buffer", () => {
    expect(call("_wfullpath", 0, str("日本"), 0)).toBe(0x8000);
    expect(allocated).toEqual([(read(0x8000).length + 1) * 2]);
    failAllocation = true;
    expect(call("_wfullpath", 0, str("x"), 100)).toBe(0); expect(errno).toBe(12);
});
test("_wfullpath handles null input, zero size and insufficient capacity", () => {
    expect(call("_wfullpath", 0x1000, 0, 100)).toBe(0x1000);
    expect(read(0x1000)).toBe("C:\\Game\\data");
    put(0x1000, "keep");
    expect(call("_wfullpath", 0x1000, str("long"), 2)).toBe(0);
    expect(errno).toBe(34); expect(read(0x1000)).toBe("");
    expect(call("_wfullpath", 0x1000, str("x"), 0)).toBe(0); expect(errno).toBe(22);
});
test("_wmakepath_s accepts optional components and counts UTF-16 units", () => {
    expect(call("_wmakepath_s", 0x1000, 32, str("C:"), str("/日本"), str("name"), str("dat"))).toBe(0);
    expect(read(0x1000)).toBe("C:/日本\\name.dat");
    expect(call("_wmakepath_s", 0x1000, 2, 0, 0, str("x"), 0)).toBe(0);
    expect(read(0x1000)).toBe("x");
    expect(call("_wmakepath_s", 0x1000, 1, 0, 0, str("x"), 0)).toBe(34);
    expect(read(0x1000)).toBe("");
    expect(call("_wmakepath_s", 0, 4, 0, 0, 0, 0)).toBe(22);
});
test("_wsplitpath_s preserves separators and handles dotfiles and omitted components", () => {
    const args = [0x1000, 3, 0x1100, 32, 0x1200, 32, 0x1300, 16];
    expect(call("_wsplitpath_s", str("C:/日本\\sub/name.tar.gz"), ...args)).toBe(0);
    expect([0x1000, 0x1100, 0x1200, 0x1300].map(p => read(p))).toEqual(["C:", "/日本\\sub/", "name.tar", ".gz"]);
    expect(call("_wsplitpath_s", str(".profile"), 0, 0, 0, 0, 0x1200, 32, 0x1300, 16)).toBe(0);
    expect([read(0x1200), read(0x1300)]).toEqual(["", ".profile"]);
});
test("a short split component clears all outputs, while invalid pairs return EINVAL", () => {
    expect(call("_wsplitpath_s", str("C:/dir/long.dat"), 0x1000, 3, 0x1100, 16, 0x1200, 2, 0x1300, 8)).toBe(34);
    for (const ptr of [0x1000, 0x1100, 0x1200, 0x1300]) expect(read(ptr)).toBe("");
    expect(call("_wsplitpath_s", str("x"), 0x1000, 0, 0, 0, 0, 0, 0, 0)).toBe(22);
    expect(call("_wsplitpath_s", 0, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(22);
});

const savedMemBinding = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, Object.getOwnPropertyDescriptor(Mem, k)] as const);
afterAll(() => { for (const [k, d] of savedMemBinding) if (d) Object.defineProperty(Mem, k, d); });

for (const [input, expected] of [
    ["C:\\folder\\", "C:\\folder\\"],
    ["\\\\server\\share\\folder\\", "\\\\server\\share\\folder\\"],
    ["C:\\folder\\file.  ", "C:\\folder\\file"],
    ["C:\\foo   ", "C:\\foo"],
    ["\\\\?\\C:\\folder\\file.  ", "\\\\?\\C:\\folder\\file"],
]) test("_wfullpath preserves the native normalization of " + input, () => {
    expect(call("_wfullpath", 0x1000, str(input), 100)).toBe(0x1000);
    expect(read(0x1000)).toBe(expected);
    expect(errno).toBe(123);
});
test("_wfullpath includes a retained trailing separator in its capacity check", () => {
    put(0x1000, "old");
    const input = str("C:\\folder\\");
    expect(call("_wfullpath", 0x1000, input, 10)).toBe(0);
    expect(errno).toBe(34);
    expect(read(0x1000)).toBe("");
    expect(Mem.readUint16(0x1002)).toBe('l'.charCodeAt(0));
    expect(call("_wfullpath", 0x1000, input, 11)).toBe(0x1000);
    expect(read(0x1000)).toBe("C:\\folder\\");
});

// Observed with the Windows UCRT _wfullpath entry point, including namespace prefixes.
for (const [input, expected] of [
    [
        "C:\\folder\\",
        "C:\\folder\\"
    ],
    [
        "\\\\server\\share\\folder\\",
        "\\\\server\\share\\folder\\"
    ],
    [
        "C:\\folder\\file.  ",
        "C:\\folder\\file"
    ],
    [
        "C:\\foo   ",
        "C:\\foo"
    ],
    [
        "C:\\foo.\\bar",
        "C:\\foo\\bar"
    ],
    [
        "C:\\foo \\bar",
        "C:\\foo \\bar"
    ],
    [
        "C:\\foo.\\",
        "C:\\foo\\"
    ],
    [
        "C:\\foo \\",
        "C:\\foo \\"
    ],
    [
        "C:\\foo\\..",
        "C:\\"
    ],
    [
        "C:\\foo\\.",
        "C:\\foo"
    ],
    [
        "C:\\foo\\..\\",
        "C:\\"
    ],
    [
        "\\\\?\\C:\\folder\\file.  ",
        "\\\\?\\C:\\folder\\file"
    ],
    [
        "\\\\?\\C:\\folder\\..\\x",
        "\\\\?\\C:\\x"
    ],
    [
        "\\\\?\\UNC\\server\\share\\folder\\..\\x",
        "\\\\?\\UNC\\server\\share\\x"
    ],
    [
        "\\\\.\\C:\\folder\\file.  ",
        "\\\\.\\C:\\folder\\file"
    ],
    [
        "\\\\?\\C:/folder/file.  ",
        "\\\\?\\C:\\folder\\file"
    ]
]) test("_wfullpath matches native UCRT for " + input, () => {
    expect(call("_wfullpath", 0x1000, str(input!), 100)).toBe(0x1000);
    expect(read(0x1000)).toBe(expected!);
});

afterEach(() => { System.getInstance().process = originalProcess; });
