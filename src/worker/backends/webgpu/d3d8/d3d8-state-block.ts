/**
 * D3D8 state block recording, capture, and replay.
 *
 * D3D8 state blocks are DWORD tokens (not COM objects like D3D9):
 *   BeginStateBlock  — start journaling Set* calls (they are NOT applied while recording)
 *   EndStateBlock    — stop journaling, return a token
 *   ApplyStateBlock  — replay the journaled state onto the device
 *   CaptureStateBlock— refresh the journaled entries from the CURRENT device state
 *   CreateStateBlock — snapshot a predefined state group (ALL/PIXELSTATE/VERTEXSTATE)
 *   DeleteStateBlock — free the token
 *
 * Shares the keyed-dedup recorder with the D3D9 backend (state-block-recorder.ts);
 * the entry set differs because D3D8 binds resources by DWORD handle/COM pointer and
 * parses material/light structs at the thunk boundary.
 */

import type { D3D8DeviceAdapter } from "./d3d8-device-adapter";
import type { Viewport } from "../ddraw/types";
import type { D3DMaterial7Data, D3DLight7Data } from "../../../modules/ddraw/d3d/types";

export const D3DSBT_ALL = 1;
export const D3DSBT_PIXELSTATE = 2;
export const D3DSBT_VERTEXSTATE = 3;

export type D3D8StateBlockEntry =
    | { op: "renderState"; state: number; value: number }
    | { op: "textureStageState"; stage: number; type: number; value: number }
    | { op: "texture"; stage: number; texPtr: number }
    | { op: "transform"; state: number; matrix: Float32Array }
    | { op: "viewport"; vp: Viewport }
    | { op: "material"; mat: D3DMaterial7Data }
    | { op: "light"; index: number; light: D3DLight7Data }
    | { op: "lightEnable"; index: number; enable: boolean }
    | { op: "clipPlane"; index: number; plane: Float32Array }
    | { op: "vertexShader"; token: number }   // SetVertexShader DWORD: FVF (bit0=0) or handle (bit0=1)
    | { op: "pixelShader"; handle: number }
    | { op: "vsConstant"; start: number; data: Float32Array }
    | { op: "psConstant"; start: number; data: Float32Array }
    | { op: "streamSource"; stream: number; vb: number; stride: number }
    | { op: "indices"; ib: number; baseVertex: number };

export function d3d8EntryKey(entry: D3D8StateBlockEntry): string {
    switch (entry.op) {
        case "renderState": return `rs:${entry.state}`;
        case "textureStageState": return `tss:${entry.stage}:${entry.type}`;
        case "texture": return `tex:${entry.stage}`;
        case "transform": return `xf:${entry.state}`;
        case "viewport": return "vp";
        case "material": return "mat";
        case "light": return `light:${entry.index}`;
        case "lightEnable": return `le:${entry.index}`;
        case "clipPlane": return `clip:${entry.index}`;
        case "vertexShader": return "vs";
        case "pixelShader": return "ps";
        case "vsConstant": return `vsc:${entry.start}:${entry.data.length}`;
        case "psConstant": return `psc:${entry.start}:${entry.data.length}`;
        case "streamSource": return `stream:${entry.stream}`;
        case "indices": return "ib";
    }
}

export function applyD3D8StateBlockEntries(device: D3D8DeviceAdapter, entries: D3D8StateBlockEntry[]): void {
    for (const entry of entries) {
        switch (entry.op) {
            case "renderState":
                device.setRenderState(entry.state, entry.value);
                break;
            case "textureStageState":
                device.setTextureStageState(entry.stage, entry.type, entry.value);
                break;
            case "texture": {
                // Resolve by COM handle; a texture released since recording drops to NULL.
                const surface = entry.texPtr !== 0 ? (device.texSurfaces.get(entry.texPtr) ?? null) : null;
                device.setTexture(entry.stage, surface, surface ? entry.texPtr : 0);
                break;
            }
            case "transform":
                device.setTransform(entry.state, entry.matrix);
                break;
            case "viewport":
                device.viewport = { ...entry.vp };
                break;
            case "material":
                device.setMaterial(entry.mat);
                break;
            case "light":
                device.setLight(entry.index, entry.light);
                break;
            case "lightEnable":
                device.lightEnable(entry.index, entry.enable);
                break;
            case "clipPlane":
                device.setClipPlane(entry.index, entry.plane);
                break;
            case "vertexShader":
                if ((entry.token & 1) === 0) device.setFVF(entry.token);
                else device.setVertexShaderHandle(entry.token);
                break;
            case "pixelShader":
                device.setPixelShader(entry.handle);
                break;
            case "vsConstant":
                device.shaders.setVertexShaderConstantFromArray(entry.start, entry.data);
                break;
            case "psConstant":
                device.shaders.setPixelShaderConstantFromArray(entry.start, entry.data);
                break;
            case "streamSource":
                device.setStreamSource(entry.stream, entry.vb, entry.stride);
                break;
            case "indices":
                device.indexIB = entry.ib;
                device.baseVertexIndex = entry.baseVertex;
                break;
        }
    }
}

