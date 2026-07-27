/**
 * fadeProbe — the durable Max Payne fade/dim-overlay hunter (replaces the
 * throwaway worker-eval `renderer.drawIndexedPrimitive` monkey-patch).
 *
 * Installs a draw observer on the ACTIVE D3D8 device's FFP executor
 * (DDrawWebGPUExecutor.drawObserver) that fires whenever the fade-overlay quad
 * signature appears — a small lit textured quad (default 32×32 + LIGHTING=1), the
 * draw that root-caused the black comic page (mp-comic-black-fade-overlay). It
 * hangs on the executor's draw chokepoint, NOT on a paused snapshot, so it catches
 * the quad WHENEVER it renders — comic OR in-game cutscene — with no precise-pause
 * timing. That directly answers the open "one bug or two" question: if suppressing
 * the SAME signature reveals BOTH the comic and the cutscene, they share a root;
 * if not, they are separate bugs.
 *
 * Verbs:
 *  - fadeProbe(opts?)   arm. opts: {texSize=32, requireLighting=true, suppress=false, keep=64}
 *  - fadeProbeReport()  matched count + recent per-draw render-state snapshots
 *  - fadeProbeDump(o?)  PNG the last matched texture -> logs/debug/ (o.save name)
 *  - fadeProbeOff()     disarm, restore normal drawing
 *
 * Suppress workflow (the A/B reveal, no mid-frame GPU split needed): arm with
 * {suppress:true}, let a frame present, `shot` → the page/scene shows through
 * (quad gone); arm with {suppress:false}, `shot` → black. The snapshot captures the
 * render states the game drove for the quad (blend/src/dst/lighting/tfactor/…),
 * the divergence-relevant data for the open "why is the quad opaque" paradox.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { harnessBus } from "../event-bus";
import { encodePngBase64 } from "./textures";
import { debugDumpPath } from "./screen";
import { readSurfaceStateRGBA } from "../../modules/ddraw/gpu-texture-utils";
import type { DrawObservation } from "../../backends/webgpu/ddraw/ddraw-backend-executor";
import type { DirectDrawSurfaceState } from "../../modules/ddraw/com-objects";
import {
    D3DRENDERSTATE_LIGHTING,
    D3DRENDERSTATE_ALPHABLENDENABLE,
    D3DRENDERSTATE_SRCBLEND,
    D3DRENDERSTATE_DESTBLEND,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DRENDERSTATE_CULLMODE,
    D3DRENDERSTATE_FOGENABLE,
    D3DRENDERSTATE_TEXTUREFACTOR,
} from "../../modules/ddraw/constants";

interface FadeProbeOpts {
    texSize: number;
    requireLighting: boolean;
    suppress: boolean;
    keep: number;
}

interface FadeSample {
    n: number;
    indexed: boolean;
    primType: number;
    vCount: number;
    texW: number;
    texH: number;
    texPtr: string;
    targetW: number;
    targetH: number;
    lighting: number;
    abe: number;
    src: number;
    dst: number;
    alphaTest: number;
    zwrite: number;
    cull: number;
    fog: number;
    tfactor: string;
}

let opts: FadeProbeOpts = { texSize: 32, requireLighting: true, suppress: false, keep: 64 };
let armed = false;
let matches = 0;
let samples: FadeSample[] = [];
let lastTexture: DirectDrawSurfaceState | null = null;

/** The observer installed on the executor. Wrapped so a probe bug can never crash
 *  the guest render path (returns false = don't suppress on any internal error). */
