import { readFile } from "node:fs/promises";
import {
    buildD3D9ProbeManifest,
    compareD3D9Capture,
    normalizeD3D9Capture,
    validateD3D9Capture,
    type D3D9Capture,
} from "./probe-oracle";

function usage(): never {
    console.error("usage: bun tools/d3d9-parity/compare-capture.ts <capture.json>");
    console.error("       bun tools/d3d9-parity/compare-capture.ts --reporting <capture.json>");
    console.error("capture schema: { schema: 1, target: 'native-d3d9'|'dxvk', source, environment, probes: { id: result } }");
    console.error("format/msaa result schema: { supported: boolean, qualityLevels: number }");
    process.exit(2);
}

const args = process.argv.slice(2);
const reporting = args.includes("--reporting") || args.includes("--report");
const paths = args.filter(arg => arg !== "--reporting" && arg !== "--report");
const path = paths[0];
if (!path || path === "--help" || path === "-h" || paths.length !== 1) usage();

function emitReport(report: Record<string, unknown>): never {
    console.log(JSON.stringify(report, null, 2));
    process.exit(reporting ? 0 : Number(report.valid === true ? 0 : 1));
}

let capture: D3D9Capture;
try {
    capture = JSON.parse(await readFile(path, "utf8")) as D3D9Capture;
} catch (error) {
    const reason = `cannot read capture ${path}: ${error instanceof Error ? error.message : String(error)}`;
    if (reporting) emitReport({ schema: 1, gate: "d3d9-parity-capture", status: "unavailable", valid: false, reason });
    console.error(reason);
    process.exit(2);
}

const shapeErrors = validateD3D9Capture(capture!);
if (shapeErrors.length > 0) {
    if (reporting) emitReport({
        schema: 1, gate: "d3d9-parity-capture", status: "invalid", valid: false,
        errors: shapeErrors,
    });
    console.error(shapeErrors.join("\n"));
    process.exit(2);
}

// Native captures retain the lossless 304-byte caps blob. Decode it field by
// field here into the same typed observation used by the local oracle; the
// normalizer is target-agnostic so DXVK captures use the identical path.
const normalizedCapture = normalizeD3D9Capture(capture!);
const comparison = compareD3D9Capture(buildD3D9ProbeManifest(), normalizedCapture);
emitReport({
    schema: 1,
    gate: "d3d9-parity-capture",
    status: comparison.valid ? "pass" : "mismatch",
    target: normalizedCapture.target,
    valid: comparison.valid,
    missing: comparison.missing,
    extra: comparison.extra,
    errors: comparison.errors,
    mismatches: comparison.mismatches.map(row => ({
        id: row.id,
        expected: row.expected,
        observed: row.observed,
    })),
});
