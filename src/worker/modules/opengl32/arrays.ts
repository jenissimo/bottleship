import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { OpenGLContext } from "./context";
import {
    emitDrawCommandFlat, arenaReserve, emitArenaDraw, immediateReserveVertex,
} from "./immediate";
import {
    guestViews, decodeIndices, sequentialIndices, gatherVertices, ensureGatherScratch,
    cvaLock, cvaUnlock, VertexSpace, validateClientArrayRange,
    lastIndexMin, lastIndexMax,
} from "./client-arrays";
import {
    GL_VERTEX_ARRAY, GL_NORMAL_ARRAY, GL_COLOR_ARRAY, GL_TEXTURE_COORD_ARRAY,
    GL_TRIANGLES, GL_TRIANGLE_STRIP, GL_TRIANGLE_FAN, GL_POLYGON, GL_QUADS, GL_QUAD_STRIP,
    GL_INVALID_VALUE, GL_INVALID_ENUM, GL_INVALID_OPERATION,
    GL_FLOAT, GL_UNSIGNED_BYTE,
    GL_V2F, GL_V3F, GL_C4UB_V2F, GL_C4UB_V3F, GL_C3F_V3F, GL_N3F_V3F, GL_C4F_N3F_V3F,
    GL_T2F_V3F, GL_T4F_V4F, GL_T2F_C4UB_V3F, GL_T2F_C3F_V3F, GL_T2F_N3F_V3F,
    GL_T2F_C4F_N3F_V3F, GL_T4F_C4F_N3F_V4F,
} from "./constants";

/**
 * Vertices a mode consumes straight through, or -1 when it needs primitive assembly.
 * MUST agree with assembleFlatVerts: its default branch copies every source vertex, and
 * GL_TRIANGLES copies whole triangles only. For those the gather can write directly into
 * the frame arena and skip the assembly copy entirely.
 */
function passThroughCount(mode: number, count: number): number {
    switch (mode) {
        case GL_TRIANGLES: return count - (count % 3);
        case GL_TRIANGLE_STRIP: case GL_TRIANGLE_FAN: case GL_POLYGON:
        case GL_QUADS: case GL_QUAD_STRIP: return -1;
        default: return count;
    }
}

interface InterleavedFormat {
    /** Texture-coordinate components, 0 when the format carries none. */
    st: number;
    /** Colour components, 0 when the format carries none. */
    sc: number;
    colorType: number;
    hasNormal: boolean;
    /** Position components (always float). */
    sv: number;
    /** Byte offsets of colour / normal / position within one packed vertex. */
    pc: number; pn: number; pv: number;
    /** Packed stride, used when the caller passes 0. */
    stride: number;
}

/** GL 1.1 table 2.4, with sizeof(GLfloat)=4 and the 4-ubyte colour padded to 4. */
const INTERLEAVED_FORMATS: Record<number, InterleavedFormat> = {
    [GL_V2F]:             { st: 0, sc: 0, colorType: GL_FLOAT,         hasNormal: false, sv: 2, pc: 0,  pn: 0,  pv: 0,  stride: 8 },
    [GL_V3F]:             { st: 0, sc: 0, colorType: GL_FLOAT,         hasNormal: false, sv: 3, pc: 0,  pn: 0,  pv: 0,  stride: 12 },
    [GL_C4UB_V2F]:        { st: 0, sc: 4, colorType: GL_UNSIGNED_BYTE, hasNormal: false, sv: 2, pc: 0,  pn: 0,  pv: 4,  stride: 12 },
    [GL_C4UB_V3F]:        { st: 0, sc: 4, colorType: GL_UNSIGNED_BYTE, hasNormal: false, sv: 3, pc: 0,  pn: 0,  pv: 4,  stride: 16 },
    [GL_C3F_V3F]:         { st: 0, sc: 3, colorType: GL_FLOAT,         hasNormal: false, sv: 3, pc: 0,  pn: 0,  pv: 12, stride: 24 },
    [GL_N3F_V3F]:         { st: 0, sc: 0, colorType: GL_FLOAT,         hasNormal: true,  sv: 3, pc: 0,  pn: 0,  pv: 12, stride: 24 },
    [GL_C4F_N3F_V3F]:     { st: 0, sc: 4, colorType: GL_FLOAT,         hasNormal: true,  sv: 3, pc: 0,  pn: 16, pv: 28, stride: 40 },
    [GL_T2F_V3F]:         { st: 2, sc: 0, colorType: GL_FLOAT,         hasNormal: false, sv: 3, pc: 0,  pn: 0,  pv: 8,  stride: 20 },
    [GL_T4F_V4F]:         { st: 4, sc: 0, colorType: GL_FLOAT,         hasNormal: false, sv: 4, pc: 0,  pn: 0,  pv: 16, stride: 32 },
    [GL_T2F_C4UB_V3F]:    { st: 2, sc: 4, colorType: GL_UNSIGNED_BYTE, hasNormal: false, sv: 3, pc: 8,  pn: 0,  pv: 12, stride: 24 },
    [GL_T2F_C3F_V3F]:     { st: 2, sc: 3, colorType: GL_FLOAT,         hasNormal: false, sv: 3, pc: 8,  pn: 0,  pv: 20, stride: 32 },
    [GL_T2F_N3F_V3F]:     { st: 2, sc: 0, colorType: GL_FLOAT,         hasNormal: true,  sv: 3, pc: 0,  pn: 8,  pv: 20, stride: 32 },
    [GL_T2F_C4F_N3F_V3F]: { st: 2, sc: 4, colorType: GL_FLOAT,         hasNormal: true,  sv: 3, pc: 8,  pn: 24, pv: 36, stride: 48 },
    [GL_T4F_C4F_N3F_V4F]: { st: 4, sc: 4, colorType: GL_FLOAT,         hasNormal: true,  sv: 4, pc: 16, pn: 32, pv: 44, stride: 60 },
};

