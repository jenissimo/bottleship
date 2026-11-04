import { describe, expect, test } from "bun:test";
import { smackw32Module } from "../../src/worker/api/smackw32.api";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { nameOrdinalImports, readExportNameDirectory, shippedExportNames } from "../../src/worker/core/pe-export-names";
import { PELoader } from "../../src/worker/core/pe-loader";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import type { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";

const FILE_ALIGN = 0x200, SECTION_RVA = 0x1000;

function buildDll(timeDateStamp: number, ordinalBase: number, exportsByIndex: string[]): Uint8Array {
    const image = new Uint8Array(FILE_ALIGN * 3);
    const v = new DataView(image.buffer);
    v.setUint16(0, 0x5A4D, true);
    v.setUint32(0x3C, 0x40, true);
    v.setUint32(0x40, 0x00004550, true);
    v.setUint16(0x44, 0x14C, true);
    v.setUint16(0x46, 1, true);
    v.setUint32(0x48, timeDateStamp, true);
    v.setUint16(0x54, 0xE0, true);
    const opt = 0x58;
    v.setUint16(opt, 0x10B, true);
    v.setUint32(opt + 60, FILE_ALIGN, true);
    const section = opt + 0xE0;
    image.set(new TextEncoder().encode(".edata"), section);
    v.setUint32(section + 8, FILE_ALIGN * 2, true);
    v.setUint32(section + 12, SECTION_RVA, true);
    v.setUint32(section + 16, FILE_ALIGN * 2, true);
    v.setUint32(section + 20, FILE_ALIGN, true);

    const sorted = exportsByIndex.map((name, index) => ({ name, index })).sort((a, b) => a.name < b.name ? -1 : 1);
    const dir = FILE_ALIGN, rva = (off: number) => SECTION_RVA + off - FILE_ALIGN;
    const functions = dir + 40, names = functions + 4 * exportsByIndex.length, ordinals = names + 4 * sorted.length;
    let strings = ordinals + 2 * sorted.length;
    v.setUint32(opt + 96, SECTION_RVA, true);
    v.setUint32(opt + 100, FILE_ALIGN, true);
    v.setUint32(dir + 16, ordinalBase, true);
    v.setUint32(dir + 20, exportsByIndex.length, true);
    v.setUint32(dir + 24, sorted.length, true);
    v.setUint32(dir + 28, rva(functions), true);
    v.setUint32(dir + 32, rva(names), true);
    v.setUint32(dir + 36, rva(ordinals), true);
    exportsByIndex.forEach((_, i) => v.setUint32(functions + 4 * i, 0x2000 + 16 * i, true));
    sorted.forEach(({ name, index }, i) => {
        v.setUint32(names + 4 * i, rva(strings), true);
        v.setUint16(ordinals + 2 * i, index, true);
        image.set(new TextEncoder().encode(name), strings);
        strings += name.length + 1;
    });
    return image;
}

const LATER_BUILD = [
    "_SmackBlit@44", "_SmackBufferClose@4", "_SmackClose@4", "_SmackDoFrame@4",
    "_SmackNextFrame@4", "_SmackOpen@12", "_SmackToBuffer@28", "_SmackWait@4",
];
const GTA_BUILD = [
    "_SmackBufferOpen@24", "_SmackOpen@12", "_SmackClose@4", "_SmackDoFrame@4",
    "_SmackWait@4", "_SmackSoundUseMSS@4", "_SmackBufferClose@4", "_SmackToBuffer@28",
];

function registry(): APIRegistry {
    const r = APIRegistry.getInstance();
    r.registerModule(smackw32Module);
    return r;
}

function bind(image: Uint8Array, ordinals: number[]) {
    const r = registry();
    const directory = readExportNameDirectory(image);
    expect(directory).not.toBeNull();
    const imports: Array<{ name?: string; ordinal?: number }> = ordinals.map(ordinal => ({ ordinal }));
    nameOrdinalImports(imports, directory!, name => r.hasExportedFunction("smackw32", name));
    return imports.map(f => ({ ordinal: f.ordinal, name: f.name, argCount: f.name ? r.getArgCount("smackw32", f.name) : undefined }));
}

describe("ordinal imports resolved through the shipped export directory", () => {
    test("reads timestamp, base and ordinal → name exactly as the directory declares them", () => {
        const directory = readExportNameDirectory(buildDll(0x36B222DC, 1, LATER_BUILD))!;
        expect(directory.timeDateStamp).toBe(0x36B222DC);
        expect(directory.ordinalBase).toBe(1);
        expect(directory.names.get(2)).toBe("_SmackBufferClose@4");
        expect(directory.names.get(6)).toBe("_SmackOpen@12");
        expect(directory.names.size).toBe(LATER_BUILD.length);
    });

    test("the same ordinal binds to a different function in each build, with that function's arg count", () => {
        expect(bind(buildDll(0x36B222DC, 1, LATER_BUILD), [2, 6, 8])).toEqual([
            { ordinal: 2, name: "_SmackBufferClose@4", argCount: 1 },
            { ordinal: 6, name: "_SmackOpen@12", argCount: 3 },
            { ordinal: 8, name: "_SmackWait@4", argCount: 1 },
        ]);
        expect(bind(buildDll(0x3327F80F, 1, GTA_BUILD), [2, 6, 8])).toEqual([
            { ordinal: 2, name: "_SmackOpen@12", argCount: 3 },
            { ordinal: 6, name: "_SmackSoundUseMSS@4", argCount: 1 },
            { ordinal: 8, name: "_SmackToBuffer@28", argCount: 7 },
        ]);
    });

    test("a non-1 ordinal base is honoured", () => {
        expect(bind(buildDll(0x3327F80F, 10, GTA_BUILD), [11])).toEqual([
            { ordinal: 11, name: "_SmackOpen@12", argCount: 3 },
        ]);
    });

    test("ordinals the directory does not name, or names we do not implement, stay unbound", () => {
        expect(bind(buildDll(0x36B222DC, 1, LATER_BUILD), [1, 42])).toEqual([
            { ordinal: 1, name: undefined, argCount: undefined },
            { ordinal: 42, name: undefined, argCount: undefined },
        ]);
    });

    test("imports that already carry a name are left alone", () => {
        const r = registry();
        const directory = readExportNameDirectory(buildDll(0x36B222DC, 1, LATER_BUILD))!;
        const imports: Array<{ name?: string; ordinal?: number }> = [{ name: "_SmackWait@4" }];
        expect(nameOrdinalImports(imports, directory, n => r.hasExportedFunction("smackw32", n))).toEqual([]);
        expect(imports).toEqual([{ name: "_SmackWait@4" }]);
    });

    test("anything that is not a PE32 image with an export directory yields null", () => {
        expect(readExportNameDirectory(new Uint8Array(16))).toBeNull();
        const noExports = buildDll(1, 1, LATER_BUILD);
        new DataView(noExports.buffer).setUint32(0x58 + 96, 0, true);
        expect(readExportNameDirectory(noExports)).toBeNull();
        expect(readExportNameDirectory(buildDll(1, 1, LATER_BUILD).slice(0, 0x300))).not.toBeNull();
    });

    test("the smackw32 descriptor declares no static ordinals", () => {
        expect(smackw32Module.functions.filter(f => f.ordinal !== undefined)).toEqual([]);
    });
});

describe("import walk", () => {
    async function walk(files: Record<string, Uint8Array>, imports: Array<{ name?: string; ordinal?: number }>) {
        const system = System.getInstance();
        const saved = { process: system.process, exe: system.executablePath };
        system.process = null;
        system.executablePath = "C:\\GAME\\game.exe";
        shippedExportNames.clear();
        const entries = new Map(Object.entries(files).map(([path, bytes]) => [path.toLowerCase(), { path, bytes }]));
        const loader = new PELoader(() => new Uint8Array(0x10000), new ThunkGenerator(), registry());
        loader.setVfs({
            currentDir: "C:\\GAME\\",
            resolvePath: (path: string) => path.replace(/\//g, "\\"),
            statEntry: (path: string) => {
                const entry = entries.get(path.toLowerCase());
                return entry ? { kind: "file", path: entry.path } : null;
            },
            open: async (path: string) => entries.get(path.toLowerCase()),
            getFileSize: (path: string) => entries.get(path.toLowerCase())!.bytes.length,
            read: async (entry: { bytes: Uint8Array }) => entry.bytes,
        } as unknown as VirtualFileSystem);
        try {
            await (loader as unknown as { nameOrdinalImportsFromShippedDll(raw: string, f: typeof imports, dirs: readonly string[]): Promise<void> })
                .nameOrdinalImportsFromShippedDll("SMACKW32.DLL", imports, ["C:\\GAME\\"]);
        } finally {
            system.process = saved.process;
            system.executablePath = saved.exe;
        }
        return imports;
    }

    test("an ordinal import of a thunked module takes the name the bundled DLL exports", async () => {
        const imports = await walk({ "C:\\GAME\\SMACKW32.DLL": buildDll(0x34BFA011, 1, LATER_BUILD) }, [{ ordinal: 2 }, { ordinal: 6 }, { name: "_SmackWait@4" }]);
        expect(imports).toEqual([{ ordinal: 2, name: "_SmackBufferClose@4" }, { ordinal: 6, name: "_SmackOpen@12" }, { name: "_SmackWait@4" }]);
        expect(shippedExportNames.nameOf("smackw32.dll", 6)).toBe("_SmackOpen@12");
        shippedExportNames.clear();
    });

    test("without a bundled DLL the import stays an ordinal", async () => {
        const imports = await walk({}, [{ ordinal: 2 }]);
        expect(imports).toEqual([{ ordinal: 2 }]);
    });
});
