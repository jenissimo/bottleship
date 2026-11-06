import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetGmBankForTests } from "../../src/worker/core/audio/gm-bank";
import { MidiRouter } from "../../src/worker/core/audio/midi-router";
import { parseSmfSong } from "../../src/worker/core/audio/smf-events";
import { SmfPlayer } from "../../src/worker/core/audio/smf-player";
import { System } from "../../src/worker/core/system";
import { TimeService } from "../../src/worker/runtime/time";
import { WinmmMci } from "../../src/worker/modules/winmm-mci";
import { MidiSynthOutput } from "../../src/worker/modules/winmm-midi-synth";

function vlq(n: number): number[] {
    const out = [n & 0x7f];
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
    return out;
}

function track(events: Array<[number, number[]]>): number[] {
    const body = events.flatMap(([delta, bytes]) => [...vlq(delta), ...bytes]);
    return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff, ...body];
}

function smf(division: number, tracks: number[][]): Uint8Array {
    return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, division >> 8, division & 0xff, ...tracks.flat()]);
}

const SONG = smf(96, [
    track([[0, [0xff, 0x51, 3, 0x07, 0xa1, 0x20]], [96, [0xff, 0x51, 3, 0x03, 0xd0, 0x90]], [96, [0xff, 0x2f, 0]]]),
    track([[0, [0xc0, 5]], [0, [0x90, 60, 100]], [48, [60, 0]], [48, [0x90, 62, 90]], [96, [0x80, 62, 0]],
        [0, [0xf0, 5, 0x7e, 0x7f, 0x09, 0x01, 0xf7]], [0, [0xff, 0x2f, 0]]]),
]);

