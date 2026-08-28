/**
 * The programmable-pipeline prologue memo: its key must be exact, and its oracle must be
 * able to say DISAGREE.
 *
 * Like d3d9-pipeline-key.test.ts, the two methods are exercised against a structural probe —
 * a real WebGPU device is neither available nor needed to check a key's coverage. What this
 * pins is the property the memo's safety rests on: EVERY field and generation it claims to
 * cover actually falsifies the match when it moves. A field silently dropped from the
 * comparison is how a memo starts answering for state it never looked at.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import {
    d3d9PipelineMemoProfileStats,
    d3d9PipelineMemoStats,
    notePipelineMemoAgree,
    notePipelineMemoHit,
    notePipelineMemoMismatch,
    notePipelineMemoProf,
    pipelineMemoEnabled,
    pipelineMemoProfiling,
    PROF_CLOCK,
    PROF_GUARD,
    PROF_HIT,
    PROF_TAIL,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-pipeline-memo";

type MemoProbe = Record<string, unknown> & {
    stateTracker: { getFVF: () => number; getStreamSource: () => { stride: number } | null };
    streamHash: (slotMask: number, stride0Override: number) => number;
};

const proto = D3D9Device.prototype as unknown as {
    _pipelineMemoMatches: (
        this: MemoProbe, topology: string, forceCullNone: boolean,
        strideOverride: number | undefined, slotMask: number, pointExpansion: boolean,
    ) => boolean;
    _armPipelineMemo: (
        this: MemoProbe, topology: string, forceCullNone: boolean,
        strideOverride: number | undefined, slotMask: number, pointExpansion: boolean,
        stride: number | null, streamHash: number, psNonNull: boolean,
    ) => void;
};

function makeProbe(): MemoProbe {
    return {
        activeVertexShader: 7,
        activePixelShader: 9,
        activeVertexDecl: 0x1234,
        pipelineStateGeneration: 100,
        samplerStateGeneration: 200,
        arenaSamplerBankGeneration: 300,
        attachmentGeneration: 400,
        _pmValid: false,
        stateTracker: {
            getFVF: () => 0x142,
            getStreamSource: () => ({ stride: 32 }),
        },
        streamHash: () => 0xabc,
    };
}

/** Arm with the arguments the "current" call would carry. */
function arm(probe: MemoProbe): void {
    proto._armPipelineMemo.call(probe, "triangle-list", false, undefined, 1, false, 32, 0xabc, true);
}

function matches(probe: MemoProbe): boolean {
    return proto._pipelineMemoMatches.call(probe, "triangle-list", false, undefined, 1, false);
}

describe("pipeline prologue memo key", () => {
    test("an armed memo matches an identical call", () => {
        const probe = makeProbe();
        expect(matches(probe)).toBe(false); // not armed yet
        arm(probe);
        expect(matches(probe)).toBe(true);
    });

    test("every generation it claims to cover falsifies the match", () => {
        for (const gen of [
            "pipelineStateGeneration",
            "samplerStateGeneration",
            "arenaSamplerBankGeneration",
            "attachmentGeneration",
        ]) {
            const probe = makeProbe();
            arm(probe);
            (probe as Record<string, number>)[gen]++;
            expect({ gen, matched: matches(probe) }).toEqual({ gen, matched: false });
        }
    });

    test("every bound-object handle falsifies the match", () => {
        for (const field of ["activeVertexShader", "activePixelShader", "activeVertexDecl"]) {
            const probe = makeProbe();
            arm(probe);
            (probe as Record<string, number>)[field]++;
            expect({ field, matched: matches(probe) }).toEqual({ field, matched: false });
        }
        const fvfProbe = makeProbe();
        arm(fvfProbe);
        fvfProbe.stateTracker.getFVF = () => 0x143;
        expect(matches(fvfProbe)).toBe(false);
    });

    test("stream identity falsifies the match (stride and layout hash separately)", () => {
        const strideProbe = makeProbe();
        arm(strideProbe);
        strideProbe.stateTracker.getStreamSource = () => ({ stride: 48 });
        expect(matches(strideProbe)).toBe(false);

        const hashProbe = makeProbe();
        arm(hashProbe);
        hashProbe.streamHash = () => 0xdef;
        expect(matches(hashProbe)).toBe(false);
    });

    test("every explicit argument falsifies the match", () => {
        const probe = makeProbe();
        arm(probe);
        expect(proto._pipelineMemoMatches.call(probe, "line-list", false, undefined, 1, false)).toBe(false);
        expect(proto._pipelineMemoMatches.call(probe, "triangle-list", true, undefined, 1, false)).toBe(false);
        expect(proto._pipelineMemoMatches.call(probe, "triangle-list", false, 64, 1, false)).toBe(false);
        expect(proto._pipelineMemoMatches.call(probe, "triangle-list", false, undefined, 3, false)).toBe(false);
        expect(proto._pipelineMemoMatches.call(probe, "triangle-list", false, undefined, 1, true)).toBe(false);
        // ...and still matches the call it was armed for.
        expect(matches(probe)).toBe(true);
    });

    test("disarming (invalidateLastResolve's job) drops the memo", () => {
        const probe = makeProbe();
        arm(probe);
        probe._pmValid = false;
        expect(matches(probe)).toBe(false);
    });
});

