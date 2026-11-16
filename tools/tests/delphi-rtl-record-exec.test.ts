// The delphi-rtl entry filters (libs/delphi-rtl/descriptor.ts) answer _InitializeRecord and
// _FinalizeRecord for a record with one long-string field without running the RTL bodies.
//
// Here the RTL bodies the detector matches (the descriptor's exact bytes, every masked operand
// wired to where a linker puts it) run in real v86 over one scenario twice: as they are, and
// with each record helper's entry patched to its filter and the original reachable through a
// relocated-prologue trampoline, as lib-patcher builds it. Both arms must leave the same memory,
// the same callee-saved registers and stack pointer, the same EAX after _FinalizeRecord and the
// same calls into the allocator, and both must equal an independent model. A third arm replaces
// the trampolines with traps and runs only the shapes the filters claim, so a filter that
// silently declined would be caught. Broken filters must be rejected by the same comparison.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    BODIES, PROLOGUE_LEN, TK_LSTRING, assembleRecordFilter, findRecordHelpers,
} from '../../src/worker/core/hle-lib/libs/delphi-rtl/descriptor';
import { OUT_DX_EAX } from '../../src/worker/core/thunking/thunk-constants';
import { applyPatch, validatePrologueBytes, type PatchContext } from '../../src/worker/core/hle-lib/lib-patcher';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { delphiRtlDescriptor } from '../../src/worker/core/hle-lib/libs/delphi-rtl/descriptor';

const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const HAVE_V86 = existsSync(LIB) && existsSync(WASM);

const BASE = 0x400000, IMG = 0xc000, ENTRY = BASE + 0x40, RESUME = BASE + 0x1000;
// A Delphi 7 runner's layout: the bodies keep their distances, so every rel32 resolves the way
// the linker resolved it.
const LSTRCLR = 0x404fa8, IREC = 0x405988, IARR = 0x4059b8, FREC = 0x405a58, FARR = 0x405aa4;
const AT: Record<keyof typeof BODIES, number> = {
    LStrClr: LSTRCLR, InitializeRecord: IREC, InitializeArray: IARR, FinalizeRecord: FREC, FinalizeArray: FARR,
};
const FREEMEM = 0x402794;
/** RTL entries the scenario must never reach (error, LStrArrayClr, WStrClr, WStrArrayClr, VarClr, IntfClear, DynArrayClear). */
const TRAPS = [0x4028d0, 0x404fcc, 0x4056dc, 0x4056f4, 0x405a8c, 0x406b98, 0x4064e0];
/** body offset of a masked operand's opcode → target. */
const SITES: Partial<Record<keyof typeof BODIES, Record<number, number>>> = {
    InitializeRecord: { 0x20: IARR },
    InitializeArray: { 0x3b: 0x4028d0, 0x70: IARR, 0x86: IREC },
    FinalizeRecord: { 0x20: FARR },
    FinalizeArray: {
        0x3e: 0x405b7e, 0x4a: LSTRCLR, 0x4f: 0x405b89, 0x56: 0x404fcc, 0x5b: 0x405b89, 0x67: 0x4056dc, 0x70: 0x4056f4,
        0x7c: 0x405a8c, 0x99: FARR, 0xaf: FREC, 0xbf: 0x406b98, 0xd0: 0x4064e0, 0xe0: 0x4028d0,
    },
    LStrClr: { 0x1c: FREEMEM },
};
const CTL_PORT = 0xb0a0, CTL_SNAP = 1, CTL_FREE = 2, CTL_TRAP = 3, CTL_FAULT = 4, CTL_SPLIT = 5;
const FILTERS = 0x409000, PF_HANDLER = 0x409c00, DATA = 0x40a000, NP_PAGE = 0x40b000, STACK = 0x200000;
// Paging for the fault arms: page 0x40a000 (type info and records) read-only, 0x40b000 not present.
const PD = 0x100000, PT = 0x101000, IDT = 0x102000, IDTR = 0x102800, GDT = 0x102900, GDTR = 0x102980;

