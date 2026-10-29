import { describe, expect, test } from "bun:test";
import {
    FfpVertexLightingPacker, FFP_VERTEX_LIGHTING_REGISTERS,
} from "../../src/worker/backends/webgpu/d3d9/shader/link/ffp-vertex-lighting";
import { createDefaultMaterial, type D3DLight7Data } from "../../src/worker/modules/ddraw/d3d/types";
import type { FFPLightingState } from "../../src/worker/modules/ddraw/d3d/ffp-lighting";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const SLOT = 44;
function fixture() {
    const state: FFPLightingState = {
        lightingEnabled: true, material: createDefaultMaterial(), lights: [],
        ambientColor: { r: 0.25, g: 0.5, b: 0.75, a: 1 }, worldMatrix: IDENTITY, viewMatrix: IDENTITY,
        diffuseSource: 2, ambientSource: 2, specularSource: 0, emissiveSource: 1,
    };
    const rs = new Int32Array(256);
    rs[141] = 1; rs[29] = 1; rs[142] = 1; rs[143] = 1;
    const out = new Float32Array(SLOT * 4 + FFP_VERTEX_LIGHTING_REGISTERS * 4 + 4).fill(-99);
    const packer = new FfpVertexLightingPacker();
    const write = (diffuse = true, specular = false) => packer.write(out, SLOT, state, rs, diffuse, specular);
    const at = (register: number) => Array.from(out.subarray((SLOT + register) * 4, (SLOT + register + 1) * 4));
    return { state, rs, out, write, at };
}

function light(type: number): D3DLight7Data {
    return {
        type, diffuse: { r: type / 4, g: 0, b: 0, a: 1 },
        specular: { r: 0, g: 0.5, b: 0, a: 1 }, ambient: { r: 0, g: 0, b: 0.25, a: 1 },
        position: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: 0, z: 2 }, range: 64, falloff: 2,
        attenuation0: 1, attenuation1: 0.5, attenuation2: 0.25, theta: 0, phi: Math.PI,
    };
}

describe("synthesized D3D8 vertex-lighting transport", () => {
    test("material, control flags and missing-colour fallback match the lighting contract", () => {
        const t = fixture();
        t.state.material.diffuse = { r: 1, g: 0.5, b: 0.25, a: 0.125 };
        t.state.material.emissive = { r: 0.0625, g: 0.125, b: 0.25, a: 0.5 };
        t.state.material.power = 8;
        t.write();
        expect(t.at(0)).toEqual([1, 0.5, 0.25, 0.125]);
        expect(t.at(3)).toEqual([0.0625, 0.125, 0.25, 0.5]);
        expect(t.at(4)).toEqual([0.25, 0.5, 0.75, 1]);
        expect(t.at(5)).toEqual([8, 1, 1, 1]);
        // Missing COLOR2 falls back to MATERIAL; emissive COLOR1 remains vertex diffuse.
        expect(t.at(6)).toEqual([0, 0, 0, 1]);
        expect(t.at(7)).toEqual([0, 0, 0, 0]);
        expect(t.out.subarray(0, SLOT * 4).every(x => x === -99)).toBe(true);
        expect(t.out.subarray((SLOT + FFP_VERTEX_LIGHTING_REGISTERS) * 4).every(x => x === -99)).toBe(true);
        t.rs[141] = 0;
        t.write();
        expect(t.at(6)).toEqual([0, 0, 0, 0]);
        t.rs[141] = 1;
        t.write(true, true);
        expect(t.at(6)).toEqual([2, 2, 0, 1]);
        t.write(false, true);
        expect(t.at(6)).toEqual([2, 2, 0, 0]);
        t.rs[29] = 0; t.rs[142] = 0; t.rs[143] = 0;
        t.write();
        expect(t.at(5)).toEqual([8, 0, 0, 0]);
    });

    test("directional, point and spot lights retain their type and transform into view space", () => {
        const t = fixture();
        t.state.viewMatrix = new Float32Array(IDENTITY);
        t.state.viewMatrix[12] = 10;
        t.state.lights = [light(3), light(1), light(2)];
        t.write();
        expect(t.at(7)[0]).toBe(3);
        for (let i = 0; i < 3; i++) {
            const b = 8 + i * 7;
            expect(t.at(b + 3)).toEqual([11, 2, 3, 64]);
            expect(t.at(b + 5)).toEqual([1, 0.5, 0.25, [3, 1, 2][i]]);
            expect(t.at(b + 4)[2]).toBe(i === 0 ? -1 : 1);
            expect(t.at(b + 4)[3]).toBe(2);
            expect(t.at(b + 6)[0]).toBe(1);
            expect(t.at(b + 6)[1]).toBeCloseTo(0, 6);
        }
        // A later disable must clear stale records, not replay them.
        t.state.lights = [];
        t.write();
        expect(t.at(7)[0]).toBe(0);
        expect(t.out.subarray((SLOT + 8) * 4, (SLOT + FFP_VERTEX_LIGHTING_REGISTERS) * 4).every(x => x === 0)).toBe(true);
    });

    test("the bank supports all eight active lights without crossing its boundary", () => {
        const t = fixture();
        t.state.lights = Array.from({ length: 9 }, () => light(1));
        t.write();
        expect(t.at(7)[0]).toBe(8);
        expect(t.at(8 + 7 * 7 + 5)).toEqual([1, 0.5, 0.25, 1]);
        expect(t.out.subarray((SLOT + FFP_VERTEX_LIGHTING_REGISTERS) * 4).every(x => x === -99)).toBe(true);
    });
});
