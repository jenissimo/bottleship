// The mingw-gcc3 libgcc _Unwind_SjLj_Register/_Unwind_SjLj_Unregister bodies get their TLS
// block rewritten by applyNativeSplices (native-leaves.ts): instead of GetLastError /
// TlsGetValue / SetLastError / TlsSetValue the spliced code reads and writes the slot in the
// TEB TLS array (fs:[2Ch]) directly. Nothing at runtime re-checks that against the original.
//
// Here the ORIGINAL bodies (the PR's exact bytes, relocated) are executed in real v86 with
// their calls going to thunk-shaped stubs served by the real kernel32 implementations
// (tls.ts / error.ts, JS) or by the WASM hypercall fast paths, and the SAME bodies after
// applyNativeSplices rewrote them are executed over the same scenario: nested and
// interleaved Register/Unregister on two threads with two TEBs (two fs bases). After every
// step the TLS slot (JS scheduler.tlsGetValue, the WASM TlsGetValue, the raw TEB arrays of
// both threads), every frame's prev link, the libgcc state, the callee-saved registers and
// LastError are recorded. Every arm must equal an independent model of the frame chain, so
// original and splice cannot agree on a wrong answer, and deliberately broken splices must
// be rejected by the same comparison.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NATIVE_SPLICES, applyNativeSplices } from '../../src/worker/core/hle-lib/native-leaves';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';
import { Scheduler } from '../../src/worker/core/scheduler/scheduler';
import { ThreadState, type Thread } from '../../src/worker/core/scheduler/types';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';
import { System } from '../../src/worker/core/system';
import { exports as tlsApi } from '../../src/worker/modules/kernel32/tls';
import { exports as errorApi } from '../../src/worker/modules/kernel32/error';
import { MOV_EAX_IMM32, MOV_EDX_IMM32, OUT_DX_EAX, THUNK_PORT } from '../../src/worker/core/thunking/thunk-constants';
import { TLS_INDEX_LIMIT } from '../../src/worker/core/teb-manager';

const LIB = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
const HAVE_V86 = existsSync(LIB) && existsSync(WASM);

const BASE = 0x400000, IMG = 0x3000, ENTRY = BASE + 0x40;
const TEXT = BASE + 0x1000, TEXT_SIZE = 0x200, REG = TEXT, UNREG = TEXT + 0x100;
const STUBS = BASE + 0x1400, STATE_VAR = BASE + 0x2000, STATE = BASE + 0x2040;
const FC = BASE + 0x2100, FC_SIZE = 0x20, FC_WORDS = FC_SIZE / 4, N_FC = 6, RES = BASE + 0x2800;
const STACK = 0x200000, HEAP = 0x800000;
const CTL_PORT = 0xb0a0, CTL_SETERR = 1, CTL_SNAP = 2, CTL_SWITCH = 3;
const OFF_CYCLE_LIMIT = 0x000, OFF_HC_ENABLED = 0x008, OFF_HC_HANDLER_CALLS = 0x2000;

// Thunk ids. The four APIs the original TLS block calls, the WASM-served probe, and traps for
// every other call/jump in the bodies (the lazy-init paths and the abort tail), which the
// scenario must never reach.
const API = { GetLastError: 101, TlsGetValue: 102, SetLastError: 103, TlsSetValue: 104 } as const;
const PROBE = 105;
const HANDLER = { GetLastError: 5, SetLastError: 6, TlsGetValue: 64, TlsSetValue: 86 } as const;
const TRAPS = { 'Register:init': 121, 'Register:init2': 122, 'Register:abort': 123, 'Unregister:init': 124, 'Unregister:init2': 125, 'Unregister:abort': 126 } as const;
type ApiName = keyof typeof API;
const API_CLEANUP: Record<ApiName, number> = { GetLastError: 0, TlsGetValue: 4, SetLastError: 4, TlsSetValue: 8 };

const [REGISTER, UNREGISTER] = NATIVE_SPLICES;
/** body offset of every e8/e9 in the bodies → where it must lead. */
const REG_SITES: Record<number, number | ApiName> = {
    0x34: TRAPS['Register:init'], 0x46: TRAPS['Register:init2'], 0x5b: 'GetLastError', 0x66: 'TlsGetValue',
    0x6e: 'SetLastError', 0x81: 'TlsSetValue', 0x93: TRAPS['Register:abort'],
};
const UNREG_SITES: Record<number, number | ApiName> = {
    0x30: TRAPS['Unregister:init'], 0x41: TRAPS['Unregister:init2'], 0x59: 'TlsSetValue', 0x68: TRAPS['Unregister:abort'],
};
const STUB_ORDER: number[] = [...Object.values(API), PROBE, ...Object.values(TRAPS)];
const stubAddr = (fid: number) => STUBS + STUB_ORDER.indexOf(fid) * 16;
const siteTarget = (t: number | ApiName) => stubAddr(typeof t === 'number' ? t : API[t]);

