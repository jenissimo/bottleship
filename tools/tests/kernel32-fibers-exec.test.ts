// The fiber exports only rewrite registers, the TEB and a guest stack; whether a guest then
// really continues where it should is decided by the CPU. Here a small guest program runs in
// real v86 and calls the real kernel32 fiber exports through thunk-shaped stubs
// (MOV EAX,id / MOV EDX,port / OUT / RET n). The thread-exit stub has the scheduler's shape
// (PUSH EAX, then the trap) but is written by the test, with a HLT behind it.
//
// Scenario A: ConvertThreadToFiber, CreateFiber, first SwitchToFiber into the new fiber
// (start routine entered with its parameter, FiberData and the TEB stack bounds switched),
// back to the thread fiber (callee-saved registers and ESP restored), DeleteFiber of a fiber
// that never ran, a second switch that resumes the fiber behind its own SwitchToFiber call,
// and the start routine's return, which must reach the exit stub with its EAX as exit code.
// Scenario B: DeleteFiber on the running fiber ends the thread with exit code 1 and does not
// return to its caller.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { resetCpuViews } from '../../src/worker/core/cpu/cpu-views';
import { exports as fiberApi, resetFiberState } from '../../src/worker/modules/kernel32/fiber';
import { MOV_EAX_IMM32, MOV_EDX_IMM32, OUT_DX_EAX, THUNK_PORT } from '../../src/worker/core/thunking/thunk-constants';

const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const HAVE_V86 = existsSync(LIB) && existsSync(WASM);

const BASE = 0x400000, IMG = 0x3000, ENTRY = BASE + 0x40;
const START = BASE + 0x800, STUBS = BASE + 0x1000, RES = BASE + 0x2000;
const STACK = 0x200000, STACK_LIMIT = 0x100000, TEB = 0x300000, HEAP = 0x800000;
const CTL_PORT = 0xb0a0;
const MAIN_PARAM = 0x11112222, FIBER_PARAM = 0x33334444, EXIT_CODE = 0x77;
const EXIT_FID = 199;

const API = { ConvertThreadToFiber: 101, CreateFiber: 102, SwitchToFiber: 103, DeleteFiber: 104, CreateFiberEx: 105 } as const;
type ApiName = keyof typeof API;
const ARGC: Record<ApiName, number> = { ConvertThreadToFiber: 1, CreateFiber: 3, SwitchToFiber: 1, DeleteFiber: 1, CreateFiberEx: 5 };
const NAMES = Object.keys(API) as ApiName[];
const stubAddr = (name: ApiName) => STUBS + NAMES.indexOf(name) * 16;
const R = { main: RES, fiber: RES + 4, param: RES + 8, spare: RES + 12, deadSwitch: RES + 16, afterDelete: RES + 20 };
const sentinel = (reg: number, who: number) => (0x10000000 * (reg + 1) + who) >>> 0;

interface Snap { regs: number[]; fiberData: number; stackBase: number; stackLimit: number; seh: number; top: number[] }
interface Run { snaps: Record<number, Snap>; res: Record<keyof typeof R, number>; exits: number[]; halted: boolean; spareMagicBefore: number; spareMagicAfter: number; fiberStack: number[] }