/** Gather + emit one client-array draw. `idx` must come from the index scratch so that
 *  the [min,max] recorded by the decode still describes it. */
function drawClientArrays(ctx: OpenGLContext, mode: number, idx: Uint32Array, count: number): void {
    if (count <= 0) return;
    if (!validateClientArrayRange(ctx, lastIndexMin(), lastIndexMax())) {
        ctx.error = GL_INVALID_OPERATION;
        return;
    }

    const direct = passThroughCount(mode, count);
    if (direct >= 0) {
        if (direct === 0) return;
        const base = arenaReserve(ctx, direct);
        const space = gatherVertices(ctx, idx, direct, ctx.vertArena.data, base, true);
        emitArenaDraw(ctx, mode, base, direct, space === VertexSpace.CLIP);
        return;
    }

    const scratch = ensureGatherScratch(count);
    const space = gatherVertices(ctx, idx, count, scratch, 0, true);
    emitDrawCommandFlat(ctx, mode, scratch, count, space === VertexSpace.CLIP);
}

export function createArrayExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['glVertexPointer'] = (_c, _m, args): number => {
        ctx.vertexArray.size = args[0] | 0;
        ctx.vertexArray.type = args[1] >>> 0;
        ctx.vertexArray.stride = args[2] | 0;
        ctx.vertexArray.pointer = args[3] >>> 0;
        return 0;
    };

    exports['glNormalPointer'] = (_c, _m, args): number => {
        ctx.normalArray.type = args[0] >>> 0;
        ctx.normalArray.stride = args[1] | 0;
        ctx.normalArray.pointer = args[2] >>> 0;
        ctx.normalArray.size = 3;
        return 0;
    };

    exports['glColorPointer'] = (_c, _m, args): number => {
        ctx.colorArray.size = args[0] | 0;
        ctx.colorArray.type = args[1] >>> 0;
        ctx.colorArray.stride = args[2] | 0;
        ctx.colorArray.pointer = args[3] >>> 0;
        return 0;
    };

    exports['glTexCoordPointer'] = (_c, _m, args): number => {
        const unit = ctx.clientActiveTextureUnit;
        if (unit < ctx.texCoordArrays.length) {
            ctx.texCoordArrays[unit].size = args[0] | 0;
            ctx.texCoordArrays[unit].type = args[1] >>> 0;
            ctx.texCoordArrays[unit].stride = args[2] | 0;
            ctx.texCoordArrays[unit].pointer = args[3] >>> 0;
        }
        return 0;
    };

    exports['glEnableClientState'] = (_c, _m, args): number => {
        const cap = args[0] >>> 0;
        switch (cap) {
            case GL_VERTEX_ARRAY: ctx.vertexArray.enabled = true; break;
            case GL_NORMAL_ARRAY: ctx.normalArray.enabled = true; break;
            case GL_COLOR_ARRAY: ctx.colorArray.enabled = true; break;
            case GL_TEXTURE_COORD_ARRAY:
                if (ctx.clientActiveTextureUnit < ctx.texCoordArrays.length)
                    ctx.texCoordArrays[ctx.clientActiveTextureUnit].enabled = true;
                break;
        }
        return 0;
    };

    exports['glDisableClientState'] = (_c, _m, args): number => {
        const cap = args[0] >>> 0;
        switch (cap) {
            case GL_VERTEX_ARRAY: ctx.vertexArray.enabled = false; break;
            case GL_NORMAL_ARRAY: ctx.normalArray.enabled = false; break;
            case GL_COLOR_ARRAY: ctx.colorArray.enabled = false; break;
            case GL_TEXTURE_COORD_ARRAY:
                if (ctx.clientActiveTextureUnit < ctx.texCoordArrays.length)
                    ctx.texCoordArrays[ctx.clientActiveTextureUnit].enabled = false;
                break;
        }
        return 0;
    };

    exports['glArrayElement'] = (_c, _m, args): number => {
        const idx = sequentialIndices(args[0] | 0, 1);
        if (!validateClientArrayRange(ctx, lastIndexMin(), lastIndexMax())) {
            ctx.error = GL_INVALID_OPERATION;
            return 0;
        }
        const base = immediateReserveVertex(ctx);
        // The immediate buffer is transformed at glEnd, so object space is mandatory here.
        gatherVertices(ctx, idx, 1, ctx.immediateFlatBuf, base, false);
        return 0;
    };

    exports['glDrawArrays'] = (_c, _m, args): number => {
        const mode = args[0] >>> 0;
        const first = args[1] | 0;
        const count = args[2] | 0;
        if (count <= 0) return 0;
        drawClientArrays(ctx, mode, sequentialIndices(first, count), count);
        return 0;
    };

    exports['glDrawElements'] = (_c, _m, args): number => {
        const mode = args[0] >>> 0;
        const count = args[1] | 0;
        const type = args[2] >>> 0;
        const indicesPtr = args[3] >>> 0;
        if (count <= 0 || !indicesPtr) return 0;
        const idx = decodeIndices(guestViews(ctx), indicesPtr, type, count);
        if (!idx) { ctx.error = GL_INVALID_ENUM; return 0; }
        drawClientArrays(ctx, mode, idx, count);
        return 0;
    };

    /**
     * start/end let a driver bound the range it touches without scanning the indices.
     * We decode the indices into a scratch anyway and get the EXACT [min,max] out of
     * that pass for free, which is a tighter bound than the declared one and cannot be
     * wrong — so the declared range is only validated, never used to bound anything.
     */
    exports['glDrawRangeElements'] = (_c, _m, args): number => {
        const mode = args[0] >>> 0;
        const start = args[1] >>> 0;
        const end = args[2] >>> 0;
        const count = args[3] | 0;
        const type = args[4] >>> 0;
        const indicesPtr = args[5] >>> 0;
        if (end < start) { ctx.error = GL_INVALID_VALUE; return 0; }
        if (count <= 0 || !indicesPtr) return 0;
        const idx = decodeIndices(guestViews(ctx), indicesPtr, type, count);
        if (!idx) { ctx.error = GL_INVALID_ENUM; return 0; }
        drawClientArrays(ctx, mode, idx, count);
        return 0;
    };

    /**
     * glInterleavedArrays SETS the four client array pointers and their enables from one
     * packed buffer (GL 1.1 §2.8, table 2.4) — as a no-op it silently leaves whatever the
     * app configured before, so the next draw renders stale geometry.
     */
    exports['glInterleavedArrays'] = (_c, _m, args): number => {
        const format = args[0] >>> 0;
        let stride = args[1] | 0;
        const pointer = args[2] >>> 0;

        const fmt = INTERLEAVED_FORMATS[format];
        if (!fmt) { ctx.error = GL_INVALID_ENUM; return 0; }
        if (stride < 0) { ctx.error = GL_INVALID_VALUE; return 0; }
        if (stride === 0) stride = fmt.stride;

        const tc = ctx.texCoordArrays[ctx.clientActiveTextureUnit];
        if (tc) {
            tc.enabled = fmt.st > 0;
            if (fmt.st > 0) {
                tc.size = fmt.st; tc.type = GL_FLOAT; tc.stride = stride; tc.pointer = pointer;
            }
        }

        ctx.colorArray.enabled = fmt.sc > 0;
        if (fmt.sc > 0) {
            ctx.colorArray.size = fmt.sc;
            ctx.colorArray.type = fmt.colorType;
            ctx.colorArray.stride = stride;
            ctx.colorArray.pointer = pointer + fmt.pc;
        }

        ctx.normalArray.enabled = fmt.hasNormal;
        if (fmt.hasNormal) {
            ctx.normalArray.size = 3;
            ctx.normalArray.type = GL_FLOAT;
            ctx.normalArray.stride = stride;
            ctx.normalArray.pointer = pointer + fmt.pn;
        }

        ctx.vertexArray.enabled = true;
        ctx.vertexArray.size = fmt.sv;
        ctx.vertexArray.type = GL_FLOAT;
        ctx.vertexArray.stride = stride;
        ctx.vertexArray.pointer = pointer + fmt.pv;
        return 0;
    };
    exports['glEdgeFlagPointer'] = (): number => 0;
    exports['glIndexPointer'] = (): number => 0;

    /**
     * EXT_compiled_vertex_array. The lock is the application promising that the arrays
     * enabled RIGHT NOW hold static data over [first, first+count) until the unlock, so
     * each unique vertex can be converted and transformed once and reused across the
     * draws that follow. It is a hint: everything renders identically if it never comes.
     */
    exports['glLockArraysEXT'] = (_c, _m, args): number => {
        cvaLock(ctx, args[0] | 0, args[1] | 0);
        return 0;
    };

    exports['glUnlockArraysEXT'] = (): number => {
        cvaUnlock(ctx);
        return 0;
    };

    return exports;
}
