/**
 * Characterization — "is the #PF EIP the CPU pushed actually the faulting
 * instruction?"
 *
 * v86 materializes only the LOW 12 BITS of eip when a jit-compiled access faults
 * (codegen::gen_set_previous_eip_offset_from_eip_with_low_bits) — the page comes from
 * whatever instruction_pointer last held, and paths that never reached a per-instruction
 * update leave the offset stale too. Reported fault EIPs therefore range from exact to
 * pointing at inter-function padding, which sends investigations to functions that never
 * ran. isFaultEipConsistent() decodes the operand at the reported EIP and compares its
 * effective address with CR2, so the fault record can flag an EIP it cannot corroborate.
 *
 * Every case below is a REAL NFSU fault captured in logs/ — bytes, CR2 and registers are
 * transcribed from the crash dumps, and the expected verdict was established
 * independently by disassembling Speed.exe at the reported address.
 */

import { describe, expect, test } from "bun:test";
import { analyzeIndirectCallFault, cr2RegisterCandidates, isFaultEipConsistent } from "../../src/worker/core/memory/fault-recorder";

type Regs = { eax: number; ecx: number; edx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number };

function memAt(eip: number, bytes: number[]): Uint8Array {
    const mem = new Uint8Array(eip + 64);
    mem.set(bytes, eip);
    return mem;
}

describe("isFaultEipConsistent — real NFSU fault dumps", () => {
    test("exact EIP: mov ecx,[edi+0x1c] with EDI=0 faulting at 0x1c", () => {
        // logs/…12-4516… t=161.867s, EIP=0x5145a7 — Ghidra agrees this is the instruction.
        const eip = 0x5145a7;
        const regs: Regs = {
            eax: 0x19ddf40, ecx: 0, edx: 0, ebx: 0x1e,
            esp: 0x10ff69c, ebp: 0x10ff6d8, esi: 0x19ddf30, edi: 0,
        };
        const mem = memAt(eip, [0x8b, 0x4f, 0x1c, 0x89, 0x31, 0x89, 0x77, 0x1c]);
        expect(isFaultEipConsistent(mem, eip, 0x1c, regs)).toBe(true);
        expect(cr2RegisterCandidates(0x1c, regs)).toContain("EDI(0x0)+0x1c");
    });

    test("stale EIP: reported address is inter-function padding, real fault is 30 bytes back", () => {
        // logs/…12-5835… t=85.418s, EIP=0x40e8f6. Speed.exe has `ret` at 0x40e8f4 and the
        // next function at 0x40e900; the instruction that can produce CR2=0x18 with ECX=0
        // is `mov eax,[ecx+0x18]` at 0x40e8d8 — NOT the reported EIP.
        const eip = 0x40e8f6;
        const regs: Regs = {
            eax: 0x78aa60, ecx: 0, edx: 0x20, ebx: 3,
            esp: 0x10ffef4, ebp: 0x78aac0, esi: 0x78aa40, edi: 0x78aa80,
        };
        const mem = memAt(eip, [0x51, 0x50, 0xff, 0x92, 0xd0, 0xe9, 0xa9, 0xfe, 0xff, 0xff]);
        expect(isFaultEipConsistent(mem, eip, 0x18, regs)).toBe(false);
        expect(cr2RegisterCandidates(0x18, regs)).toContain("ECX(0x0)+0x18");
    });

    test("stale EIP: reported address is mid-instruction inside a thunk stub", () => {
        // logs/…12-2752… t=121.867s, EIP=0x21048fa6 = thunk stub base+6, i.e. inside the
        // stub's `MOV EDX,0xB077`. No instruction boundary there at all.
        const eip = 0x21048fa6;
        const regs: Regs = {
            eax: 0, ecx: 0x1577249, edx: 0x21048b10, ebx: 0x1578bd8,
            esp: 0x10ff590, ebp: 0x10ff5ec, esi: 0x1560c40, edi: 0x1578c2c,
        };
        const mem = memAt(eip, [0x77, 0xb0, 0x00, 0x00, 0xef, 0xc2, 0x08, 0x00, 0x90, 0x90]);
        expect(isFaultEipConsistent(mem, eip, 0xc, regs)).toBe(false);
        expect(cr2RegisterCandidates(0xc, regs)).toEqual(["EAX(0x0)+0xc"]);
    });

    test("exact EIP: add edx,[eax+0xc] with EAX=0 (game's D3D constant setter)", () => {
        // Speed.exe 0x5d360d inside FUN_005d3554.
        const eip = 0x5d360d;
        const regs: Regs = {
            eax: 0, ecx: 0x100, edx: 0x200, ebx: 0,
            esp: 0x10ff000, ebp: 0x10ff040, esi: 0x300, edi: 0x400,
        };
        const mem = memAt(eip, [0x03, 0x50, 0x0c, 0xff, 0x75, 0x10]);
        expect(isFaultEipConsistent(mem, eip, 0xc, regs)).toBe(true);
    });

    test("indirect-call fault names the vtable slot the bad target came from", () => {
        // logs/…12-2752… t=121.867s. The guest stack held a textbook
        // SetVertexShaderConstantF(this=0x1560288, 4, 0x1578c18, 1) frame with NOTHING
        // pushed by the callee, so the CALL had already run: the target itself was 0xc.
        // Speed.exe 0x5cf453 is `call dword ptr [edx+0x178]` and EDX was the
        // IDirect3DDevice9 vtable (0x21048b10 per the COM log) — slot 94.
        const mem = new Uint8Array(0x21050000);
        const dv = new DataView(mem.buffer);
        mem.set([0xff, 0x92, 0x78, 0x01, 0x00, 0x00], 0x5cf453); // call [edx+0x178]
        const gameEsp = 0x10ff5a8;
        dv.setUint32(gameEsp, 0x5cf459, true); // return address pushed by the CALL
        dv.setUint32(0x21048c88, 0xc, true);   // the corrupt slot value
        const got = analyzeIndirectCallFault(mem, gameEsp, {
            eax: 0, ecx: 0x1577249, edx: 0x21048b10, ebx: 0x1578bd8,
            esp: 0x10ff590, ebp: 0x10ff5ec, esi: 0x1560c40, edi: 0x1578c2c,
        });
        expect(got).not.toBeNull();
        expect(got!.callSite).toBe(0x5cf453);
        expect(got!.slotAddr).toBe(0x21048c88);
        expect(got!.slotValue).toBe(0xc);
        expect(got!.operand).toBe("[EDX+0x178]");
    });

    test("implicit-stack forms are judged against ESP, not a phantom ModRM", () => {
        const eip = 0x401000;
        const regs: Regs = {
            eax: 0x1000, ecx: 0, edx: 0, ebx: 0,
            esp: 0x10ff000, ebp: 0, esi: 0, edi: 0,
        };
        const mem = memAt(eip, [0x50, 0x50, 0x50, 0x50]); // push eax
        expect(isFaultEipConsistent(mem, eip, 0x10feffc, regs)).toBe(true);
        expect(isFaultEipConsistent(mem, eip, 0x1c, regs)).toBe(false);
    });
});
