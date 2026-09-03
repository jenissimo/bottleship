/**
 * grTexSource on the write-buffer ring — differential against the OUT-trap path.
 *
 * grTexSource is the only hot Glide entry point that takes a guest POINTER, which is why
 * it stayed trapped while every scalar setter moved to the ring: a deferred call reads the
 * bytes present at DRAIN time, not at call time. Capture-at-call fixes exactly that, and
 * the reason it is sound here is the real contract: gtex.c's grTexSource reads the five
 * dwords of GrTexInfo and nothing they point at.
 *
 * FAST-PATH LEDGER RULE — the two paths must update the same counters, so this runs BOTH
 * over the same call and compares the ledgers, not just the rendered outcome. It also pins
 * the ring payload layout, because a capture that reads the struct at the wrong offsets
 * still produces a plausible frame.
 */

import { describe, expect, test } from "bun:test";
import { createTextureExports } from "../../src/worker/modules/glide2x/texture";
import { registerGlideWriteBufferFunctions } from "../../src/worker/modules/glide2x/fast-path";
import { GlideContext, GlideTextureRecord } from "../../src/worker/modules/glide2x/context";
import { GlideDiagnostics } from "../../src/worker/modules/glide2x/diagnostics";
import { Legacy3DFFPState } from "../../src/worker/backends/webgpu/legacy3d/ffp-state";
import {
    GR_TEXINFO_SMALL_LOD_OFFSET,
    GR_TEXINFO_LARGE_LOD_OFFSET,
    GR_TEXINFO_ASPECT_OFFSET,
    GR_TEXINFO_FORMAT_OFFSET,
    GR_TEXINFO_DATA_OFFSET,
    GR_TEXINFO_SIZE,
} from "../../src/worker/modules/glide2x/constants";

const TEX_ADDR = 0x18000;

function texture(handle: number, startAddress: number): GlideTextureRecord {
    return {
        handle, tmu: 0, startAddress, dataPtr: 0x900000, width: 64, height: 64, format: 10,
        smallLod: 0, largeLod: 6, aspectRatio: 3, evenOdd: 3, bytes: 64 * 64 * 2,
        uploadedAt: 1, lastUsedFrame: 0, sourceBytes: null,
    } as GlideTextureRecord;
}

function makeContext(): GlideContext {
    const tmu = {
        texturesByAddress: new Map<number, GlideTextureRecord>(),
        currentAddress: 0, minAddress: 0, maxAddress: 0,
        palette: null, nccTables: [null, null], activeNcc: 0,
    };
    return {
        tmus: [tmu],
        ffpState: new Legacy3DFFPState(),
        diagnostics: new GlideDiagnostics(64),
        executor: null,
        frameSnapshot: { frameId: 1000, texDownloads: 0, frameCounters: { uploads: 0, textureBytes: 0, textureBinds: 0 } },
    } as unknown as GlideContext;
}

/** Register against a dispatcher that only records, and hand back the drain handler. */
function ringHandlerFor(context: GlideContext) {
    let captured: ((mem8: Uint8Array, mem32: Uint32Array, dataPtr: number) => void) | null = null;
    let spec: { argCount: number; ptrArgIndex: number; payloadDwords: number } | null = null;
    const dispatcher = {
        registerWriteBufferFunction: () => true,
        registerStructCaptureWriteBufferFunction: (
            _dll: string, func: string, argCount: number, ptrArgIndex: number,
            payloadDwords: number, handler: (m8: Uint8Array, m32: Uint32Array, p: number) => void,
        ) => {
            if (func !== "_grTexSource@16") return;
            captured = handler;
            spec = { argCount, ptrArgIndex, payloadDwords };
        },
    };
    registerGlideWriteBufferFunctions(dispatcher, createTextureExports(context), context);
    if (!captured || !spec) throw new Error("grTexSource was not registered for struct capture");
    return { handler: captured as (m8: Uint8Array, m32: Uint32Array, p: number) => void, spec: spec! };
}

