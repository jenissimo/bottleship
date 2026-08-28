/**
 * D3DVSD DWORD stream parser → D3D9-compatible RawVertexElement layout.
 *
 * Token encoding follows d3d8types.h: type in bits 29–31, STREAM=0x20000000|n,
 * REG=0x40000000|(type<<16)|reg, SKIP=0x50000000|(count<<16).
 *
 * Multi-stream declarations are first-class: D3DVSD_STREAM(n) opens stream n and
 * resets the running offset; each following D3DVSD_REG binds the global input
 * register v# to the current offset WITHIN that stream. An element therefore
 * belongs to a stream, while its register (v#) is the shader-visible location.
 */

import type { RawVertexElement } from "../d3d9/shader";
import { Logger, LogCategory } from "../../../core/logger";
import {
    D3DVSD_TOKEN_NOP,
    D3DVSD_TOKEN_STREAM,
    D3DVSD_TOKEN_STREAMDATA,
    D3DVSD_TOKEN_TESSELLATOR,
    D3DVSD_TOKEN_CONSTMEM,
    D3DVSD_TOKEN_EXT,
    D3DVSD_TOKEN_END,
    D3DVSD_TOKENTYPESHIFT,
    D3DVSD_DATATYPESHIFT,
    D3DVSD_SKIPCOUNTSHIFT,
    D3DVSD_VERTEXREGMASK,
    D3DVSD_DATALOADTYPEMASK,
    D3DVSD_STREAMNUMBERMASK,
    D3DVSD_STREAMTESSMASK,
    D3DVSD_END,
    D3DVSDE_DIFFUSE,
    D3DVSDE_SPECULAR,
    D3DVSDE_TEXCOORD0,
    D3DVSDE_TEXCOORD7,
    D3DVSDE_POSITION2,
    D3DVSDE_NORMAL2,
    D3DVSDT_FLOAT4,
    D3DVSDT_SHORT4,
    D3DVSD_CONSTADDRESSMASK,
    D3DVSD_CONSTCOUNTSHIFT,
    D3DVSD_CONSTCOUNTMASK,
} from "./vsd-constants";

// D3DDECLUSAGE_* values this module maps VSD registers into (matches decl-to-ffp.ts / D3D9's
// RawVertexElement.usage numbering — POSITION=0, NORMAL=3, COLOR=10, TEXCOORD=5).
const D3DDECLUSAGE_POSITION = 0;
const D3DDECLUSAGE_NORMAL = 3;

/** One D3DVSD_CONSTMEM record: `values.length / 4` vec4 constants starting at register
 *  `address` in the vertex shader constant bank (D3DVSD_CONST(addr, count) macro). */
export interface VsdConstMemDef {
    address: number;
    values: Float32Array;
}

export interface ParsedVsd {
    elements: RawVertexElement[];
    /** Stream-0 stride (legacy single-stream consumers: pipeline key, decl→FVF mapping). */
    stride: number;
    /** Per-stream computed stride (max element end), index = stream number; 0 = unused. */
    streamStrides: number[];
    rawTokens: Uint32Array;
    /** D3DVSD_CONSTMEM inline constants, correctly parsed (address/count/data) but NOT applied
     *  to the compiled shader's constant bank — see the loud per-decl log this module emits
     *  when count > 0. Exposed so a future consumer (a DEF-instruction injector in the vs.1.1
     *  compile path) doesn't have to re-parse the declaration. */
    constMemDefs: VsdConstMemDef[];
}

function tokenType(token: number): number {
    return (token >>> D3DVSD_TOKENTYPESHIFT) & 7;
}

/** Map D3DVSDE register → D3DDECLUSAGE + usageIndex */
function mapVsdRegister(reg: number): { usage: number; usageIndex: number } {
    if (reg === D3DVSDE_DIFFUSE) return { usage: 10, usageIndex: 0 };
    if (reg === D3DVSDE_SPECULAR) return { usage: 10, usageIndex: 1 };
    if (reg >= D3DVSDE_TEXCOORD0 && reg <= D3DVSDE_TEXCOORD7) {
        return { usage: 5, usageIndex: reg - D3DVSDE_TEXCOORD0 };
    }
    // v15/v16: dxvk D3D8_VERTEX_INPUT_REGISTERS maps these to a second position/normal
    // stream (usageIndex 1), not distinct usages — see vsd-constants.ts.
    if (reg === D3DVSDE_POSITION2) return { usage: D3DDECLUSAGE_POSITION, usageIndex: 1 };
    if (reg === D3DVSDE_NORMAL2) return { usage: D3DDECLUSAGE_NORMAL, usageIndex: 1 };
    return { usage: reg, usageIndex: 0 };
}

/** D3DVSDT is 0-based and matches D3DDECLTYPE for FLOAT1..SHORT4 */
function mapVsdType(vsdType: number): number {
    if (vsdType >= 0 && vsdType <= D3DVSDT_SHORT4) return vsdType;
    return D3DVSDT_FLOAT4;
}

export function declTypeSize(declType: number): number {
    switch (declType) {
        case 0: return 4;
        case 1: return 8;
        case 2: return 12;
        case 3: return 16;
        case 4: return 4;
        case 5: return 4;
        case 6: return 4;
        case 7: return 8;
        default: return 16;
    }
}

