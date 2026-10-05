// Unit tests for the on-disk PE reader (packages/formats/src/pe) that backs the
// pre-flight API census. Every fixture is assembled byte-by-byte in memory — a
// synthetic PE32 with one code section carrying an import directory (by name AND by
// ordinal), a delay-load directory in both the modern RVA form and the VC6-era VA
// form, an export directory with a forwarder, and real `FF 15` call sites — so the
// parser is pinned without checking a binary into the repo.

import { describe, it, expect } from "bun:test";
import {
    readPeHeaders, parsePeImports, parsePeExports, countIatCallSites,
    detectPacker, importsLookHidden, rvaToFileOffset, isPeImage,
} from "@bottleship/formats/pe";

// --- fixture builder --------------------------------------------------------

const IMAGE_BASE = 0x400000;
const SEC_RVA = 0x1000;
const SEC_RAW = 0x400;
const SEC_SIZE = 0x2000;
const OPT_SIZE = 224;
const PE_OFF = 0x40;

/** Section-relative file offset for an RVA inside our single section. */
function off(rva: number): number {
    return SEC_RAW + (rva - SEC_RVA);
}

interface PeSpec {
    sectionName?: string;
    /** Written into the section by RVA. */
    blobs?: Array<{ rva: number; bytes: number[] | Uint8Array }>;
    /** dataDirectory index → {rva, size} */
    dirs?: Record<number, { rva: number; size: number }>;
    isDll?: boolean;
}

function buildPe(spec: PeSpec = {}): Uint8Array {
    const image = new Uint8Array(SEC_RAW + SEC_SIZE);
    const view = new DataView(image.buffer);
    const ascii = (s: string, at: number): void => {
        for (let i = 0; i < s.length; i++) image[at + i] = s.charCodeAt(i);
    };

    view.setUint16(0, 0x5a4d, true);            // MZ
    view.setUint32(0x3c, PE_OFF, true);         // e_lfanew
    view.setUint32(PE_OFF, 0x00004550, true);   // PE\0\0
    view.setUint16(PE_OFF + 4, 0x014c, true);   // machine i386
    view.setUint16(PE_OFF + 6, 1, true);        // NumberOfSections
    view.setUint16(PE_OFF + 20, OPT_SIZE, true);
    view.setUint16(PE_OFF + 22, spec.isDll ? 0x2102 : 0x0102, true);

    const opt = PE_OFF + 24;
    view.setUint16(opt, 0x010b, true);          // PE32
    view.setUint32(opt + 16, SEC_RVA + 0x500, true); // AddressOfEntryPoint
    view.setUint32(opt + 28, IMAGE_BASE, true); // ImageBase
    view.setUint32(opt + 56, SEC_RVA + SEC_SIZE, true); // SizeOfImage
    view.setUint16(opt + 68, 2, true);          // Subsystem = GUI
    view.setUint32(opt + 92, 16, true);         // NumberOfRvaAndSizes
    const dirBase = opt + 96;
    for (const [idx, d] of Object.entries(spec.dirs ?? {})) {
        view.setUint32(dirBase + Number(idx) * 8, d.rva, true);
        view.setUint32(dirBase + Number(idx) * 8 + 4, d.size, true);
    }

    const sec = opt + OPT_SIZE;
    ascii(spec.sectionName ?? ".text", sec);
    view.setUint32(sec + 8, SEC_SIZE, true);    // VirtualSize
    view.setUint32(sec + 12, SEC_RVA, true);    // VirtualAddress
    view.setUint32(sec + 16, SEC_SIZE, true);   // SizeOfRawData
    view.setUint32(sec + 20, SEC_RAW, true);    // PointerToRawData
    view.setUint32(sec + 36, 0x60000020, true); // CODE | EXECUTE | READ

    for (const b of spec.blobs ?? []) image.set(Uint8Array.from(b.bytes), off(b.rva));
    return image;
}

const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const cstr = (s: string): number[] => [...s].map(c => c.charCodeAt(0)).concat(0);
/** IMAGE_IMPORT_BY_NAME: WORD hint + ASCIIZ name. */
const hintName = (hint: number, name: string): number[] => [hint & 0xff, (hint >>> 8) & 0xff, ...cstr(name)];

// RVA map for the standard import fixture.
const R = {
    descriptors: 0x1000,
    ilt: 0x1100,
    iat: 0x1200,
    dllName: 0x1300,
    nameFoo: 0x1320,
    nameBar: 0x1340,
    delayDesc: 0x1400,
    delayIlt: 0x1440,
    delayIat: 0x1460,
    delayDll: 0x1480,
    delayName: 0x14a0,
    code: 0x1500,
    exportDir: 0x1800,
    exportFuncs: 0x1840,
    exportNames: 0x1860,
    exportOrds: 0x1880,
    exportDllName: 0x18a0,
    exportName0: 0x18c0,
    exportName1: 0x18e0,
    forwarder: 0x1900,
};