// Type info, laid out as the Delphi compiler emits it: kind, name, size, managed-field count,
// then (PPTypeInfo, offset) per managed field.
const TI_LSTR = DATA, TI_WSTR = DATA + 0x20, TI_VAR = DATA + 0x40, P_LSTR = DATA + 0x60, P_WSTR = DATA + 0x64, P_VAR = DATA + 0x68;
const TI_REC1 = DATA + 0x80, TI_REC2 = DATA + 0xc0, TI_RECW = DATA + 0x100, TI_RECV = DATA + 0x140, TI_RECNP = DATA + 0x180;
// A long-string type info whose kind byte is the last byte before the absent page.
const TI_EDGE = NP_PAGE - 1, P_EDGE = DATA + 0x6c, TI_RECEDGE = DATA + 0x1c0;
const RECS = DATA + 0x400, STRS = DATA + 0x800;
const rec = (i: number) => RECS + i * 0x40;
const str = (i: number) => STRS + i * 0x20 + 8;

interface Step { fn: 'IR' | 'FR' | 'IA' | 'FA'; p: number; ti: number; n?: number; fast: boolean }
const SCENARIO: Step[] = [
    { fn: 'IR', p: rec(0), ti: TI_REC1, fast: true },                   // one long string
    { fn: 'IR', p: rec(1), ti: TI_REC2, fast: false },                  // two managed fields
    { fn: 'IR', p: rec(2), ti: TI_RECW, fast: false },                  // a WideString field
    { fn: 'IR', p: rec(3), ti: TI_RECV, fast: false },                  // a Variant field (16 bytes)
    { fn: 'FR', p: rec(0), ti: TI_REC1, fast: true },                   // nil string
    { fn: 'FR', p: rec(5), ti: TI_REC1, fast: false },                  // refcount 2: decrement, clear
    { fn: 'FR', p: rec(6), ti: TI_REC1, fast: false },                  // literal (refcount -1): clear only
    { fn: 'FR', p: rec(7), ti: TI_REC1, fast: false },                  // refcount 1: freed
    { fn: 'FR', p: rec(1), ti: TI_REC2, fast: false },                  // two fields, both nil
    { fn: 'IA', p: rec(8), ti: TI_REC1, n: 3, fast: true },             // array of records → IR ×3
    { fn: 'FA', p: rec(8), ti: TI_REC1, n: 3, fast: true },             // array of records → FR ×3
];
const sentinel = (r: number, i: number) => (0x10000000 * (r + 1) + 0x100 + i) >>> 0;

/** machine: DF, x87 control word, status word and stack top after the call. */
interface Snap { regs: number[]; eax: number; recs: number[]; machine: number[] }
type FaultCase = 'typeInfoName' | 'fieldTypeInfo' | 'readOnlyStore' | 'absentString' | 'kindAtPageEndInit' | 'kindAtPageEndFinal';
interface Fault { cr2: number; err: number; eip: number; esp: number }
interface Patched { entry: number; filter: number; trampoline: number }
interface Arm { snaps: Snap[]; data: number[]; frees: number[]; traps: number[]; halted: boolean; entryOps: number[]; found: ReturnType<typeof findRecordHelpers>; fault?: Fault; patched: Patched[]; generator?: ThunkGenerator }
interface ArmOptions { filter: boolean; trapTrampolines?: boolean; onlyFast?: boolean; mutate?: (fin: boolean, code: Uint8Array) => void; fault?: FaultCase; splitAt?: number }

/** One call that faults in both arms, with the address the fault must name. */
const FAULTS: Record<FaultCase, { step: Step; cr2: number; write: boolean }> = {
    typeInfoName: { step: { fn: 'IR', p: rec(0), ti: NP_PAGE - 1, fast: false }, cr2: NP_PAGE, write: false },
    fieldTypeInfo: { step: { fn: 'IR', p: rec(0), ti: TI_RECNP, fast: false }, cr2: NP_PAGE, write: false },
    readOnlyStore: { step: { fn: 'IR', p: rec(0), ti: TI_REC1, fast: true }, cr2: rec(0) + 8, write: true },
    absentString: { step: { fn: 'FR', p: NP_PAGE - 8, ti: TI_REC1, fast: true }, cr2: NP_PAGE, write: false },
    kindAtPageEndInit: { step: { fn: 'IR', p: rec(0), ti: TI_RECEDGE, fast: false }, cr2: NP_PAGE, write: false },
    kindAtPageEndFinal: { step: { fn: 'FR', p: rec(10), ti: TI_RECEDGE, fast: false }, cr2: NP_PAGE, write: false },
};

