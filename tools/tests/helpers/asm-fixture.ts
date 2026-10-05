/**
 * Assemble a shader fixture with Microsoft's d3dx9 oracle and return the exact token stream.
 * The oracle import is deferred so ordinary cross-platform test discovery never dlopens a
 * Windows DLL.
 */

import { existsSync } from "node:fs";
import { parseShader, type SmProgram } from "../../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

export type AsmFixture = SmProgram & { readonly tokens: Uint32Array };

const DEFAULT_DLL = "C:\\Windows\\System32\\d3dx9_43.dll";

export function d3dxOraclePath(): string {
    return process.env.BS_D3DX9 ?? DEFAULT_DLL;
}

let noticeEmitted = false;

/**
 * A skipped suite is invisible in bun's summary, so a machine without the DLL
 * reports full success on a run that had no oracle coverage at all. Say so once
 * per process. (Announced at the first skip rather than aggregated at exit: bun
 * runs neither `process.on("exit")` nor a timer that outlives the file which
 * scheduled it, so a deferred total would be printed early and be wrong.)
 */
function noteSkippedSuite(): void {
    if (noticeEmitted) return;
    noticeEmitted = true;
    console.warn(
        `[d3dx9-oracle] UNAVAILABLE at ${d3dxOraclePath()} — every d3dx9-gated suite in this ` +
        `run is SKIPPED. Set BS_REQUIRE_D3DX9=1 to make an absent oracle a failure.`,
    );
}

export function d3dxOracleAvailable(): boolean {
    const available = process.platform === "win32" && existsSync(d3dxOraclePath());
    // Keep the normal cross-platform suite discoverable, but let CI turn an absent
    // native oracle into a hard failure instead of silently converting coverage to skips.
    if (!available && process.env.BS_REQUIRE_D3DX9 !== "1") noteSkippedSuite();
    return available || process.env.BS_REQUIRE_D3DX9 === "1";
}

/** Test-only gate for suites whose contract is explicitly the real Windows DLL. */
export function requireD3dxOracle(): void {
    if (!d3dxOracleAvailable()) {
        throw new Error(`d3dx9 oracle unavailable at ${d3dxOraclePath()}; gate this test on d3dxOracleAvailable()`);
    }
}

/** Assemble source with tools/d3dx-oracle.ts and return the parsed program plus exact tokens. */
export async function asmFixture(source: string): Promise<AsmFixture> {
    requireD3dxOracle();
    const { assemble } = await import("../../d3dx-oracle");
    const result = assemble(source);
    if (!result.tokens) {
        throw new Error(`d3dx9 oracle rejected fixture (hr=0x${(result.hr >>> 0).toString(16)}): ${result.error ?? "unknown error"}`);
    }
    const program = parseShader(result.tokens);
    return Object.assign(program, { tokens: result.tokens });
}

export const assembleAsmFixture = asmFixture;
