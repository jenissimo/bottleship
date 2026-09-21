/**
 * OpenAL 1.1 positional audio: the curves, and the wiring that reaches them.
 *
 * Every assertion here is against a value computed from the AL 1.1 spec, never against
 * whatever the implementation happens to produce — a spatializer that is merely
 * self-consistent is exactly the failure mode this feature has: a source moves, some
 * number changes, and the game is quietly wrong (or quietly silent) in a way no
 * screenshot and no cursor rate can show.
 *
 * Two layers:
 *   1. `spatialize()` — the math the AudioWorklet runs, as a pure function.
 *   2. The HLE module — that an app's alSourcefv/alListenerfv actually land in the
 *      control block the mixer reads, through every spelling AL offers.
 */

import { test, expect, beforeEach, describe } from "bun:test";
import {
    spatialize, makeSpatialResult, distanceGain, dopplerRatio,
    DIST_INVERSE_CLAMPED, DIST_INVERSE, DIST_LINEAR_CLAMPED, DIST_EXPONENT_CLAMPED, DIST_NONE,
    AL_DEFAULT_SPEED_OF_SOUND, type SpatialParams,
} from "../../src/audio/spatializer";
import { OpenAL } from "../../src/worker/modules/openal/openal";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    getCtrl, i32ToFloat,
    CTRL_3D_POS_X, CTRL_3D_POS_Y, CTRL_3D_POS_Z,
    CTRL_3D_VEL_X, CTRL_3D_MIN_DIST, CTRL_3D_MAX_DIST, CTRL_3D_ROLLOFF,
    CTRL_3D_MIN_GAIN, CTRL_3D_MAX_GAIN, CTRL_3D_MODE, CTRL_3D_FLAGS,
    CTRL_3D_CONE_INNER, CTRL_3D_CONE_OUTER, CTRL_3D_CONE_ORI_Z,
    FLAG3D_HAS_3D, FLAG3D_SOURCE_ROLLOFF,
    LCTRL_POS_X, LCTRL_FRONT_Z, LCTRL_TOP_Y, LCTRL_GAIN, LCTRL_DISTANCE_MODEL,
    LCTRL_SPEED_OF_SOUND, LCTRL_FLAGS, LISTENER_SLOTS,
} from "../../src/audio/audio-ring-buffer";

// ── AL enums (as a guest would pass them) ───────────────────────────────────
const AL_SOURCE_RELATIVE    = 0x0202;
const AL_CONE_INNER_ANGLE   = 0x1001;
const AL_CONE_OUTER_ANGLE   = 0x1002;
const AL_POSITION           = 0x1004;
const AL_DIRECTION          = 0x1005;
const AL_VELOCITY           = 0x1006;
const AL_BUFFER             = 0x1009;
const AL_GAIN               = 0x100A;
const AL_MIN_GAIN           = 0x100D;
const AL_ORIENTATION        = 0x100F;
const AL_REFERENCE_DISTANCE = 0x1020;
const AL_ROLLOFF_FACTOR     = 0x1021;
const AL_MAX_DISTANCE       = 0x1023;
const AL_LINEAR_DISTANCE_CLAMPED = 0xD004;
const AL_FORMAT_MONO16      = 0x1101;
const AL_FORMAT_STEREO16    = 0x1103;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The curves
// ─────────────────────────────────────────────────────────────────────────────

/** A listener at the origin in AL's default pose: facing −Z, +Y up, so +X is its right. */
function defaultParams(): SpatialParams {
    return {
        lPosX: 0, lPosY: 0, lPosZ: 0, lVelX: 0, lVelY: 0, lVelZ: 0,
        lAtX: 0, lAtY: 0, lAtZ: -1, lUpX: 0, lUpY: 1, lUpZ: 0,
        listenerGain: 1, distanceFactor: 1, dopplerFactor: 1,
        speedOfSound: AL_DEFAULT_SPEED_OF_SOUND,
        distanceModel: DIST_INVERSE_CLAMPED, rightHanded: true,
        sPosX: 0, sPosY: 0, sPosZ: 0, sVelX: 0, sVelY: 0, sVelZ: 0,
        refDistance: 1, maxDistance: 3.4028235e38, rolloff: 1,
        coneInner: 360, coneOuter: 360, coneOuterGain: 0,
        dirX: 0, dirY: 0, dirZ: 0,
        sourceGain: 1, minGain: 0, maxGain: 1,
        relative: false,
    };
}

