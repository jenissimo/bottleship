import { afterEach, beforeEach, expect, test } from "bun:test";
import { CrtEnvironment, readWideEnvironmentString } from "../../src/worker/modules/crt-environment";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { Msvcrt } from "../../src/worker/modules/msvcrt";

let memory: Uint8Array;
let environment: Map<string, string>;
let crt: CrtEnvironment;
let published: number;
let errno: number;
let allocations: number;
let failAt: number;
let freed: number[];
let originalCodePage: number;

beforeEach(() => {
    memory = new Uint8Array(0x40000);
    Mem.bind(() => memory, (ptr, size) => ptr > 0 && ptr + size <= memory.length);
    environment = new Map([["PATH", "C:\\WINDOWS"], ["TEMP", "C:\\TEMP"]]);
    published = errno = allocations = failAt = 0;
    freed = [];
    let next = 0x4000;
    crt = new CrtEnvironment(environment, {
        alloc(size) {
            if (++allocations === failAt) return 0;
            const ptr = next;
            next += (size + 7) & ~7;
            return ptr;
        },
        free: ptr => { freed.push(ptr); },
        setErrno: value => { errno = value; },
        publish: vector => { published = vector; },
    });
    originalCodePage = EmulatorConfig.getInstance().ansiCodePage;
    EmulatorConfig.getInstance().ansiCodePage = 65001;
});

afterEach(() => { EmulatorConfig.getInstance().ansiCodePage = originalCodePage; });

function narrow(ptr: number): string {
    let end = ptr;
    while (memory[end]) end++;
    return new TextDecoder().decode(memory.subarray(ptr, end));
}

test("getenv uses a case-insensitive snapshot and returns stable guest-owned pointers", () => {
    const vector = crt.vector();
    expect(published).toBe(vector);
    expect(narrow(Mem.readUint32(vector)!)).toBe("PATH=C:\\WINDOWS");
    expect(Mem.readUint32(vector + 8)).toBe(0);
    const value = crt.get("path");
    const count = allocations;
    for (let i = 0; i < 20; i++) expect(crt.get("PaTh")).toBe(value);
    expect(allocations).toBe(count);
    environment.set("PATH", "changed by Win32");
    expect(narrow(crt.get("PATH"))).toBe("C:\\WINDOWS");
    expect(crt.get("missing")).toBe(0);
});

test("putenv publishes the complete environment and synchronizes the Win32 map", () => {
    const old = crt.vector();
    expect(crt.put("FontConfig_Path=C:\\custom fonts=a")).toBe(0);
    expect(narrow(crt.get("fontconfig_path"))).toBe("C:\\custom fonts=a");
    expect(environment.get("FONTCONFIG_PATH")).toBe("C:\\custom fonts=a");
    expect(published).not.toBe(old);
    expect(narrow(Mem.readUint32(published + 8)!)).toBe("FONTCONFIG_PATH=C:\\custom fonts=a");
    expect(Mem.readUint32(published + 12)).toBe(0);
    expect(freed).toContain(old);
    expect(crt.put("FONTCONFIG_PATH=")).toBe(0);
    expect(crt.get("FONTCONFIG_PATH")).toBe(0);
    expect(environment.has("FONTCONFIG_PATH")).toBe(false);
});

test("wide environment is created lazily and narrow/wide updates keep both copies coherent", () => {
    crt.vector();
    expect(allocations).toBe(1);
    expect(readWideEnvironmentString(crt.get("path", true))).toBe("C:\\WINDOWS");
    expect(allocations).toBe(2);
    expect(crt.put("FONT=日本語", true)).toBe(0);
    expect(readWideEnvironmentString(crt.get("font", true))).toBe("日本語");
    expect(narrow(crt.get("FONT"))).toBe("日本語");
    expect(crt.put("FONT=updated")).toBe(0);
    expect(readWideEnvironmentString(crt.get("FONT", true))).toBe("updated");
});

test("a failed wide-copy allocation preserves both prior blocks and the process environment", () => {
    const vector = crt.vector();
    const wide = crt.get("PATH", true);
    failAt = allocations + 2;
    expect(crt.put("PATH=replacement")).toBe(-1);
    expect(errno).toBe(12);
    expect(published).toBe(vector);
    expect(narrow(crt.get("PATH"))).toBe("C:\\WINDOWS");
    expect(crt.get("PATH", true)).toBe(wide);
    expect(environment.get("PATH")).toBe("C:\\WINDOWS");
    expect(freed).toHaveLength(1);
    expect(freed).not.toContain(vector);
});

test("invalid definitions fail without mutating or allocating environment state", () => {
    for (const definition of ["", "PATH", "=invalid"]) expect(crt.put(definition)).toBe(-1);
    expect(errno).toBe(22);
    expect(allocations).toBe(0);
    expect(environment.get("PATH")).toBe("C:\\WINDOWS");
});

test("__getmainargs does not erase the first environment entry", () => {
    const vector = crt.vector();
    const module = new Msvcrt() as any;
    module.acmdlnAddr = 0x1000;
    module.arg0Addr = 0x1800;
    module.argvVectorAddr = 0x2000;
    module.envpVectorAddr = vector;
    module.environVarAddr = 0x2100;
    expect(module.getMainArgs(0, 0, 0x2200, 0, 0)).toBe(0);
    expect(Mem.readUint32(0x2100)).toBe(vector);
    expect(Mem.readUint32(0x2200)).toBe(vector);
    expect(narrow(Mem.readUint32(vector)!)).toBe("PATH=C:\\WINDOWS");
});
