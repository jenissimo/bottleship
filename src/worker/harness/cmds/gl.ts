/**
 * OpenGL introspection: the GL twin of textures()/captureFrame().
 *
 * - glFrame(): arm a one-shot capture, wait for the next present, and return the
 *   COMPLETED command stream decoded per draw — drawable size, the viewport and
 *   scissor that were active, the NDC bounding box the vertices actually cover,
 *   and the texcoord range. That triple ("where the guest asked to draw" vs
 *   "where the pixels land" vs "how big the framebuffer is") is what separates a
 *   projection bug from a viewport/render-target bug without guessing. It also
 *   names the two spaces apart: `drawable` is guest pixels (what every vp/scissor
 *   below is in), `render` is what that frame was rasterized at.
 * - glTextures()/glDumpTexture(id): the texture gallery + a PNG of one texture,
 *   so "is the quad wrong or is its texture wrong" is one call, not a theory.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { getModule } from "../serialize";
import { debugDumpPath } from "./screen";
import { encodePngBase64 } from "./textures";
import {
    CMD_I32, CMD_F32, VERT_FLOATS, GLDrawCommandType,
    CI_TYPE, CI_MODE, CI_VERT_OFFSET, CI_VERT_COUNT, CI_FLAGS, CI_TEX_ID0, CI_TEX_ID1,
    CI_SCISSOR_X, CI_SCISSOR_Y, CI_SCISSOR_W, CI_SCISSOR_H,
    CI_VP_X, CI_VP_Y, CI_VP_W, CI_VP_H, CI_CLEAR_MASK,
    CI_TEXENV0, CI_TEXENV1, CI_COMBINE0_RGB, CI_COMBINE0_ALPHA, CI_COMBINE1_RGB, CI_COMBINE1_ALPHA,
    CF_ENV_COLOR0, CF_ENV_COLOR1,
    CI_BLEND_SRC, CI_BLEND_DST, CI_ALPHA_FUNC, CI_DEPTH_FUNC,
    CI_STENCIL_FUNC, CI_STENCIL_REF, CI_STENCIL_MASK, CI_STENCIL_FAIL,
    CI_STENCIL_ZFAIL, CI_STENCIL_ZPASS, CI_STENCIL_WRITE_MASK, CF_ALPHA_REF,
    DF_BLEND, DF_ALPHA_TEST, DF_STENCIL_TEST, DF_DEPTH_TEST, DF_DEPTH_MASK, DF_FOG,
    DF_COLOR_MASK_R, DF_COLOR_MASK_G, DF_COLOR_MASK_B, DF_COLOR_MASK_A,
} from "../../modules/opengl32/context";
import { armGLFrameCapture, cancelGLFrameCapture, takeGLFrameCapture, summarizeGLComponents, type GLFrameCaptureOptions } from "../../modules/opengl32/frame-capture";
import type { OpenGLContext, GLTextureObject } from "../../modules/opengl32/context";
import { armGLWorkDigest, readGLWorkDigest, offGLWorkDigest, type GLWorkOptions } from "../../modules/opengl32/work-digest";

function glCtx(): OpenGLContext {
    const mod = getModule("opengl32") as { getContext?: () => OpenGLContext | null } | undefined;
    const ctx = mod?.getContext?.();
    if (!ctx) throw new HarnessError("no OpenGL context (game not using opengl32?)", HarnessErrorCode.UNSUPPORTED);
    return ctx;
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

// ---- Texture environment decoding ----
//
// "Does this title actually take the GL_COMBINE path, and with what?" is not answerable
// from a screenshot — a wrong combiner and a missing one both just look wrong. These
// decoders print the per-draw texture environment the executor is about to run, which
// is the positive control for the combiner: a draw that reads `MODULATE` never entered
// it, and a draw that reads e.g. `MODULATE(TEXTURE.rgb, PREVIOUS.rgb) x2` did.

const TEX_ENV_MODE_NAMES: Record<number, string> = {
    0x2100: "MODULATE", 0x2101: "DECAL", 0x1E01: "REPLACE", 0x0104: "ADD",
    0x0BE2: "BLEND", 0x8570: "COMBINE",
};
const COMBINER_FN_NAMES = [
    "REPLACE", "MODULATE", "ADD", "ADD_SIGNED", "INTERPOLATE", "SUBTRACT", "DOT3_RGB", "DOT3_RGBA",
];
const COMBINER_FN_ARITY = [1, 2, 2, 2, 3, 2, 2, 2];
const COMBINER_SRC_NAMES = ["TEXTURE", "CONSTANT", "PRIMARY", "PREVIOUS"];
const COMBINER_OP_SUFFIX = [".rgb", ".1-rgb", ".a", ".1-a"];

function decodeCombinerWord(word: number): string {
    const fn = word & 15;
    const args: string[] = [];
    for (let a = 0; a < (COMBINER_FN_ARITY[fn] ?? 2); a++) {
        const src = (word >>> (4 + a * 4)) & 3;
        const op = (word >>> (6 + a * 4)) & 3;
        args.push(`${COMBINER_SRC_NAMES[src]}${COMBINER_OP_SUFFIX[op]}`);
    }
    const scale = 1 << ((word >>> 16) & 3);
    return `${COMBINER_FN_NAMES[fn]}(${args.join(", ")})${scale > 1 ? ` x${scale}` : ""}`;
}

function decodeTexEnv(
    mode: number, rgbWord: number, alphaWord: number, F: Float32Array, colorBase: number,
): unknown {
    const name = TEX_ENV_MODE_NAMES[mode] ?? "0x" + (mode >>> 0).toString(16);
    if (mode !== 0x8570) return name;
    return {
        mode: name,
        rgb: decodeCombinerWord(rgbWord),
        alpha: decodeCombinerWord(alphaWord),
        constant: [F[colorBase], F[colorBase + 1], F[colorBase + 2], F[colorBase + 3]].map(round),
    };
}

/** Decode completed per-draw packet state; never consult the current UI context. */
export function describeGLDrawPacket(I: Int32Array, F: Float32Array, i: number, f: number) {
    const flags = I[i + CI_FLAGS]!;
    return {
        blend: { enabled: !!(flags & DF_BLEND), src: I[i + CI_BLEND_SRC], dst: I[i + CI_BLEND_DST] },
        alphaTest: { enabled: !!(flags & DF_ALPHA_TEST), func: I[i + CI_ALPHA_FUNC], ref: F[f + CF_ALPHA_REF] },
        depthFunc: I[i + CI_DEPTH_FUNC],
        depthTest: !!(flags & DF_DEPTH_TEST), depthWrite: !!(flags & DF_DEPTH_MASK),
        stencil: {
            enabled: !!(flags & DF_STENCIL_TEST), func: I[i + CI_STENCIL_FUNC], ref: I[i + CI_STENCIL_REF],
            mask: I[i + CI_STENCIL_MASK] >>> 0, fail: I[i + CI_STENCIL_FAIL],
            zfail: I[i + CI_STENCIL_ZFAIL], zpass: I[i + CI_STENCIL_ZPASS],
            writeMask: I[i + CI_STENCIL_WRITE_MASK] >>> 0,
        },
        colorMask: { r: !!(flags & DF_COLOR_MASK_R), g: !!(flags & DF_COLOR_MASK_G),
            b: !!(flags & DF_COLOR_MASK_B), a: !!(flags & DF_COLOR_MASK_A) },
    };
}