function writeTypeInfo(dv: DataView, mem: Uint8Array): void {
    const ti = (at: number, kind: number, name: string) => {
        mem[at] = kind; mem[at + 1] = name.length;
        for (let i = 0; i < name.length; i++) mem[at + 2 + i] = name.charCodeAt(i);
        return at + 2 + name.length;
    };
    ti(TI_LSTR, TK_LSTRING, 'AnsiString');
    ti(TI_WSTR, 0x0b, 'WideString');
    ti(TI_VAR, 0x0c, 'Variant');
    dv.setUint32(P_LSTR, TI_LSTR, true); dv.setUint32(P_WSTR, TI_WSTR, true); dv.setUint32(P_VAR, TI_VAR, true);
    const recTi = (at: number, name: string, size: number, fields: Array<[number, number]>) => {
        let p = ti(at, 0x0e, name);
        dv.setUint32(p, size, true); dv.setUint32(p + 4, fields.length, true); p += 8;
        for (const [pp, off] of fields) { dv.setUint32(p, pp, true); dv.setUint32(p + 4, off, true); p += 8; }
    };
    recTi(TI_REC1, 'TValue', 16, [[P_LSTR, 8]]);
    recTi(TI_REC2, 'TPair', 8, [[P_LSTR, 0], [P_LSTR, 4]]);
    recTi(TI_RECW, 'TWide', 8, [[P_WSTR, 4]]);
    recTi(TI_RECV, 'TVar', 24, [[P_VAR, 8]]);
    recTi(TI_RECNP, 'TLost', 16, [[NP_PAGE, 8]]);
    mem[TI_EDGE] = TK_LSTRING;
    dv.setUint32(P_EDGE, TI_EDGE, true);
    recTi(TI_RECEDGE, 'TEdge', 16, [[P_EDGE, 8]]);
}

/** Long strings: refcount at -8, length at -4. */
const STRINGS: Array<[number, number]> = [[5, 2], [6, -1], [7, 1]];

