import { describe, expect, test } from "bun:test";
import { mss32Module } from "../../src/worker/api/mss32.api";
import { createCoreExports } from "../../src/worker/modules/mss32/core";
import { createSampleExports } from "../../src/worker/modules/mss32/sample";
import { levelsToVolumePan, volumePanToLevels } from "../../src/worker/modules/mss32/volume-levels";
import type { MSSContext } from "../../src/worker/modules/mss32/context";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { setStreamStatus } from "../../src/worker/modules/mss32/helpers";
import { SMP_DONE, SMP_PLAYING } from "../../src/worker/modules/mss32/context";

const DRIVER = 0x800;
const SAMPLE = 0x900;

function context(memory: Uint8Array): MSSContext {
    let nextHandle = 0x700;
    return {
        process: {
            memory: { alloc: () => nextHandle, free: () => {} },
            getCurrentMemory: () => memory,
        },
        memory,
        samples: new Map(),
        streams: new Map(),
        streamCallbacks: new Map(),
        pendingStreamCallbacks: [],
        ribProviders: new Map(),
        digitalDriverHandle: DRIVER,
        preferences: new Array(32).fill(0),
    } as unknown as MSSContext;
}

/** The bits a stdcall caller pushes for an F32 argument. */
const f32Bits = (value: number): number => {
    const buffer = new ArrayBuffer(4);
    new Float32Array(buffer)[0] = value;
    return new Uint32Array(buffer)[0];
};

describe("MSS32 volume ABI", () => {
    test("the S32 and F32 master-volume spellings address one driver field", () => {
        const memory = new Uint8Array(0x2000);
        Mem.bind(() => memory);
        const ctx = context(memory);
        const exports = createCoreExports(ctx);
        const view = new DataView(memory.buffer);

        // MSS 5 writes 0-127; the value has to land in the guest driver struct at
        // +0x10, which is where computeSampleVolumes mixes it from.
        exports["_AIL_set_digital_master_volume@8"]!({} as never, memory, [DRIVER, 64]);
        expect(view.getUint32(DRIVER + 0x10, true)).toBe(64);
        expect(exports["_AIL_digital_master_volume@4"]!({} as never, memory, [DRIVER])).toBe(64);

        // MSS 6 writes the same field as an F32 0.0-1.0, so the S32 getter must see it.
        exports["_AIL_set_digital_master_volume_level@8"]!({} as never, memory, [DRIVER, f32Bits(0.25)]);
        expect(view.getUint32(DRIVER + 0x10, true)).toBe(32);
        expect(exports["_AIL_digital_master_volume@4"]!({} as never, memory, [DRIVER])).toBe(32);

        // Out-of-range levels clamp rather than wrapping through the S32 field.
        exports["_AIL_set_digital_master_volume_level@8"]!({} as never, memory, [DRIVER, f32Bits(4)]);
        expect(view.getUint32(DRIVER + 0x10, true)).toBe(127);
    });

    test("an F32 level pair round-trips through the S32 volume and pan fields", () => {
        // The pair is stored as the 0-127 volume and pan the S32 API owns, so the trip
        // back is exact only to one step of those fields — a centred pair lands on 63
        // or 64, never the 63.5 it would want. Anything wider than a step means the
        // conversion disagrees with the mix in computeSampleVolumes, not that it rounded.
        const step = 2 / 127;
        for (const [left, right] of [[1, 1], [0.5, 0.5], [1, 0], [0, 1], [0.75, 0.25]] as const) {
            const { volume, pan } = levelsToVolumePan(left, right);
            const back = volumePanToLevels(volume, pan);
            expect(Math.abs(back.left - left)).toBeLessThanOrEqual(step);
            expect(Math.abs(back.right - right)).toBeLessThanOrEqual(step);
        }
    });

    test("_AIL_set_sample_volume_levels drives the same fields as the S32 pair", () => {
        const memory = new Uint8Array(0x2000);
        Mem.bind(() => memory);
        const ctx = context(memory);
        ctx.samples.set(SAMPLE, { id: 1, handle: SAMPLE, volume: 127, pan: 64 } as never);
        const exports = createSampleExports(ctx);

        // Hard right: half the summed level, pan fully over.
        exports["_AIL_set_sample_volume_levels@12"]!({} as never, memory, [SAMPLE, f32Bits(0), f32Bits(1)]);
        expect(ctx.samples.get(SAMPLE)!.pan).toBe(127);
        expect(exports["_AIL_sample_pan@4"]!({} as never, memory, [SAMPLE])).toBe(127);

        // And the F32 getter reads back what the S32 fields now hold.
        exports["_AIL_sample_volume_levels@12"]!({} as never, memory, [SAMPLE, 0x100, 0x104]);
        const view = new DataView(memory.buffer);
        expect(view.getFloat32(0x100, true)).toBeCloseTo(0, 2);
        expect(view.getFloat32(0x104, true)).toBeCloseTo(1, 2);
    });

    test("a whole-file stream notifies its registered callback when it ends", () => {
        const memory = new Uint8Array(0x2000);
        Mem.bind(() => memory);
        const ctx = context(memory);
        const stream = { id: 1, handle: 0xa00, volume: 127, pan: 64, source: null } as never;
        ctx.streams.set(0xa00, stream);
        ctx.streamCallbacks.set(0xa00, 0xdead);

        setStreamStatus(ctx, stream, SMP_PLAYING);
        expect(ctx.pendingStreamCallbacks).toHaveLength(0);

        setStreamStatus(ctx, stream, SMP_DONE);
        expect(ctx.pendingStreamCallbacks).toEqual([{ callback: 0xdead, handle: 0xa00 }]);

        // The heartbeat rewrites the status every tick; only the edge is a notification.
        setStreamStatus(ctx, stream, SMP_DONE);
        expect(ctx.pendingStreamCallbacks).toHaveLength(1);
    });

    test("_AIL_sample_user_data@8 reads the slot the setter wrote", () => {
        const memory = new Uint8Array(0x2000);
        Mem.bind(() => memory);
        const ctx = context(memory);
        ctx.samples.set(SAMPLE, { id: 1, handle: SAMPLE, volume: 127, pan: 64 } as never);
        const exports = createSampleExports(ctx);

        expect(mss32Module.functions.find((fn) => fn.name === "_AIL_sample_user_data@8")?.params.length).toBe(2);
        exports["_AIL_set_sample_user_data@12"]!({} as never, memory, [SAMPLE, 3, 0xcafe]);
        expect(exports["_AIL_sample_user_data@8"]!({} as never, memory, [SAMPLE, 3])).toBe(0xcafe);
        // A slot the app never set reads zero, not the neighbouring one.
        expect(exports["_AIL_sample_user_data@8"]!({} as never, memory, [SAMPLE, 2])).toBe(0);
    });
});
