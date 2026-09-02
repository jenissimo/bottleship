import { RenderCommandType, type RenderFrame } from "../render-frame";
import { ArenaCommandType } from "./d3d9-wasm-arena";

/** Read-only subset of D3D9WasmArena used by the census and by its synthetic tests. */
export interface D3D9MegaBatchArenaReader {
    getCommandCount(): number;
    getCommandTypes(): ArrayLike<number>;
    getCommandA(): ArrayLike<number>;
    getCommandB(): ArrayLike<number>;
    getCommandC(): ArrayLike<number>;
    readCompactWbufRun?(offset: number): {
        pairCount: number;
        indexCount: number;
        startIndex: number;
        baseVertex: number;
        storageReady: boolean;
    };
}

/**
 * Additive eligibility totals. `groupDraws/groupCount` is kept instead of summing rounded
 * per-frame means, so a multi-frame d3d9Perf snapshot reports the exact weighted mean.
 *
 * This is deliberately only a census: a "physical draw" here is what the MegaBatch
 * instance-index/storage-constant lowering would issue. No RenderFrame or arena state is
 * modified.
 */
export interface D3D9MegaBatchCensus {
    frames: number;
    arenaRuns: number;
    logicalArenaIndexedDraws: number;
    decodedArenaIndexedDraws: number;
    estimatedPhysicalDraws: number;
    eligibleLogicalDraws: number;
    exactGroups: number;
    eligibleGroups: number;
    groupDraws: number;
    maxGroupSize: number;
    differentArgsBreaks: number;
    runBoundaryBreaks: number;
    guestInstancingVetoRuns: number;
    guestInstancingVetoDraws: number;
    malformedVetoRuns: number;
    malformedVetoDraws: number;
}

export function createD3D9MegaBatchCensus(): D3D9MegaBatchCensus {
    return {
        frames: 0,
        arenaRuns: 0,
        logicalArenaIndexedDraws: 0,
        decodedArenaIndexedDraws: 0,
        estimatedPhysicalDraws: 0,
        eligibleLogicalDraws: 0,
        exactGroups: 0,
        eligibleGroups: 0,
        groupDraws: 0,
        maxGroupSize: 0,
        differentArgsBreaks: 0,
        runBoundaryBreaks: 0,
        guestInstancingVetoRuns: 0,
        guestInstancingVetoDraws: 0,
        malformedVetoRuns: 0,
        malformedVetoDraws: 0,
    };
}

/** Add one finalized frame's eligibility into `totals`. Arena runs are atomic boundaries:
 * the scan never attempts to join draws across another RenderFrame command (query, dynamic
 * state, clear, target switch, etc.). */
