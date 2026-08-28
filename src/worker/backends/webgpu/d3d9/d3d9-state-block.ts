/**
 * D3D9 state block recording, capture, and replay.
 *
 * IDirect3DDevice9::BeginStateBlock/EndStateBlock record Set* calls made between
 * Begin and End. IDirect3DStateBlock9::Apply replays them; Capture refreshes values.
 */

import { D3D9Device } from "./d3d9-device";
import {
    resolveVertexDeclComPtr,
    resolveVertexShaderComPtr,
    resolvePixelShaderComPtr,
} from "./d3d9-com-objects";
import { KeyedStateBlockRecorder } from "../shared/state-block-recorder";
import { MAX_VERTEX_STREAMS } from "../shared/vertex-streams";
import { d3d9WasmArena, isWasmBlocksEnabled } from "./d3d9-wasm-arena";
import { addComRef, releaseComRef } from "../../../modules/d3d9/com-refs";
import {
    D3D9_PIXEL_TEXTURE_STAGE_COUNT,
    D3D9_VERTEX_TEXTURE_SAMPLER_BASE,
    D3D9_VERTEX_TEXTURE_SAMPLER_COUNT,
} from "./d3d9-state-tracker";

export const D3DSBT_ALL = 1;
export const D3DSBT_PIXELSTATE = 2;
export const D3DSBT_VERTEXSTATE = 3;

export type StateBlockEntry =
    | { op: "renderState"; state: number; value: number }
    | { op: "textureStageState"; stage: number; type: number; value: number }
    | { op: "samplerState"; sampler: number; type: number; value: number }
    | { op: "texture"; stage: number; texPtr: number }
    | { op: "transform"; state: number; matrix: Float32Array }
    | { op: "npatchMode"; segments: number }
    | { op: "material"; data: Uint8Array }
    | { op: "light"; index: number; data: Uint8Array }
    | { op: "lightEnable"; index: number; enable: number }
    | { op: "clipPlane"; index: number; plane: Float32Array }
    | { op: "fvf"; value: number }
    | { op: "vertexShader"; handle: number }
    | { op: "pixelShader"; handle: number }
    | { op: "vertexDeclaration"; handle: number }
    | { op: "vertexShaderConstantF"; start: number; data: Float32Array }
    | { op: "vertexShaderConstantI"; start: number; data: Int32Array }
    | { op: "vertexShaderConstantB"; start: number; data: Int32Array }
    | { op: "pixelShaderConstantF"; start: number; data: Float32Array }
    | { op: "pixelShaderConstantI"; start: number; data: Int32Array }
    | { op: "pixelShaderConstantB"; start: number; data: Int32Array }
    | { op: "streamSource"; stream: number; vbPtr: number; offset: number; stride: number }
    | { op: "streamSourceFreq"; stream: number; setting: number }
    | { op: "indices"; ibPtr: number }
    | { op: "viewport"; x: number; y: number; width: number; height: number; minZ: number; maxZ: number }
    | { op: "scissorRect"; left: number; top: number; right: number; bottom: number };

/** D3D9's CapturePixelRenderStates list from DXVK d3d9_stateblock.cpp. The API's
 * 256-slot render-state storage is not itself the state-block membership list. */
export const D3D9_PIXEL_RENDER_STATES = [
    7, 8, 9, 14, 15, 16, 19, 20, 23, 24, 25, 26, 36, 37, 38, 27, 195,
    52, 53, 54, 55, 56, 57, 58, 59, 60,
    128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143,
    168, 171, 174, 175, 176, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194,
    206, 207, 208, 209,
] as const;

/** D3D9's CaptureVertexRenderStates list (DXVK d3d9_stateblock.cpp). Keep this as data so
 * membership changes are reviewable and cannot accidentally become a broad state split. */
export const D3D9_VERTEX_RENDER_STATES = [
    22, 28, 34, 35, 36, 37, 38, 48, 139, 141, 140, 136, 137, 142, 148, 147, 145, 146,
    151, 152, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 166, 167, 170, 172, 173,
    178, 179, 180, 181, 182, 183, 184, 143, 29, 9,
] as const;

