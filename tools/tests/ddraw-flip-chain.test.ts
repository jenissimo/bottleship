/**
 * DirectDraw flip-chain contract.
 *
 * Flip RENAMES surfaces around the chain — it does not copy pixels. The guest keeps
 * its interface pointers while the storage behind them rotates by one, so every buffer
 * retains the frame it last displayed and a 2-surface chain returns to its starting
 * arrangement after two Flips. Dirty-rectangle renderers depend on exactly that: they
 * redraw only what changed and leave the rest of the frame to the content the buffer
 * already holds.
 *
 * Pinned against Wine's conformance tests (dlls/ddraw/tests/ddraw7.c `test_flip`,
 * mirrored in ddraw1/2/4), which fill a 4-surface chain red/green/blue and assert after
 * one Flip that backbuffer1 reads green and backbuffer2 reads blue — the colours move
 * one position towards the front. Those tests run against real Windows, and they call
 * out the failure mode this file guards: "The testbot seems to just copy the contents
 * of one surface to all the others, instead of properly flipping."
 */

import { describe, expect, test } from "bun:test";
import {
    collectFlipChain,
    findFlipBlockingLease,
    flipStorageCompatible,
    rotateFlipChain,
} from "../../src/worker/modules/ddraw/flip-chain";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

const DDSCAPS_FLIP = 0x00000010;
const DDSCAPS_ZBUFFER = 0x00020000;

/** Minimal RenderSurface good enough for the rotation: identity fields plus the
 *  storage fields the rotation is supposed to move. */
function surface(surfacePtr: number, attachedSurfaceAddr: number, caps = DDSCAPS_FLIP): DirectDrawSurfaceState {
    return {
        surfaceType: "render_surface",
        width: 640,
        height: 480,
        pitch: 640 * 4,
        caps,
        surfacePtr,
        surfacePtrAllocated: true,
        attachedSurfaceAddr,
        format: { flags: 0x40, bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff, aMask: 0 },
        mode: "GPU_ONLY",
        version: 0,
        gpuDirty: false,
        everLocked: false,
        lastUploadVersion: -1,
        writeGeneration: 0,
    } as unknown as DirectDrawSurfaceState;
}

/** The colour a surface currently shows = the storage it currently holds. */
const image = (s: DirectDrawSurfaceState) => s.surfacePtr;

