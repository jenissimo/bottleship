const MIN_WORD = -32768;
const MAX_WORD = 32767;

const QLB = [3277, 11469, 21299, 32767];
const FAC = [18431, 20479, 22527, 24575, 26623, 28671, 30719, 32767];
const LAR_B = [0, 0, 2048, -2560, 94, -1792, -341, -1144];
const LAR_MIC = [-32, -32, -16, -16, -8, -8, -4, -4];
const LAR_INVA = [13107, 13107, 13107, 13107, 19223, 17476, 31454, 29708];
const LAR_BITS = [6, 6, 5, 5, 4, 4, 3, 3];

export const GSM610_SAMPLES_PER_FRAME = 160;
export const GSM610_WAV49_BLOCK_BYTES = 65;
export const GSM610_WAV49_SAMPLES_PER_BLOCK = 320;

const w16 = (x: number): number => (x << 16) >> 16;
const sat = (x: number): number => (x < MIN_WORD ? MIN_WORD : x > MAX_WORD ? MAX_WORD : x);
const add = (a: number, b: number): number => sat(a + b);
const sub = (a: number, b: number): number => sat(a - b);
const multR = (a: number, b: number): number => w16((a * b + 16384) >> 15);

function asr(a: number, n: number): number {
    if (n >= 16) return a < 0 ? -1 : 0;
    if (n <= -16) return 0;
    if (n < 0) return w16(a << -n);
    return a >> n;
}

function asl(a: number, n: number): number {
    if (n >= 16) return 0;
    if (n <= -16) return a < 0 ? -1 : 0;
    if (n < 0) return asr(a, -n);
    return w16(a << n);
}

interface Gsm610Frame {
    larc: Int16Array;
    nc: Int16Array;
    bc: Int16Array;
    mc: Int16Array;
    xmaxc: Int16Array;
    xmc: Int16Array;
}

class LsbBitReader {
    private bit = 0;
    constructor(private readonly bytes: Uint8Array, private readonly base: number) {}
    read(n: number): number {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const pos = this.bit++;
            const byte = this.bytes[this.base + (pos >> 3)] ?? 0;
            v |= ((byte >> (pos & 7)) & 1) << i;
        }
        return v;
    }
}

function readFrame(r: LsbBitReader, f: Gsm610Frame): void {
    for (let i = 0; i < 8; i++) f.larc[i] = r.read(LAR_BITS[i]!);
    for (let j = 0; j < 4; j++) {
        f.nc[j] = r.read(7);
        f.bc[j] = r.read(2);
        f.mc[j] = r.read(2);
        f.xmaxc[j] = r.read(6);
        for (let i = 0; i < 13; i++) f.xmc[j * 13 + i] = r.read(3);
    }
}

export class Gsm610Decoder {
    private readonly dp0 = new Int16Array(280);
    private readonly larpp = [new Int16Array(8), new Int16Array(8)];
    private j = 0;
    private nrp = 40;
    private readonly v = new Int16Array(9);
    private msr = 0;
    private readonly frame: Gsm610Frame = {
        larc: new Int16Array(8), nc: new Int16Array(4), bc: new Int16Array(4),
        mc: new Int16Array(4), xmaxc: new Int16Array(4), xmc: new Int16Array(52),
    };
    private readonly erp = new Int16Array(40);
    private readonly wt = new Int16Array(160);
    private readonly larp = new Int16Array(8);
    private readonly s = new Int16Array(160);

    decodeWav49Block(bytes: Uint8Array, offset: number, out: Float32Array, outOffset: number): void {
        const r = new LsbBitReader(bytes, offset);
        for (let half = 0; half < 2; half++) {
            readFrame(r, this.frame);
            this.decodeFrame();
            const base = outOffset + half * GSM610_SAMPLES_PER_FRAME;
            for (let k = 0; k < GSM610_SAMPLES_PER_FRAME; k++) out[base + k] = this.s[k]! / 32768;
        }
    }

