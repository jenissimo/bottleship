import { describe, expect, test } from "bun:test";
import { buildD3D9Inventory } from "../d3d9-parity/inventory";
import {
    buildD3D9ProbeManifest,
    callD3D9ExHandler,
    compareD3D9Capture,
    loadCheckedInD3D9Captures,
    normalizeD3D9Capture,
    runD3D9Probe,
    validateD3D9ProbeManifest,
} from "../d3d9-parity/probe-oracle";
import { devices } from "../../src/worker/modules/d3d9/shared-state";
import {
    decodeD3D9CapsBlob,
    readCheckedInRealCaps9Hex,
    validateCheckedInRealCaps9,
    validateD3D9RealCapsHex,
} from "../d3d9-parity/caps-profile";
import generatedManifest from "../fixtures/d3d9-bottleship-inventory.json";
import nativeCapture from "../d3d9-parity/captures/native-d3d9-windows-current.json";

describe("D3D9 executable surface inventory", () => {
    const inventory = buildD3D9Inventory();

    test("covers every descriptor interface method with an assembled handler", () => {
        expect(inventory.counts.interfaces).toBe(18);
        expect(inventory.counts.methods).toBe(459);
        expect(inventory.counts.dispatcherFallback).toBe(0);
        expect(inventory.counts.implemented + inventory.counts.refused)
            .toBe(inventory.counts.methods + inventory.functions.length);
    });

    test("keeps the only intentional Ex-only refusals explicit", () => {
        const refusedRows = inventory.methods.filter(row => row.status === "refused");
        const refused = refusedRows.map(row => row.name);
        expect(refused).toEqual([
            "IDirect3DDevice9Ex_SetConvolutionMonoKernel",
        ]);
        expect(refusedRows.map(row => row.refusalHresult)).toEqual([0x8876086c]);
        expect(refusedRows.every(row => row.evidence?.includes("src/worker/modules/d3d9/ex.ts"))).toBe(true);
    });

    test("records ABI arities from the descriptor, not handler heuristics", () => {
        const createDevice = inventory.methods.find(row => row.name === "IDirect3D9_CreateDevice");
        const presentEx = inventory.methods.find(row => row.name === "IDirect3DDevice9Ex_PresentEx");
        expect(createDevice?.argCount).toBe(7);
        expect(presentEx?.argCount).toBe(6);
    });

    test("keeps the executable local oracle and its checked-in manifest synchronized", () => {
        expect(validateD3D9ProbeManifest(inventory.parity)).toEqual([]);
        expect(inventory.parity).toEqual(buildD3D9ProbeManifest());
        expect((generatedManifest as any).parity).toEqual(inventory.parity);
        expect(inventory.parity.counts.localCovered).toBe(inventory.parity.counts.total);
        expect(inventory.parity.counts.nativePending).toBeGreaterThan(0);
        expect(inventory.parity.counts.dxvkPending).toBeGreaterThan(0);
    });

    test("treats a missing native/DXVK capture as pending, never as a passing result", () => {
        const probe = inventory.parity.probes[0]!;
        const capture = {
            schema: 1 as const,
            target: "dxvk" as const,
            source: "fixture-only",
            environment: "not-run",
            probes: { [probe.id]: probe.localExpected },
        };
        const comparison = compareD3D9Capture(inventory.parity, capture);
        expect(comparison.valid).toBe(false);
        expect(comparison.missing.length).toBe(inventory.parity.probes.length - 1);
    });

    test("differential comparator accepts an exact capture and names a single drift", () => {
        const probes = Object.fromEntries(inventory.parity.probes.map(probe => [probe.id, probe.localExpected]));
        const exact = compareD3D9Capture(inventory.parity, {
            schema: 1,
            target: "native-d3d9",
            source: "deterministic-test-fixture",
            environment: "synthetic-local-only",
            probes,
        });
        expect(exact.valid).toBe(true);
        expect(exact.missing).toEqual([]);
        expect(exact.mismatches).toEqual([]);

        const drifted = { ...probes, "d3d9-msaa-2x-refusal": { supported: true, qualityLevels: 0 } as any };
        const drift = compareD3D9Capture(inventory.parity, {
            schema: 1,
            target: "dxvk",
            source: "deterministic-test-fixture",
            environment: "synthetic-local-only",
            probes: drifted,
        });
        expect(drift.valid).toBe(false);
        expect(drift.missing).toEqual([]);
        expect(drift.mismatches.map(row => row.id)).toEqual(["d3d9-msaa-2x-refusal"]);
    });

    test("keeps sampler, resource, Ex, and caps seam vectors deterministic", () => {
        const probes = new Map(inventory.parity.probes.map(probe => [probe.id, probe]));
        expect(probes.get("caps-volume-filter-refusal")?.localExpected).toBe(0);
        expect(probes.get("sampler-anisotropic-mip-filter")?.localExpected).toEqual({
            mip: "linear",
            mipNone: false,
        });
        expect(probes.get("resource-stretchrect-rt-to-offscreen-stretch")?.localExpected).toMatchObject({
            supported: true,
            cpuPath: true,
            requiresResolve: false,
        });
        expect(probes.get("ex-check-resource-residency-stub")?.localExpected).toBe(0);
        expect(probes.get("ex-check-device-state-stub")?.localExpected).toBe(0);
    });

    test("reads external coverage from the checked-in captures instead of stamping it", () => {
        const captured = loadCheckedInD3D9Captures().get("native-d3d9") ?? new Set<string>();
        expect(captured.size).toBeGreaterThan(0);
        const byId = new Map(inventory.parity.probes.map(probe => [probe.id, probe]));
        for (const [id, probe] of byId) {
            const isCaptured = captured.has(id);
            expect(probe.capturedTargets.includes("native-d3d9")).toBe(isCaptured);
            // No DXVK capture is checked in, so a natively captured row is partial, never
            // "awaiting-capture" — that was the unconditional stamp.
            expect(probe.externalStatus).toBe(isCaptured ? "partially-captured" : "awaiting-capture");
        }
        expect(byId.get("caps-layout-and-evidence")?.externalStatus).toBe("partially-captured");
        expect(byId.get("sampler-border-and-mirror-once")?.externalStatus).toBe("awaiting-capture");
        expect(inventory.parity.counts.nativePending)
            .toBe(inventory.parity.probes.filter(probe => !probe.capturedTargets.includes("native-d3d9")).length);
    });

    test("an oracle row with no evaluator is uncovered, and the validator says so", () => {
        expect(() => runD3D9Probe("probe-with-no-evaluator")).toThrow(/unknown D3D9 parity probe/);
        const manifest = buildD3D9ProbeManifest();
        const broken = {
            ...manifest,
            probes: manifest.probes.map((probe, index) => index === 0
                ? { ...probe, localStatus: "uncovered" as const, localExpected: null }
                : probe),
        };
        expect(validateD3D9ProbeManifest(broken))
            .toContain(`${manifest.probes[0]!.id} local oracle is not covered`);
    });

    test("Ex rows answer from the shipped handler, not from a constant in the oracle", () => {
        const byId = new Map(inventory.parity.probes.map(probe => [probe.id, probe]));
        const rows: Array<[string, string, number[]]> = [
            ["ex-convolution-invalidcall", "IDirect3DDevice9Ex_SetConvolutionMonoKernel", [3, 3, 0, 0]],
            ["ex-compose-rects-compat-stub", "IDirect3DDevice9Ex_ComposeRects", [0, 0, 0, 0, 0, 1, 0, 0]],
            ["ex-check-resource-residency-stub", "IDirect3DDevice9Ex_CheckResourceResidency", [0, 0]],
            ["ex-check-device-state-stub", "IDirect3DDevice9Ex_CheckDeviceState", [0]],
        ];
        const device = 0x9e000100;
        for (const [id, name, args] of rows) {
            expect(byId.get(id)?.localExpected).toBe(callD3D9ExHandler(name, [device, ...args]));
        }
        // The bridge really dispatches through the export table: an unknown name has no
        // handler to answer with, and the probe registry is left untouched.
        expect(() => callD3D9ExHandler("IDirect3DDevice9Ex_NotAnExport", [device]))
            .toThrow(/has no handler/);
        expect(devices.has(device)).toBe(false);
    });

    test("names a resource oracle drift instead of treating a DXVK-compatible path as covered", () => {
        const probes = Object.fromEntries(inventory.parity.probes.map(probe => [probe.id, probe.localExpected]));
        const drifted = {
            ...probes,
            "resource-stretchrect-rt-to-offscreen-stretch": {
                supported: false,
                requiresResolve: false,
                cpuPath: true,
                stretch: true,
                reason: "GPU render-target to CPU-only offscreen surface has no readback seam",
            },
        } as any;
        const comparison = compareD3D9Capture(inventory.parity, {
            schema: 1,
            target: "dxvk",
            source: "deterministic-test-fixture",
            environment: "synthetic-local-only",
            probes: drifted,
        });
        expect(comparison.valid).toBe(false);
        expect(comparison.missing).toEqual([]);
        expect(comparison.mismatches.map(row => row.id)).toEqual(["resource-stretchrect-rt-to-offscreen-stretch"]);
    });

    test("decodes every checked-in REAL_CAPS9_HEX word against the D3DCAPS9 truth table", () => {
        const validation = validateCheckedInRealCaps9();
        expect(validation.errors).toEqual([]);
        expect(validation.fields).toHaveLength(304 / 4);
        expect(validation.fields[0]).toMatchObject({
            name: "DeviceType", offset: 0, kind: "scalar", wordHex: "0x00000001",
            value: 1, expectedStatus: "implemented", expectedEvidenceKind: "implementation",
        });
        expect(validation.fields.find(field => field.name === "MaxVertexW")).toMatchObject({
            offset: 112, kind: "float", wordHex: "0x501502f9", value: 1e10,
        });
        expect(validation.fields.find(field => field.name === "TextureOpCaps")).toMatchObject({
            offset: 144, kind: "bitmask", wordHex: "0x03feffff", advertised: true,
            evidencePath: "src/worker/backends/webgpu/d3d9/ffp-combiner.ts",
        });
        expect(validation.fields.find(field => field.name === "VolumeTextureFilterCaps")).toMatchObject({
            offset: 72, wordHex: "0x03030300", expectedStatus: "refused", expectedEvidenceKind: "refusal",
        });
        expect(decodeD3D9CapsBlob(Uint8Array.from(readCheckedInRealCaps9Hex().match(/../g)!, byte => Number.parseInt(byte, 16))))
            .toHaveLength(76);
    });

    test("fails closed when one reference caps word is mutated", () => {
        const hex = readCheckedInRealCaps9Hex();
        const offset = 160 * 2;
        const original = hex.slice(offset, offset + 2);
        const replacement = original === "ff" ? "fe" : "ff";
        const mutated = `${hex.slice(0, offset)}${replacement}${hex.slice(offset + 2)}`;
        const validation = validateD3D9RealCapsHex(mutated);
        expect(validation.errors).toEqual([
            expect.stringContaining("MaxActiveLights@160 scalar: expected 0x000000ff"),
        ]);
    });

    test("decodes every native caps field and normalizes external support results", () => {
        const normalized = normalizeD3D9Capture(nativeCapture as any);
        const caps = (normalized.probes["caps-layout-and-evidence"] as any).caps;
        expect(caps.size).toBe(304);
        expect(caps.fields).toHaveLength(76);
        expect(caps.fields[0]).toMatchObject({ name: "DeviceType", offset: 0, value: 1, advertised: true });
        expect(caps.fields.find((field: any) => field.name === "MaxTextureWidth")).toMatchObject({
            offset: 88,
            value: 16384,
            advertised: true,
        });
        expect(normalized.probes["d3d9-msaa-none"]).toEqual({ supported: true, qualityLevels: 1 });
        expect(normalized.probes["check-device-format-cross-bpp"]).toEqual({ supported: true, qualityLevels: 0 });
    });

    test("malformed rawHex and probe schema fail the comparator with actionable errors", () => {
        const probes = Object.fromEntries(inventory.parity.probes.map(probe => [probe.id, probe.localExpected]));
        const malformedRawHex = {
            ...probes,
            "caps-layout-and-evidence": { hresult: 0, caps: { size: 304, rawHex: "00" } },
        };
        const rawHexResult = compareD3D9Capture(inventory.parity, {
            schema: 1,
            target: "native-d3d9",
            source: "malformed-fixture",
            environment: "test",
            probes: malformedRawHex,
        });
        expect(rawHexResult.valid).toBe(false);
        expect(rawHexResult.errors.some(error => error.includes("rawHex") && error.includes("304"))).toBe(true);

        const malformedSupport = {
            ...probes,
            "d3d9-msaa-none": { supported: true },
        };
        const supportResult = compareD3D9Capture(inventory.parity, {
            schema: 1,
            target: "dxvk",
            source: "malformed-fixture",
            environment: "test",
            probes: malformedSupport as any,
        });
        expect(supportResult.valid).toBe(false);
        expect(supportResult.errors).toContain(
            "capture probe d3d9-msaa-none: expected { supported: boolean, qualityLevels: non-negative integer }",
        );
    });
});
