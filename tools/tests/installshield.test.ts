/**
 * InstallShield 5 cabinet parser/extractor tests (packages/formats/src/installshield).
 *
 * Builds a SYNTHETIC IS5 cabinet (header + data1.cab) in memory matching the exact
 * byte layout the parser reads — the directory/file tables, the v5 file-descriptor
 * stride (name@0, dir@4, flags@8, expanded@0xa, compressed@0xe, data_offset@0x26,
 * md5@0x2a), and the u16-length-prefixed raw-deflate chunk stream — then asserts a
 * round-trip extraction (one uncompressed file, one compressed file, an MD5 check,
 * and the dir/name mapping). No 31MB fixture committed; this proves the layout math.
 */
import { describe, expect, test } from "bun:test";
import { deflateRawSync, inflateRawSync } from "zlib";
import { createHash } from "crypto";
import { extractInstallerFromFiles } from '@bottleship/repack/container-extract';

/** Node-backed raw inflater injected into the browser core (Bun lacks DecompressionStream). */
const nodeInflate = (chunk: Uint8Array) => new Uint8Array(inflateRawSync(Buffer.from(chunk)));
import {
    parseInstallShieldHeader,
    extractInstallShield,
    detectInstallShieldStem,
    FILE_COMPRESSED,
    FILE_OBFUSCATED,
} from "@bottleship/formats/installshield";

const CAB_SIGNATURE = 0x28635349;
const COMMON_HEADER_SIZE = 20;

interface SynthFile {
    name: string;
    dirIndex: number;
    data: Uint8Array;
    compress: boolean;
}

/** Encode a compressed payload as the u16-length-prefixed raw-deflate chunk stream. */
function chunkStream(data: Uint8Array): Uint8Array {
    const deflated = new Uint8Array(deflateRawSync(Buffer.from(data)));
    // single chunk: [u16 len][deflated bytes]
    const out = new Uint8Array(2 + deflated.length);
    new DataView(out.buffer).setUint16(0, deflated.length, true);
    out.set(deflated, 2);
    return out;
}

/**
 * Build a synthetic IS5 cabinet. Returns { header, cab }.
 * Layout (single volume, no splits, no obfuscation):
 *   header (.hdr): common(20) | file_table | directories(cstr) | file_descriptors | names(cstr)
 *   cab (data1.cab): common(20) | volume_header(40) | file data blobs
 */
