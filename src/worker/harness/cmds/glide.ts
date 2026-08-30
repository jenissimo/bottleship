/**
 * Glide introspection: the Glide twin of glFrame()/glTextures().
 *
 * - glideState(): device state, the TMU texture inventory, LFB surfaces, the
 *   event ring and the executor/pipeline counters as one POJO.
 * - glideFrame(): arm a one-shot capture, wait for the next present, and return
 *   the COMPLETED command stream decoded per draw — the screen-space box the
 *   vertices cover, the s/t and 1/w ranges, and the combine/blend/alpha-test the
 *   draw ran under, each spelled out rather than left as a packed word. "Is the
 *   quad wrong, is its texture wrong, or is the combine wrong" becomes one call.
 * - glideTextures()/glideDumpTexture(handle): the gallery + a PNG of one texture
 *   decoded exactly the way the upload path decodes it.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { getModule } from "../serialize";
import { debugDumpPath } from "./screen";
import { encodePngBase64 } from "./textures";
import {
    armGlideFrameCapture, takeGlideFrameCapture, type GlideCapturedDraw,
} from "../../modules/glide2x/frame-capture";
import { unpackCombine, unpackBlend } from "../../backends/webgpu/glide/glide-combine";

interface GlideModuleLike {
    getDebugResourcesInfo?: (scope?: "summary" | "full", onlyActive?: boolean) => unknown;
    decodeTextureForDebug?: (handle: number) => { width: number; height: number; rgba: Uint8Array } | null;
    textureSourceBytesForDebug?: (handle: number) => Uint8Array | null;
    lfbRgbaForDebug?: (syncFromFrame?: boolean) => { width: number; height: number; rgba: Uint8Array } | null;
}

function glideMod(): GlideModuleLike {
    const mod = getModule("glide2x") as GlideModuleLike | undefined;
    if (!mod?.getDebugResourcesInfo) {
        throw new HarnessError("no glide2x module (game not using Glide?)", HarnessErrorCode.UNSUPPORTED);
    }
    return mod;
}

const COMBINE_FN = [
    "ZERO", "LOCAL", "LOCAL_ALPHA", "SCALE_OTHER", "SCALE_OTHER_ADD_LOCAL",
    "SCALE_OTHER_ADD_LOCAL_ALPHA", "SCALE_OTHER_MINUS_LOCAL", "BLEND",
    "SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL_ALPHA", "BLEND_LOCAL",
];
const COMBINE_FACTOR: Record<number, string> = {
    0x0: "ZERO", 0x1: "LOCAL", 0x2: "OTHER_ALPHA", 0x3: "LOCAL_ALPHA", 0x4: "TEXTURE_ALPHA",
    0x5: "TEXTURE_RGB", 0x8: "ONE", 0x9: "ONE_MINUS_LOCAL", 0xa: "ONE_MINUS_OTHER_ALPHA",
    0xb: "ONE_MINUS_LOCAL_ALPHA", 0xc: "ONE_MINUS_TEXTURE_ALPHA", 0xd: "ONE_MINUS_TEXTURE_RGB",
};
const COMBINE_LOCAL = ["ITERATED", "CONSTANT", "DEPTH", "?"];
const COMBINE_OTHER = ["ITERATED", "TEXTURE", "CONSTANT", "?"];
const BLEND_FACTOR: Record<number, string> = {
    0x0: "ZERO", 0x1: "SRC_ALPHA", 0x2: "SRC/DST_COLOR", 0x3: "DST_ALPHA", 0x4: "ONE",
    0x5: "ONE_MINUS_SRC_ALPHA", 0x6: "ONE_MINUS_SRC/DST_COLOR", 0x7: "ONE_MINUS_DST_ALPHA",
    0xf: "ALPHA_SATURATE/PREFOG",
};
const CMP = ["NEVER", "LESS", "EQUAL", "LEQUAL", "GREATER", "NOTEQUAL", "GEQUAL", "ALWAYS"];

function describeCombine(packed: number): string {
    const c = unpackCombine(packed >>> 0);
    const fn = c.function === 0x10
        ? "SCALE_MINUS_LOCAL_ADD_LOCAL_ALPHA"
        : (COMBINE_FN[c.function] ?? "fn" + c.function);
    const inv = c.invert ? " INVERT" : "";
    return fn + " f=" + (COMBINE_FACTOR[c.factor] ?? c.factor)
        + " local=" + COMBINE_LOCAL[c.local] + " other=" + COMBINE_OTHER[c.other] + inv;
}

function describeBlend(packed: number): string {
    const b = unpackBlend(packed >>> 0);
    const f = (v: number): string => BLEND_FACTOR[v] ?? String(v);
    return "rgb " + f(b.rgbSf) + "->" + f(b.rgbDf) + " alpha " + f(b.alphaSf) + "->" + f(b.alphaDf);
}

const hex = (v: number): string => "0x" + (v >>> 0).toString(16).padStart(8, "0");

function describeDraw(d: GlideCapturedDraw): unknown {
    if (d.cmd === "CLEAR") {
        return {
            k: d.k, cmd: "CLEAR", color: hex(d.clearColor ?? 0), depth: d.clearDepth,
            clears: [d.clearsColor ? "color" : null, d.clearsDepth ? "depth" : null].filter(Boolean).join("+"),
        };
    }
    const sampler = d.useTexture
        ? (d.filterLinear ? "linear" : "nearest") + " " + (d.clampS ? "clamp" : "wrap") + "/" + (d.clampT ? "clamp" : "wrap")
        : null;
    return {
        k: d.k, cmd: "DRAW", topology: d.topology, verts: d.vertexCount,
        tex: d.useTexture ? d.textureHandle : null,
        sampler,
        xy: d.xy, z: d.z, st: d.st, q: d.q,
        colors: (d.colors ?? []).map(hex),
        colorCombine: describeCombine(d.colorCombine ?? 0),
        alphaCombine: describeCombine(d.alphaCombine ?? 0),
        constantColor: hex(d.constantColor ?? 0),
        blend: d.blendEnabled ? describeBlend(d.blend ?? 0) : "off",
        depth: d.depthTestEnabled
            ? (CMP[d.depthFunction ?? 7] ?? String(d.depthFunction)) + (d.depthWriteEnabled ? " +write" : "")
            : "off",
        alphaTest: d.alphaTestEnabled
            ? (CMP[d.alphaTestFunc ?? 7] ?? String(d.alphaTestFunc)) + " " + d.alphaRef
            : "off",
        fog: d.fogMode ? "mode=" + d.fogMode + " color=" + hex(d.fogColor ?? 0) : "off",
        cull: d.cullMode,
        colorMask: (d.colorMaskRgb ? "rgb" : "-") + (d.colorMaskAlpha ? "a" : "-"),
    };
}

export function registerGlideCommands(svc: HarnessService): void {
    svc.register("glideState", (args) => {
        const opts = (args[0] ?? {}) as { scope?: "summary" | "full"; onlyActive?: boolean };
        return glideMod().getDebugResourcesInfo!(opts.scope ?? "summary", opts.onlyActive ?? false);
    });

    svc.register("glideFrame", async (args) => {
        const opts = (args[0] ?? {}) as { timeoutMs?: number; maxDraws?: number };
        glideMod(); // fail fast when the title is not Glide
        armGlideFrameCapture();
        const deadline = Date.now() + (opts.timeoutMs ?? 5000);
        let cap = takeGlideFrameCapture();
        while (!cap && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 16));
            cap = takeGlideFrameCapture();
        }
        if (!cap) throw new HarnessError("no present within timeout (frame loop stalled?)", HarnessErrorCode.TIMEOUT);

        const max = opts.maxDraws ?? 200;
        return {
            frameId: cap.frameId,
            size: [cap.width, cap.height],
            vertexCount: cap.vertexCount,
            count: cap.count,
            // The capture layer may already have capped what it kept, so the slice is not
            // the only place draws can go missing.
            truncated: cap.commands.length > max || cap.count > cap.commands.length,
            clear: { color: hex(cap.clearColor), depth: cap.clearDepth },
            constantColor: hex(cap.constantColor),
            alphaRef: cap.alphaRef,
            chroma: cap.chromaKeyEnabled ? hex(cap.chromaKey) : "off",
            gamma: cap.gammaCorrection,
            lfbPixels: cap.hasLfbPixels,
            commands: cap.commands.slice(0, max).map(describeDraw),
        };
    });

    svc.register("glideTextures", (args) => {
        const opts = (args[0] ?? {}) as { onlyActive?: boolean };
        const info = glideMod().getDebugResourcesInfo!("full", opts.onlyActive ?? false) as {
            textures: Array<Record<string, unknown>>;
        };
        return info.textures;
    });

    // The bytes the TMU was actually handed. A decoded PNG cannot distinguish "the
    // decoder is wrong" from "the format we were told is wrong"; the raw texels can.
    svc.register("glideTextureBytes", (args) => {
        const handle = (args[0] as number) >>> 0;
        const count = Math.min(((args[1] as number) | 0) || 64, 4096);
        const bytes = glideMod().textureSourceBytesForDebug?.(handle);
        if (!bytes) throw new HarnessError("no source bytes for glide texture " + handle, HarnessErrorCode.NOT_FOUND);
        const u16: string[] = [];
        for (let i = 0; i + 1 < bytes.length && u16.length < count; i += 2) {
            u16.push("0x" + ((bytes[i] | (bytes[i + 1] << 8)) >>> 0).toString(16).padStart(4, "0"));
        }
        return { handle, byteLength: bytes.length, u16 };
    });

    // The LFB layer ALONE. Glide titles that also render 2D through the linear frame
    // buffer composite two pictures; a screenshot cannot say which one carries a defect.
    svc.register("glideDumpLfb", async (args) => {
        const opts = (args[0] ?? {}) as { syncFromFrame?: boolean };
        const lfb = glideMod().lfbRgbaForDebug?.(opts.syncFromFrame ?? false);
        if (!lfb) throw new HarnessError("no LFB surface selected", HarnessErrorCode.NOT_FOUND);
        const base64 = await encodePngBase64(lfb.rgba, lfb.width, lfb.height);
        (self as unknown as Worker).postMessage({ type: "debug_png_dump", name: "glide-lfb", base64 });
        let nonBlack = 0;
        for (let i = 0; i < lfb.rgba.length; i += 4) {
            if ((lfb.rgba[i] | lfb.rgba[i + 1] | lfb.rgba[i + 2]) !== 0) nonBlack++;
        }
        return { width: lfb.width, height: lfb.height, nonBlackPixels: nonBlack, saved: debugDumpPath("glide-lfb") };
    });

    svc.register("glideDumpTexture", async (args) => {
        const handle = (args[0] as number) >>> 0;
        const mod = glideMod();
        if (!mod.decodeTextureForDebug) {
            throw new HarnessError("glide2x has no decodeTextureForDebug", HarnessErrorCode.UNSUPPORTED);
        }
        const t = mod.decodeTextureForDebug(handle);
        if (!t) throw new HarnessError("no glide texture " + handle, HarnessErrorCode.NOT_FOUND);
        const base64 = await encodePngBase64(t.rgba, t.width, t.height);
        const name = "glidetex-" + handle;
        (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
        return { handle, width: t.width, height: t.height, saved: debugDumpPath(name) };
    });
}
