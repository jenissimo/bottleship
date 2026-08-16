import { describe, expect, test } from "bun:test";
import { mss32Module } from "../../src/worker/api/mss32.api";
import { createCoreExports } from "../../src/worker/modules/mss32/core";
import { createStreamExports } from "../../src/worker/modules/mss32/stream";
import type { MSSContext } from "../../src/worker/modules/mss32/context";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

function minimalContext(memory: Uint8Array): MSSContext {
    let nextHandle = 0x700;
    return {
        process: { memory: { alloc: () => nextHandle, free: () => {} } },
        memory,
        streams: new Map(),
        ribProviders: new Map(),
    } as unknown as MSSContext;
}

describe("MSS32 Miles ABI fixes", () => {
    test("advertises the five-argument stream-info and one-argument RIB allocator ABIs", () => {
        const arity = (name: string) => mss32Module.functions.find((fn) => fn.name === name)?.params.length;
        expect(arity("_AIL_stream_info@20")).toBe(5);
        // The undecorated import must not resolve to the 2-arg legacy entry point: the
        // stub lookup falls back to a key with `_` and `@N` stripped, so all three share it.
        expect(arity("AIL_stream_info")).toBe(5);
        expect(arity("RIB_alloc_provider_handle")).toBe(1);
        expect(arity("_RIB_alloc_provider_handle@4")).toBe(1);
    });

    test("_AIL_stream_info@20 writes all optional MSS out-parameters", () => {
        const memory = new Uint8Array(0x1000);
        Mem.bind(() => memory);
        const ctx = minimalContext(memory);
        ctx.streams.set(0x400, {
            id: 1, handle: 0x400, fileData: new Uint8Array(999), decodedData: null,
            filename: null, sampleRate: 22050, channels: 2, bitsPerSample: 16,
            formatTag: 1, blockAlign: 4, streamMemory: 8192, volume: 127, pan: 64,
            playbackRate: 1, loopCount: 1, isPlaying: false, isPaused: false,
            position: 0, pendingStart: false, pcmBytes: 88200,
        });
        const exports = createStreamExports(ctx);
        const streamInfo = exports["_AIL_stream_info@20"]!;
        expect(exports["AIL_stream_info"]).toBe(streamInfo);

        expect(streamInfo({} as never, memory, [0x400, 0x100, 0x104, 0x108, 0x10c])).toBe(0);
        const view = new DataView(memory.buffer);
        expect(view.getInt32(0x100, true)).toBe(88200);
        expect(view.getInt32(0x104, true)).toBe(3); // DIG_F_STEREO_16
        expect(view.getInt32(0x108, true)).toBe(88200);
        expect(view.getInt32(0x10c, true)).toBe(8192);
    });

    test("RIB provider handles retain registered interface tokens", () => {
        const memory = new Uint8Array(0x1000);
        Mem.bind(() => memory);
        const ctx = minimalContext(memory);
        const exports = createCoreExports(ctx);
        const view = new DataView(memory.buffer);
        memory.set(new TextEncoder().encode("ASI codec\0"), 0x100);
        // One RIB_INTERFACE_ENTRY: type, name, token, subtype.
        view.setUint32(0x200, 0, true);
        view.setUint32(0x204, 0, true);
        view.setUint32(0x208, 0x12345678, true);
        view.setUint32(0x20c, 0, true);

        const provider = exports["RIB_alloc_provider_handle"]!({} as never, memory, [0xdeadbeef]) as number;
        expect(provider).toBe(0x700);
        expect(exports["RIB_register_interface"]!({} as never, memory, [provider, 0x100, 1, 0x200])).toBe(0);
        expect(ctx.ribProviders.get(provider)?.module).toBe(0xdeadbeef);
        expect(ctx.ribProviders.get(provider)?.interfaces.get("ASI codec")?.entries).toEqual([0x12345678]);
    });
});
