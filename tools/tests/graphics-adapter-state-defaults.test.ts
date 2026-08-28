/**
 * Pins every graphics-adapter device-state DEFAULT (render states, texture-stage states, D3D9
 * sampler states) against ground truth (wined3d's stateblock.c state_init_default /
 * init_default_texture_state / init_default_sampler_states — G:/sources/wine/dlls/wined3d/
 * stateblock.c — cross-checked against dxvk's d3d8/d3d9 device state).
 *
 * Each adapter's render-state array is an Int32Array (or, for D3D9's TSS/sampler blocks, a Map
 * defaulted at the read site): an unseeded slot reads 0, and 0 is either a LEGAL-BUT-WRONG value
 * (e.g. D3DRS_COLORWRITEENABLE=0 means "write no channel", not "unset") or not even a legal enum
 * member (D3DSTENCILOP/D3DCMP both start at 1) for most of the states this file pins. A future
 * edit that drops or changes a seed — or a new adapter that forgets to seed one — fails HERE,
 * not three bring-up sessions later as a silently-wrong render or a bogus captured state block.
 *
 * One deliberate, documented cross-backend deviation is exempted rather than pinned to the D3D
 * spec value: D3DRENDERSTATE_LIGHTING defaults to FALSE on the D3D7/D3D8 paths (real D3D default
 * is TRUE) because SetMaterial/SetLight/LightEnable/normal transforms are not fully implemented
 * there yet — see the seed's own comment in both files. D3D9's tracker already seeds the correct
 * TRUE default. This test asserts the DEVIATION explicitly (not "whatever the code happens to
 * do") so a silent flip in either direction is caught.
 */
import { describe, expect, test } from "bun:test";
import {
    createD3D8DefaultRenderStates,
    createD3D8DefaultTextureStates,
} from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import { EMPTY_RENDER_STATES, EMPTY_TEX_STATES, createDefaultMaterial } from "../../src/worker/modules/ddraw/d3d/types";
import { D3D9StateTracker } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";
import { StreamBindingTable } from "../../src/worker/backends/webgpu/shared/vertex-streams";
import { d3d9TextureStageStateDefault } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { d3d9SamplerStateDefault } from "../../src/worker/backends/webgpu/d3d9/d3d9-sampler";
import * as C from "../../src/worker/modules/ddraw/constants";

// D3D9 render-state / TSS / sampler numeric IDs the tracker/device use internally (mirrors the
// private consts in d3d9-state-tracker.ts / d3d9-device.ts — kept in sync by this very test).
const D3DRS = {
    ZENABLE: 7, FILLMODE: 8, SHADEMODE: 9, ZWRITEENABLE: 14, ALPHATESTENABLE: 15,
    SRCBLEND: 19, DESTBLEND: 20, CULLMODE: 22, ZFUNC: 23, ALPHAREF: 24, ALPHAFUNC: 25,
    DITHERENABLE: 26, ALPHABLENDENABLE: 27, FOGENABLE: 28, SPECULARENABLE: 29,
    FOGCOLOR: 34, FOGTABLEMODE: 35, FOGSTART: 36, FOGEND: 37, FOGDENSITY: 38,
    RANGEFOGENABLE: 48, STENCILENABLE: 52, STENCILFAIL: 53, STENCILZFAIL: 54,
    STENCILPASS: 55, STENCILFUNC: 56, STENCILREF: 57, STENCILMASK: 58, STENCILWRITEMASK: 59,
    TEXTUREFACTOR: 60, COLORVERTEX: 141, FOGVERTEXMODE: 140, CLIPPING: 136, LIGHTING: 137,
    AMBIENT: 139, LOCALVIEWER: 142, NORMALIZENORMALS: 143, DIFFUSEMATERIALSOURCE: 145,
    SPECULARMATERIALSOURCE: 146, AMBIENTMATERIALSOURCE: 147, EMISSIVEMATERIALSOURCE: 148,
    VERTEXBLEND: 151, POINTSIZE: 154, POINTSIZE_MIN: 155, POINTSPRITEENABLE: 156,
    POINTSCALEENABLE: 157, POINTSCALE_A: 158, POINTSCALE_B: 159, POINTSCALE_C: 160,
    MULTISAMPLEANTIALIAS: 161, MULTISAMPLEMASK: 162, POINTSIZE_MAX: 166,
    INDEXEDVERTEXBLENDENABLE: 167, COLORWRITEENABLE: 168, BLENDOP: 171,
    SCISSORTESTENABLE: 174, ANTIALIASEDLINEENABLE: 176, CCW_STENCILFAIL: 186,
    CCW_STENCILZFAIL: 187, CCW_STENCILPASS: 188, CCW_STENCILFUNC: 189,
    COLORWRITEENABLE1: 190, COLORWRITEENABLE2: 191, COLORWRITEENABLE3: 192,
    SRGBWRITEENABLE: 194, SRCBLENDALPHA: 207, DESTBLENDALPHA: 208, BLENDOPALPHA: 209,
} as const;
const F1_0 = 0x3f800000; // 1.0f
const F0_0 = 0x00000000; // 0.0f

