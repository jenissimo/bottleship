/**
 * Fonts an application installs from its own data.
 *
 * Director's Font Xtra writes each embedded font as a TrueType file with a temp-file name
 * (`AAX1234.tmp`), wraps it with CreateScalableFontResource and installs the FOT. Neither the
 * file's extension nor a terminator stored inside a name record may keep the face from being
 * found: the caller then looks the family up by name and silently falls back to Arial.
 */
import { describe, expect, test } from "bun:test";
import { buildFot, parseFot } from "../../src/worker/modules/gdi32/font-fot";
import { parseSfntFace } from "../../src/worker/modules/gdi32/font-resource";

/** A minimal sfnt holding only a `name` table with one Windows/Unicode family record. */
function sfntWithFamily(utf16: number[]): Uint8Array {
    const nameLen = 6 + 12 + utf16.length * 2;
    const out = new Uint8Array(12 + 16 + nameLen);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x00010000);            // sfnt version
    dv.setUint16(4, 1);                     // numTables
    out.set([0x6e, 0x61, 0x6d, 0x65], 12);  // 'name'
    dv.setUint32(12 + 8, 28);               // offset
    dv.setUint32(12 + 12, nameLen);         // length
    const t = 28;
    dv.setUint16(t + 2, 1);                 // count
    dv.setUint16(t + 4, 18);                // stringOffset
    dv.setUint16(t + 6, 3);                 // platform: Windows
    dv.setUint16(t + 8, 1);                 // encoding: Unicode BMP
    dv.setUint16(t + 10, 0x409);            // language
    dv.setUint16(t + 12, 1);                // nameID: family
    dv.setUint16(t + 14, utf16.length * 2); // length
    dv.setUint16(t + 16, 0);                // offset
    utf16.forEach((c, i) => dv.setUint16(t + 18 + i * 2, c));
    return out;
}
const codes = (s: string): number[] => Array.from(s, c => c.charCodeAt(0));

describe("application-installed fonts", () => {
    test("a family name stops at the terminator stored inside its name record", () => {
        const face = parseSfntFace(sfntWithFamily([...codes("Mr.B *"), 0]));
        expect(face?.family).toBe("Mr.B *");
    });

    test("a name without a terminator is unchanged", () => {
        expect(parseSfntFace(sfntWithFamily(codes("Komika Axis *")))?.family).toBe("Komika Axis *");
    });

    test("a FOT may point at a font file of any extension", () => {
        const fot = buildFot("C:\\TEMP\\AAXF612.tmp", "Mr.B *");
        expect(parseFot(fot)).toEqual({ fontPath: "C:\\TEMP\\AAXF612.tmp", face: "Mr.B *" });
    });

    test("external leading is the hhea line gap beyond the Win cell, as a fraction of the em", () => {
        // head.unitsPerEm 2048; hhea 2826 / -522 / 61; OS/2 usWinAscent 2826, usWinDescent 522.
        const tables: Array<[string, number]> = [["head", 54], ["hhea", 36], ["OS/2", 78], ["name", 6 + 12 + 2]];
        let at = 12 + tables.length * 16;
        const offsets = tables.map(([, len]) => { const o = at; at += len; return o; });
        const out = new Uint8Array(at);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, 0x00010000);
        dv.setUint16(4, tables.length);
        tables.forEach(([tag, len], i) => {
            out.set(codes(tag), 12 + i * 16);
            dv.setUint32(12 + i * 16 + 8, offsets[i]!);
            dv.setUint32(12 + i * 16 + 12, len);
        });
        const [head, hhea, os2, name] = offsets as [number, number, number, number];
        dv.setUint16(head + 18, 2048);
        dv.setInt16(hhea + 4, 2826); dv.setInt16(hhea + 6, -522); dv.setInt16(hhea + 8, 61);
        dv.setUint16(os2 + 4, 400); dv.setUint16(os2 + 74, 2826); dv.setUint16(os2 + 76, 522);
        dv.setUint16(name + 2, 1); dv.setUint16(name + 4, 18);
        dv.setUint16(name + 6, 3); dv.setUint16(name + 8, 1); dv.setUint16(name + 10, 0x409);
        dv.setUint16(name + 12, 1); dv.setUint16(name + 14, 2); dv.setUint16(name + 18, 0x41);
        expect(parseSfntFace(out)?.externalLeadingEm).toBeCloseTo(61 / 2048, 6);
    });

    test("a font without hhea/OS-2 tables has no stated external leading", () => {
        expect(parseSfntFace(sfntWithFamily(codes("Plain")))?.externalLeadingEm).toBeNull();
    });
});