    private decodeFrame(): void {
        const f = this.frame;
        for (let j = 0; j < 4; j++) {
            this.rpeDecoding(f.xmaxc[j]!, f.mc[j]!, f.xmc, j * 13);
            this.longTermSynthesis(f.nc[j]!, f.bc[j]!);
            for (let k = 0; k < 40; k++) this.wt[j * 40 + k] = this.dp0[120 + k]!;
        }
        this.shortTermSynthesis(f.larc);
        let msr = this.msr;
        for (let k = 0; k < 160; k++) {
            msr = add(this.s[k]!, multR(msr, 28180));
            this.s[k] = w16(add(msr, msr) & 0xfff8);
        }
        this.msr = msr;
    }

    private rpeDecoding(xmaxc: number, mc: number, xmc: Int16Array, at: number): void {
        let exp = 0;
        if (xmaxc > 15) exp = (xmaxc >> 3) - 1;
        let mant = xmaxc - (exp << 3);
        if (mant === 0) {
            exp = -4;
            mant = 7;
        } else {
            while (mant <= 7) {
                mant = (mant << 1) | 1;
                exp--;
            }
            mant -= 8;
        }
        const temp1 = FAC[mant]!;
        const temp2 = sub(6, exp);
        const temp3 = asl(1, sub(temp2, 1));
        this.erp.fill(0);
        for (let i = 0; i < 13; i++) {
            let temp = w16(((xmc[at + i]! << 1) - 7) << 12);
            temp = multR(temp1, temp);
            temp = add(temp, temp3);
            this.erp[mc + 3 * i] = asr(temp, temp2);
        }
    }

    private longTermSynthesis(ncr: number, bcr: number): void {
        const nr = ncr < 40 || ncr > 120 ? this.nrp : ncr;
        this.nrp = nr;
        const brp = QLB[bcr]!;
        const dp = this.dp0;
        for (let k = 0; k < 40; k++) {
            dp[120 + k] = add(this.erp[k]!, multR(brp, dp[120 + k - nr]!));
        }
        for (let k = 0; k < 120; k++) dp[k] = dp[40 + k]!;
    }

    private shortTermSynthesis(larc: Int16Array): void {
        const cur = this.larpp[this.j]!;
        this.j ^= 1;
        const prev = this.larpp[this.j]!;
        for (let i = 0; i < 8; i++) {
            let t = w16(add(larc[i]!, LAR_MIC[i]!) << 10);
            t = sub(t, LAR_B[i]! << 1);
            t = multR(LAR_INVA[i]!, t);
            cur[i] = add(t, t);
        }
        const p = this.larp;
        for (let i = 0; i < 8; i++) p[i] = add(add(prev[i]! >> 2, cur[i]! >> 2), prev[i]! >> 1);
        this.filter(13, 0);
        for (let i = 0; i < 8; i++) p[i] = add(prev[i]! >> 1, cur[i]! >> 1);
        this.filter(14, 13);
        for (let i = 0; i < 8; i++) p[i] = add(add(prev[i]! >> 2, cur[i]! >> 2), cur[i]! >> 1);
        this.filter(13, 27);
        for (let i = 0; i < 8; i++) p[i] = cur[i]!;
        this.filter(120, 40);
    }

    private filter(count: number, at: number): void {
        const rp = this.larp;
        for (let i = 0; i < 8; i++) {
            const lar = rp[i]!;
            const temp = lar < 0 ? (lar === MIN_WORD ? MAX_WORD : -lar) : lar;
            const mag = temp < 11059 ? temp << 1 : temp < 20070 ? temp + 11059 : add(temp >> 2, 26112);
            rp[i] = lar < 0 ? -mag : mag;
        }
        const v = this.v;
        for (let k = 0; k < count; k++) {
            let sri = this.wt[at + k]!;
            for (let i = 7; i >= 0; i--) {
                const r = rp[i]!;
                const t2 = r === MIN_WORD && v[i] === MIN_WORD ? MAX_WORD : w16(((r * v[i]! + 16384) >> 15) & 0xffff);
                sri = sub(sri, t2);
                const t1 = r === MIN_WORD && sri === MIN_WORD ? MAX_WORD : w16(((r * sri + 16384) >> 15) & 0xffff);
                v[i + 1] = add(v[i]!, t1);
            }
            v[0] = sri;
            this.s[at + k] = sri;
        }
    }
}
