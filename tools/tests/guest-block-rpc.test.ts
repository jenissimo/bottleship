import { expect, spyOn, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { registerPerfCommands } from "../../src/worker/harness/cmds/perf";

async function withRecorder(run: (f: {
    command: (options: Record<string, unknown>) => Promise<any>;
    advance: (raw: number) => void;
    tick: () => void;
    disarmExternally: () => void;
    timers: () => number;
    recording: () => boolean;
}) => Promise<void>): Promise<void> {
    let raw = 0xffff_ff00;
    let serial = 10;
    let enabled = false;
    const pages = new Set<number>();
    const timers = new Map<object, () => void>();
    const cpu = { instruction_counter: new Int32Array([raw | 0]) };
    const handlers = new Map<string, (args: unknown[]) => unknown>();
    const instance = spyOn(System, "getInstance").mockReturnValue({
        process: { v86: { cpu } },
        services: { render: { getPresentSerial: () => serial } },
    } as never);
    const priorPreemption = (globalThis as any).preemption;
    (globalThis as any).preemption = { getWasmExports: () => ({
        trace2_reset: () => { pages.clear(); enabled = false; },
        trace2_watch_page: (address: number) => { pages.add(address); enabled = true; return 1; },
        trace2_enabled: () => Number(enabled),
        trace2_unwatch_all: () => { pages.clear(); enabled = false; },
        trace2_watched_page_count: () => pages.size,
        jit_get_tier2_page_count: () => 0,
        jit_get_tier2_page_at: () => 0,
        trace2_block_snapshot: () => 1,
        trace2_block_addr: () => 0x1000,
        trace2_block_exec: () => 2,
        trace2_block_instructions: () => 5,
        trace2_block_kind: () => 0,
    }) };
    // Browser timer IDs are numbers; Node/Bun handles can also be objects. Neither a
    // timer handle nor the accumulator's counter-reader closure belongs in an RPC report.
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
        const handle = { timerOwner: () => undefined };
        timers.set(handle, callback);
        return handle;
    }) as never);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(((handle: object) => {
        timers.delete(handle);
    }) as never);
    registerPerfCommands({ setVerbFence: () => undefined, register: (name: string, handler: (args: unknown[]) => unknown) => {
        handlers.set(name, handler);
    } } as never);
    const command = async (options: Record<string, unknown>) => handlers.get("guestBlocks")!([options]);
    try {
        await run({
            command,
            advance: value => { raw = value >>> 0; cpu.instruction_counter[0] = raw | 0; serial++; },
            tick: () => { for (const callback of timers.values()) callback(); },
            disarmExternally: () => { enabled = false; pages.clear(); },
            timers: () => timers.size,
            recording: () => enabled,
        });
    } finally {
        // The same public command must own cleanup even when an assertion/clone fails.
        try { await command({ phase: "read", keepArmed: false }); }
        finally {
            clear.mockRestore();
            interval.mockRestore();
            instance.mockRestore();
            if (priorPreemption === undefined) delete (globalThis as any).preemption;
            else (globalThis as any).preemption = priorPreemption;
        }
    }
}

test("guestBlocks arm crosses RPC without exporting its live counter/timer, then read and disarm still work", async () => {
    await withRecorder(async f => {
        const armed = await f.command({ phase: "arm", pages: [0x1000, 0x2000], maxPages: 1 });
        const reply = structuredClone(armed);
        expect(reply.armed).toBe(true);
        expect(reply.window.armedRequested).toEqual(["0x1000"]);
        expect(reply.window.requestedDropped).toEqual(["0x2000"]);
        expect(reply.window.retired).toBeUndefined();
        expect(f.timers()).toBe(1);
        expect(f.recording()).toBe(true);

        f.advance(0x100);
        f.tick();
        const first = structuredClone(await f.command({ phase: "read" }));
        expect(first.counted).toMatchObject({ available: true, retiredIns: 512, totalWeightedIns: 10 });
        expect(first.counted.window.retiredCounterWraps).toBe(1);
        expect(first.stillArmed).toBe(true);
        expect(f.timers()).toBe(1);

        f.advance(0x300);
        const last = structuredClone(await f.command({ phase: "read", keepArmed: false }));
        expect(last.counted.retiredIns).toBe(1024);
        expect(last.stillArmed).toBe(false);
        expect(f.timers()).toBe(0);
        expect(f.recording()).toBe(false);
        expect(structuredClone(await f.command({ phase: "read" })).counted.available).toBe(false);
    });
});

test("guestBlocks mid-window disarm refusal is cloneable and stops the internal ticker", async () => {
    await withRecorder(async f => {
        await f.command({ phase: "arm", pages: [0x1000] });
        f.advance(0x100);
        f.disarmExternally();
        const result = await f.command({ phase: "read", keepArmed: false });
        const reply = structuredClone(result);
        expect(reply.counted.available).toBe(false);
        expect(reply.counted.note).toContain("disarmed at read time");
        expect(reply.counted.window.disarmedMidWindow).toBe(true);
        expect(reply.counted.window.armedRequested).toEqual(["0x1000"]);
        expect(reply.counted.window.retired).toBeUndefined();
        expect(f.timers()).toBe(0);
        expect(f.recording()).toBe(false);
    });
});
