// Storm's hashing/encryption primitives. Every MPQ derives its table keys, file
// keys and block encryption from this one generated table.

const CRYPT_TABLE = (() => {
    const table = new Uint32Array(0x500);
    let seed = 0x00100001;
    for (let index1 = 0; index1 < 0x100; index1++) {
        for (let index2 = index1, i = 0; i < 5; i++, index2 += 0x100) {
            seed = (seed * 125 + 3) % 0x2aaaab;
            const temp1 = (seed & 0xffff) << 0x10;
            seed = (seed * 125 + 3) % 0x2aaaab;
            const temp2 = seed & 0xffff;
            table[index2] = (temp1 | temp2) >>> 0;
        }
    }
    return table;
})();

export const HASH_TABLE_OFFSET = 0;
export const HASH_NAME_A = 1;
export const HASH_NAME_B = 2;
export const HASH_FILE_KEY = 3;

/** MPQ names are case-insensitive and slash-insensitive; normalize before hashing. */
function normalizeChar(code: number): number {
    if (code === 0x2f) return 0x5c; // '/' -> '\'
    if (code >= 0x61 && code <= 0x7a) return code - 32;
    return code & 0xff;
}

export function hashString(name: string, hashType: number): number {
    let seed1 = 0x7fed7fed;
    let seed2 = 0xeeeeeeee;
    for (let i = 0; i < name.length; i++) {
        const ch = normalizeChar(name.charCodeAt(i));
        seed1 = (CRYPT_TABLE[(hashType << 8) + ch] ^ (seed1 + seed2)) >>> 0;
        seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
    }
    return seed1 >>> 0;
}

export function decryptBlock(data: Uint32Array, key: number): void {
    let seed = 0xeeeeeeee;
    let k = key >>> 0;
    for (let i = 0; i < data.length; i++) {
        seed = (seed + CRYPT_TABLE[0x400 + (k & 0xff)]) >>> 0;
        const ch = (data[i] ^ ((k + seed) >>> 0)) >>> 0;
        k = ((((~k << 0x15) >>> 0) + 0x11111111) | (k >>> 0x0b)) >>> 0;
        seed = (ch + seed + (seed << 5) + 3) >>> 0;
        data[i] = ch;
    }
}

/**
 * Recover the key a compressed file's sector-offset table was encrypted with,
 * from the table's own known plaintext (its first entry IS its byte size). An
 * archive with no (listfile) — every Blizzard installer payload — has no names
 * to hash, so this is the only way in.
 *
 * Returns the table's key; the file key is one higher.
 */
export function recoverSectorTableKey(encrypted0: number, encrypted1: number, plain0: number, compressedSize: number): number {
    // decrypt step 0 is: plain = enc ^ (key + 0xEEEEEEEE + T[0x400 + (key & 0xFF)])
    const target = ((encrypted0 ^ plain0) >>> 0);
    for (let low = 0; low < 0x100; low++) {
        const key = ((target - 0xeeeeeeee - CRYPT_TABLE[0x400 + low]) >>> 0);
        if ((key & 0xff) !== low) continue;
        // Confirm against the second entry: sector 1 must start after the table
        // and inside the block.
        const probe = new Uint32Array([encrypted0, encrypted1]);
        decryptBlock(probe, key);
        if (probe[0] === plain0 && probe[1] > plain0 && probe[1] <= compressedSize) return key;
    }
    return -1;
}

/**
 * A file's key is the hash of its BASE name; MPQ_FILE_FIX_KEY additionally folds
 * in where the block landed, so the same file at a different offset decrypts
 * differently.
 */
export function fileKey(name: string, blockOffset: number, fileSize: number, fixKey: boolean): number {
    const slash = Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/"));
    const base = slash >= 0 ? name.slice(slash + 1) : name;
    let key = hashString(base, HASH_FILE_KEY);
    if (fixKey) key = (((key + blockOffset) >>> 0) ^ fileSize) >>> 0;
    return key >>> 0;
}