/** One driver step: call Register/Unregister on thread `tid` with frame `fc`. */
interface Step { fn: 'R' | 'U'; tid: 1 | 2; fc: number }
const SCENARIO: Step[] = [
    { fn: 'R', tid: 1, fc: 0 }, { fn: 'R', tid: 1, fc: 1 },     // nested on T1
    { fn: 'R', tid: 2, fc: 2 },                                // T2 starts its own chain
    { fn: 'U', tid: 1, fc: 1 },                                // T1 pops while T2 holds one
    { fn: 'R', tid: 2, fc: 3 }, { fn: 'U', tid: 2, fc: 3 }, { fn: 'U', tid: 2, fc: 2 },
    { fn: 'U', tid: 1, fc: 0 },
    { fn: 'R', tid: 1, fc: 4 }, { fn: 'U', tid: 1, fc: 4 },     // re-register after full unwind
];
const fcAddr = (i: number) => FC + i * FC_SIZE;
/** T2's slot already holds an outer frame when the scenario starts; T1's is empty. */
const INITIAL_SLOT: Record<1 | 2, number> = { 1: 0, 2: fcAddr(5) };
const STATIC_CHAIN = 0x5717c0de;
const sentinel = (reg: number, step: number) => (0x10000000 * (reg + 1) + 0x1000 + step) >>> 0;
const lastErrorFor = (step: number) => (0xe0000000 + step * 0x11) >>> 0;
const preset = (tid: number, slot: number) => (0xa0000000 | (tid << 16) | slot) >>> 0;
const fcFill = (fc: number, word: number) => (0xfc000000 | (fc << 8) | word) >>> 0;

interface Snap {
    tid: number;
    regs: number[];          // ebx esi edi ebp esp after the call returned
    lastError: number;       // scheduler.getLastError()
    tebLastError: number;    // TEB+0x34 of the current thread
    slot: number;            // scheduler.tlsGetValue(idx) — the JS view of the slot
    arrays: number[][];      // each thread's whole TEB TLS array (TLS_INDEX_LIMIT words)
    after: number[][];       // the guard block allocated right after each array
    fcs: number[];           // every frame record, all words
    state: number[];         // libgcc state words 0x28..0x30
}
interface ArmResult {
    snaps: Snap[];
    probes: number[];        // the WASM TlsGetValue read of the slot after each step
    js: Record<ApiName, number>;     // body API calls the JS kernel32 implementations served
    jsProbes: number;                // probes WASM declined (expansion index)
    wasm: Record<ApiName, number>;   // calls the WASM fast paths served, probes included
    traps: number[];
    halted: boolean;
    afterInitial: number[][];        // `after` before the guest ran
    maps: number[][][];              // each thread's Thread.tlsValues at the end
    arraySpan: number[];             // bytes each TLS array owns before the next allocation
}
interface IndexSetup { name: string; alloc: (s: Scheduler) => number; expectIndex: number }
interface ArmOptions {
    splice: boolean; wasmApis: boolean; setup: IndexSetup; tweak?: (mem: Uint8Array) => void;
    /** Negative control: the pre-unification scheduler storage (JS keeps keys >= 64 in Thread.tlsValues). */
    legacyStorage?: boolean;
}

function stub(fid: number): number[] {
    const head = [MOV_EAX_IMM32, fid & 0xff, (fid >> 8) & 0xff, 0, 0,
        MOV_EDX_IMM32, THUNK_PORT & 0xff, (THUNK_PORT >> 8) & 0xff, 0, 0, OUT_DX_EAX];
    const name = (Object.keys(API) as ApiName[]).find(n => API[n] === fid);
    const cleanup = fid === PROBE ? 4 : name ? API_CLEANUP[name] : -1;
    if (cleanup < 0) return [...head, 0xf4];                        // trap: hlt
    return cleanup === 0 ? [...head, 0xc3] : [...head, 0xc2, cleanup, 0];
}

/** Lays the original bodies out exactly as a linker would and relocates their operands. */
function placeBody(mem: Uint8Array, at: number, body: Uint8Array, same: readonly number[], sites: Record<number, number | ApiName>): void {
    mem.set(body, at);
    const dv = new DataView(mem.buffer);
    for (const o of same) dv.setUint32(at + o, STATE_VAR, true);
    for (const [o, t] of Object.entries(sites)) {
        const op = at + Number(o);
        dv.setInt32(op + 1, siteTarget(t) - (op + 5), true);
    }
}