function buildImage(opts: ArmOptions): { bytes: Uint8Array; found: Arm['found']; patched: Patched[]; generator?: ThunkGenerator } {
    const mem = new Uint8Array(BASE + IMG);
    const dv = new DataView(mem.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + IMG, BASE + IMG, ENTRY]
        .forEach((v, i) => dv.setUint32(BASE + i * 4, v, true));
    for (const [name, body] of Object.entries(BODIES) as Array<[keyof typeof BODIES, (typeof BODIES)[keyof typeof BODIES]]>) {
        const at = AT[name];
        mem.set(body.bytes, at);
        for (const [o, target] of Object.entries(SITES[name] ?? {})) {
            const op = at + Number(o);
            dv.setInt32(op + 1, target - (op + 5), true);
        }
    }
    const ctl = (at: number, cmd: number, ret: boolean) => {
        mem.set([0x50, 0x52, 0xb8, cmd, 0, 0, 0, 0xba, CTL_PORT & 0xff, CTL_PORT >> 8, 0, 0, OUT_DX_EAX, 0x5a, 0x58, ret ? 0xc3 : 0xf4], at);
    };
    for (const t of TRAPS) ctl(t, CTL_TRAP, false);
    ctl(FREEMEM, CTL_FREE, true);

    writeTypeInfo(dv, mem);
    for (let i = 0; i < 12; i++) for (let w = 0; w < 16; w++) dv.setUint32(rec(i) + w * 4, (0xaa000000 | (i << 8) | w) >>> 0, true);
    for (const [i, rc] of STRINGS) {
        const s = str(i);
        dv.setInt32(s - 8, rc, true); dv.setUint32(s - 4, 3, true); mem.set([0x61, 0x62, 0x63, 0], s);
        dv.setUint32(rec(i) + 8, s, true);
    }
    dv.setUint32(rec(0) + 8, 0x5eed0000, true);
    dv.setUint32(rec(10) + 8, 0, true);
    for (let k = 0; k < 3; k++) dv.setUint32(rec(8) + k * 16 + 8, 0x5eed0100 + k, true);

    const found = findRecordHelpers(mem);
    // The filter arm goes through lib-patcher exactly as the manager does: an OUT stub, the
    // relocated-prologue trampoline and the descriptor's entry filter, all handed out by a
    // ThunkGenerator (whose allocator drops compiled code for every range it hands out), then
    // the entry JMP.
    const patched: Patched[] = [];
    let generator: ThunkGenerator | undefined;
    if (opts.filter) {
        generator = new ThunkGenerator();
        generator.setBaseAddress(FILTERS);
        const ctx: PatchContext = {
            dispatcher: { register: () => {}, applyPendingRegistrations: () => {} } as never,
            thunkGenerator: generator,
            getMemory: () => mem,
        };
        for (const [name, entry] of [['InitializeRecord', IREC], ['FinalizeRecord', FREC]] as const) {
            const decl = delphiRtlDescriptor.functions[name]!;
            const handle = applyPatch(ctx, {
                libId: delphiRtlDescriptor.id, functionName: name, moduleName: 'runner.exe', targetAddress: entry,
                callingConvention: decl.callingConvention, argCount: decl.argCount, handler: delphiRtlDescriptor.handlers[name]!,
                prologueLen: decl.prologueLen, entryFilter: decl.entryFilter,
            });
            if (!handle || handle.trampolineAddress === undefined) throw new Error(`applyPatch refused ${name}`);
            const filter = (entry + 5 + dv.getInt32(entry + 1, true)) >>> 0;
            patched.push({ entry, filter, trampoline: handle.trampolineAddress });
            if (opts.trapTrampolines) ctl(handle.trampolineAddress, CTL_TRAP, false);
            if (opts.mutate) {
                const size = assembleRecordFilter(0, 0, name === 'FinalizeRecord').length;
                const code = mem.slice(filter, filter + size);
                opts.mutate(name === 'FinalizeRecord', code);
                mem.set(code, filter);
            }
        }
    }

    let p = ENTRY;
    const e = (...b: number[]) => { mem.set(b, p); p += b.length; };
    const u = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const call = (target: number) => { e(0xe8); u(target - (p + 4)); };
    e(0xbc); u(STACK);
    e(0xfc, 0xdb, 0xe3, 0xd9, 0xe8, 0xd9, 0xeb);                 // cld; fninit; fld1; fldpi
    if (opts.fault) {
        e(0x0f, 0x01, 0x15); u(GDTR);                             // lgdt: flat code 0x08, data 0x10
        e(0xea); u(p + 6); e(0x08, 0x00);                         // jmp 0x08:next
        e(0x66, 0xb8, 0x10, 0x00, 0x8e, 0xd8, 0x8e, 0xc0, 0x8e, 0xd0, 0x8e, 0xe0, 0x8e, 0xe8);
        e(0xb8); u(PD); e(0x0f, 0x22, 0xd8);                      // mov cr3, PD
        e(0x0f, 0x20, 0xe0, 0x83, 0xc8, 0x10, 0x0f, 0x22, 0xe0);  // cr4.PSE
        e(0x0f, 0x01, 0x1d); u(IDTR);                             // lidt
        e(0x0f, 0x20, 0xc0, 0x0d); u(0x80010000); e(0x0f, 0x22, 0xc0);   // cr0.PG | cr0.WP
        mem.set([0x0f, 0x20, 0xd1, 0xb8, CTL_FAULT, 0, 0, 0, 0xba, CTL_PORT & 0xff, CTL_PORT >> 8, 0, 0, OUT_DX_EAX, 0xf4], PF_HANDLER);
    }
    const steps = opts.fault ? [FAULTS[opts.fault].step] : SCENARIO;
    steps.forEach((s, i) => {
        if (opts.onlyFast && !s.fast) return;
        if (opts.splitAt === i) {
            // The first machine stops here; the restored one enters at RESUME with the same
            // DF and x87 setup and runs the remaining calls.
            e(0xb8); u(CTL_SPLIT); e(0xba); u(CTL_PORT); e(OUT_DX_EAX, 0xf4);
            p = RESUME;
            e(0xbc); u(STACK);
            e(0xfc, 0xdb, 0xe3, 0xd9, 0xe8, 0xd9, 0xeb);
        }
        e(0xbb); u(sentinel(0, i)); e(0xbe); u(sentinel(1, i)); e(0xbf); u(sentinel(2, i)); e(0xbd); u(sentinel(3, i));
        e(0xb8); u(s.p); e(0xba); u(s.ti);
        if (s.n !== undefined) { e(0xb9); u(s.n); }
        call({ IR: IREC, FR: FREC, IA: IARR, FA: FARR }[s.fn]);
        e(0x50, 0xb9); u(i); e(0xb8); u(CTL_SNAP); e(0xba); u(CTL_PORT); e(OUT_DX_EAX, 0x58);
    });
    e(0xf4);
    return { bytes: mem.slice(BASE), found, patched, generator };
}

/** v86 binds its browser adapters to a global `window` when one exists; another test file may
 *  leave a partial mock behind, so the machine is built without one. */
async function withoutWindow<T>(fn: () => Promise<T>): Promise<T> {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g, saved = g.window;
    if (had) delete g.window;
    try { return await fn(); } finally { if (had) g.window = saved; }
}