const ORDINAL_FLAG = 0x80000000;

function importFixture(): Uint8Array {
    return buildPe({
        dirs: {
            1: { rva: R.descriptors, size: 40 },
            13: { rva: R.delayDesc, size: 64 },
        },
        blobs: [
            // one IMAGE_IMPORT_DESCRIPTOR + terminator
            { rva: R.descriptors, bytes: [
                ...u32(R.ilt), ...u32(0), ...u32(0), ...u32(R.dllName), ...u32(R.iat),
                ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
            ] },
            // ILT: by-name, by-name, by-ordinal, terminator
            { rva: R.ilt, bytes: [
                ...u32(R.nameFoo), ...u32(R.nameBar), ...u32((ORDINAL_FLAG | 42) >>> 0), ...u32(0),
            ] },
            { rva: R.dllName, bytes: cstr("GDI32.dll") },
            { rva: R.nameFoo, bytes: hintName(7, "CreatePen") },
            { rva: R.nameBar, bytes: hintName(9, "LineTo") },

            // delay-load descriptor, modern RVA form (attributes bit0 = 1)
            { rva: R.delayDesc, bytes: [
                ...u32(1), ...u32(R.delayDll), ...u32(0), ...u32(R.delayIat), ...u32(R.delayIlt),
                ...u32(0), ...u32(0), ...u32(0),
                ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
            ] },
            { rva: R.delayIlt, bytes: [...u32(R.delayName), ...u32(0)] },
            { rva: R.delayDll, bytes: cstr("SHELL32.dll") },
            { rva: R.delayName, bytes: hintName(0, "SHGetFolderPathA") },

            // code: call [CreatePen slot] twice, jmp [LineTo slot] once
            { rva: R.code, bytes: [
                0xff, 0x15, ...u32(IMAGE_BASE + R.iat),
                0x90, 0x90,
                0xff, 0x15, ...u32(IMAGE_BASE + R.iat),
                0xff, 0x25, ...u32(IMAGE_BASE + R.iat + 4),
                0xc3,
            ] },
        ],
    });
}

// --- tests ------------------------------------------------------------------

describe("PE headers", () => {
    it("reads machine, image base and sections", () => {
        const h = readPeHeaders(importFixture())!;
        expect(h).not.toBeNull();
        expect(h.machine).toBe(0x014c);
        expect(h.is64).toBe(false);
        expect(h.imageBase).toBe(IMAGE_BASE);
        expect(h.isDll).toBe(false);
        expect(h.sections.map(s => s.name)).toEqual([".text"]);
    });

    it("maps RVAs through the section table and rejects non-PE input", () => {
        const h = readPeHeaders(importFixture())!;
        expect(rvaToFileOffset(h, R.iat)).toBe(off(R.iat));
        expect(rvaToFileOffset(h, 0x900000)).toBeNull();
        expect(isPeImage(new Uint8Array(64))).toBe(false);
        expect(readPeHeaders(new Uint8Array([0x4d, 0x5a]))).toBeNull();
    });
});

describe("import directory", () => {
    it("parses imports by name and by ordinal", () => {
        const imports = parsePeImports(importFixture());
        const gdi = imports.dlls.find(d => d.dll === "GDI32.dll")!;
        expect(gdi).toBeDefined();
        expect(gdi.delayLoad).toBe(false);
        expect(gdi.entries.map(e => e.name ?? `ord_${e.ordinal}`))
            .toEqual(["CreatePen", "LineTo", "ord_42"]);
        expect(gdi.entries[0].hint).toBe(7);
        // Each entry records the IAT slot the code calls through.
        expect(gdi.entries.map(e => e.iatRva)).toEqual([R.iat, R.iat + 4, R.iat + 8]);
        expect(imports.truncated).toBe(false);
        expect(imports.bound).toBe(false);
    });

    it("parses delay-load imports, which a plain import walk would miss", () => {
        const imports = parsePeImports(importFixture());
        const shell = imports.dlls.find(d => d.dll === "SHELL32.dll")!;
        expect(shell.delayLoad).toBe(true);
        expect(shell.entries.map(e => e.name)).toEqual(["SHGetFolderPathA"]);
    });

    it("handles the VC6-era delay descriptor that stores VAs, not RVAs", () => {
        const image = buildPe({
            dirs: { 13: { rva: R.delayDesc, size: 32 } },
            blobs: [
                { rva: R.delayDesc, bytes: [
                    ...u32(0),                              // attributes: no dlattrRva ⇒ VA form
                    ...u32(IMAGE_BASE + R.delayDll),
                    ...u32(0), ...u32(IMAGE_BASE + R.delayIat), ...u32(IMAGE_BASE + R.delayIlt),
                    ...u32(0), ...u32(0), ...u32(0),
                ] },
                { rva: R.delayIlt, bytes: [...u32(IMAGE_BASE + R.delayName), ...u32(0)] },
                { rva: R.delayDll, bytes: cstr("WINMM.dll") },
                { rva: R.delayName, bytes: hintName(0, "timeGetTime") },
            ],
        });
        const imports = parsePeImports(image);
        expect(imports.dlls).toHaveLength(1);
        expect(imports.dlls[0].dll).toBe("WINMM.dll");
        expect(imports.dlls[0].entries[0].name).toBe("timeGetTime");
    });

    it("reports an image with no import directory as empty, not as an error", () => {
        const imports = parsePeImports(buildPe());
        expect(imports.dlls).toEqual([]);
        expect(imports.truncated).toBe(false);
    });
});