describe("pipeline memo stage profile", () => {
    const flags = globalThis as { __d3d9PipelineMemoProfile?: boolean };
    beforeEach(() => { d3d9PipelineMemoProfileStats(true); });
    afterEach(() => { flags.__d3d9PipelineMemoProfile = false; d3d9PipelineMemoProfileStats(true); });

    test("off by default, and an empty profile says so instead of reporting zeros", () => {
        expect(pipelineMemoProfiling()).toBe(false);
        const s = d3d9PipelineMemoProfileStats();
        expect(s.verdict).toBe("profile did not run");
        expect(s.guardUs).toBeNull();
        expect(s.calls).toBe(0);
    });

    test("a guard that sits on the clock floor is reported as unmeasured, not as fast", () => {
        for (let i = 0; i < 10; i++) {
            notePipelineMemoProf(PROF_CLOCK, 0.001);
            notePipelineMemoProf(PROF_GUARD, 0.0015);
            notePipelineMemoProf(PROF_TAIL, 0.010);
            notePipelineMemoProf(PROF_HIT, 0.0115);
        }
        const s = d3d9PipelineMemoProfileStats();
        expect(s.clockUs).toBeCloseTo(1, 6);
        expect(s.guardUs).toBeCloseTo(1.5, 6);
        expect(s.tailUs).toBeCloseTo(10, 6);
        expect(s.calls).toBe(10);
        expect(s.verdict).toBe("guard is at the clock floor — do not size a fix off it");
    });

    test("a guard clear of the floor reads as measured", () => {
        notePipelineMemoProf(PROF_CLOCK, 0.0001);
        notePipelineMemoProf(PROF_GUARD, 0.002);
        notePipelineMemoProf(PROF_HIT, 0.003);
        expect(d3d9PipelineMemoProfileStats().verdict).toBe("measured");
    });
});

describe("pipeline memo oracle", () => {
    const flags = globalThis as { __d3d9PipelineMemo?: boolean; __noD3D9KeyMemo?: boolean };

    beforeEach(() => { d3d9PipelineMemoStats(true); });
    afterEach(() => { flags.__d3d9PipelineMemo = false; flags.__noD3D9KeyMemo = false; d3d9PipelineMemoStats(true); });

    test("checked:0 reports 'oracle did not run' rather than passing", () => {
        notePipelineMemoHit();
        const s = d3d9PipelineMemoStats();
        expect(s.hits).toBe(1);
        expect(s.checked).toBe(0);
        expect(s.verdict).toBe("oracle did not run");
    });

    test("agreements read as agree", () => {
        for (let i = 0; i < 10; i++) notePipelineMemoAgree();
        const s = d3d9PipelineMemoStats();
        expect(s.checked).toBe(10);
        expect(s.mismatch).toBe(0);
        expect(s.verdict).toBe("agree");
    });

    test("the oracle CAN fail: one disagreement flips the verdict and is named", () => {
        notePipelineMemoAgree();
        notePipelineMemoMismatch("bail:rasterStateSupported");
        const s = d3d9PipelineMemoStats();
        expect(s.checked).toBe(2);
        expect(s.mismatch).toBe(1);
        expect(s.verdict).toBe("DISAGREE");
        expect(s.firstMismatch).toBe("bail:rasterStateSupported");
    });

    test("the memo is off by default and __noD3D9KeyMemo overrides it on", () => {
        expect(pipelineMemoEnabled()).toBe(false);
        flags.__d3d9PipelineMemo = true;
        expect(pipelineMemoEnabled()).toBe(true);
        flags.__noD3D9KeyMemo = true;
        expect(pipelineMemoEnabled()).toBe(false);
    });
});