function buildIs5(dirs: string[], files: SynthFile[], early = false): { header: Uint8Array; cab: Uint8Array } {
    const enc = new TextEncoder();

    // ----- cab: lay out file data first so we know data_offsets -----
    const cabParts: { off: number; bytes: Uint8Array }[] = [];
    let cabPos = COMMON_HEADER_SIZE + 40; // after common header + v5 volume header
    const fileBlobs = files.map((f) => {
        const stored = f.compress ? chunkStream(f.data) : f.data;
        const off = cabPos;
        cabParts.push({ off, bytes: stored });
        cabPos += stored.length;
        return { off, expanded: f.data.length, compressed: stored.length };
    });
    const cab = new Uint8Array(cabPos);
    const cdv = new DataView(cab.buffer);
    cdv.setUint32(0, CAB_SIGNATURE, true);
    cdv.setUint32(4, 0x01005201, true); // version dword → major 5
    // volume header (v5): all zeros is fine for a single non-split volume.
    for (const part of cabParts) cab.set(part.bytes, part.off);

    // ----- header (.hdr) -----
    // We assemble in sections to compute offsets, then patch the cab descriptor.
    const dirCount = dirs.length;
    const fileCount = files.length;
    const tableCount = dirCount + fileCount;

    // Section A: cab descriptor (we place it right after the common header).
    // The descriptor needs 0x30 bytes of fixed fields + file_group/component arrays;
    // the parser only reads the first 0x30, so we allocate exactly a fixed prefix and
    // set file_table_offset to point past it. cab_descriptor_offset = COMMON_HEADER_SIZE.
    const cdOff = COMMON_HEADER_SIZE;
    const cdFixed = 0x30; // file_table_offset is relative to cdOff and points here.

    // file_table: tableCount u32 entries (relative offsets from `base = cdOff + file_table_offset`)
    const fileTableOffset = cdFixed;
    const base = cdOff + fileTableOffset;
    const fileTableBytes = tableCount * 4;

    // Section: directory cstrings (relative to base)
    let cur = fileTableBytes;
    const dirRelOffsets: number[] = [];
    for (const d of dirs) {
        dirRelOffsets.push(cur);
        cur += enc.encode(d).length + 1;
    }

    // Section: file descriptors (0x3a stride each for v5)
    const descStride = early ? 0x2a : 0x3a;
    const descRelOffsets: number[] = [];
    for (let i = 0; i < fileCount; i++) {
        descRelOffsets.push(cur);
        cur += descStride;
    }

    // Section: file-name cstrings (relative to base)
    const nameRelOffsets: number[] = [];
    for (const f of files) {
        nameRelOffsets.push(cur);
        cur += enc.encode(f.name).length + 1;
    }

    const headerSize = base + cur;
    const header = new Uint8Array(headerSize);
    const hdv = new DataView(header.buffer);
    const writeCstr = (rel: number, s: string) => header.set(enc.encode(s), base + rel);

    // common header
    hdv.setUint32(0, CAB_SIGNATURE, true);
    hdv.setUint32(4, 0x01005201, true); // major 5
    hdv.setUint32(8, 0, true); // volume_info
    hdv.setUint32(12, cdOff, true); // cab_descriptor_offset
    hdv.setUint32(16, headerSize - cdOff, true); // cab_descriptor_size (non-zero)

    // cab descriptor fixed fields (offsets relative to cdOff)
    hdv.setUint32(cdOff + 0x0c, fileTableOffset, true);
    hdv.setUint32(cdOff + 0x14, fileTableBytes, true); // file_table_size
    hdv.setUint32(cdOff + 0x18, fileTableBytes, true); // file_table_size2
    hdv.setUint32(cdOff + 0x1c, dirCount, true); // directory_count
    hdv.setUint32(cdOff + 0x28, fileCount, true); // file_count
    hdv.setUint32(cdOff + 0x2c, 0, true); // file_table_offset2 (unused for v5)

    // file_table entries
    for (let i = 0; i < dirCount; i++) hdv.setUint32(base + i * 4, dirRelOffsets[i]!, true);
    for (let i = 0; i < fileCount; i++) {
        hdv.setUint32(base + (dirCount + i) * 4, descRelOffsets[i]!, true);
    }

    // directory cstrings
    for (let i = 0; i < dirCount; i++) writeCstr(dirRelOffsets[i]!, dirs[i]!);

    // file descriptors (v5 stride 0x3a)
    for (let i = 0; i < fileCount; i++) {
        const p = base + descRelOffsets[i]!;
        const f = files[i]!;
        const b = fileBlobs[i]!;
        hdv.setUint32(p + 0x00, nameRelOffsets[i]!, true); // name_offset
        hdv.setUint16(p + 0x04, f.dirIndex, true); // directory_index
        hdv.setUint16(p + 0x08, f.compress ? FILE_COMPRESSED : 0, true); // flags
        hdv.setUint32(p + 0x0a, b.expanded, true); // expanded_size
        hdv.setUint32(p + 0x0e, b.compressed, true); // compressed_size
        hdv.setUint32(p + 0x26, b.off, true); // data_offset
        const md5 = new Uint8Array(createHash("md5").update(Buffer.from(f.data)).digest());
        if (!early) header.set(md5, p + 0x2a); // md5[16]
    }

    // file-name cstrings
    for (let i = 0; i < fileCount; i++) writeCstr(nameRelOffsets[i]!, files[i]!.name);

    return { header, cab };
}

