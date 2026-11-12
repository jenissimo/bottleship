import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { F_INSTRUMENT_DRUMS, type DlsCollection, type DlsInstrument } from "../../packages/formats/src/dmusic/dls";
import { gmBankAvailable, loadGmBank, resetGmBankForTests } from "../../src/worker/core/audio/gm-bank";
import { MidiRouter } from "../../src/worker/core/audio/midi-router";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { WinmmMidiOut } from "../../src/worker/modules/winmm-midi";
import { MidiSynthOutput } from "../../src/worker/modules/winmm-midi-synth";

function sine(): Uint8Array {
    const pcm = new Int16Array(2000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * i) / 50) * 20000);
    return new Uint8Array(pcm.buffer);
}

function instrument(program: number, bank: number, name: string): DlsInstrument {
    return {
        bank, program, name, articulation: [],
        regions: [{ keyLow: 0, keyHigh: 127, velocityLow: 0, velocityHigh: 127, options: 0, keyGroup: 0, sample: null, waveIndex: 0, articulation: [] }],
    };
}

function gmBank(): DlsCollection {
    return {
        identity: { objectId: "", name: "GM", versionMS: 0, versionLS: 0, hasVersion: false },
        instruments: [instrument(0, 0, "Piano"), instrument(40, 0, "Violin"), instrument(40, 8 << 8, "Violin 2"), instrument(0, F_INSTRUMENT_DRUMS, "Kit")],
        waves: [{ formatTag: 1, channels: 1, sampleRate: 22050, bitsPerSample: 16, data: sine(),
            sample: { unityNote: 60, fineTune: 0, attenuation: 0, options: 0, loop: { type: 0, start: 0, length: 2000 } } }],
    };
}

const msg = (status: number, d1: number, d2 = 0): number => status | (d1 << 8) | (d2 << 16);

function energy(router: MidiRouter, frames: number, since = 0, until = 10): Float32Array {
    const left = new Float32Array(frames), right = new Float32Array(frames);
    router.render(left, right, frames, since, until);
    return left;
}

describe("MIDI routing into the DLS synthesizer", () => {
    test("program change, bank select and the drum channel pick the instrument", () => {
        const router = new MidiRouter(22050, 32);
        const chosen: Array<[number, number]> = [];
        spyOn(router.synth, "setInstrument").mockImplementation((ch, _c, patch) => { chosen.push([ch, patch]); return true; });
        router.setBank(gmBank());
        chosen.length = 0;
        router.shortMessage(msg(0xc1, 40), 0);
        router.shortMessage(msg(0xb2, 0, 8), 0);
        router.shortMessage(msg(0xc2, 40), 0);
        router.shortMessage(msg(0xc9, 25), 0);
        router.flush();
        expect(chosen).toEqual([[1, 40], [2, (8 << 16) | 40], [9, F_INSTRUMENT_DRUMS | 25]]);
    });

    test("notes sound once the bank is there, and not before", () => {
        const router = new MidiRouter(22050, 32);
        router.shortMessage(msg(0x90, 60, 100), 0);
        expect(Math.max(...energy(router, 512).map(Math.abs))).toBe(0);
        router.setBank(gmBank());
        router.shortMessage(msg(0x90, 60, 100), 0);
        expect(Math.max(...energy(router, 512).map(Math.abs))).toBeGreaterThan(0.01);
        expect(router.synth.activeVoiceCount).toBe(1);
        router.shortMessage(msg(0x80, 60), 0);
        router.flush();
        router.shortMessage(msg(0x90, 64, 100), 0);
        router.flush();
        router.systemExclusive(new Uint8Array([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]));
        energy(router, 1000);
        expect(router.synth.activeVoiceCount).toBe(0);
        expect(router.channels[0]!.program).toBe(0);
    });

    test("an event lands at its time inside the rendered block", () => {
        const router = new MidiRouter(22050, 32);
        router.setBank(gmBank());
        router.shortMessage(msg(0x90, 60, 127), 5);
        const out = energy(router, 1000, 0, 10);
        expect(Math.max(...out.subarray(0, 490).map(Math.abs))).toBe(0);
        expect(Math.max(...out.subarray(500).map(Math.abs))).toBeGreaterThan(0.01);
    });

    test("system messages and data bytes are ignored", () => {
        const router = new MidiRouter(22050, 32);
        router.shortMessage(0xf8, 0);
        router.shortMessage(0x40, 0);
        expect(router.pending).toBe(0);
    });
});

