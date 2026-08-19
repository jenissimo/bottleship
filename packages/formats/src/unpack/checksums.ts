/**
 * CRC32 — ported from innoextract crypto/crc32.cpp (init 0xFFFFFFFF, finalize ^0xFFFFFFFF).
 */

// crypto/crc32.cpp:32-85 — IEEE CRC32 lookup table
const CRC32_TABLE = new Uint32Array([
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
    0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
    0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
    0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172, 0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
    0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
    0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
    0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
    0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
    0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
    0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0, 0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
    0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
    0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
    0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
    0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
    0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60, 0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
    0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
    0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
    0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
    0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
    0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
    0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
    0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94, 0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
]);

/** crypto/crc32.hpp:46 — initial CRC value */
const CRC32_NEGL = 0xffffffff;

export class Crc32 {
    private crc = CRC32_NEGL;

    /** crypto/crc32.hpp:38 */
    init(): void {
        this.crc = CRC32_NEGL;
    }

    /** crypto/crc32.cpp:95-114 — byte-at-a-time (matches Crypto++ reference) */
    update(data: Uint8Array, start = 0, end = data.byteLength): void {
        let crc = this.crc >>> 0;
        for (let i = start; i < end; i++) {
            crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
        }
        this.crc = crc >>> 0;
    }

    /** crypto/crc32.hpp:42 */
    finalize(): number {
        return (this.crc ^ CRC32_NEGL) >>> 0;
    }

    /** Return digest as 4-byte LE (matches Inno checksum field layout). */
    digestBytes(): Uint8Array {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, this.finalize(), true);
        return out;
    }
}

const MD5_K = new Uint32Array(64);
const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
for (let i = 0; i < 64; i++) {
    MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

/** crypto/md5.cpp — incremental MD5 (RFC 1321). */
export class Md5 {
    private state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    private buffer = new Uint8Array(64);
    /** Per-block message schedule, reused: transform overwrites all 16 words. */
    private readonly m = new Uint32Array(16);
    private bufLen = 0;
    private totalLen = 0;

    update(data: Uint8Array, start = 0, end = data.byteLength): void {
        this.totalLen += end - start;
        let i = start;
        if (this.bufLen > 0) {
            const take = Math.min(64 - this.bufLen, end - i);
            this.buffer.set(data.subarray(i, i + take), this.bufLen);
            this.bufLen += take;
            i += take;
            if (this.bufLen === 64) {
                this.transform(this.buffer, 0);
                this.bufLen = 0;
            }
        }
        while (i + 64 <= end) {
            this.transform(data, i);
            i += 64;
        }
        if (i < end) {
            this.buffer.set(data.subarray(i, end), 0);
            this.bufLen = end - i;
        }
    }

    finalize(): Uint8Array {
        const pad = new Uint8Array(64);
        pad[0] = 0x80;
        const bitLen = this.totalLen * 8;
        const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
        this.update(pad, 0, padLen);
        const lenBuf = new Uint8Array(8);
        new DataView(lenBuf.buffer).setUint32(0, bitLen >>> 0, true);
        new DataView(lenBuf.buffer).setUint32(4, Math.floor(bitLen / 0x100000000), true);
        this.update(lenBuf);
        const out = new Uint8Array(16);
        const dv = new DataView(out.buffer);
        for (let i = 0; i < 4; i++) dv.setUint32(i * 4, this.state[i]!, true);
        return out;
    }

    /** `off` is the block start inside `block` — a subarray per block would allocate too. */
    private transform(block: Uint8Array, off: number): void {
        const m = this.m;
        for (let i = 0; i < 16; i++) {
            const o = off + i * 4;
            m[i] = (block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24)) >>> 0;
        }

        let a = this.state[0]!;
        let b = this.state[1]!;
        let c = this.state[2]!;
        let d = this.state[3]!;
        const rot = (v: number, s: number) => ((v << s) | (v >>> (32 - s))) >>> 0;

        for (let i = 0; i < 16; i++) {
            const f = (b & c) | (~b & d);
            const g = i;
            const t = (a + f + m[g]! + MD5_K[i]!) >>> 0;
            a = d; d = c; c = b;
            b = (b + rot(t, MD5_S[i]!)) >>> 0;
        }
        for (let i = 16; i < 32; i++) {
            const f = (d & b) | (~d & c);
            const g = (5 * (i - 16) + 1) % 16;
            const t = (a + f + m[g]! + MD5_K[i]!) >>> 0;
            a = d; d = c; c = b;
            b = (b + rot(t, MD5_S[i]!)) >>> 0;
        }
        for (let i = 32; i < 48; i++) {
            const f = b ^ c ^ d;
            const g = (3 * (i - 32) + 5) % 16;
            const t = (a + f + m[g]! + MD5_K[i]!) >>> 0;
            a = d; d = c; c = b;
            b = (b + rot(t, MD5_S[i]!)) >>> 0;
        }
        for (let i = 48; i < 64; i++) {
            const f = c ^ (b | ~d);
            const g = (7 * (i - 48)) % 16;
            const t = (a + f + m[g]! + MD5_K[i]!) >>> 0;
            a = d; d = c; c = b;
            b = (b + rot(t, MD5_S[i]!)) >>> 0;
        }

        this.state[0] = (this.state[0]! + a) >>> 0;
        this.state[1] = (this.state[1]! + b) >>> 0;
        this.state[2] = (this.state[2]! + c) >>> 0;
        this.state[3] = (this.state[3]! + d) >>> 0;
    }
}

