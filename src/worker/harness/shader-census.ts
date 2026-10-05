/**
 * One collector for the D3D9 shader instrumentation, shared by the `shaderOps`/`d3d9Census`
 * verbs and by harness.report().
 *
 * `complete` is the load-bearing field: it must be false when a device's snapshot THREW and
 * when there is no D3D9 device at all — a DDraw/D3D8 title otherwise reports a complete shader
 * census (`[].every(...)` is true) and a reader concludes the programmable path is clean.
 */

import { devices as d3d9Devices } from "../modules/d3d9/shared-state";

export interface ShaderCensusCollection {
    /** One entry per device; a failed one carries `instrumentationAvailable:false` + `error`. */
    snapshots: Array<Record<string, unknown>>;
    deviceCount: number;
    /** Devices whose snapshot threw or exposes no instrumentation seam. */
    snapshotFailures: number;
}

export function collectShaderCensus(reset: boolean): ShaderCensusCollection {
    const snapshots: Array<Record<string, unknown>> = [];
    let deviceCount = 0;
    let snapshotFailures = 0;
    for (const [device, instance] of d3d9Devices) {
        deviceCount++;
        const instrumentation = instance as unknown as {
            shaderInstrumentationSnapshot?: (reset: boolean) => Record<string, unknown>;
        };
        if (typeof instrumentation.shaderInstrumentationSnapshot !== "function") {
            snapshotFailures++;
            snapshots.push({
                device: device >>> 0,
                instrumentationAvailable: false,
                error: "D3D9 device does not expose shader instrumentation",
            });
            continue;
        }
        try {
            snapshots.push({ device: device >>> 0, ...instrumentation.shaderInstrumentationSnapshot.call(instance, reset) });
        } catch (error) {
            snapshotFailures++;
            snapshots.push({
                device: device >>> 0,
                instrumentationAvailable: false,
                error: `shader instrumentation snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    return { snapshots, deviceCount, snapshotFailures };
}

/** A census covers something only if a device answered and none of them failed. */
export function censusComplete(c: ShaderCensusCollection): boolean {
    return c.deviceCount > 0 && c.snapshotFailures === 0;
}
