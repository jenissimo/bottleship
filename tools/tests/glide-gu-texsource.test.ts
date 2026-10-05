/**
 * guTexSource's NULL mipmap handle.
 *
 * glide.h defines `GR_NULL_MIPMAP_HANDLE ((GrMipMapId_t) -1)` and gutex.c's guTexSource
 * opens with `if (mmid == GR_NULL_MIPMAP_HANDLE) return;` — a no-op that leaves whatever
 * mipmap was sourced last still bound. We used to spell the sentinel 0, so 0xffffffff
 * fell through to the mmid resolver, missed the keyed lookup (it is not a TMU address),
 * missed the ordinal range, and landed on the "most recently uploaded texture" last
 * resort: an O(textures) walk that also BOUND the wrong texture. Carmageddon 2 calls
 * guTexSource with nothing but GR_NULL_MIPMAP_HANDLE, so that was every single call.
 *
 * The handler needs a GlideContext only for its TMU maps, FFP state and diagnostics
 * ring, so the fixture below is structural rather than a real device.
 */

import { describe, expect, test } from "bun:test";
import { createTextureExports, guMmidResolveStats } from "../../src/worker/modules/glide2x/texture";
import { GlideContext, GlideTextureRecord } from "../../src/worker/modules/glide2x/context";
import { GlideDiagnostics } from "../../src/worker/modules/glide2x/diagnostics";
import { Legacy3DFFPState } from "../../src/worker/backends/webgpu/legacy3d/ffp-state";

const GR_NULL_MIPMAP_HANDLE = 0xffffffff;

function texture(handle: number, startAddress: number, uploadedAt: number): GlideTextureRecord {
    return {
        handle,
        tmu: 0,
        startAddress,
        dataPtr: 0,
        width: 64,
        height: 64,
        format: 10,
        smallLod: -1,
        largeLod: -1,
        aspectRatio: -1,
        evenOdd: -1,
        bytes: 64 * 64 * 2,
        uploadedAt,
        lastUsedFrame: 0,
        sourceBytes: null,
    } as GlideTextureRecord;
}

function makeContext(): GlideContext {
    const tmu = {
        texturesByAddress: new Map<number, GlideTextureRecord>(),
        currentAddress: 0,
        minAddress: 0,
        maxAddress: 0,
        palette: null,
        nccTables: [null, null],
        activeNcc: 0,
    };
    return {
        tmus: [tmu],
        ffpState: new Legacy3DFFPState(),
        diagnostics: new GlideDiagnostics(64),
        executor: null,
        frameSnapshot: {
            frameId: 1000,
            texDownloads: 0,
            frameCounters: { uploads: 0, textureBytes: 0, textureBinds: 0 },
        },
    } as unknown as GlideContext;
}

describe("guTexSource(GR_NULL_MIPMAP_HANDLE)", () => {
    test("is a no-op: it neither binds nor disables, and never reaches the resolver", () => {
        const context = makeContext();
        const guTexSource = createTextureExports(context)["_guTexSource@4"]!;
        const tmu0 = context.tmus[0]!;
        // Two resident textures; the one uploaded last is what the old "recent" fallback
        // would have bound.
        tmu0.texturesByAddress.set(0x1000, texture(1, 0x1000, 100));
        tmu0.texturesByAddress.set(0x2000, texture(2, 0x2000, 200));

        // A real bind first, so "left alone" is distinguishable from "disabled".
        context.ffpState.setTexture(true, 1);
        const before = { ...guMmidResolveStats };

        guTexSource(null as never, null as never, [GR_NULL_MIPMAP_HANDLE] as never);

        expect(context.ffpState.textureEnabled).toBe(true);
        expect(context.ffpState.textureHandle).toBe(1);
        expect(context.frameSnapshot.frameCounters.textureBinds).toBe(0);
        // The ledger must show the sentinel, not a fallback — a resolve of ANY kind here
        // means the sentinel was not recognised.
        expect(guMmidResolveStats.nullHandle).toBe(before.nullHandle + 1);
        expect(guMmidResolveStats.keyed).toBe(before.keyed);
        expect(guMmidResolveStats.ordinalFallback).toBe(before.ordinalFallback);
        expect(guMmidResolveStats.recentFallback).toBe(before.recentFallback);
        expect(guMmidResolveStats.miss).toBe(before.miss);
    });

    test("mmid 0 is a valid mipmap id, not the sentinel", () => {
        // GrMipMapId_t indexes gc->mm_table.data, so 0 names the first allocation. Our
        // resolver keys on the TMU address the texture was downloaded to, and
        // grTexMinAddress is 0 — so a texture living at address 0 must be BOUND, not
        // read as "no texture".
        const context = makeContext();
        const guTexSource = createTextureExports(context)["_guTexSource@4"]!;
        context.tmus[0]!.texturesByAddress.set(0, texture(7, 0, 50));
        context.ffpState.setTexture(false, 0);

        guTexSource(null as never, null as never, [0] as never);

        expect(context.ffpState.textureEnabled).toBe(true);
        expect(context.ffpState.textureHandle).toBe(7);
    });
});
