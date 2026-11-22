/**
 * WM_QUIT is retrieved regardless of wMsgFilterMin/wMsgFilterMax: GetMessageW and
 * PeekMessageW document that a pending PostQuitMessage bypasses the message filter
 * range (MSDN: "GetMessage does not filter out WM_QUIT"). These tests drive the public
 * exports with a paint-only range and a pending quit, covering both the queue path
 * (MessageQueue.dequeue/peek) and the empty-queue fallback synthesis in message.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { createMessageExports, registerFastPathMessageFunctions } from "../../src/worker/modules/user32/message";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { ThreadState, type Thread } from "../../src/worker/core/scheduler/types";

const WM_QUIT = 0x0012;
const WM_PAINT = 0x000f;
const PM_NOREMOVE = 0x0000;
const PM_REMOVE = 0x0001;
const HWND = 0x10001;
const THREAD = 1;
const OUT = 0x2000;

const system = System.getInstance();
const memory = new Uint8Array(0x20000);
const view = new DataView(memory.buffer);
Mem.bind(() => memory);
const messageExports = createMessageExports();

function fakeThread(id: number): Thread {
    return {
        id, handle: 0x1000 + id, state: ThreadState.RUNNING, context: null,
        stackBase: 0x200000, stackSize: 0x100000, stackTop: 0x300000, startAddress: 0x401000, parameter: 0,
        waitInfo: null, exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
        lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0, apcQueue: [],
        quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

let savedScheduler: unknown;
let savedPoll: unknown;

beforeEach(() => {
    savedScheduler = system.scheduler;
    savedPoll = system.inputManager.poll;
    const sched = system.scheduler as any;
    sched.threads.set(THREAD, fakeThread(THREAD));
    sched.currentThreadId = THREAD;
    system.inputManager.poll = () => {};
});

afterEach(() => {
    const sched = system.scheduler as any;
    sched.threads.delete(THREAD);
    sched.currentThreadId = null;
    system.scheduler = savedScheduler as any;
    system.inputManager.poll = savedPoll as any;
    (system.windowManager as any).messageQueue.clear();
    (system.scheduler as any).clearQuitFlag?.(THREAD);
    // Re-install the default quit source (some tests detach it with setQuitSource(null)).
    (system.windowManager as any).setQuitSource({
        pending: (threadId: number) => {
            const q = (system.scheduler as any).getQuitState?.(threadId);
            return q?.posted ? { exitCode: q.exitCode } : null;
        },
        consume: (threadId: number) => (system.scheduler as any).clearQuitFlag(threadId),
    });
    view.setUint32(OUT + 4, 0, true);
});

function postQuit(exitCode: number): void {
    (system.scheduler as any).postQuitForCurrentThread(exitCode);
}

function quitPosted(): boolean {
    return (system.scheduler as any).getQuitState(THREAD)?.posted === true;
}

function enqueuePaint(): void {
    (system.windowManager as any).messageQueue.enqueue(HWND, WM_PAINT, 0, 0);
}

function peekPaintOnly(remove: boolean): number {
    return messageExports.PeekMessageW!({ esp: 0x1000 } as any, memory, [OUT, 0, WM_PAINT, WM_PAINT, remove]) as number;
}

function getMessagePaintOnly(): any {
    return messageExports.GetMessageW!({ esp: 0x1000 } as any, memory, [OUT, 0, WM_PAINT, WM_PAINT]);
}

function readMsg(): { message: number; wParam: number } {
    return { message: view.getUint32(OUT + 4, true), wParam: view.getUint32(OUT + 8, true) };
}

describe("WM_QUIT bypasses the wMsgFilter range on the public APIs", () => {
    test("PeekMessage(PM_NOREMOVE) with a paint-only range reports WM_QUIT and leaves it pending", () => {
        postQuit(7);
        enqueuePaint();
        expect(peekPaintOnly(PM_NOREMOVE)).toBe(1);
        expect(readMsg()).toEqual({ message: WM_QUIT, wParam: 7 });
        // PM_NOREMOVE: the quit stays pending.
        expect(quitPosted()).toBe(true);
        expect(peekPaintOnly(PM_NOREMOVE)).toBe(1);
        expect(readMsg().message).toBe(WM_QUIT);
    });

    test("GetMessage with a paint-only range returns 0 with the WM_QUIT, then the paint", () => {
        postQuit(7);
        enqueuePaint();
        const result = getMessagePaintOnly();
        // Sync fast path: an object with value 0 for WM_QUIT (or a plain 0).
        expect(typeof result === "object" ? result.value : result).toBe(0);
        expect(readMsg()).toEqual({ message: WM_QUIT, wParam: 7 });
        expect(quitPosted()).toBe(false);
        // The next retrieval sees the paint.
        expect(peekPaintOnly(PM_NOREMOVE)).toBe(1);
        expect(readMsg().message).toBe(WM_PAINT);
    });

    test("the empty-queue fallback also synthesizes WM_QUIT for a paint-only range", () => {
        postQuit(3);
        // No paint, no posted messages: the queue is empty, so PeekMessage falls back to
        // synthesizing WM_QUIT — still regardless of the range.
        expect(peekPaintOnly(PM_NOREMOVE)).toBe(1);
        expect(readMsg()).toEqual({ message: WM_QUIT, wParam: 3 });
        expect(quitPosted()).toBe(true);
        expect(peekPaintOnly(PM_REMOVE)).toBe(1);
        expect(readMsg().message).toBe(WM_QUIT);
        expect(quitPosted()).toBe(false);
        expect(peekPaintOnly(PM_NOREMOVE)).toBe(0);
    });
});

describe("registered fast paths synthesize WM_QUIT when the queue lookup returns null", () => {
    const ESP = 0x1000;
    const fastPaths = new Map<string, (...args: any[]) => any>();
    registerFastPathMessageFunctions({
        registerFastPath: (_dll: string, fn: string, impl: (...args: any[]) => any) => { fastPaths.set(fn, impl); },
    } as any);

    function callFast(name: string, args: number[]): number | null {
        for (let i = 0; i < args.length; i++) view.setUint32(ESP + 4 + 4 * i, args[i] >>> 0, true);
        return fastPaths.get(name)!(ESP, view, memory) as number | null;
    }

    test("fast PeekMessageW returns the pending WM_QUIT for a paint-only range with the quit source detached", () => {
        // Force the queue lookup to return null: with no quit source, MessageQueue
        // does not synthesize WM_QUIT, so only the fast path's own fallback can.
        (system.windowManager as any).setQuitSource(null);
        postQuit(29);
        const ret = callFast("PeekMessageW", [OUT, 0, WM_PAINT, WM_PAINT, PM_NOREMOVE]);
        expect(ret).toBe(1);
        expect(readMsg()).toEqual({ message: WM_QUIT, wParam: 29 });
        expect(quitPosted()).toBe(true); // PM_NOREMOVE leaves the quit pending
        const ret2 = callFast("PeekMessageW", [OUT, 0, WM_PAINT, WM_PAINT, PM_REMOVE]);
        expect(ret2).toBe(1);
        expect(readMsg()).toEqual({ message: WM_QUIT, wParam: 29 });
        expect(quitPosted()).toBe(false); // PM_REMOVE consumes it
        expect(callFast("PeekMessageW", [OUT, 0, WM_PAINT, WM_PAINT, PM_NOREMOVE])).toBe(0);
    });

    test("fast GetMessageW returns 0 with the pending WM_QUIT for a paint-only range with the quit source detached", () => {
        (system.windowManager as any).setQuitSource(null);
        postQuit(29);
        const ret = callFast("GetMessageW", [OUT, 0, WM_PAINT, WM_PAINT]);
        expect(ret).toBe(0); // GetMessage returns 0 on WM_QUIT
        expect(readMsg()).toEqual({ message: WM_QUIT, wParam: 29 });
        expect(quitPosted()).toBe(false);
    });
});
