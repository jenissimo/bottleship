import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflate } from "pako";
import { writeZipStream } from "@bottleship/formats/wgb/zip-stream";
import { BufferSource, ZipArchive } from "@bottleship/formats/zip";
import { UnpackDecoder, UNPACK_STORE, UNPACK_LZMA1 } from "@bottleship/formats/unpack";
import { extractInno, type InnoParseResult } from "@bottleship/formats/inno";
import { CompressionMethod } from "@bottleship/formats/inno/header";
import { ExtractionArena, orderInstallerParts } from "../../src/worker/runtime/filesystem/installer-opfs";
import { writeBytesToFileHandle } from "../../src/save-as";

let decoder: UnpackDecoder;
beforeAll(async () => {
    decoder = new UnpackDecoder();
    await decoder.init(readFileSync(new URL("../../public/unpack-streaming.wasm", import.meta.url)));
});

test("streamed ZIP64 preserves UTF-8 names, empty files and CRCs in an independent reader", async () => {
    const payload = new Uint8Array(900_003).map((_, i) => i * 17 & 255);
    const blocks: { at: number; bytes: Uint8Array }[] = [];
    let maxRead = 0;
    const size = await writeZipStream([
        { name: "rom/данные.bin", source: { size: payload.length, readRange: async (a, b) => {
            maxRead = Math.max(maxRead, b - a); return payload.subarray(a, b);
        } } },
        { name: "empty", source: new BufferSource(new Uint8Array(0)) },
    ], { write: (bytes, at) => { blocks.push({ at, bytes: bytes.slice() }); } });
    expect(maxRead).toBeLessThanOrEqual(256 * 1024);
    const zip = new Uint8Array(size);
    for (const { at, bytes } of blocks) zip.set(bytes, at);
    // Other runtime tests install browser globals; isolate the independent Node ZIP reader.
    const independent = Bun.spawnSync([process.execPath, "-e", `
        import JSZip from "jszip";
        import { createHash } from "node:crypto";
        const archive = await JSZip.loadAsync(await Bun.stdin.arrayBuffer(), { checkCRC32: true });
        const data = await archive.file("rom/данные.bin").async("uint8array");
        console.log(JSON.stringify({ size: data.length, hash: createHash("sha256").update(data).digest("hex"),
            empty: (await archive.file("empty").async("uint8array")).length }));
    `], { stdin: zip, stdout: "pipe", stderr: "pipe" });
    expect(independent.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(independent.stdout))).toEqual({
        size: payload.length, hash: createHash("sha256").update(payload).digest("hex"), empty: 0,
    });
    const runtime = new ZipArchive(new BufferSource(zip)); await runtime.init();
    expect(await runtime.readEntry(runtime.getEntry("rom/данные.bin")!)).toEqual(payload);
});

test("streamed ZIP rejects a short source instead of publishing truncated data", async () => {
    await expect(writeZipStream([{ name: "bad", source: { size: 10, readRange: async () => new Uint8Array(9) } }],
        { write() {} })).rejects.toThrow("Truncated ZIP input");
});

test("decoder pulls bounded input and delivers bounded output, with short-read detection", () => {
    const bytes = new Uint8Array(2_000_003).fill(42);
    let readMax = 0, writeMax = 0, written = 0;
    decoder.decodeSourceToCallback(UNPACK_STORE, { size: bytes.length, readRangeSync(a, b) {
        readMax = Math.max(readMax, b - a); return bytes.subarray(a, b);
    } }, data => { writeMax = Math.max(writeMax, data.length); written += data.length; return true; });
    expect(written).toBe(bytes.length);
    expect(readMax).toBeLessThanOrEqual(256 * 1024);
    expect(writeMax).toBeLessThanOrEqual(256 * 1024);
    expect(() => decoder.decodeSourceToCallback(UNPACK_STORE, { size: 2, readRangeSync: () => new Uint8Array(1) }, () => true)).toThrow();
});

test("range-backed LZMA remains correct when decoder instances alternate", async () => {
    const another = new UnpackDecoder();
    await another.init(readFileSync(new URL("../../public/unpack-streaming.wasm", import.meta.url)));
    const data = readFileSync(new URL("./fixtures/inno/lzma/hello.lzma1", import.meta.url));
    const props = readFileSync(new URL("./fixtures/inno/lzma/hello.props", import.meta.url));
    const expected = readFileSync(new URL("./fixtures/inno/lzma/hello.txt", import.meta.url));
    for (const current of [decoder, another, decoder]) {
        const out: Uint8Array[] = [];
        current.decodeSourceToCallback(UNPACK_LZMA1, { size: data.length, readRangeSync: (a, b) => data.subarray(a, b) },
            chunk => { out.push(chunk.slice()); return true; }, props);
        expect(Buffer.concat(out)).toEqual(expected);
    }
});