function renderStateMembership(blockType: number): ReadonlySet<number> {
    if (blockType === D3DSBT_PIXELSTATE) return new Set(D3D9_PIXEL_RENDER_STATES);
    if (blockType === D3DSBT_VERTEXSTATE) return new Set(D3D9_VERTEX_RENDER_STATES);
    return new Set([...D3D9_PIXEL_RENDER_STATES, ...D3D9_VERTEX_RENDER_STATES]);
}

const D3DSAMP_DMAPOFFSET = 13;
const D3D9_PIXEL_SAMPLER_TYPES = 12;
const D3D9_FFP_TSS_TYPES = 32;

/**
 * Which blocks own the vertex-stream BINDINGS (SetStreamSource) and the index buffer.
 *
 * D3DSBT_ALL only. "Saving All Device States with a StateBlock (D3D9)" lists, on top of vertex
 * and pixel state: "For each vertex stream: a pointer to the vertex buffer, each argument from
 * IDirect3DDevice9::SetStreamSource, and the divider (if any) from SetStreamSourceFreq" and "A
 * pointer to the index buffer".
 *
 * D3DSBT_VERTEXSTATE deliberately does NOT capture transforms, material, lights, clip planes,
 * viewport, scissor, textures, or stream/index bindings. Its list is the vertex render/sampler
 * states, vertex shader/constants, stream-frequency dividers, and vertex declaration. The
 * divider is vertex state, while the binding it divides is not.
 *
 */
export function stateBlockCapturesStreamBindings(blockType: number): boolean {
    return blockType === D3DSBT_ALL;
}

/**
 * The device surface the stream/index capture and replay needs. D3D9Device satisfies it; naming
 * it keeps this logic testable without a GPU and documents that stream state is read through the
 * device's accessor over the single StreamBindingTable, never a second copy.
 */
export interface StreamStateDevice {
    getStreamBinding(streamNumber: number): { ptr: number; offset: number; stride: number } | null;
    setStreamSource(streamNumber: number, vbPtr: number, offset: number, stride: number): number;
    getBoundIndexBufferPtr(): number;
    setIndices(ibPtr: number): number;
}

/**
 * Append one entry per stream slot — INCLUDING the slots nothing is bound to. A slot left out
 * is a slot Apply cannot unbind, so a buffer bound after the capture would survive it and feed
 * the next draw geometry from another object.
 */
export function captureStreamBindingEntries(device: StreamStateDevice, entries: StateBlockEntry[]): void {
    for (let stream = 0; stream < MAX_VERTEX_STREAMS; stream++) {
        const b = device.getStreamBinding(stream);
        if (!b) break;
        entries.push({ op: "streamSource", stream, vbPtr: b.ptr >>> 0, offset: b.offset >>> 0, stride: b.stride >>> 0 });
    }
    entries.push({ op: "indices", ibPtr: device.getBoundIndexBufferPtr() >>> 0 });
}

export interface VertexTextureStateDevice {
    getAllSamplerStates(): Array<{ sampler: number; type: number; value: number }>;
    getSamplerState?(sampler: number, type: number): number;
    getBoundTexturePtr(stage: number): number;
}

/** Capture only the vertex sampler state in the D3D9 vertex-state list. Texture bindings are
 * ALL-only; vertex-texture sampler state is the single D3DSAMP_DMAPOFFSET entry. */
export function captureVertexTextureEntries(device: VertexTextureStateDevice, entries: StateBlockEntry[]): void {
    for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
        const sampler = D3D9_VERTEX_TEXTURE_SAMPLER_BASE + n;
        const value = device.getSamplerState
            ? device.getSamplerState(sampler, D3DSAMP_DMAPOFFSET)
            : device.getAllSamplerStates().find(s => s.sampler === sampler && s.type === D3DSAMP_DMAPOFFSET)?.value ?? 0;
        entries.push({ op: "samplerState", sampler, type: D3DSAMP_DMAPOFFSET, value });
    }
}

