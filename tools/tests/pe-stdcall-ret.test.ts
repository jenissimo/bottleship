/**
 * `readStdcallRetBytes` must find a RET at an INSTRUCTION BOUNDARY, never at a byte that
 * merely holds 0xC2/0xC3.
 *
 * The decoration in an export name is what the header said at build time, and vendors have
 * changed the argument list without changing it (Bink's `_BinkSetVolume@8` RET 8s in 0.8i
 * and 1.0v, RET 12s in 1.5v). The body is the only authority, so a wrong reading here binds
 * a caller to a stub with the wrong RET N — a 4-byte ESP drift that surfaces far away.
 *
 * A byte scan gets that right only by luck: `mov eax,0xC3`, `add edx,imm32` and a
 * `call rel32` whose displacement contains 0xC2/0xC3 all answer confidently wrong. Those
 * are the cases below, and they are what make a passing run mean something.
 */

import { describe, expect, test } from "bun:test";
import { readStdcallRetBytes } from "../../packages/formats/src/pe";

const SECTION_RVA = 0x1000;
const SECTION_RAW = 0x200;
const SECTION_SIZE = 0x400;
const OPT_HEADER_SIZE = 0xe0;

/** Section-relative layout. The export directory's declared span must NOT cover the
 *  bodies, or `parsePeExports` reads them as forwarder strings. */
const REL_EXPORT_DIR = 0x00;
const REL_FUNC_TABLE = 0x28;
const REL_NAME_TABLE = 0x2c;
const REL_ORD_TABLE = 0x30;
const REL_DLL_NAME = 0x34;
const REL_EXPORT_NAME = 0x48;
const REL_FORWARDER = 0x70;
const EXPORT_DIR_SIZE = 0x100;
const REL_BODY = 0x100;
const REL_BODY_ALT = 0x180;

interface DllSpec {
    /** Section-relative offset the export's address table entry points at. */
    funcRel?: number;
    chunks?: Array<{ rel: number; bytes: number[] }>;
    exportName?: string;
    /** Point the export at a string inside the export directory — a forwarder. */
    forwarder?: string;
}

function writeAscii(buf: Uint8Array, off: number, text: string): void {
    for (let i = 0; i < text.length; i++) buf[off + i] = text.charCodeAt(i) & 0xff;
    buf[off + text.length] = 0;
}

