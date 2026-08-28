// Differential test for the trap-free inline MultiByteToWideChar / WideCharToMultiByte stubs.
//
// The stubs answer inside guest code, so no runtime instrument can see what they return —
// the only way to know they agree with the JS fast paths is to EXECUTE the emitted bytes.
// So this file carries a decoder for exactly the instruction forms writeMbwcStubs emits
// and runs the real machine code against the real serialised LUTs. Anything the emitter
// starts emitting that is not in the decoder throws by name rather than being skipped: a
// codegen change cannot quietly stop being tested.
//
// Three properties are asserted:
//   1. For a spread of sources — ASCII, high-byte, single character, sized and
//      NUL-terminated, size query and real read — the stub returns what the JS fast path
//      returns and writes the same bytes.
//   2. Every bail condition reaches the trap, in ITS OWN counter, with the destination
//      untouched.
//   3. The answered counters move exactly once per answer.

import { describe, it, expect } from 'bun:test';
import { writeMbwcStubs } from '../../src/worker/modules/kernel32/mbwc-stubs';
import { retireMbwcStubTable } from '../../src/worker/modules/kernel32/codepage-lut';
import {
    serializeMbwcStubTable, writeMbwcStubDestLimit, codePageToUnicodeLut,
    MBWC_ANSWERED_MBTWC_OFF, MBWC_ANSWERED_WCTMB_OFF,
    MBWC_MBTWC_BAIL_OFF, MBWC_WCTMB_BAIL_OFF,
    MBTWC_BAIL_REASONS, WCTMB_BAIL_REASONS,
} from '../../src/worker/modules/kernel32/codepage-lut';
import { registerFastPathLocaleFunctions } from '../../src/worker/modules/kernel32/locale';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';

const MEM_SIZE = 1 << 20;
const TABLE_ADDR = 0x80000;      // the table is ~128 KB; it must not overlap SRC/DEST
const TRAP_MB = 0x7F000;         // sentinels: execution landing here means the stub bailed
const TRAP_WC = 0x7F100;
const STACK_TOP = 0x60000;
const SRC = 0x50000;
const DEST = 0x58000;
const RET_ADDR = 0xDEAD0000;

// ---------------------------------------------------------------------------
// A decoder for the forms writeMbwcStubs emits, and nothing else.
// ---------------------------------------------------------------------------

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, ESI = 6, EDI = 7;

interface RunResult {
    bailed: boolean;
    /** Which trap sentinel it landed on, when it bailed. */
    trap: number;
    eax: number;
    espDelta: number;
    /** Callee-saved registers must come back unchanged. */
    preserved: boolean;
}