function runArm(opts: ArmOptions): Promise<Arm> {
    return withoutWindow(() => runArmIsolated(opts));
}

async function runArmIsolated(opts: ArmOptions): Promise<Arm> {
    const { V86 } = await import(LIB);
    const boot = async () => {
        const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: WASM, log_level: 0, disable_jit: 1 });
        await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
        return em;
    };
    let em = await boot();
    try {
        let cpu = em.v86.cpu;
        cpu.reboot_internal(); cpu.reset_memory();
        const { bytes, found, patched, generator } = buildImage(opts);
        cpu.load_multiboot(bytes.buffer);
        if (opts.fault) {
            const g = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
            for (let i = 0; i < 8; i++) g.setUint32(PD + i * 4, i === 1 ? PT | 3 : ((i << 22) | 0x83) >>> 0, true);
            for (let i = 0; i < 1024; i++) {
                const page = 0x400000 + i * 0x1000;
                g.setUint32(PT + i * 4, page === NP_PAGE ? 0 : (page | (page === DATA ? 1 : 3)) >>> 0, true);
            }
            g.setUint32(GDT + 8, 0x0000ffff, true); g.setUint32(GDT + 12, 0x00cf9a00, true);
            g.setUint32(GDT + 16, 0x0000ffff, true); g.setUint32(GDT + 20, 0x00cf9200, true);
            g.setUint16(GDTR, 3 * 8 - 1, true); g.setUint32(GDTR + 2, GDT, true);
            const cs = 0x08;
            g.setUint32(IDT + 14 * 8, ((cs << 16) | (PF_HANDLER & 0xffff)) >>> 0, true);
            g.setUint32(IDT + 14 * 8 + 4, ((PF_HANDLER & 0xffff0000) | 0x8e00) >>> 0, true);
            g.setUint16(IDTR, 256 * 8 - 1, true); g.setUint32(IDTR + 2, IDT, true);
        }
        let fault: Fault | undefined;
        const snaps: Snap[] = [], frees: number[] = [], traps: number[] = [];
        let split: (() => void) | null = null;
        const listen = () => cpu.io.register_write(CTL_PORT, null, undefined, undefined, (cmd: number) => {
            const r = cpu.reg32;
            const esp = r[4] >>> 0;
            if (cmd === CTL_SNAP) {
                snaps[r[1] >>> 0] = {
                    regs: [r[3], r[6], r[7], r[5], esp + 4].map(v => v >>> 0), eax: cpu.read32s(esp) >>> 0,
                    recs: Array.from({ length: (rec(9) - RECS) / 4 }, (_, k) => cpu.read32s(RECS + k * 4) >>> 0),
                    machine: [cpu.flags[0] & 0x400, cpu.fpu_control_word[0] & 0xffff, cpu.fpu_status_word[0] & 0xffff, cpu.fpu_stack_ptr[0]],
                };
            } else if (cmd === CTL_FAULT) {
                fault = { cr2: r[1] >>> 0, err: cpu.read32s(esp) >>> 0, eip: cpu.read32s(esp + 4) >>> 0, esp: (esp + 16) >>> 0 };
            } else if (cmd === CTL_FREE) frees.push(cpu.read32s(esp + 4) >>> 0);
            else if (cmd === CTL_SPLIT) split?.();
            else traps.push(cpu.read32s(esp + 8) >>> 0);
        });
        const go = (start: boolean) => new Promise<'halt' | 'split' | 'timeout'>(resolve => {
            const timer = setTimeout(() => { em.stop(); resolve('timeout'); }, 10000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve('halt'); });
            split = () => { clearTimeout(timer); em.stop(); resolve('split'); };
            if (start) { cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2; }
            em.run();
        });
        listen();
        let end = await go(true);
        let restored: ThunkGenerator | undefined;
        if (end === 'split') {
            // The machine is saved between two calls and resumed in a fresh emulator: guest RAM
            // with the patched entries, filters, trampolines and records as the first machine
            // left them, and the thunk allocator through its captured state. The restored machine
            // enters at RESUME, so the CPU registers it does not carry are set as at boot.
            const image = cpu.mem8.slice(BASE, BASE + IMG);
            const allocator = structuredClone(generator!.captureState());
            await em.stop();
            await em.destroy();
            em = await boot();
            cpu = em.v86.cpu;
            cpu.reboot_internal(); cpu.reset_memory();
            cpu.load_multiboot(buildImage({ filter: false }).bytes.buffer);
            cpu.mem8.set(image, BASE);
            restored = new ThunkGenerator();
            restored.restoreState(allocator);
            listen();
            cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = RESUME; cpu.flags[0] = 2;
            end = await go(false);
        }
        const data = Array.from({ length: 0x1000 / 4 }, (_, i) => cpu.mem8[RECS + i * 4]! | (cpu.mem8[RECS + i * 4 + 1]! << 8) | (cpu.mem8[RECS + i * 4 + 2]! << 16) | (cpu.mem8[RECS + i * 4 + 3]! << 24))
            .map(v => v >>> 0);
        return { snaps, data, frees, traps, halted: end === 'halt', entryOps: [cpu.mem8[IREC]!, cpu.mem8[FREC]!], found, fault, patched, generator: restored ?? generator };
    } finally {
        await em.destroy();
    }
}

