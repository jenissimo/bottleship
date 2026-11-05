// @transient(constant table)
const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function compress(state: Int32Array, w: Int32Array, view: DataView, at: number): void {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(at + t * 4, false);
    for (let t = 16; t < 64; t++) {
        const a = w[t - 15]!, b = w[t - 2]!;
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
    let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;
    for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    state[0] = state[0]! + a; state[1] = state[1]! + b; state[2] = state[2]! + c; state[3] = state[3]! + d;
    state[4] = state[4]! + e; state[5] = state[5]! + f; state[6] = state[6]! + g; state[7] = state[7]! + h;
}

export function sha256HexSync(bytes: Uint8Array): string {
    const state = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Int32Array(64);
    const full = bytes.length - (bytes.length % 64);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < full; at += 64) compress(state, w, view, at);
    const rest = bytes.length - full;
    const tail = new Uint8Array(rest < 56 ? 64 : 128);
    tail.set(bytes.subarray(full));
    tail[rest] = 0x80;
    const bits = bytes.length * 8;
    const v = new DataView(tail.buffer);
    v.setUint32(tail.length - 8, Math.floor(bits / 0x100000000), false);
    v.setUint32(tail.length - 4, bits >>> 0, false);
    for (let at = 0; at < tail.length; at += 64) compress(state, w, v, at);
    let out = '';
    for (let i = 0; i < 8; i++) out += (state[i]! >>> 0).toString(16).padStart(8, '0');
    return out;
}
