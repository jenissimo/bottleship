/**
 * gdiplus.dll — GDI+ HLE module.
 *
 * Implements the subset of GDI+ needed by Alawar casual games (Montezuma etc.):
 * image loading (PNG/JPG/BMP/TGA), bitmap manipulation, and drawing via
 * OffscreenCanvas + ImageBitmap for GPU-accelerated compositing.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Marshaler } from "../core/memory/marshaler";
import { System } from "../core/system";
import { Logger, LogCategory } from "../core/logger";
import { asBlobPart, asArrayBufferView } from "../../dom-buffer";

// GpStatus enum
const Ok = 0;
const GenericError = 1;
const InvalidParameter = 2;
const OutOfMemory = 3;
const Win32Error = 8;

// PixelFormat constants
const PixelFormat32bppARGB = 0x0026200A;
const PixelFormat32bppRGB  = 0x00022009;
const PixelFormat24bppRGB  = 0x00021808;

// ImageLockMode flags
const ImageLockModeRead      = 1;
const ImageLockModeWrite     = 2;
const ImageLockModeUserInputBuf = 4;

// BitmapData struct offsets (20 bytes total)
const BD_WIDTH        = 0;   // UINT
const BD_HEIGHT       = 4;   // UINT
const BD_STRIDE       = 8;   // INT
const BD_PIXELFORMAT  = 12;  // INT
const BD_SCAN0        = 16;  // void*
const BITMAP_DATA_SIZE = 24; // padded

// ---------------------------------------------------------------------------
// GpImage — internal representation of a GDI+ image/bitmap
// ---------------------------------------------------------------------------
interface GpImage {
    handle: number;
    width: number;
    height: number;
    pixelFormat: number;
    imageBitmap: ImageBitmap | null;   // For fast drawImage (hot path)
    rgba: Uint8Array | null;           // Lazy: populated on first LockBits
    locked: boolean;
    lockBitsPtr: number;               // Guest memory for locked pixel data
    lockFlags: number;
}

// ---------------------------------------------------------------------------
// GpGraphics — wraps an OffscreenCanvas 2D context
// ---------------------------------------------------------------------------
interface GpGraphicsState {
    handle: number;
    canvas: OffscreenCanvas;
    ctx: OffscreenCanvasRenderingContext2D;
    sourceImage: number;  // handle of GpImage this was created from
}

// ---------------------------------------------------------------------------
// TGA parser (uncompressed + RLE, 24/32-bit)
// ---------------------------------------------------------------------------
function decodeTGA(data: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
    if (data.length < 18) return null;

    const idLength   = data[0];
    const imageType  = data[2];   // 2=uncompressed RGB, 10=RLE RGB
    const width      = data[12] | (data[13] << 8);
    const height     = data[14] | (data[15] << 8);
    const bpp        = data[16];  // 24 or 32
    const descriptor = data[17];
    const topDown    = (descriptor & 0x20) !== 0;

    if (width <= 0 || height <= 0 || (bpp !== 24 && bpp !== 32)) return null;
    if (imageType !== 2 && imageType !== 10) return null;

    const pixelBytes = bpp / 8;
    const rgba = new Uint8Array(width * height * 4);
    let src = 18 + idLength;

    if (imageType === 2) {
        // Uncompressed
        for (let i = 0; i < width * height; i++) {
            const row = topDown ? Math.floor(i / width) : (height - 1 - Math.floor(i / width));
            const col = i % width;
            const dst = (row * width + col) * 4;
            rgba[dst]     = data[src + 2]; // R
            rgba[dst + 1] = data[src + 1]; // G
            rgba[dst + 2] = data[src];     // B
            rgba[dst + 3] = bpp === 32 ? data[src + 3] : 255;
            src += pixelBytes;
        }
    } else {
        // RLE
        let pixel = 0;
        while (pixel < width * height && src < data.length) {
            const packet = data[src++];
            const count = (packet & 0x7F) + 1;
            const isRLE = (packet & 0x80) !== 0;

            if (isRLE) {
                const b = data[src], g = data[src + 1], r = data[src + 2];
                const a = bpp === 32 ? data[src + 3] : 255;
                src += pixelBytes;
                for (let j = 0; j < count && pixel < width * height; j++, pixel++) {
                    const row = topDown ? Math.floor(pixel / width) : (height - 1 - Math.floor(pixel / width));
                    const col = pixel % width;
                    const dst = (row * width + col) * 4;
                    rgba[dst] = r; rgba[dst + 1] = g; rgba[dst + 2] = b; rgba[dst + 3] = a;
                }
            } else {
                for (let j = 0; j < count && pixel < width * height; j++, pixel++) {
                    const row = topDown ? Math.floor(pixel / width) : (height - 1 - Math.floor(pixel / width));
                    const col = pixel % width;
                    const dst = (row * width + col) * 4;
                    rgba[dst]     = data[src + 2];
                    rgba[dst + 1] = data[src + 1];
                    rgba[dst + 2] = data[src];
                    rgba[dst + 3] = bpp === 32 ? data[src + 3] : 255;
                    src += pixelBytes;
                }
            }
        }
    }

    return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Helper: create ImageBitmap from RGBA Uint8Array
// ---------------------------------------------------------------------------
async function imageBitmapFromRGBA(rgba: Uint8Array, width: number, height: number): Promise<ImageBitmap> {
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const imageData = new ImageData(asArrayBufferView(clamped), width, height);
    return createImageBitmap(imageData);
}

// ---------------------------------------------------------------------------
// Helper: extract RGBA pixels from ImageBitmap
// ---------------------------------------------------------------------------
function extractRGBA(img: GpImage): Uint8Array {
    if (img.rgba) return img.rgba;

    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d")!;
    if (img.imageBitmap) {
        ctx.drawImage(img.imageBitmap, 0, 0);
    }
    const id = ctx.getImageData(0, 0, img.width, img.height);
    img.rgba = new Uint8Array(id.data.buffer);
    return img.rgba;
}

// ===========================================================================
export class GdiPlus implements IModule {
    name = "gdiplus";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;

    // Handle tables — handles start at 0x70000 to avoid collision with GDI handles
    private nextHandle = 0x70000;
    private gpImages = new Map<number, GpImage>();
    private gpGraphics = new Map<number, GpGraphicsState>();

    private allocHandle(): number { return this.nextHandle++; }

    initialize(process: Process): void {
        this.process = process;
        const self = this;

        // ---------------------------------------------------------------
        // GdiplusStartup / GdiplusShutdown
        // ---------------------------------------------------------------
        this.exports["GdiplusStartup"] = (ctx, mem, args) => {
            const pToken = args[0];
            const pInput = args[1];
            // const pOutput = args[2]; // unused
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            if (pToken) view.setUint32(pToken, 0x6D1B0001, true); // dummy token
            Logger.log(LogCategory.SYSTEM, `GdiplusStartup(token=0x${pToken.toString(16)}, input=0x${pInput.toString(16)})`);
            return Ok;
        };

        this.exports["GdiplusShutdown"] = (_ctx, _mem, _args) => {
            Logger.log(LogCategory.SYSTEM, "GdiplusShutdown");
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipAlloc / GdipFree
        // ---------------------------------------------------------------
        this.exports["GdipAlloc"] = (_ctx, _mem, args) => {
            const size = args[0];
            if (size <= 0) return 0;
            try {
                return process.memory.alloc(size);
            } catch {
                return 0;
            }
        };

        this.exports["GdipFree"] = (_ctx, _mem, args) => {
            // Arena allocator — no-op free
            Logger.verbose(LogCategory.SYSTEM, `GdipFree(0x${args[0].toString(16)})`);
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipCreateBitmapFromFile (async — file I/O)
        // ---------------------------------------------------------------
        this.exports["GdipCreateBitmapFromFile"] = async (_ctx, mem, args) => {
            const pFilename = args[0];
            const pImage    = args[1]; // out: GpImage**
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            const filename = Marshaler.readWideString(mem, pFilename);
            Logger.log(LogCategory.SYSTEM, `GdipCreateBitmapFromFile("${filename}")`);

            if (!pImage) return InvalidParameter;

            try {
                const system = System.getInstance();
                const vfs = system.fileSystem;
                const normalized = filename.replace(/\\/g, "/");

                const fh = await vfs.open(normalized, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
                if (!fh) {
                    Logger.warn(LogCategory.SYSTEM, `GdipCreateBitmapFromFile: file not found "${normalized}"`);
                    view.setUint32(pImage, 0, true);
                    return Win32Error;
                }

                const fileSize = vfs.getFileSize(normalized);
                const data = await vfs.read(fh, fileSize);

                let width: number, height: number;
                let imageBitmap: ImageBitmap;
                let rgba: Uint8Array | null = null;

                // Detect format by magic bytes
                if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
                    // PNG
                    imageBitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: "image/png" }));
                    width = imageBitmap.width;
                    height = imageBitmap.height;
                } else if (data[0] === 0xFF && data[1] === 0xD8) {
                    // JPEG
                    imageBitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: "image/jpeg" }));
                    width = imageBitmap.width;
                    height = imageBitmap.height;
                } else if (data[0] === 0x42 && data[1] === 0x4D) {
                    // BMP
                    imageBitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: "image/bmp" }));
                    width = imageBitmap.width;
                    height = imageBitmap.height;
                } else {
                    // Assume TGA
                    const tga = decodeTGA(data);
                    if (!tga) {
                        Logger.warn(LogCategory.SYSTEM, `GdipCreateBitmapFromFile: unsupported format "${normalized}"`);
                        view.setUint32(pImage, 0, true);
                        return GenericError;
                    }
                    width = tga.width;
                    height = tga.height;
                    rgba = tga.rgba;
                    imageBitmap = await imageBitmapFromRGBA(rgba, width, height);
                }

                const handle = self.allocHandle();
                self.gpImages.set(handle, {
                    handle,
                    width, height,
                    pixelFormat: PixelFormat32bppARGB,
                    imageBitmap,
                    rgba,
                    locked: false,
                    lockBitsPtr: 0,
                    lockFlags: 0,
                });

                view.setUint32(pImage, handle, true);
                Logger.verbose(LogCategory.SYSTEM, `GdipCreateBitmapFromFile -> handle=0x${handle.toString(16)} (${width}x${height})`);
                return Ok;
            } catch (e) {
                Logger.error(LogCategory.SYSTEM, `GdipCreateBitmapFromFile failed: ${e}`);
                const view2 = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view2.setUint32(pImage, 0, true);
                return GenericError;
            }
        };

        // ---------------------------------------------------------------
        // GdipCloneImage
        // ---------------------------------------------------------------
        this.exports["GdipCloneImage"] = async (_ctx, mem, args) => {
            const srcHandle = args[0];
            const pClone    = args[1];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            const src = self.gpImages.get(srcHandle);
            if (!src || !pClone) { if (pClone) view.setUint32(pClone, 0, true); return InvalidParameter; }

            const rgba = extractRGBA(src);
            const clonedRgba = new Uint8Array(rgba);
            const ib = await imageBitmapFromRGBA(clonedRgba, src.width, src.height);

            const handle = self.allocHandle();
            self.gpImages.set(handle, {
                handle,
                width: src.width, height: src.height,
                pixelFormat: src.pixelFormat,
                imageBitmap: ib,
                rgba: clonedRgba,
                locked: false,
                lockBitsPtr: 0,
                lockFlags: 0,
            });

            view.setUint32(pClone, handle, true);
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipDisposeImage
        // ---------------------------------------------------------------
        this.exports["GdipDisposeImage"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const img = self.gpImages.get(handle);
            if (!img) return InvalidParameter;

            if (img.imageBitmap) img.imageBitmap.close();
            self.gpImages.delete(handle);
            return Ok;
        };

        // ---------------------------------------------------------------
        // Getters: Width, Height, PixelFormat, PaletteSize, Palette
        // ---------------------------------------------------------------
        this.exports["GdipGetImageWidth"] = (_ctx, mem, args) => {
            const img = self.gpImages.get(args[0]);
            if (!img) return InvalidParameter;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(args[1], img.width, true);
            return Ok;
        };

        this.exports["GdipGetImageHeight"] = (_ctx, mem, args) => {
            const img = self.gpImages.get(args[0]);
            if (!img) return InvalidParameter;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(args[1], img.height, true);
            return Ok;
        };

        this.exports["GdipGetImagePixelFormat"] = (_ctx, mem, args) => {
            const img = self.gpImages.get(args[0]);
            if (!img) return InvalidParameter;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(args[1], img.pixelFormat, true);
            return Ok;
        };

        this.exports["GdipGetImagePaletteSize"] = (_ctx, mem, args) => {
            // All images are 32bpp ARGB — no palette
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (args[1]) view.setInt32(args[1], 0, true);
            return Ok;
        };

        this.exports["GdipGetImagePalette"] = (_ctx, _mem, _args) => {
            // No palette for 32bpp
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipCreateBitmapFromScan0
        // ---------------------------------------------------------------
        this.exports["GdipCreateBitmapFromScan0"] = async (_ctx, mem, args) => {
            const width  = args[0];
            const height = args[1];
            const stride = args[2]; // signed
            const format = args[3];
            const scan0  = args[4];
            const pOut   = args[5];
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            if (!pOut || width <= 0 || height <= 0) return InvalidParameter;

            let rgba: Uint8Array;
            if (scan0) {
                // Copy pixel data from guest memory
                const absStride = Math.abs(stride) || width * 4;
                rgba = new Uint8Array(width * height * 4);
                for (let y = 0; y < height; y++) {
                    const srcRow = scan0 + y * absStride;
                    const dstOff = y * width * 4;
                    for (let x = 0; x < width * 4 && srcRow + x < mem.length; x++) {
                        rgba[dstOff + x] = mem[srcRow + x];
                    }
                }
            } else {
                rgba = new Uint8Array(width * height * 4); // zeroed
            }

            const ib = await imageBitmapFromRGBA(rgba, width, height);
            const handle = self.allocHandle();
            self.gpImages.set(handle, {
                handle,
                width, height,
                pixelFormat: PixelFormat32bppARGB,
                imageBitmap: ib,
                rgba,
                locked: false,
                lockBitsPtr: 0,
                lockFlags: 0,
            });

            view.setUint32(pOut, handle, true);
            Logger.verbose(LogCategory.SYSTEM, `GdipCreateBitmapFromScan0(${width}x${height}) -> 0x${handle.toString(16)}`);
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipBitmapLockBits
        // ---------------------------------------------------------------
        this.exports["GdipBitmapLockBits"] = (_ctx, mem, args) => {
            const imgHandle = args[0];
            const pRect     = args[1]; // may be NULL (lock entire bitmap)
            const flags     = args[2];
            const reqFormat = args[3];
            const pBD       = args[4]; // out: BitmapData*

            const img = self.gpImages.get(imgHandle);
            if (!img || !pBD) return InvalidParameter;
            if (img.locked) return Win32Error; // already locked

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Determine lock region
            let x = 0, y = 0, w = img.width, h = img.height;
            if (pRect) {
                x = view.getInt32(pRect, true);
                y = view.getInt32(pRect + 4, true);
                w = view.getInt32(pRect + 8, true);
                h = view.getInt32(pRect + 12, true);
            }

            // Ensure RGBA is available
            const rgba = extractRGBA(img);

            // Allocate guest memory for locked pixels
            const stride = w * 4;
            const dataSize = stride * h;
            const guestPtr = process.memory.alloc(dataSize);

            // Copy RGBA sub-rect to guest memory
            for (let row = 0; row < h; row++) {
                const srcOff = ((y + row) * img.width + x) * 4;
                const dstOff = guestPtr + row * stride;
                mem.set(rgba.subarray(srcOff, srcOff + stride), dstOff);
            }

            // Fill BitmapData struct
            view.setUint32(pBD + BD_WIDTH, w, true);
            view.setUint32(pBD + BD_HEIGHT, h, true);
            view.setInt32(pBD + BD_STRIDE, stride, true);
            view.setInt32(pBD + BD_PIXELFORMAT, PixelFormat32bppARGB, true);
            view.setUint32(pBD + BD_SCAN0, guestPtr, true);

            img.locked = true;
            img.lockBitsPtr = guestPtr;
            img.lockFlags = flags;

            Logger.verbose(LogCategory.SYSTEM, `GdipBitmapLockBits(0x${imgHandle.toString(16)}, ${x},${y} ${w}x${h}) -> scan0=0x${guestPtr.toString(16)}`);
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipBitmapUnlockBits
        // ---------------------------------------------------------------
        this.exports["GdipBitmapUnlockBits"] = async (_ctx, mem, args) => {
            const imgHandle = args[0];
            // const pBD = args[1]; // BitmapData* (we already stored the info)

            const img = self.gpImages.get(imgHandle);
            if (!img || !img.locked) return InvalidParameter;

            // If write access was requested, copy back from guest to RGBA
            if ((img.lockFlags & ImageLockModeWrite) || (img.lockFlags & ImageLockModeRead) === 0) {
                const rgba = img.rgba!;
                const stride = img.width * 4;
                const dataSize = stride * img.height;
                const src = img.lockBitsPtr;

                // Full-image copy back (common case — game locks entire bitmap)
                rgba.set(mem.subarray(src, src + dataSize));

                // Recreate ImageBitmap from updated RGBA
                if (img.imageBitmap) img.imageBitmap.close();
                img.imageBitmap = await imageBitmapFromRGBA(rgba, img.width, img.height);
            }

            img.locked = false;
            img.lockBitsPtr = 0;
            img.lockFlags = 0;
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipGetImageGraphicsContext
        // ---------------------------------------------------------------
        this.exports["GdipGetImageGraphicsContext"] = (_ctx, mem, args) => {
            const imgHandle = args[0];
            const pGfx      = args[1]; // out: GpGraphics**

            const img = self.gpImages.get(imgHandle);
            if (!img || !pGfx) return InvalidParameter;

            const canvas = new OffscreenCanvas(img.width, img.height);
            const ctx2d = canvas.getContext("2d");
            if (!ctx2d) return GenericError;

            // Draw existing content onto the canvas
            if (img.imageBitmap) {
                ctx2d.drawImage(img.imageBitmap, 0, 0);
            }

            const handle = self.allocHandle();
            self.gpGraphics.set(handle, {
                handle,
                canvas,
                ctx: ctx2d,
                sourceImage: imgHandle,
            });

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(pGfx, handle, true);
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipDrawImageI — HOT PATH
        // ---------------------------------------------------------------
        this.exports["GdipDrawImageI"] = (_ctx, _mem, args) => {
            const gfxHandle = args[0];
            const imgHandle = args[1];
            const x = args[2] | 0; // signed int
            const y = args[3] | 0;

            const gfx = self.gpGraphics.get(gfxHandle);
            const img = self.gpImages.get(imgHandle);

            if (gfx && img?.imageBitmap) {
                gfx.ctx.drawImage(img.imageBitmap, x, y);
            }
            return Ok;
        };

        // ---------------------------------------------------------------
        // GdipDeleteGraphics
        // ---------------------------------------------------------------
        this.exports["GdipDeleteGraphics"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const gfx = self.gpGraphics.get(handle);
            if (!gfx) return InvalidParameter;

            // Sync canvas content back to the source image
            const img = self.gpImages.get(gfx.sourceImage);
            if (img) {
                // Update RGBA from canvas
                const id = gfx.ctx.getImageData(0, 0, gfx.canvas.width, gfx.canvas.height);
                img.rgba = new Uint8Array(id.data.buffer);

                // Recreate ImageBitmap (sync not possible — schedule async update)
                if (img.imageBitmap) img.imageBitmap.close();
                img.imageBitmap = null; // will be recreated lazily

                // Schedule async ImageBitmap recreation
                imageBitmapFromRGBA(img.rgba, img.width, img.height).then(ib => {
                    if (self.gpImages.has(img.handle)) {
                        img.imageBitmap = ib;
                    } else {
                        ib.close();
                    }
                });
            }

            self.gpGraphics.delete(handle);
            return Ok;
        };
    }

    reset(): void {
        for (const img of this.gpImages.values()) {
            try { img.imageBitmap?.close(); } catch { /* ignore */ }
        }
        this.gpImages.clear();
        this.gpGraphics.clear();
        this.nextHandle = 0x70000;
    }
}
