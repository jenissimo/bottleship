/**
 * Miles' F32 volume API — the MSS 6 spelling of state MSS 5 expressed as S32.
 *
 * A shipped mss32.dll exports BOTH families, and they address the same per-voice
 * fields: `AIL_set_sample_volume` (S32 0–127) and `AIL_set_sample_volume_levels`
 * (F32 left/right, 0.0–1.0) are two projections of one volume+pan pair, not two
 * independent controls. Which family a title calls is decided by the SDK it was
 * built against, so both must land on the same state or a game that sets volume
 * one way and reads it back the other sees its own write vanish.
 *
 * The pair⇄volume/pan conversion is the exact inverse of the mix real MSS32
 * performs (see computeSampleVolumes): left = 2·V·(127−pan)/127 and
 * right = 2·V·pan/127, so left+right = 2·V and right/(left+right) = pan/127.
 */

/**
 * Reinterpret a stdcall stack slot as the F32 it carries. __stdcall passes a float
 * in one 4-byte slot as its IEEE-754 bits, so the dispatcher's u32 argument is the
 * encoding, not the value.
 */
export function f32Arg(bits: number): number {
    const buffer = new ArrayBuffer(4);
    new Uint32Array(buffer)[0] = bits >>> 0;
    const value = new Float32Array(buffer)[0];
    return Number.isFinite(value) ? value : 0;
}

/** Clamp to the 0.0–1.0 range every Miles level is documented in. */
export function clampLevel(level: number): number {
    return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
}

/** Split an F32 left/right pair into the S32 volume and pan Miles stores. */
export function levelsToVolumePan(left: number, right: number): { volume: number; pan: number } {
    const l = clampLevel(left);
    const r = clampLevel(right);
    const sum = l + r;
    // A silent pair carries no direction; leaving pan centred is what re-raising
    // the volume afterwards has to find, since Miles keeps the two fields apart.
    if (sum <= 0) return { volume: 0, pan: 64 };
    return {
        volume: Math.max(0, Math.min(127, Math.round((sum / 2) * 127))),
        pan: Math.max(0, Math.min(127, Math.round((r / sum) * 127))),
    };
}

/** The F32 left/right pair an S32 volume and pan produce. */
export function volumePanToLevels(volume127: number, pan127: number): { left: number; right: number } {
    const v = Math.max(0, Math.min(127, volume127)) / 127;
    const pan = Math.max(0, Math.min(127, pan127));
    return {
        left: clampLevel((2 * v * (127 - pan)) / 127),
        right: clampLevel((2 * v * pan) / 127),
    };
}

/** Miles' F32 pan runs 0.0 left … 1.0 right; the S32 field runs 0 … 127. */
export function panLevelToPan127(level: number): number {
    return Math.max(0, Math.min(127, Math.round(clampLevel(level) * 127)));
}

/** The F32 pan an S32 pan field reads back as. */
export function pan127ToPanLevel(pan127: number): number {
    return clampLevel(Math.max(0, Math.min(127, pan127)) / 127);
}
