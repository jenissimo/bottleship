import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CPU_FIELDS, captureCpu, restoreCpu, type V86Cpu } from "../../src/worker/savestate/participants/cpu";
import { TimerWheel } from "../../src/worker/core/scheduler/timer-wheel";
import { TimerKind, ThreadState, WaitReason, type Thread } from "../../src/worker/core/scheduler/types";
import { Scheduler, THREAD_FIELDS } from "../../src/worker/core/scheduler/scheduler";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { ResourceTable } from "../../src/worker/core/resource-table";
import { newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { STATELESS_MODULES } from "../../src/worker/savestate/stateless-modules";
import { checkLoadedModules, registerCoreParticipants, touchedModules } from "../../src/worker/savestate/core-participants";
import { ParticipantRegistry, savestateParticipants, schemaHash, uncoveredModules } from "../../src/worker/savestate/participant";
import { captureKernel32State, restoreKernel32State } from "../../src/worker/modules/kernel32/savestate";
import { namedObjects } from "../../src/worker/modules/kernel32/named-objects";
import { captureAtoms } from "../../src/worker/modules/kernel32/atom";
import { consoleScreenBuffers } from "../../src/worker/modules/kernel32/console-screen-buffer";
import { System } from "../../src/worker/core/system";
import { ThunkDispatcher } from "../../src/worker/core/thunking/thunk-dispatcher";
import { newCaptureRun } from "../../src/worker/savestate/session";
import { markRestartable } from "../../src/worker/core/thunking/restartable";
import { resetAtomTable } from "../../src/worker/modules/kernel32/atom";
import { resetFlsState } from "../../src/worker/modules/kernel32/fls";
import { resetAllSrwLocks } from "../../src/worker/modules/kernel32/srw-lock";
import { resetResourceCache } from "../../src/worker/modules/kernel32/resource";
import { resetCommandLineState } from "../../src/worker/modules/kernel32/command/command";
import { resetConsoleModeState } from "../../src/worker/modules/kernel32/file-io-console";
import { resetPointerCookie } from "../../src/worker/modules/kernel32/exception";
import { resetIoCompletionWaiters, resetSyncState } from "../../src/worker/modules/kernel32/sync";
import { resetVistaRuntimeState } from "../../src/worker/modules/kernel32/vista-runtime";
import { resetProcessApiState } from "../../src/worker/modules/kernel32/process/process";
import { resetVistaSystemState } from "../../src/worker/modules/kernel32/process/vista-system";
import { resetActCtxState } from "../../src/worker/modules/kernel32/process/actctx";
import { getVirtualProcessManager } from "../../src/worker/modules/kernel32/process/virtual-process-manager";
import { resetProcessStartupInfo } from "../../src/worker/core/process-startup-info";
import { setFileApisAnsi } from "../../src/worker/modules/kernel32/file-io-strings";
import { TimeService } from "../../src/worker/runtime/time";
import { PARTICIPANT_IDS } from "../../src/worker/savestate/participant-ids";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import { createInputExports } from "../../src/worker/modules/user32/input";
import { createSystemExports } from "../../src/worker/modules/user32/system";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { registerDDrawParticipant } from "../../src/worker/modules/ddraw/savestate";
import { WinMM } from "../../src/worker/modules/winmm";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { DInput } from "../../src/worker/modules/dinput/dinput";
import { DMusic } from "../../src/worker/modules/dmusic";
import { clearTimerHandler } from "../../src/worker/core/scheduler/timer-wheel";
import { exports as vistaRuntimeExports } from "../../src/worker/modules/kernel32/vista-runtime";
import { exports as processExports } from "../../src/worker/modules/kernel32/process/process";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return { json: e.json, blobs: e.blobs.map(b => [...b]) };
};

function roundTrip<S>(capture: () => S, restore: (s: S) => void): void {
    const first = capture();
    const encoded = bytes(first);
    restore(structuredClone(first));
    expect(bytes(capture())).toEqual(encoded);
}