/** Total gain, independent of how the equal-power pan splits it between channels. */
function totalGain(p: SpatialParams): number {
    const out = makeSpatialResult();
    spatialize(p, out);
    return Math.sqrt(out.leftGain * out.leftGain + out.rightGain * out.rightGain);
}

describe("distance attenuation follows the AL 1.1 curve the app selected", () => {
    test("AL_INVERSE_DISTANCE_CLAMPED is ref/(ref + rolloff·(d−ref))", () => {
        // ref=1, rolloff=1 ⇒ exactly 1/d beyond the reference distance.
        expect(distanceGain(DIST_INVERSE_CLAMPED, 1, 1, 1e9, 1)).toBeCloseTo(1, 6);
        expect(distanceGain(DIST_INVERSE_CLAMPED, 2, 1, 1e9, 1)).toBeCloseTo(0.5, 6);
        expect(distanceGain(DIST_INVERSE_CLAMPED, 4, 1, 1e9, 1)).toBeCloseTo(0.25, 6);
        // ref=2, rolloff=0.5, d=10 ⇒ 2/(2+0.5·8) = 1/3.
        expect(distanceGain(DIST_INVERSE_CLAMPED, 10, 2, 1e9, 0.5)).toBeCloseTo(1 / 3, 6);
    });

    test("CLAMPED clamps the DISTANCE at both ends, not the gain", () => {
        // Below the reference distance the clamped model holds at unity...
        expect(distanceGain(DIST_INVERSE_CLAMPED, 0.25, 1, 1e9, 1)).toBeCloseTo(1, 6);
        // ...while the unclamped one keeps rising above it, which is the whole difference.
        expect(distanceGain(DIST_INVERSE, 0.25, 1, 1e9, 1)).toBeCloseTo(1 / 0.25, 6);
        // Beyond AL_MAX_DISTANCE the gain stops falling: d=100 clamps to 5 ⇒ 1/5.
        expect(distanceGain(DIST_INVERSE_CLAMPED, 100, 1, 5, 1)).toBeCloseTo(0.2, 6);
    });

    test("linear, exponent and AL_NONE each match their own formula", () => {
        // 1 − rolloff·(d−ref)/(max−ref) = 1 − 5/10.
        expect(distanceGain(DIST_LINEAR_CLAMPED, 6, 1, 11, 1)).toBeCloseTo(0.5, 6);
        // (d/ref)^(−rolloff) = 2^−2.
        expect(distanceGain(DIST_EXPONENT_CLAMPED, 2, 1, 1e9, 2)).toBeCloseTo(0.25, 6);
        expect(distanceGain(DIST_NONE, 1000, 1, 1e9, 1)).toBe(1);
    });

    test("AL_ROLLOFF_FACTOR 0 disables attenuation in every model", () => {
        for (const m of [DIST_INVERSE_CLAMPED, DIST_LINEAR_CLAMPED, DIST_EXPONENT_CLAMPED]) {
            expect(distanceGain(m, 500, 1, 1e9, 0)).toBeCloseTo(1, 6);
        }
    });
});

describe("a source's position is read against the listener's, not against the origin", () => {
    test("a world-space source attenuates with its distance FROM THE LISTENER", () => {
        const p = defaultParams();
        p.sPosX = 10;
        expect(totalGain(p)).toBeCloseTo(0.1, 5);      // 10 units away ⇒ 1/10

        // Walk the listener onto the source: no distance left, so no attenuation.
        p.lPosX = 10;
        expect(totalGain(p)).toBeCloseTo(1, 5);

        // Half way: 5 units ⇒ 1/5. A listener stuck at the origin would still say 1/10,
        // which is the "source without listener makes things quieter" failure.
        p.lPosX = 5;
        expect(totalGain(p)).toBeCloseTo(0.2, 5);
    });

    test("an AL_SOURCE_RELATIVE source at the origin is at the listener's head", () => {
        const p = defaultParams();
        p.relative = true;
        p.sPosX = 0; p.sPosY = 0; p.sPosZ = 0;
        expect(totalGain(p)).toBeCloseTo(1, 6);

        // ...and stays there however far the listener travels, and however it turns.
        p.lPosX = 5000; p.lPosY = -200; p.lPosZ = 900;
        p.lAtX = 1; p.lAtZ = 0;
        expect(totalGain(p)).toBeCloseTo(1, 6);
    });
});

