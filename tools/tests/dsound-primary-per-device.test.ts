import { describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

// A primary buffer belongs to the DirectSound device object that created it, with the
// DSBCAPS controls that caller requested. Star Wars Episode I Racer runs two device
// objects side by side: a3dapi.dll's, and Smush.dll's for cutscene audio, which asks for
// a CTRLVOLUME primary and then GetVolume/SetVolume on it. Handing Smush a3dapi's
// primary (created without CTRLVOLUME) failed GetVolume, and Smush dropped audio for
// every video.

const DS_OK = 0;
const DSERR_CONTROLUNAVAIL = 0x8878001e;
const DSERR_INVALIDCALL = 0x88780032;
const DSBCAPS_PRIMARYBUFFER = 0x1;
const DSBCAPS_CTRLVOLUME = 0x80;

const OUT = 0x1000;
const DESC = 0x2000;
const WFX = 0x3000;
const VOL = 0x4000;

function setup() {
    const mem = new Uint8Array(1 << 22);
    Mem.bind(() => mem);
    let next = 0x100000;
    const sizes = new Map<number, number>();
    const alloc = (n: number) => { const p = next; next += n + 16; sizes.set(p, n); return p; };
    const process = {
        getCurrentMemory: () => mem,
        memory: {
            alloc, allocSystemBlock: alloc, allocAt() {}, getSize: (p: number) => sizes.get(p),
            free() {}, freeSystemBlock() {},
        },
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
    const g = globalThis as any;
    const oldPost = g.postMessage;
    const oldSelf = g.self;
    g.postMessage = () => {};
    g.self = g;
    try { ds.initialize(process as any); } finally { g.postMessage = oldPost; }
    const view = new DataView(mem.buffer);
    const call = (name: string, ...args: number[]): number => {
        const post = g.postMessage;
        g.postMessage = () => {};
        try { return ((ds.exports as any)[name]({}, mem, args) as number) >>> 0; }
        finally { g.postMessage = post; }
    };
    const createDevice = (): number => {
        expect(call("directsoundcreate", 0, OUT, 0)).toBe(DS_OK);
        return view.getUint32(OUT, true);
    };
    const createPrimary = (device: number, flags: number): number => {
        view.setUint32(DESC, 20, true);
        view.setUint32(DESC + 4, flags, true);
        view.setUint32(DESC + 8, 0, true);
        view.setUint32(DESC + 12, 0, true);
        view.setUint32(DESC + 16, 0, true);
        expect(call("idirectsound8_createsoundbuffer", device, DESC, OUT + 4, 0)).toBe(DS_OK);
        return view.getUint32(OUT + 4, true);
    };
    const restore = () => { g.self = oldSelf; };
    return { ds, mem, view, call, createDevice, createPrimary, restore };
}

describe("DirectSound primary buffer per device object", () => {
    test("each device object's primary carries the caps its creator requested", () => {
        const t = setup();
        try {
            const a3d = t.createDevice();
            const a3dPrimary = t.createPrimary(a3d, DSBCAPS_PRIMARYBUFFER);
            expect(t.call("idirectsoundbuffer8_getvolume", a3dPrimary, VOL)).toBe(DSERR_CONTROLUNAVAIL);

            // Smush.dll's own device: primary with volume control, then the exact calls it makes.
            const smush = t.createDevice();
            expect(smush).not.toBe(a3d);
            const smushPrimary = t.createPrimary(smush, DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME);
            expect(smushPrimary).not.toBe(a3dPrimary);
            t.mem.set([1, 0, 2, 0, 0x22, 0x56, 0, 0, 0x88, 0x58, 1, 0, 4, 0, 16, 0, 0, 0], WFX);
            expect(t.call("idirectsoundbuffer8_setformat", smushPrimary, WFX)).toBe(DS_OK);
            t.view.setInt32(VOL, -5000, true);
            expect(t.call("idirectsoundbuffer8_getvolume", smushPrimary, VOL)).toBe(DS_OK);
            expect(t.view.getInt32(VOL, true)).toBe(0);
            expect(t.call("idirectsoundbuffer8_setvolume", smushPrimary, 0)).toBe(DS_OK);

            // The first device's primary keeps its own caps.
            expect(t.call("idirectsoundbuffer8_setvolume", a3dPrimary, 0)).toBe(DSERR_CONTROLUNAVAIL);
        } finally {
            t.restore();
        }
    });

    test("a second primary request on the same device returns the same object", () => {
        const t = setup();
        try {
            const device = t.createDevice();
            const first = t.createPrimary(device, DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME);
            const second = t.createPrimary(device, DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME);
            expect(second).toBe(first);
            // Two references: the first Release keeps it alive, the second frees it.
            expect(t.call("IDirectSoundBuffer8_Release", first)).toBe(1);
            expect(t.call("IDirectSoundBuffer8_Release", first)).toBe(0);
            const fresh = t.createPrimary(device, DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME);
            expect(t.call("idirectsoundbuffer8_getvolume", fresh, VOL)).toBe(DS_OK);
        } finally {
            t.restore();
        }
    });

    test("DuplicateSoundBuffer refuses any device's primary", () => {
        const t = setup();
        try {
            const a = t.createDevice();
            const b = t.createDevice();
            t.createPrimary(a, DSBCAPS_PRIMARYBUFFER);
            const bPrimary = t.createPrimary(b, DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRLVOLUME);
            expect(t.call("idirectsound8_duplicatesoundbuffer", a, bPrimary, OUT + 8)).toBe(DSERR_INVALIDCALL);
            expect(t.view.getUint32(OUT + 8, true)).toBe(0);
        } finally {
            t.restore();
        }
    });
});
