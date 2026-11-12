// TlsSetValue has a WASM fast path (hypercall.rs handle_tls_set_value) and a JS path
// (scheduler.tlsSetValue). Both must leave ONE state: the TEB TLS array the WASM
// TlsGetValue reads and the scheduler's own tlsGetValue. The same guest call sequence runs
// in real v86 with the fast path routed and with it zeroed (the dbg.hcoff A/B), and the
// two arms must agree on every return value and every stored slot; the per-handler ledger
// must count exactly the calls each arm was expected to serve or decline.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Scheduler } from '../../src/worker/core/scheduler/scheduler';
import { ThreadState, type Thread } from '../../src/worker/core/scheduler/types';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';
import type { TebManager } from '../../src/worker/core/teb-manager';

const lib = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const wasm = fileURLToPath(new URL('../../public/v86.wasm', import.meta.url));

const BASE = 0x400000, ENTRY = BASE + 0x40, STUB = BASE + 0x1000, RES = BASE + 0x2000;
const STACK = 0x200000, HEAP = 0x800000;
const FID = 100, HANDLER = 86;
const OFF_CYCLE_LIMIT = 0x000, OFF_HC_ENABLED = 0x008, OFF_HC_TLS_ALLOCATED = 0x0B8;
const OFF_HC_HANDLER_CALLS = 0x2000, OFF_HC_HANDLER_FALLBACKS = 0x2400;

const FREED = 5, EXPANSION = 64, PRESET = 7;
/** [index, value, expected return, served by WASM when routed] */
const CALLS: Array<[number, number, number, boolean]> = [
    [3, 0x11223344, 1, true],
    [PRESET, 0xdeadbeef, 1, true],
    [FREED, 0x55, 0, false],          // not TlsAlloc'd: JS answers FALSE
    [EXPANSION, 0x6464, 1, false],    // expansion index: WASM declines, JS stores it in the TEB array
    [70, 0x70, 0, false],
    [0xffffffff, 1, 0, false],
    [3, 0, 1, true],                  // NULL is a legitimate value
    [9, 0x99, 1, true],
];

function image(): Uint8Array {
    const bytes = new Uint8Array(0x3000), view = new DataView(bytes.buffer);
    [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE,
        BASE + bytes.length, BASE + bytes.length, ENTRY]
        .forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
    let p = ENTRY - BASE;
    CALLS.forEach(([index, value], i) => {
        bytes[p++] = 0x68; view.setUint32(p, value >>> 0, true); p += 4;   // push value
        bytes[p++] = 0x68; view.setUint32(p, index >>> 0, true); p += 4;   // push index
        bytes[p++] = 0xe8; view.setInt32(p, STUB - (BASE + p + 4), true); p += 4;
        bytes[p++] = 0xa3; view.setUint32(p, RES + i * 4, true); p += 4;   // mov [RES+i*4], eax
    });
    bytes[p] = 0xf4;
    // The thunk-stub shape: mov eax, fid; mov edx, 0xB077; out dx, eax; ret 8
    bytes.set([0xb8, FID, 0, 0, 0, 0xba, 0x77, 0xb0, 0, 0, 0xef, 0xc2, 8, 0], STUB - BASE);
    return bytes;
}

