/**
 * Unit tests for the RAR5 reader (`@bottleship/formats/rar`).
 *
 * The reader enumerates layout for every entry but can only reproduce STORED data, so the
 * load-bearing behaviour is the REFUSAL: a compressed/solid/encrypted entry must be named
 * and rejected, never sliced out as if it were plain bytes. Archives here are synthesised
 * byte by byte (no rar.exe anywhere in the loop), which also pins the vint decoder and the
 * data-offset arithmetic the extractor slices with.
 */
import { describe, expect, test } from "bun:test";
import { BufferSource } from "@bottleship/formats/unpack";
import { parseRar, assertExtractable, isRar, volumeName, RarError } from "@bottleship/formats/rar";

const RAR5_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];

function vint(value: number): number[] {
    const out: number[] = [];
    let v = value;
    do {
        const byte = v % 128;
        v = Math.floor(v / 128);
        out.push(v > 0 ? byte | 0x80 : byte);
    } while (v > 0);
    return out;
}

interface FileSpec {
    name: string;
    data: number[];
    method?: number;
    solid?: boolean;
    directory?: boolean;
    /** Extra-area record types to append (1 = CRYPT, 5 = REDIR). */
    extra?: number[];
    /** Corrupt the extra area so the record walk cannot finish. */
    extraGarbage?: boolean;
}

/** One extra-area record: [size][type][payload]; size covers type+payload. */
function extraRecord(type: number, payload: number[] = []): number[] {
    const tail = [...vint(type), ...payload];
    return [...vint(tail.length), ...tail];
}

/** Minimal RAR5 writer: main header + one file header per spec + end-of-archive. */
function buildArchive(files: FileSpec[]): Uint8Array {
    const bytes: number[] = [...RAR5_SIG];

    const block = (type: number, body: number[], data: number[] | null, extra: number[] = []) => {
        const flags = (data ? 0x0002 : 0) | (extra.length ? 0x0001 : 0);
        const head = [
            ...vint(type),
            ...vint(flags),
            ...(extra.length ? vint(extra.length) : []),
            ...(data ? vint(data.length) : []),
            ...body,
            ...extra, // the extra area is LAST in the header, which is what the reader assumes
        ];
        // Header CRC32 is not validated by the reader (the payload CRC is what matters),
        // so a zero placeholder keeps the fixture readable.
        bytes.push(0, 0, 0, 0, ...vint(head.length), ...head, ...(data ?? []));
    };

    block(1, [...vint(0)], null); // main: no archive flags
    for (const f of files) {
        const nameBytes = [...new TextEncoder().encode(f.name)];
        const compInfo = ((f.method ?? 0) << 7) | ((f.solid ? 1 : 0) << 6) | 0;
        const body = [
            ...vint(f.directory ? 0x0001 : 0), // file flags: no mtime/crc
            ...vint(f.directory ? 0 : f.data.length), // unpacked size
            ...vint(0x20), // attributes
            ...vint(compInfo),
            ...vint(0), // host os
            ...vint(nameBytes.length),
            ...nameBytes,
        ];
        const extra = f.extraGarbage
            ? [0xff, 0xff, 0xff] // a record claiming to run past the header end
            : (f.extra ?? []).flatMap((t) => extraRecord(t));
        block(2, body, f.directory ? null : f.data, extra);
    }
    block(5, [...vint(0)], null); // end of archive
    return Uint8Array.from(bytes);
}

const HELLO = [...new TextEncoder().encode("hello rar")];