function capturePixelSamplerEntries(device: VertexTextureStateDevice, entries: StateBlockEntry[]): void {
    for (let sampler = 0; sampler < D3D9_PIXEL_TEXTURE_STAGE_COUNT; sampler++) {
        for (let type = 1; type <= D3D9_PIXEL_SAMPLER_TYPES; type++) {
            const value = device.getSamplerState
                ? device.getSamplerState(sampler, type)
                : device.getAllSamplerStates().find(s => s.sampler === sampler && s.type === type)?.value ?? 0;
            entries.push({ op: "samplerState", sampler, type, value });
        }
    }
}

function captureAllTextureEntries(device: VertexTextureStateDevice, entries: StateBlockEntry[]): void {
    // D3D9's texture bindings are an ALL-only group. Include NULL slots so Apply can unbind a
    // texture installed after capture; the vertex-texture slots are sparse in the public ABI.
    for (let stage = 0; stage < D3D9_PIXEL_TEXTURE_STAGE_COUNT; stage++) {
        entries.push({ op: "texture", stage, texPtr: device.getBoundTexturePtr(stage) });
    }
    for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
        const stage = D3D9_VERTEX_TEXTURE_SAMPLER_BASE + n;
        entries.push({ op: "texture", stage, texPtr: device.getBoundTexturePtr(stage) });
    }
}

export interface D3D9StateBlockData {
    devicePtr: number;
    blockType: number;
    entries: StateBlockEntry[];
    /**
     * True when every entry is representable in the WASM arena mirror (see
     * classifyStateBlockCoverage). Computed once at End/CreateStateBlock; blocks with
     * beyond-mirror ops (transforms, NPatch mode, TSS, materials, lights, clip planes, stage>0
     * samplers, stream/index bindings) stay on the JS apply/capture path.
     */
    coverable?: boolean;
    /** Arena block-slot index when this block lives in the d3d9-webgpu WASM arena
     *  (tryAttachWasmBlockSlot). undefined = JS entry path. */
    wasmSlot?: number;
    /** The handle-shaped entries (texture/vs/ps/decl/fvf — COM-pointer values only JS
     *  can resolve) of a wasm-slotted block; refreshed/applied on the JS path while the
     *  bulk (renderState/sampler0/shader-constant) set lives in the slot. */
    handleEntries?: StateBlockEntry[];
    /** COM pointers retained by texture/shader/declaration entries while this block lives. */
    retainedRefs?: number[];
}

/**
 * Arena-coverability classification: a block can live in the d3d9-webgpu WASM arena iff
 * every entry maps onto the mirrored state set (renderStates[256], stage-0 sampler,
 * stage 0-7 textures, vs/ps/decl/fvf handles, VS/PS float constants with a bounded
 * number of ranges). Everything else must fall back to the JS entry replay.
 */
export const STATE_BLOCK_MAX_CONST_RANGES = 8;

export interface StateBlockCoverage {
    coverable: boolean;
    opCounts: Record<string, number>;
    vsConstRanges: number;
    psConstRanges: number;
}

export function classifyStateBlockCoverage(entries: StateBlockEntry[]): StateBlockCoverage {
    const opCounts: Record<string, number> = {};
    let coverable = true;
    let vsConstRanges = 0;
    let psConstRanges = 0;
    for (const entry of entries) {
        opCounts[entry.op] = (opCounts[entry.op] ?? 0) + 1;
        switch (entry.op) {
            case "renderState":
            case "fvf":
            case "vertexShader":
            case "pixelShader":
            case "vertexDeclaration":
                break;
            case "samplerState":
                if (entry.sampler !== 0) coverable = false;
                break;
            case "texture":
                if (entry.stage < 0 || entry.stage > 7) coverable = false;
                break;
            case "vertexShaderConstantF":
                vsConstRanges++;
                break;
            case "pixelShaderConstantF":
                psConstRanges++;
                break;
            default:
                coverable = false;
        }
    }
    if (vsConstRanges > STATE_BLOCK_MAX_CONST_RANGES || psConstRanges > STATE_BLOCK_MAX_CONST_RANGES) {
        coverable = false;
    }
    return { coverable, opCounts, vsConstRanges, psConstRanges };
}

