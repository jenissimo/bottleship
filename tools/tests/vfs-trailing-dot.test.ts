/**
 * Win32 path normalization drops trailing dots and spaces from each component, so a
 * game that builds "<dir>.\file" (Rise of Nations writes "...\Rise of Nations.\gamelog.ini")
 * is naming a file inside <dir>.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { normalizeGuestPath } from "../../src/worker/runtime/filesystem/guest-path-resolver";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
import { installFakeOpfs, findFakeByName } from "./fixtures/fake-opfs";

const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;

const origNavigator = (globalThis as unknown as { navigator: unknown }).navigator;
afterAll(() => { (globalThis as unknown as { navigator: unknown }).navigator = origNavigator; });

describe("VFS trailing dots", () => {
    test("a file created under \"Dir.\" lands in Dir", async () => {
        const root = installFakeOpfs();
        const vfs = new VirtualFileSystem();
        vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
        await vfs.initOverlay("test:trailing-dot");

        expect(vfs.createDirectorySync("C:\\Game Data").ok).toBe(true);
        const h = vfs.openSync("C:\\Game Data.\\gamelog.ini", GENERIC_WRITE, CREATE_ALWAYS);
        expect(h).toBeTruthy();
        vfs.writeSync(h!, new TextEncoder().encode("[log]\r\n"));
        await vfs.flushAll();

        expect(vfs.listDirectory("C:\\Game Data").map((e) => e.name.toLowerCase())).toContain("gamelog.ini");
        expect(findFakeByName(root, "gamelog.ini")).not.toBeNull();
    });

    test("a ROM entry under \"Dir.\" is indexed as Dir, so both spellings find it", () => {
        const name = "Saves./GameLog.ini";
        const entry: ZipEntry = { name, compressedSize: 7, uncompressedSize: 7, compression: 0, localHeaderOffset: 0, isDirectory: false };
        const vfs = new VirtualFileSystem();
        vfs.mountRom(null as unknown as ZipArchive, "rom", new Map([[name, entry]]));

        expect(vfs.fileExists("C:\\Saves\\gamelog.ini")).toBe(true);
        expect(vfs.fileExists("C:\\Saves.\\gamelog.ini")).toBe(true);
        expect(vfs.getFileSize("C:\\saves\\GAMELOG.INI")).toBe(7);
        expect(vfs.listDirectory("C:\\Saves").map((e) => e.name)).toContain("GameLog.ini");
        expect(vfs.listDirectory("C:\\").map((e) => e.name)).toContain("Saves");
    });
});

// Ordinary DOS paths share normalization between lookup expansion and the VFS.
test.each([
    ["C:/Games. /Saves... /slot.sav. ", "C:\\Games\\Saves\\slot.sav"],
    ["D:\\Games\\.\\Saves\\..\\slot.sav", "D:\\Games\\slot.sav"],
    ["C:\\", "C:\\"],
])("normalizes %s consistently and idempotently", (input, expected) => {
    expect(normalizeGuestPath(input)).toBe(expected);
    expect(normalizeGuestPath(expected)).toBe(expected);
    expect(new VirtualFileSystem().resolvePath(input)).toBe(expected);
});
