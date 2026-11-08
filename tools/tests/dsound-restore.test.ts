import { expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const OBJECT = 0x2000;
const DS_OK = 0;

function setup(bufferLost: boolean) {
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
    const buffer = { id: 1, ptr: 0x4000, bytes: 4096, isPlaying: false, isLooping: false, bufferLost };
    (ds as any).objects.set(OBJECT, { type: "IDirectSoundBuffer8", buffer });
    const restore = () => (ds.exports["idirectsoundbuffer8_restore"] as any)({}, mem, [OBJECT]) >>> 0;
    return { buffer, restore };
}

test("Restore on a buffer that is not lost succeeds", () => {
    expect(setup(false).restore()).toBe(DS_OK);
});

test("Restore on a lost buffer succeeds and clears the lost state", () => {
    const s = setup(true);
    expect(s.restore()).toBe(DS_OK);
    expect(s.buffer.bufferLost).toBe(false);
});
