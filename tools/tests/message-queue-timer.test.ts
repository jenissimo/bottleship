import { describe, expect, test } from "bun:test";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_KEYDOWN = 0x0100;
const WM_TIMER = 0x0113;
const WM_PAINT = 0x000f;

describe("MessageQueue WM_TIMER synthesis", () => {
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
