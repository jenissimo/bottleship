import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DSound } from "../../src/worker/modules/dsound/dsound";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createSinkBuffer, soundReference } from "../../src/worker/modules/dmusic-sink";

// Need for Speed: Underground restarts its sound system on every mode change (boot ->
// menu -> race -> results): its mixer thread exits, it Releases its IDirectSound object
// and calls DirectSoundCreate again, then creates and plays a new looping mix buffer. It
// never Stops or Releases the old mix buffer or the primary (Speed.exe 0x653d50 releases
// only the device; 0x654340 then clears its buffer pointers and re-creates them). On
// Windows the device's last Release destroys every buffer the device created, so the old
// mix buffer goes silent with it. Ours kept those buffers alive and looping, and the last
// half second the game mixed before the restart droned until exit.
//
// This drives the real DSound exports and the real worklet processor through that exact
// sequence. The control case is a looping buffer whose device is still alive and that the
// app merely stopped feeding: it keeps replaying its contents, as DirectSound does.

let Processor: any;
const saved = new Map<string, PropertyDescriptor | undefined>();
function installGlobal(key: string, value: unknown): void {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

beforeAll(async () => {
    installGlobal("AudioWorkletProcessor", class { port = { postMessage(_m: unknown) {}, onmessage: null as any }; });
    installGlobal("registerProcessor", (name: string, ctor: unknown) => { if (name === "bottleship-audio") Processor = ctor; });
    installGlobal("sampleRate", 48000);
    installGlobal("currentTime", 0);
    // A private module instance: the worklet registers its processor once per evaluation,
    // and the other worklet tests in this bun process import the plain specifier.
    await import("../../src/audio/bottleship-audio-worklet.ts?dsound-device-release");
    if (!Processor) throw new Error("worklet processor was not registered");
});

afterAll(() => {
    for (const [key, d] of saved) {
        if (d) Object.defineProperty(globalThis, key, d);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const DS_OK = 0;
const DSBCAPS_PRIMARYBUFFER = 0x1;
const DSBCAPS_GETCURRENTPOSITION2 = 0x10000;
const DSBCAPS_GLOBALFOCUS = 0x8000;
const DSBPLAY_LOOPING = 0x1;
const OUT = 0x1000, DESC = 0x2000, WFX = 0x3000, LOCK = 0x4000;
const MIX_BYTES = 88192; // 44100 Hz stereo 16-bit, rate * 500 ms & ~15 frames * 4 (Speed.exe 0x6538b0)
const QUANTUM = 128;

function rig() {
    const mem = new Uint8Array(1 << 22);
    Mem.bind(() => mem);
    let next = 0x100000;
    const sizes = new Map<number, number>();
    const alloc = (n: number) => { const p = next; next += (n + 31) & ~15; sizes.set(p, n); return p; };
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
    const proc = new Processor();
    const g = globalThis as any;
    // DSound talks to the audio engine with worker postMessage; route ring registration
    // straight into the processor, as audio-engine.ts does.
    const route = (msg: any) => {
        if (msg?.type === "audio_register") proc.port.onmessage({ data: { type: "register", id: msg.payload.id, sab: msg.payload.sab } });
        else if (msg?.type === "audio_unregister") proc.port.onmessage({ data: { type: "unregister", id: msg.payload.id } });
    };
    installGlobal("self", g);
    installGlobal("postMessage", route);
    const ds = new DSound();
    (ds as any).startNotificationPump = () => {};
    ds.initialize(process as any);
    const view = new DataView(mem.buffer);
    const call = (name: string, ...args: number[]): number => ((ds.exports as any)[name]({}, mem, args) as number) >>> 0;

    const createDevice = (): number => {
        expect(call("directsoundcreate", 0, OUT, 0)).toBe(DS_OK);
        return view.getUint32(OUT, true);
    };
    const createPrimary = (device: number): number => {
        view.setUint32(DESC, 20, true);
        view.setUint32(DESC + 4, DSBCAPS_PRIMARYBUFFER, true);
        view.setUint32(DESC + 8, 0, true);
        view.setUint32(DESC + 12, 0, true);
        view.setUint32(DESC + 16, 0, true);
        expect(call("idirectsound8_createsoundbuffer", device, DESC, OUT + 4, 0)).toBe(DS_OK);
        return view.getUint32(OUT + 4, true);
    };
    // The mix buffer exactly as Speed.exe 0x6538b0 describes it.
    const createMixBuffer = (device: number): number => {
        view.setUint16(WFX, 1, true); view.setUint16(WFX + 2, 2, true);
        view.setUint32(WFX + 4, 44100, true); view.setUint32(WFX + 8, 176400, true);
        view.setUint16(WFX + 12, 4, true); view.setUint16(WFX + 14, 16, true); view.setUint16(WFX + 16, 0, true);
        view.setUint32(DESC, 36, true);
        view.setUint32(DESC + 4, DSBCAPS_GETCURRENTPOSITION2 | DSBCAPS_GLOBALFOCUS, true);
        view.setUint32(DESC + 8, MIX_BYTES, true);
        view.setUint32(DESC + 12, 0, true);
        view.setUint32(DESC + 16, WFX, true);
        for (let i = 20; i < 36; i++) mem[DESC + i] = 0;
        expect(call("idirectsound8_createsoundbuffer", device, DESC, OUT + 8, 0)).toBe(DS_OK);
        return view.getUint32(OUT + 8, true);
    };
    // Lock [at, at+n), fill with a constant sample, Unlock. Returns the new write position.
    const write = (buf: number, at: number, n: number, sample: number): number => {
        expect(call("idirectsoundbuffer8_lock", buf, at, n, LOCK, LOCK + 4, LOCK + 8, LOCK + 12, 0)).toBe(DS_OK);
        const p1 = view.getUint32(LOCK, true), n1 = view.getUint32(LOCK + 4, true);
        const p2 = view.getUint32(LOCK + 8, true), n2 = view.getUint32(LOCK + 12, true);
        for (let o = 0; o < n1; o += 2) view.setInt16(p1 + o, sample, true);
        for (let o = 0; o < n2; o += 2) view.setInt16(p2 + o, sample, true);
        expect(call("idirectsoundbuffer8_unlock", buf, p1, n1, p2, n2)).toBe(DS_OK);
        return (at + n) % MIX_BYTES;
    };
    // Render `ms` of output and return the loudest sample.
    const render = (ms: number): number => {
        let peak = 0;
        const blocks = Math.ceil((48000 * ms) / 1000 / QUANTUM);
        for (let b = 0; b < blocks; b++) {
            const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
            proc.process([], [out], {});
            for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
            installGlobal("currentTime", (globalThis as any).currentTime + QUANTUM / 48000);
        }
        return peak;
    };
    // NFSU's mixer thread: every 10 ms ask the cursor, mix 10 ms (1764 bytes) at its own
    // write position, then let 10 ms of audio play.
    const pump = (buf: number, ms: number, sample: number, at = 0): number => {
        for (let t = 0; t < ms; t += 10) {
            expect(call("idirectsoundbuffer8_getcurrentposition", buf, OUT + 16, OUT + 20)).toBe(DS_OK);
            at = write(buf, at, 1764, sample);
            render(10);
        }
        return at;
    };
    // Speed.exe 0x654340: device, primary, mix buffer zero-filled, Play(LOOPING).
    const startSoundSystem = () => {
        const device = createDevice();
        const primary = createPrimary(device);
        const mix = createMixBuffer(device);
        write(mix, 0, MIX_BYTES, 0);
        expect(call("idirectsoundbuffer8_play", mix, 0, 0, DSBPLAY_LOOPING)).toBe(DS_OK);
        return { device, primary, mix };
    };
    return { ds, call, render, pump, startSoundSystem, process };
}

describe("DirectSound buffers die with the device object that created them", () => {
    test("NFSU restart: the device's last Release silences the abandoned looping mix buffer", () => {
        const t = rig();
        const race = t.startSoundSystem();
        t.pump(race.mix, 1000, 12000);
        expect(t.render(20)).toBeGreaterThan(0.3); // race music is playing

        // Race over: the mixer thread exits and the sound system restarts. The old mix
        // buffer and primary are never Stopped or Released.
        expect(t.call("IDirectSound8_Release", race.device)).toBe(0);
        const results = t.startSoundSystem();
        t.pump(results.mix, 1000, 0); // the results screen mixes silence

        expect(t.render(1000)).toBe(0);
        // The old interfaces are dead, not dangling: a late call fails and a late
        // Release is harmless.
        expect(t.call("idirectsoundbuffer8_play", race.mix, 0, 0, DSBPLAY_LOOPING)).not.toBe(DS_OK);
        expect(t.call("IDirectSoundBuffer8_Release", race.mix)).toBe(0);
        expect(t.call("IDirectSoundBuffer8_Release", race.primary)).toBe(0);
        // The new device has a primary of its own, not the dead device's.
        expect(results.primary).not.toBe(race.primary);
    });

    test("control: an unfed looping buffer on a live device keeps replaying its contents", () => {
        const t = rig();
        const race = t.startSoundSystem();
        t.pump(race.mix, 1000, 12000);
        // The app stops feeding but keeps its device: DirectSound loops what it holds.
        expect(t.render(2000)).toBeGreaterThan(0.3);
        expect(t.call("IDirectSound8_Release", race.device)).toBe(0);
        expect(t.render(200)).toBe(0);
    });

    test("buffer ownership survives a savestate round trip", () => {
        const t = rig();
        const race = t.startSoundSystem();
        t.pump(race.mix, 600, 12000);
        const state = t.ds.captureSavestate();
        expect(state.objects.find(o => o.ptr === race.mix)!.device).toBe(race.device);
        t.ds.restoreSavestate(structuredClone(state));
        expect(t.render(100)).toBeGreaterThan(0.3);
        expect(t.call("IDirectSound8_Release", race.device)).toBe(0);
        expect(t.render(200)).toBe(0);
    });

    // Empires: Dawn of the Modern World calls IDirectMusicPerformance8::InitAudio without a
    // DirectSound object, so DirectMusic makes a private device for its sink buffer. That
    // device used to be released right after the buffer was created; once a device's last
    // Release destroyed its buffers, the sink's GetCaps failed, InitAudio returned E_FAIL
    // and the game called abort().
    test("a DirectMusic sink buffer on a private device lives until its own last release", () => {
        const t = rig();
        const proc = { ...t.process, getModule: (name: string) => (name === "dsound" ? t.ds : undefined) } as any;
        const buf = createSinkBuffer(proc, 0, 2, 22050);
        expect(buf).not.toBe(0);
        expect(t.call("idirectsoundbuffer8_getcaps", buf, OUT + 32)).toBe(DS_OK);
        expect(t.call("idirectsoundbuffer8_play", buf, 0, 0, DSBPLAY_LOOPING)).toBe(DS_OK);
        // The buffer's last release takes the private device with it.
        const devices = () => (t.ds as any).objects.size as number;
        const before = devices();
        soundReference(proc, buf, true, false);
        expect(devices()).toBeLessThan(before - 1);
    });

    test("a device that still has references keeps its buffers", () => {
        const t = rig();
        const s = t.startSoundSystem();
        t.pump(s.mix, 600, 12000);
        expect(t.call("IDirectSound8_AddRef", s.device)).toBe(2);
        expect(t.call("IDirectSound8_Release", s.device)).toBe(1);
        expect(t.render(200)).toBeGreaterThan(0.3);
    });
});