function entryKey(entry: StateBlockEntry): string {
    switch (entry.op) {
        case "renderState":
            return `rs:${entry.state}`;
        case "textureStageState":
            return `tss:${entry.stage}:${entry.type}`;
        case "samplerState":
            return `ss:${entry.sampler}:${entry.type}`;
        case "texture":
            return `tex:${entry.stage}`;
        case "transform":
            return `xf:${entry.state}`;
        case "npatchMode":
            return "npatch";
        case "material":
            return "mat";
        case "light":
            return `light:${entry.index}`;
        case "lightEnable":
            return `le:${entry.index}`;
        case "clipPlane":
            return `clip:${entry.index}`;
        case "fvf":
            return "fvf";
        case "vertexShader":
            return "vs";
        case "pixelShader":
            return "ps";
        case "vertexDeclaration":
            return "vd";
        case "vertexShaderConstantF":
            return `vsc:${entry.start}:${entry.data.length}`;
        case "vertexShaderConstantI":
            return `vsci:${entry.start}:${entry.data.length}`;
        case "vertexShaderConstantB":
            return `vscb:${entry.start}:${entry.data.length}`;
        case "pixelShaderConstantF":
            return `psc:${entry.start}:${entry.data.length}`;
        case "pixelShaderConstantI":
            return `psci:${entry.start}:${entry.data.length}`;
        case "pixelShaderConstantB":
            return `pscb:${entry.start}:${entry.data.length}`;
        case "streamSource":
            return `stream:${entry.stream}`;
        case "streamSourceFreq":
            return `streamFreq:${entry.stream}`;
        case "indices":
            return "ib";
        case "viewport":
            return "viewport";
        case "scissorRect":
            return "scissorRect";
    }
}

export class D3D9StateBlockRecorder extends KeyedStateBlockRecorder<StateBlockEntry> {
    constructor() {
        super(entryKey);
    }
}

function retainedEntryPtr(entry: StateBlockEntry): number {
    switch (entry.op) {
        case "texture":
            return entry.texPtr >>> 0;
        case "vertexShader":
        case "pixelShader":
        case "vertexDeclaration":
            return entry.handle >>> 0;
        case "streamSource":
            return entry.vbPtr >>> 0;
        case "indices":
            return entry.ibPtr >>> 0;
        default:
            return 0;
    }
}

function activeHandleEntries(data: D3D9StateBlockData): StateBlockEntry[] {
    return data.wasmSlot !== undefined ? (data.handleEntries ?? []) : data.entries;
}

export function releaseStateBlockRefs(data: D3D9StateBlockData): void {
    for (const ptr of data.retainedRefs ?? []) {
        releaseComRef(ptr);
    }
    data.retainedRefs = [];
}

export function retainStateBlockRefs(data: D3D9StateBlockData): void {
    releaseStateBlockRefs(data);
    const retained: number[] = [];
    for (const entry of activeHandleEntries(data)) {
        const ptr = retainedEntryPtr(entry);
        if (ptr !== 0 && addComRef(ptr) !== undefined) retained.push(ptr);
    }
    data.retainedRefs = retained;
}

export function disposeStateBlockData(data: D3D9StateBlockData): void {
    releaseStateBlockRefs(data);
    if (data.wasmSlot !== undefined) {
        d3d9WasmArena.releaseBlockSlot(data.wasmSlot);
        data.wasmSlot = undefined;
    }
    data.handleEntries = undefined;
}