const word = (data: number[], addr: number) => data[(addr - RECS) / 4]!;
const fill = (i: number, w: number) => (0xaa000000 | (i << 8) | w) >>> 0;

/** What the RTL defines for each step, computed without running x86. */
function modelProblems(arm: Arm, onlyFast = false): string[] {
    const bad: string[] = [];
    if (!arm.halted) bad.push('guest did not halt');
    if (arm.traps.length) bad.push(`reached trap stubs ${arm.traps.map(t => t.toString(16))}`);
    SCENARIO.forEach((s, i) => {
        if (onlyFast && !s.fast) return;
        const got = arm.snaps[i];
        if (!got) { bad.push(`step ${i}: no snapshot`); return; }
        const want = [0, 1, 2, 3].map(r => sentinel(r, i)).concat(STACK);
        if (got.regs.join() !== want.join()) bad.push(`step ${i}: callee-saved ${got.regs.map(v => v.toString(16))}`);
        if (s.fn === 'FR' && got.eax !== s.p) bad.push(`step ${i}: FinalizeRecord returned ${got.eax.toString(16)}`);
    });
    const d = arm.data;
    const expectWord = (addr: number, v: number, why: string) => {
        if (word(d, addr) !== v >>> 0) bad.push(`${why}: [${addr.toString(16)}] = ${word(d, addr).toString(16)}, want ${(v >>> 0).toString(16)}`);
    };
    expectWord(rec(0) + 8, 0, 'IR one string');
    expectWord(rec(0) + 4, fill(0, 1), 'IR leaves other words');
    expectWord(rec(0) + 12, fill(0, 3), 'IR leaves other words');
    for (let k = 0; k < 3; k++) {
        expectWord(rec(8) + k * 16 + 8, 0, `IA element ${k}`);
        expectWord(rec(8) + k * 16 + 4, fill(8, k * 4 + 1), `IA element ${k} neighbour`);
    }
    if (!onlyFast) {
        expectWord(rec(1), 0, 'IR two fields'); expectWord(rec(1) + 4, 0, 'IR two fields');
        expectWord(rec(2) + 4, 0, 'IR WideString'); expectWord(rec(2), fill(2, 0), 'IR WideString neighbour');
        for (let w = 2; w < 6; w++) expectWord(rec(3) + w * 4, 0, 'IR Variant');
        expectWord(rec(3) + 24, fill(3, 6), 'IR Variant neighbour');
        for (const i of [5, 6, 7]) expectWord(rec(i) + 8, 0, `FR clears string ${i}`);
        if (arm.frees.join() !== [str(7) - 8].join()) bad.push(`frees ${arm.frees.map(f => f.toString(16))}`);
    } else if (arm.frees.length) bad.push('fast path freed memory');
    return bad;
}

/** After every step: callee-saved registers, ESP, the records, and EAX where the helper returns
 *  something (the finalizers return p). */
function contract(arm: Arm): Array<number[]> {
    return SCENARIO.map((s, i) => {
        const snap = arm.snaps[i];
        if (!snap) return [];
        return [...snap.regs, ...snap.machine, ...(s.fn === 'FR' || s.fn === 'FA' ? [snap.eax] : []), ...snap.recs];
    });
}

function stringHeaders(arm: Arm): number[] {
    return [5, 6].map(i => word(arm.data, str(i) - 8));
}