// ---------------------------------------------------------------------------------------------
// D3D7 / DDraw executor (modules/ddraw/d3d/types.ts) — EMPTY_RENDER_STATES / EMPTY_TEX_STATES
// ---------------------------------------------------------------------------------------------

describe("DDraw/D3D7 default render states (createDefaultRenderStates)", () => {
    const rs = EMPTY_RENDER_STATES;

    test.each([
        ["ZENABLE", C.D3DRENDERSTATE_ZENABLE, C.D3DZB_FALSE], // documented DX7 deviation (real default TRUE)
        ["ZWRITEENABLE", C.D3DRENDERSTATE_ZWRITEENABLE, 1],
        ["ZFUNC", C.D3DRENDERSTATE_ZFUNC, C.D3DCMP_LESSEQUAL],
        ["FILLMODE", C.D3DRENDERSTATE_FILLMODE, C.D3DFILL_SOLID],
        ["SHADEMODE", C.D3DRENDERSTATE_SHADEMODE, C.D3DSHADE_GOURAUD],
        ["CULLMODE", C.D3DRENDERSTATE_CULLMODE, C.D3DCULL_CCW],
        ["ALPHATESTENABLE", C.D3DRENDERSTATE_ALPHATESTENABLE, 0],
        ["ALPHAREF", C.D3DRENDERSTATE_ALPHAREF, 0],
        ["ALPHAFUNC", C.D3DRENDERSTATE_ALPHAFUNC, C.D3DCMP_ALWAYS],
        ["ALPHABLENDENABLE", C.D3DRENDERSTATE_ALPHABLENDENABLE, 0],
        ["SRCBLEND", C.D3DRENDERSTATE_SRCBLEND, C.D3DBLEND_ONE],
        ["DESTBLEND", C.D3DRENDERSTATE_DESTBLEND, C.D3DBLEND_ZERO],
        ["LIGHTING", C.D3DRENDERSTATE_LIGHTING, 0], // documented deviation, see file header
        ["AMBIENT", C.D3DRENDERSTATE_AMBIENT, 0],
        ["SPECULARENABLE", C.D3DRENDERSTATE_SPECULARENABLE, 0],
        ["DITHERENABLE", C.D3DRENDERSTATE_DITHERENABLE, 0],
        ["FOGENABLE", C.D3DRENDERSTATE_FOGENABLE, 0],
        ["FOGTABLEMODE", C.D3DRENDERSTATE_FOGTABLEMODE, C.D3DFOG_NONE],
        ["FOGVERTEXMODE", C.D3DRENDERSTATE_FOGVERTEXMODE, C.D3DFOG_NONE],
        ["FOGSTART", C.D3DRENDERSTATE_FOGSTART, F0_0],
        ["FOGEND", C.D3DRENDERSTATE_FOGEND, F1_0],
        ["FOGDENSITY", C.D3DRENDERSTATE_FOGDENSITY, F1_0],
        ["COLORKEYENABLE", C.D3DRENDERSTATE_COLORKEYENABLE, 0],
        ["TEXTUREFACTOR", C.D3DRENDERSTATE_TEXTUREFACTOR, 0xffffffff],
        ["COLORVERTEX", C.D3DRENDERSTATE_COLORVERTEX, 1],
        ["LOCALVIEWER", C.D3DRENDERSTATE_LOCALVIEWER, 1],
        ["DIFFUSEMATERIALSOURCE", C.D3DRENDERSTATE_DIFFUSEMATERIALSOURCE, 1],
        ["AMBIENTMATERIALSOURCE", C.D3DRENDERSTATE_AMBIENTMATERIALSOURCE, 0],
        ["SPECULARMATERIALSOURCE", C.D3DRENDERSTATE_SPECULARMATERIALSOURCE, 2],
        ["EMISSIVEMATERIALSOURCE", C.D3DRENDERSTATE_EMISSIVEMATERIALSOURCE, 0],
        ["COLORWRITEENABLE (D3D9-numbered, shared pipeline)", 168, 0xf],
        ["BLENDOP (D3D9-numbered, shared pipeline)", 171, 1],
        ["STENCILMASK", C.D3DRENDERSTATE_STENCILMASK, 0xff],
        ["STENCILWRITEMASK", C.D3DRENDERSTATE_STENCILWRITEMASK, 0xff],
        ["STENCILENABLE", C.D3DRENDERSTATE_STENCILENABLE, 0],
        ["STENCILFAIL", C.D3DRENDERSTATE_STENCILFAIL, C.D3DSTENCILOP_KEEP],
        ["STENCILZFAIL", C.D3DRENDERSTATE_STENCILZFAIL, C.D3DSTENCILOP_KEEP],
        ["STENCILPASS", C.D3DRENDERSTATE_STENCILPASS, C.D3DSTENCILOP_KEEP],
        ["STENCILFUNC", C.D3DRENDERSTATE_STENCILFUNC, C.D3DCMP_ALWAYS],
        ["STENCILREF", C.D3DRENDERSTATE_STENCILREF, 0],
        ["POINTSCALE_A", C.D3DRENDERSTATE_POINTSCALE_A, F1_0],
    ])("%s = %i", (_name, state, expected) => {
        expect(rs[state]! >>> 0).toBe(expected >>> 0);
    });
});

