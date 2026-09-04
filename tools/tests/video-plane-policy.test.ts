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
import type { VideoFrameViews } from "../../src/worker/video/video-routing-types";

// Bun has no OffscreenCanvas. The policy is a decision about STATE — whose pixels these are
// and whether the screen they were composed for still exists — so a canvas that only records
// its size is the whole surface area the rules touch.
class StubContext {
    imageSmoothingEnabled = false;
    clearRect(): void { /* the plane's bytes are not what these rules read */ }
    putImageData(): void { /* ditto */ }
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
function rescued(render: ReturnType<typeof fakeRender>) {
    const router = new VideoRoutingService(render.service as never);
    router.openSession({ codec: "bink", guestHandle: 1, width: 4, height: 4, fps: 25 });
    router.onFrameDecoded({ codec: "bink", guestHandle: 1, frame: frame(), hasAppManagedSink: false });
    router.onFrameFinalize({ codec: "bink", guestHandle: 1, hasAppManagedSink: false });
    return router;
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
