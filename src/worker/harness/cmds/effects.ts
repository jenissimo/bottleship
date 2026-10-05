/**
 * What the D3DX effect layer is actually bound to.
 *
 * An effect drives the whole renderer of a title like RA3, and its failure mode is SILENT: a
 * texture parameter nobody set, a sampler block naming a parameter that will not resolve, an
 * array selector whose index expression does not parse — each one binds nothing, no call
 * fails, and the frame renders from the fallback texture. Counting calls cannot see it; only
 * the model's own state can.
 */
import type { HarnessService } from "../service";
import { allEffectInstances, effectSetTextureOutcomes, effectNameLookups } from "../../modules/d3dx9/effect-state";
import { effectApplyWarnings, effectZeroConstantCensus, shaderObjectIndicesOf } from "../../modules/d3dx9/effect-apply";
import { STATE_PIXEL_SHADER, STATE_VERTEX_SHADER } from "../../modules/d3dx9/effect-parser";
import { effectParamWriteCensus } from "../../modules/d3dx9/effect-values";
import { effectAnnotationReadCensus } from "../../modules/d3dx9/effects";
import { d3dxTextureCreateOutcomes } from "../../modules/d3dx9/textures";
import { EffectParamClass, EffectParamType } from "../../modules/d3dx9/effect-state";

function isTexture(type: number): boolean {
    return type >= EffectParamType.Texture && type <= EffectParamType.TextureCube;
}

/** Chunked, because `String.fromCharCode(...blob)` blows the argument limit on a shader
 *  object of any size and the verb would throw instead of handing the bytes out. */
function toBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

