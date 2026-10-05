/**
 * OpenAL 1.1 positional audio — the state model and its projection onto the audio
 * ring-buffer control blocks the AudioWorklet mixes against.
 *
 * SOURCE AND LISTENER ARE ONE FEATURE. Distance attenuation is measured between the
 * two, so feeding source positions to a listener frozen at the origin does not give
 * partial 3D — it gives every world-space source the gain of a source that is far
 * away, i.e. a quieter game. Nothing here is published unless both halves are.
 *
 * CONVENTIONS (OpenAL 1.1, §3.4–3.5, §4.3):
 *  - Right-handed. The listener's orientation is a SIX-float at/up pair, default
 *    at=(0,0,-1) up=(0,1,0), which puts +X on the listener's right — the basis the
 *    mixer assumes when LFLAG_LEFT_HANDED is clear.
 *  - AL_VELOCITY only affects anything through the Doppler shift, and AL_DOPPLER_FACTOR
 *    defaults to 1, so velocities an app sets ARE audible by default.
 *  - AL_SOURCE_RELATIVE means position/velocity/direction are in listener-LOCAL axes;
 *    a relative source at the origin is at the listener's head and never attenuates.
 *  - Only MONO buffers are spatialized. A stereo buffer plays as authored — which is
 *    also what keeps music and pre-panned ambience from being attenuated.
 *
 * The setters are stores, not computations: the mixer recomputes the whole model once
 * per 128-frame block from these fields, so an engine that pushes AL_POSITION for every
 * voice every frame pays a handful of Atomics.store and nothing else.
 */

import {
    setCtrl, setCtrlFloat, createListenerSab, floatToI32,
    CTRL_3D_POS_X, CTRL_3D_POS_Y, CTRL_3D_POS_Z,
    CTRL_3D_VEL_X, CTRL_3D_VEL_Y, CTRL_3D_VEL_Z,
    CTRL_3D_MIN_DIST, CTRL_3D_MAX_DIST, CTRL_3D_MODE,
    CTRL_3D_CONE_INNER, CTRL_3D_CONE_OUTER,
    CTRL_3D_CONE_ORI_X, CTRL_3D_CONE_ORI_Y, CTRL_3D_CONE_ORI_Z,
    CTRL_3D_CONE_OUTVOL, CTRL_3D_FLAGS,
    CTRL_3D_ROLLOFF, CTRL_3D_MIN_GAIN, CTRL_3D_MAX_GAIN,
    FLAG3D_HAS_3D, FLAG3D_SOURCE_ROLLOFF,
    LCTRL_POS_X, LCTRL_POS_Y, LCTRL_POS_Z,
    LCTRL_VEL_X, LCTRL_VEL_Y, LCTRL_VEL_Z,
    LCTRL_FRONT_X, LCTRL_FRONT_Y, LCTRL_FRONT_Z,
    LCTRL_TOP_X, LCTRL_TOP_Y, LCTRL_TOP_Z,
    LCTRL_DIST_FACTOR, LCTRL_ROLLOFF_FACTOR, LCTRL_DOPPLER_FACTOR,
    LCTRL_GAIN, LCTRL_DISTANCE_MODEL, LCTRL_SPEED_OF_SOUND, LCTRL_FLAGS,
    LISTENER_SLOTS,
} from "../../../audio/audio-ring-buffer";
import {
    DIST_INVERSE, DIST_INVERSE_CLAMPED, DIST_LINEAR, DIST_LINEAR_CLAMPED,
    DIST_EXPONENT, DIST_EXPONENT_CLAMPED, DIST_NONE, AL_DEFAULT_SPEED_OF_SOUND,
} from "../../../audio/spatializer";

// ── AL enums this model reads ───────────────────────────────────────────────

export const AL_NONE_ENUM          = 0x0000;
export const AL_SOURCE_RELATIVE    = 0x0202;
export const AL_CONE_INNER_ANGLE   = 0x1001;
export const AL_CONE_OUTER_ANGLE   = 0x1002;
export const AL_POSITION           = 0x1004;
export const AL_DIRECTION          = 0x1005;
export const AL_VELOCITY           = 0x1006;
export const AL_ORIENTATION        = 0x100F;
export const AL_REFERENCE_DISTANCE = 0x1020;
export const AL_ROLLOFF_FACTOR     = 0x1021;
export const AL_CONE_OUTER_GAIN    = 0x1022;
export const AL_MAX_DISTANCE       = 0x1023;
export const AL_MIN_GAIN           = 0x100D;
export const AL_MAX_GAIN           = 0x100E;

export const AL_DOPPLER_FACTOR   = 0xC000;
export const AL_DOPPLER_VELOCITY = 0xC001;
export const AL_SPEED_OF_SOUND   = 0xC003;
export const AL_DISTANCE_MODEL   = 0xD000;

