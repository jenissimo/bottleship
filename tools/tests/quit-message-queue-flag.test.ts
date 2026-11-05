/**
 * A pending PostQuitMessage must stay visible to the WASM PeekMessage short-circuit.
 *
 * WM_QUIT is synthesized by the JS PeekMessage/GetMessage paths from the per-thread quit
 * flag; the WASM tier answers FALSE whenever the shared "queue non-empty" word is 0. Every
 * site that refreshes that word asked only the queue, so a BeginPaint that drained the last
 * WM_PAINT after PostQuitMessage cleared it, and a Delphi pump (PeekMessage -> WaitMessage)
 * slept forever on a grey window (GOG Video Player in Cossacks: European Wars).
 */
import { expect, test } from "bun:test";
import { HypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState, type Thread } from "../../src/worker/core/scheduler/types";

function manager(): HypercallDataManager {
    const buffer = new ArrayBuffer(0x10000);
    const m = new HypercallDataManager() as any;
    m.cpu = { wasm_memory: { buffer } };
    m.wasmMemory = buffer;
    m.view = new DataView(buffer);
    m.hpBase = 0x1000;
    m.initialized = true;
    return m as HypercallDataManager;
}

function thread(id: number, state: ThreadState): Thread {
    return {
        id, handle: 0x1000 + id, state, context: null,
        stackBase: 0x200000, stackSize: 0x100000, stackTop: 0x300000, startAddress: 0x401000, parameter: 0,
        waitInfo: null, exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0, apcQueue: [],
        quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

test("an empty queue keeps the flag up while a quit is pending", () => {
    const m = manager();
    let quit = false;
    m.setQuitPendingProbe(() => quit);
    m.updateMessageQueueFlag(false);
    expect(m.readMessageQueueFlag()).toBe(0);
    quit = true;
    m.updateMessageQueueFlag(false);          // e.g. BeginPaint drained the last WM_PAINT
    expect(m.readMessageQueueFlag()).toBe(1);
    quit = false;                             // WM_QUIT retrieved
    m.updateMessageQueueFlag(false);
    expect(m.readMessageQueueFlag()).toBe(0);
    m.updateMessageQueueFlag(true);
    expect(m.readMessageQueueFlag()).toBe(1);
});

test("the scheduler reports pending quits per thread and ignores terminated threads", () => {
    const s = new Scheduler() as any;
    const t1 = thread(1, ThreadState.RUNNING), t2 = thread(2, ThreadState.READY);
    s.threads.set(1, t1); s.threads.set(2, t2); s.currentThreadId = 1;
    expect(s.hasPendingQuit()).toBe(false);
    s.postQuitForCurrentThread(0);
    expect(s.hasPendingQuit()).toBe(true);
    expect(s.hasPendingQuit(1)).toBe(true);
    expect(s.hasPendingQuit(2)).toBe(false);
    t1.state = ThreadState.TERMINATED;
    expect(s.hasPendingQuit()).toBe(false);
    t1.state = ThreadState.RUNNING;
    s.clearQuitFlag(1);
    expect(s.hasPendingQuit()).toBe(false);
});
