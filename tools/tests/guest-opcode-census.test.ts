/**
 * The x86 judgement behind the guest census (roadmap 10), and the census verb's refusals.
 *
 * v86 feeds this classifier mechanical bits; everything that says what those bits MEAN is
 * here, so this table is the only place the meaning is asserted. The encodings below are
 * real ones — the byte sequences a compiler emits for `fld [ebp-8]`, `movaps xmm0,[esp]`,
 * `call [eax+0x10]` — with the census key computed the way v86 computes it, so a wrong
 * table entry is a wrong answer about the game, not a stylistic disagreement.
 *
 * The second half is the part that matters more: every path where the census could hand
 * back a confident zero is asserted to refuse instead.
 */

import { describe, test, expect } from "bun:test";
import {
    classifyOpcode, classGroup, classifyAddrKey, simdFamily,
} from "../../src/worker/core/debug/guest-opcode-classes";
import { summarizeCensus, type CensusSnapshot } from "../../src/worker/harness/cmds/census";

/** v86's ModRM/SIB key: bit7 addr16 | bit6 hasSib | bits5-4 mod | bits3-1 base | bit0 index. */
function addrKey(opts: { mod: number; rm: number; sib?: { base: number; index: number }; addr16?: boolean }): number {
    const hasSib = opts.sib !== undefined;
    const base = hasSib ? opts.sib!.base : opts.rm;
    const indexPresent = hasSib && opts.sib!.index !== 4;
    return (opts.addr16 ? 1 : 0) << 7 | (hasSib ? 1 : 0) << 6 | (opts.mod & 3) << 4
        | (base & 7) << 1 | (indexPresent ? 1 : 0);
}

