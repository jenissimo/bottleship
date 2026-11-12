/**
 * The drawn guest pointer sits over the screen point the guest reports. The canvas shows a
 * rectangle of the guest screen; with that rectangle off the screen origin, the origin has
 * to come off the position before it is scaled into CSS pixels.
 */
import { expect, test } from "bun:test";
import { cursorPlacement, type CursorGeometry } from "../../src/app/guest-cursor";

const geo = (over: Partial<CursorGeometry>): CursorGeometry => ({
    left: 100, top: 50, width: 1120, height: 800, originLeft: 20, originTop: 10,
    spaceLeft: 0, spaceTop: 0, spaceWidth: 560, spaceHeight: 400, ...over,
});

test("with the view at the screen origin the pointer is scaled from the canvas corner", () => {
    const p = cursorPlacement(geo({}), { x: 280, y: 200 }, 0, 0);
    expect(p).toEqual({ scaleX: 2, scaleY: 2, x: 100 - 20 + 560, y: 50 - 10 + 400 });
});

test("with the view at (40,40) the same screen point is drawn 40 guest pixels further up-left", () => {
    const view = geo({ spaceLeft: 40, spaceTop: 40 });
    // The view's own corner is the canvas corner.
    expect(cursorPlacement(view, { x: 40, y: 40 }, 0, 0)).toMatchObject({ x: 80, y: 40 });
    // The middle of the view is the middle of the canvas.
    expect(cursorPlacement(view, { x: 320, y: 240 }, 0, 0)).toMatchObject({ x: 80 + 560, y: 40 + 400 });
});

test("the hotspot is taken off in guest pixels, after the view origin", () => {
    const view = geo({ spaceLeft: 40, spaceTop: 40 });
    expect(cursorPlacement(view, { x: 50, y: 60 }, 4, 6)).toMatchObject({ x: 80 + 12, y: 40 + 28 });
});
