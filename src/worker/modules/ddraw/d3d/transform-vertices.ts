/**
 * IDirect3DViewport(2/3)::TransformVertices — the DX3..DX6 "transform these points for me"
 * query. Pure math over guest memory so the conformance test can import it on its own.
 *
 *   HRESULT TransformVertices(DWORD dwVertexCount, D3DTRANSFORMDATA *lpData,
 *                             DWORD dwFlags, DWORD *lpOffscreen)
 *
 * It is not a draw call. Apps use it to learn where geometry WILL land on screen — The
 * Longest Journey transforms the 8 corners of every actor's bounding box each frame and
 * builds the dirty rectangle it restores the background into from the result. A stub that
 * answers D3D_OK without writing lpOut hands the app stale corners, so the restore rect
 * misses the part of the actor that moved and the old pixels stay on screen as trails.
 *
 * Semantics follow Wine's d3d_viewport_TransformVertices (dlls/ddraw/viewport.c), which is
 * calibrated against native by ddraw's own tests:
 *  - clip = v · (world · view · projection), then the viewport's clip-space remap;
 *  - visible vertices: divide by w, map x/y onto the viewport pixel rect (y flipped),
 *    out = (sx, sy, z/w, 1/w) followed by the 16-byte payload copied from the input;
 *  - D3DTRANSFORM_CLIPPED: per-vertex D3DCLIP_* flags into lpHOut (with hx/hy/hz in
 *    pre-remap clip space); a clipped vertex gets its raw clip-space (x, y, z, w) and no
 *    payload; *lpOffscreen is the AND of every vertex's flags (non-zero = wholly off one
 *    plane). D3DTRANSFORM_UNCLIPPED writes no lpHOut and *lpOffscreen = 0.
 * Beyond Wine, the two documented OUT members of D3DTRANSFORMDATA that Wine leaves alone are
 * filled, because TLJ reads them straight back: dwClipIntersection / dwClipUnion (AND / OR of
 * the vertex clip flags — zero in UNCLIPPED mode, where the caller has declared every vertex
 * on screen) and drExtent (the screen-space bounding rect of the vertices written).
 */

import { isValidAddress } from "../../../core/memory/address-guard";

export const D3DTRANSFORM_CLIPPED = 0x1;
export const D3DTRANSFORM_UNCLIPPED = 0x2;

export const D3DCLIP_LEFT = 0x01;
export const D3DCLIP_RIGHT = 0x02;
export const D3DCLIP_TOP = 0x04;
export const D3DCLIP_BOTTOM = 0x08;
export const D3DCLIP_FRONT = 0x10;
export const D3DCLIP_BACK = 0x20;

/** sizeof(D3DTRANSFORMDATA): dwSize, lpIn, dwInSize, lpOut, dwOutSize, lpHOut, dwClip,
 *  dwClipIntersection, dwClipUnion, drExtent{x1,y1,x2,y2}. */
export const D3DTRANSFORMDATA_SIZE = 52;
const TD_LPIN = 4;
const TD_INSIZE = 8;
const TD_LPOUT = 12;
const TD_OUTSIZE = 16;
const TD_LPHOUT = 20;
const TD_CLIP_INTERSECTION = 28;
const TD_CLIP_UNION = 32;
const TD_EXTENT = 36;
/** sizeof(D3DHVERTEX): dwFlags, hx, hy, hz. */
const D3DHVERTEX_SIZE = 16;
/** Position (x, y, z, w-or-reserved) ahead of the payload in D3DVERTEX/D3DLVERTEX/D3DTLVERTEX. */
const POSITION_BYTES = 16;
const PAYLOAD_BYTES = 16;

const D3D_OK = 0;
const DDERR_INVALIDPARAMS = 0x80070057;

export interface TransformVerticesState {
    /** world × view × projection, row-major, D3D row-vector convention (v' = v·M). */
    mvp: Float32Array;
    /** Viewport pixel rectangle. */
    viewport: { x: number; y: number; width: number; height: number };
    /** The viewport's post-projection clip-space remap (identity for the default volume). */
    clipSpace: { sx: number; sy: number; sz: number; ox: number; oy: number; oz: number };
}