function fakeCpu(): V86Cpu {
    const cpu: Record<string, unknown> = {};
    let n = 1;
    for (const name of Object.keys(CPU_FIELDS)) {
        const arr = name === 'current_tsc' ? new Int32Array(2)
            : name === 'fpu_st' || name === 'last_result' ? new Float64Array(8)
            : name === 'sreg' || name === 'segment_access_bytes' ? new Uint16Array(8) : new Int32Array(8);
        for (let i = 0; i < arr.length; i++) arr[i] = (n++ * 7) % 251;
        cpu[name] = arr;
    }
    (cpu.memory_size as Int32Array)[0] = 1 << 20;
    let tsc: [number, number] = [0, 0];
    cpu.store_current_tsc = () => { (cpu.current_tsc as Int32Array).set(tsc); };
    cpu.set_tsc = (lo: number, hi: number) => { tsc = [lo, hi]; (cpu.current_tsc as Int32Array).set(tsc); };
    cpu.update_state_flags = () => {};
    cpu.full_clear_tlb = () => {};
    cpu.jit_clear_cache = () => {};
    cpu.fw_value = null;
    return cpu as unknown as V86Cpu;
}

function resetKernel32Session(): void {
    resetAtomTable();
    resetFlsState();
    resetAllSrwLocks();
    namedObjects.reset();
    resetResourceCache();
    resetCommandLineState();
    resetConsoleModeState();
    resetPointerCookie();
    resetIoCompletionWaiters();
    resetSyncState();
    resetVistaRuntimeState();
    resetProcessApiState();
    resetVistaSystemState();
    resetActCtxState();
    getVirtualProcessManager().reset();
    resetProcessStartupInfo();
    setFileApisAnsi(true);
    consoleScreenBuffers.reset();
}

function mkThread(id: number, state: ThreadState): Thread {
    return {
        id, handle: 0x1000 + id, state, context: null,
        stackBase: 0x00200000, stackSize: 0x00100000, stackTop: 0x00300000, startAddress: 0x00401000, parameter: id,
        waitInfo: null, exitCode: null, tlsValues: new Map([[1, 0x1234 + id]]), lastError: 5, suspendCount: 0, priority: 1,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0x7ffd0000 - id * 0x1000, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 3,
    };
}