/** The ring entry the trampoline writes: [tmu][startAddress][evenOdd][infoPtr][GrTexInfo…]. */
function ringEntry(args: number[], info: number[]): { mem8: Uint8Array; mem32: Uint32Array; ptr: number } {
    const buf = new ArrayBuffer(256);
    const mem32 = new Uint32Array(buf);
    const ptr = 64; // byte offset of the entry's first scalar arg
    const w = ptr >> 2;
    for (let i = 0; i < args.length; i++) mem32[w + i] = args[i]! >>> 0;
    for (let i = 0; i < info.length; i++) mem32[w + args.length + i] = info[i]! >>> 0;
    return { mem8: new Uint8Array(buf), mem32, ptr };
}

function ledger(context: GlideContext) {
    return {
        textureEnabled: context.ffpState.textureEnabled,
        textureHandle: context.ffpState.textureHandle,
        textureBinds: context.frameSnapshot.frameCounters.textureBinds,
        currentAddress: context.tmus[0]!.currentAddress,
        lastUsedFrame: context.tmus[0]!.texturesByAddress.get(TEX_ADDR)?.lastUsedFrame,
        ringEvents: context.diagnostics.getRecent(8).map(e => `${e.type}:${e.detail}`),
    };
}

describe("grTexSource write-buffer capture", () => {
    test("the ring payload is the whole GrTexInfo, in the struct's own dword order", () => {
        // 5 dwords is not a magic number: it is sizeof(GrTexInfo), and the capture reads
        // the fields at fixed dword indices after the scalar args. If the struct ever
        // grows, the payload size and those indices must move together.
        expect(GR_TEXINFO_SIZE).toBe(20);
        expect(GR_TEXINFO_SMALL_LOD_OFFSET >> 2).toBe(0);
        expect(GR_TEXINFO_LARGE_LOD_OFFSET >> 2).toBe(1);
        expect(GR_TEXINFO_ASPECT_OFFSET >> 2).toBe(2);
        expect(GR_TEXINFO_FORMAT_OFFSET >> 2).toBe(3);
        expect(GR_TEXINFO_DATA_OFFSET >> 2).toBe(4);

        const { spec } = ringHandlerFor(makeContext());
        expect(spec).toEqual({ argCount: 4, ptrArgIndex: 3, payloadDwords: GR_TEXINFO_SIZE / 4 });
    });

    test("trap path and ring path leave identical ledgers for a resident texture", () => {
        const trapCtx = makeContext();
        trapCtx.tmus[0]!.texturesByAddress.set(TEX_ADDR, texture(42, TEX_ADDR));
        const trap = createTextureExports(trapCtx)["_grTexSource@16"]!;
        trap(null as never, null as never, [0, TEX_ADDR, 3, 0x800000] as never);

        const ringCtx = makeContext();
        ringCtx.tmus[0]!.texturesByAddress.set(TEX_ADDR, texture(42, TEX_ADDR));
        const { handler } = ringHandlerFor(ringCtx);
        const e = ringEntry([0, TEX_ADDR, 3, 0x800000], [0, 6, 3, 10, 0x900000]);
        handler(e.mem8, e.mem32, e.ptr);

        expect(ledger(ringCtx)).toEqual(ledger(trapCtx));
        expect(ledger(ringCtx).textureHandle).toBe(42);
        expect(ledger(ringCtx).textureBinds).toBe(1);
    });

    test("an unknown start address declines the bind on both paths", () => {
        // No resident texture and no way to upload one (no executor): the slow path
        // disables texturing rather than binding something else, and so must the ring.
        const trapCtx = makeContext();
        const trap = createTextureExports(trapCtx)["_grTexSource@16"]!;
        trapCtx.ffpState.setTexture(true, 9);
        trap(null as never, null as never, [0, TEX_ADDR, 3, 0] as never);

        const ringCtx = makeContext();
        const { handler } = ringHandlerFor(ringCtx);
        ringCtx.ffpState.setTexture(true, 9);
        const e = ringEntry([0, TEX_ADDR, 3, 0], [0, 6, 3, 10, 0]);
        handler(e.mem8, e.mem32, e.ptr);

        expect(ringCtx.ffpState.textureEnabled).toBe(false);
        expect(trapCtx.ffpState.textureEnabled).toBe(false);
        expect(ledger(ringCtx)).toEqual(ledger(trapCtx));
    });
});
