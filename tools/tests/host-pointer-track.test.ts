import { describe, expect, it } from "bun:test";
import { HostPointerTrack, type HostPoint, type PointerSpace, wheelPointerTarget } from "../../src/input/host-pointer-track";

const BOUNDS: PointerSpace = { x: 0, y: 0, width: 1024, height: 768 };
const CENTRE: HostPoint = { x: 512, y: 384 };

/** What virtual-device's setPointerAbsolute does to a published position. */
function clamp(p: HostPoint, bounds: PointerSpace): HostPoint {
    return {
        x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, p.x)),
        y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, p.y)),
    };
}

/**
 * The host pointer sweeps; the guest reads the position, takes the delta from a fixed
 * centre and warps back to it (relative-mouse emulation). Feeds the real cursor state
 * back in each step, so the sequence is the one the app actually produces.
 */
function sweep(track: HostPointerTrack, hostXs: number[], opts: { warp?: boolean } = {}) {
    let cursor: HostPoint = { x: hostXs[0], y: CENTRE.y };
    const deltas: number[] = [];
    const seen: number[] = [];
    for (const hx of hostXs) {
        cursor = clamp(track.next({ x: hx, y: CENTRE.y }, cursor, BOUNDS), BOUNDS);
        seen.push(cursor.x);
        if (opts.warp !== false) {
            deltas.push(cursor.x - CENTRE.x);
            cursor = { ...CENTRE };   // the guest's SetCursorPos back to the centre
        }
    }
    return { deltas, seen };
}

describe("HostPointerTrack", () => {
    it("a warping guest reads the motion, not the drift from its recentre target", () => {
        const track = new HostPointerTrack();
        // Six equal +40 host steps starting on the centre.
        const { deltas } = sweep(track, [512, 552, 592, 632, 672, 712]);
        // The first sample re-seats (no motion known yet), then every step is the motion.
        expect(deltas).toEqual([0, 40, 40, 40, 40, 40]);
    });

    it("without the track, the same sweep grows without bound (the bug)", () => {
        // Publishing the host position verbatim is what the guest used to see.
        const raw = [512, 552, 592, 632, 672, 712].map((x) => x - CENTRE.x);
        expect(raw).toEqual([0, 40, 80, 120, 160, 200]);
    });

    it("is value-identical to the raw host position while nothing warps", () => {
        const track = new HostPointerTrack();
        const hostXs = [10, 640.5, 641, 0, 1024, 300];
        const { seen } = sweep(track, hostXs, { warp: false });
        expect(seen).toEqual(hostXs);
    });

    it("re-seats after a lost track instead of inventing a delta across the gap", () => {
        const track = new HostPointerTrack();
        track.next({ x: 100, y: 100 }, { x: 100, y: 100 }, BOUNDS);
        track.lose();
        // The guest warped meanwhile; the first sample after the gap is the host's own
        // position, exactly as it was before this class existed.
        expect(track.next({ x: 700, y: 300 }, CENTRE, BOUNDS)).toEqual({ x: 700, y: 300 });
    });

    it("a sample outside the guest space is a lost track, so a clamp cannot leak drift", () => {
        const track = new HostPointerTrack();
        // Drag out past the right edge with a button held, then back inside. Taking a
        // delta against the CLAMPED position would drift by whatever the clamp removed
        // (176px here); the published position must stay the raw host one throughout.
        let cursor: HostPoint = { x: 1000, y: 384 };
        const seen: number[] = [];
        for (const hx of [1000, 1100, 1200, 400]) {
            cursor = clamp(track.next({ x: hx, y: 384 }, cursor, BOUNDS), BOUNDS);
            seen.push(cursor.x);
        }
        expect(seen).toEqual([1000, 1024, 1024, 400]);
    });

    /**
     * ClipCursor while the lock is not held. The guest clamps to the box anyway, so
     * without this the host's pointer walks off past the wall and the two diverge by the
     * whole excursion: the box's interior is unreachable from outside it, and coming back
     * has to retrace every pixel of the drift before the guest's pointer moves at all.
     */
    describe("confinement (the transport when Pointer Lock is not held)", () => {
        const BOX = { left: 0, top: 0, right: 640, bottom: 480 };

        it("holds the published position inside the box, exclusive of right/bottom", () => {
            const track = new HostPointerTrack();
            track.setConfine(BOX);
            expect(track.next({ x: 800, y: 600 }, CENTRE, BOUNDS)).toEqual({ x: 639, y: 479 });
            expect(track.next({ x: -5, y: -5 }, CENTRE, BOUNDS)).toEqual({ x: 0, y: 0 });
        });

        it("reverses immediately after an excursion — no drift to retrace", () => {
            const track = new HostPointerTrack();
            track.setConfine(BOX);
            let cursor: HostPoint = { x: 600, y: 400 };
            const seen: number[] = [];
            // Push 300px past the right wall in 100px steps, then come back 10px.
            for (const hx of [600, 700, 800, 900, 890]) {
                cursor = clamp(track.next({ x: hx, y: 400 }, cursor, BOUNDS), BOUNDS);
                seen.push(cursor.x);
            }
            expect(seen).toEqual([600, 639, 639, 639, 629]);
        });

        /**
         * The mouse-look case, which also clips: the guest recentres every frame, so its
         * pointer never approaches the wall and the deltas it reads must be the motion,
         * exactly as with no confinement at all.
         */
        it("a recentring guest inside the box still reads the motion", () => {
            const track = new HostPointerTrack();
            track.setConfine(BOX);
            const centre = { x: 320, y: 240 };
            let cursor: HostPoint = { x: 320, y: 240 };
            const deltas: number[] = [];
            for (const hx of [320, 360, 400, 440, 480]) {
                cursor = track.next({ x: hx, y: 240 }, cursor, BOUNDS);
                deltas.push(cursor.x - centre.x);
                cursor = { ...centre };
            }
            expect(deltas).toEqual([0, 40, 40, 40, 40]);
        });

        it("an unconfined guest is untouched by the clamp", () => {
            const track = new HostPointerTrack();
            track.setConfine(BOX);
            track.setConfine(null);
            expect(track.next({ x: 800, y: 600 }, CENTRE, BOUNDS)).toEqual({ x: 800, y: 600 });
        });
    });

    it("keeps a warp that happened while the pointer stood still", () => {
        const track = new HostPointerTrack();
        track.next({ x: 300, y: 300 }, { x: 300, y: 300 }, BOUNDS);
        // Guest warps to the centre without the host pointer moving, then the host
        // moves 5px: the guest must land 5px from ITS pointer, not 5px from the host's.
        expect(track.next({ x: 305, y: 300 }, CENTRE, BOUNDS)).toEqual({ x: 517, y: 384 });
    });
});

