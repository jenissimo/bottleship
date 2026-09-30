/**
 * postHostTask — the tick loop's "yield and come straight back". It must queue through the
 * renderer's task scheduler where there is one (a MessagePort message is carried over IPC and
 * can arrive milliseconds late), and still run everything, in order, on the fallback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createTickYield, postHostTask } from "../../src/worker/core/host-task";

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

/** vendor/v86/src/main.js's tick loop, verbatim in the parts that decide which tick runs. */
class TickLoop {
    tick_counter = 0;
    running = false;
    stopping = false;
    idle = true;
    ticks = 0;
    yield: (t: number, tick: number) => void = () => {};
    constructor(private readonly onTick: (loop: TickLoop) => number) {}
    run(): void {
        this.stopping = false;
        this.running = true;
        this.next_tick(0);
    }
    stop(): void { if (this.running) this.stopping = true; }
    do_tick(): void {
        if (this.stopping || !this.running) { this.stopping = this.running = false; return; }
        this.idle = false;
        this.ticks++;
        this.next_tick(this.onTick(this));
    }
    next_tick(t: number): void {
        const tick = ++this.tick_counter;
        this.idle = true;
        this.yield(t, tick);
    }
    yield_callback(tick: number): void { if (tick === this.tick_counter) this.do_tick(); }
}

/** A tick that re-queues itself mid-tick the ways the scheduler and the CPU do: run() on a
 *  yield resume, and the wake callback (`idle && next_tick(0)`). */
function reentrantTick(loop: TickLoop): number {
    if (loop.ticks % 3 === 0) loop.run();
    if (loop.ticks % 5 === 0 && loop.idle) loop.next_tick(0);
    return 0;
}

function pump(queue: Array<() => void>, steps: number): number {
    let maxQueued = 0;
    for (let i = 0; i < steps && queue.length; i++) {
        queue.shift()!();
        maxQueued = Math.max(maxQueued, queue.length);
    }
    return maxQueued;
}

describe("createTickYield", () => {
    test("a tick re-queued mid-tick never becomes a second tick chain", () => {
        const queue: Array<() => void> = [];
        g.scheduler = { postTask: (cb: () => void) => { queue.push(cb); return Promise.resolve(); } };
        const loop = new TickLoop(reentrantTick);
        loop.yield = createTickYield((tick) => loop.yield_callback(tick));
        loop.run();
        const maxQueued = pump(queue, 2000);
        expect(maxQueued).toBe(1);
        expect(loop.ticks).toBe(2000);
    });

    test("negative control: a shared latest-tick callback without the in-flight guard multiplies", () => {
        const queue: Array<() => void> = [];
        g.scheduler = { postTask: (cb: () => void) => { queue.push(cb); return Promise.resolve(); } };
        const loop = new TickLoop(reentrantTick);
        let pendingTick = 0;
        const runTick = (): void => loop.yield_callback(pendingTick);
        loop.yield = (t, tick) => { if (t < 1) { pendingTick = tick; postHostTask(runTick); } };
        loop.run();
        expect(pump(queue, 2000)).toBeGreaterThan(100);
    });

    test("a tick superseded by a later timed yield is discarded", async () => {
        const queue: Array<() => void> = [];
        g.scheduler = { postTask: (cb: () => void) => { queue.push(cb); return Promise.resolve(); } };
        let latest = 0;
        const ran: number[] = [];
        const y = createTickYield((tick) => { if (tick === latest) ran.push(tick); });
        y(0, latest = 1);
        y(2, latest = 2);
        queue.shift()!();
        await new Promise((r) => setTimeout(r, 20));
        expect(ran).toEqual([2]);
        expect(queue).toHaveLength(0);
    });

    test("stop() still ends the loop: the in-flight tick observes it", () => {
        const queue: Array<() => void> = [];
        g.scheduler = { postTask: (cb: () => void) => { queue.push(cb); return Promise.resolve(); } };
        const loop = new TickLoop((l) => { if (l.ticks === 10) l.stop(); return 0; });
        loop.yield = createTickYield((tick) => loop.yield_callback(tick));
        loop.run();
        pump(queue, 100);
        expect(loop.ticks).toBe(10);
        expect(loop.running).toBe(false);
        expect(queue).toHaveLength(0);
    });
});
