// Function units (#105 baseline oracle) through the host's real owners. v86 owns admission,
// execution, exits and table/code lifetime; these checks only drive it the way the host does:
// the harness verbs on a live instance, a JS patch of an already-compiled unit through
// writeGuestCode, a fresh instance, a savestate safe point restored into a fresh instance,
// and fiber switches through thunk-shaped stubs while units run on both stacks.
//
// Every guest program also runs with units off; both arms must equal an expected value
// computed here. Guest functions live on pages the caller's modules may not absorb, so every
// direct CALL reaches the dispatcher.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { resetCpuViews } from '../../src/worker/core/cpu/cpu-views';
import { preemptionManager } from '../../src/worker/core/cpu/preemption-manager';
import { resetGuestCodeInvalidationState, writeGuestCode } from '../../src/worker/core/memory/guest-code';
import { exports as fiberApi, resetFiberState } from '../../src/worker/modules/kernel32/fiber';
import { MOV_EAX_IMM32, MOV_EDX_IMM32, OUT_DX_EAX, THUNK_PORT } from '../../src/worker/core/thunking/thunk-constants';
import { captureCpu, restoreCpu } from '../../src/worker/savestate/participants/cpu';
import { registerFnUnitCommands, summarizeFnUnit, FN_UNIT_STAT_NAMES, FN_UNIT_CHAIN_COUNTER_NAMES } from '../../src/worker/harness/cmds/fn-unit';

const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const HAVE_V86 = existsSync(LIB) && existsSync(WASM);

const BASE = 0x400000, IMG = 0x8000, ENTRY = BASE + 0x40;
const FN = BASE + 0x2000, FN_END = BASE + 0x6000, GET = BASE + 0x3000, STUBS = BASE + 0x6000;
const STACK = 0x200000, FIBER_STACKS = 0x800000, TEB = 0x300000, HEAP = 0xa00000, RES = 0x380000;
const CTL_PORT = 0xb0a0;
const ITER = 60000, SUM_N = 37, LONG_N = 300000, FIBER_LONG_N = 30000;
const S = Object.fromEntries(FN_UNIT_STAT_NAMES.map((n, i) => [n, i])) as Record<(typeof FN_UNIT_STAT_NAMES)[number], number>;

const rol = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;
function sum(n: number): number { let a = 0; for (let c = n; c > 0; c--) { a = (a + c) >>> 0; a = rol(a, 3); } return a; }

class Asm {
    p: number;
    constructor(public mem: Uint8Array, at: number) { this.p = at; }
    e(...b: number[]) { for (const x of b) this.mem[this.p++] = x & 0xff; return this; }
    u(v: number) { new DataView(this.mem.buffer).setUint32(this.p, v >>> 0, true); this.p += 4; return this; }
    call(t: number) { return this.e(0xe8).u(t - (this.p + 4)); }
    jnz(t: number) { return this.e(0x0f, 0x85).u(t - (this.p + 4)); }
    ctl(i: number) { return this.e(0xb9).u(i).e(0xba).u(CTL_PORT).e(OUT_DX_EAX); }
}

function header(mem: Uint8Array) {
    const dv = new DataView(mem.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + IMG, BASE + IMG, ENTRY]
        .forEach((v, i) => dv.setUint32(BASE + i * 4, v, true));
}

/** sum(n): stdcall loop leaf, ret 4. get(): mov eax, imm32; ret. */
function functions(mem: Uint8Array) {
    const f = new Asm(mem, FN);
    f.e(0x55, 0x8b, 0xec, 0x8b, 0x4d, 0x08, 0x31, 0xc0);
    const l = f.p;
    f.e(0x01, 0xc8, 0xc1, 0xc0, 0x03, 0x49);
    f.e(0x75, (l - (f.p + 2)) & 0xff);
    f.e(0x5d, 0xc2, 0x04, 0x00);
    new Asm(mem, GET).e(0xb8).u(0x11).e(0xc3);
}

