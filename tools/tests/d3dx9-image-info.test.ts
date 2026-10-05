/**
 * D3DXIMAGE_INFO's EXTENT, pinned.
 *
 * The struct is seven DWORDs and callers declare it as a local, so the word after it belongs
 * to the caller's frame. An eighth field — we had invented a Pool member — writes into that
 * frame: in RA3's texture loader the struct ends exactly at the saved return address and
 * D3DXIFF_DDS (4) landed on it, so the loader RET'd to address 4. Nothing downstream can
 * detect that, which is why the length is a test and not a comment.
 */
import { describe, expect, test } from "bun:test";
import { imageInfoWords } from "../../src/worker/modules/d3dx9/textures";
import { readDdsInfo } from "../../src/worker/modules/d3dx9/image-decode";
import { classifyWildTransfer } from "../../src/worker/core/memory/fault-recorder";

const D3DFMT_DXT1 = 0x31545844;
const D3DXIFF_DDS = 4;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DRTYPE_CUBETEXTURE = 5;

/** A DXT1 .dds header with `caps2`/`depth` under the caller's control. */
function ddsHeader(width: number, height: number, opts: { caps2?: number; depth?: number; mips?: number } = {}): Uint8Array {
    const bytes = new Uint8Array(128 + 8 * 64 * 64);
    const u32 = new DataView(bytes.buffer);
    u32.setUint32(0, 0x20534444, true);   // "DDS "
    u32.setUint32(4, 124, true);          // header size
    u32.setUint32(12, height, true);
    u32.setUint32(16, width, true);
    u32.setUint32(24, opts.depth ?? 0, true);
    u32.setUint32(28, opts.mips ?? 1, true);
    u32.setUint32(76, 32, true);          // pixelformat size
    u32.setUint32(80, 0x4, true);         // DDPF_FOURCC
    u32.setUint32(84, D3DFMT_DXT1, true);
    u32.setUint32(112, opts.caps2 ?? 0, true);
    return bytes;
}

describe("D3DXIMAGE_INFO", () => {
    test("is exactly seven DWORDs, in the documented order", () => {
        const w = imageInfoWords(256, 128, 9, D3DFMT_DXT1, D3DXIFF_DDS, 1, D3DRTYPE_TEXTURE);
        expect(w.length).toBe(7);                 // an eighth field lands in the caller's frame
        expect(w.byteLength).toBe(28);
        expect(Array.from(w)).toEqual([256, 128, 1, 9, D3DFMT_DXT1, D3DRTYPE_TEXTURE, D3DXIFF_DDS]);
    });

    test("a volume file reports its depth in the Depth slot, not 1", () => {
        const w = imageInfoWords(64, 64, 1, D3DFMT_DXT1, D3DXIFF_DDS, 16, D3DRTYPE_VOLUMETEXTURE);
        expect(w[2]).toBe(16);
        expect(w[5]).toBe(D3DRTYPE_VOLUMETEXTURE);
    });
});

describe("readDdsInfo — the shape the caller switches on", () => {
    test("a plain 2D file is D3DRTYPE_TEXTURE with depth 1", () => {
        const info = readDdsInfo(ddsHeader(64, 64))!;
        expect(info.resourceType).toBe(D3DRTYPE_TEXTURE);
        expect(info.depth).toBe(1);
    });

    test("DDSCAPS2_CUBEMAP is a cube texture", () => {
        expect(readDdsInfo(ddsHeader(64, 64, { caps2: 0x200 }))!.resourceType).toBe(D3DRTYPE_CUBETEXTURE);
    });

    test("DDSCAPS2_VOLUME is a volume texture and carries dwDepth", () => {
        const info = readDdsInfo(ddsHeader(64, 64, { caps2: 0x200000, depth: 8 }))!;
        expect(info.resourceType).toBe(D3DRTYPE_VOLUMETEXTURE);
        expect(info.depth).toBe(8);
    });
});

/**
 * And the diagnostic that would have named it in one step: a wild EIP reached by a RET points
 * at the SLOT that held the wrong address, not at a call site. Before this, a smashed return
 * address and a bad vtable slot produced the same (empty) fault record.
 */
describe("classifyWildTransfer", () => {
    const mem = new Uint8Array(0x10000);
    const dv = new DataView(mem.buffer);

    test("a popped return address equal to the faulting EIP is a RET", () => {
        dv.setUint32(0x1000, 4, true);            // the slot the callee RET'd through
        dv.setUint32(0x1004, 0xdeadbeef, true);   // the callee's first argument
        expect(classifyWildTransfer(mem, 0x1004, 4, false)).toEqual({ how: "ret", retSlot: 0x1000 });
    });

    test("a decoded indirect CALL names the return address", () => {
        dv.setUint32(0x2000, 0x1111, true);
        dv.setUint32(0x2004, 0x401234, true);
        expect(classifyWildTransfer(mem, 0x2004, 4, true)).toEqual({ how: "call", retAddr: 0x401234 });
    });

    test("an undecodable top word is reported as unknown, not guessed into a call", () => {
        dv.setUint32(0x3000, 0x9999, true);
        dv.setUint32(0x3004, 0xf851750, true);
        expect(classifyWildTransfer(mem, 0x3004, 4, false)).toEqual({ how: "unknown", stackTop: 0xf851750 });
    });
});

/**
 * A DDS surface format with no four-character code puts the D3DFORMAT enum VALUE in dwFourCC.
 * RA3's HDR environment maps are written that way (0x71 == D3DFMT_A16B16G16R16F), and reading
 * it as a code refuses the file — after which the engine substitutes its own placeholder and
 * nothing reports a failure.
 */
describe("readDdsInfo — numeric dwFourCC", () => {
    const D3DFMT_A16B16G16R16F = 113;

    function floatDds(caps2 = 0): Uint8Array {
        const bytes = new Uint8Array(128 + 64 * 64 * 8 * 6);
        const dv = new DataView(bytes.buffer);
        dv.setUint32(0, 0x20534444, true);
        dv.setUint32(4, 124, true);
        dv.setUint32(12, 64, true);          // height
        dv.setUint32(16, 64, true);          // width
        dv.setUint32(28, 1, true);           // mips
        dv.setUint32(76, 32, true);
        dv.setUint32(80, 0x4, true);         // DDPF_FOURCC
        dv.setUint32(84, D3DFMT_A16B16G16R16F, true);
        dv.setUint32(112, caps2, true);
        return bytes;
    }

    test("0x71 is read as D3DFMT_A16B16G16R16F, not refused", () => {
        const info = readDdsInfo(floatDds());
        expect(info).not.toBeNull();
        expect(info!.format).toBe(D3DFMT_A16B16G16R16F);
        expect(info!.width).toBe(64);
    });

    test("the six-face cube spelling is still a cube texture", () => {
        expect(readDdsInfo(floatDds(0xfe00))!.resourceType).toBe(D3DRTYPE_CUBETEXTURE);
    });

    test("a real four-character code is NOT reinterpreted as a number", () => {
        const dds = floatDds();
        new DataView(dds.buffer).setUint32(84, D3DFMT_DXT1, true);
        expect(readDdsInfo(dds)!.format).toBe(D3DFMT_DXT1);
    });

    test("an unknown numeric format stays a refusal", () => {
        const dds = floatDds();
        new DataView(dds.buffer).setUint32(84, 0xfe, true);   // not a D3DFORMAT we know
        expect(readDdsInfo(dds)).toBeNull();
    });
});
