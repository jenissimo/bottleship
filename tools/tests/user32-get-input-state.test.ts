/**
 * GetInputState reports keyboard or mouse-button input waiting for the calling thread, and
 * only that: a pending mouse move, timer, paint or posted application message is not input.
 */
import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createMessageExports } from "../../src/worker/modules/user32/message";

const system = System.getInstance();
const memory = new Uint8Array(0x1000);
Mem.bind(() => memory);
const exports = createMessageExports();

const manager = system.windowManager;
const originalHas = manager.hasMessages;
const originalPoll = system.inputManager.poll;
afterEach(() => {
    manager.hasMessages = originalHas;
    system.inputManager.poll = originalPoll;
});

function withQueue(pending: number[]): { polls: boolean[]; threads: number[] } {
    const polls: boolean[] = [];
    const threads: number[] = [];
    system.inputManager.poll = (force = false) => { polls.push(force); };
    manager.hasMessages = (min = 0, max = 0, thread = 0) => {
        threads.push(thread);
        return pending.some((m) => (min === 0 && max === 0) || (m >= min && m <= max));
    };
    return { polls, threads };
}

const call = (): number => exports.GetInputState({} as any, memory, []) as number;

test("empty queue -> FALSE, after polling the host input", () => {
    const seen = withQueue([]);
    expect(call()).toBe(0);
    expect(seen.polls).toEqual([true]);
    expect(seen.threads.every((t) => t === system.scheduler.getCurrentThreadId())).toBe(true);
});

test("a key or mouse-button message -> TRUE", () => {
    for (const msg of [0x0100, 0x0101, 0x0104, 0x0109, 0x0201, 0x0202, 0x0204, 0x020a, 0x020e]) {
        withQueue([msg]);
        expect(call()).toBe(1);
    }
});

test("timer, paint and application messages are not input", () => {
    withQueue([0x0113, 0x000f, 0x0400, 0x0010]);
    expect(call()).toBe(0);
});

test("a mouse move alone -> FALSE; a move with a key or button behind it -> TRUE", () => {
    withQueue([0x0200]);
    expect(call()).toBe(0);
    withQueue([0x0200, 0x0200, 0x0113]);
    expect(call()).toBe(0);
    withQueue([0x0200, 0x0100]);
    expect(call()).toBe(1);
    withQueue([0x0200, 0x0201]);
    expect(call()).toBe(1);
});