function thread(): Thread {
    return {
        id: 1, handle: 1, state: ThreadState.RUNNING, context: null, stackBase: 0x100000,
        stackSize: 0x100000, stackTop: STACK, startAddress: ENTRY, parameter: 0, waitInfo: null,
        exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

interface ArmResult {
    returns: number[];
    values: Record<number, number>;
    arrayWords: number[];
    lastError: number;
    tebLastError: number;
    jsCalls: number;
    served: number;
    fellBack: number;
    afterFree: { slot: number; published: number; other: number };
}

async function runArm(routed: boolean): Promise<ArmResult> {
    const g = globalThis as { window?: unknown };
    const hadWindow = 'window' in g, savedWindow = g.window;
    delete g.window;
    const manager = hypercallDataManager as any;
    const saved = { ...manager };
    const savedTls = (manager.tlsAllocatedShadow as Uint8Array).slice();
    const { V86 } = await import(lib);
    const em = new V86({ autostart: false, memory_size: 32 << 20, wasm_path: wasm, log_level: 0, disable_jit: 1 });
    try {
        await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
        const cpu = em.v86.cpu, api = cpu.wm.exports;
        cpu.reboot_internal(); cpu.reset_memory(); cpu.load_multiboot(image().buffer);
        const mem = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
        const guest = () => new DataView(mem().buffer, mem().byteOffset);

        let bump = HEAP;
        const memory = { alloc: (size: number) => { const a = bump; bump += (size + 0xfff) & ~0xfff; return a; } };
        const s = new Scheduler();
        const teb: TebManager = s.tebManager;
        teb.initProcess(mem, memory);
        const t = thread();
        t.tebAddress = teb.allocateTeb(1, t.stackBase, t.stackTop, memory);
        (s as any).threads.set(1, t); (s as any).currentThreadId = 1;

        manager.tlsAllocatedShadow.fill(0);
        manager.initialized = false; manager.registeredEntries = new Map();
        const hp = api.get_hypercall_page_ptr() >>> 0;
        manager.initialize(cpu, hp);
        const page = () => new DataView(cpu.wasm_memory.buffer, hp);
        page().setUint32(OFF_CYCLE_LIMIT, 100_003, true);
        manager.registerFunction('kernel32', 'TlsSetValue', FID);
        if (!routed) manager.setDispatchEntry(FID, 0);
        page().setUint32(OFF_HC_ENABLED, 1, true);
        manager.syncThreadData(1, 0, t.tebAddress);

        for (let i = 0; i <= EXPANSION; i++) expect(s.tlsAlloc()).toBe(i);
        expect(s.tlsFree(FREED)).toBe(true);
        expect(s.tlsSetValue(PRESET, 0xaaaa)).toBe(true);

        let jsCalls = 0;
        cpu.io.register_write(0xb077, null, undefined, undefined, (fid: number) => {
            if (fid !== FID) return;
            jsCalls++;
            const esp = cpu.reg32[4] >>> 0;
            const index = cpu.read32s(esp + 4) >>> 0, value = cpu.read32s(esp + 8) >>> 0;
            cpu.reg32[0] = s.tlsSetValue(index, value) ? 1 : 0;   // kernel32/tls.ts TlsSetValue
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 10000);
            em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve(); });
            cpu.reg32[4] = STACK; cpu.instruction_pointer[0] = ENTRY; cpu.flags[0] = 2;
            em.run();
        });

        const returns = CALLS.map((_, i) => cpu.read32s(RES + i * 4) >>> 0);
        const values: Record<number, number> = {};
        for (const i of [3, PRESET, FREED, 9, EXPANSION]) values[i] = s.tlsGetValue(i);
        const array = teb.getTlsArrayAddress(1)!;
        const arrayWords = Array.from({ length: EXPANSION + 1 }, (_, i) => guest().getUint32(array + i * 4, true));
        const served = page().getUint32(OFF_HC_HANDLER_CALLS + HANDLER * 4, true);
        const fellBack = page().getUint32(OFF_HC_HANDLER_FALLBACKS + HANDLER * 4, true);
        expect(s.tlsFree(9)).toBe(true);
        const afterFree = {
            slot: guest().getUint32(array + 9 * 4, true),
            published: page().getUint8(OFF_HC_TLS_ALLOCATED + 9),
            other: page().getUint8(OFF_HC_TLS_ALLOCATED + 3),
        };
        return {
            returns, values, arrayWords, lastError: t.lastError,
            tebLastError: guest().getUint32(t.tebAddress + 0x34, true),
            jsCalls, served, fellBack, afterFree,
        };
    } finally {
        await em.destroy();
        for (const key of Object.keys(manager)) if (!(key in saved)) delete manager[key];
        Object.assign(manager, saved);
        manager.tlsAllocatedShadow.set(savedTls);
        if (hadWindow) g.window = savedWindow;
    }
}

describe.skipIf(!existsSync(lib) || !existsSync(wasm))('TlsSetValue hypercall, executed', () => {
    test('WASM and JS paths leave the same TLS state', async () => {
        const js = await runArm(false);
        const hc = await runArm(true);
        const expectServed = CALLS.filter(c => c[3]).length;

        expect(js.returns).toEqual(CALLS.map(c => c[2]));
        expect(js.values).toEqual({ 3: 0, [PRESET]: 0xdeadbeef, [FREED]: 0, 9: 0x99, [EXPANSION]: 0x6464 });
        expect(js.arrayWords[9]).toBe(0x99);
        expect(js.arrayWords[PRESET]).toBe(0xdeadbeef);
        expect(js.arrayWords[EXPANSION]).toBe(0x6464);   // one storage for every index
        expect(js.jsCalls).toBe(CALLS.length);
        expect(js.served + js.fellBack).toBe(0);

        expect(hc.returns).toEqual(js.returns);
        expect(hc.values).toEqual(js.values);
        expect(hc.arrayWords).toEqual(js.arrayWords);
        expect([hc.lastError, hc.tebLastError]).toEqual([js.lastError, js.tebLastError]);
        expect(hc.jsCalls).toBe(CALLS.length - expectServed);
        expect(hc.served).toBe(expectServed);
        expect(hc.fellBack).toBe(CALLS.length - expectServed);

        for (const arm of [js, hc]) expect(arm.afterFree).toEqual({ slot: 0, published: 0, other: 1 });
    }, 30000);
});