describe("midiOut handles", () => {
    const restore: Array<() => void> = [];
    let mem: Uint8Array;
    const calls: number[][] = [];
    let output: { router: MidiRouter; release: () => void; releases: number; shortMessage: (m: number) => void };

    beforeEach(() => {
        mem = new Uint8Array(0x20000);
        Mem.bind(() => mem);
        calls.length = 0;
        const router = new MidiRouter(22050, 8);
        output = { router, releases: 0, release() { this.releases++; }, shortMessage: (m) => router.shortMessage(m, 0) };
        const acquire = spyOn(MidiSynthOutput, "acquire").mockImplementation(() => output as unknown as MidiSynthOutput);
        const system = System.getInstance() as unknown as { process: unknown; fileSystem: unknown };
        const process = system.process, fs = system.fileSystem;
        system.process = {};
        system.fileSystem = { getFileSize: (p: string) => (p.toUpperCase().endsWith("GM.DLS") ? 100 : -1) };
        resetGmBankForTests();
        restore.push(() => { acquire.mockRestore(); system.process = process; system.fileSystem = fs; resetGmBankForTests(); });
    });
    afterEach(() => { while (restore.length) restore.pop()!(); });

    const view = (): DataView => new DataView(mem.buffer);

    test("one device while a bank exists; caps name the software synth", () => {
        const midi = new WinmmMidiOut({ callFunction: () => undefined });
        expect(midi.deviceCount()).toBe(1);
        expect(midi.writeCaps(0x11000, 52, false)).toBe(0);
        expect(new TextDecoder().decode(mem.subarray(0x11008, 0x11008 + 31)).replace(/\0+$/, "")).toBe("Microsoft GS Wavetable SW Synth");
        expect(view().getUint16(0x11008 + 32, true)).toBe(7);
        (System.getInstance() as unknown as { fileSystem: unknown }).fileSystem = { getFileSize: () => -1 };
        expect(midi.deviceCount()).toBe(0);
        expect(midi.open(0x11100, 0, 0, 0, 0)).toBe(2);
        expect(view().getUint32(0x11100, true)).toBe(0);
    });

    test("open, short messages, sysex with MOM_DONE, close with MOM_CLOSE", () => {
        const midi = new WinmmMidiOut({ callFunction: (cb, args) => calls.push([cb, ...args]) });
        expect(midi.open(0x11100, 0xffffffff, 0x401000, 0x77, 0x30000)).toBe(0);
        const h = view().getUint32(0x11100, true);
        expect(h).not.toBe(0);
        expect(calls[0]).toEqual([0x401000, h, 0x3c7, 0x77, 0, 0]);
        expect(midi.shortMessage(h, msg(0x90, 60, 100))).toBe(0);
        expect(output.router.pending).toBe(1);
        const hdr = 0x12000;
        mem.set([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7], 0x13000);
        view().setUint32(hdr, 0x13000, true);
        view().setUint32(hdr + 4, 6, true);
        expect(midi.longMessage(h, hdr, 48)).toBe(64);
        expect(midi.prepare(h, hdr, 48, true)).toBe(0);
        expect(midi.longMessage(h, hdr, 48)).toBe(0);
        expect(view().getUint32(hdr + 16, true) & 3).toBe(3);
        expect(output.router.pending).toBe(0);
        expect(calls[1]).toEqual([0x401000, h, 0x3c9, 0x77, hdr, 0]);
        expect(midi.prepare(h, hdr, 48, false)).toBe(0);
        expect(midi.setVolume(h, 0x80008000)).toBe(0);
        expect(midi.getVolume(h, 0x11200)).toBe(0);
        expect(view().getUint32(0x11200, true)).toBe(0x80008000);
        expect(midi.openCount()).toBe(1);
        expect(midi.close(h)).toBe(0);
        expect(output.releases).toBe(1);
        expect(calls[2]).toEqual([0x401000, h, 0x3c8, 0x77, 0, 0]);
        expect(midi.close(h)).toBe(5);
        expect(midi.shortMessage(h, 0x90)).toBe(5);
    });

    test("gmBankAvailable follows the bundle's gm.dls, and an empty bundle loads no bank", async () => {
        expect(gmBankAvailable()).toBe(true);
        (System.getInstance() as unknown as { fileSystem: unknown }).fileSystem = { getFileSize: () => -1, openSync: () => null };
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
        try {
            expect(await loadGmBank()).toBeNull();
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
