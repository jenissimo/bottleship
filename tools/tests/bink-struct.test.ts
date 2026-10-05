/**
 * HBINK ABI table — pinned against real binkw32.dll builds.
 *
 * The offsets below were read out of shipped DLLs (BinkNextFrame's frame-wrap
 * compare, BinkGetSummary's field copies, BinkGetRects' rect/count accesses):
 *   Bink 0.5a — HoMM3            Frames@0x08 FrameNum@0x0C rects@0x30 num@0xB0
 *   Bink 0.8i — TLJ              Frames@0x10 FrameNum@0x14 rects@0x3C num@0xBC
 *   Bink 1.0f — Diablo II        Frames@0x08 FrameNum@0x0C rects@0x34 num@0xB4
 *   Bink 1.5a — Morrowind        as 1.0f
 * A game reads these at the offsets its own bink.h declared, so one fixed layout
 * cannot serve all of them: on 0.8x a "video finished" test (FrameNum==Frames-1)
 * reads FrameRate vs LastFrameNum and never fires — the playback loop spins forever.
 */

import { describe, expect, test } from "bun:test";
import {
    BINK_LAYOUT_V05,
    BINK_LAYOUT_V08,
    BINK_LAYOUT_V1,
    BINK_LAYOUT_DEFAULT,
    binkLayoutFor,
    selectBinkLayout,
} from "../../src/worker/modules/bink-struct";

describe("HBINK layouts match the shipped DLLs", () => {
    test("0.5x (HoMM3)", () => {
        expect(BINK_LAYOUT_V05).toMatchObject({
            width: 0x00, height: 0x04, frames: 0x08, frameNum: 0x0c,
            lastFrameNum: null, frameRate: 0x10, frameRateDiv: 0x14,
            frameRects: 0x30, numRects: 0xb0,
        });
    });

    test("0.8x (The Longest Journey) — Width/Height duplicated at 0x08/0x0C", () => {
        expect(BINK_LAYOUT_V08).toMatchObject({
            width: 0x00, height: 0x04, widthAlt: 0x08, heightAlt: 0x0c,
            frames: 0x10, frameNum: 0x14, lastFrameNum: 0x18,
            frameRate: 0x1c, frameRateDiv: 0x20,
            frameRects: 0x3c, numRects: 0xbc,
        });
    });

    test("1.x (Diablo II, Morrowind)", () => {
        expect(BINK_LAYOUT_V1).toMatchObject({
            width: 0x00, height: 0x04, frames: 0x08, frameNum: 0x0c,
            lastFrameNum: 0x10, frameRate: 0x14, frameRateDiv: 0x18,
            frameRects: 0x34, numRects: 0xb4,
        });
    });

    test("FrameRects is 8 BINKRECTs of 16 bytes in every layout", () => {
        for (const l of [BINK_LAYOUT_V05, BINK_LAYOUT_V08, BINK_LAYOUT_V1]) {
            expect(l.numRects - l.frameRects).toBe(8 * 16);
        }
    });
});

describe("selectBinkLayout keys off the DLL's FileVersion", () => {
    test("real FileVersion strings", () => {
        expect(selectBinkLayout("0.5a")?.id).toBe("0.5x");
        expect(selectBinkLayout("0.8i")?.id).toBe("0.8x");
        expect(selectBinkLayout("1.0f")?.id).toBe("1.x");
        expect(selectBinkLayout("1.5a")?.id).toBe("1.x");
        expect(selectBinkLayout("1.9x")?.id).toBe("1.x");
    });

    // RAD-era resource scripts write FileVersion as "0, 8, 0, 0". A dotted-only pattern
    // drops that onto the 1.x default — the exact 8-byte Frames/FrameNum misplacement
    // this table exists to prevent, and it fails with one log line.
    test("comma-separated resource-script versions resolve, not fall through", () => {
        expect(selectBinkLayout("0, 8, 0, 0")?.id).toBe("0.8x");
        expect(selectBinkLayout("0,5,0,0")?.id).toBe("0.5x");
        expect(selectBinkLayout("1, 9, 0, 0")?.id).toBe("1.x");
    });

    // An unresolvable version must not look like a resolution: the caller has to know it
    // is guessing, so this returns null rather than the default.
    test("unreadable version resolves to nothing", () => {
        expect(selectBinkLayout(null)).toBeNull();
        expect(selectBinkLayout("")).toBeNull();
        expect(selectBinkLayout("Bink")).toBeNull();
        expect(BINK_LAYOUT_DEFAULT).toBe(BINK_LAYOUT_V1);
    });

    test("binkLayoutFor takes the major/minor pair from any source (VS_FIXEDFILEINFO)", () => {
        expect(binkLayoutFor(0, 5).id).toBe("0.5x");
        expect(binkLayoutFor(0, 8).id).toBe("0.8x");
        expect(binkLayoutFor(1, 0).id).toBe("1.x");
        expect(binkLayoutFor(2, 7).id).toBe("1.x");
    });
});