function buildImage(scenario: 'A' | 'B'): Uint8Array {
    const mem = new Uint8Array(BASE + IMG);
    const dv = new DataView(mem.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + IMG, BASE + IMG, ENTRY]
        .forEach((v, i) => dv.setUint32(BASE + i * 4, v, true));
    for (const name of NAMES) {
        const fid = API[name];
        mem.set([MOV_EAX_IMM32, fid, 0, 0, 0, MOV_EDX_IMM32, THUNK_PORT & 0xff, (THUNK_PORT >> 8) & 0xff, 0, 0, OUT_DX_EAX,
            0xc2, ARGC[name] * 4, 0], stubAddr(name));
    }
    let p = ENTRY;
    const e = (...b: number[]) => { mem.set(b, p); p += b.length; };
    const u = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const call = (name: ApiName) => { e(0xe8); u(stubAddr(name) - (p + 4)); };
    const push = (v: number) => { e(0x68); u(v); };
    const pushMem = (a: number) => { e(0xff, 0x35); u(a); };
    const storeEax = (a: number) => { e(0xa3); u(a); };
    const snap = (i: number) => { e(0xb9); u(i); e(0xba); u(CTL_PORT); e(OUT_DX_EAX); };
    const regs = (who: number) => { e(0xbb); u(sentinel(0, who)); e(0xbe); u(sentinel(1, who)); e(0xbf); u(sentinel(2, who)); e(0xbd); u(sentinel(3, who)); };

    e(0xbc); u(STACK);
    push(MAIN_PARAM); call('ConvertThreadToFiber'); storeEax(R.main);
    push(FIBER_PARAM); push(START); push(0); call('CreateFiber'); storeEax(R.fiber);
    regs(1);
    pushMem(R.fiber); call('SwitchToFiber');
    snap(2);
    push(0); push(START); push(0); push(0x20000); push(0x1000); call('CreateFiberEx'); storeEax(R.spare);
    snap(3);
    pushMem(R.spare); call('DeleteFiber');
    snap(4);
    pushMem(R.spare); call('SwitchToFiber'); storeEax(R.deadSwitch);
    regs(3);
    pushMem(R.fiber); call('SwitchToFiber');
    e(0xf4);

    p = START;
    snap(1);
    e(0x8b, 0x44, 0x24, 0x04); storeEax(R.param);
    if (scenario === 'A') {
        regs(2);
        pushMem(R.main); call('SwitchToFiber');
        snap(5);
        e(0xb8); u(EXIT_CODE);
        e(0xc3);
    } else {
        e(0x64, 0xa1); u(0x10);
        e(0x50);
        call('DeleteFiber');
        e(0xc7, 0x05); u(R.afterDelete); u(0xbad);
        e(0xf4);
    }
    return mem.slice(BASE);
}

async function run(scenario: 'A' | 'B'): Promise<Run> {
    const g = globalThis as { window?: unknown };
    const hadWindow = 'window' in g, savedWindow = g.window;
    delete g.window;
    const system = System.getInstance() as any;
    const saved = { process: system.process, scheduler: system.scheduler };
    const { V86 } = await import(LIB);
    const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: WASM, log_level: 0, disable_jit: 1 });
    try {
        await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
        const cpu = em.v86.cpu;
        cpu.reboot_internal(); cpu.reset_memory();
        const mem = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
        const guest = () => new DataView(mem().buffer, mem().byteOffset);
        const u32 = (a: number) => guest().getUint32(a, true);
        resetCpuViews();
        Mem.bind(mem);

        let bump = HEAP;
        mem().fill(0xf4, HEAP, HEAP + 0x400000);
        const freed: number[] = [];
        let exitStub = 0, lastError = 0;
        const memory = {
            alloc: (size: number, _kind?: unknown, _prot?: unknown, align = 8) => {
                bump = (bump + align - 1) & ~(align - 1);
                const a = bump; bump += (size + 7) & ~7; return a;
            },
            free: (a: number) => { freed.push(a); },
        };
        system.process = { v86: em.v86, memory, resetGeneration: 0 };
        system.scheduler = {
            setLastError: (code: number) => { lastError = code; },
            getImageStackReserve: () => 0x40000,
            allocateStack: (size: number) => memory.alloc(size, undefined, undefined, 0x1000),
            releaseStackBlock: (a: number) => { freed.push(a); return true; },
            getThreadExitStubAddress: () => {
                if (!exitStub) {
                    exitStub = memory.alloc(16);
                    mem().set([0x50, MOV_EAX_IMM32, EXIT_FID, 0, 0, 0, MOV_EDX_IMM32, THUNK_PORT & 0xff, (THUNK_PORT >> 8) & 0xff, 0, 0, OUT_DX_EAX, 0xf4], exitStub);
                }
                return exitStub;
            },
        };
        resetFiberState();

        cpu.load_multiboot(buildImage(scenario).buffer);
        guest().setUint32(TEB + 0x00, 0x5eeeeee0, true);
        guest().setUint32(TEB + 0x04, STACK, true);
        guest().setUint32(TEB + 0x08, STACK_LIMIT, true);
        cpu.segment_offsets[4] = TEB;

        const exits: number[] = [];
        let spareMagicBefore = 0, spareMagicAfter = 0;
        const fiberStack: number[] = [];
        cpu.io.register_write(THUNK_PORT, null, undefined, undefined, (fid: number) => {
            const esp = cpu.reg32[4] >>> 0;
            if (fid === EXIT_FID) { exits.push(u32(esp)); return; }
            const name = NAMES.find(n => API[n] === fid);
            if (!name) throw new Error(`unexpected thunk ${fid}`);
            const args = Array.from({ length: ARGC[name] }, (_, i) => u32(esp + 4 + i * 4));
            const r = (fiberApi[name] as any)({}, mem(), args);
            cpu.reg32[0] = (typeof r === 'number' ? r : r.value) | 0;
            if (name === 'CreateFiber') fiberStack.push(u32(cpu.reg32[0] + 0x0c), u32(cpu.reg32[0] + 0x08));
        });
        const snaps: Record<number, Snap> = {};
        cpu.io.register_write(CTL_PORT, null, undefined, undefined, () => {
            const i = cpu.reg32[1] >>> 0;
            const r = cpu.reg32, esp = r[4] >>> 0;
            snaps[i] = {
                regs: [r[3], r[6], r[7], r[5], r[4]].map((v: number) => v >>> 0),
                fiberData: u32(TEB + 0x10), stackBase: u32(TEB + 0x04), stackLimit: u32(TEB + 0x08), seh: u32(TEB),
                top: [u32(esp), u32(esp + 4)],
            };
            if (i === 3) spareMagicBefore = u32(u32(R.spare) + 0x24);
            if (i === 4) spareMagicAfter = u32(u32(R.spare) + 0x24);
        });

        const halted = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => { em.stop(); resolve(false); }, 10000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve(true); });
            cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2;
            em.run();
        });
        const res = Object.fromEntries(Object.entries(R).map(([k, a]) => [k, u32(a)])) as Run['res'];
        void lastError; void freed;
        return { snaps, res, exits, halted, spareMagicBefore, spareMagicAfter, fiberStack };
    } finally {
        await em.destroy();
        system.process = saved.process; system.scheduler = saved.scheduler;
        resetFiberState();
        resetCpuViews();
        if (hadWindow) g.window = savedWindow;
    }
}

