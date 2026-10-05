import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Capability evidence for an offline WGSL parser/validator.
 *
 * `@webgpu/types` is intentionally not treated as a validator: it contains
 * declarations only.  A validator is accepted only after it rejects a
 * deliberately malformed module and accepts a deliberately valid module.
 * The command is argv-based, never shell-evaluated.
 */
export interface WgslValidatorCapability {
    schema: 1;
    available: boolean;
    validator: string | null;
    protocol: "path-argv-v1" | null;
    reason: string;
    searched: string[];
}

export interface WgslValidationResult {
    schema: 1;
    status: "passed" | "rejected" | "skipped";
    passed: boolean;
    reason: string;
    diagnostics?: string;
}

interface ValidatorRunnerResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: string;
}

interface ProbeOptions {
    /** Override the environment for deterministic tests and CI wrappers. */
    environment?: Record<string, string | undefined>;
    /** Explicit executable candidates. An empty list disables PATH discovery. */
    candidates?: string[];
    /** Set false to avoid PATH discovery; useful for a capability-only test. */
    searchPath?: boolean;
    runner?: (executable: string, sourcePath: string) => ValidatorRunnerResult;
}

const VALID_WGSL = `@compute @workgroup_size(1) fn main() {}`;
const INVALID_WGSL = `@compute @workgroup_size(1) fn main( {}`;

function runValidator(executable: string, sourcePath: string): ValidatorRunnerResult {
    const result: SpawnSyncReturns<string> = spawnSync(executable, [sourcePath], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error?.message,
    };
}

function pathCandidates(names: string[]): string[] {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    const found: string[] = [];
    for (const name of names) {
        const result = spawnSync(lookup, [name], { encoding: "utf8", windowsHide: true });
        if (result.status !== 0) continue;
        const first = (result.stdout ?? "").split(/\r?\n/).map(value => value.trim()).find(Boolean);
        if (first && !found.includes(first)) found.push(first);
    }
    return found;
}

function reportForUnavailable(reason: string, searched: string[]): WgslValidatorCapability {
    return {
        schema: 1,
        available: false,
        validator: null,
        protocol: null,
        reason,
        searched,
    };
}

function unavailableCapability(
    reason: string,
    searched: string[],
    environment: Record<string, string | undefined>,
): WgslValidatorCapability {
    if (environment.BS_REQUIRE_WGSL_VALIDATOR === "1") {
        throw new Error(`BS_REQUIRE_WGSL_VALIDATOR=1 but no usable offline WGSL validator was found: ${reason}`);
    }
    return reportForUnavailable(reason, searched);
}

/**
 * Find and self-test a real offline WGSL validator.  The self-test is
 * deliberately semantic: accepting only a binary's presence would turn a
 * compiler wrapper with the wrong invocation into false evidence.
 */
export function probeOfflineWgslValidator(options: ProbeOptions = {}): WgslValidatorCapability {
    const environment = options.environment ?? process.env;
    const explicit = environment.BS_WGSL_VALIDATOR?.trim();
    const candidates = options.candidates ?? (options.searchPath === false ? [] : pathCandidates(["naga", "tint"]));
    const searched = explicit ? ["BS_WGSL_VALIDATOR"] : [...candidates];
    const executables = explicit ? [explicit] : candidates;
    if (executables.length === 0) {
        return unavailableCapability(
            "no real offline WGSL validator is available; @webgpu/types is type-only and PATH candidates naga/tint were absent",
            searched,
            environment,
        );
    }

    const runner = options.runner ?? runValidator;
    const directory = mkdtempSync(join(tmpdir(), "bottleship-wgsl-"));
    const validPath = join(directory, "valid.wgsl");
    const invalidPath = join(directory, "invalid.wgsl");
    writeFileSync(validPath, VALID_WGSL, "utf8");
    writeFileSync(invalidPath, INVALID_WGSL, "utf8");
    try {
        const failures: string[] = [];
        for (const executable of executables) {
            const valid = runner(executable, validPath);
            const invalid = runner(executable, invalidPath);
            if (valid.status === 0 && invalid.status !== 0) {
                return {
                    schema: 1,
                    available: true,
                    validator: executable,
                    protocol: "path-argv-v1",
                    reason: "validator accepted a valid module and rejected a malformed module",
                    searched,
                };
            }
            failures.push(`${executable}: valid exit=${String(valid.status)}, invalid exit=${String(invalid.status)}`);
        }
        return unavailableCapability(
            `offline WGSL validator candidates failed the semantic self-test; ${failures.join("; ")}`,
            searched,
            environment,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

/**
 * Validate one module only when the capability probe proved a real validator
 * exists.  An unavailable capability is explicitly skipped and is never
 * represented as `passed: true`.
 */
export function validateWgslOffline(
    source: string,
    capability: WgslValidatorCapability,
    runner: (executable: string, sourcePath: string) => ValidatorRunnerResult = runValidator,
): WgslValidationResult {
    if (!capability.available || !capability.validator || !capability.protocol) {
        return {
            schema: 1,
            status: "skipped",
            passed: false,
            reason: `WGSL validation skipped: ${capability.reason}`,
        };
    }
    const directory = mkdtempSync(join(tmpdir(), "bottleship-wgsl-check-"));
    const sourcePath = join(directory, "module.wgsl");
    writeFileSync(sourcePath, source, "utf8");
    try {
        const result = runner(capability.validator, sourcePath);
        const diagnostics = `${result.stdout}${result.stderr}`.trim();
        if (result.status === 0) {
            return {
                schema: 1,
                status: "passed",
                passed: true,
                reason: `validated by ${capability.validator}`,
                ...(diagnostics ? { diagnostics } : {}),
            };
        }
        return {
            schema: 1,
            status: "rejected",
            passed: false,
            reason: `validator ${capability.validator} rejected the module (exit ${String(result.status)})`,
            ...(diagnostics ? { diagnostics } : {}),
        };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

export interface WgslCapabilityReport {
    schema: 1;
    gate: "d3d9-wgsl-validator";
    capability: WgslValidatorCapability;
    sentinel: WgslValidationResult;
}

export function buildWgslCapabilityReport(options: ProbeOptions = {}): WgslCapabilityReport {
    const capability = probeOfflineWgslValidator(options);
    const sentinel = validateWgslOffline(VALID_WGSL, capability);
    return { schema: 1, gate: "d3d9-wgsl-validator", capability, sentinel };
}

if (import.meta.main) {
    const reporting = process.argv.includes("--reporting") || process.argv.includes("--report");
    const report = buildWgslCapabilityReport();
    console.log(JSON.stringify(report, null, 2));
    // This is a reporting capability gate: absence is recorded as an explicit
    // skip, while an actually discovered validator must still self-test above.
    // The command remains non-fatal so Windows/native tooling is not required
    // on ordinary local or Linux CI hosts.
    if (!reporting && !report.capability.available) process.exit(3);
}
