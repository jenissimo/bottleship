/**
 * Vista+ kernel32 threading contracts that modern runtimes resolve through GetProcAddress.
 *
 * A stub answering a canned value reads as success to every one of these callers: an
 * INIT_ONCE that never leaves "running", an Ex-created event with the wrong reset mode, a
 * WaitOnAddress that returns at once whatever the value. The tests pin the Windows
 * contract, including the parts only a second thread can observe.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState, WAIT_TIMEOUT, type Thread } from "../../src/worker/core/scheduler/types";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as sync } from "../../src/worker/modules/kernel32/sync";
import { exports as vista } from "../../src/worker/modules/kernel32/vista-runtime";
import { exports as vistaSystem } from "../../src/worker/modules/kernel32/process/vista-system";
import { exports as time } from "../../src/worker/modules/kernel32/time/time";
import { exports as fileIo } from "../../src/worker/modules/kernel32/file-io";
import { kernelbaseOwnExports as kernelbase } from "../../src/worker/modules/kernelbase";

const ERROR_INVALID_PARAMETER = 87;
const ERROR_GEN_FAILURE = 31;
const ERROR_TIMEOUT = 1460;
const CURRENT_THREAD = 0xFFFFFFFE;
const INFINITE = 0xFFFFFFFF;

const ESP = 0x1000;          // stack: [ESP] = return address
const RETURN_ADDR = 0x00401000;
const ONCE = 0x2000;
const OUT = 0x2100;
const OUT2 = 0x2104;
const ADDR = 0x2200;
const CMP = 0x2210;
const HEAP = 0x8000;

let mem: Uint8Array;
let view: DataView;
let sched: Scheduler;
let reg32: Int32Array;

function thread(id: number, state: ThreadState): Thread {
    return {
        id, handle: 0x1000 + id, state, context: null,
        stackBase: 0x00200000, stackSize: 0x00100000, stackTop: 0x00300000,
        startAddress: 0x00401000, parameter: 0, waitInfo: null, exitCode: null,
        tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

function makeCurrent(id: number): void {
    (sched as any).currentThreadId = id;
}

const ctx = () => ({ eax: 0, ecx: 0, edx: 0, ebx: 0, esp: ESP, ebp: 0, esi: 0, edi: 0, eip: 0, eflags: 0x202 });

function call(table: Record<string, any>, name: string, ...args: number[]): number {
    const r = table[name]!(ctx(), mem, args);
    return typeof r === "number" ? r >>> 0 : (r.value >>> 0);
}

function raw(table: Record<string, any>, name: string, ...args: number[]): any {
    return table[name]!(ctx(), mem, args);
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    view.setUint32(ESP, RETURN_ADDR, true);

    sched = new Scheduler();
    const threads = (sched as any).threads as Map<number, Thread>;
    threads.set(1, thread(1, ThreadState.RUNNING));
    threads.set(2, thread(2, ThreadState.READY));
    (sched as any).runQueue.push(2);
    makeCurrent(1);

    reg32 = new Int32Array(8);
    let heap = HEAP;
    const system = System.getInstance() as any;
    system.scheduler = sched;
    system.process = {
        getCurrentMemory: () => mem,
        memory: { alloc: (n: number) => { const p = heap; heap += (n + 15) & ~15; return p; } },
        v86: { cpu: { reg32 } },
    };
});

describe("CreateEventEx / CreateMutexEx / CreateSemaphoreEx", () => {
    test("event flags select reset mode and initial state", () => {
        const manualSet = call(sync, "CreateEventExW", 0, 0, 0x1 | 0x2, 0x1F0003);
        const autoClear = call(sync, "CreateEventExW", 0, 0, 0, 0x1F0003);
        const a = System.getInstance().resourceProvider.getKernelObject(manualSet) as any;
        const b = System.getInstance().resourceProvider.getKernelObject(autoClear) as any;
        expect(a.kind).toBe("event");
        expect(a.manualReset).toBe(true);
        expect(a.signaled).toBe(true);
        expect(b.manualReset).toBe(false);
        expect(b.signaled).toBe(false);
    });

    test("CREATE_MUTEX_INITIAL_OWNER makes the caller the owner", () => {
        const owned = call(sync, "CreateMutexExW", 0, 0, 0x1, 0x1F0001);
        const free = call(sync, "CreateMutexExW", 0, 0, 0, 0x1F0001);
        const rp = System.getInstance().resourceProvider;
        expect((rp.getKernelObject(owned) as any).ownerThreadId).toBe(1);
        expect((rp.getKernelObject(free) as any).ownerThreadId ?? null).toBeNull();
    });

    test("a semaphore whose initial count exceeds its maximum is refused", () => {
        expect(call(sync, "CreateSemaphoreExW", 0, 5, 2, 0, 0, 0x1F0003)).toBe(0);
        expect(sched.getLastError()).toBe(ERROR_INVALID_PARAMETER);
        expect(call(sync, "CreateSemaphoreExW", 0, 1, 2, 0, 0, 0x1F0003)).not.toBe(0);
    });
});

describe("WaitOnAddress", () => {
    test("returns at once when the value already differs", () => {
        view.setUint32(ADDR, 7, true);
        view.setUint32(CMP, 8, true);
        expect(call(kernelbase, "WaitOnAddress", ADDR, CMP, 4, INFINITE)).toBe(1);
    });

    test("an equal value with a zero timeout is FALSE / ERROR_TIMEOUT", () => {
        view.setUint32(ADDR, 7, true);
        view.setUint32(CMP, 7, true);
        expect(call(kernelbase, "WaitOnAddress", ADDR, CMP, 4, 0)).toBe(0);
        expect(sched.getLastError()).toBe(ERROR_TIMEOUT);
    });

    test("a size other than 1/2/4/8 is ERROR_INVALID_PARAMETER", () => {
        expect(call(kernelbase, "WaitOnAddress", ADDR, CMP, 3, 0)).toBe(0);
        expect(sched.getLastError()).toBe(ERROR_INVALID_PARAMETER);
    });

    test("parks until WakeByAddressSingle, then returns TRUE", () => {
        view.setUint16(ADDR, 5, true);
        view.setUint16(CMP, 5, true);
        const r = raw(kernelbase, "WaitOnAddress", ADDR, CMP, 2, INFINITE);
        expect(r.blockedNoSwitch).toBe(true);
        const waiter = (sched as any).threads.get(1) as Thread;
        expect(waiter.state).toBe(ThreadState.WAITING);

        makeCurrent(2);
        call(kernelbase, "WakeByAddressSingle", ADDR + 4); // another address wakes nobody
        expect(waiter.state).toBe(ThreadState.WAITING);
        call(kernelbase, "WakeByAddressSingle", ADDR);
        expect(waiter.state).toBe(ThreadState.READY);
        expect(waiter.context!.eax).toBe(1);
        expect(waiter.context!.eip).toBe(RETURN_ADDR);
        expect(waiter.context!.esp).toBe(ESP + 20);
    });

    test("a timed-out park returns FALSE with ERROR_TIMEOUT in the WAITER's last error", () => {
        view.setUint32(ADDR, 1, true);
        view.setUint32(CMP, 1, true);
        raw(kernelbase, "WaitOnAddress", ADDR, CMP, 4, 50);
        const waiter = (sched as any).threads.get(1) as Thread;
        makeCurrent(2);
        (sched as any).wakeThread(waiter, WAIT_TIMEOUT);
        expect(waiter.context!.eax).toBe(0);
        expect(waiter.lastError).toBe(ERROR_TIMEOUT);
        expect(((sched as any).threads.get(2) as Thread).lastError).toBe(0);
    });
});

describe("InitOnceBeginInitialize / InitOnceComplete", () => {
    test("first caller owns the initialization; completion publishes the context", () => {
        expect(call(vista, "InitOnceBeginInitialize", ONCE, 0, OUT, OUT2)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(1);        // fPending
        expect(view.getUint32(ONCE, true) & 3).toBe(1);   // running

        expect(call(vista, "InitOnceBeginInitialize", ONCE, 1 /* CHECK_ONLY */, OUT, OUT2)).toBe(0);
        expect(sched.getLastError()).toBe(ERROR_GEN_FAILURE);

        expect(call(vista, "InitOnceComplete", ONCE, 0, 0x00345670)).toBe(1);
        expect(view.getUint32(ONCE, true)).toBe(0x00345672);

        view.setUint32(OUT2, 0, true);
        expect(call(vista, "InitOnceBeginInitialize", ONCE, 0, OUT, OUT2)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(0);
        expect(view.getUint32(OUT2, true)).toBe(0x00345670);
    });

    test("completing twice fails; a context with low bits set is refused", () => {
        call(vista, "InitOnceBeginInitialize", ONCE, 0, OUT, OUT2);
        expect(call(vista, "InitOnceComplete", ONCE, 0, 0x1001)).toBe(0);
        expect(sched.getLastError()).toBe(ERROR_INVALID_PARAMETER);
        expect(call(vista, "InitOnceComplete", ONCE, 0, 0)).toBe(1);
        expect(call(vista, "InitOnceComplete", ONCE, 0, 0)).toBe(0);
        expect(sched.getLastError()).toBe(ERROR_GEN_FAILURE);
    });

    test("INIT_ONCE_INIT_FAILED returns the block to its initial state", () => {
        call(vista, "InitOnceBeginInitialize", ONCE, 0, OUT, OUT2);
        expect(call(vista, "InitOnceComplete", ONCE, 4 /* INIT_FAILED */, 0)).toBe(1);
        expect(view.getUint32(ONCE, true)).toBe(0);
        expect(call(vista, "InitOnceBeginInitialize", ONCE, 0, OUT, OUT2)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(1);
    });

    test("async initialization: every async caller is pending, a sync caller is refused", () => {
        expect(call(vista, "InitOnceBeginInitialize", ONCE, 2 /* ASYNC */, OUT, OUT2)).toBe(1);
        expect(view.getUint32(ONCE, true) & 3).toBe(3);
        expect(call(vista, "InitOnceBeginInitialize", ONCE, 2, OUT, OUT2)).toBe(1);
        expect(view.getUint32(OUT, true)).toBe(1);
        expect(call(vista, "InitOnceBeginInitialize", ONCE, 0, OUT, OUT2)).toBe(0);
        expect(sched.getLastError()).toBe(ERROR_INVALID_PARAMETER);
        expect(call(vista, "InitOnceComplete", ONCE, 2, 0x4000)).toBe(1);
        expect(view.getUint32(ONCE, true)).toBe(0x4002);
    });
});