describe('delphi-rtl record helpers: detection', () => {
    test('the bodies are found once each, and only with their internal calls wired', () => {
        const { bytes } = buildImage({ filter: false });
        const mem = new Uint8Array(BASE + IMG);
        mem.set(bytes, BASE);
        expect(findRecordHelpers(mem)).toEqual({ initializeRecord: IREC, finalizeRecord: FREC });

        const twisted = mem.slice();
        new DataView(twisted.buffer).setInt32(IREC + 0x21, FARR - (IREC + 0x25), true);
        expect(findRecordHelpers(twisted)).toBeNull();

        const noClr = mem.slice();
        noClr[LSTRCLR + 5] ^= 1;
        expect(findRecordHelpers(noClr)).toBeNull();

        const twoArrays = mem.slice();
        twoArrays.set(twoArrays.subarray(IARR, IARR + BODIES.InitializeArray.bytes.length), DATA + 0x200);
        expect(findRecordHelpers(twoArrays)).toBeNull();
    });

    test('every fixed byte of every body is load-bearing', () => {
        const { bytes } = buildImage({ filter: false });
        const mem = new Uint8Array(BASE + IMG);
        mem.set(bytes, BASE);
        for (const [name, body] of Object.entries(BODIES) as Array<[keyof typeof BODIES, (typeof BODIES)[keyof typeof BODIES]]>) {
            for (let k = 0; k < body.bytes.length; k++) {
                if (body.mask[k] !== 'x') continue;
                const m = mem.slice();
                m[AT[name] + k] ^= 0x01;
                expect(findRecordHelpers(m)).toBeNull();
            }
        }
    });

    test('lib-patcher accepts both record helpers\' prologues for its trampoline', () => {
        for (const body of [BODIES.InitializeRecord, BODIES.FinalizeRecord]) {
            expect(body.mask.slice(0, PROLOGUE_LEN)).toBe('x'.repeat(PROLOGUE_LEN));
            expect(validatePrologueBytes(body.bytes.subarray(0, PROLOGUE_LEN))).toBeNull();
        }
    });

    test('the filter reaches its trampoline from every decline branch', () => {
        for (const fin of [false, true]) {
            const code = assembleRecordFilter(0x1000, 0x2000, fin);
            const jmp = code.length - 5;
            expect(code[jmp]).toBe(0xe9);
            expect(new DataView(code.buffer).getInt32(jmp + 1, true)).toBe(0x2000 - (0x1000 + code.length));
            for (let k = 0; k < jmp; k++) {
                if (code[k] === 0x75) expect(k + 2 + code[k + 1]!).toBe(jmp);
            }
        }
    });
});

