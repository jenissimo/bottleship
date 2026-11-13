// The kernel32 TEB stubs (kernel32/teb-stubs.ts) answer GetLastError/SetLastError and the
// Tls/Fls Get/Set pairs in guest code through FS, while the JS handlers answer the same
// calls through the TebManager. Both must be ONE store per thread. The same script — guest
// calls interleaved with JS handler calls and thread switches — runs in real v86 twice:
// through the stubs, and through plain OUT-trap stubs that reach the JS handlers. Every
// result, every TEB field and the stack must agree, and both are checked against explicit
// expectations so the two arms cannot be wrong together. The trap arm is the negative
// control: without the stubs every call is a crossing.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Scheduler } from '../../src/worker/core/scheduler/scheduler';
import { ThreadState, type Thread } from '../../src/worker/core/scheduler/types';
import { System } from '../../src/worker/core/system';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';
import { writeTebStubs, type TebStubName } from '../../src/worker/modules/kernel32/teb-stubs';
import { exports as errorApi } from '../../src/worker/modules/kernel32/error';
import { exports as tlsApi } from '../../src/worker/modules/kernel32/tls';
import { exports as flsApi, resetFlsState } from '../../src/worker/modules/kernel32/fls';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';

const lib = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const wasm = fileURLToPath(new URL('../../public/v86.wasm', import.meta.url));

const BASE = 0x400000, ENTRY = BASE + 0x40, STUBS = BASE + 0x4000, RES = BASE + 0x6000, IMG = 0x8000;
const RES_ESP = RES + 0x800, REGS = RES + 0x1000, STACK = 0x200000, HEAP = 0x800000, CTL = 0x900;
/** Callee-saved EBX/ESI/EDI/EBP seeded before every call; a stub must hand them back. */
const sentinels = (k: number) => [0x11110000 + k, 0x22220000 + k, 0x33330000 + k, 0x44440000 + k];

type Api = 'GetLastError' | 'SetLastError' | 'TlsGetValue' | 'TlsSetValue' | 'FlsGetValue' | 'FlsSetValue';
const API: Record<Api, { fid: number; pop: number; stub: TebStubName }> = {
    GetLastError: { fid: 101, pop: 0, stub: 'getLastErrorStub' },
    SetLastError: { fid: 102, pop: 4, stub: 'setLastErrorStub' },
    TlsGetValue: { fid: 103, pop: 4, stub: 'tlsGetValueStub' },
    TlsSetValue: { fid: 104, pop: 8, stub: 'tlsSetValueStub' },
    FlsGetValue: { fid: 105, pop: 4, stub: 'flsGetValueStub' },
    FlsSetValue: { fid: 106, pop: 8, stub: 'flsSetValueStub' },
};

interface Env { s: Scheduler; switchTo(tid: number): number }
type Step =
    | { call: Api; args: number[]; want?: number }      // want undefined: void API, EAX not compared
    | { js: string; run(env: Env): number; want: number };

const js = (label: string, want: number, run: (env: Env) => number): Step => ({ js: label, run, want });
const jsApi = (fn: (mem: Uint8Array, args: number[]) => unknown) => (args: number[]) => () => Number(fn(new Uint8Array(0), args)) >>> 0;
const jsSetLastError = jsApi((m, a) => errorApi.SetLastError!(null as never, m, a));
const jsGetLastError = jsApi((m, a) => errorApi.GetLastError!(null as never, m, a));

