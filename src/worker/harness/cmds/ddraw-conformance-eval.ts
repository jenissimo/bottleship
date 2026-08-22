/**
 * The judgement half of the DDraw read-lock conformance scene: pixel decoding, and whether an
 * injected bug was actually caught.
 *
 * Split from the scene itself so it can be unit-tested without a worker, a GPU or a guest —
 * these are the pieces that, wrong, would make the scene report a plausible verdict about
 * something other than what it claims: a decode that mis-expands a channel invents a colour
 * failure, and an inverted blind-group test turns "the mutation changed nothing" into a proof
 * that the assertion works. See `tools/tests/ddraw-conformance-scene.test.ts`.
 */

export interface PixelFormat { bpp: number; rMask: number; gMask: number; bMask: number; aMask: number }

export interface ConformanceCheck {
    /** Stable row id — the mutation roster names these. */
    name: string;
    /** Where in ddraw7.c the statement lives. */
    wine: string;
    expected: string;
    observed: string;
    pass: boolean;
    note?: string;
}

export type Mutation =
    | "stale-read-lock"
    | "noop-flip"
    | "ignore-subrect"
    | "skip-colorfill"
    | "allow-double-lock";

/**
 * The injected bugs, and the row groups each one must break. `groups` is a list of row-name
 * prefixes; a mutation is effective when at least one row in EVERY group it names fails.
 * (Not "all rows in the group": a stale serve that loses a race with its own readback can
 * answer a later probe correctly, and demanding otherwise would make the proof flaky.)
 */
export const MUTATIONS: Record<Mutation, { how: string; groups: string[] }> = {
    "stale-read-lock": {
        how: "setWorkerFlag('__noReadLockReadback') — the shipped read-lock divergence instrument: "
            + "a DDLOCK_READONLY Lock is answered from the CPU bytes we already hold instead of the GPU round trip",
        groups: ["flip3d.currentBackBuffer", "subrect1x1"],
    },
    "noop-flip": {
        how: "IDirectDrawSurface7_Flip returns DD_OK without rotating the chain",
        groups: ["flip3d.otherChainSlot"],
    },
    "ignore-subrect": {
        how: "the rect argument of IDirectDrawSurface7_Lock is replaced by NULL, so the lock covers the "
            + "whole surface and lpSurface addresses pixel (0,0)",
        groups: ["subrect1x1"],
    },
    "skip-colorfill": {
        how: "IDirectDrawSurface7_Blt returns DD_OK for a DDBLT_COLORFILL without filling anything",
        groups: ["colorfill.fullSurfaceLock", "subrect1x1"],
    },
    "allow-double-lock": {
        how: "a Lock that answered DDERR_SURFACEBUSY is reported as DD_OK",
        groups: ["lockExclusivity.secondLock"],
    },
};

/**
 * Verdict per group a mutation was supposed to break, judged against the CLEAN run.
 *
 * A group that was already failing before the mutation proves nothing: crediting the
 * mutation with it turns "the suite is red" into "every mutation is caught", which is the
 * failure mode this whole scene exists to prevent. Such a group is `unprovable`, and it is
 * neither a pass nor a miss — it is a statement that the baseline must be fixed first.
 */
export function mutationVerdict(
    baseline: ConformanceCheck[],
    mutated: ConformanceCheck[],
    mutation: Mutation,
): { caught: string[]; blind: string[]; unprovable: string[] } {
    const caught: string[] = [];
    const blind: string[] = [];
    const unprovable: string[] = [];
    for (const g of MUTATIONS[mutation].groups) {
        const before = baseline.filter((c) => c.name.startsWith(g));
        const passedBefore = before.filter((c) => c.pass);
        if (passedBefore.length === 0) { unprovable.push(g); continue; }
        const brokeOne = passedBefore.some(
            (b) => mutated.some((m) => m.name === b.name && !m.pass));
        (brokeOne ? caught : blind).push(g);
    }
    return { caught, blind, unprovable };
}

/** The groups a mutation was supposed to break and did not, judged against the clean run. */
export function blindGroups(
    baseline: ConformanceCheck[],
    mutated: ConformanceCheck[],
    mutation: Mutation,
): string[] {
    return mutationVerdict(baseline, mutated, mutation).blind;
}

const maskShift = (m: number): number => (m === 0 ? 0 : 31 - Math.clz32(m & -m));

/** Expand a masked channel to 8 bits. A full-range channel (0xff/0x3f/0x1f) round-trips exactly. */
export function channel8(value: number, mask: number): number {
    if (!mask) return 0;
    const shift = maskShift(mask);
    const max = mask >>> shift;
    return Math.round(((value & mask) >>> shift) * 255 / max);
}

/** Decode a raw pixel word into 0x00RRGGBB — what get_surface_color compares. */
export function decodeRgb(raw: number, fmt: PixelFormat): number {
    return ((channel8(raw, fmt.rMask) << 16) | (channel8(raw, fmt.gMask) << 8) | channel8(raw, fmt.bMask)) >>> 0;
}

/** Encode 0x00RRGGBB into the surface's own word — DDBLTFX.dwFillColor is in surface format. */
export function encodeRgb(rgb: number, fmt: PixelFormat): number {
    const enc = (c: number, mask: number): number => {
        if (!mask) return 0;
        const shift = maskShift(mask);
        const max = mask >>> shift;
        return (Math.round(c * max / 255) << shift) & mask;
    };
    return (enc((rgb >>> 16) & 0xff, fmt.rMask) | enc((rgb >>> 8) & 0xff, fmt.gMask) | enc(rgb & 0xff, fmt.bMask)) >>> 0;
}
