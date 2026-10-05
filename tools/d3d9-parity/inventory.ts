/**
 * Executable D3D9 surface inventory.
 *
 * The descriptor is the ABI authority and the assembled D3D9 module is the
 * runtime authority.  Keeping the two inputs in one inventory prevents a new
 * COM method from silently falling through the generic dispatcher when the
 * descriptor grows.  This is intentionally independent of a live WebGPU
 * adapter; runtime/render probes layer on top of this surface census.
 */

import { d3d9Module } from "../../src/worker/api/d3d9.api";
import { D3D9 } from "../../src/worker/modules/d3d9/index";
import { buildD3D9ProbeManifest, type D3D9ProbeManifest } from "./probe-oracle";

export type D3D9MethodStatus = "implemented" | "refused" | "dispatcher-fallback";

export interface D3D9MethodInventoryRow {
    interface: string;
    name: string;
    argCount: number;
    status: D3D9MethodStatus;
    /** Explicit HRESULT contract for intentional refusals; absent for successes. */
    refusalHresult?: number;
    /** Local evidence anchor for the refusal policy. */
    evidence?: string;
}

export interface D3D9Inventory {
    schema: 1;
    module: "d3d9";
    descriptorVersion: string;
    methods: D3D9MethodInventoryRow[];
    functions: Array<{ name: string; argCount: number; status: D3D9MethodStatus }>;
    counts: {
        interfaces: number;
        methods: number;
        implemented: number;
        refused: number;
        dispatcherFallback: number;
    };
    /** Deterministic local oracle plus explicit native/DXVK capture work. */
    parity: D3D9ProbeManifest;
}

/** Ex-only APIs with no WebGPU equivalent. They are deliberately surfaced as
 * refusals, never allowed to look like a successful generic stub. */
const EXPLICIT_REFUSALS = new Map<string, { hresult: number; evidence: string }>([
    ["IDirect3DDevice9Ex_SetConvolutionMonoKernel", {
        hresult: 0x8876086c, evidence: "src/worker/modules/d3d9/ex.ts:SetConvolutionMonoKernel-invalidcall",
    }],
]);

function makeRuntimeExports(): Record<string, unknown> {
    const runtime = new D3D9();
    // Initialization only assembles export tables.  Fast paths are not needed
    // for inventory and a no-op registrar keeps this probe adapter-free.
    runtime.initialize({
        dispatcher: { registerFastPath: () => undefined },
    } as any);
    return runtime.exports as Record<string, unknown>;
}

function statusFor(name: string, exports: Record<string, unknown>): D3D9MethodStatus {
    if (EXPLICIT_REFUSALS.has(name)) return "refused";
    return typeof exports[name] === "function" ? "implemented" : "dispatcher-fallback";
}

export function buildD3D9Inventory(): D3D9Inventory {
    const runtimeExports = makeRuntimeExports();
    const methods: D3D9MethodInventoryRow[] = [];
    for (const iface of d3d9Module.interfaces ?? []) {
        for (const method of iface.methods) {
            const name = `${iface.name}_${method.name}`;
            const status = statusFor(name, runtimeExports);
            const refusal = EXPLICIT_REFUSALS.get(name);
            methods.push({
                interface: iface.name,
                name,
                argCount: method.params.length,
                status,
                ...(refusal ? { refusalHresult: refusal.hresult, evidence: refusal.evidence } : {}),
            });
        }
    }

    const functions = (d3d9Module.functions ?? []).map(fn => {
        const status = statusFor(fn.name, runtimeExports);
        const refusal = EXPLICIT_REFUSALS.get(fn.name);
        return {
            name: fn.name,
            argCount: fn.params.length,
            status,
            ...(refusal ? { refusalHresult: refusal.hresult, evidence: refusal.evidence } : {}),
        };
    });
    const implemented = methods.filter(m => m.status === "implemented").length +
        functions.filter(f => f.status === "implemented").length;
    const refused = methods.filter(m => m.status === "refused").length +
        functions.filter(f => f.status === "refused").length;
    const dispatcherFallback = methods.filter(m => m.status === "dispatcher-fallback").length +
        functions.filter(f => f.status === "dispatcher-fallback").length;
    const parity = buildD3D9ProbeManifest();

    return {
        schema: 1,
        module: "d3d9",
        descriptorVersion: d3d9Module.version ?? "unknown",
        methods,
        functions,
        counts: {
            interfaces: d3d9Module.interfaces?.length ?? 0,
            methods: methods.length,
            implemented,
            refused,
            dispatcherFallback,
        },
        parity,
    };
}
