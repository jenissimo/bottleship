/**
 * D3D8 shader object registry — DWORD handles, decl storage, bytecode compile.
 */

import { Logger, LogCategory } from "../../../core/logger";
import {
    compileVertexShader,
    compilePixelShader,
    CompiledVs,
    CompiledPs,
    RawVertexElement,
} from "../d3d9/shader";
import { parseVsdDeclaration } from "./vsd-parser";
import {
    D3D8_MAX_PS_CONST,
    D3D8_MAX_VS_CONST,
    D3D8_PS_CONST_BANK,
    D3D8_VS_CONST_BANK,
    D3D8_PS_VERSION,
} from "./vsd-constants";

const D3DERR_INVALIDCALL = 0x8876086c;

/** D3DRENDERSTATE_* indices (d3dtypes.h) — local to avoid ddraw/constants import cycle. */
const RS_CULLMODE = 22;
const RS_ZENABLE = 7;
const RS_ZWRITEENABLE = 14;

export interface D3D8VsObject {
    guestHandle: number;
    decl: RawVertexElement[];
    declStride: number;
    /** Per-stream declaration strides (index = stream number; 0 = unused stream). */
    streamStrides: number[];
    rawDecl: Uint32Array;
    bytecode: Uint32Array | null;
    compiled: CompiledVs | null;
}

export interface D3D8PsObject {
    guestHandle: number;
    bytecode: Uint32Array;
    compiled: CompiledPs;
}

export class D3D8ShaderRegistry {
    private vsObjects = new Map<number, D3D8VsObject>();
    private psObjects = new Map<number, D3D8PsObject>();
    private nextId = 1;

    activeVsHandle = 0;
    activePsHandle = 0;

    readonly vsConstants = new Float32Array(D3D8_VS_CONST_BANK * 4);
    readonly psConstants = new Float32Array(D3D8_PS_CONST_BANK * 4);
    private readonly vsConstantBits = new Uint32Array(this.vsConstants.buffer);
    private readonly psConstantBits = new Uint32Array(this.psConstants.buffer);
    vsConstantsVersion = 0;
    psConstantsVersion = 0;

    private allocHandle(): number {
        const id = this.nextId++;
        return (id << 1) | 1;
    }

    readShaderTokens(bytecodePtr: number, mem: Uint8Array): Uint32Array {
        if (!bytecodePtr) return new Uint32Array(0);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const tokens = new Uint32Array(256);
        let count = 0;
        for (let i = 0; i < 256; i++) {
            const addr = bytecodePtr + i * 4;
            if (addr + 4 > mem.byteLength) break;
            const token = view.getUint32(addr, true);
            tokens[count++] = token;
            if ((token & 0xffff) === 0xffff) break;
        }
        return tokens.subarray(0, count);
    }

    private validateVsVersion(tokens: Uint32Array): boolean {
        if (tokens.length === 0) return false;
        const ver = tokens[0] >>> 0;
        const tag = (ver >>> 16) & 0xffff;
        if (tag !== 0xfffe) return false;
        const major = (ver >> 8) & 0xff;
        const minor = ver & 0xff;
        return major === 1 && minor <= 1;
    }

    private validatePsVersion(tokens: Uint32Array): boolean {
        if (tokens.length === 0) return false;
        const ver = tokens[0] >>> 0;
        const major = (ver >> 8) & 0xff;
        const minor = ver & 0xff;
        if (major !== 1) return false;
        return minor <= 4 && ver <= D3D8_PS_VERSION;
    }

