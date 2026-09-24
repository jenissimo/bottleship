import { describe, expect, it } from "bun:test";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_KEYDOWN = 0x0100;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;

describe("message queue dwExtraInfo", () => {
    it("carries the input's extra info to the retrieved message", () => {
        const q = new MessageQueue();
        q.enqueue(0x10, WM_KEYDOWN, 0x41, 1, 0, 0, 0, undefined, 0xff515700);
        q.enqueue(0x10, WM_KEYDOWN, 0x42, 1);
        expect(q.dequeue()?.extraInfo).toBe(0xff515700);
        expect(q.dequeue()?.extraInfo).toBe(0);
    });

    it("keeps it across a coalesced mouse move flushed ahead of a click", () => {
        const q = new MessageQueue();
        q.enqueue(0x10, WM_MOUSEMOVE, 0, 0, 0, 0, 0, undefined, 0x1234);
        q.enqueue(0x10, WM_LBUTTONDOWN, 1, 0, 0, 0, 0, undefined, 0x5678);
        const move = q.dequeue();
        expect(move?.message).toBe(WM_MOUSEMOVE);
        expect(move?.extraInfo).toBe(0x1234);
        expect(q.dequeue()?.extraInfo).toBe(0x5678);
    });
});
