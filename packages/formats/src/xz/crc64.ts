/**
 * CRC-64/XZ (ECMA-182 polynomial, reflected) — the default integrity check in an `.xz` stream.
 *
 * Kept as two 32-bit halves rather than BigInt: this runs over every decompressed byte of a
 * multi-GB archive, and a BigInt per byte would cost more than the LZMA2 decode itself.
 */

const POLY_LO = 0xd7870f42; // reflected 0x42F0E1EBA9EA3693, low half
const POLY_HI = 0xc96c5795;

const TABLE_LO = new Uint32Array(256);
const TABLE_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let lo = i;
    let hi = 0;
    for (let bit = 0; bit < 8; bit++) {
        const carry = lo & 1;
        lo = ((lo >>> 1) | (hi << 31)) >>> 0;
        hi = hi >>> 1;
        if (carry) {
            lo = (lo ^ POLY_LO) >>> 0;
            hi = (hi ^ POLY_HI) >>> 0;
        }
    }
    TABLE_LO[i] = lo;
    TABLE_HI[i] = hi;
}

export class Crc64 {
    private lo = 0xffffffff;
    private hi = 0xffffffff;

    update(data: Uint8Array, start = 0, end = data.byteLength): void {
        let { lo, hi } = this;
        for (let i = start; i < end; i++) {
            const idx = (lo ^ data[i]!) & 0xff;
            lo = (((lo >>> 8) | (hi << 24)) ^ TABLE_LO[idx]!) >>> 0;
            hi = ((hi >>> 8) ^ TABLE_HI[idx]!) >>> 0;
        }
        this.lo = lo;
        this.hi = hi;
    }

    /** Digest as 8 little-endian bytes — the layout of the check field itself. */
    digestBytes(): Uint8Array {
        const lo = (this.lo ^ 0xffffffff) >>> 0;
        const hi = (this.hi ^ 0xffffffff) >>> 0;
        const out = new Uint8Array(8);
        const view = new DataView(out.buffer);
        view.setUint32(0, lo, true);
        view.setUint32(4, hi, true);
        return out;
    }

    hex(): string {
        const b = this.digestBytes();
        let s = "";
        for (let i = 7; i >= 0; i--) s += b[i]!.toString(16).padStart(2, "0");
        return s;
    }
}
