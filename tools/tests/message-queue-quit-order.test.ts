// USER's GetMessage/PeekMessage order is: sent, posted, input, WM_QUIT, WM_PAINT, WM_TIMER.
// WM_PAINT and WM_TIMER are generated only when nothing else is pending, so a window that
// keeps invalidating itself or a running timer must not hold a PostQuitMessage back.
import { describe, expect, it } from "bun:test";
import { MessageQueue, type QuitSource } from "../../src/worker/runtime/windowing/message-queue";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState, type Thread } from "../../src/worker/core/scheduler/types";

const WM_QUIT = 0x0012;
const WM_PAINT = 0x000f;
const WM_KEYDOWN = 0x0100;
const WM_TIMER = 0x0113;
const WM_USER = 0x0400;
const HWND = 0x10001;

/** A quit flag per thread, shaped like the scheduler's. */
function fakeQuits(): QuitSource & { post(threadId: number, exitCode: number): void; consumed: number[] } {
    const flags = new Map<number, number>();
    const consumed: number[] = [];
    return {
        consumed,
        post: (threadId, exitCode) => { flags.set(threadId, exitCode); },
        pending: (threadId) => (flags.has(threadId) ? { exitCode: flags.get(threadId)! } : null),
        consume: (threadId) => { consumed.push(threadId); flags.delete(threadId); },
    };
}

function queueWithQuit(threadId = 1, exitCode = 7) {
    const q = new MessageQueue();
    const quits = fakeQuits();
    q.setQuitSource(quits);
    quits.post(threadId, exitCode);
    return { q, quits };
}

describe("WM_QUIT is retrieved before generated WM_PAINT and WM_TIMER", () => {
    it("returns the quit ahead of a pending paint, then the paint", () => {
        const { q, quits } = queueWithQuit();
        q.enqueue(HWND, WM_PAINT, 0, 0);
        const quit = q.dequeue(0, 0, 1);
        expect(quit?.message).toBe(WM_QUIT);
        expect(quit?.hwnd).toBe(0);
        expect(quit?.wParam).toBe(7);
        expect(quits.consumed).toEqual([1]);
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_PAINT);
        expect(q.dequeue(0, 0, 1)).toBeNull();
    });

    it("returns the quit ahead of an expired timer", () => {
        const { q } = queueWithQuit();
        q.enqueue(HWND, WM_TIMER, 1, 0);
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_QUIT);
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_TIMER);
    });

    it("is not held back by a window that invalidates itself after every paint", () => {
        const { q } = queueWithQuit();
        const delivered: number[] = [];
        for (let i = 0; i < 5; i++) {
            q.enqueue(HWND, WM_PAINT, 0, 0);
            const msg = q.dequeue(0, 0, 1);
            delivered.push(msg!.message);
            if (msg!.message === WM_QUIT) break;
        }
        expect(delivered).toEqual([WM_QUIT]);
    });

    it("keeps posted messages and hardware input ahead of the quit", () => {
        const { q } = queueWithQuit();
        q.enqueue(HWND, WM_PAINT, 0, 0);
        q.enqueue(HWND, WM_KEYDOWN, 0x41, 1, 0, 0, 0, undefined, 0, true, 0, true);
        q.enqueue(HWND, WM_USER, 1, 0);
        expect([q.dequeue(0, 0, 1), q.dequeue(0, 0, 1), q.dequeue(0, 0, 1), q.dequeue(0, 0, 1)].map(m => m?.message))
            .toEqual([WM_USER, WM_KEYDOWN, WM_QUIT, WM_PAINT]);
    });

    it("delivers the quit once", () => {
        const { q } = queueWithQuit();
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_QUIT);
        expect(q.dequeue(0, 0, 1)).toBeNull();
    });
});

describe("WM_QUIT retrieval honours the message filter and the caller", () => {
    it("a filter that excludes WM_QUIT returns the paint and leaves the quit pending", () => {
        const { q, quits } = queueWithQuit();
        q.enqueue(HWND, WM_PAINT, 0, 0);
        expect(q.dequeue(WM_PAINT, WM_PAINT, 1)?.message).toBe(WM_PAINT);
        expect(quits.consumed).toEqual([]);
        expect(q.dequeue(WM_QUIT, WM_QUIT, 1)?.message).toBe(WM_QUIT);
    });

    it("a filter that includes WM_QUIT returns it ahead of the paint", () => {
        const { q } = queueWithQuit();
        q.enqueue(HWND, WM_PAINT, 0, 0);
        expect(q.dequeue(0x0001, 0x0113, 1)?.message).toBe(WM_QUIT);
    });

    it("a quit posted by another thread is not delivered to the caller", () => {
        const { q, quits } = queueWithQuit(2);
        q.enqueue(HWND, WM_PAINT, 0, 0);
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_PAINT);
        expect(quits.consumed).toEqual([]);
        expect(q.dequeue(0, 0, 2)?.message).toBe(WM_QUIT);
    });

    it("PM_NOREMOVE reports the quit without clearing the flag", () => {
        const { q, quits } = queueWithQuit();
        q.enqueue(HWND, WM_PAINT, 0, 0);
        expect(q.peek(0, 0, 1)?.message).toBe(WM_QUIT);
        expect(q.peek(0, 0, 1)?.message).toBe(WM_QUIT);
        expect(quits.consumed).toEqual([]);
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_QUIT);
    });

    it("a queue without a quit source behaves as before", () => {
        const q = new MessageQueue();
        q.enqueue(HWND, WM_PAINT, 0, 0);
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_PAINT);
        expect(q.dequeue(0, 0, 1)).toBeNull();
    });
});

describe("with the scheduler's PostQuitMessage flag", () => {
    function thread(id: number): Thread {
        return {
            id, handle: 0x1000 + id, state: ThreadState.RUNNING, context: null,
            stackBase: 0x200000, stackSize: 0x100000, stackTop: 0x300000, startAddress: 0x401000, parameter: 0,
            waitInfo: null, exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0,
            lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0, apcQueue: [],
            quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
        };
    }

    it("PostQuitMessage(3) beats the pending paint and clears the flag", () => {
        const s = new Scheduler() as any;
        s.threads.set(1, thread(1));
        s.currentThreadId = 1;
        const q = new MessageQueue();
        q.setQuitSource({
            pending: (id) => { const st = s.getQuitState(id); return st?.posted ? { exitCode: st.exitCode } : null; },
            consume: (id) => s.clearQuitFlag(id),
        });
        q.enqueue(HWND, WM_PAINT, 0, 0);
        s.postQuitForCurrentThread(3);
        const msg = q.dequeue(0, 0, 1);
        expect(msg?.message).toBe(WM_QUIT);
        expect(msg?.wParam).toBe(3);
        expect(s.hasPendingQuit(1)).toBe(false);
        expect(q.dequeue(0, 0, 1)?.message).toBe(WM_PAINT);
    });
});
