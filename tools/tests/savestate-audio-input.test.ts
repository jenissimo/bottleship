import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { WinMM, WINMM_FIELDS, WINMM_TIMER_FIELDS, type WinMMState } from "../../src/worker/modules/winmm";
import { resetWinmmJoystick } from "../../src/worker/modules/winmm-joystick";
import { DSound, DSOUND_FIELDS, type DSoundState } from "../../src/worker/modules/dsound/dsound";
import { CTRL_PLAY_CURSOR, CTRL_STATE, STATE_PLAYING, STATE_STOPPED, createAudioRingBuffer, getCtrl, setCtrl } from "../../src/audio/audio-ring-buffer";
import { System } from "../../src/worker/core/system";
import {
    DInput, DINPUT_DEVICE_FIELDS, DINPUT_FIELDS, DirectInputDeviceObject, SAVED_INPUT_DEVICE_KEYS, type SavedInputDevice,
} from "../../src/worker/modules/dinput/dinput";
import { BaseComObject } from "../../src/worker/core/com/base-com-object";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Internals = Record<string, unknown>;

let comBefore = new Set<number>();
beforeEach(() => {
    comBefore = new Set(System.getInstance().resourceProvider.getAllComObjects().map(o => o.handle));
});
afterEach(() => {
    for (const o of System.getInstance().resourceProvider.getAllComObjects()) if (!comBefore.has(o.handle)) o.forceRelease();
});