/** CaptureStateBlock: refresh each recorded entry's VALUE from current device state. */
export function refreshD3D8CapturedEntries(device: D3D8DeviceAdapter, entries: D3D8StateBlockEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        switch (entry.op) {
            case "renderState":
                entries[i] = { op: "renderState", state: entry.state, value: device.getRenderState(entry.state) };
                break;
            case "textureStageState":
                entries[i] = {
                    op: "textureStageState", stage: entry.stage, type: entry.type,
                    value: device.getTextureStageState(entry.stage, entry.type),
                };
                break;
            case "texture":
                entries[i] = { op: "texture", stage: entry.stage, texPtr: device.getTextureComPtr(entry.stage) };
                break;
            case "transform": {
                const m = device.getTransform(entry.state);
                if (m) entries[i] = { op: "transform", state: entry.state, matrix: new Float32Array(m) };
                break;
            }
            case "viewport":
                entries[i] = { op: "viewport", vp: { ...device.viewport } };
                break;
            case "material":
                entries[i] = { op: "material", mat: device.getMaterial() };
                break;
            case "light": {
                const light = device.getLight(entry.index);
                if (light) entries[i] = { op: "light", index: entry.index, light };
                break;
            }
            case "lightEnable":
                entries[i] = { op: "lightEnable", index: entry.index, enable: device.isLightEnabled(entry.index) };
                break;
            case "clipPlane": {
                const plane = device.getClipPlane(entry.index);
                if (plane) entries[i] = { op: "clipPlane", index: entry.index, plane: new Float32Array(plane) };
                break;
            }
            case "vertexShader":
                entries[i] = { op: "vertexShader", token: device.getActiveVertexToken() };
                break;
            case "pixelShader":
                entries[i] = { op: "pixelShader", handle: device.getPixelShaderHandle() };
                break;
            case "vsConstant": {
                const data = new Float32Array(entry.data.length);
                data.set(device.shaders.vsConstants.subarray(entry.start * 4, entry.start * 4 + data.length));
                entries[i] = { op: "vsConstant", start: entry.start, data };
                break;
            }
            case "psConstant": {
                const data = new Float32Array(entry.data.length);
                data.set(device.shaders.psConstants.subarray(entry.start * 4, entry.start * 4 + data.length));
                entries[i] = { op: "psConstant", start: entry.start, data };
                break;
            }
            case "streamSource": {
                const src = device.getStreamSource(entry.stream);
                entries[i] = { op: "streamSource", stream: entry.stream, vb: src.vb, stride: src.stride };
                break;
            }
            case "indices":
                entries[i] = { op: "indices", ib: device.indexIB, baseVertex: device.baseVertexIndex };
                break;
        }
    }
}

// Membership tables ported from wined3d's stateblock.c (pixel_states_render/texture/
// sampler, vertex_states_render/texture/sampler — dlls/wined3d/stateblock.c:104-263),
// through D3D9's identical render-state numbering (D3D8's D3DRENDERSTATETYPE shares
// values with wined3d's WINED3D_RS_* for every state D3D8 exposes; D3D9-only render
// states appear here too but a real D3D8 title never sets them, so they're inert).
//
// TSS values are D3D8's D3DTEXTURESTAGESTATETYPE numbering (sampler-constants.ts) —
// wined3d's WINED3D_TSS_* is a compacted INTERNAL index that does not match the
// guest-visible D3DTSS_* constants, and wined3d's *_states_sampler arrays cover the
// D3D9 sampler states that D3D8 still exposes as texture-stage states (ADDRESSU/V/W,
// filters, MIPMAPLODBIAS, MAXMIPLEVEL, MAXANISOTROPY, BORDERCOLOR) — both were
// hand-translated to D3D8 numbering below. D3DTSS_TEXCOORDINDEX/TEXTURETRANSFORMFLAGS
// have DUAL membership (present in both wined3d texture arrays).
const PIXEL_RENDER_STATES: readonly number[] = [
    7, 8, 9, 14, 15, 16, 19, 20, 23, 24, 25, 26, 27, 36, 37, 38, 52, 53, 54, 55, 56, 57, 58, 59, 60,
    128, 129, 130, 131, 132, 133, 134, 135, 168, 171, 174, 175, 176, 185, 186, 187, 188, 190, 191,
    192, 193, 194, 195, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209,
];

