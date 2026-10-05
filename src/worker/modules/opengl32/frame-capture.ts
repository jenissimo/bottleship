/**
 * One-shot GL frame capture for the harness.
 *
 * The command stream and the vertex arena are frame-scoped (reset inside
 * present()), so nothing outside a present can observe a COMPLETE frame — a
 * mid-frame read only ever sees the part the guest has emitted so far. Arm this
 * before a present and the presenter copies the finished stream aside, which is
 * what makes "which viewport was active for the draw that landed wrong" an
 * answerable question.
 */

import { OpenGLContext, CMD_I32, CMD_F32 } from "./context";

export interface GLFrameCapture {
    frameId: number;
    drawableW: number;
    drawableH: number;
    count: number;
    i32: Int32Array;
    f32: Float32Array;
    verts: Float32Array;
}

let armed = false;
let last: GLFrameCapture | null = null;

/** Request a copy of the next completed frame. */
export function armGLFrameCapture(): void {
    armed = true;
    last = null;
}

/** The most recent captured frame (cleared by the next arm). */
export function takeGLFrameCapture(): GLFrameCapture | null {
    return last;
}

/** Presenter hook: snapshot the finished stream before it is reset. */
export function captureGLFrameIfArmed(ctx: OpenGLContext, drawableW: number, drawableH: number): void {
    if (!armed) return;
    armed = false;
    const n = ctx.commands.count;
    last = {
        frameId: ctx.frameId,
        drawableW,
        drawableH,
        count: n,
        i32: new Int32Array(ctx.commands.i32.subarray(0, n * CMD_I32)),
        f32: new Float32Array(ctx.commands.f32.subarray(0, n * CMD_F32)),
        verts: new Float32Array(ctx.vertArena.data.subarray(0, ctx.vertArena.used)),
    };
}
