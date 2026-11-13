/**
 * A callback chain started when a thunk resumes from an async park returns to the
 * thunk's real caller.
 *
 * While a thread is parked its [ESP] slot holds the spin-loop address (CLAUDE.md §3.5),
 * and the caller's address travels in the context handed to startCallbackChain. A
 * GetMessage that blocked and woke to a mouse move sends WM_SETCURSOR from that
 * continuation; reading the return address back from [ESP] there names the spin loop, the
 * frame save is refused and the message is dropped.
 *
 * Driven through the REAL CallbackManager, so "the frame was saved" is the manager's own
 * verdict and "returns to the caller" is where it leaves EIP/ESP when the window procedure
 * comes back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { CallbackManager } from "../../src/worker/core/thunking/callback-manager";
import { MEM_THUNK_CODE_BASE } from "../../src/worker/core/cpu/emulator-config";
import { createMessageExports, sendToTopLevelSync } from "../../src/worker/modules/user32/message";
import { windows } from "../../src/worker/modules/user32/shared-state";

const system = System.getInstance();
const saved = {
    process: system.process, scheduler: system.scheduler, isExiting: system.isExiting,
    peek: system.windowManager.peekMessage, wait: system.windowManager.waitForMessage,
    forEachTopLevel: system.windowManager.forEachTopLevel, poll: system.inputManager.poll,
};

const STUB_POOL = 0x4000, STUB_POOL_SIZE = 0x4000;
const STACK = { base: 0xa000, top: 0xd000 };
const ESP = 0xc000;                              // the thunk's entry ESP: [ESP] is its return slot
const CALLER = 0x1234;                           // guest code that called GetMessage
const SPIN = (MEM_THUNK_CODE_BASE + 0x40000) >>> 0;
const WNDPROC = 0x1800, OUT = 0x2000, HWND = 0x777, THREAD = 1;
const WM_MOUSEMOVE = 0x200, WM_SETCURSOR = 0x20, WM_DISPLAYCHANGE = 0x7e;
const SETCURSOR_LPARAM = 0x02000001;
const GETMESSAGE_CLEANUP = 16;

let mem: Uint8Array, view: DataView, cpu: any, manager: CallbackManager;
let peeked: unknown;
let wndProcCalls: number[][];

const mouseMove = () => ({ hwnd: HWND, message: WM_MOUSEMOVE, wParam: 0, lParam: 0, time: 1,
    sentSetCursor: { wParam: HWND, lParam: SETCURSOR_LPARAM } });

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    cpu = { reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), is_jumping: false };
    cpu.reg32[4] = ESP;
    view.setUint32(ESP, CALLER, true);
    system.scheduler = {
        getCurrentThreadId: () => THREAD,
        getThreadStackBounds: () => STACK,
        wakeThreadForAsyncCompletion: () => true,
        requestSwitchToThread: () => {},
        wakeEarlyFromIdleYield: () => false,
        wakeCurrentThreadForCallbackDispatch: () => true,
        pinCurrentThread: () => {},
        unpinThread: () => {},
    } as any;
    system.isExiting = false;
    manager = new CallbackManager({ cpu }, {} as any, () => mem);
    manager.initialize({ getRegions: () => ({ callbackStubPoolBase: STUB_POOL, callbackStubPoolSize: STUB_POOL_SIZE }) } as any);
    wndProcCalls = [];
    const invoke = manager.invokeCallback.bind(manager);
    manager.invokeCallback = ((proc: number, args: number[], ...rest: unknown[]) => {
        if (proc === WNDPROC) wndProcCalls.push(args);
        return (invoke as any)(proc, args, ...rest);
    }) as any;
    system.process = {
        resetGeneration: 0,
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length },
        dispatcher: { callbackManager: manager },
        v86: { mem8: mem },
        getCurrentMemory: () => mem,
    } as any;
    peeked = null;
    system.windowManager.peekMessage = (() => peeked) as any;
    system.windowManager.waitForMessage = (async () => mouseMove()) as any;
    system.inputManager.poll = () => {};
    windows.set(HWND, { hwnd: HWND, wndProc: WNDPROC, isSystemControl: false, creatorThreadId: THREAD } as any);
});
afterEach(() => {
    manager.reset();
    windows.delete(HWND);
    system.process = saved.process;
    system.scheduler = saved.scheduler;
    system.isExiting = saved.isExiting;
    system.windowManager.peekMessage = saved.peek;
    system.windowManager.waitForMessage = saved.wait;
    system.windowManager.forEachTopLevel = saved.forEachTopLevel;
    system.inputManager.poll = saved.poll;
});

const getMessage = () =>
    createMessageExports().GetMessageW!({ esp: ESP } as any, mem, [OUT, 0, WM_MOUSEMOVE, WM_MOUSEMOVE]) as Promise<any>;

/** The window procedure is entered: EIP on it, its four arguments above a return into a stub. */
function expectInsideWndProc(message: number, wParam: number, lParam: number): number {
    expect(cpu.instruction_pointer[0] >>> 0).toBe(WNDPROC);
    const esp = cpu.reg32[4] >>> 0;
    const ret = view.getUint32(esp, true);
    expect(ret >= STUB_POOL && ret < STUB_POOL + STUB_POOL_SIZE).toBe(true);
    expect([1, 2, 3, 4].map(i => view.getUint32(esp + i * 4, true))).toEqual([HWND, message, wParam, lParam]);
    const ids = [...(manager as any).pendingCallbacks.keys()] as number[];
    return ids[ids.length - 1]!;
}

