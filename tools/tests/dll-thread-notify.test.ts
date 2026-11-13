/**
 * DLL_THREAD_ATTACH / DLL_THREAD_DETACH. A guest thread first runs DllMain(base, 2, 0) of
 * every loaded DLL in initialization order and ends with DllMain(base, 3, 0) in reverse;
 * DLLs that called DisableThreadLibraryCalls and unloaded ones are skipped. The calls are a
 * return chain on the thread's stack, so these pin the exact words a stdcall DllMain sees.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHIPPING_JIT, applyCodegenSwitches } from "../jit-config/shipping.mjs";
import {
    DLL_THREAD_ATTACH, DLL_THREAD_DETACH, disableThreadLibraryCalls, layNotifyChain, layNotifyChainForRet, markThreadAttached, noteDllAttached, noteDllInitialized,
    noteDllUnloaded, resetDllThreadNotify, takeThreadDetach, threadNotifyTargets,
} from "../../src/worker/core/dll-thread-notify";
import type { LoadedPEModule, ModuleRegistry } from "../../src/worker/core/module-registry";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState } from "../../src/worker/core/scheduler/types";

const mod = (name: string, base: number, entry: number, extra: Partial<LoadedPEModule> = {}): LoadedPEModule => ({
    name, path: name, baseAddress: base, size: 0x1000, entryPoint: entry,
    exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true, ...extra,
});
const registry = (mods: LoadedPEModule[]) => ({ getAllModules: () => mods }) as unknown as ModuleRegistry;

beforeEach(() => resetDllThreadNotify());
const ready = (base: number) => { noteDllInitialized(base); noteDllAttached(base); };

describe("thread notification targets", () => {
    test("initialization order, not registry order; the EXE, stubs, uninitialized and entry-less modules are skipped", () => {
        const mods = [
            mod("game", 0x400000, 0x1000, { isExecutable: true }),
            mod("a", 0x10000000, 0x100), mod("b", 0x20000000, 0x200),
            mod("stub", 0x2a000000, 0x10, { isRealDll: false }),
            mod("noentry", 0x30000000, 0), mod("queued", 0x31000000, 0x10, { initialized: false }),
        ];
        ready(0x20000000);
        ready(0x10000000);
        expect(threadNotifyTargets(registry(mods))).toEqual([
            { base: 0x20000000, entry: 0x20000200 }, { base: 0x10000000, entry: 0x10000100 },
        ]);
    });

    test("DisableThreadLibraryCalls removes a DLL until it is unloaded", () => {
        const mods = [mod("a", 0x10000000, 0x100), mod("b", 0x20000000, 0x200)];
        ready(0x10000000); ready(0x20000000);
        disableThreadLibraryCalls(0x10000000);
        expect(threadNotifyTargets(registry(mods)).map(t => t.base)).toEqual([0x20000000]);
        noteDllUnloaded(0x10000000);
        ready(0x10000000);
        expect(threadNotifyTargets(registry(mods)).map(t => t.base)).toEqual([0x20000000, 0x10000000]);
    });

    test("a DLL whose DLL_PROCESS_ATTACH has not returned yet is not notified (loader lock)", () => {
        const mods = [mod("a", 0x10000000, 0x100), mod("b", 0x20000000, 0x200)];
        ready(0x10000000);
        noteDllInitialized(0x20000000);
        expect(threadNotifyTargets(registry(mods)).map(t => t.base)).toEqual([0x10000000]);
        noteDllAttached(0x20000000);
        expect(threadNotifyTargets(registry(mods)).map(t => t.base)).toEqual([0x10000000, 0x20000000]);
    });

    test("a thread owes its detach once", () => {
        markThreadAttached(7);
        expect(takeThreadDetach(7)).toBe(true);
        expect(takeThreadDetach(7)).toBe(false);
        expect(takeThreadDetach(8)).toBe(false);
    });
});

describe("the call chain on the stack", () => {
    test("each DllMain returns into the next with (base, reason, 0); the last returns to the start routine", () => {
        const mem = new Uint8Array(0x1000), view = new DataView(mem.buffer);
        const targets = [{ base: 0x10000000, entry: 0x10000100 }, { base: 0x20000000, entry: 0x20000200 }];
        const esp = layNotifyChain(view, 0x1000, targets, DLL_THREAD_ATTACH, 0x401000, [0x21000000, 0x1234]);
        const words = Array.from({ length: (0x1000 - esp) / 4 }, (_, i) => view.getUint32(esp + i * 4, true));
        expect(words).toEqual([
            0x20000200, 0x10000000, 2, 0,
            0x401000, 0x20000000, 2, 0,
            0x21000000, 0x1234,
        ]);
        expect(0x1000 - esp).toBe(40);
    });
});

const lib = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const wasm = fileURLToPath(new URL('../../public/v86.wasm', import.meta.url));
const BASE = 0x400000, DLL_A = BASE + 0x100, DLL_B = BASE + 0x140, START = BASE + 0x200;
const RET = BASE + 0x2ff, PIVOT = BASE + 0x300, FINAL = BASE + 0x320;
const LOGP = BASE + 0x2000, LOG = BASE + 0x2100, RES = BASE + 0x2800, TOP = 0x200000;

function image(): Uint8Array {
    const bytes = new Uint8Array(0x3000), view = new DataView(bytes.buffer);
    [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE,
        BASE + bytes.length, BASE + bytes.length, START]
        .forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
    const put = (at: number, ...parts: (number | [number])[]) => {
        let p = at - BASE;
        for (const x of parts) {
            if (Array.isArray(x)) { view.setUint32(p, x[0]! >>> 0, true); p += 4; } else bytes[p++] = x;
        }
    };
    const dllMain = [0xa1, [LOGP], 0x8b, 0x54, 0x24, 0x04, 0x89, 0x10, 0x8b, 0x54, 0x24, 0x08, 0x89, 0x50, 0x04,
        0x83, 0x05, [LOGP], 0x08, 0xb8, [1], 0xc2, 0x0c, 0x00] as (number | [number])[];
    put(DLL_A, ...dllMain);
    put(DLL_B, ...dllMain);
    put(START, 0x8b, 0x04, 0x24, 0xa3, [RES], 0x8b, 0x44, 0x24, 0x04, 0xa3, [RES + 4], 0x89, 0x25, [RES + 8], 0xf4);
    put(RET, 0xc3, 0x5c, 0xc3);
    put(FINAL, 0x8b, 0x04, 0x24, 0xa3, [RES + 0x10], 0x89, 0x25, [RES + 0x14], 0xf4);
    view.setUint32(LOGP - BASE, LOG, true);
    return bytes;
}

describe.skipIf(!existsSync(lib) || !existsSync(wasm))('the call chain, executed in v86', () => {
    for (const jit of [false, true]) {
        test(`attach reaches the start routine with its frame; ExitThread's pivot runs detach in reverse (JIT=${jit})`, async () => {
            const g = globalThis as { window?: unknown };
            const hadWindow = 'window' in g, savedWindow = g.window;
            delete g.window;
            const { V86 } = await import(lib);
            const em = new V86({ autostart: false, memory_size: 32 << 20,
                wasm_path: wasm, log_level: 0, disable_jit: jit ? 0 : 1 });
            try {
                await new Promise<void>(resolve => em.add_listener('emulator-loaded', resolve));
                const cpu = em.v86.cpu;
                cpu.reboot_internal(); cpu.reset_memory(); cpu.load_multiboot(image().buffer);
                for (const [index, value] of SHIPPING_JIT) cpu.wm.exports.set_jit_config(index, value);
                applyCodegenSwitches(cpu.wm.exports);
                const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
                const run = (eip: number, esp: number) => new Promise<void>((resolve, reject) => {
                    cpu.reg32[4] = esp; cpu.instruction_pointer[0] = eip; cpu.flags[0] = 2; cpu.in_hlt[0] = 0;
                    const timer = setTimeout(() => { em.stop(); reject(new Error('guest did not halt')); }, 10000);
                    const halt = () => { clearTimeout(timer); em.stop(); em.bus.unregister('cpu-event-halt', halt); resolve(); };
                    em.bus.register('cpu-event-halt', halt); em.run();
                });
                const log = (n: number) => Array.from({ length: n }, (_, i) => view().getUint32(LOG + i * 4, true));
                const targets = [{ base: 0x10000000, entry: DLL_A }, { base: 0x20000000, entry: DLL_B }];

                const esp = layNotifyChain(view(), TOP, targets, DLL_THREAD_ATTACH, START, [0x12345678, 0xabc]);
                await run(targets[0]!.entry, esp);
                expect(log(4)).toEqual([0x10000000, 2, 0x20000000, 2]);
                expect([0, 4, 8].map(o => view().getUint32(RES + o, true))).toEqual([0x12345678, 0xabc, TOP - 8]);

                view().setUint32(LOGP, LOG, true);
                const chain = layNotifyChainForRet(view(), TOP - 0x100, [...targets].reverse(), DLL_THREAD_DETACH, FINAL, [0x77]);
                view().setUint32(TOP - 0x200, PIVOT, true);
                view().setUint32(TOP - 0x1fc, chain, true);
                await run(RET, TOP - 0x200);
                expect(log(4)).toEqual([0x20000000, 3, 0x10000000, 3]);
                expect(view().getUint32(RES + 0x10, true)).toBe(0x77);
                expect(view().getUint32(RES + 0x14, true)).toBe(TOP - 0x104);
            } finally {
                await em.destroy();
                if (hadWindow) g.window = savedWindow;
            }
        }, 20000);
    }
});

describe("scheduler: thread start and exit", () => {
    const START_ADDR = 0x401000, PARAM = 0xabc;
    function setup(mods: LoadedPEModule[]) {
        const mem = new Uint8Array(16 << 20), view = new DataView(mem.buffer);
        let next = 0x100000;
        const memory = { alloc: (size: number, _k?: string, _p?: string, align = 8) => {
            const a = (next + align - 1) & ~(align - 1); next = a + size; return a; }, free: () => {} };
        const cpu = { reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), flags: new Int32Array(1),
            sreg: new Int16Array(8), segment_offsets: new Int32Array(8), instruction_counter: new Int32Array(1) };
        const s = new Scheduler();
        (s as any).process = { memory, pageTableManager: null, moduleRegistry: registry(mods),
            dispatcher: { hasActiveAsyncThunkForThread: () => false }, getCurrentMemory: () => mem, v86: { cpu } };
        s.tebManager.initProcess(() => mem, memory as any);
        (s as any).currentThreadId = 0;
        return { s, mem, view, cpu };
    }
    const words = (view: DataView, at: number, n: number) => Array.from({ length: n }, (_, i) => view.getUint32(at + i * 4, true));
    const mods = () => [mod("a", 0x10000000, 0x100), mod("b", 0x20000000, 0x200)];

    test("CreateThread enters the first DllMain; the chain ends in the start routine with [exit stub, parameter]", () => {
        const { s, mem, view } = setup(mods());
        ready(0x10000000); ready(0x20000000);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const t = (s as any).threads.get((s as any).nextThreadId - 1);
        const stub = (s as any).threadExitStubAddr;
        expect(t.context.eip >>> 0).toBe(0x10000100);
        expect(words(view, t.context.esp >>> 0, 10)).toEqual([
            0x20000200, 0x10000000, 2, 0, START_ADDR, 0x20000000, 2, 0, stub, PARAM]);
    });

    test("without notification (host-internal threads) or without DLLs the start routine is entered directly", () => {
        for (const [list, notify] of [[mods(), false], [[], true]] as const) {
            resetDllThreadNotify();
            const { s, mem, view } = setup([...list]);
            ready(0x10000000);
            s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, notify);
            const t = (s as any).threads.get((s as any).nextThreadId - 1);
            expect(t.context.eip >>> 0).toBe(START_ADDR);
            expect(words(view, t.context.esp >>> 0, 2)).toEqual([(s as any).threadExitStubAddr, PARAM]);
        }
    });

    test("returning into the exit stub runs DLL_THREAD_DETACH in reverse first, then the thread ends", () => {
        const { s, mem, view, cpu } = setup(mods());
        ready(0x10000000); ready(0x20000000);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = (s as any).nextThreadId - 1, t = (s as any).threads.get(id);
        (s as any).currentThreadId = id; t.state = ThreadState.RUNNING;
        const stub = (s as any).threadExitStubAddr;
        const esp = 0x80000;
        view.setUint32(esp, 0x55, true);
        cpu.reg32[4] = esp;
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe(true);
        expect(cpu.instruction_pointer[0]! >>> 0).toBe(stub + 16);
        expect([mem[stub + 16], mem[stub + 17]]).toEqual([0x5c, 0xc3]);
        const slot = cpu.reg32[4]! >>> 0, chain = view.getUint32(slot, true);
        expect(words(view, chain, 10)).toEqual([0x20000200, 0x10000100, 0x20000000, 3, 0, stub + 1, 0x10000000, 3, 0, 0x55]);
        expect(chain + 40).toBe(esp);
        expect(t.state).toBe(ThreadState.RUNNING);
        cpu.reg32[4] = esp;
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe(false);
        expect(t.state).toBe(ThreadState.TERMINATED);
        expect(t.exitCode).toBe(0x55);
    });

    test("ExitThread returns through the pivot into the detach chain, once", () => {
        const { s, mem, view } = setup(mods());
        ready(0x10000000); ready(0x20000000);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = (s as any).nextThreadId - 1;
        (s as any).currentThreadId = id; (s as any).threads.get(id).state = ThreadState.RUNNING;
        const stub = (s as any).threadExitStubAddr, esp = 0x80000;
        expect(s.exitThreadWithDetach(esp, 0x66, mem)).toEqual({ value: 0, stackCleanup: 0 });
        expect(view.getUint32(esp, true)).toBe(stub + 16);
        const chain = view.getUint32(esp + 4, true);
        expect(words(view, chain, 10)).toEqual([0x20000200, 0x10000100, 0x20000000, 3, 0, stub + 1, 0x10000000, 3, 0, 0x66]);
        expect(chain + 40).toBeLessThanOrEqual(esp - 0x100);
        expect(s.exitThreadWithDetach(esp, 0x66, mem)).toBeNull();
    });
});