describe.skipIf(!HAVE_V86)('fibers executed in v86', () => {
    test('first switch, switch back, DeleteFiber of an idle fiber, resume, return into the exit stub', async () => {
        const r = await run('A');
        expect(r.halted).toBe(true);
        const [limit, base] = r.fiberStack as [number, number];
        expect(base - limit).toBe(0x40000);

        const first = r.snaps[1]!;
        expect(first.fiberData).toBe(r.res.fiber);
        expect([first.stackLimit, first.stackBase, first.seh]).toEqual([limit, base, 0xffffffff]);
        expect(first.regs[4]).toBe(base - 8);
        expect(first.top[1]).toBe(FIBER_PARAM);
        expect(r.res.param).toBe(FIBER_PARAM);

        const back = r.snaps[2]!;
        expect(back.regs).toEqual([sentinel(0, 1), sentinel(1, 1), sentinel(2, 1), sentinel(3, 1), STACK]);
        expect([back.fiberData, back.stackBase, back.stackLimit, back.seh]).toEqual([r.res.main, STACK, STACK_LIMIT, 0x5eeeeee0]);

        expect(r.res.spare).not.toBe(0);
        expect(r.spareMagicBefore).not.toBe(0);
        expect(r.spareMagicAfter).toBe(0);
        expect(r.snaps[4]!.regs[4]).toBe(STACK);
        expect(r.res.deadSwitch).toBe(0);

        const resumed = r.snaps[5]!;
        expect(resumed.regs.slice(0, 4)).toEqual([sentinel(0, 2), sentinel(1, 2), sentinel(2, 2), sentinel(3, 2)]);
        expect(resumed.regs[4]).toBe(base - 8);
        expect(resumed.fiberData).toBe(r.res.fiber);
        expect(r.exits).toEqual([EXIT_CODE]);
        expect(r.res.afterDelete).toBe(0);
    }, 30000);

    test('DeleteFiber on the running fiber ends the thread with exit code 1', async () => {
        const r = await run('B');
        expect(r.halted).toBe(true);
        expect(r.snaps[1]!.fiberData).toBe(r.res.fiber);
        expect(r.exits).toEqual([1]);
        expect(r.res.afterDelete).toBe(0);
        expect(r.snaps[2]).toBeUndefined();
    }, 30000);
});