describe("thread description", () => {
    test("round-trips through the GetCurrentThread pseudo-handle as a LocalAlloc'd string", () => {
        const NAME = 0x3000;
        const text = "Render Worker";
        for (let i = 0; i < text.length; i++) view.setUint16(NAME + i * 2, text.charCodeAt(i), true);
        view.setUint16(NAME + text.length * 2, 0, true);

        expect(call(vistaSystem, "SetThreadDescription", CURRENT_THREAD, NAME)).toBe(0);
        view.setUint32(OUT, 0xDEADBEEF, true);
        expect(call(vistaSystem, "GetThreadDescription", 0x1001 /* thread 1's handle */, OUT)).toBe(0);
        const p = view.getUint32(OUT, true);
        expect(p).toBeGreaterThanOrEqual(HEAP);
        let got = "";
        for (let i = 0; view.getUint16(p + i * 2, true); i++) got += String.fromCharCode(view.getUint16(p + i * 2, true));
        expect(got).toBe(text);
    });

    test("an unnamed thread describes itself as the empty string; a bad handle is an NT HRESULT", () => {
        expect(call(vistaSystem, "GetThreadDescription", 0x1002, OUT)).toBe(0);
        expect(view.getUint16(view.getUint32(OUT, true), true)).toBe(0);
        expect(call(vistaSystem, "GetThreadDescription", 0x7777, OUT)).toBe(0xD0000008);
        expect(view.getUint32(OUT, true)).toBe(0);
    });
});

