import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { clearTimerHandler, getTimerHandler, replaceTimerHandler, setTimerHandler, TimerWheel } from "../../src/worker/core/scheduler/timer-wheel";
import { completeWait } from "../../src/worker/core/scheduler/wait-completion";
import {
    ThreadState, TimerKind, WAIT_OBJECT_0, WAIT_TIMEOUT, WaitCompletionKind, type Thread,
} from "../../src/worker/core/scheduler/types";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { TimeService } from "../../src/worker/runtime/time";
import { exports as sync } from "../../src/worker/modules/kernel32/sync";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import "../../src/worker/modules/kernelbase";
import "../../src/worker/modules/kernel32/vista-runtime";
import "../../src/worker/modules/kernel32/file-io-comm";

const ESP = 0x1000;
const DUE = 0x2000;
const OVERLAPPED = 0x3000;
const BYTES = 0x3100;

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

const now = () => TimeService.getInstance().nowMs();
const signaled = (handle: number) => !!(System.getInstance().resourceProvider.getKernelObject(handle) as any).signaled;

type MemBinding = { memoryGetter: unknown; validateRange: unknown; getRegion: unknown; dataRoutes: unknown };
let saved: { scheduler: unknown; process: unknown; mem: MemBinding } | null = null;

afterEach(() => {
    if (!saved) return;
    const system = System.getInstance() as any;
    system.scheduler = saved.scheduler;
    system.process = saved.process;
    const m = saved.mem;
    Mem.bind(m.memoryGetter as never, m.validateRange as never, m.getRegion as never, m.dataRoutes as never);
    saved = null;
});

beforeEach(() => {
    const system0 = System.getInstance() as any;
    const binding = Mem as unknown as MemBinding;
    saved = {
        scheduler: system0.scheduler, process: system0.process,
        mem: { memoryGetter: binding.memoryGetter, validateRange: binding.validateRange, getRegion: binding.getRegion, dataRoutes: binding.dataRoutes },
    };
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

describe("timer wheel entries are kinds plus data", () => {
    test("a fired entry reaches its kind's handler with owner, arg and id", () => {
        const wheel = new TimerWheel();
        const seen: number[][] = [];
        wheel.bind(TimerKind.USER32_TIMER, (owner, arg, id) => { seen.push([owner, arg, id]); });
        const id = wheel.add(5, false, TimerKind.USER32_TIMER, 0x77, 0, 9);
        wheel.poll(5);
        expect(seen).toEqual([[0x77, 9, id]]);
    });

    test("a second, different handler for a kind is refused; replace and clear are explicit", () => {
        const kind = TimerKind.THREADPOOL_WAIT;
        const saved = getTimerHandler(kind);
        try {
            const first = () => {};
            const second = () => {};
            clearTimerHandler(kind);
            setTimerHandler(kind, first);
            setTimerHandler(kind, first);
            setTimerHandler(kind, second);
            expect(getTimerHandler(kind)).toBe(first);
            replaceTimerHandler(kind, second);
            expect(getTimerHandler(kind)).toBe(second);
        } finally {
            if (saved) replaceTimerHandler(kind, saved); else clearTimerHandler(kind);
        }
    });

    test("entries armed through the APIs hold no behaviour and survive structured cloning", () => {
        const timer = call("CreateWaitableTimerW", 0, 1, 0);
        view.setBigInt64(DUE, -150000n, true);
        expect(call("SetWaitableTimer", timer, DUE, 40, 0, 0, 0)).toBe(1);
        const user = createMessageExports();
        expect(user.SetTimer(ctx() as any, mem, [0x10001, 7, 10, 0])).toBe(7);

        const entries = [...(sched.timerWheel as any).entries.values()];
        expect(entries.map((e) => e.kind).sort()).toEqual([TimerKind.USER32_TIMER, TimerKind.WAITABLE_TIMER].sort());
        for (const e of entries) {
            expect(Object.values(e).some((v) => typeof v === "function")).toBe(false);
        }
        expect(structuredClone(entries)).toEqual(entries);
        user.KillTimer(ctx() as any, mem, [0x10001, 7]);
    });

    test("a periodic waitable timer fires at its due time, then every period", () => {
        const timer = call("CreateWaitableTimerW", 0, 0, 0);
        view.setBigInt64(DUE, -150000n, true);
        call("SetWaitableTimer", timer, DUE, 40, 0, 0, 0);
        const start = now();
        expect(sched.timerWheel.nextFireIn(start)).toBeLessThanOrEqual(15);

        sched.timerWheel.poll(start + 15);
        expect(signaled(timer)).toBe(true);
        expect(sched.timerWheel.nextFireIn(start + 15)).toBeGreaterThan(15);
        expect(sched.timerWheel.nextFireIn(start + 15)).toBeLessThanOrEqual(40);
    });
});

describe("wait completions are kinds plus data", () => {
    test("WaitOnAddress answers TRUE on a wake and FALSE with ERROR_TIMEOUT on a timeout", () => {
        const c = { kind: WaitCompletionKind.WAIT_ON_ADDRESS, a: 0, b: 0, c: 0 };
        expect(completeWait(c, WAIT_OBJECT_0)).toEqual({ value: 1 });
        expect(completeWait(c, WAIT_TIMEOUT)).toEqual({ value: 0, lastError: 1460 });
    });

    test("an overlapped result reads the IOSB the completion names", () => {
        view.setUint32(OVERLAPPED, 0, true);
        view.setUint32(OVERLAPPED + 4, 1234, true);
        const c = { kind: WaitCompletionKind.OVERLAPPED_RESULT, a: OVERLAPPED, b: BYTES, c: 0 };
        expect(completeWait(c, WAIT_OBJECT_0)).toEqual({ value: 1, lastError: 0 });
        expect(view.getUint32(BYTES, true)).toBe(1234);
        expect(completeWait(c, WAIT_TIMEOUT)).toEqual({ value: 0, lastError: WAIT_TIMEOUT });
    });

    test("a rerun completion puts the caller's return address back", () => {
        view.setUint32(ESP, 0xdeadbeef, true);
        const c = { kind: WaitCompletionKind.RERUN_FROM_STUB, a: ESP, b: 0x00401234, c: 0 };
        expect(completeWait(c, WAIT_OBJECT_0)).toEqual({ value: 0 });
        expect(view.getUint32(ESP, true)).toBe(0x00401234);
    });
});
