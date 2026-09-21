/**
 * 3D spatialization math — one definition, two callers (the AudioWorklet mixer and
 * the tests that pin the curves).
 *
 * The worklet cannot be unit-tested: its math lives inside an AudioWorkletProcessor
 * that only exists in an audio rendering thread. Keeping the curves here, as pure
 * functions over plain numbers, is what makes "gain at distance d is X" an assertion
 * rather than a listening impression.
 *
 * COORDINATE CONVENTIONS — getting one of these wrong is silent, so they are pinned:
 *  - Orientation is an at/up pair. The listener's RIGHT is cross(at, up), which is the
 *    RIGHT-handed convention (OpenAL: default at=(0,0,-1), up=(0,1,0) ⇒ right=(+1,0,0)).
 *    A left-handed producer (DirectSound3D, Miles) has right = cross(up, at) instead —
 *    see `rightHanded`.
 *  - `dir` is LISTENER → SOURCE. Cone angle is measured from the source, so it uses −dir.
 *  - A relative source (AL_SOURCE_RELATIVE / DS3DMODE_HEAD_RELATIVE) carries a position
 *    already expressed in listener-LOCAL axes, so the listener basis is the identity and
 *    its velocity does not enter the Doppler shift.
 *
 * This file must not import anything: it is bundled into the AudioWorklet scope.
 */

// ── Distance models ─────────────────────────────────────────────────────────
// 0 is the inverse-distance-clamped curve, which is both OpenAL's default and
// exactly the curve DirectSound3D/Miles already used, so an existing producer that
// never writes this field keeps its behavior.

export const DIST_INVERSE_CLAMPED = 0;
export const DIST_INVERSE = 1;
export const DIST_LINEAR = 2;
export const DIST_LINEAR_CLAMPED = 3;
export const DIST_EXPONENT = 4;
export const DIST_EXPONENT_CLAMPED = 5;
export const DIST_NONE = 6;

/** Speed of sound in m/s: OpenAL's AL_SPEED_OF_SOUND default (DirectSound uses 340). */
export const AL_DEFAULT_SPEED_OF_SOUND = 343.3;

const DEG_PER_RAD = 180 / Math.PI;
const QUARTER_PI = Math.PI / 4;

/**
 * Distance attenuation.
 *
 * `rolloff` 0 yields 1 in every model, which is how an app disables attenuation
 * per source without disabling spatialization.
 */
export function distanceGain(
    model: number,
    distance: number,
    refDistance: number,
    maxDistance: number,
    rolloff: number,
): number {
    if (model === DIST_NONE) return 1;

    const ref = Math.max(refDistance, 0);
    let d = Math.max(distance, 0);

    switch (model) {
        case DIST_INVERSE_CLAMPED:
            d = Math.min(Math.max(d, ref), maxDistance);
            // fallthrough
        case DIST_INVERSE: {
            const denom = ref + rolloff * (d - ref);
            // ref === 0 makes the curve degenerate (0/0 at the origin); AL leaves it
            // undefined, so answer "no attenuation" rather than NaN into the mixer.
            if (ref <= 0 || denom <= 0) return 1;
            return ref / denom;
        }

        case DIST_LINEAR_CLAMPED:
            d = Math.max(d, ref);
            // fallthrough
        case DIST_LINEAR: {
            d = Math.min(d, maxDistance);
            const span = maxDistance - ref;
            // A zero span is a step at the reference distance, not a division.
            if (span <= 0) return d > ref ? clamp01(1 - rolloff) : 1;
            return clamp01(1 - rolloff * (d - ref) / span);
        }

        case DIST_EXPONENT_CLAMPED:
            d = Math.min(Math.max(d, ref), maxDistance);
            // fallthrough
        case DIST_EXPONENT: {
            if (ref <= 0 || d <= 0) return 1;
            return Math.pow(d / ref, -rolloff);
        }
    }
    return 1;
}