function buildImage(idx: number, splice: boolean, tweak?: (mem: Uint8Array) => void): { bytes: Uint8Array; applied: number[] } {
    const mem = new Uint8Array(BASE + IMG);
    const dv = new DataView(mem.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + IMG, BASE + IMG, ENTRY]
        .forEach((v, i) => dv.setUint32(BASE + i * 4, v, true));
    placeBody(mem, REG, REGISTER!.body, REGISTER!.same, REG_SITES);
    placeBody(mem, UNREG, UNREGISTER!.body, UNREGISTER!.same, UNREG_SITES);
    STUB_ORDER.forEach(fid => mem.set(stub(fid), stubAddr(fid)));
    dv.setUint32(STATE_VAR, STATE, true);
    dv.setUint32(STATE + 0x28, STATIC_CHAIN, true);   // non-TLS chain head: must stay untouched
    dv.setUint32(STATE + 0x2c, 1, true);              // > 0: "use the TLS slot"
    dv.setUint32(STATE + 0x30, idx, true);            // the TlsAlloc'd key
    for (let f = 0; f < N_FC; f++) for (let w = 0; w < FC_WORDS; w++) dv.setUint32(fcAddr(f) + w * 4, fcFill(f, w), true);
    tweak?.(mem);

    let applied: number[] = [];
    if (splice) {
        const module = {
            name: 'sjlj.exe', baseAddress: BASE, size: IMG,
            sections: [{ name: '.text', virtualAddress: TEXT - BASE, virtualSize: TEXT_SIZE, rawSize: TEXT_SIZE, characteristics: 0x60000020 }],
        } as unknown as LoadedPEModule;
        applied = applyNativeSplices(mem, module).map(s => s.address);
    }

    let p = ENTRY;
    const e = (...b: number[]) => { mem.set(b, p); p += b.length; };
    const u = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const ctl = (cmd: number, arg: number) => { e(0xb9); u(arg); e(0xb8); u(cmd); e(0xba); u(CTL_PORT); e(OUT_DX_EAX); };
    const call = (target: number) => { e(0xe8); u(target - (p + 4)); };
    e(0xbc); u(STACK);                                         // mov esp, STACK
    let tid = 1;
    SCENARIO.forEach((s, i) => {
        if (s.tid !== tid) { ctl(CTL_SWITCH, s.tid); tid = s.tid; }
        ctl(CTL_SETERR, i);
        e(0xbb); u(sentinel(0, i)); e(0xbe); u(sentinel(1, i));  // mov ebx / mov esi
        e(0xbf); u(sentinel(2, i)); e(0xbd); u(sentinel(3, i));  // mov edi / mov ebp
        e(0x68); u(fcAddr(s.fc));                                // push fc
        call(s.fn === 'R' ? REG : UNREG);
        ctl(CTL_SNAP, i);
        e(0x83, 0xc4, 0x04);                                     // add esp, 4
        e(0x68); u(idx); call(stubAddr(PROBE));                  // TlsGetValue(idx), WASM-served
        e(0xa3); u(RES + i * 4);                                 // mov [RES+i*4], eax
    });
    e(0xf4);
    return { bytes: mem.slice(BASE), applied };
}

