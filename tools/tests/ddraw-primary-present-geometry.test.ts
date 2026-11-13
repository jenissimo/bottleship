/**
 * A windowed DirectDraw primary is an image of the whole guest screen and shows the host
 * view's part of it; an exclusive full-screen primary owns the display and is never cropped.
 */
import { describe, expect, test } from "bun:test";
import { primaryPresentGeometry } from "../../src/worker/modules/ddraw/presenter";

const DDSCL_FULLSCREEN = 0x1, DDSCL_NORMAL = 0x8, DDSCL_EXCLUSIVE = 0x10;
const ctx = (flags: number) => ({ cooperative: { flags } }) as unknown as Parameters<typeof primaryPresentGeometry>[4];

describe("the DirectDraw primary's present geometry", () => {
    test("exclusive full screen is not a screen plane, so it is never cropped", () => {
        expect(primaryPresentGeometry(640, 480, 1280, 960, ctx(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN)).screenPlane).toBe(false);
    });

    test("a normal (windowed) primary and no DirectDraw context are screen planes", () => {
        expect(primaryPresentGeometry(1024, 768, 1280, 960, ctx(DDSCL_NORMAL)).screenPlane).toBe(true);
        expect(primaryPresentGeometry(1024, 768, 1280, 960, null).screenPlane).toBe(true);
    });

    test("the sizes go through to the post-fx chain unchanged", () => {
        expect(primaryPresentGeometry(640, 480, 1280, 960, null)).toEqual(
            { srcW: 640, srcH: 480, outW: 1280, outH: 960, toCanvas: true, screenPlane: true });
    });
});
