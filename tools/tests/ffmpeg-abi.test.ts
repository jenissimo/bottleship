/**
 * The ffmpeg-HLE ABI gates. Each one exists to REFUSE a build we cannot safely write into, so
 * each test here pairs the passing shape with the exact damage it is meant to catch — a gate
 * that has never been shown failing is a gate nobody has verified.
 */

import { describe, expect, test } from "bun:test";
import { measureAvcodecAbi } from "../../src/worker/modules/ffmpeg/avcodec-abi";
import { frameLooksFresh, vp8FrameTagIsKeyframe } from "../../src/worker/modules/ffmpeg/avcodec-decode-hle";
import type { LoadedPEModule } from "../../src/worker/core/module-registry";

const BASE = 0x10000;
const MEM = 0x40000;
const OPT_ROW = 48;

/** Offsets the shipped Lavc 56.1.100 AVOption table really reports. */
const ANCHORS: [string, number][] = [
    ["b", 0x48], ["flags", 0x58], ["extradata_size", 0x64], ["time_base", 0x68],
    ["delay", 0x74], ["g", 0x88], ["me_method", 0x90], ["ar", 0x19c], ["ac", 0x1a0],
    ["refcounted_frames", 0x1e8], ["lowres", 0x320], ["threads", 0x328],
];

interface Build {
    versionInt?: number;
    frameSizeof?: number;
    anchorOverride?: [string, number];
    dropOptionTable?: boolean;
}

/** Synthesize the two images the measurement reads: an avcodec and an avutil. */
function makeImages(b: Build = {}) {
    const mem = new Uint8Array(MEM);
    const put32 = (a: number, v: number) => {
        mem[a] = v & 0xff; mem[a + 1] = (v >>> 8) & 0xff; mem[a + 2] = (v >>> 16) & 0xff; mem[a + 3] = (v >>> 24) & 0xff;
    };

    // avcodec_version body: mov eax, LIBAVCODEC_VERSION_INT; ret
    const versionBody = BASE + 0x100;
    mem[versionBody] = 0xb8;
    put32(versionBody + 1, b.versionInt ?? ((56 << 16) | (1 << 8) | 100));
    mem[versionBody + 5] = 0xc3;

    // Option-name strings, then the 48-byte rows that point at them.
    let strAt = BASE + 0x200;
    const strAddr = new Map<string, number>();
    for (const [name] of ANCHORS) {
        strAddr.set(name, strAt);
        for (let i = 0; i < name.length; i++) mem[strAt + i] = name.charCodeAt(i);
        mem[strAt + name.length] = 0;
        strAt += name.length + 1;
    }
    if (!b.dropOptionTable) {
        let row = BASE + 0x1000;
        for (const [name, off] of ANCHORS) {
            const value = b.anchorOverride && b.anchorOverride[0] === name ? b.anchorOverride[1] : off;
            put32(row, strAddr.get(name)!);
            put32(row + 8, value);
            put32(row + 0x0c, 1);            // AV_OPT_TYPE_INT
            row += OPT_ROW;
        }
        // A CONST row sharing a name must not shadow the field row.
        put32(row, strAddr.get("ac")!);
        put32(row + 8, 0);
        put32(row + 0x0c, 128);              // AV_OPT_TYPE_CONST
    }

    // av_frame_alloc: push esi; push sizeof(AVFrame); call …
    const avutilBase = BASE + 0x8000;
    const allocBody = avutilBase + 0x40;
    mem[allocBody] = 0x56;
    mem[allocBody + 1] = 0x68;
    put32(allocBody + 2, b.frameSizeof ?? 0x1e0);

    const avcodec: LoadedPEModule = {
        name: "avcodec-56", path: "c:\\avcodec-56.dll", baseAddress: BASE, size: 0x8000,
        entryPoint: 0, exports: new Map([["avcodec_version", versionBody]]),
        ordinalExports: new Map(), isRealDll: true, initialized: true,
        sections: [{ name: ".rdata", virtualAddress: 0, virtualSize: 0x8000, rawSize: 0x8000, characteristics: 0 }],
    };
    const avutil: LoadedPEModule = {
        name: "avutil-54", path: "c:\\avutil-54.dll", baseAddress: avutilBase, size: 0x1000,
        entryPoint: 0, exports: new Map([["av_frame_alloc", allocBody]]),
        ordinalExports: new Map(), isRealDll: true, initialized: true,
        sections: [{ name: ".text", virtualAddress: 0, virtualSize: 0x1000, rawSize: 0x1000, characteristics: 0 }],
    };
    return { mem, avcodec, avutil };
}

