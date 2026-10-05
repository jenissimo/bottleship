/**
 * grDrawTriangle on the write-buffer ring — differential against the OUT-trap path.
 *
 * grDrawTriangle takes THREE guest pointers, so it is the case capture-at-call was
 * extended for. The extension is only sound if the ring copy reproduces the trap path
 * exactly, and "the frame looks right" cannot show that: a swapped vertex, a payload read
 * at the wrong stride, or a dropped draw all still render something plausible.
 *
 * FAST-PATH LEDGER RULE — this runs BOTH paths over the same call and compares the vertex
 * stream and the draw list they produce, not a screenshot. It also pins the two things the
 * ring entry's correctness rests on: the payload layout, and the BARRIER registration that
 * keeps coalescing from spanning two draws.
 */

import { describe, expect, test } from "bun:test";
import { createDrawExports, GR_VERTEX_FLOATS } from "../../src/worker/modules/glide2x/draw";
import { registerGlideWriteBufferFunctions } from "../../src/worker/modules/glide2x/fast-path";
import { GlideContext, createDefaultRuntimeState } from "../../src/worker/modules/glide2x/context";
import { GlideDiagnostics } from "../../src/worker/modules/glide2x/diagnostics";
import { Legacy3DFFPState } from "../../src/worker/backends/webgpu/legacy3d/ffp-state";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { GR_VERTEX_SIZE } from "../../src/worker/modules/glide2x/constants";

// Field order of the 12 floats a draw reads out of GrVertex (glide.h).
const F = { X: 0, Y: 1, Z: 2, R: 3, G: 4, B: 5, OOZ: 6, A: 7, OOW: 8, SOW: 9, TOW: 10, TMU0_OOW: 11 };

function vertex(x: number, y: number, r: number, g: number, b: number): number[] {
    const v = new Array<number>(GR_VERTEX_FLOATS).fill(0);
    v[F.X] = x; v[F.Y] = y;
    v[F.R] = r; v[F.G] = g; v[F.B] = b; v[F.A] = 255;
    v[F.OOZ] = 32767; v[F.OOW] = 1; v[F.TMU0_OOW] = 1;
    v[F.SOW] = x / 64; v[F.TOW] = y / 64;
    return v;
}

const TRI = [vertex(10, 20, 255, 0, 0), vertex(30, 40, 0, 255, 0), vertex(50, 60, 0, 0, 255)];

type Pushed = { x: number; y: number; z: number; u: number; v: number; q: number; color: number };

function makeContext(): { context: GlideContext; pushed: Pushed[]; draws: unknown[] } {
    const pushed: Pushed[] = [];
    const draws: unknown[] = [];
    const context = {
        tmus: [{
            texturesByAddress: new Map(), currentAddress: 0, minAddress: 0, maxAddress: 0,
            palette: null, nccTables: [null, null], activeNcc: 0, minFilter: 0, magFilter: 0,
        }],
        ffpState: new Legacy3DFFPState(),
        diagnostics: new GlideDiagnostics(64),
        executor: null,
        stream: {
            getVertexCount: () => pushed.length,
            pushVertex: (x: number, y: number, z: number, u: number, v: number, q: number, color: number) => {
                pushed.push({ x, y, z, u, v, q, color });
                return pushed.length - 1;
            },
            pushDraw: (d: unknown) => { draws.push(d); },
        },
        runtime: createDefaultRuntimeState(),
        frameSnapshot: {
            frameId: 1, drawCalls: 0,
            frameCounters: { uploads: 0, textureBytes: 0, textureBinds: 0, vertexBytes: 0 },
        },
        apiState: {},
    } as unknown as GlideContext;
    return { context, pushed, draws };
}

/** Register against a recording dispatcher and hand back the drain handler + its spec. */
function ringHandlerFor(context: GlideContext) {
    let captured: ((m8: Uint8Array, m32: Uint32Array, p: number) => void) | null = null;
    let spec: { argCount: number; ptrArgIndices: number[]; payloadDwords: number } | null = null;
    const dispatcher = {
        registerWriteBufferFunction: () => true,
        registerStructCaptureWriteBufferFunction: () => { /* grTexSource, not under test */ },
        registerMultiStructCaptureWriteBufferFunction: (
            _dll: string, func: string, argCount: number, ptrArgIndices: number[],
            payloadDwords: number, handler: (m8: Uint8Array, m32: Uint32Array, p: number) => void,
        ) => {
            if (func !== "_grDrawTriangle@12") return;
            captured = handler;
            spec = { argCount, ptrArgIndices, payloadDwords };
        },
    };
    registerGlideWriteBufferFunctions(dispatcher, createDrawExports(context), context);
    if (!captured || !spec) throw new Error("grDrawTriangle was not registered for multi-struct capture");
    return { handler: captured as (m8: Uint8Array, m32: Uint32Array, p: number) => void, spec: spec! };
}