export const AL_INVERSE_DISTANCE          = 0xD001;
export const AL_INVERSE_DISTANCE_CLAMPED  = 0xD002;
export const AL_LINEAR_DISTANCE           = 0xD003;
export const AL_LINEAR_DISTANCE_CLAMPED   = 0xD004;
export const AL_EXPONENT_DISTANCE         = 0xD005;
export const AL_EXPONENT_DISTANCE_CLAMPED = 0xD006;

/** AL_MAX_DISTANCE's default is FLT_MAX — effectively "never clamp". */
export const AL_MAX_DISTANCE_DEFAULT = 3.4028235e38;

// ── State ───────────────────────────────────────────────────────────────────

export interface ALListenerState {
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    atX: number; atY: number; atZ: number;
    upX: number; upY: number; upZ: number;
    gain: number;
}

/** The per-source half. Defaults are AL 1.1's, so an app that sets nothing is unattenuated. */
export interface ALSourceSpatial {
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    dirX: number; dirY: number; dirZ: number;
    relative: boolean;
    referenceDistance: number;
    maxDistance: number;
    rolloffFactor: number;
    minGain: number;
    maxGain: number;
    coneInnerAngle: number;
    coneOuterAngle: number;
    coneOuterGain: number;
}

/** Context-wide AL state (alDistanceModel / alDopplerFactor / alSpeedOfSound). */
export interface ALContextSpatial {
    distanceModel: number;
    dopplerFactor: number;
    speedOfSound: number;
}

export function createListenerState(): ALListenerState {
    return {
        posX: 0, posY: 0, posZ: 0,
        velX: 0, velY: 0, velZ: 0,
        atX: 0, atY: 0, atZ: -1,
        upX: 0, upY: 1, upZ: 0,
        gain: 1,
    };
}

export function createSourceSpatial(): ALSourceSpatial {
    return {
        posX: 0, posY: 0, posZ: 0,
        velX: 0, velY: 0, velZ: 0,
        dirX: 0, dirY: 0, dirZ: 0,
        relative: false,
        referenceDistance: 1,
        maxDistance: AL_MAX_DISTANCE_DEFAULT,
        rolloffFactor: 1,
        minGain: 0,
        maxGain: 1,
        coneInnerAngle: 360,
        coneOuterAngle: 360,
        coneOuterGain: 0,
    };
}

export function createContextSpatial(): ALContextSpatial {
    return {
        distanceModel: AL_INVERSE_DISTANCE_CLAMPED,
        dopplerFactor: 1,
        speedOfSound: AL_DEFAULT_SPEED_OF_SOUND,
    };
}

/** AL distance-model enum → the mixer's model id. An unknown enum means no attenuation. */
export function distanceModelToMixer(alEnum: number): number {
    switch (alEnum) {
        case AL_INVERSE_DISTANCE:          return DIST_INVERSE;
        case AL_INVERSE_DISTANCE_CLAMPED:  return DIST_INVERSE_CLAMPED;
        case AL_LINEAR_DISTANCE:           return DIST_LINEAR;
        case AL_LINEAR_DISTANCE_CLAMPED:   return DIST_LINEAR_CLAMPED;
        case AL_EXPONENT_DISTANCE:         return DIST_EXPONENT;
        case AL_EXPONENT_DISTANCE_CLAMPED: return DIST_EXPONENT_CLAMPED;
        default:                           return DIST_NONE;
    }
}

/** Linear gain → DirectSound centibels, the encoding the cone-outside field uses. */
export function gainToCentibels(gain: number): number {
    if (gain <= 0) return -10000;
    return Math.max(-10000, Math.round(2000 * Math.log10(gain)));
}

// ── Publication ─────────────────────────────────────────────────────────────

/** DS3DMODE_HEAD_RELATIVE — what AL_SOURCE_RELATIVE maps onto in the mixer. */
const MODE_HEAD_RELATIVE = 1;
const MODE_NORMAL = 0;

/**
 * Create the process-wide listener block and hand it to the worklet.
 *
 * One listener per context is the model in OpenAL exactly as in DirectSound3D, so this
 * is the same singleton those APIs register; whichever one the guest actually uses owns it.
 */
export function createALListenerSab(): SharedArrayBuffer {
    const sab = createListenerSab();
    (self as unknown as { postMessage(m: unknown): void })
        .postMessage({ type: "audio_listener_sab", payload: { sab } });
    return sab;
}

/** Cached like the per-source views: the listener is re-published on every orientation
 *  change, which for a first-person engine is every frame. */
const listenerViews = new WeakMap<SharedArrayBuffer, Int32Array>();

