// The WM_SETCURSOR a mouse move carries coalesces with that move and leaves on it, to be
// SENT by the retrieving call. Queued per move it flushed every pending WM_MOUSEMOVE, so a
// pump reading one message per frame replayed the pointer's whole path seconds behind it.
import { describe, expect, it } from "bun:test";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_SETCURSOR = 0x0020;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const HWND = 0x10;
const SETCURSOR_FOR_MOVE = ((WM_MOUSEMOVE << 16) | 1) >>> 0; // HTCLIENT

function postMove(q: MessageQueue, x: number): void {
    q.enqueue(HWND, WM_SETCURSOR, HWND, SETCURSOR_FOR_MOVE);
    q.enqueue(HWND, WM_MOUSEMOVE, 0, x);
}

function drain(q: MessageQueue): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let m = q.dequeue(); m; m = q.dequeue()) out.push([m.message, m.lParam]);
    return out;
}

describe("WM_SETCURSOR coalesces with its mouse move", () => {
    it("many moves leave one WM_MOUSEMOVE carrying the WM_SETCURSOR to send", () => {
        const q = new MessageQueue();
        for (let x = 1; x <= 40; x++) postMove(q, x);
        const move = q.dequeue();
        expect([move?.message, move?.lParam]).toEqual([WM_MOUSEMOVE, 40]);
        expect(move?.sentSetCursor).toEqual({ wParam: HWND, lParam: SETCURSOR_FOR_MOVE });
        expect(q.dequeue()).toBeNull();
    });

    it("a move posted after the last retrieval is not starved by its WM_SETCURSOR", () => {
        const q = new MessageQueue();
        postMove(q, 1);
        expect(q.dequeue()?.lParam).toBe(1);
        postMove(q, 2);
        expect(q.dequeue()?.lParam).toBe(2);
    });

    it("peek shows the move without consuming its WM_SETCURSOR", () => {
        const q = new MessageQueue();
        postMove(q, 7);
        const peeked = q.peek();
        expect(peeked?.message).toBe(WM_MOUSEMOVE);
        expect(peeked?.sentSetCursor).toBeUndefined();
        expect(q.dequeue()?.sentSetCursor).toBeDefined();
    });

    it("a filtered retrieval of the move still carries the WM_SETCURSOR", () => {
        const q = new MessageQueue();
        postMove(q, 5);
        expect(q.dequeue(WM_MOUSEMOVE, WM_MOUSEMOVE)?.sentSetCursor).toBeDefined();
    });

    it("a click flushes the pending pair ahead of it, in order", () => {
        const q = new MessageQueue();
        postMove(q, 3);
        q.enqueue(HWND, WM_LBUTTONDOWN, 1, 3);
        expect(drain(q).map(([m]) => m)).toEqual([WM_SETCURSOR, WM_MOUSEMOVE, WM_LBUTTONDOWN]);
    });

    it("a WM_SETCURSOR for a click stays an ordinary queued message", () => {
        const q = new MessageQueue();
        const forClick = ((WM_LBUTTONDOWN << 16) | 1) >>> 0;
        q.enqueue(HWND, WM_SETCURSOR, HWND, forClick);
        q.enqueue(HWND, WM_LBUTTONDOWN, 1, 0);
        expect(drain(q)).toEqual([[WM_SETCURSOR, forClick], [WM_LBUTTONDOWN, 0]]);
    });

    it("a restored move comes back unless a newer one replaced it", () => {
        const q = new MessageQueue();
        postMove(q, 4);
        const move = q.dequeue()!;
        q.restorePendingMouseMove(move);
        expect(q.dequeue()?.lParam).toBe(4);
        postMove(q, 5);
        const newer = q.dequeue()!;
        postMove(q, 6);
        q.restorePendingMouseMove(newer);
        expect(q.dequeue()?.lParam).toBe(6);
    });
});