test("OPFS arena handles partial I/O and isolates interleaved file extents", () => {
    const bytes = new Uint8Array(100);
    const arena = new ExtractionArena({ truncate() {}, flush() {}, close() {},
        write(data, { at }) { const n = Math.min(3, data.length); bytes.set(data.subarray(0, n), at); return n; },
        read(data, { at }) { const n = Math.min(2, data.length); data.set(bytes.subarray(at, at + n)); return n; },
    });
    const a = arena.reserve(8), b = arena.reserve(8);
    a.writeAt(new Uint8Array([1, 2, 3, 4]), 4); b.writeAt(new Uint8Array(8).fill(9), 0);
    expect(a.readRangeSync(4, 8)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(b.readRangeSync(0, 8)).toEqual(new Uint8Array(8).fill(9));
    expect(() => a.writeAt(new Uint8Array(9), 0)).toThrow("out of bounds");
});

test("multipart ordering supports disk letters and rejects missing, foreign and duplicate parts", () => {
    const parts = [{ name: "Setup-2a.bin" }, { name: "Setup-1b.bin" }, { name: "Setup-1a.bin" }];
    expect(orderInstallerParts(parts, "setup.exe", 2, 3).map(p => p.name)).toEqual(["Setup-1a.bin", "Setup-1b.bin", "Setup-2a.bin"]);
    expect(() => orderInstallerParts(parts.slice(1), "setup.exe", 2, 3)).toThrow("Missing installer part");
    expect(() => orderInstallerParts([...parts, { name: "other.bin" }], "setup.exe", 2, 3)).toThrow("do not belong");
    expect(() => orderInstallerParts([parts[2]!, parts[2]!], "setup.exe", 2, 1)).toThrow("do not belong");
});

test("saving a disk-backed Blob never requests its entire ArrayBuffer and aborts on failure", async () => {
    class DiskBlob extends Blob { arrayBuffer(): Promise<ArrayBuffer> { throw new Error("Whole-file read"); } }
    const input = new DiskBlob([new Uint8Array(9 * 1024 * 1024)]);
    let written = 0, closed = false, aborted = false;
    const handle = { createWritable: async () => ({
        write: async (chunk: Blob) => { expect(chunk.size).toBeLessThanOrEqual(4 * 1024 * 1024); written += chunk.size; },
        close: async () => { closed = true; }, abort: async () => { aborted = true; },
    }) } as unknown as FileSystemFileHandle;
    await writeBytesToFileHandle(handle, input);
    expect(written).toBe(input.size); expect(closed).toBe(true); expect(aborted).toBe(false);
    const broken = { createWritable: async () => ({ write: async () => { throw new Error("Disk full"); }, abort: async () => { aborted = true; } }) } as unknown as FileSystemFileHandle;
    await expect(writeBytesToFileHandle(broken, input)).rejects.toThrow("Disk full");
    expect(aborted).toBe(true);
});

test("Galaxy segment assembly streams zlib, hashes in file order, and fans out deduplicated paths", async () => {
    const first = new Uint8Array(400_000).fill(65), second = new Uint8Array(300_000).fill(66);
    const expected = Buffer.concat([first, second]);
    const segments = [deflate(first), second];
    const dataEntries = segments.map((bytes, i) => ({ firstSlice: 0, lastSlice: 0, sortOffset: i * 1_000_000,
        fileOffset: 0n, fileSize: BigInt(bytes.length), chunkSize: BigInt(bytes.length),
        uncompressedSize: BigInt(i ? second.length : first.length), checksumType: "crc32", checksum: new Uint8Array(4),
        timestamp: 0n, fileVersion: 0n, options: 0, sign: 0, chunkCompressed: false, zlibFilter: !i }));
    const file = { source: "", destination: "data/one.bin", check: "", location: 0, additionalLocations: [1],
        assemblySize: BigInt(expected.length), galaxyChecksumType: "md5", galaxyChecksum: new Uint8Array(createHash("md5").update(expected).digest()), options: 0 };
    const parsed = { header: { compression: CompressionMethod.Stored, options: 0 }, offsets: { dataOffset: 0 },
        files: [file, { ...file, destination: "data/two.bin" }], dataEntries } as unknown as InnoParseResult;
    const slice = { readSpan(_slice: number, offset: number, length: number) {
        const i = Math.floor(offset / 1_000_000), at = offset % 1_000_000;
        const chunk = Buffer.concat([new Uint8Array([0x7a, 0x6c, 0x62, 0x1a]), segments[i]!]);
        return chunk.subarray(at, at + length);
    } };
    const results = new Map<string, Uint8Array[]>(); let maxRead = 0, closed = 0;
    await extractInno({ size: 0, readRangeSync: () => new Uint8Array(0) }, {
        wantFile: () => true,
        createAssemblyStore(size) { const bytes = new Uint8Array(size); return {
            size, writeAt: (data, at) => bytes.set(data, at),
            readRangeSync(a, b) { maxRead = Math.max(maxRead, b - a); return bytes.subarray(a, b); },
            close() { closed++; },
        }; },
    }, path => { const out: Uint8Array[] = []; results.set(path, out); return {
        begin() {}, data: bytes => { out.push(bytes.slice()); }, end: ok => { expect(ok).toBe(true); },
    }; }, decoder, parsed, slice);
    expect([...results.keys()]).toEqual(["data/one.bin", "data/two.bin"]);
    for (const out of results.values()) expect(Buffer.concat(out)).toEqual(expected);
    expect(maxRead).toBeLessThanOrEqual(256 * 1024); expect(closed).toBe(1);
});
