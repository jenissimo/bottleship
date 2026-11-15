import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { BufferSource, ZipArchive } from "@bottleship/formats/zip";
import { decodeXz, type XzStream } from "../../packages/formats/src/xz";
import { UnpackDecoder, UNPACK_TRANSFER_BUF_SIZE } from "../../packages/formats/src/unpack/unpack";
import { Crc32 } from "../../packages/formats/src/unpack/checksums";
import { COPY_CHUNK, ZipStoreWriter, crc32 } from "../internal/zip-store-writer";

let decoder: UnpackDecoder;
beforeAll(async () => {
    decoder = new UnpackDecoder();
    const bytes = readFileSync(resolve("public/unpack-streaming.wasm"));
    await decoder.init(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
});

function xzBlockFixture() {
    // Five literal LZMA2 packets cross the host transfer boundary without a large fixture.
    const payload = Uint8Array.from({ length: 5 * 65536 }, (_, i) => (i * 73 + (i >>> 8)) & 255);
    const packets: Uint8Array[] = [];
    for (let at = 0; at < payload.length; at += 65536) {
        const part = payload.subarray(at, at + 65536);
        const packet = new Uint8Array(3 + part.length);
        packet.set([at === 0 ? 1 : 2, 255, 255]);
        packet.set(part, 3); packets.push(packet);
    }
    const compressedSize = packets.reduce((n, p) => n + p.length, 0) + 1;
    const paddedSize = (compressedSize + 3) & ~3;
    const bytes = new Uint8Array(paddedSize + 4);
    let at = 0; for (const p of packets) { bytes.set(p, at); at += p.length; }
    const crc = new Crc32(); crc.update(payload);
    new DataView(bytes.buffer).setUint32(paddedSize, crc.finalize(), true);
    const base = 2 ** 32 + 4096;
    const stream: XzStream = { checkType: 1, checkSize: 4, uncompressedSize: payload.length,
        blocks: [{ offset: base - 12, dataOffset: base, compressedSize, uncompressedSize: payload.length, dictSize: 4096 }] };
    const requests: number[] = [];
    const source = { size: base + bytes.length, readRangeSync(start: number, end: number) {
        requests.push(end - start);
        if (end - start > UNPACK_TRANSFER_BUF_SIZE) throw new Error("unbounded compressed read");
        return bytes.subarray(start - base, end - base);
    } };
    return { payload, bytes, base, stream, source, requests };
}

test("XZ pulls a large compressed block by bounded ranges and verifies the real LZMA2 output", () => {
    const f = xzBlockFixture(), chunks: Uint8Array[] = [];
    decodeXz(f.source, decoder, f.stream, bytes => chunks.push(bytes));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(f.payload));
    expect(f.requests.length).toBeGreaterThan(2);
    expect(Math.max(...f.requests)).toBeLessThanOrEqual(UNPACK_TRANSFER_BUF_SIZE);
});

test("XZ ranged decoding still rejects truncated input, bad output length and integrity mismatch", () => {
    const truncated = xzBlockFixture();
    const short = { size: truncated.source.size, readRangeSync(start: number, end: number) {
        return truncated.source.readRangeSync(start, end - 1);
    } };
    expect(() => decodeXz(short, decoder, truncated.stream, () => {})).toThrow(/truncated/);
    const badLength = xzBlockFixture();
    const stream = { ...badLength.stream, blocks: [{ ...badLength.stream.blocks[0]!, uncompressedSize: badLength.payload.length + 1 }] };
    expect(() => decodeXz(badLength.source, decoder, stream, () => {})).toThrow(/index says/);
    const badCrc = xzBlockFixture(); badCrc.bytes[badCrc.bytes.length - 1]! ^= 1;
    expect(() => decodeXz(badCrc.source, decoder, badCrc.stream, () => {})).toThrow(/integrity check mismatch/);
});