describe("InstallShield 5 parser", () => {
    test('early descriptors omit MD5 without consuming the next record', async () => {
        const payload = new TextEncoder().encode('cabinet payload');
        const {header,cab} = buildIs5([''], [
            {name:'first.bin',dirIndex:0,data:payload,compress:true},
            {name:'last.bin',dirIndex:0,data:payload,compress:false},
        ], true);
        for (const version of [0x01005100,0x01000004]) {
            new DataView(header.buffer).setUint32(4, version, true);
            const info = parseInstallShieldHeader(header);
            expect(info.major).toBe(version === 0x01005100 ? 5 : 0);
            expect(info.files.map(f => f.md5)).toEqual([null,null]);
            const out = await extractInstallShield(header,new Map([[1,cab]]),{inflateRaw:nodeInflate});
            expect(out.get('first.bin')).toEqual(payload);
            expect(out.get('last.bin')).toEqual(payload);
        }
    });
    test("parses dirs + v5 file descriptors", () => {
        const { header } = buildIs5(
            ["", "Drivers"],
            [
                { name: "Game.exe", dirIndex: 0, data: new Uint8Array([1, 2, 3, 4]), compress: false },
                { name: "d.dll", dirIndex: 1, data: new Uint8Array(50).fill(7), compress: true },
            ],
        );
        const info = parseInstallShieldHeader(header);
        expect(info.major).toBe(5);
        expect(info.dirs).toEqual(["", "Drivers"]);
        expect(info.files.length).toBe(2);
        expect(info.files[0]!.name).toBe("Game.exe");
        expect(info.files[0]!.dir).toBe("");
        expect(info.files[0]!.expanded).toBe(4);
        expect(info.files[1]!.name).toBe("d.dll");
        expect(info.files[1]!.dir).toBe("Drivers");
        expect(info.files[1]!.flags & FILE_COMPRESSED).toBe(FILE_COMPRESSED);
        expect(info.files[1]!.md5).not.toBeNull();
    });
});

describe("InstallShield 5 extraction", () => {
    test('plaintext recovery is explicit and still verifies the digest', async () => {
        const payload = new TextEncoder().encode('MZ-plaintext-with-a-wrong-cabinet-flag');
        for (const compress of [false, true]) {
            const {header, cab} = buildIs5([''], [{name:'game.exe',dirIndex:0,data:payload,compress}]);
            const dv = new DataView(header.buffer);
            const base = COMMON_HEADER_SIZE + dv.getUint32(COMMON_HEADER_SIZE + 0x0c, true);
            const descriptor = base + dv.getUint32(base + 4, true);
            dv.setUint16(descriptor + 8, (compress ? FILE_COMPRESSED : 0) | FILE_OBFUSCATED, true);
            const volumes = new Map([[1, cab]]);
            await expect(extractInstallShield(header, volumes, {inflateRaw:nodeInflate})).rejects.toThrow();
            const restored = await extractInstallShield(header, volumes, {inflateRaw:nodeInflate,ignoreObfuscation:true});
            expect(restored.get('game.exe')).toEqual(payload);
            header[descriptor + 0x2a]! ^= 1;
            await expect(extractInstallShield(header, volumes, {inflateRaw:nodeInflate,ignoreObfuscation:true})).rejects.toThrow(/MD5 mismatch/);
        }
    });

    test('normal extraction decodes genuinely obfuscated payloads', async () => {
        const payload = new TextEncoder().encode('MZ-genuinely-obfuscated');
        for (const compress of [false, true]) {
            const {header, cab} = buildIs5([''], [{name:'game.exe',dirIndex:0,data:payload,compress}]);
            const dv = new DataView(header.buffer);
            const base = COMMON_HEADER_SIZE + dv.getUint32(COMMON_HEADER_SIZE + 0x0c, true);
            const descriptor = base + dv.getUint32(base + 4, true);
            dv.setUint16(descriptor + 8, (compress ? FILE_COMPRESSED : 0) | FILE_OBFUSCATED, true);
            const start = dv.getUint32(descriptor + 0x26, true);
            const size = dv.getUint32(descriptor + 0x0e, true);
            for (let i = 0; i < size; i++) {
                const shifted = (cab[start + i]! + i % 0x47) & 0xff;
                cab[start + i] = ((shifted << 2) | (shifted >>> 6)) ^ 0xd5;
            }
            const restored = await extractInstallShield(header, new Map([[1,cab]]), {inflateRaw:nodeInflate});
            expect(restored.get('game.exe')).toEqual(payload);
        }
    });

    test('container extraction accepts an IS5 descriptor embedded in data1.cab', async () => {
        const payload = new TextEncoder().encode('MZ-test-game');
        const {header,cab} = buildIs5([''], [{name:'game.exe',dirIndex:0,data:payload,compress:true}]);
        const combined = new Uint8Array(cab.length + header.length - COMMON_HEADER_SIZE);
        combined.set(cab); combined.set(header.subarray(COMMON_HEADER_SIZE), cab.length);
        combined.set(header.subarray(0, COMMON_HEADER_SIZE));
        new DataView(combined.buffer).setUint32(12, cab.length, true);
        const result = await extractInstallerFromFiles(new Map([['Disk1/DATA1.CAB', combined]]), {inflateRaw:nodeInflate});
        expect(result.via).toBe('installshield');
        expect(result.gameFiles.get('game.exe')).toEqual(payload);
        expect(result.gameFiles.size).toBe(1);
    });
    test("round-trips uncompressed + compressed files with MD5 verify", async () => {
        const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4, 5]);
        const big = new Uint8Array(2000);
        for (let i = 0; i < big.length; i++) big[i] = (i * 37) & 0xff;
        const { header, cab } = buildIs5(
            ["", "Drivers"],
            [
                { name: "Game.exe", dirIndex: 0, data: exe, compress: false },
                { name: "voodoo.dll", dirIndex: 1, data: big, compress: true },
            ],
        );
        const out = await extractInstallShield(header, new Map([[1, cab]]), {
            verifySize: true,
            verifyMd5: true,
            inflateRaw: nodeInflate,
        });
        expect([...out.keys()].sort()).toEqual(["Drivers/voodoo.dll", "Game.exe"]);
        expect(out.get("Game.exe")).toEqual(exe);
        expect(out.get("Drivers/voodoo.dll")).toEqual(big);
    });

    test("throws on a corrupted compressed descriptor (size mismatch)", async () => {
        const big = new Uint8Array(500).fill(0x5a);
        const { header, cab } = buildIs5(
            [""],
            [{ name: "a.bin", dirIndex: 0, data: big, compress: true }],
        );
        // Corrupt the stored expanded_size DOWN: the single chunk still inflates to the
        // real 500 bytes, the loop stops (produced >= claim), and 500 != 100 → size mismatch.
        const dv = new DataView(header.buffer);
        const cdOff = COMMON_HEADER_SIZE;
        const fileTableOffset = dv.getUint32(cdOff + 0x0c, true);
        const base = cdOff + fileTableOffset;
        const descRel = dv.getUint32(base + 1 * 4, true); // file_table[dirCount(1) + index(0)]
        dv.setUint32(base + descRel + 0x0a, 100, true); // wrong (too small) expanded size
        await expect(
            extractInstallShield(header, new Map([[1, cab]]), {
                verifySize: true,
                verifyMd5: false,
                inflateRaw: nodeInflate,
            }),
        ).rejects.toThrow(/Size mismatch/);
    });
});

