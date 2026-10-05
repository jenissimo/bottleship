/**
 * Byte-for-byte encodings of the guestbench emitter (tools/guestbench/lib/asm.mjs).
 *
 * Every fixture built on this emitter claims an exact instruction mix. If a ModRM byte is
 * wrong, the fixture still runs, still produces a checksum, and measures something other
 * than its name — a defect that would show up as an inexplicable A/B result months later.
 * So the encodings are pinned here against hand-checked sequences, with the awkward cases
 * (ESP needing a SIB, [ebp] having no mod-0 form, a bare disp32) named individually.
 */

import { describe, test, expect } from "bun:test";
// @ts-expect-error — plain .mjs helper, deliberately untyped
import { Asm, mem, abs, reg, EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI } from "../guestbench/lib/asm.mjs";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
function enc(build: (a: any) => void): string {
    const a = new Asm(0x1000);
    build(a);
    return hex(a.link());
}

describe("ModRM / SIB encoding", () => {
    const cases: Array<[string, (a: any) => void, string]> = [
        ["mov eax, [ebp-8]", (a) => a.mov(EAX, mem({ base: EBP, disp: -8 })), "8b 45 f8"],
        ["mov eax, [ebp]  (no mod-0 form for EBP)", (a) => a.mov(EAX, mem({ base: EBP })), "8b 45 00"],
        ["mov eax, [ecx]", (a) => a.mov(EAX, mem({ base: ECX })), "8b 01"],
        ["mov eax, [esp]  (ESP always needs a SIB)", (a) => a.mov(EAX, mem({ base: ESP })), "8b 04 24"],
        ["mov eax, [esp+8]", (a) => a.mov(EAX, mem({ base: ESP, disp: 8 })), "8b 44 24 08"],
        ["mov ecx, [edx+esi*4]", (a) => a.mov(ECX, mem({ base: EDX, index: ESI, scale: 4 })), "8b 0c b2"],
        ["mov eax, [ebp+esi*8]  (SIB base 5 has no mod-0 form)", (a) => a.mov(EAX, mem({ base: EBP, index: ESI, scale: 8 })), "8b 44 f5 00"],
        ["mov eax, [esi*4+0x10]  (no base: mod 0, SIB base 5, disp32)", (a) => a.mov(EAX, mem({ base: null, index: ESI, scale: 4, disp: 0x10 })), "8b 04 b5 10 00 00 00"],
        ["mov ebx, [0x00102100]", (a) => a.mov(EBX, abs(0x00102100)), "8b 1d 00 21 10 00"],
        ["mov [ebp-4], eax", (a) => a.movTo(mem({ base: EBP, disp: -4 }), EAX), "89 45 fc"],
        ["mov eax, ebx", (a) => a.mov(EAX, reg(EBX)), "8b c3"],
        ["mov dword [ebp-0x10], 5", (a) => a.movMemImm(mem({ base: EBP, disp: -0x10 }), 5), "c7 45 f0 05 00 00 00"],
        ["mov eax, 0x1234", (a) => a.movImm(EAX, 0x1234), "b8 34 12 00 00"],
        ["lea eax, [ebp-4]", (a) => a.lea(EAX, mem({ base: EBP, disp: -4 })), "8d 45 fc"],
        ["mov eax, [ebx+0x200] (disp32 form)", (a) => a.mov(EAX, mem({ base: EBX, disp: 0x200 })), "8b 83 00 02 00 00"],
    ];
    for (const [label, build, expected] of cases) {
        test(label, () => { expect(enc(build)).toBe(expected); });
    }

    test("ESP is refused as a SIB index rather than encoded as 'no index'", () => {
        expect(() => enc((a) => a.mov(EAX, mem({ base: EBX, index: ESP, scale: 2 })))).toThrow("ESP cannot be a SIB index");
    });
});

