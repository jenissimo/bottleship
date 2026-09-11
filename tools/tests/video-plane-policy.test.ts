/**
 * The video plane's composite policy — the rules six present paths used to each hold a
 * private version of.
 *
 * The plane is a COMPENSATION layer: real Bink/Smacker present nothing, so it exists only for
 * the shape where the app's own upload path loses the decoded pixels. Compositing it covers
 * the whole frame the guest just drew, so every rule here is about when it STOPS being on
 * screen — the half that "the plane still holds a bitmap" cannot express, and the half that
 * kept coming back as a finished movie over a menu.
 */
import { describe, expect, test } from "bun:test";
import { VideoRoutingService } from "../../src/worker/video/video-routing-service";
import type { VideoFrameViews, VideoTargetHint } from "../../src/worker/video/video-routing-types";
import { getVirtualScreenRect } from "../../src/worker/modules/user32/shared-state";

// Bun has no OffscreenCanvas. The policy is a decision about STATE — whose pixels these are
// and whether the screen they were composed for still exists — so a canvas that only records
// its size is the whole surface area the rules touch. It also records the ONE drawImage the
// plane issues, because WHERE the movie lands is the other half of the plane's contract.
interface DrawCall { sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }
let lastDraw: DrawCall | null = null;
class StubContext {
    imageSmoothingEnabled = false;
    clearRect(): void { /* the plane's bytes are not what these rules read */ }
    putImageData(): void { /* ditto */ }
    drawImage(_src: unknown, _sx: number, _sy: number, sw: number, sh: number,
              dx: number, dy: number, dw: number, dh: number): void {
        lastDraw = { sw, sh, dx, dy, dw, dh };
    }
}
class StubOffscreenCanvas {
    constructor(public width: number, public height: number) {}
    getContext(): StubContext { return new StubContext(); }
}
const g = globalThis as Record<string, unknown>;
g.OffscreenCanvas ??= StubOffscreenCanvas;
g.ImageData ??= class { constructor(public data: unknown, public width: number, public height: number) {} };

/** Just enough RenderService for the router: a serial, a presenter kind and a draw load. */
function fakeRender() {
    const state = { guestSerial: 0, kind: "d3d9" as string | null, draws: null as number | null };
    return {
        state,
        service: {
            getGuestPresentSerial: () => state.guestSerial,
            getLastPresenterKind: () => state.kind,
            getLastPresentDrawCount: () => state.draws,
            getBackend: () => ({}),
        },
    };
}

function frame(width = 4, height = 4): VideoFrameViews {
    return {
        width, height, frameIndex: 1, frameDurationMs: 40, decodedAtMs: 0,
        bgra: new Uint8Array(width * height * 4).fill(0x40),
    };
}

/** A session locked to the plane with one frame published — the state a rescue leaves behind. */
function rescued(render: ReturnType<typeof fakeRender>, targetHint?: Partial<VideoTargetHint>) {
    lastDraw = null;
    const router = new VideoRoutingService(render.service as never);
    router.openSession({ codec: "bink", guestHandle: 1, width: 4, height: 4, fps: 25 });
    router.onFrameDecoded({ codec: "bink", guestHandle: 1, frame: frame(), hasAppManagedSink: false, targetHint });
    router.onFrameFinalize({ codec: "bink", guestHandle: 1, hasAppManagedSink: false, targetHint });
    return router;
}

/** The guest screen the plane must live in — read from the same authority the plane uses. */
function guestScreen(): { w: number; h: number } {
    const r = getVirtualScreenRect();
    return { w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) };
}