export function transformVertices(
    mem: Uint8Array,
    count: number,
    lpData: number,
    flags: number,
    lpOffscreen: number,
    state: TransformVerticesState,
): number {
    if (!lpData || !isValidAddress(mem, lpData, D3DTRANSFORMDATA_SIZE, "rw")) return DDERR_INVALIDPARAMS;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (view.getUint32(lpData, true) !== D3DTRANSFORMDATA_SIZE) return DDERR_INVALIDPARAMS;
    if (!(flags & (D3DTRANSFORM_CLIPPED | D3DTRANSFORM_UNCLIPPED))) return DDERR_INVALIDPARAMS;
    const clipped = (flags & D3DTRANSFORM_CLIPPED) !== 0;

    const lpIn = view.getUint32(lpData + TD_LPIN, true);
    const inSize = view.getUint32(lpData + TD_INSIZE, true);
    const lpOut = view.getUint32(lpData + TD_LPOUT, true);
    const outSize = view.getUint32(lpData + TD_OUTSIZE, true);
    const lpHOut = view.getUint32(lpData + TD_LPHOUT, true);

    // Count, strides and pointers all come from the guest: validate the whole extent each
    // stream touches once, up front, rather than per vertex.
    if (count > 0) {
        const inSpan = (count - 1) * inSize + 12;
        const outSpan = (count - 1) * outSize + POSITION_BYTES;
        if (!isValidAddress(mem, lpIn, inSpan, "r") || !isValidAddress(mem, lpOut, outSpan, "rw")) {
            return DDERR_INVALIDPARAMS;
        }
        if (clipped && !isValidAddress(mem, lpHOut, count * D3DHVERTEX_SIZE, "rw")) return DDERR_INVALIDPARAMS;
    }
    const payload = Math.min(PAYLOAD_BYTES, inSize - POSITION_BYTES, outSize - POSITION_BYTES);
    const canCopyPayload = payload > 0 && count > 0
        && isValidAddress(mem, lpIn, (count - 1) * inSize + POSITION_BYTES + payload, "r")
        && isValidAddress(mem, lpOut, (count - 1) * outSize + POSITION_BYTES + payload, "rw");

    const m = state.mvp;
    const cs = state.clipSpace;
    const vp = state.viewport;
    const halfW = vp.width / 2;
    const halfH = vp.height / 2;

    let offscreen = clipped ? 0xffffffff : 0;
    let clipIntersection = clipped ? 0xffffffff : 0;
    let clipUnion = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (let i = 0; i < count; i++) {
        const src = lpIn + i * inSize;
        const dst = lpOut + i * outSize;
        const px = view.getFloat32(src, true);
        const py = view.getFloat32(src + 4, true);
        const pz = view.getFloat32(src + 8, true);

        const xc = px * m[0]! + py * m[4]! + pz * m[8]! + m[12]!;
        const yc = px * m[1]! + py * m[5]! + pz * m[9]! + m[13]!;
        const zc = px * m[2]! + py * m[6]! + pz * m[10]! + m[14]!;
        const w = px * m[3]! + py * m[7]! + pz * m[11]! + m[15]!;
        const x = xc * cs.sx + w * cs.ox;
        const y = yc * cs.sy + w * cs.oy;
        const z = zc * cs.sz + w * cs.oz;

        if (clipped) {
            let f = 0;
            if (x > w) f |= D3DCLIP_RIGHT;
            if (x < -w) f |= D3DCLIP_LEFT;
            if (y > w) f |= D3DCLIP_TOP;
            if (y < -w) f |= D3DCLIP_BOTTOM;
            if (z < 0) f |= D3DCLIP_FRONT;
            if (z > w) f |= D3DCLIP_BACK;
            const h = lpHOut + i * D3DHVERTEX_SIZE;
            view.setUint32(h, f, true);
            view.setFloat32(h + 4, xc, true);
            view.setFloat32(h + 8, yc, true);
            view.setFloat32(h + 12, zc, true);
            offscreen = (offscreen & f) >>> 0;
            clipIntersection = (clipIntersection & f) >>> 0;
            clipUnion |= f;
            if (f) {
                view.setFloat32(dst, x, true);
                view.setFloat32(dst + 4, y, true);
                view.setFloat32(dst + 8, z, true);
                view.setFloat32(dst + 12, w, true);
                continue;
            }
        }

        const invW = w !== 0 ? 1 / w : 0;
        const sx = (x * invW + 1) * halfW + vp.x;
        const sy = (-y * invW + 1) * halfH + vp.y;
        view.setFloat32(dst, sx, true);
        view.setFloat32(dst + 4, sy, true);
        view.setFloat32(dst + 8, z * invW, true);
        view.setFloat32(dst + 12, invW, true);
        if (canCopyPayload) {
            mem.copyWithin(dst + POSITION_BYTES, src + POSITION_BYTES, src + POSITION_BYTES + payload);
        }
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
    }

    if (count === 0) clipIntersection = 0;
    view.setUint32(lpData + TD_CLIP_INTERSECTION, clipIntersection >>> 0, true);
    view.setUint32(lpData + TD_CLIP_UNION, clipUnion >>> 0, true);
    if (minX <= maxX) {
        view.setInt32(lpData + TD_EXTENT, Math.floor(minX), true);
        view.setInt32(lpData + TD_EXTENT + 4, Math.floor(minY), true);
        view.setInt32(lpData + TD_EXTENT + 8, Math.ceil(maxX), true);
        view.setInt32(lpData + TD_EXTENT + 12, Math.ceil(maxY), true);
    }
    if (lpOffscreen && isValidAddress(mem, lpOffscreen, 4, "rw")) {
        view.setUint32(lpOffscreen, count === 0 ? 0 : offscreen >>> 0, true);
    }
    return D3D_OK;
}