describe("winmm", () => {
    function winmm(): WinMM & Internals {
        const w = new WinMM() as WinMM & Internals;
        const timer = { wTimerID: 3, wheelId: 77, isPeriodic: true, mode: 0, callbackOrEvent: 0x401000, dwUser: 9, delayMs: 10 };
        (w.timers as Map<number, unknown>).set(3, timer);
        (w.timersByWheel as Map<number, unknown>).set(77, timer);
        (w.periodRefCounts as Map<number, number>).set(1, 2);
        w.nextTimerId = 4;
        w.timerThreadId = 5;
        w.timerWakeEvent = 6;
        return w;
    }

    test("capture → restore → capture is byte-identical, timers keep their wheel ids", () => {
        const first = winmm().captureSavestate();
        const fresh = new WinMM() as WinMM & Internals;
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect((fresh.timersByWheel as Map<number, { wTimerID: number }>).get(77)?.wTimerID).toBe(3);
    });

    test("every saved timer field reaches the capture", () => {
        const w = winmm();
        const before = bytes(w.captureSavestate());
        const timer = (w.timers as Map<number, Record<string, unknown>>).get(3)!;
        for (const [field, policy] of Object.entries(WINMM_TIMER_FIELDS)) {
            if (policy !== "save" || field === "wTimerID" || field === "wheelId") continue;
            const old = timer[field];
            timer[field] = typeof old === "number" ? old + 1 : !old;
            expect({ field, same: bytes(w.captureSavestate()) === before }).toEqual({ field, same: false });
            timer[field] = old;
        }
    });

    test("refuses open devices and queued callbacks", () => {
        const w = winmm();
        (w.mmioHandles as Map<number, unknown>).set(1, {});
        expect(() => w.captureSavestate()).toThrow("MMIO");
        (w.mmioHandles as Map<number, unknown>).clear();
        (w.pendingTimerCallbacks as unknown[]).push({});
        expect(() => w.captureSavestate()).toThrow("timer callback");
    });

    test("refuses an open MCI device and a running timer callback", () => {
        const w = winmm();
        w.mci = { openDeviceCount: () => 1 };
        expect(() => w.captureSavestate()).toThrow("MCI");
        w.mci = null;
        w.dispatchingTimerCallback = (w.timers as Map<number, unknown>).get(3);
        expect(() => w.captureSavestate()).toThrow("timer callback");
        w.dispatchingTimerCallback = null;
        w.dispatchingPosted = true;
        expect(() => w.captureSavestate()).toThrow("timer callback");
    });

    test("every instance field has a policy", () => {
        expect(Object.keys(new WinMM()).sort()).toEqual(Object.keys(WINMM_FIELDS).sort());
    });

    test("every saved field survives a restore into a fresh module", () => {
        try {
            const joystick = winmm().captureSavestate().joystick;
            const values: Record<keyof WinMMState, unknown> = {
                timers: [{ wTimerID: 8, wheelId: 91, isPeriodic: false, mode: 1, callbackOrEvent: 0x402000, dwUser: 2, delayMs: 33 }],
                nextTimerId: 12, periodRefCounts: [[5, 3]], nextWaveOutId: 7, nextMMIOHandle: 0x99, nextPlaySoundId: 4,
                timerThreadId: 21, timerThreadHandle: 0x88, timerWakeEvent: 0x77,
                joystick: { thresholds: joystick.thresholds.map((t, i) => t + i + 1), captures: joystick.captures.map((_, i) => i === 0 ? { hwnd: 0x20001, changedOnly: true, timerId: 4, x: 1, y: 2, z: 3, buttons: 5, primed: true } : null) },
                waveOut: [{
                    fields: {
                        id: 0x20000003, format: { channels: 2, sampleRate: 11025, avgBytesPerSec: 22050, blockAlign: 2, bitsPerSample: 8 },
                        callback: 0x403000, instance: 6, flags: 0x30000, isPlaying: true, positionBytes: 0, writeOffset: 12,
                        pendingBuffers: [{ pwh: 0x1100, data: 0x1000, length: 8, endOffset: 12 }], lastPlayCursor: 2, playedBytes: 2,
                        completionPollerId: 41, guestLpData: 0, guestBufferLength: 0, multiBuffer: true,
                    },
                    writeCursor: 12, dataLength: 131072, loopMode: -1, volume: -300, pan: 40, tail: new Uint8Array([9, 8]),
                }],
                waveDone: [{ callback: 0x403000, args: [0x20000003, 0x3bd, 6, 0x1100, 0] }],
                playSound: { id: 0x50000002, channels: 1, sampleRate: 8000, bitsPerSample: 8, loop: true, playCursor: 3, pcm: new Uint8Array([1, 2, 3, 4, 5, 6]) },
            };
            expect(Object.keys(values).sort()).toEqual(Object.keys(winmm().captureSavestate()).sort());
            for (const [field, value] of Object.entries(values) as Array<[keyof WinMMState, unknown]>) {
                const saved = { ...winmm().captureSavestate(), [field]: value } as WinMMState;
                const fresh = new WinMM() as WinMM & Internals;
                fresh.guestMemory = () => new Uint8Array(0x2000);
                resetWinmmJoystick();
                fresh.restoreSavestate(structuredClone(saved));
                expect({ field, value: bytes(fresh.captureSavestate()[field]) }).toEqual({ field, value: bytes(value) });
            }
        } finally {
            resetWinmmJoystick();
        }
    });

    test("refuses a timer that the wheel index does not match", () => {
        const w = winmm();
        (w.timersByWheel as Map<number, unknown>).set(78, (w.timers as Map<number, unknown>).get(3));
        expect(() => w.captureSavestate()).toThrow("not indexed");
    });

    test("WinMMState keys", () => {
        const keys: Array<keyof WinMMState> = ["timers", "nextTimerId", "periodRefCounts", "nextWaveOutId", "nextMMIOHandle", "nextPlaySoundId", "timerThreadId", "timerThreadHandle", "timerWakeEvent", "joystick", "waveOut", "playSound", "waveDone"];
        expect(Object.keys(winmm().captureSavestate()).sort()).toEqual([...keys].sort());
    });
});