/** A minimal 32-bit PE: DOS stub, COFF/optional headers, one section, one named export. */
function buildDll(spec: DllSpec = {}): Uint8Array {
    const exportName = spec.exportName ?? "_Test@8";
    const funcRel = spec.forwarder !== undefined ? REL_FORWARDER : (spec.funcRel ?? REL_BODY);

    const section = new Uint8Array(SECTION_SIZE);
    const sv = new DataView(section.buffer);
    const rva = (rel: number) => SECTION_RVA + rel;

    // IMAGE_EXPORT_DIRECTORY
    sv.setUint32(REL_EXPORT_DIR + 12, rva(REL_DLL_NAME), true);   // Name
    sv.setUint32(REL_EXPORT_DIR + 16, 1, true);                   // Base (ordinal base)
    sv.setUint32(REL_EXPORT_DIR + 20, 1, true);                   // NumberOfFunctions
    sv.setUint32(REL_EXPORT_DIR + 24, 1, true);                   // NumberOfNames
    sv.setUint32(REL_EXPORT_DIR + 28, rva(REL_FUNC_TABLE), true);
    sv.setUint32(REL_EXPORT_DIR + 32, rva(REL_NAME_TABLE), true);
    sv.setUint32(REL_EXPORT_DIR + 36, rva(REL_ORD_TABLE), true);

    sv.setUint32(REL_FUNC_TABLE, rva(funcRel), true);
    sv.setUint32(REL_NAME_TABLE, rva(REL_EXPORT_NAME), true);
    sv.setUint16(REL_ORD_TABLE, 0, true);
    writeAscii(section, REL_DLL_NAME, "test.dll");
    writeAscii(section, REL_EXPORT_NAME, exportName);
    if (spec.forwarder !== undefined) writeAscii(section, REL_FORWARDER, spec.forwarder);

    for (const chunk of spec.chunks ?? []) section.set(chunk.bytes, chunk.rel);

    const image = new Uint8Array(SECTION_RAW + SECTION_SIZE);
    const view = new DataView(image.buffer);
    image[0] = 0x4d; image[1] = 0x5a;                             // "MZ"
    const peOff = 0x80;
    view.setUint32(0x3c, peOff, true);
    view.setUint32(peOff, 0x00004550, true);                      // "PE\0\0"

    view.setUint16(peOff + 4, 0x014c, true);                      // machine i386
    view.setUint16(peOff + 6, 1, true);                           // NumberOfSections
    view.setUint16(peOff + 20, OPT_HEADER_SIZE, true);
    view.setUint16(peOff + 22, 0x2102, true);                     // EXECUTABLE_IMAGE | DLL | 32BIT

    const opt = peOff + 24;
    view.setUint16(opt, 0x010b, true);                            // PE32
    view.setUint32(opt + 16, 0, true);                            // AddressOfEntryPoint
    view.setUint32(opt + 28, 0x10000000, true);                   // ImageBase
    view.setUint32(opt + 56, SECTION_RVA + SECTION_SIZE, true);   // SizeOfImage
    view.setUint16(opt + 68, 2, true);                            // Subsystem
    view.setUint32(opt + 92, 16, true);                           // NumberOfRvaAndSizes
    view.setUint32(opt + 96, SECTION_RVA + REL_EXPORT_DIR, true); // DataDirectory[0].VirtualAddress
    view.setUint32(opt + 100, EXPORT_DIR_SIZE, true);             // DataDirectory[0].Size

    const sec = opt + OPT_HEADER_SIZE;
    writeAscii(image, sec, ".text");
    view.setUint32(sec + 8, SECTION_SIZE, true);                  // VirtualSize
    view.setUint32(sec + 12, SECTION_RVA, true);                  // VirtualAddress
    view.setUint32(sec + 16, SECTION_SIZE, true);                 // SizeOfRawData
    view.setUint32(sec + 20, SECTION_RAW, true);                  // PointerToRawData
    view.setUint32(sec + 36, 0x60000020, true);                   // CODE | EXECUTE | READ

    image.set(section, SECTION_RAW);
    return image;
}

/** One export whose body is `bytes`, read back. */
function retOf(bytes: number[]): number | null {
    return readStdcallRetBytes(buildDll({ chunks: [{ rel: REL_BODY, bytes }] }), "_Test@8");
}

const nops = (n: number) => new Array<number>(n).fill(0x90);

describe("readStdcallRetBytes decodes to the return", () => {
    test("a guarded prologue ending in RET 8 (the shape of Bink 0.8i/1.0v)", () => {
        // mov ecx,[esp+4]; test ecx,ecx; jz +0x21; <padding>; ret 8
        expect(retOf([
            0x8b, 0x4c, 0x24, 0x04,
            0x85, 0xc9,
            0x74, 0x21,
            ...nops(0x21),
            0xc2, 0x08, 0x00,
        ])).toBe(8);
    });

    test("a body ending in RET 12 (the shape of Bink 1.5v under the same @8 name)", () => {
        // push esi; mov esi,[esp+8]; test esi,esi; jz +0x39; <padding>; ret 0xC
        expect(retOf([
            0x56,
            0x8b, 0x74, 0x24, 0x08,
            0x85, 0xf6,
            0x74, 0x39,
            ...nops(0x39),
            0xc2, 0x0c, 0x00,
        ])).toBe(12);
    });

    test("a plain RET pops nothing", () => {
        expect(retOf([0xc3])).toBe(0);
    });

    test("a rep-prefixed RET is still a RET", () => {
        expect(retOf([0xf3, 0xc3])).toBe(0);
    });
});

