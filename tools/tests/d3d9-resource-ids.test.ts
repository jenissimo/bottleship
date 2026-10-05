/**
 * The COM pointer -> stable resource id table (§9 step 4 of the D3D9 target architecture).
 *
 * The load-bearing case is RECYCLING: COM blocks come from a shared pool, so a pointer that named
 * a texture can, one allocation later, name a vertex buffer belonging to another subsystem
 * entirely (this project already shipped that bug — Gothic died inside dinput dispatching through
 * a freed vertex buffer's block). Every test below that mentions "recycle" is checking that the
 * table cannot answer for the previous occupant, and each one is also run with the invalidation
 * BYPASSED so the check is shown to fail when the thing it guards is removed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    D3D9ResourceKind,
    D3D9_RESOURCE_ID_NONE,
    D3D9_RESOURCE_ID_UNRESOLVED,
    clearResourceKindProbesForTests,
    d3d9ResourceIdStats,
    d3d9ResourceIdTableAbi,
    invalidateResourceId,
    isResourceIdLive,
    peekResourceId,
    registerResourceKindProbe,
    resetResourceIds,
    resolveResourceId,
    resourceIdKind,
    resourceIdPtr,
} from "../../src/worker/modules/d3d9/resource-ids";

/** Stand-in for textureMeta / vertexBufferMeta / ... — the registries the real probes read. */
const liveTextures = new Set<number>();
const liveVertexBuffers = new Set<number>();
const liveShaders = new Set<number>();

type BypassFlags = { __d3d9ResourceIdNoInvalidate?: boolean };
const flags = globalThis as BypassFlags;

beforeEach(() => {
    resetResourceIds();
    clearResourceKindProbesForTests();
    liveTextures.clear();
    liveVertexBuffers.clear();
    liveShaders.clear();
    registerResourceKindProbe(D3D9ResourceKind.Texture, (p) => liveTextures.has(p));
    registerResourceKindProbe(D3D9ResourceKind.VertexBuffer, (p) => liveVertexBuffers.has(p));
    registerResourceKindProbe(D3D9ResourceKind.VertexShader, (p) => liveShaders.has(p));
});

afterEach(() => {
    delete flags.__d3d9ResourceIdNoInvalidate;
    resetResourceIds();
    clearResourceKindProbesForTests();
});

