/**
 * Inter-stage semantic placement shared by both programmable stages.
 *
 * COLOR0/1 and TEXCOORD keep their historical slots; every other linkable SM3
 * declaration usage gets a stable generic interpolant slot. Both stages must
 * read the SAME table: a usage one stage places and the other drops turns a
 * legal vs/ps pair into a one-sided link.
 */

import { Usage } from "../sm-enums";

const GENERIC_SLOT_BASE: Record<number, number> = {
    [Usage.BLENDWEIGHT]: 8,
    [Usage.BLENDINDICES]: 9,
    [Usage.NORMAL]: 10,
    [Usage.PSIZE]: 11,
    [Usage.TANGENT]: 12,
    [Usage.BINORMAL]: 13,
    [Usage.TESSFACTOR]: 14,
    [Usage.FOG]: 8,
    [Usage.SAMPLE]: 15,
};

/** Generic interpolant slot for a usage that is neither COLOR0/1 nor TEXCOORD. */
export function genericInterpolantSlot(usage: number, usageIndex: number): number {
    return (GENERIC_SLOT_BASE[usage] ?? 8) + usageIndex;
}
