// Differential test for the trap-free inline GetLocaleInfoW stub.
//
// The stub answers inside guest code, so no runtime instrument can see what it returns —
// the only way to know it agrees with the JS fast path is to EXECUTE the emitted bytes.
// So this file carries a decoder for exactly the instruction forms writeLocaleStubs emits
// and runs the real machine code against the real serialised table. Anything the emitter
// starts emitting that is not in the decoder throws by name rather than being skipped: a
// codegen change cannot quietly stop being tested.
//
// Two properties are asserted:
//   1. For every LCTYPE the locale cache holds — as a size query and as a real read —
//      the stub returns what the JS fast path returns, and writes the same bytes.
//   2. Every bail condition in the stub's contract actually reaches the trap, and leaves
//      the destination untouched.

import { describe, it, expect } from 'bun:test';
import { writeLocaleStubs } from '../../src/worker/modules/kernel32/locale-stubs';
import {
    serializeLocaleStubTable, writeLocaleStubDestLimit, ensureLocaleCache, _localeWCache,
    LOCALE_STUB_ANSWERED_OFF, LOCALE_STUB_BAIL_OFF, LOCALE_STUB_BAIL_REASONS,
} from '../../src/worker/modules/kernel32/locale-data';
import { registerFastPathLocaleFunctions } from '../../src/worker/modules/kernel32/locale';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';

const MEM_SIZE = 1 << 20;
const TABLE_ADDR = 0x70000;   // above DEST: the stub refuses any destination reaching its own table
const TRAP_ADDR = 0x7F000;   // sentinel: execution landing here means the stub bailed
const STACK_TOP = 0x60000;
const DEST = 0x50000;
const RET_ADDR = 0xDEAD0000;

// ---------------------------------------------------------------------------
// A decoder for the forms writeLocaleStubs emits, and nothing else.
// ---------------------------------------------------------------------------

interface RunResult {
    bailed: boolean;
    eax: number;
    /** ESP delta across the call, including the return address pop — must be 20 (RET 16). */
    espDelta: number;
}

const EAX = 0, ECX = 1, EDX = 2, ESP = 4, ESI = 6, EDI = 7;

