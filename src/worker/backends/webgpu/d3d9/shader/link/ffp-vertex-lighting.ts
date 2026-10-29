/** Fixed-function lighting carried in a synthesized VS constant bank. Reuses the
 * same light packing and WGSL lighting equation as the ordinary FFP backends. */
import {
    FFP_LIGHT_STRUCT_WGSL, FFP_SELECT_COLOR_WGSL, FFP_MAX_LIGHTS,
    FFP_LIGHTSET_FLOATS, packFfpLightSet, emitFfpComputeLighting,
    type FfpColor, type FfpLightInput,
} from "../../ffp-lighting";
import {
    D3DRENDERSTATE_COLORVERTEX,
    D3DRENDERSTATE_LOCALVIEWER,
    D3DRENDERSTATE_NORMALIZENORMALS,
    D3DRENDERSTATE_SPECULARENABLE,
} from "../../../../../modules/ddraw/constants";
import type { FFPLightingState } from "../../../../../modules/ddraw/d3d/ffp-lighting";

// Seven vec4 material/control records, then the shared count + eight-light block.
export const FFP_VERTEX_LIGHTING_REGISTERS = 7 + FFP_LIGHTSET_FLOATS / 4;
export interface FixedFunctionVertexLighting {
    constantSlot: number;
    worldViewSlot: number;
    normalMatrixSlot: number;
    positionRegister: number;
    normalRegister: number | null;
}

export const FFP_VERTEX_LIGHTING_WGSL = FFP_LIGHT_STRUCT_WGSL + FFP_SELECT_COLOR_WGSL
    + emitFfpComputeLighting("(*lights)", true);

/** Called after the synthesized bytecode has supplied oD0/oD1, before interpolation. */
export function emitFixedFunctionVertexLighting(
    o: FixedFunctionVertexLighting, inputs: Map<number, string>, vsc: string,
): string {
    const c = (n: number) => `${vsc}.c[${o.constantSlot + n}]`;
    const pos = inputs.get(o.positionRegister) ?? "vec4f(0.0, 0.0, 0.0, 1.0)";
    const normal = o.normalRegister === null ? "vec4f(0.0)" : inputs.get(o.normalRegister) ?? "vec4f(0.0)";
    const transform = (v: string, slot: number) => `vec3f(${[0, 1, 2].map(i => `dot(${v}, ${vsc}.c[${slot + i}])`).join(", ")})`;
    // A function-address-space array permits dynamic indexing on all supported WGSL
    // validators, including those that reject indexing an array passed by value.
    const lights = Array.from({ length: FFP_MAX_LIGHTS }, (_, i) =>
        `_ffpLights[${i}] = FfpLight(${Array.from({ length: 7 }, (_, j) => c(8 + i * 7 + j)).join(", ")});`).join("\n");
    return `
var _ffpLights: array<FfpLight, ${FFP_MAX_LIGHTS}>;
${lights}
let _ffpLit = ffpComputeLighting(
    ${transform(`vec4f((${pos}).xyz, 1.0)`, o.worldViewSlot)},
    ${transform(`vec4f((${normal}).xyz, 0.0)`, o.normalMatrixSlot)},
    ${c(0)}, ${c(1)}, ${c(2)}, ${c(3)},
    ${c(5)}.x, ${c(5)}.y != 0.0, ${c(5)}.z != 0.0, ${o.normalRegister !== null},
    ${c(5)}.w != 0.0,
    ${c(6)}.x, ${c(6)}.y, ${c(6)}.z, ${c(6)}.w,
    ${c(4)}.xyz, i32(${c(7)}.x), oD0, oD1, &_ffpLights);
oD0 = _ffpLit[0];
oD1 = vec4f(_ffpLit[1].xyz, oD1.w);
`;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function writeColor(out: Float32Array, offset: number, color: FfpColor): void {
    out[offset] = color.r;
    out[offset + 1] = color.g;
    out[offset + 2] = color.b;
    out[offset + 3] = color.a;
}

function materialSource(source: number, colorVertex: boolean, hasDiffuse: boolean, hasSpecular: boolean): number {
    if (!colorVertex || (source === 1 && !hasDiffuse) || (source === 2 && !hasSpecular)) return 0;
    return source;
}

/** Reuses light records and writes directly into the destination constant bank. */
export class FfpVertexLightingPacker {
    private readonly lights: FfpLightInput[] = [];
    private readonly pool: FfpLightInput[] = [];

    write(
        out: Float32Array, slot: number, state: FFPLightingState, rs: ArrayLike<number>,
        hasDiffuse: boolean, hasSpecular: boolean,
    ): void {
        const base = slot * 4;
        writeColor(out, base, state.material.diffuse);
        writeColor(out, base + 4, state.material.ambient);
        writeColor(out, base + 8, state.material.specular);
        writeColor(out, base + 12, state.material.emissive);
        writeColor(out, base + 16, state.ambientColor);
        out[base + 20] = state.material.power;
        out[base + 21] = +(rs[D3DRENDERSTATE_SPECULARENABLE] !== 0);
        out[base + 22] = +(rs[D3DRENDERSTATE_LOCALVIEWER] !== 0);
        out[base + 23] = +(rs[D3DRENDERSTATE_NORMALIZENORMALS] !== 0);
        const colorVertex = rs[D3DRENDERSTATE_COLORVERTEX] !== 0;
        out[base + 24] = materialSource(state.diffuseSource, colorVertex, hasDiffuse, hasSpecular);
        out[base + 25] = materialSource(state.ambientSource, colorVertex, hasDiffuse, hasSpecular);
        out[base + 26] = materialSource(state.specularSource, colorVertex, hasDiffuse, hasSpecular);
        out[base + 27] = materialSource(state.emissiveSource, colorVertex, hasDiffuse, hasSpecular);
        this.lights.length = 0;
        for (let i = 0; i < Math.min(state.lights.length, FFP_MAX_LIGHTS); i++) {
            const light = state.lights[i]!;
            const record = this.pool[i] ??= {
                type: 0, diffuse: light.diffuse, specular: light.specular, ambient: light.ambient,
                position: [0, 0, 0], direction: [0, 0, 0], range: 0, falloff: 0,
                att0: 0, att1: 0, att2: 0, theta: 0, phi: 0,
            };
            record.type = light.type;
            record.diffuse = light.diffuse;
            record.specular = light.specular;
            record.ambient = light.ambient;
            record.position[0] = light.position.x;
            record.position[1] = light.position.y;
            record.position[2] = light.position.z;
            record.direction[0] = light.direction.x;
            record.direction[1] = light.direction.y;
            record.direction[2] = light.direction.z;
            record.range = light.range;
            record.falloff = light.falloff;
            record.att0 = light.attenuation0;
            record.att1 = light.attenuation1;
            record.att2 = light.attenuation2;
            record.theta = light.theta;
            record.phi = light.phi;
            this.lights.push(record);
        }
        packFfpLightSet(out, this.lights, state.viewMatrix ?? IDENTITY, base + 28);
    }
}
