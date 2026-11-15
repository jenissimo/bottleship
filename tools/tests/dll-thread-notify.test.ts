/**
 * DLL_THREAD_ATTACH / DLL_THREAD_DETACH. A guest thread runs DllMain(base, 2, 0) of every
 * loaded DLL in initialization order before its start routine and DllMain(base, 3, 0) in
 * reverse before it ends; DLLs that called DisableThreadLibraryCalls and unloaded ones are
 * skipped. Every entry-point call is serialized process-wide: a thread waits while another
 * runs a DLL_PROCESS_ATTACH or its own notification calls, and picks its DLLs when it gets its
 * turn. The calls are a return chain on the thread's stack, so these pin the exact words a
 * stdcall DllMain sees.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHIPPING_JIT, applyCodegenSwitches } from "../jit-config/shipping.mjs";
import {
    DLL_NOTIFY_WAITING, DLL_THREAD_ATTACH, DLL_THREAD_DETACH, DllNotifyPhase, DllThreadNotify, layNotifyChain,
} from "../../src/worker/core/dll-thread-notify";
import type { LoadedPEModule, ModuleRegistry } from "../../src/worker/core/module-registry";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState } from "../../src/worker/core/scheduler/types";
import { SEH_CATCH_COMPLETION_FUNCID } from "../../src/worker/core/thunking/thunk-memory-manager";

const mod = (name: string, base: number, entry: number, extra: Partial<LoadedPEModule> = {}): LoadedPEModule => ({
    name, path: name, baseAddress: base, size: 0x1000, entryPoint: entry,
    exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true, ...extra,
});
const registry = (mods: LoadedPEModule[]) => ({ getAllModules: () => mods }) as unknown as ModuleRegistry;
const ready = (n: DllThreadNotify, base: number) => { n.noteDllInitialized(base, 0); n.noteDllAttached(base); };

describe("notification bookkeeping", () => {
    test("initialization order, not registry order; the EXE, stubs, uninitialized and entry-less modules are skipped", () => {
        const n = new DllThreadNotify();
        const mods = [
            mod("game", 0x400000, 0x1000, { isExecutable: true }),
            mod("a", 0x10000000, 0x100), mod("b", 0x20000000, 0x200),
            mod("stub", 0x2a000000, 0x10, { isRealDll: false }),
            mod("noentry", 0x30000000, 0), mod("queued", 0x31000000, 0x10, { initialized: false }),
        ];
        ready(n, 0x20000000);
        ready(n, 0x10000000);
        expect(n.targets(registry(mods))).toEqual([
            { base: 0x20000000, entry: 0x20000200 }, { base: 0x10000000, entry: 0x10000100 },
        ]);
    });

    test("DisableThreadLibraryCalls removes a DLL until it is unloaded", () => {
        const n = new DllThreadNotify();
        const mods = [mod("a", 0x10000000, 0x100), mod("b", 0x20000000, 0x200)];
        ready(n, 0x10000000); ready(n, 0x20000000);
        n.disableThreadLibraryCalls(0x10000000);
        expect(n.targets(registry(mods)).map(t => t.base)).toEqual([0x20000000]);
        n.noteDllUnloaded(0x10000000);
        ready(n, 0x10000000);
        expect(n.targets(registry(mods)).map(t => t.base)).toEqual([0x20000000, 0x10000000]);
    });

    test("a pending DLL_PROCESS_ATTACH holds the loader for every other thread until it returned", () => {
        let idle = 0;
        const n = new DllThreadNotify(() => idle++);
        n.noteDllInitialized(0x10000000, 5);
        expect(n.loaderBusyFor(7)).toBe(true);
        expect(n.loaderBusyFor(5)).toBe(false);
        n.noteDllAttached(0x10000000);
        expect(n.loaderBusyFor(7)).toBe(false);
        expect(idle).toBe(1);
        n.noteDllAttached(0x10000000);
        expect(idle).toBe(1);
    });

    test("notification calls hold the loader; a thread that ends gives back what it held", () => {
        let idle = 0;
        const n = new DllThreadNotify(() => idle++);
        n.acquire(3);
        expect(n.loaderBusyFor(4)).toBe(true);
        expect(n.loaderBusyFor(3)).toBe(false);
        n.release(4);
        expect(n.loaderBusyFor(4)).toBe(true);
        n.release(3);
        expect(n.loaderBusyFor(4)).toBe(false);
        n.acquire(3);
        n.noteDllInitialized(0x10000000, 3);
        n.releaseThread(3);
        expect(n.loaderBusyFor(4)).toBe(false);
        expect(idle).toBe(2);
    });

    test("the savestate record round-trips; an absent record restores an empty state", () => {
        const n = new DllThreadNotify();
        const mods = [mod("a", 0x10000000, 0x100), mod("b", 0x20000000, 0x200), mod("c", 0x30000000, 0x300)];
        ready(n, 0x20000000); ready(n, 0x10000000); n.noteDllInitialized(0x30000000, 9);
        n.disableThreadLibraryCalls(0x10000000); n.acquire(4);
        const saved = JSON.parse(JSON.stringify(n.captureState()));
        const m = new DllThreadNotify();
        m.restoreState(saved);
        expect(m.captureState()).toEqual(n.captureState());
        expect(m.targets(registry(mods)).map(t => t.base)).toEqual([0x20000000]);
        expect(m.loaderBusyFor(5)).toBe(true);
        m.restoreState(undefined);
        expect(m.loaderBusyFor(5)).toBe(false);
        expect(m.targets(registry(mods)).map(t => t.base)).toEqual([0x10000000, 0x20000000, 0x30000000]);
    });
});

describe("the call chain on the stack", () => {
    test("each DllMain returns into the next with (base, reason, 0); the last returns to finalReturn with ESP = top", () => {
        const mem = new Uint8Array(0x1000), view = new DataView(mem.buffer);
        const targets = [{ base: 0x10000000, entry: 0x10000100 }, { base: 0x20000000, entry: 0x20000200 }];
        const esp = layNotifyChain(view, 0x1000, targets, DLL_THREAD_ATTACH, 0x401000);
        const words = Array.from({ length: (0x1000 - esp) / 4 }, (_, i) => view.getUint32(esp + i * 4, true));
        expect(words).toEqual([0x20000200, 0x10000000, 2, 0, 0x401000, 0x20000000, 2, 0]);
    });
});

const lib = fileURLToPath(new URL('../../vendor/v86/build/libv86.mjs', import.meta.url));
const wasm = fileURLToPath(new URL('../../public/v86.wasm', import.meta.url));
const BASE = 0x400000, DLL_A = BASE + 0x100, DLL_B = BASE + 0x140, START = BASE + 0x200, FINAL = BASE + 0x320;
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
    put(FINAL, 0x8b, 0x04, 0x24, 0xa3, [RES + 0x10], 0x89, 0x25, [RES + 0x14], 0xf4);
    view.setUint32(LOGP - BASE, LOG, true);
    return bytes;
}

describe.skipIf(!existsSync(lib) || !existsSync(wasm))('the call chain, executed in v86', () => {
    for (const jit of [false, true]) {
        test(`attach reaches the start routine with its frame; detach in reverse comes back with the exit code on top (JIT=${jit})`, async () => {
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

                view().setUint32(TOP - 8, 0x12345678, true);
                view().setUint32(TOP - 4, 0xabc, true);
                const esp = layNotifyChain(view(), TOP - 8, targets, DLL_THREAD_ATTACH, START);
                await run(targets[0]!.entry, esp);
                expect(log(4)).toEqual([0x10000000, 2, 0x20000000, 2]);
                expect([0, 4, 8].map(o => view().getUint32(RES + o, true))).toEqual([0x12345678, 0xabc, TOP - 8]);

                view().setUint32(LOGP, LOG, true);
                view().setUint32(TOP - 0x100, 0x77, true);
                const chain = layNotifyChain(view(), TOP - 0x100, [...targets].reverse(), DLL_THREAD_DETACH, FINAL);
                await run(DLL_B, chain);
                expect(log(4)).toEqual([0x20000000, 3, 0x10000000, 3]);
                expect(view().getUint32(RES + 0x10, true)).toBe(0x77);
                expect(view().getUint32(RES + 0x14, true)).toBe(TOP - 0x100);
            } finally {
                await em.destroy();
                if (hadWindow) g.window = savedWindow;
            }
        }, 20000);
    }
});

describe("scheduler: thread start and exit", () => {
    const START_ADDR = 0x401000, PARAM = 0xabc, A = 0x10000000, B = 0x20000000;
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
        return { s, mem, view, cpu, mods };
    }
    const words = (view: DataView, at: number, n: number) => Array.from({ length: n }, (_, i) => view.getUint32(at + i * 4, true));
    const mods = () => [mod("a", A, 0x100), mod("b", B, 0x200)];
    const thread = (s: Scheduler, id: number) => (s as any).threads.get(id);
    const lastId = (s: Scheduler) => (s as any).nextThreadId - 1;
    /** Make `id` the running thread with its saved registers in the CPU, as a switch would. */
    function run(s: Scheduler, cpu: any, id: number) {
        const t = thread(s, id);
        (s as any).currentThreadId = id;
        if (t.context) { cpu.reg32[4] = t.context.esp; cpu.instruction_pointer[0] = t.context.eip; }
        t.state = ThreadState.RUNNING; t.context = null;
    }
    const startStub = (s: Scheduler) => (s as any).threadStartStubAddr >>> 0;
    const exitStub = (s: Scheduler) => (s as any).threadExitStubAddr >>> 0;
    const eip = (cpu: any) => cpu.instruction_pointer[0] >>> 0;
    const esp = (cpu: any) => cpu.reg32[4] >>> 0;

    test("the start stubs use function ids no other dispatcher path claims", () => {
        const { s } = setup([]);
        for (const taken of [0x7fff0001, 0x7fff0002, SEH_CATCH_COMPLETION_FUNCID]) expect(s.isThreadStartId(taken)).toBe(false);
        expect(s.isThreadStartId(0x7fff0010) && s.isThreadStartId(0x7fff0011)).toBe(true);
    });

    test("a guest thread enters through the start stub with [exit stub, parameter]; host threads start directly", () => {
        const { s, mem, view } = setup(mods());
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const t = thread(s, lastId(s));
        expect(t.context.eip >>> 0).toBe(startStub(s));
        expect(t.dllNotify).toBe(DllNotifyPhase.START);
        expect(words(view, t.context.esp >>> 0, 2)).toEqual([exitStub(s), PARAM]);
        expect(Array.from(mem.subarray(startStub(s), startStub(s) + 11))).toEqual([0xb8, 0x10, 0x00, 0xff, 0x7f, 0xba, 0x77, 0xb0, 0, 0, 0xef]);
        expect(Array.from(mem.subarray(startStub(s) + 16, startStub(s) + 21))).toEqual([0xb8, 0x11, 0x00, 0xff, 0x7f]);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, false);
        const h = thread(s, lastId(s));
        expect(h.context.eip >>> 0).toBe(START_ADDR);
        expect(h.dllNotify).toBe(DllNotifyPhase.NONE);
    });

    test("the start stub runs DLL_THREAD_ATTACH in order holding the loader, then the start routine with its frame", () => {
        const { s, mem, view, cpu } = setup(mods());
        ready(s.dllNotify, A); ready(s.dllNotify, B);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s);
        run(s, cpu, id);
        const top = esp(cpu);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("chain");
        expect(eip(cpu)).toBe(A + 0x100);
        expect(words(view, esp(cpu), 10)).toEqual([B + 0x200, A, 2, 0, startStub(s) + 16, B, 2, 0, exitStub(s), PARAM]);
        expect(esp(cpu) + 32).toBe(top);
        expect(s.dllNotify.loaderBusyFor(id + 1)).toBe(true);
        cpu.reg32[4] = top;
        expect(s.handleThreadStartStub(0x7fff0011, cpu as any, mem)).toBe("chain");
        expect(eip(cpu)).toBe(START_ADDR);
        expect(esp(cpu)).toBe(top);
        expect(thread(s, id).dllNotify).toBe(DllNotifyPhase.RUNNING);
        expect(s.dllNotify.loaderBusyFor(id + 1)).toBe(false);
    });

    test("a thread whose start meets a pending DLL_PROCESS_ATTACH waits for it, then notifies that DLL too", () => {
        const { s, mem, view, cpu } = setup(mods());
        ready(s.dllNotify, A);
        s.dllNotify.noteDllInitialized(B, 99);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s);
        run(s, cpu, id);
        const top = esp(cpu);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("parked");
        const t = thread(s, id);
        expect(t.state).toBe(ThreadState.WAITING);
        expect(t.context.eip >>> 0).toBe(startStub(s));
        expect(t.context.esp >>> 0).toBe(top);
        expect(t.dllNotify & DLL_NOTIFY_WAITING).toBe(DLL_NOTIFY_WAITING);
        s.dllNotify.noteDllAttached(B);
        expect(t.state).toBe(ThreadState.READY);
        expect(t.dllNotify).toBe(DllNotifyPhase.START);
        run(s, cpu, id);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("chain");
        expect(words(view, esp(cpu), 8)).toEqual([B + 0x200, A, 2, 0, startStub(s) + 16, B, 2, 0]);
    });

    test("a thread waits while another thread runs its notification calls", () => {
        const { s, mem, cpu } = setup(mods());
        ready(s.dllNotify, A);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const first = lastId(s);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const second = lastId(s);
        run(s, cpu, first);
        const top = esp(cpu);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("chain");
        thread(s, first).state = ThreadState.READY; thread(s, first).context = { eip: 0, esp: 0 };
        run(s, cpu, second);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("parked");
        run(s, cpu, first);
        cpu.reg32[4] = top;
        expect(s.handleThreadStartStub(0x7fff0011, cpu as any, mem)).toBe("chain");
        expect(thread(s, second).state).toBe(ThreadState.READY);
    });

    test("CREATE_SUSPENDED: the DLLs are those loaded when the thread first runs, not when it was created", () => {
        const list = [mod("old", A, 0x100)];
        const { s, mem, view, cpu } = setup(list);
        ready(s.dllNotify, A);
        s.createThread(START_ADDR, PARAM, 1 << 20, 4 /* CREATE_SUSPENDED */, 0, mem, true);
        const id = lastId(s);
        const top = thread(s, id).context.esp >>> 0;
        expect(words(view, top, 2)).toEqual([exitStub(s), PARAM]);
        list.pop(); s.dllNotify.noteDllUnloaded(A);
        list.push(mod("new", B, 0x200)); ready(s.dllNotify, B);
        expect(s.resumeThread(thread(s, id).handle)).toBe(1);
        run(s, cpu, id);
        expect(eip(cpu)).toBe(startStub(s));
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("chain");
        expect(eip(cpu)).toBe(B + 0x200);
        expect(words(view, esp(cpu), 6)).toEqual([startStub(s) + 16, B, 2, 0, exitStub(s), PARAM]);
    });

    test("DLL_THREAD_DETACH needs no DLL_THREAD_ATTACH: a DLL loaded after the thread started is notified on ExitThread", () => {
        const list: LoadedPEModule[] = [];
        const { s, mem, view, cpu } = setup(list);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s);
        run(s, cpu, id);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("chain");
        expect(eip(cpu)).toBe(START_ADDR);
        list.push(mod("late", A, 0x100)); ready(s.dllNotify, A);
        const callEsp = esp(cpu) - 0x40;
        view.setUint32(callEsp, 0x401234, true);
        expect(s.exitThreadThroughStub(callEsp, 0x66, 4, mem)).toEqual({ value: 0x66, stackCleanup: 4 });
        expect(view.getUint32(callEsp, true)).toBe(exitStub(s));
        const stubEsp = callEsp + 4;
        view.setUint32(stubEsp, 0x66, true);
        cpu.reg32[4] = stubEsp;
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe("chain");
        expect(eip(cpu)).toBe(A + 0x100);
        expect(words(view, esp(cpu), 5)).toEqual([exitStub(s) + 1, A, 3, 0, 0x66]);
        cpu.reg32[4] = stubEsp;
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe("ended");
        expect(thread(s, id).state).toBe(ThreadState.TERMINATED);
        expect(thread(s, id).exitCode).toBe(0x66);
        expect(s.dllNotify.loaderBusyFor(id + 1)).toBe(false);
    });

    test("the initial process thread owes DLL_THREAD_DETACH too", () => {
        const { s, mem, cpu } = setup(mods());
        ready(s.dllNotify, A);
        (s as any).currentThreadId = null;
        cpu.reg32[4] = 0x180000; cpu.instruction_pointer[0] = 0x401000;
        (s as any).ensureMainThread();
        const main = (s as any).mainThreadId;
        expect(thread(s, main).dllNotify).toBe(DllNotifyPhase.RUNNING);
        expect(s.exitThreadThroughStub(0x17ff00, 0, 4, mem)).not.toBeNull();
    });

    test("returning into the exit stub: detach in reverse, once; the second pass ends the thread", () => {
        const { s, mem, view, cpu } = setup(mods());
        ready(s.dllNotify, A); ready(s.dllNotify, B);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s), t = thread(s, id);
        run(s, cpu, id);
        t.dllNotify = DllNotifyPhase.RUNNING;
        const at = t.stackTop - 0x100;
        view.setUint32(at, 0x55, true);
        cpu.reg32[4] = at;
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe("chain");
        expect(words(view, esp(cpu), 9)).toEqual([A + 0x100, B, 3, 0, exitStub(s) + 1, A, 3, 0, 0x55]);
        expect(t.dllNotify).toBe(DllNotifyPhase.DETACHING);
        expect(s.exitThreadThroughStub(at, 0x55, 4, mem)).toBeNull();
        cpu.reg32[4] = at;
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe("ended");
        expect(t.exitCode).toBe(0x55);
    });

    test("an exit while the loader is busy waits with the exit code kept on its stack", () => {
        const { s, mem, view, cpu } = setup(mods());
        ready(s.dllNotify, A);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s), t = thread(s, id);
        run(s, cpu, id);
        t.dllNotify = DllNotifyPhase.RUNNING;
        const at = t.stackTop - 0x100;
        view.setUint32(at, 0x44, true);
        cpu.reg32[4] = at;
        s.dllNotify.noteDllInitialized(B, 99);
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe("parked");
        expect(t.state).toBe(ThreadState.WAITING);
        expect(t.context.eip >>> 0).toBe(exitStub(s) + 1);
        expect(view.getUint32(at, true)).toBe(0x44);
        s.dllNotify.noteDllAttached(B);
        expect(t.state).toBe(ThreadState.READY);
        run(s, cpu, id);
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe("chain");
        expect(words(view, esp(cpu), 9)).toEqual([A + 0x100, B, 3, 0, exitStub(s) + 1, A, 3, 0, 0x44]);
    });

    test("no room for the detach chain on the stack: nothing below it is written, the loader is not taken", () => {
        const { s, mem, view, cpu } = setup(mods());
        ready(s.dllNotify, A); ready(s.dllNotify, B);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s), t = thread(s, id);
        run(s, cpu, id);
        t.dllNotify = DllNotifyPhase.RUNNING;
        const low = t.stackBase >>> 0, at = low + 0x10;
        mem.fill(0xcc, low - 0x40, low);
        view.setUint32(at, 0x33, true);
        cpu.reg32[4] = at;
        expect(s.handleThreadExitStub(cpu as any, mem)).toBe("ended");
        expect(Array.from(mem.subarray(low - 0x40, low)).every(b => b === 0xcc)).toBe(true);
        expect(t.state).toBe(ThreadState.TERMINATED);
        expect(t.exitCode).toBe(0x33);
        expect(s.dllNotify.loaderBusyFor(id + 1)).toBe(false);
    });

    test("ExitThread from a stack it may not write ends the thread directly, writing nothing", () => {
        const { s, mem, view, cpu } = setup(mods());
        ready(s.dllNotify, A);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s), t = thread(s, id);
        run(s, cpu, id);
        t.dllNotify = DllNotifyPhase.RUNNING;
        const foreign = 0x900000;
        view.setUint32(foreign, 0x1111, true);
        expect(s.exitThreadThroughStub(foreign, 0x22, 4, mem)).toBeNull();
        expect(view.getUint32(foreign, true)).toBe(0x1111);
        expect(t.dllNotify).toBe(DllNotifyPhase.RUNNING);
    });

    test("a terminated thread gives back the loader it held; a parked waiter is woken", () => {
        const { s, mem, cpu } = setup(mods());
        ready(s.dllNotify, A);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const first = lastId(s);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const second = lastId(s);
        run(s, cpu, first);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("chain");
        thread(s, first).state = ThreadState.READY; thread(s, first).context = { eip: 0, esp: 0 };
        run(s, cpu, second);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("parked");
        (s as any).terminateThread(first, 1);
        expect(thread(s, second).state).toBe(ThreadState.READY);
        expect(s.dllNotify.loaderBusyFor(second)).toBe(false);
    });

    test("savestate: phases, the parked waiter and the loader owner survive a capture/restore", () => {
        const { s, mem, cpu } = setup(mods());
        ready(s.dllNotify, A);
        s.dllNotify.disableThreadLibraryCalls(B);
        s.dllNotify.noteDllInitialized(B, 77);
        s.createThread(START_ADDR, PARAM, 1 << 20, 0, 0, mem, true);
        const id = lastId(s);
        run(s, cpu, id);
        expect(s.handleThreadStartStub(0x7fff0010, cpu as any, mem)).toBe("parked");
        const objects: unknown[] = [];
        const state = JSON.parse(JSON.stringify(s.captureState(o => objects.push(o) - 1)));
        expect(state.threadStartStubAddr).toBe(startStub(s));
        const r = setup(mods()).s;
        r.restoreState(state, i => objects[i]);
        expect(thread(r, id).dllNotify).toBe(DllNotifyPhase.START | DLL_NOTIFY_WAITING);
        expect((r as any).threadStartStubAddr).toBe(startStub(s));
        expect(r.dllNotify.captureState()).toEqual(s.dllNotify.captureState());
        r.dllNotify.noteDllAttached(B);
        expect(thread(r, id).state).toBe(ThreadState.READY);
        expect(thread(r, id).dllNotify).toBe(DllNotifyPhase.START);
        delete state.dllNotify; delete state.threadStartStubAddr;
        for (const t of state.threads) delete t.dllNotify;
        const old = setup(mods()).s;
        old.restoreState(state, i => objects[i]);
        expect(thread(old, id).dllNotify).toBe(DllNotifyPhase.NONE);
        expect(old.dllNotify.loaderBusyFor(id)).toBe(false);
    });
});