function observe(d: DrawObservation): boolean {
    try {
        const t = d.texture;
        if (!t || t.width !== opts.texSize || t.height !== opts.texSize) return false;
        const rs = d.renderStates;
        if (opts.requireLighting && !(rs[D3DRENDERSTATE_LIGHTING] | 0)) return false;
        matches++;
        lastTexture = t;
        const s: FadeSample = {
            n: matches,
            indexed: d.indexed,
            primType: d.primitiveType,
            vCount: d.vertexCount,
            texW: t.width,
            texH: t.height,
            texPtr: "0x" + ((t.surfacePtr ?? 0) >>> 0).toString(16),
            targetW: d.target?.width ?? 0,
            targetH: d.target?.height ?? 0,
            lighting: rs[D3DRENDERSTATE_LIGHTING] | 0,
            abe: rs[D3DRENDERSTATE_ALPHABLENDENABLE] | 0,
            src: rs[D3DRENDERSTATE_SRCBLEND] | 0,
            dst: rs[D3DRENDERSTATE_DESTBLEND] | 0,
            alphaTest: rs[D3DRENDERSTATE_ALPHATESTENABLE] | 0,
            zwrite: rs[D3DRENDERSTATE_ZWRITEENABLE] | 0,
            cull: rs[D3DRENDERSTATE_CULLMODE] | 0,
            fog: rs[D3DRENDERSTATE_FOGENABLE] | 0,
            tfactor: "0x" + ((rs[D3DRENDERSTATE_TEXTUREFACTOR] | 0) >>> 0).toString(16),
        };
        samples.push(s);
        if (samples.length > opts.keep) samples.shift();
        harnessBus.emit("fadeQuad", s);
        return opts.suppress;
    } catch {
        return false;
    }
}

/** Resolve the active device's FFP executor (D3D8/DDraw), or throw. */
function activeExecutor(): { drawObserver: ((d: DrawObservation) => boolean) | null } {
    const active = sys().services?.render?.getActive?.() as { renderer?: unknown } | null;
    const exec = active?.renderer as { drawObserver?: unknown; drawPrimitive?: unknown } | undefined;
    if (!exec || typeof exec.drawPrimitive !== "function") {
        throw new HarnessError(
            "active device has no FFP executor (not D3D8/DDraw, or nothing rendered yet) — nothing to probe",
            HarnessErrorCode.UNSUPPORTED,
        );
    }
    return exec as { drawObserver: ((d: DrawObservation) => boolean) | null };
}

export function registerFadeProbeCommands(svc: HarnessService): void {
    svc.register("fadeProbe", (args) => {
        const o = (args[0] ?? {}) as Partial<FadeProbeOpts>;
        opts = {
            texSize: o.texSize ?? 32,
            requireLighting: o.requireLighting ?? true,
            suppress: !!o.suppress,
            keep: Math.max(1, o.keep ?? 64),
        };
        const exec = activeExecutor();
        exec.drawObserver = observe;
        armed = true;
        matches = 0;
        samples = [];
        lastTexture = null;
        return { armed, opts };
    });

    svc.register("fadeProbeReport", () => ({
        armed,
        matches,
        suppress: opts.suppress,
        texSize: opts.texSize,
        requireLighting: opts.requireLighting,
        samples,
    }));

    svc.register("fadeProbeDump", async (args) => {
        const o = (args[0] ?? {}) as { save?: string };
        if (!lastTexture) {
            throw new HarnessError(
                "no matched fade texture yet (arm fadeProbe, then let a fade quad render)",
                HarnessErrorCode.NOT_FOUND,
            );
        }
        const backend = sys().services?.render?.getBackend?.() as
            | { kind?: string; getDevice(): GPUDevice | null; getQueue(): GPUQueue | null }
            | null;
        const wgpu = backend && backend.kind === "webgpu" ? backend : null;
        const r = await readSurfaceStateRGBA(lastTexture, wgpu);
        if ("err" in r) throw new HarnessError(`readSurfaceStateRGBA: ${r.err}`, HarnessErrorCode.INTERNAL);
        const ptrHex = ((lastTexture.surfacePtr ?? 0) >>> 0).toString(16);
        const name = (o.save ?? `fadequad_${ptrHex}_${r.w}x${r.h}`).replace(/\.png$/i, "");
        const base64 = await encodePngBase64(r.rgba, r.w, r.h);
        (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
        return { saved: debugDumpPath(name), w: r.w, h: r.h, source: r.source, texPtr: "0x" + ptrHex };
    });

    svc.register("fadeProbeOff", () => {
        // Only clear if it's OUR observer — never stomp another consumer's hook.
        const active = sys().services?.render?.getActive?.() as { renderer?: { drawObserver?: unknown } } | null;
        const exec = active?.renderer;
        if (exec && exec.drawObserver === observe) exec.drawObserver = null;
        armed = false;
        return { armed: false, matches };
    });
}
