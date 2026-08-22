/**
 * Whether an injected bug was actually CAUGHT, judged against the clean run.
 *
 * Shared by every conformance scene: a row that was already red before the mutation proves
 * nothing, and crediting the mutation with it turns "the suite is red" into "every mutation
 * is caught" — the exact failure mode the scenes exist to prevent. Such a group is
 * `unprovable`: neither a pass nor a miss, but a statement that the baseline comes first.
 */

/** The only shape the verdict needs from a conformance row. */
export interface VerdictRow {
    name: string;
    pass: boolean;
}

export interface GroupVerdict {
    caught: string[];
    blind: string[];
    unprovable: string[];
}

/**
 * `groups` are row-name PREFIXES. A mutation is effective for a group when at least one row
 * in it that was green goes red — not "all rows": a stale serve that loses a race with its
 * own readback can still answer a later probe correctly, and demanding otherwise would make
 * the proof flaky.
 */
export function groupVerdict(
    groups: readonly string[],
    baseline: readonly VerdictRow[],
    mutated: readonly VerdictRow[],
): GroupVerdict {
    const caught: string[] = [];
    const blind: string[] = [];
    const unprovable: string[] = [];
    for (const g of groups) {
        const passedBefore = baseline.filter((c) => c.name.startsWith(g) && c.pass);
        if (passedBefore.length === 0) { unprovable.push(g); continue; }
        const brokeOne = passedBefore.some(
            (b) => mutated.some((m) => m.name === b.name && !m.pass));
        (brokeOne ? caught : blind).push(g);
    }
    return { caught, blind, unprovable };
}