/**
 * Move a coverable block into an arena slot (Block A): write its recorded masks,
 * const ranges, and initial values through the slot views, and split off the
 * handle-shaped entries for the JS path. No-op (block stays on the JS entry path)
 * when the arena/kill-switch/pool says no or an entry turns out unrepresentable —
 * in that case coverable is downgraded so the perf counters tell the truth.
 *
 * Const-pool packing contract with d3d9_block_apply/capture: ALL vs ranges' data
 * first (in range order), then all ps ranges' — both sides derive each range's pool
 * offset from that cumulative order, nothing is stored twice.
 */
export function tryAttachWasmBlockSlot(data: D3D9StateBlockData): void {
    if (data.coverable !== true || data.entries.length === 0) return;
    if (!isWasmBlocksEnabled() || !d3d9WasmArena.isInitialized()) return;
    const slot = d3d9WasmArena.allocBlockSlot();
    if (slot < 0) return;

    const v = d3d9WasmArena.blockSlotViews(slot);
    v.maskRs.fill(0);
    v.maskSamp[0] = 0;
    v.vsRanges.fill(0);
    v.psRanges.fill(0);

    const handleEntries: StateBlockEntry[] = [];
    const vsConst: Array<{ start: number; data: Float32Array }> = [];
    const psConst: Array<{ start: number; data: Float32Array }> = [];
    let ok = true;
    for (const e of data.entries) {
        switch (e.op) {
            case "renderState":
                if (e.state < 0 || e.state >= 256) { ok = false; break; }
                v.maskRs[e.state >>> 5]! |= 1 << (e.state & 31);
                v.rsValues[e.state] = e.value | 0;
                break;
            case "samplerState":
                if (e.sampler !== 0 || e.type < 0 || e.type >= 16) { ok = false; break; }
                v.maskSamp[0]! |= 1 << e.type;
                v.sampValues[e.type] = e.value | 0;
                break;
            case "vertexShaderConstantF":
                if (e.start < 0 || e.start * 4 + e.data.length > 256 * 4) { ok = false; break; }
                vsConst.push({ start: e.start, data: e.data });
                break;
            case "pixelShaderConstantF":
                if (e.start < 0 || e.start * 4 + e.data.length > 224 * 4) { ok = false; break; }
                psConst.push({ start: e.start, data: e.data });
                break;
            case "texture":
            case "vertexShader":
            case "pixelShader":
            case "vertexDeclaration":
            case "fvf":
                handleEntries.push(e);
                break;
            default:
                ok = false; // classification should have caught this
        }
        if (!ok) break;
    }

    const totalFloats = [...vsConst, ...psConst].reduce((n, r) => n + r.data.length, 0);
    if (ok && (vsConst.length > 4 || psConst.length > 4 || totalFloats > 512)) ok = false;

    if (!ok) {
        d3d9WasmArena.releaseBlockSlot(slot);
        data.coverable = false;
        return;
    }

    let pool = 0;
    for (const [ranges, list] of [[v.vsRanges, vsConst], [v.psRanges, psConst]] as const) {
        for (let i = 0; i < list.length; i++) {
            ranges[i * 2] = list[i]!.start;
            ranges[i * 2 + 1] = list[i]!.data.length;
            v.constPool.set(list[i]!.data, pool);
            pool += list[i]!.data.length;
        }
    }

    data.wasmSlot = slot;
    data.handleEntries = handleEntries;
}

export type StreamStateEntry = Extract<StateBlockEntry, { op: "streamSource" } | { op: "indices" }>;

/** Replay one captured binding. vbPtr/ibPtr 0 is the captured "nothing bound" and must be
 *  replayed as such — the setters treat it as an unbind, not as "leave alone". */
export function applyStreamStateEntry(device: StreamStateDevice, entry: StreamStateEntry): void {
    if (entry.op === "streamSource") {
        device.setStreamSource(entry.stream, entry.vbPtr, entry.offset, entry.stride);
    } else {
        device.setIndices(entry.ibPtr);
    }
}

/** Re-read one captured binding from the live device. Refreshed IN PLACE: Capture runs per
 *  frame over every slot, and a replacement entry object per slot is churn with no reason. */