describe("azimuth follows the listener's at/up basis", () => {
    test("+X is the listener's right in AL's default pose", () => {
        const p = defaultParams();
        p.sPosX = 1;                                   // one unit to the right
        const out = makeSpatialResult();
        spatialize(p, out);
        expect(out.rightGain).toBeGreaterThan(out.leftGain);
        expect(out.leftGain).toBeCloseTo(0, 6);        // hard right ⇒ nothing on the left

        p.sPosX = -1;
        spatialize(p, out);
        expect(out.leftGain).toBeGreaterThan(out.rightGain);
        expect(out.rightGain).toBeCloseTo(0, 6);
    });

    test("turning the listener around swaps the channels", () => {
        const p = defaultParams();
        p.sPosX = 1;
        p.lAtZ = 1;                                    // face +Z instead of −Z
        const out = makeSpatialResult();
        spatialize(p, out);
        expect(out.leftGain).toBeCloseTo(1, 6);
        expect(out.rightGain).toBeCloseTo(0, 6);
    });

    test("a relative source is placed in the listener's OWN axes, so turning does nothing", () => {
        const p = defaultParams();
        p.relative = true;
        p.sPosX = 1;
        const out = makeSpatialResult();
        spatialize(p, out);
        expect(out.rightGain).toBeCloseTo(1, 6);

        p.lAtZ = 1;                                    // the listener turns around
        spatialize(p, out);
        expect(out.rightGain).toBeCloseTo(1, 6);       // the source turns with it
    });
});

describe("gain assembly brackets source gain and lets the listener scale the result", () => {
    test("AL_MIN_GAIN floors the attenuated gain before the listener's gain applies", () => {
        const p = defaultParams();
        p.sPosX = 100;                                 // ⇒ distance gain 0.01
        expect(totalGain(p)).toBeCloseTo(0.01, 6);

        p.minGain = 0.25;
        expect(totalGain(p)).toBeCloseTo(0.25, 6);

        // Listener gain multiplies AFTER the clamp, so it still scales a floored source.
        p.listenerGain = 0.5;
        expect(totalGain(p)).toBeCloseTo(0.125, 6);
    });

    test("AL_MAX_GAIN caps a source that would otherwise exceed it", () => {
        const p = defaultParams();
        p.sourceGain = 4;
        p.maxGain = 1;
        expect(totalGain(p)).toBeCloseTo(1, 6);
        p.maxGain = 2;
        expect(totalGain(p)).toBeCloseTo(2, 6);
    });
});

describe("cone attenuation", () => {
    test("a source aimed at the listener is unattenuated; aimed away it drops to the outer gain", () => {
        const p = defaultParams();
        p.sPosZ = -10;                                 // ten units in front of the listener
        p.coneInner = 60; p.coneOuter = 120; p.coneOuterGain = 0.1;
        p.refDistance = 100;                           // keep distance out of the comparison

        p.dirX = 0; p.dirY = 0; p.dirZ = 1;            // pointing back at the listener
        expect(totalGain(p)).toBeCloseTo(1, 6);

        p.dirZ = -1;                                   // pointing away
        expect(totalGain(p)).toBeCloseTo(0.1, 6);
    });

    test("a zero AL_DIRECTION means omnidirectional, whatever the cone angles say", () => {
        const p = defaultParams();
        p.sPosZ = -10; p.refDistance = 100;
        p.coneInner = 1; p.coneOuter = 2; p.coneOuterGain = 0;
        p.dirX = 0; p.dirY = 0; p.dirZ = 0;
        expect(totalGain(p)).toBeCloseTo(1, 6);
    });
});