function makeThread(id: number): Thread {
    return {
        id, handle: id, state: id === 1 ? ThreadState.RUNNING : ThreadState.READY, context: null,
        stackBase: 0x100000, stackSize: 0x100000, stackTop: STACK, startAddress: ENTRY, parameter: 0,
        waitInfo: null, exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

async function runArm(opts: ArmOptions): Promise<ArmResult & { idx: number; applied: number[] }> {
    const g = globalThis as { window?: unknown };
    const hadWindow = 'window' in g, savedWindow = g.window;
    delete g.window;
    const manager = hypercallDataManager as any;
    const saved = { ...manager };
    const savedTls = (manager.tlsAllocatedShadow as Uint8Array).slice();
    const system = System.getInstance();
    const savedScheduler = system.scheduler;
    const { V86 } = await import(LIB);
    const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: WASM, log_level: 0, disable_jit: 1 });
    try {
        await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
        const cpu = em.v86.cpu, api = cpu.wm.exports;
        cpu.reboot_internal(); cpu.reset_memory();
        const mem = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
        const guest = () => new DataView(mem().buffer, mem().byteOffset);

        // Packed like MemoryManager.alloc (8-byte granularity): whatever is allocated next sits
        // right after a TLS array, as in a real process.
        let bump = HEAP;
        const allocs: number[] = [];
        const memory = { alloc: (size: number) => { const a = bump; bump += (size + 7) & ~7; allocs.push(a); return a; } };
        const s = new Scheduler();
        system.scheduler = s;
        if (opts.legacyStorage) {
            const tm = s.tebManager as any;
            const sync = tm.syncTlsSlot.bind(tm), read = tm.readTlsSlot.bind(tm), clear = tm.clearTlsSlotAllThreads.bind(tm);
            tm.syncTlsSlot = (t: number, i: number, v: number) => i < 64 && sync(t, i, v);
            tm.readTlsSlot = (t: number, i: number) => (i < 64 ? read(t, i) : undefined);
            tm.clearTlsSlotAllThreads = (i: number) => { if (i < 64) clear(i); };
        }
        s.tebManager.initProcess(mem, memory);
        const threads = { 1: makeThread(1), 2: makeThread(2) } as Record<1 | 2, Thread>;
        // A guard block is the very next allocation after each thread's TLS array.
        const guards: Record<number, number> = {};
        for (const t of Object.values(threads)) {
            t.tebAddress = s.tebManager.allocateTeb(t.id, t.stackBase, t.stackTop, memory);
            guards[t.id] = memory.alloc(64);
            (s as any).threads.set(t.id, t);
        }
        (s as any).currentThreadId = 1;

        manager.tlsAllocatedShadow.fill(0);
        manager.initialized = false; manager.registeredEntries = new Map();
        const hp = api.get_hypercall_page_ptr() >>> 0;
        manager.initialize(cpu, hp);
        const page = () => new DataView(cpu.wasm_memory.buffer, hp);
        page().setUint32(OFF_CYCLE_LIMIT, 100_003, true);
        manager.registerFunction('kernel32', 'TlsGetValue', PROBE);
        if (opts.wasmApis) for (const n of Object.keys(API) as ApiName[]) manager.registerFunction('kernel32', n, API[n]);
        page().setUint32(OFF_HC_ENABLED, 1, true);

        const idx = opts.setup.alloc(s);
        const { bytes, applied } = buildImage(idx, opts.splice, opts.tweak);
        cpu.load_multiboot(bytes.buffer);

        const tlsArray = (tid: number) => s.tebManager.getTlsArrayAddress(tid)!;
        const words = (a: number, n: number) => Array.from({ length: n }, (_, i) => guest().getUint32(a + i * 4, true));
        const after = () => [1, 2].map(tid => words(guards[tid]!, 16));
        for (const tid of [1, 2]) for (let w = 0; w < 16; w++) guest().setUint32(guards[tid]! + w * 4, (0x6a7d0000 | (tid << 8) | w) >>> 0, true);
        for (const tid of [1, 2] as const) {
            for (let j = 0; j < TLS_INDEX_LIMIT; j++) if (j !== idx) guest().setUint32(tlsArray(tid) + j * 4, preset(tid, j), true);
            guest().setUint32(tlsArray(tid) + idx * 4, INITIAL_SLOT[tid], true);
            if (opts.legacyStorage && idx >= 64) threads[tid].tlsValues.set(idx, INITIAL_SLOT[tid]);
        }
        const afterInitial = after();
        const arraySpan = [1, 2].map(tid => allocs[allocs.indexOf(tlsArray(tid)) + 1]! - tlsArray(tid));
        expect([1, 2].map(tid => allocs[allocs.indexOf(tlsArray(tid)) + 1])).toEqual([guards[1], guards[2]]);
        const switchTo = (tid: 1 | 2) => {
            const from = threads[(s as any).currentThreadId as 1 | 2];
            from.lastError = manager.readLastError(); from.state = ThreadState.READY;
            const to = threads[tid];
            to.state = ThreadState.RUNNING; (s as any).currentThreadId = tid;
            cpu.segment_offsets[4] = to.tebAddress | 0;   // fs base, as setFsBase() programs it
            manager.syncThreadData(tid, to.lastError, to.tebAddress);
        };
        manager.syncThreadData(1, 0, threads[1].tebAddress);
        cpu.segment_offsets[4] = threads[1].tebAddress | 0;

        const calls = { GetLastError: 0, TlsGetValue: 0, SetLastError: 0, TlsSetValue: 0 } as Record<ApiName, number>;
        let probeCalls = 0;
        const traps: number[] = [];
        const impl: Record<ApiName, (args: number[]) => unknown> = {
            GetLastError: a => errorApi.GetLastError!(null as never, mem(), a),
            SetLastError: a => errorApi.SetLastError!(null as never, mem(), a),
            TlsGetValue: a => tlsApi.TlsGetValue!(null as never, mem(), a),
            TlsSetValue: a => tlsApi.TlsSetValue!(null as never, mem(), a),
        };
        cpu.io.register_write(THUNK_PORT, null, undefined, undefined, (fid: number) => {
            const name = (Object.keys(API) as ApiName[]).find(n => API[n] === fid) ?? (fid === PROBE ? 'TlsGetValue' : null);
            if (!name) { traps.push(fid); return; }
            if (fid === PROBE) probeCalls++; else calls[name]++;
            const esp = cpu.reg32[4] >>> 0;
            const args = [cpu.read32s(esp + 4) >>> 0, cpu.read32s(esp + 8) >>> 0];
            const r = impl[name](args);
            cpu.reg32[0] = (typeof r === 'number' ? r : (r as { value: number }).value) | 0;
        });
        const snaps: Snap[] = [];
        cpu.io.register_write(CTL_PORT, null, undefined, undefined, (cmd: number) => {
            const arg = cpu.reg32[1] >>> 0;
            if (cmd === CTL_SWITCH) switchTo(arg as 1 | 2);
            else if (cmd === CTL_SETERR) s.setLastError(lastErrorFor(arg));
            else if (cmd === CTL_SNAP) {
                const tid = (s as any).currentThreadId as number;
                const r = cpu.reg32;
                snaps[arg] = {
                    tid,
                    regs: [r[3], r[6], r[7], r[5], r[4]].map(v => v >>> 0),
                    lastError: s.getLastError(),
                    tebLastError: guest().getUint32(threads[tid as 1 | 2].tebAddress + 0x34, true),
                    slot: s.tlsGetValue(idx),
                    arrays: [words(tlsArray(1), TLS_INDEX_LIMIT), words(tlsArray(2), TLS_INDEX_LIMIT)],
                    after: after(),
                    fcs: words(FC, N_FC * FC_WORDS),
                    state: words(STATE + 0x28, 3),
                };
            }
        });

        const halted = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => { em.stop(); resolve(false); }, 10000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve(true); });
            cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2;
            em.run();
        });
        const probes = SCENARIO.map((_, i) => cpu.read32s(RES + i * 4) >>> 0);
        // WASM-served calls never reach the JS port handler; the per-handler ledger counts them
        // (the probe and the body's TlsGetValue share handler 64).
        const wasm = {} as Record<ApiName, number>;
        for (const n of Object.keys(API) as ApiName[]) wasm[n] = page().getUint32(OFF_HC_HANDLER_CALLS + HANDLER[n] * 4, true);
        const maps = [threads[1], threads[2]].map(t => [...t.tlsValues].map(([k, v]) => [k, v]));
        return { snaps, probes, js: calls, jsProbes: probeCalls, wasm, traps, halted, idx, applied, afterInitial, maps, arraySpan };
    } finally {
        await em.destroy();
        system.scheduler = savedScheduler;
        for (const key of Object.keys(manager)) if (!(key in saved)) delete manager[key];
        Object.assign(manager, saved);
        manager.tlsAllocatedShadow.set(savedTls);
        if (hadWindow) g.window = savedWindow;
    }
}