export function censusD3D9MegaBatchFrame(
    frame: Pick<RenderFrame, "commandTypes" | "commandA" | "commandD" | "arenaIndexedRuns">,
    arena: D3D9MegaBatchArenaReader,
    totals: D3D9MegaBatchCensus = createD3D9MegaBatchCensus(),
): D3D9MegaBatchCensus {
    totals.frames++;

    const arenaCount = arena.getCommandCount();
    const types = arena.getCommandTypes();
    const a = arena.getCommandA();
    const b = arena.getCommandB();
    const c = arena.getCommandC();
    let seenRun = false;

    for (let command = 0; command < frame.commandTypes.length; command++) {
        if (frame.commandTypes[command] !== RenderCommandType.DrawIndexedArenaRun) continue;

        totals.arenaRuns++;
        if (seenRun) totals.runBoundaryBreaks++;
        seenRun = true;

        const run = frame.arenaIndexedRuns[frame.commandA[command]! >>> 0];
        const expected = run && Number.isSafeInteger(run.expectedPairCount) && run.expectedPairCount > 0
            ? run.expectedPairCount : 0;
        const expectedLogical = expected + (run?.prefixVsBits ? 1 : 0);
        totals.logicalArenaIndexedDraws += expectedLogical;

        // commandD is currently zero for arena-run commands (implicit one instance). Reading a
        // future non-zero value makes guest instancing fail closed instead of producing an
        // optimistic estimate if the RenderFrame ABI grows before this diagnostic does.
        const encodedInstances = frame.commandD[command] ?? 0;
        const instanceCount = encodedInstances === 0 ? 1 : encodedInstances;
        if (!Number.isSafeInteger(instanceCount) || instanceCount !== 1) {
            totals.guestInstancingVetoRuns++;
            totals.guestInstancingVetoDraws += expectedLogical;
            totals.estimatedPhysicalDraws += expectedLogical;
            continue;
        }

        // Compact/storage runs intentionally own no legacy command rows. Decode their
        // descriptor instead of classifying the empty range as malformed. The descriptor
        // carries one exact indexed shape and is therefore one physical group.
        if (run && expected > 0 && run.compactDescriptorOffset >= 0) {
            let compact: ReturnType<NonNullable<D3D9MegaBatchArenaReader["readCompactWbufRun"]>> | null = null;
            try {
                compact = arena.readCompactWbufRun?.(run.compactDescriptorOffset) ?? null;
            } catch {
                compact = null;
            }
            if (!compact || compact.pairCount !== expected
                || !Number.isSafeInteger(compact.indexCount) || compact.indexCount <= 0
                || !Number.isSafeInteger(compact.startIndex) || compact.startIndex < 0
                || !Number.isSafeInteger(compact.baseVertex)) {
                totals.malformedVetoRuns++;
                totals.malformedVetoDraws += expectedLogical;
                totals.estimatedPhysicalDraws += expectedLogical;
                continue;
            }
            totals.decodedArenaIndexedDraws += expected;
            totals.exactGroups++;
            if (expectedLogical >= 2) {
                totals.eligibleGroups++;
                totals.eligibleLogicalDraws += expectedLogical;
            }
            totals.groupDraws += expectedLogical;
            totals.estimatedPhysicalDraws++;
            if (expectedLogical > totals.maxGroupSize) totals.maxGroupSize = expectedLogical;
            continue;
        }

        if (!run || expected === 0
            || !Number.isSafeInteger(run.arenaCommandStart)
            || !Number.isSafeInteger(run.arenaCommandEnd)
            || run.arenaCommandStart < 0 || run.arenaCommandEnd > arenaCount
            || run.arenaCommandStart >= run.arenaCommandEnd) {
            totals.malformedVetoRuns++;
            totals.malformedVetoDraws += expectedLogical;
            totals.estimatedPhysicalDraws += expectedLogical;
            continue;
        }

        let malformed = false;
        let hasBinding = false;
        let decoded = 0;
        let groupSize = 0;
        let runGroups = 0;
        let runEligibleGroups = 0;
        let runEligibleDraws = 0;
        let runMaxGroup = 0;
        let runDifferentArgsBreaks = 0;
        let lastA = 0;
        let lastB = 0;
        let lastC = 0;
        let prefixPending = !!run.prefixVsBits;

        const finishGroup = (): void => {
            if (groupSize === 0) return;
            runGroups++;
            if (groupSize >= 2) {
                runEligibleGroups++;
                runEligibleDraws += groupSize;
            }
            if (groupSize > runMaxGroup) runMaxGroup = groupSize;
            groupSize = 0;
        };

        for (let row = run.arenaCommandStart; row < run.arenaCommandEnd; row++) {
            const type = types[row];
            if (type === ArenaCommandType.BindProgrammable) {
                hasBinding = true;
                continue;
            }
            if (type !== ArenaCommandType.DrawIndexed) {
                if (type !== ArenaCommandType.SetPipeline
                    && type !== ArenaCommandType.SetVertexBuffer
                    && type !== ArenaCommandType.SetIndexBuffer) {
                    malformed = true;
                    break;
                }
                continue;
            }
            if (!hasBinding) {
                malformed = true;
                break;
            }

            const drawA = a[row]! >>> 0;
            const drawB = b[row]! >>> 0;
            const drawC = c[row]! | 0;
            if (groupSize !== 0 && (drawA !== lastA || drawB !== lastB || drawC !== lastC)) {
                finishGroup();
                runDifferentArgsBreaks++;
            }
            if (groupSize === 0) {
                lastA = drawA;
                lastB = drawB;
                lastC = drawC;
            }
            if (prefixPending) {
                groupSize++;
                prefixPending = false;
            }
            groupSize++;
            decoded++;
        }
        finishGroup();

        // The executor also requires exact producer/decoder pair parity. Treat the whole run
        // as non-batchable on any discrepancy; partial grouping would overstate safe coverage.
        if (malformed || decoded !== expected) {
            totals.malformedVetoRuns++;
            totals.malformedVetoDraws += expectedLogical;
            totals.estimatedPhysicalDraws += expectedLogical;
            continue;
        }

        totals.decodedArenaIndexedDraws += decoded;
        totals.exactGroups += runGroups;
        totals.eligibleGroups += runEligibleGroups;
        totals.eligibleLogicalDraws += runEligibleDraws;
        totals.groupDraws += decoded;
        totals.estimatedPhysicalDraws += runGroups;
        totals.differentArgsBreaks += runDifferentArgsBreaks;
        if (runMaxGroup > totals.maxGroupSize) totals.maxGroupSize = runMaxGroup;
    }

    return totals;
}

/** Flat numeric fields merge directly into dbg.d3d9Perf().backend. */
export function d3d9MegaBatchCensusMetrics(census: D3D9MegaBatchCensus): Record<string, number> {
    return {
        megaBatchCensusFrames: census.frames,
        megaBatchArenaRuns: census.arenaRuns,
        megaBatchLogicalArenaIndexedDraws: census.logicalArenaIndexedDraws,
        megaBatchDecodedArenaIndexedDraws: census.decodedArenaIndexedDraws,
        megaBatchEstimatedPhysicalDraws: census.estimatedPhysicalDraws,
        megaBatchEligibleLogicalDraws: census.eligibleLogicalDraws,
        megaBatchExactGroups: census.exactGroups,
        megaBatchEligibleGroups: census.eligibleGroups,
        megaBatchMaxGroupSize: census.maxGroupSize,
        megaBatchMeanGroupSize: census.exactGroups === 0 ? 0 : census.groupDraws / census.exactGroups,
        megaBatchEligibleMeanGroupSize: census.eligibleGroups === 0
            ? 0 : census.eligibleLogicalDraws / census.eligibleGroups,
        megaBatchDifferentArgsBreaks: census.differentArgsBreaks,
        megaBatchRunBoundaryBreaks: census.runBoundaryBreaks,
        megaBatchGuestInstancingVetoRuns: census.guestInstancingVetoRuns,
        megaBatchGuestInstancingVetoDraws: census.guestInstancingVetoDraws,
        megaBatchMalformedVetoRuns: census.malformedVetoRuns,
        megaBatchMalformedVetoDraws: census.malformedVetoDraws,
    };
}