describe("instruction classes", () => {
    const cases: Array<[string, { opcode: number; is0f: boolean; isMem: boolean; fixedG: number }, string]> = [
        // x87 — the class the last campaign optimised on a proxy's say-so.
        ["fld dword [ebp-8]     (D9 /0 m)", { opcode: 0xd9, is0f: false, isMem: true, fixedG: 0 }, "x87.load"],
        ["fstp qword [esp]      (DD /3 m)", { opcode: 0xdd, is0f: false, isMem: true, fixedG: 3 }, "x87.store"],
        ["fld qword [eax]       (DD /0 m)", { opcode: 0xdd, is0f: false, isMem: true, fixedG: 0 }, "x87.load"],
        ["fmul dword [esi]      (D8 /1 m)", { opcode: 0xd8, is0f: false, isMem: true, fixedG: 1 }, "x87.arith"],
        ["fcom dword [esi]      (D8 /2 m)", { opcode: 0xd8, is0f: false, isMem: true, fixedG: 2 }, "x87.compare"],
        ["fild dword [ecx]      (DB /0 m)", { opcode: 0xdb, is0f: false, isMem: true, fixedG: 0 }, "x87.load"],
        ["fistp dword [ecx]     (DB /3 m)", { opcode: 0xdb, is0f: false, isMem: true, fixedG: 3 }, "x87.store"],
        ["fldcw [esp]           (D9 /5 m)", { opcode: 0xd9, is0f: false, isMem: true, fixedG: 5 }, "x87.control"],
        ["fnstcw [esp]          (D9 /7 m)", { opcode: 0xd9, is0f: false, isMem: true, fixedG: 7 }, "x87.control"],
        ["faddp st(1),st        (DE /0 r)", { opcode: 0xde, is0f: false, isMem: false, fixedG: 0 }, "x87.arith"],
        ["fld st(2)             (D9 /0 r)", { opcode: 0xd9, is0f: false, isMem: false, fixedG: 0 }, "x87.load"],
        ["fnstsw ax             (DF /4 r)", { opcode: 0xdf, is0f: false, isMem: false, fixedG: 4 }, "x87.control"],
        ["fucomip st(1)         (DF /5 r)", { opcode: 0xdf, is0f: false, isMem: false, fixedG: 5 }, "x87.compare"],
        ["fxch st(1)            (D9 /1 r)", { opcode: 0xd9, is0f: false, isMem: false, fixedG: 1 }, "x87.control"],

        // SIMD
        ["movaps xmm0,[esp]     (0F 28 m)", { opcode: 0x28, is0f: true, isMem: true, fixedG: 0 }, "simd.mov"],
        ["addps xmm0,xmm1       (0F 58 r)", { opcode: 0x58, is0f: true, isMem: false, fixedG: 0 }, "simd.arith"],
        ["shufps                (0F C6)  ", { opcode: 0xc6, is0f: true, isMem: false, fixedG: 0 }, "simd.shuffle"],
        ["cvtsi2ss              (0F 2A)  ", { opcode: 0x2a, is0f: true, isMem: false, fixedG: 0 }, "simd.cvt"],
        ["comiss                (0F 2F)  ", { opcode: 0x2f, is0f: true, isMem: false, fixedG: 0 }, "simd.compare"],
        ["pxor                  (0F EF)  ", { opcode: 0xef, is0f: true, isMem: false, fixedG: 0 }, "simd.arith"],
        ["punpcklbw             (0F 60)  ", { opcode: 0x60, is0f: true, isMem: false, fixedG: 0 }, "simd.shuffle"],

        // Control flow — the classes roadmap 07 splits the dispatch tax by.
        ["jne rel8              (75)     ", { opcode: 0x75, is0f: false, isMem: false, fixedG: 0 }, "branch.condDirect"],
        ["jne rel32             (0F 85)  ", { opcode: 0x85, is0f: true, isMem: false, fixedG: 0 }, "branch.condDirect"],
        ["jmp rel32             (E9)     ", { opcode: 0xe9, is0f: false, isMem: false, fixedG: 0 }, "branch.jmpDirect"],
        ["call rel32            (E8)     ", { opcode: 0xe8, is0f: false, isMem: false, fixedG: 0 }, "branch.callDirect"],
        ["call [eax+0x10]       (FF /2 m)", { opcode: 0xff, is0f: false, isMem: true, fixedG: 2 }, "branch.indirect"],
        ["jmp eax               (FF /4 r)", { opcode: 0xff, is0f: false, isMem: false, fixedG: 4 }, "branch.indirect"],
        ["ret                   (C3)     ", { opcode: 0xc3, is0f: false, isMem: false, fixedG: 0 }, "branch.ret"],
        ["cmpxchg [m], r        (0F B1)  ", { opcode: 0xb1, is0f: true, isMem: true, fixedG: 0 }, "mem.alu"],
        ["bswap ecx             (0F C9)  ", { opcode: 0xc9, is0f: true, isMem: false, fixedG: 0 }, "reg.alu"],
        ["nop [m]               (0F 1F)  ", { opcode: 0x1f, is0f: true, isMem: true, fixedG: 0 }, "other"],
        ["pcmpgtd               (0F 66)  ", { opcode: 0x66, is0f: true, isMem: false, fixedG: 0 }, "simd.compare"],
        ["ret 0x10              (C2)     ", { opcode: 0xc2, is0f: false, isMem: false, fixedG: 0 }, "branch.ret"],
        ["loop rel8             (E2)     ", { opcode: 0xe2, is0f: false, isMem: false, fixedG: 0 }, "branch.condDirect"],

        // Stack and strings
        ["push ebp              (55)     ", { opcode: 0x55, is0f: false, isMem: false, fixedG: 0 }, "stack"],
        ["push dword [eax]      (FF /6 m)", { opcode: 0xff, is0f: false, isMem: true, fixedG: 6 }, "stack"],
        ["pop edi               (5F)     ", { opcode: 0x5f, is0f: false, isMem: false, fixedG: 0 }, "stack"],
        ["rep movsd             (A5)     ", { opcode: 0xa5, is0f: false, isMem: false, fixedG: 0 }, "string"],
        ["rep stosd             (AB)     ", { opcode: 0xab, is0f: false, isMem: false, fixedG: 0 }, "string"],

        // Plain integer work
        ["mov eax,[ebp-4]       (8B m)   ", { opcode: 0x8b, is0f: false, isMem: true, fixedG: 0 }, "mem.mov"],
        ["mov eax,ebx           (8B r)   ", { opcode: 0x8b, is0f: false, isMem: false, fixedG: 0 }, "reg.mov"],
        ["add eax,[esi]         (03 m)   ", { opcode: 0x03, is0f: false, isMem: true, fixedG: 0 }, "mem.alu"],
        ["add eax,ebx           (03 r)   ", { opcode: 0x03, is0f: false, isMem: false, fixedG: 0 }, "reg.alu"],
        ["lea eax,[ebp-4]       (8D)     ", { opcode: 0x8d, is0f: false, isMem: true, fixedG: 0 }, "mem.mov"],
        ["imul eax,ebx          (0F AF r)", { opcode: 0xaf, is0f: true, isMem: false, fixedG: 0 }, "reg.alu"],
        ["movzx eax,byte [esi]  (0F B6 m)", { opcode: 0xb6, is0f: true, isMem: true, fixedG: 0 }, "mem.mov"],
        ["cpuid                 (0F A2)  ", { opcode: 0xa2, is0f: true, isMem: false, fixedG: 0 }, "system"],
        ["int 3                 (CC)     ", { opcode: 0xcc, is0f: false, isMem: false, fixedG: 0 }, "system"],
    ];

    for (const [label, key, expected] of cases) {
        test(`${label} -> ${expected}`, () => {
            expect(classifyOpcode(key)).toBe(expected as never);
        });
    }

    test("groups roll up the way the census table prints them", () => {
        expect(classGroup("x87.load")).toBe("x87");
        expect(classGroup("simd.cvt")).toBe("simd");
        expect(classGroup("branch.ret")).toBe("branch");
        expect(classGroup("mem.mov")).toBe("memory");
        expect(classGroup("reg.alu")).toBe("register");
        expect(classGroup("stack")).toBe("stack");
    });
});

