/**
 * EA RefPack — the LZ77 variant every SAGE `.big` entry is stored with.
 *
 * A decoder only: nothing here needs to produce archives, and a compressor would be a second
 * implementation of the format with nothing to check it against.
 *
 * The header is two bytes of magic-with-flags, big-endian, followed by one or two sizes that are
 * ALSO big-endian and either 3 or 4 bytes wide depending on a flag. Everything in the container
 * is big-endian; reading any of it little-endian yields a plausible size and a decode that runs
 * off the end thousands of bytes later.
 */

/** Thrown rather than returning a short buffer: a truncated decode is indistinguishable from a
 *  small file, and the caller would go on to parse garbage. */
export class RefPackError extends Error {}

/** Does this buffer start with a RefPack header? (0x10FB, plus the 4-byte-size/compressed-size flags.) */
export function isRefPack(src: Uint8Array, at = 0): boolean {
    return src.length >= at + 2 && (src[at]! & 0x3e) === 0x10 && src[at + 1] === 0xfb;
}

/** The size `decodeRefPack` will produce, read from the header without decoding. */
export function refPackSize(src: Uint8Array, at = 0): number {
    if (!isRefPack(src, at)) throw new RefPackError("not a RefPack stream");
    const flags = src[at]!;
    const width = flags & 0x80 ? 4 : 3;
    const p = at + 2 + (flags & 0x01 ? width : 0);   // skip the compressed size when present
    // A header short of its own size field yields NaN through the `!`, and NaN sizes a
    // zero-length buffer that reads as a successful empty decode.
    if (p + width > src.length) throw new RefPackError("RefPack header is truncated");
    let size = 0;
    for (let i = 0; i < width; i++) size = size * 256 + src[p + i]!;
    return size;
}

/**
 * Decode one RefPack stream.
 *
 * The command byte's top bits pick one of five forms; the first three carry a back-reference, the
 * fourth is a long literal run and the fifth both ends the stream and flushes 0-3 trailing bytes.
 * A back-reference may overlap the bytes it is still producing (run-length fills are expressed
 * that way), so the copy is byte-at-a-time on purpose — `copyWithin` would read the pre-copy
 * bytes and quietly produce a different image.
 */
export function decodeRefPack(src: Uint8Array, at = 0): Uint8Array {
    const expected = refPackSize(src, at);
    // The size is a 3- or 4-byte field in an untrusted archive and nothing cross-checks it.
    // A corrupt one asks for up to 4 GB before a single command byte is read; the ratio bound
    // is what a real RefPack stream cannot exceed, so refusing here costs nothing valid.
    const ceiling = Math.max(1 << 20, (src.length - at) * 512);
    if (expected > ceiling) {
        throw new RefPackError(`header promises ${expected} bytes from a ${src.length - at}-byte stream`);
    }
    const flags = src[at]!;
    const width = flags & 0x80 ? 4 : 3;
    let p = at + 2 + (flags & 0x01 ? width : 0) + width;

    const out = new Uint8Array(expected);
    let o = 0;
    const literal = (n: number): void => {
        if (p + n > src.length || o + n > out.length) throw new RefPackError("literal run runs past the buffer");
        out.set(src.subarray(p, p + n), o);
        p += n; o += n;
    };
    const back = (run: number, offset: number): void => {
        const from = o - offset;
        if (from < 0 || o + run > out.length) throw new RefPackError("back-reference outside the window");
        for (let i = 0; i < run; i++) out[o + i] = out[from + i]!;
        o += run;
    };

    for (;;) {
        if (p >= src.length) throw new RefPackError("stream ended without a stop command");
        const b0 = src[p++]!;
        if (b0 < 0x80) {
            const b1 = src[p++]!;
            literal(b0 & 3);
            back(((b0 & 0x1c) >> 2) + 3, ((b0 >> 5) << 8) + b1 + 1);
        } else if (b0 < 0xc0) {
            const b1 = src[p++]!, b2 = src[p++]!;
            literal((b1 >> 6) & 3);
            back((b0 & 0x3f) + 4, ((b1 & 0x3f) << 8) + b2 + 1);
        } else if (b0 < 0xe0) {
            const b1 = src[p++]!, b2 = src[p++]!, b3 = src[p++]!;
            literal(b0 & 3);
            back(((b0 & 0x0c) << 6) + b3 + 5, ((b0 & 0x10) << 12) + (b1 << 8) + b2 + 1);
        } else if (b0 < 0xfc) {
            literal(((b0 & 0x1f) << 2) + 4);
        } else {
            literal(b0 & 3);
            break;
        }
    }
    // The header's size is the only integrity check the format offers, so it is enforced: a
    // decode that stopped early otherwise hands back a zero-padded tail that parses as data.
    if (o !== expected) throw new RefPackError(`decoded ${o} bytes, header promised ${expected}`);
    return out;
}
