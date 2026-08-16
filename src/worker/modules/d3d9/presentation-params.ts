/** D3DPRESENT_PARAMETERS layout shared by CreateDevice and Reset. */
export const PP_BACKBUFFER_WIDTH = 0;
export const PP_BACKBUFFER_HEIGHT = 4;
export const PP_BACKBUFFER_FORMAT = 8;
export const PP_BACKBUFFER_COUNT = 12;
export const PP_SWAP_EFFECT = 24;
export const PP_WINDOWED = 32;
export const PP_ENABLE_AUTO_DEPTHSTENCIL = 36;
export const PP_AUTO_DEPTHSTENCIL_FORMAT = 40;
export const PP_PRESENTATION_INTERVAL = 52;

export const D3DSWAPEFFECT_DISCARD = 1;
export const D3DSWAPEFFECT_FLIP = 2;
export const D3DSWAPEFFECT_COPY = 3;

/** DISCARD leaves the backbuffer obtained after Present undefined. */
export function d3d9SwapEffectDiscardsBackBuffer(rawSwapEffect: number): boolean {
    return (rawSwapEffect >>> 0) === D3DSWAPEFFECT_DISCARD;
}

/** Read the guest ABI rather than duplicating the offset at every call site. */
export function readD3d9SwapEffect(view: DataView, presentationParameters: number): number {
    return view.getUint32((presentationParameters + PP_SWAP_EFFECT) >>> 0, true);
}