export function registerEffectCommands(svc: HarnessService): void {
    /**
     * effectSelectors() — the FXLC index expression behind every shader ARRAY, as base64.
     *
     * A selector that will not evaluate binds NO shader for that pass, and the draw falls back
     * to the fixed function — geometry in the right place with the wrong shading, which reads
     * as an art bug. The bytes are a d3dx preshader, so the shipped d3dx9 disassembler can say
     * what the expression actually is instead of us inferring it from a failure message.
     */
    svc.register("effectSelectors", () => {
        const out: Array<Record<string, unknown>> = [];
        for (const [ptr, inst] of allEffectInstances()) {
            for (const technique of inst.model.techniques) {
                for (const pass of technique.passes) {
                    for (const a of pass.assignments) {
                        if (!a.selector || !a.selector.length) continue;
                        out.push({
                            effect: "0x" + (ptr >>> 0).toString(16),
                            state: a.state,
                            stage: a.state === STATE_VERTEX_SHADER ? "vertex"
                                : a.state === STATE_PIXEL_SHADER ? "pixel" : "other",
                            arrayName: a.parameterName ?? "",
                            bytes: a.selector.length,
                            base64: toBase64(a.selector),
                        });
                    }
                }
            }
        }
        return out;
    });

    /**
     * effectShaderBlobs() — every shader object a pass binds, as base64, with the effect and
     * object index that own it.
     *
     * A shader that will not create is diagnosed by READING IT, and reading it inside a
     * running guest costs a boot per hypothesis. Handing the bytes out lets the same parser
     * run offline against the real d3dx9 disassembler, so "our parser is wrong" and "we fetched
     * the wrong object" stop looking alike. Object indices are per effect: an index alone does
     * not identify a blob, which is exactly the bug this verb was written to see.
     */
    svc.register("effectShaderBlobs", () => {
        const out: Array<Record<string, unknown>> = [];
        for (const [ptr, inst] of allEffectInstances()) {
            const seen = new Set<number>();
            for (const technique of inst.model.techniques) {
                for (const pass of technique.passes) {
                    for (const a of pass.assignments) {
                        const vertex = a.state === STATE_VERTEX_SHADER;
                        if (!vertex && a.state !== STATE_PIXEL_SHADER) continue;
                        for (const index of shaderObjectIndicesOf(inst, a)) {
                            if (index < 0 || seen.has(index)) continue;
                            seen.add(index);
                            const data = inst.model.objects[index]?.data;
                            if (!data || data.length < 8) continue;
                            const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
                            out.push({
                                effect: "0x" + (ptr >>> 0).toString(16),
                                objectIndex: index,
                                stage: vertex ? "vertex" : "pixel",
                                bytes: data.length,
                                version: "0x" + (dv.getUint32(0, true) >>> 0).toString(16),
                                base64: toBase64(data),
                            });
                        }
                    }
                }
            }
        }
        return out;
    });

    /** effectConstants(limit?) — shader constants the effect layer uploaded as ALL ZERO.
     *
     *  The quietest failure this layer has: the draw is issued, the pipeline is valid, nothing
     *  is refused, and the geometry collapses because its transform matrix is zeros. `paramZero`
     *  splits the two causes that look identical from the picture — the app never gave us a
     *  value (paramZero == zero) versus we packed a value it did give into zeros (paramZero 0
     *  with zero > 0), which is our bug and nobody else's. */
    svc.register("effectConstants", (args) => {
        const limit = typeof args[0] === "number" ? Math.max(1, args[0] as number) : 40;
        const all = effectZeroConstantCensus();
        const writes = new Map(effectParamWriteCensus().map((w) => [w.name, w]));
        return {
            total: all.length,
            // `writes` is the app's own side of the story: a constant uploaded thousands of
            // times whose parameter was never written is a set that landed somewhere else,
            // not a value the app declined to supply.
            zeroed: all.filter((r) => r.zero > 0).slice(0, limit)
                .map((r) => ({ ...r, writes: writes.get(r.name)?.writes ?? 0, zeroWrites: writes.get(r.name)?.zeroWrites ?? 0, sourceZero: writes.get(r.name)?.sourceZero ?? 0, lastZeroPtr: writes.get(r.name)?.lastZeroPtr, lastZeroCaller: writes.get(r.name)?.lastZeroCaller, lastPtr: writes.get(r.name)?.lastPtr })),
            topWrites: effectParamWriteCensus().slice(0, 20),
            annotationReads: effectAnnotationReadCensus().slice(0, 20),
        };
    });

    /** effects({names?}) — per-effect parameter census plus the apply-path warnings. */
    svc.register("effects", (args) => {
        const opts = (args[0] ?? {}) as { names?: boolean };
        let textureParams = 0, textureParamsBound = 0, samplerParams = 0, samplerTextureStates = 0;
        const unboundNames: string[] = [];
        // A pass annotation is how a SAS engine names the routine that fills its per-view
        // constants, so "which effects have annotated passes" separates a parse that lost
        // them from a title that simply does not use them.
        let passes = 0, annotatedPasses = 0, effectsWithNoAnnotatedPass = 0;
        for (const [, inst] of allEffectInstances()) {
            let any = 0, total = 0;
            for (const technique of inst.model.techniques) {
                for (const pass of technique.passes) {
                    total++;
                    if ((pass.annotations?.length ?? 0) > 0) any++;
                }
            }
            passes += total;
            annotatedPasses += any;
            if (total > 0 && any === 0) effectsWithNoAnnotatedPass++;
        }
        const passAnnotations = { passes, annotatedPasses, effectsWithNoAnnotatedPass };
        const effects = allEffectInstances().map(([ptr, inst]) => {
            let tex = 0, bound = 0, samplers = 0;
            for (const p of inst.model.parameters) {
                if (p.paramClass !== EffectParamClass.Object) continue;
                if (isTexture(p.type)) {
                    tex++;
                    if (p.objectPtr) bound++;
                    else if (unboundNames.length < 40) unboundNames.push(p.name);
                }
                if (p.samplerStates?.length) {
                    samplers++;
                    samplerTextureStates += p.samplerStates.length;
                }
            }
            textureParams += tex; textureParamsBound += bound; samplerParams += samplers;
            return {
                effect: "0x" + (ptr >>> 0).toString(16),
                parameters: inst.model.parameters.length,
                techniques: inst.model.techniques.length,
                textureParams: tex,
                textureParamsBound: bound,
                samplerParams: samplers,
                ...(opts.names ? { names: inst.model.parameters.map((p) => p.name) } : {}),
            };
        });
        return {
            effectCount: effects.length,
            // The number that matters: texture parameters the app has actually SET. Zero here
            // with a non-zero textureParams means every sampler resolves to a null texture.
            textureParams,
            textureParamsBound,
            samplerParams,
            samplerTextureStates,
            unboundTextureNames: unboundNames,
            // Why a SetTexture did not land, if it did not: the parameter handle did not
            // resolve, the parameter was not a texture, or the app passed NULL.
            setTextureOutcomes: effectSetTextureOutcomes(),
            // Which NAMES the app asked us to resolve, and which we refused.
            nameLookups: effectNameLookups(),
            passAnnotations,
            // RA3 binds parameters through SAS: each carries a SasBindAddress annotation
            // naming the engine value. What the TEXTURE parameters ask for is the question.
            sasTextureBindings: (() => {
                const out: string[] = []; let withSas = 0, withoutSas = 0;
                for (const [, inst] of allEffectInstances()) {
                    for (const p of inst.model.parameters) {
                        if (p.paramClass !== EffectParamClass.Object) continue;
                        if (!(p.type >= EffectParamType.Texture && p.type <= EffectParamType.TextureCube)) continue;
                        const sas = p.annotations.find((a) => a.name.toLowerCase() === "sasbindaddress");
                        if (sas?.stringValue) {
                            withSas++;
                            if (out.length < 14) out.push(`${p.name} <- ${sas.stringValue}`);
                        } else {
                            withoutSas++;
                            if (out.length < 14) out.push(`${p.name} <- (no SasBindAddress; anns=${p.annotations.map((a) => a.name).join(",")})`);
                        }
                    }
                }
                return { withSas, withoutSas, sample: out };
            })(),
            // D3DX_PARAMETER_SHARED (1) / _LITERAL (2): an app uses these to decide where a
            // parameter's storage lives. All-zero means we are reporting none as shared.
            paramFlags: (() => {
                const hist: Record<string, number> = {};
                for (const [, inst] of allEffectInstances()) {
                    for (const p of inst.model.parameters) {
                        const k = "0x" + ((p.flags ?? 0) >>> 0).toString(16);
                        hist[k] = (hist[k] ?? 0) + 1;
                    }
                }
                return hist;
            })(),
            // String annotations are what an engine matches its shader variants on (RA3
            // compares one against "static" and CLEARS the sampler's texture when it differs),
            // so an empty one is not cosmetic.
            stringAnnotations: (() => {
                let total = 0, empty = 0; const sample: string[] = [];
                for (const [, inst] of allEffectInstances()) {
                    const lists = [
                        ...inst.model.parameters.map((p) => p.annotations),
                        ...inst.model.techniques.map((t) => t.annotations),
                        ...inst.model.techniques.flatMap((t) => t.passes.map((ps) => ps.annotations)),
                    ];
                    for (const list of lists) for (const a of list) {
                        if (a.type !== EffectParamType.String) continue;
                        total++;
                        if (!a.stringValue) empty++;
                        else if (sample.length < 12) sample.push(`${a.name}="${a.stringValue}"`);
                    }
                }
                return { total, empty, sample };
            })(),
            warnings: effectApplyWarnings(),
            effects: effects.slice(0, 40),
        };
    });
}

/**
 * d3dxTextures() — what D3DXCreateTexture* produced, by outcome.
 *
 * A refused create is invisible from every other angle: the engine's own loader substitutes a
 * placeholder (RA3 fills a texture with 0xffff00ff and releases the object) and carries on, so
 * the only symptom is a scene rendered in the game's error colour.
 */
export function registerD3dxTextureCommands(svc: HarnessService): void {
    svc.register("d3dxTextures", () => ({ creates: d3dxTextureCreateOutcomes() }));
}