// The host surface may show a part of the guest screen that does not start at its origin;
// every position here is a guest SCREEN coordinate, and "outside" is outside that part.
describe("a view that does not start at the screen origin", () => {
    const VIEW: PointerSpace = { x: 40, y: 40, width: 560, height: 400 };

    it("tracks motion inside the view exactly as it does on the whole screen", () => {
        const track = new HostPointerTrack();
        expect(track.next({ x: 50, y: 60 }, { x: 0, y: 0 }, VIEW)).toEqual({ x: 50, y: 60 });
        // The guest warped its pointer; the next sample applies what the host pointer moved.
        expect(track.next({ x: 57, y: 60 }, { x: 320, y: 240 }, VIEW)).toEqual({ x: 327, y: 240 });
    });

    it("a sample left of or above the view is a lost track, not a delta", () => {
        const track = new HostPointerTrack();
        track.next({ x: 100, y: 100 }, { x: 100, y: 100 }, VIEW);
        // (30, 100) is on the screen but outside the view: re-seat, and re-seat again after it.
        expect(track.next({ x: 30, y: 100 }, { x: 300, y: 300 }, VIEW)).toEqual({ x: 30, y: 100 });
        expect(track.next({ x: 45, y: 100 }, { x: 300, y: 300 }, VIEW)).toEqual({ x: 45, y: 100 });
    });

    it("the far edge is the view's, not the screen's", () => {
        const track = new HostPointerTrack();
        track.next({ x: 590, y: 430 }, { x: 590, y: 430 }, VIEW);
        // 601 > 40 + 560: outside, although well inside a 640x480 screen.
        expect(track.next({ x: 601, y: 430 }, { x: 100, y: 100 }, VIEW)).toEqual({ x: 601, y: 430 });
        expect(track.next({ x: 600, y: 440 }, { x: 100, y: 100 }, VIEW)).toEqual({ x: 600, y: 440 });
    });
});

// A WheelEvent's clientX/Y are frozen under Pointer Lock at the point where the lock was
// taken; the guest's pointer has moved on by relative motion since. Publishing the frozen
// point threw the pointer back there on every wheel notch.
describe("wheelPointerTarget", () => {
    const FROZEN = { x: 100, y: 80 };          // where the lock engaged
    const GUEST = { x: 700, y: 500 };          // where relative motion has taken the pointer

    it("under Pointer Lock a wheel notch leaves the pointer where it is", () => {
        const track = new HostPointerTrack();
        track.lose();                           // what every locked move does
        expect(wheelPointerTarget(true, track, FROZEN, GUEST, BOUNDS)).toBeNull();
        // ... and does not seat the track on the frozen point either: the first real
        // sample after the lock is released is still a re-seat, not a delta from it.
        expect(track.next({ x: 300, y: 300 }, GUEST, BOUNDS)).toEqual({ x: 300, y: 300 });
    });

    it("unlocked it is one more sample of the tracked host pointer", () => {
        const track = new HostPointerTrack();
        track.next({ x: 300, y: 300 }, { x: 300, y: 300 }, BOUNDS);
        expect(wheelPointerTarget(false, track, { x: 300, y: 300 }, CENTRE, BOUNDS)).toEqual(CENTRE);
        expect(wheelPointerTarget(false, track, { x: 310, y: 300 }, CENTRE, BOUNDS))
            .toEqual({ x: CENTRE.x + 10, y: CENTRE.y });
    });
});