describe("addressing forms — the ceiling roadmap 02 is stated on", () => {
    const cases: Array<[string, number, string]> = [
        // mod=01 rm=101: [ebp+disp8] — the classic frame slot.
        ["[ebp-8]", addrKey({ mod: 1, rm: 5 }), "stackConst"],
        ["[ebp+disp32]", addrKey({ mod: 2, rm: 5 }), "stackConst"],
        // rm=100 asks for a SIB; base=100 is ESP, index=100 means "no index".
        ["[esp]", addrKey({ mod: 0, rm: 4, sib: { base: 4, index: 4 } }), "stackConst"],
        ["[esp+0x10]", addrKey({ mod: 1, rm: 4, sib: { base: 4, index: 4 } }), "stackConst"],
        ["[esp+eax*4]", addrKey({ mod: 0, rm: 4, sib: { base: 4, index: 0 } }), "stackIndex"],
        ["[ebp+esi*8+4]", addrKey({ mod: 1, rm: 4, sib: { base: 5, index: 6 } }), "stackIndex"],
        ["[eax]", addrKey({ mod: 0, rm: 0 }), "baseConst"],
        ["[esi+0x24]", addrKey({ mod: 1, rm: 6 }), "baseConst"],
        ["[ecx+edx*4]", addrKey({ mod: 0, rm: 4, sib: { base: 1, index: 2 } }), "baseIndex"],
        // mod=00 rm=101 is disp32 with no base; the SIB form of the same is base=101,mod=00.
        ["[0x00401000]", addrKey({ mod: 0, rm: 5 }), "absolute"],
        ["[disp32] via SIB", addrKey({ mod: 0, rm: 4, sib: { base: 5, index: 4 } }), "absolute"],
        ["[eax*4+disp32]", addrKey({ mod: 0, rm: 4, sib: { base: 5, index: 0 } }), "baseIndex"],
        ["16-bit addressing", addrKey({ mod: 1, rm: 6, addr16: true }), "addr16"],
    ];
    for (const [label, key, expected] of cases) {
        test(`${label} -> ${expected}`, () => {
            expect(classifyAddrKey(key)).toBe(expected as never);
        });
    }

    test("a stack base with an index is NOT the stackConst class", () => {
        // The distinction the whole item turns on: a single per-unit guard can bound
        // [esp+K], but not [esp+eax*4], whose displacement is a runtime value.
        expect(classifyAddrKey(addrKey({ mod: 0, rm: 4, sib: { base: 4, index: 4 } }))).toBe("stackConst");
        expect(classifyAddrKey(addrKey({ mod: 0, rm: 4, sib: { base: 4, index: 0 } }))).toBe("stackIndex");
    });
});

