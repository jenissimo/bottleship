import { describe, expect, test } from "bun:test";
import {
    buildD3D9CapabilityProfile,
    D3D9_ADVERTISED_WITHOUT_PROOF,
    D3D9_CAPS_SIZE,
    validateD3D9CapabilityProfile,
    type D3D9CapabilityProfile,
} from "../d3d9-parity/caps-profile";
import generatedProfile from "../fixtures/d3d9-capability-profile.json";

describe("D3D9 capability evidence profile", () => {
    const profile = buildD3D9CapabilityProfile();

    test("covers the complete D3DCAPS9 layout with no unmapped advertised field", () => {
        expect(profile.size).toBe(D3D9_CAPS_SIZE);
        expect(profile.fields).toHaveLength(D3D9_CAPS_SIZE / 4);
        expect(validateD3D9CapabilityProfile(profile)).toEqual([]);
        for (const field of profile.fields.filter(row => row.advertised)) {
            // Every non-zero value has a declared proof source. Reference-only
            // is intentionally a visible gap, not an implicit implementation.
            expect(field.evidence.length).toBeGreaterThan(0);
            expect(["implementation", "refusal", "reference"]).toContain(field.evidenceKind);
        }
    });

    test("keeps unsupported public capabilities as explicit refusals", () => {
        const byName = new Map(profile.fields.map(field => [field.name, field]));
        for (const name of ["VolumeTextureFilterCaps", "VolumeTextureAddressCaps", "MaxVolumeExtent"]) {
            const field = byName.get(name);
            expect(field?.value).toBe(0);
            expect(field?.status).toBe("refused");
            expect(field?.evidenceKind).toBe("refusal");
            expect(field?.evidence.length).toBeGreaterThan(0);
        }
    });

    test("reports reference-blob rows as open work instead of claiming parity", () => {
        const open = profile.fields.filter(field => field.status === "reference-only");
        expect(open.length).toBeGreaterThan(0);
        expect(profile.counts.advertisedWithoutProof)
            .toBe(open.filter(field => field.advertised && field.evidenceKind === "reference").length);
        for (const field of open) {
            expect(field.gap).toBeTruthy();
            expect(field.evidenceKind).toBe("reference");
        }
    });

    // The gate step reads THIS profile, so these three are the checks that make the
    // step a statement about the caps we answer with rather than about the reference blob.
    function mutate(change: (draft: D3D9CapabilityProfile) => void): string[] {
        const draft = JSON.parse(JSON.stringify(profile)) as D3D9CapabilityProfile;
        change(draft);
        return validateD3D9CapabilityProfile(draft);
    }

    test("a refused capability that starts answering non-zero fails the profile", () => {
        const errors = mutate(draft => {
            const field = draft.fields.find(row => row.name === "MaxVolumeExtent")!;
            field.value = 512;
            field.advertised = true;
            draft.counts.advertised++;
        });
        expect(errors).toContain("MaxVolumeExtent is classified refused but writeDeviceCaps9 answers 512");
    });

    test("advertising one more capability with no backing trips the ratchet", () => {
        const errors = mutate(draft => {
            // ExtentsAdjust is a reference-only row that currently answers zero.
            const field = draft.fields.find(row => row.name === "ExtentsAdjust")!;
            field.value = 1;
            field.advertised = true;
            draft.counts.advertised++;
            draft.counts.advertisedWithoutProof++;
        });
        expect(errors.some(error => error.includes("advertised without proof") &&
            error.includes(`ratchet is ${D3D9_ADVERTISED_WITHOUT_PROOF}`))).toBe(true);
    });

    test("counts cannot disagree with the fields they summarize", () => {
        expect(mutate(draft => { draft.counts.refused = 0; }))
            .toContain(`counts.refused is 0; fields say ${profile.counts.refused}`);
    });

    test("keeps the checked-in profile artifact synchronized with the live caps writer", () => {
        expect(generatedProfile).toEqual(profile);
    });
});