describe("DDraw/D3D7 default texture-stage states (createDefaultTexStates)", () => {
    const ts = EMPTY_TEX_STATES;

    test("stage 0: MODULATE texture*diffuse, alpha = SELECTARG1(texture)", () => {
        expect(ts[0 * 32 + C.D3DTSS_COLOROP]).toBe(C.D3DTOP_MODULATE);
        expect(ts[0 * 32 + C.D3DTSS_COLORARG1]).toBe(C.D3DTA_TEXTURE);
        expect(ts[0 * 32 + C.D3DTSS_COLORARG2]).toBe(C.D3DTA_DIFFUSE);
        expect(ts[0 * 32 + C.D3DTSS_ALPHAOP]).toBe(C.D3DTOP_SELECTARG1);
        expect(ts[0 * 32 + C.D3DTSS_ALPHAARG1]).toBe(C.D3DTA_TEXTURE);
        expect(ts[0 * 32 + C.D3DTSS_ALPHAARG2]).toBe(C.D3DTA_DIFFUSE);
    });

    for (let stage = 0; stage < 8; stage++) {
        test(`stage ${stage}: WRAP address, POINT filter, no mip filter, TEXCOORDINDEX=stage`, () => {
            const o = stage * 32;
            expect(ts[o + C.D3DTSS_ADDRESSU]).toBe(C.D3DTADDRESS_WRAP);
            expect(ts[o + C.D3DTSS_ADDRESSV]).toBe(C.D3DTADDRESS_WRAP);
            expect(ts[o + C.D3DTSS_TEXCOORDINDEX]).toBe(stage);
            expect(ts[o + C.D3DTSS_MINFILTER]).toBe(C.D3DTFN_POINT);
            expect(ts[o + C.D3DTSS_MAGFILTER]).toBe(C.D3DTFG_POINT);
            expect(ts[o + C.D3DTSS_MIPFILTER]).toBe(C.D3DTFP_NONE);
        });
    }

    test("stages 1..7 default COLOROP/ALPHAOP to DISABLE (stage 0 does not)", () => {
        expect(ts[0 * 32 + C.D3DTSS_COLOROP]).not.toBe(C.D3DTOP_DISABLE);
        for (let stage = 1; stage < 8; stage++) {
            const o = stage * 32;
            expect(ts[o + C.D3DTSS_COLOROP]).toBe(C.D3DTOP_DISABLE);
            expect(ts[o + C.D3DTSS_ALPHAOP]).toBe(C.D3DTOP_DISABLE);
        }
    });
});