function run(mem: Uint8Array, entry: number, args: number[]): RunResult {
    const dv = new DataView(mem.buffer);
    const r = new Uint32Array(8);
    // Poison the callee-saved registers so a missing POP shows up as a mismatch.
    r[EBX] = 0xB0B0B0B0; r[ESI] = 0x51515151; r[EDI] = 0xD1D1D1D1;
    const savedBx = r[EBX]!, savedSi = r[ESI]!, savedDi = r[EDI]!;
    let esp = STACK_TOP;
    for (let i = args.length - 1; i >= 0; i--) { esp -= 4; dv.setUint32(esp, args[i]! >>> 0, true); }
    esp -= 4; dv.setUint32(esp, RET_ADDR, true);
    r[ESP] = esp;
    const espBefore = esp;

    let ZF = false, SF = false, CF = false;
    let eip = entry;
    const u32 = (v: number) => v >>> 0;
    const preserved = () => r[EBX] === savedBx && r[ESI] === savedSi && r[EDI] === savedDi;

    const setLog = (v: number) => { ZF = u32(v) === 0; SF = (u32(v) >>> 31) === 1; CF = false; };
    const cmp = (a: number, b: number) => { a = u32(a); b = u32(b); CF = a < b; ZF = a === b; SF = ((a - b) >>> 31) === 1; };
    const add = (a: number, b: number) => { const s = u32(a) + u32(b); CF = s > 0xFFFFFFFF; const v = u32(s); ZF = v === 0; SF = (v >>> 31) === 1; return v; };

    for (let steps = 0; steps < 1_000_000; steps++) {
        if (eip === TRAP_MB || eip === TRAP_WC) {
            return { bailed: true, trap: eip, eax: r[EAX]!, espDelta: u32(r[ESP]!) - espBefore, preserved: preserved() };
        }
        const op = mem[eip]!;
        const b1 = mem[eip + 1]!;
        if (op === 0x66) {                                   // operand-size prefix
            const o = mem[eip + 1]!, m = mem[eip + 2]!;
            if (o === 0x83 && m === 0x38) {                  // CMP word [EAX], imm8
                cmp(dv.getUint16(r[EAX]!, true), mem[eip + 3]!); eip += 4; continue;
            }
            if (o === 0x81 && m === 0x3C && mem[eip + 3] === 0x4D) {  // CMP word [disp32+ECX*2], imm16
                const addr = u32(dv.getUint32(eip + 4, true) + r[ECX]! * 2);
                cmp(dv.getUint16(addr, true), dv.getUint16(eip + 8, true)); eip += 10; continue;
            }
            if (o === 0x8B && m === 0x14 && mem[eip + 3] === 0x55) {  // MOV DX, [disp32+EDX*2]
                const addr = u32(dv.getUint32(eip + 4, true) + r[EDX]! * 2);
                r[EDX] = u32((r[EDX]! & 0xFFFF0000) | dv.getUint16(addr, true)); eip += 8; continue;
            }
            if (o === 0x89 && m === 0x17) {                  // MOV [EDI], DX
                dv.setUint16(r[EDI]!, r[EDX]! & 0xFFFF, true); eip += 3; continue;
            }
            throw new Error(`unsupported 66-prefixed ${o.toString(16)} ${m.toString(16)}`);
        }
        if (op === 0x0F) {
            if (b1 === 0xB6 && mem[eip + 2] === 0x16) {       // MOVZX EDX, byte [ESI]
                r[EDX] = mem[r[ESI]!]!; eip += 3; continue;
            }
            if (b1 === 0xB7) {                               // MOVZX r32, word [r/m]
                const modrm = mem[eip + 2]!;
                if (modrm === 0x08) { r[ECX] = dv.getUint16(r[EAX]!, true); eip += 3; continue; }
                if (modrm === 0x16) { r[EDX] = dv.getUint16(r[ESI]!, true); eip += 3; continue; }
                throw new Error(`movzx word: unsupported modrm ${modrm.toString(16)}`);
            }
            if (b1 >= 0x80 && b1 <= 0x8F) {                  // Jcc rel32
                const rel = dv.getInt32(eip + 2, true);
                const taken =
                    b1 === 0x82 ? CF :
                    b1 === 0x84 ? ZF :
                    b1 === 0x85 ? !ZF :
                    b1 === 0x87 ? (!CF && !ZF) :
                    b1 === 0x88 ? SF :
                    (() => { throw new Error(`unsupported Jcc 0F ${b1.toString(16)}`); })();
                eip += 6; if (taken) eip = u32(eip + rel); continue;
            }
            throw new Error(`unsupported 0F ${b1.toString(16)}`);
        }
        switch (op) {
            case 0x25: r[EAX] = u32(r[EAX]! & dv.getUint32(eip + 1, true)); setLog(r[EAX]!); eip += 5; continue;  // AND EAX, imm32
            case 0x3D: cmp(r[EAX]!, dv.getUint32(eip + 1, true)); eip += 5; continue;                             // CMP EAX, imm32
            case 0xE9: eip = u32(eip + 5 + dv.getInt32(eip + 1, true)); continue;                                 // JMP rel32
            case 0x40: r[EAX] = u32(r[EAX]! + 1); eip += 1; continue;                                             // INC EAX
            case 0x46: r[ESI] = u32(r[ESI]! + 1); eip += 1; continue;                                             // INC ESI
            case 0x47: r[EDI] = u32(r[EDI]! + 1); eip += 1; continue;                                             // INC EDI
            case 0x49: r[ECX] = u32(r[ECX]! - 1); ZF = r[ECX] === 0; eip += 1; continue;                          // DEC ECX
            case 0x53: r[ESP] = u32(r[ESP]! - 4); dv.setUint32(r[ESP]!, r[EBX]!, true); eip += 1; continue;
            case 0x56: r[ESP] = u32(r[ESP]! - 4); dv.setUint32(r[ESP]!, r[ESI]!, true); eip += 1; continue;
            case 0x57: r[ESP] = u32(r[ESP]! - 4); dv.setUint32(r[ESP]!, r[EDI]!, true); eip += 1; continue;
            case 0x5B: r[EBX] = dv.getUint32(r[ESP]!, true); r[ESP] = u32(r[ESP]! + 4); eip += 1; continue;
            case 0x5E: r[ESI] = dv.getUint32(r[ESP]!, true); r[ESP] = u32(r[ESP]! + 4); eip += 1; continue;
            case 0x5F: r[EDI] = dv.getUint32(r[ESP]!, true); r[ESP] = u32(r[ESP]! + 4); eip += 1; continue;
            case 0x80: {                                                                    // CMP byte [EAX], imm8
                if (b1 !== 0x38) throw new Error('80: only CMP byte [EAX],imm8 supported');
                cmp(mem[r[EAX]!]!, mem[eip + 2]!); eip += 3; continue;
            }
            case 0x83: {                                                                    // ADD r32, imm8
                if (((b1 >> 3) & 7) !== 0 || (b1 & 0xC0) !== 0xC0) throw new Error('83: only ADD reg,imm8 supported');
                r[b1 & 7] = add(r[b1 & 7]!, mem[eip + 2]!); eip += 3; continue;
            }
            case 0x81: {                                                                    // ADD/CMP r32, imm32
                const ext = (b1 >> 3) & 7;
                if ((b1 & 0xC0) !== 0xC0) throw new Error('81: only reg form supported');
                const imm = dv.getUint32(eip + 2, true);
                if (ext === 0) r[b1 & 7] = add(r[b1 & 7]!, imm);
                else if (ext === 7) cmp(r[b1 & 7]!, imm);
                else throw new Error(`81: unsupported /${ext}`);
                eip += 6; continue;
            }
            case 0x85: {                                                                    // TEST r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('85: only reg form supported');
                setLog(r[b1 & 7]! & r[(b1 >> 3) & 7]!); eip += 2; continue;
            }
            case 0x0B: {                                                                    // OR EAX, [ESP+disp8]
                if (b1 !== 0x44 || mem[eip + 2] !== 0x24) throw new Error('0B: only OR EAX,[ESP+disp8] supported');
                r[EAX] = u32(r[EAX]! | dv.getUint32(u32(r[ESP]! + mem[eip + 3]!), true));
                setLog(r[EAX]!); eip += 4; continue;
            }
            case 0x39: {                                                                    // CMP r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('39: only reg form supported');
                cmp(r[b1 & 7]!, r[(b1 >> 3) & 7]!); eip += 2; continue;
            }
            case 0x89: {                                                                    // MOV r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('89: only reg form supported');
                r[b1 & 7] = r[(b1 >> 3) & 7]!; eip += 2; continue;
            }
            case 0x01: {                                                                    // ADD r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('01: only reg form supported');
                r[b1 & 7] = add(r[b1 & 7]!, r[(b1 >> 3) & 7]!); eip += 2; continue;
            }
            case 0x29: {                                                                    // SUB r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('29: only reg form supported');
                const a = u32(r[b1 & 7]!), b = u32(r[(b1 >> 3) & 7]!);
                CF = a < b; r[b1 & 7] = u32(a - b); ZF = r[b1 & 7] === 0; SF = (r[b1 & 7]! >>> 31) === 1;
                eip += 2; continue;
            }
            case 0xD1: {                                                                    // SHR r32, 1
                if ((b1 & 0xF8) !== 0xE8) throw new Error('D1: only SHR reg,1 supported');
                r[b1 & 7] = r[b1 & 7]! >>> 1; ZF = r[b1 & 7] === 0; SF = false; eip += 2; continue;
            }
            case 0x8A: {                                                                    // MOV DL, [disp32+EDX*2]
                if (b1 !== 0x14 || mem[eip + 2] !== 0x55) throw new Error('8A: only MOV DL,[disp32+EDX*2] supported');
                const addr = u32(dv.getUint32(eip + 3, true) + r[EDX]! * 2);
                r[EDX] = u32((r[EDX]! & 0xFFFFFF00) | mem[addr]!); eip += 7; continue;
            }
            case 0x88: {                                                                    // MOV [EDI], DL
                if (b1 !== 0x17) throw new Error('88: only MOV [EDI],DL supported');
                mem[r[EDI]!] = r[EDX]! & 0xFF; eip += 2; continue;
            }
            case 0x8B: {                                                                    // MOV r32, [ESP+disp8]
                const reg = (b1 >> 3) & 7;
                if ((b1 & 0xC7) === 0x44 && mem[eip + 2] === 0x24) {
                    r[reg] = dv.getUint32(u32(r[ESP]! + mem[eip + 3]!), true); eip += 4; continue;
                }
                throw new Error(`8B: unsupported modrm ${b1.toString(16)}`);
            }
            case 0x3B: {                                                                    // CMP r32, [disp32]
                if (b1 !== 0x05 && b1 !== 0x15) throw new Error('3B: only CMP EAX/EDX,[disp32] supported');
                cmp(r[b1 === 0x05 ? EAX : EDX]!, dv.getUint32(dv.getUint32(eip + 2, true), true)); eip += 6; continue;
            }
            case 0xFF: {                                                                    // INC dword [disp32]
                if (b1 !== 0x05) throw new Error('FF: only INC [disp32] supported');
                const a = dv.getUint32(eip + 2, true);
                dv.setUint32(a, u32(dv.getUint32(a, true) + 1), true); eip += 6; continue;
            }
            case 0xC2: {                                                                    // RET imm16
                const ret = dv.getUint32(r[ESP]!, true);
                r[ESP] = u32(r[ESP]! + 4 + dv.getUint16(eip + 1, true));
                if (ret !== RET_ADDR) throw new Error('RET to a clobbered return address');
                return { bailed: false, trap: 0, eax: r[EAX]!, espDelta: u32(r[ESP]!) - espBefore, preserved: preserved() };
            }
            default: throw new Error(`unsupported opcode ${op.toString(16)} at 0x${eip.toString(16)}`);
        }
    }
    throw new Error('stub did not terminate');
}