    createVertexShader(
        pDecl: number,
        pFunction: number,
        mem: Uint8Array,
    ): { hr: number; handle: number } {
        if (!pDecl) return { hr: D3DERR_INVALIDCALL, handle: 0 };
        try {
            const parsed = parseVsdDeclaration(mem, pDecl);
            let compiled: CompiledVs | null = null;
            let bytecode: Uint32Array | null = null;

            if (pFunction !== 0) {
                bytecode = this.readShaderTokens(pFunction, mem);
                if (!this.validateVsVersion(bytecode)) {
                    return { hr: D3DERR_INVALIDCALL, handle: 0 };
                }
                compiled = compileVertexShader(bytecode);
            }

            const handle = this.allocHandle();
            this.vsObjects.set(handle, {
                guestHandle: handle,
                decl: parsed.elements,
                declStride: parsed.stride,
                streamStrides: parsed.streamStrides,
                rawDecl: parsed.rawTokens,
                bytecode,
                compiled,
            });
            Logger.log(LogCategory.SYSTEM,
                `D3D8 CreateVertexShader handle=0x${handle.toString(16)} decl=${parsed.elements.length} streams=[${parsed.streamStrides.join(",")}] bytecode=${compiled ? "yes" : "decl-only"}`);
            return { hr: 0, handle };
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `D3D8 CreateVertexShader failed: ${e}`);
            return { hr: D3DERR_INVALIDCALL, handle: 0 };
        }
    }

    deleteVertexShader(handle: number): number {
        const h = handle >>> 0;
        if (!this.vsObjects.has(h)) return D3DERR_INVALIDCALL;
        this.vsObjects.delete(h);
        if (this.activeVsHandle === h) this.activeVsHandle = 0;
        return 0;
    }

    createPixelShader(pFunction: number, mem: Uint8Array): { hr: number; handle: number } {
        if (!pFunction) return { hr: D3DERR_INVALIDCALL, handle: 0 };
        try {
            const bytecode = this.readShaderTokens(pFunction, mem);
            if (!this.validatePsVersion(bytecode)) {
                return { hr: D3DERR_INVALIDCALL, handle: 0 };
            }
            const compiled = compilePixelShader(bytecode);
            const handle = this.allocHandle();
            this.psObjects.set(handle, { guestHandle: handle, bytecode, compiled });
            Logger.log(LogCategory.SYSTEM,
                `D3D8 CreatePixelShader ps_${compiled.prog.major}_${compiled.prog.minor} handle=0x${handle.toString(16)}`);
            return { hr: 0, handle };
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `D3D8 CreatePixelShader failed: ${e}`);
            return { hr: D3DERR_INVALIDCALL, handle: 0 };
        }
    }

    deletePixelShader(handle: number): number {
        const h = handle >>> 0;
        if (!this.psObjects.has(h)) return D3DERR_INVALIDCALL;
        this.psObjects.delete(h);
        if (this.activePsHandle === h) this.activePsHandle = 0;
        return 0;
    }

    getVsObject(handle: number): D3D8VsObject | undefined {
        return this.vsObjects.get(handle >>> 0);
    }

    getPsObject(handle: number): D3D8PsObject | undefined {
        return this.psObjects.get(handle >>> 0);
    }

    getActiveVs(): D3D8VsObject | null {
        if (this.activeVsHandle === 0) return null;
        return this.vsObjects.get(this.activeVsHandle) ?? null;
    }

    getActivePs(): D3D8PsObject | null {
        if (this.activePsHandle === 0) return null;
        return this.psObjects.get(this.activePsHandle) ?? null;
    }

    isProgrammable(): boolean {
        const vs = this.getActiveVs();
        return vs !== null && vs.compiled !== null;
    }

    isDeclOnly(): boolean {
        const vs = this.getActiveVs();
        return vs !== null && vs.compiled === null;
    }

    private copyConstantsFromGuest(targetBits: Uint32Array, start: number, count: number, dataPtr: number, mem: Uint8Array): number {
        const reg = start >>> 0;
        const n = count >>> 0;
        const floatCount = n * 4;
        const byteEnd = dataPtr + floatCount * 4;
        if (dataPtr < 0 || byteEnd > mem.byteLength) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const baseIdx = reg * 4;
        let changed = false;
        for (let i = 0; i < floatCount; i++) {
            const bits = view.getUint32(dataPtr + i * 4, true);
            const dst = baseIdx + i;
            if (targetBits[dst] !== bits) {
                targetBits[dst] = bits;
                changed = true;
            }
        }
        return changed ? 1 : 0;
    }

    setVertexShaderConstant(start: number, dataPtr: number, count: number, mem: Uint8Array): number {
        const reg = start >>> 0;
        const n = count >>> 0;
        if (reg + n > D3D8_MAX_VS_CONST) return D3DERR_INVALIDCALL;
        const result = this.copyConstantsFromGuest(this.vsConstantBits, reg, n, dataPtr, mem);
        if (result === D3DERR_INVALIDCALL) return result;
        if (result !== 0) this.vsConstantsVersion++;
        return 0;
    }

    /** State-block replay: write constants from a captured Float32Array (floats, start=register). */
    setVertexShaderConstantFromArray(start: number, data: Float32Array): number {
        const baseIdx = (start >>> 0) * 4;
        if (baseIdx + data.length > this.vsConstants.length) return D3DERR_INVALIDCALL;
        this.vsConstants.set(data, baseIdx);
        this.vsConstantsVersion++;
        return 0;
    }

    setPixelShaderConstantFromArray(start: number, data: Float32Array): number {
        const baseIdx = (start >>> 0) * 4;
        if (baseIdx + data.length > this.psConstants.length) return D3DERR_INVALIDCALL;
        this.psConstants.set(data, baseIdx);
        this.psConstantsVersion++;
        return 0;
    }

    getVertexShaderConstant(start: number, dataPtr: number, count: number, mem: Uint8Array): number {
        const reg = start >>> 0;
        const n = count >>> 0;
        if (reg + n > D3D8_MAX_VS_CONST) return D3DERR_INVALIDCALL;
        const floatCount = n * 4;
        const byteEnd = dataPtr + floatCount * 4;
        if (dataPtr < 0 || byteEnd > mem.byteLength) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const baseIdx = reg * 4;
        for (let i = 0; i < floatCount; i++) {
            view.setFloat32(dataPtr + i * 4, this.vsConstants[baseIdx + i], true);
        }
        return 0;
    }

    setPixelShaderConstant(start: number, dataPtr: number, count: number, mem: Uint8Array): number {
        const reg = start >>> 0;
        const n = count >>> 0;
        if (reg + n > D3D8_MAX_PS_CONST) return D3DERR_INVALIDCALL;
        const result = this.copyConstantsFromGuest(this.psConstantBits, reg, n, dataPtr, mem);
        if (result === D3DERR_INVALIDCALL) return result;
        if (result !== 0) this.psConstantsVersion++;
        return 0;
    }

    getPixelShaderConstant(start: number, dataPtr: number, count: number, mem: Uint8Array): number {
        const reg = start >>> 0;
        const n = count >>> 0;
        if (reg + n > D3D8_MAX_PS_CONST) return D3DERR_INVALIDCALL;
        const floatCount = n * 4;
        const byteEnd = dataPtr + floatCount * 4;
        if (dataPtr < 0 || byteEnd > mem.byteLength) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const baseIdx = reg * 4;
        for (let i = 0; i < floatCount; i++) {
            view.setFloat32(dataPtr + i * 4, this.psConstants[baseIdx + i], true);
        }
        return 0;
    }

    copyDeclarationToGuest(handle: number, pData: number, mem: Uint8Array): number {
        const obj = this.vsObjects.get(handle >>> 0);
        if (!obj || !pData) return D3DERR_INVALIDCALL;
        const bytes = obj.rawDecl.length * 4;
        if (pData + bytes > mem.byteLength) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < obj.rawDecl.length; i++) {
            view.setUint32(pData + i * 4, obj.rawDecl[i], true);
        }
        return 0;
    }

    copyFunctionToGuest(bytecode: Uint32Array | null, pData: number, mem: Uint8Array): number {
        if (!bytecode || !pData) return D3DERR_INVALIDCALL;
        const bytes = bytecode.length * 4;
        if (pData + bytes > mem.byteLength) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < bytecode.length; i++) {
            view.setUint32(pData + i * 4, bytecode[i], true);
        }
        return 0;
    }
}