describe("capture → restore → capture is byte-identical", () => {
    test("cpu registers", () => {
        const a = fakeCpu();
        const saved = captureCpu(a);
        const b = fakeCpu();
        for (const name of Object.keys(CPU_FIELDS)) if (name !== 'memory_size') (b as unknown as Record<string, Int32Array>)[name].fill(0);
        restoreCpu(b, structuredClone(saved));
        expect(bytes(captureCpu(b))).toEqual(bytes(saved));
    });

    test("timer wheel keeps ids, deadlines, kinds and order", () => {
        const wheel = new TimerWheel();
        wheel.add(20, true, TimerKind.WINMM_TIMER, 0, 1000);
        wheel.add(5, false, TimerKind.USER32_TIMER, 0x10010, 1000);
        const cancelled = wheel.add(7, false, TimerKind.SLEEP_TIMEOUT, 2, 1000);
        wheel.cancel(cancelled);
        const fresh = new TimerWheel();
        roundTrip(() => wheel.captureState(), s => fresh.restoreState(s));
        expect(bytes(fresh.captureState())).toEqual(bytes(wheel.captureState()));
    });

    test("time continues from the saved clock", () => {
        const time = TimeService.getInstance();
        const saved = time.captureClock();
        time.restoreClock({ nowMs: saved.nowMs + 60_000 });
        expect(time.nowMs()).toBeGreaterThanOrEqual(saved.nowMs + 60_000);
        time.restoreClock({ nowMs: saved.nowMs });
    });

    test("address space and memory manager", () => {
        const mem = new Uint8Array(8 * 1024 * 1024);
        const space = new AddressSpace(() => mem);
        space.registerRegion({ base: 0x100000, size: 6 * 1024 * 1024, kind: "HEAP", perms: "rw", owner: "Layout" });
        const manager = new MemoryManager(space);
        manager.refreshLayoutBuckets();
        const a = manager.alloc(100, "HEAP", "rw");
        manager.alloc(5000, "HEAP", "rw");
        manager.free(a);
        manager.allocSystemBlock(48);

        const space2 = new AddressSpace(() => mem);
        const manager2 = new MemoryManager(space2);
        roundTrip(() => space.captureState(), s => space2.restoreState(s));
        roundTrip(() => manager.captureState(), s => manager2.restoreState(s));
        expect(bytes(space2.captureState())).toEqual(bytes(space.captureState()));
        expect(bytes(manager2.captureState())).toEqual(bytes(manager.captureState()));
    });

    test("thunk generator stubs, names and data exports", () => {
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        gen.generateStubDll("kernel32.dll", [{ name: "GetTickCount", argCount: 0 }, { name: "Sleep", argCount: 1 }]);
        gen.registerDataExport("msvcrt.dll", "_iob", 0x500000);
        const fresh = new ThunkGenerator();
        fresh.setBaseAddress(0x21046000);
        roundTrip(() => gen.captureState(), s => fresh.restoreState(s));
        expect(bytes(fresh.captureState())).toEqual(bytes(gen.captureState()));
    });

    test("scheduler threads, run queue and TLS", () => {
        const s = new Scheduler();
        const any = s as unknown as { threads: Map<number, Thread>; runQueue: number[]; currentThreadId: number | null; nextThreadId: number };
        const t1 = mkThread(1, ThreadState.RUNNING);
        t1.context = { eax: 1, ebx: 2, ecx: 3, edx: 4, esi: 5, edi: 6, ebp: 7, esp: 0x2ff000, eip: 0x401234, eflags: 0x202 } as Thread['context'];
        const t2 = mkThread(2, ThreadState.READY);
        t2.apcQueue.push({ routine: 0x401500, arg0: 1, arg1: 0, arg2: 0, kind: 0 } as Thread['apcQueue'][number]);
        any.threads.set(1, t1);
        any.threads.set(2, t2);
        any.runQueue.push(2);
        any.currentThreadId = 1;
        any.nextThreadId = 3;
        const graph = newObjectGraph();
        const saved = s.captureState((o, w) => graph.ref(o, w));
        const fresh = new Scheduler();
        fresh.restoreState(structuredClone(saved), r => restoreObjectGraph(graph.objects).object(r));
        expect(bytes(fresh.captureState((o, w) => graph.ref(o, w)))).toEqual(bytes(saved));
    });

    test("resource table entries restore to the same handles", () => {
        const table = new ResourceTable<{ v: number }>();
        const h1 = 0x10004, h2 = 0x10008;
        table.create(h1, { v: 1 });
        table.create(h2, { v: 2 });
        table.create(0x1000c, { v: 3 });
        table.release(h2);
        const entries = table.entries().map(([h, o]) => [h, o.v]);
        const fresh = new ResourceTable<{ v: number }>();
        for (const [h, v] of entries) fresh.create(h, { v });
        expect(fresh.entries().map(([h, o]) => [h, o.v])).toEqual(entries);
        expect(fresh.getByHandle(h1)?.v).toBe(1);
    });

    test("kernel32 module state, restored over a session that holds other state", () => {
        resetKernel32Session();
        namedObjects.register("mutex", "Global\\Single", 0x120, { initialState: false });
        namedObjects.acquire("mutex", "Global\\Single");
        consoleScreenBuffers.createScreenBuffer(40, 10);
        const saved = captureKernel32State();
        resetKernel32Session();
        namedObjects.register("event", "Other", 0x200, {});
        consoleScreenBuffers.createScreenBuffer(80, 25);
        consoleScreenBuffers.createScreenBuffer(10, 10);
        restoreKernel32State(structuredClone(saved));
        expect(bytes(captureKernel32State())).toEqual(bytes(saved));
        expect(namedObjects.peek("mutex", "Global\\Single")).toBe(0x120);
        expect(namedObjects.peek("event", "Other")).toBeUndefined();
        expect(captureAtoms().atoms).toEqual(saved.atoms.atoms);
        resetKernel32Session();
    });

    test("the dispatcher refuses unflushed write-buffer entries", () => {
        const fake = { writeBufferPendingBytes: () => 8 };
        expect(() => ThunkDispatcher.prototype.captureState.call(fake as never)).toThrow(/write-buffer/);
    });

    test("RAM patches and the CPU override belong to one capture", () => {
        const a = newCaptureRun();
        a.patchRam(0x1000, [1, 2]);
        a.overrideCpu({ eip: 0x401000, esp: 0x2ff000 });
        const b = newCaptureRun();
        expect(b.ramPatches).toEqual([]);
        expect(b.cpuOverride()).toBeNull();
        expect(() => a.overrideCpu({ eip: 1, esp: 2 })).toThrow(/two threads/);
    });
});