describe.skipIf(!HAVE_V86)('delphi-rtl record helpers, executed in v86', () => {
    test('original and filtered helpers leave the same machine state, and both match the model', async () => {
        const orig = await runArm({ filter: false });
        const filt = await runArm({ filter: true });
        expect(orig.found).toEqual({ initializeRecord: IREC, finalizeRecord: FREC });
        expect(modelProblems(orig)).toEqual([]);
        expect(modelProblems(filt)).toEqual([]);
        expect(contract(filt)).toEqual(contract(orig));
        expect(filt.data).toEqual(orig.data);
        expect(filt.frees).toEqual(orig.frees);
        expect(stringHeaders(orig)).toEqual([1, 0xffffffff]);
    }, 60000);

    test('the shapes the filters claim never reach the original bodies', async () => {
        const arm = await runArm({ filter: true, trapTrampolines: true, onlyFast: true });
        expect(modelProblems(arm, true)).toEqual([]);
    }, 30000);

    test('the filters, trampolines and stubs live in the thunk code area: a captured generator restores past them', async () => {
        const arm = await runArm({ filter: true });
        const size = (x: Patched) => assembleRecordFilter(0, 0, x.entry === FREC).length;
        const end = Math.max(...arm.patched.flatMap(x => [x.filter + size(x), x.trampoline + PROLOGUE_LEN + 5]));
        expect(arm.patched.every(x => x.filter >= FILTERS && x.trampoline >= FILTERS && x.filter < PF_HANDLER)).toBe(true);
        const restored = new ThunkGenerator();
        restored.restoreState(structuredClone(arm.generator!.captureState()));
        expect(restored.allocateRawCodeArea(16)).toBeGreaterThanOrEqual(end);
    }, 30000);

    test('a machine saved between calls and resumed in a fresh emulator keeps the filters: the rest of the scenario, claims and declines, matches the original', async () => {
        const orig = await runArm({ filter: false });
        for (const splitAt of [3, 6, 9]) {
            const resumed = await runArm({ filter: true, splitAt });
            expect(resumed.entryOps).toEqual([0xe9, 0xe9]);
            expect(modelProblems(resumed)).toEqual([]);
            expect(contract(resumed)).toEqual(contract(orig));
            expect(resumed.data).toEqual(orig.data);
            expect(resumed.frees).toEqual(orig.frees);
            const size = (x: Patched) => assembleRecordFilter(0, 0, x.entry === FREC).length;
            const end = Math.max(...resumed.patched.flatMap(x => [x.filter + size(x), x.trampoline + PROLOGUE_LEN + 5]));
            const next = resumed.generator!.allocateRawCodeArea(16);
            expect(next).toBeGreaterThanOrEqual(end);
            expect(next).toBeLessThan(PF_HANDLER);
        }
        const trapped = await runArm({ filter: true, trapTrampolines: true, onlyFast: true, splitAt: 4 });
        expect(modelProblems(trapped, true)).toEqual([]);
    }, 120000);

    test('a partial window left behind by another test does not reach the machine', async () => {
        const g = globalThis as { window?: unknown };
        const had = 'window' in g, saved = g.window;
        g.window = { addEventListener() { /* partial mock */ } };
        try {
            const arm = await runArm({ filter: true });
            expect(modelProblems(arm)).toEqual([]);
            expect((g.window as object)).toHaveProperty('addEventListener');
        } finally {
            if (had) g.window = saved; else delete g.window;
        }
    }, 30000);

    test('DF and the x87 control word, status word and stack top are what the scenario set before every call', async () => {
        const filt = await runArm({ filter: true });
        const first = filt.snaps.find(Boolean)!.machine;
        expect(first[0]).toBe(0);
        expect(first[1]).toBe(0x037f);
        for (const snap of filt.snaps) expect(snap.machine).toEqual(first);
    }, 30000);

    // A fault inside either arm is delivered for the SAME access: same faulting address, same
    // error code, nothing written before it. What differs, and is part of the stated contract:
    // the reported EIP (filter code instead of the RTL body) and the stack depth at the fault
    // (the filter pushes nothing; the original has pushed callee-saved registers and, below
    // _InitializeRecord/_FinalizeRecord, the return addresses of its nested calls).
    for (const kind of Object.keys(FAULTS) as FaultCase[]) {
        test(`a fault is the same access in both arms — ${kind}`, async () => {
            const orig = await runArm({ filter: false, fault: kind });
            const filt = await runArm({ filter: true, fault: kind });
            const want = FAULTS[kind];
            for (const arm of [orig, filt]) {
                expect(arm.halted).toBe(true);
                expect(arm.fault).toBeDefined();
                expect(arm.fault!.cr2).toBe(want.cr2);
                expect((arm.fault!.err & 2) !== 0).toBe(want.write);
                expect(arm.snaps.filter(Boolean)).toEqual([]);
            }
            expect(filt.fault!.err).toBe(orig.fault!.err);
            expect(filt.data).toEqual(orig.data);
            expect(filt.patched.some(x => filt.fault!.eip >= x.filter && filt.fault!.eip < x.filter + 0x40)).toBe(true);
            expect(orig.fault!.eip >= LSTRCLR && orig.fault!.eip < FARR + BODIES.FinalizeArray.bytes.length).toBe(true);
            expect(filt.fault!.esp).toBe(STACK - 4);
            expect(orig.fault!.esp).toBeLessThan(STACK - 4);
        }, 60000);
    }

    const MUTANTS: Array<{ name: string; mutate: (fin: boolean, code: Uint8Array) => void }> = [
        { name: 'the field-count test is dropped', mutate: (_f, c) => { c[9] = 0x90; c[10] = 0x90; } },
        { name: 'the long-string kind test is dropped', mutate: (_f, c) => { c[20] = 0x90; c[21] = 0x90; } },
        { name: 'finalize skips its nil test', mutate: (f, c) => { if (f) { c[38] = 0x90; c[39] = 0x90; } } },
        { name: 'initialize stores 1 instead of 0', mutate: (f, c) => { if (!f) c[37] = 1; } },
    ];
    for (const m of MUTANTS) {
        test(`negative control: a broken filter is caught — ${m.name}`, async () => {
            const orig = await runArm({ filter: false });
            const arm = await runArm({ filter: true, mutate: m.mutate });
            const same = JSON.stringify([contract(arm), arm.data, arm.frees]) === JSON.stringify([contract(orig), orig.data, orig.frees]);
            expect(same && modelProblems(arm).length === 0).toBe(false);
        }, 60000);
    }
});