describe("d3d9 resource id table", () => {
    test("a null interface pointer is a binding of nothing, not a failure", () => {
        expect(resolveResourceId(0, D3D9ResourceKind.Texture)).toBe(D3D9_RESOURCE_ID_NONE);
        expect(d3d9ResourceIdStats().misses).toBe(0);
    });

    test("the id is stable across repeated lookups and identifies the pointer both ways", () => {
        liveTextures.add(0x8000);
        const id = resolveResourceId(0x8000, D3D9ResourceKind.Texture);
        expect(id).toBeGreaterThan(0);
        expect(resolveResourceId(0x8000, D3D9ResourceKind.Texture)).toBe(id);
        expect(resolveResourceId(0x8000, D3D9ResourceKind.Texture)).toBe(id);
        expect(resourceIdPtr(id)).toBe(0x8000);
        expect(resourceIdKind(id)).toBe(D3D9ResourceKind.Texture);
        expect(isResourceIdLive(id)).toBe(true);

        const stats = d3d9ResourceIdStats();
        expect(stats.minted).toBe(1);
        expect(stats.hits).toBe(2);
        expect(stats.verdict).toBe("consistent");
    });

    test("distinct resources get distinct ids across kinds", () => {
        liveTextures.add(0x1000);
        liveVertexBuffers.add(0x2000);
        liveShaders.add(0x3000);
        const ids = [
            resolveResourceId(0x1000, D3D9ResourceKind.Texture),
            resolveResourceId(0x2000, D3D9ResourceKind.VertexBuffer),
            resolveResourceId(0x3000, D3D9ResourceKind.VertexShader),
        ];
        expect(new Set(ids).size).toBe(3);
        expect(ids.every((id) => id > 0)).toBe(true);
    });

    test("a pointer no registry vouches for is REFUSED, not invented", () => {
        expect(resolveResourceId(0x4000, D3D9ResourceKind.Texture)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
        const stats = d3d9ResourceIdStats();
        expect(stats.misses).toBe(1);
        expect(stats.minted).toBe(0);
        expect(peekResourceId(0x4000)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
    });

    test("a kind with no probe installed is counted separately from a miss", () => {
        clearResourceKindProbesForTests();
        expect(resolveResourceId(0x4000, D3D9ResourceKind.IndexBuffer)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
        const stats = d3d9ResourceIdStats();
        expect(stats.probeMissing).toBe(1);
        expect(stats.misses).toBe(0);
    });

    // ── recycling ───────────────────────────────────────────────────────────────

    test("RECYCLE: a block reused by another subsystem does not resolve to the dead resource", () => {
        // The Gothic shape: the block is freed, something outside d3d9 takes it, and nothing
        // re-registers the pointer here. Nothing but invalidation can save this lookup.
        liveTextures.add(0x9000);
        const texId = resolveResourceId(0x9000, D3D9ResourceKind.Texture);
        expect(texId).toBeGreaterThan(0);

        liveTextures.delete(0x9000);
        expect(invalidateResourceId(0x9000)).toBe(true);

        expect(resolveResourceId(0x9000, D3D9ResourceKind.Texture)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
        expect(isResourceIdLive(texId)).toBe(false);
        expect(resourceIdPtr(texId)).toBe(0);
    });

    test("RECYCLE: the same check FAILS when invalidation is bypassed", () => {
        // The bypass is the proof the assertion above is load-bearing rather than decorative.
        flags.__d3d9ResourceIdNoInvalidate = true;
        liveTextures.add(0x9000);
        const texId = resolveResourceId(0x9000, D3D9ResourceKind.Texture);

        liveTextures.delete(0x9000);
        expect(invalidateResourceId(0x9000)).toBe(false);

        // Resolves to the DESTROYED texture — this is the bug, reproduced on demand.
        expect(resolveResourceId(0x9000, D3D9ResourceKind.Texture)).toBe(texId);
        expect(isResourceIdLive(texId)).toBe(true);
    });

    test("RECYCLE: allocate, register, release to zero, reallocate the block as another kind", () => {
        const block = 0xa100;
        liveTextures.add(block);
        const texId = resolveResourceId(block, D3D9ResourceKind.Texture);

        // Release to zero: the metadata goes and the table is invalidated.
        liveTextures.delete(block);
        invalidateResourceId(block);

        // The pool hands the SAME block to a vertex buffer.
        liveVertexBuffers.add(block);
        const vbId = resolveResourceId(block, D3D9ResourceKind.VertexBuffer);

        expect(vbId).toBeGreaterThan(0);
        expect(vbId).not.toBe(texId);
        expect(resourceIdKind(vbId)).toBe(D3D9ResourceKind.VertexBuffer);
        // The old id stays dead forever — ids are never reused.
        expect(isResourceIdLive(texId)).toBe(false);
        // And a stale SetTexture naming the block is refused rather than answered.
        expect(resolveResourceId(block, D3D9ResourceKind.Texture)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
        expect(d3d9ResourceIdStats().kindMismatch).toBe(1);
    });

    test("RECYCLE across kinds: the same sequence hands back the WRONG kind when bypassed", () => {
        flags.__d3d9ResourceIdNoInvalidate = true;
        const block = 0xa100;
        liveTextures.add(block);
        const texId = resolveResourceId(block, D3D9ResourceKind.Texture);

        liveTextures.delete(block);
        invalidateResourceId(block);
        liveVertexBuffers.add(block);

        // The stale entry answers first: the block is now a vertex buffer, and the table still
        // calls it texture `texId`.
        expect(resolveResourceId(block, D3D9ResourceKind.Texture)).toBe(texId);
        expect(resourceIdKind(texId)).toBe(D3D9ResourceKind.Texture);
    });

    test("invalidating a pointer the table never saw is a cheap no-op", () => {
        expect(invalidateResourceId(0xdead0)).toBe(false);
        expect(invalidateResourceId(0)).toBe(false);
        expect(d3d9ResourceIdStats().invalidated).toBe(0);
    });

    // ── the table's own failure counter ─────────────────────────────────────────

    test("staleHits fires when the reverse entry stops naming the pointer", () => {
        // Manufacture the exact corruption the counter exists to name: the probe and the
        // reverse map torn apart. (A MISSED invalidation is not this — it leaves both halves
        // agreeing; only the wire test can see that one.)
        liveTextures.add(0xb000);
        const id = resolveResourceId(0xb000, D3D9ResourceKind.Texture);
        expect(d3d9ResourceIdStats().staleHits).toBe(0);

        d3d9ResourceIdTableAbi().idPtr[id] = 0;

        expect(resolveResourceId(0xb000, D3D9ResourceKind.Texture)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
        const stats = d3d9ResourceIdStats();
        expect(stats.staleHits).toBe(1);
        expect(stats.verdict).toBe("TORN: the probe and the reverse map disagree");
    });

    test("an untouched table reports 'never consulted', not a clean bill of health", () => {
        expect(d3d9ResourceIdStats().verdict).toBe("never consulted");
    });

    // ── probe-chain integrity ───────────────────────────────────────────────────

    test("removal keeps colliding probe chains reachable", () => {
        // Enough pointers to force collisions and at least one rehash, then delete half of them
        // and check that every survivor still resolves to the id it was minted with.
        const ids = new Map<number, number>();
        for (let i = 0; i < 2000; i++) {
            const ptr = 0x10000 + i * 0x100;
            liveTextures.add(ptr);
            ids.set(ptr, resolveResourceId(ptr, D3D9ResourceKind.Texture));
        }
        expect(d3d9ResourceIdStats().rehashes).toBeGreaterThan(0);

        for (const ptr of [...ids.keys()]) {
            if ((ptr & 0x100) === 0) continue;
            liveTextures.delete(ptr);
            expect(invalidateResourceId(ptr)).toBe(true);
            ids.delete(ptr);
        }

        for (const [ptr, id] of ids) {
            expect(resolveResourceId(ptr, D3D9ResourceKind.Texture)).toBe(id);
        }
        expect(d3d9ResourceIdStats().live).toBe(ids.size);
        expect(d3d9ResourceIdStats().staleHits).toBe(0);
    });

    test("high guest pointers (>= 2GB) round-trip", () => {
        const ptr = 0xc0001000;
        liveTextures.add(ptr);
        const id = resolveResourceId(ptr, D3D9ResourceKind.Texture);
        expect(id).toBeGreaterThan(0);
        expect(resourceIdPtr(id)).toBe(ptr);
        expect(resolveResourceId(ptr, D3D9ResourceKind.Texture)).toBe(id);
        expect(invalidateResourceId(ptr)).toBe(true);
        expect(resourceIdPtr(id)).toBe(0);
    });

    test("reset restarts the id space", () => {
        liveTextures.add(0x8000);
        const first = resolveResourceId(0x8000, D3D9ResourceKind.Texture);
        resetResourceIds();
        registerResourceKindProbe(D3D9ResourceKind.Texture, (p) => liveTextures.has(p));
        const second = resolveResourceId(0x8000, D3D9ResourceKind.Texture);
        expect(second).toBe(first);
        expect(d3d9ResourceIdStats().idsEverMinted).toBe(1);
    });
});
