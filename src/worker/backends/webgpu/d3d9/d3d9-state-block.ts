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
import { d3d9WasmArena, isWasmBlocksEnabled } from "./d3d9-wasm-arena";
import { addComRef, releaseComRef } from "../../../modules/d3d9/shared-state";

export const D3DSBT_ALL = 1;
export const D3DSBT_PIXELSTATE = 2;
export const D3DSBT_VERTEXSTATE = 3;

export type StateBlockEntry =
    | { op: "renderState"; state: number; value: number }
    | { op: "textureStageState"; stage: number; type: number; value: number }
    | { op: "samplerState"; sampler: number; type: number; value: number }
    | { op: "texture"; stage: number; texPtr: number }
    | { op: "transform"; state: number; matrix: Float32Array }
    | { op: "material"; data: Uint8Array }
    | { op: "light"; index: number; data: Uint8Array }
    | { op: "lightEnable"; index: number; enable: number }
    | { op: "clipPlane"; index: number; plane: Float32Array }
    | { op: "fvf"; value: number }
    | { op: "vertexShader"; handle: number }
    | { op: "pixelShader"; handle: number }
    | { op: "vertexDeclaration"; handle: number }
    | { op: "vertexShaderConstantF"; start: number; data: Float32Array }
    | { op: "pixelShaderConstantF"; start: number; data: Float32Array };

export interface D3D9StateBlockData {
    devicePtr: number;
    blockType: number;
    entries: StateBlockEntry[];
    /**
     * True when every entry is representable in the WASM arena mirror (see
     * classifyStateBlockCoverage). Computed once at End/CreateStateBlock; blocks with
     * beyond-mirror ops (transforms, TSS, materials, lights, clip planes, stage>0
     * samplers) stay on the JS apply/capture path.
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
        case "pixelShaderConstantF":
            return `psc:${entry.start}:${entry.data.length}`;
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
            case "pixelShaderConstantF":
                device.setPixelShaderConstantFFromArray(entry.start, entry.data, mem);
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
            case "pixelShaderConstantF": {
                const data = device.getPixelShaderConstants(entry.start, entry.data.length / 4);
                entries[i] = { op: "pixelShaderConstantF", start: entry.start, data };
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
        for (const { state, value } of device.getAllRenderStates()) {
            entries.push({ op: "renderState", state, value });
        }
        for (const { stage, type, value } of device.getAllTextureStageStates()) {
            entries.push({ op: "textureStageState", stage, type, value });
        }
        for (const { sampler, type, value } of device.getAllSamplerStates()) {
            entries.push({ op: "samplerState", sampler, type, value });
        }
        for (let stage = 0; stage < 8; stage++) {
            const texPtr = device.getBoundTexturePtr(stage);
            if (texPtr !== 0) {
                entries.push({ op: "texture", stage, texPtr });
            }
        }
        entries.push({ op: "pixelShader", handle: device.getPixelShaderComPtr() });
        const psConsts = device.getAllPixelShaderConstants();
        if (psConsts.length > 0) {
            entries.push({ op: "pixelShaderConstantF", start: 0, data: psConsts });
        }
    }

    if (includeVertex) {
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
        const fvf = device.getFVF();
        if (fvf !== 0) {
            entries.push({ op: "fvf", value: fvf });
        }
        const vs = device.getVertexShaderComPtr();
        if (vs !== 0) {
            entries.push({ op: "vertexShader", handle: vs });
        }
        const vd = device.getVertexDeclarationComPtr();
        if (vd !== 0) {
            entries.push({ op: "vertexDeclaration", handle: vd });
        }
        const vsConsts = device.getAllVertexShaderConstants();
        if (vsConsts.length > 0) {
            entries.push({ op: "vertexShaderConstantF", start: 0, data: vsConsts });
        }
    }

    return entries;
}