describe("SIMD families — MMX and SSE2 share opcodes", () => {
    const key = (prefix: number, op: number) => (prefix << 8) | op;
    test("unprefixed integer 0F is MMX, 66-prefixed is SSE2", () => {
        expect(simdFamily(key(0, 0xef))).toBe("mmx");        // pxor mm0,mm1
        expect(simdFamily(key(1, 0xef))).toBe("sse2.int");   // pxor xmm0,xmm1
    });
    test("the scalar prefixes name the scalar families", () => {
        expect(simdFamily(key(0, 0x58))).toBe("sse.ps");     // addps
        expect(simdFamily(key(1, 0x58))).toBe("sse2.pd");    // addpd
        expect(simdFamily(key(2, 0x58))).toBe("sse.ss");     // addss
        expect(simdFamily(key(3, 0x58))).toBe("sse2.sd");    // addsd
    });
    test("non-SIMD 0F opcodes are excluded rather than mislabelled", () => {
        expect(simdFamily(key(0, 0x85))).toBe("other");      // jne rel32
        expect(simdFamily(key(0, 0xa2))).toBe("other");      // cpuid
        expect(simdFamily(key(0, 0xb6))).toBe("other");      // movzx
        expect(simdFamily(key(2, 0x6f))).toBe("sse2.int");   // F3 0F 6F movdqu
        expect(simdFamily(key(1, 0x7f))).toBe("sse2.int");   // 66 0F 7F movdqa
        expect(simdFamily(key(0, 0x7f))).toBe("mmx");        // 0F 7F movq mm
        expect(simdFamily(key(0, 0xc9))).toBe("other");      // bswap ecx
        expect(simdFamily(key(0, 0xae))).toBe("other");      // fxsave/ldmxcsr group
    });
});

// ---------------------------------------------------------------------------

const OPCODE_KEYS = 0x2000;

function snap(over: Partial<CensusSnapshot> = {}): CensusSnapshot {
    return {
        atMs: 0,
        opcode: new Float64Array(OPCODE_KEYS),
        addr: new Float64Array(256),
        simd: new Float64Array(1024),
        retiredCounter: 0, enabled: 1, armEpoch: 1,
        ...over,
    };
}

/** Build an "after" snapshot with the given per-key counts. */
function after(opts: {
    atMs?: number; retired?: number; enabled?: number; armEpoch?: number;
    opcodes?: Array<[{ opcode: number; is0f?: boolean; isMem?: boolean; fixedG?: number }, number]>;
    addrs?: Array<[number, number]>;
    simds?: Array<[number, number]>;
}): CensusSnapshot {
    const s = snap({ atMs: opts.atMs ?? 1000, retiredCounter: opts.retired ?? 0 });
    if (opts.enabled !== undefined) s.enabled = opts.enabled;
    if (opts.armEpoch !== undefined) s.armEpoch = opts.armEpoch;
    for (const [k, n] of opts.opcodes ?? []) {
        const idx = ((k.is0f ? 1 : 0) << 12) | (k.opcode << 4) | ((k.isMem ? 1 : 0) << 3) | (k.fixedG ?? 0);
        s.opcode[idx]! += n;
    }
    for (const [k, n] of opts.addrs ?? []) s.addr[k]! += n;
    for (const [k, n] of opts.simds ?? []) s.simd[k]! += n;
    return s;
}