/** Phase 1 and 2 each call sum(SUM_N) and get() ITER times, separated by checkpoint 1, then one long sum. */
function mainImage(withHalt: boolean): Uint8Array {
    const mem = new Uint8Array(BASE + IMG);
    header(mem);
    functions(mem);
    const a = new Asm(mem, ENTRY);
    a.e(0xbc).u(STACK).e(0x31, 0xff);
    const phase = () => {
        a.e(0xb9).u(ITER);
        const top = a.p;
        a.e(0x51, 0x6a, SUM_N).call(FN).e(0x01, 0xc7).call(GET).e(0x01, 0xc7, 0x59, 0x49).jnz(top);
    };
    phase();
    a.ctl(1);
    if (withHalt) a.e(0xf4);
    phase();
    a.e(0x68).u(LONG_N).call(FN).e(0x01, 0xc7);
    a.e(0x89, 0x3d).u(RES);
    a.ctl(2);
    a.e(0xf4);
    return mem.slice(BASE);
}

function expectedMain(get2: number, get1 = 0x11): number {
    let edi = 0;
    for (let c = 0; c < ITER; c++) edi = (edi + sum(SUM_N) + get1) >>> 0;
    for (let c = 0; c < ITER; c++) edi = (edi + sum(SUM_N) + get2) >>> 0;
    return (edi + sum(LONG_N)) >>> 0;
}

interface Machine { em: any; cpu: any; w: any; mem: () => Uint8Array; u32: (a: number) => number; stats: () => Record<string, number> }

async function machine(units: boolean, chain = 0): Promise<Machine> {
    const { V86 } = await import(LIB);
    const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: WASM, log_level: 0, disable_jit: 0 });
    await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
    const cpu = em.v86.cpu, w = cpu.wm.exports;
    cpu.reboot_internal(); cpu.reset_memory();
    const mem = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
    const u32 = (a: number) => new DataView(mem().buffer, mem().byteOffset).getUint32(a, true);
    w.jit_set_region_exclusion(FN, FN_END);
    w.fn_unit_set_threshold(4);
    w.fn_unit_set_mutation(+(process.env.FN_UNIT_MUTATION ?? 0));
    if (units) { w.fn_census_set_enabled(1); w.fn_unit_set_enabled(1); }
    if (chain) { w.fn_unit_set_chain(chain); w.fn_unit_set_chain_counting(1); }
    const stats = () => Object.fromEntries([
        ...FN_UNIT_STAT_NAMES.map((n, i) => [n, w.fn_unit_stat(i)]),
        ...FN_UNIT_CHAIN_COUNTER_NAMES.map((n, i) => [`chain.${n}`, w.fn_unit_chain_counter(i) >>> 0]),
    ]);
    return { em, cpu, w, mem, u32, stats };
}

function runToHalt(m: Machine, start?: () => void, ms = 20000): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { m.em.stop(); if (process.env.UDBG) console.error('TIMEOUT eip', (m.cpu.instruction_pointer[0] >>> 0).toString(16), 'esp', (m.cpu.reg32[4] >>> 0).toString(16), 'edi', m.cpu.reg32[7] >>> 0, 'hlt', m.cpu.in_hlt[0], 'ecx', m.cpu.reg32[1]); resolve(false); }, ms);
        const onHalt = () => { clearTimeout(timer); m.em.bus.unregister('cpu-event-halt', onHalt); m.em.stop(); resolve(true); };
        m.em.bus.register('cpu-event-halt', onHalt);
        start?.();
        m.em.run();
    });
}

async function withoutWindow<T>(f: () => Promise<T>): Promise<T> {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g, saved = g.window;
    delete g.window;
    try { return await f(); } finally { if (had) g.window = saved; resetCpuViews(); }
}

function verbs(cpuObj: unknown) {
    const system = System.getInstance() as any;
    const saved = system.process;
    system.process = { v86: { cpu: cpuObj } };
    const handlers = new Map<string, (a: unknown[]) => any>();
    registerFnUnitCommands({ register: (n: string, f: (a: unknown[]) => unknown) => handlers.set(n, f) } as never);
    return { call: (n: string, ...a: unknown[]) => handlers.get(n)!(a), restore: () => { system.process = saved; } };
}

