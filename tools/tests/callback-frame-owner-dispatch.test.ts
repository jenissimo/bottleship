/**
 * A suspended-frame chain dispatch runs on the frame's OWNER thread.
 *
 * A modal DialogBox loop is a JS pump re-armed from setTimeout; its dispatches write
 * the current thread's EIP/ESP and anchor on the frame's saved stack. When the pump
 * steps while a sibling thread is current, dispatching immediately runs the owner's
 * window procedure on the sibling's register file over the owner's stack, after which
 * both threads share one stack (UE1 launchers: the splash thread inherits the wizard's).
 */
import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {CALLBACK_DISPATCH_DEFERRED, CallbackManager} from "../../src/worker/core/thunking/callback-manager";

const system = System.getInstance();
const saved = {process: system.process, scheduler: system.scheduler, isExiting: system.isExiting};
const ENTRY = 0xc000, RETURN = 0x1000, WNDPROC = 0x1200, SIBLING_ESP = 0xb800, SIBLING_EIP = 0x1500;
const OWNER = 1, SIBLING = 2;
let mem: Uint8Array, cpu: any, manager: CallbackManager, current: number;
let woken: number[], switches: number;

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    cpu = {reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), is_jumping: false};
    cpu.reg32[4] = ENTRY;
    new DataView(mem.buffer).setUint32(ENTRY, RETURN, true);
    current = OWNER;
    woken = [];
    switches = 0;
    system.scheduler = {
        getCurrentThreadId: () => current,
        getThreadStackBounds: () => ({base: 0xa000, top: 0xd000}),
        wakeThreadForAsyncCompletion: (tid: number) => { woken.push(tid); return true; },
        requestSwitchToThread: () => { switches++; },
        wakeEarlyFromIdleYield: () => false,
        wakeCurrentThreadForCallbackDispatch: () => true,
        pinCurrentThread: () => {},
        unpinThread: () => {},
    } as any;
    system.process = {resetGeneration: 0, addressSpace: {
        validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length,
    }} as any;
    system.isExiting = false;
    manager = new CallbackManager({cpu}, {} as any, () => mem);
    manager.initialize({getRegions: () => ({callbackStubPoolBase: 0x4000, callbackStubPoolSize: 0x4000})} as any);
});
afterEach(() => {
    manager.reset();
    system.process = saved.process;
    system.scheduler = saved.scheduler;
    system.isExiting = saved.isExiting;
});

/** DialogBoxParam on OWNER: the frame the pump dispatches through. */
const suspendOwner = (): number => manager.saveSuspendedThunkContext({esp: ENTRY, returnAddr: RETURN}, 20, "DialogBoxParamA");

const sibling = (): void => {
    current = SIBLING;
    cpu.reg32[4] = SIBLING_ESP;
    cpu.instruction_pointer[0] = SIBLING_EIP;
};

describe("suspended-frame dispatch thread ownership", () => {
    test("the owner's own pump step dispatches immediately", () => {
        const frameId = suspendOwner();
        const r = manager.invokeCallback(WNDPROC, [0x10005, 0x86, 0, 0], 0, () => null, false, "pump", frameId);

        expect(r.callbackId).not.toBe(0);
        expect(r.callbackId).not.toBe(CALLBACK_DISPATCH_DEFERRED);
        expect(cpu.instruction_pointer[0]).toBe(WNDPROC);
        expect(woken).toEqual([]);
    });

    test("a step taken while a sibling is current leaves the sibling's registers alone", () => {
        const frameId = suspendOwner();
        sibling();

        const r = manager.invokeCallback(WNDPROC, [0x10005, 0x86, 0, 0], 0, () => null, false, "pump", frameId);

        expect(r.callbackId).toBe(CALLBACK_DISPATCH_DEFERRED);
        expect(cpu.reg32[4]).toBe(SIBLING_ESP);
        expect(cpu.instruction_pointer[0]).toBe(SIBLING_EIP);
        expect(manager.getPendingCount()).toBe(0);
        // The owner is parked between pump steps; something has to ready it.
        expect(woken).toEqual([OWNER]);
        expect(switches).toBe(1);
        expect(manager.hasDeferredDispatchForThread(OWNER)).toBe(true);
        expect(manager.dispatchDeferredToOwner(SIBLING)).toBe(false);
    });

    test("the deferred dispatch runs on the owner, anchored on the owner's frame", () => {
        const frameId = suspendOwner();
        sibling();
        let completedWith = -1;
        manager.invokeCallback(WNDPROC, [0x10005, 0x86, 1, 0x10001], 0,
            (ret) => { completedWith = ret; return null; }, false, "pump", frameId);

        current = OWNER;
        cpu.reg32[4] = ENTRY + 4;
        expect(manager.dispatchDeferredToOwner(OWNER)).toBe(true);
        expect(manager.hasDeferredDispatchForThread(OWNER)).toBe(false);

        const view = new DataView(mem.buffer);
        const esp = cpu.reg32[4] >>> 0;
        expect(cpu.instruction_pointer[0]).toBe(WNDPROC);
        expect(esp).toBe(ENTRY - 20);
        expect([1, 2, 3, 4].map((i) => view.getUint32(esp + i * 4, true))).toEqual([0x10005, 0x86, 1, 0x10001]);

        // The window procedure returns through its stub: the pump's completion runs.
        const id = [...(manager as any).pendingCallbacks.keys()][0] as number;
        const call = manager.getPendingCallback(id)!;
        cpu.reg32[4] = call.espBeforeInvoke! - 4;
        view.setUint32(cpu.reg32[4], 7, true);
        manager.handleCallbackReturn(id);
        expect(completedWith).toBe(7);
    });

    test("a deferred dispatch whose frame is gone is dropped, not run", () => {
        const frameId = suspendOwner();
        sibling();
        manager.invokeCallback(WNDPROC, [0, 0, 0, 0], 0, () => null, false, "pump", frameId);
        expect(manager.abandonSuspendedFrame(frameId)).toBe(true);

        current = OWNER;
        expect(manager.dispatchDeferredToOwner(OWNER)).toBe(false);
        expect(manager.getPendingCount()).toBe(0);
    });
});
