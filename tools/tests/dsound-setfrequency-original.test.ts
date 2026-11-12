// SetFrequency(DSBFREQUENCY_ORIGINAL) — frequency 0 — puts a buffer back on the rate of
// its own wave format. It is what a sound runtime passes for "no pitch change" before
// every Play (Multimedia Fusion's mmfs2.dll does). Clamped up to 1 Hz instead, each
// sample is created, written and played, every cursor moves a few bytes per second,
// and nothing is ever heard.

import { expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const OBJECT = 0x2000, OUT = 0x3000;
const DS_OK = 0, DSERR_CONTROLUNAVAIL = 0x8878001e;
const DSBCAPS_CTRLFREQUENCY = 0x20;

function rig(flags = DSBCAPS_CTRLFREQUENCY, sampleRate = 22050) {
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
    (ds as any).signalRemix = () => {};
    const oldPost = globalThis.postMessage;
    globalThis.postMessage = () => {};
    try { ds.initialize(process as any); } finally { globalThis.postMessage = oldPost; }
    const buffer: any = {
        id: 1, ptr: 0x4000, bytes: 4096, flags, isPlaying: false, isLooping: false, bufferLost: false,
        format: { channels: 1, sampleRate, bitsPerSample: 16, blockAlign: 2 },
        frequency: sampleRate, playbackRate: 1,
    };
    (ds as any).objects.set(OBJECT, { type: "IDirectSoundBuffer8", buffer });
    const set = (hz: number) => (ds.exports["idirectsoundbuffer8_setfrequency"] as any)({}, mem, [OBJECT, hz]) >>> 0;
    const get = () => {
        expect((ds.exports["idirectsoundbuffer8_getfrequency"] as any)({}, mem, [OBJECT, OUT]) >>> 0).toBe(DS_OK);
        return new DataView(mem.buffer).getUint32(OUT, true);
    };
    return { buffer, set, get };
}

test("DSBFREQUENCY_ORIGINAL plays the buffer at its own format's rate", () => {
    const r = rig();
    expect(r.set(0)).toBe(DS_OK);
    expect(r.get()).toBe(22050);
    expect(r.buffer.playbackRate).toBe(1);
});

test("DSBFREQUENCY_ORIGINAL undoes an earlier pitch change", () => {
    const r = rig();
    expect(r.set(44100)).toBe(DS_OK);
    expect(r.buffer.playbackRate).toBe(2);
    expect(r.set(0)).toBe(DS_OK);
    expect(r.get()).toBe(22050);
    expect(r.buffer.playbackRate).toBe(1);
});

test("a rate outside DSBFREQUENCY_MIN..MAX is refused and changes nothing", () => {
    const r = rig();
    expect(r.set(11025)).toBe(DS_OK);
    for (const hz of [1, 99, 200001, 0xffffffff]) expect(r.set(hz)).not.toBe(DS_OK);
    expect(r.get()).toBe(11025);
    expect(r.set(100)).toBe(DS_OK);
    expect(r.set(200000)).toBe(DS_OK);
});

test("a buffer without DSBCAPS_CTRLFREQUENCY has no frequency control", () => {
    expect(rig(0).set(0)).toBe(DSERR_CONTROLUNAVAIL);
});
