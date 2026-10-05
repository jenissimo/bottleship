import { describe, expect, test } from "bun:test";
import { copyD3D9SurfaceRectCpu, writeD3D9Pixel } from "../../src/worker/backends/webgpu/d3d9/copy-cpu";
import { resolveD3D9StretchRectPolicy } from "../../src/worker/backends/webgpu/d3d9/copy-policy";
import {
    decodeD3DTextureToRgba8,
    float16BitsToFloat32,
    float32ToFloat16Bits,
    getD3DTextureLayout,
} from "../../src/worker/backends/webgpu/shared/texture-formats";

const D3DPOOL_DEFAULT = 0;
const D3DUSAGE_RENDERTARGET = 1;
const D3DMULTISAMPLE_NONE = 0;
const D3DMULTISAMPLE_2_SAMPLES = 2;
let nextTexture = 1;

function surface(overrides: Partial<Parameters<typeof resolveD3D9StretchRectPolicy>[0]> = {}) {
    return {
        format: 21,
        usage: D3DUSAGE_RENDERTARGET,
        pool: D3DPOOL_DEFAULT,
        width: 4,
        height: 4,
        multiSampleType: D3DMULTISAMPLE_NONE,
        texturePtr: nextTexture++,
        ...overrides,
    };
}

describe("D3D9 StretchRect copy policy", () => {
    test("accepts a render-target scale and refuses non-DEFAULT pools", () => {
        const accepted = resolveD3D9StretchRectPolicy(
            surface({ width: 2, height: 2 }),
            surface({ width: 4, height: 4 }),
            2,
        );
        expect(accepted).toMatchObject({ supported: true, stretch: true, cpuPath: false });

        const rejected = resolveD3D9StretchRectPolicy(
            surface({ pool: 2 }),
            surface(),
            0,
        );
        expect(rejected.supported).toBe(false);
        expect(rejected.reason).toContain("DEFAULT");
    });

    test("allows only the explicit offscreen-plain CPU pair", () => {
        const src = surface({ usage: 0, offscreenPlain: true, texturePtr: 11 });
        const dst = surface({ usage: 0, offscreenPlain: true, texturePtr: 12 });
        const accepted = resolveD3D9StretchRectPolicy(src, dst, 1, {
            left: 1, top: 1, right: 3, bottom: 3,
        }, {
            left: 1, top: 1, right: 3, bottom: 3,
        });
        expect(accepted).toMatchObject({ supported: true, cpuPath: true, stretch: false });

        const textureDestination = resolveD3D9StretchRectPolicy(src, surface({ usage: 0, texturePtr: 12 }), 0);
        expect(textureDestination.supported).toBe(false);
    });

    test("accepts a single-sample render target source into DEFAULT offscreen plain", () => {
        const src = surface({ usage: D3DUSAGE_RENDERTARGET, offscreenPlain: false });
        const dst = surface({ usage: 0, offscreenPlain: true, texturePtr: 12 });
        const accepted = resolveD3D9StretchRectPolicy(src, dst, 0);
        expect(accepted).toMatchObject({ supported: true, cpuPath: true, requiresResolve: false });

        const ordinaryTexture = surface({ usage: 0, offscreenPlain: false, texturePtr: 13 });
        expect(resolveD3D9StretchRectPolicy(ordinaryTexture, dst, 0).supported).toBe(false);
    });

    test("keeps MSAA resolve direction and rejects MSAA destinations", () => {
        const resolve = resolveD3D9StretchRectPolicy(
            surface({ multiSampleType: D3DMULTISAMPLE_2_SAMPLES }),
            surface(),
            0,
        );
        expect(resolve).toMatchObject({ supported: true, requiresResolve: true });

        const destinationMsaa = resolveD3D9StretchRectPolicy(
            surface(),
            surface({ multiSampleType: D3DMULTISAMPLE_2_SAMPLES }),
            0,
        );
        expect(destinationMsaa.supported).toBe(false);
    });

    test("CPU point copy preserves pixels outside destination rect and converts packed format", () => {
        const srcData = new Uint8Array(4 * 4 * 4);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            const o = (y * 4 + x) * 4;
            srcData[o] = x * 40;
            srcData[o + 1] = y * 40;
            srcData[o + 2] = 0x7f;
            srcData[o + 3] = 0xff;
        }
        const dstLayout = getD3DTextureLayout(23, 4, 4);
        const dstData = new Uint8Array(dstLayout.bytes).fill(0xee);
        const originalOutside = dstData.slice();
        const copied = copyD3D9SurfaceRectCpu(
            { data: srcData, pitch: 16, width: 4, height: 4, format: 21 },
            { data: dstData, pitch: dstLayout.pitch, width: 4, height: 4, format: 23 },
            { left: 1, top: 1, right: 3, bottom: 3 },
            { left: 0, top: 0, right: 2, bottom: 2 },
            false,
        );
        expect(copied).toBe(true);
        expect(dstData.slice(24, 26)).toEqual(originalOutside.slice(24, 26));
        expect(dstData.some((byte, index) => byte !== originalOutside[index])).toBe(true);
    });

    test("CPU linear scaling uses the source footprint rather than nearest-only", () => {
        const srcData = new Uint8Array([
            0, 0, 0, 255, 255, 0, 0, 255,
            0, 255, 0, 255, 0, 0, 255, 255,
        ]);
        const dstData = new Uint8Array(4 * 4 * 4);
        const copied = copyD3D9SurfaceRectCpu(
            { data: srcData, pitch: 8, width: 2, height: 2, format: 21 },
            { data: dstData, pitch: 16, width: 4, height: 4, format: 21 },
            { left: 0, top: 0, right: 2, bottom: 2 },
            { left: 0, top: 0, right: 4, bottom: 4 },
            true,
        );
        expect(copied).toBe(true);
        // Center sample is the bilinear mix, not any one source corner.
        const center = (2 * 4 + 2) * 4;
        expect(dstData[center]).toBeGreaterThan(0);
        expect(dstData[center + 1]).toBeGreaterThan(0);
        expect(dstData[center + 2]).toBeGreaterThan(0);
    });

    test("float-to-float linear copies preserve half-float precision", () => {
        const sourceValues = [0.1234, 0.2345];
        const sourceData = new Uint8Array(4);
        const sourceView = new DataView(sourceData.buffer);
        for (let x = 0; x < sourceValues.length; x++) {
            sourceView.setUint16(x * 2, float32ToFloat16Bits(sourceValues[x]!), true);
        }
        const destinationLayout = getD3DTextureLayout(111, 3, 1);
        const destinationData = new Uint8Array(destinationLayout.bytes);
        expect(copyD3D9SurfaceRectCpu(
            { data: sourceData, pitch: 4, width: 2, height: 1, format: 111 },
            { data: destinationData, pitch: destinationLayout.pitch, width: 3, height: 1, format: 111 },
            { left: 0, top: 0, right: 2, bottom: 1 },
            { left: 0, top: 0, right: 3, bottom: 1 },
            true,
        )).toBe(true);

        const destinationView = new DataView(destinationData.buffer);
        const left = float16BitsToFloat32(destinationView.getUint16(0, true));
        const center = float16BitsToFloat32(destinationView.getUint16(2, true));
        const right = float16BitsToFloat32(destinationView.getUint16(4, true));
        const sourceLeft = float16BitsToFloat32(sourceView.getUint16(0, true));
        const sourceRight = float16BitsToFloat32(sourceView.getUint16(2, true));
        // The centre footprint is averaged in float space, then rounded once to
        // the destination half format. An RGBA8 detour would quantize this to a
        // different value.
        expect(left).toBe(sourceLeft);
        expect(center).toBe(float16BitsToFloat32(float32ToFloat16Bits((sourceLeft + sourceRight) / 2)));
        expect(right).toBe(sourceRight);
    });

    test("multi-channel half-float copies preserve channel lanes", () => {
        for (const [format, channels] of [[112, 2], [113, 4]] as const) {
            const bytesPerTexel = channels * 2;
            const source = new Uint8Array(bytesPerTexel);
            const sourceView = new DataView(source.buffer);
            for (let channel = 0; channel < channels; channel++) {
                sourceView.setUint16(channel * 2, float32ToFloat16Bits((channel + 1) / 7), true);
            }
            const layout = getD3DTextureLayout(format, 1, 1);
            const destination = new Uint8Array(layout.bytes);
            expect(copyD3D9SurfaceRectCpu(
                { data: source, pitch: bytesPerTexel, width: 1, height: 1, format },
                { data: destination, pitch: layout.pitch, width: 1, height: 1, format },
                { left: 0, top: 0, right: 1, bottom: 1 },
                { left: 0, top: 0, right: 1, bottom: 1 },
                false,
            )).toBe(true);
            expect(Array.from(destination.slice(0, bytesPerTexel))).toEqual(Array.from(source));
        }
    });

    test("float CPU copies reject a truncated row before writing", () => {
        const destination = new Uint8Array(4).fill(0xa5);
        expect(copyD3D9SurfaceRectCpu(
            { data: new Uint8Array(4), pitch: 2, width: 2, height: 1, format: 111 },
            { data: destination, pitch: 4, width: 2, height: 1, format: 111 },
            { left: 0, top: 0, right: 2, bottom: 1 },
            { left: 0, top: 0, right: 2, bottom: 1 },
            true,
        )).toBe(false);
        expect(Array.from(destination)).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
    });

    test("CPU copy encodes X4R4G4B4 and L16 destinations instead of refusing known layouts", () => {
        const srcData = new Uint8Array([0x20, 0x40, 0x80, 0xff]);
        for (const format of [30, 81]) {
            const layout = getD3DTextureLayout(format, 1, 1);
            const dstData = new Uint8Array(layout.bytes);
            expect(copyD3D9SurfaceRectCpu(
                { data: srcData, pitch: 4, width: 1, height: 1, format: 21 },
                { data: dstData, pitch: layout.pitch, width: 1, height: 1, format },
                { left: 0, top: 0, right: 1, bottom: 1 },
                { left: 0, top: 0, right: 1, bottom: 1 },
                false,
            )).toBe(true);
            expect(dstData.some(byte => byte !== 0)).toBe(true);
        }
    });

    test("packed ColorFill/StretchRect encoder covers the accepted D3D9 layouts", () => {
        const pixel = [0x66, 0x99, 0xcc, 0xee];
        for (const format of [20, 21, 22, 23, 24, 25, 26, 27, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 60, 61, 62, 63, 64, 65, 67, 81, 110]) {
            const layout = getD3DTextureLayout(format, 1, 1);
            const data = new Uint8Array(layout.bytes);
            expect(writeD3D9Pixel(format, data, 0, pixel), format.toString()).toBe(true);
            expect(data.some(byte => byte !== 0), format.toString()).toBe(true);
        }
        expect(writeD3D9Pixel(41, new Uint8Array(4), 0, pixel)).toBe(false);
    });

    test("R3G3B2 CPU copies use the packed 3/3/2 bit layout", () => {
        const data = new Uint8Array(getD3DTextureLayout(27, 1, 1).bytes);
        expect(writeD3D9Pixel(27, data, 0, [255, 128, 64, 255])).toBe(true);
        // 255→7, 128→4, and 64→1, packed as 111 100 01.
        expect(data[0]).toBe(0xf1);
    });

    test("V8U8 CPU copies preserve signed-normalized U/V bytes", () => {
        const data = new Uint8Array(getD3DTextureLayout(60, 1, 1).bytes);
        expect(writeD3D9Pixel(60, data, 0, [128, 0, 255, 255])).toBe(true);
        // Canonical shadow values are signed byte + 128: 0 -> 0x00 and -128 -> 0x80.
        expect(Array.from(data)).toEqual([0x00, 0x80]);

        const source = new Uint8Array([0x80, 0x7f]);
        const destination = new Uint8Array(2);
        expect(copyD3D9SurfaceRectCpu(
            { data: source, pitch: 2, width: 1, height: 1, format: 60 },
            { data: destination, pitch: 2, width: 1, height: 1, format: 60 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(destination)).toEqual(Array.from(source));
    });

    test("X8L8V8U8 CPU copies preserve U/V signed bytes and luminance", () => {
        const data = new Uint8Array(getD3DTextureLayout(62, 1, 1).bytes);
        expect(writeD3D9Pixel(62, data, 0, [128, 0, 0x7a, 255])).toBe(true);
        // U=0, V=-128, L=0x7a; X is the canonical unused byte.
        expect(Array.from(data)).toEqual([0x00, 0x80, 0x7a, 0xff]);

        const source = new Uint8Array([0x80, 0x7f, 0x31, 0x12]);
        const destination = new Uint8Array(4);
        expect(copyD3D9SurfaceRectCpu(
            { data: source, pitch: 4, width: 1, height: 1, format: 62 },
            { data: destination, pitch: 4, width: 1, height: 1, format: 62 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(destination)).toEqual([0x80, 0x7f, 0x31, 0xff]);
    });

    test("Q8W8V8U8 CPU copies preserve all four signed-normalized bytes", () => {
        const data = new Uint8Array(getD3DTextureLayout(63, 1, 1).bytes);
        expect(writeD3D9Pixel(63, data, 0, [128, 0, 255, 1])).toBe(true);
        // U=0, V=-128, W=127, Q=-127 in little-endian component order.
        expect(Array.from(data)).toEqual([0x00, 0x80, 0x7f, 0x81]);

        const source = new Uint8Array([0x80, 0x7f, 0x00, 0xff]);
        const destination = new Uint8Array(4);
        expect(copyD3D9SurfaceRectCpu(
            { data: source, pitch: 4, width: 1, height: 1, format: 63 },
            { data: destination, pitch: 4, width: 1, height: 1, format: 63 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(destination)).toEqual(Array.from(source));
    });

    test("V16U16 CPU copies encode signed-normalized 16-bit U/V words", () => {
        const data = new Uint8Array(getD3DTextureLayout(64, 1, 1).bytes);
        expect(writeD3D9Pixel(64, data, 0, [128, 1, 0, 255])).toBe(true);
        // U=0 and the minimum signed V endpoint (-32768), little-endian.
        expect(Array.from(data)).toEqual([0x00, 0x00, 0x00, 0x80]);

        const source = new Uint8Array([0x00, 0x00, 0xff, 0x7f]);
        const destination = new Uint8Array(4);
        expect(copyD3D9SurfaceRectCpu(
            { data: source, pitch: 4, width: 1, height: 1, format: 64 },
            { data: destination, pitch: 4, width: 1, height: 1, format: 64 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        // Raw U=0 and V=32767 survive the decode/re-encode shadow path.
        expect(Array.from(destination)).toEqual(Array.from(source));
    });

    test("Q16W16V16U16 CPU copies encode all signed-normalized 16-bit words", () => {
        const data = new Uint8Array(getD3DTextureLayout(110, 1, 1).bytes);
        expect(writeD3D9Pixel(110, data, 0, [128, 1, 255, 0])).toBe(true);
        // U=0, V=-32768, W=32767, Q=-32768 at the canonical minimum shadow.
        expect(Array.from(data)).toEqual([0x00, 0x00, 0x00, 0x80, 0xff, 0x7f, 0x00, 0x80]);

        const source = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x7f]);
        const destination = new Uint8Array(8);
        expect(copyD3D9SurfaceRectCpu(
            { data: source, pitch: 8, width: 1, height: 1, format: 110 },
            { data: destination, pitch: 8, width: 1, height: 1, format: 110 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(destination)).toEqual(Array.from(source));
    });

    test("L6V5U5 CPU copies preserve signed U/V and luminance bits", () => {
        const data = new Uint8Array(getD3DTextureLayout(61, 1, 1).bytes);
        expect(writeD3D9Pixel(61, data, 0, [128, 0, 255, 255])).toBe(true);
        // U=0, V=-16 (5-bit minimum), L=63.
        expect(Array.from(data)).toEqual([0x00, 0xfe]);

        const destination = new Uint8Array(2);
        expect(copyD3D9SurfaceRectCpu(
            { data, pitch: 2, width: 1, height: 1, format: 61 },
            { data: destination, pitch: 2, width: 1, height: 1, format: 61 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(destination)).toEqual(Array.from(data));
    });

    test("W11V11U10 and A2W10V10U10 CPU copies preserve packed endpoints", () => {
        const w = new Uint8Array(getD3DTextureLayout(65, 1, 1).bytes);
        expect(writeD3D9Pixel(65, w, 0, [128, 0, 255, 255])).toBe(true);
        expect(Array.from(w)).toEqual([0x00, 0x00, 0xf0, 0x7f]);
        const wRoundTrip = new Uint8Array(4);
        expect(copyD3D9SurfaceRectCpu(
            { data: w, pitch: 4, width: 1, height: 1, format: 65 },
            { data: wRoundTrip, pitch: 4, width: 1, height: 1, format: 65 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(wRoundTrip)).toEqual(Array.from(w));

        const a = new Uint8Array(getD3DTextureLayout(67, 1, 1).bytes);
        expect(writeD3D9Pixel(67, a, 0, [128, 0, 255, 255])).toBe(true);
        expect(Array.from(a)).toEqual([0x00, 0x00, 0xf8, 0xdf]);
        const aRoundTrip = new Uint8Array(4);
        expect(copyD3D9SurfaceRectCpu(
            { data: a, pitch: 4, width: 1, height: 1, format: 67 },
            { data: aRoundTrip, pitch: 4, width: 1, height: 1, format: 67 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            false,
        )).toBe(true);
        expect(Array.from(aRoundTrip)).toEqual(Array.from(a));
    });
});

/**
 * The CPU copy path decodes a source texel into the canonical RGBA8 shadow and re-encodes it
 * for the destination. writeD3D9Pixel must therefore be the exact inverse of the shared
 * decoder over that shadow: whatever byte a code point decodes to has to encode back to a
 * code point that decodes to the same byte. Anything else silently shifts a same-format copy.
 */
describe("D3D9 CPU copy encoders round-trip through the shared decoder", () => {
    const formats = [
        20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
        50, 51, 52, 60, 61, 62, 63, 64, 65, 67, 81, 110,
    ];

    function shadowOf(format: number, bytes: Uint8Array): number[] {
        const pitch = getD3DTextureLayout(format, 1, 1).pitch;
        return [...decodeD3DTextureToRgba8(bytes, 0, 1, 1, format, { pitch }).subarray(0, 4)];
    }

    for (const format of formats) {
        test(`format ${format} decodes, re-encodes and decodes to the same shadow`, () => {
            const bytesPerPixel = getD3DTextureLayout(format, 1, 1).pitch;
            // Every code point for the narrow formats; a fixed pseudo-random sweep otherwise.
            const exhaustive = bytesPerPixel <= 2;
            const iterations = exhaustive ? 1 << (bytesPerPixel * 8) : 8192;
            let seed = 0x1234_5678;
            const next = (): number => {
                seed = (seed * 1103515245 + 12345) >>> 0;
                return (seed >>> 16) & 0xff;
            };
            for (let iteration = 0; iteration < iterations; iteration++) {
                const raw = new Uint8Array(bytesPerPixel);
                for (let byte = 0; byte < bytesPerPixel; byte++) {
                    raw[byte] = exhaustive ? (iteration >>> (8 * byte)) & 0xff : next();
                }
                const shadow = shadowOf(format, raw);
                const encoded = new Uint8Array(bytesPerPixel);
                expect(writeD3D9Pixel(format, encoded, 0, shadow)).toBe(true);
                expect({ format, raw: [...raw], shadow: shadowOf(format, encoded) })
                    .toEqual({ format, raw: [...raw], shadow });
            }
        });
    }
});
