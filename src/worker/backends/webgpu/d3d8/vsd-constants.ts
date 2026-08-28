/**
 * D3DVSD vertex-shader-declaration token constants (Direct3D 8 d3d8types.h ABI).
 */

export const D3DVSD_TOKEN_NOP = 0;
export const D3DVSD_TOKEN_STREAM = 1;
export const D3DVSD_TOKEN_STREAMDATA = 2;
export const D3DVSD_TOKEN_TESSELLATOR = 3;
export const D3DVSD_TOKEN_CONSTMEM = 4;
export const D3DVSD_TOKEN_EXT = 5;
export const D3DVSD_TOKEN_END = 7;

export const D3DVSD_TOKENTYPESHIFT = 29;
export const D3DVSD_TOKENTYPEMASK = 7 << D3DVSD_TOKENTYPESHIFT;

export const D3DVSD_STREAMNUMBERSHIFT = 0;
export const D3DVSD_STREAMNUMBERMASK = 0xf << D3DVSD_STREAMNUMBERSHIFT;

export const D3DVSD_STREAMTESSSHIFT = 28;
export const D3DVSD_STREAMTESSMASK = 1 << D3DVSD_STREAMTESSSHIFT;

/** Max vertex streams a D3D8 device exposes (caps.MaxStreams). */
export const D3D8_MAX_STREAMS = 16;

export const D3DVSD_DATALOADTYPESHIFT = 28;
export const D3DVSD_DATALOADTYPEMASK = 1 << D3DVSD_DATALOADTYPESHIFT;

export const D3DVSD_DATATYPESHIFT = 16;
export const D3DVSD_DATATYPEMASK = 0xf << D3DVSD_DATATYPESHIFT;

export const D3DVSD_SKIPCOUNTSHIFT = 16;
export const D3DVSD_SKIPCOUNTMASK = 0xf << D3DVSD_SKIPCOUNTSHIFT;

export const D3DVSD_VERTEXREGSHIFT = 0;
export const D3DVSD_VERTEXREGMASK = 0x1f << D3DVSD_VERTEXREGSHIFT;

/** D3DVSD_CONSTMEM token fields (d3d8types.h): D3DVSD_CONST(ConstantAddress, Count) =
 *  MAKETOKENTYPE(CONSTMEM) | (Count << CONSTCOUNTSHIFT) | ConstantAddress. Each of the
 *  `Count` constants is 4 DWORDs (a vec4) immediately following the token in the stream. */
export const D3DVSD_CONSTADDRESSSHIFT = 0;
export const D3DVSD_CONSTADDRESSMASK = 0x7f << D3DVSD_CONSTADDRESSSHIFT;
export const D3DVSD_CONSTCOUNTSHIFT = 25;
export const D3DVSD_CONSTCOUNTMASK = 0xf << D3DVSD_CONSTCOUNTSHIFT;

export const D3DVSD_END = 0xffffffff;
export const D3DVSD_NOP = 0x00000000;

/** D3DVSDE_* vertex shader register types */
export const D3DVSDE_POSITION = 0;
export const D3DVSDE_BLENDWEIGHT = 1;
export const D3DVSDE_BLENDINDICES = 2;
export const D3DVSDE_NORMAL = 3;
export const D3DVSDE_PSIZE = 4;
export const D3DVSDE_DIFFUSE = 5;
export const D3DVSDE_SPECULAR = 6;
export const D3DVSDE_TEXCOORD0 = 7;
export const D3DVSDE_TEXCOORD7 = 14;
/** v15/v16 — dxvk d3d8_shader.cpp D3D8_VERTEX_INPUT_REGISTERS maps these to a SECOND
 *  position/normal stream (D3DDECLUSAGE_POSITION/NORMAL, usageIndex 1), used by
 *  N-Patch / continuous-tessellation content, not a distinct D3DVSDE_* usage of their own. */
export const D3DVSDE_POSITION2 = 15;
export const D3DVSDE_NORMAL2 = 16;

/** D3DVSDT_* data types (0-based; matches D3DDECLTYPE_FLOAT1..SHORT4) */
export const D3DVSDT_FLOAT1 = 0x00;
export const D3DVSDT_FLOAT2 = 0x01;
export const D3DVSDT_FLOAT3 = 0x02;
export const D3DVSDT_FLOAT4 = 0x03;
export const D3DVSDT_D3DCOLOR = 0x04;
export const D3DVSDT_UBYTE4 = 0x05;
export const D3DVSDT_SHORT2 = 0x06;
export const D3DVSDT_SHORT4 = 0x07;

/** Macros from d3d8types.h — used in tests and guest decl replay. */
export function D3DVSD_MAKETOKENTYPE(tokenType: number): number {
    return ((tokenType << D3DVSD_TOKENTYPESHIFT) & D3DVSD_TOKENTYPEMASK) >>> 0;
}

export function D3DVSD_STREAM(streamNumber: number): number {
    return (D3DVSD_MAKETOKENTYPE(D3DVSD_TOKEN_STREAM) | streamNumber) >>> 0;
}

export function D3DVSD_REG(vertexRegister: number, type: number): number {
    return (
        D3DVSD_MAKETOKENTYPE(D3DVSD_TOKEN_STREAMDATA) |
        (type << D3DVSD_DATATYPESHIFT) |
        (vertexRegister & (D3DVSD_VERTEXREGMASK >>> D3DVSD_VERTEXREGSHIFT))
    ) >>> 0;
}

export function D3DVSD_SKIP(dwordCount: number): number {
    return (
        D3DVSD_MAKETOKENTYPE(D3DVSD_TOKEN_STREAMDATA) |
        D3DVSD_DATALOADTYPEMASK |
        ((dwordCount & 0xf) << D3DVSD_SKIPCOUNTSHIFT)
    ) >>> 0;
}

/** Advertised shader caps (faithful D3DCAPS8 for vs_1_1 / ps_1_4 hardware) */
export const D3D8_VS_VERSION = 0xfffe0101; // D3DVS_VERSION(1, 1)
export const D3D8_PS_VERSION = 0xffff0104; // D3DPS_VERSION(1, 4)
export const D3D8_MAX_VS_CONST = 96;
export const D3D8_MAX_PS_CONST = 8;

/** Internal codegen bank sizes (larger than advertised caps) */
export const D3D8_VS_CONST_BANK = 256;
export const D3D8_PS_CONST_BANK = 224;