describe("ddraw flip chain", () => {
    test("Flip exchanges the two surfaces of a 2-buffer chain", () => {
        const front = surface(0xa000, 0);
        const back = surface(0xb000, 0);
        const chain = [front, back];

        rotateFlipChain(chain);

        // The image the guest drew into the back buffer is now on the front, and the
        // back buffer holds what used to be displayed — NOT a copy of the new frame.
        expect(image(front)).toBe(0xb000);
        expect(image(back)).toBe(0xa000);
        expect(image(front)).not.toBe(image(back));
    });

    test("two Flips return a 2-buffer chain to its starting arrangement", () => {
        const front = surface(0xa000, 0);
        const back = surface(0xb000, 0);
        const chain = [front, back];

        rotateFlipChain(chain);
        rotateFlipChain(chain);

        expect(image(front)).toBe(0xa000);
        expect(image(back)).toBe(0xb000);
    });

    test("content a buffer is not asked to redraw survives its turn off-screen", () => {
        // What TLJ's main menu relies on: paint a frame, flip twice, and the buffer
        // still holds it. A copying Flip collapses both buffers onto one image, so a
        // full-surface clear of the back destroys the retained frame for good.
        const front = surface(0xa000, 0);
        const back = surface(0xb000, 0);
        const chain = [front, back];

        rotateFlipChain(chain); // composed menu (0xb000) goes on screen
        const retained = image(back); // the buffer now holding the previous frame
        rotateFlipChain(chain);

        expect(image(front)).toBe(retained);
    });

    test("a longer chain rotates one position towards the front", () => {
        // ddraw7.c test_flip: bb1=red bb2=green bb3=blue; after Flip bb1 reads green
        // and bb2 reads blue — each surface takes its successor's image.
        const front = surface(0xf000, 0);
        const bb1 = surface(0x1000, 0);
        const bb2 = surface(0x2000, 0);
        const bb3 = surface(0x3000, 0);
        const chain = [front, bb1, bb2, bb3];

        rotateFlipChain(chain);

        expect(image(front)).toBe(0x1000);
        expect(image(bb1)).toBe(0x2000);
        expect(image(bb2)).toBe(0x3000);
        expect(image(bb3)).toBe(0xf000); // the old front wraps onto the last buffer
    });

    test("four Flips return a 4-surface chain to its starting arrangement", () => {
        const s = [surface(0xf000, 0), surface(0x1000, 0), surface(0x2000, 0), surface(0x3000, 0)];
        const before = s.map(image);
        for (let i = 0; i < 4; i++) rotateFlipChain(s);
        expect(s.map(image)).toEqual(before);
    });

    test("Flip(target) rotates only the span up to that surface", () => {
        // IDirectDrawSurface7::Flip with lpDDSurfaceTargetOverride: the surfaces past
        // the named one keep their contents.
        const front = surface(0xf000, 0);
        const bb1 = surface(0x1000, 0);
        const bb2 = surface(0x2000, 0);
        const bb3 = surface(0x3000, 0);
        const chain = [front, bb1, bb2, bb3];

        rotateFlipChain(chain, 2); // Flip(front, bb1)

        expect(image(front)).toBe(0x1000);
        expect(image(bb1)).toBe(0xf000);
        expect(image(bb2)).toBe(0x2000); // untouched
        expect(image(bb3)).toBe(0x3000); // untouched
    });

    test("rotation moves the GPU texture and content version, not the surface identity", () => {
        const front = surface(0xa000, 0, 0x10006218);
        const back = surface(0xb000, 0, 0x6014);
        const frontTex = { id: "front" } as unknown as GPUTexture;
        const backTex = { id: "back" } as unknown as GPUTexture;
        front.gpuTexture = frontTex;
        back.gpuTexture = backTex;
        (back as { version: number }).version = 42;

        rotateFlipChain([front, back]);

        // Storage travelled…
        expect(front.gpuTexture).toBe(backTex);
        expect(back.gpuTexture).toBe(frontTex);
        expect((front as unknown as { version: number }).version).toBe(42);
        // …identity did not: caps still say which slot is the primary.
        expect(front.caps).toBe(0x10006218);
        expect(back.caps).toBe(0x6014);
    });

    test("a single surface with no attachment is not rotated", () => {
        const only = surface(0xa000, 0);
        rotateFlipChain([only]);
        expect(image(only)).toBe(0xa000);
    });

    test("collectFlipChain walks the attachment ring back to the front", () => {
        const front = surface(0xa000, 0xb0);
        const bb1 = surface(0xb000, 0xc0);
        const bb2 = surface(0xc000, 0xa0);
        const byAddr: Record<number, DirectDrawSurfaceState> = { 0xa0: front, 0xb0: bb1, 0xc0: bb2 };
        const resolve = (addr: number) => {
            const st = byAddr[addr];
            return st ? ({ getState: () => st } as never) : null;
        };

        const chain = collectFlipChain(0xa0, resolve);

        expect(chain?.map((e) => e.addr)).toEqual([0xa0, 0xb0, 0xc0]);
        expect(chain?.map((e) => image(e.state))).toEqual([0xa000, 0xb000, 0xc000]);
    });

    test("collectFlipChain rejects links that do not close into a ring", () => {
        const front = surface(0xa000, 0xb0);
        const orphan = surface(0xb000, 0);
        const byAddr: Record<number, DirectDrawSurfaceState> = { 0xa0: front, 0xb0: orphan };
        const resolve = (addr: number) => {
            const st = byAddr[addr];
            return st ? ({ getState: () => st } as never) : null;
        };

        expect(collectFlipChain(0xa0, resolve)).toBeNull();
    });

    test("collectFlipChain refuses a non-flippable attachment", () => {
        // AddAttachedSurface overwrites the single link slot, so a game that attaches a
        // z buffer to the buffer it flips through would otherwise put a DEPTH surface on
        // the chain — and rotation would swap depth storage with colour storage.
        const front = surface(0xa000, 0xb0);
        const zbuf = surface(0xb000, 0xa0, DDSCAPS_ZBUFFER);
        const byAddr: Record<number, DirectDrawSurfaceState> = { 0xa0: front, 0xb0: zbuf };
        const resolve = (addr: number) => {
            const st = byAddr[addr];
            return st ? ({ getState: () => st } as never) : null;
        };

        expect(collectFlipChain(0xa0, resolve)).toBeNull();
    });

    test("depth and colour storage are never compatible, whatever the geometry", () => {
        const colour = surface(0xa000, 0);
        const depth = surface(0xb000, 0, DDSCAPS_FLIP | DDSCAPS_ZBUFFER);
        expect(flipStorageCompatible(colour, depth)).toBe(false);
        expect(flipStorageCompatible(colour, surface(0xc000, 0))).toBe(true);
    });

    test("the slot's own driving mode does not travel with the image", () => {
        // `mode`/`everLocked` say how THIS slot is driven — one GetDC on the primary demotes
        // the primary permanently. Carrying them would move that demotion to the back buffer
        // on the next Flip, and the two would alternate every frame.
        const front = surface(0xa000, 0);
        const back = surface(0xb000, 0);
        (front as unknown as { mode: string; everLocked: boolean }).mode = "CPU";
        (front as unknown as { everLocked: boolean }).everLocked = true;

        rotateFlipChain([front, back]);

        expect((front as unknown as { mode: string }).mode).toBe("CPU");
        expect((front as unknown as { everLocked: boolean }).everLocked).toBe(true);
        expect((back as unknown as { mode: string }).mode).toBe("GPU_ONLY");
        expect((back as unknown as { everLocked: boolean }).everLocked).toBe(false);
    });

    test("rotation reports every storage move with the pointer that left the slot", () => {
        // The surfacePtr→handle index and the deferred-upload batch are both keyed by the
        // storage being renamed; without this they describe the other chain member.
        const front = surface(0xa000, 0);
        const back = surface(0xb000, 0);
        const moves: { to: DirectDrawSurfaceState; from: DirectDrawSurfaceState; previousPtr: number }[] = [];

        rotateFlipChain([front, back], 2, (m) => moves.push({ ...m }));

        // `from` identifies the SLOT the image came from — that is the key any index built
        // before the rotation is stored under — and previousPtr the allocation that left.
        expect(moves.map((m) => m.previousPtr)).toEqual([0xa000, 0xb000]);
        expect(moves[0]!.to).toBe(front);
        expect(moves[0]!.from).toBe(back);
        expect(moves[1]!.to).toBe(back);
        expect(moves[1]!.from).toBe(front);
        expect(front.surfacePtr).toBe(0xb000);
    });

    test("a live Lock lease names the surface that blocks the flip", () => {
        const front = surface(0xa000, 0);
        const back = surface(0xb000, 0);
        expect(findFlipBlockingLease([front, back])).toBeNull();
        // A lease id with nothing behind it in the registry must not wedge the frame loop.
        back.activeLeaseId = 12345;
        expect(findFlipBlockingLease([front, back])).toBeNull();
    });
});