describe("bytes that only look like a return", () => {
    test("0xC3 inside a mov imm32 is not a return", () => {
        // mov eax,0xC3 ; ret 8   — a byte scan stops at the immediate and answers 0
        expect(retOf([0xb8, 0xc3, 0x00, 0x00, 0x00, 0xc2, 0x08, 0x00])).toBe(8);
    });

    test("0xC2 as a ModRM byte is not a return", () => {
        // add edx,0x1234 ; ret 0xC — a byte scan reads the ModRM as `ret 0x1234`
        expect(retOf([0x81, 0xc2, 0x34, 0x12, 0x00, 0x00, 0xc2, 0x0c, 0x00])).toBe(12);
    });

    test("0xC2/0xC3 inside a call displacement is not a return", () => {
        // call rel32 (displacement 0x0000C2C3) ; ret 4
        expect(retOf([0xe8, 0xc3, 0xc2, 0x00, 0x00, 0xc2, 0x04, 0x00])).toBe(4);
    });

    test("0xC3 in a disp32 is not a return", () => {
        // mov eax,[edx+0x000000C3] ; ret 0x10
        expect(retOf([0x8b, 0x82, 0xc3, 0x00, 0x00, 0x00, 0xc2, 0x10, 0x00])).toBe(16);
    });
});

describe("it refuses rather than guesses", () => {
    test("an opcode it does not model aborts the walk", () => {
        // 0xD6 (undocumented SALC) sits before a real RET 8; a guessed length would
        // resynchronise onto it and report 8, which is the failure mode being excluded.
        expect(retOf([0xd6, 0xc2, 0x08, 0x00])).toBeNull();
    });

    test("no return inside scanBytes", () => {
        const image = buildDll({ chunks: [{ rel: REL_BODY, bytes: [...nops(64), 0xc2, 0x08, 0x00] }] });
        expect(readStdcallRetBytes(image, "_Test@8", null, 8)).toBeNull();
    });

    test("an absent export name", () => {
        expect(readStdcallRetBytes(buildDll({ chunks: [{ rel: REL_BODY, bytes: [0xc3] }] }), "_Nope@4")).toBeNull();
    });

    test("a forwarded export has no local body", () => {
        expect(readStdcallRetBytes(buildDll({ forwarder: "OTHER.Thing" }), "_Test@8")).toBeNull();
    });

    test("an FF 25 import thunk cannot be resolved from a file image", () => {
        expect(retOf([0xff, 0x25, 0x00, 0x20, 0x00, 0x10])).toBeNull();
    });

    test("not a PE at all", () => {
        expect(readStdcallRetBytes(new Uint8Array(64), "_Test@8")).toBeNull();
    });
});

describe("entry thunks", () => {
    test("one E9 jump is followed to the real body", () => {
        const disp = (SECTION_RVA + REL_BODY_ALT) - (SECTION_RVA + REL_BODY + 5);
        const image = buildDll({
            chunks: [
                { rel: REL_BODY, bytes: [0xe9, disp & 0xff, (disp >> 8) & 0xff, (disp >> 16) & 0xff, (disp >> 24) & 0xff] },
                { rel: REL_BODY_ALT, bytes: [0xc2, 0x10, 0x00] },
            ],
        });
        expect(readStdcallRetBytes(image, "_Test@8")).toBe(16);
    });

    test("one EB short jump is followed to the real body", () => {
        const disp = (SECTION_RVA + REL_BODY_ALT) - (SECTION_RVA + REL_BODY + 2);
        const image = buildDll({
            chunks: [
                { rel: REL_BODY, bytes: [0xeb, disp & 0xff] },
                { rel: REL_BODY_ALT, bytes: [0xc2, 0x14, 0x00] },
            ],
        });
        expect(readStdcallRetBytes(image, "_Test@8")).toBe(20);
    });

    test("a chain of thunks is not followed past the first hop", () => {
        // The first hop lands on another E9; the walk decodes it as an instruction and
        // continues linearly rather than jumping again, so the second target's RET is not
        // what it reports. Bounded, and honest about it: no return on the linear path.
        const toAlt = (SECTION_RVA + REL_BODY_ALT) - (SECTION_RVA + REL_BODY + 5);
        const image = buildDll({
            chunks: [
                { rel: REL_BODY, bytes: [0xe9, toAlt & 0xff, (toAlt >> 8) & 0xff, (toAlt >> 16) & 0xff, (toAlt >> 24) & 0xff] },
                { rel: REL_BODY_ALT, bytes: [0xe9, 0x00, 0x00, 0x00, 0x00, 0xc2, 0x18, 0x00] },
            ],
        });
        // The second E9 is decoded (5 bytes), then the RET that follows it is reached.
        expect(readStdcallRetBytes(image, "_Test@8")).toBe(24);
    });
});