/** The frame chain as libgcc defines it, computed without running any x86. */
function oracle(idx: number, afterInitial: number[][]): { snaps: Snap[]; probes: number[] } {
    const slots = { ...INITIAL_SLOT };
    const fcs = Array.from({ length: N_FC * FC_WORDS }, (_, k) => fcFill(Math.floor(k / FC_WORDS), k % FC_WORDS));
    const array = (tid: 1 | 2) => Array.from({ length: TLS_INDEX_LIMIT }, (_, j) => j === idx ? slots[tid] : preset(tid, j));
    const snaps: Snap[] = [], probes: number[] = [];
    SCENARIO.forEach(({ fn, tid, fc }, i) => {
        if (fn === 'R') { fcs[fc * FC_WORDS] = slots[tid]; slots[tid] = fcAddr(fc); }
        else slots[tid] = fcs[fc * FC_WORDS]!;
        snaps.push({
            tid, regs: [0, 1, 2, 3].map(r => sentinel(r, i)).concat(STACK - 4),
            lastError: lastErrorFor(i), tebLastError: lastErrorFor(i), slot: slots[tid],
            arrays: [array(1), array(2)], after: afterInitial, fcs: [...fcs], state: [STATIC_CHAIN, 1, idx],
        });
        probes.push(slots[tid]);
    });
    return { snaps, probes };
}

const hex = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === 'number' ? `0x${(x >>> 0).toString(16)}` : x);