export function refreshStreamStateEntry(device: StreamStateDevice, entry: StreamStateEntry): void {
    if (entry.op === "streamSource") {
        const b = device.getStreamBinding(entry.stream);
        if (!b) return;
        entry.vbPtr = b.ptr >>> 0;
        entry.offset = b.offset >>> 0;
        entry.stride = b.stride >>> 0;
    } else {
        entry.ibPtr = device.getBoundIndexBufferPtr() >>> 0;
    }
}

export function applyStateBlockEntries(device: D3D9Device, entries: StateBlockEntry[], mem: Uint8Array): void {
    for (const entry of entries) {
        switch (entry.op) {
            case "renderState":
                device.setRenderState(entry.state, entry.value);
                break;
            case "textureStageState":
                device.setTextureStageState(entry.stage, entry.type, entry.value);
                break;
            case "samplerState":
                device.setSamplerState(entry.sampler, entry.type, entry.value);
                break;
            case "texture":
                device.setTexture(entry.stage, entry.texPtr);
                break;
            case "transform":
                device.setTransform(entry.state, entry.matrix);
                break;
            case "npatchMode":
                device.setNPatchMode(entry.segments);
                break;
            case "material":
                device.setMaterial(entry.data);
                break;
            case "light":
                device.setLight(entry.index, entry.data);
                break;
            case "lightEnable":
                device.lightEnable(entry.index, entry.enable);
                break;
            case "clipPlane":
                device.setClipPlane(entry.index, entry.plane);
                break;
            case "fvf":
                device.setFVF(entry.value);
                break;
            case "vertexShader": {
                const meta = entry.handle !== 0 ? resolveVertexShaderComPtr(entry.handle) : null;
                device.setVertexShader(meta?.internalHandle ?? 0, entry.handle);
                break;
            }
            case "pixelShader": {
                const meta = entry.handle !== 0 ? resolvePixelShaderComPtr(entry.handle) : null;
                device.setPixelShader(meta?.internalHandle ?? 0, entry.handle);
                break;
            }
            case "vertexDeclaration": {
                const meta = entry.handle !== 0 ? resolveVertexDeclComPtr(entry.handle) : null;
                device.setVertexDeclaration(meta?.internalHandle ?? 0, entry.handle);
                break;
            }
            case "vertexShaderConstantF":
                device.setVertexShaderConstantFFromArray(entry.start, entry.data, mem);
                break;
            case "vertexShaderConstantI":
                device.setVertexShaderConstantIFromArray(entry.start, entry.data);
                break;
            case "vertexShaderConstantB":
                device.setVertexShaderConstantBFromArray(entry.start, entry.data);
                break;
            case "pixelShaderConstantF":
                device.setPixelShaderConstantFFromArray(entry.start, entry.data, mem);
                break;
            case "pixelShaderConstantI":
                device.setPixelShaderConstantIFromArray(entry.start, entry.data);
                break;
            case "pixelShaderConstantB":
                device.setPixelShaderConstantBFromArray(entry.start, entry.data);
                break;
            case "streamSourceFreq":
                device.setStreamSourceFreq(entry.stream, entry.setting);
                break;
            case "streamSource":
            case "indices":
                applyStreamStateEntry(device, entry);
                break;
            case "viewport":
                device.setViewportValues(entry);
                break;
            case "scissorRect":
                device.setScissorRect(entry.left, entry.top, entry.right, entry.bottom);
                break;
        }
    }
}