describe("avcodec ABI measurement", () => {
    test("accepts the shipped Lavc 56.1.100 build and reports its offsets", () => {
        const { mem, avcodec, avutil } = makeImages();
        const abi = measureAvcodecAbi(avcodec, avutil, mem);
        expect(abi).not.toBeNull();
        expect(abi!.version).toBe("56.1.100");
        expect(abi!.ctxPixFmt).toBe(0x8c);
        expect(abi!.ctxRefcountedFrames).toBe(0x1e8);
        expect(abi!.frameBestEffort).toBe(0x1b0);
        expect(abi!.frameSizeof).toBe(0x1e0);
    });

    test("refuses a major version we have no pinned layout for", () => {
        const { mem, avcodec, avutil } = makeImages({ versionInt: (58 << 16) | (18 << 8) | 100 });
        expect(measureAvcodecAbi(avcodec, avutil, mem)).toBeNull();
    });

    test("refuses when one AVOption offsetof disagrees with the pinned layout", () => {
        // A single shifted field is exactly the silent-corruption case: everything else lines
        // up, and pix_fmt would be written into whatever moved into 0x8c.
        const { mem, avcodec, avutil } = makeImages({ anchorOverride: ["g", 0x84] });
        expect(measureAvcodecAbi(avcodec, avutil, mem)).toBeNull();
    });

    test("refuses when sizeof(AVFrame) is not the one we lay out", () => {
        const { mem, avcodec, avutil } = makeImages({ frameSizeof: 0x250 });
        expect(measureAvcodecAbi(avcodec, avutil, mem)).toBeNull();
    });

    test("refuses when the option table cannot be found at all", () => {
        const { mem, avcodec, avutil } = makeImages({ dropOptionTable: true });
        expect(measureAvcodecAbi(avcodec, avutil, mem)).toBeNull();
    });

    test("refuses when avutil is not loaded, rather than trusting sizeof(AVFrame)", () => {
        const { mem, avcodec } = makeImages();
        expect(measureAvcodecAbi(avcodec, undefined, mem)).toBeNull();
    });
});

describe("AVFrame freshness gate", () => {
    const abiOf = () => {
        const { mem, avcodec, avutil } = makeImages();
        return { abi: measureAvcodecAbi(avcodec, avutil, mem)!, mem };
    };
    /** get_frame_defaults leaves format -1, best_effort AV_NOPTS_VALUE, every buf[] NULL. */
    const freshFrame = (mem: Uint8Array, at: number, abi: { frameFormat: number; frameBestEffort: number }) => {
        mem.fill(0, at, at + 0x1e0);
        new DataView(mem.buffer).setInt32(at + abi.frameFormat, -1, true);
        new DataView(mem.buffer).setUint32(at + abi.frameBestEffort + 4, 0x80000000, true);
    };

    test("passes on a frame in avutil's default state", () => {
        const { abi, mem } = abiOf();
        freshFrame(mem, 0x20000, abi);
        expect(frameLooksFresh(mem, abi, 0x20000)).toBeNull();
    });

    test("goes red when format is not -1 — the offset we could not measure statically", () => {
        const { abi, mem } = abiOf();
        freshFrame(mem, 0x20000, abi);
        new DataView(mem.buffer).setInt32(0x20000 + abi.frameFormat, 0, true);
        expect(frameLooksFresh(mem, abi, 0x20000)).toContain("format");
    });

    test("goes red when best_effort_timestamp is not AV_NOPTS_VALUE", () => {
        const { abi, mem } = abiOf();
        freshFrame(mem, 0x20000, abi);
        new DataView(mem.buffer).setUint32(0x20000 + abi.frameBestEffort + 4, 0, true);
        expect(frameLooksFresh(mem, abi, 0x20000)).toContain("best_effort_timestamp");
    });

    test("goes red when a buf[] reference is present — someone else owns those planes", () => {
        const { abi, mem } = abiOf();
        freshFrame(mem, 0x20000, abi);
        new DataView(mem.buffer).setUint32(0x20000 + abi.frameBuf + 4, 0xdeadbeef, true);
        expect(frameLooksFresh(mem, abi, 0x20000)).toContain("buf[1]");
    });
});

/**
 * The VP8 frame-tag keyframe test, against bytes taken from this game's own packets (captured
 * live) and from its .webm files. A decoder handed a leading `delta` emits nothing at all, so
 * "is this a keyframe" has to be right for a reason better than a container flag.
 */
describe("VP8 frame tag keyframe detection", () => {
    // `data` is a GUEST POINTER, so 0 means NULL — the payload has to sit at a real address.
    const AT = 0x40;
    const place = (hex: string) => {
        const src = hex.split(" ").map((h) => parseInt(h, 16));
        const mem = new Uint8Array(0x100);
        mem.set(src, AT);
        return { mem, size: src.length };
    };
    const check = (hex: string) => {
        const { mem, size } = place(hex);
        return vp8FrameTagIsKeyframe(mem, AT, size);
    };

    test("recognises the 1920x1080 keyframe that opens these streams", () => {
        expect(check("30 b7 01 9d 01 2a 80 07 38 04")).toBe(true);
    });

    test("recognises the 1024x576 keyframe of the low-res variants", () => {
        expect(check("50 95 00 9d 01 2a 00 04 40 02")).toBe(true);
    });

    test("goes red on a real delta frame — the packet that must never open a session", () => {
        expect(check("11 18 00 07 10 e4 00 18 00 18")).toBe(false);
    });

    test("refuses to answer when the start code is absent (not raw VP8)", () => {
        // Frame-type bit says key, but without `9d 01 2a` this is not a VP8 keyframe payload.
        expect(check("30 b7 01 00 00 00 80 07 38 04")).toBeNull();
    });

    test("refuses to answer on a truncated payload rather than guessing", () => {
        expect(check("30 b7 01 9d 01")).toBeNull();
        // A NULL payload pointer is "cannot say", never "not a keyframe".
        expect(vp8FrameTagIsKeyframe(new Uint8Array(0x100), 0, 10)).toBeNull();
    });
});