function report(r: ReturnType<typeof summarizeCensus>): Record<string, any> {
    expect(r.ok).toBe(true);
    return (r as any).report;
}

describe("census rollup", () => {
    test("shares are of the counted total, with coverage against retired", () => {
        const r = report(summarizeCensus(snap(), after({
            retired: 1000,
            opcodes: [
                [{ opcode: 0xd9, isMem: true, fixedG: 0 }, 100],   // fld m32
                [{ opcode: 0x8b, isMem: true }, 200],              // mov r,[m]
                [{ opcode: 0x03 }, 100],                           // add r,r
            ],
            addrs: [
                [addrKey({ mod: 1, rm: 5 }), 250],                            // [ebp-8]
                [addrKey({ mod: 0, rm: 4, sib: { base: 1, index: 2 } }), 50], // [ecx+edx*4]
            ],
        })));
        expect(r.counted).toBe(400);
        expect(r.coveragePct).toBe(40);
        expect(r.memory.ops).toBe(300);
        expect(r.memory.crossCheck.ok).toBe(true);
        expect(r.memory.stackConstPctOfMemory).toBeCloseTo(83.33, 1);
        expect(r.x87.total).toBe(100);
        expect(r.x87.pctOfCounted).toBe(25);
    });

    test("a prefix byte is not double-counted as an opcode", () => {
        // v86 records each prefix at prefix<<4, which on the one-byte map collides with
        // opcode 0x66/0xF3/… at is_mem 0, fixed_g 0. Counting those as instructions would
        // inflate every prefixed workload — SSE code most of all.
        const r = report(summarizeCensus(snap(), after({
            retired: 100,
            opcodes: [[{ opcode: 0x66 }, 5000], [{ opcode: 0x03 }, 100]],
        })));
        expect(r.counted).toBe(100);
    });

    test("a disagreement between the two memory feeds is reported, not reconciled", () => {
        const r = report(summarizeCensus(snap(), after({
            retired: 100,
            opcodes: [[{ opcode: 0x8b, isMem: true }, 100]],
            addrs: [[addrKey({ mod: 1, rm: 5 }), 60]],
        })));
        expect(r.memory.crossCheck.ok).toBe(false);
        expect(r.memory.crossCheck.note).toContain("MISMATCH");
    });

    test("MMX and SSE2 stay apart in the family table", () => {
        const r = report(summarizeCensus(snap(), after({
            retired: 100,
            opcodes: [[{ opcode: 0xef, is0f: true }, 100]],
            simds: [[0xef, 40], [(1 << 8) | 0xef, 60]],
        })));
        const fam = Object.fromEntries(r.simd.families.map((f: any) => [f.name, f.n]));
        expect(fam["mmx"]).toBe(40);
        expect(fam["sse2.int"]).toBe(60);
    });
});

describe("the census refuses rather than reporting an empty table", () => {
    test("switch off", () => {
        const r = summarizeCensus(snap({ enabled: 0 }), after({ enabled: 0, retired: 1000 }));
        expect(r.ok).toBe(false);
        expect((r as any).refuse).toContain("census switch is off");
    });

    test("nothing counted while the guest ran is an error, not 'no x87'", () => {
        const r = summarizeCensus(snap(), after({ retired: 5_000_000 }));
        expect(r.ok).toBe(false);
        expect((r as any).refuse).toContain("counted 0 instructions");
    });

    test("a re-arm inside the window", () => {
        const r = summarizeCensus(snap({ armEpoch: 1 }), after({ armEpoch: 2, retired: 10 }));
        expect(r.ok).toBe(false);
        expect((r as any).refuse).toContain("zeroed mid-flight");
    });

    test("an empty window", () => {
        const s = snap({ atMs: 7 });
        const r = summarizeCensus(s, { ...s });
        expect(r.ok).toBe(false);
        expect((r as any).refuse).toContain("window is empty");
    });
});