// ---------------------------------------------------------------------------

interface Fixture {
    mem: Uint8Array;
    mbToWc: number;
    wcToMb: number;
    codePage: number;
    js: Record<'MultiByteToWideChar' | 'WideCharToMultiByte', (esp: number, mem: Uint8Array) => number | null>;
}

function mkFixture(): Fixture {
    const mem = new Uint8Array(MEM_SIZE);
    const table = serializeMbwcStubTable(MEM_SIZE);
    if (!table) throw new Error('serializeMbwcStubTable declined the default ANSI page');
    mem.set(table.bytes, TABLE_ADDR);
    // The destination bound is installed once the table's address is known; without it the
    // serialised 0 rejects every destination and every call bails.
    writeMbwcStubDestLimit(mem, TABLE_ADDR, MEM_SIZE);
    let bump = 0x1000;
    const allocator: StubAllocator = { alloc: (size: number) => { const a = bump; bump = (bump + size + 15) & ~15; return a; } };
    const { mbToWcStub, wcToMbStub } = writeMbwcStubs(
        allocator, () => mem, TABLE_ADDR, table.codePage, table.alsoOem, TRAP_MB, TRAP_WC);

    // The REAL JS fast paths, captured off a fake dispatcher — the reference to agree with.
    const fns: Record<string, any> = {};
    registerFastPathLocaleFunctions({
        registerFastPath: (dll: string, name: string, impl: any) => { if (dll === 'kernel32') fns[name] = impl; },
    });
    const wrap = (name: string) => {
        const fn = fns[name];
        if (!fn) throw new Error(`${name} fast path did not register`);
        return (esp: number, m: Uint8Array) => fn({ reg32: new Uint32Array([0, 0, 0, 0, esp, 0, 0, 0]) }, m,
            new Uint32Array(m.buffer), new DataView(m.buffer));
    };
    return {
        mem, mbToWc: mbToWcStub, wcToMb: wcToMbStub, codePage: table.codePage,
        js: { MultiByteToWideChar: wrap('MultiByteToWideChar'), WideCharToMultiByte: wrap('WideCharToMultiByte') },
    };
}

