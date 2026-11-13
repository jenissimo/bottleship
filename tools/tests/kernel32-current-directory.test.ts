/**
 * GetCurrentDirectory returns the directory without a trailing backslash, except for a drive root.
 * https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getcurrentdirectory
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { registerFileIoPathExports } from "../../src/worker/modules/kernel32/file-io-path";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { setFileApisAnsi, areFileApisAnsi } from "../../src/worker/modules/kernel32/file-io-strings";

const system = System.getInstance() as any;
const api: any = {};
registerFileIoPathExports(api);
let savedFs: any, priorAnsi: boolean, priorCp: number;
const memory = new Uint8Array(512);

beforeEach(() => {
    savedFs = system.fileSystem;
    priorAnsi = areFileApisAnsi(); priorCp = EmulatorConfig.getInstance().ansiCodePage;
    EmulatorConfig.getInstance().ansiCodePage = 1252; setFileApisAnsi(true);
    memory.fill(0);
});
afterEach(() => {
    system.fileSystem = savedFs;
    EmulatorConfig.getInstance().ansiCodePage = priorCp; setFileApisAnsi(priorAnsi);
});

const cwd = (dir: string) => { system.fileSystem = { currentDir: dir }; };
const text = (at: number) => { let s = ""; while (memory[at]) s += String.fromCharCode(memory[at++]); return s; };

test.each([
    ["C:\\Games\\Foo", "C:\\Games\\Foo"],
    ["C:\\Games\\Foo\\", "C:\\Games\\Foo"],
    ["C:\\", "C:\\"],
])("GetCurrentDirectoryA(%s)", (dir, expected) => {
    cwd(dir);
    expect(api.GetCurrentDirectoryA({}, memory, [260, 16])).toBe(expected.length);
    expect(text(16)).toBe(expected);
});

test("GetCurrentDirectoryA reports the size including the NUL when the buffer is too small", () => {
    cwd("C:\\Games\\Foo");
    expect(api.GetCurrentDirectoryA({}, memory, [4, 16])).toBe("C:\\Games\\Foo".length + 1);
});

test("GetCurrentDirectoryW matches", () => {
    cwd("C:\\Games\\Foo\\");
    expect(api.GetCurrentDirectoryW({}, memory, [260, 16])).toBe("C:\\Games\\Foo".length);
    expect(new TextDecoder("utf-16le").decode(memory.subarray(16, 16 + 2 * "C:\\Games\\Foo".length))).toBe("C:\\Games\\Foo");
});