const SCRIPT: Step[] = [
    js('JS SetLastError(0x1234)', 0, jsSetLastError([0x1234])),
    { call: 'GetLastError', args: [], want: 0x1234 },
    { call: 'SetLastError', args: [0x55] },
    js('JS GetLastError', 0x55, jsGetLastError([])),
    js('TlsAlloc', 0, () => Number(tlsApi.TlsAlloc!(null as never, new Uint8Array(0), []))),
    js('JS TlsSetValue(0)', 1, () => Number(tlsApi.TlsSetValue!(null as never, new Uint8Array(0), [0, 0xaaaa0000]))),
    { call: 'SetLastError', args: [9] },
    { call: 'TlsGetValue', args: [0], want: 0xaaaa0000 },
    { call: 'GetLastError', args: [], want: 0 },                 // success clears LastError
    { call: 'TlsGetValue', args: [1088], want: 0 },              // past TLS_INDEX_LIMIT
    { call: 'GetLastError', args: [], want: 87 },
    { call: 'TlsGetValue', args: [5], want: 0 },                 // never allocated: still success
    { call: 'GetLastError', args: [], want: 0 },
    { call: 'TlsSetValue', args: [0, 0xbeef], want: 1 },
    js('JS TlsGetValue(0)', 0xbeef, () => Number(tlsApi.TlsGetValue!(null as never, new Uint8Array(0), [0])) >>> 0),
    { call: 'TlsSetValue', args: [2000, 1], want: 0 },
    { call: 'GetLastError', args: [], want: 87 },
    { call: 'TlsSetValue', args: [700, 0x7007], want: 1 },       // TlsExpansionSlots range
    js('JS TlsGetValue(700)', 0x7007, () => Number(tlsApi.TlsGetValue!(null as never, new Uint8Array(0), [700])) >>> 0),
    js('JS TlsSetValue(1087)', 1, () => Number(tlsApi.TlsSetValue!(null as never, new Uint8Array(0), [1087, 0x1087]))),
    { call: 'SetLastError', args: [3] },
    { call: 'TlsGetValue', args: [1087], want: 0x1087 },         // the last index there is
    { call: 'GetLastError', args: [], want: 0 },
    { call: 'TlsGetValue', args: [64], want: 0 },
    js('FlsAlloc', 1, () => Number(flsApi.FlsAlloc!(null as never, new Uint8Array(0), []))),
    { call: 'SetLastError', args: [5] },
    { call: 'FlsGetValue', args: [1], want: 0 },                 // FlsAlloc gave the caller its block
    { call: 'GetLastError', args: [], want: 0 },                 // ...so this is a success
    { call: 'FlsSetValue', args: [1, 0x1111], want: 1 },
    { call: 'FlsGetValue', args: [1], want: 0x1111 },
    { call: 'GetLastError', args: [], want: 0 },
    { call: 'FlsSetValue', args: [1, 0x2222], want: 1 },         // block exists: answered in guest
    js('JS FlsGetValue(1)', 0x2222, () => Number(flsApi.FlsGetValue!(null as never, new Uint8Array(0), [1])) >>> 0),
    { call: 'FlsGetValue', args: [0], want: 0 },
    { call: 'GetLastError', args: [], want: 87 },
    { call: 'FlsGetValue', args: [128], want: 0 },
    { call: 'FlsSetValue', args: [128, 5], want: 0 },
    { call: 'SetLastError', args: [0x77] },
    js('switch to thread 2', 0, env => env.switchTo(2)),
    { call: 'GetLastError', args: [], want: 0 },                 // thread 2's own TEB
    { call: 'TlsGetValue', args: [0], want: 0 },
    { call: 'FlsGetValue', args: [1], want: 0 },                 // thread 2 has no FLS block
    { call: 'GetLastError', args: [], want: 87 },
    { call: 'FlsSetValue', args: [1, 0x3333], want: 1 },         // stub traps: JS allocates the block
    { call: 'FlsGetValue', args: [1], want: 0x3333 },
    { call: 'SetLastError', args: [0xb0b0] },
    js('JS GetLastError on 2', 0xb0b0, jsGetLastError([])),
    js('switch to thread 3 (TEB+0x2C = 0)', 0, env => env.switchTo(3)),
    { call: 'TlsSetValue', args: [3, 0x3030], want: 1 },         // no TLS array: the trap tail answers
    { call: 'TlsGetValue', args: [3], want: 0x3030 },
    { call: 'GetLastError', args: [], want: 0 },
    { call: 'TlsGetValue', args: [1088], want: 0 },              // range check precedes the array test
    { call: 'GetLastError', args: [], want: 87 },
    js('switch to thread 1', 0, env => env.switchTo(1)),
    { call: 'GetLastError', args: [], want: 0x77 },
    js('JS GetLastError on 1', 0x77, jsGetLastError([])),
];

