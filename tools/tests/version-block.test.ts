/**
 * VS_VERSIONINFO block model — the thing version.dll hands a guest and then walks.
 *
 * The failure mode this guards is silent: a block that parses "successfully" but reports
 * the wrong version makes a DirectX-era title refuse to start with a message that names
 * DirectDraw, not us. So the parser is pinned against blocks whose contents are known
 * independently — a real Windows DLL's own resource where one is available on the host,
 * and a block this module built otherwise — and every positive assertion is paired with
 * a lookup that must FAIL, so a walker that answers yes to everything cannot pass.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
    buildVersionBlock,
    queryVersionBlock,
    transcodeVersionBlock,
    versionBlockIsWide,
    VS_FIXEDFILEINFO_SIZE,
} from "../../src/worker/core/version-block";
import { readPeVersionResourceBytes, readPeFixedFileVersion } from "../../src/worker/core/pe-version";
import { hleDllVersion, buildHleDllVersionBlock } from "../../src/worker/core/hle-dll-versions";

const VS_FFI_SIGNATURE = 0xfeef04bd;

const readText = (b: Uint8Array, off: number, chars: number, wide: boolean): string => {
    let s = "";
    for (let i = 0; i < chars; i++) {
        const c = wide ? (b[off + i * 2] | (b[off + i * 2 + 1] << 8)) : b[off + i];
        if (!c) break;
        s += String.fromCharCode(c);
    }
    return s;
};

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const SAMPLE = buildVersionBlock({
    fixed: {
        fileVersionMS: 0x00040007, fileVersionLS: 0x000002bc,
        productVersionMS: 0x00040007, productVersionLS: 0x000002bc,
        fileFlagsMask: 0x3f, fileFlags: 0, fileOS: 4, fileType: 2, fileSubtype: 0,
    },
    strings: [{
        langCodePage: "040904B0",
        values: [["FileVersion", "4.07.00.0700"], ["OriginalFilename", "ddraw.dll"]],
    }],
    translations: [{ lang: 0x0409, codePage: 0x04b0 }],
}, true);

describe("buildVersionBlock produces a walkable block", () => {
    test("root value is a VS_FIXEDFILEINFO carrying the requested version", () => {
        const root = queryVersionBlock(SAMPLE, "\\");
        expect(root).not.toBeNull();
        expect(root!.len).toBe(VS_FIXEDFILEINFO_SIZE);
        const view = dv(SAMPLE);
        expect(view.getUint32(root!.offset, true)).toBe(VS_FFI_SIGNATURE);
        expect(view.getUint32(root!.offset + 8, true)).toBe(0x00040007);
        expect(view.getUint32(root!.offset + 12, true)).toBe(0x000002bc);
    });

    test("wLength covers the whole block", () => {
        expect(dv(SAMPLE).getUint16(0, true)).toBe(SAMPLE.length);
    });

    test("string and translation sub-blocks resolve", () => {
        const q = queryVersionBlock(SAMPLE, "\\StringFileInfo\\040904B0\\FileVersion")!;
        expect(readText(SAMPLE, q.offset, q.len, true)).toBe("4.07.00.0700");
        const t = queryVersionBlock(SAMPLE, "\\VarFileInfo\\Translation")!;
        expect(t.len).toBe(4);
        expect(dv(SAMPLE).getUint16(t.offset, true)).toBe(0x0409);
        expect(dv(SAMPLE).getUint16(t.offset + 2, true)).toBe(0x04b0);
    });

    test("sub-block matching is case-insensitive, as VerQueryValue's is", () => {
        expect(queryVersionBlock(SAMPLE, "\\stringfileinfo\\040904b0\\fileversion")).not.toBeNull();
    });

    // The failure side: a walker that returns something for every path would pass every
    // assertion above while telling a guest that any key it asks for exists.
    test("absent keys and language tables report absent", () => {
        expect(queryVersionBlock(SAMPLE, "\\StringFileInfo\\040904B0\\NoSuchKey")).toBeNull();
        expect(queryVersionBlock(SAMPLE, "\\StringFileInfo\\041904E3\\FileVersion")).toBeNull();
        expect(queryVersionBlock(SAMPLE, "\\NoSuchChild")).toBeNull();
    });
});

describe("transcodeVersionBlock", () => {
    const narrow = transcodeVersionBlock(SAMPLE, false)!;

    test("narrow form is genuinely 1-byte and shorter", () => {
        expect(versionBlockIsWide(narrow)).toBe(false);
        expect(narrow.length).toBeLessThan(SAMPLE.length);
    });

    test("narrow form answers the same questions", () => {
        const q = queryVersionBlock(narrow, "\\StringFileInfo\\040904B0\\FileVersion")!;
        expect(readText(narrow, q.offset, q.len, false)).toBe("4.07.00.0700");
        const root = queryVersionBlock(narrow, "\\")!;
        expect(dv(narrow).getUint32(root.offset, true)).toBe(VS_FFI_SIGNATURE);
        expect(dv(narrow).getUint32(root.offset + 8, true)).toBe(0x00040007);
    });

    test("round trip back to wide is stable", () => {
        const wideAgain = transcodeVersionBlock(narrow, true)!;
        const q = queryVersionBlock(wideAgain, "\\StringFileInfo\\040904B0\\OriginalFilename")!;
        expect(readText(wideAgain, q.offset, q.len, true)).toBe("ddraw.dll");
    });

    test("asking for the width a block already has returns it unchanged", () => {
        expect(transcodeVersionBlock(SAMPLE, true)).toBe(SAMPLE);
    });
});

describe("HLE DLL versions", () => {
    test("the DirectX modules report the generation we implement", () => {
        expect(hleDllVersion("ddraw")).toMatchObject({ major: 4, minor: 7 });
        expect(hleDllVersion("dsound")).toMatchObject({ major: 4, minor: 7 });
        expect(hleDllVersion("dplayx")).toMatchObject({ major: 4, minor: 7 });
        expect(hleDllVersion("d3d9")).toMatchObject({ major: 4, minor: 9 });
    });

    test("a module we do not stand in for has no version resource", () => {
        expect(hleDllVersion("binkw32")).toBeNull();
        expect(buildHleDllVersionBlock("binkw32", "binkw32.dll", true)).toBeNull();
    });

    // KKND2 (and its generation) gates startup on this exact comparison: it wants the
    // ddraw.dll minor version to be at least 4, DirectX 3's 4.04.00.0068.
    test("ddraw's block satisfies a DirectDraw-3-or-greater check", () => {
        const block = buildHleDllVersionBlock("ddraw", "ddraw.dll", false)!;
        const root = queryVersionBlock(block, "\\")!;
        const ms = dv(block).getUint32(root.offset + 8, true);
        expect(ms >>> 16).toBe(4);
        expect(ms & 0xffff).toBeGreaterThanOrEqual(4);
    });
});

// Ground truth: only the host's own DLLs can tell us the parser reads a resource an
// independent producer wrote. Skipped rather than faked where they are not present.
const SYSTEM_DLLS = ["C:/Windows/SysWOW64/version.dll", "C:/Windows/SysWOW64/ddraw.dll"]
    .filter((p) => fs.existsSync(p));

describe.skipIf(SYSTEM_DLLS.length === 0)("real Windows version resources", () => {
    for (const path of SYSTEM_DLLS) {
        test(`${path} parses and agrees with readPeFixedFileVersion`, () => {
            const image = new Uint8Array(fs.readFileSync(path));
            const res = readPeVersionResourceBytes(image)!;
            expect(res).not.toBeNull();
            expect(versionBlockIsWide(res)).toBe(true);

            const root = queryVersionBlock(res, "\\")!;
            const view = dv(res);
            expect(view.getUint32(root.offset, true)).toBe(VS_FFI_SIGNATURE);

            const fixed = readPeFixedFileVersion(image)!;
            const ms = view.getUint32(root.offset + 8, true);
            const ls = view.getUint32(root.offset + 12, true);
            expect({ major: ms >>> 16, minor: ms & 0xffff, build: ls >>> 16, revision: ls & 0xffff })
                .toEqual(fixed);

            // Every Microsoft system DLL carries these; a parser that walked the tree
            // wrongly would return null here rather than a wrong string.
            const t = queryVersionBlock(res, "\\VarFileInfo\\Translation")!;
            const lang = view.getUint16(t.offset, true).toString(16).padStart(4, "0");
            const cp = view.getUint16(t.offset + 2, true).toString(16).padStart(4, "0");
            const fv = queryVersionBlock(res, `\\StringFileInfo\\${lang}${cp}\\FileVersion`)!;
            expect(readText(res, fv.offset, fv.len, true)).toMatch(/^\d+\.\d+\.\d+\.\d+/);

            // …and the narrow re-emit must read back identically.
            const narrow = transcodeVersionBlock(res, false)!;
            const nfv = queryVersionBlock(narrow, `\\StringFileInfo\\${lang}${cp}\\FileVersion`)!;
            expect(readText(narrow, nfv.offset, nfv.len, false))
                .toBe(readText(res, fv.offset, fv.len, true));
        });
    }
});
