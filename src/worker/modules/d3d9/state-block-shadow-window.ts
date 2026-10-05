/**
 * The guest-side setter shadows must not skip while a state block is RECORDING.
 *
 * A shadowed setter's trampoline RETs in guest code when the incoming value equals its shadow
 * slot — no ring entry, no JS. During BeginStateBlock..EndStateBlock the device journals
 * setters instead of applying them, and the shadow is deliberately kept in lock-step with the
 * device's tracked value, so a guest that records a setter at the value the device ALREADY
 * HOLDS has that call elided in guest code and the entry never reaches the block. Real D3D9
 * records every Set* issued while recording, unconditionally; a later Apply under different
 * device state then fails to restore that state.
 *
 * The window closes the gate instead of teaching each setter about recording: every shadow
 * trampoline (and the EAGL WASM replica, which reads the same word through
 * `ownerGlobalAddr` on every call) skips only while the owner gate holds the calling device,
 * so zeroing it routes every setter to the ring for the whole window. Correct-and-slower is
 * the right failure direction — an unbalanced Begin leaves skipping OFF, never on.
 *
 * The counter below is the part that outlives the fix. The symptom is a block silently missing
 * an entry: no error, no dropped draw, just a state that fails to restore later. `elided` is
 * the number of setters skipped in guest code between a Begin and its End, and after this fix
 * it can only be 0 — but it reads the SAME guest skip counters the trampolines and the EAGL
 * path bump, so it would have read non-zero before it, and will again if the gate is ever
 * left armed.
 */

import { System } from '../../core/system';

type ShadowDispatcher = {
    setShadowOwner?: (ptr: number) => void;
    getShadowStats?: () => Record<string, number>;
};

function dispatcher(): ShadowDispatcher | null {
    try {
        return (System.getInstance().process?.dispatcher as ShadowDispatcher) ?? null;
    } catch {
        return null;
    }
}

/** Skip counters at each open window's Begin, keyed by the recording device. */
const openWindows = new Map<number, Record<string, number>>();

let windows = 0;
let elided = 0;
const elidedBySetter: Record<string, number> = {};

/**
 * Open the recording window: disarm the shadow owner gate so no setter can be elided, and
 * snapshot the guest skip counters so the instrument can say whether one was.
 */
export function beginStateBlockShadowWindow(devicePtr: number): void {
    const d = dispatcher();
    if (!d) return;
    openWindows.set(devicePtr >>> 0, { ...(d.getShadowStats?.() ?? {}) });
    d.setShadowOwner?.(0);
}

/**
 * Close it: count anything elided while the block was recording (0 is the only correct
 * answer), then re-arm the gate for the device that was recording. Call at the point the
 * DEVICE stopped recording, not at the end of the export — a failure after that point still
 * leaves the device applying setters normally.
 */
export function endStateBlockShadowWindow(devicePtr: number): void {
    const d = dispatcher();
    if (!d) return;
    const key = devicePtr >>> 0;
    const before = openWindows.get(key);
    if (before) {
        openWindows.delete(key);
        windows++;
        const after = d.getShadowStats?.() ?? {};
        for (const [setter, end] of Object.entries(after)) {
            const delta = (end >>> 0) - ((before[setter] ?? 0) >>> 0);
            if (delta > 0) {
                elided += delta;
                elidedBySetter[setter] = (elidedBySetter[setter] ?? 0) + delta;
            }
        }
    }
    d.setShadowOwner?.(key);
}

/**
 * Readout. `elided > 0` means a setter was skipped in guest code while a block was recording,
 * i.e. that block is missing an entry the guest issued. `windows: 0` means no block was
 * recorded in the sampled period — not that none leaked.
 */
export function d3d9StateBlockShadowStats(reset = false): {
    windows: number;
    openWindows: number;
    elided: number;
    elidedBySetter: Record<string, number>;
    verdict: string;
} {
    const out = {
        windows,
        openWindows: openWindows.size,
        elided,
        elidedBySetter: { ...elidedBySetter },
        verdict: windows === 0
            ? 'no state block recorded in this window'
            : (elided === 0
                ? 'clean: nothing elided while recording'
                : 'LEAK: a recorded block is missing setters the guest issued'),
    };
    if (reset) {
        windows = 0;
        elided = 0;
        for (const k of Object.keys(elidedBySetter)) delete elidedBySetter[k];
    }
    return out;
}

/** Test hook: forget every open window and counter. */
export function resetStateBlockShadowWindowForTests(): void {
    openWindows.clear();
    windows = 0;
    elided = 0;
    for (const k of Object.keys(elidedBySetter)) delete elidedBySetter[k];
}