describe("parseRar", () => {
    test("enumerates stored entries with usable data offsets", () => {
        const buf = buildArchive([{ name: "dir/hello.txt", data: HELLO }]);
        const archive = parseRar(new BufferSource(buf));
        expect(archive.entries.length).toBe(1);
        const entry = archive.entries[0]!;
        expect(entry.name).toBe("dir/hello.txt");
        expect(entry.method).toBe(0);
        expect(entry.unpackedSize).toBe(HELLO.length);
        expect(entry.packedSize).toBe(HELLO.length);
        // The offset is what the extractor slices with — read it back.
        const data = buf.subarray(entry.dataOffset, entry.dataOffset + entry.packedSize);
        expect(new TextDecoder().decode(data)).toBe("hello rar");
    });

    test("walks past a large-vint header (multi-byte name length)", () => {
        const name = "x".repeat(300);
        const archive = parseRar(new BufferSource(buildArchive([{ name, data: HELLO }])));
        expect(archive.entries[0]!.name).toBe(name);
    });

    test("directory entries carry no data", () => {
        const archive = parseRar(new BufferSource(buildArchive([{ name: "save", data: [], directory: true }])));
        expect(archive.entries[0]!.isDirectory).toBe(true);
        expect(archive.entries[0]!.packedSize).toBe(0);
    });

    test("rejects a non-RAR input", () => {
        expect(() => parseRar(new BufferSource(new Uint8Array(16)))).toThrow(RarError);
    });

    test("rejects RAR 1.5-4.x by name rather than mis-parsing it", () => {
        const rar4 = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00]);
        expect(() => parseRar(new BufferSource(rar4))).toThrow(/RAR 1\.5-4\.x/);
    });

    test("rejects an encrypted archive instead of returning garbage entries", () => {
        // A crypt header (type 4) precedes the encrypted headers.
        const bytes = [...RAR5_SIG];
        const head = [...vint(4), ...vint(0), ...vint(0)];
        bytes.push(0, 0, 0, 0, ...vint(head.length), ...head);
        expect(() => parseRar(new BufferSource(Uint8Array.from(bytes)))).toThrow(/encrypted/);
    });
});

describe("assertExtractable", () => {
    test("passes a stored entry", () => {
        const [entry] = parseRar(new BufferSource(buildArchive([{ name: "a.bin", data: HELLO }]))).entries;
        expect(() => assertExtractable(entry!)).not.toThrow();
    });

    test("refuses a compressed entry, naming it", () => {
        const [entry] = parseRar(new BufferSource(buildArchive([{ name: "a.bin", data: HELLO, method: 3 }]))).entries;
        expect(() => assertExtractable(entry!)).toThrow(/"a\.bin".*method 3/);
    });

    test("refuses a solid entry", () => {
        const [entry] = parseRar(new BufferSource(buildArchive([{ name: "a.bin", data: HELLO, solid: true }]))).entries;
        expect(() => assertExtractable(entry!)).toThrow(/solid/);
    });

    // `rar -p` encrypts the DATA and leaves the headers readable: method stays 0 and every
    // other field looks ordinary, so only the extra area distinguishes a stored file from
    // AES blocks. Skipping that area would have this entry "extracted" as ciphertext.
    test("refuses a per-file encrypted entry whose headers are plaintext", () => {
        const [entry] = parseRar(new BufferSource(buildArchive([{ name: "a.bin", data: HELLO, extra: [1] }]))).entries;
        expect(entry!.method).toBe(0);
        expect(entry!.encrypted).toBe(true);
        expect(() => assertExtractable(entry!)).toThrow(/encrypted/);
    });

    test("refuses a link/redirect entry", () => {
        const [entry] = parseRar(new BufferSource(buildArchive([{ name: "l", data: HELLO, extra: [5] }]))).entries;
        expect(entry!.redirect).toBe(true);
        expect(() => assertExtractable(entry!)).toThrow(/link\/redirect/);
    });

    test("an unwalkable extra area refuses instead of reporting 'not encrypted'", () => {
        const [entry] = parseRar(new BufferSource(buildArchive([{ name: "a.bin", data: HELLO, extraGarbage: true }]))).entries;
        expect(entry!.extraUnreadable).toBe(true);
        expect(entry!.encrypted).toBe(false); // unknown, NOT a clean bill of health
        expect(() => assertExtractable(entry!)).toThrow(/cannot rule out encryption/);
    });

    test("a plain stored entry reads clean through the same path", () => {
        const [entry] = parseRar(new BufferSource(buildArchive([{ name: "a.bin", data: HELLO }]))).entries;
        expect(entry!.encrypted).toBe(false);
        expect(entry!.redirect).toBe(false);
        expect(entry!.extraUnreadable).toBe(false);
    });
});

describe("helpers", () => {
    test("isRar accepts both generations", () => {
        expect(isRar(Uint8Array.from(RAR5_SIG))).toBe(true);
        expect(isRar(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe(true);
        expect(isRar(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    });

    test("volumeName follows a .partN.rar set, preserving digit width", () => {
        expect(volumeName("game.part01.rar", 1)).toBe("game.part02.rar");
        expect(volumeName("game.part9.rar", 1)).toBe("game.part10.rar");
        expect(volumeName("game.rar", 1)).toBeNull();
    });
});