describe("Doppler", () => {
    test("a closing pair raises pitch and a separating pair lowers it", () => {
        const c = AL_DEFAULT_SPEED_OF_SOUND;
        // Source closing at 10 m/s: f' = f·c/(c − 10).
        expect(dopplerRatio(0, 10, 1, c)).toBeCloseTo(c / (c - 10), 6);
        expect(dopplerRatio(0, 10, 1, c)).toBeGreaterThan(1);
        // Separating at 10 m/s: f' = f·c/(c + 10) — the direction of the shift, not just
        // its size, is what a reciprocal sign error gets wrong.
        expect(dopplerRatio(0, -10, 1, c)).toBeCloseTo(c / (c + 10), 6);
        expect(dopplerRatio(0, -10, 1, c)).toBeLessThan(1);
        // A listener moving toward the source raises pitch too.
        expect(dopplerRatio(10, 0, 1, c)).toBeCloseTo((c + 10) / c, 6);
    });

    test("AL_DOPPLER_FACTOR 0 disables the shift", () => {
        expect(dopplerRatio(50, 50, 0, AL_DEFAULT_SPEED_OF_SOUND)).toBe(1);
    });

    test("a source approaching through the full model shifts up", () => {
        const p = defaultParams();
        p.sPosZ = -10;                                 // in front
        p.sVelZ = 10;                                  // moving toward the listener (+Z)
        const out = makeSpatialResult();
        spatialize(p, out);
        const c = AL_DEFAULT_SPEED_OF_SOUND;
        expect(out.rateMul).toBeCloseTo(c / (c - 10), 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The wiring — an app's calls must reach the control block
// ─────────────────────────────────────────────────────────────────────────────

const MEM_BYTES = 1 << 20;
const SCRATCH = 0x1000;
const PCM = 0x40000;

let al: OpenAL;
let mem: Uint8Array;
let dv: DataView;

function fakeProcess(): any {
    let next = 0x80000;
    return {
        memory: { alloc: (n: number) => { const p = next; next += n + 16; return p; } },
        getCurrentMemory: () => mem,
    };
}

function call(name: string, ...args: number[]): number {
    const impl = al.exports[name];
    if (!impl) throw new Error(`no export ${name}`);
    return (impl as any)({}, mem, args) as number;
}

const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);
/** A float as the u32 the cdecl stack actually carries. */
function f2u(v: number): number { _f[0] = v; return _u[0]!; }

function putFloats(ptr: number, ...vals: number[]): number {
    vals.forEach((v, i) => dv.setFloat32(ptr + i * 4, v, true));
    return ptr;
}

function gen(name: string): number {
    call(name, 1, SCRATCH);
    return dv.getUint32(SCRATCH, true);
}

/** A playing mono source, which is the only shape that carries a 3D control block. */
function playingSource(format = AL_FORMAT_MONO16): { src: number; sab: SharedArrayBuffer } {
    const src = gen("alGenSources");
    const buf = gen("alGenBuffers");
    for (let i = 0; i < 4096; i += 2) dv.setInt16(PCM + i, 1000, true);
    call("alBufferData", buf, format, PCM, 4096, 22050);
    call("alSourcei", src, AL_BUFFER, buf);
    call("alSourcePlay", src);
    const s = (al as any).sources.get(src);
    if (!s?.sab) throw new Error("source did not start");
    return { src, sab: s.sab as SharedArrayBuffer };
}

function ctrlF(sab: SharedArrayBuffer, field: number): number {
    return i32ToFloat(getCtrl(sab, field));
}

function listenerSab(): SharedArrayBuffer {
    const sab = (al as any).listenerSab;
    if (!sab) throw new Error("no listener block published");
    return sab as SharedArrayBuffer;
}

/** The listener block is its OWN width — `getCtrl` views a source block and would
 *  read past the end of this one. */
function lctrlI(field: number): number {
    return Atomics.load(new Int32Array(listenerSab(), 0, LISTENER_SLOTS), field);
}

function lctrlF(field: number): number {
    return i32ToFloat(lctrlI(field));
}

beforeEach(() => {
    (globalThis as any).postMessage = () => { /* audio_register / audio_listener_sab sink */ };
    mem = new Uint8Array(MEM_BYTES);
    dv = new DataView(mem.buffer);
    Mem.bind(() => mem);
    al = new OpenAL();
    al.initialize(fakeProcess());
    call("alcCreateContext", 0, 0);
});

test("the listener exists from context creation, in AL's default pose", () => {
    // Not merely "a listener SAB was allocated": the mixer skips 3D entirely when the
    // pose is absent, so a source set up before the app touches the listener would go
    // unspatialized rather than unattenuated.
    expect(lctrlF(LCTRL_POS_X)).toBe(0);
    expect(lctrlF(LCTRL_FRONT_Z)).toBe(-1);            // AL faces −Z, DirectSound faces +Z
    expect(lctrlF(LCTRL_TOP_Y)).toBe(1);
    expect(lctrlF(LCTRL_GAIN)).toBe(1);
    expect(lctrlF(LCTRL_SPEED_OF_SOUND)).toBeCloseTo(AL_DEFAULT_SPEED_OF_SOUND, 3);
    expect(lctrlI(LCTRL_DISTANCE_MODEL)).toBe(DIST_INVERSE_CLAMPED);
    // OpenAL is right-handed, so the left-handed bit must stay clear.
    expect(lctrlI(LCTRL_FLAGS)).toBe(0);
});

test("alSourcefv(AL_POSITION) reaches the block the mixer reads", () => {
    const { src, sab } = playingSource();
    call("alSourcefv", src, AL_POSITION, putFloats(SCRATCH, 3, -4, 5));
    expect(ctrlF(sab, CTRL_3D_POS_X)).toBeCloseTo(3, 5);
    expect(ctrlF(sab, CTRL_3D_POS_Y)).toBeCloseTo(-4, 5);
    expect(ctrlF(sab, CTRL_3D_POS_Z)).toBeCloseTo(5, 5);

    call("alSourcefv", src, AL_VELOCITY, putFloats(SCRATCH, 7, 0, 0));
    expect(ctrlF(sab, CTRL_3D_VEL_X)).toBeCloseTo(7, 5);
});

test("alListenerfv(AL_ORIENTATION) is a six-float at/up pair", () => {
    call("alListenerfv", AL_ORIENTATION, putFloats(SCRATCH, 1, 0, 0, 0, 0, 1));
    const spatial = (al as any).openalSpatial();
    expect([spatial.listener.atX, spatial.listener.atY, spatial.listener.atZ]).toEqual([1, 0, 0]);
    expect([spatial.listener.upX, spatial.listener.upY, spatial.listener.upZ]).toEqual([0, 0, 1]);
    expect(lctrlF(LCTRL_FRONT_Z)).toBe(0);
    expect(lctrlF(LCTRL_TOP_Y)).toBe(0);

    // Reading it back gives the same six floats, in the same order.
    call("alGetListenerfv", AL_ORIENTATION, SCRATCH);
    const back = Array.from({ length: 6 }, (_, i) => dv.getFloat32(SCRATCH + i * 4, true));
    expect(back).toEqual([1, 0, 0, 0, 0, 1]);
});

test("every spelling of a property lands in the same place", () => {
    const { src, sab } = playingSource();

    // Vector: 3f in, fv out.
    call("alSource3f", src, AL_POSITION, f2u(1), f2u(2), f2u(3));
    call("alGetSourcefv", src, AL_POSITION, SCRATCH);
    expect([0, 1, 2].map(i => dv.getFloat32(SCRATCH + i * 4, true))).toEqual([1, 2, 3]);

    // Scalar: the float entry point and the integer one are the same property.
    call("alSourcef", src, AL_REFERENCE_DISTANCE, f2u(2.5));
    expect(ctrlF(sab, CTRL_3D_MIN_DIST)).toBeCloseTo(2.5, 5);
    call("alSourcei", src, AL_REFERENCE_DISTANCE, 7);
    expect(ctrlF(sab, CTRL_3D_MIN_DIST)).toBeCloseTo(7, 5);
    call("alGetSourcef", src, AL_REFERENCE_DISTANCE, SCRATCH);
    expect(dv.getFloat32(SCRATCH, true)).toBeCloseTo(7, 5);

    // A vector property set through a one-float entry point is not a partial write.
    call("alSourcef", src, AL_POSITION, f2u(99));
    expect(ctrlF(sab, CTRL_3D_POS_X)).toBeCloseTo(1, 5);
});

test("the whole per-source curve is published, not just the position", () => {
    const { src, sab } = playingSource();
    call("alSourcef", src, AL_REFERENCE_DISTANCE, f2u(50));
    call("alSourcef", src, AL_MAX_DISTANCE, f2u(500));
    call("alSourcef", src, AL_ROLLOFF_FACTOR, f2u(0.25));
    call("alSourcef", src, AL_MIN_GAIN, f2u(0.1));
    call("alSourcei", src, AL_CONE_INNER_ANGLE, 30);
    call("alSourcei", src, AL_CONE_OUTER_ANGLE, 90);
    call("alSourcefv", src, AL_DIRECTION, putFloats(SCRATCH, 0, 0, -1));

    expect(ctrlF(sab, CTRL_3D_MIN_DIST)).toBeCloseTo(50, 4);
    expect(ctrlF(sab, CTRL_3D_MAX_DIST)).toBeCloseTo(500, 4);
    expect(ctrlF(sab, CTRL_3D_MIN_GAIN)).toBeCloseTo(0.1, 5);
    expect(ctrlF(sab, CTRL_3D_MAX_GAIN)).toBeCloseTo(1, 5);
    expect(getCtrl(sab, CTRL_3D_CONE_INNER)).toBe(30);
    expect(getCtrl(sab, CTRL_3D_CONE_OUTER)).toBe(90);
    expect(ctrlF(sab, CTRL_3D_CONE_ORI_Z)).toBeCloseTo(-1, 5);

    // Rolloff is per-SOURCE in AL and per-LISTENER in DirectSound3D; the flag is what
    // tells the mixer which of the two blocks to believe.
    expect(ctrlF(sab, CTRL_3D_ROLLOFF)).toBeCloseTo(0.25, 5);
    expect(getCtrl(sab, CTRL_3D_FLAGS) & FLAG3D_SOURCE_ROLLOFF).toBe(FLAG3D_SOURCE_ROLLOFF);
});

test("AL_SOURCE_RELATIVE selects the head-relative reading of the same position", () => {
    const { src, sab } = playingSource();
    expect(getCtrl(sab, CTRL_3D_MODE)).toBe(0);
    call("alSourcei", src, AL_SOURCE_RELATIVE, 1);
    expect(getCtrl(sab, CTRL_3D_MODE)).toBe(1);
    call("alSourcei", src, AL_SOURCE_RELATIVE, 0);
    expect(getCtrl(sab, CTRL_3D_MODE)).toBe(0);
});

test("a stereo buffer is not spatialized", () => {
    // AL plays a stereo buffer as authored. Attenuating one would pull down exactly the
    // music and pre-panned ambience an app never meant to place in the world.
    const mono = playingSource(AL_FORMAT_MONO16);
    expect(getCtrl(mono.sab, CTRL_3D_FLAGS) & FLAG3D_HAS_3D).toBe(FLAG3D_HAS_3D);

    const stereo = playingSource(AL_FORMAT_STEREO16);
    expect(getCtrl(stereo.sab, CTRL_3D_FLAGS) & FLAG3D_HAS_3D).toBe(0);
});

test("alDistanceModel and alSpeedOfSound reach the listener block", () => {
    call("alDistanceModel", AL_LINEAR_DISTANCE_CLAMPED);
    expect(lctrlI(LCTRL_DISTANCE_MODEL)).toBe(DIST_LINEAR_CLAMPED);
    call("alSpeedOfSound", f2u(500));
    expect(lctrlF(LCTRL_SPEED_OF_SOUND)).toBeCloseTo(500, 3);
});