function image(viaStubs: boolean): Uint8Array {
    const mem = new Uint8Array(BASE + IMG), view = new DataView(mem.buffer);
    [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE, BASE + IMG, BASE + IMG, ENTRY]
        .forEach((v, i) => view.setUint32(BASE + i * 4, v >>> 0, true));
    const target: Record<Api, number> = {} as Record<Api, number>;
    if (viaStubs) {
        let bump = STUBS;
        const allocator: StubAllocator = { alloc(size: number) { const a = bump; bump += (size + 15) & ~15; return a; } };
        const stubs = writeTebStubs(allocator, () => mem,
            { tlsGetValue: API.TlsGetValue.fid, tlsSetValue: API.TlsSetValue.fid, flsSetValue: API.FlsSetValue.fid });
        for (const name of Object.keys(API) as Api[]) target[name] = stubs[API[name].stub];
    } else {
        // The OUT-trap thunk shape: mov eax, fid; mov edx, 0xB077; out dx, eax; ret N
        (Object.keys(API) as Api[]).forEach((name, i) => {
            const at = STUBS + i * 16, { fid, pop } = API[name];
            mem.set([0xb8, fid, 0, 0, 0, 0xba, 0x77, 0xb0, 0, 0, 0xef], at);
            mem.set(pop ? [0xc2, pop, 0] : [0xc3], at + 11);
            target[name] = at;
        });
    }
    let p = ENTRY;
    const e = (...b: number[]) => { for (const x of b) mem[p++] = x & 0xff; };
    const u = (v: number) => { view.setUint32(p, v >>> 0, true); p += 4; };
    e(0xbc); u(STACK);                                                   // mov esp, STACK
    SCRIPT.forEach((step, k) => {
        if ('call' in step) {
            const [sb, ss, sd, sp] = sentinels(k);
            e(0xbb); u(sb); e(0xbe); u(ss); e(0xbf); u(sd); e(0xbd); u(sp);  // ebx, esi, edi, ebp
            for (let i = step.args.length - 1; i >= 0; i--) { e(0x68); u(step.args[i]); }
            e(0xb8); u(0xdeadbeef);                                      // EAX is not an input
            e(0xe8); u(target[step.call] - (p + 4));
            e(0xa3); u(RES + k * 4);                                     // mov [RES+k*4], eax
            const r = REGS + k * 20;
            e(0x89, 0x1d); u(r); e(0x89, 0x35); u(r + 4); e(0x89, 0x3d); u(r + 8);
            e(0x89, 0x2d); u(r + 12); e(0x89, 0x25); u(r + 16);         // ebx esi edi ebp esp
        } else {
            e(0xb9); u(k); e(0xb8); u(CTL); e(0xba); u(0xb077); e(0xef); // JS step k
        }
    });
    e(0x89, 0x25); u(RES_ESP);                                           // mov [RES_ESP], esp
    e(0xf4);
    return mem.slice(BASE);
}

