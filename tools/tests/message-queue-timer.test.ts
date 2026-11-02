import { describe, expect, test } from "bun:test";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_KEYDOWN = 0x0100;
const WM_TIMER = 0x0113;
const WM_PAINT = 0x000f;

describe("MessageQueue WM_TIMER synthesis", () => {
    test("cancelling an expired timer removes it until it has been observed", () => {
        const q = new MessageQueue();
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        q.cancelTimer(0x10001, 1);
        expect(q.dequeue()).toBeNull();
    });

    test("a timer observed by PM_NOREMOVE survives cancellation", () => {
        const q = new MessageQueue();
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        expect(q.peek()?.message).toBe(WM_TIMER);
        q.cancelTimer(0x10001, 1);
        expect(q.dequeue()?.wParam).toBe(1);
        expect(q.dequeue()).toBeNull();
    });

    test("a materialized timer and a new expiration with the same id remain distinct", () => {
        const q = new MessageQueue();
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        expect(q.peek()?.message).toBe(WM_TIMER);
        q.cancelTimer(0x10001, 1);
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        expect(q.dequeue()?.message).toBe(WM_TIMER);
        expect(q.dequeue()?.message).toBe(WM_TIMER);
        expect(q.dequeue()).toBeNull();
    });

    test("explicitly posted timer messages survive cancellation and keep posted priority", () => {
        const q = new MessageQueue();
        q.enqueue(0x10001, WM_TIMER, 1, 0, 0, 0, 0, undefined, 0, false);
        q.enqueue(0x10001, WM_PAINT, 0, 0);
        q.cancelTimer(0x10001, 1);
        expect(q.dequeue()?.message).toBe(WM_TIMER);
        expect(q.dequeue()?.message).toBe(WM_PAINT);
    });
    test("coalesces repeated ticks for the same window and timer id", () => {
        const q = new MessageQueue();
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        q.enqueue(0x10001, WM_TIMER, 1, 0);

        expect(q.dequeue()?.message).toBe(WM_TIMER);
        expect(q.dequeue()).toBeNull();
    });

    test("keeps different timer ids and windows independent", () => {
        const q = new MessageQueue();
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        q.enqueue(0x10001, WM_TIMER, 2, 0);
        q.enqueue(0x10002, WM_TIMER, 1, 0);

        expect([q.dequeue(), q.dequeue(), q.dequeue()].map(m => [m?.hwnd, m?.wParam])).toEqual([
            [0x10001, 1],
            [0x10001, 2],
            [0x10002, 1],
        ]);
        expect(q.dequeue()).toBeNull();
    });

    test("delivers timer after input and paint", () => {
        const q = new MessageQueue();
        q.enqueue(0x10001, WM_PAINT, 0, 0);
        q.enqueue(0x10001, WM_TIMER, 1, 0);
        q.enqueue(0x10001, WM_KEYDOWN, 0x20, 0);

        expect([q.dequeue()?.message, q.dequeue()?.message, q.dequeue()?.message]).toEqual([
            WM_KEYDOWN,
            WM_PAINT,
            WM_TIMER,
        ]);
    });
});
