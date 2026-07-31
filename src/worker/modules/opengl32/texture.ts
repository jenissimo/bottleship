import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { OpenGLContext, GLTextureObject } from "./context";
import {
    GL_TEXTURE_1D, GL_TEXTURE_2D, GL_TEXTURE_3D, GL_RGBA,
    GL_TEXTURE_WRAP_S, GL_TEXTURE_WRAP_T, GL_TEXTURE_MAG_FILTER, GL_TEXTURE_MIN_FILTER,
    GL_INVALID_ENUM, GL_INVALID_VALUE,
    GL_REPEAT, GL_NEAREST,
    GL_RGB, GL_R3_G3_B2, GL_RGB4, GL_RGB5, GL_RGB8, GL_RGB10, GL_RGB12, GL_RGB16,
    GL_LUMINANCE, GL_LUMINANCE4, GL_LUMINANCE8, GL_LUMINANCE12, GL_LUMINANCE16,
    GL_ALPHA, GL_ALPHA4, GL_ALPHA8, GL_ALPHA12, GL_ALPHA16,
    GL_LUMINANCE_ALPHA, GL_LUMINANCE4_ALPHA4, GL_LUMINANCE6_ALPHA2, GL_LUMINANCE8_ALPHA8,
    GL_LUMINANCE12_ALPHA4, GL_LUMINANCE12_ALPHA12, GL_LUMINANCE16_ALPHA16,
    GL_INTENSITY, GL_INTENSITY4, GL_INTENSITY8, GL_INTENSITY12, GL_INTENSITY16,
} from "./constants";
import { Logger, LogCategory } from "../../core/logger";
import {
    decodeOpenGLCompressedTextureToRgba8,
    decodeOpenGLPixelsToRgba8,
    isOpenGLCompressedTextureFormat,
} from "../../backends/webgpu/shared/texture-formats";

const _f32ab = new ArrayBuffer(4);
const _f32dv = new DataView(_f32ab);
function bitsToF32(bits: number): number {
    _f32dv.setUint32(0, bits >>> 0, true);
    return _f32dv.getFloat32(0, true);
}

export function convertPixelsToRGBA8(
    mem: Uint8Array,
    srcPtr: number, width: number, height: number,
    format: number, type: number, unpackAlignment: number,
    unpackRowLength: number, unpackSkipPixels: number, unpackSkipRows: number
): Uint8Array {
    return decodeOpenGLPixelsToRgba8(
        mem,
        srcPtr,
        width,
        height,
        format,
        type,
        unpackAlignment,
        unpackRowLength,
        unpackSkipPixels,
        unpackSkipRows,
    );
}

/** Base internal format a sized/legacy internal format resolves to (GL 1.x table 3.15). */
const enum BaseFormat { ALPHA, LUMINANCE, LUMINANCE_ALPHA, INTENSITY, RGB, RGBA }

/**
 * The internal format — not the client format — decides which components the texture
 * STORES; every component it does not store is substituted at sample time (GL 1.x
 * §3.8.7 table 3.21): missing RGB reads 0, missing A reads 1, and LUMINANCE/INTENSITY
 * replicate their single stored value.
 *
 * GL 1.0 also allows a bare component COUNT (1/2/3/4) in place of an enum.
 */
function baseInternalFormat(internalFormat: number): BaseFormat {
    switch (internalFormat >>> 0) {
        case 1: case GL_LUMINANCE: case GL_LUMINANCE4: case GL_LUMINANCE8:
        case GL_LUMINANCE12: case GL_LUMINANCE16:
            return BaseFormat.LUMINANCE;
        case 2: case GL_LUMINANCE_ALPHA: case GL_LUMINANCE4_ALPHA4:
        case GL_LUMINANCE6_ALPHA2: case GL_LUMINANCE8_ALPHA8:
        case GL_LUMINANCE12_ALPHA4: case GL_LUMINANCE12_ALPHA12: case GL_LUMINANCE16_ALPHA16:
            return BaseFormat.LUMINANCE_ALPHA;
        case GL_ALPHA: case GL_ALPHA4: case GL_ALPHA8: case GL_ALPHA12: case GL_ALPHA16:
            return BaseFormat.ALPHA;
        case GL_INTENSITY: case GL_INTENSITY4: case GL_INTENSITY8:
        case GL_INTENSITY12: case GL_INTENSITY16:
            return BaseFormat.INTENSITY;
        case 3: case GL_RGB: case GL_R3_G3_B2: case GL_RGB4: case GL_RGB5:
        case GL_RGB8: case GL_RGB10: case GL_RGB12: case GL_RGB16:
            return BaseFormat.RGB;
        default:
            return BaseFormat.RGBA;
    }
}

