import { describe, expect, it } from "bun:test";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_KEYDOWN = 0x0100;
const WM_USER = 0x0400;
const T1 = 1;
const T15 = 15;

describe("message queue thread targeting", () => {
    // PostThreadMessage(T1, ...) belongs to T1 alone. DestroyWindow purges the destroyed
    // window's messages by draining and re-queuing the rest; a re-queued thread message
    // that comes back untargeted can be retrieved by any thread's PeekMessage.
    it("keeps a thread message's target when another window is destroyed", () => {
        const q = new MessageQueue();
        q.enqueue(0, WM_USER + 3, 0, 0, 0, 0, T1);
        q.enqueue(0x20, WM_KEYDOWN, 0x41, 1, 0, 0, T15);
        q.removeWindow(0x20);

        expect(q.dequeue(0, 0, T15)).toBeNull();
        const msg = q.dequeue(0, 0, T1);
        expect(msg?.message).toBe(WM_USER + 3);
        expect(msg?.targetThreadId).toBe(T1);
    });

    it("reports the target thread of a range-filtered retrieval", () => {
        const q = new MessageQueue();
        q.enqueue(0, WM_USER + 2, 0, 0, 0, 0, T15);
        expect(q.dequeue(WM_USER, WM_USER + 0xff, T15)?.targetThreadId).toBe(T15);
    });

    it("keeps the extra info of messages queued ahead of one retrieved from the middle", () => {
        const q = new MessageQueue();
        q.enqueue(0x10, WM_KEYDOWN, 0x41, 1, 0, 0, T1, undefined, 0x11);
        q.enqueue(0x10, WM_KEYDOWN, 0x42, 1, 0, 0, T15, undefined, 0x22);

        expect(q.dequeue(0, 0, T15)?.extraInfo).toBe(0x22);
        expect(q.dequeue(0, 0, T1)?.extraInfo).toBe(0x11);
    });
});