describe('fnUnit verbs', () => {
    test('missing exports are unavailable, not zero', () => {
        const v = verbs({ wm: { exports: { fn_census_enabled: () => 1 } } });
        try { expect(() => v.call('fnUnitStatus')).toThrow('unavailable'); } finally { v.restore(); }
    });
    test('status counters are checked for consistency', () => {
        const s = summarizeFnUnit({ exportsId: 1, enabled: 1, censusEnabled: 0, threshold: 4, units: 0, stats: [3, 1, 1] });
        expect(s.problems).toContain('matched + exited != entries');
        expect(s.problems.some(p => p.includes('census is off'))).toBe(true);
        expect(s.matchedShare).toBeCloseTo(1 / 3);
        expect(s.chain).toBe('off');
        const c = summarizeFnUnit({ exportsId: 1, enabled: 1, censusEnabled: 1, threshold: 4, units: 0, stats: [], chain: 2, depth: 3 });
        expect(c.chain).toBe('private');
        expect(c.problems.some(p => p.includes('chain depth 3'))).toBe(true);
    });
});

describe.skipIf(!HAVE_V86)('function units in v86 through the host', () => {
    test('verbs on a live instance: census required, enable, status, reset; default off', async () => withoutWindow(async () => {
        const m = await machine(false);
        const v = verbs(m.cpu);
        try {
            expect(v.call('fnUnitStatus').enabled).toBe(false);
            expect(() => v.call('fnUnitEnable', {})).toThrow('fnCensusArm');
            expect(() => v.call('fnUnitEnable', { threshold: 0 })).toThrow();
            m.w.fn_census_set_enabled(1);
            const on = v.call('fnUnitEnable', { threshold: 4 });
            expect([on.enabled, on.threshold]).toEqual([true, 4]);
            m.cpu.load_multiboot(mainImage(false).buffer);
            expect(await runToHalt(m, () => { m.cpu.reg32[4] = STACK; m.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
            const st = v.call('fnUnitStatus');
            expect(st.problems).toEqual([]);
            expect(st.units).toBeGreaterThan(0);
            expect(st.stats.entries).toBeGreaterThan(ITER);
            expect(m.u32(RES)).toBe(expectedMain(0x11));
            const r = v.call('fnUnitReset');
            expect([r.units, r.stats.entries, r.enabled]).toEqual([0, 0, true]);
            expect(v.call('fnUnitEnable', { on: false }).enabled).toBe(false);
        } finally { v.restore(); await m.em.destroy(); }
    }), 60000);

    for (const units of [false, true]) test(`writeGuestCode patches an already-compiled unit (units ${units ? 'on' : 'off'})`, async () => withoutWindow(async () => {
        const m = await machine(units);
        const saved = (preemptionManager as unknown as { wasmExports: unknown }).wasmExports;
        (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = m.w;
        resetGuestCodeInvalidationState();
        let before: Record<string, number> = {}, slot = -1;
        try {
            Mem.bind(m.mem);
            m.cpu.load_multiboot(mainImage(false).buffer);
            m.cpu.io.register_write(CTL_PORT, null, undefined, undefined, () => {
                if ((m.cpu.reg32[1] >>> 0) !== 1) return;
                before = m.stats();
                slot = m.w.fn_unit_slot(GET) >>> 0;
                expect(writeGuestCode(m.mem(), new Uint8Array([0x22]), GET + 1)).toBe(true);
            });
            expect(await runToHalt(m, () => { m.cpu.reg32[4] = STACK; m.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
            expect(m.u32(RES)).toBe(expectedMain(0x22));
            const after = m.stats();
            if (units) {
                expect(slot).not.toBe(0xffffffff);
                expect(after.invalidated! - before.invalidated!).toBeGreaterThanOrEqual(1);
                expect(after.published!).toBeGreaterThan(before.published!);
                expect(after.matched! + after.exited!).toBe(after.entries!);
                expect(after.exited).toBe(1);
            }
            else expect(Object.values(after).every(x => x === 0)).toBe(true);
        } finally {
            (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = saved;
            resetGuestCodeInvalidationState();
            await m.em.destroy();
        }
    }), 60000);

    for (const units of [false, true]) test(`a unit storing into the instruction it executes next leaves through the active-code-write exit (units ${units ? 'on' : 'off'})`, async () => withoutWindow(async () => {
        const AHEAD = BASE + 0x4000, N = 2000000;
        const mem = new Uint8Array(BASE + IMG);
        header(mem);
        functions(mem);
        new Asm(mem, AHEAD).e(0xf7, 0xc1).u(0x3ffff).e(0x75, 0x06, 0x89, 0x0d).u(AHEAD + 15).e(0xb8).u(0x5555).e(0xc3);
        const a = new Asm(mem, ENTRY);
        a.e(0xbc).u(STACK).e(0x31, 0xff).e(0xb9).u(N);
        const top = a.p;
        a.e(0x51).call(AHEAD).e(0x01, 0xc7, 0x59, 0x49).jnz(top);
        a.e(0x89, 0x3d).u(RES).e(0xf4);
        let want = 0, prev = 0x5555;
        for (let c = N; c > 0; c--) { if ((c & 0x3ffff) === 0) prev = c; want = (want + prev) % 2 ** 32; }
        const m = await machine(units);
        try {
            m.cpu.load_multiboot(mem.slice(BASE).buffer);
            expect(await runToHalt(m, () => { m.cpu.reg32[4] = STACK; m.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
            expect(m.u32(RES)).toBe(want);
            const st = m.stats();
            if (units) {
                expect(st.published!).toBeGreaterThan(0);
                expect(st.exited!).toBeGreaterThan(0);
                expect(st.matched! + st.exited!).toBe(st.entries!);
            }
        } finally { await m.em.destroy(); }
    }), 60000);

    test('a fresh instance starts with units off and nothing carried over', async () => withoutWindow(async () => {
        const a = await machine(true);
        a.cpu.load_multiboot(mainImage(false).buffer);
        expect(await runToHalt(a, () => { a.cpu.reg32[4] = STACK; a.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
        expect(a.w.fn_unit_count() >>> 0).toBeGreaterThan(0);
        const { V86 } = await import(LIB);
        const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: WASM, log_level: 0, disable_jit: 0 });
        await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
        const w = em.v86.cpu.wm.exports;
        expect([w.fn_unit_enabled() >>> 0, w.fn_unit_count() >>> 0, w.fn_unit_stat(S.entries)]).toEqual([0, 0, 0]);
        await em.destroy(); await a.em.destroy();
    }), 60000);

    test('a host savestate taken at a safe point restores over live units', async () => withoutWindow(async () => {
        const src = await machine(true);
        src.cpu.load_multiboot(mainImage(true).buffer);
        expect(await runToHalt(src, () => { src.cpu.reg32[4] = STACK; src.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
        expect(src.w.fn_unit_count() >>> 0).toBeGreaterThan(0);
        const cpuState = captureCpu(src.cpu);
        const ram = src.mem().slice();
        src.cpu.in_hlt[0] = 0;
        expect(await runToHalt(src)).toBe(true);
        const continued = src.u32(RES);
        await src.em.destroy();

        const dst = await machine(true);
        const other = mainImage(false);
        new Asm(other, GET - BASE + 1).u(0x33);
        dst.cpu.load_multiboot(other.buffer);
        expect(await runToHalt(dst, () => { dst.cpu.reg32[4] = STACK; dst.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
        expect(dst.u32(RES)).toBe(expectedMain(0x33, 0x33));
        expect(dst.w.fn_unit_count() >>> 0).toBeGreaterThan(0);
        const publishedBefore = dst.stats().published!;
        dst.mem().set(ram);
        restoreCpu(dst.cpu, cpuState);
        expect(dst.w.fn_unit_count() >>> 0).toBe(0);
        dst.cpu.in_hlt[0] = 0;
        expect(await runToHalt(dst)).toBe(true);
        expect([continued, dst.u32(RES)]).toEqual([expectedMain(0x11), expectedMain(0x11)]);
        const st = dst.stats();
        expect(st.published!).toBeGreaterThan(publishedBefore);
        expect(st.matched! + st.exited!).toBe(st.entries!);
        await dst.em.destroy();
    }), 60000);

    for (const [units, chain] of [[false, 0], [true, 0], [true, 2]] as const) test(`fiber switches through thunk stubs while units run on both stacks (units ${units ? 'on' : 'off'}, chain ${chain})`, async () => withoutWindow(async () => {
        const API = { ConvertThreadToFiber: 101, CreateFiber: 102, SwitchToFiber: 103 } as const;
        const ARGC = { ConvertThreadToFiber: 1, CreateFiber: 3, SwitchToFiber: 1 } as const;
        const names = Object.keys(API) as (keyof typeof API)[];
        const stub = (n: keyof typeof API) => STUBS + names.indexOf(n) * 16;
        const MAIN = RES + 0x10, FIB = RES + 0x14, FSUM = RES + 0x18, ROUNDS = 400, PER = 150;
        const mem = new Uint8Array(BASE + IMG);
        header(mem);
        functions(mem);
        for (const n of names) mem.set([MOV_EAX_IMM32, API[n], 0, 0, 0, MOV_EDX_IMM32, THUNK_PORT & 0xff, (THUNK_PORT >> 8) & 0xff, 0, 0, OUT_DX_EAX, 0xc2, ARGC[n] * 4, 0], stub(n));
        const a = new Asm(mem, ENTRY);
        a.e(0xbc).u(STACK).e(0x31, 0xff);
        a.e(0x6a, 0).call(stub('ConvertThreadToFiber')).e(0xa3).u(MAIN);
        const START = BASE + 0x1000;
        a.e(0x6a, 0, 0x68).u(START).e(0x6a, 0).call(stub('CreateFiber')).e(0xa3).u(FIB);
        a.e(0xbe).u(ROUNDS);
        const outer = a.p;
        a.e(0xb9).u(PER);
        const inner = a.p;
        a.e(0x51, 0x6a, SUM_N).call(FN).e(0x01, 0xc7, 0x59, 0x49).jnz(inner);
        a.e(0xff, 0x35).u(FIB).call(stub('SwitchToFiber'));
        a.e(0x4e).jnz(outer);
        a.e(0x89, 0x3d).u(RES).e(0xf4);
        const b = new Asm(mem, START);
        b.e(0x31, 0xdb);
        const loop = b.p;
        b.e(0xb9).u(PER);
        const bi = b.p;
        b.e(0x51, 0x6a, SUM_N).call(FN).e(0x01, 0xc3).call(GET).e(0x01, 0xc3, 0x59, 0x49).jnz(bi);
        b.e(0x68).u(FIBER_LONG_N).call(FN).e(0x01, 0xc3);
        b.e(0x89, 0x1d).u(FSUM);
        b.e(0xff, 0x35).u(MAIN).call(stub('SwitchToFiber'));
        b.e(0xeb, (loop - (b.p + 2)) & 0xff);

        const m = await machine(units, chain);
        const system = System.getInstance() as any;
        const saved = { process: system.process, scheduler: system.scheduler };
        try {
            Mem.bind(m.mem);
            let bump = HEAP;
            const memory = { alloc: (size: number, _k?: unknown, _p?: unknown, align = 8) => { bump = (bump + align - 1) & ~(align - 1); const r = bump; bump += (size + 7) & ~7; return r; }, free: () => {} };
            let fstack = FIBER_STACKS;
            system.process = { v86: m.em.v86, memory, resetGeneration: 0 };
            system.scheduler = {
                setLastError: () => {}, getImageStackReserve: () => 0x40000,
                allocateStack: (size: number) => { fstack += size; return fstack - size; },
                releaseStackBlock: () => true, getThreadExitStubAddress: () => STUBS + 0x100,
            };
            resetFiberState();
            m.cpu.load_multiboot(mem.slice(BASE).buffer);
            const dv = () => new DataView(m.mem().buffer, m.mem().byteOffset);
            dv().setUint32(TEB + 4, STACK, true); dv().setUint32(TEB + 8, 0x100000, true);
            m.cpu.segment_offsets[4] = TEB;
            m.cpu.io.register_write(THUNK_PORT, null, undefined, undefined, (fid: number) => {
                const esp = m.cpu.reg32[4] >>> 0;
                const n = names.find(x => API[x] === fid)!;
                const args = Array.from({ length: ARGC[n] }, (_, i) => m.u32(esp + 4 + i * 4));
                const r = (fiberApi[n] as any)({}, m.mem(), args);
                m.cpu.reg32[0] = (typeof r === 'number' ? r : r.value) | 0;
            });
            expect(await runToHalt(m, () => { m.cpu.reg32[4] = STACK; m.cpu.instruction_pointer[0] = ENTRY; m.cpu.flags[0] = 2; }, 40000)).toBe(true);
            const s = sum(SUM_N);
            expect(m.u32(RES)).toBe((ROUNDS * PER * s) % 2 ** 32);
            expect(m.u32(FSUM)).toBe((ROUNDS * PER * (s + 0x11) + ROUNDS * sum(FIBER_LONG_N)) % 2 ** 32);
            const st = m.stats();
            if (units) {
                expect(st.entries!).toBeGreaterThan(ROUNDS * PER);
                expect(st.matched! + st.exited!).toBe(st.entries!);
                expect(st.exited!).toBeGreaterThanOrEqual(1);
            }
            else expect(st.entries).toBe(0);
        } finally {
            system.process = saved.process; system.scheduler = saved.scheduler;
            resetFiberState();
            await m.em.destroy();
        }
    }), 90000);

    /** pair(n) = sum(n) + get(): a unit whose two direct calls go to units. */
    const PAIR = BASE + 0x5000;
    function chainImage(withHalt: boolean): Uint8Array {
        const mem = new Uint8Array(BASE + IMG);
        header(mem);
        functions(mem);
        const p = new Asm(mem, PAIR);
        p.e(0x55, 0x8b, 0xec, 0x53, 0xff, 0x75, 0x08).call(FN).e(0x89, 0xc3).call(GET).e(0x01, 0xd8, 0x5b, 0x5d, 0xc2, 0x04, 0x00);
        const a = new Asm(mem, ENTRY);
        a.e(0xbc).u(STACK).e(0x31, 0xff);
        const phase = () => {
            a.e(0xb9).u(ITER);
            const top = a.p;
            a.e(0x51, 0x6a, SUM_N).call(PAIR).e(0x01, 0xc7, 0x59, 0x49).jnz(top);
        };
        phase();
        a.ctl(1);
        if (withHalt) a.e(0xf4);
        phase();
        a.e(0x68).u(LONG_N).call(PAIR).e(0x01, 0xc7);
        a.e(0x89, 0x3d).u(RES);
        a.ctl(2);
        a.e(0xf4);
        return mem.slice(BASE);
    }
    const expectedChain = (get2: number, get1 = 0x11) => (expectedMain(get2, get1) + get2) >>> 0;

    test('chain verbs: modes, and-esp, counting, status; each switch frees the units', async () => withoutWindow(async () => {
        const m = await machine(false);
        const v = verbs(m.cpu);
        try {
            const st0 = v.call('fnUnitStatus');
            expect([st0.chain, st0.andEsp, st0.chainDepth]).toEqual(['off', false, 0]);
            m.w.fn_census_set_enabled(1);
            expect(() => v.call('fnUnitEnable', { chain: 'fast' })).toThrow('chain must be');
            const on = v.call('fnUnitEnable', { threshold: 4, chain: 'private', andEsp: true, counting: true });
            expect([on.enabled, on.chain, on.andEsp]).toEqual([true, 'private', true]);
            m.cpu.load_multiboot(chainImage(false).buffer);
            expect(await runToHalt(m, () => { m.cpu.reg32[4] = STACK; m.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
            expect(m.u32(RES)).toBe(expectedChain(0x11));
            const st = v.call('fnUnitStatus');
            expect(st.problems).toEqual([]);
            expect(st.chainCounters.calls).toBeGreaterThan(ITER);
            expect(st.chainCounters.retMatched).toBeGreaterThan(ITER);
            expect(st.stats.chainSites).toBeGreaterThanOrEqual(2);
            expect(st.units).toBeGreaterThan(0);
            const canon = v.call('fnUnitEnable', { chain: 'canonical' });
            expect([canon.chain, canon.units]).toEqual(['canonical', 0]);
            const off = v.call('fnUnitEnable', { on: false, chain: 'off', andEsp: false, counting: false });
            expect([off.enabled, off.chain, off.andEsp, off.units]).toEqual([false, 'off', false, 0]);
        } finally { v.restore(); await m.em.destroy(); }
    }), 60000);

    for (const chain of [0, 1, 2]) test(`writeGuestCode patches a chained callee; its caller is dropped and chains again (chain ${chain})`, async () => withoutWindow(async () => {
        const m = await machine(chain !== 0, chain);
        const saved = (preemptionManager as unknown as { wasmExports: unknown }).wasmExports;
        (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = m.w;
        resetGuestCodeInvalidationState();
        let before: Record<string, number> = {};
        try {
            Mem.bind(m.mem);
            m.cpu.load_multiboot(chainImage(false).buffer);
            m.cpu.io.register_write(CTL_PORT, null, undefined, undefined, () => {
                if ((m.cpu.reg32[1] >>> 0) !== 1) return;
                before = m.stats();
                expect(writeGuestCode(m.mem(), new Uint8Array([0x22]), GET + 1)).toBe(true);
            });
            expect(await runToHalt(m, () => { m.cpu.reg32[4] = STACK; m.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
            expect(m.u32(RES)).toBe(expectedChain(0x22));
            const after = m.stats();
            expect(m.w.fn_unit_chain_depth() >>> 0).toBe(0);
            if (chain) {
                expect(after.chainDependantsDropped! - before.chainDependantsDropped!).toBeGreaterThanOrEqual(1);
                expect(after['chain.calls']! - before['chain.calls']!).toBeGreaterThan(ITER);
                expect(after['chain.fallbackToken']! - before['chain.fallbackToken']!).toBeLessThan(64);
                expect(after.matched! + after.exited!).toBe(after.entries!);
            }
            else expect(after['chain.calls']).toBe(0);
        } finally {
            (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = saved;
            resetGuestCodeInvalidationState();
            await m.em.destroy();
        }
    }), 60000);

    test('a host savestate taken at a safe point restores over live chained units', async () => withoutWindow(async () => {
        const src = await machine(true, 2);
        src.cpu.load_multiboot(chainImage(true).buffer);
        expect(await runToHalt(src, () => { src.cpu.reg32[4] = STACK; src.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
        expect(src.w.fn_unit_count() >>> 0).toBeGreaterThan(0);
        const cpuState = captureCpu(src.cpu);
        const ram = src.mem().slice();
        src.cpu.in_hlt[0] = 0;
        expect(await runToHalt(src)).toBe(true);
        const continued = src.u32(RES);
        await src.em.destroy();

        const dst = await machine(true, 2);
        const other = chainImage(false);
        new Asm(other, GET - BASE + 1).u(0x33);
        dst.cpu.load_multiboot(other.buffer);
        expect(await runToHalt(dst, () => { dst.cpu.reg32[4] = STACK; dst.cpu.instruction_pointer[0] = ENTRY; })).toBe(true);
        expect(dst.u32(RES)).toBe(expectedChain(0x33, 0x33));
        const callsBefore = dst.stats()['chain.calls']!;
        dst.mem().set(ram);
        restoreCpu(dst.cpu, cpuState);
        expect(dst.w.fn_unit_count() >>> 0).toBe(0);
        dst.cpu.in_hlt[0] = 0;
        expect(await runToHalt(dst)).toBe(true);
        expect([continued, dst.u32(RES)]).toEqual([expectedChain(0x11), expectedChain(0x11)]);
        expect(dst.stats()['chain.calls']!).toBeGreaterThan(callsBefore);
        expect(dst.w.fn_unit_chain_depth() >>> 0).toBe(0);
        await dst.em.destroy();
    }), 60000);
});