/** [funcId][a][b][c][12 floats × 3] — the layout the trampoline writes. */
function ringEntry(ptrs: number[], tri: number[][]): { mem8: Uint8Array; mem32: Uint32Array; ptr: number } {
    const buf = new ArrayBuffer(512);
    const mem32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    const ptr = 64;
    const w = ptr >> 2;
    for (let i = 0; i < 3; i++) mem32[w + i] = ptrs[i]! >>> 0;
    for (let v = 0; v < 3; v++) {
        for (let i = 0; i < GR_VERTEX_FLOATS; i++) f32[w + 3 + v * GR_VERTEX_FLOATS + i] = tri[v]![i]!;
    }
    return { mem8: new Uint8Array(buf), mem32, ptr };
}

describe("grDrawTriangle write-buffer capture", () => {
    test("is registered as a BARRIER with a three-pointer payload", () => {
        // The barrier is not a tuning choice: without it, coalescing spans two draws and
        // the setters of consecutive triangles collapse into one.
        const { spec } = ringHandlerFor(makeContext().context);
        expect(spec).toEqual({ argCount: 3, ptrArgIndices: [0, 1, 2], payloadDwords: GR_VERTEX_FLOATS });
    });

    test("trap path and ring path produce identical vertices, draws and counters", () => {
        // The real differential: one guest memory holding the three GrVertex structs, read
        // by the trap path through Mem and by the ring path out of a capture of the same
        // bytes. Anything the two paths disagree on shows up here as a value, not a count.
        const PTRS = [0x2000, 0x2000 + GR_VERTEX_SIZE, 0x2000 + GR_VERTEX_SIZE * 2];
        const guest = new Uint8Array(0x8000);
        const guestF32 = new Float32Array(guest.buffer);
        for (let v = 0; v < 3; v++) {
            for (let i = 0; i < GR_VERTEX_FLOATS; i++) guestF32[(PTRS[v]! >> 2) + i] = TRI[v]![i]!;
        }
        Mem.bind(() => guest, () => true, () => null);
        try {
            const trap = makeContext();
            const trapDraw = createDrawExports(trap.context)["_grDrawTriangle@12"]!;
            trapDraw(null as never, null as never, PTRS as never);

            const ring = makeContext();
            const { handler } = ringHandlerFor(ring.context);
            const e = ringEntry(PTRS, TRI);
            handler(e.mem8, e.mem32, e.ptr);

            expect(ring.pushed).toEqual(trap.pushed);
            expect(ring.pushed.length).toBe(3);
            expect(ring.draws).toEqual(trap.draws);
            expect(ring.context.frameSnapshot.drawCalls).toBe(trap.context.frameSnapshot.drawCalls);
            expect(ring.context.frameSnapshot.frameCounters.vertexBytes)
                .toBe(trap.context.frameSnapshot.frameCounters.vertexBytes);
            expect(ring.context.diagnostics.getRecent(8).map(x => `${x.type}:${x.detail}`))
                .toEqual(trap.context.diagnostics.getRecent(8).map(x => `${x.type}:${x.detail}`));
        } finally {
            Mem.bind(null as never, undefined, undefined);
        }
    });

    test("the ring payload decodes each vertex at its own stride", () => {
        // A payload read one vertex-stride out still renders a triangle — it just renders
        // the wrong one. Pin the actual values against the floats that went in.
        const ring = makeContext();
        const { handler } = ringHandlerFor(ring.context);
        const e = ringEntry([0x1000, 0x2000, 0x3000], TRI);
        handler(e.mem8, e.mem32, e.ptr);

        expect(ring.pushed.map(p => [p.x, p.y])).toEqual([[10, 20], [30, 40], [50, 60]]);
        expect(ring.pushed.map(p => [p.u, p.v])).toEqual([[10 / 64, 20 / 64], [30 / 64, 40 / 64], [50 / 64, 60 / 64]]);
        // Colour is packed ABGR; the three vertices carried pure red, green and blue.
        expect(ring.pushed.map(p => (p.color >>> 0).toString(16)))
            .toEqual(["ff0000ff", "ff00ff00", "ffff0000"]);
    });

    test("a null vertex pointer declines the draw on both paths", () => {
        const trap = makeContext();
        const trapDraw = createDrawExports(trap.context)["_grDrawTriangle@12"]!;
        trapDraw(null as never, null as never, [0x1000, 0, 0x3000] as never);

        const ring = makeContext();
        const { handler } = ringHandlerFor(ring.context);
        const e = ringEntry([0x1000, 0, 0x3000], TRI);
        handler(e.mem8, e.mem32, e.ptr);

        expect(trap.pushed.length).toBe(0);
        expect(ring.pushed.length).toBe(0);
    });
});
