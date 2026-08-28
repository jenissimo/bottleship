import { describe, expect, test } from "bun:test";
import nativeCapture from "../d3d9-parity/captures/native-d3d9-windows-current.json";
import {
    decodeD3D9CapsBlob,
    readCheckedInRealCaps9Hex,
    validateD3D9RealCapsHex,
} from "../d3d9-parity/caps-profile";
import {
    buildD3D9ProbeManifest,
    compareD3D9Capture,
    decodeD3D9CapsRawHex,
    normalizeD3D9Capture,
    validateD3D9Capture,
} from "../d3d9-parity/probe-oracle";
import {
    buildWgslCapabilityReport,
    probeOfflineWgslValidator,
    validateWgslOffline,
    type WgslValidatorCapability,
} from "../d3d9-parity/wgsl-validator";

describe("D3D9 parity evidence capability", () => {
    test("does not call a missing real WGSL validator a pass", () => {
        const report = buildWgslCapabilityReport({
            candidates: [],
            searchPath: false,
            environment: {},
        });

        expect(report.capability.available).toBe(false);
        expect(report.capability.validator).toBeNull();
        expect(report.capability.reason).toContain("no real offline WGSL validator");
        expect(report.sentinel).toMatchObject({ status: "skipped", passed: false });
        expect(report.sentinel.reason).toContain("WGSL validation skipped:");
    });

    test("BS_REQUIRE_WGSL_VALIDATOR turns missing evidence into a hard failure", () => {
        expect(() => probeOfflineWgslValidator({
            candidates: [],
            searchPath: false,
            environment: { BS_REQUIRE_WGSL_VALIDATOR: "1" },
        })).toThrow(/BS_REQUIRE_WGSL_VALIDATOR=1/);
    });

    test("a capability result cannot be upgraded to passed by a caller", () => {
        const unavailable: WgslValidatorCapability = {
            schema: 1,
            available: false,
            validator: null,
            protocol: null,
            reason: "test: validator intentionally unavailable",
            searched: [],
        };
        const result = validateWgslOffline("@compute @workgroup_size(1) fn main() {}", unavailable);
        expect(result.status).toBe("skipped");
        expect(result.passed).toBe(false);
        expect(result.reason).toBe("WGSL validation skipped: test: validator intentionally unavailable");
    });

    test("rejects a candidate that accepts both valid and malformed WGSL", () => {
        const capability = probeOfflineWgslValidator({
            candidates: ["test-validator"],
            searchPath: false,
            environment: {},
            runner: () => ({ status: 0, stdout: "", stderr: "" }),
        });

        expect(capability.available).toBe(false);
        expect(capability.validator).toBeNull();
        expect(capability.reason).toContain("semantic self-test");
    });

    test("requires the valid/malformed semantic pair before accepting a validator", () => {
        const capability = probeOfflineWgslValidator({
            candidates: ["test-validator"],
            searchPath: false,
            environment: {},
            runner: (_executable, sourcePath) => ({
                status: sourcePath.endsWith("invalid.wgsl") ? 1 : 0,
                stdout: "",
                stderr: "",
            }),
        });

        expect(capability).toMatchObject({
            available: true,
            validator: "test-validator",
            protocol: "path-argv-v1",
        });
        const rejected = validateWgslOffline(
            "@compute @workgroup_size(1) fn main( {}",
            capability,
            () => ({ status: 1, stdout: "syntax error", stderr: "" }),
        );
        expect(rejected).toMatchObject({ status: "rejected", passed: false });
        expect(rejected.reason).toContain("rejected the module");
    });

    test("decodes native caps rawHex into all typed D3DCAPS9 fields", () => {
        const rawHex = (nativeCapture as any).probes["caps-layout-and-evidence"].caps.rawHex as string;
        const decoded = decodeD3D9CapsRawHex(rawHex);
        expect(decoded).toMatchObject({ size: 304 });
        expect(decoded.fields).toHaveLength(76);
        expect(decoded.fields[0]).toMatchObject({ name: "DeviceType", offset: 0, kind: "scalar", value: 1 });
        expect(decoded.fields.find(field => field.name === "MaxTextureWidth")).toMatchObject({
            offset: 88,
            kind: "scalar",
            value: 16384,
            advertised: true,
            setBits: [],
        });
        expect(decoded.fields.find(field => field.name === "MaxVertexW")).toMatchObject({
            offset: 112,
            kind: "float",
            value: 1e10,
        });
        expect(decodeD3D9CapsBlob(Uint8Array.from(rawHex.match(/../g)!, byte => Number.parseInt(byte, 16))))
            .toHaveLength(76);
    });

    test("keeps native legacy results interchangeable with the common support schema", () => {
        const manifest = buildD3D9ProbeManifest();
        const probes = Object.fromEntries(manifest.probes.map(probe => [probe.id, probe.localExpected]));
        const legacy = {
            schema: 1 as const,
            target: "native-d3d9" as const,
            source: "legacy-capture-test",
            environment: "synthetic",
            probes: {
                ...probes,
                "check-device-format-cross-bpp": 0,
                "d3d9-msaa-none": { hresult: 0, qualityLevels: 1 },
            },
        };

        expect(validateD3D9Capture(legacy)).toEqual([]);
        const normalized = normalizeD3D9Capture(legacy);
        expect(normalized.probes["check-device-format-cross-bpp"])
            .toEqual({ supported: true, qualityLevels: 0 });
        expect(normalized.probes["d3d9-msaa-none"])
            .toEqual({ supported: true, qualityLevels: 1 });
        expect(compareD3D9Capture(manifest, normalized).valid).toBe(true);
    });

    test("fails closed on malformed capture schema and mutated reference caps", () => {
        const manifest = buildD3D9ProbeManifest();
        const probes = Object.fromEntries(manifest.probes.map(probe => [probe.id, probe.localExpected]));
        const malformed = {
            schema: 1 as const,
            target: "native-d3d9" as const,
            source: "malformed-capture-test",
            environment: "synthetic",
            probes: {
                ...probes,
                "caps-layout-and-evidence": { hresult: 0, caps: { rawHex: "00" } },
                "d3d9-msaa-none": { supported: true },
            },
        } as any;
        const errors = validateD3D9Capture(malformed);
        expect(errors.some(error => error.includes("rawHex") && error.includes("304"))).toBe(true);
        expect(errors.some(error => error.includes("d3d9-msaa-none") && error.includes("qualityLevels"))).toBe(true);
        expect(validateD3D9Capture(null as any)).toEqual(["capture must be an object"]);

        const hex = readCheckedInRealCaps9Hex();
        const offset = 160 * 2;
        const original = hex.slice(offset, offset + 2);
        const replacement = original === "ff" ? "fe" : "ff";
        const mutated = `${hex.slice(0, offset)}${replacement}${hex.slice(offset + 2)}`;
        const validation = validateD3D9RealCapsHex(mutated);
        expect(validation.errors.some(error => error.includes("MaxActiveLights@160 scalar"))).toBe(true);
    });
});