function readTokenStream(mem: Uint8Array, ptr: number, maxTokens = 256): Uint32Array {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const tokens: number[] = [];
    for (let i = 0; i < maxTokens; i++) {
        const addr = ptr + i * 4;
        if (addr + 4 > mem.byteLength) break;
        const token = view.getUint32(addr, true);
        tokens.push(token);
        if (token === D3DVSD_END) break;
    }
    return new Uint32Array(tokens);
}

/**
 * Parse a D3DVSD declaration from guest memory or a pre-captured token array.
 */
export function parseVsdDeclaration(source: Uint8Array | Uint32Array, ptr = 0): ParsedVsd {
    const tokens = source instanceof Uint32Array
        ? source
        : readTokenStream(source, ptr);

    const elements: RawVertexElement[] = [];
    const streamStrides: number[] = [];
    const constMemDefs: VsdConstMemDef[] = [];
    let stream = 0;
    let offset = 0;
    let sawStream = false;
    let skippingTessStream = false;

    // Index-based (not for-of): D3DVSD_CONSTMEM's payload is `count*4` raw DWORDs living
    // INLINE in the token stream right after the token, not further tokens — they must be
    // consumed by advancing the index, or the next iteration misparses payload data as a token.
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]! >>> 0;
        if (token === D3DVSD_END) break;

        const tt = tokenType(token);
        switch (tt) {
            case D3DVSD_TOKEN_NOP:
                continue;

            case D3DVSD_TOKEN_END:
                break;

            case D3DVSD_TOKEN_STREAM: {
                if ((token & D3DVSD_STREAMTESSMASK) !== 0) {
                    // D3DVSD_STREAMTESSS(): tessellator-generated stream — carries no
                    // VB data. Skip its REG tokens; they don't consume stream bytes.
                    Logger.warn(LogCategory.SYSTEM, "D3DVSD: tessellator stream not supported — ignoring its elements");
                    skippingTessStream = true;
                    continue;
                }
                stream = token & D3DVSD_STREAMNUMBERMASK;
                offset = 0;
                sawStream = true;
                skippingTessStream = false;
                continue;
            }

            case D3DVSD_TOKEN_STREAMDATA: {
                if (skippingTessStream) continue;
                if ((token & D3DVSD_DATALOADTYPEMASK) !== 0) {
                    const skipDwords = (token >>> D3DVSD_SKIPCOUNTSHIFT) & 0xf;
                    offset += skipDwords * 4;
                    continue;
                }
                const vsdType = (token >>> D3DVSD_DATATYPESHIFT) & 0xf;
                const vsdReg = token & D3DVSD_VERTEXREGMASK;
                const { usage, usageIndex } = mapVsdRegister(vsdReg);
                const type = mapVsdType(vsdType);
                elements.push({ stream, offset, type, usage, usageIndex, reg: vsdReg });
                const size = declTypeSize(type);
                const end = offset + size;
                if (end > (streamStrides[stream] ?? 0)) streamStrides[stream] = end;
                offset += size;
                continue;
            }

            case D3DVSD_TOKEN_CONSTMEM: {
                // D3DVSD_CONST(addr, count): count vec4s (count*4 DWORDs) follow inline.
                const address = token & D3DVSD_CONSTADDRESSMASK;
                const count = (token & D3DVSD_CONSTCOUNTMASK) >>> D3DVSD_CONSTCOUNTSHIFT;
                const dwordCount = count * 4;
                if (count > 0) {
                    const values = new Float32Array(dwordCount);
                    const dv = new DataView(tokens.buffer, tokens.byteOffset, tokens.byteLength);
                    for (let j = 0; j < dwordCount; j++) {
                        const srcIdx = i + 1 + j;
                        values[j] = srcIdx < tokens.length ? dv.getFloat32(srcIdx * 4, true) : 0;
                    }
                    constMemDefs.push({ address, values });
                    // Precisely scoped, not a routine warning: this decl actually carries
                    // inline VS constants that we parse but do not wire into the compiled
                    // shader's constant bank (see ParsedVsd.constMemDefs) — any vertex shader
                    // that relies on D3DVSD_CONSTMEM instead of SetVertexShaderConstant gets
                    // wrong/stale values in registers c[address..address+count).
                    Logger.error(
                        LogCategory.SYSTEM,
                        `D3DVSD_CONSTMEM: decl defines ${count} constant(s) at c${address} — parsed but NOT applied ` +
                        `to the shader constant bank (no DEF-instruction injection in this build)`,
                    );
                }
                i += dwordCount;
                continue;
            }

            case D3DVSD_TOKEN_TESSELLATOR:
            case D3DVSD_TOKEN_EXT:
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3DVSD: unsupported token type ${tt} in vertex declaration (0x${token.toString(16)})`,
                );
                continue;

            default:
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3DVSD: unknown token type ${tt} (0x${token.toString(16)})`,
                );
                continue;
        }
    }

    if (!sawStream && elements.length > 0) {
        Logger.warn(LogCategory.SYSTEM, "D3DVSD: stream data without preceding D3DVSD_STREAM token");
    }

    for (let i = 0; i < streamStrides.length; i++) {
        streamStrides[i] = streamStrides[i] ?? 0;
    }

    return { elements, stride: streamStrides[0] ?? 0, streamStrides, rawTokens: tokens, constMemDefs };
}