function thread(id: number): Thread {
    return {
        id, handle: id, state: ThreadState.RUNNING, context: null, stackBase: 0x100000,
        stackSize: 0x100000, stackTop: STACK, startAddress: ENTRY, parameter: 0, waitInfo: null,
        exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

interface Arm {
    results: number[];
    regs: number[][];
    esp: number;
    apiCrossings: number;
    teb: { lastError: number[]; tls: number[]; fls1: Array<number | undefined> };
}

async function runArm(viaStubs: boolean): Promise<Arm> {
    const g = globalThis as { window?: unknown };
    const hadWindow = 'window' in g, savedWindow = g.window;
    delete g.window;
    const system = System.getInstance();
    const saved = { scheduler: system.scheduler, process: system.process };
    const savedTls = ((hypercallDataManager as any).tlsAllocatedShadow as Uint8Array).slice();
    const { V86 } = await import(lib);
    const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: wasm, log_level: 0, disable_jit: 1 });
    try {
        await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
        const cpu = em.v86.cpu;
        cpu.reboot_internal(); cpu.reset_memory(); cpu.load_multiboot(image(viaStubs).buffer);
        const mem = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);

        let bump = HEAP;
        const memory = { alloc: (size: number) => { const a = bump; bump += (size + 0xfff) & ~0xfff; return a; } };
        const s = new Scheduler();
        s.tebManager.initProcess(mem, memory);
        for (const id of [1, 2, 3]) {
            const t = thread(id);
            t.tebAddress = s.tebManager.allocateTeb(id, t.stackBase, t.stackTop, memory);
            (s as any).threads.set(id, t);
        }
        // Thread 3 publishes no TLS array: the stubs must take their trap tails.
        new DataView(mem().buffer, mem().byteOffset).setUint32(s.tebManager.getTebAddress(3)! + 0x2c, 0, true);
        (s as any).process = { memory };
        system.scheduler = s;
        system.process = { resetGeneration: 0, memory, getCurrentMemory: mem } as never;
        resetFlsState();

        const switchTo = (tid: number) => {
            (s as any).currentThreadId = tid;
            cpu.segment_offsets[4] = s.tebManager.getTebAddress(tid)!;
            cpu.segment_is_null[4] = 0;
            return 0;
        };
        switchTo(1);

        let apiCrossings = 0;
        const byFid = new Map(Object.entries(API).map(([name, a]) => [a.fid, name as Api]));
        const impl: Record<Api, (args: number[]) => unknown> = {
            GetLastError: a => errorApi.GetLastError!(null as never, mem(), a),
            SetLastError: a => errorApi.SetLastError!(null as never, mem(), a),
            TlsGetValue: a => tlsApi.TlsGetValue!(null as never, mem(), a),
            TlsSetValue: a => tlsApi.TlsSetValue!(null as never, mem(), a),
            FlsGetValue: a => flsApi.FlsGetValue!(null as never, mem(), a),
            FlsSetValue: a => flsApi.FlsSetValue!(null as never, mem(), a),
        };
        cpu.io.register_write(0xb077, null, undefined, undefined, (fid: number) => {
            if (fid === CTL) {
                const k = cpu.reg32[1] >>> 0, step = SCRIPT[k];
                if (!('js' in step)) throw new Error(`step ${k} is not a JS step`);
                new DataView(mem().buffer, mem().byteOffset).setUint32(RES + k * 4, step.run({ s, switchTo }) >>> 0, true);
                return;
            }
            const name = byFid.get(fid);
            if (!name) throw new Error(`unexpected OUT ${fid}`);
            apiCrossings++;
            const esp = cpu.reg32[4] >>> 0;
            const args = Array.from({ length: API[name].pop / 4 }, (_, i) => cpu.read32s(esp + 4 + i * 4) >>> 0);
            cpu.reg32[0] = Number(impl[name](args)) >>> 0;
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 15000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve(); });
            cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2;
            em.run();
        });

        const r32 = (a: number) => cpu.read32s(a) >>> 0;
        const t = s.tebManager;
        const out: Arm = {
            results: SCRIPT.map((_, k) => r32(RES + k * 4)),
            regs: SCRIPT.map((_, k) => [0, 4, 8, 12, 16].map(o => r32(REGS + k * 20 + o))),
            esp: r32(RES_ESP),
            apiCrossings,
            teb: {
                lastError: [t.readLastError(1), t.readLastError(2)],
                tls: [t.readTlsSlot(1, 0)!, t.readTlsSlot(2, 0)!, t.readTlsSlot(1, 700)!, t.readTlsSlot(3, 3)!],
                fls1: [t.readFlsSlot(1, 1), t.readFlsSlot(2, 1)],
            },
        };
        s.tlsFree(0);
        return out;
    } finally {
        await em.destroy();
        system.scheduler = saved.scheduler;
        system.process = saved.process;
        resetFlsState();
        (hypercallDataManager as any).tlsAllocatedShadow.set(savedTls);
        if (hadWindow) g.window = savedWindow;
    }
}