function registerAllParticipants(): void {
    const flag = globalThis as { __savestates?: unknown };
    flag.__savestates = true;
    try {
        clearTimerHandler(TimerKind.USER32_TIMER);
        createMessageExports();
        createInputExports();
        createSystemExports();
        createPaintingExports();
        registerCoreParticipants();
        registerDDrawParticipant({ context: () => { throw new Error("unused"); }, bitmapSurfaces: () => new Map(), surfaceStates: () => [] });
    } finally {
        delete flag.__savestates;
    }
}

describe("participant ids", () => {
    test("every listed id is registered somewhere, and everything registered is listed", () => {
        registerAllParticipants();
        const listed = new Set<string>(PARTICIPANT_IDS);
        for (const p of savestateParticipants.all()) expect(listed.has(p.id)).toBe(true);
        const sources: string[] = [];
        const walk = (d: string) => {
            for (const n of readdirSync(d)) {
                const f = join(d, n);
                if (statSync(f).isDirectory()) walk(f); else if (n.endsWith(".ts")) sources.push(readFileSync(f, "utf8"));
            }
        };
        walk(join(import.meta.dir, "..", "..", "src", "worker"));
        const registered = new Set<string>();
        for (const src of sources) {
            for (const m of src.matchAll(/savestateParticipants\.add\(\{\s*id: '([^']+)'/g)) registered.add(m[1]!);
        }
        expect([...registered].sort()).toEqual([...listed].sort());
    });
});

describe("kernel32 refusals", () => {
    test("thread-pool objects make the capture refuse", () => {
        resetVistaRuntimeState();
        expect(() => captureKernel32State()).not.toThrow();
        const handle = vistaRuntimeExports.CreateThreadpoolWork!({} as never, new Uint8Array(0), [0x401000, 0, 0]);
        expect(handle).toBeGreaterThan(0);
        expect(() => captureKernel32State()).toThrow("thread-pool objects");
        resetVistaRuntimeState();
    });

    test("an open toolhelp snapshot makes the capture refuse", () => {
        resetProcessApiState();
        const handle = processExports.CreateToolhelp32Snapshot!({} as never, new Uint8Array(0x1000), [2, 0]);
        expect(handle).toBeGreaterThan(0);
        expect(handle).not.toBe(0xffffffff);
        expect(() => captureKernel32State()).toThrow("toolhelp snapshots");
        resetProcessApiState();
        expect(() => captureKernel32State()).not.toThrow();
    });
});

describe("kernel records", () => {
    test("a kernel object keeps exactly its policy fields through the object graph", () => {
        registerCoreParticipants();
        const graph = newObjectGraph();
        const event = { kind: 'event' as const, manualReset: true, signaled: false, pendingWake: true };
        const mutex = { kind: 'mutex' as const, ownerThreadId: 2, recursion: 1, abandoned: false };
        const ids = [graph.ref(event, 'event'), graph.ref(mutex, 'mutex'), graph.ref(event, 'event again')];
        expect(ids[2]).toBe(ids[0]);
        const ctx = restoreObjectGraph(structuredClone(graph.objects));
        expect(ctx.object(ids[0])).toEqual(event);
        expect(ctx.object(ids[1])).toEqual(mutex);
        expect(ctx.object(ids[0])).toBe(ctx.object(ids[0]));
    });

    test("an object without a codec is refused with its path", () => {
        registerCoreParticipants();
        const graph = newObjectGraph();
        class Opaque { x = 1; }
        expect(() => graph.ref(new Opaque(), 'gdi 0x40')).toThrow(/gdi 0x40: no savestate codec for Opaque/);
    });
});

describe("participant schemas", () => {
    test("each participant reports its version and a hash of its field policy", () => {
        registerCoreParticipants();
        const schemas = savestateParticipants.schemas();
        expect(schemas.scheduler!.version).toBe(2);
        expect(schemas.scheduler!.schemaHash).toMatch(/^[0-9a-f]{16}$/);
        expect(schemas.scheduler!.schemaHash).not.toBe(schemas.cpu!.schemaHash);
        expect(schemaHash({ a: "save", b: "host" })).toBe(schemaHash({ b: "host", a: "save" }));
        expect(schemaHash({ a: "save", b: "host" })).not.toBe(schemaHash({ a: "save", b: "save" }));
    });
});

describe("schema pin and mutation", () => {
    test("participant versions and schema hashes are pinned; a change here needs a version bump", () => {
        registerAllParticipants();
        const undo = [new WinMM(), new DSound(), new DInput(), new DMusic()].map(m => m.registerSavestate());
        const schemas = savestateParticipants.schemas();
        for (const u of undo) u();
        expect(schemas).toEqual({
            "kernel32": { version: 4, schemaHash: "6bbba5ed115386df" },
            "module-images": { version: 1, schemaHash: "d20656b52f2472e7" },
            "time": { version: 1, schemaHash: "728d1b2522148901" },
            "address-space": { version: 1, schemaHash: "a1c4ce059654c36f" },
            "memory-manager": { version: 1, schemaHash: "4a5dbc8ebbd40e94" },
            "kernel32-memory": { version: 2, schemaHash: "4e2a2400e2517640" },
            "thunk-generator": { version: 1, schemaHash: "2673e673145253a5" },
            "resources": { version: 1, schemaHash: "de537d8b445269ef" },
            "hypercall-page": { version: 1, schemaHash: "5ea73324ac1a4cda" },
            "scheduler": { version: 2, schemaHash: "9ca6e9ac5f1ca162" },
            "timer-wheel": { version: 1, schemaHash: "3e2f3b81b4d37775" },
            "dispatcher": { version: 1, schemaHash: "88687a30dd0036f2" },
            "loaded-modules": { version: 1, schemaHash: "1294dbb9b5a4d85f" },
            "cpu": { version: 1, schemaHash: "4aad346ee75f6054" },
            "window-manager": { version: 1, schemaHash: "0a7d493b700e7f53" },
            "message-queue": { version: 1, schemaHash: "58fb335bdd9764ed" },
            "user32": { version: 2, schemaHash: "32eb51b29591ecf8" },
            "user32-timers": { version: 1, schemaHash: "e6c18e508aea7e24" },
            "user32-input": { version: 4, schemaHash: "5665463c4f60f14e" },
            "user32-system": { version: 1, schemaHash: "b93e806912786ec3" },
            "user32-accelerators": { version: 1, schemaHash: "4ab3bf298a09550d" },
            "gdi32": { version: 1, schemaHash: "f5495edbe7c4ae9d" },
            "gdi32-palettes": { version: 1, schemaHash: "fdca280b054649f9" },
            "ddraw": { version: 1, schemaHash: "844462508bc4ae1e" },
            "dsound": { version: 3, schemaHash: "d59d33450645191b" },
            "dinput": { version: 1, schemaHash: "d7eaf2cafce58a42" },
            "winmm": { version: 3, schemaHash: "13a32abfc6563265" },
            "dmusic": { version: 5, schemaHash: "2c7000ebe28c598d" },
        });
    });

    test("every saved thread field reaches the capture", () => {
        registerCoreParticipants();
        const captureOf = (t: Thread) => {
            const s = new Scheduler();
            (s as unknown as { threads: Map<number, Thread> }).threads.set(t.id, t);
            const graph = newObjectGraph();
            return bytes(s.captureState((o, w) => graph.ref(o, w)));
        };
        const base = () => {
            const t = mkThread(1, ThreadState.READY);
            t.context = { eax: 1, ebx: 2, ecx: 3, edx: 4, esi: 5, edi: 6, ebp: 7, esp: 8, eip: 9, eflags: 0x202 } as Thread['context'];
            return t;
        };
        const mutate: Partial<Record<keyof Thread, (t: Thread) => void>> = {
            kernelObject: t => { t.kernelObject = { kind: 'thread', threadId: 1 }; },
            context: t => { t.context!.eax = 99; },
            lastFpuState: t => { t.lastFpuState = new Uint8Array([1]); },
            lastSimdState: t => { t.lastSimdState = new Uint8Array([2]); },
            waitInfo: t => { t.waitInfo = { reason: WaitReason.SLEEP } as unknown as Thread['waitInfo']; },
            exitCode: t => { t.exitCode = 5; },
            tlsValues: t => { t.tlsValues.set(9, 9); },
            backgroundMode: t => { t.backgroundMode = true; },
            apcQueue: t => { t.apcQueue.push({ routine: 1, arg0: 0, arg1: 0, arg2: 0, kind: 0 } as Thread['apcQueue'][number]); },
            quitPosted: t => { t.quitPosted = true; },
        };
        const before = captureOf(base());
        for (const [field, policy] of Object.entries(THREAD_FIELDS) as Array<[keyof Thread, string]>) {
            if (policy !== 'save') continue;
            const t = base();
            const change = mutate[field] ?? ((x: Thread) => { (x as unknown as Record<string, number>)[field] = ((x as unknown as Record<string, number>)[field] as number) + 1; });
            change(t);
            expect({ field, same: JSON.stringify(captureOf(t)) === JSON.stringify(before) }).toEqual({ field, same: false });
        }
    });

    test("every saved CPU register reaches the capture", () => {
        const before = bytes(captureCpu(fakeCpu()));
        for (const [name, policy] of Object.entries(CPU_FIELDS)) {
            if (policy !== 'save' || name === 'current_tsc') continue;
            const cpu = fakeCpu();
            (cpu as unknown as Record<string, Int32Array>)[name]![0] += 1;
            expect({ name, same: JSON.stringify(bytes(captureCpu(cpu))) === JSON.stringify(before) }).toEqual({ name, same: false });
        }
    });
});

describe("module coverage", () => {
    test("names every touched module that no participant captures", () => {
        expect(uncoveredModules(["KERNEL32.dll", "user32.dll", "C:\\GAME\\ddraw.DLL", "ntdll"], new Set(["kernel32", "ntdll"])))
            .toEqual(["ddraw", "user32"]);
    });

    test("a module declared stateless counts as covered and needs a reason", () => {
        const reg = new ParticipantRegistry();
        reg.stateless("SHLWAPI.dll", "path helpers over guest buffers; nothing kept between calls");
        expect(reg.coveredModules().has("shlwapi")).toBe(true);
        expect(uncoveredModules(["shlwapi", "psapi"], reg.coveredModules())).toEqual(["psapi"]);
        expect(() => reg.stateless("psapi", " ")).toThrow("without a reason");
    });

    test("every declared stateless module is registered with the core participants", () => {
        registerCoreParticipants();
        for (const [module, reason] of Object.entries(STATELESS_MODULES)) {
            expect(savestateParticipants.statelessModules().get(module)).toBe(reason);
        }
    });

    test("a restore whose loaded modules differ from the save fails and names them", () => {
        expect(() => checkLoadedModules(["ddraw", "kernel32", "user32"], ["user32", "kernel32", "ddraw"])).not.toThrow();
        expect(() => checkLoadedModules(["ddraw", "kernel32", "winmm"], ["kernel32", "ddraw", "dsound"]))
            .toThrow("missing winmm, extra dsound");
    });

    test("core participants cover kernel32, user32 and gdi32; touched modules are the ones the process loaded", () => {
        registerCoreParticipants();
        const covered = savestateParticipants.coveredModules();
        expect(covered.has("kernel32")).toBe(true);
        expect(covered.has("user32")).toBe(true);
        expect(covered.has("gdi32")).toBe(true);
        expect(covered.has("dsound")).toBe(false);
        const system = System.getInstance();
        const previous = system.process;
        const gen = new ThunkGenerator();
        gen.setBaseAddress(0x21046000);
        gen.generateStubDll("DSOUND.dll", [{ name: "DirectSoundCreate", argCount: 3 }]);
        gen.generateStubDll("BINKW32.dll", [{ name: "BinkOpen", argCount: 2 }]);
        system.process = { thunkGenerator: gen } as never;
        try {
            const loaded = () => [{ name: "kernel32" }, { name: "user32" }, { name: "gdi32" }, { name: "dsound" }, { name: "kernel32" }];
            expect(touchedModules(loaded)).toEqual(["kernel32", "user32", "gdi32", "dsound"]);
            expect(uncoveredModules(touchedModules(loaded), covered)).toEqual(["dsound"]);
            expect(touchedModules(() => [])).toEqual([]);
        } finally {
            system.process = previous;
        }
    });
});

describe("restartable park rewind", () => {
    type Park = { threadId: number; functionId: number; functionName: string; generation: number; esp: number; returnAddr: number; argBytes: number; args: Uint8Array; spinAddr: number; spinBytes: [number, number] };
    const args = new Uint8Array([0x00, 0x20, 0x40, 0x00, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]);
    const park = (over: Partial<Park> = {}): Park => ({
        threadId: 1, functionId: 9, functionName: "user32:GetMessageA", generation: 3, esp: 0x2fff00, returnAddr: 0x401234, argBytes: 16,
        args, spinAddr: 0x7000, spinBytes: [0x55, 0x8b], ...over,
    });

    function parkedThread(id: number, esp: number): Thread {
        const t = mkThread(id, ThreadState.WAITING);
        t.context = { eax: 0, ebx: 7, ecx: 0, edx: 0, esi: 8, edi: 9, ebp: 0x2fff40, esp: esp + 20, eip: 0x7000, eflags: 0x202 } as Thread['context'];
        t.waitInfo = { reason: WaitReason.ASYNC_THUNK, handles: [], waitAll: false, timeoutTimerId: 0, alertable: false, csAddress: 0, srwWantExclusive: false } as unknown as Thread['waitInfo'];
        return t;
    }

    function withSession(threads: Thread[], current: number, parks: Park[], run: (capture: () => { state: any; ctx: ReturnType<typeof newCaptureRun> }) => void): void {
        registerCoreParticipants();
        const system = System.getInstance();
        const previous = { process: system.process, scheduler: system.scheduler };
        const sched = new Scheduler();
        const any = sched as unknown as { threads: Map<number, Thread>; currentThreadId: number | null };
        for (const t of threads) any.threads.set(t.id, t);
        any.currentThreadId = current;
        system.scheduler = sched;
        system.process = {
            dispatcher: { restartableParks: () => parks },
            thunkGenerator: { getStubById: (id: number) => id === 9 ? { address: 0x21046090, argCount: 4 } : undefined },
        } as never;
        try {
            run(() => {
                const ctx = newCaptureRun();
                const state = savestateParticipants.all().find(p => p.id === 'scheduler')!.capture(ctx) as any;
                return { state, ctx };
            });
        } finally {
            system.process = previous.process;
            system.scheduler = previous.scheduler;
        }
    }

    test("a parked thread that is not current comes back READY at the stub, with its return address and arguments", () => {
        const t1 = parkedThread(1, 0x2fff00), t2 = mkThread(2, ThreadState.RUNNING);
        t1.asyncParkGeneration = 3;
        withSession([t1, t2], 2, [park()], (capture) => {
            const { state, ctx } = capture();
            const saved = state.threads.find((x: { id: number }) => x.id === 1);
            expect([saved.state, saved.context.eip, saved.context.esp, saved.waitInfo]).toEqual([ThreadState.READY, 0x21046090, 0x2fff00, null]);
            expect(state.runQueue).toContain(1);
            expect(ctx.cpuOverride()).toBeNull();
            expect(ctx.ramPatches).toEqual([
                { address: 0x2fff00, bytes: [0x34, 0x12, 0x40, 0x00, ...args] },
                { address: 0x7000, bytes: [0x55, 0x8b] },
            ]);
        });
    });

    test("the current thread stays RUNNING and the CPU section takes the parked registers, at the stub", () => {
        const t1 = parkedThread(1, 0x2fff00);
        t1.asyncParkGeneration = 3;
        withSession([t1], 1, [park()], (capture) => {
            const { state, ctx } = capture();
            expect(state.threads[0].state).toBe(ThreadState.RUNNING);
            const live = fakeCpu();
            (live as unknown as { reg32: Int32Array }).reg32.set([11, 12, 13, 14, 15, 16, 17, 18]);
            const cpu = captureCpu(live, ctx.cpuOverride()) as any;
            expect([...cpu.regs.reg32]).toEqual([0, 0, 0, 7, 0x2fff00, 0x2fff40, 8, 9]);
            expect([cpu.regs.instruction_pointer[0] >>> 0, cpu.regs.flags[0], cpu.regs.flags_changed[0], cpu.regs.last_virt_eip[0]])
                .toEqual([0x21046090, 0x202, 0, -1]);
        });
    });

    test("refuses the current thread when another thread owns the live FPU", () => {
        const t1 = parkedThread(1, 0x2fff00);
        t1.asyncParkGeneration = 3;
        withSession([t1], 1, [park()], (capture) => {
            (System.getInstance().scheduler as unknown as { fpuLiveOwnerThreadId: number }).fpuLiveOwnerThreadId = 2;
            expect(capture).toThrow(/live FPU/);
        });
    });

    test("the spin bytes are put back once, from a park that saw the original code", () => {
        const t1 = parkedThread(1, 0x2fff00), t2 = parkedThread(2, 0x3fff00);
        t1.asyncParkGeneration = 3;
        t2.asyncParkGeneration = 5;
        withSession([t1, t2], 1, [park(), park({ threadId: 2, generation: 5, esp: 0x3fff00, spinBytes: [0xeb, 0xfe] })], (capture) => {
            const { ctx } = capture();
            expect(ctx.ramPatches.filter(p => p.address === 0x7000)).toEqual([{ address: 0x7000, bytes: [0x55, 0x8b] }]);
        });
    });

    test("refuses a thread that is not really parked, a stale park and lost arguments", () => {
        const running = mkThread(1, ThreadState.RUNNING);
        running.context = { eip: 0x7000, esp: 0x2fff14 } as Thread['context'];
        withSession([running], 1, [park()], (capture) => expect(capture).toThrow(/is not parked/));
        const stale = parkedThread(1, 0x2fff00);
        stale.asyncParkGeneration = 4;
        withSession([stale], 1, [park()], (capture) => expect(capture).toThrow(/is not parked/));
        const parked = parkedThread(1, 0x2fff00);
        parked.asyncParkGeneration = 3;
        withSession([parked], 1, [park({ args: new Uint8Array(12) })], (capture) => expect(capture).toThrow(/arguments/));
        const unlisted = parkedThread(1, 0x2fff00);
        unlisted.asyncParkGeneration = 3;
        withSession([unlisted], 1, [], (capture) => expect(capture).toThrow(/cannot be re-issued/));
    });
});

describe("parking keeps what the rewind needs", () => {
    test("a real park of a 4-argument stub keeps the return address and all 16 argument bytes", () => {
        const d = new ThunkDispatcher({ add_listener: () => {} } as never, { getStubById: () => undefined } as never) as any;
        const mem = new Uint8Array(0x10000);
        d.cachedMem8 = mem;
        d.cachedDataView = new DataView(mem.buffer);
        d.memLength = mem.length;
        d.spinLoopAddress = 0x7000;
        d.cachedWasmBuffer = mem.buffer;
        d.cachedReg32Raw = new Int32Array(mem.buffer, 64, 8);
        d.cachedFlagsRaw = new Int32Array(mem.buffer, 120, 1);
        d.isDataViewValid = () => true;
        d.stackCleanupTable[9] = 16;
        const esp = 0x8000;
        mem.set([0x34, 0x12, 0x40, 0x00, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0], esp);
        const system = System.getInstance();
        const previous = system.scheduler;
        system.scheduler = { getCurrentThreadId: () => 1, markThreadAsyncParked: () => true, getAsyncParkGeneration: () => 3 } as never;
        try {
            const promise = markRestartable(new Promise(() => {}));
            d.parkThreadAsync(promise, 9, "user32:GetMessageA", {}, esp);
            const [p] = d.restartableParks();
            expect([p.returnAddr, p.argBytes, p.generation]).toEqual([0x401234, 16, 3]);
            expect([...p.args.subarray(0, 16)]).toEqual([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0]);
        } finally {
            system.scheduler = previous;
        }
    });
});