function mismatches(arm: ArmResult & { idx: number }): string[] {
    const want = oracle(arm.idx, arm.afterInitial);
    const bad: string[] = [];
    if (!arm.halted) bad.push('guest did not halt');
    if (arm.traps.length) bad.push(`reached trap stubs ${hex(arm.traps)}`);
    // One storage: nothing may live in the per-thread map, and each array must own every index.
    if (arm.maps.some(m => m.length)) bad.push(`Thread.tlsValues not empty: ${hex(arm.maps)}`);
    if (arm.arraySpan.some(n => n < TLS_INDEX_LIMIT * 4)) bad.push(`TLS array spans ${hex(arm.arraySpan)} bytes`);
    SCENARIO.forEach((s, i) => {
        const got = arm.snaps[i], exp = want.snaps[i]!;
        const tag = `step ${i} ${s.fn}(fc${s.fc}) on T${s.tid}`;
        if (!got) { bad.push(`${tag}: no snapshot`); return; }
        for (const k of Object.keys(exp) as Array<keyof Snap>) {
            if (hex(got[k]) !== hex(exp[k])) bad.push(`${tag}: ${k} got ${hex(got[k])} want ${hex(exp[k])}`);
        }
        if (arm.probes[i] !== want.probes[i]) bad.push(`${tag}: WASM TlsGetValue got ${hex(arm.probes[i])} want ${hex(want.probes[i])}`);
    });
    return bad;
}

const IDX5: IndexSetup = {
    name: 'key 5, TlsAlloc\'d after five other slots', expectIndex: 5,
    alloc: s => { for (let i = 0; i < 5; i++) s.tlsAlloc(); return s.tlsAlloc(); },
};
const IDX0: IndexSetup = { name: 'key 0, the first TlsAlloc', expectIndex: 0, alloc: s => s.tlsAlloc() };
const CHURN: IndexSetup = {
    name: 'key from TlsAlloc after 64 TlsAlloc/TlsFree pairs (one live slot)', expectIndex: 0,
    alloc: s => { for (let i = 0; i < 64; i++) s.tlsFree(s.tlsAlloc()); return s.tlsAlloc(); },
};
const LIVE65: IndexSetup = {
    name: 'key 64 from the 65th live TlsAlloc', expectIndex: 64,
    alloc: s => { for (let i = 0; i < 64; i++) s.tlsAlloc(); return s.tlsAlloc(); },
};
const LAST: IndexSetup = {
    name: 'key 1087, the last index TlsAlloc can give', expectIndex: TLS_INDEX_LIMIT - 1,
    alloc: s => { for (let i = 0; i < TLS_INDEX_LIMIT - 1; i++) s.tlsAlloc(); return s.tlsAlloc(); },
};

const nR = SCENARIO.filter(s => s.fn === 'R').length, nU = SCENARIO.length - nR;
const zero = { GetLastError: 0, TlsGetValue: 0, SetLastError: 0, TlsSetValue: 0 };

describe('libgcc SjLj splice: fixture', () => {
    test('every relocated operand of both bodies is a state reference or a call/jump this harness wires', () => {
        for (const [s, sites] of [[REGISTER!, REG_SITES], [UNREGISTER!, UNREG_SITES]] as const) {
            const holes: number[] = [];
            for (let i = 0; i < s.body.length; i++) if (s.mask[i] === 0 && (i === 0 || s.mask[i - 1] !== 0)) holes.push(i);
            const wired = [...s.same, ...Object.keys(sites).map(o => Number(o) + 1)].sort((a, b) => a - b);
            expect(holes).toEqual(wired);
            for (const o of Object.keys(sites).map(Number)) {
                expect([0xe8, 0xe9]).toContain(s.body[o]!);
                expect(Array.from(s.mask.subarray(o + 1, o + 5))).toEqual([0, 0, 0, 0]);
            }
        }
        // Each splice starts exactly where the body's "use the TLS slot" branch lands (jne rel8).
        expect([REGISTER!.body[0x22], 0x24 + REGISTER!.body[0x23]!]).toEqual([0x75, REGISTER!.offset]);
        expect([UNREGISTER!.body[0x1f], 0x21 + UNREGISTER!.body[0x20]!]).toEqual([0x75, UNREGISTER!.offset]);
    });
});

