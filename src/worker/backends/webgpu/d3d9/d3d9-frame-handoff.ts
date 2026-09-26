/**
 * Threaded D3D9 frame hand-off, render side (plan/d3d9-threaded/canvas-ownership.md, option c1).
 *
 * The render side owns no screen. At Present it copies the complete backbuffer — physical
 * extent, BEFORE PostFx — into a private OffscreenCanvas and ships `transferToImageBitmap()` of
 * it; the emulator side imports the bitmap and runs the one D3D9 composite (d3d9-screen-layer.ts).
 * The boundary is a single call carrying transferable data only, so a render worker replaces
 * the call with a postMessage and nothing on either side changes.
 */

/** `__d3d9BitmapPresent`: a render twin presents through the hand-off instead of the canvas.
 *  Needs OffscreenCanvas.transferToImageBitmap; without it the flag answers false everywhere,
 *  so the front and the twin cannot disagree about which edge is whose. */
export function d3d9BitmapPresentWanted(): boolean {
    if ((globalThis as { __d3d9BitmapPresent?: boolean }).__d3d9BitmapPresent !== true) return false;
    return typeof OffscreenCanvas !== "undefined"
        && typeof OffscreenCanvas.prototype.transferToImageBitmap === "function";
}

/** Everything the emulator side needs besides the pixels. Plain data: it crosses a postMessage. */
export interface D3D9FrameMeta {
    /** The render side's hand-off count, from 1, strictly increasing per sink. */
    serial: number;
    /** The guest's backbuffer extent: the logical space the frame was drawn in. */
    guestWidth: number;
    guestHeight: number;
    /** The bitmap's extent: guest extent times the internal-scale factor. */
    physicalWidth: number;
    physicalHeight: number;
    /** Swap-chain format the frame was rendered in. The bitmap carries RGB only (opaque). */
    format: GPUTextureFormat;
    /** Draws the guest issued for this frame (D3D9Device.getLastPresentDrawCount at this
     *  present): the video policy tells a movie blit from a scene of the app's own by it.
     *  Null = unknown, never "few". */
    drawCount: number | null;
    /** `performance.timeOrigin + performance.now()` at transfer: comparable across workers. */
    sentAt: number;
}

/** Takes ownership of `bitmap` and must close it. */
export type D3D9FrameSink = (bitmap: ImageBitmap, meta: D3D9FrameMeta) => void;

/**
 * The private canvas a frame leaves the render side through. Opaque on purpose: a
 * premultiplied vehicle lets the backbuffer's alpha — which D3D9 titles routinely leave at 0 —
 * alter RGB on import (measured in canvas-ownership.md §3).
 */
export class D3D9FrameVehicle {
    private canvas: OffscreenCanvas | null = null;
    private context: GPUCanvasContext | null = null;
    private device: GPUDevice | null = null;
    private format: GPUTextureFormat | null = null;
    private encoded = false;

    constructor(
        private readonly createCanvas: (width: number, height: number) => OffscreenCanvas
            = (width, height) => new OffscreenCanvas(width, height),
    ) {}

    /** Encode a copy of `source` into the vehicle. False when the vehicle has no context. */
    encode(device: GPUDevice, format: GPUTextureFormat, encoder: GPUCommandEncoder, source: GPUTexture): boolean {
        const width = source.width, height = source.height;
        this.canvas ??= this.createCanvas(width, height);
        const canvas = this.canvas;
        // Writing the size unconfigures the context, so every resize is followed by a configure.
        const resized = canvas.width !== width || canvas.height !== height;
        if (resized) {
            canvas.width = width;
            canvas.height = height;
        }
        if (!this.context) {
            this.context = canvas.getContext("webgpu") as GPUCanvasContext | null;
            if (!this.context) return false;
        }
        if (resized || this.device !== device || this.format !== format) {
            this.context.configure({
                device,
                format,
                alphaMode: "opaque",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
            });
            this.device = device;
            this.format = format;
        }
        encoder.copyTextureToTexture(
            { texture: source },
            { texture: this.context.getCurrentTexture() },
            { width, height, depthOrArrayLayers: 1 },
        );
        this.encoded = true;
        return true;
    }

    /** The frame encode() copied, once the encoder carrying that copy has been submitted. */
    transfer(): ImageBitmap | null {
        if (!this.encoded || !this.canvas) return null;
        this.encoded = false;
        return this.canvas.transferToImageBitmap();
    }
}