/** The window procedure returns `value` through its stub. */
function returnFromWndProc(id: number, value: number): void {
    const call = manager.getPendingCallback(id)!;
    cpu.reg32[4] = call.espBeforeInvoke! - 4;
    view.setUint32(cpu.reg32[4], value, true);
    manager.handleCallbackReturn(id);
}

/** The thunk returned to its caller as a stdcall of `cleanup` bytes with `eax`. */
function expectResumedCaller(cleanup: number, eax: number): void {
    expect(cpu.instruction_pointer[0] >>> 0).toBe(CALLER);
    expect(cpu.reg32[4] >>> 0).toBe(ESP + 4 + cleanup);
    expect(cpu.reg32[0] >>> 0).toBe(eax);
    expect(manager.getPendingCount()).toBe(0);
    expect(manager.getActiveSuspendedFrameId()).toBe(0);
}

describe("WM_SETCURSOR sent from GetMessage", () => {
    test("a GetMessage that blocked resumes its caller from the carried return address", async () => {
        const result = await getMessage();
        expect(result.startCallbackChain).toBeFunction();
        expect(wndProcCalls).toHaveLength(0);

        // The thread is parked: its return slot now holds the spin loop.
        view.setUint32(ESP, SPIN, true);
        expect(result.startCallbackChain({ esp: ESP, returnAddr: CALLER, mem })).toBe(true);

        expect(wndProcCalls).toEqual([[HWND, WM_SETCURSOR, HWND, SETCURSOR_LPARAM]]);
        expect(view.getUint32(OUT + 4, true)).toBe(WM_MOUSEMOVE);
        const id = expectInsideWndProc(WM_SETCURSOR, HWND, SETCURSOR_LPARAM);
        expect(manager.getPendingCount()).toBe(1);

        returnFromWndProc(id, 1);
        expectResumedCaller(GETMESSAGE_CLEANUP, 1);
        expect(wndProcCalls).toHaveLength(1);
        // Resumed from the saved frame, not through the slot the park overwrote.
        expect(view.getUint32(ESP, true)).toBe(SPIN);
    });

    test("a GetMessage answered at once reads its return address from the stack", async () => {
        peeked = mouseMove();
        const result = await getMessage();
        expect(result.suspendedForCallback).toBe(true);
        expect(result.stackCleanup).toBe(GETMESSAGE_CLEANUP);
        expect(result.preserveCallbackReturnAddress).toBe(false);

        expect(wndProcCalls).toHaveLength(1);
        const id = expectInsideWndProc(WM_SETCURSOR, HWND, SETCURSOR_LPARAM);
        returnFromWndProc(id, 1);
        expectResumedCaller(GETMESSAGE_CLEANUP, 1);
    });

    test("a carried address inside the callback stub pool reuses the outer callback's frame", async () => {
        // GetMessage is itself running as a guest callback: its caller is a callback stub.
        const outerFrame = manager.saveSuspendedThunkContext({ esp: ESP, returnAddr: CALLER }, 4, "outer");
        const outer = manager.invokeCallback(0x1900, [1, 2, 3, 4], 0, () => 7, false, "outer", outerFrame);
        expect(outer.callbackId).not.toBe(0);
        const innerEsp = cpu.reg32[4] >>> 0;
        const stubAddr = view.getUint32(innerEsp, true);
        expect(stubAddr >= STUB_POOL && stubAddr < STUB_POOL + STUB_POOL_SIZE).toBe(true);

        const result = await (createMessageExports().GetMessageW!(
            { esp: innerEsp } as any, mem, [OUT, 0, WM_MOUSEMOVE, WM_MOUSEMOVE]) as Promise<any>);
        view.setUint32(innerEsp, SPIN, true);
        expect(result.startCallbackChain({ esp: innerEsp, returnAddr: stubAddr, mem })).toBe(true);

        expect(wndProcCalls).toHaveLength(1);
        const id = expectInsideWndProc(WM_SETCURSOR, HWND, SETCURSOR_LPARAM);
        // No second frame: the window procedure runs under the outer callback's.
        expect(manager.getActiveSuspendedFrameId()).toBe(outerFrame);
        expect(manager.getPendingCallback(id)!.frameId).toBe(outerFrame);
        expect(manager.getPendingCount()).toBe(2);
    });

    test("an answered GetMessage called from a callback stub reuses the frame too", async () => {
        const outerFrame = manager.saveSuspendedThunkContext({ esp: ESP, returnAddr: CALLER }, 4, "outer");
        manager.invokeCallback(0x1900, [1, 2, 3, 4], 0, () => 7, false, "outer", outerFrame);
        const innerEsp = cpu.reg32[4] >>> 0;

        peeked = mouseMove();
        const result = await (createMessageExports().GetMessageW!(
            { esp: innerEsp } as any, mem, [OUT, 0, WM_MOUSEMOVE, WM_MOUSEMOVE]) as Promise<any>);
        expect(result.suspendedForCallback).toBe(true);
        expect(result.preserveCallbackReturnAddress).toBe(true);
        expect(wndProcCalls).toHaveLength(1);
        expect(manager.getActiveSuspendedFrameId()).toBe(outerFrame);
    });
});