describe("dsound", () => {
    const g = globalThis as Record<string, unknown>;

    function dsound(): DSound & Internals {
        const d = new DSound() as DSound & Internals;
        const mem = new Uint8Array(0x20000);
        for (let i = 0; i < 64; i++) mem[0x1000 + i] = i;
        d.getMemory = () => mem;
        const ds3d = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, minDistance: 1, maxDistance: 1e9, mode: 0, coneInside: 360, coneOutside: 360, coneOrientX: 0, coneOrientY: 0, coneOrientZ: 1, coneOutsideVolume: 0 };
        (d.objects as Map<number, unknown>).set(0x5000, { type: "device", refCount: 1 });
        (d.objects as Map<number, unknown>).set(0x5100, {
            type: "buffer", refCount: 1, buffer: {
                id: 42, bytes: 64, format: { channels: 1, sampleRate: 22050, bitsPerSample: 8, blockAlign: 1, avgBytesPerSec: 22050 },
                flags: 0, ptr: 0x1000, currentPosition: 16, volume: 1, volumeDb: 0, pan: 0, frequency: 22050, playbackRate: 1,
                isPlaying: false, isLooping: false, sab: null, registered: false, bufferRefCount: 1, bufferLost: false,
                has3D: false, ds3d, deferredDs3d: null, notifications: [{ offset: 32, eventHandle: 0x88 }],
            },
        });
        d.nextBufferId = 43;
        return d;
    }

    test("capture → restore → capture is byte-identical for a stopped buffer", () => {
        const posted: unknown[] = [];
        const prev = g.self;
        g.self = { postMessage: (m: unknown) => posted.push(m) };
        try {
            const first = dsound().captureSavestate();
            const fresh = dsound();
            (fresh.objects as Map<number, unknown>).clear();
            fresh.restoreSavestate(structuredClone(first) as DSoundState);
            expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        } finally {
            g.self = prev;
        }
    });

    test("interfaces of one buffer share it again after a restore, and its ring is registered once", () => {
        const posted: Array<{ type: string; payload: { id: number; sab: SharedArrayBuffer } }> = [];
        const prev = g.self;
        g.self = { postMessage: (m: never) => posted.push(m) };
        try {
            const d = dsound();
            const objects = d.objects as Map<number, { type: string; refCount: number; buffer?: Record<string, unknown> }>;
            const buffer = objects.get(0x5100)!.buffer!;
            buffer.sab = createAudioRingBuffer(64, { channels: 1, sampleRate: 22050, bitsPerSample: 8 }, true);
            buffer.isPlaying = true;
            buffer.isLooping = true;
            objects.set(0x5200, { type: "IDirectSoundNotify", refCount: 1, buffer });
            const saved = structuredClone(d.captureSavestate()) as DSoundState;
            const fresh = dsound();
            (fresh.objects as Map<number, unknown>).clear();
            fresh.restoreSavestate(saved);
            const restored = fresh.objects as Map<number, { buffer?: { sab: SharedArrayBuffer | null; isPlaying: boolean } }>;
            expect(restored.get(0x5200)!.buffer).toBe(restored.get(0x5100)!.buffer!);
            const registers = posted.filter(m => m.type === "audio_register");
            expect(registers.map(m => m.payload.id)).toEqual([42]);
            expect(registers[0]!.payload.sab).toBe(restored.get(0x5100)!.buffer!.sab!);
        } finally {
            g.self = prev;
        }
    });

    test("every instance field has a policy", () => {
        expect(Object.keys(new DSound()).sort()).toEqual(Object.keys(DSOUND_FIELDS).sort());
    });

    test("every module-level field survives a restore into a fresh module", () => {
        const listener = { posX: 1, posY: 2, posZ: 3, velX: 4, velY: 5, velZ: 6, frontX: 0, frontY: 1, frontZ: 0, topX: 1, topY: 0, topZ: 0, distanceFactor: 2, rolloffFactor: 3, dopplerFactor: 4 };
        const values: Partial<Record<keyof DSoundState, unknown>> = {
            nextBufferId: 77, notifyTimerId: 31, primaryByDevice: [[0x5000, 0x5100], [0x5300, 0x5400]], speakerConfig: 0x00050004, listener,
            deferredListener: { ...listener, posX: 9 },
        };
        for (const [field, value] of Object.entries(values) as Array<[keyof DSoundState, unknown]>) {
            const saved = { ...dsound().captureSavestate(), [field]: value } as DSoundState;
            const fresh = dsound();
            (fresh.objects as Map<number, unknown>).clear();
            fresh.restoreSavestate(structuredClone(saved));
            expect({ field, value: bytes(fresh.captureSavestate()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    function withPlayingBuffer(state: number, run: (d: DSound & Internals, b: Record<string, unknown>) => void): void {
        const prev = g.self;
        g.self = { postMessage: () => undefined };
        try {
            const d = dsound();
            const b = ((d.objects as Map<number, { buffer: Record<string, unknown> }>).get(0x5100)!).buffer;
            const sab = createAudioRingBuffer(64, { channels: 1, sampleRate: 22050, bitsPerSample: 8 }, true);
            setCtrl(sab, CTRL_PLAY_CURSOR, 24);
            setCtrl(sab, CTRL_STATE, state);
            Object.assign(b, { sab, registered: true, isPlaying: true, isLooping: true });
            run(d, b);
        } finally {
            g.self = prev;
        }
    }

    test("a playing looped buffer is saved at its cursor and plays again after the restore", () => {
        withPlayingBuffer(STATE_PLAYING, (d) => {
            const saved = d.captureSavestate();
            const buf = saved.objects.find(o => o.buffer)!;
            expect(buf.buffer!.isPlaying).toBe(true);
            expect(buf.buffer!.currentPosition).toBe(24);
            const fresh = dsound();
            (fresh.objects as Map<number, unknown>).clear();
            fresh.restoreSavestate(structuredClone(saved));
            const restored = ((fresh.objects as Map<number, { buffer: Record<string, unknown> }>).get(0x5100)!).buffer;
            expect(restored.isPlaying).toBe(true);
            expect(getCtrl(restored.sab as SharedArrayBuffer, CTRL_STATE)).toBe(STATE_PLAYING);
            expect(getCtrl(restored.sab as SharedArrayBuffer, CTRL_PLAY_CURSOR)).toBe(24);
        });
    });

    test("a one-shot the worklet already finished is saved stopped and stays silent after the restore", () => {
        withPlayingBuffer(STATE_STOPPED, (d) => {
            const saved = d.captureSavestate();
            const buf = saved.objects.find(o => o.buffer)!.buffer!;
            expect(buf.isPlaying).toBe(false);
            expect(buf.isLooping).toBe(false);
            const fresh = dsound();
            (fresh.objects as Map<number, unknown>).clear();
            fresh.restoreSavestate(structuredClone(saved));
            const restored = ((fresh.objects as Map<number, { buffer: Record<string, unknown> }>).get(0x5100)!).buffer;
            expect(restored.isPlaying).toBe(false);
        });
    });

    test("refuses a locked buffer and capture buffers", () => {
        const d = dsound();
        const b = ((d.objects as Map<number, { buffer: Record<string, unknown> }>).get(0x5100)!).buffer;
        b.lockFirstSize = 8;
        expect(() => d.captureSavestate()).toThrow("locked");
        b.lockFirstSize = undefined;
        (d.objects as Map<number, unknown>).set(0x5200, { type: "capture", refCount: 1, capture: {} });
        expect(() => d.captureSavestate()).toThrow("capture buffers");
    });
});

describe("dinput", () => {
    class Plain extends BaseComObject {
        constructor() {
            super("00000000-0000-0000-c000-000000000046", 0);
        }

        protected destroy(): void {
            return;
        }
    }

    function device(): DirectInputDeviceObject {
        const d = new DirectInputDeviceObject(0x7a00);
        d.deviceType = "keyboard";
        d.dataFormat = "keyboard";
        d.dataSize = 256;
        d.acquired = true;
        d.seq = 5;
        d.actionMap = [];
        return d;
    }

    test("every device instance field has a policy, and the saved ones are exactly the capture", () => {
        const base = new Set(Object.keys(new Plain()));
        const own = Object.keys(new DirectInputDeviceObject(0)).filter(k => !base.has(k));
        expect(own.sort()).toEqual(Object.keys(DINPUT_DEVICE_FIELDS).sort());
        const saved = Object.entries(DINPUT_DEVICE_FIELDS).filter(([, p]) => p === "save").map(([k]) => k === "_deviceType" ? "deviceType" : k);
        expect(["base", ...saved].sort()).toEqual([...SAVED_INPUT_DEVICE_KEYS].sort());
        expect(Object.keys(DirectInputDeviceObject.captureObject(device())).sort()).toEqual([...SAVED_INPUT_DEVICE_KEYS].sort());
    });

    test("every module instance field has a policy", () => {
        expect(Object.keys(new DInput()).sort()).toEqual(Object.keys(DINPUT_FIELDS).sort());
    });

    test("capture → restore → capture is byte-identical and keeps the handle", () => {
        const d = device();
        const first = DirectInputDeviceObject.captureObject(d);
        const back = DirectInputDeviceObject.restoreObject(structuredClone(first));
        expect(back.handle).toBe(d.handle);
        expect(bytes(DirectInputDeviceObject.captureObject(back))).toBe(bytes(first));
    });

    test("every saved device field survives a restore into a fresh object", () => {
        const values: Partial<Record<keyof SavedInputDevice, unknown>> = {
            deviceType: "joystick", dataFormat: "joystick", isDI8: true, dataSize: 80, acquired: false, inputLost: true,
            exclusive: true, lastMouseX: 11, lastMouseY: 12, notifyEvent: 0x4c, isActionMapped: true,
            actionMap: [{ dwSemantic: 1, dwObjID: 2, uAppData: 3, lastValue: 0 }], actionMapGuid: "{map}", seq: 99,
            mousePollPrevButtons: 3,
        };
        expect(Object.keys(values).sort()).toEqual(SAVED_INPUT_DEVICE_KEYS.filter(k => k !== "base").sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof SavedInputDevice, unknown]>) {
            const saved = { ...DirectInputDeviceObject.captureObject(device()), [field]: value } as SavedInputDevice;
            const back = DirectInputDeviceObject.restoreObject(structuredClone(saved));
            expect({ field, value: bytes(DirectInputDeviceObject.captureObject(back)[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("saved action maps survive a restore into a fresh module", () => {
        const first = new DInput() as DInput & Internals;
        first.savedActionMaps = new Map([["user|keyboard|{map}", [{ uAppData: 1, semantic: 2, objId: 3, how: 4 }]]]);
        const undo = first.registerSavestate();
        const p = savestateParticipants.all().find(x => x.id === "dinput")!;
        const saved = structuredClone(p.capture({} as never));
        undo();
        const fresh = new DInput() as DInput & Internals;
        const undoFresh = fresh.registerSavestate();
        try {
            savestateParticipants.all().find(x => x.id === "dinput")!.restore(saved, {} as never);
            expect([...(fresh.savedActionMaps as Map<string, unknown>)]).toEqual([...(first.savedActionMaps as Map<string, unknown>)]);
        } finally {
            undoFresh();
        }
    });

    test("buffer sizes, sequence counters and unread buffered input survive a restore into a fresh session", () => {
        const im = System.getInstance().inputManager;
        const reset = () => im.restoreDInputBuffers({
            mouse: { size: 0, seq: 0, events: [], overflowed: false },
            keyboard: { size: 0, seq: 0, events: [], overflowed: false },
            gamepad: { size: 0, seq: 0, events: [], overflowed: false },
        });
        try {
            im.setDInputKeyboardBufferSize(16);
            im.setDInputMouseBufferSize(32);
            im.setDInputGamepadBufferSize(8);
            const lanes = im.captureDInputBuffers() as unknown as Record<string, Record<string, unknown>>;
            lanes.keyboard!.seq = 7;
            lanes.keyboard!.events = [{ dwOfs: 0x1e, dwData: 0x80, dwTimeStamp: 100, dwSequence: 7 }];
            lanes.mouse!.seq = 3;
            im.restoreDInputBuffers(lanes as never);
            const first = new DInput();
            const undo = first.registerSavestate();
            const saved = structuredClone(savestateParticipants.all().find(x => x.id === "dinput")!.capture({} as never));
            undo();
            reset();
            expect(im.getDInputKeyboardBufferSize()).toBe(0);
            const fresh = new DInput();
            const undoFresh = fresh.registerSavestate();
            try {
                savestateParticipants.all().find(x => x.id === "dinput")!.restore(saved, {} as never);
            } finally {
                undoFresh();
            }
            expect(im.getDInputKeyboardBufferSize()).toBe(16);
            expect(im.getDInputMouseBufferSize()).toBe(32);
            expect(im.getDInputGamepadBufferSize()).toBe(8);
            const back = im.captureDInputBuffers();
            expect(back.keyboard.seq).toBe(7);
            expect(back.mouse.seq).toBe(3);
            expect(im.drainDInputKeyboardEvents(4)).toEqual([{ dwOfs: 0x1e, dwData: 0x80, dwTimeStamp: 100, dwSequence: 7 }]);
        } finally {
            reset();
        }
    });

    test("refuses action-mapped input that is waiting to be read", () => {
        const d = device();
        d.actionDataPending.push({ entry: {} as never, dwData: 1 });
        expect(() => DirectInputDeviceObject.captureObject(d)).toThrow(CaptureRefusal);
        d.actionDataPending.length = 0;
        d.actionDataOverflowed = true;
        expect(() => DirectInputDeviceObject.captureObject(d)).toThrow("waiting to be read");
    });
});
