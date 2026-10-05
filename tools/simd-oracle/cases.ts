// SIMD conformance cases: one entry per instruction FORM (register/memory/immediate variant).
//
// Every encoding here must mean the same thing in 32-bit protected mode (the guest v86 runs)
// and in 64-bit long mode (the host CPU the native arm runs on). That holds for the MMX/SSE
// register forms with registers 0-7 and no REX, and for `[esi]`, which long mode reads as
// `[rsi]` — the runner points both at the same bytes. Anything else is excluded rather than
// approximated.
//
// Operand convention: destination = reg field (mm0/xmm0/eax), source = rm field (mm1/xmm1,
// `[esi]`, or edi for a GPR source).

export type Lanes = "i" | "f32" | "f64";
export interface Case {
    name: string;
    bytes: number[];
    lanes: Lanes;
}

const RR = 0xc1;   // mod=11 reg=0 rm=1
const SAME = 0xc0; // mod=11 reg=0 rm=0
const MEM = 0x06;  // mod=00 reg=0 rm=110 ([esi])
const GPR_SRC = 0xc7; // mod=11 reg=0 rm=7 (edi)

function forms(prefix: number[], op: number, lanes: Lanes, name: string, imm?: number, noMem = false): Case[] {
    const t = (modrm: number, suffix: string): Case => ({
        name: `${name} ${suffix}${imm === undefined ? "" : ` ,${imm}`}`,
        bytes: [...prefix, 0x0f, op, modrm, ...(imm === undefined ? [] : [imm])],
        lanes,
    });
    const out = [t(RR, "r,r"), t(SAME, "r,same")];
    if (!noMem) out.push(t(MEM, "r,[esi]"));
    return out;
}

const MMX_BINARY: Array<[number, string]> = [
    [0x60, "punpcklbw"], [0x61, "punpcklwd"], [0x62, "punpckldq"], [0x63, "packsswb"],
    [0x64, "pcmpgtb"], [0x65, "pcmpgtw"], [0x66, "pcmpgtd"], [0x67, "packuswb"],
    [0x68, "punpckhbw"], [0x69, "punpckhwd"], [0x6a, "punpckhdq"], [0x6b, "packssdw"],
    [0x6f, "movq"], [0x74, "pcmpeqb"], [0x75, "pcmpeqw"], [0x76, "pcmpeqd"],
    [0xd1, "psrlw"], [0xd2, "psrld"], [0xd3, "psrlq"], [0xd4, "paddq"], [0xd5, "pmullw"],
    [0xd8, "psubusb"], [0xd9, "psubusw"], [0xda, "pminub"], [0xdb, "pand"], [0xdc, "paddusb"],
    [0xdd, "paddusw"], [0xde, "pmaxub"], [0xdf, "pandn"], [0xe0, "pavgb"], [0xe1, "psraw"],
    [0xe2, "psrad"], [0xe3, "pavgw"], [0xe4, "pmulhuw"], [0xe5, "pmulhw"], [0xe8, "psubsb"],
    [0xe9, "psubsw"], [0xea, "pminsw"], [0xeb, "por"], [0xec, "paddsb"], [0xed, "paddsw"],
    [0xee, "pmaxsw"], [0xef, "pxor"], [0xf1, "psllw"], [0xf2, "pslld"], [0xf3, "psllq"],
    [0xf4, "pmuludq"], [0xf5, "pmaddwd"], [0xf6, "psadbw"], [0xf8, "psubb"], [0xf9, "psubw"],
    [0xfa, "psubd"], [0xfb, "psubq"], [0xfc, "paddb"], [0xfd, "paddw"], [0xfe, "paddd"],
];
const SSE2_ONLY: Array<[number, string]> = [[0x6c, "punpcklqdq"], [0x6d, "punpckhqdq"]];
const SHIFT_COUNTS = [0, 1, 3, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 127, 255];
const SHUF_IMMS = [0x00, 0x1b, 0x39, 0x4e, 0xe4, 0xff];