describe("Standard MIDI files as timed events", () => {
    test("tracks merge in time order, tempo changes rescale, running status and sysex survive", () => {
        const song = parseSmfSong(SONG)!;
        expect(song.tracks).toBe(2);
        expect(song.events.map((e) => [Math.round(e.ms), e.message & 0xffffff])).toEqual([
            [0, 0x05c0], [0, 0x643c90], [250, 0x003c90], [500, 0x5a3e90], [750, 0x003e80], [750, 0],
        ]);
        expect([...song.events[5]!.sysex!]).toEqual([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
        expect(song.lengthMs).toBe(750);
    });

    test("an RMID wrapper is unwrapped; anything else is not a song", () => {
        const data = [0x64, 0x61, 0x74, 0x61, SONG.length & 0xff, (SONG.length >> 8) & 0xff, 0, 0, ...SONG];
        const size = 4 + data.length;
        const rmid = new Uint8Array([0x52, 0x49, 0x46, 0x46, size & 0xff, (size >> 8) & 0xff, 0, 0, 0x52, 0x4d, 0x49, 0x44, ...data]);
        expect(parseSmfSong(rmid)!.events).toHaveLength(6);
        expect(parseSmfSong(new Uint8Array(32))).toBeNull();
    });
});

describe("the SMF player", () => {
    test("events go out at their song time, seek chases controllers, the end fires once", () => {
        const router = new MidiRouter(22050, 8);
        const sent: Array<[number, number]> = [];
        spyOn(router, "shortMessage").mockImplementation((m, at) => { sent.push([m & 0xffffff, at]); });
        const player = new SmfPlayer(parseSmfSong(SONG)!, router);
        let ended = 0;
        player.play(1000, 0, () => ended++);
        player.tick(1100);
        expect(sent).toEqual([[0x05c0, 1000], [0x643c90, 1000]]);
        expect(player.positionAt(1100)).toBe(100);
        sent.length = 0;
        player.tick(1800);
        expect(sent.slice(0, 3).map(([m, at]) => [m, Math.round(at)])).toEqual([[0x003c90, 1250], [0x5a3e90, 1500], [0x003e80, 1750]]);
        expect(ended).toBe(1);
        expect(player.playing).toBe(false);
        player.tick(1900);
        expect(ended).toBe(1);
        sent.length = 0;
        player.seek(600);
        expect(sent.map(([m]) => m)).toEqual([0x05c0]);
        expect(player.positionAt(0)).toBe(600);
    });
});

describe("MCI sequencer device", () => {
    const restore: Array<() => void> = [];
    const mem = new Uint8Array(0x10000);
    let exports: Record<string, (...a: never[]) => unknown>;
    let ticker: ((now: number) => void) | null;
    let released: number;
    let now = 5000;
    let returned = "";

    const send = (command: string): number => {
        mem.fill(0, 0x100, 0x400);
        for (let i = 0; i < command.length; i++) mem[0x100 + i] = command.charCodeAt(i);
        return (exports["mciSendStringA"] as unknown as (c: unknown, m: Uint8Array, a: number[]) => number)({}, mem, [0x100, 0x800, 128, 0x10077]);
    };

    beforeEach(() => {
        ticker = null;
        released = 0;
        returned = "";
        const router = new MidiRouter(22050, 8);
        const output = {
            router,
            addTicker: (t: (now: number) => void) => { ticker = t; return () => { ticker = null; }; },
            release: () => { released++; },
        };
        const acquire = spyOn(MidiSynthOutput, "acquire").mockImplementation(() => output as unknown as MidiSynthOutput);
        const nowSpy = spyOn(TimeService.getInstance(), "nowMs").mockImplementation(() => now);
        const posted: number[][] = [];
        const system = System.getInstance() as unknown as Record<string, unknown>;
        const saved = { process: system.process, fileSystem: system.fileSystem, windowManager: system.windowManager, scheduler: system.scheduler };
        system.process = {};
        system.fileSystem = {
            getFileSize: (p: string) => (p.toUpperCase().endsWith("GM.DLS") ? 100 : p.toUpperCase().endsWith("SONG.MID") ? SONG.length : -1),
            resolveRomMediaPath: () => null,
            resolvePath: (p: string) => "C:\\" + p,
            openSync: () => ({}),
            readSync: () => SONG,
        };
        system.windowManager = { postMessage: (...a: number[]) => posted.push(a) };
        system.scheduler = { wakeMessageWaiters: () => undefined };
        (globalThis as unknown as { __posted: number[][] }).__posted = posted;
        resetGmBankForTests();
        const mci = new WinmmMci({
            readAnsiString: (ptr: number, max: number) => {
                let s = "";
                for (let i = 0; i < max && mem[ptr + i]; i++) s += String.fromCharCode(mem[ptr + i]!);
                return s;
            },
            writeAnsiString: (_p: number, _c: number, v: string) => { returned = v; return true; },
            readWideString: () => "",
            writeWideString: () => true,
        });
        exports = {};
        mci.registerExports(exports as never);
        restore.push(() => {
            acquire.mockRestore();
            nowSpy.mockRestore();
            Object.assign(system, saved);
            resetGmBankForTests();
        });
    });
    afterEach(() => { while (restore.length) restore.pop()!(); });

    test("open, status, play with notify, end, close", () => {
        const posted = (globalThis as unknown as { __posted: number[][] }).__posted;
        expect(send("open song.mid type sequencer alias music")).toBe(0);
        expect(send("status music length")).toBe(0);
        expect(returned).toBe("750");
        expect(send("status music mode")).toBe(0);
        expect(returned).toBe("stopped");
        expect(send("play music from 0 notify")).toBe(0);
        expect(send("status music mode")).toBe(0);
        expect(returned).toBe("playing");
        now += 300;
        ticker!(now);
        expect(send("status music position")).toBe(0);
        expect(returned).toBe("300");
        now += 600;
        ticker!(now);
        expect(posted).toEqual([[0x10077, 0x3b9, 1, expect.any(Number) as unknown as number]]);
        expect(send("status music mode")).toBe(0);
        expect(returned).toBe("stopped");
        expect(send("close music")).toBe(0);
        expect(released).toBe(1);
        expect(ticker).toBeNull();
        expect(send("status music mode")).toBe(263);
    });

    test("a missing file or a non-MIDI file fails the open and leaves no device", () => {
        expect(send("open nothere.mid alias x")).toBe(275);
        expect(send("status x mode")).toBe(263);
    });
});