test("D3D7 default material is all-zero, matching real D3D's zero-initialized device state", () => {
    const m = createDefaultMaterial();
    for (const c of [m.diffuse, m.ambient, m.specular, m.emissive]) {
        expect(c.r).toBe(0); expect(c.g).toBe(0); expect(c.b).toBe(0); expect(c.a).toBe(0);
    }
    expect(m.power).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// D3D8 adapter (backends/webgpu/d3d8/d3d8-device-adapter.ts)
// ---------------------------------------------------------------------------------------------

describe("D3D8 default render states (createD3D8DefaultRenderStates)", () => {
    const rs = createD3D8DefaultRenderStates();

    test.each([
        ["ZENABLE", C.D3DRENDERSTATE_ZENABLE, C.D3DZB_TRUE],
        ["ZWRITEENABLE", C.D3DRENDERSTATE_ZWRITEENABLE, 1],
        ["ZFUNC", C.D3DRENDERSTATE_ZFUNC, C.D3DCMP_LESSEQUAL],
        ["FILLMODE", C.D3DRENDERSTATE_FILLMODE, C.D3DFILL_SOLID],
        ["SHADEMODE", C.D3DRENDERSTATE_SHADEMODE, C.D3DSHADE_GOURAUD],
        ["ALPHATESTENABLE", C.D3DRENDERSTATE_ALPHATESTENABLE, 0],
        ["ALPHAREF", C.D3DRENDERSTATE_ALPHAREF, 0],
        ["ALPHAFUNC", C.D3DRENDERSTATE_ALPHAFUNC, C.D3DCMP_ALWAYS],
        ["ALPHABLENDENABLE", C.D3DRENDERSTATE_ALPHABLENDENABLE, 0],
        ["SRCBLEND", C.D3DRENDERSTATE_SRCBLEND, C.D3DBLEND_ONE],
        ["DESTBLEND", C.D3DRENDERSTATE_DESTBLEND, C.D3DBLEND_ZERO],
        ["CULLMODE", C.D3DRENDERSTATE_CULLMODE, C.D3DCULL_CCW],
        ["DITHERENABLE", C.D3DRENDERSTATE_DITHERENABLE, 0],
        ["FOGENABLE", C.D3DRENDERSTATE_FOGENABLE, 0],
        ["FOGTABLEMODE", C.D3DRENDERSTATE_FOGTABLEMODE, C.D3DFOG_NONE],
        ["FOGVERTEXMODE", C.D3DRENDERSTATE_FOGVERTEXMODE, C.D3DFOG_NONE],
        ["FOGSTART", C.D3DRENDERSTATE_FOGSTART, F0_0],
        ["FOGEND", C.D3DRENDERSTATE_FOGEND, F1_0],
        ["FOGDENSITY", C.D3DRENDERSTATE_FOGDENSITY, F1_0],
        ["COLORKEYENABLE", C.D3DRENDERSTATE_COLORKEYENABLE, 0],
        ["LIGHTING", C.D3DRENDERSTATE_LIGHTING, 0], // documented deviation, see file header
        ["AMBIENT", C.D3DRENDERSTATE_AMBIENT, 0],
        ["SPECULARENABLE", C.D3DRENDERSTATE_SPECULARENABLE, 0],
        ["TEXTUREFACTOR", C.D3DRENDERSTATE_TEXTUREFACTOR, 0xffffffff],
        ["DIFFUSEMATERIALSOURCE", C.D3DRENDERSTATE_DIFFUSEMATERIALSOURCE, 1],
        ["AMBIENTMATERIALSOURCE", C.D3DRENDERSTATE_AMBIENTMATERIALSOURCE, 0],
        ["SPECULARMATERIALSOURCE", C.D3DRENDERSTATE_SPECULARMATERIALSOURCE, 2],
        ["EMISSIVEMATERIALSOURCE", C.D3DRENDERSTATE_EMISSIVEMATERIALSOURCE, 0],
        ["COLORVERTEX", C.D3DRENDERSTATE_COLORVERTEX, 1],
        ["LOCALVIEWER", C.D3DRENDERSTATE_LOCALVIEWER, 1],
        ["POINTSIZE", C.D3DRENDERSTATE_POINTSIZE, F1_0],
        ["POINTSIZE_MIN", C.D3DRENDERSTATE_POINTSIZE_MIN, F1_0],
        ["POINTSIZE_MAX", C.D3DRENDERSTATE_POINTSIZE_MAX, 0x46000000],
        ["POINTSCALE_A", C.D3DRENDERSTATE_POINTSCALE_A, F1_0],
        ["COLORWRITEENABLE", 168, 0xf],
        ["BLENDOP", 171, 1],
        ["STENCILMASK", C.D3DRENDERSTATE_STENCILMASK, 0xff],
        ["STENCILWRITEMASK", C.D3DRENDERSTATE_STENCILWRITEMASK, 0xff],
        ["STENCILENABLE", C.D3DRENDERSTATE_STENCILENABLE, 0],
        ["STENCILFAIL", C.D3DRENDERSTATE_STENCILFAIL, C.D3DSTENCILOP_KEEP],
        ["STENCILZFAIL", C.D3DRENDERSTATE_STENCILZFAIL, C.D3DSTENCILOP_KEEP],
        ["STENCILPASS", C.D3DRENDERSTATE_STENCILPASS, C.D3DSTENCILOP_KEEP],
        ["STENCILFUNC", C.D3DRENDERSTATE_STENCILFUNC, C.D3DCMP_ALWAYS],
        ["STENCILREF", C.D3DRENDERSTATE_STENCILREF, 0],
    ])("%s = %i", (_name, state, expected) => {
        expect(rs[state]! >>> 0).toBe(expected >>> 0);
    });
});

describe("D3D8 default texture-stage states (createD3D8DefaultTextureStates)", () => {
    const ts = createD3D8DefaultTextureStates();

    test("stage 0: MODULATE texture*diffuse, alpha = SELECTARG1(texture)", () => {
        expect(ts[0 * 32 + C.D3DTSS_COLOROP]).toBe(C.D3DTOP_MODULATE);
        expect(ts[0 * 32 + C.D3DTSS_COLORARG1]).toBe(C.D3DTA_TEXTURE);
        expect(ts[0 * 32 + C.D3DTSS_COLORARG2]).toBe(C.D3DTA_DIFFUSE);
        expect(ts[0 * 32 + C.D3DTSS_ALPHAOP]).toBe(C.D3DTOP_SELECTARG1);
        expect(ts[0 * 32 + C.D3DTSS_ALPHAARG1]).toBe(C.D3DTA_TEXTURE);
        expect(ts[0 * 32 + C.D3DTSS_ALPHAARG2]).toBe(C.D3DTA_DIFFUSE);
    });

    for (let stage = 0; stage < 8; stage++) {
        test(`stage ${stage}: WRAP address, POINT filter, no mip filter, TEXCOORDINDEX=stage`, () => {
            const o = stage * 32;
            expect(ts[o + C.D3DTSS_ADDRESSU]).toBe(C.D3DTADDRESS_WRAP);
            expect(ts[o + C.D3DTSS_ADDRESSV]).toBe(C.D3DTADDRESS_WRAP);
            expect(ts[o + C.D3DTSS_TEXCOORDINDEX]).toBe(stage);
        });
    }

    test("stages 1..7 default COLOROP/ALPHAOP to DISABLE (stage 0 does not)", () => {
        expect(ts[0 * 32 + C.D3DTSS_COLOROP]).not.toBe(C.D3DTOP_DISABLE);
        for (let stage = 1; stage < 8; stage++) {
            const o = stage * 32;
            expect(ts[o + C.D3DTSS_COLOROP]).toBe(C.D3DTOP_DISABLE);
            expect(ts[o + C.D3DTSS_ALPHAOP]).toBe(C.D3DTOP_DISABLE);
        }
    });
});

// ---------------------------------------------------------------------------------------------
// D3D9 state tracker (backends/webgpu/d3d9/d3d9-state-tracker.ts) — render states only; TSS and
// sampler states live on D3D9Device itself (Map-defaulted at the read site, tested below).
// ---------------------------------------------------------------------------------------------

describe("D3D9 default render states (D3D9StateTracker.seedRenderStateDefaults)", () => {
    function tracker(): D3D9StateTracker { return new D3D9StateTracker(new StreamBindingTable()); }

    test.each([
        ["ZENABLE", D3DRS.ZENABLE, 1],
        ["ZWRITEENABLE", D3DRS.ZWRITEENABLE, 1],
        ["ZFUNC", D3DRS.ZFUNC, C.D3DCMP_LESSEQUAL],
        ["FILLMODE", D3DRS.FILLMODE, C.D3DFILL_SOLID],
        ["SHADEMODE", D3DRS.SHADEMODE, C.D3DSHADE_GOURAUD],
        ["ALPHAFUNC", D3DRS.ALPHAFUNC, C.D3DCMP_ALWAYS],
        ["SRCBLEND", D3DRS.SRCBLEND, C.D3DBLEND_ONE],
        ["DESTBLEND", D3DRS.DESTBLEND, C.D3DBLEND_ZERO],
        ["CULLMODE", D3DRS.CULLMODE, C.D3DCULL_CCW],
        ["FOGEND", D3DRS.FOGEND, F1_0],
        ["FOGDENSITY", D3DRS.FOGDENSITY, F1_0],
        ["LIGHTING", D3DRS.LIGHTING, 1], // D3D9 tracker does NOT share the D3D7/D3D8 deviation
        ["COLORVERTEX", D3DRS.COLORVERTEX, 1],
        ["LOCALVIEWER", D3DRS.LOCALVIEWER, 1],
        ["DIFFUSEMATERIALSOURCE", D3DRS.DIFFUSEMATERIALSOURCE, 1],
        ["SPECULARMATERIALSOURCE", D3DRS.SPECULARMATERIALSOURCE, 2],
        ["POINTSIZE", D3DRS.POINTSIZE, F1_0],
        ["POINTSIZE_MIN", D3DRS.POINTSIZE_MIN, F1_0],
        ["POINTSIZE_MAX", D3DRS.POINTSIZE_MAX, 0x46000000],
        ["POINTSCALE_A", D3DRS.POINTSCALE_A, F1_0],
        ["MULTISAMPLEANTIALIAS", D3DRS.MULTISAMPLEANTIALIAS, 1],
        ["MULTISAMPLEMASK", D3DRS.MULTISAMPLEMASK, 0xffffffff],
        ["ANTIALIASEDLINEENABLE", D3DRS.ANTIALIASEDLINEENABLE, 0],
        ["COLORWRITEENABLE", D3DRS.COLORWRITEENABLE, 0xf],
        ["COLORWRITEENABLE1", D3DRS.COLORWRITEENABLE1, 0xf],
        ["COLORWRITEENABLE2", D3DRS.COLORWRITEENABLE2, 0xf],
        ["COLORWRITEENABLE3", D3DRS.COLORWRITEENABLE3, 0xf],
        ["BLENDOP", D3DRS.BLENDOP, 1],
        ["SRCBLENDALPHA", D3DRS.SRCBLENDALPHA, C.D3DBLEND_ONE],
        ["DESTBLENDALPHA", D3DRS.DESTBLENDALPHA, C.D3DBLEND_ZERO],
        ["BLENDOPALPHA", D3DRS.BLENDOPALPHA, 1],
        ["TEXTUREFACTOR", D3DRS.TEXTUREFACTOR, 0xffffffff],
        ["STENCILFAIL", D3DRS.STENCILFAIL, C.D3DSTENCILOP_KEEP],
        ["STENCILZFAIL", D3DRS.STENCILZFAIL, C.D3DSTENCILOP_KEEP],
        ["STENCILPASS", D3DRS.STENCILPASS, C.D3DSTENCILOP_KEEP],
        ["STENCILFUNC", D3DRS.STENCILFUNC, C.D3DCMP_ALWAYS],
        ["STENCILMASK", D3DRS.STENCILMASK, 0xffffffff],
        ["STENCILWRITEMASK", D3DRS.STENCILWRITEMASK, 0xffffffff],
        ["CCW_STENCILFAIL", D3DRS.CCW_STENCILFAIL, C.D3DSTENCILOP_KEEP],
        ["CCW_STENCILZFAIL", D3DRS.CCW_STENCILZFAIL, C.D3DSTENCILOP_KEEP],
        ["CCW_STENCILPASS", D3DRS.CCW_STENCILPASS, C.D3DSTENCILOP_KEEP],
        ["CCW_STENCILFUNC", D3DRS.CCW_STENCILFUNC, C.D3DCMP_ALWAYS],
    ])("%s = %i", (_name, state, expected) => {
        expect(tracker().getRenderState(state) >>> 0).toBe(expected >>> 0);
    });

    test("survives reset() — Reset() must restore every default, not just the ones a title touched", () => {
        const t = tracker();
        t.setRenderState(D3DRS.LIGHTING, 0);
        t.setRenderState(D3DRS.CULLMODE, C.D3DCULL_NONE);
        t.reset();
        expect(t.getRenderState(D3DRS.LIGHTING)).toBe(1);
        expect(t.getRenderState(D3DRS.CULLMODE)).toBe(C.D3DCULL_CCW);
    });
});

// ---------------------------------------------------------------------------------------------
// D3D9 device: GetTextureStageState / GetSamplerState observable defaults for an UNSET slot.
// D3D9Device itself needs a live WebGPU/guest-memory context to construct, so these two default
// tables are pinned as the pure, exported functions the device's getters delegate to.
// ---------------------------------------------------------------------------------------------

describe("D3D9 GetSamplerState default for an unset slot (d3d9SamplerStateDefault)", () => {
    const D3DSAMP_ADDRESSU = 1, D3DSAMP_ADDRESSV = 2, D3DSAMP_ADDRESSW = 3, D3DSAMP_BORDERCOLOR = 4;
    const D3DSAMP_MAGFILTER = 5, D3DSAMP_MINFILTER = 6, D3DSAMP_MIPFILTER = 7;
    const D3DSAMP_MIPMAPLODBIAS = 8, D3DSAMP_MAXMIPLEVEL = 9, D3DSAMP_MAXANISOTROPY = 10;
    const D3DSAMP_SRGBTEXTURE = 11;
    const D3DTADDRESS_WRAP = 1, D3DTEXF_POINT = 1;

    test.each([
        ["ADDRESSU", D3DSAMP_ADDRESSU, D3DTADDRESS_WRAP],
        ["ADDRESSV", D3DSAMP_ADDRESSV, D3DTADDRESS_WRAP],
        ["ADDRESSW", D3DSAMP_ADDRESSW, D3DTADDRESS_WRAP],
        ["MAGFILTER", D3DSAMP_MAGFILTER, D3DTEXF_POINT],
        ["MINFILTER", D3DSAMP_MINFILTER, D3DTEXF_POINT],
        ["MIPFILTER", D3DSAMP_MIPFILTER, 0], // D3DTEXF_NONE
        ["MAXANISOTROPY", D3DSAMP_MAXANISOTROPY, 1], // NOT 0 — 0 anisotropy is not representable
        ["BORDERCOLOR", D3DSAMP_BORDERCOLOR, 0],
        ["MIPMAPLODBIAS", D3DSAMP_MIPMAPLODBIAS, 0],
        ["MAXMIPLEVEL", D3DSAMP_MAXMIPLEVEL, 0],
        ["SRGBTEXTURE", D3DSAMP_SRGBTEXTURE, 0],
    ])("%s = %i", (_name, type, expected) => {
        expect(d3d9SamplerStateDefault(type)).toBe(expected);
    });
});

describe("D3D9 GetTextureStageState default for an unset slot (d3d9TextureStageStateDefault)", () => {
    const D3DTSS_COLOROP = 1, D3DTSS_COLORARG1 = 2, D3DTSS_COLORARG2 = 3, D3DTSS_ALPHAOP = 4;
    const D3DTSS_ALPHAARG1 = 5, D3DTSS_ALPHAARG2 = 6, D3DTSS_TEXCOORDINDEX = 11;
    const D3DTSS_COLORARG0 = 26, D3DTSS_ALPHAARG0 = 27, D3DTSS_RESULTARG = 28;
    const D3DTA_CURRENT = 1, D3DTA_TEXTURE = 2;
    const D3DTOP_DISABLE = 1, D3DTOP_SELECTARG1 = 2, D3DTOP_MODULATE = 4;

    test("stage 0 defaults to MODULATE/SELECTARG1 (texture args, CURRENT for arg2/arg0/result)", () => {
        expect(d3d9TextureStageStateDefault(0, D3DTSS_COLOROP)).toBe(D3DTOP_MODULATE);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_COLORARG1)).toBe(D3DTA_TEXTURE);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_COLORARG2)).toBe(D3DTA_CURRENT);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_ALPHAOP)).toBe(D3DTOP_SELECTARG1);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_ALPHAARG1)).toBe(D3DTA_TEXTURE);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_ALPHAARG2)).toBe(D3DTA_CURRENT);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_COLORARG0)).toBe(D3DTA_CURRENT);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_ALPHAARG0)).toBe(D3DTA_CURRENT);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_RESULTARG)).toBe(D3DTA_CURRENT);
        expect(d3d9TextureStageStateDefault(0, D3DTSS_TEXCOORDINDEX)).toBe(0);
    });

    for (let stage = 1; stage < 8; stage++) {
        test(`stage ${stage} defaults COLOROP/ALPHAOP to DISABLE, TEXCOORDINDEX to its own index`, () => {
            expect(d3d9TextureStageStateDefault(stage, D3DTSS_COLOROP)).toBe(D3DTOP_DISABLE);
            expect(d3d9TextureStageStateDefault(stage, D3DTSS_ALPHAOP)).toBe(D3DTOP_DISABLE);
            expect(d3d9TextureStageStateDefault(stage, D3DTSS_TEXCOORDINDEX)).toBe(stage);
        });
    }
});
