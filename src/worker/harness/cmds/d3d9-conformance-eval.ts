/**
 * The judgement half of the D3D9 lock/readback conformance scene: the mutation roster and
 * the pixel decode.
 *
 * Split from the scene so it can be unit-tested with no worker, no GPU and no guest — these
 * are the pieces that, wrong, would make the scene report a plausible verdict about
 * something other than what it claims. See `tools/tests/d3d9-conformance-scene.test.ts`.
 */

import { groupVerdict, type GroupVerdict } from "./conformance-verdict";

export interface ConformanceCheck {
    /** Stable row id — the mutation roster names these by prefix. */
    name: string;
    /** Where the statement comes from (Wine test or DXVK line). */
    source: string;
    expected: string;
    observed: string;
    pass: boolean;
    note?: string;
}

export type Mutation =
    | "no-lock-readback"
    | "discard-whole-surface"
    | "ignore-lock-flags"
    | "ignore-subrect"
    | "skip-clear";

/**
 * The injected bugs and the row groups each must break. A mutation that changes nothing is a
 * finding about the SCENE — the assertion is not watching what it claims — and the regression
 * scenario fails on it.
 */
export const MUTATIONS: Record<Mutation, { how: string; groups: string[] }> = {
    "no-lock-readback": {
        how: "setWorkerFlag('__noD3D9LockReadback') — the shipped kill switch: a LockRect is answered "
            + "from the guest bytes we already hold instead of the GPU round trip, which is what this "
            + "path did before the readback existed",
        groups: ["rtdata.", "rtlock."],
    },
    "discard-whole-surface": {
        how: "setWorkerFlag('__d3d9LockDiscardWholeSurface') — D3DLOCK_DISCARD is honoured at the "
            + "whole-surface extent even when the lock named a sub-rect",
        groups: ["lockflags.discardKeepsUnnamedPixels"],
    },
    "ignore-lock-flags": {
        how: "setWorkerFlag('__noD3D9LockFlags') — the shipped kill switch: the D3DLOCK_* word is "
            + "discarded as it was before, so READONLY no longer suppresses the write-back",
        groups: ["lockflags.readonlyDoesNotUpload"],
    },
    "ignore-subrect": {
        how: "the pRect argument of IDirect3DSurface9_LockRect is replaced by NULL, so pBits "
            + "addresses pixel (0,0) instead of the rect the scene asked for",
        groups: ["sublock."],
    },
    "skip-clear": {
        how: "IDirect3DDevice9_Clear returns D3D_OK without clearing anything",
        groups: ["rtdata.", "rtlock."],
    },
};

export function mutationVerdict(
    baseline: ConformanceCheck[],
    mutated: ConformanceCheck[],
    mutation: Mutation,
): GroupVerdict {
    return groupVerdict(MUTATIONS[mutation].groups, baseline, mutated);
}

/**
 * Decode a 32-bit [A|X]R8G8B8 surface word into 0x00RRGGBB.
 *
 * The scene reads the raw DWORD too, and every row prints it: our render targets live on the
 * GPU in the swap chain's own format, so a channel-order slip in the readback is a colour
 * that is exactly right in the wrong lanes. A row that printed only the decoded value would
 * report "expected red, observed blue" without saying that the bytes were the right bytes.
 */
export function decodeXrgb(raw: number): number {
    return raw & 0x00ffffff;
}

/** 0x00RRGGBB with the red and blue channels exchanged — the shape of a channel-order slip. */
export function swapRb(rgb: number): number {
    return (((rgb & 0xff) << 16) | (rgb & 0x00ff00) | ((rgb >>> 16) & 0xff)) >>> 0;
}