describe.skipIf(!existsSync(lib) || !existsSync(wasm))('kernel32 TEB stubs, executed', () => {
    test('guest stubs and JS handlers share one LastError/TLS/FLS store per thread', async () => {
        const viaStubs = await runArm(true);
        const viaTraps = await runArm(false);

        const callSteps = SCRIPT.filter(s => 'call' in s).length;
        for (const arm of [viaStubs, viaTraps]) {
            const bad = SCRIPT.flatMap((step, k) => {
                if (step.want === undefined || arm.results[k] === step.want) return [];
                const what = 'call' in step ? `${step.call}(${step.args.map(a => a.toString(16))})` : step.js;
                return [`#${k} ${what}: got 0x${arm.results[k].toString(16)} want 0x${step.want.toString(16)}`];
            });
            expect(bad).toEqual([]);
            // Per call: callee-saved registers intact and ESP back where the caller had it
            // (every RET N, including the trap tails', popped exactly its arguments).
            const clobbered = SCRIPT.flatMap((step, k) => {
                if (!('call' in step)) return [];
                const want = [...sentinels(k), STACK].map(v => v.toString(16)).join(' ');
                const got = arm.regs[k].map(v => v.toString(16)).join(' ');
                return got === want ? [] : [`#${k} ${step.call}: ebx esi edi ebp esp = ${got}, want ${want}`];
            });
            expect(clobbered).toEqual([]);
            expect(arm.esp).toBe(STACK);
            expect(arm.teb).toEqual({ lastError: [0x77, 0xb0b0], tls: [0xbeef, 0, 0x7007, 0x3030], fls1: [0x2222, 0x3333] });
        }
        const compared = (a: Arm) => SCRIPT.map((s, k) => (s.want === undefined ? null : a.results[k]));
        expect(compared(viaStubs)).toEqual(compared(viaTraps));
        // The stubs cross only where they cannot answer in guest code: thread 2's first
        // FlsSetValue (its block is allocated in JS) and both TLS calls on thread 3, which
        // has no TLS array. Without them every call crosses.
        expect(viaStubs.apiCrossings).toBe(3);
        expect(viaTraps.apiCrossings).toBe(callSteps);
    }, 60000);
});

describe('hypercall routing while the TEB stubs are bound', () => {
    const manager = hypercallDataManager as any;
    let saved: Record<string, unknown> | null = null;
    afterEach(() => {
        if (!saved) return;
        for (const key of Object.keys(manager)) if (!(key in saved)) delete manager[key];
        Object.assign(manager, saved);
        saved = null;
    });

    test('the page-cache readers go to JS, the TEB writers stay in WASM, and unbinding restores them', () => {
        saved = { ...manager };
        const HP = 0x1000, DISPATCH = 0x100;
        const buffer = new ArrayBuffer(0x20000);
        manager.initialized = false; manager.registeredEntries = new Map(); manager.tebStubsBound = false;
        manager.wasmMemory = null; manager.view = null;
        manager.initialize({ wasm_memory: { buffer } }, HP);
        const fids = { getlasterror: 11, setlasterror: 12, tlsgetvalue: 13, tlssetvalue: 14, flsgetvalue: 15 };
        const entry = (fid: number) => new Uint8Array(buffer)[HP + DISPATCH + fid];
        const routed = () => Object.fromEntries(Object.entries(fids).map(([n, f]) => [n, entry(f) !== 0]));

        for (const [name, fid] of Object.entries(fids)) manager.registerFunction('kernel32', name, fid);
        const all = { getlasterror: true, setlasterror: true, tlsgetvalue: true, tlssetvalue: true, flsgetvalue: true };
        expect(routed()).toEqual(all);

        manager.setTebStubsBound(true);
        const bound = { ...all, getlasterror: false, flsgetvalue: false };
        expect(routed()).toEqual(bound);
        // A registration after binding (a later DLL's stubs) honours it too.
        manager.registerFunction('kernel32', 'GetLastError', 21);
        expect(entry(21)).toBe(0);
        // So does the buffer-change rebuild.
        manager.rewriteState();
        expect(routed()).toEqual(bound);

        manager.setTebStubsBound(false);
        expect(routed()).toEqual(all);
        expect(entry(21)).not.toBe(0);
    });
});
