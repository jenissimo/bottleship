import { describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { CTRL_BLOCK_BYTES, createAudioRingBuffer } from "../../src/audio/audio-ring-buffer";

// Exercise the exported Lock/Unlock pair and its real copies into the worklet's
// SharedArrayBuffer. No audio device or emulated CPU is needed for this contract.
const SIZE = 32768;
const PTR = 0x4000;
const OBJECT = 0x2000;
const OUT = 0x1000;

function setup(laps: number) {
    const mem = new Uint8Array(1 << 20);
    Mem.bind(() => mem);
    let next = 0x20000;
    const alloc = (n: number) => { const p = next; next += n + 16; return p; };
    const process = {
        getCurrentMemory: () => mem,
        memory: { alloc, allocAt() {}, getSize: (p: number) => p === PTR ? SIZE : undefined },
        dispatcher: { registerModule() {}, applyPendingRegistrations() {} },
        thunkGenerator: {
            generateStubDll(_module: string, methods: { name: string }[]) {
                const baseAddress = alloc(methods.length);
                return {
                    baseAddress,
                    stubCode: new Uint8Array(methods.length).fill(0xB8),
                    exportTable: new Map(methods.map((m, i) => [m.name.toLowerCase(), baseAddress + i])),
                };
            },
            allocateVTableMemory: alloc,
        },
    };
    const ds = new DSound();
    // Notification scheduling is unrelated to PCM copies and needs a live CPU.
    (ds as any).startNotificationPump = () => {};
    const oldPost = globalThis.postMessage;
    globalThis.postMessage = () => {};
    try { ds.initialize(process as any); } finally { globalThis.postMessage = oldPost; }
    const sab = createAudioRingBuffer(SIZE * laps, {
        channels: 2, sampleRate: 22050, bitsPerSample: 16, blockAlign: 4,
    });
    const pcm = new Uint8Array(sab, CTRL_BLOCK_BYTES);
    pcm.fill(0x11);
    const buffer = {
        id: 1, ptr: PTR, bytes: SIZE, ringBytes: SIZE * laps, sab,
        format: { channels: 2, sampleRate: 22050, bitsPerSample: 16, blockAlign: 4 },
        isPlaying: false, isLooping: true, currentPosition: 0,
        lastUnlockCursor: undefined as number | undefined,
    };
    (ds as any).objects.set(OBJECT, { type: "IDirectSoundBuffer8", buffer });
    const call = (name: string, ...args: number[]) => (ds.exports[name] as any)({}, mem, args);
    const lock = (offset: number, count: number) => {
        expect(call("idirectsoundbuffer8_lock", OBJECT, offset, count, OUT, OUT + 4, OUT + 8, OUT + 12, 0)).toBe(0);
        const v = new DataView(mem.buffer);
        return [0, 4, 8, 12].map(o => v.getUint32(OUT + o, true));
    };
    const unlock = (span: number[]) => {
        expect(call("idirectsoundbuffer8_unlock", OBJECT, ...span)).toBe(0);
    };
    return { mem, pcm, buffer, ds, lock, unlock };
}

for (const laps of [1, 2]) describe(`DirectSound Unlock with ${laps} host lap(s)`, () => {
    test("copies both regions when a streaming write wraps", () => {
        const t = setup(laps);
        // Observed native-game write: a 2320-byte chunk straddles the 32 KiB end.
        const span = t.lock(32356, 2320);
        expect(span).toEqual([PTR + 32356, 412, PTR, 1908]);
        t.mem.fill(0xA1, span[0], span[0] + span[1]);
        t.mem.fill(0xB2, span[2], span[2] + span[3]);
        t.unlock(span);
        for (let lap = 0; lap < laps; lap++) {
            const pcm = t.pcm.subarray(lap * SIZE, (lap + 1) * SIZE);
            expect(new Set(pcm.subarray(32356))).toEqual(new Set([0xA1]));
            expect(new Set(pcm.subarray(0, 1908))).toEqual(new Set([0xB2]));
            expect(new Set(pcm.subarray(1908, 32356))).toEqual(new Set([0x11]));
        }
        expect(t.ds.dbgAudioCalls.bytesUnlocked).toBe(2320);
        expect(t.buffer.lastUnlockCursor).toBe(1908);
    });

    test("a contiguous write leaves surrounding PCM untouched", () => {
        const t = setup(laps);
        const span = t.lock(1000, 2000);
        t.mem.fill(0xA3, PTR + 1000, PTR + 3000);
        t.unlock(span);
        for (let lap = 0; lap < laps; lap++) {
            const pcm = t.pcm.subarray(lap * SIZE, (lap + 1) * SIZE);
            expect(new Set(pcm.subarray(1000, 3000))).toEqual(new Set([0xA3]));
            expect(new Set(pcm.subarray(0, 1000))).toEqual(new Set([0x11]));
            expect(new Set(pcm.subarray(3000))).toEqual(new Set([0x11]));
        }
    });

    test("interleaved locks do not erase an earlier lock's wrap region", () => {
        const t = setup(laps);
        const wrapped = t.lock(SIZE - 512, 2048);
        t.lock(8192, 1024);
        t.mem.fill(0xC4, PTR + SIZE - 512, PTR + SIZE);
        t.mem.fill(0xD5, PTR, PTR + 1536);
        t.unlock(wrapped);
        for (let lap = 0; lap < laps; lap++) {
            expect(new Set(t.pcm.subarray(lap * SIZE, lap * SIZE + 1536))).toEqual(new Set([0xD5]));
        }
        expect(t.ds.dbgAudioCalls.bytesUnlocked).toBe(2048);
    });

    test("a full rotated lock publishes exactly one complete buffer", () => {
        const t = setup(laps);
        const span = t.lock(4096, SIZE);
        t.mem.fill(0xE6, PTR, PTR + SIZE);
        t.unlock(span);
        expect(new Set(t.pcm)).toEqual(new Set([0xE6]));
        expect(t.ds.dbgAudioCalls.bytesUnlocked).toBe(SIZE);
    });

    test("Unlock commits only the bytes reported written in each region", () => {
        const t = setup(laps);
        const span = t.lock(SIZE - 512, 2048);
        t.mem.fill(0xA7, PTR + SIZE - 512, PTR + SIZE);
        t.mem.fill(0xB8, PTR, PTR + 1536);
        t.unlock([span[0], 128, span[2], 256]);
        for (let lap = 0; lap < laps; lap++) {
            const pcm = t.pcm.subarray(lap * SIZE, (lap + 1) * SIZE);
            expect(new Set(pcm.subarray(SIZE - 512, SIZE - 384))).toEqual(new Set([0xA7]));
            expect(new Set(pcm.subarray(SIZE - 384))).toEqual(new Set([0x11]));
            expect(new Set(pcm.subarray(0, 256))).toEqual(new Set([0xB8]));
            expect(new Set(pcm.subarray(256, SIZE - 512))).toEqual(new Set([0x11]));
        }
        expect(t.ds.dbgAudioCalls.bytesUnlocked).toBe(384);
    });
});
