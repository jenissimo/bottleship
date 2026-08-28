/**
 * Shader diagnostics for the programmable D3D9 path.
 *
 * These verbs read the device's private registries through narrow diagnostic seams. Opcode
 * status comes from the emitters' own census (LinkResult.census), so a shader that was never
 * linked reports dispatched=0 rather than a clean bill of health, and `attribution` says
 * whether an empty draw count means "no programmable draw" or "the draw was not attributed".
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { devices as d3d9Devices } from "../../modules/d3d9/shared-state";
import { getD3D9PerfSnapshot, resetD3D9Perf } from "../../modules/d3d9/d3d9-perf";
import { collectShaderCensus, censusComplete } from "../shader-census";
import type { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";

interface WgslDiagnostic {
    type: string;
    message: string;
    lineNum: number;
    linePos: number;
    offset: number;
    length: number;
}

function currentGpuDevice(): GPUDevice {
    const backend = sys().services.render.getBackend() as WebGPUBackend | null;
    if (!backend || backend.kind !== "webgpu") {
        throw new HarnessError("no WebGPU backend (no render device created yet)", HarnessErrorCode.UNSUPPORTED);
    }
    const device = backend.getDevice();
    if (!device) {
        throw new HarnessError("WebGPU device is not available", HarnessErrorCode.UNSUPPORTED);
    }
    return device;
}

function numberField(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeCompilationMessage(message: unknown): WgslDiagnostic {
    const raw = (message ?? {}) as Record<string, unknown>;
    const type = typeof raw.type === "string" ? raw.type : "error";
    return {
        type,
        message: String(raw.message ?? "WebGPU returned an empty compilation message"),
        lineNum: numberField(raw.lineNum),
        linePos: numberField(raw.linePos),
        offset: numberField(raw.offset),
        length: numberField(raw.length),
    };
}

function syntheticDiagnostic(error: unknown): WgslDiagnostic {
    return {
        type: "error",
        message: `WGSL compilation check threw synchronously: ${error instanceof Error ? error.message : String(error)}`,
        lineNum: 0,
        linePos: 0,
        offset: 0,
        length: 0,
    };
}

async function checkWgsl(source: string): Promise<Record<string, unknown>> {
    if (!source.trim()) {
        return { ok: false, messages: [syntheticDiagnostic(new Error("WGSL source is empty"))] };
    }

    const device = currentGpuDevice();
    try {
        const module = device.createShaderModule({ code: source });
        const info = await module.getCompilationInfo();
        const messages = Array.isArray(info.messages)
            ? info.messages.map(normalizeCompilationMessage)
            : [syntheticDiagnostic(new Error("GPUCompilationInfo.messages was not an array"))];
        return {
            ok: !messages.some((message) => message.type === "error"),
            messages,
        };
    } catch (error) {
        return { ok: false, messages: [syntheticDiagnostic(error)] };
    }
}

function snapshotShaderOps(reset: boolean): Record<string, unknown> {
    const collection = collectShaderCensus(reset);
    const snapshots = collection.snapshots;
    const shaders: Array<Record<string, unknown>> = [];
    const pairs: Array<Record<string, unknown>> = [];
    for (const snapshot of snapshots) {
        const device = snapshot.device as number;
        for (const shader of (snapshot.shaders as Array<Record<string, unknown>>) ?? []) {
            shaders.push({ device, ...shader });
        }
        for (const pair of (snapshot.pairs as Array<Record<string, unknown>>) ?? []) {
            pairs.push({ device, ...pair });
        }
    }
    const unsupported = shaders.reduce((sum, shader) => sum + Number(shader.unsupportedCount ?? 0), 0);
    const approximated = shaders.reduce((sum, shader) => sum + Number(shader.approximatedCount ?? 0), 0);
    const drawsIssued = pairs.reduce((sum, pair) => sum + Number(pair.drawsIssued ?? 0), 0);
    const dispatched = shaders.reduce((sum, shader) => sum + Number(shader.dispatched ?? 0), 0);
    const attributionOf = (field: string): number => snapshots.reduce(
        (sum, snapshot) => sum + Number((snapshot.attribution as Record<string, unknown> | undefined)?.[field] ?? 0), 0);
    return {
        instrumentationVersion: 2,
        census: {
            complete: censusComplete(collection),
            deviceCount: collection.deviceCount,
            snapshotFailures: collection.snapshotFailures,
            source: "emitter-dispatch",
            note: "opcode status is recorded at the emitter's own dispatch; dispatched=0 means the shader was never linked, NOT that it is clean",
        },
        devices: snapshots,
        shaders,
        pairs,
        unsupported,
        approximated,
        dispatched,
        drawsIssued,
        attribution: {
            programmableDraws: attributionOf("programmableDraws"),
            unattributed: attributionOf("unattributed"),
        },
    };
}

export function registerShaderCommands(svc: HarnessService): void {
    /** wgslCheck({wgsl}) — compile with the live WebGPU device and return normalized diagnostics. */
    svc.register("wgslCheck", async (args) => {
        const value = args[0];
        const source = typeof value === "string" ? value : String((value as { wgsl?: unknown } | null)?.wgsl ?? "");
        return checkWgsl(source);
    });

    /** shaderOps({reset?}) — compiled shader opcode sidecars and programmable draw counts.
     *  CAVEAT: the device seam (d3d9-device.shaderInstrumentationSnapshot) zeroes drawsIssued
     *  BEFORE building its arrays, so `{reset:true}` reports 0 draws for the window it is
     *  summarizing. Ask without `reset` until that seam reads first. */
    svc.register("shaderOps", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        return snapshotShaderOps(!!opts.reset);
    });

    /** d3d9Census({reset?}) — one ledger for refusals, unsupported ops and approximations.
     *  `reset` zeroes AFTER reading: resetting first answers "what did this scene drop?" with
     *  zeros, which reads as a clean frame. */
    svc.register("d3d9Census", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        const perf = getD3D9PerfSnapshot();
        const shaders = snapshotShaderOps(!!opts.reset);
        if (opts.reset) resetD3D9Perf();
        return {
            dropDraws: { ...perf.droppedDraws },
            ffpUnimplemented: { ...perf.ffpUnimplemented },
            approximated: { ...perf.approximated },
            formatSupport: perf.formatSupport,
            shaderUnsupported: Number(shaders.unsupported ?? 0),
            shaderApproximated: Number(shaders.approximated ?? 0),
            shaderCensus: shaders.census,
        };
    });

    /** dropDraws({reset?}) — the small, direct view of the draw-refusal histogram. */
    svc.register("dropDraws", (args) => {
        const opts = (args[0] ?? {}) as { reset?: boolean };
        const dropDraws = { ...getD3D9PerfSnapshot().droppedDraws };
        if (opts.reset) resetD3D9Perf();   // read first: a reset-then-read answers every scene with zeros
        return { dropDraws };
    });

    /** shaderWgsl({handle}) — retrieve one saved VS/PS module, even after a failed build. */
    svc.register("shaderWgsl", (args) => {
        const value = args[0];
        const rawHandle = typeof value === "object" && value !== null
            ? (value as { handle?: unknown }).handle
            : value;
        const handle = Number(rawHandle);
        if (!Number.isSafeInteger(handle) || handle <= 0) {
            throw new HarnessError("shaderWgsl requires a positive instrumentation handle", HarnessErrorCode.BAD_ARGS);
        }
        for (const [device, instance] of d3d9Devices) {
            const instrumentation = instance as unknown as {
                shaderInstrumentationWgsl?: (handle: number) => Record<string, unknown> | null;
            };
            if (typeof instrumentation.shaderInstrumentationWgsl !== "function") continue;
            const result = instrumentation.shaderInstrumentationWgsl.call(instance, handle);
            if (result) return { device: device >>> 0, ...result };
        }
        throw new HarnessError(`shader instrumentation handle ${handle} not found`, HarnessErrorCode.NOT_FOUND);
    });
}
