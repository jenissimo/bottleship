import { describe, expect, test } from "bun:test";
import { MessageQueue } from "../../src/worker/runtime/windowing/message-queue";

const WM_SETCURSOR = 0x0020;
const WM_MOUSEMOVE = 0x0200;
const WM_KEYDOWN = 0x0100;
const HTCLIENT = 1;
const HWND = 0x10001;

describe("a mouse move that carries WM_SETCURSOR is visible before retrieval", () => {
    test("the pending move reports its WM_SETCURSOR until it is retrieved", () => {
        const q = new MessageQueue();
        q.enqueue(HWND, WM_SETCURSOR, HWND, (HTCLIENT | (WM_MOUSEMOVE << 16)) >>> 0);
        q.enqueue(HWND, WM_MOUSEMOVE, 0, 0x00100010);
        expect(q.hasPendingMoveSetCursor()).toBe(true);
        expect(q.hasPendingMoveSetCursor(WM_MOUSEMOVE, WM_MOUSEMOVE)).toBe(true);
        expect(q.hasPendingMoveSetCursor(WM_KEYDOWN, WM_KEYDOWN)).toBe(false);
        const msg = q.dequeue();
        expect(msg?.message).toBe(WM_MOUSEMOVE);
        expect(msg?.sentSetCursor).toBeDefined();
        expect(q.hasPendingMoveSetCursor()).toBe(false);
    });

    test("negative control: a plain mouse move has nothing to send", () => {
        const q = new MessageQueue();
        q.enqueue(HWND, WM_MOUSEMOVE, 0, 0x00100010);
        expect(q.hasPendingMoveSetCursor()).toBe(false);
    });
});
