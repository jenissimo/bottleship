import { describe, expect, test } from "bun:test";
import {
    clientToGuestPoint,
    computePresentDestRect,
    contentRectFromPresentRect,
    coversTarget,
    getPresentRect,
    publishPresentRect,
    type HostRect,
    type PresentRect,
} from "../../src/worker/backends/webgpu/shared/present-geometry";
import { DEFAULT_QUALITY, type QualityConfig } from "../../src/worker/core/quality-config";

// The whole point of present-geometry is that the worker's forward map (guest pixel -> where
// it lands on the canvas) and the host's inverse (pointer event -> guest pixel) are ONE
// definition. So the assertion is the round trip, not a second copy of the arithmetic.

const q = (over: Partial<QualityConfig>): QualityConfig => ({ ...DEFAULT_QUALITY, ...over });

/** The worker side: where guest pixel (gx, gy) lands in canvas backing pixels. */
function workerForward(
    rect: PresentRect, srcW: number, srcH: number, gx: number, gy: number,
): { x: number; y: number } {
    return { x: rect.x + (gx * rect.w) / srcW, y: rect.y + (gy * rect.h) / srcH };
}

/**
 * The host side, through the real functions: the canvas element's CSS box (taken here as the
 * backing buffer itself, so a canvas pixel IS a client pixel) narrowed to the content rect,
 * then a client point mapped back into guest space.
 */
function hostInverse(
    outW: number, outH: number, srcW: number, srcH: number, cx: number, cy: number,
): { x: number; y: number } {
    const box: HostRect = {
        left: 0, top: 0, width: outW, height: outH, right: outW, bottom: outH,
    };
    const content = contentRectFromPresentRect(box, getPresentRect(), outW, outH)!;
    return clientToGuestPoint(content, cx, cy, srcW, srcH);
}

interface Case {
    name: string;
    quality: QualityConfig;
    srcW: number; srcH: number;
    outW: number; outH: number;
    /** null = the picture covers the whole target. */
    expect: PresentRect | null;
}

const CASES: Case[] = [
    {
        name: "stretch fills the target",
        quality: q({ aspectMode: "stretch", integerScale: false }),
        srcW: 640, srcH: 480, outW: 1557, outH: 1168, expect: null,
    },
    {
        name: "pillarbox letterboxes a 4:3 picture in a 16:9 canvas",
        quality: q({ aspectMode: "pillarbox", integerScale: false }),
        srcW: 640, srcH: 480, outW: 1600, outH: 900,
        expect: { x: 200, y: 0, w: 1200, h: 900 },
    },
    {
        name: "pillarbox letterboxes a 16:9 picture in a 4:3 canvas",
        quality: q({ aspectMode: "pillarbox", integerScale: false }),
        srcW: 1280, srcH: 720, outW: 1024, outH: 768,
        expect: { x: 0, y: 96, w: 1024, h: 576 },
    },
    {
        name: "integer scale 2 in a canvas that is not a whole multiple",
        quality: q({ aspectMode: "integer", integerScale: false }),
        srcW: 640, srcH: 480, outW: 1557, outH: 1168,
        expect: { x: 138, y: 104, w: 1280, h: 960 },
    },
    {
        name: "integer FLOORS to 1 when the canvas is only 1.45x the guest",
        quality: q({ aspectMode: "integer", integerScale: false }),
        srcW: 640, srcH: 480, outW: 1000, outH: 700,
        expect: { x: 180, y: 110, w: 640, h: 480 },
    },
    {
        name: "integerScale on top of stretch behaves as integer",
        quality: q({ aspectMode: "stretch", integerScale: true }),
        srcW: 320, srcH: 200, outW: 1000, outH: 700,
        expect: { x: 20, y: 50, w: 960, h: 600 },
    },
    {
        name: "canvas SMALLER than the guest still scales 1 (picture overhangs)",
        quality: q({ aspectMode: "integer", integerScale: false }),
        srcW: 640, srcH: 480, outW: 320, outH: 240,
        expect: { x: -160, y: -120, w: 640, h: 480 },
    },
];

describe("present geometry", () => {
    for (const c of CASES) {
        test(`${c.name} — rect`, () => {
            expect(computePresentDestRect(c.srcW, c.srcH, c.outW, c.outH, c.quality)).toEqual(c.expect);
        });

        test(`${c.name} — hostInverse(workerForward(p)) === p`, () => {
            const rect = computePresentDestRect(c.srcW, c.srcH, c.outW, c.outH, c.quality);
            publishPresentRect(c.srcW, c.srcH, c.outW, c.outH, rect);
            const placed = rect ?? { x: 0, y: 0, w: c.outW, h: c.outH };
            const points = [
                [0, 0], [c.srcW / 2, c.srcH / 2], [c.srcW - 1, c.srcH - 1],
                [1, c.srcH - 1], [c.srcW - 1, 1], [c.srcW / 3, (2 * c.srcH) / 7],
            ];
            for (const [gx, gy] of points) {
                const canvasPt = workerForward(placed, c.srcW, c.srcH, gx!, gy!);
                const back = hostInverse(c.outW, c.outH, c.srcW, c.srcH, canvasPt.x, canvasPt.y);
                expect(back.x).toBeCloseTo(gx!, 6);
                expect(back.y).toBeCloseTo(gy!, 6);
            }
        });
    }

    test("a degenerate dimension publishes nothing and maps through the whole box", () => {
        publishPresentRect(640, 480, 1557, 1168, { x: 138, y: 104, w: 1280, h: 960 });
        // outH === 0: no rect to compute and nothing to publish, so the previous publication
        // must not be replaced by a bogus one.
        expect(computePresentDestRect(640, 0, 1557, 1168, q({ aspectMode: "integer" }))).toBeNull();
        publishPresentRect(640, 0, 1557, 0, null);
        expect(getPresentRect()).toEqual({
            x: 138, y: 104, w: 1280, h: 960, outW: 1557, outH: 1168, srcW: 640, srcH: 480,
        });
        // A published rect with a zero extent is not a map either — Infinity scale, NaN cursor.
        const box: HostRect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
        expect(contentRectFromPresentRect(
            box, { x: 0, y: 0, w: 0, h: 0, outW: 800, outH: 600, srcW: 640, srcH: 480 }, 800, 600,
        )).toBe(box);
    });

    test("a publication measured against another backing size is refused", () => {
        // integer is the mode where applying the FRACTIONS across a resize is wrong: the scale
        // itself is a floor of the ratio, so it changes with the canvas.
        publishPresentRect(640, 480, 1557, 1168, { x: 138, y: 104, w: 1280, h: 960 });
        const box: HostRect = { left: 0, top: 0, width: 1200, height: 900, right: 1200, bottom: 900 };
        expect(contentRectFromPresentRect(box, getPresentRect(), 1200, 900)).toBe(box);
        // and accepted once it names the size the host actually has
        publishPresentRect(640, 480, 1200, 900, { x: 280, y: 210, w: 640, h: 480 });
        expect(contentRectFromPresentRect(box, getPresentRect(), 1200, 900))
            .toEqual({ left: 280, top: 210, width: 640, height: 480, right: 920, bottom: 690 });
    });

    test("full-cover test tolerates the one pixel an aspect fit can lose", () => {
        expect(coversTarget({ x: 0, y: 0, w: 1200, h: 900 }, 1200, 900)).toBe(true);
        expect(coversTarget({ x: 0, y: 0, w: 1199, h: 900 }, 1200, 900)).toBe(true);
        expect(coversTarget({ x: 200, y: 0, w: 800, h: 900 }, 1200, 900)).toBe(false);
    });
});
