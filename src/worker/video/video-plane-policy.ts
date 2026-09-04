/**
 * The video plane's composite policy — ONE owner, the way getOverlayCompositePlan owns the
 * GDI/window plane.
 *
 * The plane is a COMPENSATION layer: real Bink/Smacker present nothing, so it exists only
 * for the shape where the app's own upload path loses the decoded pixels. Drawing it is
 * therefore destructive — it covers the whole frame the guest just rendered — and the
 * decision to draw it must be made in one place, from the router's own lifetime state,
 * never from "the plane still holds a bitmap".
 *
 * Every present path (the rAF GDI loop, the DDraw presenter's 2D and GPU paths, and the
 * D3D8/D3D9/Glide present paths) asks this and nothing else; `tools/validate-video-plane-policy.ts`
 * is what keeps that true. `reason` is the answer to "why is it (not) on screen this frame",
 * and is reported by `state(["video"]).plane`.
 */

import { System } from "../core/system";
import type { VideoPlanePlan } from "./video-routing-types";

/**
 * Should the video plane be composited over this frame, and which canvas.
 *
 * Not a pure read: it is also where the plane's lifetime is enforced, so a plane whose
 * owner has gone away is CLEARED here rather than left to read as content for the next
 * caller. The VERDICT is idempotent — every present path in a frame gets the same
 * `onScreen` — but the `reason` is latched at the transition: a clearing reason is reported
 * once, and a second call in the same frame answers `no_content` for the plane it just
 * dropped.
 */
export function getVideoPlanePlan(): VideoPlanePlan {
    return System.getInstance().videoRouting.resolvePlanePlan();
}

/**
 * Tell the plane its pixels reached the screen. Called by a present path immediately after it
 * composited `plan.canvas`; it also consumes the dirty flag, so a present path never needs the
 * overlay service itself and the policy stays the only route to the plane.
 */
export function notifyVideoPlaneComposited(plan: VideoPlanePlan): void {
    if (!plan.onScreen) return;
    System.getInstance().videoRouting.notePlaneComposited();
}

/** Has the plane been fed since it was last composited? Presentation cadence, not policy. */
export function isVideoPlaneDirty(): boolean {
    return System.getInstance().videoRouting.isPlaneDirty();
}

/**
 * Drop a dirty flag the caller is deliberately NOT going to act on — a present path that
 * decided the plane is not on screen this frame, so a later full repaint does not treat a
 * frame from a movie that is over as fresh content.
 */
export function dropVideoPlaneDirty(): void {
    System.getInstance().videoRouting.dropPlaneDirty();
}
