import { expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const OBJECT = 0x2000, STATUS = 0x3000;
const DSBSTATUS_PLAYING = 0x1, DSBSTATUS_LOOPING = 0x4, DSBSTATUS_LOCSOFTWARE = 0x10;
const DSBCAPS_LOCDEFER = 0x40000;

function status(flags: number, isPlaying: boolean, isLooping = false): number {
    const mem = new Uint8Array(1 << 20);
    Mem.bind(() => mem);
    let next = 0x20000;
    const alloc = (n: number) => { const p = next; next += n + 16; return p; };
    const process = {
        getCurrentMemory: () => mem,
        memory: { alloc, allocAt() {}, getSize: () => undefined },
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
    (ds as any).startNotificationPump = () => {};
    const oldPost = globalThis.postMessage;
    globalThis.postMessage = () => {};
    try { ds.initialize(process as any); } finally { globalThis.postMessage = oldPost; }
    (ds as any).objects.set(OBJECT, { type: "IDirectSoundBuffer8", buffer: { id: 1, ptr: 0x4000, bytes: 4096, flags, isPlaying, isLooping, bufferLost: false } });
    expect((ds.exports["idirectsoundbuffer8_getstatus"] as any)({}, mem, [OBJECT, STATUS]) >>> 0).toBe(0);
    return new DataView(mem.buffer).getUint32(STATUS, true);
}

test("a stopped buffer reports 0, so a stop loop waiting for GetStatus == 0 ends", () => {
    expect(status(0, false)).toBe(0);
});

test("a playing buffer reports PLAYING (and LOOPING) without a location flag", () => {
    expect(status(0, true)).toBe(DSBSTATUS_PLAYING);
    expect(status(0, true, true)).toBe(DSBSTATUS_PLAYING | DSBSTATUS_LOOPING);
});

test("LOCSOFTWARE is reported only for a buffer created with DSBCAPS_LOCDEFER", () => {
    expect(status(DSBCAPS_LOCDEFER, true)).toBe(DSBSTATUS_PLAYING | DSBSTATUS_LOCSOFTWARE);
    expect(status(DSBCAPS_LOCDEFER, false)).toBe(DSBSTATUS_LOCSOFTWARE);
});