/**
 * Cone attenuation. `angleDeg` is measured at the source, between its direction and
 * the source→listener vector; `inner`/`outer` are FULL angles in degrees, so the
 * comparison is against their halves.
 */
export function coneGain(angleDeg: number, inner: number, outer: number, outerGain: number): number {
    if (inner >= 360 && outer >= 360) return 1;
    const halfInner = inner * 0.5;
    const halfOuter = outer * 0.5;
    if (angleDeg <= halfInner) return 1;
    if (angleDeg >= halfOuter) return outerGain;
    const t = (angleDeg - halfInner) / (halfOuter - halfInner);
    return 1 + t * (outerGain - 1);
}

/**
 * Doppler frequency ratio.
 *
 * `vlsToward` is the listener's speed TOWARD the source and `vssToward` the source's
 * speed TOWARD the listener — both already positive when the two are closing, which is
 * what makes the classic f' = f·(c + vl)/(c − vs) read directly off the formula. A
 * closing pair raises pitch; the reciprocal of this is a real and audible bug.
 */
export function dopplerRatio(
    vlsToward: number,
    vssToward: number,
    dopplerFactor: number,
    speedOfSound: number,
): number {
    if (dopplerFactor <= 0 || speedOfSound <= 0) return 1;
    // AL clamps each projected speed at SS/DF, the point where the denominator would
    // cross zero (a source outrunning its own sound).
    const limit = speedOfSound / dopplerFactor;
    const vl = Math.min(vlsToward, limit);
    const vs = Math.min(vssToward, limit);
    const denom = speedOfSound - dopplerFactor * vs;
    if (denom <= 1e-7) return 1;
    return (speedOfSound + dopplerFactor * vl) / denom;
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Whole-source spatialization ─────────────────────────────────────────────

/**
 * Inputs for one source against the current listener. A flat mutable record, filled
 * from the SAB control blocks and reused across sources — the mixer runs this per
 * 128-frame block per active source, so it must not allocate.
 */
export interface SpatialParams {
    // Listener
    lPosX: number; lPosY: number; lPosZ: number;
    lVelX: number; lVelY: number; lVelZ: number;
    lAtX: number; lAtY: number; lAtZ: number;
    lUpX: number; lUpY: number; lUpZ: number;
    listenerGain: number;
    /** Scales world units to meters before attenuation (DS3D); OpenAL leaves it 1. */
    distanceFactor: number;
    dopplerFactor: number;
    speedOfSound: number;
    distanceModel: number;
    /** false ⇒ right = cross(up, at), the left-handed (DirectSound3D/Miles) basis. */
    rightHanded: boolean;

    // Source
    sPosX: number; sPosY: number; sPosZ: number;
    sVelX: number; sVelY: number; sVelZ: number;
    refDistance: number; maxDistance: number; rolloff: number;
    coneInner: number; coneOuter: number; coneOuterGain: number;
    dirX: number; dirY: number; dirZ: number;
    sourceGain: number; minGain: number; maxGain: number;
    /** Position/velocity/direction are in listener-local axes. */
    relative: boolean;
}

export interface SpatialResult {
    leftGain: number;
    rightGain: number;
    /** Multiplier on playback rate — the Doppler shift. */
    rateMul: number;
}

export function makeSpatialResult(): SpatialResult {
    return { leftGain: 1, rightGain: 1, rateMul: 1 };
}

/**
 * Resolve one source to stereo gains and a pitch ratio.
 *
 * Gain assembly follows AL 1.1: the MIN/MAX clamp brackets the source's own gain
 * together with distance and cone, and the listener gain multiplies AFTER the clamp —
 * so a listener at 0.5 still halves a source pinned at AL_MIN_GAIN.
 */
export function spatialize(p: SpatialParams, out: SpatialResult): void {
    // Listener → source. A relative source is already expressed that way.
    const dx = p.relative ? p.sPosX : p.sPosX - p.lPosX;
    const dy = p.relative ? p.sPosY : p.sPosY - p.lPosY;
    const dz = p.relative ? p.sPosZ : p.sPosZ - p.lPosZ;

    const rawDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dist = rawDist * (p.distanceFactor > 0 ? p.distanceFactor : 1);

    let dirX = 0, dirY = 0, dirZ = 0;
    if (rawDist > 1e-7) {
        const inv = 1 / rawDist;
        dirX = dx * inv; dirY = dy * inv; dirZ = dz * inv;
    }

    // Azimuth against the listener's right vector. A relative source's axes ARE the
    // listener's, so its right is (1,0,0) and the orientation must not be applied twice.
    let nrX = 1, nrY = 0, nrZ = 0;
    if (!p.relative) {
        const aX = p.lAtX, aY = p.lAtY, aZ = p.lAtZ;
        const uX = p.lUpX, uY = p.lUpY, uZ = p.lUpZ;
        let rX: number, rY: number, rZ: number;
        if (p.rightHanded) {
            rX = aY * uZ - aZ * uY; rY = aZ * uX - aX * uZ; rZ = aX * uY - aY * uX;
        } else {
            rX = uY * aZ - uZ * aY; rY = uZ * aX - uX * aZ; rZ = uX * aY - uY * aX;
        }
        const len = Math.sqrt(rX * rX + rY * rY + rZ * rZ);
        if (len > 1e-7) {
            const inv = 1 / len;
            nrX = rX * inv; nrY = rY * inv; nrZ = rZ * inv;
        } else {
            nrX = 0; nrY = 0; nrZ = 0;   // degenerate orientation ⇒ centered
        }
    }

    // Equal-power pan: a source dead ahead sits at cos/sin(PI/4) on both channels.
    const pan = dirX * nrX + dirY * nrY + dirZ * nrZ;
    const theta = (clampPan(pan) + 1) * QUARTER_PI;

    // Distance + cone, clamped, then the listener's master gain.
    let gain = p.sourceGain
        * distanceGain(p.distanceModel, dist, p.refDistance, p.maxDistance, p.rolloff)
        * sourceConeGain(p, dirX, dirY, dirZ);

    if (gain < p.minGain) gain = p.minGain;
    if (gain > p.maxGain) gain = p.maxGain;
    gain *= p.listenerGain;

    out.leftGain = gain * Math.cos(theta);
    out.rightGain = gain * Math.sin(theta);

    // Doppler: project each velocity onto the closing direction. `dir` points at the
    // source, so the listener closes along +dir and the source closes along −dir.
    if (p.dopplerFactor > 0 && rawDist > 1e-7) {
        const vlsToward = p.relative ? 0 : p.lVelX * dirX + p.lVelY * dirY + p.lVelZ * dirZ;
        const vssToward = -(p.sVelX * dirX + p.sVelY * dirY + p.sVelZ * dirZ);
        out.rateMul = clampRate(dopplerRatio(vlsToward, vssToward, p.dopplerFactor, p.speedOfSound));
    } else {
        out.rateMul = 1;
    }
}

function sourceConeGain(p: SpatialParams, dirX: number, dirY: number, dirZ: number): number {
    if (p.coneInner >= 360 && p.coneOuter >= 360) return 1;
    const len = Math.sqrt(p.dirX * p.dirX + p.dirY * p.dirY + p.dirZ * p.dirZ);
    if (len <= 1e-7) return 1;              // zero AL_DIRECTION ⇒ omnidirectional
    const inv = 1 / len;
    const dot = -(dirX * p.dirX + dirY * p.dirY + dirZ * p.dirZ) * inv;
    const angleDeg = Math.acos(clampPan(dot)) * DEG_PER_RAD;
    return coneGain(angleDeg, p.coneInner, p.coneOuter, p.coneOuterGain);
}

function clampPan(v: number): number {
    return v < -1 ? -1 : v > 1 ? 1 : v;
}

function clampRate(v: number): number {
    return v < 0.1 ? 0.1 : v > 10 ? 10 : v;
}
