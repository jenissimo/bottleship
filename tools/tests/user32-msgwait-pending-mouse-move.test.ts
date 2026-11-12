/**
 * MsgWaitForMultipleObjects reports a mouse move the thread has not been told about as new
 * input, even when the move was queued before the call.
 *
 * A coalesced WM_MOUSEMOVE wakes no waiter when it is queued, and the wait's own input poll
 * is usually what queues it. A window thread that pumps only when this wait reports input
 * (the usual shape: wait on a few event handles with QS_ALLINPUT, then PeekMessage until
 * empty) therefore never retrieved a mouse move, and was never sent the WM_SETCURSOR that
 * travels with it - so a pointer the app hides in its WM_SETCURSOR handler stayed visible.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_MOUSEMOVE = 0x0200;
const WM_KEYDOWN = 0x0100;
const HWND = 0x10;
const HWND2 = 0x20;
const QS_KEY = 0x0001;
const QS_ALLINPUT = 0x04ff;
const INFINITE_FALSE = 0;

const move = (q: MessageQueue, x: number, y: number, thread = 0) =>
    q.enqueue(HWND, WM_MOUSEMOVE, 0, (y << 16) | x, x, y, thread);

describe("MessageQueue.takeNewMouseMove", () => {
    test("nothing pending is not new input", () => {
        expect(new MessageQueue().takeNewMouseMove(1)).toBe(false);
    });

    test("a pending move is reported once per thread, a later move again", () => {
        const q = new MessageQueue();
        move(q, 10, 20);
        expect(q.takeNewMouseMove(1)).toBe(true);
        expect(q.takeNewMouseMove(1)).toBe(false);
        expect(q.takeNewMouseMove(2)).toBe(true);
        move(q, 11, 20);
        expect(q.takeNewMouseMove(1)).toBe(true);
        expect(q.takeNewMouseMove(1)).toBe(false);
    });

    test("a move addressed to another thread is not this thread's input", () => {
        const q = new MessageQueue();
        move(q, 10, 20, 2);
        expect(q.takeNewMouseMove(1)).toBe(false);
        expect(q.takeNewMouseMove(2)).toBe(true);
    });

    test("a retrieved move is gone; other queued messages are not mouse moves", () => {
        const q = new MessageQueue();
        move(q, 10, 20);
        expect(q.dequeue()?.message).toBe(WM_MOUSEMOVE);
        expect(q.takeNewMouseMove(1)).toBe(false);
        q.enqueue(HWND, WM_KEYDOWN, 0x41, 0, 0, 0, 0, undefined, 0, true, 0, true);
        expect(q.takeNewMouseMove(1)).toBe(false);
    });

    test("pending moves on two windows of one thread are reported once, not alternately", () => {
        const q = new MessageQueue();
        q.enqueue(HWND, WM_MOUSEMOVE, 0, 0, 1, 1, 1);
        q.enqueue(HWND2, WM_MOUSEMOVE, 0, 0, 2, 2, 1);
        const answers = [0, 1, 2, 3, 4, 5].map(() => q.takeNewMouseMove(1));
        expect(answers).toEqual([true, false, false, false, false, false]);
        q.enqueue(HWND, WM_MOUSEMOVE, 0, 0, 3, 3, 1);
        expect(q.takeNewMouseMove(1)).toBe(true);
        expect(q.takeNewMouseMove(1)).toBe(false);
    });

    test("a move the thread looked at with a filter that admits mouse moves is not new", () => {
        const q = new MessageQueue();
        move(q, 10, 20);
        expect(q.peek(0, 0, 1)?.message).toBe(WM_MOUSEMOVE);
        expect(q.takeNewMouseMove(1)).toBe(false);
        expect(q.takeNewMouseMove(2)).toBe(true);
        move(q, 11, 20);
        expect(q.peek(WM_MOUSEMOVE, WM_MOUSEMOVE, 1)?.message).toBe(WM_MOUSEMOVE);
        expect(q.takeNewMouseMove(1)).toBe(false);
    });

    test("a look with a filter that excludes mouse moves leaves the move new", () => {
        const q = new MessageQueue();
        move(q, 10, 20);
        expect(q.peek(WM_KEYDOWN, WM_KEYDOWN, 1)).toBeNull();
        expect(q.takeNewMouseMove(1)).toBe(true);
    });

    test("a move put back after removal is not new again", () => {
        const q = new MessageQueue();
        move(q, 10, 20);
        const taken = q.dequeue(0, 0, 1)!;
        q.restorePendingMouseMove(taken);
        expect(q.takeNewMouseMove(1)).toBe(false);
    });

    test("clear() forgets what each thread was told, and asking never grows the record", () => {
        const q = new MessageQueue();
        const inner = q as unknown as { seenMoveSeq: Map<number, number>; moveSeq: Map<number, number> };
        for (let i = 0; i < 1000; i++) { move(q, i, 20); q.takeNewMouseMove(1); q.peek(0, 0, 1); }
        expect(inner.seenMoveSeq.size).toBe(1);
        expect(inner.moveSeq.size).toBe(1);
        q.removeWindow(HWND);
        expect(inner.moveSeq.size).toBe(0);
        move(q, 10, 20);
        q.clear();
        expect(inner.seenMoveSeq.size).toBe(0);
        expect(inner.moveSeq.size).toBe(0);
        move(q, 10, 20);
        expect(q.takeNewMouseMove(1)).toBe(true);
    });
});

describe("MsgWaitForMultipleObjects and a pending mouse move", () => {
    const system = System.getInstance();
    const memory = new Uint8Array(0x1000);
    Mem.bind(() => memory);
    const exports = createMessageExports();
    const queue = (system.windowManager as unknown as { messageQueue: MessageQueue }).messageQueue;
    const originalPoll = system.inputManager.poll;
    afterEach(() => { system.inputManager.poll = originalPoll; queue.clear(); });

    // (nCount, pHandles, fWaitAll, dwMilliseconds, dwWakeMask); a zero timeout never parks.
    const wait = (mask: number): number =>
        (exports.MsgWaitForMultipleObjects({ esp: 0x100 } as any, memory, [0, 0, INFINITE_FALSE, 0, mask]) as number) >>> 0;

    test("the move the call's own poll queues ends the wait with the input result", () => {
        const thread = system.scheduler.getCurrentThreadId();
        system.inputManager.poll = () => { move(queue, 30, 40, thread); };
        expect(wait(QS_ALLINPUT)).toBe(0);            // WAIT_OBJECT_0 + nCount
    });

    test("the same pending move does not end a second wait", () => {
        const thread = system.scheduler.getCurrentThreadId();
        let polled = false;
        system.inputManager.poll = () => { if (!polled) move(queue, 30, 40, thread); polled = true; };
        expect(wait(QS_ALLINPUT)).toBe(0);
        expect(wait(QS_ALLINPUT)).not.toBe(0);
    });

    test("a wake mask without QS_MOUSEMOVE ignores it", () => {
        const thread = system.scheduler.getCurrentThreadId();
        system.inputManager.poll = () => { move(queue, 30, 40, thread); };
        expect(wait(QS_KEY)).not.toBe(0);
        // ... and leaves it to be reported to a caller that does ask for mouse moves.
        system.inputManager.poll = () => {};
        expect(wait(QS_ALLINPUT)).toBe(0);
    });

    test("without a pending move the wait is what it was", () => {
        system.inputManager.poll = () => {};
        expect(wait(QS_ALLINPUT)).not.toBe(0);
    });
});
