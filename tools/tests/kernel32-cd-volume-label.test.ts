/**
 * GetVolumeInformation reports the bundle's disc label (manifest emulator.cdLabel) as D:'s
 * volume name: a retail title verifying its disc compares exactly this string. Unset, D:
 * keeps the emulator's generic label, and the label is per-game state cleared on a switch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";

const ERROR_MORE_DATA = 234;
const ROOT = 0x1000;
const NAME = 0x1100;
const FS_NAME = 0x1200;
const NAME_CHARS = 0x40;

type Api = (ctx: never, mem: Uint8Array, args: number[]) => number;

describe("GetVolumeInformation D: label", () => {
    const vfs = System.getInstance().fileSystem;
    const scheduler = System.getInstance().scheduler as unknown as { setLastError: (code: number) => void };
    let savedSetLastError: (code: number) => void;
    let mem: Uint8Array;
    let lastError = 0;

    beforeEach(() => {
        mem = new Uint8Array(0x2000);
        Mem.bind(() => mem);
        savedSetLastError = scheduler.setLastError;
        lastError = -1;
        scheduler.setLastError = (code: number) => { lastError = code; };
        vfs.setCdVolumeLabel(null);
    });
    afterEach(() => {
        scheduler.setLastError = savedSetLastError;
        vfs.setCdVolumeLabel(null);
    });

    const readA = (at: number) => {
        let s = "";
        for (let i = at; mem[i]; i++) s += String.fromCharCode(mem[i]!);
        return s;
    };
    const readW = (at: number) => {
        let s = "";
        for (let i = at; mem[i] || mem[i + 1]; i += 2) s += String.fromCharCode(mem[i]! | (mem[i + 1]! << 8));
        return s;
    };

    /** GetVolumeInformationA(root) → [ok, volume name, file system name]. */
    const volumeA = (root: string, nameCap = NAME_CHARS): [number, string, string] => {
        mem.fill(0, ROOT, 0x2000);
        mem.set(new TextEncoder().encode(root + "\0"), ROOT);
        const ok = (fileIo["GetVolumeInformationA"] as unknown as Api)(
            null as never, mem, [ROOT, NAME, nameCap, 0, 0, 0, FS_NAME, NAME_CHARS]);
        return [ok, readA(NAME), readA(FS_NAME)];
    };
    const volumeW = (root: string): [number, string, string] => {
        mem.fill(0, ROOT, 0x2000);
        for (let i = 0; i < root.length; i++) mem[ROOT + i * 2] = root.charCodeAt(i);
        const ok = (fileIo["GetVolumeInformationW"] as unknown as Api)(
            null as never, mem, [ROOT, NAME, NAME_CHARS, 0, 0, 0, FS_NAME, NAME_CHARS]);
        return [ok, readW(NAME), readW(FS_NAME)];
    };

    test("with no label set, D: is the emulator's generic CD", () => {
        expect(volumeA("D:\\")).toEqual([1, "BOTTLESHIP_CD", "CDFS"]);
        expect(volumeW("D:\\")).toEqual([1, "BOTTLESHIP_CD", "CDFS"]);
    });

    test("the bundle's label is D:'s volume name, through both A and W", () => {
        vfs.setCdVolumeLabel("BFN_PC");
        expect(volumeA("D:\\")).toEqual([1, "BFN_PC", "CDFS"]);
        expect(volumeW("D:\\")).toEqual([1, "BFN_PC", "CDFS"]);
        expect(lastError).toBe(0);
    });

    test("it applies to D: alone; C: keeps its own label", () => {
        vfs.setCdVolumeLabel("BFN_PC");
        expect(volumeA("C:\\")).toEqual([1, "BOTTLESHIP", "FAT32"]);
        expect(volumeW("C:\\")).toEqual([1, "BOTTLESHIP", "FAT32"]);
    });

    test("the label is reported as given, and a blank one means none", () => {
        vfs.setCdVolumeLabel("  MY DISC");
        expect(volumeA("D:\\")[1]).toBe("  MY DISC");
        for (const blank of ["", "   "]) {
            vfs.setCdVolumeLabel(blank);
            expect(vfs.getCdVolumeLabel()).toBeNull();
            expect(volumeA("D:\\")[1]).toBe("BOTTLESHIP_CD");
        }
    });

    test("a buffer too small for the label is ERROR_MORE_DATA, as for any volume name", () => {
        vfs.setCdVolumeLabel("BFN_PC");
        expect(volumeA("D:\\", 6)[0]).toBe(0);
        expect(lastError).toBe(ERROR_MORE_DATA);
        expect(volumeA("D:\\", 7)).toEqual([1, "BFN_PC", "CDFS"]);
    });

    test("a game switch clears the label", () => {
        vfs.setCdVolumeLabel("BFN_PC");
        vfs.reset();
        expect(vfs.getCdVolumeLabel()).toBeNull();
        expect(volumeA("D:\\")[1]).toBe("BOTTLESHIP_CD");
    });
});