function run(mem: Uint8Array, entry: number, args: number[]): RunResult {
    const dv = new DataView(mem.buffer);
    const r = new Uint32Array(8);
    let esp = STACK_TOP;
    // stdcall frame: args pushed right to left, then the return address.
    for (let i = args.length - 1; i >= 0; i--) { esp -= 4; dv.setUint32(esp, args[i] >>> 0, true); }
    esp -= 4; dv.setUint32(esp, RET_ADDR, true);
    r[ESP] = esp;
    const espBefore = esp;

    let ZF = false, SF = false, CF = false;
    let eip = entry;
    const u32 = (v: number) => v >>> 0;

    const cmp = (a: number, b: number) => { a = u32(a); b = u32(b); CF = a < b; ZF = a === b; SF = ((a - b) >>> 31) === 1; };
    const test = (a: number, b: number) => { const x = u32(a & b); ZF = x === 0; SF = (x >>> 31) === 1; CF = false; };

    for (let steps = 0; steps < 10000; steps++) {
        if (eip === TRAP_ADDR) return { bailed: true, eax: r[EAX], espDelta: u32(r[ESP]) - espBefore };
        const op = mem[eip];
        const b1 = mem[eip + 1];
        // 0F-prefixed
        if (op === 0x0F) {
            if (b1 === 0xB7) {              // MOVZX r32, r/m16 (reg form)
                const modrm = mem[eip + 2];
                const dst = (modrm >> 3) & 7, src = modrm & 7;
                if ((modrm & 0xC0) !== 0xC0) throw new Error('movzx: unsupported modrm');
                r[dst] = r[src] & 0xFFFF; eip += 3; continue;
            }
            if (b1 >= 0x80 && b1 <= 0x8F) { // Jcc rel32
                const rel = dv.getInt32(eip + 2, true);
                const taken =
                    b1 === 0x82 ? CF :
                    b1 === 0x83 ? !CF :
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
            case 0xA9: test(r[EAX], dv.getUint32(eip + 1, true)); eip += 5; continue;      // TEST EAX, imm32
            case 0x3D: cmp(r[EAX], dv.getUint32(eip + 1, true)); eip += 5; continue;       // CMP EAX, imm32
            case 0xE9: eip = u32(eip + 5 + dv.getInt32(eip + 1, true)); continue;          // JMP rel32
            case 0x56: r[ESP] = u32(r[ESP] - 4); dv.setUint32(r[ESP], r[ESI], true); eip += 1; continue;
            case 0x57: r[ESP] = u32(r[ESP] - 4); dv.setUint32(r[ESP], r[EDI], true); eip += 1; continue;
            case 0x5E: r[ESI] = dv.getUint32(r[ESP], true); r[ESP] = u32(r[ESP] + 4); eip += 1; continue;
            case 0x5F: r[EDI] = dv.getUint32(r[ESP], true); r[ESP] = u32(r[ESP] + 4); eip += 1; continue;
            case 0xD1: {                                                                   // SHR r32, 1
                if (b1 !== 0xE8) throw new Error('D1: only SHR EAX,1 supported');
                r[EAX] = r[EAX] >>> 1; ZF = r[EAX] === 0; SF = false; eip += 2; continue;
            }
            case 0xC1: {                                                                   // SHR r32, imm8
                const reg = b1 & 7;
                if ((b1 & 0xF8) !== 0xE8) throw new Error('C1: only SHR reg,imm8 supported');
                r[reg] = r[reg] >>> mem[eip + 2]; ZF = r[reg] === 0; SF = (r[reg] >>> 31) === 1; eip += 3; continue;
            }
            case 0x85: {                                                                   // TEST r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('85: only reg form supported');
                test(r[b1 & 7], r[(b1 >> 3) & 7]); eip += 2; continue;
            }
            case 0x39: {                                                                   // CMP r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('39: only reg form supported');
                cmp(r[b1 & 7], r[(b1 >> 3) & 7]); eip += 2; continue;
            }
            case 0x89: {                                                                   // MOV r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('89: only reg form supported');
                r[b1 & 7] = r[(b1 >> 3) & 7]; eip += 2; continue;
            }
            case 0x01: {                                                                   // ADD r/m32, r32
                if ((b1 & 0xC0) !== 0xC0) throw new Error('01: only reg form supported');
                const sum = u32(r[b1 & 7]) + u32(r[(b1 >> 3) & 7]);
                CF = sum > 0xFFFFFFFF; r[b1 & 7] = u32(sum); ZF = r[b1 & 7] === 0; SF = (r[b1 & 7] >>> 31) === 1;
                eip += 2; continue;
            }
            case 0x81: {                                                                   // ADD r32, imm32 (/0)
                if (((b1 >> 3) & 7) !== 0 || (b1 & 0xC0) !== 0xC0) throw new Error('81: only ADD reg,imm32 supported');
                const sum = u32(r[b1 & 7]) + dv.getUint32(eip + 2, true);
                CF = sum > 0xFFFFFFFF; r[b1 & 7] = u32(sum); ZF = r[b1 & 7] === 0; SF = (r[b1 & 7] >>> 31) === 1;
                eip += 6; continue;
            }
            case 0x8B: {                                                                   // MOV r32, r/m32
                const reg = (b1 >> 3) & 7;
                if (b1 === 0x04) {                                                         // [reg*4 + disp32] via SIB
                    const sib = mem[eip + 2];
                    if (sib !== 0x85) throw new Error('8B 04: only [EAX*4+disp32] supported');
                    r[EAX] = dv.getUint32(u32(r[EAX] * 4 + dv.getUint32(eip + 3, true)), true);
                    eip += 7; continue;
                }
                if ((b1 & 0xC7) === 0x44 && mem[eip + 2] === 0x24) {                        // [ESP+disp8]
                    r[reg] = dv.getUint32(u32(r[ESP] + mem[eip + 3]), true); eip += 4; continue;
                }
                throw new Error(`8B: unsupported modrm ${b1.toString(16)}`);
            }
            case 0x3B: {                                                                   // CMP r32, [disp32]
                if (b1 !== 0x15) throw new Error('3B: only CMP EDX,[disp32] supported');
                cmp(r[EDX], dv.getUint32(dv.getUint32(eip + 2, true), true)); eip += 6; continue;
            }
            case 0xFF: {                                                                   // INC dword [disp32]
                if (b1 !== 0x05) throw new Error('FF: only INC [disp32] supported');
                const a = dv.getUint32(eip + 2, true);
                dv.setUint32(a, u32(dv.getUint32(a, true) + 1), true); eip += 6; continue;
            }
            case 0xF3: {                                                                   // REP MOVSB
                if (b1 !== 0xA4) throw new Error('F3: only REP MOVSB supported');
                while (r[ECX] !== 0) { mem[r[EDI]] = mem[r[ESI]]; r[ESI] = u32(r[ESI] + 1); r[EDI] = u32(r[EDI] + 1); r[ECX] = u32(r[ECX] - 1); }
                eip += 2; continue;
            }
            case 0xC2: {                                                                   // RET imm16
                const ret = dv.getUint32(r[ESP], true);
                r[ESP] = u32(r[ESP] + 4 + dv.getUint16(eip + 1, true));
                if (ret !== RET_ADDR) throw new Error('RET to a clobbered return address');
                return { bailed: false, eax: r[EAX], espDelta: u32(r[ESP]) - espBefore };
            }
            default: throw new Error(`unsupported opcode ${op.toString(16)} at 0x${eip.toString(16)}`);
        }
    }
    throw new Error('stub did not terminate');
}

// ---------------------------------------------------------------------------

interface Fixture {
    mem: Uint8Array;
    stub: number;
    jsFastPath: (esp: number, mem: Uint8Array) => number | null;
}

function mkFixture(): Fixture {
    const mem = new Uint8Array(MEM_SIZE);
    ensureLocaleCache();
    mem.set(serializeLocaleStubTable(), TABLE_ADDR);
    // The destination bound is installed once the table's address is known; without it the
    // serialised 0 rejects every destination and every call bails.
    writeLocaleStubDestLimit(mem, TABLE_ADDR, MEM_SIZE);
    let bump = 0x1000;
    const allocator: StubAllocator = { alloc: (size: number) => { const a = bump; bump = (bump + size + 15) & ~15; return a; } };
    const { getLocaleInfoWStub } = writeLocaleStubs(allocator, () => mem, TABLE_ADDR, TRAP_ADDR);

    // The REAL JS fast path, captured off a fake dispatcher — the reference the stub must agree with.
    let fn: any = null;
    registerFastPathLocaleFunctions({
        registerFastPath: (dll: string, name: string, impl: any) => {
            if (dll === 'kernel32' && name === 'GetLocaleInfoW') fn = impl;
        },
    });
    if (!fn) throw new Error('GetLocaleInfoW fast path did not register');

    return {
        mem,
        stub: getLocaleInfoWStub,
        jsFastPath: (esp, m) => fn({ reg32: new Uint32Array([0, 0, 0, 0, esp, 0, 0, 0]) }, m,
            new Uint32Array(m.buffer), new DataView(m.buffer)),
    };
}

/** Run the JS fast path over its own copy of memory with the same stdcall frame. */
function runJs(f: Fixture, args: number[]): { ret: number | null; mem: Uint8Array } {
    const m = new Uint8Array(f.mem.length);
    m.set(f.mem);
    const dv = new DataView(m.buffer);
    let esp = STACK_TOP;
    for (let i = args.length - 1; i >= 0; i--) { esp -= 4; dv.setUint32(esp, args[i] >>> 0, true); }
    esp -= 4; dv.setUint32(esp, RET_ADDR, true);
    return { ret: f.jsFastPath(esp, m), mem: m };
}

function runStub(f: Fixture, args: number[]): { res: RunResult; mem: Uint8Array } {
    const m = new Uint8Array(f.mem.length);
    m.set(f.mem);
    return { res: run(m, f.stub, args), mem: m };
}

describe('inline GetLocaleInfoW stub', () => {
    it('agrees with the JS fast path for every cached LCTYPE, sized and read', () => {
        const f = mkFixture();
        ensureLocaleCache();
        const types = [..._localeWCache!.keys()].sort((a, b) => a - b);
        expect(types.length).toBeGreaterThan(20);

        let answered = 0;
        for (const t of types) {
            // Size query.
            const sizeArgs = [0x0409, t, 0, 0];
            const js = runJs(f, sizeArgs);
            const st = runStub(f, sizeArgs);
            expect(st.res.bailed).toBe(false);
            expect(st.res.eax).toBe(js.ret!);
            expect(st.res.espDelta).toBe(20);
            answered++;

            // Real read into an exactly-sized buffer, and into an oversized one.
            const need = js.ret!;
            for (const cch of [need, need + 8]) {
                const args = [0x0409, t, DEST, cch];
                const jsR = runJs(f, args);
                const stR = runStub(f, args);
                expect(stR.res.bailed).toBe(false);
                expect(stR.res.eax).toBe(jsR.ret!);
                expect(stR.res.espDelta).toBe(20);
                expect([...stR.mem.subarray(DEST, DEST + need * 2)])
                    .toEqual([...jsR.mem.subarray(DEST, DEST + need * 2)]);
                answered++;
            }
        }
        // The counter the harness verb reads must have moved by exactly the answers given.
        const one = runStub(f, [0x0409, types[0], 0, 0]);
        expect(new DataView(one.mem.buffer).getUint32(TABLE_ADDR + LOCALE_STUB_ANSWERED_OFF, true)).toBe(1);
        expect(answered).toBeGreaterThan(60);
    });

    it('bails to the trap on every case outside its contract', () => {
        const f = mkFixture();
        const KNOWN = 0x000E; // LOCALE_SDECIMAL — "." → 2 WCHARs
        const cases: Record<string, number[]> = {
            returnNumber: [0x0409, KNOWN | 0x20000000, DEST, 16],
            typeOutOfTable: [0x0409, 0x1100, DEST, 16],
            unknownType: [0x0409, 0x0FF0, DEST, 16],
            negativeCch: [0x0409, KNOWN, DEST, -1],
            bufferTooSmall: [0x0409, KNOWN, DEST, 1],
            nullDest: [0x0409, KNOWN, 0, 16],
            destPastMemory: [0x0409, KNOWN, MEM_SIZE - 2, 16],
            destWraps: [0x0409, KNOWN, 0xFFFFFFFF, 16],
        };
        for (const [name, args] of Object.entries(cases)) {
            const { res, mem } = runStub(f, args);
            expect(`${name}:${res.bailed}`).toBe(`${name}:true`);
            // The bail landed in ITS OWN counter — a shared total would let a reordered
            // check pass while the census pointed at the wrong cause.
            const dv = new DataView(mem.buffer);
            const hit = LOCALE_STUB_BAIL_REASONS
                .filter((_r, i) => dv.getUint32(TABLE_ADDR + LOCALE_STUB_BAIL_OFF + i * 4, true) === 1);
            expect(hit).toEqual([name as typeof LOCALE_STUB_BAIL_REASONS[number]]);
            expect(mem[DEST]).toBe(0);
        }
    });

    it('refuses a destination inside its own table, not just one past guest RAM', () => {
        // A bare length check against guest RAM is not validation: the table is writable
        // THUNK_DATA, so a wild pointer landing in it would rewrite the blob the stub and
        // the JS fast path both answer out of — invisibly, since an inline stub is outside
        // every census.
        const f = mkFixture();
        const inTable = TABLE_ADDR + 0x40;
        const before = f.mem[inTable];
        const { res, mem } = runStub(f, [0x0409, 0x000E, inTable, 16]);
        expect(res.bailed).toBe(true);
        const dv = new DataView(mem.buffer);
        expect(dv.getUint32(TABLE_ADDR + LOCALE_STUB_BAIL_OFF
            + LOCALE_STUB_BAIL_REASONS.indexOf('destPastMemory') * 4, true)).toBe(1);
        expect(mem[inTable]).toBe(before);
    });

    it('serves a size query for a known type without writing', () => {
        const f = mkFixture();
        const { res, mem } = runStub(f, [0x0409, 0x000E, DEST, 0]);
        expect(res.bailed).toBe(false);
        expect(res.eax).toBe(2); // "." + NUL
        expect(mem[DEST]).toBe(0);
    });
});