export function writeListener(sab: SharedArrayBuffer, l: ALListenerState, g: ALContextSpatial): void {
    let c = listenerViews.get(sab);
    if (!c) { c = new Int32Array(sab, 0, LISTENER_SLOTS); listenerViews.set(sab, c); }
    Atomics.store(c, LCTRL_POS_X, floatToI32(l.posX));
    Atomics.store(c, LCTRL_POS_Y, floatToI32(l.posY));
    Atomics.store(c, LCTRL_POS_Z, floatToI32(l.posZ));
    Atomics.store(c, LCTRL_VEL_X, floatToI32(l.velX));
    Atomics.store(c, LCTRL_VEL_Y, floatToI32(l.velY));
    Atomics.store(c, LCTRL_VEL_Z, floatToI32(l.velZ));
    Atomics.store(c, LCTRL_FRONT_X, floatToI32(l.atX));
    Atomics.store(c, LCTRL_FRONT_Y, floatToI32(l.atY));
    Atomics.store(c, LCTRL_FRONT_Z, floatToI32(l.atZ));
    Atomics.store(c, LCTRL_TOP_X, floatToI32(l.upX));
    Atomics.store(c, LCTRL_TOP_Y, floatToI32(l.upY));
    Atomics.store(c, LCTRL_TOP_Z, floatToI32(l.upZ));
    Atomics.store(c, LCTRL_GAIN, floatToI32(l.gain));
    // OpenAL has no world-units-to-meters scale, and rolloff is a SOURCE property here —
    // the listener's copy is pinned so a stale DS3D value can never leak into the curve.
    Atomics.store(c, LCTRL_DIST_FACTOR, floatToI32(1));
    Atomics.store(c, LCTRL_ROLLOFF_FACTOR, floatToI32(1));
    Atomics.store(c, LCTRL_DOPPLER_FACTOR, floatToI32(g.dopplerFactor));
    Atomics.store(c, LCTRL_SPEED_OF_SOUND, floatToI32(g.speedOfSound));
    Atomics.store(c, LCTRL_DISTANCE_MODEL, distanceModelToMixer(g.distanceModel));
    Atomics.store(c, LCTRL_FLAGS, 0);   // right-handed
}

/**
 * Publish one source's 3D state.
 *
 * `spatialized` is false for a stereo buffer (AL plays those unattenuated) and for a
 * source before any buffer is known; it clears FLAG3D_HAS_3D so the mixer takes the
 * plain-gain path rather than attenuating against a listener the app may not have
 * positioned yet.
 */
export function writeSourceSpatial(sab: SharedArrayBuffer, s: ALSourceSpatial, spatialized: boolean): void {
    setCtrlFloat(sab, CTRL_3D_POS_X, s.posX);
    setCtrlFloat(sab, CTRL_3D_POS_Y, s.posY);
    setCtrlFloat(sab, CTRL_3D_POS_Z, s.posZ);
    setCtrlFloat(sab, CTRL_3D_VEL_X, s.velX);
    setCtrlFloat(sab, CTRL_3D_VEL_Y, s.velY);
    setCtrlFloat(sab, CTRL_3D_VEL_Z, s.velZ);
    setCtrlFloat(sab, CTRL_3D_CONE_ORI_X, s.dirX);
    setCtrlFloat(sab, CTRL_3D_CONE_ORI_Y, s.dirY);
    setCtrlFloat(sab, CTRL_3D_CONE_ORI_Z, s.dirZ);
    setCtrlFloat(sab, CTRL_3D_MIN_DIST, s.referenceDistance);
    setCtrlFloat(sab, CTRL_3D_MAX_DIST, s.maxDistance);
    setCtrlFloat(sab, CTRL_3D_ROLLOFF, s.rolloffFactor);
    setCtrlFloat(sab, CTRL_3D_MIN_GAIN, s.minGain);
    setCtrlFloat(sab, CTRL_3D_MAX_GAIN, s.maxGain);
    setCtrl(sab, CTRL_3D_CONE_INNER, Math.round(s.coneInnerAngle));
    setCtrl(sab, CTRL_3D_CONE_OUTER, Math.round(s.coneOuterAngle));
    setCtrl(sab, CTRL_3D_CONE_OUTVOL, gainToCentibels(s.coneOuterGain));
    setCtrl(sab, CTRL_3D_MODE, s.relative ? MODE_HEAD_RELATIVE : MODE_NORMAL);
    setCtrl(sab, CTRL_3D_FLAGS, spatialized ? (FLAG3D_HAS_3D | FLAG3D_SOURCE_ROLLOFF) : 0);
}

/**
 * Position/velocity only — the path an engine's per-frame update actually takes.
 * The rest of a source's 3D state changes when a sound is set up, not per frame.
 */
export function writeSourceMotion(sab: SharedArrayBuffer, s: ALSourceSpatial): void {
    setCtrlFloat(sab, CTRL_3D_POS_X, s.posX);
    setCtrlFloat(sab, CTRL_3D_POS_Y, s.posY);
    setCtrlFloat(sab, CTRL_3D_POS_Z, s.posZ);
    setCtrlFloat(sab, CTRL_3D_VEL_X, s.velX);
    setCtrlFloat(sab, CTRL_3D_VEL_Y, s.velY);
    setCtrlFloat(sab, CTRL_3D_VEL_Z, s.velZ);
}