describe("dispatcher: a load's DLL_PROCESS_ATTACH waits for another thread's notification calls", () => {
    const B = 0x30000000, ENTRY = B + 0x100;
    function fixture() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ThunkDispatcher } = require("../../src/worker/core/thunking/thunk-dispatcher");
        const d = new ThunkDispatcher({ add_listener() {} } as any, { getStubById: () => undefined } as any) as any;
        const ram = new WebAssembly.Memory({ initial: 1, maximum: 3 });
        const notify = new DllThreadNotify();
        let tid = 2;
        const calls: number[][] = [];
        const completions: Array<(ret: number) => number | null> = [];
        const restored: number[] = [];
        d.ensureScheduler = () => ({
            dllNotify: notify,
            getCurrentThreadId: () => tid,
            getCurrentThread: () => ({ id: tid, kernelPinCount: 0 }),
            wakeThreadForAsyncCompletion: () => true,
            markThreadRunningAfterAsyncWake() {},
            requestSwitchToThread() {},
            isThreadAsyncParked: () => true,
            validateAsyncRestoreTarget: () => ({ ok: true }),
            rejectAsyncRestore() {},
        });
        d._callbackManager = {
            reset() {},
            getStubPoolRange: () => ({ base: 0, end: 0 }),
            saveSuspendedThunkContext: () => 7,
            invokeCallback: (entry: number, args: number[], _a: number, complete: (r: number) => number | null) => {
                calls.push([entry, ...args]); completions.push(complete); return { callbackId: 1 };
            },
        };
        d.updateMemoryCache = () => { d.cachedMem8 = new Uint8Array(ram.buffer); };
        d.kickV86IfIdleForAsyncWake = () => {};
        d._restoreAsyncContext = (_i: unknown, _c: unknown, value: number) => { restored.push(value); };
        const cpu = { instruction_pointer: [0x7000], reg32: [0, 0, 0, 0, 0x200] };
        const load = (thread: number, base = B) => {
            notify.noteDllInitialized(base, 99);
            d._onAsyncComplete(Promise.resolve(),
                { value: base, stackCleanup: 4, dllInits: [{ baseAddress: base, entryPoint: base + 0x100, name: "dll" }] },
                { epoch: d.asyncEpoch, functionId: 1, threadId: thread, asyncParkGeneration: 1, esp: 0x200, returnAddr: 0x401000, startTime: performance.now() },
                cpu, 1, "kernel32:LoadLibraryA", performance.now());
        };
        return { d, notify, calls, completions, restored, load, poll: () => d.tryApplyPendingAsyncRestoreAtSafePoint(cpu), setThread: (t: number) => { tid = t; } };
    }

    test("T1 in its THREAD_ATTACH calls, T2's LoadLibrary completes: no process attach until T1 releases, then exactly one", () => {
        const f = fixture();
        f.notify.acquire(1);
        f.load(2);
        expect(f.notify.loaderBusyFor(2)).toBe(true);
        for (let i = 0; i < 3; i++) f.poll();
        expect(f.calls).toEqual([]);
        expect(f.d.pendingAsyncRestores.length).toBe(1);
        f.notify.release(1);
        f.poll();
        expect(f.calls).toEqual([[ENTRY, B, 1, 0]]);
        expect(f.d.pendingAsyncRestores.length).toBe(0);
        expect(f.completions[0]!(1)).toBe(B);
        expect(f.notify.loaderBusyFor(1)).toBe(false);
        f.poll();
        expect(f.calls.length).toBe(1);
    });

    test("an in-process COM server's DLL_PROCESS_ATTACH chain waits the same way", () => {
        const f = fixture();
        f.notify.acquire(1);
        f.notify.noteDllInitialized(B, 99);
        let started = 0;
        f.d._onAsyncComplete(Promise.resolve(),
            { value: 0, dllInits: [{ baseAddress: B, entryPoint: ENTRY, name: "b" }], startCallbackChain: () => { started++; return true; } },
            { epoch: f.d.asyncEpoch, functionId: 1, threadId: 2, asyncParkGeneration: 1, esp: 0x200, returnAddr: 0x401000, startTime: performance.now() },
            {}, 4, "ole32:CoCreateInstance", performance.now());
        f.poll(); f.poll();
        expect(started).toBe(0);
        f.notify.release(1);
        f.poll();
        expect(started).toBe(1);
    });

    test("two completed loads with the loader idle: one runs, the other follows after it returns", () => {
        const f = fixture();
        const A = 0x28000000;
        f.load(1, A);
        f.load(2, B);
        expect(f.notify.holder()).toBe(1);
        f.setThread(2); f.poll(); f.poll();
        expect(f.calls).toEqual([]);
        f.setThread(1); f.poll();
        expect(f.calls).toEqual([[A + 0x100, A, 1, 0]]);
        f.setThread(2); f.poll();
        expect(f.calls.length).toBe(1);
        expect(f.completions[0]!(1)).toBe(A);
        f.poll();
        expect(f.calls).toEqual([[A + 0x100, A, 1, 0], [ENTRY, B, 1, 0]]);
        expect(f.completions[1]!(1)).toBe(B);
        expect(f.d.pendingAsyncRestores.length).toBe(0);
        expect(f.notify.holder()).toBe(-1);
    });

    test("the chain owner loads reentrantly although another thread's load is queued; that one follows the release", () => {
        const f = fixture();
        const C = 0x38000000;
        f.notify.acquire(1);
        f.load(2, B);
        f.setThread(2); f.poll();
        expect(f.calls).toEqual([]);
        f.setThread(1);
        f.load(1, C);
        f.poll();
        expect(f.calls).toEqual([[C + 0x100, C, 1, 0]]);
        expect(f.completions[0]!(1)).toBe(C);
        f.setThread(2); f.poll();
        expect(f.calls.length).toBe(1);
        f.notify.release(1);
        f.poll();
        expect(f.calls).toEqual([[C + 0x100, C, 1, 0], [ENTRY, B, 1, 0]]);
    });

    test("a load from inside the owner's own notification call runs at once (reentrant)", () => {
        const f = fixture();
        f.notify.acquire(2);
        f.load(2);
        f.poll();
        expect(f.calls).toEqual([[ENTRY, B, 1, 0]]);
    });
});