export function refreshCapturedEntries(device: D3D9Device, entries: StateBlockEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        switch (entry.op) {
            case "renderState":
                entries[i] = { op: "renderState", state: entry.state, value: device.getRenderState(entry.state) };
                break;
            case "textureStageState":
                entries[i] = {
                    op: "textureStageState",
                    stage: entry.stage,
                    type: entry.type,
                    value: device.getTextureStageState(entry.stage, entry.type),
                };
                break;
            case "samplerState":
                entries[i] = {
                    op: "samplerState",
                    sampler: entry.sampler,
                    type: entry.type,
                    value: device.getSamplerState(entry.sampler, entry.type),
                };
                break;
            case "texture":
                entries[i] = { op: "texture", stage: entry.stage, texPtr: device.getBoundTexturePtr(entry.stage) };
                break;
            case "transform": {
                const matrix = device.getTransform(entry.state);
                if (matrix) {
                    entries[i] = { op: "transform", state: entry.state, matrix: new Float32Array(matrix) };
                }
                break;
            }
            case "npatchMode":
                entries[i] = { op: "npatchMode", segments: device.getNPatchMode() };
                break;
            case "material":
                entries[i] = { op: "material", data: new Uint8Array(device.getMaterial()) };
                break;
            case "light": {
                const light = device.getLight(entry.index);
                if (light) {
                    entries[i] = { op: "light", index: entry.index, data: new Uint8Array(light) };
                }
                break;
            }
            case "lightEnable":
                entries[i] = { op: "lightEnable", index: entry.index, enable: device.getLightEnable(entry.index) };
                break;
            case "clipPlane": {
                const plane = device.getClipPlane(entry.index);
                if (plane) {
                    entries[i] = { op: "clipPlane", index: entry.index, plane: new Float32Array(plane) };
                }
                break;
            }
            case "fvf":
                entries[i] = { op: "fvf", value: device.getFVF() };
                break;
            case "vertexShader":
                entries[i] = { op: "vertexShader", handle: device.getVertexShaderComPtr() };
                break;
            case "pixelShader":
                entries[i] = { op: "pixelShader", handle: device.getPixelShaderComPtr() };
                break;
            case "vertexDeclaration":
                entries[i] = { op: "vertexDeclaration", handle: device.getVertexDeclarationComPtr() };
                break;
            case "vertexShaderConstantF": {
                const data = device.getVertexShaderConstants(entry.start, entry.data.length / 4);
                entries[i] = { op: "vertexShaderConstantF", start: entry.start, data };
                break;
            }
            case "vertexShaderConstantI": {
                const data = device.getVertexShaderConstantsI(entry.start, entry.data.length / 4);
                entries[i] = { op: "vertexShaderConstantI", start: entry.start, data };
                break;
            }
            case "vertexShaderConstantB": {
                const data = device.getVertexShaderConstantsB(entry.start, entry.data.length);
                entries[i] = { op: "vertexShaderConstantB", start: entry.start, data };
                break;
            }
            case "pixelShaderConstantF": {
                const data = device.getPixelShaderConstants(entry.start, entry.data.length / 4);
                entries[i] = { op: "pixelShaderConstantF", start: entry.start, data };
                break;
            }
            case "pixelShaderConstantI": {
                const data = device.getPixelShaderConstantsI(entry.start, entry.data.length / 4);
                entries[i] = { op: "pixelShaderConstantI", start: entry.start, data };
                break;
            }
            case "pixelShaderConstantB": {
                const data = device.getPixelShaderConstantsB(entry.start, entry.data.length);
                entries[i] = { op: "pixelShaderConstantB", start: entry.start, data };
                break;
            }
            case "streamSourceFreq": {
                const setting = device.getStreamSourceFreq(entry.stream);
                if (setting !== null) entries[i] = { op: "streamSourceFreq", stream: entry.stream, setting };
                break;
            }
            case "streamSource":
            case "indices":
                refreshStreamStateEntry(device, entry);
                break;
            case "viewport": {
                const viewport = device.getViewport();
                entries[i] = { op: "viewport", ...viewport };
                break;
            }
            case "scissorRect": {
                const rect = device.getScissorRect();
                entries[i] = { op: "scissorRect", ...rect };
                break;
            }
        }
    }
}