function fixture() { mkdirSync(resolve("logs"), { recursive: true }); return mkdtempSync(resolve("logs/repack-stream-test-")); }
async function run(...args: string[]) {
    // Guard actual allocations in the CLI process, not its source spelling. The old
    // whole-local-file path fails on the fixture just beyond COPY_CHUNK.
    const preload = join(dirname(args[1]!), "allocation-guard.mjs");
    writeFileSync(preload, `const original = Buffer.allocUnsafe;
Buffer.allocUnsafe = size => {
    if (size > ${COPY_CHUNK}) throw new Error("unbounded local payload allocation: " + size);
    return original(size);
};\n`);
    const child = Bun.spawn(["bun", "--preload", preload, "tools/wgb.ts", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
}
async function open(path: string) {
    const zip = new ZipArchive(new BufferSource(readFileSync(path))); await zip.init(); return zip;
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("WGB add-dir and replace preserve bytes, CRC, order and untouched DOS timestamps across copy chunks", async () => {
    const root = fixture(), path = join(root, "test.wgb"), dir = join(root, "local");
    mkdirSync(join(dir, "nested"), { recursive: true });
    const payload = Buffer.allocUnsafe(COPY_CHUNK + 37);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + (i >>> 16)) & 255;
    const source = join(dir, "nested/payload.bin"); writeFileSync(source, payload);
    writeFileSync(join(dir, "empty"), "");
    const stamp = 1002283642, writer = new ZipStoreWriter(path);
    writer.addStored("keep.dat", new Uint8Array([1, 2, 3]), 0x2b4560eb);
    writer.addBuffer("rom/nested/payload.bin", Buffer.from("old")); writer.finish();
    try {
        const added = await run("add-dir", path, "rom", dir); expect(added.code, added.stderr).toBe(0);
        let zip = await open(path);
        expect(zip.listEntries().map(e => e.name)).toEqual(["keep.dat", "rom/nested/payload.bin", "rom/empty"]);
        const e = zip.getEntry("rom/nested/payload.bin")!;
        expect(e.crc32).toBe(crc32(payload)); expect(sha(await zip.readEntry(e))).toBe(sha(payload));
        expect(zip.getEntry("keep.dat")!.modified).toBe(stamp);
        expect((await zip.readEntry(zip.getEntry("rom/empty")!)).length).toBe(0);
        writeFileSync(source, payload.subarray(0, COPY_CHUNK - 13));
        const replaced = await run("replace", path, "rom/nested/payload.bin", source); expect(replaced.code, replaced.stderr).toBe(0);
        zip = await open(path);
        expect(sha(await zip.readEntry(zip.getEntry("rom/nested/payload.bin")!))).toBe(sha(payload.subarray(0, COPY_CHUNK - 13)));
        expect(zip.getEntry("keep.dat")!.modified).toBe(stamp);
        expect([...await zip.readEntry(zip.getEntry("keep.dat")!)]).toEqual([1, 2, 3]);
    } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("WGB replace can read its own input archive without overwriting it before the temp rewrite completes", async () => {
    const root = fixture(), path = join(root, "alias.wgb");
    const writer = new ZipStoreWriter(path); writer.addBuffer("keep", Buffer.from("original")); writer.finish();
    try {
        const original = readFileSync(path), result = await run("replace", path, "snapshot.wgb", path);
        expect(result.code, result.stderr).toBe(0);
        const zip = await open(path);
        expect(await zip.readEntry(zip.getEntry("snapshot.wgb")!)).toEqual(new Uint8Array(original));
        expect(new TextDecoder().decode(await zip.readEntry(zip.getEntry("keep")!))).toBe("original");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("WGB local edits refuse an existing temp/input alias without changing either file", async () => {
    const root = fixture(), path = join(root, "temp-alias.wgb"), temp = path + ".wgbtmp";
    const writer = new ZipStoreWriter(path); writer.addBuffer("keep", Buffer.from("original")); writer.finish();
    writeFileSync(temp, "replacement input must survive");
    try {
        const original = readFileSync(path), replacement = readFileSync(temp);
        for (const args of [["replace", path, "new", temp], ["add-dir", path, "rom", root], ["repack", path]]) {
            const result = await run(...args);
            expect(result.code).not.toBe(0); expect(result.stderr).toContain("EEXIST");
            expect(readFileSync(path)).toEqual(original); expect(readFileSync(temp)).toEqual(replacement);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("WGB local-file edits refuse compressed source entries and keep the source archive unchanged", async () => {
    const root = fixture(), path = join(root, "compressed.wgb"), dir = join(root, "local");
    mkdirSync(dir); writeFileSync(join(dir, "new"), "new");
    const payload = Buffer.from("compressed payload");
    const writer = new ZipStoreWriter(path); writer.addDeflated("old", [deflateRawSync(payload)], payload.length, crc32(payload)); writer.finish();
    try {
        const original = readFileSync(path), result = await run("add-dir", path, "rom", dir);
        expect(result.code).not.toBe(0); expect(result.stderr).toContain("is compressed");
        expect(readFileSync(path)).toEqual(original);
        expect(existsSync(path + ".wgbtmp")).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