/** Exported for unit tests — build pipeline cache key from D3D8 render state. */
export function buildD3D8PipelineKey(
    renderStates: Int32Array,
    vsHandle: number,
    psHandle: number,
    declStride: number,
    stride: number | string | null,
    topology: string,
    forceCullNone: boolean,
    blendKey: string,
    alphaTestKey: string,
    cubeMask: number,
    /** Fixed-function cascade shape for a draw with no pixel shader (stage count + projected
     *  mask). Appended last so purgeShaderPipelines' leading-field parse stays valid. */
    ffpKey = "",
): string {
    const cullMode = renderStates[RS_CULLMODE] ?? 0;
    const zEnable = renderStates[RS_ZENABLE] ?? 1;
    const zWrite = renderStates[RS_ZWRITEENABLE] ?? 1;
    const stateBits = (
        ((cullMode & 0xff) << 16) |
        ((zEnable !== 0 ? 1 : 0) << 25) |
        ((zWrite !== 0 ? 1 : 0) << 26)
    ) >>> 0;
    return `${vsHandle}:${psHandle}:${declStride}:${stride}:${stateBits}:${topology}:${forceCullNone ? 1 : 0}:${blendKey}:${alphaTestKey}:cm${cubeMask}${ffpKey ? ":" + ffpKey : ""}`;
}