const VERTEX_RENDER_STATES: readonly number[] = [
    9, 22, 28, 29, 34, 35, 36, 37, 38, 48, 136, 137, 139, 140, 141, 142, 143, 145, 146, 147, 148,
    151, 152, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 166, 167, 170, 172, 173,
    178, 179, 180, 181, 182, 183, 184,
];

// D3DRS_SOFTWAREVERTEXPROCESSING — dxvk d3d8_state_block.cpp calls this out by name
// ("a very easy footgun for D3D8 applications") as captured ONLY by D3DSBT_ALL, not by
// either the vertex or pixel group.
const SWVP_RENDER_STATE = 153;

const PIXEL_TSS_TYPES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];
const VERTEX_TSS_TYPES: readonly number[] = [11, 24];

/**
 * CreateStateBlock: snapshot a predefined group.
 *
 * Per wined3d, D3DSBT_VERTEXSTATE/PIXELSTATE capture only the render-state/TSS
 * membership tables above (plus, for vertex, lights/vertex-shader/VS-constants; for
 * pixel, pixel-shader/PS-constants) — material, world/view/projection transforms,
 * clip planes, texture bindings, stream sources, and indices are captured ONLY by
 * D3DSBT_ALL (stateblock_savedstates_set_all vs _set_vertex/_set_pixel; dxvk's
 * D3D8StateBlock constructor sets its Textures/VertexBuffers/Indices/SWVP capture
 * flags only for Type::All). This is a well-known D3D footgun: a VERTEXSTATE block
 * does NOT snapshot the current transform.
 */
export function captureD3D8StateToEntries(device: D3D8DeviceAdapter, blockType: number): D3D8StateBlockEntry[] {
    const entries: D3D8StateBlockEntry[] = [];
    const all = blockType === D3DSBT_ALL;
    const includePixel = all || blockType === D3DSBT_PIXELSTATE;
    const includeVertex = all || blockType === D3DSBT_VERTEXSTATE;

    if (includePixel) {
        for (const state of PIXEL_RENDER_STATES) {
            entries.push({ op: "renderState", state, value: device.getRenderState(state) });
        }
        for (let stage = 0; stage < 8; stage++) {
            for (const type of PIXEL_TSS_TYPES) {
                entries.push({
                    op: "textureStageState", stage, type,
                    value: device.getTextureStageState(stage, type),
                });
            }
        }
        entries.push({ op: "pixelShader", handle: device.getPixelShaderHandle() });
        entries.push({ op: "psConstant", start: 0, data: new Float32Array(device.shaders.psConstants) });
    }

    if (includeVertex) {
        for (const state of VERTEX_RENDER_STATES) {
            entries.push({ op: "renderState", state, value: device.getRenderState(state) });
        }
        for (let stage = 0; stage < 8; stage++) {
            for (const type of VERTEX_TSS_TYPES) {
                entries.push({
                    op: "textureStageState", stage, type,
                    value: device.getTextureStageState(stage, type),
                });
            }
        }
        for (const { index, light } of device.getAllLights()) {
            entries.push({ op: "light", index, light });
        }
        for (const index of device.getEnabledLightIndices()) {
            entries.push({ op: "lightEnable", index, enable: true });
        }
        entries.push({ op: "vertexShader", token: device.getActiveVertexToken() });
        entries.push({ op: "vsConstant", start: 0, data: new Float32Array(device.shaders.vsConstants) });
    }

    if (all) {
        entries.push({ op: "renderState", state: SWVP_RENDER_STATE, value: device.getRenderState(SWVP_RENDER_STATE) });
        entries.push({ op: "material", mat: device.getMaterial() });
        for (const { state, matrix } of device.getAllTransforms()) {
            entries.push({ op: "transform", state, matrix: new Float32Array(matrix) });
        }
        for (const { index, plane } of device.getAllClipPlanes()) {
            entries.push({ op: "clipPlane", index, plane: new Float32Array(plane) });
        }
        // Slot membership, not truthiness: an Apply must be able to restore a stage/stream
        // back to NULL even if it was unbound at Capture time (dxvk:
        // m_captures.textures.setAll() / equivalent for streams — every stage/stream gets
        // an entry regardless of whether it currently holds a live pointer).
        for (let stage = 0; stage < 8; stage++) {
            entries.push({ op: "texture", stage, texPtr: device.getTextureComPtr(stage) });
        }
        for (let s = 0; s < 16; s++) {
            const src = device.getStreamSource(s);
            entries.push({ op: "streamSource", stream: s, vb: src.vb, stride: src.stride });
        }
        entries.push({ op: "viewport", vp: { ...device.viewport } });
        entries.push({ op: "indices", ib: device.indexIB, baseVertex: device.baseVertexIndex });
    }

    return entries;
}