/**
 * Does this internal format keep an alpha component?
 *
 * Uploading GL_RGBA client pixels into a GL_RGB texture discards their alpha and
 * sampling then yields A = 1.0. Engines rely on this to hand the driver a padded
 * 4-byte-per-texel buffer whose 4th byte is meaningless: id Tech 3's RE_StretchRaw
 * uploads every cinematic frame as `internalFormat = 3` (GL_RGB) with
 * `format = GL_RGBA` and A = 0. Keeping that alpha renders the whole video invisible.
 */
export function internalFormatHasAlpha(internalFormat: number): boolean {
    const base = baseInternalFormat(internalFormat);
    return base !== BaseFormat.LUMINANCE && base !== BaseFormat.RGB;
}

/**
 * Reduce decoded RGBA texels in place to the component set the internal format stores,
 * substituting what GL substitutes for the rest. We sample the stored texture directly,
 * so the substitution has to happen at upload or the client's spare components leak
 * through (a GL_ALPHA mask uploaded from a GL_RGBA image would render in full colour).
 */
export function applyInternalFormatComponents(data: Uint8Array, internalFormat: number): void {
    switch (baseInternalFormat(internalFormat)) {
        case BaseFormat.RGBA:
            return;
        case BaseFormat.RGB:
            for (let i = 3; i < data.length; i += 4) data[i] = 255;
            return;
        case BaseFormat.ALPHA:
            for (let i = 0; i + 3 < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 0;
            return;
        case BaseFormat.LUMINANCE:
            for (let i = 0; i + 3 < data.length; i += 4) {
                data[i + 1] = data[i + 2] = data[i];
                data[i + 3] = 255;
            }
            return;
        case BaseFormat.LUMINANCE_ALPHA:
            for (let i = 0; i + 3 < data.length; i += 4) data[i + 1] = data[i + 2] = data[i];
            return;
        case BaseFormat.INTENSITY:
            // One stored value feeds all four components; the client's red is it.
            for (let i = 0; i + 3 < data.length; i += 4) {
                data[i + 1] = data[i + 2] = data[i + 3] = data[i];
            }
            return;
    }
}

export function createTextureExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    let texUploadDiagCount = 0;

    function ensureTexture(id: number): GLTextureObject {
        let tex = ctx.textures.get(id);
        if (!tex) {
            tex = {
                id, width: 0, height: 0, internalFormat: GL_RGBA,
                data: null, wrapS: GL_REPEAT, wrapT: GL_REPEAT,
                minFilter: GL_NEAREST, magFilter: GL_NEAREST,
                dirty: false, gpuVersion: 0,
            };
            ctx.textures.set(id, tex);
        }
        return tex;
    }

    function isSupportedTextureTarget(target: number): boolean {
        return target === GL_TEXTURE_1D || target === GL_TEXTURE_2D || target === GL_TEXTURE_3D;
    }

    function uploadCompressedTexture(
        target: number,
        level: number,
        internalFormat: number,
        width: number,
        height: number,
        depth: number,
        border: number,
        imageSize: number,
        data: number,
    ): number {
        if (!isSupportedTextureTarget(target) || level !== 0) return 0;
        const texHeight = target === GL_TEXTURE_1D ? 1 : height;
        const texDepth = target === GL_TEXTURE_3D ? Math.max(1, depth | 0) : 1;
        if (border !== 0 || width <= 0 || texHeight <= 0 || texDepth <= 0) {
            ctx.error = GL_INVALID_VALUE;
            return 0;
        }
        if (!isOpenGLCompressedTextureFormat(internalFormat)) {
            ctx.error = GL_INVALID_ENUM;
            return 0;
        }

        const texId = ctx.textureUnits[ctx.activeTextureUnit].boundTexture;
        if (texId === 0) return 0;
        const tex = ensureTexture(texId);
        tex.width = width;
        tex.height = texHeight;
        tex.internalFormat = internalFormat;

        if (data !== 0 && imageSize > 0) {
            const mem = ctx.process.getCurrentMemory();
            const end = Math.min(mem.length, data + imageSize);
            const compressed = mem.subarray(data, end);
            tex.data = decodeOpenGLCompressedTextureToRgba8(compressed, 0, width, texHeight, internalFormat);
        } else {
            tex.data = new Uint8Array(width * texHeight * 4);
        }

        tex.dirty = true;
        tex.gpuVersion++;
        ctx.frameSnapshot.texUploads++;
        return 0;
    }

    function uploadCompressedTextureSubImage(
        target: number,
        level: number,
        xoffset: number,
        yoffset: number,
        zoffset: number,
        width: number,
        height: number,
        depth: number,
        format: number,
        imageSize: number,
        data: number,
    ): number {
        if (!isSupportedTextureTarget(target) || level !== 0) return 0;
        const subHeight = target === GL_TEXTURE_1D ? 1 : height;
        const subDepth = target === GL_TEXTURE_3D ? Math.max(1, depth | 0) : 1;
        if (zoffset !== 0 && target === GL_TEXTURE_3D) return 0;
        if (width <= 0 || subHeight <= 0 || subDepth <= 0) return 0;
        if (!isOpenGLCompressedTextureFormat(format)) {
            ctx.error = GL_INVALID_ENUM;
            return 0;
        }

        const texId = ctx.textureUnits[ctx.activeTextureUnit].boundTexture;
        if (texId === 0 || data === 0 || imageSize <= 0) return 0;
        const tex = ctx.textures.get(texId);
        if (!tex || !tex.data) return 0;

        const mem = ctx.process.getCurrentMemory();
        const end = Math.min(mem.length, data + imageSize);
        const compressed = mem.subarray(data, end);
        const sub = decodeOpenGLCompressedTextureToRgba8(compressed, 0, width, subHeight, format);

        for (let y = 0; y < subHeight; y++) {
            const dstY = yoffset + y;
            if (dstY < 0 || dstY >= tex.height) continue;
            for (let x = 0; x < width; x++) {
                const dstX = xoffset + x;
                if (dstX < 0 || dstX >= tex.width) continue;
                const si = (y * width + x) * 4;
                const di = (dstY * tex.width + dstX) * 4;
                tex.data[di] = sub[si];
                tex.data[di + 1] = sub[si + 1];
                tex.data[di + 2] = sub[si + 2];
                tex.data[di + 3] = sub[si + 3];
            }
        }

        tex.dirty = true;
        tex.gpuVersion++;
        ctx.frameSnapshot.texUploads++;
        return 0;
    }

    exports['glGenTextures'] = (_c, _m, args): number => {
        const n = args[0] | 0;
        const ptr = args[1] >>> 0;
        for (let j = 0; j < n; j++) {
            const id = ctx.nextTextureId++;
            Mem.writeUint32(ptr + j * 4, id);
            ensureTexture(id);
        }
        return 0;
    };

    exports['glDeleteTextures'] = (_c, _m, args): number => {
        const n = args[0] | 0;
        const ptr = args[1] >>> 0;
        for (let j = 0; j < n; j++) {
            const id = Mem.readUint32(ptr + j * 4)! >>> 0;
            ctx.textures.delete(id);
            for (const unit of ctx.textureUnits) {
                if (unit.boundTexture === id) unit.boundTexture = 0;
            }
        }
        return 0;
    };

    exports['glBindTexture'] = (_c, _m, args): number => {
        const target = args[0] >>> 0;
        const texture = args[1] >>> 0;
        if (!isSupportedTextureTarget(target)) return 0;
        ctx.textureUnits[ctx.activeTextureUnit].boundTexture = texture;
        if (texture !== 0) ensureTexture(texture);
        return 0;
    };

    exports['glTexImage2D'] = (_c, _m, args): number => {
        const target = args[0] >>> 0;
        const level = args[1] | 0;
        const internalformat = args[2] | 0;
        const width = args[3] | 0;
        const height = args[4] | 0;
        const _border = args[5] | 0;
        const format = args[6] >>> 0;
        const type = args[7] >>> 0;
        const pixels = args[8] >>> 0;

        if (target !== GL_TEXTURE_2D || level !== 0) return 0;

        const texId = ctx.textureUnits[ctx.activeTextureUnit].boundTexture;
        if (texId === 0) return 0;
        const tex = ensureTexture(texId);

        tex.width = width;
        tex.height = height;
        tex.internalFormat = internalformat;

        if (pixels !== 0 && width > 0 && height > 0) {
            const mem = ctx.process.getCurrentMemory();
            tex.data = convertPixelsToRGBA8(
                mem, pixels, width, height, format, type,
                ctx.unpackAlignment, ctx.unpackRowLength, ctx.unpackSkipPixels, ctx.unpackSkipRows
            );
            applyInternalFormatComponents(tex.data, internalformat);
            tex.dirty = true;
            tex.gpuVersion++;
            ctx.frameSnapshot.texUploads++;
            if (texUploadDiagCount < 8) {
                const cX = Math.max(0, (width >> 1) - 1);
                const cY = Math.max(0, (height >> 1) - 1);
                const p0 = 0;
                const pc = (cY * width + cX) * 4;
                Logger.log(
                    LogCategory.SYSTEM,
                    `glTexImage2D tex=${texId} ${width}x${height} fmt=0x${format.toString(16)} type=0x${type.toString(16)} ` +
                    `ptr=0x${pixels.toString(16)} unpack(al=${ctx.unpackAlignment},row=${ctx.unpackRowLength},sx=${ctx.unpackSkipPixels},sy=${ctx.unpackSkipRows}) ` +
                    `rgba0=[${tex.data[p0]},${tex.data[p0 + 1]},${tex.data[p0 + 2]},${tex.data[p0 + 3]}] ` +
                    `center=[${tex.data[pc]},${tex.data[pc + 1]},${tex.data[pc + 2]},${tex.data[pc + 3]}]`
                );
                texUploadDiagCount++;
            }
        } else {
            tex.data = new Uint8Array(width * height * 4);
            applyInternalFormatComponents(tex.data, internalformat);
        }
        return 0;
    };

    exports['glTexSubImage2D'] = (_c, _m, args): number => {
        const target = args[0] >>> 0;
        const _level = args[1] | 0;
        const xoffset = args[2] | 0;
        const yoffset = args[3] | 0;
        const width = args[4] | 0;
        const height = args[5] | 0;
        const format = args[6] >>> 0;
        const type = args[7] >>> 0;
        const pixels = args[8] >>> 0;

        if (target !== GL_TEXTURE_2D) return 0;
        const texId = ctx.textureUnits[ctx.activeTextureUnit].boundTexture;
        if (texId === 0) return 0;
        const tex = ctx.textures.get(texId);
        if (!tex || !tex.data || pixels === 0) return 0;

        const mem = ctx.process.getCurrentMemory();
        const sub = convertPixelsToRGBA8(
            mem, pixels, width, height, format, type,
            ctx.unpackAlignment, ctx.unpackRowLength, ctx.unpackSkipPixels, ctx.unpackSkipRows
        );
        applyInternalFormatComponents(sub, tex.internalFormat);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const si = (y * width + x) * 4;
                const di = ((yoffset + y) * tex.width + (xoffset + x)) * 4;
                tex.data[di] = sub[si];
                tex.data[di + 1] = sub[si + 1];
                tex.data[di + 2] = sub[si + 2];
                tex.data[di + 3] = sub[si + 3];
            }
        }
        tex.dirty = true;
        tex.gpuVersion++;
        if (texUploadDiagCount < 8) {
            const cX = Math.max(0, (width >> 1) - 1);
            const cY = Math.max(0, (height >> 1) - 1);
            const p0 = 0;
            const pc = (cY * width + cX) * 4;
            // Log raw bytes at ptr for format diagnosis: is the source BGRA or RGBA?
            const rawBytes = `raw=[${mem[pixels]},${mem[pixels+1]},${mem[pixels+2]},${mem[pixels+3]}]`;
            Logger.log(
                LogCategory.SYSTEM,
                `glTexSubImage2D tex=${texId} off=(${xoffset},${yoffset}) ${width}x${height} fmt=0x${format.toString(16)} type=0x${type.toString(16)} ` +
                `ptr=0x${pixels.toString(16)} ${rawBytes} unpack(al=${ctx.unpackAlignment},row=${ctx.unpackRowLength},sx=${ctx.unpackSkipPixels},sy=${ctx.unpackSkipRows}) ` +
                `rgba0=[${sub[p0]},${sub[p0 + 1]},${sub[p0 + 2]},${sub[p0 + 3]}] center=[${sub[pc]},${sub[pc + 1]},${sub[pc + 2]},${sub[pc + 3]}]`
            );
            texUploadDiagCount++;
        }
        return 0;
    };

    exports['glTexParameteri'] = (_c, _m, args): number => {
        const target = args[0] >>> 0;
        const pname = args[1] >>> 0;
        const param = args[2] | 0;
        if (!isSupportedTextureTarget(target)) return 0;
        const texId = ctx.textureUnits[ctx.activeTextureUnit].boundTexture;
        if (texId === 0) return 0;
        const tex = ensureTexture(texId);
        switch (pname) {
            case GL_TEXTURE_WRAP_S: tex.wrapS = param; break;
            case GL_TEXTURE_WRAP_T: tex.wrapT = param; break;
            case GL_TEXTURE_MAG_FILTER: tex.magFilter = param; break;
            case GL_TEXTURE_MIN_FILTER: tex.minFilter = param; break;
        }
        return 0;
    };

    exports['glTexParameterf'] = (_c, _m, args): number => {
        const target = args[0] >>> 0;
        const pname = args[1] >>> 0;
        const param = bitsToF32(args[2]) | 0;
        if (!isSupportedTextureTarget(target)) return 0;
        const texId = ctx.textureUnits[ctx.activeTextureUnit].boundTexture;
        if (texId === 0) return 0;
        const tex = ensureTexture(texId);
        switch (pname) {
            case GL_TEXTURE_WRAP_S: tex.wrapS = param; break;
            case GL_TEXTURE_WRAP_T: tex.wrapT = param; break;
            case GL_TEXTURE_MAG_FILTER: tex.magFilter = param; break;
            case GL_TEXTURE_MIN_FILTER: tex.minFilter = param; break;
        }
        return 0;
    };

    exports['glTexParameterfv'] = (): number => 0;
    exports['glTexParameteriv'] = (): number => 0;

    exports['glTexImage1D'] = (): number => 0;
    exports['glTexSubImage1D'] = (): number => 0;
    exports['glCopyTexImage1D'] = (): number => 0;
    exports['glCopyTexImage2D'] = (): number => 0;
    exports['glCopyTexSubImage1D'] = (): number => 0;
    exports['glCopyTexSubImage2D'] = (): number => 0;

    // GL 1.2
    exports['glTexImage3D'] = (): number => 0;
    exports['glTexSubImage3D'] = (): number => 0;
    exports['glCopyTexSubImage3D'] = (): number => 0;

    // GL 1.3 compressed
    exports['glCompressedTexImage3D'] = (_c, _m, args): number => uploadCompressedTexture(
        args[0] >>> 0,
        args[1] | 0,
        args[2] >>> 0,
        args[3] | 0,
        args[4] | 0,
        args[5] | 0,
        args[6] | 0,
        args[7] | 0,
        args[8] >>> 0,
    );
    exports['glCompressedTexImage2D'] = (_c, _m, args): number => uploadCompressedTexture(
        args[0] >>> 0,
        args[1] | 0,
        args[2] >>> 0,
        args[3] | 0,
        args[4] | 0,
        1,
        args[5] | 0,
        args[6] | 0,
        args[7] >>> 0,
    );
    exports['glCompressedTexImage1D'] = (_c, _m, args): number => uploadCompressedTexture(
        args[0] >>> 0,
        args[1] | 0,
        args[2] >>> 0,
        args[3] | 0,
        1,
        1,
        args[4] | 0,
        args[5] | 0,
        args[6] >>> 0,
    );
    exports['glCompressedTexSubImage3D'] = (_c, _m, args): number => uploadCompressedTextureSubImage(
        args[0] >>> 0,
        args[1] | 0,
        args[2] | 0,
        args[3] | 0,
        args[4] | 0,
        args[5] | 0,
        args[6] | 0,
        args[7] | 0,
        args[8] >>> 0,
        args[9] | 0,
        args[10] >>> 0,
    );
    exports['glCompressedTexSubImage2D'] = (_c, _m, args): number => uploadCompressedTextureSubImage(
        args[0] >>> 0,
        args[1] | 0,
        args[2] | 0,
        args[3] | 0,
        0,
        args[4] | 0,
        args[5] | 0,
        1,
        args[6] >>> 0,
        args[7] | 0,
        args[8] >>> 0,
    );
    exports['glCompressedTexSubImage1D'] = (_c, _m, args): number => uploadCompressedTextureSubImage(
        args[0] >>> 0,
        args[1] | 0,
        args[2] | 0,
        0,
        0,
        args[3] | 0,
        1,
        1,
        args[4] >>> 0,
        args[5] | 0,
        args[6] >>> 0,
    );
    exports['glGetCompressedTexImage'] = (): number => 0;

    exports['glPrioritizeTextures'] = (): number => 0;

    return exports;
}