describe("integer, stack and control flow", () => {
    const cases: Array<[string, (a: any) => void, string]> = [
        ["add eax, [esi]", (a) => a.alu("add", EAX, mem({ base: ESI })), "03 06"],
        ["xor eax, eax", (a) => a.alu("xor", EAX, reg(EAX)), "33 c0"],
        ["add [ebp-4], eax", (a) => a.aluTo("add", mem({ base: EBP, disp: -4 }), EAX), "01 45 fc"],
        ["add eax, 0x100", (a) => a.aluImm("add", reg(EAX), 0x100), "81 c0 00 01 00 00"],
        ["cmp eax, 0", (a) => a.aluImm("cmp", reg(EAX), 0), "81 f8 00 00 00 00"],
        ["imul eax, ebx", (a) => a.imul(EAX, reg(EBX)), "0f af c3"],
        ["imul eax, eax, 0x01000193", (a) => a.imulImm(EAX, reg(EAX), 0x01000193), "69 c0 93 01 00 01"],
        ["dec dword [ebp-0x10]", (a) => a.dec(mem({ base: EBP, disp: -0x10 })), "ff 4d f0"],
        ["inc eax", (a) => a.inc(reg(EAX)), "ff c0"],
        ["shl eax, 3", (a) => a.shl(reg(EAX), 3), "c1 e0 03"],
        ["ror eax, 7", (a) => a.ror(reg(EAX), 7), "c1 c8 07"],
        ["push eax / pop edi", (a) => { a.push(EAX); a.pop(EDI); }, "50 5f"],
        ["call edi", (a) => a.callIndirect(reg(EDI)), "ff d7"],
        ["call [eax+0x10]", (a) => a.callIndirect(mem({ base: EAX, disp: 0x10 })), "ff 50 10"],
        ["ret / hlt", (a) => { a.ret(); a.hlt(); }, "c3 f4"],
        ["invlpg [0x00280000]", (a) => a.invlpg(abs(0x00280000)), "0f 01 3d 00 00 28 00"],
    ];
    for (const [label, build, expected] of cases) {
        test(label, () => { expect(enc(build)).toBe(expected); });
    }

    test("a backward rel8 branch resolves to the right displacement", () => {
        // L: dec [ebp-0x10] (3 bytes) ; jnz L (2 bytes) -> rel8 = -5
        expect(enc((a) => {
            a.label("L");
            a.dec(mem({ base: EBP, disp: -0x10 }));
            a.jccShort("nz", "L");
        })).toBe("ff 4d f0 75 fb");
    });

    test("a forward rel32 branch resolves across the emitted body", () => {
        // jmp end (5 bytes) ; nop-ish 6 bytes ; end:
        expect(enc((a) => {
            a.jmp("end");
            a.movImm(EAX, 1);       // 5 bytes
            a.label("end");
            a.ret();
        })).toBe("e9 05 00 00 00 b8 01 00 00 00 c3");
    });

    test("an out-of-range short branch is refused, not silently truncated", () => {
        expect(() => enc((a) => {
            a.label("L");
            for (let i = 0; i < 40; i++) a.movImm(EAX, 0);   // 200 bytes
            a.jccShort("nz", "L");
        })).toThrow("use the rel32 form");
    });

    test("an unresolved label is an error", () => {
        expect(() => enc((a) => a.jmp("nowhere"))).toThrow("unresolved label nowhere");
    });
});

describe("x87 and SSE", () => {
    const cases: Array<[string, (a: any) => void, string]> = [
        ["fninit", (a) => a.fninit(), "db e3"],
        ["fld dword [ebp-8]", (a) => a.fldM32(mem({ base: EBP, disp: -8 })), "d9 45 f8"],
        ["fld qword [esi]", (a) => a.fldM64(mem({ base: ESI })), "dd 06"],
        ["fstp dword [ebp-8]", (a) => a.fstpM32(mem({ base: EBP, disp: -8 })), "d9 5d f8"],
        ["fadd dword [ebp-8]", (a) => a.farithM32("add", mem({ base: EBP, disp: -8 })), "d8 45 f8"],
        ["fmul dword [esi]", (a) => a.farithM32("mul", mem({ base: ESI })), "d8 0e"],
        ["fistp dword [ebp-4]", (a) => a.fistpM32(mem({ base: EBP, disp: -4 })), "db 5d fc"],
        ["fld st(2)", (a) => a.fldSt(2), "d9 c2"],
        ["fadd st,st(1)", (a) => a.farithSt("add", 1), "d8 c1"],
        ["fmul st,st(3)", (a) => a.farithSt("mul", 3), "d8 cb"],
        ["fxch st(1)", (a) => a.fxch(1), "d9 c9"],
        ["fstp st(0)", (a) => a.fstpSt(0), "dd d8"],
        ["movups xmm0, [ebp-0x20]", (a) => a.movups(0, mem({ base: EBP, disp: -0x20 })), "0f 10 45 e0"],
        ["movups [esi], xmm1", (a) => a.movupsTo(mem({ base: ESI }), 1), "0f 11 0e"],
        ["addps xmm0, xmm0", (a) => a.sseArith("add", 0, reg(0)), "0f 58 c0"],
        ["mulps xmm1, xmm2", (a) => a.sseArith("mul", 1, reg(2)), "0f 59 ca"],
        ["pxor mm0, mm1 (MMX form)", (a) => a.pxorMmx(0, reg(1)), "0f ef c1"],
        ["emms", (a) => a.emms(), "0f 77"],
    ];
    for (const [label, build, expected] of cases) {
        test(label, () => { expect(enc(build)).toBe(expected); });
    }

    test("enableFpuAndSse clears CR0.EM|TS and sets CR4.OSFXSR|OSXMMEXCPT", () => {
        expect(enc((a) => a.enableFpuAndSse())).toBe(
            "0f 20 c0 25 f3 ff ff ff 0f 22 c0 0f 20 e0 0d 00 06 00 00 0f 22 e0 db e3");
    });
});