describe("call-site counting", () => {
    it("counts FF15/FF25 references per IAT slot", () => {
        const image = importFixture();
        const h = readPeHeaders(image)!;
        const counts = countIatCallSites(image, h, [R.iat, R.iat + 4, R.iat + 8]);
        expect(counts.get(R.iat)).toBe(2);      // two call [CreatePen]
        expect(counts.get(R.iat + 4)).toBe(1);  // one jmp  [LineTo]
        expect(counts.get(R.iat + 8)).toBe(0);  // the ordinal import is never called
    });

    it("ignores matching bytes outside executable sections", () => {
        const image = buildPe({
            sectionName: ".data",
            blobs: [{ rva: R.code, bytes: [0xff, 0x15, ...u32(IMAGE_BASE + R.iat)] }],
        });
        const view = new DataView(image.buffer);
        // clear MEM_EXECUTE on the single section
        view.setUint32(PE_OFF + 24 + OPT_SIZE + 36, 0x40000040, true);
        const h = readPeHeaders(image)!;
        expect(countIatCallSites(image, h, [R.iat]).get(R.iat)).toBe(0);
    });
});

describe("export directory", () => {
    it("parses names, ordinals and forwarders", () => {
        const image = buildPe({
            isDll: true,
            dirs: { 0: { rva: R.exportDir, size: 0x200 } },
            blobs: [
                { rva: R.exportDir, bytes: [
                    ...u32(0), ...u32(0), ...u32(0),
                    ...u32(R.exportDllName),
                    ...u32(1),               // OrdinalBase
                    ...u32(2),               // NumberOfFunctions
                    ...u32(2),               // NumberOfNames
                    ...u32(R.exportFuncs), ...u32(R.exportNames), ...u32(R.exportOrds),
                ] },
                // fn 0 → real code; fn 1 → inside the export dir ⇒ a forwarder string
                { rva: R.exportFuncs, bytes: [...u32(R.code), ...u32(R.forwarder)] },
                { rva: R.exportNames, bytes: [...u32(R.exportName0), ...u32(R.exportName1)] },
                { rva: R.exportOrds, bytes: [0, 0, 1, 0] },
                { rva: R.exportDllName, bytes: cstr("helper.dll") },
                { rva: R.exportName0, bytes: cstr("DoWork") },
                { rva: R.exportName1, bytes: cstr("Allocate") },
                { rva: R.forwarder, bytes: cstr("NTDLL.RtlAllocateHeap") },
            ],
        });
        const exp = parsePeExports(image);
        expect(exp.dllName).toBe("helper.dll");
        expect([...exp.names].sort()).toEqual(["Allocate", "DoWork"]);
        expect(exp.ordinals.get(1)).toBe("DoWork");
        expect(exp.ordinals.get(2)).toBe("Allocate");
        expect(exp.forwarders.get("Allocate")).toBe("NTDLL.RtlAllocateHeap");
    });
});

describe("opacity signals", () => {
    it("names the packer from the section table", () => {
        expect(detectPacker(readPeHeaders(buildPe({ sectionName: "UPX1" }))!)).toBe("UPX");
        expect(detectPacker(readPeHeaders(buildPe({ sectionName: ".aspack" }))!)).toBe("ASPack");
        expect(detectPacker(readPeHeaders(buildPe())!)).toBeNull();
    });

    it("flags a suspiciously thin import table as runtime-resolved", () => {
        expect(importsLookHidden(parsePeImports(importFixture()))).toBe(true); // 4 entries
        expect(importsLookHidden({ dlls: [], bound: false, truncated: false })).toBe(false);
        const many = { dlls: [{ dll: "a.dll", delayLoad: false, entries: new Array(30).fill({ iatRva: 0 }) }],
                       bound: false, truncated: false };
        expect(importsLookHidden(many)).toBe(false);
    });
});
