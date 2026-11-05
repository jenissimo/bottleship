// USER retrieves posted messages before hardware input (GetMessage: sent, posted, input,
// WM_PAINT, WM_TIMER). TranslateMessage POSTS WM_CHAR, so with a burst of keys already
// queued the character still lands between its WM_KEYDOWN and WM_KEYUP.
import { describe, expect, it } from "bun:test";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_MOUSEMOVE = 0x0200;
const WM_USER = 0x0400;

const input = (q: MessageQueue, msg: number, wParam: number) =>
    q.enqueue(0x10, msg, wParam, 1, 0, 0, 0, undefined, 0, true, 0, true);
const posted = (q: MessageQueue, msg: number, wParam: number) => q.enqueue(0x10, msg, wParam, 1);

describe("posted messages are retrieved before hardware input", () => {
    it("a translated WM_CHAR overtakes the queued WM_KEYUP and the next key", () => {
        const q = new MessageQueue();
        input(q, WM_KEYDOWN, 0x41);
        input(q, WM_KEYUP, 0x41);
        input(q, WM_KEYDOWN, 0x42);
        input(q, WM_KEYUP, 0x42);
        const order: string[] = [];
        for (let m = q.dequeue(); m; m = q.dequeue()) {
            order.push(`${m.message.toString(16)}:${m.wParam.toString(16)}`);
            if (m.message === WM_KEYDOWN) posted(q, WM_CHAR, m.wParam + 0x20); // TranslateMessage
        }
        expect(order).toEqual(["100:41", "102:61", "101:41", "100:42", "102:62", "101:42"]);
    });

    it("posted messages keep FIFO order among themselves and precede a coalesced move", () => {
        const q = new MessageQueue();
        input(q, WM_MOUSEMOVE, 0);
        posted(q, WM_USER, 1);
        posted(q, WM_USER, 2);
        expect(q.peek()?.wParam).toBe(1);
        expect(q.dequeue()?.wParam).toBe(1);
        expect(q.dequeue()?.wParam).toBe(2);
        expect(q.dequeue()?.message).toBe(WM_MOUSEMOVE);
        expect(q.hasMessages()).toBe(false);
    });

    it("window destruction purges both queues", () => {
        const q = new MessageQueue();
        input(q, WM_KEYDOWN, 0x41);
        posted(q, WM_USER, 1);
        q.enqueue(0x20, WM_USER, 2);
        q.removeWindow(0x10);
        expect(q.dequeue()?.hwnd).toBe(0x20);
        expect(q.dequeue()).toBeNull();
    });
});
