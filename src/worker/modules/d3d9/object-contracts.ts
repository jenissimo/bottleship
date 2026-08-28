/**
 * COM identity contracts for D3D9 objects.
 *
 * QueryInterface is not a generic "return this pointer" operation: accepting
 * an unrelated IID gives the caller a pointer whose vtable has the wrong
 * shape, which is substantially worse than E_NOINTERFACE.  Keep the compact
 * GUID-key tables here so the state/resource handlers share one identity rule.
 */

export const E_NOINTERFACE = 0x80004002;
export const E_POINTER = 0x80004003;

export const IID_IUNKNOWN = '0000000000000000c000000000000046';
export const IID_IDIRECT3D9 = 'cacbbd81d4646d42ae8dad0147f4275c';
export const IID_IDIRECT3D9EX = '41721702fc690c408ff193a44df6861d';
export const IID_IDIRECT3DDEVICE9 = '963b22d07abffd4392bda43b0d82b9eb';
/** IDirect3DDevice9Ex {B18B10CE-2649-405A-870F-95F777D4313A}. */
export const IID_IDIRECT3DDEVICE9EX = 'ce108bb149265a40870f95f777d4313a';
export const IID_IDIRECT3DRESOURCE9 = '5dc0ee057d8f6243b999d1baf357c704';
export const IID_IDIRECT3DBASETEXTURE9 = '7ea80c583c1d544d991db7d3e3c298ce';
export const IID_IDIRECT3DVERTEXBUFFER9 = 'b5b14bb670fdf64dbf9119d0a12455e3';
export const IID_IDIRECT3DINDEXBUFFER9 = '5ed69d7cf7d32945acee785830acde35';
export const IID_IDIRECT3DTEXTURE9 = '2712c385e53d004f9b3af11ac38c18b5';
export const IID_IDIRECT3DCUBETEXTURE9 = '812ff3ff53d93a47922393d652aba93f';
/** IDirect3DSurface9 {0CFBAF3A-9FF6-429A-99B3-A2796AF8B89B} in guest GUID byte order. */
export const IID_IDIRECT3DSURFACE9 = '3aaffb0cf69f9a4299b3a2796af8b89b';
/** IDirect3DVolume9 {24F416E6-1F67-4AA7-B88E-D33F6F3128A1} in guest GUID byte order. */
export const IID_IDIRECT3DVOLUME9 = 'e616f424671fa74ab88ed33f6f3128a1';
export const IID_IDIRECT3DSTATEBLOCK9 = 'e54f7cb00d31a84ba23c4f0f206f218b';
export const IID_IDIRECT3DVERTEXDECLARATION9 = '9cc513ddfa369840a8fbc7ed39dc8546';
export const IID_IDIRECT3DVERTEXSHADER9 = '7e55c5ef656213468a9443857889eb36';
export const IID_IDIRECT3DPIXELSHADER9 = 'dcdb3b6d025b1544b852ce5e8bccb289';

const acceptedByPrefix: Readonly<Record<string, ReadonlySet<string>>> = {
    IDirect3D9: new Set([IID_IUNKNOWN, IID_IDIRECT3D9]),
    IDirect3DDevice9: new Set([IID_IUNKNOWN, IID_IDIRECT3DDEVICE9]),
    IDirect3DVertexBuffer9: new Set([IID_IUNKNOWN, IID_IDIRECT3DRESOURCE9, IID_IDIRECT3DVERTEXBUFFER9]),
    IDirect3DIndexBuffer9: new Set([IID_IUNKNOWN, IID_IDIRECT3DRESOURCE9, IID_IDIRECT3DINDEXBUFFER9]),
    IDirect3DTexture9: new Set([IID_IUNKNOWN, IID_IDIRECT3DRESOURCE9, IID_IDIRECT3DBASETEXTURE9, IID_IDIRECT3DTEXTURE9]),
    IDirect3DCubeTexture9: new Set([IID_IUNKNOWN, IID_IDIRECT3DRESOURCE9, IID_IDIRECT3DBASETEXTURE9, IID_IDIRECT3DCUBETEXTURE9]),
    // IDirect3DSurface9 derives from IDirect3DResource9.  The inherited methods
    // are part of its vtable, so QI must expose the resource identity as well.
    IDirect3DSurface9: new Set([IID_IUNKNOWN, IID_IDIRECT3DRESOURCE9, IID_IDIRECT3DSURFACE9]),
    IDirect3DStateBlock9: new Set([IID_IUNKNOWN, IID_IDIRECT3DSTATEBLOCK9]),
    IDirect3DVertexDeclaration9: new Set([IID_IUNKNOWN, IID_IDIRECT3DVERTEXDECLARATION9]),
    IDirect3DVertexShader9: new Set([IID_IUNKNOWN, IID_IDIRECT3DVERTEXSHADER9]),
    IDirect3DPixelShader9: new Set([IID_IUNKNOWN, IID_IDIRECT3DPIXELSHADER9]),
};

/** Read a GUID in the guest's Windows byte order. */
export function readD3D9GuidKey(memory: Uint8Array, ptr: number): string | null {
    const address = ptr >>> 0;
    if (!address || address + 16 > memory.length) return null;
    let key = '';
    for (let i = 0; i < 16; i++) key += memory[address + i]!.toString(16).padStart(2, '0');
    return key;
}

export function d3d9ObjectSupportsIid(prefix: string, memory: Uint8Array, riid: number): boolean {
    const accepted = acceptedByPrefix[prefix];
    if (!accepted) return false;
    const key = readD3D9GuidKey(memory, riid);
    return key !== null && accepted.has(key);
}