function frame(m: Uint8Array, args: number[]): number {
    const dv = new DataView(m.buffer);
    let esp = STACK_TOP;
    for (let i = args.length - 1; i >= 0; i--) { esp -= 4; dv.setUint32(esp, args[i]! >>> 0, true); }
    esp -= 4; dv.setUint32(esp, RET_ADDR, true);
    return esp;
}

function copy(f: Fixture): Uint8Array {
    const m = new Uint8Array(f.mem.length);
    m.set(f.mem);
    return m;
}

/** Run the JS fast path and the stub over identical private copies of memory. */
function differential(f: Fixture, which: 'MultiByteToWideChar' | 'WideCharToMultiByte',
                      seed: (m: Uint8Array) => void, args: number[]) {
    const mj = copy(f); seed(mj);
    const ms = copy(f); seed(ms);
    const jsRet = f.js[which](frame(mj, args), mj);
    const res = run(ms, which === 'MultiByteToWideChar' ? f.mbToWc : f.wcToMb, args);
    return { jsRet, res, jsMem: mj, stubMem: ms };
}

const ASCII = 'C:\\Games\\Data.pak';

function seedBytes(at: number, bytes: number[]): (m: Uint8Array) => void {
    return (m) => { for (let i = 0; i < bytes.length; i++) m[at + i] = bytes[i]!; };
}