export function buildCases(): Case[] {
    const cs: Case[] = [];
    // ── MMX (and the matching SSE2 integer forms on xmm) ───────────────────────────
    for (const [op, n] of MMX_BINARY) {
        cs.push(...forms([], op, "i", n));
        cs.push(...forms([0x66], op, "i", n + " xmm"));
    }
    for (const [op, n] of SSE2_ONLY) cs.push(...forms([0x66], op, "i", n + " xmm"));
    const shiftImm: Array<[number, number, string]> = [
        [0x71, 2, "psrlw"], [0x71, 4, "psraw"], [0x71, 6, "psllw"],
        [0x72, 2, "psrld"], [0x72, 4, "psrad"], [0x72, 6, "pslld"],
        [0x73, 2, "psrlq"], [0x73, 6, "psllq"],
    ];
    for (const [op, sub, n] of shiftImm) {
        for (const k of SHIFT_COUNTS) {
            cs.push({ name: `${n} imm,${k}`, bytes: [0x0f, op, 0xc0 | (sub << 3), k], lanes: "i" });
            cs.push({ name: `${n} xmm imm,${k}`, bytes: [0x66, 0x0f, op, 0xc0 | (sub << 3), k], lanes: "i" });
        }
    }
    for (const k of SHIFT_COUNTS) {
        cs.push({ name: `psrldq imm,${k}`, bytes: [0x66, 0x0f, 0x73, 0xd8, k], lanes: "i" });
        cs.push({ name: `pslldq imm,${k}`, bytes: [0x66, 0x0f, 0x73, 0xf8, k], lanes: "i" });
    }
    for (const imm of SHUF_IMMS) {
        cs.push(...forms([], 0x70, "i", "pshufw", imm));
        cs.push(...forms([0x66], 0x70, "i", "pshufd", imm));
        cs.push(...forms([0xf2], 0x70, "i", "pshuflw", imm));
        cs.push(...forms([0xf3], 0x70, "i", "pshufhw", imm));
    }
    for (const imm of [0, 1, 2, 3, 7, 0xff]) {
        cs.push({ name: `pinsrw r32,${imm}`, bytes: [0x0f, 0xc4, GPR_SRC, imm], lanes: "i" });
        cs.push({ name: `pinsrw [esi],${imm}`, bytes: [0x0f, 0xc4, MEM, imm], lanes: "i" });
        cs.push({ name: `pinsrw xmm r32,${imm}`, bytes: [0x66, 0x0f, 0xc4, GPR_SRC, imm], lanes: "i" });
        cs.push({ name: `pextrw ,${imm}`, bytes: [0x0f, 0xc5, RR, imm], lanes: "i" });
        cs.push({ name: `pextrw xmm,${imm}`, bytes: [0x66, 0x0f, 0xc5, RR, imm], lanes: "i" });
    }
    cs.push({ name: "pmovmskb", bytes: [0x0f, 0xd7, RR], lanes: "i" });
    cs.push({ name: "pmovmskb xmm", bytes: [0x66, 0x0f, 0xd7, RR], lanes: "i" });
    cs.push({ name: "movd mm,r32", bytes: [0x0f, 0x6e, GPR_SRC], lanes: "i" });
    cs.push({ name: "movd mm,[esi]", bytes: [0x0f, 0x6e, MEM], lanes: "i" });
    cs.push({ name: "movd r32,mm", bytes: [0x0f, 0x7e, SAME], lanes: "i" });
    cs.push({ name: "movd [esi],mm", bytes: [0x0f, 0x7e, MEM], lanes: "i" });
    cs.push({ name: "movq mm1,mm0", bytes: [0x0f, 0x7f, RR], lanes: "i" });
    cs.push({ name: "movq [esi],mm", bytes: [0x0f, 0x7f, MEM], lanes: "i" });
    cs.push({ name: "movntq [esi],mm", bytes: [0x0f, 0xe7, MEM], lanes: "i" });
    cs.push({ name: "movd xmm,r32", bytes: [0x66, 0x0f, 0x6e, GPR_SRC], lanes: "i" });
    cs.push({ name: "movd xmm,[esi]", bytes: [0x66, 0x0f, 0x6e, MEM], lanes: "i" });
    cs.push({ name: "movd r32,xmm", bytes: [0x66, 0x0f, 0x7e, SAME], lanes: "i" });
    cs.push({ name: "movd [esi],xmm", bytes: [0x66, 0x0f, 0x7e, MEM], lanes: "i" });
    cs.push(...forms([0xf3], 0x7e, "i", "movq xmm,xmm/m64"));
    cs.push({ name: "movq xmm1,xmm0 (d6)", bytes: [0x66, 0x0f, 0xd6, RR], lanes: "i" });
    cs.push({ name: "movq [esi],xmm (d6)", bytes: [0x66, 0x0f, 0xd6, MEM], lanes: "i" });
    cs.push(...forms([0x66], 0x6f, "i", "movdqa"));
    cs.push(...forms([0xf3], 0x6f, "i", "movdqu"));
    cs.push({ name: "movdqa [esi],xmm", bytes: [0x66, 0x0f, 0x7f, MEM], lanes: "i" });
    cs.push({ name: "movdqu [esi],xmm", bytes: [0xf3, 0x0f, 0x7f, MEM], lanes: "i" });
    cs.push({ name: "movntdq [esi],xmm", bytes: [0x66, 0x0f, 0xe7, MEM], lanes: "i" });
    cs.push({ name: "movq2dq", bytes: [0xf3, 0x0f, 0xd6, RR], lanes: "i" });
    cs.push({ name: "movdq2q", bytes: [0xf2, 0x0f, 0xd6, RR], lanes: "i" });
    cs.push({ name: "popcnt", bytes: [0xf3, 0x0f, 0xb8, GPR_SRC], lanes: "i" });

    // ── SSE / SSE2 / SSE3 floating point ──────────────────────────────────────────
    const fp: Array<[number, string, boolean?]> = [
        [0x51, "sqrt"], [0x54, "and"], [0x55, "andn"], [0x56, "or"], [0x57, "xor"], [0x58, "add"],
        [0x59, "mul"], [0x5c, "sub"], [0x5d, "min"], [0x5e, "div"], [0x5f, "max"],
    ];
    for (const [op, n] of fp) {
        cs.push(...forms([], op, "f32", n + "ps"));
        cs.push(...forms([0x66], op, "f64", n + "pd"));
        if (op !== 0x54 && op !== 0x55 && op !== 0x56 && op !== 0x57) {
            cs.push(...forms([0xf3], op, "f32", n + "ss"));
            cs.push(...forms([0xf2], op, "f64", n + "sd"));
        }
    }
    cs.push(...forms([], 0x52, "f32", "rsqrtps"), ...forms([0xf3], 0x52, "f32", "rsqrtss"));
    cs.push(...forms([], 0x53, "f32", "rcpps"), ...forms([0xf3], 0x53, "f32", "rcpss"));
    for (const imm of [0, 1, 2, 3, 4, 5, 6, 7]) {
        cs.push(...forms([], 0xc2, "f32", "cmpps", imm), ...forms([0xf3], 0xc2, "f32", "cmpss", imm));
        cs.push(...forms([0x66], 0xc2, "f64", "cmppd", imm), ...forms([0xf2], 0xc2, "f64", "cmpsd", imm));
    }
    for (const imm of SHUF_IMMS) {
        cs.push(...forms([], 0xc6, "f32", "shufps", imm));
        cs.push(...forms([0x66], 0xc6, "f64", "shufpd", imm & 3));
    }
    const moves: Array<[number[], number, Lanes, string, boolean?]> = [
        [[], 0x10, "f32", "movups"], [[0xf3], 0x10, "f32", "movss"], [[0x66], 0x10, "f64", "movupd"],
        [[0xf2], 0x10, "f64", "movsd"], [[], 0x28, "f32", "movaps"], [[0x66], 0x28, "f64", "movapd"],
        [[], 0x14, "f32", "unpcklps"], [[], 0x15, "f32", "unpckhps"], [[0x66], 0x14, "f64", "unpcklpd"],
        [[0x66], 0x15, "f64", "unpckhpd"],
    ];
    for (const [p, op, l, n] of moves) cs.push(...forms(p, op, l, n));
    cs.push({ name: "movups [esi],xmm", bytes: [0x0f, 0x11, MEM], lanes: "f32" });
    cs.push({ name: "movss [esi],xmm", bytes: [0xf3, 0x0f, 0x11, MEM], lanes: "f32" });
    cs.push({ name: "movss xmm1,xmm0 (11)", bytes: [0xf3, 0x0f, 0x11, RR], lanes: "f32" });
    cs.push({ name: "movsd [esi],xmm", bytes: [0xf2, 0x0f, 0x11, MEM], lanes: "f64" });
    cs.push({ name: "movaps [esi],xmm", bytes: [0x0f, 0x29, MEM], lanes: "f32" });
    cs.push({ name: "movlps xmm,[esi]", bytes: [0x0f, 0x12, MEM], lanes: "f32" });
    cs.push({ name: "movhlps", bytes: [0x0f, 0x12, RR], lanes: "f32" });
    cs.push({ name: "movlps [esi],xmm", bytes: [0x0f, 0x13, MEM], lanes: "f32" });
    cs.push({ name: "movhps xmm,[esi]", bytes: [0x0f, 0x16, MEM], lanes: "f32" });
    cs.push({ name: "movlhps", bytes: [0x0f, 0x16, RR], lanes: "f32" });
    cs.push({ name: "movhps [esi],xmm", bytes: [0x0f, 0x17, MEM], lanes: "f32" });
    cs.push({ name: "movlpd xmm,[esi]", bytes: [0x66, 0x0f, 0x12, MEM], lanes: "f64" });
    cs.push({ name: "movhpd xmm,[esi]", bytes: [0x66, 0x0f, 0x16, MEM], lanes: "f64" });
    cs.push({ name: "movmskps", bytes: [0x0f, 0x50, RR], lanes: "f32" });
    cs.push({ name: "movmskpd", bytes: [0x66, 0x0f, 0x50, RR], lanes: "f64" });
    // conversions
    const cvt: Array<[number[], number, Lanes, string]> = [
        [[], 0x5a, "f32", "cvtps2pd"], [[0x66], 0x5a, "f64", "cvtpd2ps"], [[0xf3], 0x5a, "f32", "cvtss2sd"],
        [[0xf2], 0x5a, "f64", "cvtsd2ss"], [[], 0x5b, "i", "cvtdq2ps"], [[0x66], 0x5b, "f32", "cvtps2dq"],
        [[0xf3], 0x5b, "f32", "cvttps2dq"], [[0xf3], 0xe6, "i", "cvtdq2pd"], [[0x66], 0xe6, "f64", "cvttpd2dq"],
        [[0xf2], 0xe6, "f64", "cvtpd2dq"], [[], 0x2a, "i", "cvtpi2ps"], [[0x66], 0x2a, "i", "cvtpi2pd"],
        [[], 0x2c, "f32", "cvttps2pi"], [[], 0x2d, "f32", "cvtps2pi"], [[0x66], 0x2c, "f64", "cvttpd2pi"],
        [[0x66], 0x2d, "f64", "cvtpd2pi"],
    ];
    for (const [p, op, l, n] of cvt) cs.push(...forms(p, op, l, n));
    cs.push({ name: "cvtsi2ss r32", bytes: [0xf3, 0x0f, 0x2a, GPR_SRC], lanes: "i" });
    cs.push({ name: "cvtsi2sd r32", bytes: [0xf2, 0x0f, 0x2a, GPR_SRC], lanes: "i" });
    cs.push({ name: "cvtss2si", bytes: [0xf3, 0x0f, 0x2d, RR], lanes: "f32" });
    cs.push({ name: "cvttss2si", bytes: [0xf3, 0x0f, 0x2c, RR], lanes: "f32" });
    cs.push({ name: "cvtsd2si", bytes: [0xf2, 0x0f, 0x2d, RR], lanes: "f64" });
    cs.push({ name: "cvttsd2si", bytes: [0xf2, 0x0f, 0x2c, RR], lanes: "f64" });
    cs.push({ name: "cvtss2si [esi]", bytes: [0xf3, 0x0f, 0x2d, MEM], lanes: "f32" });
    // flag-setting compares (flags captured through lahf)
    cs.push(...forms([], 0x2e, "f32", "ucomiss"), ...forms([], 0x2f, "f32", "comiss"));
    cs.push(...forms([0x66], 0x2e, "f64", "ucomisd"), ...forms([0x66], 0x2f, "f64", "comisd"));
    // SSE3 (CPUID advertises it)
    cs.push(...forms([0xf2], 0x7c, "f32", "haddps"), ...forms([0x66], 0x7c, "f64", "haddpd"));
    cs.push(...forms([0xf2], 0x7d, "f32", "hsubps"), ...forms([0x66], 0x7d, "f64", "hsubpd"));
    cs.push(...forms([0xf2], 0xd0, "f32", "addsubps"), ...forms([0x66], 0xd0, "f64", "addsubpd"));
    cs.push(...forms([0xf2], 0x12, "f64", "movddup"), ...forms([0xf3], 0x16, "f32", "movshdup"));
    cs.push(...forms([0xf3], 0x12, "f32", "movsldup"));
    cs.push({ name: "lddqu [esi]", bytes: [0xf2, 0x0f, 0xf0, MEM], lanes: "i" });
    return cs;
}