export function captureStateToEntries(device: D3D9Device, blockType: number): StateBlockEntry[] {
    const entries: StateBlockEntry[] = [];

    const includePixel = blockType === D3DSBT_ALL || blockType === D3DSBT_PIXELSTATE;
    const includeVertex = blockType === D3DSBT_ALL || blockType === D3DSBT_VERTEXSTATE;

    if (includePixel) {
        const renderStates = renderStateMembership(blockType);
        for (const { state, value } of device.getAllRenderStates()) {
            if (renderStates.has(state)) entries.push({ op: "renderState", state, value });
        }
        for (const { stage, type, value } of device.getAllTextureStageStates()) {
            entries.push({ op: "textureStageState", stage, type, value });
        }
        capturePixelSamplerEntries(device, entries);
        // A state block captures the selected shader even when it is NULL: a
        // block made while fixed-function rendering is active must be able to
        // unbind a shader installed after the capture.
        entries.push({ op: "pixelShader", handle: device.getPixelShaderComPtr() });
        const psConsts = device.getAllPixelShaderConstants();
        entries.push({ op: "pixelShaderConstantF", start: 0, data: psConsts });
        const psInts = device.getAllPixelShaderConstantsI();
        entries.push({ op: "pixelShaderConstantI", start: 0, data: psInts });
        const psBools = device.getAllPixelShaderConstantsB();
        entries.push({ op: "pixelShaderConstantB", start: 0, data: psBools });
    }

    if (includeVertex) {
        captureVertexTextureEntries(device, entries);
        if (blockType === D3DSBT_VERTEXSTATE) {
            const renderStates = renderStateMembership(blockType);
            for (const { state, value } of device.getAllRenderStates()) {
                if (renderStates.has(state)) entries.push({ op: "renderState", state, value });
            }
        }
        entries.push({ op: "vertexShader", handle: device.getVertexShaderComPtr() });
        // FVF and the vertex declaration share one slot in D3D9: whichever was set last wins.
        // Capture BOTH, FVF first, so Apply ends on the declaration — a block captured with a
        // declaration current still restores it. Without the FVF entry a block applied under a
        // different FVF leaves the new stride against the old everything-else.
        entries.push({ op: "fvf", value: device.getFVF() });
        entries.push({ op: "vertexDeclaration", handle: device.getVertexDeclarationComPtr() });
        // D3D9's documented vertex-state list includes NPatchMode.
        entries.push({ op: "npatchMode", segments: device.getNPatchMode() });
        const vsConsts = device.getAllVertexShaderConstants();
        entries.push({ op: "vertexShaderConstantF", start: 0, data: vsConsts });
        const vsInts = device.getAllVertexShaderConstantsI();
        entries.push({ op: "vertexShaderConstantI", start: 0, data: vsInts });
        const vsBools = device.getAllVertexShaderConstantsB();
        entries.push({ op: "vertexShaderConstantB", start: 0, data: vsBools });
        // The dividers are vertex state (see stateBlockCapturesStreamBindings) — captured by
        // VERTEXSTATE and ALL, unlike the bindings they divide.
        for (let stream = 0; stream < MAX_VERTEX_STREAMS; stream++) {
            const setting = device.getStreamSourceFreq(stream);
            if (setting !== null) entries.push({ op: "streamSourceFreq", stream, setting });
        }
    }

    if (stateBlockCapturesStreamBindings(blockType)) {
        captureStreamBindingEntries(device, entries);
    }

    if (blockType === D3DSBT_ALL) {
        captureAllTextureEntries(device, entries);
        for (const { state, matrix } of device.getAllTransforms()) {
            entries.push({ op: "transform", state, matrix: new Float32Array(matrix) });
        }
        entries.push({ op: "material", data: new Uint8Array(device.getMaterial()) });
        for (const { index, data } of device.getAllLights()) {
            entries.push({ op: "light", index, data: new Uint8Array(data) });
        }
        for (const { index, enable } of device.getAllLightEnables()) {
            entries.push({ op: "lightEnable", index, enable });
        }
        for (const { index, plane } of device.getAllClipPlanes()) {
            entries.push({ op: "clipPlane", index, plane: new Float32Array(plane) });
        }
        const viewport = device.getViewport();
        entries.push({ op: "viewport", ...viewport });
        entries.push({ op: "scissorRect", ...device.getScissorRect() });
    }

    return entries;
}
