/**
 * postHostTask — the tick loop's "yield and come straight back". It must queue through the
 * renderer's task scheduler where there is one (a MessagePort message is carried over IPC and
 * can arrive milliseconds late), and still run everything, in order, on the fallback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { postHostTask } from "../../src/worker/core/host-task";

const g = globalThis as { scheduler?: unknown; __noPostTaskYield?: boolean };
const saved = g.scheduler;

afterEach(() => { g.scheduler = saved; delete g.__noPostTaskYield; });

describe("postHostTask", () => {
    test("uses scheduler.postTask when the host has it", async () => {
        const posted: Array<() => void> = [];
        g.scheduler = { postTask: (cb: () => void) => { posted.push(cb); return Promise.resolve(); } };
        let ran = false;
        postHostTask(() => { ran = true; });
        expect(posted).toHaveLength(1);
        posted[0]!();
        expect(ran).toBe(true);
    });

    test("falls back to a MessageChannel and runs callbacks in order", async () => {
        let posted = 0;
        g.scheduler = { postTask: () => { posted++; return Promise.resolve(); } };
        g.__noPostTaskYield = true;
        const order: number[] = [];
        await new Promise<void>((done) => {
            postHostTask(() => order.push(1));
            postHostTask(() => { order.push(2); done(); });
        });
        expect(order).toEqual([1, 2]);
        expect(posted).toBe(0);
    });
});