function seedWide(at: number, codes: number[]): (m: Uint8Array) => void {
    return (m) => {
        const dv = new DataView(m.buffer);
        for (let i = 0; i < codes.length; i++) dv.setUint16(at + i * 2, codes[i]!, true);
    };
}

describe('inline MultiByteToWideChar stub', () => {
    it('agrees with the JS fast path across sources, sized and NUL-terminated', () => {
        const f = mkFixture();
        const fwd = codePageToUnicodeLut(f.codePage)!;
        // ASCII, a single character, and every high byte the page can round-trip: the LUT
        // is the whole contract, so a spot-check of ASCII would not exercise it.
        const highBytes = [...Array(128).keys()].map((i) => i + 0x80).filter((b) => fwd[b] !== 0xFFFD);
        const bodies: number[][] = [
            [...ASCII].map((c) => c.charCodeAt(0)),
            [0x41],
            highBytes,
        ];
        let answered = 0;
        for (const body of bodies) {
            const nulTerm = [...body, 0];
            for (const [bytes, cb] of [[nulTerm, -1], [body, body.length]] as [number[], number][]) {
                const seed = seedBytes(SRC, [...bytes, 0]);
                const need = cb === -1 ? bytes.length : body.length;
                for (const cch of [0, need, need + 4]) {
                    const args = [f.codePage, 0, SRC, cb, cch === 0 ? DEST : DEST, cch];
                    const d = differential(f, 'MultiByteToWideChar', seed, args);
                    expect(d.res.bailed).toBe(false);
                    expect(d.res.eax).toBe(d.jsRet!);
                    expect(d.res.espDelta).toBe(28);   // RET 24 + the return address
                    expect(d.res.preserved).toBe(true);
                    expect([...d.stubMem.subarray(DEST, DEST + need * 2 + 4)])
                        .toEqual([...d.jsMem.subarray(DEST, DEST + need * 2 + 4)]);
                    answered++;
                }
            }
        }
        expect(answered).toBe(18);
    });

    it('accepts CP_ACP and MB_PRECOMPOSED, which are the same request', () => {
        const f = mkFixture();
        const seed = seedBytes(SRC, [0x41, 0x42, 0]);
        for (const args of [[0, 0, SRC, -1, DEST, 8], [f.codePage, 1, SRC, -1, DEST, 8]]) {
            const d = differential(f, 'MultiByteToWideChar', seed, args);
            expect(d.res.bailed).toBe(false);
            expect(d.res.eax).toBe(3);
            expect([...d.stubMem.subarray(DEST, DEST + 6)]).toEqual([0x41, 0, 0x42, 0, 0, 0]);
        }
    });

    it('bails to the trap on every case outside its contract', () => {
        const f = mkFixture();
        const seed = seedBytes(SRC, [0x41, 0x42, 0]);
        const cases: Record<string, number[]> = {
            flags: [f.codePage, 8, SRC, -1, DEST, 8],                          // MB_ERR_INVALID_CHARS
            otherCodePage: [65001, 0, SRC, -1, DEST, 8],
            nullSrc: [f.codePage, 0, 0, -1, DEST, 8],
            negativeLength: [f.codePage, 0, SRC, -2, DEST, 8],
            zeroLength: [f.codePage, 0, SRC, 0, DEST, 8],
            srcRangeWraps: [f.codePage, 0, 0xFFFFFF00, 0x400, DEST, 8],
            srcPastMemory: [f.codePage, 0, MEM_SIZE - 4, 64, DEST, 8],
            srcScanWraps: [f.codePage, 0, 0xFFFFFF00, -1, DEST, 8],
            srcScanPastMemory: [f.codePage, 0, MEM_SIZE - 4, -1, DEST, 8],
            negativeCch: [f.codePage, 0, SRC, -1, DEST, -1],
            bufferTooSmall: [f.codePage, 0, SRC, -1, DEST, 2],
            nullDest: [f.codePage, 0, SRC, -1, 0, 8],
            destWraps: [f.codePage, 0, SRC, -1, 0xFFFFFFFC, 8],
            destPastMemory: [f.codePage, 0, SRC, -1, MEM_SIZE - 2, 8],
        };
        for (const [name, args] of Object.entries(cases)) {
            const m = copy(f); seed(m);
            const res = run(m, f.mbToWc, args);
            expect(`${name}:${res.bailed}:${res.trap.toString(16)}`).toBe(`${name}:true:${TRAP_MB.toString(16)}`);
            expect(res.preserved).toBe(true);
            expect(res.espDelta).toBe(0);   // the trap must see the frame the guest built
            const dv = new DataView(m.buffer);
            const hit = MBTWC_BAIL_REASONS.filter((_r, i) => dv.getUint32(TABLE_ADDR + MBWC_MBTWC_BAIL_OFF + i * 4, true) === 1);
            expect(hit).toEqual([name as typeof MBTWC_BAIL_REASONS[number]]);
            expect(m[DEST]).toBe(0);
        }
        // srcTooLong needs a source with no terminator inside the scan window.
        const m = copy(f);
        m.fill(0x41, SRC, SRC + 0x2000);
        const res = run(m, f.mbToWc, [f.codePage, 0, SRC, -1, DEST, 0x4000]);
        expect(res.bailed).toBe(true);
        const dv = new DataView(m.buffer);
        expect(dv.getUint32(TABLE_ADDR + MBWC_MBTWC_BAIL_OFF + MBTWC_BAIL_REASONS.indexOf('srcTooLong') * 4, true)).toBe(1);
    });

    it('refuses a destination inside its own LUT, not just one past guest RAM', () => {
        // A bare length check against guest RAM is not validation: the 128KB LUT is writable
        // THUNK_DATA, so a wild pointer landing in it would rewrite the table the stub and
        // the JS fast path both translate out of — invisibly, since an inline stub is
        // outside every census.
        const f = mkFixture();
        const inTable = TABLE_ADDR + 0x40;
        const m = copy(f); seedBytes(SRC, [0x41, 0x42, 0])(m);
        const before = m[inTable];
        const res = run(m, f.mbToWc, [f.codePage, 0, SRC, -1, inTable, 8]);
        expect(res.bailed).toBe(true);
        const dv = new DataView(m.buffer);
        expect(dv.getUint32(TABLE_ADDR + MBWC_MBTWC_BAIL_OFF
            + MBTWC_BAIL_REASONS.indexOf('destPastMemory') * 4, true)).toBe(1);
        expect(m[inTable]).toBe(before);
    });

    it('counts exactly one answer per answered call', () => {
        const f = mkFixture();
        const m = copy(f); seedBytes(SRC, [0x41, 0])(m);
        for (let i = 0; i < 5; i++) run(m, f.mbToWc, [f.codePage, 0, SRC, -1, DEST, 8]);
        expect(new DataView(m.buffer).getUint32(TABLE_ADDR + MBWC_ANSWERED_MBTWC_OFF, true)).toBe(5);
    });
});