describe.skipIf(!HAVE_V86)('libgcc SjLj splice, executed in v86', () => {
    for (const setup of [IDX5, IDX0, CHURN]) {
        test(`original (JS kernel32), original (WASM fast paths) and splice all follow the frame chain — ${setup.name}`, async () => {
            const origJs = await runArm({ splice: false, wasmApis: false, setup });
            const origHc = await runArm({ splice: false, wasmApis: true, setup });
            const spliced = await runArm({ splice: true, wasmApis: false, setup });
            expect(origJs.idx).toBe(setup.expectIndex);

            expect(origJs.applied).toEqual([]);
            expect(origHc.applied).toEqual([]);
            expect(spliced.applied).toEqual([REG, UNREG]);

            expect(mismatches(origJs)).toEqual([]);
            expect(mismatches(origHc)).toEqual([]);
            expect(mismatches(spliced)).toEqual([]);
            expect(hex(spliced.snaps)).toBe(hex(origJs.snaps));
            expect(hex(spliced.snaps)).toBe(hex(origHc.snaps));

            // The original really went through the APIs (JS in one arm, WASM in the other);
            // the spliced bodies made no API call at all — only the probes reached TlsGetValue.
            expect(origJs.js).toEqual({ GetLastError: nR, TlsGetValue: nR, SetLastError: nR, TlsSetValue: nR + nU });
            expect(origJs.wasm).toEqual({ ...zero, TlsGetValue: SCENARIO.length });
            expect(origHc.js).toEqual(zero);
            expect(origHc.wasm).toEqual({ GetLastError: nR, TlsGetValue: nR + SCENARIO.length, SetLastError: nR, TlsSetValue: nR + nU });
            expect(spliced.js).toEqual(zero);
            expect(spliced.wasm).toEqual({ ...zero, TlsGetValue: SCENARIO.length });
            for (const arm of [origJs, origHc, spliced]) expect(arm.jsProbes).toBe(0);
        }, 60000);
    }

    // Negative control: the same comparison must reject a splice that is wrong in any one way.
    const MUTANTS: Array<{ name: string; splice: 0 | 1; at: number; bytes: number[] }> = [
        { name: 'Register takes the key from state+0x2C', splice: 0, at: 2, bytes: [0x2c] },
        { name: 'Register reads fs:[0x30] instead of fs:[0x2C]', splice: 0, at: 5, bytes: [0x30] },
        { name: 'Register drops the fc->prev store', splice: 0, at: 12, bytes: [0x90, 0x90] },
        { name: 'Unregister takes the key from state+0x2C', splice: 1, at: 2, bytes: [0x2c] },
        { name: 'Unregister stores the key instead of fc->prev', splice: 1, at: 10, bytes: [0x0c] },
        { name: 'Unregister jumps past the ebx restore', splice: 1, at: 13, bytes: [0xc7] },
    ];
    for (const m of MUTANTS) {
        test(`negative control: a broken splice is caught — ${m.name}`, async () => {
            const code = NATIVE_SPLICES[m.splice]!.code;
            const original = code.slice();
            code.set(m.bytes, m.at);
            try {
                const arm = await runArm({ splice: true, wasmApis: false, setup: IDX5 });
                expect(arm.applied).toEqual([REG, UNREG]);
                expect(mismatches(arm).length).toBeGreaterThan(0);
            } finally {
                code.set(original);
            }
        }, 30000);
    }

    test('negative control: the LastError comparison is live — an original Register that skips its SetLastError restore is caught', async () => {
        // call SetLastError (body+0x6E) → add esp, 4 (drop the argument) + nops. TlsGetValue has
        // just cleared LastError, so only the restore brings the caller's value back.
        const tweak = (mem: Uint8Array) => mem.set([0x83, 0xc4, 0x04, 0x90, 0x90], REG + 0x6e);
        const arm = await runArm({ splice: false, wasmApis: false, setup: IDX5, tweak });
        const bad = mismatches(arm);
        expect(bad.length).toBeGreaterThan(0);
        expect(bad.every(b => /: (lastError|tebLastError) got "0x0"/.test(b))).toBe(true);
    }, 30000);
});