export function registerGlCommands(svc: HarnessService): void {
    /** Absolute GL guest-present window; engine demo frames are an independent oracle. */
    svc.register("glWorkDigest", (args) => {
        const opts = (args[0] ?? {}) as GLWorkOptions & { phase?: "arm" | "read" | "off" };
        if (opts.phase === "off") return offGLWorkDigest();
        const ctx = glCtx();
        if (opts.phase === "arm") return armGLWorkDigest(ctx, opts);
        if (opts.phase !== undefined && opts.phase !== "read") throw new HarnessError("glWorkDigest phase must be arm|read|off", HarnessErrorCode.BAD_ARGS);
        return { ...readGLWorkDigest(ctx), currentFrame: ctx.frameId };
    });
    svc.register("glFrame", async (args) => {
        const opts = (args[0] ?? {}) as GLFrameCaptureOptions & { timeoutMs?: number };
        const ctx = glCtx(); // fail fast when the title is not GL
        armGLFrameCapture(opts, ctx);
        const deadline = Date.now() + (opts.timeoutMs ?? 3000);
        let cap = takeGLFrameCapture();
        while (!cap && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 16));
            cap = takeGLFrameCapture();
        }
        if (!cap) { cancelGLFrameCapture(); throw new HarnessError("no present within timeout (frame loop stalled?)", HarnessErrorCode.TIMEOUT); }

        const { i32: I, f32: F, verts } = cap;
        const commands: unknown[] = [];
        for (let k = 0; k < cap.count; k++) {
            const i = k * CMD_I32;
            const f = k * CMD_F32;
            const type = I[i + CI_TYPE];
            const vp = [I[i + CI_VP_X], I[i + CI_VP_Y], I[i + CI_VP_W], I[i + CI_VP_H]];
            if (type === GLDrawCommandType.VIEWPORT) { commands.push({ k, cmd: "VIEWPORT", vp }); continue; }
            if (type === GLDrawCommandType.SCISSOR) {
                commands.push({ k, cmd: "SCISSOR", scissor: [I[i + CI_SCISSOR_X], I[i + CI_SCISSOR_Y], I[i + CI_SCISSOR_W], I[i + CI_SCISSOR_H]] });
                continue;
            }
            if (type === GLDrawCommandType.CLEAR) {
                commands.push({ k, cmd: "CLEAR", mask: "0x" + (I[i + CI_CLEAR_MASK] >>> 0).toString(16), color: [F[f], F[f + 1], F[f + 2], F[f + 3]].map(round) });
                continue;
            }
            const off = I[i + CI_VERT_OFFSET];
            const n = I[i + CI_VERT_COUNT];
            // Vertices reach the arena in CLIP space; /w gives the NDC the GPU sees.
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
            for (let v = 0; v < n; v++) {
                const b = off + v * VERT_FLOATS;
                const w = verts[b + 3] || 1;
                const nx = verts[b] / w, ny = verts[b + 1] / w;
                if (nx < x0) x0 = nx; if (nx > x1) x1 = nx;
                if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
                const s = verts[b + 11], t = verts[b + 12];
                if (s < s0) s0 = s; if (s > s1) s1 = s;
                if (t < t0) t0 = t; if (t > t1) t1 = t;
            }
            // Where the NDC box lands on the drawable, given that viewport — the number
            // to compare against a screenshot.
            const vpW = vp[2] > 0 ? vp[2] : cap.drawableW;
            const vpH = vp[3] > 0 ? vp[3] : cap.drawableH;
            const px = (nx: number) => round(vp[0] + (nx + 1) * 0.5 * vpW);
            const py = (ny: number) => round(cap.drawableH - (vp[1] + (ny + 1) * 0.5 * vpH));
            commands.push({
                k, cmd: "DRAW", mode: I[i + CI_MODE], verts: n,
                tex0: I[i + CI_TEX_ID0], tex1: I[i + CI_TEX_ID1],
                env0: decodeTexEnv(I[i + CI_TEXENV0], I[i + CI_COMBINE0_RGB], I[i + CI_COMBINE0_ALPHA], F, f + CF_ENV_COLOR0),
                env1: decodeTexEnv(I[i + CI_TEXENV1], I[i + CI_COMBINE1_RGB], I[i + CI_COMBINE1_ALPHA], F, f + CF_ENV_COLOR1),
                flags: "0x" + (I[i + CI_FLAGS] >>> 0).toString(16),
                ...describeGLDrawPacket(I, F, i, f),
                vertexColor: summarizeGLComponents(verts, off, n, 4, 4),
                normalRange: (I[i + CI_FLAGS] & DF_FOG) ? null : summarizeGLComponents(verts, off, n, 8, 3),
                normalRangeNote: (I[i + CI_FLAGS] & DF_FOG) ? "Fog reuses nx in the completed arena; use drawEmissions[].normal captured before transform" : "Object-space input normals; no lighting is inferred from this range",
                emissions: cap.drawEmissions.map((emission, index) => emission.commandIndex === k ? index : -1).filter(index => index >= 0),
                vp, scissor: [I[i + CI_SCISSOR_X], I[i + CI_SCISSOR_Y], I[i + CI_SCISSOR_W], I[i + CI_SCISSOR_H]],
                ndc: n ? [round(x0), round(x1), round(y0), round(y1)] : null,
                screen: n ? [px(x0), px(x1), py(y1), py(y0)] : null,
                st: n ? [round(s0), round(s1), round(t0), round(t1)] : null,
            });
        }
        // Both spaces, named: `drawable` is what the guest thinks it draws into (and what
        // every vp/scissor above is in), `render` is what it was rasterized at.
        const space = ctx.executor?.getRenderSpace?.();
        return {
            frameId: cap.frameId,
            drawable: [cap.drawableW, cap.drawableH],
            render: space ? [space.renderW, space.renderH] : null,
            internalScale: space ? Math.round(space.scale * 1000) / 1000 : null,
            count: cap.count, commands,
            drawEmissions: cap.drawEmissions,
            emissionCoverage: cap.emissionCoverage,
        };
    });

    svc.register("glTextures", () => {
        const ctx = glCtx();
        const out: unknown[] = [];
        for (const [id, t] of ctx.textures) {
            out.push({ id, width: t.width, height: t.height, internalFormat: "0x" + (t.internalFormat >>> 0).toString(16) });
        }
        return out;
    });

    svc.register("glDumpTexture", async (args) => {
        const id = (args[0] as number) >>> 0;
        const ctx = glCtx();
        const t: GLTextureObject | undefined = ctx.textures.get(id);
        if (!t) throw new HarnessError(`no GL texture ${id}`, HarnessErrorCode.NOT_FOUND);
        if (!t.data) throw new HarnessError(`GL texture ${id} has no CPU copy`, HarnessErrorCode.UNSUPPORTED);
        const rgba = new Uint8Array(t.data.buffer, t.data.byteOffset, t.width * t.height * 4);
        const base64 = await encodePngBase64(rgba, t.width, t.height);
        const name = `gltex-${id}`;
        (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
        return { id, width: t.width, height: t.height, saved: debugDumpPath(name) };
    });
}