/** crypto/sha1.cpp — incremental SHA-1 (FIPS 180-1). */
export class Sha1 {
    private h0 = 0x67452301;
    private h1 = 0xefcdab89;
    private h2 = 0x98badcfe;
    private h3 = 0x10325476;
    private h4 = 0xc3d2e1f0;
    private buffer = new Uint8Array(64);
    /** Per-block message schedule, reused: transform overwrites all 80 words. */
    private readonly w = new Uint32Array(80);
    private bufLen = 0;
    private totalLen = 0;

    update(data: Uint8Array, start = 0, end = data.byteLength): void {
        this.totalLen += end - start;
        let i = start;
        if (this.bufLen > 0) {
            const take = Math.min(64 - this.bufLen, end - i);
            this.buffer.set(data.subarray(i, i + take), this.bufLen);
            this.bufLen += take;
            i += take;
            if (this.bufLen === 64) {
                this.transform(this.buffer, 0);
                this.bufLen = 0;
            }
        }
        while (i + 64 <= end) {
            this.transform(data, i);
            i += 64;
        }
        if (i < end) {
            this.buffer.set(data.subarray(i, end), 0);
            this.bufLen = end - i;
        }
    }

    finalize(): Uint8Array {
        const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
        const pad = new Uint8Array(padLen + 8);
        pad[0] = 0x80;
        const bitLen = this.totalLen * 8;
        const lenView = new DataView(pad.buffer, padLen, 8);
        lenView.setUint32(0, Math.floor(bitLen / 0x100000000), false);
        lenView.setUint32(4, bitLen >>> 0, false);
        this.update(pad);
        const out = new Uint8Array(20);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, this.h0, false);
        dv.setUint32(4, this.h1, false);
        dv.setUint32(8, this.h2, false);
        dv.setUint32(12, this.h3, false);
        dv.setUint32(16, this.h4, false);
        return out;
    }

    /** `off` is the block start inside `block` — a subarray per block would allocate too. */
    private transform(block: Uint8Array, off: number): void {
        const w = this.w;
        for (let i = 0; i < 16; i++) {
            const o = off + i * 4;
            w[i] = ((block[o]! << 24) | (block[o + 1]! << 16) | (block[o + 2]! << 8) | block[o + 3]!) >>> 0;
        }
        for (let i = 16; i < 80; i++) {
            w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
        }
        let a = this.h0, bb = this.h1, c = this.h2, d = this.h3, e = this.h4;
        for (let i = 0; i < 80; i++) {
            let f: number, k: number;
            if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
            else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
            else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = bb ^ c ^ d; k = 0xca62c1d6; }
            const temp = (rotl(a, 5) + f + e + w[i]! + k) >>> 0;
            e = d; d = c; c = rotl(bb, 30); bb = a; a = temp;
        }
        this.h0 = (this.h0 + a) >>> 0;
        this.h1 = (this.h1 + bb) >>> 0;
        this.h2 = (this.h2 + c) >>> 0;
        this.h3 = (this.h3 + d) >>> 0;
        this.h4 = (this.h4 + e) >>> 0;
    }
}

function rotl(v: number, s: number): number {
    return ((v << s) | (v >>> (32 - s))) >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Create an incremental hasher matching a DataEntry checksum type. */
export function createChecksumHasher(type: string): {
    update(data: Uint8Array, start?: number, end?: number): void;
    digest(): Uint8Array;
} {
    switch (type) {
        case "crc32": {
            const h = new Crc32();
            h.init();
            return { update: (d, s, e) => h.update(d, s, e), digest: () => h.digestBytes() };
        }
        case "md5": {
            const h = new Md5();
            return { update: (d, s, e) => h.update(d, s, e), digest: () => h.finalize() };
        }
        case "sha1": {
            const h = new Sha1();
            return { update: (d, s, e) => h.update(d, s, e), digest: () => h.finalize() };
        }
        default:
            throw new Error(`Unsupported checksum type: ${type}`);
    }
}

export function verifyChecksum(computed: Uint8Array, expected: Uint8Array, type: string): boolean {
    if (type === "crc32" && expected.byteLength >= 4) {
        const dv = new DataView(expected.buffer, expected.byteOffset, 4);
        const exp = dv.getUint32(0, true);
        const got = new DataView(computed.buffer, computed.byteOffset, 4).getUint32(0, true);
        return exp === got;
    }
    return bytesEqual(computed, expected.subarray(0, computed.byteLength));
}
