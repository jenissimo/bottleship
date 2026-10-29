/**
 * SetWaitableTimer's lpDueTime is a SIGNED LARGE_INTEGER: negative is relative (100 ns
 * units), positive an absolute FILETIME. Read unsigned, every relative due time becomes
 * ~1.8e15 ms and the waiter (a frame limiter's WaitForSingleObject(INFINITE)) never wakes.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState, type Thread } from "../../src/worker/core/scheduler/types";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { TimeService } from "../../src/worker/runtime/time";
import { exports as sync } from "../../src/worker/modules/kernel32/sync";

const ESP = 0x1000;
const DUE = 0x2000;
const FILETIME_UNIX_EPOCH_MS = 11644473600000n;

let mem: Uint8Array;
let view: DataView;
let sched: Scheduler;

function thread(id: number): Thread {
    return {
        id, handle: 0x1000 + id, state: ThreadState.RUNNING, context: null,
        stackBase: 0x00200000, stackSize: 0x00100000, stackTop: 0x00300000,
        startAddress: 0x00401000, parameter: 0, waitInfo: null, exitCode: null,
        tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0,
        apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

const ctx = () => ({ eax: 0, ecx: 0, edx: 0, ebx: 0, esp: ESP, ebp: 0, esi: 0, edi: 0, eip: 0, eflags: 0x202 });

function call(name: string, ...args: number[]): number {
    const r = (sync[name] as any)(ctx(), mem, args);
    return typeof r === "number" ? r >>> 0 : (r.value >>> 0);
}

function setDue(due100ns: bigint): void {
    view.setBigInt64(DUE, due100ns, true);
}

/** Milliseconds until the timer's wheel entry fires. */
function firesIn(): number {
    return sched.timerWheel.nextFireIn(TimeService.getInstance().nowMs());
}

function signaled(handle: number): boolean {
    return !!(System.getInstance().resourceProvider.getKernelObject(handle) as any).signaled;
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    view.setUint32(ESP, 0x00401000, true);
    sched = new Scheduler();
    (sched as any).threads.set(1, thread(1));
    (sched as any).currentThreadId = 1;
    const system = System.getInstance() as any;
    system.scheduler = sched;
    system.process = { getCurrentMemory: () => mem, memory: { alloc: () => 0 } };
});

describe("SetWaitableTimer due time", () => {
    test("a negative due time is relative", () => {
        const timer = call("CreateWaitableTimerW", 0, 1, 0);
        setDue(-150000n);   // 15 ms
        expect(call("SetWaitableTimer", timer, DUE, 0, 0, 0, 0)).toBe(1);
        expect(firesIn()).toBeGreaterThan(5);
        expect(firesIn()).toBeLessThanOrEqual(15);
    });

    test("a positive due time is an absolute FILETIME on the system clock", () => {
        const timer = call("CreateWaitableTimerW", 0, 1, 0);
        const nowFileTimeMs = BigInt(Math.floor(TimeService.getInstance().nowUnixMs())) + FILETIME_UNIX_EPOCH_MS;
        setDue((nowFileTimeMs + 40n) * 10000n);
        expect(call("SetWaitableTimer", timer, DUE, 0, 0, 0, 0)).toBe(1);
        expect(firesIn()).toBeGreaterThan(20);
        expect(firesIn()).toBeLessThanOrEqual(41);
    });

    test("arming a signalled manual-reset timer clears it", () => {
        const timer = call("CreateWaitableTimerW", 0, 1, 0);
        sched.setEvent(timer);
        expect(signaled(timer)).toBe(true);
        setDue(-10000n);
        call("SetWaitableTimer", timer, DUE, 0, 0, 0, 0);
        expect(signaled(timer)).toBe(false);
    });

    test("an unknown handle and a negative period fail with their error codes", () => {
        setDue(-10000n);
        expect(call("SetWaitableTimer", 0xdead, DUE, 0, 0, 0, 0)).toBe(0);
        expect(sched.getLastError()).toBe(6);       // ERROR_INVALID_HANDLE
        const timer = call("CreateWaitableTimerW", 0, 1, 0);
        expect(call("SetWaitableTimer", timer, DUE, -1, 0, 0, 0)).toBe(0);
        expect(sched.getLastError()).toBe(87);      // ERROR_INVALID_PARAMETER
    });
});