// The splice indexes fs:[2Ch] with the key and has no fallback path, so it relies on the TEB
// TLS array holding EVERY index TlsAlloc can hand out (teb-manager.ts TLS_INDEX_LIMIT) and on
// the JS TlsGetValue/TlsSetValue using that same array for keys the WASM fast paths decline.
describe('TlsAlloc and the TEB TLS array', () => {
    test('64 simultaneously live slots are 0..63; the 65th is 64 (expansion range, as on NT)', () => {
        const s = new Scheduler();
        expect(Array.from({ length: 64 }, () => s.tlsAlloc())).toEqual(Array.from({ length: 64 }, (_, i) => i));
        expect(s.tlsAlloc()).toBe(64);
    });

    test('TlsAlloc returns the lowest free index: churn alone never leaves the WASM-served range', () => {
        // tlsAlloc() used to resume after the last index, so 64 TlsAlloc/TlsFree pairs with ONE
        // live slot produced key 64. NT returns the lowest free index.
        const s = new Scheduler();
        for (let i = 0; i < 64; i++) s.tlsFree(s.tlsAlloc());
        expect(s.tlsAlloc()).toBe(0);
        expect([s.tlsAlloc(), s.tlsAlloc()]).toEqual([1, 2]);
        s.tlsFree(1);
        expect(s.tlsAlloc()).toBe(1);
        for (let i = 3; i < 64; i++) expect(s.tlsAlloc()).toBeLessThan(64);
        expect(s.tlsAlloc()).toBe(64);                 // only a 65th LIVE slot leaves it
    });

    test('TlsAlloc stops at TLS_INDEX_LIMIT = NT\'s 1088 (64 + 1024 expansion) with TLS_OUT_OF_INDEXES', () => {
        expect(TLS_INDEX_LIMIT).toBe(1088);
        const s = new Scheduler();
        for (let i = 0; i < TLS_INDEX_LIMIT; i++) expect(s.tlsAlloc()).toBe(i);
        expect(s.tlsAlloc()).toBe(0xffffffff);
        s.tlsFree(700);
        expect(s.tlsAlloc()).toBe(700);
    });

    test('every index TlsAlloc can give is stored in, read from and cleared in the TEB array', () => {
        const mem = new Uint8Array(0x20000);
        let bump = 0x1000;
        const memory = { alloc: (n: number) => { const a = bump; bump += (n + 7) & ~7; return a; } };
        const s = new Scheduler();
        s.tebManager.initProcess(() => mem, memory);
        const teb = s.tebManager.allocateTeb(1, 0, 0, memory);
        const array = s.tebManager.getTlsArrayAddress(1)!;
        const dv = new DataView(mem.buffer);
        expect(dv.getUint32(teb + 0x2c, true)).toBe(array);
        const next = memory.alloc(4);
        expect(next - array).toBeGreaterThanOrEqual(TLS_INDEX_LIMIT * 4);
        for (const i of [0, 63, 64, 700, TLS_INDEX_LIMIT - 1]) {
            expect(s.tebManager.syncTlsSlot(1, i, 0xc0de0000 + i)).toBe(true);
            expect(dv.getUint32(array + i * 4, true)).toBe(0xc0de0000 + i);
            expect(s.tebManager.readTlsSlot(1, i)).toBe(0xc0de0000 + i);
        }
        expect(s.tebManager.syncTlsSlot(1, TLS_INDEX_LIMIT, 1)).toBe(false);
        expect(s.tebManager.readTlsSlot(1, TLS_INDEX_LIMIT)).toBeUndefined();
        expect(dv.getUint32(next, true)).toBe(0);
        s.tebManager.clearTlsSlotAllThreads(700);
        expect(dv.getUint32(array + 700 * 4, true)).toBe(0);
    });
});

describe.skipIf(!HAVE_V86)('libgcc SjLj splice with an expansion key, executed in v86', () => {
    for (const setup of [LIVE65, LAST]) {
        test(`original (JS), original (WASM declines to JS) and splice all follow the frame chain in the one TEB array — ${setup.name}`, async () => {
            const origJs = await runArm({ splice: false, wasmApis: false, setup });
            const origHc = await runArm({ splice: false, wasmApis: true, setup });
            const spliced = await runArm({ splice: true, wasmApis: true, setup });
            expect(origJs.idx).toBe(setup.expectIndex);
            expect(spliced.applied).toEqual([REG, UNREG]);

            expect(mismatches(origJs)).toEqual([]);
            expect(mismatches(origHc)).toEqual([]);
            expect(mismatches(spliced)).toEqual([]);
            expect(hex(spliced.snaps)).toBe(hex(origJs.snaps));
            expect(hex(spliced.snaps)).toBe(hex(origHc.snaps));
            // Register(fc0) by the splice is in T1's array at the key, and the scheduler sees it.
            expect(spliced.snaps[0]!.arrays[0]![setup.expectIndex]).toBe(fcAddr(0));
            expect(spliced.snaps[0]!.slot).toBe(fcAddr(0));

            // The WASM TlsGetValue/TlsSetValue still serve only 0..63: for this key they declined
            // and the JS implementations answered, from the same array.
            expect(origJs.js).toEqual({ GetLastError: nR, TlsGetValue: nR, SetLastError: nR, TlsSetValue: nR + nU });
            expect(origHc.js).toEqual({ ...zero, TlsGetValue: nR, TlsSetValue: nR + nU });
            expect(origHc.wasm).toEqual({ ...zero, GetLastError: nR, SetLastError: nR });
            expect(spliced.js).toEqual(zero);
            for (const arm of [origJs, origHc, spliced]) expect(arm.jsProbes).toBe(SCENARIO.length);
            expect(origJs.wasm).toEqual(zero);
            expect(spliced.wasm).toEqual(zero);
        }, 60000);
    }

    test('negative control: with the old split storage (keys >= 64 in Thread.tlsValues) the splice is caught', async () => {
        const arm = await runArm({ splice: true, wasmApis: true, setup: LIVE65, legacyStorage: true });
        expect(arm.applied).toEqual([REG, UNREG]);
        const bad = mismatches(arm);
        expect(bad.some(b => /step 0 R\(fc0\) on T1: slot got "0x0" want "0x402100"/.test(b))).toBe(true);
        expect(bad.some(b => /WASM TlsGetValue got/.test(b))).toBe(true);
    }, 30000);
});