describe("GetTickCount64", () => {
    test("returns EDX:EAX whose low dword is GetTickCount's answer", () => {
        reg32[2] = 0x55;
        const lo = call(time, "GetTickCount64");
        const tick = call(time, "GetTickCount");
        expect(reg32[2]).toBe(0);
        expect(Math.abs(tick - lo)).toBeLessThan(1000);
    });
});

describe("GetOverlappedResultEx", () => {
    const OV = 0x2400;
    const BYTES = 0x2500;

    test("a completed operation answers its byte count at once", () => {
        view.setUint32(OV, 0, true);          // Internal = STATUS_SUCCESS
        view.setUint32(OV + 4, 321, true);    // InternalHigh
        expect(call(fileIo, "GetOverlappedResultEx", 0x40, OV, BYTES, INFINITE, 0)).toBe(1);
        expect(view.getUint32(BYTES, true)).toBe(321);
    });

    test("a pending operation with a zero timeout is ERROR_IO_INCOMPLETE", () => {
        view.setUint32(OV, 0x103, true);      // STATUS_PENDING
        expect(call(fileIo, "GetOverlappedResultEx", 0x40, OV, BYTES, 0, 0)).toBe(0);
        expect(sched.getLastError()).toBe(996);
    });

    test("a pending operation parks on hEvent and completes when it is signalled", () => {
        const hEvent = sched.createEvent(true, false);
        view.setUint32(OV, 0x103, true);
        view.setUint32(OV + 16, hEvent, true);
        const r = raw(fileIo, "GetOverlappedResultEx", 0x40, OV, BYTES, INFINITE, 0);
        expect(r.blockedNoSwitch).toBe(true);
        const waiter = (sched as any).threads.get(1) as Thread;

        makeCurrent(2);
        view.setUint32(OV, 0, true);
        view.setUint32(OV + 4, 77, true);
        sched.setEvent(hEvent);
        expect(waiter.state).toBe(ThreadState.READY);
        expect(waiter.context!.eax).toBe(1);
        expect(waiter.context!.esp).toBe(ESP + 24);
        expect(view.getUint32(BYTES, true)).toBe(77);
    });

    test("a pending operation that times out is FALSE with WAIT_TIMEOUT as the error", () => {
        const hEvent = sched.createEvent(true, false);
        view.setUint32(OV, 0x103, true);
        view.setUint32(OV + 16, hEvent, true);
        raw(fileIo, "GetOverlappedResultEx", 0x40, OV, BYTES, 30, 0);
        const waiter = (sched as any).threads.get(1) as Thread;
        makeCurrent(2);
        (sched as any).wakeThread(waiter, WAIT_TIMEOUT);
        expect(waiter.context!.eax).toBe(0);
        expect(waiter.lastError).toBe(WAIT_TIMEOUT);
    });
});

describe("GetLogicalProcessorInformationEx", () => {
    const BUF = 0x4000;
    const LEN = 0x3F00;

    test("RelationAll describes one core, one package, one NUMA node and one group", () => {
        view.setUint32(LEN, 0, true);
        expect(call(vistaSystem, "GetLogicalProcessorInformationEx", 0xFFFF, 0, LEN)).toBe(0);
        expect(sched.getLastError()).toBe(122);
        const needed = view.getUint32(LEN, true);
        expect(needed).toBe(44 + 44 + 44 + 76);

        expect(call(vistaSystem, "GetLogicalProcessorInformationEx", 0xFFFF, BUF, LEN)).toBe(1);
        const kinds: number[] = [];
        for (let at = BUF; at < BUF + needed; at += view.getUint32(at + 4, true)) kinds.push(view.getUint32(at, true));
        expect(kinds).toEqual([0, 3, 1, 4]);
        expect(view.getUint32(BUF + 8 + 24, true)).toBe(1);   // core's GroupMask[0].Mask
    });
});