describe("detectInstallShieldStem", () => {
    test("recognizes data1.hdr + data1.cab pair", () => {
        expect(detectInstallShieldStem(["data1.hdr", "data1.cab", "setup.exe"])).toBe("data");
    });
    test("case-insensitive + path-stripping", () => {
        expect(detectInstallShieldStem(["sub/DATA1.HDR", "sub/Data1.Cab"])).toBe("data");
    });
    test("returns null without a matching pair", () => {
        expect(detectInstallShieldStem(["data1.hdr", "setup.exe"])).toBeNull();
        expect(detectInstallShieldStem(["game.exe"])).toBeNull();
    });

    test("prefers the game cabinet over IS engine cabinets (_sys/_user)", () => {
        // NFS Porsche layout: data1 (game) + _sys1 + _user1 (engine support).
        // The detector MUST pick `data`, not an underscore engine stem — picking
        // `_sys` extracts 4 scaffolding files (IsUninst.Exe etc.) instead of the game.
        expect(
            detectInstallShieldStem([
                "_sys1.hdr",
                "_sys1.cab",
                "_user1.hdr",
                "_user1.cab",
                "data1.hdr",
                "data1.cab",
            ]),
        ).toBe("data");
        // Engine stems come first in the list — order must not matter.
        expect(
            detectInstallShieldStem(["_sys1.hdr", "_sys1.cab", "game1.hdr", "game1.cab"]),
        ).toBe("game");
    });

    test("falls back to an engine stem only when it is the sole cabinet", () => {
        expect(detectInstallShieldStem(["_sys1.hdr", "_sys1.cab"])).toBe("_sys");
    });
});