describe("a message sent to every top-level window (sendToTopLevelSync)", () => {
    beforeEach(() => {
        system.windowManager.forEachTopLevel = ((visit: (win: unknown) => void) => visit(windows.get(HWND))) as any;
    });

    test("resumes its caller from the carried return address", () => {
        view.setUint32(ESP, SPIN, true);
        const result = sendToTopLevelSync(
            { esp: ESP, returnAddr: CALLER } as any, mem, WM_DISPLAYCHANGE, 16, 0x01e00280, 16, "ChangeDisplaySettings", 0) as any;
        expect(result.suspendedForCallback).toBe(true);

        expect(wndProcCalls).toEqual([[HWND, WM_DISPLAYCHANGE, 16, 0x01e00280]]);
        const id = expectInsideWndProc(WM_DISPLAYCHANGE, 16, 0x01e00280);
        returnFromWndProc(id, 0);
        expectResumedCaller(16, 0);
        expect(wndProcCalls).toHaveLength(1);
    });

    test("reads the return address from the stack when none is carried", () => {
        const result = sendToTopLevelSync(
            { esp: ESP } as any, mem, WM_DISPLAYCHANGE, 16, 0x01e00280, 16, "ChangeDisplaySettings", 0) as any;
        expect(result.suspendedForCallback).toBe(true);
        const id = expectInsideWndProc(WM_DISPLAYCHANGE, 16, 0x01e00280);
        returnFromWndProc(id, 0);
        expectResumedCaller(16, 0);
    });
});
