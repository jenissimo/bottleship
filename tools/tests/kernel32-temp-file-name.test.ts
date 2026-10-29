/**
 * GetTempFileName: with uUnique 0 it creates an empty file named <path>\<pre><hex>.tmp and
 * returns the number it used; with a nonzero uUnique it only formats that name.
 * https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettempfilenamea
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState } from "../../src/worker/core/scheduler/types";
import { TimeService } from "../../src/worker/runtime/time";
import { PathPolicy } from "../../src/worker/runtime/filesystem/path-policy";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import { registerFileIoPathExports } from "../../src/worker/modules/kernel32/file-io-path";
import { encodeUTF16LE, setFileApisAnsi, areFileApisAnsi } from "../../src/worker/modules/kernel32/file-io-strings";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { installFakeOpfs } from "./fixtures/fake-opfs";

const system = System.getInstance() as any;
const api: any = {};
registerFileIoPathExports(api);
const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let saved: any, vfs: VirtualFileSystem, memory: Uint8Array, thread: any, clock: ReturnType<typeof spyOn>;
let priorAnsi: boolean, priorCp: number;
const PATH = 64, PREFIX = 800, OUT = 2048;

beforeEach(async () => {
    saved = { process: system.process, scheduler: system.scheduler, fileSystem: system.fileSystem };
    priorAnsi = areFileApisAnsi(); priorCp = EmulatorConfig.getInstance().ansiCodePage;
    EmulatorConfig.getInstance().ansiCodePage = 1252; setFileApisAnsi(true);
    clock = spyOn(TimeService.getInstance(), "nowUnixMs").mockReturnValue(0x1234);
    installFakeOpfs();
    vfs = new VirtualFileSystem();
    await vfs.initOverlay("app:temp-name");
    vfs.setPathPolicy(new PathPolicy({ persistOnly: true, persist: ["**"] }));
    await vfs.createDirectory("C:\\temp");
    memory = new Uint8Array(4096);
    const guest = {
        resetGeneration: 0, getCurrentMemory: () => memory,
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= memory.length },
    };
    thread = { id: 1, state: ThreadState.RUNNING, lastError: 0x55, tebAddress: 0 };
    system.process = guest; system.fileSystem = vfs;
    system.scheduler = {
        process: guest, threads: new Map([[1, thread]]), getCurrentThread: () => thread,
        setLastError: (code: number) => { thread.lastError = code; },
        setThreadLastError: (t: any, code: number) => { t.lastError = code; },
        captureLastError: Scheduler.prototype.captureLastError,
    };
    input("C:\\temp", "TMP");
});
afterEach(async () => {
    await vfs.flushAll(); clock.mockRestore();
    EmulatorConfig.getInstance().ansiCodePage = priorCp; setFileApisAnsi(priorAnsi);
    Object.assign(system, saved);
    if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete (globalThis as any).navigator;
});

function input(path: string, prefix: string, wide = false) {
    memory.fill(0, PATH, 1024);
    memory.set(wide ? encodeUTF16LE(path) : new TextEncoder().encode(path + "\0"), PATH);
    memory.set(wide ? encodeUTF16LE(prefix) : new TextEncoder().encode(prefix + "\0"), PREFIX);
}
async function call(unique = 0, wide = false): Promise<number> {
    const r = api[wide ? "GetTempFileNameW" : "GetTempFileNameA"]({}, memory, [PATH, PREFIX, unique, OUT]);
    return (await r) >>> 0;
}
function output(wide = false): string {
    let end = OUT;
    if (wide) { while (memory[end] || memory[end + 1]) end += 2; return new TextDecoder("utf-16le").decode(memory.slice(OUT, end)); }
    while (memory[end]) end++;
    return new TextDecoder("windows-1252").decode(memory.slice(OUT, end));
}

test("uUnique 0 creates an empty file and returns the number it used", async () => {
    expect(await call()).toBe(0x1234);
    expect(output()).toBe("C:\\temp\\TMP1234.tmp");
    expect(vfs.fileExists(output())).toBe(true);
    expect(vfs.getFileSize(output())).toBe(0);
});

test("an existing name is skipped for the next number", async () => {
    expect(await call()).toBe(0x1234);
    expect(await call()).toBe(0x1235);
    expect(output()).toBe("C:\\temp\\TMP1235.tmp");
});

test("a nonzero uUnique formats the name without creating the file", async () => {
    expect(await call(0xbeef)).toBe(0xbeef);
    expect(output()).toBe("C:\\temp\\TMPBEEF.tmp");
    expect(vfs.fileExists(output())).toBe(false);
});

test("the prefix is at most three characters and the wide form writes UTF-16", async () => {
    input("C:\\temp", "LONGPREFIX", true);
    expect(await call(0, true)).toBe(0x1234);
    expect(output(true)).toBe("C:\\temp\\LON1234.tmp");
});

test("a missing directory fails with ERROR_PATH_NOT_FOUND", async () => {
    input("C:\\nowhere", "TMP");
    expect(await call()).toBe(0);
    expect(thread.lastError).toBe(3);
});