describe("video plane composite policy", () => {
    test("a rescued movie is on screen, and says so", () => {
        const render = fakeRender();
        render.state.draws = 1; // the guest is blitting a movie, not drawing a scene
        const plan = rescued(render).resolvePlanePlan();
        expect(plan.reason).toBe("live");
        expect(plan.onScreen).toBe(true);
        expect(plan.canvas).not.toBeNull();
    });

    test("it is NOT on screen over a frame the guest drew a scene into", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const router = rescued(render);
        expect(router.resolvePlanePlan().onScreen).toBe(true);
        // Same session, same pixels — only the guest's own frame changed.
        render.state.draws = 18;
        const plan = router.resolvePlanePlan();
        expect(plan.reason).toBe("app_scene_observed");
        expect(plan.onScreen).toBe(false);
        expect(plan.canvas).toBeNull();
    });

    test("a presenter that cannot report its draws is unknown, not 'few'", () => {
        const render = fakeRender();
        render.state.draws = null;
        expect(rescued(render).resolvePlanePlan().onScreen).toBe(true);
    });

    test("the decision is re-taken every frame, so a scene can give the screen back", () => {
        const render = fakeRender();
        render.state.draws = 18;
        const router = rescued(render);
        expect(router.resolvePlanePlan().onScreen).toBe(false);
        render.state.draws = 1;
        expect(router.resolvePlanePlan().onScreen).toBe(true);
    });

    test("closing the session drops the pixels — a plane cannot outlive its owner", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const router = rescued(render);
        router.closeSession("bink", 1);
        const plan = router.resolvePlanePlan();
        expect(plan.reason).toBe("no_content");
        expect(plan.onScreen).toBe(false);
    });

    test("a change of presenter kind retires pixels composed for the old screen", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const router = rescued(render);
        expect(router.resolvePlanePlan().onScreen).toBe(true);
        render.state.kind = "ddraw";
        expect(router.resolvePlanePlan().reason).toBe("presenter_changed");
        // And it is CLEARED, not merely reported: the next ask must not find it again.
        render.state.kind = "d3d9";
        expect(router.resolvePlanePlan().reason).toBe("no_content");
    });

    test("our own composite of the plane is not a change of screen", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const router = rescued(render);
        render.state.kind = "video";
        expect(router.resolvePlanePlan().reason).toBe("live");
    });

    test("getDebugInfo reports the verdict WITHOUT taking it", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const router = rescued(render);
        render.state.kind = "ddraw";
        expect(router.getDebugInfo().plane.reason).toBe("presenter_changed");
        // A debug read that cleared the plane it reports would destroy the evidence.
        expect(router.getDebugInfo().plane.reason).toBe("presenter_changed");
    });
});

/**
 * WHERE the plane draws. The plane is a guest-space image, so a movie the app placed in a
 * sub-rect must be rescued INTO that rect: the compositors stretch the plane over the rect
 * the frame under it landed in, so a frame-sized plane (or a fill with a known destination)
 * blows a windowed movie up over the whole screen.
 */
describe("video plane placement", () => {
    test("the plane is a GUEST-SCREEN image, not a frame-sized one", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const plan = rescued(render).resolvePlanePlan();
        const screen = guestScreen();
        expect(plan.canvas!.width).toBe(screen.w);
        expect(plan.canvas!.height).toBe(screen.h);
        // The pre-fix shape: a 4x4 canvas, which every present path then stretched fullscreen.
        expect(plan.canvas!.width).not.toBe(4);
    });

    test("an unknown destination fills the guest screen — the compensation case", () => {
        const render = fakeRender();
        render.state.draws = 1;
        rescued(render).resolvePlanePlan();
        const screen = guestScreen();
        expect(lastDraw).toEqual({ sw: 4, sh: 4, dx: 0, dy: 0, dw: screen.w, dh: screen.h });
    });

    test("a stated destination is honoured instead of filling the screen", () => {
        const render = fakeRender();
        render.state.draws = 1;
        rescued(render, { destRect: { x: 40, y: 30, w: 160, h: 120 } }).resolvePlanePlan();
        expect(lastDraw).toEqual({ sw: 4, sh: 4, dx: 40, dy: 30, dw: 160, dh: 120 });
    });

    test("a destination entirely off the screen is unknown, not drawn where nobody sees it", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const screen = guestScreen();
        rescued(render, { destRect: { x: screen.w + 10, y: 0, w: 64, h: 64 } }).resolvePlanePlan();
        expect(lastDraw).toEqual({ sw: 4, sh: 4, dx: 0, dy: 0, dw: screen.w, dh: screen.h });
    });

    test("the plane reports the rect it drew, so a mis-placed movie is visible in state()", () => {
        const render = fakeRender();
        render.state.draws = 1;
        const router = rescued(render, { destRect: { x: 8, y: 9, w: 32, h: 24 } });
        expect(router.getDebugInfo().overlay.destRect).toEqual({ x: 8, y: 9, w: 32, h: 24 });
    });
});
