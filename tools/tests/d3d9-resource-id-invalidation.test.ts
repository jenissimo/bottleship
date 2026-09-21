/**
 * The WIRE, not the table: com-refs must invalidate the pointer -> resource id table at every
 * point a COM object stops existing. The table's own unit tests call `invalidateResourceId`
 * directly; these call the real destruction paths, so a future refactor that adds a destruction
 * route bypassing `dropCount` fails here rather than in a game.
 *
 * The guest-side Release stub is not a fourth route: it declines (OUT-traps) at a refcount of 1,
 * so the destroying Release is always this JS path — see `guest-release-stub.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    addComRef,
    drainComFinalizers,
    forgetComObject,
    releaseComRef,
    trackComObject,
    unpinGuestRefcountStoreForTests,
} from "../../src/worker/modules/d3d9/com-refs";
import {
    D3D9ResourceKind,
    D3D9_RESOURCE_ID_UNRESOLVED,
    clearResourceKindProbesForTests,
    isResourceIdLive,
    peekResourceId,
    registerResourceKindProbe,
    resetResourceIds,
    resolveResourceId,
} from "../../src/worker/modules/d3d9/resource-ids";

type MirrorFlags = { __d3d9MirrorRefcount?: boolean; __d3d9ResourceIdNoInvalidate?: boolean };
const flags = globalThis as MirrorFlags;

const liveTextures = new Set<number>();
const TEX = 0x5000;

beforeEach(() => {
    // Keep the refcount in the JS mirror: these tests exercise destruction ordering, not guest
    // memory, and there is no bound Mem accessor in a unit test.
    flags.__d3d9MirrorRefcount = true;
    unpinGuestRefcountStoreForTests();
    drainComFinalizers();
    resetResourceIds();
    clearResourceKindProbesForTests();
    liveTextures.clear();
    liveTextures.add(TEX);
    registerResourceKindProbe(D3D9ResourceKind.Texture, (p) => liveTextures.has(p));
});

afterEach(() => {
    delete flags.__d3d9MirrorRefcount;
    delete flags.__d3d9ResourceIdNoInvalidate;
    drainComFinalizers();
    resetResourceIds();
    clearResourceKindProbesForTests();
});

describe("resource id invalidation is wired to COM destruction", () => {
    test("releaseComRef to zero drops the entry", () => {
        trackComObject(TEX);
        const id = resolveResourceId(TEX, D3D9ResourceKind.Texture);
        expect(id).toBeGreaterThan(0);

        expect(releaseComRef(TEX)).toBe(0);
        // The registry teardown that the finalizer would do, in the order it really happens.
        liveTextures.delete(TEX);

        expect(peekResourceId(TEX)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
        expect(isResourceIdLive(id)).toBe(false);
        expect(resolveResourceId(TEX, D3D9ResourceKind.Texture)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
    });

    test("only the LAST release invalidates; a release to a non-zero count keeps the id", () => {
        trackComObject(TEX);
        expect(addComRef(TEX)).toBe(2);
        const id = resolveResourceId(TEX, D3D9ResourceKind.Texture);

        expect(releaseComRef(TEX)).toBe(1);
        expect(isResourceIdLive(id)).toBe(true);
        expect(resolveResourceId(TEX, D3D9ResourceKind.Texture)).toBe(id);

        expect(releaseComRef(TEX)).toBe(0);
        expect(isResourceIdLive(id)).toBe(false);
    });

    test("a block recreated at the same address gets a NEW id", () => {
        trackComObject(TEX);
        const id = resolveResourceId(TEX, D3D9ResourceKind.Texture);
        expect(releaseComRef(TEX)).toBe(0);

        trackComObject(TEX);
        const reborn = resolveResourceId(TEX, D3D9ResourceKind.Texture);
        expect(reborn).toBeGreaterThan(0);
        expect(reborn).not.toBe(id);
        expect(isResourceIdLive(id)).toBe(false);
    });

    test("forgetComObject (an implicit subresource dying with its owner) drops the entry", () => {
        trackComObject(TEX);
        const id = resolveResourceId(TEX, D3D9ResourceKind.Texture);
        forgetComObject(TEX);
        liveTextures.delete(TEX);
        expect(isResourceIdLive(id)).toBe(false);
        expect(peekResourceId(TEX)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
    });

    test("drainComFinalizers (module reset) empties the table", () => {
        trackComObject(TEX);
        const id = resolveResourceId(TEX, D3D9ResourceKind.Texture);
        expect(isResourceIdLive(id)).toBe(true);
        drainComFinalizers();
        expect(isResourceIdLive(id)).toBe(false);
        expect(peekResourceId(TEX)).toBe(D3D9_RESOURCE_ID_UNRESOLVED);
    });

    test("BYPASS: with invalidation disabled, releaseComRef leaves the stale entry behind", () => {
        // Proof that the assertions above test the wire and not a tautology.
        flags.__d3d9ResourceIdNoInvalidate = true;
        trackComObject(TEX);
        const id = resolveResourceId(TEX, D3D9ResourceKind.Texture);

        expect(releaseComRef(TEX)).toBe(0);
        liveTextures.delete(TEX);

        expect(peekResourceId(TEX)).toBe(id);
        expect(isResourceIdLive(id)).toBe(true);
        expect(resolveResourceId(TEX, D3D9ResourceKind.Texture)).toBe(id);
    });
});
