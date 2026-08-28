/**
 * Per-draw shader attribution: the fast route must count exactly what the slow one counts.
 *
 * The slow route reaches each stage record by building `vs:<handle>` and `ps:<handle>` and
 * looking them up in the string-keyed map — two string allocations on every programmable draw,
 * measured in-race at 0.324 us of a 1.06 us memo hit. The fast route reads a numeric index and
 * caches the two references on the pair. Both must leave the SAME counters on the SAME records,
 * because the diagnostic they feed is read by shaderCensus and is the reason either exists.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

type Rec = { handle: number; stage: string; drawsIssued: number };
type Pair = {
    handle: number; vsHandle: number; psHandle: number | null; build: string;
    drawsIssued: number; vsDiag: Rec | null; psDiag: Rec | null; diagEpoch: number;
};
type Probe = Record<string, unknown> & {
    progDrawsSeen: number;
    progDrawsUnattributed: number;
    shaderDiagnostics: Map<string, Rec>;
    vsDiagnosticsByHandle: Map<number, Rec>;
    psDiagnosticsByHandle: Map<number, Rec>;
    shaderPipelinePairs: Map<number, number>;
    shaderPairDiagnostics: Map<number, Pair>;
    shaderDiagnosticEpoch: number;
};

const proto = D3D9Device.prototype as unknown as {
    noteProgrammableDraw: (this: Probe, pipelineId: number) => number;
    resolvePairDiagnostics: (this: Probe, pair: Pair) => void;
};

const flags = globalThis as { __d3d9FastDrawAttribution?: boolean };
afterEach(() => { flags.__d3d9FastDrawAttribution = false; });

function makeProbe(): Probe {
    const vs: Rec = { handle: 3, stage: "vs", drawsIssued: 0 };
    const ps: Rec = { handle: 4, stage: "ps", drawsIssued: 0 };
    const pair: Pair = {
        handle: 1, vsHandle: 3, psHandle: 4, build: "linked",
        drawsIssued: 0, vsDiag: null, psDiag: null, diagEpoch: -1,
    };
    const probe: Probe = {
        progDrawsSeen: 0,
        progDrawsUnattributed: 0,
        shaderDiagnostics: new Map([["vs:3", vs], ["ps:4", ps]]),
        vsDiagnosticsByHandle: new Map([[3, vs]]),
        psDiagnosticsByHandle: new Map([[4, ps]]),
        shaderPipelinePairs: new Map([[42, 1]]),
        shaderPairDiagnostics: new Map([[1, pair]]),
        shaderDiagnosticEpoch: 7,
    };
    probe.resolvePairDiagnostics = proto.resolvePairDiagnostics;
    return probe;
}

function counts(p: Probe): Record<string, number> {
    return {
        vs: p.vsDiagnosticsByHandle.get(3)!.drawsIssued,
        ps: p.psDiagnosticsByHandle.get(4)!.drawsIssued,
        pair: p.shaderPairDiagnostics.get(1)!.drawsIssued,
        seen: p.progDrawsSeen,
        unattributed: p.progDrawsUnattributed,
    };
}

describe("programmable draw attribution", () => {
    test("the fast route leaves exactly the counters the slow route leaves", () => {
        const slow = makeProbe();
        for (let i = 0; i < 100; i++) proto.noteProgrammableDraw.call(slow, 42);

        flags.__d3d9FastDrawAttribution = true;
        const fast = makeProbe();
        for (let i = 0; i < 100; i++) proto.noteProgrammableDraw.call(fast, 42);

        expect(counts(fast)).toEqual(counts(slow));
        expect(counts(fast).vs).toBe(100);
    });

    test("a re-published record is picked up: the cached reference is epoch-guarded", () => {
        flags.__d3d9FastDrawAttribution = true;
        const p = makeProbe();
        proto.noteProgrammableDraw.call(p, 42);
        // CreateVertexShader reusing the handle publishes a new record and bumps the epoch.
        const replacement: Rec = { handle: 3, stage: "vs", drawsIssued: 0 };
        p.vsDiagnosticsByHandle.set(3, replacement);
        p.shaderDiagnostics.set("vs:3", replacement);
        p.shaderDiagnosticEpoch++;
        proto.noteProgrammableDraw.call(p, 42);
        expect(replacement.drawsIssued).toBe(1);
        expect(p.shaderPairDiagnostics.get(1)!.vsDiag).toBe(replacement);
    });

    test("both routes agree on the unattributed and failed-pair paths", () => {
        for (const fast of [false, true]) {
            flags.__d3d9FastDrawAttribution = fast;
            const p = makeProbe();
            expect(proto.noteProgrammableDraw.call(p, 99)).toBe(99);   // no pair for this pipeline
            expect(p.progDrawsUnattributed).toBe(1);
            p.shaderPairDiagnostics.get(1)!.build = "failed";
            expect(proto.noteProgrammableDraw.call(p, 42)).toBe(-1);   // refuse a rejected pipeline
            expect(counts(p).vs).toBe(0);
        }
    });

    test("a vertex-shader-only pair attributes to the VS alone on both routes", () => {
        for (const fast of [false, true]) {
            flags.__d3d9FastDrawAttribution = fast;
            const p = makeProbe();
            p.shaderPairDiagnostics.get(1)!.psHandle = null;
            proto.noteProgrammableDraw.call(p, 42);
            expect(counts(p).vs).toBe(1);
            expect(counts(p).ps).toBe(0);
        }
    });
});