describe('retiring the MBWC table', () => {
    it('makes every stub call decline, so a code-page change is answered by JS', () => {
        const f = mkFixture();
        const seed = seedBytes(SRC, [0x41, 0x42, 0]);
        const args = [f.codePage, 0, SRC, -1, DEST, 8];

        const seeded = () => { const m = copy(f); seed(m); return m; };
        const before = run(seeded(), f.mbToWc, args);
        expect(before.bailed).toBe(false);
        expect(before.eax).toBe(3);

        // _setmbcp moves EmulatorConfig.ansiCodePage; the stub's LUT cannot follow it, and a
        // stub that kept answering would disagree with the JS tier on every high byte.
        retireMbwcStubTable(f.mem);
        const after = run(seeded(), f.mbToWc, args);
        expect(after.bailed).toBe(true);
        expect(after.trap).toBe(TRAP_MB);
        expect(after.espDelta).toBe(0);
    });
});

describe('inline WideCharToMultiByte stub', () => {
    it('agrees with the JS fast path across sources, sized and NUL-terminated', () => {
        const f = mkFixture();
        const fwd = codePageToUnicodeLut(f.codePage)!;
        const highChars = [...Array(128).keys()].map((i) => fwd[i + 0x80]!).filter((c) => c !== 0xFFFD);
        const bodies: number[][] = [
            [...ASCII].map((c) => c.charCodeAt(0)),
            [0x41],
            highChars,
        ];
        let answered = 0;
        for (const body of bodies) {
            const nulTerm = [...body, 0];
            for (const [codes, cch] of [[nulTerm, -1], [body, body.length]] as [number[], number][]) {
                const seed = seedWide(SRC, [...codes, 0]);
                const need = codes.length;
                for (const cb of [0, need, need + 4]) {
                    const args = [f.codePage, 0, SRC, cch, DEST, cb, 0, 0];
                    const d = differential(f, 'WideCharToMultiByte', seed, args);
                    expect(d.res.bailed).toBe(false);
                    expect(d.res.eax).toBe(d.jsRet!);
                    expect(d.res.espDelta).toBe(36);   // RET 32 + the return address
                    expect(d.res.preserved).toBe(true);
                    expect([...d.stubMem.subarray(DEST, DEST + need + 4)])
                        .toEqual([...d.jsMem.subarray(DEST, DEST + need + 4)]);
                    answered++;
                }
            }
        }
        expect(answered).toBe(18);
    });

    it('bails to the trap on every case outside its contract', () => {
        const f = mkFixture();
        const seed = seedWide(SRC, [0x41, 0x42, 0]);
        const cases: Record<string, number[]> = {
            flags: [f.codePage, 0x400, SRC, -1, DEST, 8, 0, 0],                // WC_COMPOSITECHECK
            defaultChar: [f.codePage, 0, SRC, -1, DEST, 8, SRC + 0x100, 0],
            otherCodePage: [65001, 0, SRC, -1, DEST, 8, 0, 0],
            nullSrc: [f.codePage, 0, 0, -1, DEST, 8, 0, 0],
            negativeLength: [f.codePage, 0, SRC, -2, DEST, 8, 0, 0],
            zeroLength: [f.codePage, 0, SRC, 0, DEST, 8, 0, 0],
            srcRangeWraps: [f.codePage, 0, 0xFFFFFF00, 0x400, DEST, 8, 0, 0],
            srcPastMemory: [f.codePage, 0, MEM_SIZE - 4, 64, DEST, 8, 0, 0],
            srcScanWraps: [f.codePage, 0, 0xFFFFFF00, -1, DEST, 8, 0, 0],
            srcScanPastMemory: [f.codePage, 0, MEM_SIZE - 4, -1, DEST, 8, 0, 0],
            negativeCb: [f.codePage, 0, SRC, -1, DEST, -1, 0, 0],
            bufferTooSmall: [f.codePage, 0, SRC, -1, DEST, 2, 0, 0],
            nullDest: [f.codePage, 0, SRC, -1, 0, 8, 0, 0],
            destWraps: [f.codePage, 0, SRC, -1, 0xFFFFFFFE, 8, 0, 0],
            destPastMemory: [f.codePage, 0, SRC, -1, MEM_SIZE - 1, 8, 0, 0],
        };
        for (const [name, args] of Object.entries(cases)) {
            const m = copy(f); seed(m);
            const res = run(m, f.wcToMb, args);
            expect(`${name}:${res.bailed}:${res.trap.toString(16)}`).toBe(`${name}:true:${TRAP_WC.toString(16)}`);
            expect(res.preserved).toBe(true);
            expect(res.espDelta).toBe(0);
            const dv = new DataView(m.buffer);
            const hit = WCTMB_BAIL_REASONS.filter((_r, i) => dv.getUint32(TABLE_ADDR + MBWC_WCTMB_BAIL_OFF + i * 4, true) === 1);
            expect(hit).toEqual([name as typeof WCTMB_BAIL_REASONS[number]]);
            expect(m[DEST]).toBe(0);
        }
        // unrepresentable: a code point the single-byte page cannot encode. Nothing may be
        // written — a partial conversion followed by a bail would be converted TWICE.
        const m = copy(f);
        seedWide(SRC, [0x41, 0x4E2D, 0])(m);
        const res = run(m, f.wcToMb, [f.codePage, 0, SRC, -1, DEST, 8, 0, 0]);
        expect(res.bailed).toBe(true);
        expect(m[DEST]).toBe(0);
        const dv = new DataView(m.buffer);
        expect(dv.getUint32(TABLE_ADDR + MBWC_WCTMB_BAIL_OFF + WCTMB_BAIL_REASONS.indexOf('unrepresentable') * 4, true)).toBe(1);
        // srcTooLong: no terminator inside the scan window.
        const m2 = copy(f);
        seedWide(SRC, new Array(0x1200).fill(0x41))(m2);
        expect(run(m2, f.wcToMb, [f.codePage, 0, SRC, -1, DEST, 0x4000, 0, 0]).bailed).toBe(true);
        expect(new DataView(m2.buffer)
            .getUint32(TABLE_ADDR + MBWC_WCTMB_BAIL_OFF + WCTMB_BAIL_REASONS.indexOf('srcTooLong') * 4, true)).toBe(1);
    });

    it('counts exactly one answer per answered call', () => {
        const f = mkFixture();
        const m = copy(f); seedWide(SRC, [0x41, 0])(m);
        for (let i = 0; i < 5; i++) run(m, f.wcToMb, [f.codePage, 0, SRC, -1, DEST, 8, 0, 0]);
        expect(new DataView(m.buffer).getUint32(TABLE_ADDR + MBWC_ANSWERED_WCTMB_OFF, true)).toBe(5);
    });
});
